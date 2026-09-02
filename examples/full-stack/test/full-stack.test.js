import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkboardService } from "../backend/service.js";
import { openTaskStore } from "../backend/store.js";
import { createWorkboardClient, renderBoardMarkup } from "../frontend/app.js";
import { transitionTaskLifecycle } from "../generated/task-lifecycle.machine.generated.js";
import { taskLifecycleHandlers } from "../backend/lifecycle.js";

test("runs a persistent UI, API, and state workflow with restart recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mermaid-spec-full-stack-"));
  const file = join(directory, "workboard.sqlite");
  let store = openTaskStore(file);
  const logs = [];
  const timestamps = ["2026-09-01T01:00:00.000Z", "2026-09-01T01:01:00.000Z", "2026-09-01T01:02:00.000Z"];

  try {
    expect(store.schemaVersion()).toBe(1);
    const service = createWorkboardService({
      store,
      clock: () => timestamps.shift() ?? "2026-09-01T01:03:00.000Z",
      logger: { info: (entry) => logs.push(entry), error: (entry) => logs.push(entry) },
    });
    const client = createWorkboardClient((url, init) => service(new Request(url, init)), { baseUrl: "https://workboard.test" });
    const deniedClient = createWorkboardClient((url, init) => service(new Request(url, init)), { actor: "visitor", baseUrl: "https://workboard.test" });
    await expect(deniedClient.list()).rejects.toThrow(/not available/);
    expect(await transitionTaskLifecycle("Backlog", "start", {}, taskLifecycleHandlers)).toEqual({ state: "InProgress", context: { started: true } });

    const denied = await service(new Request("https://workboard.test/tasks", { headers: { "x-actor-id": "visitor" } }));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ code: "access_denied", message: "This workspace is not available to the current actor." });

    const invalid = await service(new Request("https://workboard.test/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-actor-id": "demo-user" },
      body: JSON.stringify({ title: "x", description: "Too short" }),
    }));
    expect(invalid.status).toBe(400);

    const created = await client.create({ title: "Trace a vertical slice", description: "Keep the rendered board aligned with its contracts." });
    expect(created.status).toBe("Backlog");
    const rejected = await service(new Request(`https://workboard.test/tasks/${created.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-actor-id": "demo-user" },
      body: JSON.stringify({ event: "complete", confirmed: false }),
    }));
    expect(rejected.status).toBe(409);

    const started = await client.transition(created.id, "start");
    expect(started.status).toBe("InProgress");
    const completed = await client.transition(created.id, "complete");
    expect(completed.status).toBe("Done");
    expect(completed.version).toBe(3);
    const reopened = await client.transition(created.id, "reopen");
    expect(reopened.status).toBe("InProgress");
    const completedAgain = await client.transition(created.id, "complete");
    expect(completedAgain.status).toBe("Done");
    expect(completedAgain.version).toBe(5);

    const page = await client.list();
    expect(renderBoardMarkup(page.items)).toContain("Trace a vertical slice");
    expect(renderBoardMarkup(page.items)).toContain("data-event=\"reopen\"");
    expect(logs.some((entry) => entry.event === "request.completed" && entry.status === 200)).toBe(true);

    store.close();
    store = openTaskStore(file);
    expect(store.get(created.id)).toEqual(expect.objectContaining({ status: "Done", version: 5 }));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns a stable cursor for bounded pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mermaid-spec-full-stack-page-"));
  const store = openTaskStore(join(directory, "workboard.sqlite"));
  try {
    for (const id of ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"]) {
      store.create({ id, title: `Task ${id.at(-1)}`, description: "Pagination fixture", status: "Backlog", assignee: "demo-user", version: 1, createdAt: "2026-09-01T01:00:00.000Z", updatedAt: "2026-09-01T01:00:00.000Z" });
    }
    const first = store.list({ limit: 2 });
    const second = store.list({ cursor: first.nextCursor, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1].id);
    expect(second.items.map((task) => task.id)).toEqual(["00000000-0000-4000-8000-000000000003"]);
    expect(second.nextCursor).toBeNull();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
