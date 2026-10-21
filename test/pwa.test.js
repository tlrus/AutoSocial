const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function worker(fetchImplementation) {
  const listeners = new Map();
  const stores = new Map();
  const requests = [];
  const cacheStorage = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async put(key, response) { store.set(key, response.clone()); },
        async match(key) { return store.get(key)?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(key) { return stores.delete(key); },
  };
  const context = {
    Request, Response, URL, caches: cacheStorage,
    self: {
      location: { origin: "https://autosocial.example" },
      addEventListener(type, callback) { listeners.set(type, callback); },
      async skipWaiting() {}, clients: { async claim() {} },
    },
    async fetch(request, options) {
      requests.push({ request, options });
      return fetchImplementation(request, options);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/sw.js"), "utf8"), context, { filename: "sw.js" });
  return {
    stores, requests,
    async lifecycle(type) {
      let work;
      listeners.get(type)({ waitUntil(promise) { work = promise; } });
      await work;
    },
    request(pathname, { mode = "navigate", method = "GET", origin = "https://autosocial.example" } = {}) {
      let response;
      listeners.get("fetch")({
        request: { url: origin + pathname, method, mode },
        respondWith(promise) { response = promise; },
      });
      return response;
    },
  };
}

test("PWA offline storage contains only the anonymous generic fallback", async () => {
  const offlinePage = "<h1>No connection</h1>";
  let available = true;
  const runtime = worker(async (request) => {
    if (request.url.endsWith("/offline.html")) return new Response(offlinePage, { headers: { "Content-Type": "text/html" } });
    if (!available) throw new Error("Disconnected");
    return new Response("Private account content", { headers: { "Content-Type": "text/html" } });
  });
  await runtime.lifecycle("install");
  assert.equal(runtime.requests[0].request.credentials, "omit");
  assert.equal(runtime.requests[0].request.redirect, "error");
  assert.equal(await (await runtime.request("/")).text(), "Private account content");
  assert.equal(await (await runtime.request("/login")).text(), "Private account content");
  assert.equal(runtime.requests.at(-1).options.cache, "no-store");
  const entries = [...runtime.stores.values()].flatMap((store) => [...store.keys()]);
  assert.deepEqual(entries, ["/offline.html"]);
  available = false;
  const fallback = await runtime.request("/");
  assert.equal(fallback.status, 503);
  assert.equal(fallback.headers.get("cache-control"), "no-store");
  assert.equal(await fallback.text(), offlinePage);
});

test("PWA worker never intercepts API requests, media, uploads, or private assets", () => {
  const runtime = worker(async () => { throw new Error("Unexpected network request"); });
  for (const pathname of ["/api/account-data", "/api/auth/login", "/api/account-data/media", "/user-assets/photo.png", "/app.js", "/style.css"]) {
    assert.equal(runtime.request(pathname), undefined, pathname);
    assert.equal(runtime.request(pathname, { mode: "cors" }), undefined, pathname);
  }
  assert.equal(runtime.request("/", { method: "POST" }), undefined);
  assert.equal(runtime.request("/", { mode: "cors" }), undefined);
  assert.equal(runtime.request("/", { origin: "https://another.example" }), undefined);
  assert.equal(runtime.requests.length, 0);
});

test("PWA installation rejects a redirected login page instead of caching it", async () => {
  const response = new Response("Private login page", { headers: { "Content-Type": "text/html" } });
  Object.defineProperty(response, "redirected", { value: true });
  const runtime = worker(async () => response);
  await assert.rejects(runtime.lifecycle("install"), /Offline page unavailable/);
  assert.equal(runtime.stores.size, 0);
});

test("PWA updates remove only their own obsolete public cache", async () => {
  const runtime = worker(async () => new Response("<h1>Offline</h1>", { headers: { "Content-Type": "text/html" } }));
  runtime.stores.set("autosocial-public-v0", new Map());
  runtime.stores.set("another-app-cache", new Map());
  await runtime.lifecycle("install");
  await runtime.lifecycle("activate");
  assert.equal(runtime.stores.has("autosocial-public-v0"), false);
  assert.equal(runtime.stores.has("autosocial-public-v1"), true);
  assert.equal(runtime.stores.has("another-app-cache"), true);
});
