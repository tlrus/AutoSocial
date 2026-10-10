const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");

async function uploadMedia({ mediaPath, videoPath, photoPath, mediaType = "video", caption, botToken, chatId } = {}) {
  const token = botToken || config.telegramBotToken;
  const targetChatId = chatId || config.telegramChatId;

  if (!token) {
    return {
      ok: false,
      error: "Telegram bot token is not configured. Set TELEGRAM_BOT_TOKEN in .env or dashboard settings.",
    };
  }
  if (!targetChatId) {
    return {
      ok: false,
      error: "Telegram chat/channel ID is not configured. Set TELEGRAM_CHAT_ID in .env or dashboard settings.",
    };
  }

  try {
    const fileBuffer = await fs.readFile(mediaPath || photoPath || videoPath);
    const fileName = path.basename(mediaPath || photoPath || videoPath);
    const isPhoto = mediaType === "photo";
    const blob = new Blob([fileBuffer], { type: isPhoto ? "image/jpeg" : "video/mp4" });
    const formData = new FormData();
    formData.append("chat_id", targetChatId);
    formData.append(isPhoto ? "photo" : "video", blob, fileName);
    if (caption) {
      formData.append("caption", caption);
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/${isPhoto ? "sendPhoto" : "sendVideo"}`, {
      method: "POST",
      body: formData,
    });

    const data = await response.json();
    if (!data.ok) {
      return {
        ok: false,
        error: `Telegram API error: ${data.description || JSON.stringify(data)}`,
      };
    }

    return {
      ok: true,
      messageId: data.result?.message_id,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Telegram upload request failed: ${err.message}`,
    };
  }
}

module.exports = {
  uploadVideo: (options) => uploadMedia({ ...options, mediaType: "video" }),
  uploadPhoto: (options) => uploadMedia({ ...options, mediaType: "photo" }),
};
