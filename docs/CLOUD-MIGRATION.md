# AutoSocial cloud migration

Assessment date: 2026-10-07. **Prepared, not deployed.** A permanent server and authorized access have not been provided. The existing free-only budget remains in effect. No paid resource, paid inference, social post, production switch, or data deletion is authorized by this preparation.

## Application inventory

| Component | Current implementation | Cloud treatment |
| --- | --- | --- |
| Website | Static HTML/CSS/vanilla JS in `web/`, served by Express | Same application container behind Caddy HTTPS |
| API | Node.js CommonJS, Express 5, Multer 2; Node 24 recommended | One persistent Node process; password required for remote binding |
| Commands | `npm start` / `npm run dashboard`; `npm run check`, `npm run doctor` | Docker image with locked npm dependencies; no frontend compiler required |
| Video/photo processing | FFmpeg, ffprobe, sharp, HEIC/BMP decoders | Linux packages and platform-specific npm binaries in the image |
| Publishing | Playwright/Chromium to TikTok, Instagram, YouTube and X; Telegram Bot API | Chromium on the server, isolated account sessions, separate bot secrets |
| AI agents | 17 roles, HTTP Ollama API, currently installed workstation models | Private `ollama` Compose service, persistent model volume; no paid AI API |
| Calendar | JSON per account plus media under `queue/<account>/calendar/` | Persistent `/data/queue`; encrypted migration rebases absolute Windows paths |
| Other storage | `accounts-state.json`, scheduler JSON, agent/canvas drafts, references, author profile, download archives | Persistent `/data`; no application SQL server is required |
| Browser SQLite | Chromium Cookies databases, inspected by optional Node SQLite | Session infrastructure, not the application database; Windows cookie encryption is not portable |
| Jobs | Calendar tick every 30 seconds; five platform cron schedulers; queue file watchers; downloader timer; asynchronous inference/video processing | Single application replica; restart policy; first cloud boot has background jobs disabled |
| Settings | Local `.env` plus runtime files | Docker secret mounts for password hash and Telegram credentials; writable `/data/settings.env` for non-secret settings |
| Existing public address | Free Cloudflare Worker relays to Cloudflare Tunnel on the PC | Keep address only after separately approved relay origin switch to verified cloud HTTPS |

The repository is `https://github.com/Katzca/AutoSocial.git`, with existing uncommitted changes. A private local source snapshot and binary Git diff were saved before modifications. No history was rewritten and nothing was pushed. Source archives use an explicit allowlist and content hashes; they exclude browser profiles, runtime data, local `.env`, personal author notes, experimental login scripts, screenshots, executables, `node_modules`, and Git history.

## Target and cost

Use Ubuntu 24.04 on a persistent Linux VM with Docker Engine and Compose. This application needs writable storage, long-running jobs, subprocesses, and a browser; a static site or sleeping free web service does not provide those requirements. Keep a single writer because JSON files and in-process locks are not a distributed database or queue.

For a free-only deployment, a usable **existing** server or a successfully registered Oracle Always Free tenancy with available A1 capacity is required. Oracle currently documents 2 OCPUs / 12 GB total, 200 GB combined boot/block storage, and possible idle reclamation. Select only console resources explicitly within the actual remaining Always Free allowance. Trial credits are not permanent hosting. The earlier signup/region problem remains unresolved; an account or VM must not be assumed to exist. [Oracle Always Free documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

For a paid alternative, an x86 Hetzner CX53 (32 GB RAM) is a reasonable starting point for the existing 14B model plus Chromium and media jobs: Germany/Finland list price is EUR 29.49/month excluding IPv4 and VAT. IPv4 adds EUR 0.50/month: about EUR 29.99/month before taxes. Optional provider backups add 20% of the server price, bringing this example to about EUR 35.89/month before taxes. CPU inference may be substantially slower than the workstation GPU; benchmark the actual workload before switching. This is an estimate, **not purchase approval**. [Server prices](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [IPv4 pricing](https://docs.hetzner.com/cloud/servers/primary-ips/overview/), [backup billing](https://docs.hetzner.com/cloud/billing/faq/).

For smaller/free hardware, the configuration proposes `qwen2.5:3b`; it has not been benchmarked on a target VM and can produce different text quality. Preserve the existing `qwen2.5-coder:14b` only on a host with adequate available memory. A GPU is optional for Ollama CPU mode, but responsiveness is not guaranteed. [Ollama Docker documentation](https://docs.ollama.com/docker).

Cloudflare Containers require Workers Paid plus metered runtime usage. Render free services sleep after 15 minutes of inactivity and cannot provide this application's durable local storage. Neither is selected as a free 24/7 replacement. [Cloudflare pricing](https://developers.cloudflare.com/containers/platform/pricing/), [Render free restrictions](https://render.com/docs/free).

## Prepared artifacts

- `Dockerfile`: Node 24, Linux FFmpeg, yt-dlp, Chromium, Xvfb, image libraries; non-root application user, health check, frozen install with package scripts disabled.
- `deploy/compose.yaml`: app, private Ollama, HTTPS Caddy, persistent volumes, bounded logs, graceful shutdown, restart after host reboot.
- `deploy/.env.example`: non-secret settings, actual domain, model choice, and `AUTOSOCIAL_START_BACKGROUND=false`.
- `scripts/prepare-cloud-bundle.js`: source-only archive, secret-pattern scan, per-file SHA-256 inventory and archive checksum.
- `scripts/prepare-cloud-secrets.js`: copies the existing password **hash**, selected bot settings and a separate random backup key into ignored protected local files. It does not rotate the dashboard password or print credentials.
- `scripts/cloud-data.js`: AES-256-GCM runtime archive; verifies authentication before extraction and checks every file hash; refuses an existing restore target, path traversal, links, or active publication snapshots; restores into a fresh location with paths rebased and imported queue watchers disabled.
- `deploy/backup.sh` and systemd timer: daily encrypted backup at 03:00 Asia/Qyzylorda after briefly stopping the sole writer. No automatic deletion. A separately approved off-server copy is still required for protection against server loss.
- `scripts/cloud-smoke.js`: health, anonymous access, optional authenticated site/API checks; never publishes or calls a paid inference API.
- GitHub CI: application checks, npm audit, Linux Docker build and runtime browser/image/tool verification. CI has not run remotely unless recorded in a separate verification report.

Docker and Linux/WSL are unavailable in the current workstation environment. A local Node test pass does not establish a working Linux image, a running server, or cloud availability. ARM64 builds must be verified on an ARM64 runner/host.

## Deployment procedure after access is supplied

1. Verify the actual host identity, available RAM/storage, provider quota and cost. Keep the free-only limit; obtain explicit approval before any billable creation or subscription.
2. Install Docker Engine/Compose from the official Ubuntu repository instructions, enable Docker at boot, and verify versions. Allow inbound SSH only from approved administration addresses; allow 80/443 for Caddy. Never expose ports 3000 or 11434. [Docker Ubuntu installation](https://docs.docker.com/engine/install/ubuntu/).
3. Create `/opt/autosocial` as a private release directory. Transfer the verified source archive over SSH/SFTP, separately from secrets and encrypted data; verify its SHA-256 on the host before unpacking. Do not upload the entire checkout or raw local `.env`.
4. Copy `deploy/.env.example` to `deploy/.env`; set a real DNS hostname. Point its A/AAAA record to the VM. Use a hostname already controlled by the user, or verify a no-purchase IP-based DNS hostname before requesting certificates. Domain registration is not included in the cost estimate. The existing `workers.dev` hostname belongs to the relay and cannot be assigned directly to Caddy.
5. Place `dashboard-password-hash`, `runtime.env`, and `backup.key` in `deploy/secrets/`. On Linux restrict the directory to mode 700 and secret files to mode 600. The two application secrets must be owned by UID 1000, matching the non-root `node` container user; the backup key is read only by the root backup helper. File-backed Compose secrets are bind mounts and may retain host ownership. Docker Engine administrators can read these files; use the provider's vault to deliver them if available. Never store the backup decryption key alongside an externally shared backup or in Git. Keep an independent protected key copy.
6. Run `docker compose build` and `docker compose pull ollama caddy`. Record image repository digests in `deploy/.env` for repeatable rollout/rollback. Confirm the actual Linux browser and photo decoders work using the CI runtime commands before proceeding.
7. Start Ollama with `docker compose up -d ollama`. Download only the selected free local model with `docker compose --profile models run --rm model-init`. This downloads weights, not a paid inference API call.
8. Restore the encrypted runtime archive **into a fresh temporary directory**, using the same image and backup key. Then, with the app stopped, copy this verified tree into the empty `autosocial-data` volume. Run `cloud-data restore --snapshot <encrypted-file> --target <fresh-staging-directory> --path-root /data --key-file <protected-key-file>`. Paths must be rebased to `/data`, not to the temporary host path. Set ownership to the app's UID 1000. Keep `AUTOSOCIAL_START_BACKGROUND=false` during validation.
9. Start `docker compose up -d`. Verify `docker compose ps`, `/healthz`, login, 401 for anonymous API requests, the calendar/media preview, agent model availability, a real generated draft, draft persistence after restart, and photo/video processing without any social submission.
10. Windows Chrome profiles cannot simply be copied to Linux and treated as logged in. The existing portable Instagram session JSON is included privately, but the platform may request revalidation from the new IP. TikTok/YouTube/X generally require a fresh browser login on the server. Use an SSH-protected remote desktop/login session; do not expose an unauthenticated remote browser or VNC port. The current Xvfb display is not an interactive remote login solution. Provider security checks and CAPTCHA must be completed by the user. Do not publish test content without separate permission.
11. Take a verified cloud backup and install the backup service/timer only after backup downtime is approved. Test recovery into a fresh volume; protect the independent key copy. Monitor free disk space, health checks, RAM/CPU, queue failures and Ollama errors. This preparation does not provision a paid monitoring service.
12. Present the exact new origin, verified tests, schedules due at cutover, and old Worker origin for approval. Only then pause local publication/downloader jobs, create a final stable snapshot, restore it on cloud, and switch the existing Worker origin. Enable one cloud scheduler after reviewing overdue scheduled posts. Never run both local and cloud publishing concurrently.
13. To prove independence, stop the local app/tunnel under the approved cutover and check the public address again. Reboot the VM and repeat checks. Keep the local source/data intact until acceptance; do not declare the migration complete before this proof.

## Rollback

Before cutover, record the current Worker origin privately, app image digest, deployment settings and snapshot checksum. No production relay change has been made during preparation.

If cloud checks fail, leave the Worker pointing to the existing origin. If failure occurs after an approved switch, stop cloud schedulers first, restore the old Worker origin, then resume local jobs only after checking posts that may already have been submitted in cloud. Do not blindly import a pre-cutover queue and republish it. Restore any data into a **fresh** directory/volume and verify before selection. Keep current data and the previous image available; avoid destructive `docker compose down -v`. A rollback to the PC temporarily brings back the PC-on dependency.

## Required user actions

Provide a permanent server's provider, hostname/IP and SSH user/access method, or a usable free hosting account with compatible compute. Do not paste private keys, account passwords or bot tokens in chat; use a secure file or the platform's secret settings. Select a real domain if one exists. Approve billable resources only if the budget changes. Approve the exact production cutover after cloud verification, and complete any new social-platform security checks. Until a server is available and verified, there is no new cloud URL and the application still depends on the workstation.
