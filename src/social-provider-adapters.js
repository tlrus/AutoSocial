const SOCIAL_PROVIDERS = Object.freeze([
  Object.freeze({ id: "instagram", name: "Instagram", requiredEnv: ["INSTAGRAM_CLIENT_ID", "INSTAGRAM_CLIENT_SECRET"], apiDomains: ["api.instagram.com", "graph.instagram.com"], scopes: ["instagram_business_basic"], supportsPKCE: false, limitations: "Только собственный профессиональный аккаунт Business или Creator. Личные сообщения, черновики и личные аккаунты не импортируются." }),
  Object.freeze({ id: "tiktok", name: "TikTok", requiredEnv: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"], apiDomains: ["open.tiktokapis.com"], scopes: ["user.info.basic", "video.list"], supportsPKCE: true, limitations: "Профиль и публичные видео авторизованного аккаунта. Закрытые публикации, фотопосты, черновики и сообщения не импортируются; часть статистики требует дополнительных разрешений." }),
  Object.freeze({ id: "youtube", name: "YouTube", requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], apiDomains: ["oauth2.googleapis.com", "www.googleapis.com"], scopes: ["https://www.googleapis.com/auth/youtube.readonly"], supportsPKCE: true, limitations: "Видео канала, выбранного при входе в Google. Доступность записей и статистики определяется YouTube и выданными разрешениями." }),
  Object.freeze({ id: "x", name: "X", requiredEnv: ["X_CLIENT_ID", "X_CLIENT_SECRET"], apiDomains: ["api.x.com"], scopes: ["tweet.read", "users.read", "offline.access"], supportsPKCE: true, limitations: "Публикации авторизованного аккаунта в пределах тарифа, разрешений и глубины истории X API. Недоступные и удалённые записи не импортируются." }),
  Object.freeze({ id: "telegram", name: "Telegram", authType: "configured", requiredEnv: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"], apiDomains: ["api.telegram.org"], scopes: [], supportsPKCE: false, limitations: "Только доступные боту ожидающие обновления выбранного чата или канала. Bot API не предоставляет полную историю; существующий webhook не заменяется." }),
]);

function failure(code, status = 502, extra = {}) {
  // Never expose provider response bodies, request URLs, codes or credentials.
  return Object.assign(new Error(`Social provider request failed (${code}).`), { code, status, ...extra });
}

function text(value, limit = 100000) { return typeof value === "string" ? value.slice(0, limit) : ""; }
function id(value) { return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? String(value).slice(0, 1000) : ""; }
function metric(value) {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function date(value) {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || [...url.searchParams.keys()].some((key) => /^(access_token|refresh_token|client_secret|code)$/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}
function scopes(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || "").split(/[\s,]+/)).filter((item) => typeof item === "string" && item))];
}
function cursorText(value) {
  if (typeof value !== "string" || !value || value.length > 10000) throw failure("invalid_cursor", 400);
  return value;
}
function pageBudget(value = 10) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw failure("invalid_page_budget", 400);
  return value;
}
function requiredId(value) {
  const result = id(value);
  if (!result) throw failure("provider_malformed_response");
  return result;
}

function createSocialProviderAdapters({ fetchImpl = globalThis.fetch, env = process.env, now = Date.now, timeoutMs = 20000 } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const adapters = {};
  const metadata = (providerId) => {
    const definition = SOCIAL_PROVIDERS.find((item) => item.id === providerId);
    const adapter = { ...definition, requiredEnv: [...definition.requiredEnv], apiDomains: [...definition.apiDomains], scopes: [...definition.scopes] };
    // Settings can update the injected environment while jobs retain these
    // adapters. Readiness must describe the current configuration each time.
    Object.defineProperties(adapter, {
      missingEnv: { enumerable: true, get: () => definition.requiredEnv.filter((key) => !text(env[key]).trim()) },
      configured: { enumerable: true, get: () => adapter.missingEnv.length === 0 },
    });
    return adapter;
  };
  function configured(adapter) { if (!adapter.configured) throw failure("provider_not_configured", 503); }
  function tokenValue(token) {
    if (!token || typeof token.accessToken !== "string" || !token.accessToken) throw failure("reauthorization_required", 401);
    return token.accessToken;
  }
  function normalizeToken(raw, fallback = {}) {
    const value = Array.isArray(raw?.data) ? raw.data[0] : raw?.data && typeof raw.data === "object" ? raw.data : raw;
    if (!value || typeof value.access_token !== "string" || !value.access_token) throw failure("provider_malformed_response");
    const lifetime = metric(value.expires_in);
    const expiry = lifetime !== null ? now() + lifetime * 1000 : null;
    if (expiry !== null && !Number.isFinite(new Date(expiry).getTime())) throw failure("provider_malformed_response");
    return {
      accessToken: value.access_token,
      refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : fallback.refreshToken || null,
      expiresAt: expiry !== null ? new Date(expiry).toISOString() : null,
      scope: scopes(value.scope || fallback.scope),
    };
  }
  async function request(url, { method = "GET", headers = {}, body, signal, tiktok = false } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(url.toString(), { method, headers: { Accept: "application/json", ...headers }, body, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      let result;
      try { result = await response.json(); } catch (error) {
        if (signal?.aborted || timeout.aborted) throw error;
        if (response.ok) throw failure("provider_malformed_response");
      }
      const structured = result && typeof result === "object" && !Array.isArray(result) ? result : null;
      const hasProviderError = Boolean(structured?.error && (!tiktok || structured.error.code !== "ok"));
      if (!response.ok || hasProviderError) {
        // Inspect only documented codes/reasons to classify the failure. Raw
        // messages, bodies and credential-bearing URLs never leave this helper.
        const hostname = new URL(url).hostname;
        const providerError = structured?.error;
        const errorCode = typeof providerError === "string" ? providerError : providerError?.code;
        const googleReasons = Array.isArray(providerError?.errors) ? providerError.errors.map((item) => item?.reason) : [];
        const quotaReasons = new Set(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"]);
        const googleQuota = ["www.googleapis.com", "oauth2.googleapis.com"].includes(hostname) && googleReasons.some((reason) => quotaReasons.has(reason));
        const graphQuota = ["graph.instagram.com", "api.instagram.com"].includes(hostname) && [4, 17, 32, 613].includes(Number(errorCode));
        const graphInvalidToken = ["graph.instagram.com", "api.instagram.com"].includes(hostname) && Number(errorCode) === 190;
        const invalidToken = ["invalid_grant", "invalid_token", "access_token_invalid", "access_token_expired", "invalid_access_token"].includes(errorCode);
        const retry = response.headers?.get("retry-after");
        const providerRetry = structured?.parameters?.retry_after;
        const retryAfter = retry && /^\d+$/.test(retry) ? Math.min(Number(retry), 86400) : typeof providerRetry === "number" && Number.isFinite(providerRetry) && providerRetry >= 0 ? Math.min(providerRetry, 86400) : null;
        if (response.status === 401 || graphInvalidToken || invalidToken) throw failure("provider_authorization_failed", 401);
        if (response.status === 429 || googleQuota || graphQuota || (tiktok && errorCode === "rate_limit_exceeded")) throw failure("rate_limited", 429, { retryAfter });
        if (response.status === 409) throw failure("provider_conflict", 409);
        if ([400, 403].includes(response.status) || hasProviderError) throw failure("provider_request_failed", 502);
        throw failure("provider_unavailable", 502);
      }
      if (!structured) throw failure("provider_malformed_response");
      return result;
    } catch (error) {
      if (error?.code && error?.status && /^Social provider request failed \(/.test(error.message)) throw error;
      if (signal?.aborted) throw failure("request_aborted", 408);
      if (timeout.aborted) throw failure("request_timeout", 504);
      throw failure("provider_network_error", 502);
    }
  }
  function authorized(token) { return { Authorization: `Bearer ${tokenValue(token)}` }; }
  function authUrl(adapter, endpoint, params, { redirectUri, state, codeChallenge }) {
    configured(adapter);
    let redirect;
    try { redirect = new URL(redirectUri); } catch { throw failure("invalid_redirect_uri", 400); }
    if (redirect.protocol !== "https:" || redirect.username || redirect.password || !state) throw failure("invalid_redirect_uri", 400);
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries({ ...params, redirect_uri: redirect.href, response_type: "code", state })) url.searchParams.set(key, value);
    if (adapter.supportsPKCE && codeChallenge) {
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.href;
  }
  function formToken(endpoint, values, options = {}) {
    return request(endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values).toString(), ...options });
  }
  function collectPage(posts, input, normalize) {
    if (!Array.isArray(input)) throw failure("provider_malformed_response");
    for (const item of input) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw failure("provider_malformed_response");
      const post = normalize(item);
      posts.set(post.id, post);
    }
  }
  async function report(onProgress, pages, posts, cursor, complete) {
    if (typeof onProgress === "function") await onProgress({ pages, posts: posts.size, cursor, complete });
  }

  const instagram = metadata("instagram");
  const igVersion = /^v\d+\.\d+$/.test(env.INSTAGRAM_API_VERSION || "") ? env.INSTAGRAM_API_VERSION : "v23.0";
  const igBase = `https://graph.instagram.com/${igVersion}`;
  Object.assign(instagram, {
    authorizationUrl(options) { return authUrl(instagram, "https://www.instagram.com/oauth/authorize", { client_id: env.INSTAGRAM_CLIENT_ID, scope: instagram.scopes.join(","), enable_fb_login: "0", force_authentication: "1" }, options); },
    async exchangeCode({ code, redirectUri }) {
      configured(instagram);
      const raw = await formToken("https://api.instagram.com/oauth/access_token", { client_id: env.INSTAGRAM_CLIENT_ID, client_secret: env.INSTAGRAM_CLIENT_SECRET, grant_type: "authorization_code", redirect_uri: redirectUri, code });
      const shortToken = normalizeToken(raw, { scope: instagram.scopes });
      // Instagram refresh uses a long-lived access token rather than a separate
      // refresh token. Only mark refreshable after this exchange has succeeded.
      // Contract is fixture-tested; current provider docs were network-blocked.
      const url = new URL("https://graph.instagram.com/access_token");
      url.searchParams.set("grant_type", "ig_exchange_token");
      url.searchParams.set("client_secret", env.INSTAGRAM_CLIENT_SECRET);
      url.searchParams.set("access_token", shortToken.accessToken);
      const longToken = await request(url);
      if (!(metric(longToken.expires_in) > 0)) throw failure("provider_malformed_response");
      const token = normalizeToken(longToken, { scope: shortToken.scope });
      return { ...token, refreshToken: token.accessToken, tokenType: "instagram_long_lived" };
    },
    async refreshToken(token) {
      configured(instagram);
      if (token?.tokenType !== "instagram_long_lived" || !token.refreshToken) throw failure("reauthorization_required", 401);
      const url = new URL("https://graph.instagram.com/refresh_access_token");
      url.searchParams.set("grant_type", "ig_refresh_token");
      url.searchParams.set("access_token", token.refreshToken);
      const raw = await request(url);
      if (!(metric(raw.expires_in) > 0)) throw failure("provider_malformed_response");
      const refreshed = normalizeToken(raw, token);
      return { ...refreshed, refreshToken: refreshed.accessToken, tokenType: "instagram_long_lived" };
    },
    async readProfile(token, { signal } = {}) {
      const url = new URL(`${igBase}/me`);
      url.searchParams.set("fields", "id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count");
      const raw = await request(url, { headers: authorized(token), signal });
      const username = text(raw.username, 1000);
      return { id: requiredId(raw.id || raw.user_id), username, displayName: text(raw.name, 1000) || username, avatarUrl: safeUrl(raw.profile_picture_url), url: username ? `https://www.instagram.com/${encodeURIComponent(username)}/` : null, bio: text(raw.biography), metrics: { followers: metric(raw.followers_count), following: metric(raw.follows_count), posts: metric(raw.media_count), likes: null, views: null } };
    },
    async readPosts(token, { cursor, signal, maxPages, onProgress } = {}) {
      const budget = pageBudget(maxPages);
      let after = cursor === undefined || cursor === null ? null : cursorText(cursor);
      const posts = new Map();
      const seen = new Set();
      for (let pages = 1; pages <= budget; pages += 1) {
        const url = new URL(`${igBase}/me/media`);
        url.searchParams.set("fields", "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count");
        url.searchParams.set("limit", "100");
        if (after) url.searchParams.set("after", after);
        const raw = await request(url, { headers: authorized(token), signal });
        collectPage(posts, raw.data, (item) => ({ id: requiredId(item.id), caption: text(item.caption), url: safeUrl(item.permalink), thumbnailUrl: safeUrl(item.thumbnail_url) || (item.media_type === "IMAGE" ? safeUrl(item.media_url) : null), publishedAt: date(item.timestamp), mediaType: item.media_type === "VIDEO" ? "video" : item.media_type === "CAROUSEL_ALBUM" ? "carousel" : item.media_type === "IMAGE" ? "photo" : "unknown", metrics: { likes: metric(item.like_count), comments: metric(item.comments_count), shares: null, views: null } }));
        if (!raw.paging?.next) {
          await report(onProgress, pages, posts, null, true);
          return { posts: [...posts.values()], cursor: null, complete: true, pages };
        }
        let next;
        try { next = new URL(raw.paging.next); } catch { throw failure("provider_malformed_response"); }
        if (next.origin !== "https://graph.instagram.com" || next.username || next.password) throw failure("provider_malformed_response");
        after = raw.paging?.cursors?.after || next.searchParams.get("after");
        if (typeof after !== "string" || !after || after.length > 10000 || seen.has(after) || after === cursor) throw failure("provider_invalid_pagination");
        seen.add(after);
        await report(onProgress, pages, posts, after, false);
        if (pages === budget) return { posts: [...posts.values()], cursor: after, complete: false, pages };
      }
    },
  });
  adapters.instagram = instagram;

  const tiktok = metadata("tiktok");
  Object.assign(tiktok, {
    authorizationUrl(options) { return authUrl(tiktok, "https://www.tiktok.com/v2/auth/authorize/", { client_key: env.TIKTOK_CLIENT_KEY, scope: tiktok.scopes.join(",") }, options); },
    async exchangeCode({ code, redirectUri, codeVerifier }) {
      configured(tiktok);
      const raw = await formToken("https://open.tiktokapis.com/v2/oauth/token/", { client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: "authorization_code", redirect_uri: redirectUri, code, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }, { tiktok: true });
      return normalizeToken(raw);
    },
    async refreshToken(token) {
      configured(tiktok);
      if (!token?.refreshToken) throw failure("reauthorization_required", 401);
      const raw = await formToken("https://open.tiktokapis.com/v2/oauth/token/", { client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: token.refreshToken }, { tiktok: true });
      return normalizeToken(raw, token);
    },
    async readProfile(token, { signal } = {}) {
      const granted = scopes(token?.scope);
      const fields = ["open_id", "display_name", "avatar_url"];
      if (granted.includes("user.info.profile")) fields.push("username", "bio_description", "profile_deep_link");
      if (granted.includes("user.info.stats")) fields.push("follower_count", "following_count", "likes_count", "video_count");
      const url = new URL("https://open.tiktokapis.com/v2/user/info/");
      url.searchParams.set("fields", fields.join(","));
      const result = await request(url, { headers: authorized(token), signal, tiktok: true });
      const raw = result.data?.user;
      if (!raw || typeof raw !== "object") throw failure("provider_malformed_response");
      const hasProfile = granted.includes("user.info.profile");
      const hasStats = granted.includes("user.info.stats");
      return { id: requiredId(raw.open_id), username: hasProfile ? text(raw.username, 1000) : "", displayName: text(raw.display_name, 1000), avatarUrl: safeUrl(raw.avatar_url), url: hasProfile ? safeUrl(raw.profile_deep_link) : null, bio: hasProfile ? text(raw.bio_description) : "", metrics: { followers: hasStats ? metric(raw.follower_count) : null, following: hasStats ? metric(raw.following_count) : null, posts: hasStats ? metric(raw.video_count) : null, likes: hasStats ? metric(raw.likes_count) : null, views: null } };
    },
    async readPosts(token, { cursor, signal, maxPages, onProgress } = {}) {
      const budget = pageBudget(maxPages);
      let after = cursor === undefined || cursor === null ? null : cursorText(cursor);
      const posts = new Map();
      const seen = new Set();
      for (let pages = 1; pages <= budget; pages += 1) {
        const body = { max_count: 20 };
        if (after !== null) {
          if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw failure("invalid_cursor", 400);
          body.cursor = Number(after);
        }
        const url = new URL("https://open.tiktokapis.com/v2/video/list/");
        url.searchParams.set("fields", "id,create_time,title,video_description,cover_image_url,share_url,like_count,comment_count,share_count,view_count");
        const raw = await request(url, { method: "POST", headers: { ...authorized(token), "Content-Type": "application/json" }, body: JSON.stringify(body), signal, tiktok: true });
        collectPage(posts, raw.data?.videos, (item) => ({ id: requiredId(item.id), caption: text(item.video_description) || text(item.title), url: safeUrl(item.share_url), thumbnailUrl: safeUrl(item.cover_image_url), publishedAt: typeof item.create_time === "number" && Number.isFinite(item.create_time) && Number.isFinite(new Date(item.create_time * 1000).getTime()) ? new Date(item.create_time * 1000).toISOString() : null, mediaType: "video", metrics: { likes: metric(item.like_count), comments: metric(item.comment_count), shares: metric(item.share_count), views: metric(item.view_count) } }));
        if (typeof raw.data?.has_more !== "boolean") throw failure("provider_malformed_response");
        if (!raw.data.has_more) {
          await report(onProgress, pages, posts, null, true);
          return { posts: [...posts.values()], cursor: null, complete: true, pages };
        }
        const next = id(raw.data.cursor);
        if (!/^\d+$/.test(next) || !Number.isSafeInteger(Number(next)) || next === after || seen.has(next)) throw failure("provider_invalid_pagination");
        seen.add(next);
        after = next;
        await report(onProgress, pages, posts, after, false);
        if (pages === budget) return { posts: [...posts.values()], cursor: after, complete: false, pages };
      }
    },
  });
  adapters.tiktok = tiktok;

  const youtube = metadata("youtube");
  function youtubeUrl(resource, params) {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(key, value);
    return url;
  }
  function encodeYoutubeCursor(playlistId, pageToken) { return Buffer.from(JSON.stringify({ playlistId, pageToken })).toString("base64url"); }
  function decodeYoutubeCursor(value) {
    try {
      const raw = JSON.parse(Buffer.from(cursorText(value), "base64url").toString("utf8"));
      if (typeof raw.playlistId !== "string" || !/^[\w-]{1,200}$/.test(raw.playlistId) || typeof raw.pageToken !== "string" || !raw.pageToken || raw.pageToken.length > 4096) throw new Error();
      return raw;
    } catch { throw failure("invalid_cursor", 400); }
  }
  Object.assign(youtube, {
    authorizationUrl(options) { return authUrl(youtube, "https://accounts.google.com/o/oauth2/v2/auth", { client_id: env.GOOGLE_CLIENT_ID, scope: youtube.scopes.join(" "), access_type: "offline", prompt: "consent" }, options); },
    async exchangeCode({ code, redirectUri, codeVerifier }) {
      configured(youtube);
      const raw = await formToken("https://oauth2.googleapis.com/token", { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "authorization_code", redirect_uri: redirectUri, code, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) });
      return normalizeToken(raw);
    },
    async refreshToken(token) {
      configured(youtube);
      if (!token?.refreshToken) throw failure("reauthorization_required", 401);
      const raw = await formToken("https://oauth2.googleapis.com/token", { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: token.refreshToken });
      return normalizeToken(raw, token);
    },
    async readProfile(token, { signal } = {}) {
      const raw = await request(youtubeUrl("channels", { part: "snippet,statistics", mine: "true" }), { headers: authorized(token), signal });
      if (!Array.isArray(raw.items) || !raw.items.length) throw failure("provider_account_unavailable", 404);
      const channel = raw.items[0];
      const channelId = requiredId(channel.id);
      return { id: channelId, username: text(channel.snippet?.customUrl, 1000), displayName: text(channel.snippet?.title, 1000), avatarUrl: safeUrl(channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url), url: `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`, bio: text(channel.snippet?.description), metrics: { followers: channel.statistics?.hiddenSubscriberCount ? null : metric(channel.statistics?.subscriberCount), following: null, posts: metric(channel.statistics?.videoCount), likes: null, views: metric(channel.statistics?.viewCount) } };
    },
    async readPosts(token, { cursor, signal, maxPages, onProgress } = {}) {
      const budget = pageBudget(maxPages);
      let playlistId;
      let pageToken = null;
      if (cursor !== undefined && cursor !== null) ({ playlistId, pageToken } = decodeYoutubeCursor(cursor));
      else {
        const channel = await request(youtubeUrl("channels", { part: "contentDetails", mine: "true" }), { headers: authorized(token), signal });
        if (!Array.isArray(channel.items) || !channel.items.length) throw failure("provider_account_unavailable", 404);
        playlistId = channel.items[0].contentDetails?.relatedPlaylists?.uploads;
        if (typeof playlistId !== "string" || !/^[\w-]{1,200}$/.test(playlistId)) throw failure("provider_malformed_response");
      }
      const posts = new Map();
      const seen = new Set(pageToken ? [pageToken] : []);
      for (let pages = 1; pages <= budget; pages += 1) {
        const list = await request(youtubeUrl("playlistItems", { part: "contentDetails", playlistId, maxResults: "50", pageToken }), { headers: authorized(token), signal });
        if (!Array.isArray(list.items)) throw failure("provider_malformed_response");
        if (list.items.length > 50 || list.items.some((item) => typeof item?.contentDetails?.videoId !== "string" || !/^[\w-]{1,200}$/.test(item.contentDetails.videoId))) throw failure("provider_malformed_response");
        const ids = [...new Set(list.items.map((item) => item.contentDetails.videoId))];
        if (ids.length) {
          const videos = await request(youtubeUrl("videos", { part: "snippet,contentDetails,statistics,status", id: ids.join(",") }), { headers: authorized(token), signal });
          collectPage(posts, videos.items, (item) => {
            const videoId = requiredId(item.id);
            return { id: videoId, caption: text(item.snippet?.description) || text(item.snippet?.title), url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, thumbnailUrl: safeUrl(item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url), publishedAt: date(item.snippet?.publishedAt), mediaType: "video", metrics: { likes: metric(item.statistics?.likeCount), comments: metric(item.statistics?.commentCount), shares: null, views: metric(item.statistics?.viewCount) } };
          });
        }
        if (list.nextPageToken === undefined || list.nextPageToken === null || list.nextPageToken === "") {
          await report(onProgress, pages, posts, null, true);
          return { posts: [...posts.values()], cursor: null, complete: true, pages };
        }
        if (typeof list.nextPageToken !== "string" || list.nextPageToken.length > 4096 || seen.has(list.nextPageToken)) throw failure("provider_invalid_pagination");
        pageToken = list.nextPageToken;
        seen.add(pageToken);
        await report(onProgress, pages, posts, encodeYoutubeCursor(playlistId, pageToken), false);
        if (pages === budget) return { posts: [...posts.values()], cursor: encodeYoutubeCursor(playlistId, pageToken), complete: false, pages };
      }
    },
  });
  adapters.youtube = youtube;

  const x = metadata("x");
  function xUrl(resource, params = {}) {
    const url = new URL(`https://api.x.com/2/${resource}`);
    for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(key, value);
    return url;
  }
  function xClientHeaders() {
    const credentials = `${encodeURIComponent(env.X_CLIENT_ID)}:${encodeURIComponent(env.X_CLIENT_SECRET)}`;
    return { Authorization: `Basic ${Buffer.from(credentials).toString("base64")}` };
  }
  function xCursor(value) {
    try {
      const raw = JSON.parse(Buffer.from(cursorText(value), "base64url").toString("utf8"));
      if (typeof raw.userId !== "string" || !/^\d{1,100}$/.test(raw.userId) || typeof raw.paginationToken !== "string" || !raw.paginationToken || raw.paginationToken.length > 4096) throw new Error();
      return raw;
    } catch { throw failure("invalid_cursor", 400); }
  }
  const encodeXCursor = (userId, paginationToken) => Buffer.from(JSON.stringify({ userId, paginationToken })).toString("base64url");
  Object.assign(x, {
    authorizationUrl(options) {
      if (!options?.codeChallenge) throw failure("pkce_required", 400);
      return authUrl(x, "https://x.com/i/oauth2/authorize", { client_id: env.X_CLIENT_ID, scope: x.scopes.join(" ") }, options);
    },
    async exchangeCode({ code, redirectUri, codeVerifier }) {
      configured(x);
      if (!codeVerifier) throw failure("pkce_required", 400);
      const raw = await formToken("https://api.x.com/2/oauth2/token", { code, grant_type: "authorization_code", client_id: env.X_CLIENT_ID, redirect_uri: redirectUri, code_verifier: codeVerifier }, { headers: { ...xClientHeaders(), "Content-Type": "application/x-www-form-urlencoded" } });
      return normalizeToken(raw);
    },
    async refreshToken(token) {
      configured(x);
      if (!token?.refreshToken) throw failure("reauthorization_required", 401);
      const raw = await formToken("https://api.x.com/2/oauth2/token", { grant_type: "refresh_token", refresh_token: token.refreshToken, client_id: env.X_CLIENT_ID }, { headers: { ...xClientHeaders(), "Content-Type": "application/x-www-form-urlencoded" } });
      return normalizeToken(raw, token);
    },
    async readProfile(token, { signal } = {}) {
      const raw = await request(xUrl("users/me", { "user.fields": "description,name,profile_image_url,public_metrics,username" }), { headers: authorized(token), signal });
      const user = raw.data;
      if (!user || typeof user !== "object") throw failure("provider_malformed_response");
      const username = text(user.username, 1000);
      return { id: requiredId(user.id), username, displayName: text(user.name, 1000), avatarUrl: safeUrl(user.profile_image_url), url: username ? `https://x.com/${encodeURIComponent(username)}` : null, bio: text(user.description), metrics: { followers: metric(user.public_metrics?.followers_count), following: metric(user.public_metrics?.following_count), posts: metric(user.public_metrics?.tweet_count), likes: metric(user.public_metrics?.like_count), views: null } };
    },
    async readPosts(token, { cursor, signal, maxPages, onProgress } = {}) {
      const budget = pageBudget(maxPages);
      let userId;
      let paginationToken = null;
      if (cursor !== undefined && cursor !== null) ({ userId, paginationToken } = xCursor(cursor));
      else {
        const user = await request(xUrl("users/me"), { headers: authorized(token), signal });
        userId = id(user.data?.id);
        if (!/^\d{1,100}$/.test(userId)) throw failure("provider_malformed_response");
      }
      const posts = new Map();
      const seen = new Set(paginationToken ? [paginationToken] : []);
      for (let pages = 1; pages <= budget; pages += 1) {
        const raw = await request(xUrl(`users/${userId}/tweets`, { max_results: "100", pagination_token: paginationToken, "tweet.fields": "created_at,public_metrics,attachments", expansions: "attachments.media_keys", "media.fields": "preview_image_url,url,type" }), { headers: authorized(token), signal });
        // X can omit data on an empty result but explicitly reports result_count.
        const items = raw.data === undefined && raw.meta?.result_count === 0 ? [] : raw.data;
        const media = new Map((Array.isArray(raw.includes?.media) ? raw.includes.media : []).filter((item) => item && typeof item.media_key === "string").map((item) => [item.media_key, item]));
        collectPage(posts, items, (item) => {
          const postId = requiredId(item.id);
          const attachments = (Array.isArray(item.attachments?.media_keys) ? item.attachments.media_keys : []).map((key) => media.get(key)).filter(Boolean);
          const first = attachments[0];
          return { id: postId, caption: text(item.text), url: `https://x.com/i/web/status/${encodeURIComponent(postId)}`, thumbnailUrl: safeUrl(first?.preview_image_url) || (first?.type === "photo" ? safeUrl(first.url) : null), publishedAt: date(item.created_at), mediaType: attachments.length > 1 ? "carousel" : first?.type === "photo" ? "photo" : ["video", "animated_gif"].includes(first?.type) ? "video" : "text", metrics: { likes: metric(item.public_metrics?.like_count), comments: metric(item.public_metrics?.reply_count), shares: metric(item.public_metrics?.retweet_count), views: metric(item.public_metrics?.impression_count) } };
        });
        if (raw.errors?.length) throw failure("provider_partial_response");
        if (!raw.meta?.next_token) {
          await report(onProgress, pages, posts, null, true);
          return { posts: [...posts.values()], cursor: null, complete: true, pages };
        }
        if (typeof raw.meta.next_token !== "string" || raw.meta.next_token.length > 4096 || seen.has(raw.meta.next_token)) throw failure("provider_invalid_pagination");
        paginationToken = raw.meta.next_token;
        seen.add(paginationToken);
        const nextCursor = encodeXCursor(userId, paginationToken);
        await report(onProgress, pages, posts, nextCursor, false);
        if (pages === budget) return { posts: [...posts.values()], cursor: nextCursor, complete: false, pages };
      }
    },
  });
  adapters.x = x;

  const telegram = metadata("telegram");
  async function telegramRequest(token, method, params = {}, signal) {
    // A bot token belongs to a single path segment. Preserve its standard colon,
    // and encode slashes/queries or proxy placeholders rather than interpreting
    // them as URL syntax. Never return this credential-bearing URL to callers.
    const secretSegment = encodeURIComponent(tokenValue(token)).replace(/%3A/gi, ":");
    const raw = await formToken(`https://api.telegram.org/bot${secretSegment}/${method}`, params, { signal });
    if (raw.ok !== true || !Object.hasOwn(raw, "result")) throw failure("provider_authorization_failed", 401);
    return raw.result;
  }
  function telegramChatId(token) {
    if (typeof token?.chatId !== "string" || !token.chatId || token.chatId.length > 1000) throw failure("provider_chat_not_configured", 503);
    return token.chatId;
  }
  Object.assign(telegram, {
    configuredToken() {
      configured(telegram);
      return { accessToken: env.TELEGRAM_BOT_TOKEN, chatId: String(env.TELEGRAM_CHAT_ID), refreshToken: null, expiresAt: null, scope: [] };
    },
    async refreshToken() { throw failure("reauthorization_required", 401); },
    async readProfile(token, { signal } = {}) {
      const bot = await telegramRequest(token, "getMe", {}, signal);
      if (!bot || !id(bot.id) || bot.is_bot !== true) throw failure("provider_malformed_response");
      const chat = await telegramRequest(token, "getChat", { chat_id: telegramChatId(token) }, signal);
      if (!chat || typeof chat !== "object") throw failure("provider_malformed_response");
      let followers = null;
      try { followers = metric(await telegramRequest(token, "getChatMemberCount", { chat_id: requiredId(chat.id) }, signal)); }
      catch (error) { if (!["provider_authorization_failed", "provider_request_failed"].includes(error.code)) throw error; }
      const username = text(chat.username, 1000);
      return { id: requiredId(chat.id), username, displayName: text(chat.title, 1000) || [text(chat.first_name, 500), text(chat.last_name, 500)].filter(Boolean).join(" "), avatarUrl: null, url: username ? `https://t.me/${encodeURIComponent(username)}` : null, bio: text(chat.description) || text(chat.bio), metrics: { followers, following: null, posts: null, likes: null, views: null } };
    },
    async readPosts(token, { cursor, signal, maxPages, onProgress } = {}) {
      pageBudget(maxPages);
      if (cursor !== undefined && cursor !== null) throw failure("invalid_cursor", 400);
      const webhook = await telegramRequest(token, "getWebhookInfo", {}, signal);
      if (!webhook || typeof webhook.url !== "string") throw failure("provider_malformed_response");
      if (webhook.url) throw failure("telegram_webhook_configured", 409);
      const chat = await telegramRequest(token, "getChat", { chat_id: telegramChatId(token) }, signal);
      const selectedChatId = requiredId(chat?.id);
      // Omitting offset deliberately does not acknowledge/consume pending
      // updates. Do not change webhook, allowed_updates or drop_pending_updates.
      const updates = await telegramRequest(token, "getUpdates", { limit: "100", timeout: "0" }, signal);
      if (!Array.isArray(updates) || updates.length > 100) throw failure("provider_malformed_response");
      const posts = new Map();
      for (const update of updates) {
        const item = update?.channel_post || update?.edited_channel_post || update?.message || update?.edited_message;
        if (!item || id(item.chat?.id) !== selectedChatId) continue;
        if (!Number.isSafeInteger(item.message_id)) throw failure("provider_malformed_response");
        const postId = `${selectedChatId}:${item.message_id}`;
        const username = text(chat.username, 1000);
        const url = username ? `https://t.me/${encodeURIComponent(username)}/${item.message_id}` : null;
        posts.set(postId, { id: postId, caption: text(item.text) || text(item.caption), url, thumbnailUrl: null, publishedAt: typeof item.date === "number" && Number.isFinite(new Date(item.date * 1000).getTime()) ? new Date(item.date * 1000).toISOString() : null, mediaType: item.video || item.animation || item.video_note ? "video" : Array.isArray(item.photo) && item.photo.length ? "photo" : item.document || item.audio || item.voice ? "unknown" : "text", metrics: { likes: null, comments: null, shares: null, views: null } });
      }
      await report(onProgress, 1, posts, null, false);
      return { posts: [...posts.values()], cursor: null, complete: false, pages: 1, coverageReason: "telegram_pending_updates_only", warnings: ["Telegram Bot API предоставляет только ожидающие обновления; полная история канала недоступна."] };
    },
  });
  adapters.telegram = telegram;
  return adapters;
}

module.exports = { SOCIAL_PROVIDERS, createSocialProviderAdapters };
