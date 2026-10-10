const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");
const { getNextQueuedItem, getCaptionPaths } = require("./telegram-queue");
const { uploadVideo } = require("./telegram-uploader");
const { ensureDirectories, fileExists, moveWithTimestamp } = require("./fs-utils");

async function moveCaptionsIfExists(captionPaths, targetDir) {
  const moved = [];
  for (const cp of captionPaths) {
    if (await fileExists(cp)) {
      const result = await moveFileSafely(cp, targetDir, "caption file");
      if (result) moved.push(result);
    }
  }
  return moved.length > 0 ? moved[0] : null;
}

async function moveFileSafely(sourcePath, targetDir, label) {
  try {
    return await moveWithTimestamp(sourcePath, targetDir);
  } catch (error) {
    console.error(`Could not move ${label}: ${error.message}`);
    return null;
  }
}

async function postSingleVideo({ videoPath, caption, postedDir, failedDir, accountId, botToken, chatId }) {
  const posted = postedDir || config.telegramPostedDir;
  const failed = failedDir || config.telegramFailedDir;
  await ensureDirectories([posted, failed]);

  const result = await uploadVideo({ videoPath, caption, accountId, botToken, chatId });
  const captionPaths = getCaptionPaths(videoPath);

  if (result.ok) {
    const movedVideo = await moveFileSafely(videoPath, posted, "posted video");
    const movedCaption = await moveCaptionsIfExists(captionPaths, posted);
    if (!movedVideo) {
      return {
        ok: false,
        error: "Video sent to Telegram, but could not archive file from queue.",
      };
    }
    return { ok: true, movedVideo, movedCaption, messageId: result.messageId };
  }

  const movedVideo = await moveFileSafely(videoPath, failed, "failed video");
  const movedCaption = await moveCaptionsIfExists(captionPaths, failed);
  return {
    ok: false,
    movedVideo,
    movedCaption,
    error: result.error,
  };
}

async function postNextFromQueue({ source, queueDir, postedDir, failedDir, accountId, botToken, chatId } = {}) {
  const targetQueue = queueDir || config.telegramQueueDir;
  const item = await getNextQueuedItem(targetQueue);
  if (!item) {
    return {
      ok: false,
      skipped: true,
      reason: `No video files in Telegram queue: ${targetQueue}`,
    };
  }

  const caption = item.caption || config.defaultCaption || "";
  return postSingleVideo({
    videoPath: item.videoPath,
    caption,
    postedDir,
    failedDir,
    accountId,
    botToken,
    chatId,
  });
}

module.exports = {
  postNextFromQueue,
  postSingleVideo,
};
