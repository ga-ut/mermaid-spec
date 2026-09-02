import { createApiHandler } from "./generated/api.generated.js";
import { IssueLifecycle, transitionIssueLifecycleRecord } from "./generated/issue-lifecycle.machine.generated.js";
import { issueLifecycleHandlers } from "./scenario-handlers.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

const issues = new Map();
const comments = new Map();

const api = createApiHandler({
  async createIssue({ body }) {
    if (body.status !== IssueLifecycle.initial || issues.has(body.id)) return { status: 400 };
    issues.set(body.id, body);
    return { status: 201, body };
  },
  async getIssue({ params }) {
    const issue = issues.get(params.issueId);
    return issue ? { status: 200, body: issue } : { status: 404 };
  },
  async updateIssue({ params, body }) {
    if (params.issueId !== body.id) return { status: 400 };
    if (!issues.has(params.issueId)) return { status: 404 };
    issues.set(body.id, body);
    return { status: 200, body };
  },
  async addComment({ params, body }) {
    if (params.issueId !== body.issueId) return { status: 400 };
    if (!issues.has(params.issueId)) return { status: 404 };
    comments.set(body.id, body);
    return { status: 201, body };
  },
});

async function request(path, { method = "GET", body } = {}) {
  return api(new Request(`https://issue-tracker.test${path}`, {
    method,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  }));
}

const now = "2026-09-01T09:00:00.000Z";
const reporterId = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000002";
const issue = {
  id: issueId,
  userId: reporterId,
  title: "Generated contracts reject invalid payloads",
  description: "Exercise a complete issue workflow through the generated Fetch router.",
  status: IssueLifecycle.initial,
  createdAt: now,
  updatedAt: now,
};

const created = await request("/issues", { method: "POST", body: issue });
equal(created.status, 201, "createIssue status");

const invalid = await request("/issues", { method: "POST", body: { ...issue, unexpected: true } });
equal(invalid.status, 400, "generated request validation");

const started = await transitionIssueLifecycleRecord(issue, "start", {}, issueLifecycleHandlers);
equal(started.state, "InProgress", "state transition");

const startedIssue = { ...started.record, updatedAt: "2026-09-01T09:05:00.000Z" };
const updated = await request(`/issues/${issueId}`, { method: "PUT", body: startedIssue });
equal(updated.status, 200, "updateIssue status");

const loaded = await request(`/issues/${issueId}`);
equal(loaded.status, 200, "getIssue status");
equal((await loaded.json()).status, "InProgress", "persisted issue status");

const comment = {
  id: "00000000-0000-4000-8000-000000000003",
  issueId,
  userId: reporterId,
  body: "The bounded product slice passed its generated contracts.",
  createdAt: "2026-09-01T09:10:00.000Z",
};
const commented = await request(`/issues/${issueId}/comments`, { method: "POST", body: comment });
equal(commented.status, 201, "addComment status");
assert(comments.has(comment.id), "comment was not persisted by the application handler");

console.log("Issue tracker API, validation, persistence handlers, and lifecycle completed from generated specifications");
