const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const AUTH_TTL_MS = 10 * 60 * 1000;
const ACTIVE_JOBS = new Set(["queued", "running"]);
const string = (value) => typeof value === "string" ? value : "";
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const error = (message, status = 400, code = "invalid_request") => Object.assign(new Error(message), { status, code });
const copy = (value) => JSON.parse(JSON.stringify(value));

function iso(value) {
  if (!string(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if ([...url.searchParams.keys()].some((key) => /^(access_token|refresh_token|client_secret|authorization|password)$/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}

function metrics(raw) {
  const result = {};
  for (const key of ["followers", "following", "posts", "likes", "views", "comments", "shares", "subscribers", "videos", "favorites"]) {
    const value = raw?.[key];
    if (value === null) result[key] = null;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}

function profile(raw) {
  if (!raw || !string(raw.id) || raw.id.length > 300) throw error("Платформа не вернула профиль аккаунта.", 502, "invalid_profile");
  return {
    id: raw.id,
    username: string(raw.username),
    displayName: string(raw.displayName),
    avatarUrl: safeUrl(raw.avatarUrl),
    url: safeUrl(raw.url),
    bio: string(raw.bio),
    metrics: metrics(raw.metrics),
  };
}

function posts(raw) {
  if (!Array.isArray(raw)) throw error("Платформа не вернула список публикаций.", 502, "invalid_posts");
  const unique = new Map();
  for (const item of raw) if (item && string(item.id) && item.id.length <= 300) unique.set(item.id, item);
  return [...unique.values()].map((item) => ({
    id: item.id,
    caption: string(item.caption),
    title: string(item.title),
    mediaType: ["photo", "video", "carousel", "text"].includes(item.mediaType) ? item.mediaType : "unknown",
    mediaUrl: safeUrl(item.mediaUrl),
    thumbnailUrl: safeUrl(item.thumbnailUrl),
    url: safeUrl(item.url),
    publishedAt: iso(item.publishedAt),
    metrics: metrics(item.metrics),
  }));
}

function token(raw, previous = {}) {
  const accessToken = string(raw?.accessToken);
  const refreshToken = string(raw?.refreshToken) || string(previous.refreshToken);
  if (!accessToken || accessToken.length > 32000 || /[\r\n\0]/.test(accessToken + refreshToken)) throw error("Платформа не вернула действующий токен.", 502, "invalid_token_response");
  const scope = Array.isArray(raw.scope) ? raw.scope : typeof raw.scope === "string" ? raw.scope.split(/[ ,]+/) : previous.scope || [];
  const chatId = string(raw.chatId) || string(previous.chatId);
  if (chatId.length > 200 || /[\r\n\0]/.test(chatId)) throw error("Некорректный идентификатор настроенного чата.", 502, "invalid_token_response");
  return { accessToken, refreshToken: refreshToken || null, expiresAt: iso(raw.expiresAt), scope: scope.filter((item) => typeof item === "string"), tokenType: string(raw.tokenType) || string(previous.tokenType) || null, chatId: chatId || null };
}

function createSocialConnectionService(options = {}) {
  const root = path.resolve(options.root || require("./config").config.projectRoot);
  const providers = options.providers || require("./social-provider-adapters").createSocialProviderAdapters();
  const getAccounts = options.getAccounts || require("./account-manager").getAllAccounts;
  const now = options.now || Date.now;
  const maxPages = options.maxPages === undefined ? 100 : options.maxPages;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw error("Некорректный предел страниц.");
  const configuredPublicUrl = options.publicUrl === undefined ? process.env.DASHBOARD_PUBLIC_URL || "" : options.publicUrl;
  let publicUrl = null;
  try {
    const url = new URL(configuredPublicUrl);
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"
      && !/(^|\.)(tunnelmole\.net|trycloudflare\.com)$/.test(url.hostname)
      && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) publicUrl = url.origin;
  } catch {}
  const directory = path.join(root, ".local", "social-api");
  const keyPath = path.join(directory, "vault.key");
  const storePath = path.join(directory, "vault.enc");
  const inFlight = new Map();
  let state = { version: 1, connections: {}, pending: {}, generations: {} };
  let key;
  let initializing;
  let writes = Promise.resolve();
  let closing = false;
  const stamp = () => new Date(now()).toISOString();

  async function atomicWrite(target, contents) {
    const temporary = path.join(directory, `.write-${crypto.randomBytes(12).toString("hex")}`);
    try {
      await fs.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  function persist() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("AutoSocial official API v1"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
    const serialized = Buffer.concat([Buffer.from("ASOCIAL1"), iv, cipher.getAuthTag(), ciphertext]);
    const write = writes.then(() => atomicWrite(storePath, serialized)).catch(() => { throw error("Не удалось сохранить защищённые данные подключений.", 500, "storage_unavailable"); });
    writes = write.catch(() => {});
    return write;
  }

  async function initialize() {
    try {
      await fs.mkdir(root, { recursive: true });
      for (const dir of [path.join(root, ".local"), directory]) {
        await fs.mkdir(dir, { mode: 0o700 }).catch((exception) => { if (exception.code !== "EEXIST") throw exception; });
        const stat = await fs.lstat(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe storage directory");
      }
      await fs.chmod(directory, 0o700);
      let existingStore = false;
      try { existingStore = Boolean(await fs.lstat(storePath)); } catch (exception) { if (exception.code !== "ENOENT") throw exception; }
      try {
        const handle = await fs.open(keyPath, "wx", 0o600);
        if (existingStore) { await handle.close(); await fs.unlink(keyPath); throw new Error("Missing encryption key"); }
        try { await handle.writeFile(crypto.randomBytes(32)); } finally { await handle.close(); }
      } catch (exception) { if (exception.code !== "EEXIST") throw exception; }
      if ((await fs.lstat(keyPath)).isSymbolicLink()) throw new Error("Unsafe storage key");
      key = await fs.readFile(keyPath);
      if (key.length !== 32) throw new Error("Invalid key");
      await fs.chmod(keyPath, 0o600);
      if (existingStore) {
        if ((await fs.lstat(storePath)).isSymbolicLink()) throw new Error("Unsafe storage file");
        const encrypted = await fs.readFile(storePath);
        if (encrypted.length < 37 || encrypted.subarray(0, 8).toString() !== "ASOCIAL1") throw new Error("Invalid storage");
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, encrypted.subarray(8, 20));
        decipher.setAAD(Buffer.from("AutoSocial official API v1"));
        decipher.setAuthTag(encrypted.subarray(20, 36));
        const restored = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(36)), decipher.final()]).toString("utf8"));
        if (restored.version !== 1 || !restored.connections || !restored.pending) throw new Error("Invalid storage shape");
        state = restored;
        if (!state.generations || typeof state.generations !== "object") state.generations = {};
      }
      let changed = false;
      for (const connection of Object.values(state.connections)) {
        if (ACTIVE_JOBS.has(connection.job?.status)) {
          connection.job.status = "interrupted";
          connection.job.finishedAt = stamp();
          connection.job.error = { code: "interrupted", message: "Синхронизация прервана перезапуском. Повторите её." };
          changed = true;
        }
      }
      for (const [id, pending] of Object.entries(state.pending)) {
        if (pending.expiresAt <= now()) { delete state.pending[id]; changed = true; }
      }
      if (changed) await persist();
    } catch { throw error("Не удалось открыть защищённое хранилище подключений. Проверьте постоянный диск и ключ.", 500, "storage_unavailable"); }
  }

  function ready() {
    if (!initializing) initializing = initialize();
    return initializing;
  }

  function adapter(id, requireReady = true) {
    if (typeof id !== "string" || !Object.hasOwn(providers, id)) throw error("Неизвестная социальная сеть.");
    const provider = providers[id];
    if (requireReady && provider.configured !== true) throw error("Приложение этой социальной сети ещё не настроено.", 409, "provider_not_configured");
    return provider;
  }

  function publicConnection(connection) {
    return copy({
      id: connection.id, provider: connection.provider, accountId: connection.accountId,
      source: "official_api", connectionStatus: connection.connectionStatus,
      connectedAt: connection.connectedAt, updatedAt: connection.updatedAt,
      profile: connection.profile, posts: connection.posts,
      lastSyncedAt: connection.lastSyncedAt, complete: connection.complete, cursor: connection.cursor,
      coverageReason: connection.coverageReason || null, warnings: connection.warnings || [],
      job: connection.job,
    });
  }

  async function status() {
    await ready();
    return {
      ok: true, source: "official_api", collectedAt: stamp(),
      hosting: { configured: Boolean(publicUrl), publicUrl, reason: publicUrl ? null : "Укажите постоянный HTTPS-адрес приложения; временные туннели не подходят." },
      providers: Object.values(providers).map((provider) => ({
        id: provider.id, name: provider.name, authType: provider.authType === "configured" ? "configured" : "oauth", configured: provider.configured === true,
        missingEnv: Array.isArray(provider.missingEnv) ? provider.missingEnv.filter((name) => /^[A-Z0-9_]+$/.test(name)) : [],
        available: provider.configured === true && (provider.authType === "configured" || Boolean(publicUrl)),
        reason: provider.configured !== true ? "Настройте приложение социальной сети." : provider.authType !== "configured" && !publicUrl ? "Укажите постоянный HTTPS-адрес приложения." : null,
        limitations: Array.isArray(provider.limitations) ? provider.limitations.filter((value) => typeof value === "string") : string(provider.limitations) ? [provider.limitations] : [],
      })),
      connections: Object.values(state.connections).map(publicConnection),
    };
  }

  async function beginAuthorization(providerId, accountId) {
    await ready();
    if (closing) throw error("Сервис перезапускается.", 503, "shutting_down");
    const provider = adapter(providerId);
    if (provider.authType === "configured") throw error("Эта платформа подключается через настройки сервера.", 409, "configured_connection_required");
    if (!publicUrl) throw error("Для подключения нужен постоянный HTTPS-адрес приложения.", 409, "public_url_required");
    if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(accountId)) throw error("Некорректный аккаунт.");
    const accounts = await getAccounts();
    if (!accounts.some((account) => account.id === accountId)) throw error("Аккаунт не найден.", 404);
    const oauthState = crypto.randomBytes(32).toString("base64url");
    const binding = crypto.randomBytes(32).toString("base64url");
    const verifier = provider.supportsPKCE ? crypto.randomBytes(48).toString("base64url") : null;
    const redirectUri = `${publicUrl}/api/social-connections/oauth/${providerId}/callback`;
    const authorizationUrl = provider.authorizationUrl({ redirectUri, state: oauthState, ...(verifier ? { codeChallenge: crypto.createHash("sha256").update(verifier).digest("base64url") } : {}) });
    if (!safeUrl(authorizationUrl)) throw error("Некорректный адрес авторизации провайдера.", 500, "invalid_provider_configuration");
    for (const [id, pending] of Object.entries(state.pending)) if (pending.expiresAt <= now()) delete state.pending[id];
    if (Object.keys(state.pending).length >= 100) throw error("Слишком много незавершённых подключений.", 429, "authorization_limit");
    state.pending[digest(oauthState)] = { provider: providerId, accountId, bindingHash: digest(binding), verifier, redirectUri, expiresAt: now() + AUTH_TTL_MS, generation: state.generations[`${providerId}:${accountId}`] || 0 };
    await persist();
    return {
      authorizationUrl,
      stateCookie: { name: `autosocial_oauth_${providerId}`, value: binding, maxAge: AUTH_TTL_MS, httpOnly: true, secure: true, sameSite: "lax", path: `/api/social-connections/oauth/${providerId}/callback` },
    };
  }

  async function completeAuthorization(providerId, input = {}) {
    await ready();
    if (closing) throw error("Сервис перезапускается.", 503, "shutting_down");
    const provider = adapter(providerId);
    if (typeof input.state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || typeof input.bindingCookie !== "string" || input.bindingCookie.length > 200) throw error("Подтверждение подключения недействительно. Начните подключение снова.", 400, "invalid_oauth_state");
    const pendingId = digest(input.state);
    const pending = state.pending[pendingId];
    if (!pending || pending.provider !== providerId || pending.expiresAt <= now()
      || !crypto.timingSafeEqual(Buffer.from(pending.bindingHash, "hex"), Buffer.from(digest(input.bindingCookie), "hex"))) throw error("Подтверждение подключения недействительно. Начните подключение снова.", 400, "invalid_oauth_state");
    delete state.pending[pendingId];
    await persist();
    if (input.error) throw error("Разрешение социальной сети не получено. Подключите аккаунт повторно.", 400, "authorization_denied");
    if (typeof input.code !== "string" || !input.code || input.code.length > 4096) throw error("Платформа не вернула код подключения.", 400, "authorization_code_missing");
    let grant;
    let user;
    try {
      grant = token(await provider.exchangeCode({ code: input.code, redirectUri: pending.redirectUri, ...(pending.verifier ? { codeVerifier: pending.verifier } : {}) }));
      user = profile(await provider.readProfile(grant, {}));
    } catch { throw error("Не удалось подтвердить доступ к аккаунту социальной сети. Повторите подключение.", 502, "authorization_failed"); }
    return finishConnection(providerId, pending.accountId, grant, user, pending.generation || 0);
  }

  async function finishConnection(providerId, accountId, grant, user, generation) {
    if (closing) throw error("Сервис перезапускается. Подключите аккаунт ещё раз.", 503, "shutting_down");
    if ((state.generations[`${providerId}:${accountId}`] || 0) !== generation) throw error("Подключение отменено. При необходимости начните его заново.", 409, "authorization_cancelled");
    let connection = Object.values(state.connections).find((item) => item.provider === providerId && item.accountId === accountId && item.profile.id === user.id);
    if (connection) {
      inFlight.get(connection.id)?.controller.abort();
      connection.job = null;
      connection.token = grant;
      connection.profile = user;
      connection.connectionStatus = "connected";
      connection.updatedAt = stamp();
    } else {
      connection = {
        id: crypto.randomUUID(), provider: providerId, accountId, token: grant,
        profile: user, posts: [], connectedAt: stamp(), updatedAt: stamp(), connectionStatus: "connected",
        lastSyncedAt: null, complete: false, cursor: null, coverageReason: null, warnings: [], job: null,
      };
      state.connections[connection.id] = connection;
    }
    await persist();
    // Connecting explicitly authorizes the initial read. Publishing is not part of this service.
    return sync(connection.id);
  }

  async function connectConfigured(providerId, accountId) {
    await ready();
    if (closing) throw error("Сервис перезапускается.", 503, "shutting_down");
    const provider = adapter(providerId);
    if (provider.authType !== "configured" || typeof provider.configuredToken !== "function") throw error("Эта платформа требует авторизации в социальной сети.", 409, "oauth_required");
    if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(accountId)) throw error("Некорректный аккаунт.");
    const accounts = await getAccounts();
    if (!accounts.some((account) => account.id === accountId)) throw error("Аккаунт не найден.", 404);
    const generation = state.generations[`${providerId}:${accountId}`] || 0;
    let grant;
    let user;
    try {
      grant = token(await provider.configuredToken());
      user = profile(await provider.readProfile(grant, {}));
    } catch { throw error("Не удалось проверить настроенное подключение. Проверьте доступ бота к указанному чату и настройки сервера.", 502, "configured_connection_failed"); }
    return finishConnection(providerId, accountId, grant, user, generation);
  }

  function current(id, jobId) {
    const connection = state.connections[id];
    return connection?.job?.id === jobId ? connection : null;
  }

  async function execute(id, jobId, controller) {
    let connection = current(id, jobId);
    if (!connection) {
      if (inFlight.get(id)?.jobId === jobId) inFlight.delete(id);
      return;
    }
    const provider = adapter(connection.provider, false);
    try {
      connection.job.status = "running";
      connection.job.startedAt = stamp();
      await persist();
      let grant = connection.token;
      if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now() + 60000) {
        if (!grant.refreshToken || typeof provider.refreshToken !== "function") throw error("Подключите аккаунт повторно.", 401, "token_expired");
        const refreshed = token(await provider.refreshToken(grant), grant);
        connection = current(id, jobId);
        if (!connection || controller.signal.aborted) return;
        connection.token = refreshed;
        grant = refreshed;
        // Persist a rotated refresh token before any following provider request.
        await persist();
      }
      const user = profile(await provider.readProfile(grant, { signal: controller.signal }));
      connection = current(id, jobId);
      if (!connection || controller.signal.aborted) return;
      if (user.id !== connection.profile.id) throw error("Подключённый профиль изменился. Подключите аккаунт повторно.", 401, "invalid_token");
      const continuing = connection.lastSyncedAt && connection.complete === false && connection.cursor;
      const result = await provider.readPosts(grant, {
        signal: controller.signal, maxPages, ...(continuing ? { cursor: connection.cursor } : {}),
        onProgress: async (progress) => {
          const active = current(id, jobId);
          if (!active || controller.signal.aborted) return;
          active.job.pages = Number.isInteger(progress?.pages) && progress.pages >= 0 ? progress.pages : active.job.pages;
          active.job.posts = Number.isInteger(progress?.posts) && progress.posts >= 0 ? progress.posts : active.job.posts;
          // A cursor is provider metadata, not a fetch URL or an authorization token.
          active.job.hasMore = Boolean(progress?.cursor);
          await persist();
        },
      });
      connection = current(id, jobId);
      if (!connection || controller.signal.aborted) return;
      const limitedCoverage = provider.authType === "configured" && result?.coverageReason === "telegram_pending_updates_only";
      if (typeof result?.complete !== "boolean" || (result.complete === false && !string(result.cursor) && !limitedCoverage)) throw error("Платформа вернула неполные данные без курсора продолжения.", 502, "invalid_pagination");
      const collected = posts(continuing || limitedCoverage ? [...connection.posts, ...result.posts] : result.posts);
      connection.profile = user;
      connection.posts = collected;
      connection.complete = result.complete;
      connection.cursor = result.complete ? null : string(result.cursor);
      if (!connection.cursor) connection.cursor = null;
      connection.coverageReason = /^[a-z][a-z0-9_]{0,100}$/.test(string(result.coverageReason)) ? result.coverageReason : null;
      connection.warnings = Array.isArray(result.warnings) ? result.warnings.filter((warning) => typeof warning === "string").map((warning) => warning.slice(0, 1000)) : [];
      connection.lastSyncedAt = stamp();
      connection.updatedAt = stamp();
      connection.connectionStatus = "connected";
      connection.job.status = result.complete ? "completed" : "partial";
      connection.job.pages = Number.isInteger(result.pages) ? result.pages : 0;
      connection.job.posts = collected.length;
      connection.job.finishedAt = stamp();
      connection.job.error = result.complete ? null : limitedCoverage
        ? { code: "coverage_limited", message: "Bot API предоставляет ожидающие обновления, а не полную историю канала. Сохранены доступные публикации." }
        : { code: "page_limit", message: "Получена часть публикаций. Ограничение страниц API достигнуто; список неполный." };
      await persist();
    } catch (exception) {
      connection = current(id, jobId);
      if (!connection) return;
      connection.job.status = controller.signal.aborted ? "interrupted" : "failed";
      connection.job.finishedAt = stamp();
      const authFailure = exception.status === 401 || ["token_expired", "invalid_token", "invalid_grant", "unauthorized"].includes(exception.code);
      if (authFailure) connection.connectionStatus = "needs_authorization";
      connection.job.error = {
        code: controller.signal.aborted ? "interrupted" : authFailure ? "authorization_required" : exception.status === 429 ? "rate_limited" : "sync_failed",
        message: controller.signal.aborted ? "Синхронизация прервана. Повторите её." : authFailure ? "Доступ истёк или отозван. Подключите аккаунт повторно." : exception.status === 429 ? "Социальная сеть ограничила частоту запросов. Повторите синхронизацию позже." : "Не удалось загрузить данные социальной сети. Последние сохранённые данные оставлены без изменений.",
      };
      if (exception.code === "telegram_webhook_configured") connection.job.error = { code: "telegram_webhook_configured", message: "У бота настроен webhook. Чтение ожидающих обновлений недоступно; используйте отдельного бота." };
      await persist();
    } finally {
      if (inFlight.get(id)?.jobId === jobId) inFlight.delete(id);
    }
  }

  async function sync(id) {
    await ready();
    if (closing) throw error("Сервис перезапускается.", 503, "shutting_down");
    const connection = typeof id === "string" && Object.hasOwn(state.connections, id) ? state.connections[id] : null;
    if (!connection) throw error("Подключение не найдено.", 404, "connection_not_found");
    adapter(connection.provider);
    if (ACTIVE_JOBS.has(connection.job?.status)) throw error("Синхронизация уже выполняется.", 409, "sync_running");
    if (connection.connectionStatus === "needs_authorization") throw error("Подключите аккаунт повторно.", 409, "authorization_required");
    const controller = new AbortController();
    const jobId = crypto.randomUUID();
    connection.job = { id: jobId, status: "queued", createdAt: stamp(), startedAt: null, finishedAt: null, pages: 0, posts: 0, error: null };
    const task = { controller, jobId, promise: null };
    inFlight.set(id, task);
    try { await persist(); } catch { inFlight.delete(id); connection.job = null; throw error("Не удалось сохранить задание синхронизации.", 500, "storage_unavailable"); }
    const snapshot = publicConnection(connection);
    task.promise = execute(id, jobId, controller);
    // All asynchronous failures are represented in the job; do not log provider errors or tokens.
    task.promise.catch(() => {});
    return snapshot;
  }

  async function disconnect(id) {
    await ready();
    if (typeof id !== "string" || !Object.hasOwn(state.connections, id)) throw error("Подключение не найдено.", 404, "connection_not_found");
    const connection = state.connections[id];
    const generationKey = `${connection.provider}:${connection.accountId}`;
    state.generations[generationKey] = (state.generations[generationKey] || 0) + 1;
    for (const [key, pending] of Object.entries(state.pending)) {
      if (pending.provider === connection.provider && pending.accountId === connection.accountId) delete state.pending[key];
    }
    inFlight.get(id)?.controller.abort();
    delete state.connections[id];
    await persist();
    return { ok: true };
  }

  async function waitForIdle() {
    await ready();
    await Promise.allSettled([...inFlight.values()].map((task) => task.promise).filter(Boolean));
    await writes;
  }

  async function shutdown() {
    closing = true;
    if (!initializing) return;
    await ready();
    for (const task of inFlight.values()) task.controller.abort();
    await waitForIdle();
  }

  return { status, list: status, beginAuthorization, completeAuthorization, connectConfigured, sync, disconnect, shutdown, waitForIdle };
}

module.exports = { createSocialConnectionService };
