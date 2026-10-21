const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

test("account data API protects all-account collection, filtered exports and account-scoped media", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-account-data-api-"));
  process.env.AUTOSOCIAL_DATA_DIR = root;
  process.env.AUTOSOCIAL_ENV_FILE = path.join(root, "settings.env");
  process.env.DASHBOARD_HOST = "127.0.0.1";
  process.env.DASHBOARD_PORT = "0";
  process.env.AUTOSOCIAL_START_BACKGROUND = "false";
  const { hashPassword } = require("../src/dashboard-auth");
  process.env.DASHBOARD_PASSWORD_HASH = await hashPassword("account-data-test-password");
  await fs.writeFile(path.join(root, "settings.env"), "TELEGRAM_BOT_TOKEN=SENTINEL_TOKEN_NEVER_EXPORT\n");
  await fs.writeFile(path.join(root, "accounts-state.json"), JSON.stringify({
    activeAccountId: "alpha", accounts: [{ id: "alpha", name: "First account" }, { id: "beta", name: "Second account" }],
  }));
  const calendar = path.join(root, "queue", "alpha", "calendar");
  await fs.mkdir(path.join(calendar, "videos"), { recursive: true });
  const photo = path.join(calendar, "videos", "photo.jpg");
  await fs.writeFile(photo, "calendar-media-fixture");
  await fs.writeFile(path.join(calendar, "posts.json"), JSON.stringify([{
    id: "alpha-photo", accountId: "alpha", caption: "Calendar caption", mediaType: "photo",
    mediaPath: photo, mediaFilename: "photo.jpg", platforms: ["instagram"], status: "scheduled",
    scheduledAt: "2030-01-02T12:00:00.000Z", createdAt: "2026-01-01T12:00:00.000Z",
  }]));
  const betaCalendar = path.join(root, "queue", "beta", "calendar");
  await fs.mkdir(betaCalendar, { recursive: true });
  await fs.writeFile(path.join(betaCalendar, "posts.json"), "[]");
  const queue = path.join(root, "queue", "beta", "x", "posted");
  await fs.mkdir(queue, { recursive: true });
  await fs.writeFile(path.join(queue, "clip.mp4"), "queue-media-fixture");
  await fs.writeFile(path.join(queue, "clip.description"), "=2+2");

  const { createServer } = require("../src/dashboard-server");
  const { server, shutdown } = await createServer();
  t.after(async () => {
    await shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const route of ["/api/account-data", "/api/account-data/export?format=json", "/api/account-data/media?accountId=alpha&postId=calendar%3Aalpha-photo"]) {
    assert.equal((await fetch(origin + route)).status, 401);
  }
  const login = await fetch(origin + "/api/auth/login", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "account-data-test-password" }),
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get("set-cookie").split(";")[0] };
  const response = await fetch(origin + "/api/account-data", { headers });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.source, "stored_local");
  assert.deepEqual(data.accounts.map((account) => account.id).sort(), ["alpha", "beta"]);
  assert.equal(data.posts.length, 2);
  assert.equal(JSON.stringify(data).includes("SENTINEL_TOKEN_NEVER_EXPORT"), false);
  assert.equal(JSON.stringify(data).includes(root), false);

  const filtered = await fetch(origin + "/api/account-data?accountId=beta&platform=x&status=posted&source=queue", { headers });
  assert.equal(filtered.status, 200);
  assert.deepEqual((await filtered.json()).posts.map((post) => post.accountId), ["beta"]);
  assert.equal((await fetch(origin + "/api/account-data?accountId=missing", { headers })).status, 404);
  assert.equal((await fetch(origin + "/api/account-data?status=not-a-status", { headers })).status, 400);

  const exported = await fetch(origin + "/api/account-data/export?format=json&accountId=beta", { headers });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition"), /attachment;.*\.json/);
  assert.equal((await exported.json()).posts.length, 1);
  const csv = await fetch(origin + "/api/account-data/export?format=csv&accountId=beta", { headers });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(await csv.text(), /'=2\+2/);
  assert.equal((await fetch(origin + "/api/account-data/export?format=xml", { headers })).status, 400);

  const calendarPost = data.posts.find((post) => post.source === "calendar");
  const media = await fetch(origin + calendarPost.mediaUrl, { headers });
  assert.equal(media.status, 200);
  assert.equal(await media.text(), "calendar-media-fixture");
  const wrongAccount = new URL(calendarPost.mediaUrl, origin);
  wrongAccount.searchParams.set("accountId", "beta");
  assert.equal((await fetch(wrongAccount, { headers })).status, 404);
  assert.equal((await fetch(origin + "/api/account-data/media?accountId=..&postId=calendar%3Aalpha-photo", { headers })).status, 400);
  const accounts = await (await fetch(origin + "/api/accounts", { headers })).json();
  assert.equal(accounts.activeAccountId, "alpha");
});
