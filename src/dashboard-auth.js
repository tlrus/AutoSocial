const crypto = require("node:crypto");
const { promisify } = require("node:util");
const path = require("node:path");
const express = require("express");
const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = "autosocial_session";

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString("hex")}`;
}

function validatePasswordHash(hash) {
  return /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash);
}

async function verifyPassword(password, hash) {
  if (!validatePasswordHash(hash) || typeof password !== "string" || password.length > 1024) return false;
  const [, salt, expected] = hash.split(":");
  const key = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(key, Buffer.from(expected, "hex"));
}

function installDashboardAuth(app, { passwordHash = "", now = Date.now } = {}) {
  const enabled = Boolean(passwordHash);
  if (enabled && !validatePasswordHash(passwordHash)) throw new Error("Invalid DASHBOARD_PASSWORD_HASH. Run npm run setup:password.");
  const sessions = new Map();
  const attempts = new Map();
  let inFlight = 0;
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
  function sessionKey(req) {
    const token = String(req.headers.cookie || "").split(";")
      .map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    return token ? digest(token.slice(COOKIE.length + 1)) : "";
  }
  function authenticated(req) {
    if (!enabled) return true;
    const key = sessionKey(req);
    const expires = sessions.get(key);
    if (expires > now()) return true;
    sessions.delete(key);
    return false;
  }
  function cookieOptions(req) {
    return { httpOnly: true, sameSite: "strict", secure: req.secure, path: "/" };
  }
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "same-origin");
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/healthz", (req, res) => res.json({ ok: true }));
  app.get("/login", (req, res) => {
    if (authenticated(req)) return res.redirect("/");
    res.sendFile(path.join(__dirname, "..", "web", "login.html"));
  });
  app.get("/login.js", (req, res) => res.sendFile(path.join(__dirname, "..", "web", "login.js")));
  app.get("/api/auth/status", (req, res) => res.json({ enabled, authenticated: authenticated(req) }));
  app.post("/api/auth/login", express.json({ limit: "4kb" }), async (req, res, next) => {
    if (!enabled) return res.json({ ok: true });
    const time = now();
    for (const [key, entry] of attempts) if (entry.until <= time) attempts.delete(key);
    for (const [key, expires] of sessions) if (expires <= time) sessions.delete(key);
    const address = req.ip;
    const entry = attempts.get(address) || { count: 0, until: time + 15 * 60 * 1000 };
    if (entry.count >= 5 || inFlight >= 4 || attempts.size >= 10000 || sessions.size >= 1000) {
      res.set("Retry-After", "900");
      return res.status(429).json({ ok: false, error: "Too many attempts. Try again in 15 minutes." });
    }
    entry.count += 1;
    attempts.set(address, entry);
    inFlight += 1;
    try {
      if (!await verifyPassword(req.body?.password, passwordHash)) {
        return res.status(401).json({ ok: false, error: "Incorrect password." });
      }
      attempts.delete(address);
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(digest(token), time + SESSION_MS);
      res.cookie(COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_MS });
      res.json({ ok: true });
    } catch (error) { next(error); }
    finally { inFlight -= 1; }
  });
  app.post("/api/auth/logout", (req, res) => {
    sessions.delete(sessionKey(req));
    res.clearCookie(COOKIE, cookieOptions(req));
    res.json({ ok: true });
  });
  app.use((req, res, next) => {
    if (authenticated(req)) return next();
    if (req.path.startsWith("/api/") || !["GET", "HEAD"].includes(req.method)) {
      return res.status(401).json({ ok: false, error: "Sign in to AutoSocial." });
    }
    res.redirect("/login");
  });
}

module.exports = { hashPassword, verifyPassword, validatePasswordHash, installDashboardAuth };
