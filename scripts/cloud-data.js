// Authenticated, encrypted runtime snapshots. No credentials or content are logged.
const fs = require("node:fs/promises");
const io = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const dotenv = require("dotenv");

const MAGIC = Buffer.from("AUTOSOCIALv1\n");
const MANIFEST = ".autosocial-migration.json";
const ROOTS = ["queue", "user-assets", ".scheduler-state", "accounts-state.json", "about-me.md", "autodownload-state.json", "autodownload/downloads", "autodownload/profile_downloads", "autodownload/archive.txt"];
const SETTINGS = ["CRON_EXPRESSION", "INSTAGRAM_CRON_EXPRESSION", "YOUTUBE_CRON_EXPRESSION", "TELEGRAM_CRON_EXPRESSION", "X_CRON_EXPRESSION", "TZ", "BROWSER_LOCALE", "POST_DELAY_MS", "POST_PUBLISH_HOLD_MS", "FAILURE_HOLD_MS", "AUTO_ADD_SOUND", "RANDOM_QUEUE_ORDER", "DEFAULT_CAPTION", "DEFAULT_SOUND_QUERY", "WATCH_CHANNEL", "WATCH_INTERVAL", "WATCH_MAX_VIDEOS", "WATCH_MIN_VIEWS", "AUTO_POST_PLATFORMS"];
const hash = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const normalized = (value) => value.replace(/\\/g, "/");

function safeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some((p) => p === ".." || p === ".")) throw new Error("Unsafe snapshot path.");
  return value.replace(/\/$/, "");
}
function allowed(value) {
  return ROOTS.some((r) => value === r || value.startsWith(r + "/")) || value === "settings.env" || /^\.profiles\/[a-z0-9_-]+\/instagram\/\.instagram-session\.json$/.test(value);
}
async function keyFrom(file) {
  const key = await fs.readFile(file);
  if (key.length !== 32) throw new Error("Backup key must contain exactly 32 bytes.");
  return key;
}
async function fileHash(file) {
  const digest = crypto.createHash("sha256");
  for await (const chunk of io.createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
async function filesUnder(root, relative) {
  const full = path.join(root, relative);
  let info;
  try { info = await fs.lstat(full); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  if (info.isSymbolicLink()) throw new Error("Runtime snapshots cannot include symbolic links.");
  if (info.isFile()) return [normalized(relative)];
  if (!info.isDirectory()) throw new Error("Runtime snapshots only accept regular files.");
  const result = [];
  for (const name of await fs.readdir(full)) result.push(...await filesUnder(root, path.join(relative, name)));
  return result;
}
function tarDone(child) {
  child.stderr.resume();
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Snapshot archive operation failed.")));
  });
}

async function exportData({ source, outputDir, keyFile }) {
  source = path.resolve(source);
  outputDir = path.resolve(outputDir);
  const key = await keyFrom(keyFile);
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const stage = await fs.mkdtemp(path.join(outputDir, ".snapshot-"));
  const manifest = { version: 1, sourceRoot: source, createdAt: new Date().toISOString(), files: [] };
  const snapshot = path.join(outputDir, `autosocial-data-${manifest.createdAt.replace(/[:.]/g, "-")}.enc`);
  try {
    let names = [];
    for (const root of ROOTS) names.push(...await filesUnder(source, root));
    const profiles = path.join(source, ".profiles");
    for (const id of await fs.readdir(profiles).catch((e) => e.code === "ENOENT" ? [] : Promise.reject(e))) {
      if (/^[a-z0-9_-]+$/.test(id)) names.push(...await filesUnder(source, `.profiles/${id}/instagram/.instagram-session.json`));
    }
    for (const relative of [...new Set(names)].sort()) {
      safeRelative(relative);
      if (!allowed(relative)) throw new Error("Unexpected runtime file.");
      const from = path.join(source, relative), to = path.join(stage, relative);
      await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      const before = await fs.stat(from);
      await fs.copyFile(from, to);
      const copiedHash = await fileHash(to);
      const after = await fs.stat(from);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || copiedHash !== await fileHash(from)) throw new Error("Runtime data changed during the snapshot. Pause writers before the final export.");
      if (/\/calendar\/posts\.json$/.test(relative)) {
        const posts = JSON.parse(await fs.readFile(to, "utf8"));
        if (posts.some((p) => p.status === "publishing")) throw new Error("Wait for the active publication before exporting data.");
      }
      manifest.files.push({ path: relative, bytes: before.size, sha256: copiedHash });
    }
    const raw = await fs.readFile(path.join(source, "settings.env"), "utf8").catch(() => fs.readFile(path.join(source, ".env"), "utf8").catch(() => ""));
    const env = dotenv.parse(raw);
    const settings = Buffer.from(SETTINGS.filter((k) => env[k] !== undefined).map((k) => `${k}=${JSON.stringify(env[k])}`).join("\n") + "\nAUTOSOCIAL_START_BACKGROUND=false\n");
    await fs.writeFile(path.join(stage, "settings.env"), settings, { mode: 0o600 });
    manifest.files.push({ path: "settings.env", bytes: settings.length, sha256: hash(settings) });
    await fs.writeFile(path.join(stage, MANIFEST), JSON.stringify(manifest), { mode: 0o600 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(MAGIC);
    await fs.writeFile(snapshot, Buffer.concat([MAGIC, iv]), { flag: "wx", mode: 0o600 });
    const child = spawn("tar", ["-czf", "-", "-C", stage, MANIFEST, ...manifest.files.map((f) => f.path)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    await Promise.all([tarDone(child), pipeline(child.stdout, cipher, io.createWriteStream(snapshot, { flags: "a", mode: 0o600 }))]);
    await fs.appendFile(snapshot, cipher.getAuthTag());
    return { snapshot, files: manifest.files.length, bytes: (await fs.stat(snapshot)).size, sha256: await fileHash(snapshot), encrypted: true, browserProfiles: "portable Instagram session only; Windows browser profiles stay on the source" };
  } finally {
    // Only this operation's generated staging copies; original runtime files remain intact.
    await fs.rm(stage, { recursive: true, force: true });
  }
}

function relocate(value, oldRoot, target, field) {
  if (Array.isArray(value)) return value.map((item) => relocate(item, oldRoot, target, field));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v, oldRoot, target, k)]));
  if (typeof value !== "string") return value;
  // Rebase path metadata, never a caption, prompt, author text, or cookie value.
  if (field && !/(paths?|dirs?)$/i.test(field)) return value;
  const root = normalized(oldRoot).replace(/\/$/, ""), candidate = normalized(value);
  if (!candidate.toLowerCase().startsWith(root.toLowerCase() + "/")) return value;
  const relative = safeRelative(candidate.slice(root.length + 1));
  return target.startsWith("/") ? path.posix.join(target, relative) : path.join(target, ...relative.split("/"));
}

async function restoreData({ snapshot, target, keyFile, pathRoot }) {
  target = path.resolve(target);
  const outputRoot = pathRoot || target;
  if (pathRoot && (!pathRoot.startsWith("/") || pathRoot.split("/").includes("..") || pathRoot.includes("\\"))) throw new Error("--path-root must be an absolute Linux data path without traversal.");
  // Refuse overwrites: restore to a new release/data location, then verify before switching.
  try { await fs.lstat(target); throw new Error("Restore target already exists. Choose a fresh directory."); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  const key = await keyFrom(keyFile);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const stage = await fs.mkdtemp(path.join(path.dirname(target), ".autosocial-restore-"));
  const archive = path.join(stage, "payload.tar.gz");
  let finished = false, createdTarget = false;
  try {
    const handle = await fs.open(snapshot, "r");
    let header, tag, size;
    try {
      size = (await handle.stat()).size;
      if (size < MAGIC.length + 29) throw new Error("Invalid encrypted snapshot.");
      header = Buffer.alloc(MAGIC.length + 12); tag = Buffer.alloc(16);
      await handle.read(header, 0, header.length, 0);
      await handle.read(tag, 0, 16, size - 16);
    } finally { await handle.close(); }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid encrypted snapshot format.");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
    decipher.setAAD(MAGIC); decipher.setAuthTag(tag);
    await pipeline(io.createReadStream(snapshot, { start: header.length, end: size - 17 }), decipher, io.createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    const list = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
    if (list.status !== 0) throw new Error("Could not inspect decrypted snapshot.");
    const entries = list.stdout.split(/\r?\n/).filter(Boolean).map(safeRelative);
    if (!entries.includes(MANIFEST) || entries.some((f) => f !== MANIFEST && !allowed(f)) || new Set(entries).size !== entries.length) throw new Error("Unexpected snapshot paths.");
    const verbose = spawnSync("tar", ["-tvzf", archive], { encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
    if (verbose.status !== 0 || verbose.stdout.split(/\r?\n/).filter(Boolean).some((line) => !line.startsWith("-"))) throw new Error("Snapshot links or special files are not allowed.");
    await fs.mkdir(target, { mode: 0o700 });
    createdTarget = true;
    const extract = spawn("tar", ["-xzf", archive, "-C", target], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    await tarDone(extract);
    const manifest = JSON.parse(await fs.readFile(path.join(target, MANIFEST), "utf8"));
    if (manifest.version !== 1 || typeof manifest.sourceRoot !== "string" || !Array.isArray(manifest.files)) throw new Error("Invalid snapshot manifest.");
    if (entries.length !== manifest.files.length + 1 || manifest.files.some((f) => !entries.includes(f.path))) throw new Error("Snapshot inventory mismatch.");
    for (const file of manifest.files) {
      const full = path.join(target, safeRelative(file.path));
      if ((await fs.stat(full)).size !== file.bytes || await fileHash(full) !== file.sha256) throw new Error("Snapshot checksum mismatch.");
      if (file.path.endsWith(".json")) {
        let data = JSON.parse(await fs.readFile(full, "utf8"));
        data = relocate(data, manifest.sourceRoot, outputRoot);
        // Imported settings must not start filesystem-triggered posting on boot.
        if (/scheduler-state\.json$/.test(file.path) && data && typeof data === "object") data.instantPost = false;
        if (file.path === ".scheduler-state/runtime.json") Object.keys(data).forEach((k) => { if (typeof data[k] === "boolean") data[k] = false; });
        await fs.writeFile(full, JSON.stringify(data, null, 2), { mode: 0o600 });
      }
    }
    finished = true;
    return { target, pathRoot: outputRoot, files: manifest.files.length, checksumsVerified: true, startupAutomationDisabled: true };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    if (!finished && createdTarget) await fs.rm(target, { recursive: true, force: true });
  }
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const values = {};
  for (let i = 0; i < args.length; i += 2) { if (!args[i]?.startsWith("--") || args[i + 1] === undefined) throw new Error("Expected named options."); values[args[i].slice(2)] = args[i + 1]; }
  if (!values["key-file"]) throw new Error("Provide --key-file without printing its contents.");
  const result = mode === "export" && values.source && values["output-dir"]
    ? await exportData({ source: values.source, outputDir: values["output-dir"], keyFile: values["key-file"] })
    : mode === "restore" && values.snapshot && values.target
      ? await restoreData({ snapshot: values.snapshot, target: values.target, keyFile: values["key-file"], pathRoot: values["path-root"] })
      : (() => { throw new Error("Use export --source --output-dir --key-file or restore --snapshot --target --key-file."); })();
  console.log(JSON.stringify(result));
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { exportData, restoreData, relocate, safeRelative };
