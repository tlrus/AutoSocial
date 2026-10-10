const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { hashPassword } = require("../src/dashboard-auth");

async function main() {
  const root = path.resolve(__dirname, "..");
  const envPath = path.resolve(process.env.AUTOSOCIAL_ENV_FILE || path.join(root, ".env"));
  let text = await fs.readFile(envPath, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  if (/^DASHBOARD_PASSWORD_HASH=.+$/m.test(text) && !process.argv.includes("--reset")) {
    console.log("A dashboard password is already configured. Use --reset to replace it.");
    return;
  }
  const password = crypto.randomBytes(18).toString("base64url");
  const hash = await hashPassword(password);
  const line = `DASHBOARD_PASSWORD_HASH=${hash}`;
  text = /^DASHBOARD_PASSWORD_HASH=.*$/m.test(text)
    ? text.replace(/^DASHBOARD_PASSWORD_HASH=.*$/m, line) : `${text.trimEnd()}\n${line}\n`;
  const credentialPath = path.join(root, ".local", "dashboard-access.txt");
  await fs.mkdir(path.dirname(credentialPath), { recursive: true });
  await fs.writeFile(credentialPath, `AutoSocial dashboard password: ${password}\n`, { mode: 0o600 });
  await fs.writeFile(envPath, text, { mode: 0o600 });
  console.log(`Password configured. Credentials saved locally to ${credentialPath}. Restart the dashboard to apply.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
