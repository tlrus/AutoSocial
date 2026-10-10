const fs = require("node:fs/promises");
const path = require("node:path");

function normalizeInstagramCookies(input, now = Date.now()) {
  let source = input;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { throw new Error("Paste a valid cookies JSON export."); }
  }
  const sourceCookies = Array.isArray(source) ? source : source?.cookies;
  const candidates = sourceCookies || [
    { name: "sessionid", value: source?.sessionid },
    { name: "ds_user_id", value: source?.ds_user_id },
  ];
  if (!Array.isArray(candidates) || candidates.length > 150) throw new Error("Invalid cookies export.");
  const cookies = candidates.filter((cookie) => {
    if (!cookie || typeof cookie !== "object") return false;
    return !cookie.domain || /^(\.)?([a-z0-9-]+\.)*instagram\.com$/i.test(cookie.domain);
  }).map((cookie) => {
    const expires = Number(cookie.expires ?? cookie.expirationDate ?? -1);
    const value = String(cookie.value || "").trim();
    if (!value || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error("Cookie values must be nonempty and valid.");
    if (!cookie.name || !/^[A-Za-z0-9_-]+$/.test(cookie.name)) throw new Error("Invalid cookie name.");
    if (!Number.isFinite(expires) || (expires > 0 && expires * 1000 <= now)) throw new Error("The cookies have expired. Export a fresh Instagram session.");
    const sameSite = String(cookie.sameSite || "Lax").toLowerCase();
    return {
      name: cookie.name, value, domain: cookie.domain || ".instagram.com",
      path: cookie.path?.startsWith("/") ? cookie.path : "/",
      expires: expires > 0 ? expires : -1, httpOnly: Boolean(cookie.httpOnly ?? true), secure: true,
      sameSite: { strict: "Strict", lax: "Lax", none: "None", no_restriction: "None" }[sameSite] || "Lax",
    };
  });
  for (const name of ["sessionid", "ds_user_id"]) {
    if (!cookies.some((cookie) => cookie.name === name)) throw new Error("Both sessionid and ds_user_id are required.");
  }
  if (!/^\d+$/.test(cookies.find((cookie) => cookie.name === "ds_user_id").value)) throw new Error("ds_user_id must contain the numeric Instagram user ID.");
  return cookies;
}

function sessionPath(profileDir) { return path.join(profileDir, ".instagram-session.json"); }

async function readInstagramSession(profileDir) {
  try {
    const data = JSON.parse(await fs.readFile(sessionPath(profileDir), "utf8"));
    return { cookies: normalizeInstagramCookies(data), verifiedAt: data.verifiedAt || null };
  } catch { return null; }
}

async function saveInstagramSession(profileDir, cookies) {
  await fs.mkdir(profileDir, { recursive: true });
  const target = sessionPath(profileDir);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ cookies: normalizeInstagramCookies(cookies), verifiedAt: new Date().toISOString() }), { mode: 0o600 });
  await fs.rename(temp, target);
}

module.exports = { normalizeInstagramCookies, readInstagramSession, saveInstagramSession };
