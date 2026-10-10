# AutoSocial Studio — Agent Guidelines & Instructions

## Project Overview
AutoSocial Studio is a local workstation multi-account automation dashboard for short-form video workflows across TikTok, Instagram, and YouTube.
- **Runtime**: Node.js 18+ (tested on Node 24), Express 5, Playwright Chromium, FFmpeg, ffprobe, and yt-dlp.
- **Location**: `E:\AutoSocial`

## Key Capabilities & Workflows
1. **Local Dashboard**:
   - Command: `npm run dashboard` (or `node src/dashboard-server.js`)
   - URL: `http://127.0.0.1:3000`
   - Binds to `127.0.0.1` locally without external exposure.

2. **Automation & Posting**:
   - `npm run post -- --account <account> --platform <tiktok|instagram|youtube>`: Posts pending video from queue.
   - `npm run daemon`: Starts background scheduler running cron intervals configured in `.env`.

3. **Queues & Folders**:
   - Pending videos: `queue/<account>/<platform>/pending/`
   - Successfully posted: `queue/<account>/<platform>/posted/`
   - Failed attempts: `queue/<account>/<platform>/failed/`
   - Browser sessions/cookies: `.profiles/<account>/<platform>/`

4. **Video Uniquifier**:
   - Command: `npm run uniquify`
   - Changes visual hashes, trims intro/outro frames, and adds optional logo/watermark.

5. **Downloader (yt-dlp)**:
   - Tool located at: `E:\AutoSocial\autodownload\yt-dlp.exe`
   - Profile scraper / watcher: `npm run autodownload`

## Operational Guidelines for AI Agents
- Always check environment integrity via `npm run doctor`.
- Never commit or expose `.env` or `.profiles/` (contains cookies and platform tokens).
- Maintain graceful handling of network delays during Playwright browser automation.
