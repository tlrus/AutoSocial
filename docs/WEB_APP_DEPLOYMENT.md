# Permanent AutoSocial web application

This is a deployment recipe for an existing hosting account and a permanent
hostname. The actual provider, server access, hostname, and available capacity
must be confirmed before deployment. These files do not create a server, buy a
domain, change the existing public relay, or deploy the application.

Use `deploy/compose.web.yaml` as an alternative to `deploy/compose.yaml`, not an
overlay. It runs the existing application image and Caddy HTTPS, with persistent
application and certificate volumes. It does not start Ollama or download models.
Local AI generation needs a separately configured inference service; dashboard,
PWA installation, and official social account connections do not need Ollama.

## Hosting requirements

- A persistent Linux server or container host that supports Docker Compose,
  background Node.js processes, Chromium, FFmpeg, and writable persistent storage.
  Static hosting, PHP-only shared hosting, and short-lived serverless functions
  cannot run this application as packaged.
- One application replica. Account data, tokens, and jobs use local files and
  in-process state; do not run multiple writers against the same data volume.
- A real hostname controlled by the user, with DNS pointing to the host and
  inbound TCP ports 80 and 443 available for Caddy and certificate issuance.
  Expose neither the application port 3000 nor a browser remote-debugging port.
- Enough memory, CPU, and disk for the actual media workload and Chromium. Check
  the provider's existing quota before building; this recipe does not authorize
  a paid upgrade. The Docker image includes browser and media tools even when
  only the dashboard is used.

For a provider that manages HTTPS itself, use its container and persistent-disk
facilities instead of running a second public Caddy listener. Preserve the same
data path, secret bindings, single replica, and trusted HTTPS proxy settings.
Confirm the provider's proxy topology before changing `DASHBOARD_TRUST_PROXY`.

## Configuration and private files

Transfer a reviewed source checkout or verified release archive that includes
`deploy/compose.web.yaml`, current `src/`, and all PWA files under `web/`. Do not
transfer raw browser profiles, `.env`, or runtime data as part of the source
archive. When using `scripts/prepare-cloud-bundle.js`, verify its checksum and
file inventory before transferring the source-only archive to the host.

From the release directory on the server:

```sh
umask 077
mkdir -p deploy/secrets
[ -e deploy/.env ] || cp deploy/.env.example deploy/.env
```

Edit the non-secret deployment settings privately:

```dotenv
AUTOSOCIAL_DOMAIN=autosocial.example.com
DASHBOARD_PUBLIC_URL=https://autosocial.example.com
AUTOSOCIAL_START_BACKGROUND=false
```

Replace the example hostname with the actual permanent hostname in both places.
`DASHBOARD_PUBLIC_URL` must be the HTTPS origin only: no application path, query,
fragment, or credentials. Use the same origin in the browser and provider OAuth
registrations. Temporary `tunnelmole.net` and `trycloudflare.com` URLs are rejected
for official OAuth connections. A changed hostname requires updating provider
callbacks and reconnecting accounts.

Prepare these private files through the provider's secret manager or a secure
file transfer, never through chat or source control:

| File | Contents |
| --- | --- |
| `deploy/secrets/dashboard-password-hash` | One valid `scrypt:...` dashboard password hash, not the plain password |
| `deploy/secrets/runtime.env` | Dotenv assignments for the provider credentials listed below; it may be empty if no provider is configured |

To reuse an existing dashboard password, run
`node scripts/prepare-cloud-secrets.js` on the trusted development machine and
transfer its protected output files. If no dashboard password exists, run
`npm run setup:password` there first; it saves the generated password in the
private `.local/dashboard-access.txt` file. Keep that password private and copy
only the hash into the server secret. The preparation script exports the hash
and Telegram settings; add OAuth application credentials separately using the
server's secure secret configuration. Do not reset an existing password unless
that change is intended.

Compose mounts both files as secrets. The entrypoint exports the dashboard hash,
and `AUTOSOCIAL_SECRETS_FILE=/run/secrets/runtime_env` loads provider settings
before writable application settings. Keep credentials out of `deploy/.env` and
`/data/settings.env`. On Linux, set the secret directory to mode 700 and the
files to mode 600, owned by UID/GID 1000 so the non-root container can read the
file-backed secret mounts. Host and Docker administrators retain access.

## Official provider configuration

Register OAuth applications for the providers you intend to connect. Put their
credentials in `deploy/secrets/runtime.env` or an equivalent private runtime
secret binding. Empty or missing credentials leave that provider unavailable;
they do not prevent the dashboard from starting. Do not enter browser cookies
or another service's access token in place of OAuth application credentials.

| Provider | Runtime variable names | Required callback URL |
| --- | --- | --- |
| Instagram | `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET`; optional `INSTAGRAM_API_VERSION` | `https://autosocial.example.com/api/social-connections/oauth/instagram/callback` |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | `https://autosocial.example.com/api/social-connections/oauth/tiktok/callback` |
| YouTube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `https://autosocial.example.com/api/social-connections/oauth/youtube/callback` |
| X | `X_CLIENT_ID`, `X_CLIENT_SECRET` | `https://autosocial.example.com/api/social-connections/oauth/x/callback` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | None; Telegram uses the server's configured bot and chat |

Replace the example origin in every registered callback with
`DASHBOARD_PUBLIC_URL`. These callback paths must match exactly; neither a
wildcard callback nor a callback ending at the site root is sufficient. Choose
the corresponding web/server OAuth application type. Register required verified
domains, authorized test users, and consent-screen information in each provider
console before attempting a connection.

- Instagram uses Instagram Login with `instagram_business_basic`. It supports
  the authorized user's professional Business or Creator account, not personal
  accounts, private messages, or drafts. Public access can require Meta app
  review and the provider's required business/account verification.
- TikTok uses `user.info.basic` and `video.list` with PKCE. Login Kit and the
  Display API permissions, test-user access, and production review must be
  enabled as required by TikTok. The adapter reads the authorized profile and
  accessible public videos; it does not import private videos, photo posts,
  drafts, or messages.
- YouTube uses `https://www.googleapis.com/auth/youtube.readonly` with PKCE.
  Enable YouTube Data API v3 and configure a Google OAuth web client and consent
  screen. Test-mode users, token lifetime, production verification, and API
  quotas follow the Google project's settings. The selected Google/YouTube
  channel determines the accessible videos and statistics.
- X uses OAuth 2.0 with PKCE and `tweet.read users.read offline.access`.
  Available endpoints, history depth, and request quotas depend on the
  application's approved X API access and plan. Configuring credentials does
  not buy or enable a paid plan.
- Telegram requires a bot that can access the chosen chat or channel and the
  corresponding chat ID. There is no Telegram OAuth callback. Bot API sync reads
  only available pending updates for that chat, not full channel history. It
  does not replace an existing webhook, acknowledge queued updates, or change
  another consumer's update settings. An existing webhook prevents this sync;
  use a suitable dedicated bot rather than deleting another integration's
  webhook. Other consumers and Telegram retention can make pending updates
  unavailable.

These integrations import data through official read APIs. They do not authorize
publishing and do not remove provider review, account, or quota restrictions.
Browser-based publishing sessions remain a separate workflow.

## Start and validate on the confirmed host

Check DNS, access, available resources, and secret-file permissions first. If
replacing the older Compose stack, stop its application and Ollama service before starting this
alternative. Both recipes deliberately use the existing `autosocial-data`
volume and the same Compose project name; do not run them concurrently.

```sh
docker compose --env-file deploy/.env -f deploy/compose.web.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.web.yaml build autosocial
docker compose --env-file deploy/.env -f deploy/compose.web.yaml pull caddy
docker compose --env-file deploy/.env -f deploy/compose.web.yaml up -d
docker compose --env-file deploy/.env -f deploy/compose.web.yaml ps
```

The Dockerfile installs locked npm dependencies and browser/media prerequisites.
Keep a reviewed application image and immutable Caddy image digest for repeatable
updates. No Node proxy flag is needed on an ordinary production server with
direct HTTPS access. In a managed cloud environment that supplies HTTP proxy
variables, Node 24's native `fetch` uses them with `NODE_USE_ENV_PROXY=1` (or the
equivalent Node option); preserve inherited CA trust and proxy variables. This
host recipe does not copy temporary cloud proxies into production.

Validate the permanent HTTPS address without publishing any social content:

```sh
curl --fail --silent --show-error https://autosocial.example.com/healthz
node scripts/cloud-smoke.js https://autosocial.example.com
```

Use the actual hostname. For authenticated smoke checks, supply an existing
protected password file via `AUTOSOCIAL_SMOKE_PASSWORD_FILE`; do not put the
password in a command argument or print cookies. The web-only stack is expected
to report the local model unavailable. Do not use `--require-model` for it.

Open the HTTPS address on the phone, sign in, verify the connection indicator,
and check the account connections and imported posts pages. After provider
setup, use Connect and approve each account through its own provider screen.
Check that the callback returns to the same site and that account data survives
an application restart. Verify that anonymous API calls return 401 and the
session cookie is `Secure`, `HttpOnly`, and `SameSite=Strict`.

On iPhone, use Safari's Share > Add to Home Screen. On Android, use the app's
installation action or the browser's Install app / Add to Home screen command.
Installation uses the same HTTPS site and credentials; it is not an App Store
or Google Play listing. Offline mode shows connectivity/offline information;
account sync still requires internet and a running server.

Keep `AUTOSOCIAL_START_BACKGROUND=false` while validating and migrating data.
Do not enable publishing schedules or switch an existing production relay until
the actual target, data, and cutover have been reviewed.

## Persistence, backups, and updates

The `autosocial-data` volume is mounted at `/data`. It includes application
settings, account data, media, and the encrypted connection vault under
`/data/.local/social-api/`. Preserve `vault.key` and `vault.enc` together. Losing
the key requires reconnecting accounts; a volume alone is not a backup.

Take a protected, encrypted full-volume backup while the sole application writer
is stopped, keep an independent recovery copy, and test recovery into a fresh
volume. The older `scripts/cloud-data.js` allowlist does not include the social
OAuth vault; do not rely on it alone for connection recovery until its coverage
has been updated. Protect both the persistent data and the deployment secret
files; do not publish raw archives or include them in a source release.

Back up before updates, replace the reviewed application image, and recreate the
application while retaining the data and Caddy certificate volumes. Ordinary
restart keeps data, but dashboard sessions and pending OAuth handshakes can need
a new login or connection attempt. Never use `docker compose down -v` as an
update or rollback command. Keep the previous image and verified backup until
the permanent HTTPS address, phone installation, and connected accounts have
been checked again.
