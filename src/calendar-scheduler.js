const { publishDuePosts } = require("./calendar-service");

let schedulerTimer = null;

function startCalendarScheduler(intervalMs = 30000) {
  if (schedulerTimer) return;
  console.log("[calendar-scheduler] Started calendar post scheduler (30s interval)");

  // Run once immediately on start
  publishDuePosts().catch((err) => {
    console.error("[calendar-scheduler] Error on initial check:", err.message);
  });

  schedulerTimer = setInterval(() => {
    publishDuePosts().catch((err) => {
      console.error("[calendar-scheduler] Error on interval check:", err.message);
    });
  }, intervalMs);
}

function stopCalendarScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[calendar-scheduler] Stopped calendar post scheduler");
  }
}

module.exports = {
  startCalendarScheduler,
  stopCalendarScheduler,
};