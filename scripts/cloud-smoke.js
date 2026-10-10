// Read-only cloud checks, apart from a short-lived dashboard login/logout session.
const fs = require("node:fs/promises");

async function main() {
  const url = new URL(process.argv[2] || "http://127.0.0.1:3000");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("Provide the dashboard origin only.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Cloud checks require verified HTTPS.");
  const origin = url.origin;
  const get = (route, cookie) => fetch(origin + route, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: cookie ? { Cookie: cookie } : {} });
  const health = await get("/healthz");
  if (health.status !== 200 || !(await health.json()).ok) throw new Error("Health endpoint failed.");
  if ((await get("/api/accounts")).status !== 401 || (await get("/api/agents/status")).status !== 401) throw new Error("Dashboard is not protected.");
  let signedIn = false, agentsAvailable = null, catalogSize = null, mediaPreviews = 0;
  const file = process.env.AUTOSOCIAL_SMOKE_PASSWORD_FILE;
  if (file) {
    const raw = await fs.readFile(file, "utf8");
    const password = raw.match(/password:\s*(.+)/i)?.[1]?.trim() || raw.trim();
    const login = await fetch(origin + "/api/auth/login", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ password }) });
    if (!login.ok) throw new Error("Dashboard login failed.");
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Dashboard session cookie was not returned.");
    try {
      for (const route of ["/", "/api/accounts", "/api/calendar/posts", "/api/overview"]) {
        const response = await get(route, cookie);
        if (response.status !== 200) throw new Error("Authenticated dashboard check failed.");
        if (route === "/api/calendar/posts") {
          const data = await response.json();
          for (const post of (data.posts || []).slice(0, 1)) {
            const media = await get(`/api/calendar/posts/${encodeURIComponent(post.id)}/media`, cookie);
            if (!media.ok || !(await media.arrayBuffer()).byteLength) throw new Error("Migrated calendar media preview failed.");
            mediaPreviews++;
          }
        }
      }
      const response = await get("/api/agents/status", cookie);
      if (!response.ok) throw new Error("Agent API check failed.");
      const status = await response.json();
      catalogSize = status.agents?.length; agentsAvailable = Boolean(status.available);
      if (catalogSize !== 17) throw new Error("Agent catalog is incomplete.");
      if (process.argv.includes("--require-model") && !agentsAvailable) throw new Error("No cloud Ollama model is ready.");
      signedIn = true;
    } finally {
      await fetch(origin + "/api/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: origin }, signal: AbortSignal.timeout(15000) });
    }
  }
  console.log(JSON.stringify({ origin, health: true, anonymousAccessBlocked: true, signedIn, agentsAvailable, catalogSize, mediaPreviews, publicationsSent: 0, paidInferenceCalls: 0 }));
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
