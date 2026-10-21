(() => {
  const $ = (id) => document.getElementById(id);
  const pageSize = 40;
  const platformLabels = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", telegram: "Telegram", x: "X (Twitter)" };
  const statusLabels = { pending: "В очереди", posted: "Опубликован", published: "Опубликован", failed: "Ошибка", scheduled: "Запланирован", publishing: "Публикуется", partial: "Частично опубликован", unknown: "Статус неизвестен" };
  const sourceLabels = { calendar: "Календарь", queue: "Очередь" };
  let snapshot = null, filtered = [], page = 1, loading = false, refreshedAt = 0, searchTimer;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function number(value) { return Number(value || 0).toLocaleString("ru-RU"); }
  function date(value) {
    if (!value) return "Не указано";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "Не указано" : parsed.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
  }
  function size(value) {
    if (value === null || value === undefined) return "Неизвестен";
    const bytes = Number(value);
    return bytes < 1024 * 1024 ? `${number(Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
  }
  function message(text, error = false) {
    $("accountDataMessage").textContent = text;
    $("accountDataMessage").classList.toggle("is-error", error);
  }
  function filters() {
    return {
      accountId: $("accountDataAccount").value, platform: $("accountDataPlatform").value,
      status: $("accountDataStatus").value, source: $("accountDataSource").value,
      search: $("accountDataSearch").value.trim(),
    };
  }
  function exportLinks() {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters())) if (value) params.set(key, value);
    for (const format of ["json", "csv"]) {
      const link = $(format === "json" ? "accountDataJson" : "accountDataCsv");
      params.set("format", format);
      if (snapshot) link.href = `/api/account-data/export?${params}`;
      else link.removeAttribute("href");
      link.setAttribute("aria-disabled", String(!snapshot || loading));
    }
    $("accountDataExportNote").textContent = snapshot
      ? `Экспорт: все ${number(filtered.length)} найденных постов. JSON также содержит сведения обо всех аккаунтах.`
      : "Экспорт станет доступен после загрузки данных.";
  }
  function countsText(counts = {}) {
    return `${number(counts.total)} записей · ${number(counts.posted)} опубликовано · ${number(Number(counts.pending || 0) + Number(counts.scheduled || 0))} в ожидании · ${number(counts.failed)} с ошибкой`;
  }
  function renderAccounts() {
    const selected = $("accountDataAccount").value;
    $("accountDataAccount").replaceChildren(new Option("Все аккаунты", ""));
    $("accountDataAccountsList").replaceChildren();
    for (const account of snapshot.accounts) {
      $("accountDataAccount").append(new Option(account.name, account.id));
      const card = node("article", "account-data-account");
      card.append(node("h4", "", account.name), node("p", "account-data-muted", `ID аккаунта: ${account.id}`), node("p", "account-data-muted", countsText(account.counts)));
      const list = node("ul", "account-data-connections");
      for (const platform of account.platforms || []) {
        const item = node("li", "");
        const connection = platform.connected === null ? "Не проверено" : platform.connected
          ? platform.id === "telegram" ? "Настроено" : "Сессия сохранена" : "Нет подключения";
        const header = node("div", "account-data-connection-row");
        const status = node("span", "account-data-connection", connection);
        status.dataset.connected = platform.connected === null ? "unknown" : String(platform.connected);
        header.append(node("strong", "", platform.label || platformLabels[platform.id] || platform.id), status);
        item.append(header, node("p", "account-data-muted", countsText(platform.counts)));
        list.append(item);
      }
      card.append(list);
      $("accountDataAccountsList").append(card);
    }
    if ([...$("accountDataAccount").options].some((option) => option.value === selected)) $("accountDataAccount").value = selected;
    $("accountDataAccountsCount").textContent = number(snapshot.accounts.length);
  }
  function renderWarnings() {
    const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
    $("accountDataWarnings").classList.toggle("hidden", !warnings.length);
    $("accountDataWarningsLabel").textContent = `Неполные данные: ${number(warnings.length)} предупреждений`;
    $("accountDataWarningsList").replaceChildren();
    for (const warning of warnings) {
      const account = snapshot.accounts.find((item) => item.id === warning.accountId);
      $("accountDataWarningsList").append(node("li", "", `${account ? account.name + ": " : ""}${warning.message}`));
    }
  }
  function field(list, label, value) {
    list.append(node("dt", "", label), node("dd", "", value));
  }
  function mediaLink(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin || url.pathname !== "/api/account-data/media") return null;
      return url.pathname + url.search;
    } catch { return null; }
  }
  function postCard(post) {
    const card = node("article", "account-data-post");
    const header = node("div", "account-data-post-header");
    const title = node("h4", "", post.filename || (post.caption ? String(post.caption).slice(0, 100) : "Пост без названия"));
    const badge = node("span", "account-data-status", statusLabels[post.status] || statusLabels.unknown);
    badge.dataset.status = post.status;
    header.append(title, badge);
    const platforms = (post.platforms || []).map((id) => platformLabels[id] || id).join(", ") || "Не указана";
    card.append(header, node("p", "account-data-post-context", `${post.accountName} · ${platforms} · ${sourceLabels[post.source] || post.source}`));
    card.append(node("p", "account-data-muted", `Дата: ${date(post.publishedAt || post.scheduledAt || post.modifiedAt || post.createdAt)}`));
    if (post.caption) card.append(node("p", "account-data-caption-preview", post.caption));
    const details = node("details", "account-data-post-details");
    details.append(node("summary", "", "Все данные поста"));
    if (post.caption) {
      details.append(node("h5", "", "Описание"), node("p", "account-data-full-caption", post.caption));
    }
    const metadata = node("dl", "account-data-metadata");
    field(metadata, "ID", post.id);
    field(metadata, "Аккаунт", post.accountName);
    field(metadata, "Платформы", platforms);
    field(metadata, "Источник", sourceLabels[post.source] || post.source);
    field(metadata, "Статус", statusLabels[post.status] || statusLabels.unknown);
    field(metadata, "Файл", post.filename || "Не указан");
    field(metadata, "Тип медиа", post.mediaType === "photo" ? "Фото" : post.mediaType === "video" ? "Видео" : "Не указан");
    field(metadata, "Размер", size(post.sizeBytes));
    field(metadata, "Создан", date(post.createdAt));
    field(metadata, "Запланирован", date(post.scheduledAt));
    field(metadata, "Опубликован", date(post.publishedAt));
    field(metadata, "Изменён", date(post.modifiedAt));
    details.append(metadata);
    if (post.results && Object.keys(post.results).length) {
      details.append(node("h5", "", "Результаты публикации"));
      const results = node("ul", "account-data-result-list");
      for (const [platform, result] of Object.entries(post.results)) {
        if (result && typeof result === "object") {
          results.append(node("li", "", `${platformLabels[platform] || platform}: ${result.ok ? "Успешно" : "Ошибка"}${result.at ? " · " + date(result.at) : ""}${result.error ? " · " + result.error : ""}`));
        } else if (typeof result === "string") results.append(node("li", "", `${platformLabels[platform] || platform}: ${result}`));
      }
      details.append(results);
    }
    const safeMediaUrl = mediaLink(post.mediaUrl);
    if (safeMediaUrl) {
      const link = node("a", "control-btn-small account-data-media", "Открыть медиа");
      link.href = safeMediaUrl; link.target = "_blank"; link.rel = "noopener";
      details.append(link);
    } else details.append(node("p", "account-data-muted", "Медиафайл недоступен."));
    card.append(details);
    return card;
  }
  function renderPosts() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(page, pages);
    const offset = (page - 1) * pageSize;
    const list = $("accountDataPosts");
    list.replaceChildren();
    for (const post of filtered.slice(offset, offset + pageSize)) list.append(postCard(post));
    $("accountDataEmpty").classList.toggle("hidden", Boolean(filtered.length) || !snapshot);
    $("accountDataEmptyTitle").textContent = snapshot?.posts.length ? "По выбранным фильтрам постов нет" : "Сохранённых постов пока нет";
    $("accountDataEmptyText").textContent = snapshot?.posts.length ? "Измените запрос или сбросьте фильтры." : "Добавьте публикацию в календарь или медиафайл в очередь аккаунта.";
    $("accountDataPagination").classList.toggle("hidden", !filtered.length);
    $("accountDataPrevious").disabled = page <= 1;
    $("accountDataNext").disabled = page >= pages;
    $("accountDataPageLabel").textContent = `Страница ${number(page)} из ${number(pages)}`;
    $("accountDataResultCount").textContent = snapshot
      ? `Найдено ${number(filtered.length)} из ${number(snapshot.posts.length)} постов${filtered.length ? ` · Показаны ${number(offset + 1)}–${number(Math.min(offset + pageSize, filtered.length))}` : ""}`
      : "Загрузка постов…";
    exportLinks();
  }
  function applyFilters(resetPage = true) {
    if (resetPage) page = 1;
    const selected = filters();
    const query = selected.search.toLocaleLowerCase();
    filtered = (snapshot?.posts || []).filter((post) => {
      if (selected.accountId && post.accountId !== selected.accountId) return false;
      if (selected.platform && !(post.platforms || []).includes(selected.platform)) return false;
      if (selected.status && post.status !== selected.status) return false;
      if (selected.source && post.source !== selected.source) return false;
      return !query || [post.id, post.accountId, post.accountName, post.caption, post.filename, post.status, post.source, ...(post.platforms || [])].join(" ").toLocaleLowerCase().includes(query);
    });
    $("accountDataReset").classList.toggle("hidden", !Object.values(selected).some(Boolean));
    renderPosts();
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    $("accountDataRefresh").disabled = true;
    $("accountDataRefresh").textContent = "Загружаем…";
    $("accountDataPosts").setAttribute("aria-busy", "true");
    message("Собираем сохранённые данные всех аккаунтов…");
    exportLinks();
    try {
      const response = await fetch("/api/account-data");
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Не удалось загрузить данные.");
      if (!Array.isArray(data.accounts) || !Array.isArray(data.posts)) throw new Error("Сервис вернул неполные данные. Повторите загрузку.");
      snapshot = data;
      refreshedAt = Date.now();
      renderAccounts(); renderWarnings();
      const totals = data.summary || {};
      $("accountDataTotalAccounts").textContent = number(data.accounts.length);
      $("accountDataTotalPosts").textContent = number(data.posts.length);
      $("accountDataTotalPosted").textContent = number(totals.posted);
      $("accountDataTotalPending").textContent = number(Number(totals.pending || 0) + Number(totals.scheduled || 0));
      $("accountDataTotalFailed").textContent = number(totals.failed);
      $("accountDataCollectedAt").textContent = `Собрано: ${date(data.collectedAt)} · время вашего устройства`;
      applyFilters(false);
      message("Данные обновлены.");
    } catch (error) {
      message(`${error.message || "Не удалось загрузить данные."}${snapshot ? " Показаны ранее загруженные данные." : " Нажмите «Обновить», чтобы повторить."}`, true);
      if (!snapshot) $("accountDataResultCount").textContent = "Данные не загружены";
    } finally {
      loading = false;
      $("accountDataRefresh").disabled = false;
      $("accountDataRefresh").textContent = "Обновить";
      $("accountDataPosts").setAttribute("aria-busy", "false");
      exportLinks();
    }
  }
  function init() {
    $("accountDataRefresh").addEventListener("click", refresh);
    for (const id of ["accountDataAccount", "accountDataPlatform", "accountDataStatus", "accountDataSource"]) $(id).addEventListener("change", () => applyFilters());
    $("accountDataSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => applyFilters(), 150); });
    $("accountDataReset").addEventListener("click", () => {
      for (const id of ["accountDataAccount", "accountDataPlatform", "accountDataStatus", "accountDataSource", "accountDataSearch"]) $(id).value = "";
      applyFilters();
    });
    $("accountDataPrevious").addEventListener("click", () => { page -= 1; renderPosts(); $("accountDataResults").scrollIntoView({ block: "start" }); });
    $("accountDataNext").addEventListener("click", () => { page += 1; renderPosts(); $("accountDataResults").scrollIntoView({ block: "start" }); });
    for (const id of ["accountDataJson", "accountDataCsv"]) $(id).addEventListener("click", (event) => { if (!snapshot || loading) event.preventDefault(); });
    document.addEventListener("autosocial:viewchange", (event) => { if (event.detail?.viewName === "account-data" && Date.now() - refreshedAt > 60000) refresh(); });
    if ($("view-account-data").classList.contains("active")) refresh();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
