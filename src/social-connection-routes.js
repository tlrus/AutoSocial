const path = require("node:path");

const PUBLIC_ASSETS = [
  "manifest.webmanifest", "sw.js", "pwa.js", "pwa.css", "offline.html",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "icons/icon-maskable-512.png", "icons/apple-touch-icon.png",
];

function installPublicAppRoutes(app, { service }) {
  for (const asset of PUBLIC_ASSETS) app.get(`/${asset}`, (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    if (asset === "sw.js") res.set("Service-Worker-Allowed", "/");
    if (asset === "manifest.webmanifest") res.type("application/manifest+json");
    res.sendFile(path.join(__dirname, "..", "web", asset));
  });

  // OAuth returns cross-site. Its own single-use state and Lax nonce cookie
  // protect this public callback; the dashboard session remains SameSite=Strict.
  app.get("/api/social-connections/oauth/:provider/callback", async (req, res) => {
    const provider = req.params.provider;
    const knownProvider = ["instagram", "tiktok", "youtube", "x"].includes(provider);
    const name = knownProvider ? `autosocial_oauth_${provider}` : null;
    const entry = name && String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
    let success = false;
    if (knownProvider) {
      try {
        await service.completeAuthorization(provider, {
          state: req.query.state, code: req.query.code, error: req.query.error,
          bindingCookie: entry ? entry.slice(name.length + 1) : "",
        });
        success = true;
      } catch { /* Never echo or log provider response bodies, codes or tokens. */ }
      res.clearCookie(name, { httpOnly: true, secure: true, sameSite: "lax", path: `/api/social-connections/oauth/${provider}/callback` });
    }
    res.set({
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    // A deliberate same-origin navigation also restores the Strict session
    // cookie after returning from the provider's authorization page.
    res.status(success ? 200 : 400).type("html").send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoSocial</title><style>body{font:18px system-ui;background:#101218;color:#f2f4f8;margin:0;display:grid;min-height:100svh;place-items:center}main{max-width:32rem;padding:2rem}a{display:inline-block;background:#b9ff66;color:#101218;padding:1rem;border-radius:.75rem;text-decoration:none}</style><main><h1>${success ? "Аккаунт подключён" : "Подключение не завершено"}</h1><p>${success ? "Началась загрузка доступных публикаций. Результат появится в приложении." : "Вернитесь в приложение и начните подключение снова."}</p><a href="/#connections">Открыть AutoSocial</a></main></html>`);
  });
}

function installSocialConnectionRoutes(app, { service, getActiveAccount }) {
  const respond = (res, exception) => {
    const code = typeof exception.code === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(exception.code) ? exception.code : "request_failed";
    const status = [400, 404, 409, 429, 503, 504].includes(exception.status) ? exception.status : 502;
    // Service errors are intentionally sanitized. Unexpected exceptions get a
    // fixed message; raw provider payloads must never reach the dashboard.
    const message = code !== "request_failed" && typeof exception.message === "string" ? exception.message : "Не удалось выполнить запрос. Повторите попытку.";
    return res.status(status).json({ ok: false, code, error: message });
  };
  app.get("/api/social-connections", async (req, res) => {
    try { res.json(await service.status()); } catch (exception) { respond(res, exception); }
  });
  app.post("/api/social-connections/:provider/connect", async (req, res) => {
    try {
      const accountId = req.body?.accountId === undefined ? (await getActiveAccount()).id : req.body.accountId;
      const state = await service.status();
      const provider = state.providers.find((item) => item.id === req.params.provider);
      if (provider?.authType === "configured") {
        const connection = await service.connectConfigured(req.params.provider, accountId);
        return res.status(202).json({ ok: true, connection });
      }
      const { authorizationUrl, stateCookie } = await service.beginAuthorization(req.params.provider, accountId);
      const { name, value, ...options } = stateCookie;
      res.cookie(name, value, options);
      res.json({ ok: true, authorizationUrl });
    } catch (exception) { respond(res, exception); }
  });
  app.post("/api/social-connections/:id/sync", async (req, res) => {
    try { res.status(202).json({ ok: true, connection: await service.sync(req.params.id) }); }
    catch (exception) { respond(res, exception); }
  });
  app.delete("/api/social-connections/:id", async (req, res) => {
    try { res.json(await service.disconnect(req.params.id)); } catch (exception) { respond(res, exception); }
  });
}

module.exports = { installPublicAppRoutes, installSocialConnectionRoutes };
