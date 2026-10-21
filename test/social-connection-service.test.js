const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createSocialConnectionService } = require("../src/social-connection-service");

const deferred = () => { let resolve; const promise = new Promise((finish) => { resolve = finish; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-social-"));
  const clock = { value: Date.parse("2026-10-15T10:00:00Z") };
  const calls = { exchanges: [], refreshes: [], reads: [] };
  const provider = {
    id: "tiktok", name: "TikTok", configured: true, missingEnv: [], supportsPKCE: true, limitations: ["Опубликованные видео владельца аккаунта"],
    authorizationUrl: ({ redirectUri, state, codeChallenge }) => {
      const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
      url.search = new URLSearchParams({ redirect_uri: redirectUri, state, code_challenge: codeChallenge });
      return url.href;
    },
    exchangeCode: async (input) => {
      calls.exchanges.push(input);
      return { accessToken: "private-access-original", refreshToken: "private-refresh-original", expiresAt: new Date(clock.value + 3600000).toISOString(), scope: ["user.info.basic", "video.list"], tokenType: "test_token_type" };
    },
    refreshToken: async (grant) => {
      calls.refreshes.push(grant);
      return { accessToken: "private-access-rotated", refreshToken: "private-refresh-rotated", expiresAt: new Date(clock.value + 3600000).toISOString() };
    },
    readProfile: async (grant) => {
      calls.reads.push(grant);
      return { id: "user-123", username: "creator", displayName: "Creator", avatarUrl: "https://cdn.example.com/photo.jpg", url: "https://www.tiktok.com/@creator", bio: "Profile bio", metrics: { followers: 123, posts: 2, injectedSecret: "private-profile-secret" }, token: "private-profile-token" };
    },
    readPosts: async (_grant, { onProgress }) => {
      await onProgress?.({ pages: 1, posts: 1, cursor: null });
      return { posts: [{ id: "post-1", caption: "Real provider fixture", mediaType: "video", publishedAt: "2026-10-10T12:00:00Z", url: "https://www.tiktok.com/@creator/video/1", mediaUrl: "https://cdn.example.com/video.mp4", metrics: { views: 45 }, accessToken: "private-post-token" }], cursor: null, complete: true, pages: 1 };
    },
    ...options.provider,
  };
  const providers = { tiktok: provider };
  const settings = { root, providers, publicUrl: "https://app.example.com", getAccounts: async () => [{ id: "default", name: "Default" }], now: () => clock.value, ...options.settings };
  const service = createSocialConnectionService(settings);
  const services = [service];
  t.after(async () => { for (const current of services) await current.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, clock, calls, provider, providers, service, settings, services };
}

async function connect(service) {
  const auth = await service.beginAuthorization("tiktok", "default");
  const state = new URL(auth.authorizationUrl).searchParams.get("state");
  const connection = await service.completeAuthorization("tiktok", { state, code: "private-one-use-code", bindingCookie: auth.stateCookie.value });
  return { connection, auth, state };
}

test("OAuth binds state, account and Lax cookie, persists encrypted grants, and synchronizes sanitized API data", async (t) => {
  const { service, root, calls, settings, services } = await fixture(t);
  const { connection, auth, state } = await connect(service);
  assert.equal(auth.stateCookie.httpOnly, true);
  assert.equal(auth.stateCookie.secure, true);
  assert.equal(auth.stateCookie.sameSite, "lax");
  assert.equal(auth.stateCookie.path, "/api/social-connections/oauth/tiktok/callback");
  assert.equal(auth.stateCookie.maxAge, 600000);
  assert.equal(connection.accountId, "default");
  assert.equal(connection.source, "official_api");
  assert.equal(calls.exchanges[0].redirectUri, "https://app.example.com/api/social-connections/oauth/tiktok/callback");
  assert.match(calls.exchanges[0].codeVerifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(new URL(auth.authorizationUrl).searchParams.get("code_challenge"), crypto.createHash("sha256").update(calls.exchanges[0].codeVerifier).digest("base64url"));
  await service.waitForIdle();
  const snapshot = await service.status();
  assert.equal(snapshot.hosting.configured, true);
  assert.equal(snapshot.connections[0].job.status, "completed");
  assert.equal(snapshot.connections[0].posts.length, 1);
  assert.equal(snapshot.connections[0].complete, true);
  assert.equal(snapshot.connections[0].profile.metrics.followers, 123);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-|accessToken|refreshToken|codeVerifier/);
  const vault = path.join(root, ".local", "social-api");
  assert.equal((await fs.stat(vault)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(vault, "vault.key"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(vault, "vault.enc"))).mode & 0o777, 0o600);
  assert.equal((await fs.readFile(path.join(vault, "vault.key"))).length, 32);
  assert.equal((await fs.readFile(path.join(vault, "vault.enc"))).includes(Buffer.from("private-access-original")), false);
  await assert.rejects(service.completeAuthorization("tiktok", { state, code: "replay", bindingCookie: auth.stateCookie.value }), { code: "invalid_oauth_state" });
  await service.shutdown();
  const restarted = createSocialConnectionService(settings);
  services.push(restarted);
  assert.deepEqual((await restarted.status()).connections, snapshot.connections);
});

test("rejects cookie CSRF, expiry, denial, unknown account and unconfigured or temporary hosting", async (t) => {
  const { service, clock, settings, services } = await fixture(t);
  const auth = await service.beginAuthorization("tiktok", "default");
  const state = new URL(auth.authorizationUrl).searchParams.get("state");
  await assert.rejects(service.completeAuthorization("tiktok", { state, code: "code", bindingCookie: "other-browser" }), { code: "invalid_oauth_state" });
  clock.value += 600001;
  await assert.rejects(service.completeAuthorization("tiktok", { state, code: "code", bindingCookie: auth.stateCookie.value }), { code: "invalid_oauth_state" });
  const denied = await service.beginAuthorization("tiktok", "default");
  const deniedState = new URL(denied.authorizationUrl).searchParams.get("state");
  await assert.rejects(service.completeAuthorization("tiktok", { state: deniedState, bindingCookie: denied.stateCookie.value, error: "access_denied private-provider-secret" }), { code: "authorization_denied" });
  await assert.rejects(service.completeAuthorization("tiktok", { state: deniedState, code: "replay", bindingCookie: denied.stateCookie.value }), { code: "invalid_oauth_state" });
  await assert.rejects(service.beginAuthorization("tiktok", "missing"), { status: 404 });
  await assert.rejects(service.beginAuthorization("tiktok", "../bad"), { status: 400 });
  await assert.rejects(service.beginAuthorization("__proto__", "default"), { status: 400 });
  for (const publicUrl of ["", "http://app.example.com", "https://random.tunnelmole.net", "https://random.trycloudflare.com", "https://user:pass@app.example.com", "https://app.example.com/?token=secret"]) {
    const current = createSocialConnectionService({ ...settings, publicUrl });
    services.push(current);
    const snapshot = await current.status();
    assert.equal(snapshot.hosting.configured, false);
    assert.equal(snapshot.providers[0].available, false);
    await assert.rejects(current.beginAuthorization("tiktok", "default"), { code: "public_url_required" });
  }
  const unconfigured = createSocialConnectionService({ ...settings, providers: { tiktok: { ...settings.providers.tiktok, configured: false, missingEnv: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"] } } });
  services.push(unconfigured);
  assert.deepEqual((await unconfigured.status()).providers[0].missingEnv, ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"]);
  await assert.rejects(unconfigured.beginAuthorization("tiktok", "default"), { code: "provider_not_configured" });
});

test("reserves one sync per connection, persists rotated refresh tokens before failure and preserves last good snapshot", async (t) => {
  const { service, clock, calls, provider, settings, services } = await fixture(t);
  const { connection } = await connect(service);
  await service.waitForIdle();
  const previous = (await service.status()).connections[0];
  clock.value += 3600001;
  const started = deferred();
  const release = deferred();
  provider.readPosts = async () => { started.resolve(); await release.promise; throw Object.assign(new Error("private-provider-body access_token=private"), { status: 429 }); };
  await service.sync(connection.id);
  await started.promise;
  await assert.rejects(service.sync(connection.id), { status: 409 });
  assert.equal(calls.refreshes.length, 1);
  release.resolve();
  await service.waitForIdle();
  const failed = (await service.status()).connections[0];
  assert.deepEqual(failed.posts, previous.posts);
  assert.equal(failed.lastSyncedAt, previous.lastSyncedAt);
  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.error.code, "rate_limited");
  assert.doesNotMatch(JSON.stringify(failed), /private-|access_token/);
  await service.shutdown();
  const restarted = createSocialConnectionService(settings);
  services.push(restarted);
  clock.value += 3600001;
  provider.readPosts = async () => ({ posts: [], complete: true, cursor: null, pages: 1 });
  await restarted.sync(connection.id);
  await restarted.waitForIdle();
  assert.equal(calls.refreshes[1].refreshToken, "private-refresh-rotated");
  assert.equal(calls.refreshes[1].tokenType, "test_token_type");
  assert.equal((await restarted.status()).connections[0].job.status, "completed");
});

test("marks expired unrecoverable authorization and does not erase data on provider profile failure", async (t) => {
  const { service, clock, provider } = await fixture(t);
  const { connection } = await connect(service);
  await service.waitForIdle();
  const previous = (await service.status()).connections[0];
  provider.readProfile = async () => { throw Object.assign(new Error("private-token-response"), { status: 401, code: "invalid_token" }); };
  await service.sync(connection.id);
  await service.waitForIdle();
  const failed = (await service.status()).connections[0];
  assert.equal(failed.connectionStatus, "needs_authorization");
  assert.equal(failed.job.error.code, "authorization_required");
  assert.deepEqual(failed.posts, previous.posts);
  await assert.rejects(service.sync(connection.id), { code: "authorization_required" });
  clock.value += 3600001;
});

test("continues bounded API pagination, reports partial completeness and deduplicates posts", async (t) => {
  const cursors = [];
  const { service, provider } = await fixture(t, { provider: {
    readPosts: async (_grant, { cursor, onProgress, maxPages }) => {
      cursors.push(cursor);
      assert.equal(maxPages, 2);
      await onProgress({ pages: 2, posts: 1, cursor: "next-page" });
      return { posts: [{ id: "first", caption: "First" }], complete: false, cursor: "next-page", pages: 2 };
    },
  }, settings: { maxPages: 2 } });
  const { connection } = await connect(service);
  await service.waitForIdle();
  let snapshot = (await service.status()).connections[0];
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.cursor, "next-page");
  assert.equal(snapshot.job.status, "partial");
  assert.equal(snapshot.job.pages, 2);
  provider.readPosts = async (_grant, { cursor }) => {
    cursors.push(cursor);
    return { posts: [{ id: "first", caption: "Duplicate" }, { id: "second", caption: "Second", mediaUrl: "https://cdn.example.com/file?access_token=private-url-token" }], complete: true, cursor: null, pages: 1 };
  };
  await service.sync(connection.id);
  await service.waitForIdle();
  snapshot = (await service.status()).connections[0];
  assert.deepEqual(cursors, [undefined, "next-page"]);
  assert.equal(snapshot.posts.length, 2);
  assert.equal(snapshot.posts[1].mediaUrl, null);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.cursor, null);
  assert.equal(snapshot.job.status, "completed");
});

test("disconnect during an uncooperative refresh cannot recreate tokens or connections", async (t) => {
  const { service, clock, provider, settings, services } = await fixture(t);
  const { connection } = await connect(service);
  await service.waitForIdle();
  clock.value += 3600001;
  const started = deferred();
  const release = deferred();
  provider.refreshToken = async () => { started.resolve(); await release.promise; return { accessToken: "private-new-after-disconnect", refreshToken: "private-new-refresh", expiresAt: new Date(clock.value + 3600000).toISOString() }; };
  await service.sync(connection.id);
  await started.promise;
  await service.disconnect(connection.id);
  release.resolve();
  await service.waitForIdle();
  assert.deepEqual((await service.status()).connections, []);
  await assert.rejects(service.sync(connection.id), { status: 404 });
  await assert.rejects(service.disconnect("__proto__"), { status: 404 });
  await service.shutdown();
  const restarted = createSocialConnectionService(settings);
  services.push(restarted);
  assert.deepEqual((await restarted.status()).connections, []);
});

test("disconnect invalidates a previously started authorization even when token exchange ignores cancellation", async (t) => {
  const { service, provider } = await fixture(t);
  const { connection } = await connect(service);
  await service.waitForIdle();
  const auth = await service.beginAuthorization("tiktok", "default");
  const state = new URL(auth.authorizationUrl).searchParams.get("state");
  const started = deferred();
  const release = deferred();
  const originalExchange = provider.exchangeCode;
  provider.exchangeCode = async (input) => { started.resolve(); await release.promise; return originalExchange(input); };
  const finishing = service.completeAuthorization("tiktok", { state, code: "late-code", bindingCookie: auth.stateCookie.value });
  await started.promise;
  await service.disconnect(connection.id);
  release.resolve();
  await assert.rejects(finishing, { code: "authorization_cancelled" });
  assert.deepEqual((await service.status()).connections, []);
});

test("detects authenticated-store tampering without leaking details or overwriting stored data", async (t) => {
  const { service, root, settings, services } = await fixture(t);
  await connect(service);
  await service.waitForIdle();
  await service.shutdown();
  const file = path.join(root, ".local", "social-api", "vault.enc");
  const tampered = await fs.readFile(file);
  tampered[tampered.length - 1] ^= 1;
  await fs.writeFile(file, tampered);
  const restarted = createSocialConnectionService(settings);
  // This instance cannot initialize, so its shutdown is intentionally not added to the normal cleanup.
  await assert.rejects(restarted.status(), (exception) => exception.code === "storage_unavailable" && !exception.message.includes(root));
  assert.deepEqual(await fs.readFile(file), tampered);
  assert.equal(services.length, 1);
});

test("recovers interrupted jobs on restart while retaining previous successful data", async (t) => {
  const { service, root, settings, services } = await fixture(t);
  await connect(service);
  await service.waitForIdle();
  const previous = (await service.status()).connections[0];
  await service.shutdown();
  const dir = path.join(root, ".local", "social-api");
  const key = await fs.readFile(path.join(dir, "vault.key"));
  const file = path.join(dir, "vault.enc");
  const encrypted = await fs.readFile(file);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, encrypted.subarray(8, 20));
  decipher.setAAD(Buffer.from("AutoSocial official API v1"));
  decipher.setAuthTag(encrypted.subarray(20, 36));
  const state = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(36)), decipher.final()]).toString());
  state.connections[previous.id].job.status = "running";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("AutoSocial official API v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
  await fs.writeFile(file, Buffer.concat([Buffer.from("ASOCIAL1"), iv, cipher.getAuthTag(), ciphertext]));
  const restarted = createSocialConnectionService(settings);
  services.push(restarted);
  const restored = (await restarted.status()).connections[0];
  assert.equal(restored.job.status, "interrupted");
  assert.deepEqual(restored.posts, previous.posts);
  assert.equal(restored.job.error.code, "interrupted");
});

test("configured Telegram connection uses server credentials without OAuth hosting and preserves limited observed updates", async (t) => {
  const { service, settings, providers, services } = await fixture(t, { settings: { publicUrl: "" } });
  const observedGrants = [];
  let iteration = 0;
  providers.telegram = {
    id: "telegram", name: "Telegram", authType: "configured", configured: true, missingEnv: [],
    limitations: "Только ожидающие обновления бота, без полной истории канала.",
    configuredToken: () => ({ accessToken: "private-bot-token", chatId: "@configured_channel", expiresAt: null, refreshToken: null, scope: [], injectedKey: "private-ignored-property" }),
    readProfile: async (grant) => {
      observedGrants.push(grant);
      assert.equal(grant.chatId, "@configured_channel");
      assert.equal(grant.injectedKey, undefined);
      return { id: "-1001234", username: "configured_channel", displayName: "Channel", url: "https://t.me/configured_channel", metrics: { followers: 200, posts: null } };
    },
    readPosts: async (grant) => {
      assert.equal(grant.chatId, "@configured_channel");
      iteration += 1;
      return {
        posts: iteration === 1 ? [{ id: "1", caption: "Original text", mediaType: "text" }] : [{ id: "1", caption: "Edited text", mediaType: "text" }, { id: "2", caption: "Another update", mediaType: "text" }],
        cursor: null, complete: false, pages: 1, coverageReason: "telegram_pending_updates_only",
        warnings: ["Telegram Bot API предоставляет только ожидающие обновления; полная история канала недоступна."],
      };
    },
  };
  const before = await service.status();
  assert.equal(before.hosting.configured, false);
  assert.equal(before.providers.find((provider) => provider.id === "telegram").authType, "configured");
  assert.equal(before.providers.find((provider) => provider.id === "telegram").available, true);
  assert.equal(before.providers.find((provider) => provider.id === "tiktok").available, false);
  await assert.rejects(service.connectConfigured("tiktok", "default"), { code: "oauth_required" });
  await assert.rejects(service.beginAuthorization("telegram", "default"), { code: "configured_connection_required" });
  await assert.rejects(service.connectConfigured("telegram", "missing"), { status: 404 });
  const connection = await service.connectConfigured("telegram", "default");
  await service.waitForIdle();
  let snapshot = (await service.status()).connections[0];
  assert.equal(snapshot.connectionStatus, "connected");
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.cursor, null);
  assert.equal(snapshot.coverageReason, "telegram_pending_updates_only");
  assert.equal(snapshot.job.status, "partial");
  assert.equal(snapshot.job.error.code, "coverage_limited");
  assert.equal(snapshot.posts[0].mediaType, "text");
  assert.equal(snapshot.profile.metrics.posts, null);
  assert.equal(snapshot.warnings.length, 1);
  assert.equal(snapshot.token, undefined);
  assert.equal(snapshot.chatId, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-|accessToken|refreshToken|injectedKey/);
  await service.shutdown();
  const restarted = createSocialConnectionService(settings);
  services.push(restarted);
  await restarted.sync(connection.id);
  await restarted.waitForIdle();
  snapshot = (await restarted.status()).connections[0];
  assert.equal(snapshot.posts.length, 2);
  assert.equal(snapshot.posts[0].caption, "Edited text");
  assert.ok(observedGrants.length >= 3, "configured chat ID must survive encrypted persistence and restart");
  const saved = snapshot.posts;
  providers.telegram.readPosts = async () => { throw Object.assign(new Error("private-webhook-url"), { status: 409, code: "telegram_webhook_configured" }); };
  await restarted.sync(connection.id);
  await restarted.waitForIdle();
  snapshot = (await restarted.status()).connections[0];
  assert.equal(snapshot.job.status, "failed");
  assert.equal(snapshot.job.error.code, "telegram_webhook_configured");
  assert.deepEqual(snapshot.posts, saved);
  assert.equal(snapshot.coverageReason, "telegram_pending_updates_only");
  assert.doesNotMatch(JSON.stringify(snapshot), /private-webhook/);
});

test("configured connections reject missing credentials and invalid bot settings without saving a connection", async (t) => {
  const { service, providers } = await fixture(t, { settings: { publicUrl: "" } });
  providers.telegram = { id: "telegram", name: "Telegram", authType: "configured", configured: false, missingEnv: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"], limitations: "Pending updates only" };
  await assert.rejects(service.connectConfigured("telegram", "default"), { code: "provider_not_configured" });
  assert.deepEqual((await service.status()).providers.find((provider) => provider.id === "telegram").missingEnv, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
  providers.telegram.configured = true;
  providers.telegram.configuredToken = () => ({ accessToken: "private-bot-token", chatId: "bad\nchat" });
  providers.telegram.readProfile = async () => { throw new Error("must not get here"); };
  await assert.rejects(service.connectConfigured("telegram", "default"), (exception) => exception.code === "configured_connection_failed" && !/private-|bad|chat/.test(exception.message));
  assert.deepEqual((await service.status()).connections, []);
});
