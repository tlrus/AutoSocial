const path = require("path");
const fs = require("fs/promises");
const { chromium } = require("playwright");
const { config } = require("./config");
const uiLabels = require("./platform-ui-labels");
const { normalizeInstagramCookies, readInstagramSession, saveInstagramSession } = require("./instagram-session");
const {
  getActiveAccount,
  getPlatformProfileDir,
  hasSavedPlatformSession,
} = require("./account-manager");

let loginSessionContext = null;
let loginSessionAccountId = null;
const busyAccounts = new Set();

async function openPersistentContext(accountId, { isLogin = false } = {}) {
  const profileDir = await getPlatformProfileDir("instagram", accountId);
  await fs.mkdir(profileDir, { recursive: true });
  const launchOptions = {
    headless: isLogin ? false : config.headless,
    channel: "chrome",
    viewport: isLogin ? null : { width: 1400, height: 1000 },
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (err) {
    if (!/executable.*(exist|found)|distribution.*(found|installed)/i.test(err.message)) {
      throw new Error("Could not open the Instagram browser profile. Close any browser using this account and try again.");
    }
    delete launchOptions.channel;
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
  }
  const session = await readInstagramSession(profileDir);
  try { if (session) await context.addCookies(session.cookies); }
  catch (error) { await context.close(); throw error; }
  return context;
}

async function verifyInstagramPage(page) {
  await page.goto("https://www.instagram.com/accounts/edit/", { waitUntil: "domcontentloaded", timeout: 45000 });
  try { await page.waitForFunction(() => /\/accounts\/login|\/challenge|\/checkpoint|\/recaptcha|\/auth_platform/.test(location.pathname) || Boolean(document.querySelector('input[name="username"], textarea, a[href="/direct/inbox/"], svg[aria-label="Home"]')), null, { timeout: 20000 }); } catch {}
  if (/\/accounts\/login|\/challenge|\/checkpoint|\/recaptcha|\/auth_platform/i.test(page.url())) {
    throw new Error("Instagram requires login or a security check. Complete it in your regular browser, then export a fresh session.");
  }
  const proof = await page.locator('input[name="username"], textarea, a[href="/direct/inbox/"], svg[aria-label="Home"]').count();
  if (!proof || !page.url().startsWith("https://www.instagram.com/")) throw new Error("Instagram did not confirm the session. The previous session was kept.");
}

async function importSession(input, accountId) {
  const id = accountId || (await getActiveAccount()).id;
  if (busyAccounts.has(id) || loginSessionAccountId === id) throw new Error("Close the login browser and wait for any Instagram upload to finish before importing.");
  busyAccounts.add(id);
  let browser;
  try {
    const cookies = normalizeInstagramCookies(input);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: config.browserLocale, timezoneId: config.timezone });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await verifyInstagramPage(page);
    const verifiedCookies = await context.cookies("https://www.instagram.com/");
    await saveInstagramSession(await getPlatformProfileDir("instagram", id), verifiedCookies);
    return { ok: true, saved: true, verified: true };
  } finally {
    if (browser) await browser.close();
    busyAccounts.delete(id);
  }
}

/**
 * Navigate with retry logic and exponential backoff.
 * On 429 / network errors, waits and retries up to `maxRetries` times.
 */
async function navigateWithRetry(page, url, { maxRetries = 3, waitUntil = "domcontentloaded" } = {}) {
  const backoffMs = [5000, 15000, 30000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil, timeout: 60000 });
      if (response && response.status() === 429) {
        throw new Error("HTTP 429 - Instagram rate limit");
      }
      // Random human-like pause after navigation (1.5-3.5 s)
      await page.waitForTimeout(1500 + Math.random() * 2000);
      return response;
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      const delay = backoffMs[attempt] || 30000;
      console.log(
        `Instagram navigation failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. ` +
        `Retrying in ${delay / 1000}s...`
      );
      await page.waitForTimeout(delay);
    }
  }
}

async function gotoUploadPage(page) {
  await navigateWithRetry(page, config.instagramUploadPageUrl);
}

async function startLoginSession() {
  const activeAccount = await getActiveAccount();
  if (busyAccounts.has(activeAccount.id)) throw new Error("Instagram is busy for this account. Wait for the current operation to finish.");
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

  const loginUrl = "https://www.instagram.com/accounts/login/";
  page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((err) => {
    console.warn(`[instagram] Login navigation notice: ${err.message}`);
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
      saved = ["sessionid", "ds_user_id"].every((name) => cookies.some((c) =>
        /(^|\.)instagram\.com$/.test(c.domain) && c.name === name && c.value && (c.expires <= 0 || c.expires * 1000 > Date.now())));
    } catch {}
  }

  if (!saved) {
    saved = await hasSavedPlatformSession("instagram", activeAccount.id);
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
  const context = loginSessionContext;
  loginSessionContext = null;
  loginSessionAccountId = null;
  await context.close().catch(() => { });
  return { ok: true, alreadyClosed: false };
}

async function clickFirstVisibleEnabledLocator(page, locator) {
  const total = await locator.count();
  for (let i = 0; i < total; i += 1) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const disabled = await candidate.isDisabled().catch(() => false);
    if (disabled) continue;
    try {
      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 });
      await candidate.click({ timeout: 5000 });
      return true;
    } catch {
      try {
        await candidate.click({ timeout: 5000, force: true });
        return true;
      } catch {
        // continue
      }
    }
  }
  return false;
}

async function ensureCreateFlowInput(page) {
  const input = page.locator('input[type="file"]').first();
  if ((await input.count()) > 0) return input;

  const createPattern = uiLabels.pattern("create");
  const postFormatPattern = uiLabels.pattern("instagramPostFormat", "instagramReelFormat");
  const createEntryPoints = [
    page.getByRole("link", { name: createPattern }),
    page.getByRole("button", { name: createPattern }),
    page.locator('a[href*="/create"]').filter({ hasText: createPattern }),
    page.locator('nav a, nav [role="link"], nav button, nav [role="button"]').filter({
      hasText: createPattern,
    }),
  ];

  for (const entry of createEntryPoints) {
    const clicked = await clickFirstVisibleEnabledLocator(page, entry);
    if (!clicked) continue;
    console.log("Instagram create entry clicked.");
    await page.waitForTimeout(1200);
    if ((await input.count()) > 0) return input;
  }

  // Some flows open a chooser first (post/reel/story).
  const formatPickers = [
    ...uiLabels
      .terms("instagramPostFormat", "instagramReelFormat")
      .map((term) => page.getByText(term, { exact: true })),
    page.getByRole("button", { name: postFormatPattern }),
    page.getByRole("menuitem", { name: postFormatPattern }),
    page.getByRole("button", { name: /reel|reels/i }),
    page.locator('[role="menuitem"], [role="option"], button, a').filter({
      hasText: postFormatPattern,
    }),
  ];
  for (const picker of formatPickers) {
    const clicked = await clickFirstVisibleEnabledLocator(page, picker);
    if (!clicked) continue;
    console.log("Instagram post format selected (Post/Reel).");
    await page.waitForTimeout(1200);
    if ((await input.count()) > 0) return input;
  }

  const createButtons = [
    page.getByRole("button", { name: uiLabels.pattern("create", "instagramPostFormat") }),
    page.locator('[role="button"]').filter({ hasText: uiLabels.pattern("create", "instagramPostFormat") }),
    page.locator("a, [role='link']").filter({ hasText: uiLabels.pattern("create", "instagramPostFormat") }),
  ];

  for (const button of createButtons) {
    const clicked = await clickFirstVisibleEnabledLocator(page, button);
    if (clicked) {
      await page.waitForTimeout(1200);
      if ((await input.count()) > 0) return input;
    }
  }

  return input;
}

async function setVideoFile(page, videoPath) {
  let input = await ensureCreateFlowInput(page);
  if ((await input.count()) > 0) {
    await input.waitFor({ state: "attached", timeout: 120000 });
    await input.setInputFiles(videoPath);
    return;
  }

  // Fallback: use file chooser event if no file input is exposed yet.
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10000 }).catch(() => null);
  const uploadTriggerPattern = uiLabels.pattern("instagramUploadTrigger");
  const uploadTriggers = [
    page.getByRole("button", { name: uploadTriggerPattern }),
    page.locator('button, [role="button"]').filter({
      hasText: uploadTriggerPattern,
    }),
  ];

  for (const trigger of uploadTriggers) {
    const clicked = await clickFirstVisibleEnabledLocator(page, trigger);
    if (clicked) {
      console.log("Instagram upload trigger clicked.");
      break;
    }
  }

  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(videoPath);
    return;
  }

  // One last attempt to locate input after opening dialogs.
  input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 120000 });
  await input.setInputFiles(videoPath);
}

async function clickNextButtons(page) {
  const nextSelectors = [
    page.getByRole("button", { name: uiLabels.pattern("next") }),
    page.locator("button").filter({ hasText: uiLabels.pattern("next") }),
  ];

  for (let pass = 0; pass < 3; pass += 1) {
    let clicked = false;
    for (const selector of nextSelectors) {
      const didClick = await clickFirstVisibleEnabledLocator(page, selector);
      if (didClick) {
        clicked = true;
        await page.waitForTimeout(1200);
        break;
      }
    }
    if (!clicked) break;
  }
}

async function setCaption(page, caption) {
  if (!caption) return;
  const candidates = [
    uiLabels.attrSelector("textarea", "aria-label", "captionAttribute"),
    uiLabels.attrSelector("textarea", "placeholder", "captionAttribute"),
    'textarea',
    'div[contenteditable="true"]',
  ];

  for (const selector of candidates) {
    const target = page.locator(selector).first();
    if ((await target.count()) === 0) continue;
    try {
      await target.click({ timeout: 8000 });
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      await target.type(caption, { delay: 10 });
      return;
    } catch {
      // next
    }
  }
}

async function clickShare(page) {
  const sharePattern = uiLabels.pattern("share");
  const shareLocators = [
    page.getByRole("button", { name: sharePattern }),
    page.locator("button").filter({ hasText: sharePattern }),
    page.locator('[role="button"]').filter({ hasText: sharePattern }),
  ];

  for (const locator of shareLocators) {
    const clicked = await clickFirstVisibleEnabledLocator(page, locator);
    if (clicked) return true;
  }
  return false;
}

async function waitForPostConfirmation(page, startedUrl) {
  // Wait up to 60 * 1500ms = 90 seconds for upload processing
  for (let i = 0; i < 60; i += 1) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (uiLabels.pattern("posted").test(text)) {
      return { ok: true };
    }
    if (uiLabels.pattern("error").test(text)) {
      return { ok: false, reason: "Instagram reported an error while posting." };
    }

    const currentUrl = page.url();
    if (currentUrl !== startedUrl && !/\/create\//i.test(currentUrl)) {
      return { ok: true };
    }
    await page.waitForTimeout(1500);
  }
  return { ok: false, reason: "No reliable Instagram post confirmation within timeout." };
}

async function uploadMedia({ mediaPath, videoPath, photoPath, caption, accountId }) {
  const id = accountId || (await getActiveAccount()).id;
  if (busyAccounts.has(id) || loginSessionAccountId === id) return { ok: false, error: "Instagram browser is already in use for this account." };
  busyAccounts.add(id);
  const absoluteVideoPath = path.resolve(mediaPath || photoPath || videoPath);
  let context;
  let page;
  let closeHoldMs = 0;

  try {
    context = await openPersistentContext(id);
    page = context.pages()[0] || (await context.newPage());
    await verifyInstagramPage(page);
    await gotoUploadPage(page);
    await setVideoFile(page, absoluteVideoPath);
    await page.waitForTimeout(Math.max(config.postDelayMs, 5000));
    await clickNextButtons(page);
    await setCaption(page, caption || config.defaultCaption);

    const startedUrl = page.url();
    const shared = await clickShare(page);
    if (!shared) {
      throw new Error("Could not find/click Instagram Share button.");
    }

    const confirmation = await waitForPostConfirmation(page, startedUrl);
    if (!confirmation.ok) {
      throw new Error(confirmation.reason);
    }

    const successScreenshotPath = path.resolve(
      config.projectRoot,
      "last-instagram-upload-success.png"
    );
    await page.screenshot({ path: successScreenshotPath, fullPage: true }).catch(() => { });

    // Hold the browser open so background processing finishes
    closeHoldMs = Math.max(config.postPublishHoldMs || 15000, 15000);
    return { ok: true };
  } catch (error) {
    const screenshotPath = path.resolve(
      config.projectRoot,
      "last-instagram-upload-error.png"
    );
    if (page) await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { });

    closeHoldMs = Math.max(config.failureHoldMs, 0);
    return {
      ok: false,
      error: error.message,
      screenshotPath,
    };
  } finally {
    if (closeHoldMs > 0 && page) {
      console.log(`Holding browser for ${closeHoldMs / 1000}s before closing...`);
      await page.waitForTimeout(closeHoldMs).catch(() => { });
    }
    try { if (context) await context.close(); } finally { busyAccounts.delete(id); }
  }
}

module.exports = {
  uploadVideo: uploadMedia,
  uploadPhoto: uploadMedia,
  startLoginSession,
  getLoginSessionStatus,
  closeLoginSession,
  importSession,
};

