const test = require("node:test");
const assert = require("node:assert/strict");
const { SOCIAL_PROVIDERS, createSocialProviderAdapters } = require("../src/social-provider-adapters");

const env = {
  INSTAGRAM_CLIENT_ID: "instagram-client", INSTAGRAM_CLIENT_SECRET: "instagram-secret",
  TIKTOK_CLIENT_KEY: "tiktok-client", TIKTOK_CLIENT_SECRET: "tiktok-secret",
  GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret",
  X_CLIENT_ID: "x-client", X_CLIENT_SECRET: "x-secret",
  TELEGRAM_BOT_TOKEN: "123456:telegram-secret", TELEGRAM_CHAT_ID: "@mychannel",
};
const token = { accessToken: "test-access-token", refreshToken: "test-refresh-token", scope: ["user.info.basic", "video.list"] };
const response = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function fixture(replies, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const next = replies.shift();
    if (typeof next === "function") return next(url, init);
    assert.ok(next, "Unexpected outbound request");
    return next;
  };
  return { calls, adapters: createSocialProviderAdapters({ env, fetchImpl, now: () => Date.parse("2026-10-15T00:00:00Z"), ...options }) };
}

test("provider metadata advertises requirements without exposing configured values", () => {
  const adapters = createSocialProviderAdapters({ env: { GOOGLE_CLIENT_ID: "do-not-expose" } });
  assert.deepEqual(Object.keys(adapters), ["instagram", "tiktok", "youtube", "x", "telegram"]);
  assert.equal(SOCIAL_PROVIDERS.length, 5);
  assert.equal(adapters.youtube.configured, false);
  assert.deepEqual(adapters.youtube.missingEnv, ["GOOGLE_CLIENT_SECRET"]);
  assert.doesNotMatch(JSON.stringify(adapters), /do-not-expose/);
  assert.throws(() => adapters.youtube.authorizationUrl({ redirectUri: "https://app.example/callback", state: "state" }), { code: "provider_not_configured", status: 503 });
});

test("all providers reflect configuration changes without replacing adapters or restarting jobs", () => {
  const mutableEnv = {};
  const adapters = createSocialProviderAdapters({ env: mutableEnv });
  for (const definition of SOCIAL_PROVIDERS) {
    const adapter = adapters[definition.id];
    assert.equal(adapter.configured, false);
    assert.deepEqual(adapter.missingEnv, definition.requiredEnv);
    for (const key of definition.requiredEnv) mutableEnv[key] = `configured-${key}`;
    assert.equal(adapter.configured, true);
    assert.deepEqual(adapter.missingEnv, []);
    assert.equal(JSON.parse(JSON.stringify(adapter)).configured, true);
    delete mutableEnv[definition.requiredEnv[0]];
    assert.equal(adapter.configured, false);
    assert.deepEqual(adapter.missingEnv, [definition.requiredEnv[0]]);
    mutableEnv[definition.requiredEnv[0]] = "   ";
    assert.equal(adapter.configured, false);
    mutableEnv[definition.requiredEnv[0]] = `configured-${definition.requiredEnv[0]}`;
    assert.equal(adapter.configured, true);
    assert.equal(adapters[definition.id], adapter, "existing jobs keep the same adapter");
  }
  mutableEnv.TELEGRAM_BOT_TOKEN = "updated-bot-token";
  mutableEnv.TELEGRAM_CHAT_ID = "@updatedchannel";
  assert.equal(adapters.telegram.configuredToken().accessToken, "updated-bot-token");
  assert.equal(adapters.telegram.configuredToken().chatId, "@updatedchannel");
  delete mutableEnv.TELEGRAM_CHAT_ID;
  assert.throws(() => adapters.telegram.configuredToken(), { code: "provider_not_configured" });
});

test("authorization URLs use official hosts, minimal scopes, state and PKCE where supported", () => {
  const { adapters } = fixture([]);
  for (const [provider, host, scope] of [["instagram", "www.instagram.com", "instagram_business_basic"], ["tiktok", "www.tiktok.com", "user.info.basic,video.list"], ["youtube", "accounts.google.com", "https://www.googleapis.com/auth/youtube.readonly"]]) {
    const url = new URL(adapters[provider].authorizationUrl({ redirectUri: "https://app.example/api/callback", state: "state-value", codeChallenge: "challenge" }));
    assert.equal(url.hostname, host);
    assert.equal(url.searchParams.get("scope"), scope);
    assert.equal(url.searchParams.get("state"), "state-value");
    assert.equal(url.searchParams.get("redirect_uri"), "https://app.example/api/callback");
    assert.equal(url.searchParams.get("code_challenge"), provider === "instagram" ? null : "challenge");
    assert.doesNotMatch(url.href, /secret/);
    assert.throws(() => adapters[provider].authorizationUrl({ redirectUri: "http://app.example/callback", state: "s" }), { status: 400 });
  }
});

test("TikTok code exchange and refresh preserve rotated credentials and granted scopes", async () => {
  const { adapters, calls } = fixture([
    response({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "user.info.basic,video.list" }),
    response({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200 }),
  ]);
  const first = await adapters.tiktok.exchangeCode({ code: "auth-code", redirectUri: "https://app.example/callback", codeVerifier: "verifier" });
  assert.equal(first.expiresAt, "2026-10-15T01:00:00.000Z");
  assert.deepEqual(first.scope, ["user.info.basic", "video.list"]);
  assert.equal(new URLSearchParams(calls[0].init.body).get("code_verifier"), "verifier");
  assert.equal(new URLSearchParams(calls[0].init.body).get("client_secret"), env.TIKTOK_CLIENT_SECRET);
  const next = await adapters.tiktok.refreshToken(first);
  assert.equal(next.refreshToken, "refresh-2");
  assert.equal(next.accessToken, "access-2");
  assert.deepEqual(next.scope, first.scope);
  assert.equal(calls[0].url.origin, "https://open.tiktokapis.com");
  assert.equal(calls[0].init.redirect, "error");
});

test("TikTok optional profile/statistic fields are requested only with granted scopes", async () => {
  const user = { open_id: "user", display_name: "Creator", avatar_url: "https://images.example/a.jpg", follower_count: 999, username: "creator", bio_description: "Biography", profile_deep_link: "https://www.tiktok.com/@creator" };
  const { adapters, calls } = fixture([response({ data: { user }, error: { code: "ok" } }), response({ data: { user }, error: { code: "ok" } })]);
  const basic = await adapters.tiktok.readProfile(token);
  assert.equal(basic.metrics.followers, null);
  assert.equal(basic.username, "");
  assert.equal(basic.bio, "");
  assert.doesNotMatch(calls[0].url.searchParams.get("fields"), /follower_count|username|bio_description/);
  const full = await adapters.tiktok.readProfile({ ...token, scope: [...token.scope, "user.info.profile", "user.info.stats"] });
  assert.equal(full.metrics.followers, 999);
  assert.equal(full.metrics.following, null);
  assert.equal(full.username, "creator");
  assert.match(calls[1].url.searchParams.get("fields"), /follower_count/);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${token.accessToken}`);
});

test("TikTok pagination reports partial budgets, resumes and preserves missing metric nulls", async () => {
  const video = { id: "v1", video_description: "Real post", create_time: 1700000000, share_url: "https://www.tiktok.com/@user/video/v1", view_count: 0 };
  const { adapters, calls } = fixture([
    response({ data: { videos: [video], cursor: 1700000000000, has_more: true }, error: { code: "ok" } }),
    response({ data: { videos: [{ ...video, id: "v2" }], cursor: 0, has_more: false }, error: { code: "ok" } }),
  ]);
  const first = await adapters.tiktok.readPosts(token, { maxPages: 1 });
  assert.equal(first.complete, false);
  assert.equal(first.cursor, "1700000000000");
  assert.equal(first.posts[0].metrics.views, 0);
  assert.equal(first.posts[0].metrics.likes, null);
  assert.equal(first.posts[0].publishedAt, "2023-11-14T22:13:20.000Z");
  const second = await adapters.tiktok.readPosts(token, { cursor: first.cursor, maxPages: 1 });
  assert.equal(JSON.parse(calls[1].init.body).cursor, 1700000000000);
  assert.equal(second.complete, true);
  assert.equal(second.cursor, null);
  await assert.rejects(adapters.tiktok.readPosts(token, { cursor: "https://attacker.example" }), { code: "invalid_cursor" });
});

test("page progress is awaited and records final completeness separately from intermediate cursors", async () => {
  const { adapters } = fixture([
    response({ data: { videos: [{ id: "one" }], cursor: 20, has_more: true }, error: { code: "ok" } }),
    response({ data: { videos: [{ id: "two" }], has_more: false }, error: { code: "ok" } }),
  ]);
  const progress = [];
  const result = await adapters.tiktok.readPosts(token, { maxPages: 2, onProgress: async (value) => { await Promise.resolve(); progress.push(value); } });
  assert.deepEqual(progress, [{ pages: 1, posts: 1, cursor: "20", complete: false }, { pages: 2, posts: 2, cursor: null, complete: true }]);
  assert.equal(result.posts.length, 2);
});

test("Instagram makes short tokens refreshable only after successful long-lived exchange", async () => {
  const { adapters, calls } = fixture([
    response({ data: [{ access_token: "short-token", user_id: "ig-user" }] }),
    response({ access_token: "long-token", expires_in: 5184000, token_type: "bearer" }),
    response({ access_token: "refreshed-long", expires_in: 5184000 }),
  ]);
  const long = await adapters.instagram.exchangeCode({ code: "code", redirectUri: "https://app.example/callback" });
  assert.equal(calls[0].url.href, "https://api.instagram.com/oauth/access_token");
  assert.equal(calls[1].url.origin, "https://graph.instagram.com");
  assert.equal(calls[1].url.searchParams.get("grant_type"), "ig_exchange_token");
  assert.equal(calls[1].url.searchParams.get("access_token"), "short-token");
  assert.equal(long.tokenType, "instagram_long_lived");
  assert.equal(long.refreshToken, "long-token");
  const refreshed = await adapters.instagram.refreshToken(long);
  assert.equal(refreshed.refreshToken, "refreshed-long");
  assert.equal(refreshed.tokenType, "instagram_long_lived");
  assert.equal(calls[2].url.pathname, "/refresh_access_token");
  await assert.rejects(adapters.instagram.refreshToken({ accessToken: "short-token", refreshToken: "short-token" }), { code: "reauthorization_required" });
  const failed = fixture([response({ access_token: "short" }), response({ error: { message: "secret-data" } }, 400)]);
  await assert.rejects(failed.adapters.instagram.exchangeCode({ code: "code", redirectUri: "https://app.example/callback" }), { code: "provider_request_failed", status: 502 });
});

test("Instagram normalizes profile and extracts pagination cursor without following supplied URLs", async () => {
  const { adapters, calls } = fixture([
    response({ id: "ig", username: "creator", followers_count: 0, media_count: "2", profile_picture_url: "javascript:alert(1)" }),
    response({ data: [{ id: "1", caption: "Post", media_type: "IMAGE", media_url: "https://media.example/photo.jpg", timestamp: "2026-10-14T10:00:00Z" }], paging: { cursors: { after: "opaque-after" }, next: "https://graph.instagram.com/v23.0/ig/media?after=opaque-after&access_token=do-not-forward" } }),
    response({ data: [{ id: "2", media_type: "CAROUSEL_ALBUM", permalink: "https://www.instagram.com/p/two/" }] }),
  ]);
  const profile = await adapters.instagram.readProfile(token);
  assert.equal(profile.avatarUrl, null);
  assert.equal(profile.metrics.followers, 0);
  assert.equal(profile.metrics.posts, 2);
  const posts = await adapters.instagram.readPosts(token, { maxPages: 2 });
  assert.equal(posts.complete, true);
  assert.equal(posts.posts.length, 2);
  assert.equal(posts.posts[0].mediaType, "photo");
  assert.equal(posts.posts[1].mediaType, "carousel");
  assert.equal(calls[2].url.pathname, "/v23.0/me/media");
  assert.equal(calls[2].url.searchParams.get("after"), "opaque-after");
  assert.equal(calls[2].url.searchParams.has("access_token"), false);
  const unsafe = fixture([response({ data: [], paging: { next: "https://attacker.example/?after=bad" } })]);
  await assert.rejects(unsafe.adapters.instagram.readPosts(token), { code: "provider_malformed_response" });
  assert.equal(unsafe.calls.length, 1);
});

test("Instagram partial cursor and repeated provider cursors cannot be mistaken for exhaustion", async () => {
  const page = response({ data: [], paging: { next: "https://graph.instagram.com/v23.0/me/media?after=same", cursors: { after: "same" } } });
  const { adapters } = fixture([page, page.clone()]);
  const first = await adapters.instagram.readPosts(token, { maxPages: 1 });
  assert.deepEqual({ cursor: first.cursor, complete: first.complete, pages: first.pages }, { cursor: "same", complete: false, pages: 1 });
  await assert.rejects(adapters.instagram.readPosts(token, { cursor: first.cursor, maxPages: 1 }), { code: "provider_invalid_pagination" });
});

test("Google exchange uses readonly OAuth and refresh retains the prior refresh token when not rotated", async () => {
  const { adapters, calls } = fixture([response({ access_token: "google-1", refresh_token: "google-refresh", scope: "https://www.googleapis.com/auth/youtube.readonly", expires_in: 3600 }), response({ access_token: "google-2", expires_in: 3600 })]);
  const first = await adapters.youtube.exchangeCode({ code: "code", redirectUri: "https://app.example/callback", codeVerifier: "verifier" });
  const second = await adapters.youtube.refreshToken(first);
  assert.equal(calls[0].url.href, "https://oauth2.googleapis.com/token");
  assert.equal(new URLSearchParams(calls[0].init.body).get("code_verifier"), "verifier");
  assert.equal(second.refreshToken, "google-refresh");
  assert.deepEqual(second.scope, first.scope);
});

test("YouTube reads the authenticated channel and reports hidden/unavailable metrics as null", async () => {
  const { adapters, calls } = fixture([response({ items: [{ id: "channel", snippet: { title: "Channel", customUrl: "@channel", thumbnails: { default: { url: "https://images.example/channel.jpg" } } }, statistics: { subscriberCount: "999", hiddenSubscriberCount: true, videoCount: "3", viewCount: "0" } }] })]);
  const profile = await adapters.youtube.readProfile(token);
  assert.equal(calls[0].url.searchParams.get("mine"), "true");
  assert.equal(profile.metrics.followers, null);
  assert.equal(profile.metrics.views, 0);
  assert.equal(profile.metrics.posts, 3);
});

test("YouTube follows the uploads playlist and resumes bounded pagination using only fixed API hosts", async () => {
  const video = (videoId) => ({ id: videoId, snippet: { description: `Description ${videoId}`, publishedAt: "2026-10-10T00:00:00Z" }, statistics: { viewCount: "123", likeCount: "0" } });
  const { adapters, calls } = fixture([
    response({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UUchannel" } } }] }),
    response({ items: [{ contentDetails: { videoId: "v1" } }], nextPageToken: "page-2" }),
    response({ items: [video("v1")] }),
    response({ items: [{ contentDetails: { videoId: "v2" } }] }),
    response({ items: [video("v2")] }),
  ]);
  const first = await adapters.youtube.readPosts(token, { maxPages: 1 });
  assert.equal(first.complete, false);
  assert.equal(first.posts[0].metrics.likes, 0);
  assert.equal(first.posts[0].metrics.comments, null);
  const second = await adapters.youtube.readPosts(token, { cursor: first.cursor, maxPages: 1 });
  assert.equal(second.complete, true);
  assert.equal(second.posts[0].id, "v2");
  assert.equal(calls[3].url.searchParams.get("playlistId"), "UUchannel");
  assert.equal(calls[3].url.searchParams.get("pageToken"), "page-2");
  assert.ok(calls.every((call) => call.url.origin === "https://www.googleapis.com"));
  assert.equal(calls[2].url.pathname, "/youtube/v3/videos");
  assert.equal(calls[2].url.searchParams.get("id"), "v1");
});

test("errors hide provider bodies, request URLs and all secrets; rate limits preserve numeric retry guidance", async () => {
  const secret = "must-never-be-exposed";
  const { adapters } = fixture([response({ error: { message: secret, access_token: token.accessToken } }, 429, { "Retry-After": "42" }), response({ error: { code: "access_token_invalid", message: secret } }), () => { throw new Error(`Network ${secret}`); }, new Response("not-json")]);
  await assert.rejects(adapters.youtube.readProfile(token), (error) => error.status === 429 && error.retryAfter === 42 && !JSON.stringify(error).includes(secret));
  await assert.rejects(adapters.tiktok.readProfile(token), (error) => error.code === "provider_authorization_failed" && !error.message.includes(secret));
  await assert.rejects(adapters.instagram.readProfile(token), (error) => error.code === "provider_network_error" && !error.message.includes(secret));
  await assert.rejects(adapters.youtube.readProfile(token), { code: "provider_malformed_response" });
});

test("Google quotas and Instagram Graph rate limits preserve authorization instead of requesting another login", async () => {
  for (const reason of ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"]) {
    const { adapters } = fixture([response({ error: { code: 403, message: "secret-token-and-provider-message", errors: [{ reason, message: "secret-details" }] } }, 403, { "Retry-After": "60" })]);
    await assert.rejects(adapters.youtube.readProfile(token), (error) => error.status === 429 && error.code === "rate_limited" && error.retryAfter === 60 && !JSON.stringify(error).includes("secret"));
  }
  for (const code of [4, 17, 32, 613]) {
    const { adapters } = fixture([response({ error: { code, message: "private Graph response" } }, 400)]);
    await assert.rejects(adapters.instagram.readProfile(token), { code: "rate_limited", status: 429 });
  }
  const logical = fixture([response({ error: { code: 4, message: "private Graph response" } })]);
  await assert.rejects(logical.adapters.instagram.readProfile(token), { code: "rate_limited", status: 429 });
});

test("known invalid tokens require authorization while unknown provider field/permission errors stay request failures", async () => {
  const graph = fixture([response({ error: { code: 190, message: "secret-invalid-token" } }, 400)]);
  await assert.rejects(graph.adapters.instagram.readProfile(token), { code: "provider_authorization_failed", status: 401 });
  const oauth = fixture([response({ error: "invalid_grant", error_description: "private-auth-code" }, 400)]);
  await assert.rejects(oauth.adapters.youtube.exchangeCode({ code: "code", redirectUri: "https://app.example/callback" }), (error) => error.status === 401 && error.code === "provider_authorization_failed" && !error.message.includes("private"));
  for (const status of [400, 403]) {
    const unknown = fixture([response({ error: { code: 100, message: "Unsupported private field", errors: [{ reason: "forbidden" }] } }, status)]);
    await assert.rejects(unknown.adapters.instagram.readProfile(token), { code: "provider_request_failed", status: 502 });
  }
  const unknownLogical = fixture([response({ error: { code: 99999, message: "secret" } })]);
  await assert.rejects(unknownLogical.adapters.youtube.readProfile(token), { code: "provider_request_failed", status: 502 });
  const notJson = fixture([new Response("private gateway response", { status: 401 })]);
  await assert.rejects(notJson.adapters.youtube.readProfile(token), { code: "provider_authorization_failed", status: 401 });
});

test("aborted requests and provider timeouts fail cleanly without turning into empty successful imports", async () => {
  const pending = (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const controller = new AbortController();
  const { adapters } = fixture([pending, pending], { timeoutMs: 10 });
  controller.abort();
  await assert.rejects(adapters.youtube.readProfile(token, { signal: controller.signal }), { code: "request_aborted", status: 408 });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(adapters.youtube.readProfile(token), { code: "request_timeout", status: 504 }); }
  finally { clearTimeout(keepAlive); }
});

test("malformed or repeating page signals fail rather than silently claim every post was retrieved", async () => {
  const tt = fixture([response({ data: { videos: [], has_more: true, cursor: 10 }, error: { code: "ok" } })]);
  await assert.rejects(tt.adapters.tiktok.readPosts(token, { cursor: "10" }), { code: "provider_invalid_pagination" });
  const yt = fixture([response({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UUchannel" } } }] }), response({ items: [{ contentDetails: {} }] })]);
  await assert.rejects(yt.adapters.youtube.readPosts(token), { code: "provider_malformed_response" });
  const ig = fixture([response({ unexpected: "value" })]);
  await assert.rejects(ig.adapters.instagram.readPosts(token), { code: "provider_malformed_response" });
  await assert.rejects(ig.adapters.instagram.readPosts(token, { maxPages: 0 }), { code: "invalid_page_budget" });
});

test("X requires PKCE and uses official readonly OAuth endpoints with confidential client authentication", async () => {
  const { adapters, calls } = fixture([
    response({ access_token: "x-access", refresh_token: "x-refresh", expires_in: 7200, scope: "tweet.read users.read offline.access" }),
    response({ access_token: "x-rotated", refresh_token: "x-refresh-rotated", expires_in: 7200 }),
  ]);
  const url = new URL(adapters.x.authorizationUrl({ redirectUri: "https://app.example/callback", state: "state", codeChallenge: "challenge" }));
  assert.equal(url.origin, "https://x.com");
  assert.equal(url.pathname, "/i/oauth2/authorize");
  assert.equal(url.searchParams.get("scope"), "tweet.read users.read offline.access");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.throws(() => adapters.x.authorizationUrl({ redirectUri: "https://app.example/callback", state: "state" }), { code: "pkce_required" });
  await assert.rejects(adapters.x.exchangeCode({ code: "code", redirectUri: "https://app.example/callback" }), { code: "pkce_required" });
  const first = await adapters.x.exchangeCode({ code: "code", redirectUri: "https://app.example/callback", codeVerifier: "verifier" });
  assert.equal(calls[0].url.href, "https://api.x.com/2/oauth2/token");
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from("x-client:x-secret").toString("base64")}`);
  assert.equal(new URLSearchParams(calls[0].init.body).get("code_verifier"), "verifier");
  const refreshed = await adapters.x.refreshToken(first);
  assert.equal(refreshed.refreshToken, "x-refresh-rotated");
  assert.equal(new URLSearchParams(calls[1].init.body).get("grant_type"), "refresh_token");
});

test("X normalizes actual profile counters and reads/resumes user tweet pagination", async () => {
  const { adapters, calls } = fixture([
    response({ data: { id: "123", username: "person", name: "Person", public_metrics: { followers_count: 0, following_count: 5, tweet_count: 123 } } }),
    response({ data: { id: "123" } }),
    response({ data: [{ id: "456", text: "Real tweet", created_at: "2026-10-15T10:00:00Z", public_metrics: { like_count: 0, reply_count: 3, retweet_count: 1 }, attachments: { media_keys: ["photo"] } }], includes: { media: [{ media_key: "photo", type: "photo", url: "https://images.example/photo.jpg" }] }, meta: { result_count: 1, next_token: "next-page" } }),
    response({ data: [{ id: "457", text: "Text tweet" }], meta: { result_count: 1 } }),
  ]);
  const profile = await adapters.x.readProfile(token);
  assert.equal(profile.metrics.followers, 0);
  assert.equal(profile.metrics.posts, 123);
  assert.equal(profile.metrics.views, null);
  const first = await adapters.x.readPosts(token, { maxPages: 1 });
  assert.equal(first.complete, false);
  assert.equal(first.posts[0].mediaType, "photo");
  assert.equal(first.posts[0].metrics.likes, 0);
  assert.equal(first.posts[0].metrics.views, null);
  assert.equal(calls[2].url.pathname, "/2/users/123/tweets");
  assert.equal(calls[2].url.searchParams.has("exclude"), false, "replies and reposts are not silently excluded");
  const second = await adapters.x.readPosts(token, { cursor: first.cursor, maxPages: 1 });
  assert.equal(second.complete, true);
  assert.equal(second.posts[0].mediaType, "text");
  assert.equal(calls[3].url.searchParams.get("pagination_token"), "next-page");
  assert.ok(calls.every((call) => call.url.origin === "https://api.x.com"));
});

test("X empty and malformed pagination cannot produce invented posts or false exhaustion", async () => {
  const empty = fixture([response({ data: { id: "123" } }), response({ meta: { result_count: 0 } })]);
  const result = await empty.adapters.x.readPosts(token);
  assert.deepEqual(result.posts, []);
  assert.equal(result.complete, true);
  const broken = fixture([response({ data: { id: "123" } }), response({ data: [], meta: { next_token: "same" } }), response({ data: [], meta: { next_token: "same" } })]);
  await assert.rejects(broken.adapters.x.readPosts(token, { maxPages: 2 }), { code: "provider_invalid_pagination" });
  const partial = fixture([response({ data: { id: "123" } }), response({ data: [], errors: [{ detail: "secret-provider-data" }], meta: { result_count: 0 } })]);
  await assert.rejects(partial.adapters.x.readPosts(token), (error) => error.code === "provider_partial_response" && !error.message.includes("secret-provider-data"));
});

test("Telegram configured readiness keeps bot credentials private and reads actual chat metadata", async () => {
  const { adapters, calls } = fixture([
    response({ ok: true, result: { id: 123456, is_bot: true, username: "mybot" } }),
    response({ ok: true, result: { id: -10012345, type: "channel", title: "My channel", username: "mychannel", description: "Actual description" } }),
    response({ ok: true, result: 0 }),
  ]);
  assert.equal(adapters.telegram.authType, "configured");
  assert.equal(adapters.telegram.configured, true);
  const configured = adapters.telegram.configuredToken();
  assert.equal(configured.chatId, "@mychannel");
  assert.equal(configured.expiresAt, null);
  assert.doesNotMatch(JSON.stringify(adapters.telegram), /telegram-secret/);
  const profile = await adapters.telegram.readProfile(configured);
  assert.equal(profile.id, "-10012345");
  assert.equal(profile.displayName, "My channel");
  assert.equal(profile.metrics.followers, 0);
  assert.equal(profile.metrics.posts, null);
  assert.equal(profile.avatarUrl, null);
  assert.equal(calls[0].url.pathname, "/bot123456:telegram-secret/getMe");
  assert.equal(new URLSearchParams(calls[1].init.body).get("chat_id"), "@mychannel");
  assert.equal(new URLSearchParams(calls[2].init.body).get("chat_id"), "-10012345");
});

test("Telegram gets pending updates without acknowledgment and explicitly cannot claim complete history", async () => {
  const { adapters, calls } = fixture([
    response({ ok: true, result: { url: "" } }),
    response({ ok: true, result: { id: -10012345, username: "mychannel" } }),
    response({ ok: true, result: [
      { update_id: 1, channel_post: { message_id: 10, chat: { id: -10012345 }, text: "Older text", date: 1700000000 } },
      { update_id: 2, edited_channel_post: { message_id: 10, chat: { id: -10012345 }, text: "Edited text", date: 1700000000 } },
      { update_id: 3, channel_post: { message_id: 11, chat: { id: -10012345 }, caption: "Photo caption", photo: [{ file_id: "secret-file-id" }], date: 1700000001 } },
      { update_id: 4, message: { message_id: 12, chat: { id: 999 }, text: "Other chat must not leak", date: 1700000002 } },
    ] }),
  ]);
  const result = await adapters.telegram.readPosts(adapters.telegram.configuredToken(), { maxPages: 100 });
  assert.equal(result.complete, false);
  assert.equal(result.cursor, null);
  assert.equal(result.pages, 1);
  assert.equal(result.coverageReason, "telegram_pending_updates_only");
  assert.ok(result.warnings.length);
  assert.equal(result.posts.length, 2);
  assert.equal(result.posts[0].caption, "Edited text");
  assert.equal(result.posts[1].mediaType, "photo");
  assert.equal(result.posts[1].thumbnailUrl, null);
  assert.ok(Object.values(result.posts[1].metrics).every((value) => value === null));
  assert.doesNotMatch(JSON.stringify(result), /telegram-secret|secret-file-id|Other chat/);
  assert.equal(calls[2].url.pathname.endsWith("/getUpdates"), true);
  const params = new URLSearchParams(calls[2].init.body);
  assert.equal(params.get("limit"), "100");
  assert.equal(params.get("timeout"), "0");
  for (const key of ["offset", "allowed_updates", "drop_pending_updates"]) assert.equal(params.has(key), false);
  assert.ok(calls.every((call) => !/setWebhook|deleteWebhook|sendMessage|getFile/.test(call.url.pathname)));
});

test("Telegram preserves existing webhooks and never reveals token-bearing URLs in failures", async () => {
  const webhook = fixture([response({ ok: true, result: { url: "https://existing.example/private-webhook" } })]);
  await assert.rejects(webhook.adapters.telegram.readPosts(webhook.adapters.telegram.configuredToken()), (error) => error.code === "telegram_webhook_configured" && error.status === 409 && !error.message.includes("existing.example"));
  assert.equal(webhook.calls.length, 1);
  const failed = fixture([() => { throw new Error("https://api.telegram.org/bot123456:telegram-secret/getWebhookInfo"); }]);
  await assert.rejects(failed.adapters.telegram.readPosts(failed.adapters.telegram.configuredToken()), (error) => error.code === "provider_network_error" && !error.message.includes("telegram-secret"));
  const disabled = createSocialProviderAdapters({ env: {} }).telegram;
  assert.equal(disabled.configured, false);
  assert.deepEqual(disabled.missingEnv, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
  assert.throws(() => disabled.configuredToken(), { code: "provider_not_configured" });
});

test("Telegram encodes unusual credential path characters instead of treating them as a request destination", async () => {
  const { adapters, calls } = fixture([response({ ok: true, result: { url: "https://already-set.example/" } })], { env: { ...env, TELEGRAM_BOT_TOKEN: "proxy/placeholder?secret#" } });
  await assert.rejects(adapters.telegram.readPosts(adapters.telegram.configuredToken()), { code: "telegram_webhook_configured" });
  assert.equal(calls[0].url.origin, "https://api.telegram.org");
  assert.equal(calls[0].url.pathname, "/botproxy%2Fplaceholder%3Fsecret%23/getWebhookInfo");
  assert.equal(calls[0].url.search, "");
  assert.equal(calls[0].url.hash, "");
});
