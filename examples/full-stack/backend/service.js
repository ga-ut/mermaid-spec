import { InvalidTransitionError } from "@ga-ut/mermaid-spec/runtime";
import { createApiHandler } from "../generated/api.generated.js";
import { TaskLifecycle, transitionTaskLifecycleRecord } from "../generated/task-lifecycle.machine.generated.js";
import { taskLifecycleHandlers } from "./lifecycle.js";

function errorResponse(status, code, message) {
  return { status, body: { code, message } };
}

export function createWorkboardService({ store, actors = new Set(["demo-user"]), clock = () => new Date().toISOString(), logger = console }) {
  function actor(request) {
    const value = request.headers["x-actor-id"];
    return actors.has(value) ? value : null;
  }

  const api = createApiHandler({
    async listTasks(request) {
      if (!actor(request)) return errorResponse(401, "access_denied", "This workspace is not available to the current actor.");
      const body = store.list({ cursor: request.queryParams.cursor, limit: request.queryParams.limit ?? 20 });
      return { status: 200, body };
    },
    async createTask(request) {
      const assignee = actor(request);
      if (!assignee) return errorResponse(401, "access_denied", "This workspace is not available to the current actor.");
      const now = clock();
      const task = {
        id: crypto.randomUUID(),
        title: request.body.title,
        description: request.body.description,
        status: TaskLifecycle.initial,
        assignee,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      try {
        return { status: 201, body: store.create(task) };
      } catch {
        return errorResponse(409, "write_conflict", "The task could not be created.");
      }
    },
    async transitionTask(request) {
      if (!actor(request)) return errorResponse(401, "access_denied", "This workspace is not available to the current actor.");
      const current = store.get(request.params["task-id"]);
      if (!current) return errorResponse(404, "task_not_found", "The task no longer exists.");
      let transitioned;
      try {
        transitioned = await transitionTaskLifecycleRecord(current, request.body.event, { confirmed: request.body.confirmed === true }, taskLifecycleHandlers);
      } catch (cause) {
        if (cause instanceof InvalidTransitionError) return errorResponse(409, "transition_rejected", "The task cannot move to that state.");
        throw cause;
      }
      const saved = store.updateStatus({ ...transitioned.record, updatedAt: clock() }, current.version);
      return saved ? { status: 200, body: saved } : errorResponse(409, "write_conflict", "The task changed before this update was saved.");
    },
  });

  return async function workboard(request) {
    const startedAt = performance.now();
    let response;
    try {
      response = await api(request);
    } catch (cause) {
      logger.error?.({ event: "request.failed", method: request.method, path: new URL(request.url).pathname, message: cause instanceof Error ? cause.message : String(cause) });
      response = Response.json({ code: "internal_error", message: "The request could not be completed." }, { status: 500 });
    }
    logger.info?.({ event: "request.completed", method: request.method, path: new URL(request.url).pathname, status: response.status, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 });
    return response;
  };
}
