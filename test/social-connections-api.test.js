const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { createSocialConnectionService } = require("../src/social-connection-service");
const { createDashboardRequestGuard } = require("../src/request-guard");
const { hashPassword, installDashboardAuth } = require("../src/dashboard-auth");
const { installPublicAppRoutes, installSocialConnectionRoutes } = require("../src/social-connection-routes");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-social-api-"));
  const accounts = [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }];
  const calls = { exchanges: [], tiktokPosts: 0, telegramPosts: 0, configured: 0 };
  const providers = {
    tiktok: {
      id: "tiktok", name: "TikTok", authType: "oauth", configured: true, missingEnv: [], supportsPKCE: true,
      authorizationUrl: ({ redirectUri, state, codeChallenge }) => {
        const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
        url.search = new URLSearchParams({ redirect_uri: redirectUri, state, code_challenge: codeChallenge });
        return url.href;
      },
      exchangeCode: async (input) => {
        calls.exchanges.push(input);
        return { accessToken: "PRIVATE_OAUTH_ACCESS", refreshToken: "PRIVATE_OAUTH_REFRESH", expiresAt: new Date(Date.now() + 3600000).toISOString(), scope: ["user.info.basic", "video.list"] };
      },
      readProfile: async () => ({ id: "creator-1", username: "creator", displayName: "Creator", metrics: { followers: 12 }, accessToken: "PRIVATE_PROFILE_FIELD" }),
      readPosts: async (_grant, { onProgress }) => {
        calls.tiktokPosts += 1;
        await onProgress?.({ pages: 1, posts: 1, cursor: null });
        return { posts: [{ id: "video-1", caption: "Imported post", mediaType: "video", refreshToken: "PRIVATE_POST_FIELD" }], pages: 1, complete: true, cursor: null };
      },
    },
    telegram: {
      id: "telegram", name: "Telegram", authType: "configured", configured: true, missingEnv: [],
      configuredToken: () => { calls.configured += 1; return { accessToken: "PRIVATE_TELEGRAM_TOKEN", chatId: "@channel", scope: [] }; },
      readProfile: async (grant) => {
        assert.equal(grant.chatId, "@channel");
        return { id: "-10042", username: "channel", displayName: "Channel", metrics: { followers: 35 } };
      },
      readPosts: async () => {
        calls.telegramPosts += 1;
        return { posts: [{ id: "message-1", caption: "Observed channel post", mediaType: "text" }], pages: 1, complete: false, cursor: null, coverageReason: "telegram_pending_updates_only", warnings: ["Полная история канала недоступна через Bot API."] };
      },
    },
  };
  const service = createSocialConnectionService({ root, providers, publicUrl: "https://autosocial.example.com", getAccounts: async () => accounts });
  const app = express();
  app.set("trust proxy", 1);
  app.use(createDashboardRequestGuard({ publicUrl: "https://autosocial.example.com" }));
  installPublicAppRoutes(app, { service });
  installDashboardAuth(app, { passwordHash: await hashPassword("social-route-test-password") });
  app.use(express.json({ limit: "8kb" }));
  installSocialConnectionRoutes(app, { service, getActiveAccount: async () => accounts[1] });
  app.use(express.static(path.join(__dirname, "..", "web")));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(async () => {
    await service.shutdown();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await fs.rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
    body: JSON.stringify({ password: "social-route-test-password" }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /SameSite=Strict/);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
  return { origin, headers, service, calls };
}

test("social HTTP routes enforce login and same-origin mutations while allowing bound OAuth callbacks without dashboard cookies", async (t) => {
  const { origin, headers, service, calls } = await fixture(t);
  for (const [method, route] of [
    ["GET", "/api/social-connections"],
    ["POST", "/api/social-connections/tiktok/connect"],
    ["POST", "/api/social-connections/unknown/sync"],
    ["DELETE", "/api/social-connections/unknown"],
  ]) {
    const response = await fetch(origin + route, { method, headers: { Origin: origin, "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, 401, `${method} ${route} requires login`);
  }
  const crossSite = await fetch(origin + "/api/social-connections/tiktok/connect", {
    method: "POST", headers: { ...headers, Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify({ accountId: "alpha" }),
  });
  assert.equal(crossSite.status, 403);
  assert.equal(calls.exchanges.length, 0);
  const begin = await fetch(origin + "/api/social-connections/tiktok/connect", { method: "POST", headers, body: JSON.stringify({ accountId: "alpha" }) });
  assert.equal(begin.status, 200);
  const beginBody = await begin.json();
  const authorization = new URL(beginBody.authorizationUrl);
  assert.equal(authorization.origin, "https://www.tiktok.com");
  const setCookie = begin.headers.get("set-cookie");
  assert.match(setCookie, /^autosocial_oauth_tiktok=/);
  assert.match(setCookie, /Path=\/api\/social-connections\/oauth\/tiktok\/callback/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=600/);
  assert.doesNotMatch(JSON.stringify(beginBody), /PRIVATE_|stateCookie|codeVerifier|accessToken|refreshToken/);
  const state = authorization.searchParams.get("state");
  const sensitiveCode = 'PRIVATE_CALLBACK_CODE<script>alert("no")</script>';
  const query = new URLSearchParams({ state, code: sensitiveCode });
  const callbackPath = "/api/social-connections/oauth/tiktok/callback?" + query;
  const missingCookie = await fetch(origin + callbackPath);
  assert.equal(missingCookie.status, 400);
  assert.doesNotMatch(await missingCookie.text(), /PRIVATE_|<script>|accessToken|refreshToken/);
  assert.equal(calls.exchanges.length, 0);
  const callback = await fetch(origin + callbackPath, {
    // The provider's top-level return has the dedicated Lax nonce cookie,
    // while the dashboard's Strict session cookie is deliberately absent.
    headers: { Cookie: setCookie.split(";")[0], Origin: "https://www.tiktok.com", "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(callback.status, 200);
  assert.equal(callback.headers.get("cache-control"), "no-store");
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  assert.equal(callback.headers.get("x-content-type-options"), "nosniff");
  assert.match(callback.headers.get("content-security-policy"), /default-src 'none'/);
  const callbackBody = await callback.text();
  assert.match(callbackBody, /Аккаунт подключён/);
  assert.doesNotMatch(callbackBody, /PRIVATE_|<script>|accessToken|refreshToken/);
  assert.equal(calls.exchanges.length, 1);
  assert.equal(calls.exchanges[0].code, sensitiveCode);
  assert.equal(calls.exchanges[0].redirectUri, "https://autosocial.example.com/api/social-connections/oauth/tiktok/callback");
  await service.waitForIdle();
  assert.equal(calls.tiktokPosts, 1, "the callback must trigger exactly one initial import");
  const replay = await fetch(origin + callbackPath, { headers: { Cookie: setCookie.split(";")[0] } });
  assert.equal(replay.status, 400);
  assert.doesNotMatch(await replay.text(), /PRIVATE_|<script>|accessToken|refreshToken/);
  assert.equal(calls.exchanges.length, 1);
  const badState = await fetch(origin + "/api/social-connections/oauth/tiktok/callback?state=PRIVATE_BAD_STATE&code=PRIVATE_BAD_CODE");
  assert.equal(badState.status, 400);
  assert.doesNotMatch(await badState.text(), /PRIVATE_|accessToken|refreshToken/);
  assert.equal((await fetch(origin + "/api/social-connections")).status, 401);
  const collected = await fetch(origin + "/api/social-connections", { headers });
  assert.equal(collected.status, 200);
  const snapshot = await collected.json();
  assert.equal(snapshot.connections.length, 1);
  assert.equal(snapshot.connections[0].accountId, "alpha");
  assert.equal(snapshot.connections[0].job.status, "completed");
  assert.equal(snapshot.connections[0].posts[0].caption, "Imported post");
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|accessToken|refreshToken|codeVerifier|bindingHash/);
});

test("configured Telegram routes use the active account, sync and disconnect safely, and serve generic app assets before login", async (t) => {
  const { origin, headers, service, calls } = await fixture(t);
  for (const asset of ["manifest.webmanifest", "sw.js", "offline.html", "pwa.js", "pwa.css", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"]) {
    const response = await fetch(`${origin}/${asset}`, { redirect: "manual" });
    assert.equal(response.status, 200, `public asset ${asset} must load before authentication`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (asset === "sw.js") assert.equal(response.headers.get("service-worker-allowed"), "/");
    if (asset === "manifest.webmanifest") {
      assert.match(response.headers.get("content-type"), /application\/manifest\+json/);
      const manifest = await response.json();
      assert.equal(manifest.display, "standalone");
      assert.ok(manifest.icons.length >= 2);
    } else if (asset.endsWith(".png")) {
      const image = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    } else {
      assert.doesNotMatch(await response.text(), /PRIVATE_|accessToken|refreshToken/);
    }
  }
  const privateScript = await fetch(origin + "/app.js", { redirect: "manual" });
  assert.equal(privateScript.status, 302);
  assert.equal(privateScript.headers.get("location"), "/login");
  const connectResponse = await fetch(origin + "/api/social-connections/telegram/connect", { method: "POST", headers, body: "{}" });
  assert.equal(connectResponse.status, 202);
  const { connection } = await connectResponse.json();
  assert.equal(connection.accountId, "beta", "omitting accountId must use the active brand");
  assert.equal(connection.provider, "telegram");
  assert.equal(connectResponse.headers.get("set-cookie"), null, "configured connections do not create OAuth cookies");
  await service.waitForIdle();
  assert.equal(calls.configured, 1);
  assert.equal(calls.telegramPosts, 1, "configured connect must trigger exactly one initial import");
  let snapshot = await (await fetch(origin + "/api/social-connections", { headers })).json();
  assert.equal(snapshot.connections[0].coverageReason, "telegram_pending_updates_only");
  assert.equal(snapshot.connections[0].complete, false);
  assert.equal(snapshot.connections[0].job.status, "partial");
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|accessToken|refreshToken|chatId/);
  for (const method of ["POST", "DELETE"]) {
    const route = `/api/social-connections/${connection.id}${method === "POST" ? "/sync" : ""}`;
    const blocked = await fetch(origin + route, { method, headers: { ...headers, Origin: "https://attacker.example" }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(blocked.status, 403);
  }
  const sync = await fetch(origin + `/api/social-connections/${connection.id}/sync`, { method: "POST", headers, body: "{}" });
  assert.equal(sync.status, 202);
  assert.equal((await sync.json()).connection.id, connection.id);
  await service.waitForIdle();
  assert.equal(calls.telegramPosts, 2);
  const disconnect = await fetch(origin + `/api/social-connections/${connection.id}`, { method: "DELETE", headers });
  assert.equal(disconnect.status, 200);
  assert.deepEqual(await disconnect.json(), { ok: true });
  snapshot = await (await fetch(origin + "/api/social-connections", { headers })).json();
  assert.deepEqual(snapshot.connections, []);
  assert.equal((await fetch(origin + `/api/social-connections/${connection.id}/sync`, { method: "POST", headers, body: "{}" })).status, 404);
});
