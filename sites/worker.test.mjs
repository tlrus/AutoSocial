import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.mjs";

test("Sites refuses missing, insecure, and recursive backend addresses", async () => {
  const request = new Request("https://site.example/api/status");
  for (const address of [undefined, "http://backend.example", "https://site.example", "https://user:secret@backend.example"]) {
    assert.equal((await worker.fetch(request, { AUTOSOCIAL_ORIGIN: address })).status, 503);
  }
});

test("Sites streams requests to the fixed backend and rewrites login redirects", async () => {
  const savedFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (url, options) => {
    forwarded = { url: String(url), options };
    return new Response(null, { status: 302, headers: { Location: "https://backend.example/login", "Set-Cookie": "autosocial_session=a; HttpOnly; Secure; SameSite=Strict" } });
  };
  try {
    const request = new Request("https://site.example/api/auth/login?q=1", {
      method: "POST", body: "password-body", headers: { Origin: "https://site.example", Authorization: "must-not-forward", "oai-authenticated-user-email": "private@example.com" },
    });
    const response = await worker.fetch(request, { AUTOSOCIAL_ORIGIN: "https://backend.example" });
    assert.equal(forwarded.url, "https://backend.example/api/auth/login?q=1");
    assert.equal(forwarded.options.headers.get("origin"), "https://backend.example");
    assert.equal(forwarded.options.headers.get("authorization"), null);
    assert.equal(forwarded.options.headers.get("oai-authenticated-user-email"), null);
    assert.equal(response.headers.get("location"), "https://site.example/login");
    assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  } finally { globalThis.fetch = savedFetch; }
});

test("Gateway refuses foreign browser mutations before contacting the backend", async () => {
  const savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("unexpected"); };
  try {
    for (const headers of [
      { Origin: "https://attacker.example" },
      { Origin: "https://backend.example" },
      { Origin: "null" },
      { Referer: "https://attacker.example/page" },
      { "Sec-Fetch-Site": "cross-site" },
    ]) {
      const request = new Request("https://site.example/api/auth/login", { method: "POST", headers, body: "{}" });
      assert.equal((await worker.fetch(request, { AUTOSOCIAL_ORIGIN: "https://backend.example" })).status, 403);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = savedFetch; }
});
