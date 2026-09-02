import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createWorkboardService } from "./backend/service.js";
import { openTaskStore } from "./backend/store.js";

function option(name) {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

const dataDirectory = join(import.meta.dir, ".data");
await mkdir(dataDirectory, { recursive: true });
const databaseFile = option("--db") ?? join(dataDirectory, "workboard.sqlite");
const store = openTaskStore(databaseFile);
const service = createWorkboardService({ store });
const index = Bun.file(join(import.meta.dir, "frontend/index.html"));
const application = Bun.file(join(import.meta.dir, "frontend/app.js"));
const browserApplication = Bun.file(join(import.meta.dir, "frontend/browser.js"));

const server = Bun.serve({
  port: Number(option("--port") ?? 3000),
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (pathname === "/app.js") return new Response(application, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    if (pathname === "/browser.js") return new Response(browserApplication, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    return service(request);
  },
});

function close() {
  server.stop();
  store.close();
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
console.log(`Workboard is running at ${server.url}`);
