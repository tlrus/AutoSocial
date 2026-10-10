const { startLoginSession: startIgLogin, closeLoginSession: closeIgLogin } = require('../src/instagram-uploader');
const { startDashboardLoginSession: startTtLogin, closeLoginSession: closeTtLogin } = require('../src/tiktok-uploader');
const { startLoginSession: startYtLogin, closeLoginSession: closeYtLogin } = require('../src/youtube-uploader');
const { startLoginSession: startXLogin, closeLoginSession: closeXLogin } = require('../src/x-uploader');
const { hasSavedPlatformSession } = require('../src/account-manager');

const platform = (process.argv[2] || 'instagram').toLowerCase();

const starters = {
  instagram: { start: startIgLogin, close: closeIgLogin, label: 'Instagram' },
  tiktok: { start: startTtLogin, close: closeTtLogin, label: 'TikTok' },
  youtube: { start: startYtLogin, close: closeYtLogin, label: 'YouTube' },
  x: { start: startXLogin, close: closeXLogin, label: 'X (Twitter)' },
};

const target = starters[platform];
if (!target) {
  console.error(`Unknown platform "${platform}". Use: instagram, tiktok, youtube, x`);
  process.exit(1);
}

async function run() {
  console.log(`\n==================================================`);
  console.log(`  AutoSocial: Opening browser for ${target.label}`);
  console.log(`==================================================\n`);

  try {
    const res = await target.start();
    console.log(`✓ Browser opened!`);
    console.log(`Please log in or register your account in the opened window.`);
    console.log(`Waiting for login to be completed...\n`);

    let alreadyReported = false;
    const interval = setInterval(async () => {
      try {
        const saved = await hasSavedPlatformSession(platform, 'default');
        if (saved && !alreadyReported) {
          alreadyReported = true;
          console.log(`\n🎉 SUCCESS! Active login detected for ${target.label}!`);
          console.log(`Session is saved. You can close the browser window now.\n`);
        }
      } catch {}
    }, 2000);

    // Keep process alive until user hits Ctrl+C
    process.on('SIGINT', async () => {
      clearInterval(interval);
      console.log(`\nClosing browser...`);
      await target.close().catch(() => {});
      process.exit(0);
    });

  } catch (err) {
    console.error(`Failed to launch browser:`, err.message);
    process.exit(1);
  }
}

run();
