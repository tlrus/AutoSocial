import { mkdir, copyFile } from "node:fs/promises";
await mkdir(new URL("./dist/server/", import.meta.url), { recursive: true });
await copyFile(new URL("./worker.mjs", import.meta.url), new URL("./dist/server/index.js", import.meta.url));
console.log("Sites Worker built at dist/server/index.js. Site registration and runtime configuration are still required.");
