const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const { validatePasswordHash } = require("../src/dashboard-auth");

async function main() {
  const root = path.resolve(__dirname, "..");
  const values = dotenv.parse(await fs.readFile(path.join(root, ".env")));
  if (!validatePasswordHash(values.DASHBOARD_PASSWORD_HASH)) throw new Error("Configure a dashboard password before preparing cloud secrets.");
  const output = path.join(root, ".local", "cloud-deployment", "secrets");
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(output, "dashboard-password-hash"), values.DASHBOARD_PASSWORD_HASH + "\n", { mode: 0o600 });
  const runtime = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].filter((k) => values[k]).map((k) => `${k}=${JSON.stringify(values[k])}`).join("\n");
  await fs.writeFile(path.join(output, "runtime.env"), runtime + "\n", { mode: 0o600 });
  const keyFile = path.join(output, "backup.key");
  try { await fs.writeFile(keyFile, crypto.randomBytes(32), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  console.log(JSON.stringify({ secretsDirectory: output, secretValuesPrinted: false }));
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
