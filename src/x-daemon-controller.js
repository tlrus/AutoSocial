const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const cron = require("node-cron");
const { config } = require("./config");
const { postNextFromQueue } = require("./x-post-service");

function nowIso() {
  return new Date().toISOString();
}

function normalizeDailyTimes(times) {
  const source = Array.isArray(times) ? times : [];
  const normalized = source
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => {
      const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
      if (!match) {
        throw new Error(`Invalid time "${value}". Use HH:MM (24h).`);
      }
      return `${match[1].padStart(2, "0")}:${match[2]}`;
    });

  const uniqueSorted = Array.from(new Set(normalized)).sort((a, b) =>
    a.localeCompare(b)
  );
  if (!uniqueSorted.length) {
    throw new Error("Please provide at least one valid time.");
  }
  return uniqueSorted;
}

function getLocalTimeKey(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(date);
}

class XDaemonController {
  constructor(options = {}) {
    this.accountId = options.accountId || "default";
    this.queueDir = options.queueDir || config.xQueueDir;
    this.postedDir = options.postedDir || config.xPostedDir;
    this.failedDir = options.failedDir || config.xFailedDir;

    this.task = null;
    this.isPosting = false;
    this.lastRunAt = null;
    this.lastResult = null;
    this.logs = [];
    this.cronExpression = config.xCronExpression;
    this.schedulePlan = { type: "cron", expression: this.cronExpression };
    this.lastScheduleTriggerKey = null;
    this.instantPost = false;
    this._queueWatcher = null;
    this._watchDebounce = null;
    this._scheduledTimers = new Set();
    this.statePath = options.statePath || path.resolve(config.projectRoot, "x-scheduler-state.json");
    this._loadState();
  }

  _loadState() {
    try {
      const data = fsSync.readFileSync(this.statePath, "utf-8");
      const state = JSON.parse(data);
      if (state.schedulePlan && state.schedulePlan.type === "daily-times") {
        this.schedulePlan = {
          type: "daily-times",
          times: normalizeDailyTimes(state.schedulePlan.times),
        };
      } else if (state.schedulePlan && state.schedulePlan.type === "cron") {
        this.cronExpression = state.schedulePlan.expression || this.cronExpression;
        this.schedulePlan = { type: "cron", expression: this.cronExpression };
      } else if (state.cronExpression) {
        this.cronExpression = state.cronExpression;
        this.schedulePlan = { type: "cron", expression: this.cronExpression };
      }
      if (typeof state.instantPost === "boolean") {
        this.instantPost = state.instantPost;
        if (this.instantPost && config.startBackground) {
          this._startWatching();
        }
      }
    } catch {
      // Ignore missing file or parse error
    }
  }

  async _saveState() {
    try {
      await fs.writeFile(
        this.statePath,
        JSON.stringify(
          {
            cronExpression: this.cronExpression,
            schedulePlan: this.schedulePlan,
            instantPost: this.instantPost,
          },
          null,
          2
        )
      );
    } catch (error) {
      this.log(`Failed to save scheduler state: ${error.message}`, "error");
    }
  }

  async setSchedule(expression) {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: ${expression}`);
    }
    this.cronExpression = expression;
    this.schedulePlan = { type: "cron", expression };
    await this._saveState();
    this.log(`Schedule updated to: ${expression}`);
    if (this.task) {
      this.stop();
      this.start();
    }
  }

  async setDailyTimes(times) {
    const validTimes = normalizeDailyTimes(times);
    this.schedulePlan = { type: "daily-times", times: validTimes };
    await this._saveState();
    this.log(`Daily schedule set to: ${validTimes.join(", ")} (${config.timezone})`);
    if (this.task) {
      this.stop();
      this.start();
    }
  }

  async setInstantPost(enabled) {
    this.instantPost = Boolean(enabled);
    await this._saveState();
    if (this.instantPost) {
      this.log("Instant post enabled. Watching X queue for new videos.");
      this._startWatching();
      if (!this.isPosting) {
        this.runOnce("instant-post-enabled");
      }
    } else {
      this.log("Instant post disabled.");
      this._stopWatching();
    }
  }

  _startWatching() {
    if (this._queueWatcher) return;
    try {
      this._queueWatcher = fsSync.watch(this.queueDir, (eventType, filename) => {
        if (!filename) return;
        const ext = path.extname(filename).toLowerCase();
        if ([".mp4", ".mov", ".webm", ".avi", ".mkv"].includes(ext)) {
          if (this._watchDebounce) clearTimeout(this._watchDebounce);
          this._watchDebounce = setTimeout(() => {
            if (this.instantPost && !this.isPosting) {
              this.log(`New video detected in queue: ${filename}. Posting now.`);
              this.runOnce("instant-post-trigger");
            }
          }, 2000);
        }
      });
    } catch (err) {
      this.log(`Failed to watch queue folder: ${err.message}`, "warn");
    }
  }

  _stopWatching() {
    if (this._watchDebounce) {
      clearTimeout(this._watchDebounce);
      this._watchDebounce = null;
    }
    if (this._queueWatcher) {
      this._queueWatcher.close();
      this._queueWatcher = null;
    }
  }

  log(message, level = "info") {
    const entry = {
      timestamp: nowIso(),
      message,
      level,
    };
    this.logs.push(entry);
    if (this.logs.length > 200) {
      this.logs.shift();
    }
    const prefix = `[${entry.timestamp}] [X]`;
    if (level === "error") {
      console.error(`${prefix} ${message}`);
    } else if (level === "warn") {
      console.warn(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  start() {
    if (this.task) {
      this.log("Scheduler is already running.");
      return;
    }

    if (this.schedulePlan.type === "daily-times") {
      this.task = cron.schedule(
        "* * * * *",
        () => {
          this._handleDailyTimesTick();
        },
        { timezone: config.timezone }
      );
      this.log(
        `X scheduler started with daily times: ${this.schedulePlan.times.join(", ")} (${config.timezone})`
      );
      return;
    }

    this.task = cron.schedule(
      this.cronExpression,
      () => {
        this.runOnce("cron");
      },
      { timezone: config.timezone }
    );
    this.log(`X scheduler started with cron: ${this.cronExpression} (${config.timezone})`);
  }

  _handleDailyTimesTick() {
    const now = new Date();
    const currentKey = getLocalTimeKey(now, config.timezone);
    if (this.schedulePlan.times.includes(currentKey)) {
      if (this.lastScheduleTriggerKey === currentKey) return;
      this.lastScheduleTriggerKey = currentKey;
      this.log(`Triggering daily scheduled post at ${currentKey}`);
      this.runOnce("daily-times");
    } else {
      this.lastScheduleTriggerKey = null;
    }
  }

  stop() {
    if (!this.task) {
      this.log("Scheduler is not running.");
      return;
    }
    this.task.stop();
    this.task = null;
    this.log("X scheduler stopped.");
  }

  async runOnce(trigger = "manual") {
    if (this.isPosting) {
      this.log(`Skipping post trigger (${trigger}) because a post is already in progress.`, "warn");
      return { skipped: true, reason: "Already posting" };
    }

    this.isPosting = true;
    this.lastRunAt = nowIso();
    this.log(`Starting X post flow (trigger: ${trigger})...`);

    try {
      const result = await postNextFromQueue({
        queueDir: this.queueDir,
        postedDir: this.postedDir,
        failedDir: this.failedDir,
        accountId: this.accountId,
      });
      this.lastResult = result;
      if (result.ok) {
        this.log(`Video posted successfully to X: ${result.movedVideo}`);
      } else if (result.skipped) {
        this.log(`Post skipped: ${result.reason}`);
      } else {
        this.log(`Post failed: ${result.error}`, "error");
      }
      return result;
    } catch (error) {
      const result = { ok: false, error: error.message };
      this.lastResult = result;
      this.log(`Unexpected error: ${error.message}`, "error");
      return result;
    } finally {
      this.isPosting = false;
    }
  }

  async getQueueState() {
    const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
    const pendingEntries = await fs.readdir(this.queueDir, { withFileTypes: true }).catch(() => []);
    const postedEntries = await fs.readdir(this.postedDir, { withFileTypes: true }).catch(() => []);
    const failedEntries = await fs.readdir(this.failedDir, { withFileTypes: true }).catch(() => []);

    const isVideo = (entry) => entry.isFile() && VIDEO_EXTS.has(path.extname(entry.name).toLowerCase());

    const pendingVideos = pendingEntries
      .filter(isVideo)
      .map((entry) => {
        const ext = path.extname(entry.name);
        const base = entry.name.slice(0, -ext.length);
        const hasCaption = pendingEntries.some(e => e.isFile() && (e.name === `${base}.description` || e.name === `${base}.txt`));
        return { name: entry.name, hasCaption };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      counts: {
        pending: pendingVideos.length,
        posted: postedEntries.filter(isVideo).length,
        failed: failedEntries.filter(isVideo).length,
      },
      pendingVideos,
    };
  }

  async getStatus() {
    const queue = await this.getQueueState();
    return {
      running: Boolean(this.task),
      isPosting: this.isPosting,
      cronExpression: this.cronExpression,
      schedulePlan: this.schedulePlan,
      instantPost: this.instantPost,
      randomQueueOrder: config.randomQueueOrder,
      timezone: config.timezone,
      accountId: this.accountId,
      queue,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      logs: this.logs.slice(-50),
    };
  }
}

module.exports = {
  XDaemonController,
  normalizeDailyTimes,
  getLocalTimeKey,
};
