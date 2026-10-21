const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createAccountDataService } = require("../src/account-data-service");

const platforms = ["tiktok", "instagram", "youtube", "telegram", "x"];

async function fixture(t, accounts = [{ id: "first", name: "Первый" }, { id: "second", name: "Второй" }]) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-account-data-"));
  const root = path.join(base, "data");
  await fs.mkdir(root);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  for (const account of accounts) {
    const accountRoot = path.join(root, "queue", account.id);
    await fs.mkdir(path.join(accountRoot, "calendar", "videos"), { recursive: true });
    await fs.writeFile(path.join(accountRoot, "calendar", "posts.json"), "[]");
    for (const platform of platforms) {
      for (const status of ["pending", "posted", "failed"]) await fs.mkdir(path.join(accountRoot, platform, status), { recursive: true });
    }
  }
  const sessions = [];
  const service = createAccountDataService({
    root,
    getAccounts: async () => accounts,
    getSessionStatus: async (platform, accountId) => { sessions.push({ platform, accountId }); return platform === "instagram" && accountId === "second"; },
  });
  return { root, base, service, sessions, accounts };
}

async function queue(root, accountId, platform, status, name, caption) {
  const file = path.join(root, "queue", accountId, platform, status, name);
  await fs.writeFile(file, "media");
  if (caption !== undefined) await fs.writeFile(file.replace(/\.[^.]+$/, ".description"), caption);
  return file;
}

test("collects all accounts, queue states and calendar media without switching accounts or writing state", async (t) => {
  const { root, service, sessions } = await fixture(t);
  const clip = await queue(root, "first", "tiktok", "pending", "clip.mp4", "Priority caption");
  await fs.writeFile(clip.replace(/\.mp4$/, ".txt"), "Fallback caption");
  await queue(root, "first", "youtube", "posted", "published.webm", "Archive");
  await queue(root, "second", "x", "failed", "retry.mov", "Retry");
  await fs.writeFile(path.join(root, "queue", "first", "tiktok", "pending", "notes.txt"), "not a post");
  const mediaPath = path.join(root, "queue", "second", "calendar", "videos", "photo.jpg");
  await fs.writeFile(mediaPath, "photo");
  const postsFile = path.join(root, "queue", "second", "calendar", "posts.json");
  const stored = JSON.stringify([
    { id: "photo-1", mediaPath, mediaFilename: "camera/photo.jpg", mediaType: "photo", caption: "Photo caption", platforms: ["instagram", "telegram", "instagram"], status: "scheduled", createdAt: "2026-10-13T10:00:00Z", scheduledAt: "2026-10-20T10:00:00Z" },
    { id: "photo-2", videoPath: mediaPath, videoFilename: "old-photo.jpg", caption: "Posted photo", platforms: ["instagram"], status: "published", publishedAt: "2026-10-14T12:00:00Z", results: { instagram: { ok: true, at: "2026-10-14T12:00:00Z" } } },
  ]);
  await fs.writeFile(postsFile, stored);
  const snapshot = await service.collect();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.source, "stored_local");
  assert.deepEqual(snapshot.summary, { accounts: 2, posts: 5, pending: 1, posted: 2, failed: 1, scheduled: 1, publishing: 0, partial: 0, unknown: 0 });
  assert.equal(snapshot.accounts.length, 2);
  assert.equal(sessions.length, 10);
  assert.equal(snapshot.accounts[1].platforms.find((p) => p.id === "instagram").connected, true);
  assert.equal(snapshot.accounts[0].platforms.find((p) => p.id === "instagram").connected, false);
  assert.deepEqual(snapshot.accounts[1].counts, { pending: 0, posted: 1, failed: 1, scheduled: 1, publishing: 0, partial: 0, unknown: 0, total: 3 });
  const pending = snapshot.posts.find((p) => p.status === "pending");
  assert.equal(pending.caption, "Priority caption");
  assert.equal(pending.publishedAt, null);
  assert.equal(pending.createdAt, null);
  assert.equal(typeof pending.modifiedAt, "string");
  const photo = snapshot.posts.find((p) => p.id === "calendar:photo-1");
  assert.equal(photo.mediaType, "photo");
  assert.equal(photo.filename, "photo.jpg");
  assert.deepEqual(photo.platforms, ["instagram", "telegram"]);
  assert.equal(photo.sizeBytes, 5);
  assert.match(photo.mediaUrl, /accountId=second&postId=calendar%3Aphoto-1$/);
  assert.equal(await service.resolveMedia("second", photo.id), mediaPath);
  assert.equal(await service.resolveMedia("first", pending.id), clip);
  assert.equal(sessions.length, 10, "media resolution must not inspect browser sessions");
  await assert.rejects(service.resolveMedia("first", photo.id), { status: 404 });
  assert.equal(await fs.readFile(postsFile, "utf8"), stored);
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(JSON.stringify(snapshot).includes(root), false);
});

test("filters and exports every matching record with identical semantics and formula-safe CSV", async (t) => {
  const { root, service } = await fixture(t);
  for (let i = 0; i < 63; i += 1) await queue(root, "second", "instagram", "pending", `${i}.mp4`, i === 0 ? '=HYPERLINK("https://example.com","click")\nline, "quote"' : `caption ${i}`);
  await queue(root, "first", "instagram", "failed", "retry.mp4", "other account");
  const filters = { accountId: "second", platform: "instagram", status: "pending", source: "queue", search: "ВТОРОЙ" };
  const snapshot = await service.collect(filters);
  const exported = JSON.parse(await service.exportJSON(filters));
  assert.equal(snapshot.posts.length, 63);
  assert.equal(snapshot.summary.posts, 63);
  assert.deepEqual(exported.posts, snapshot.posts);
  const csv = await service.exportCSV(filters);
  assert.match(csv, /^\uFEFF"id","accountId"/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example.com"",""click""\)\nline, ""quote"""/);
  assert.equal((csv.match(/"queue:instagram:pending:/g) || []).length, 63);
  assert.equal((await service.collect({ search: "caption 62" })).posts.length, 1);
  assert.equal((await service.collect({ search: "failed" })).posts.length, 1);
  assert.equal((await service.collect({ search: "first" })).posts.length, 1);
  assert.equal((await service.collect({ source: "calendar" })).posts.length, 0);
});

test("allowlists account, calendar and result fields, excluding tokens, sessions and absolute paths", async (t) => {
  const { root, service, accounts } = await fixture(t);
  accounts[0].token = "secret-account-token";
  accounts[0].profilePath = "/secret/browser-profile";
  const calendarDir = path.join(root, "queue", "first", "calendar");
  const mediaPath = path.join(calendarDir, "videos", "clean.mp4");
  await fs.writeFile(mediaPath, "clean");
  await fs.writeFile(path.join(root, ".env"), "DO_NOT_EXPORT=secret-env");
  await fs.mkdir(path.join(root, ".profiles"));
  await fs.writeFile(path.join(root, ".profiles", "session.json"), "secret-cookies");
  await fs.writeFile(path.join(calendarDir, "posts.json"), JSON.stringify([
    { id: "one", mediaPath, status: "partial", caption: "Safe caption", platforms: ["instagram", "injected"], token: "secret-post-token", cookie: "secret-cookie", results: { instagram: { ok: false, at: "invalid-date", error: `secret-error-token at ${mediaPath}`, accessToken: "secret-result-token" }, injected: { token: "secret-injected" } } },
    { id: "two", mediaPath, status: "publishing", platforms: ["x"], caption: "Second" },
  ]));
  const snapshot = await service.collect();
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /secret-|\.profiles|DO_NOT_EXPORT/);
  assert.equal(serialized.includes(root), false);
  assert.deepEqual(snapshot.posts.find((post) => post.id === "calendar:one").results, { instagram: { ok: false, at: null, error: "Публикация не выполнена." } });
  assert.equal(snapshot.summary.partial, 1);
  assert.equal(snapshot.summary.publishing, 1);
});

test("reports corrupt, missing and unsafe sources without silently writing replacement data", async (t) => {
  const { root, service } = await fixture(t);
  const corrupt = path.join(root, "queue", "first", "calendar", "posts.json");
  const missing = path.join(root, "queue", "second", "calendar", "posts.json");
  await fs.writeFile(corrupt, "{corrupt-json");
  await fs.unlink(missing);
  await fs.rm(path.join(root, "queue", "second", "youtube", "pending"), { recursive: true });
  await queue(root, "first", "telegram", "posted", "ok.mp4", "Valid elsewhere");
  const snapshot = await service.collect();
  assert.equal(snapshot.posts.length, 1);
  assert.ok(snapshot.warnings.some((warning) => warning.accountId === "first" && warning.source === "calendar"));
  assert.ok(snapshot.warnings.some((warning) => warning.accountId === "second" && warning.source === "calendar"));
  assert.ok(snapshot.warnings.some((warning) => warning.accountId === "second" && warning.source === "queue"));
  assert.equal(await fs.readFile(corrupt, "utf8"), "{corrupt-json");
  await assert.rejects(fs.stat(missing), { code: "ENOENT" });
});

test("rejects path traversal and malformed filters and keeps session failures visible", async (t) => {
  const { root } = await fixture(t);
  const service = createAccountDataService({ root, getAccounts: async () => [{ id: "first", name: "First" }, { id: "../outside", name: "Unsafe" }], getSessionStatus: async () => { throw new Error("secret-session-path"); } });
  const snapshot = await service.collect();
  assert.equal(snapshot.accounts.length, 1);
  assert.ok(snapshot.accounts[0].platforms.every((platform) => platform.connected === null));
  assert.equal(snapshot.warnings.filter((warning) => warning.source === "session").length, 5);
  assert.ok(snapshot.warnings.some((warning) => warning.source === "account"));
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-session-path|outside/);
  for (const filter of [{ accountId: "../first" }, { platform: "facebook" }, { status: "whatever" }, { source: "live" }, { accountId: ["first"] }, { search: {} }, { rawPath: ".env" }, { search: "x".repeat(501) }]) {
    await assert.rejects(service.collect(filter), { status: 400 });
  }
  await assert.rejects(service.collect({ accountId: "absent" }), { status: 404 });
  await assert.rejects(service.resolveMedia("../first", "calendar:one"), { status: 400 });
  await assert.rejects(service.resolveMedia("first", { path: ".env" }), { status: 400 });
  await assert.rejects(service.resolveMedia("first", "../../.env"), { status: 404 });
});

test("blocks media, sidecar, calendar-state and account-directory symlinks outside their own scope", async (t) => {
  const { root, base, service } = await fixture(t);
  const outside = path.join(base, "outside.mp4");
  await fs.writeFile(outside, "secret-outside-media");
  const pendingDir = path.join(root, "queue", "first", "tiktok", "pending");
  await fs.symlink(outside, path.join(pendingDir, "outside.mp4"));
  const clean = await queue(root, "first", "tiktok", "pending", "clean.mp4");
  await fs.symlink(outside, path.join(pendingDir, "clean.description"));
  await fs.writeFile(path.join(pendingDir, "clean.txt"), "Safe fallback");
  const calendarDir = path.join(root, "queue", "first", "calendar");
  const unsafeCalendarMedia = path.join(calendarDir, "videos", "linked.mp4");
  await fs.symlink(outside, unsafeCalendarMedia);
  await fs.writeFile(path.join(calendarDir, "posts.json"), JSON.stringify([
    { id: "linked", mediaPath: unsafeCalendarMedia, platforms: ["youtube"], status: "scheduled" },
    { id: "external", mediaPath: outside, platforms: ["youtube"], status: "scheduled" },
    { id: "other-account", mediaPath: clean, platforms: ["youtube"], status: "scheduled" },
  ]));
  const secondCalendar = path.join(root, "queue", "second", "calendar", "posts.json");
  await fs.unlink(secondCalendar);
  await fs.symlink(outside, secondCalendar);
  const snapshot = await service.collect();
  assert.equal(snapshot.posts.filter((post) => post.source === "queue").length, 1);
  assert.equal(snapshot.posts.find((post) => post.source === "queue").caption, "Safe fallback");
  assert.ok(snapshot.posts.filter((post) => post.source === "calendar").every((post) => post.mediaUrl === null && post.sizeBytes === null));
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-outside-media/);
  assert.ok(snapshot.warnings.length >= 5);
  for (const postId of ["calendar:linked", "calendar:external", "calendar:other-account"]) await assert.rejects(service.resolveMedia("first", postId), { status: 404 });
  const firstRoot = path.join(root, "queue", "first");
  await fs.rm(firstRoot, { recursive: true });
  await fs.symlink(path.join(root, "queue", "second"), firstRoot);
  const after = await service.collect();
  assert.equal(after.posts.length, 0);
  assert.ok(after.warnings.some((warning) => warning.accountId === "first" && warning.source === "queue"));
});

test("supports data root symlinks and isolates malformed calendar entries", async (t) => {
  const { root, base } = await fixture(t, [{ id: "first", name: "First" }]);
  const alias = path.join(base, "alias");
  await fs.symlink(root, alias);
  const actualPath = path.join(root, "queue", "first", "calendar", "videos", "one.mp4");
  await fs.writeFile(actualPath, "one");
  await fs.writeFile(path.join(root, "queue", "first", "calendar", "posts.json"), JSON.stringify([
    null,
    { id: "../sensitive", mediaPath: actualPath },
    { id: "one", mediaPath: actualPath.replace(root, alias), caption: "First", platforms: ["x"], status: "invented" },
    { id: "one", mediaPath: actualPath, caption: "Duplicate" },
  ]));
  const service = createAccountDataService({ root: alias, getAccounts: async () => [{ id: "first", name: "First" }], getSessionStatus: async () => false });
  const snapshot = await service.collect();
  assert.equal(snapshot.posts.length, 1);
  assert.equal(snapshot.posts[0].status, "unknown");
  assert.equal(snapshot.summary.unknown, 1);
  assert.equal(snapshot.warnings.length, 3);
  assert.equal(await service.resolveMedia("first", "calendar:one"), actualPath);
});
