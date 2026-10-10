const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

test("calendar accepts mixed uploads, excludes video-only targets for photos, and rolls back invalid batches", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), ".autosocial-calendar-"));
  process.env.AUTOSOCIAL_DATA_DIR = dir;
  process.env.AUTOSOCIAL_ENV_FILE = path.join(dir, "settings.env");
  process.env.DASHBOARD_HOST = "127.0.0.1";
  process.env.DASHBOARD_PORT = "0";
  process.env.DASHBOARD_PASSWORD_HASH = "";
  const photoCalls = [];
  for (const platform of ["instagram", "telegram", "x"]) {
    t.mock.method(require(`../src/${platform}-uploader`), "uploadPhoto", async (options) => { photoCalls.push({ platform, path: options.photoPath }); return { ok: true }; });
  }
  const { createServer } = require("../src/dashboard-server");
  const { server, shutdown } = await createServer({ startBackground: false });
  t.after(async () => { await shutdown(); await fs.rm(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "blue" } }).png().toBuffer();
  const form = (files, platforms = ["instagram", "telegram", "x", "youtube", "tiktok"]) => {
    const body = new FormData();
    for (const [name, data, type] of files) body.append("videos", new Blob([data], { type }), name);
    body.append("platforms", JSON.stringify(platforms));
    body.append("scheduledAt", "2099-01-01T12:00:00.000Z");
    body.append("caption", "Тестовая подпись");
    return body;
  };
  const upload = async (body) => {
    const response = await fetch(`${url}/api/calendar/posts/batch`, { method: "POST", headers: { Origin: url }, body });
    return { status: response.status, ...await response.json() };
  };
  const mixed = await upload(form([["фото.PNG", png, "image/png"], ["video.mp4", Buffer.from("legacy-video-fixture"), "video/mp4"]]));
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.posts[0].platforms, ["instagram", "telegram", "x"]);
  assert.equal(mixed.posts[0].mediaType, "photo");
  assert.equal(mixed.posts[0].mediaFilename, "фото.PNG");
  assert.deepEqual(mixed.posts[1].platforms, ["instagram", "telegram", "x", "youtube", "tiktok"]);
  assert.equal(mixed.posts[1].mediaType, "video");
  const media = await fetch(`${url}/api/calendar/posts/${mixed.posts[0].id}/media`);
  assert.match(media.headers.get("content-type"), /image\/jpeg/);
  assert.equal((await sharp(Buffer.from(await media.arrayBuffer())).metadata()).format, "jpeg");
  const published = await fetch(`${url}/api/calendar/posts/${mixed.posts[0].id}/publish-now`, { method: "POST", headers: { Origin: url } });
  assert.equal((await published.json()).post.status, "published");
  assert.deepEqual(photoCalls.map((call) => call.platform), ["instagram", "telegram", "x"]);
  assert.ok(photoCalls.every((call) => call.path === mixed.posts[0].mediaPath));
  assert.equal((await upload(form([["photo.png", png, "image/png"]], ["youtube"]))).status, 400);
  assert.equal((await upload(form([["photo.png", png, "image/png"], ["bad.png", "bad data", "image/png"]]))).status, 400);
  const posts = (await (await fetch(`${url}/api/calendar/posts`)).json()).posts;
  assert.equal(posts.length, 2);
  assert.equal((await fs.readdir(path.join(dir, "queue", "default", "calendar", "videos"))).length, 2);
  assert.deepEqual(await fs.readdir(path.join(dir, "uploads", "tmp")), []);
  const deleted = await fetch(`${url}/api/calendar/posts/${mixed.posts[0].id}`, { method: "DELETE", headers: { Origin: url } });
  assert.equal((await deleted.json()).ok, true);
  await assert.rejects(fs.stat(mixed.posts[0].mediaPath), { code: "ENOENT" });
});
