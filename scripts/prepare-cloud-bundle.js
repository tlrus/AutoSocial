const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const included = [
  "src", "web", "test", "package.json", "package-lock.json", "Dockerfile", ".dockerignore", ".gitignore", ".gitattributes", ".env.example",
  "README.md", "SETUP.md", "docs/AGENT-POSTS.md", "docs/CLOUD-MIGRATION.md", "docs/WEB_APP_DEPLOYMENT.md", ".github/workflows/ci.yml",
  "deploy/compose.yaml", "deploy/compose.web.yaml", "deploy/Caddyfile", "deploy/.env.example", "deploy/entrypoint.sh", "deploy/backup.sh", "deploy/autosocial-backup.service", "deploy/autosocial-backup.timer",
  "autodownload/watcher.js", "scripts/doctor.js", "scripts/setup-dashboard-password.js", "scripts/check-syntax.js", "scripts/clean-runtime.js",
  "scripts/cloud-data.js", "scripts/cloud-smoke.js", "scripts/prepare-cloud-secrets.js", "scripts/prepare-cloud-bundle.js",
  "sites/worker.mjs", "sites/build.mjs", "sites/package.json", "sites/worker.test.mjs",
];

async function rejectLinks(file) {
  const info = await fs.lstat(file);
  if (info.isSymbolicLink()) throw new Error("Cloud bundle cannot contain symbolic links.");
  if (info.isDirectory()) {
    for (const name of await fs.readdir(file)) await rejectLinks(path.join(file, name));
  }
}

async function main() {
  for (const item of included) await rejectLinks(path.join(root, item));
  const outputDir = path.join(root, ".local", "cloud-deployment");
  await fs.mkdir(outputDir, { recursive: true });
  const output = path.join(outputDir, "autosocial-source.tar.gz");
  const manifest = { createdAt: new Date().toISOString(), files: [] };
  async function inventory(relative) {
    const full = path.join(root, relative);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) { for (const name of await fs.readdir(full)) await inventory(`${relative}/${name}`); return; }
    const bytes = await fs.readFile(full);
    const secretPatterns = [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{20,}/, /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/];
    if (secretPatterns.some((p) => p.test(bytes.toString("utf8")))) throw new Error(`Potential secret found in source file: ${relative}`);
    manifest.files.push({ path: relative, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  }
  for (const item of included) await inventory(item);
  await fs.writeFile(path.join(outputDir, "source-manifest.json"), JSON.stringify(manifest, null, 2));
  const archive = spawnSync("tar", ["-czf", output, ...included], { cwd: root, encoding: "utf8", windowsHide: true });
  if (archive.status !== 0) throw new Error(archive.stderr || archive.error?.message || "Archive creation failed.");
  const listing = spawnSync("tar", ["-tzf", output], { cwd: root, encoding: "utf8", windowsHide: true });
  if (listing.status !== 0) throw new Error("Could not verify cloud archive.");
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/, "");
    if (!included.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed}/`))) throw new Error("Unexpected cloud archive entry.");
    if (/(^|\/)\.env$|\.profiles|\.local|\.git\//.test(entry)) throw new Error("Private runtime data cannot be bundled.");
  }
  const sha256 = crypto.createHash("sha256").update(await fs.readFile(output)).digest("hex");
  await fs.writeFile(`${output}.sha256`, `${sha256}  autosocial-source.tar.gz\n`);
  console.log(JSON.stringify({ archive: output, entries: entries.length, sourceFiles: manifest.files.length, sha256, privateRuntimeIncluded: false }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
