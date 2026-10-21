const PUBLIC_CACHE_PREFIX = "autosocial-public-";
const PUBLIC_CACHE = PUBLIC_CACHE_PREFIX + "v1";
const OFFLINE_PATH = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // Only this generic page belongs in Cache Storage. Never store account data.
    const request = new Request(new URL(OFFLINE_PATH, self.location.origin), { cache: "reload", credentials: "omit", redirect: "error" });
    const response = await fetch(request);
    if (!response.ok || response.redirected || !response.headers.get("content-type")?.includes("text/html")) throw new Error("Offline page unavailable");
    const cache = await caches.open(PUBLIC_CACHE);
    await cache.put(OFFLINE_PATH, response);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(PUBLIC_CACHE_PREFIX) && name !== PUBLIC_CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function offlineResponse() {
  const cache = await caches.open(PUBLIC_CACHE);
  const fallback = await cache.match(OFFLINE_PATH);
  const html = fallback ? await fallback.text() : '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AutoSocial — нет связи</title><h1>Нет связи с AutoSocial</h1><p>Подключитесь к интернету и повторите.</p><form action="/" method="get"><button type="submit">Повторить подключение</button></form></html>';
  return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // API calls, media, scripts, styles, and third-party resources use the network directly.
  if (request.method !== "GET" || request.mode !== "navigate" || url.origin !== self.location.origin || !["/", "/index.html", "/login"].includes(url.pathname)) return;
  // A successful private response is returned immediately and is never cached.
  event.respondWith(fetch(request, { cache: "no-store" }).catch(offlineResponse));
});
