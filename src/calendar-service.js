const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { config } = require("./config");
const { getAllAccounts } = require("./account-manager");
const { randomUUID } = require("node:crypto");
const { prepareMedia, PHOTO_PLATFORMS } = require("./calendar-media");

const { uploadVideo: uploadTikTok } = require("./tiktok-uploader");
const { uploadVideo: uploadInstagram } = require("./instagram-uploader");
const { uploadVideo: uploadYouTube } = require("./youtube-uploader");
const { uploadVideo: uploadTelegram } = require("./telegram-uploader");
const { uploadVideo: uploadX } = require("./x-uploader");
const photoUploaders = {
  instagram: require("./instagram-uploader").uploadPhoto,
  telegram: require("./telegram-uploader").uploadPhoto,
  x: require("./x-uploader").uploadPhoto,
};

function getCalendarDir(accountId = "default") {
  return path.resolve(config.projectRoot, "queue", accountId, "calendar");
}

function getVideosDir(accountId = "default") {
  return path.resolve(getCalendarDir(accountId), "videos");
}

function getPostsFilePath(accountId = "default") {
  return path.resolve(getCalendarDir(accountId), "posts.json");
}

async function ensureDirs(accountId = "default") {
  const calDir = getCalendarDir(accountId);
  const vidsDir = getVideosDir(accountId);
  await fs.mkdir(calDir, { recursive: true });
  await fs.mkdir(vidsDir, { recursive: true });
}

async function loadPosts(accountId = "default") {
  await ensureDirs(accountId);
  const filePath = getPostsFilePath(accountId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.writeFile(filePath, JSON.stringify([], null, 2), "utf8");
      return [];
    }
    console.error(`[calendar] Error reading posts for ${accountId}:`, err.message);
    return [];
  }
}

async function savePosts(accountId = "default", posts = []) {
  await ensureDirs(accountId);
  const filePath = getPostsFilePath(accountId);
  await fs.writeFile(filePath, JSON.stringify(posts, null, 2), "utf8");
}

async function createPost(item) {
  const created = await createPostsBatch({ accountId: item.accountId || "default", postsData: [item] });
  return created[0];
}

async function createPostsBatch({ accountId = "default", postsData = [] }) {
  if (!Array.isArray(postsData) || !postsData.length || postsData.length > 30) throw new Error("Выберите от 1 до 30 файлов.");
  await ensureDirs(accountId);
  const created = [];
  const preparedPaths = [];
  try {
    for (const item of postsData) {
      const { sourceFilePath, originalFilename, mimeType = "", caption = "", platforms = [], scheduledAt } = item;
      if (!Array.isArray(platforms) || !platforms.length) throw new Error("Выберите хотя бы одну социальную сеть.");
      if (platforms.some((p) => !["tiktok", "instagram", "youtube", "telegram", "x"].includes(p))) throw new Error("Неизвестная социальная сеть.");
      const scheduleDate = new Date(scheduledAt);
      if (!scheduledAt || isNaN(scheduleDate.getTime())) throw new Error("Укажите дату и время публикации.");
      const id = "post_" + randomUUID();
      const media = await prepareMedia({ sourceFilePath, originalFilename, mimeType, destinationBase: path.resolve(getVideosDir(accountId), id) });
      preparedPaths.push(media.mediaPath);
      const targets = Array.from(new Set(platforms)).filter((p) => media.mediaType !== "photo" || PHOTO_PLATFORMS.has(p));
      if (!targets.length) throw new Error("Фото можно публиковать в Instagram, Telegram и X. Выберите хотя бы одну из этих сетей.");
      const storedName = path.basename(media.mediaPath);
      created.push({
        id, accountId, ...media,
        mediaFilename: originalFilename || storedName,
        // Keep legacy fields so existing calendar data and clients continue to work.
        videoFilename: originalFilename || storedName,
        videoStoredName: storedName,
        videoPath: media.mediaPath,
        caption: String(caption || "").trim(),
        platforms: targets,
        skippedPlatforms: platforms.filter((p) => !targets.includes(p)),
        scheduledAt: scheduleDate.toISOString(),
        status: "scheduled", createdAt: new Date().toISOString(), results: {},
      });
    }
    const posts = await loadPosts(accountId);
    await savePosts(accountId, [...posts, ...created]);
    return created;
  } catch (error) {
    await Promise.all(preparedPaths.map((p) => fs.unlink(p).catch(() => {})));
    throw error;
  }
}

async function getPosts(accountId = "default") {
  const posts = await loadPosts(accountId);
  return posts.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
}

async function deletePost(id, accountId = "default") {
  const posts = await loadPosts(accountId);
  const index = posts.findIndex((p) => p.id === id);
  if (index === -1) {
    return { ok: false, error: "Post not found." };
  }

  const [removed] = posts.splice(index, 1);
  await savePosts(accountId, posts);

  if (removed.videoPath) {
    await fs.unlink(removed.videoPath).catch(() => {});
  }

  return { ok: true };
}

const platformUploaders = {
  tiktok: uploadTikTok,
  instagram: uploadInstagram,
  youtube: uploadYouTube,
  telegram: uploadTelegram,
  x: uploadX,
};

let isPublishingAny = false;

async function publishPost(post) {
  const { accountId, id, caption, platforms } = post;
  const mediaPath = post.mediaPath || post.videoPath;
  console.log(`[calendar] Starting publication of post ${id} to [${platforms.join(", ")}]...`);

  if (!fsSync.existsSync(mediaPath)) {
    post.status = "failed";
    post.results = { error: "Media file was not found on disk." };
    const posts = await loadPosts(accountId);
    const idx = posts.findIndex((p) => p.id === id);
    if (idx !== -1) {
      posts[idx] = post;
      await savePosts(accountId, posts);
    }
    return post;
  }

  post.status = "publishing";
  const posts = await loadPosts(accountId);
  const idx = posts.findIndex((p) => p.id === id);
  if (idx !== -1) {
    posts[idx] = post;
    await savePosts(accountId, posts);
  }

  let successCount = 0;
  let failCount = 0;

  for (const plat of platforms) {
    const uploader = (post.mediaType === "photo" ? photoUploaders : platformUploaders)[plat];
    if (!uploader) {
      post.results[plat] = {
        ok: false,
        error: `Platform "${plat}" is not supported.`,
        at: new Date().toISOString(),
      };
      failCount++;
      continue;
    }

    try {
      console.log(`[calendar] Uploading post ${id} to ${plat}...`);
      const result = await uploader({
        videoPath: mediaPath,
        photoPath: mediaPath,
        mediaPath,
        caption,
        accountId,
      });

      post.results[plat] = {
        ok: Boolean(result?.ok),
        error: result?.error || null,
        at: new Date().toISOString(),
      };

      if (result?.ok) {
        successCount++;
      } else {
        failCount++;
      }
    } catch (err) {
      console.error(`[calendar] Upload error for ${plat}:`, err.message);
      post.results[plat] = {
        ok: false,
        error: err.message,
        at: new Date().toISOString(),
      };
      failCount++;
    }
  }

  if (successCount > 0 && failCount === 0) {
    post.status = "published";
  } else if (successCount > 0 && failCount > 0) {
    post.status = "partial";
  } else {
    post.status = "failed";
  }

  post.publishedAt = new Date().toISOString();

  const currentPosts = await loadPosts(accountId);
  const curIdx = currentPosts.findIndex((p) => p.id === id);
  if (curIdx !== -1) {
    currentPosts[curIdx] = post;
    await savePosts(accountId, currentPosts);
  }

  console.log(`[calendar] Post ${id} completed with status: ${post.status}`);
  return post;
}

async function publishPostNow(id, accountId = "default") {
  const posts = await loadPosts(accountId);
  const post = posts.find((p) => p.id === id);
  if (!post) {
    throw new Error("Post not found.");
  }
  return await publishPost(post);
}

async function publishDuePosts() {
  if (isPublishingAny) return;
  isPublishingAny = true;

  try {
    const accounts = await getAllAccounts();
    const accountIds = (accounts || []).map((a) => a.id);
    if (!accountIds.includes("default")) {
      accountIds.push("default");
    }

    const now = new Date();

    for (const accId of accountIds) {
      const posts = await loadPosts(accId);
      const duePosts = posts.filter(
        (p) => p.status === "scheduled" && new Date(p.scheduledAt) <= now
      );

      for (const due of duePosts) {
        try {
          await publishPost(due);
        } catch (err) {
          console.error(`[calendar] Error publishing scheduled post ${due.id}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error("[calendar] Scheduler check error:", err.message);
  } finally {
    isPublishingAny = false;
  }
}

module.exports = {
  createPost,
  createPostsBatch,
  getPosts,
  deletePost,
  publishPostNow,
  publishDuePosts,
  getCalendarDir,
  getVideosDir,
};
