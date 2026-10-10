const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const heicDecode = require("heic-decode");
const bmp = require("bmp-js");

const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".jfif", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif", ".svg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mpeg", ".mpg", ".3gp", ".ts", ".mts"]);
const PHOTO_PLATFORMS = new Set(["instagram", "telegram", "x"]);
const MAX_PIXELS = 80_000_000;

function isPhoto(filename, mimeType = "") {
  return mimeType.startsWith("image/") || PHOTO_EXTENSIONS.has(path.extname(filename || "").toLowerCase());
}

async function prepareMedia({ sourceFilePath, originalFilename, mimeType = "", destinationBase }) {
  const ext = path.extname(originalFilename || "").toLowerCase();
  if (!isPhoto(originalFilename, mimeType)) {
    if (!VIDEO_EXTENSIONS.has(ext)) throw new Error("Выберите фото или видео поддерживаемого формата.");
    const mediaPath = `${destinationBase}${ext}`;
    await fs.copyFile(sourceFilePath, mediaPath);
    return { mediaType: "video", mediaPath };
  }
  const stat = await fs.stat(sourceFilePath);
  if (stat.size > 50 * 1024 * 1024) throw new Error("Фото должно быть не больше 50 МБ.");
  const mediaPath = `${destinationBase}.jpg`;
  try {
    let input = await fs.readFile(sourceFilePath);
    let options = { limitInputPixels: MAX_PIXELS, animated: false };
    // The JPEG stored in the calendar is also readable by every photo uploader.
    if ([".heic", ".heif"].includes(ext) || /image\/hei[cf]/i.test(mimeType)) {
      const images = await heicDecode.all({ buffer: input });
      try {
        const image = images[0];
        if (!image || image.width * image.height > MAX_PIXELS) throw new Error("HEIC dimensions are too large");
        const decoded = await image.decode();
        input = Buffer.from(decoded.data);
        options = { raw: { width: decoded.width, height: decoded.height, channels: 4 }, limitInputPixels: MAX_PIXELS };
      } finally { images.dispose(); }
    } else if (input[0] === 0x42 && input[1] === 0x4d) {
      if (input.length < 54) throw new Error("Invalid BMP header");
      const width = Math.abs(input.readInt32LE(18));
      const height = Math.abs(input.readInt32LE(22));
      if (!width || !height || width * height > MAX_PIXELS) throw new Error("BMP dimensions are too large");
      const decoded = bmp.decode(input);
      const rgba = Buffer.alloc(decoded.data.length);
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = decoded.data[i + 3];
        rgba[i + 1] = decoded.data[i + 2];
        rgba[i + 2] = decoded.data[i + 1];
        rgba[i + 3] = 255;
      }
      input = rgba;
      options = { raw: { width: decoded.width, height: decoded.height, channels: 4 }, limitInputPixels: MAX_PIXELS };
    }
    const metadata = await sharp(input, options).metadata();
    let jpeg = await sharp(input, options).rotate().flatten({ background: "#ffffff" })
      .resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    // Telegram accepts photo aspect ratios up to 20:1. Preserve the full picture with padding.
    const size = await sharp(jpeg).metadata();
    if (size.width > size.height * 20 || size.height > size.width * 20) {
      const targetWidth = Math.max(size.width, Math.ceil(size.height / 20));
      const targetHeight = Math.max(size.height, Math.ceil(size.width / 20));
      jpeg = await sharp(jpeg).extend({ right: targetWidth - size.width, bottom: targetHeight - size.height, background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
    }
    if (jpeg.length > 5 * 1024 * 1024) jpeg = await sharp(jpeg).resize(1536, 1536, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
    await fs.writeFile(mediaPath, jpeg);
    return { mediaType: "photo", mediaPath, sourceFormat: metadata.format, firstFrameOnly: (metadata.pages || 1) > 1 };
  } catch {
    await fs.unlink(mediaPath).catch(() => {});
    throw new Error(`Не удалось прочитать фото «${originalFilename || "из буфера"}». Поддерживаются JPG, PNG, WEBP, GIF, BMP, TIFF, HEIC/HEIF, AVIF и SVG. Проверьте, что файл не повреждён.`);
  }
}

module.exports = { prepareMedia, isPhoto, PHOTO_PLATFORMS };
