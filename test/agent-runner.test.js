const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AgentRunner } = require("../src/agent-runner");
const { AGENTS } = require("../src/agent-catalog");

const input = (agentIds = ["hook-generator", "post-writer", "post-reviewer"]) => ({ topic: "Как делегировать", brief: "Мои факты о делегировании", format: "text", platform: "instagram", agentIds, model: "local-model" });
const response = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
async function complete(runner, id) {
  for (let i = 0; i < 200; i++) {
    const run = await runner.get("default", id);
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Mock generation did not finish");
}
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-agents-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function mockFetch(chat) {
  return async (url, options) => {
    assert.equal(new URL(url).origin, "http://127.0.0.1:11434");
    if (url.endsWith("/api/tags")) return response({ models: [{ name: "local-model", size: 9e9 }, { name: "remote:cloud", size: 9e9 }, { name: "remote", size: 123 }] });
    if (url.endsWith("/api/show")) return response({ capabilities: ["completion"] });
    return chat(JSON.parse(options.body), options.signal);
  };
}

test("cloud inference uses only the private Ollama service and rejects remote API destinations", async (t) => {
  const previous = process.env.OLLAMA_BASE_URL;
  const dir = await directory(t);
  try {
    for (const value of ["https://example.com", "http://ollama:11434/other", "http://user:password@ollama:11434", "http://169.254.169.254:11434"]) {
      process.env.OLLAMA_BASE_URL = value;
      assert.throws(() => new AgentRunner(dir), /OLLAMA_BASE_URL/);
    }
    process.env.OLLAMA_BASE_URL = "http://ollama:11434";
    let called = false;
    const runner = new AgentRunner(dir, { fetchImpl: async (url) => {
      assert.equal(url, "http://ollama:11434/api/tags"); called = true;
      return response({ models: [] });
    } });
    await runner.models();
    assert.equal(called, true);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = previous;
  }
});

test("selected agents share context in pipeline order, save edits, and isolate account results", async (t) => {
  const dir = await directory(t);
  const calls = [];
  const runner = new AgentRunner(dir, { fetchImpl: mockFetch(async (body) => {
    calls.push(body);
    assert.deepEqual(body.format.required, ["result", "postText"]);
    return response({ message: { content: JSON.stringify({ result: `Роль ${calls.length}`, postText: `Пост ${calls.length}` }) } });
  }) });
  const run = await runner.start("default", input(["post-reviewer", "post-writer", "hook-generator", "post-writer"]));
  const done = await complete(runner, run.id);
  assert.equal(done.status, "completed");
  assert.deepEqual(done.steps.map((s) => s.id), ["hook-generator", "post-writer", "post-reviewer"]);
  assert.equal(done.postText, "Пост 3");
  const secondContext = JSON.parse(calls[1].messages[1].content);
  assert.equal(secondContext.postText, "Пост 1");
  assert.equal(secondContext.previousResults[0].result, "Роль 1");
  assert.equal(await runner.get("other-brand", run.id), null);
  await runner.saveDraft("default", run.id, "Мои ручные правки");
  const reloaded = new AgentRunner(dir, { fetchImpl: runner.fetch });
  assert.equal((await reloaded.latest("default")).postText, "Мои ручные правки");
  await assert.rejects(runner.start("default", { ...input(), agentIds: ["not-an-agent"] }), /Выберите/);
  await assert.rejects(runner.start("default", { ...input(), model: "remote:cloud" }), /не установлена/);
  assert.equal(calls.length, 3);
});

test("missing research and analytics inputs are explicit; malformed model outputs preserve earlier work", async (t) => {
  const dir = await directory(t);
  let calls = 0;
  const runner = new AgentRunner(dir, { fetchImpl: mockFetch(async () => response({ message: { content: ++calls === 1 ? JSON.stringify({ result: "Готовый пост", postText: "Полезный текст" }) : '{"result":false}' } })) });
  const run = await runner.start("default", input(["trend-research", "analytics", "post-writer", "post-reviewer"]));
  const done = await complete(runner, run.id);
  assert.equal(done.status, "partial");
  assert.equal(done.steps.find((s) => s.id === "trend-research").status, "needs-input");
  assert.equal(done.steps.find((s) => s.id === "analytics").status, "needs-input");
  assert.equal(done.steps.find((s) => s.id === "post-reviewer").status, "failed");
  assert.equal(done.postText, "Полезный текст");
  assert.equal(calls, 2);
});

test("cancelling a run aborts inference, does not launch later roles, and prevents duplicate GPU runs", async (t) => {
  const dir = await directory(t);
  let inferenceStarted;
  const started = new Promise((r) => { inferenceStarted = r; });
  let calls = 0;
  const runner = new AgentRunner(dir, { fetchImpl: mockFetch((body, signal) => new Promise((resolve, reject) => {
    calls++; inferenceStarted();
    signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  })) });
  const run = await runner.start("default", input());
  await started;
  await assert.rejects(runner.start("default", input()), { status: 409 });
  await assert.rejects(runner.saveDraft("default", run.id, "Overwrite"), { status: 409 });
  await runner.cancel("default", run.id);
  const stopped = await complete(runner, run.id);
  assert.equal(stopped.status, "cancelled");
  assert.ok(stopped.steps.every((s) => s.status === "cancelled"));
  assert.equal(calls, 1);
});

test("all 17 catalog roles execute when supplied with the necessary inputs", async (t) => {
  const dir = await directory(t);
  let calls = 0;
  const runner = new AgentRunner(dir, { fetchImpl: mockFetch(async () => { calls++; return response({ message: { content: JSON.stringify({ result: "Результат роли", postText: "Текст" }) } }); }) });
  const run = await runner.start("default", { ...input(AGENTS.map((a) => a.id)), brief: "Источник https://example.com, выдержка: публикация собрала 100 просмотров и 10 реакций." });
  const done = await complete(runner, run.id);
  assert.equal(done.steps.length, 17);
  assert.equal(calls, 17);
  assert.ok(done.steps.every((s) => s.status === "done"));
});
