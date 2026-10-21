const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const { spawn } = require("child_process");
const express = require("express");
const { config } = require("./config");
const { ensureDirectories } = require("./fs-utils");
const { UniquifierController } = require("./uniquifier-controller");
const { AutoDownloadController } = require("./autodownload-controller");
const { ProfileDownloadController } = require("./profile-download-controller");
const { getDaemons, getAllStatus } = require("./daemon-registry");
const { migrateQueueIfNeeded } = require("./migrate-queue");
const { createDashboardRequestGuard } = require("./request-guard");
const { installDashboardAuth, validatePasswordHash } = require("./dashboard-auth");
const { trackController, beginShutdown } = require("./runtime-state");
const { buildSetupHealth, getAllowedSetupFolderPath } = require("./setup-health");
const {
  startDashboardLoginSession: startTikTokLoginSession,
  getLoginSessionStatus: getTikTokLoginSessionStatus,
  closeLoginSession: closeTikTokLoginSession,
} = require("./tiktok-uploader");
const {
  startLoginSession: startInstagramLoginSession,
  getLoginSessionStatus: getInstagramLoginSessionStatus,
  closeLoginSession: closeInstagramLoginSession,
  importSession: importInstagramSession,
} = require("./instagram-uploader");
const {
  startLoginSession: startYouTubeLoginSession,
  getLoginSessionStatus: getYouTubeLoginSessionStatus,
  closeLoginSession: closeYouTubeLoginSession,
} = require("./youtube-uploader");
const {
  startLoginSession: startXLoginSession,
  getLoginSessionStatus: getXLoginSessionStatus,
  closeLoginSession: closeXLoginSession,
} = require("./x-uploader");
const {
  getState,
  addAccount,
  selectAccount,
  getActiveAccount,
  getAllAccounts,
  ensureAccountDirs,
} = require("./account-manager");
const multer = require("multer");
const {
  createPost,
  createPostsBatch,
  getPosts,
  deletePost,
  publishPostNow,
} = require("./calendar-service");
const { startCalendarScheduler, stopCalendarScheduler } = require("./calendar-scheduler");
const { CanvasController } = require("./canvas-controller");
const { AgentRunner } = require("./agent-runner");
const { createAccountDataService } = require("./account-data-service");
const { createSocialConnectionService } = require("./social-connection-service");
const { installPublicAppRoutes, installSocialConnectionRoutes } = require("./social-connection-routes");

function uploadFilename(file) {
  const name = file.originalname;
  if (/[^\u0000-\u00ff]/.test(name)) return name;
  const utf8 = Buffer.from(name, "latin1").toString("utf8");
  return utf8.includes("\ufffd") ? name : utf8;
}

function openFolder(folderPath) {
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    if (platform === "win32") {
      const child = spawn("explorer", [folderPath], { detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.unref();
      resolve();
      return;
    }
    if (platform === "darwin") {
      const child = spawn("open", [folderPath], { detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.unref();
      resolve();
      return;
    }
    const child = spawn("xdg-open", [folderPath], { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

/**
 * Helper: resolve the active account and get its daemons from the registry.
 */
async function getActiveDaemons() {
  const active = await getActiveAccount();
  return getDaemons(active.id);
}

const SETTINGS_ENV_KEYS = new Set([
  "AUTO_ADD_SOUND",
  "DEFAULT_CAPTION",
  "DEFAULT_SOUND_QUERY",
  "RANDOM_QUEUE_ORDER",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
]);

function serializeEnvValue(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@,-]+$/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function applyRuntimeSetting(envKey, value) {
  if (envKey === "AUTO_ADD_SOUND") {
    config.autoAddSound = String(value).toLowerCase() === "true";
  } else if (envKey === "DEFAULT_CAPTION") {
    config.defaultCaption = String(value ?? "");
  } else if (envKey === "DEFAULT_SOUND_QUERY") {
    config.defaultSoundQuery = String(value ?? "");
  } else if (envKey === "RANDOM_QUEUE_ORDER") {
    config.randomQueueOrder = String(value).toLowerCase() === "true";
  } else if (envKey === "TELEGRAM_BOT_TOKEN") {
    config.telegramBotToken = String(value ?? "");
    process.env.TELEGRAM_BOT_TOKEN = config.telegramBotToken;
  } else if (envKey === "TELEGRAM_CHAT_ID") {
    config.telegramChatId = String(value ?? "");
    process.env.TELEGRAM_CHAT_ID = config.telegramChatId;
  }
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function ensureDashboardBindAllowed() {
  if (!isLoopbackHost(config.dashboardHost) && !validatePasswordHash(config.dashboardPasswordHash)) {
    throw new Error("Remote dashboard requires a password. Run npm run setup:password before exposing it.");
  }
  if (config.dashboardAllowRemote || isLoopbackHost(config.dashboardHost)) {
    return;
  }

  throw new Error(
    `Refusing to bind dashboard to "${config.dashboardHost}". ` +
    "Use DASHBOARD_HOST=127.0.0.1 or set DASHBOARD_ALLOW_REMOTE=true if you understand the risk."
  );
}

async function createServer({ listen = true, startBackground = config.startBackground } = {}) {
  ensureDashboardBindAllowed();
  await fs.mkdir(config.projectRoot, { recursive: true });
  // Run migration from old flat queue layout to per-profile structure
  await migrateQueueIfNeeded();

  // Ensure dirs for all existing accounts
  const allAccounts = await getAllAccounts();
  for (const acct of allAccounts) {
    await ensureAccountDirs(acct.id);
  }

  // Ensure uniquifier dirs
  await ensureDirectories([
    config.uniquifyInputDir,
    config.uniquifyOutputDir,
  ]);

  // Pre-initialize daemons for all existing accounts
  for (const acct of allAccounts) {
    await getDaemons(acct.id);
  }

  const app = express();
  app.disable("x-powered-by");
  if (config.dashboardTrustProxy) app.set("trust proxy", 1);
  const uniquifier = new UniquifierController();
  const autoDownloader = trackController(new AutoDownloadController(), "autodownload");
  const profileDownloader = new ProfileDownloadController();
  const canvasController = new CanvasController(config.projectRoot);
  const agentRunner = new AgentRunner(config.projectRoot);
  const socialConnections = createSocialConnectionService();

  const tmpUploadDir = path.resolve(config.projectRoot, "uploads", "tmp");
  await fs.mkdir(tmpUploadDir, { recursive: true });
  const upload = multer({
    dest: tmpUploadDir,
    limits: { fileSize: 1000 * 1024 * 1024 },
  });

  app.use(createDashboardRequestGuard({ publicUrl: config.dashboardPublicUrl }));
  installPublicAppRoutes(app, { service: socialConnections });
  installDashboardAuth(app, { passwordHash: config.dashboardPasswordHash });
  app.use(express.json({ limit: "50mb" }));
  installSocialConnectionRoutes(app, { service: socialConnections, getActiveAccount });
  app.use(express.static(path.join(__dirname, "..", "web")));
  app.use("/user-assets", express.static(path.join(config.projectRoot, "user-assets")));

  // TikTok endpoints (profile-aware)

  app.get("/api/status", async (req, res) => {
    const daemons = await getActiveDaemons();
    const status = await daemons.tiktok.getStatus();
    res.json(status);
  });

  app.post("/api/start", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.tiktok.start();
    res.json(result);
  });

  app.post("/api/stop", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.tiktok.stop();
    res.json(result);
  });

  app.post("/api/run-once", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = await daemons.tiktok.runOnce("dashboard");
    res.json(result);
  });

  app.post("/api/schedule", async (req, res) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        return res.status(400).json({ ok: false, error: "Missing expression" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.tiktok.setSchedule(expression);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/instant-post", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ ok: false, error: "Missing 'enabled' (boolean)" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.tiktok.setInstantPost(enabled);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/schedule-plan", async (req, res) => {
    try {
      const { type, times } = req.body || {};
      if (type !== "daily-times") {
        return res.status(400).json({ ok: false, error: "Unsupported schedule plan type." });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.tiktok.setDailyTimes(times);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Settings

  app.post("/api/settings/save", async (req, res) => {
    try {
      const { payload } = req.body || {};
      if (!payload || typeof payload !== "object") {
        return res.status(400).json({ ok: false, error: "Invalid payload." });
      }

      const envPath = config.envFile;
      let envContent = "";
      try {
        envContent = await fs.readFile(envPath, "utf-8");
      } catch (err) {
        // file might not exist
      }

      const lines = envContent.split("\n");
      for (const [key, value] of Object.entries(payload)) {
        const envKey = key.toUpperCase();
        if (!SETTINGS_ENV_KEYS.has(envKey)) {
          return res.status(400).json({ ok: false, error: `Unsupported setting: ${envKey}` });
        }

        const serializedValue = serializeEnvValue(value);
        let found = false;

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().startsWith(`${envKey}=`)) {
            lines[i] = `${envKey}=${serializedValue}`;
            found = true;
            break;
          }
        }

        if (!found) {
          lines.push(`${envKey}=${serializedValue}`);
        }

        applyRuntimeSetting(envKey, value);
      }

      await fs.writeFile(envPath, lines.join("\n").replace(/\n{2,}/g, "\n"), { mode: 0o600 });
      await fs.chmod(envPath, 0o600);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Account endpoints

  app.get("/api/accounts", async (req, res) => {
    const state = await getState();
    const active = await getActiveAccount();
    res.json({ ...state, activeAccount: active });
  });

  // Read-only archive of saved posts across brands; never changes selection.
  const accountData = createAccountDataService();
  const accountDataError = (res, error) => {
    const status = [400, 404].includes(error.status) ? error.status : 500;
    res.status(status).json({ ok: false, error: status === 500 ? "Данные аккаунтов недоступны." : error.message });
  };
  app.get("/api/account-data", async (req, res) => {
    try { res.json(await accountData.collect(req.query)); }
    catch (error) { accountDataError(res, error); }
  });
  app.get("/api/account-data/export", async (req, res) => {
    try {
      const { format = "json", ...filters } = req.query;
      if (!["json", "csv"].includes(format)) return res.status(400).json({ ok: false, error: "Unsupported export format." });
      const contents = format === "csv" ? await accountData.exportCSV(filters) : await accountData.exportJSON(filters);
      res.attachment(`autosocial-account-data.${format}`).type(format === "csv" ? "text/csv" : "application/json").send(contents);
    } catch (error) { accountDataError(res, error); }
  });
  app.get("/api/account-data/media", async (req, res) => {
    try {
      const mediaPath = await accountData.resolveMedia(req.query.accountId, req.query.postId);
      res.sendFile(mediaPath, { dotfiles: "deny" }, (error) => {
        if (error && !res.headersSent) res.status(404).json({ ok: false, error: "Media not found." });
      });
    } catch (error) { accountDataError(res, error); }
  });

  app.post("/api/accounts/add", async (req, res) => {
    try {
      const account = await addAccount(req.body?.name);
      // Pre-initialize daemons for the new account
      await getDaemons(account.id);
      const state = await getState();
      res.json({ ok: true, account, state });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts/select", async (req, res) => {
    try {
      const account = await selectAccount(req.body?.accountId);
      const state = await getState();
      res.json({ ok: true, account, state });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Login endpoints (TikTok)

  app.post("/api/tiktok/login", async (req, res) => {
    try {
      const result = await startTikTokLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/tiktok/login/status", async (req, res) => {
    res.json(await getTikTokLoginSessionStatus());
  });

  app.post("/api/tiktok/login/close", async (req, res) => {
    try {
      const result = await closeTikTokLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Instagram endpoints (profile-aware)

  app.get("/api/instagram/status", async (req, res) => {
    const daemons = await getActiveDaemons();
    const status = await daemons.instagram.getStatus();
    res.json(status);
  });

  app.post("/api/instagram/start", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.instagram.start();
    res.json(result);
  });

  app.post("/api/instagram/stop", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.instagram.stop();
    res.json(result);
  });

  app.post("/api/instagram/run-once", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = await daemons.instagram.runOnce("dashboard");
    res.json(result);
  });

  app.post("/api/instagram/schedule", async (req, res) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        return res.status(400).json({ ok: false, error: "Missing expression" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.instagram.setSchedule(expression);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/instagram/schedule-plan", async (req, res) => {
    try {
      const { type, times } = req.body || {};
      if (type !== "daily-times") {
        return res.status(400).json({ ok: false, error: "Unsupported schedule plan type." });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.instagram.setDailyTimes(times);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/instagram/instant-post", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ ok: false, error: "Missing 'enabled' (boolean)" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.instagram.setInstantPost(enabled);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Login endpoints (Instagram)

  app.post("/api/instagram/login", async (req, res) => {
    try {
      const result = await startInstagramLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/instagram/login/status", async (req, res) => {
    res.json(await getInstagramLoginSessionStatus());
  });

  app.post("/api/instagram/session/import", async (req, res) => {
    try {
      const account = await getActiveAccount();
      const result = await importInstagramSession(req.body?.cookies || req.body, account.id);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/instagram/login/close", async (req, res) => {
    try {
      const result = await closeInstagramLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // YouTube endpoints (profile-aware)

  app.get("/api/youtube/status", async (req, res) => {
    const daemons = await getActiveDaemons();
    const status = await daemons.youtube.getStatus();
    res.json(status);
  });

  app.post("/api/youtube/start", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.youtube.start();
    res.json(result);
  });

  app.post("/api/youtube/stop", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.youtube.stop();
    res.json(result);
  });

  app.post("/api/youtube/run-once", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = await daemons.youtube.runOnce("dashboard");
    res.json(result);
  });

  app.post("/api/youtube/schedule", async (req, res) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        return res.status(400).json({ ok: false, error: "Missing expression" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.youtube.setSchedule(expression);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/youtube/schedule-plan", async (req, res) => {
    try {
      const { type, times } = req.body || {};
      if (type !== "daily-times") {
        return res.status(400).json({ ok: false, error: "Unsupported schedule plan type." });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.youtube.setDailyTimes(times);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/youtube/instant-post", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ ok: false, error: "Missing 'enabled' (boolean)" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.youtube.setInstantPost(enabled);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Login endpoints (YouTube)

  app.post("/api/youtube/login", async (req, res) => {
    try {
      const result = await startYouTubeLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/youtube/login/status", async (req, res) => {
    res.json(await getYouTubeLoginSessionStatus());
  });

  app.post("/api/youtube/login/close", async (req, res) => {
    try {
      const result = await closeYouTubeLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Telegram endpoints (profile-aware)

  app.get("/api/telegram/status", async (req, res) => {
    const daemons = await getActiveDaemons();
    const status = await daemons.telegram.getStatus();
    res.json(status);
  });

  app.post("/api/telegram/start", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.telegram.start();
    res.json(result);
  });

  app.post("/api/telegram/stop", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.telegram.stop();
    res.json(result);
  });

  app.post("/api/telegram/run-once", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = await daemons.telegram.runOnce("dashboard");
    res.json(result);
  });

  app.post("/api/telegram/schedule", async (req, res) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        return res.status(400).json({ ok: false, error: "Missing expression" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.telegram.setSchedule(expression);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/telegram/schedule-plan", async (req, res) => {
    try {
      const { type, times } = req.body || {};
      if (type !== "daily-times") {
        return res.status(400).json({ ok: false, error: "Unsupported schedule plan type." });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.telegram.setDailyTimes(times);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/telegram/instant-post", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ ok: false, error: "Missing 'enabled' (boolean)" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.telegram.setInstantPost(enabled);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // X (Twitter) endpoints (profile-aware)

  app.get("/api/x/status", async (req, res) => {
    const daemons = await getActiveDaemons();
    const status = await daemons.x.getStatus();
    res.json(status);
  });

  app.post("/api/x/start", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.x.start();
    res.json(result);
  });

  app.post("/api/x/stop", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.x.stop();
    res.json(result);
  });

  app.post("/api/x/run-once", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = await daemons.x.runOnce("dashboard");
    res.json(result);
  });

  app.post("/api/x/schedule", async (req, res) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        return res.status(400).json({ ok: false, error: "Missing expression" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.x.setSchedule(expression);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/x/schedule-plan", async (req, res) => {
    try {
      const { type, times } = req.body || {};
      if (type !== "daily-times") {
        return res.status(400).json({ ok: false, error: "Unsupported schedule plan type." });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.x.setDailyTimes(times);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/x/instant-post", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ ok: false, error: "Missing 'enabled' (boolean)" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.x.setInstantPost(enabled);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/x/login", async (req, res) => {
    try {
      const result = await startXLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/x/login/status", async (req, res) => {
    res.json(await getXLoginSessionStatus());
  });

  app.post("/api/x/login/close", async (req, res) => {
    try {
      const result = await closeXLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Overview endpoint (aggregates all profiles)

  app.get("/api/overview", async (req, res) => {
    try {
      const allStatus = await getAllStatus();
      res.json(allStatus);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // First-run setup and health endpoints

  app.get("/api/setup/health", async (req, res) => {
    try {
      res.json(await buildSetupHealth());
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/setup/open-folder", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const folderPath = getAllowedSetupFolderPath(req.body?.key, active.id);
      if (!folderPath) {
        return res.status(400).json({ ok: false, error: "Unsupported setup folder key." });
      }

      await fs.mkdir(folderPath, { recursive: true });
      await openFolder(folderPath);
      res.json({ ok: true, path: folderPath });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Uniquifier endpoints

  app.get("/api/uniquifier/status", async (req, res) => {
    const status = await uniquifier.getStatus();
    res.json(status);
  });

  app.post("/api/uniquifier/start", async (req, res) => {
    try {
      const { inputDir, outputDir, logoImage } = req.body || {};
      const result = await uniquifier.start({ inputDir, outputDir, logoImage });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/uniquifier/stop", (req, res) => {
    const result = uniquifier.stop();
    res.json(result);
  });

  app.post("/api/uniquifier/open-folder", async (req, res) => {
    try {
      const { kind, folderPath } = req.body || {};
      const status = await uniquifier.getStatus();
      const targetPath =
        folderPath ||
        (kind === "output" ? status.outputDir : kind === "input" ? status.inputDir : null);
      if (!targetPath) {
        return res.status(400).json({ ok: false, error: "Missing folder path or kind." });
      }
      await openFolder(targetPath);
      res.json({ ok: true, path: targetPath });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Auto-download endpoints
  app.get("/api/autodownload/status", (req, res) => {
    res.json(autoDownloader.getStatus());
  });

  app.post("/api/autodownload/start", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const result = await autoDownloader.start({ accountId: req.body?.accountId || active.id });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/autodownload/stop", (req, res) => {
    const result = autoDownloader.stop();
    res.json(result);
  });

  app.post("/api/autodownload/configure", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const payload = { ...(req.body || {}) };
      if (!payload.accountId) {
        payload.accountId = active.id;
      }
      const result = await autoDownloader.configure(payload);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Profile download endpoints
  app.get("/api/profile-download/status", (req, res) => {
    res.json(profileDownloader.getStatus());
  });

  app.post("/api/profile-download/start", async (req, res) => {
    try {
      const { channel, minViews, maxVideos, scanOnly } = req.body || {};
      const result = await profileDownloader.start({ channel, minViews, maxVideos, scanOnly });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/profile-download/open-folder", async (req, res) => {
    try {
      const status = profileDownloader.getStatus();
      await openFolder(status.downloadsDir);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Calendar endpoints

  app.get("/api/calendar/posts", async (req, res) => {
    try {
      const account = await getActiveAccount();
      const posts = await getPosts(account.id);
      res.json({ ok: true, posts });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/calendar/posts/:id/media", async (req, res) => {
    try {
      const account = await getActiveAccount();
      const post = (await getPosts(account.id)).find((p) => p.id === req.params.id);
      if (!post) return res.status(404).json({ ok: false, error: "Post not found." });
      res.set("Cache-Control", "private, no-store");
      res.sendFile(post.mediaPath || post.videoPath, { dotfiles: "allow" });
    } catch (err) {
      res.status(500).json({ ok: false, error: "Could not open media." });
    }
  });

  app.post("/api/calendar/posts", upload.single("video"), async (req, res) => {
    try {
      const account = await getActiveAccount();
      if (!req.file) {
        return res.status(400).json({ ok: false, error: "Выберите фото или видео." });
      }

      let platforms = [];
      if (typeof req.body.platforms === "string") {
        try {
          platforms = JSON.parse(req.body.platforms);
        } catch {
          platforms = req.body.platforms.split(",").map((s) => s.trim()).filter(Boolean);
        }
      } else if (Array.isArray(req.body.platforms)) {
        platforms = req.body.platforms;
      }

      const post = await createPost({
        accountId: account.id,
        sourceFilePath: req.file.path,
        originalFilename: uploadFilename(req.file),
        mimeType: req.file.mimetype,
        caption: req.body.caption || "",
        platforms,
        scheduledAt: req.body.scheduledAt,
      });

      await fs.unlink(req.file.path).catch(() => {});
      res.json({ ok: true, post });
    } catch (err) {
      if (req.file) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/calendar/posts/batch", upload.array("videos", 30), async (req, res) => {
    try {
      const account = await getActiveAccount();
      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ ok: false, error: "Выберите хотя бы одно фото или видео." });
      }

      let platforms = [];
      if (typeof req.body.platforms === "string") {
        try {
          platforms = JSON.parse(req.body.platforms);
        } catch {
          platforms = req.body.platforms.split(",").map((s) => s.trim()).filter(Boolean);
        }
      } else if (Array.isArray(req.body.platforms)) {
        platforms = req.body.platforms;
      }

      let scheduleTimes = [];
      if (typeof req.body.scheduledTimes === "string") {
        try {
          scheduleTimes = JSON.parse(req.body.scheduledTimes);
        } catch {}
      } else if (Array.isArray(req.body.scheduledTimes)) {
        scheduleTimes = req.body.scheduledTimes;
      }

      const baseCaption = req.body.caption || "";
      const baseScheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : new Date();
      const intervalHours = parseFloat(req.body.intervalHours) || 3;

      const postsData = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        let postTime;
        if (scheduleTimes[i]) {
          postTime = new Date(scheduleTimes[i]).toISOString();
        } else {
          const t = new Date(baseScheduledAt.getTime() + i * intervalHours * 3600 * 1000);
          postTime = t.toISOString();
        }

        postsData.push({
          sourceFilePath: file.path,
          originalFilename: uploadFilename(file),
          mimeType: file.mimetype,
          caption: baseCaption,
          platforms,
          scheduledAt: postTime,
        });
      }

      const createdPosts = await createPostsBatch({
        accountId: account.id,
        postsData,
      });

      for (const file of files) {
        await fs.unlink(file.path).catch(() => {});
      }

      res.json({ ok: true, posts: createdPosts });
    } catch (err) {
      if (req.files) {
        for (const f of req.files) {
          await fs.unlink(f.path).catch(() => {});
        }
      }
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.delete("/api/calendar/posts/:id", async (req, res) => {
    try {
      const account = await getActiveAccount();
      const result = await deletePost(req.params.id, account.id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/calendar/posts/:id/publish-now", async (req, res) => {
    try {
      const account = await getActiveAccount();
      const post = await publishPostNow(req.params.id, account.id);
      res.json({ ok: true, post });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ==================== CONTENT CANVAS ENDPOINTS ====================

  app.get("/api/agents/status", async (req, res) => {
    try {
      const account = await getActiveAccount();
      res.set("Cache-Control", "private, no-store");
      res.json(await agentRunner.status(account.id));
    } catch { res.status(500).json({ ok: false, error: "Не удалось загрузить состояние агентов." }); }
  });

  app.post("/api/agents/runs", async (req, res) => {
    try {
      const account = await getActiveAccount();
      const run = await agentRunner.start(account.id, req.body);
      res.status(202).json({ ok: true, run });
    } catch (error) { res.status(error.status || 400).json({ ok: false, error: error.message }); }
  });

  app.get("/api/agents/runs/:id", async (req, res) => {
    try {
      const account = await getActiveAccount();
      const run = await agentRunner.get(account.id, req.params.id);
      res.set("Cache-Control", "private, no-store");
      if (!run) return res.status(404).json({ ok: false, error: "Запуск не найден для выбранного бренда." });
      res.json({ ok: true, run });
    } catch { res.status(500).json({ ok: false, error: "Не удалось загрузить результат." }); }
  });

  app.post("/api/agents/runs/:id/cancel", async (req, res) => {
    try {
      const account = await getActiveAccount();
      const run = await agentRunner.cancel(account.id, req.params.id);
      res.json({ ok: true, run });
    } catch (error) { res.status(error.status || 400).json({ ok: false, error: error.message }); }
  });

  app.patch("/api/agents/runs/:id", async (req, res) => {
    try {
      const account = await getActiveAccount();
      const run = await agentRunner.saveDraft(account.id, req.params.id, req.body?.postText);
      res.json({ ok: true, run });
    } catch (error) { res.status(error.status || 400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/canvas/generate", async (req, res) => {
    try {
      const result = await canvasController.generateCreative(req.body || {});
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/canvas/chat", async (req, res) => {
    try {
      const result = await canvasController.chatWithAgent(req.body || {});
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/canvas/upload-reference", upload.single("referenceImage"), async (req, res) => {
    try {
      let buffer = null;
      let filename = "";
      if (req.file) {
        buffer = await fs.readFile(req.file.path);
        filename = req.file.originalname;
        await fs.unlink(req.file.path).catch(() => {});
      }
      const dataUrl = req.body?.dataUrl;
      const result = await canvasController.saveReference({ filename, buffer, dataUrl });
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/canvas/references", async (req, res) => {
    try {
      const references = await canvasController.listReferences();
      res.json({ ok: true, references });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/canvas/drafts", async (req, res) => {
    try {
      const result = await canvasController.saveDraft(req.body || {});
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/canvas/drafts", async (req, res) => {
    try {
      const drafts = await canvasController.listDrafts();
      res.json({ ok: true, drafts });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.use((error, req, res, next) => {
    console.error(`[dashboard] ${error.name || "Error"}: ${error.type || "request failed"}`);
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json({ ok: false, error: status === 500 ? "The request failed. Check the server logs." : "Invalid or oversized request." });
  });

  let server;
  if (listen) {
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(config.dashboardPort, config.dashboardHost, () => resolve(instance));
      instance.once("error", reject);
    });
    console.log(`Dashboard running at http://${config.dashboardHost}:${server.address().port}`);
  }
  if (startBackground) {
    startCalendarScheduler(30000);
    for (const account of allAccounts) {
      for (const daemon of Object.values(await getDaemons(account.id))) {
        if (daemon.resumeRequested) daemon.start();
      }
    }
    if (autoDownloader.resumeRequested) {
      await autoDownloader.start({ accountId: autoDownloader.accountId }).catch((error) => console.error(`[autodownload] Could not resume: ${error.message}`));
    }
  }
  async function shutdown() {
    beginShutdown();
    agentRunner.shutdown();
    stopCalendarScheduler();
    autoDownloader.stop();
    uniquifier.stop();
    for (const account of await getAllAccounts()) {
      for (const daemon of Object.values(await getDaemons(account.id))) {
        daemon.stop();
        daemon._stopWatching?.();
      }
    }
    await Promise.allSettled([socialConnections.shutdown(), closeTikTokLoginSession(), closeInstagramLoginSession(), closeYouTubeLoginSession(), closeXLoginSession()]);
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); });
  }
  return { app, server, shutdown };
}

process.on("uncaughtException", (err) => {
  console.error("[AutoSocial Uncaught Exception]:", err?.message || err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[AutoSocial Unhandled Rejection]:", reason?.message || reason);
  process.exit(1);
});

if (require.main === module) {
  createServer().then(({ shutdown }) => {
    let stopping = false;
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      const timeout = setTimeout(() => process.exit(1), 30000);
      timeout.unref();
      shutdown().then(() => process.exit(0), () => process.exit(1));
    });
  }).catch((error) => {
    console.error(`[AutoSocial Server Fatal Error]: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createServer, ensureDashboardBindAllowed };
