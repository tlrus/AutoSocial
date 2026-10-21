const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

const PLATFORM_LABELS = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", telegram: "Telegram", x: "X" };
const PLATFORMS = Object.keys(PLATFORM_LABELS);
const QUEUE_STATUSES = ["pending", "posted", "failed"];
const STATUSES = new Set([...QUEUE_STATUSES, "scheduled", "published", "publishing", "partial", "unknown"]);
const QUEUE_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
const VIDEO_EXTENSIONS = new Set([...QUEUE_VIDEO_EXTENSIONS, ".m4v", ".mpeg", ".mpg", ".3gp", ".ts", ".mts"]);
const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".jfif", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif"]);

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function within(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function validAccountId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && value.length <= 100;
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function date(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function filename(value) {
  return text(value).split(/[\\/]/).pop() || "";
}

function counts() {
  return { pending: 0, posted: 0, failed: 0, scheduled: 0, publishing: 0, partial: 0, unknown: 0, total: 0 };
}

function countPost(target, post) {
  target.total += 1;
  const status = post.status === "published" ? "posted" : post.status;
  if (Object.hasOwn(target, status)) target[status] += 1;
}

function normalizeFilters(filters) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw failure("Некорректные фильтры.");
  const result = {};
  for (const key of Object.keys(filters)) {
    if (!["accountId", "platform", "status", "source", "search"].includes(key)) throw failure("Неизвестный фильтр.");
    const value = filters[key];
    if (typeof value !== "string") throw failure("Значение фильтра должно быть строкой.");
    if (value.length > (key === "search" ? 500 : 100)) throw failure("Значение фильтра слишком длинное.");
    if (value) result[key] = value;
  }
  if (result.accountId && !validAccountId(result.accountId)) throw failure("Некорректный аккаунт.");
  if (result.platform && !PLATFORMS.includes(result.platform)) throw failure("Неизвестная социальная сеть.");
  if (result.status && !STATUSES.has(result.status)) throw failure("Неизвестный статус.");
  if (result.source && !["calendar", "queue"].includes(result.source)) throw failure("Неизвестный источник.");
  return result;
}

function matches(post, filters) {
  if (filters.accountId && post.accountId !== filters.accountId) return false;
  if (filters.platform && !post.platforms.includes(filters.platform)) return false;
  if (filters.status && post.status !== filters.status) return false;
  if (filters.source && post.source !== filters.source) return false;
  if (filters.search) {
    const haystack = [post.id, post.accountId, post.accountName, post.caption, post.filename, post.status, post.source, ...post.platforms].join(" ").toLocaleLowerCase();
    if (!haystack.includes(filters.search.toLocaleLowerCase())) return false;
  }
  return true;
}

function safeResults(raw) {
  const result = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  for (const platform of PLATFORMS) {
    const entry = raw[platform];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    result[platform] = {
      ok: entry.ok === true,
      at: date(entry.at),
      // Provider errors can contain access tokens or local paths.
      error: entry.error ? "Публикация не выполнена." : null,
    };
  }
  return result;
}

function csvCell(value) {
  let cell = value === null || value === undefined ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/g, '""')}"`;
}

function createAccountDataService(options = {}) {
  const root = path.resolve(options.root || require("./config").config.projectRoot);
  const getAccounts = options.getAccounts || require("./account-manager").getAllAccounts;
  const getSessionStatus = options.getSessionStatus || require("./account-manager").hasSavedPlatformSession;

  async function scan({ accountId = null, checkSessions = true } = {}) {
    let realRoot;
    try { realRoot = await fs.realpath(root); } catch { throw failure("Каталог данных недоступен.", 500); }
    let rawAccounts;
    try { rawAccounts = await getAccounts(); } catch { throw failure("Список аккаунтов недоступен.", 500); }
    if (!Array.isArray(rawAccounts)) throw failure("Список аккаунтов недоступен.", 500);
    const warnings = [];
    const accounts = [];
    const posts = [];
    const mediaPaths = new Map();
    const seenAccounts = new Set();
    const warn = (accountId, source, message) => warnings.push({ accountId, source, message });

    async function safeFile(candidate, scope) {
      if ((await fs.lstat(candidate)).isSymbolicLink()) throw failure("Ссылка на файл недоступна.", 404);
      const real = await fs.realpath(candidate);
      if (!within(realRoot, real) || !within(scope, real)) throw failure("Небезопасное расположение файла.", 404);
      const stat = await fs.stat(real);
      if (!stat.isFile()) throw failure("Файл недоступен.", 404);
      return { path: real, stat };
    }

    async function safeDirectory(candidate, scope) {
      const real = await fs.realpath(candidate);
      if (!within(realRoot, real) || !within(scope, real)) throw failure("Небезопасное расположение каталога.", 404);
      return fs.readdir(real, { withFileTypes: true });
    }

    function addPost(account, post, media) {
      post.mediaUrl = media ? `/api/account-data/media?accountId=${encodeURIComponent(account.id)}&postId=${encodeURIComponent(post.id)}` : null;
      if (media) mediaPaths.set(`${account.id}\0${post.id}`, media.path);
      posts.push(post);
      countPost(account.counts, post);
      for (const platform of account.platforms) {
        if (post.platforms.includes(platform.id)) countPost(platform.counts, post);
      }
    }

    async function readCalendar(account, accountRoot) {
      const calendarDir = path.join(accountRoot, "calendar");
      const videosDir = path.join(calendarDir, "videos");
      let items;
      try {
        const file = await safeFile(path.join(calendarDir, "posts.json"), calendarDir);
        items = JSON.parse(await fs.readFile(file.path, "utf8"));
        if (!Array.isArray(items)) throw new Error("Invalid calendar");
      } catch (error) {
        warn(account.id, "calendar", error.code === "ENOENT" ? "Сохранённый календарь отсутствует." : "Не удалось прочитать календарь.");
        return;
      }
      const seen = new Set();
      for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item) || !/^[A-Za-z0-9_:-]{1,200}$/.test(text(item.id)) || seen.has(item.id)) {
          warn(account.id, "calendar", "Пропущена некорректная запись календаря.");
          continue;
        }
        seen.add(item.id);
        const rawPath = text(item.mediaPath) || text(item.videoPath);
        let media = null;
        const extension = path.extname(rawPath).toLowerCase();
        const mediaType = PHOTO_EXTENSIONS.has(extension) || (!VIDEO_EXTENSIONS.has(extension) && item.mediaType === "photo") ? "photo" : "video";
        if (rawPath && (PHOTO_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension))) {
          try {
            const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
            // Accept a configured root which itself is a symlink, but keep media in this account's calendar.
            media = await safeFile(candidate, videosDir);
          } catch { warn(account.id, "calendar", "Медиа одной из записей недоступно или находится вне календаря аккаунта."); }
        } else {
          warn(account.id, "calendar", "У записи отсутствует поддерживаемый медиафайл.");
        }
        const post = {
          id: `calendar:${item.id}`,
          accountId: account.id,
          accountName: account.name,
          source: "calendar",
          platforms: Array.isArray(item.platforms) ? [...new Set(item.platforms.filter((platform) => PLATFORMS.includes(platform)))] : [],
          status: STATUSES.has(item.status) ? item.status : "unknown",
          caption: text(item.caption),
          filename: filename(item.mediaFilename) || filename(item.videoFilename) || filename(rawPath),
          mediaType,
          sizeBytes: media ? media.stat.size : null,
          createdAt: date(item.createdAt),
          scheduledAt: date(item.scheduledAt),
          publishedAt: date(item.publishedAt),
          modifiedAt: media ? media.stat.mtime.toISOString() : null,
          results: safeResults(item.results),
        };
        addPost(account, post, media);
      }
    }

    async function readQueue(account, accountRoot, platform, status) {
      const queueDir = path.join(accountRoot, platform, status);
      let entries;
      try { entries = await safeDirectory(queueDir, queueDir); } catch (error) {
        warn(account.id, "queue", error.code === "ENOENT" ? `Очередь ${PLATFORM_LABELS[platform]} (${status}) отсутствует.` : `Не удалось прочитать очередь ${PLATFORM_LABELS[platform]} (${status}).`);
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if ((!entry.isFile() && !entry.isSymbolicLink()) || !QUEUE_VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        let media;
        try { media = await safeFile(path.join(queueDir, entry.name), queueDir); } catch {
          warn(account.id, "queue", `Пропущен недоступный медиафайл очереди ${PLATFORM_LABELS[platform]} (${status}).`);
          continue;
        }
        const base = path.basename(entry.name, path.extname(entry.name));
        let caption = "";
        for (const extension of [".description", ".txt"]) {
          try {
            const sidecar = await safeFile(path.join(queueDir, `${base}${extension}`), queueDir);
            caption = (await fs.readFile(sidecar.path, "utf8")).trim();
            break;
          } catch (error) {
            if (error.code !== "ENOENT") warn(account.id, "queue", `Подпись файла очереди ${PLATFORM_LABELS[platform]} (${status}) недоступна.`);
          }
        }
        addPost(account, {
          id: `queue:${platform}:${status}:${createHash("sha256").update(entry.name).digest("hex").slice(0, 24)}`,
          accountId: account.id,
          accountName: account.name,
          source: "queue",
          platforms: [platform],
          status,
          caption,
          filename: entry.name,
          mediaType: "video",
          sizeBytes: media.stat.size,
          createdAt: null,
          scheduledAt: null,
          publishedAt: null,
          modifiedAt: media.stat.mtime.toISOString(),
          results: {},
        }, media);
      }
    }

    for (const raw of rawAccounts) {
      if (accountId && raw?.id !== accountId) continue;
      if (!raw || !validAccountId(raw.id) || typeof raw.name !== "string" || seenAccounts.has(raw.id)) {
        warn(null, "account", "Пропущен некорректный или повторяющийся аккаунт.");
        continue;
      }
      seenAccounts.add(raw.id);
      const account = { id: raw.id, name: raw.name, platforms: [], counts: counts() };
      for (const platform of PLATFORMS) {
        let connected = null;
        if (checkSessions) {
          try { connected = Boolean(await getSessionStatus(platform, account.id)); } catch {
            warn(account.id, "session", `Не удалось определить наличие сохранённого входа в ${PLATFORM_LABELS[platform]}.`);
          }
        }
        account.platforms.push({ id: platform, label: PLATFORM_LABELS[platform], connected, counts: counts() });
      }
      accounts.push(account);
      const accountRoot = path.join(realRoot, "queue", account.id);
      await readCalendar(account, accountRoot);
      for (const platform of PLATFORMS) {
        for (const status of QUEUE_STATUSES) await readQueue(account, accountRoot, platform, status);
      }
    }
    posts.sort((a, b) => (b.publishedAt || b.scheduledAt || b.modifiedAt || b.createdAt || "").localeCompare(a.publishedAt || a.scheduledAt || a.modifiedAt || a.createdAt || "") || a.id.localeCompare(b.id));
    return { accounts, posts, warnings, mediaPaths };
  }

  async function collect(filters = {}) {
    const normalized = normalizeFilters(filters);
    const snapshot = await scan();
    if (normalized.accountId && !snapshot.accounts.some((account) => account.id === normalized.accountId)) throw failure("Аккаунт не найден.", 404);
    const posts = snapshot.posts.filter((post) => matches(post, normalized));
    const totals = counts();
    for (const post of posts) countPost(totals, post);
    const { total, ...statusCounts } = totals;
    return {
      ok: true,
      source: "stored_local",
      collectedAt: new Date().toISOString(),
      accounts: snapshot.accounts,
      posts,
      summary: { accounts: snapshot.accounts.length, posts: total, ...statusCounts },
      warnings: snapshot.warnings,
    };
  }

  async function exportJSON(filters = {}) {
    return JSON.stringify(await collect(filters), null, 2);
  }

  async function exportCSV(filters = {}) {
    const snapshot = await collect(filters);
    const columns = ["id", "accountId", "accountName", "source", "platforms", "status", "caption", "filename", "mediaType", "sizeBytes", "createdAt", "scheduledAt", "publishedAt", "modifiedAt", "mediaUrl", "results"];
    const lines = [columns.map(csvCell).join(",")];
    for (const post of snapshot.posts) {
      lines.push(columns.map((column) => csvCell(column === "platforms" ? post.platforms.join(";") : column === "results" ? JSON.stringify(post.results) : post[column])).join(","));
    }
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  async function resolveMedia(accountId, postId) {
    if (!validAccountId(accountId) || typeof postId !== "string" || !postId || postId.length > 500) throw failure("Некорректный запрос медиа.");
    const snapshot = await scan({ accountId, checkSessions: false });
    const resolved = snapshot.mediaPaths.get(`${accountId}\0${postId}`);
    if (!resolved) throw failure("Медиафайл не найден.", 404);
    return resolved;
  }

  return { collect, exportJSON, exportCSV, resolveMedia };
}

module.exports = { createAccountDataService };
