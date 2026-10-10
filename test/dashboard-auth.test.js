const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { hashPassword, verifyPassword, installDashboardAuth } = require("../src/dashboard-auth");
const { createDashboardRequestGuard } = require("../src/request-guard");

async function fixture(t, { secure = false, now } = {}) {
  const hash = await hashPassword("a-test-password-123");
  const app = express();
  if (secure) app.set("trust proxy", 1);
  app.use(createDashboardRequestGuard());
  installDashboardAuth(app, { passwordHash: hash, now });
  app.get("/api/private", (req, res) => res.json({ private: true }));
  app.get("/private-media", (req, res) => res.send("secret media"));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const login = (password, extra = {}) => fetch(`${url}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: url, ...extra }, body: JSON.stringify({ password }),
  });
  return { url, login, hash };
}

test("passwords are salted and verify without storing the password", async () => {
  const a = await hashPassword("my-password");
  const b = await hashPassword("my-password");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("my-password", a), true);
  assert.equal(await verifyPassword("wrong", a), false);
  assert.equal(await verifyPassword("my-password", "invalid"), false);
});

test("login protects API and media, logout revokes the session", async (t) => {
  const { url, login } = await fixture(t);
  assert.equal((await fetch(`${url}/api/private`)).status, 401);
  const blocked = await fetch(`${url}/private-media`, { redirect: "manual" });
  assert.equal(blocked.status, 302);
  assert.equal(blocked.headers.get("location"), "/login");
  assert.equal((await login("wrong")).status, 401);
  const response = await login("a-test-password-123");
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0];
  assert.equal((await fetch(`${url}/api/private`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${url}/api/auth/logout`, { method: "POST", headers: { cookie, Origin: url } })).status, 200);
  assert.equal((await fetch(`${url}/api/private`, { headers: { cookie } })).status, 401);
});

test("HTTPS proxy uses Secure cookie and expired sessions are rejected", async (t) => {
  let time = Date.now();
  const { url, login } = await fixture(t, { secure: true, now: () => time });
  const response = await login("a-test-password-123", { "X-Forwarded-Proto": "https" });
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /; Secure/);
  time += 13 * 60 * 60 * 1000;
  assert.equal((await fetch(`${url}/api/private`, { headers: { cookie: setCookie.split(";")[0] } })).status, 401);
});

test("login limits attempts and rejects cross-origin requests", async (t) => {
  const { login } = await fixture(t);
  assert.equal((await login("a-test-password-123", { Origin: "https://attacker.example" })).status, 403);
  for (let i = 0; i < 5; i += 1) assert.equal((await login("wrong")).status, 401);
  assert.equal((await login("a-test-password-123")).status, 429);
});
