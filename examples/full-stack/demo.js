import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkboardClient, renderBoardMarkup } from "./frontend/app.js";
import { createWorkboardService } from "./backend/service.js";
import { openTaskStore } from "./backend/store.js";

const directory = await mkdtemp(join(tmpdir(), "mermaid-spec-workboard-"));
const file = join(directory, "workboard.sqlite");
let store = openTaskStore(file);
const entries = [];

try {
  const service = createWorkboardService({ store, logger: { info: (entry) => entries.push(entry), error: (entry) => entries.push(entry) } });
  const client = createWorkboardClient((url, init) => service(new Request(url, init)), { baseUrl: "https://workboard.local" });
  const created = await client.create({ title: "Ship contract gate", description: "Verify UI, API, state, and persistence together." });
  await client.transition(created.id, "start");
  await client.transition(created.id, "complete");
  store.close();

  store = openTaskStore(file);
  const persisted = store.list({ limit: 20 }).items;
  const markup = renderBoardMarkup(persisted);
  if (persisted[0]?.status !== "Done" || !markup.includes("Ship contract gate")) throw new Error("Full-stack state did not survive restart");
  if (!entries.some((entry) => entry.event === "request.completed" && entry.status === 200)) throw new Error("Request completion was not observed");
  console.log("Workboard completed a UI-driven workflow and recovered it from persistent storage");
} finally {
  store.close();
  await rm(directory, { recursive: true, force: true });
}
