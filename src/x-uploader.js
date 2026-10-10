const path = require("path");
const fs = require("fs/promises");
const { chromium } = require("playwright");
const { config } = require("./config");
const {
  getActiveAccount,
  getPlatformProfileDir,
  hasSavedPlatformSession,
} = require("./account-manager");

const REALISTIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let loginSessionContext = null;
let loginSessionAccountId = null;

async function openPersistentContext(accountId, { isLogin = false } = {}) {
  const profileDir = await getPlatformProfileDir("x", accountId);
  await fs.mkdir(profileDir, { recursive: true });
  const launchOptions = {
    headless: isLogin ? false : config.headless,
    channel: "chrome",
    viewport: isLogin ? null : { width: 1400, height: 1000 },
    userAgent: REALISTIC_USER_AGENT,
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };

  try {
    return await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (err) {
    delete launchOptions.channel;
    return await chromium.launchPersistentContext(profileDir, launchOptions);
  }
}

async function navigateWithRetry(page, url, { maxRetries = 3, waitUntil = "domcontentloaded" } = {}) {
  const backoffMs = [5000, 15000, 30000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil, timeout: 60000 });
      await page.waitForTimeout(1500 + Math.random() * 2000);
      return response;
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      const delay = backoffMs[attempt] || 30000;
      console.log(`X navigation failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. Retrying in ${delay / 1000}s...`);
      await page.waitForTimeout(delay);
    }
  }
}

async function startLoginSession() {
  const activeAccount = await getActiveAccount();
  if (loginSessionContext) {
    const previous = loginSessionContext;
    loginSessionContext = null;
    loginSessionAccountId = null;
    await previous.close().catch(() => {});
  }

  const context = await openPersistentContext(activeAccount.id, { isLogin: true });
  const page = context.pages()[0] || (await context.newPage());
  loginSessionContext = context;
  loginSessionAccountId = activeAccount.id;
  context.on("close", () => {
    if (loginSessionContext === context) {
      loginSessionContext = null;
      loginSessionAccountId = null;
    }
  });

  const loginUrl = "https://x.com/i/flow/login";
  page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((err) => {
    console.warn(`[X] Login navigation notice: ${err.message}`);
  });
  await page.bringToFront().catch(() => {});
  return { ok: true, alreadyOpen: false, url: loginUrl };
}

async function getLoginSessionStatus() {
  const activeAccount = await getActiveAccount();
  const isOpen = Boolean(loginSessionContext) && loginSessionAccountId === activeAccount.id;
  let saved = false;

  if (isOpen) {
    try {
      const cookies = await loginSessionContext.cookies();
      saved = cookies.some(
        (c) =>
          (c.domain?.includes("x.com") || c.domain?.includes("twitter.com")) &&
          (c.name === "auth_token" || c.name === "twid")
      );
    } catch {}
  }

  if (!saved) {
    saved = await hasSavedPlatformSession("x", activeAccount.id);
  }

  return {
    open: isOpen,
    saved,
  };
}

async function closeLoginSession() {
  if (!loginSessionContext) {
    return { ok: true, alreadyClosed: true };
  }
  const current = loginSessionContext;
  loginSessionContext = null;
  loginSessionAccountId = null;
  await current.close();
  return { ok: true, closed: true };
}

async function uploadMedia({ mediaPath, videoPath, photoPath, caption, accountId } = {}) {
  const targetAccountId = accountId || (await getActiveAccount()).id;
  let context = null;

  try {
    context = await openPersistentContext(targetAccountId);
    const page = context.pages()[0] || (await context.newPage());

    await navigateWithRetry(page, config.xUploadPageUrl);

    // Look for file input
    const fileInputSelector = 'input[data-testid="fileInput"], input[type="file"]';
    await page.waitForSelector(fileInputSelector, { timeout: 30000 });
    const fileInput = await page.$(fileInputSelector);
    if (!fileInput) {
      throw new Error("Could not find X media upload file input.");
    }

    await fileInput.setInputFiles(path.resolve(mediaPath || photoPath || videoPath));
    console.log("[X] Media file attached, waiting for upload/preview processing...");
    await page.waitForTimeout(6000);

    // Enter caption/tweet text if provided
    if (caption) {
      const textSelector = 'div[data-testid="tweetTextarea_0"], div[role="textbox"]';
      try {
        const textBox = await page.waitForSelector(textSelector, { timeout: 10000 });
        if (textBox) {
          await textBox.click();
          await page.keyboard.type(caption, { delay: 30 });
          await page.waitForTimeout(1000);
        }
      } catch (err) {
        console.warn(`[X] Could not type caption: ${err.message}`);
      }
    }

    // Click Tweet / Post button
    const postBtnSelector = 'button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]';
    const postBtn = await page.waitForSelector(postBtnSelector, { timeout: 15000 });
    if (!postBtn) {
      throw new Error("Could not find X Post button.");
    }

    await postBtn.click();
    console.log("[X] Post button clicked. Holding for completion...");
    await page.waitForTimeout(config.postPublishHoldMs || 15000);

    return { ok: true };
  } catch (error) {
    let screenshotPath = null;
    try {
      if (context) {
        const page = context.pages()[0];
        if (page) {
          screenshotPath = path.resolve(config.projectRoot, "last-x-upload-error.png");
          await page.screenshot({ path: screenshotPath });
        }
      }
    } catch {
      // screenshot error ignored
    }
    return {
      ok: false,
      error: error.message,
      screenshotPath,
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

module.exports = {
  startLoginSession,
  getLoginSessionStatus,
  closeLoginSession,
  uploadVideo: uploadMedia,
  uploadPhoto: uploadMedia,
};
