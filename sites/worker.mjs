export default {
  async fetch(request, env) {
    const unavailable = (message, status = 503) => new Response(
      request.headers.get("accept")?.includes("text/html")
        ? `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoSocial</title><style>body{font:16px/1.6 system-ui;background:#0e1118;color:#f3f5fb;margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:480px;padding:32px}h1{font-size:28px}</style><main><h1>AutoSocial</h1><p>${message}</p></main></html>`
        : JSON.stringify({ ok: false, error: message }),
      { status, headers: { "Content-Type": request.headers.get("accept")?.includes("text/html") ? "text/html; charset=utf-8" : "application/json", "Cache-Control": "no-store" } },
    );
    let origin;
    try {
      origin = new URL(env.AUTOSOCIAL_ORIGIN);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid origin");
    } catch { return unavailable("The AutoSocial server has not been connected yet."); }
    const incoming = new URL(request.url);
    if (incoming.origin === origin.origin) return unavailable("The server address must differ from the site address.");
    const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const sourceOrigin = request.headers.get("Origin");
    const sourceReferer = request.headers.get("Referer");
    if (unsafeMethod) {
      const source = sourceOrigin || sourceReferer;
      let sameOrigin = !source;
      if (source) {
        try { sameOrigin = new URL(source).origin === incoming.origin; } catch { sameOrigin = false; }
      }
      if (!sameOrigin || (!source && request.headers.get("Sec-Fetch-Site") === "cross-site")) {
        return unavailable("Cross-origin dashboard requests are blocked.", 403);
      }
    }
    if (Number(request.headers.get("Content-Length")) > 95 * 1024 * 1024) {
      return unavailable("This Sites upload exceeds 95 MB. Use a smaller video or open the server dashboard to upload it.", 413);
    }
    const target = new URL(origin);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const headers = new Headers(request.headers);
    for (const name of ["host", "authorization", "x-forwarded-for", "x-forwarded-host", "oai-authenticated-user-id", "oai-authenticated-user-email", "oai-authenticated-user-full-name"]) headers.delete(name);
    // Validate the browser's origin at this gateway before translating it for the upstream host.
    if (unsafeMethod && sourceOrigin) headers.set("Origin", origin.origin);
    if (unsafeMethod && sourceReferer) {
      try {
        const referer = new URL(sourceReferer);
        if (referer.origin === incoming.origin) {
          referer.protocol = origin.protocol;
          referer.host = origin.host;
          headers.set("Referer", referer.href);
        } else headers.delete("Referer");
      } catch { headers.delete("Referer"); }
    }
    headers.set("X-Forwarded-Proto", "https");
    try {
      const upstream = await fetch(target, {
        method: request.method, headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "manual",
      });
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set("Cache-Control", "no-store");
      const location = responseHeaders.get("Location");
      if (location) {
        const redirect = new URL(location, origin);
        if (redirect.origin === origin.origin) responseHeaders.set("Location", `${incoming.origin}${redirect.pathname}${redirect.search}${redirect.hash}`);
      }
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch { return unavailable("The AutoSocial server is unavailable. Check that it is running and try again.", 502); }
  },
};
