import { expect, test } from "bun:test";
import { compareContractCompatibility, createContractGraph } from "../src/index.js";

function graph({ fields, operation = {}, machine = {} }) {
  return createContractGraph({
    model: {
      entities: [{ name: "TASK", role: "table", attributes: fields }],
      relationships: [],
    },
    apiContract: {
      operations: [{
        method: "POST",
        path: "/tasks",
        operationId: "createTask",
        requestModel: "TASK",
        responses: [{ status: "201", model: "TASK" }],
        ...operation,
      }],
    },
    machines: [{
      name: "TaskFlow",
      initial: "Open",
      states: ["Done", "Open"],
      terminal: ["Done"],
      transitions: [{ from: "Open", event: "complete", to: "Done" }],
      ...machine,
    }],
  });
}

const baseFields = [
  { type: "uuid", name: "id", keys: ["PK"] },
  { type: "string", name: "title", keys: [] },
];

test("classifies optional columns as compatible safe migrations", () => {
  const baseline = graph({ fields: baseFields });
  const current = graph({ fields: [...baseFields, { type: "text", name: "description", keys: [], optional: true }] });
  const report = compareContractCompatibility(current, baseline);
  expect(report.compatible).toBe(true);
  expect(report.changes).toContainEqual(expect.objectContaining({ code: "OPTIONAL_FIELD_ADDED", level: "non-breaking" }));
  expect(report.migrations).toContainEqual(expect.objectContaining({ action: "add-column", safety: "safe" }));
  expect(report.migrations[0].sql).toContain("ALTER TABLE \"task\" ADD COLUMN \"description\" TEXT");
});

test("blocks required additions and destructive model changes", () => {
  const baseline = graph({ fields: baseFields });
  const required = graph({ fields: [...baseFields, { type: "text", name: "description", keys: [] }] });
  const requiredReport = compareContractCompatibility(required, baseline);
  expect(requiredReport.compatible).toBe(false);
  expect(requiredReport.migrationSafe).toBe(false);
  expect(requiredReport.changes).toContainEqual(expect.objectContaining({ code: "REQUIRED_FIELD_ADDED", level: "breaking" }));
  expect(requiredReport.migrations).toContainEqual(expect.objectContaining({ safety: "unsafe", action: "add-column", sql: null }));

  const removed = graph({ fields: [baseFields[0]] });
  const removedReport = compareContractCompatibility(removed, baseline);
  expect(removedReport.changes).toContainEqual(expect.objectContaining({ code: "FIELD_REMOVED" }));
  expect(removedReport.migrations).toContainEqual(expect.objectContaining({ action: "drop-column", safety: "unsafe" }));
});

test("detects breaking HTTP and state-machine changes", () => {
  const baseline = graph({ fields: baseFields });
  const current = graph({
    fields: baseFields,
    operation: {
      access: { scheme: "bearer" },
      parameters: [{ in: "query", name: "limit", type: "int", required: true }],
      responses: [{ status: "200", model: "TASK" }],
    },
    machine: { states: ["Done", "Open", "Paused"] },
  });
  const report = compareContractCompatibility(current, baseline);
  expect(report.compatible).toBe(false);
  expect(report.changes.map((item) => item.code)).toEqual(expect.arrayContaining([
    "ACCESS_CHANGED",
    "REQUIRED_PARAMETER_ADDED",
    "RESPONSE_ADDED",
    "RESPONSE_REMOVED",
    "MACHINE_SHAPE_CHANGED",
  ]));
});

test("plans additive tables and rejects invalid graph versions", () => {
  const baseline = graph({ fields: baseFields });
  const current = structuredClone(baseline);
  const extra = createContractGraph({
    model: { entities: [{ name: "AUDIT", role: "table", attributes: [{ type: "uuid", name: "id", keys: ["PK"] }] }], relationships: [] },
    apiContract: { operations: [] },
    machines: [],
  });
  current.nodes.push(...extra.nodes);
  current.nodes.sort((left, right) => left.id.localeCompare(right.id));
  const report = compareContractCompatibility(current, baseline);
  expect(report.changes).toContainEqual(expect.objectContaining({ code: "MODEL_ADDED" }));
  expect(report.migrations).toContainEqual(expect.objectContaining({ action: "add-table", safety: "safe", sql: expect.stringContaining("CREATE TABLE \"audit\"") }));
  expect(() => compareContractCompatibility({ version: 2 }, baseline)).toThrow(/version 1/);
});

test("classifies tightened fields, removed models, and changed transitions", () => {
  const baseline = graph({ fields: [{ type: "string", name: "title", keys: [], optional: true, minLength: 1 }] });
  const tightened = graph({ fields: [{ type: "string", name: "title", keys: [], minLength: 3 }] });
  const tightenedReport = compareContractCompatibility(tightened, baseline);
  expect(tightenedReport.changes).toContainEqual(expect.objectContaining({ code: "FIELD_CONSTRAINT_TIGHTENED", level: "breaking" }));
  expect(tightenedReport.migrations).toContainEqual(expect.objectContaining({ action: "alter-column", safety: "review" }));

  const changedTransition = graph({ fields: baseFields, machine: { transitions: [{ from: "Open", event: "complete", to: "Open" }] } });
  expect(compareContractCompatibility(changedTransition, graph({ fields: baseFields })).changes).toContainEqual(expect.objectContaining({ code: "TRANSITION_CHANGED" }));

  const withoutModel = structuredClone(graph({ fields: baseFields }));
  withoutModel.nodes = withoutModel.nodes.filter((node) => node.kind !== "model");
  withoutModel.edges = withoutModel.edges.filter((edge) => !edge.to.startsWith("model:"));
  const removed = compareContractCompatibility(withoutModel, graph({ fields: baseFields }));
  expect(removed.changes).toContainEqual(expect.objectContaining({ code: "MODEL_REMOVED" }));
  expect(removed.migrations).toContainEqual(expect.objectContaining({ action: "drop-table", safety: "unsafe" }));
});

test("emits review plans for defaults without applying them", () => {
  const baseline = graph({ fields: baseFields });
  const current = graph({ fields: [
    ...baseFields,
    { type: "string", name: "mode", keys: [], default: "standard" },
    { type: "boolean", name: "enabled", keys: [], default: true },
    { type: "text", name: "note", keys: [], default: null },
  ] });
  const report = compareContractCompatibility(current, baseline);
  expect(report.migrations.every((item) => item.safety === "review")).toBe(true);
  expect(report.migrations.map((item) => item.sql).join("\n")).toContain("DEFAULT 'standard'");
  expect(report.migrations.map((item) => item.sql).join("\n")).toContain("DEFAULT TRUE");
  expect(report.migrations.map((item) => item.sql).join("\n")).toContain("DEFAULT NULL");
});
