const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const bmp = require("bmp-js");
const { prepareMedia } = require("../src/calendar-media");

test("photo formats become JPEG, with orientation and transparency handled", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-photo-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const raw = { create: { width: 96, height: 64, channels: 4, background: { r: 30, g: 110, b: 210, alpha: 0.5 } } };
  for (const ext of ["jpg", "png", "webp", "gif", "tiff", "avif", "svg", "bmp"]) {
    const source = path.join(dir, `source.${ext}`);
    if (ext === "svg") await fs.writeFile(source, '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" fill="blue"/></svg>');
    else if (ext === "bmp") {
      const data = Buffer.alloc(96 * 64 * 4);
      for (let i = 0; i < data.length; i += 4) { data[i + 1] = 210; data[i + 2] = 110; data[i + 3] = 30; }
      await fs.writeFile(source, bmp.encode({ data, width: 96, height: 64 }).data);
    } else await sharp(raw).toFormat(ext === "jpg" ? "jpeg" : ext).toFile(source);
    const result = await prepareMedia({ sourceFilePath: source, originalFilename: `source.${ext}`, destinationBase: path.join(dir, `output-${ext}`) });
    assert.equal(result.mediaType, "photo", ext);
    const decoded = await sharp(result.mediaPath).metadata();
    assert.equal(decoded.format, "jpeg", ext);
    assert.equal(decoded.width, 96, ext);
    assert.equal(decoded.height, 64, ext);
    assert.equal(decoded.hasAlpha, false, ext);
  }
  const oriented = path.join(dir, "rotated.jpg");
  await sharp(raw).withMetadata({ orientation: 6 }).jpeg().toFile(oriented);
  const result = await prepareMedia({ sourceFilePath: oriented, originalFilename: "rotated.jpg", destinationBase: path.join(dir, "rotated-output") });
  const size = await sharp(result.mediaPath).metadata();
  assert.equal(size.width, 64);
  assert.equal(size.height, 96);
  assert.equal(size.orientation, undefined);
  const panorama = path.join(dir, "panorama.png");
  await sharp({ create: { width: 2000, height: 4, channels: 3, background: "blue" } }).png().toFile(panorama);
  const padded = await prepareMedia({ sourceFilePath: panorama, originalFilename: "panorama.png", destinationBase: path.join(dir, "padded") });
  const paddingSize = await sharp(padded.mediaPath).metadata();
  assert.ok(paddingSize.width / paddingSize.height <= 20);
  const invalid = path.join(dir, "bad.png");
  await fs.writeFile(invalid, "not an image");
  await assert.rejects(prepareMedia({ sourceFilePath: invalid, originalFilename: "bad.png", destinationBase: path.join(dir, "invalid") }), /Не удалось прочитать/);
  await assert.rejects(fs.stat(path.join(dir, "invalid.jpg")), { code: "ENOENT" });
});

test("Telegram photos use sendPhoto with a photo attachment; videos keep sendVideo", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-telegram-photo-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "photo.jpg");
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).jpeg().toFile(file);
  const requests = [];
  t.mock.method(global, "fetch", async (url, options) => { requests.push({ url, form: options.body }); return { json: async () => ({ ok: true, result: { message_id: 123 } }) }; });
  const uploader = require("../src/telegram-uploader");
  assert.equal((await uploader.uploadPhoto({ photoPath: file, caption: "photo caption", botToken: "test-token", chatId: "test-chat" })).ok, true);
  assert.match(requests[0].url, /\/sendPhoto$/);
  assert.equal(requests[0].form.get("photo").type, "image/jpeg");
  assert.equal(requests[0].form.get("video"), null);
  assert.equal(requests[0].form.get("caption"), "photo caption");
  await uploader.uploadVideo({ videoPath: file, botToken: "test-token", chatId: "test-chat" });
  assert.match(requests[1].url, /\/sendVideo$/);
  assert.ok(requests[1].form.get("video"));
});
