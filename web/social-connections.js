(() => {
  const $ = (id) => document.getElementById(id);
  const providerNames = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", telegram: "Telegram", x: "X (Twitter)" };
  const providerIcons = { instagram: "ph-instagram-logo", tiktok: "ph-tiktok-logo", youtube: "ph-youtube-logo", telegram: "ph-paper-plane-tilt", x: "ph-x-logo" };
  const jobLabels = { queued: "В очереди на обновление", running: "Данные загружаются…", completed: "Обновление завершено", partial: "Получена часть доступных данных", failed: "Не удалось обновить", interrupted: "Обновление прервано" };
  const pending = new Set();
  let snapshot = null, loading = false, refreshAgain = false, allBusy = false, failures = 0, page = 1, timer, searchTimer;
  const pageSize = 30;
  const activeJob = (connection) => ["queued", "running"].includes(connection.job?.status);
  const activeView = () => $("view-connections")?.classList.contains("active") && document.visibilityState !== "hidden";
  const number = (value) => Number(value).toLocaleString("ru-RU");
  const title = (connection) => connection.profile?.displayName || connection.profile?.username || providerNames[connection.provider] || "Аккаунт";

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function date(value, empty = "Недоступно") {
    const parsed = value ? new Date(value) : null;
    return !parsed || Number.isNaN(parsed.getTime()) ? empty : parsed.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
  }
  function safeUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return null;
      if ([...url.searchParams.keys()].some((key) => /^(access_token|refresh_token|client_secret|authorization|password)$/i.test(key))) return null;
      return url.href;
    } catch { return null; }
  }
  function link(label, value, className = "social-text-link") {
    const url = safeUrl(value);
    if (!url) return null;
    const result = node("a", className, label);
    result.href = url; result.target = "_blank"; result.rel = "noopener noreferrer"; result.referrerPolicy = "no-referrer";
    return result;
  }
  function metric(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? number(value) : "Недоступно";
  }
  function message(text, error = false) {
    $("socialConnectionsMessage").textContent = text;
    $("socialConnectionsMessage").classList.toggle("is-error", error);
  }
  function provider(id) { return snapshot?.providers.find((item) => item.id === id); }
  function canSync(connection) {
    return connection.connectionStatus !== "needs_authorization" && !activeJob(connection) && provider(connection.provider)?.configured === true;
  }
  async function request(path, { method = "GET", body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), method === "GET" ? 15000 : 25000);
    try {
      const response = await fetch(path, {
        method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error || "Сервис не смог выполнить запрос. Повторите попытку.");
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Сервис отвечает слишком долго. Повторите попытку.");
      if (error instanceof TypeError) throw new Error("Нет связи с сервисом. Проверьте подключение к интернету.");
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function actionButton(label, action, identifier, disabled = false) {
    const button = node("button", "control-btn-small", label);
    button.type = "button"; button.dataset.action = action;
    if (action === "connect") button.dataset.provider = identifier;
    else button.dataset.connectionId = identifier;
    button.disabled = disabled;
    return button;
  }
  function renderProviders() {
    const container = $("socialProviderCards"); container.replaceChildren();
    for (const [id, name] of Object.entries(providerNames)) {
      const configuration = provider(id);
      const available = configuration?.available === true;
      const card = node("article", "social-provider-card"); card.dataset.provider = id;
      const heading = node("div", "social-provider-heading");
      const icon = node("i", "ph " + providerIcons[id]); icon.setAttribute("aria-hidden", "true");
      heading.append(icon, node("h4", "", configuration?.name || name));
      const status = node("span", "social-provider-status", available ? "Можно подключить" : "Нужна настройка");
      status.dataset.available = String(available);
      const count = (snapshot.connections || []).filter((connection) => connection.provider === id).length;
      card.append(heading, status);
      if (count) card.append(node("p", "social-muted", `Подключено аккаунтов: ${number(count)}`));
      if (!available) card.append(node("p", "social-provider-reason", configuration?.reason || "Подключение этой социальной сети пока недоступно."));
      const limitations = Array.isArray(configuration?.limitations) ? configuration.limitations : configuration?.limitations ? [configuration.limitations] : [];
      if (limitations.length) {
        const details = node("details", "social-provider-details"); details.append(node("summary", "", "Что можно получить"));
        for (const limitation of limitations) details.append(node("p", "social-muted", limitation));
        card.append(details);
      }
      const busy = pending.has("connect:" + id);
      card.append(actionButton(busy ? "Подключаем…" : "Подключить", "connect", id, !available || busy));
      if (id === "telegram" && !available) {
        const settings = node("a", "social-text-link", "Настроить Telegram"); settings.href = "#settings"; card.append(settings);
      }
      if (!available) card.append(node("p", "social-provider-owner-note", "Владельцу сервиса нужно завершить настройку этой платформы. После этого вход откроется здесь."));
      container.append(card);
    }
  }
  function appendMetric(container, label, value) {
    const item = node("div", "social-metric");
    item.append(node("dt", "", label), node("dd", typeof value === "number" ? "" : "social-metric-unavailable", metric(value)));
    container.append(item);
  }
  function accountCard(connection) {
    const card = node("article", "social-account-card"); card.dataset.connectionId = connection.id;
    const heading = node("div", "social-account-heading");
    const avatar = node("div", "social-avatar", (providerNames[connection.provider] || "A").slice(0, 1));
    const avatarUrl = safeUrl(connection.profile?.avatarUrl);
    if (avatarUrl) {
      const image = node("img", ""); image.src = avatarUrl; image.alt = ""; image.referrerPolicy = "no-referrer"; image.loading = "lazy";
      image.addEventListener("error", () => image.remove()); avatar.append(image);
    }
    const name = node("div", "social-account-name");
    name.append(node("h4", "", title(connection)), node("p", "social-muted", `${providerNames[connection.provider] || connection.provider}${connection.profile?.username ? " · @" + connection.profile.username.replace(/^@/, "") : ""}`));
    heading.append(avatar, name); card.append(heading);
    const needsAuthorization = connection.connectionStatus === "needs_authorization";
    const state = node("p", "social-account-state", needsAuthorization ? "Нужно подключить аккаунт повторно" : jobLabels[connection.job?.status] || "Доступ к аккаунту подтверждён");
    state.dataset.state = needsAuthorization ? "needs_authorization" : connection.job?.status || "connected";
    card.append(state, node("p", "social-muted social-last-sync", `Обновлено: ${date(connection.lastSyncedAt, "Ещё не выполнялось")}`));
    if (activeJob(connection)) {
      const progress = connection.job.progress || connection.job;
      const details = [];
      if (Number.isInteger(progress.pages)) details.push(`страниц: ${number(progress.pages)}`);
      if (Number.isInteger(progress.posts)) details.push(`постов: ${number(progress.posts)}`);
      if (details.length) card.append(node("p", "social-muted", "Получено " + details.join(" · ")));
    }
    const stats = node("dl", "social-account-metrics");
    const metrics = connection.profile?.metrics || {};
    appendMetric(stats, "Подписчики", metrics.followers ?? metrics.subscribers);
    appendMetric(stats, "Публикации", metrics.posts ?? metrics.videos);
    appendMetric(stats, "Просмотры", metrics.views);
    appendMetric(stats, "Отметки «Нравится»", metrics.likes);
    card.append(stats);
    card.append(node("p", "social-import-count", `В приложении: ${number((connection.posts || []).length)} полученных постов`));
    if (connection.lastSyncedAt && connection.complete !== true) {
      card.append(node("p", "social-coverage-warning", connection.coverageReason === "telegram_pending_updates_only"
        ? "Telegram передаёт только новые доступные боту записи. Полная история канала не загружается."
        : connection.cursor ? "Получена часть постов. Продолжите загрузку, чтобы запросить следующую часть." : "Доступна часть публикаций. Смотрите ограничения платформы."));
    }
    if (connection.job?.error?.message) card.append(node("p", "social-job-error", connection.job.error.message));
    const extra = node("details", "social-account-details");
    extra.append(node("summary", "", "О профиле и доступных данных"));
    if (connection.profile?.bio) extra.append(node("p", "social-profile-bio", connection.profile.bio));
    const metadata = node("dl", "social-profile-metadata");
    metadata.append(node("dt", "", "ID аккаунта"), node("dd", "", connection.profile?.id || "Недоступно"));
    metadata.append(node("dt", "", "Подписки"), node("dd", "", metric(metrics.following)));
    metadata.append(node("dt", "", "Подключён"), node("dd", "", date(connection.connectedAt)));
    extra.append(metadata, node("p", "social-muted", "«Недоступно» означает, что платформа не предоставила показатель. Число публикаций профиля может отличаться от количества полученных постов."));
    const limitations = provider(connection.provider)?.limitations || [];
    for (const text of Array.isArray(limitations) ? limitations : [limitations]) if (text) extra.append(node("p", "social-muted", text));
    for (const text of connection.warnings || []) if (typeof text === "string") extra.append(node("p", "social-coverage-warning", text));
    const profileLink = link("Открыть профиль", connection.profile?.url); if (profileLink) extra.append(profileLink);
    card.append(extra);
    const actions = node("div", "social-account-actions");
    const busy = allBusy || pending.has("sync:" + connection.id) || pending.has("disconnect:" + connection.id);
    if (needsAuthorization) {
      actions.append(actionButton("Подключить повторно", "reconnect", connection.id, busy || provider(connection.provider)?.available !== true || pending.has("connect:" + connection.provider)));
    } else {
      actions.append(actionButton(activeJob(connection) ? "Обновляем…" : connection.cursor && connection.complete !== true ? "Продолжить загрузку" : "Обновить данные", "sync", connection.id, busy || !canSync(connection)));
    }
    const disconnect = actionButton("Отключить", "disconnect", connection.id, busy); disconnect.classList.add("social-disconnect");
    actions.append(disconnect); card.append(actions);
    return card;
  }
  function renderAccounts() {
    const expanded = new Set([...$("socialAccounts").querySelectorAll(".social-account-card")].filter((card) => card.querySelector("details[open]")).map((card) => card.dataset.connectionId));
    $("socialAccounts").replaceChildren();
    for (const connection of snapshot.connections) {
      const card = accountCard(connection);
      if (expanded.has(connection.id)) card.querySelector("details").open = true;
      $("socialAccounts").append(card);
    }
    $("socialAccountsEmpty").classList.toggle("hidden", Boolean(snapshot.connections.length));
    const current = $("socialPostAccount").value;
    $("socialPostAccount").replaceChildren(new Option("Все аккаунты", ""));
    for (const connection of snapshot.connections) $("socialPostAccount").append(new Option(`${title(connection)} · ${providerNames[connection.provider] || connection.provider}`, connection.id));
    if ([...$("socialPostAccount").options].some((option) => option.value === current)) $("socialPostAccount").value = current;
  }
  function postCard({ connection, post }) {
    const card = node("article", "social-post-card"); card.dataset.postKey = connection.id + ":" + post.id;
    const thumbnail = safeUrl(post.thumbnailUrl || (post.mediaType === "photo" ? post.mediaUrl : null));
    if (thumbnail) {
      const image = node("img", "social-post-thumbnail"); image.src = thumbnail; image.alt = "";
      image.loading = "lazy"; image.decoding = "async"; image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove()); card.append(image);
    }
    const body = node("div", "social-post-body");
    const type = { video: "Видео", photo: "Фото", carousel: "Карусель", text: "Текст" }[post.mediaType] || "Публикация";
    body.append(node("p", "social-post-context", `${providerNames[connection.provider] || connection.provider} · ${title(connection)}`));
    body.append(node("h4", "", post.title || (post.caption ? post.caption.slice(0, 100) : type)));
    body.append(node("p", "social-muted", `${type} · ${post.publishedAt ? date(post.publishedAt) : "Дата недоступна"}`));
    if (post.caption) body.append(node("p", "social-post-caption", post.caption));
    const stats = node("dl", "social-post-metrics");
    for (const [key, label] of [["views", "Просмотры"], ["likes", "Нравится"], ["comments", "Комментарии"], ["shares", "Поделились"]]) appendMetric(stats, label, post.metrics?.[key]);
    body.append(stats);
    const details = node("details", "social-post-details"); details.append(node("summary", "", "Подробности публикации"));
    if (post.caption) details.append(node("p", "social-full-caption", post.caption));
    details.append(node("p", "social-muted", "ID публикации: " + post.id));
    const actions = node("div", "social-post-links");
    const permalink = link("Открыть публикацию", post.url); if (permalink) actions.append(permalink);
    const media = link("Открыть медиа", post.mediaUrl); if (media) actions.append(media);
    if (actions.childElementCount) details.append(actions);
    else details.append(node("p", "social-muted", "Платформа не предоставила ссылку на публикацию."));
    body.append(details); card.append(body);
    return card;
  }
  function renderPosts(resetPage = false) {
    if (!snapshot) return;
    if (resetPage) page = 1;
    const account = $("socialPostAccount").value, platform = $("socialPostPlatform").value, search = $("socialPostSearch").value.trim().toLocaleLowerCase();
    const records = snapshot.connections.flatMap((connection) => (connection.posts || []).map((post) => ({ connection, post })));
    const filtered = records.filter(({ connection, post }) => (!account || account === connection.id) && (!platform || platform === connection.provider)
      && (!search || [post.caption, post.title, post.id, title(connection), connection.profile?.username, providerNames[connection.provider]].join(" ").toLocaleLowerCase().includes(search)))
      .sort((a, b) => (Date.parse(b.post.publishedAt) || 0) - (Date.parse(a.post.publishedAt) || 0));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize)); page = Math.min(page, pages);
    const expanded = new Set([...$("socialPosts").querySelectorAll(".social-post-card")].filter((card) => card.querySelector("details[open]")).map((card) => card.dataset.postKey));
    $("socialPosts").replaceChildren();
    for (const record of filtered.slice((page - 1) * pageSize, page * pageSize)) {
      const card = postCard(record);
      if (expanded.has(card.dataset.postKey)) card.querySelector("details").open = true;
      $("socialPosts").append(card);
    }
    $("socialPostsCount").textContent = `Найдено ${number(filtered.length)} из ${number(records.length)} полученных постов`;
    $("socialPostsPagination").classList.toggle("hidden", !filtered.length);
    $("socialPostsPrevious").disabled = page <= 1; $("socialPostsNext").disabled = page >= pages;
    $("socialPostsPage").textContent = `Страница ${number(page)} из ${number(pages)}`;
    $("socialPostsEmpty").classList.toggle("hidden", Boolean(filtered.length));
    $("socialPostsEmptyTitle").textContent = records.length ? "По запросу постов нет" : snapshot.connections.some(activeJob) ? "Публикации загружаются" : "Публикации ещё не получены";
    $("socialPostsEmptyText").textContent = records.length ? "Измените фильтры или поисковый запрос." : !snapshot.connections.length ? "Подключите свой аккаунт выше. Здесь появятся доступные ему публикации из соцсети." : snapshot.connections.some(activeJob) ? "Обновление выполняется. Результат появится здесь автоматически." : "Обновите подключённые аккаунты. Доступность публикаций зависит от разрешений и ограничений платформы.";
    $("socialPostsReset").classList.toggle("hidden", !account && !platform && !search);
    $("socialTotalPosts").textContent = number(records.length);
  }
  function render() {
    if (!snapshot) return;
    const focused = document.activeElement?.dataset;
    const focus = focused?.action ? { action: focused.action, connectionId: focused.connectionId, provider: focused.provider } : null;
    const openProviders = new Set([...$("socialProviderCards").querySelectorAll(".social-provider-card")].filter((card) => card.querySelector("details[open]")).map((card) => card.dataset.provider));
    renderProviders(); renderAccounts(); renderPosts();
    for (const card of $("socialProviderCards").children) if (openProviders.has(card.dataset.provider)) card.querySelector("details")?.setAttribute("open", "");
    if (focus) [...$("view-connections").querySelectorAll("button[data-action]")].find((button) => button.dataset.action === focus.action && button.dataset.connectionId === focus.connectionId && button.dataset.provider === focus.provider)?.focus({ preventScroll: true });
    const hostingMissing = snapshot.hosting?.configured !== true;
    $("socialHostingNotice").classList.toggle("hidden", !hostingMissing);
    $("socialHostingReason").textContent = snapshot.hosting?.reason || "Для постоянного доступа с любого устройства владельцу сервиса нужно подключить постоянный HTTPS-адрес.";
    $("socialTotalAccounts").textContent = number(snapshot.connections.length);
    const synced = snapshot.connections.map((connection) => connection.lastSyncedAt).filter(Boolean).sort();
    $("socialLatestSync").textContent = date(synced.at(-1), "Ещё не выполнялось");
    $("socialCollectedAt").textContent = "Состояние проверено: " + date(snapshot.collectedAt) + " · время вашего устройства";
    $("socialSyncAll").disabled = allBusy || !snapshot.connections.some((connection) => canSync(connection) && !pending.has("sync:" + connection.id));
    $("socialSyncAll").textContent = allBusy ? "Запускаем обновление…" : "Обновить все аккаунты";
    $("socialCoverageNote").classList.toggle("hidden", !snapshot.connections.some((connection) => connection.lastSyncedAt && connection.complete !== true));
  }
  function schedulePoll() {
    clearTimeout(timer);
    if (activeView() && snapshot?.connections.some(activeJob) && failures < 3) timer = setTimeout(() => refresh({ silent: true }), Math.min(12000, 3000 * 2 ** failures));
  }
  async function refresh({ silent = false } = {}) {
    if (loading) { refreshAgain = true; return; }
    clearTimeout(timer); loading = true;
    $("socialConnectionsRefresh").disabled = true;
    $("socialConnectionsRefresh").textContent = "Проверяем…";
    $("socialAccounts").setAttribute("aria-busy", "true");
    if (!silent) message("Проверяем подключения и последнее состояние данных…");
    try {
      const data = await request("/api/social-connections");
      if (!Array.isArray(data.connections) || !Array.isArray(data.providers)) throw new Error("Не удалось получить список подключений. Повторите загрузку.");
      snapshot = data; failures = 0; render();
      if (!silent) message("Состояние обновлено. Чтобы получить свежие посты из соцсетей, нажмите «Обновить данные» у аккаунта.");
    } catch (error) {
      failures += 1;
      message(error.message + (snapshot ? " Показаны последние полученные данные." : " Нажмите «Проверить состояние», чтобы повторить.") + (failures >= 3 ? " Автообновление приостановлено." : ""), true);
    } finally {
      loading = false;
      $("socialConnectionsRefresh").disabled = false;
      $("socialConnectionsRefresh").textContent = "Проверить состояние";
      $("socialAccounts").setAttribute("aria-busy", "false");
      if (refreshAgain && activeView()) { refreshAgain = false; refresh({ silent: true }); }
      else { refreshAgain = false; schedulePoll(); }
    }
  }
  async function connect(providerId, accountId) {
    if (pending.has("connect:" + providerId) || provider(providerId)?.available !== true) return;
    pending.add("connect:" + providerId); render();
    message("Начинаем подключение " + providerNames[providerId] + "…");
    try {
      const selected = accountId || $("brandSelect")?.value;
      const data = await request(`/api/social-connections/${encodeURIComponent(providerId)}/connect`, { method: "POST", body: selected ? { accountId: selected } : {} });
      if (data.authorizationUrl) {
        const url = safeUrl(data.authorizationUrl);
        if (!url) throw new Error("Сервис не предоставил безопасный адрес входа. Повторите подключение.");
        location.assign(url);
        return;
      }
      await refresh({ silent: true });
      message("Аккаунт подключён. Началась загрузка доступных данных.");
    } catch (error) { message(error.message, true); }
    finally { pending.delete("connect:" + providerId); render(); schedulePoll(); }
  }
  async function syncOne(connection) {
    if (!canSync(connection) || pending.has("sync:" + connection.id)) return;
    pending.add("sync:" + connection.id); render();
    try {
      await request(`/api/social-connections/${encodeURIComponent(connection.id)}/sync`, { method: "POST", body: {} });
      await refresh({ silent: true });
      message("Обновление аккаунта запущено. Данные появятся по завершении загрузки.");
    } catch (error) { message(error.message, true); }
    finally { pending.delete("sync:" + connection.id); render(); schedulePoll(); }
  }
  async function syncAll() {
    if (allBusy || !snapshot) return;
    const connections = snapshot.connections.filter((connection) => canSync(connection) && !pending.has("sync:" + connection.id));
    if (!connections.length) return;
    allBusy = true; render();
    message(`Запускаем обновление ${number(connections.length)} аккаунтов…`);
    try {
      const results = await Promise.allSettled(connections.map((connection) => request(`/api/social-connections/${encodeURIComponent(connection.id)}/sync`, { method: "POST", body: {} })));
      const failed = results.filter((result) => result.status === "rejected").length;
      await refresh({ silent: true });
      message(failed ? `Обновление запущено для ${number(connections.length - failed)} из ${number(connections.length)} аккаунтов. Для остальных повторите запрос отдельно.` : "Обновление всех доступных аккаунтов запущено.", Boolean(failed));
    } finally { allBusy = false; render(); schedulePoll(); }
  }
  async function disconnect(connection) {
    if (pending.has("disconnect:" + connection.id) || !window.confirm(`Отключить «${title(connection)}» и удалить его импортированные данные из приложения?`)) return;
    pending.add("disconnect:" + connection.id); render();
    try {
      await request(`/api/social-connections/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
      await refresh({ silent: true }); message("Аккаунт отключён от AutoSocial.");
    } catch (error) { message(error.message, true); }
    finally { pending.delete("disconnect:" + connection.id); render(); schedulePoll(); }
  }
  function init() {
    $("socialConnectionsRefresh").addEventListener("click", () => { failures = 0; refresh(); });
    $("socialSyncAll").addEventListener("click", syncAll);
    $("view-connections").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button || button.disabled) return;
      if (button.dataset.action === "connect") return connect(button.dataset.provider);
      const connection = snapshot?.connections.find((item) => item.id === button.dataset.connectionId);
      if (!connection) return;
      if (button.dataset.action === "sync") syncOne(connection);
      if (button.dataset.action === "disconnect") disconnect(connection);
      if (button.dataset.action === "reconnect") connect(connection.provider, connection.accountId);
    });
    for (const id of ["socialPostAccount", "socialPostPlatform"]) $(id).addEventListener("change", () => renderPosts(true));
    $("socialPostSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => renderPosts(true), 150); });
    $("socialPostsReset").addEventListener("click", () => { for (const id of ["socialPostAccount", "socialPostPlatform", "socialPostSearch"]) $(id).value = ""; renderPosts(true); });
    $("socialPostsPrevious").addEventListener("click", () => { page -= 1; renderPosts(); $("socialPostsSection").scrollIntoView({ block: "start" }); });
    $("socialPostsNext").addEventListener("click", () => { page += 1; renderPosts(); $("socialPostsSection").scrollIntoView({ block: "start" }); });
    document.addEventListener("autosocial:viewchange", (event) => {
      clearTimeout(timer);
      if (event.detail?.viewName === "connections" && activeView()) { failures = 0; refresh({ silent: Boolean(snapshot) }); }
    });
    document.addEventListener("visibilitychange", () => { clearTimeout(timer); if (activeView()) { failures = 0; refresh({ silent: true }); } });
    window.addEventListener("online", () => { if (activeView()) { failures = 0; refresh({ silent: true }); } });
    setTimeout(() => { if (activeView() && !snapshot && !loading) refresh(); }, 0);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
