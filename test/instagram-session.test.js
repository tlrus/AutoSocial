const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { normalizeInstagramCookies, saveInstagramSession, readInstagramSession } = require("../src/instagram-session");

test("Instagram requires both auth cookies and filters unrelated domains", () => {
  assert.throws(() => normalizeInstagramCookies({ sessionid: "secret" }), /nonempty|required/);
  const cookies = normalizeInstagramCookies([
    { name: "sessionid", value: "secret", domain: ".instagram.com" },
    { name: "ds_user_id", value: "12345", domain: ".instagram.com" },
    { name: "foreign", value: "not-imported", domain: ".example.com" },
  ]);
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every((cookie) => cookie.secure));
  assert.throws(() => normalizeInstagramCookies({ sessionid: "a", ds_user_id: "invalid" }), /numeric/);
});

test("Instagram rejects expired cookies and accepts browser export formats", () => {
  const cookies = { cookies: [
    { name: "sessionid", value: "a", expirationDate: Date.now() / 1000 + 3600, sameSite: "no_restriction" },
    { name: "ds_user_id", value: "12345" },
  ] };
  assert.equal(normalizeInstagramCookies(JSON.stringify(cookies))[0].sameSite, "None");
  cookies.cookies[0].expirationDate = 1;
  assert.throws(() => normalizeInstagramCookies(cookies), /expired/);
  assert.throws(() => normalizeInstagramCookies("not JSON"), /JSON/);
});

test("Instagram session persists in its account profile and rejects corrupted data", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-session-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(await readInstagramSession(dir), null);
  await saveInstagramSession(dir, normalizeInstagramCookies({ sessionid: "test-token", ds_user_id: "123" }));
  const saved = await readInstagramSession(dir);
  assert.equal(saved.cookies[0].value, "test-token");
  assert.ok(saved.verifiedAt);
  await fs.writeFile(path.join(dir, ".instagram-session.json"), "bad data");
  assert.equal(await readInstagramSession(dir), null);
});
