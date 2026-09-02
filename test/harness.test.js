import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareContractGraphs, createContractContext, createContractGraph, loadTraceConfiguration, validateTraceConfiguration } from "../src/index.js";

function project(titleType = "string") {
  return {
    model: {
      entities: [
        { name: "USER", attributes: [{ type: "uuid", name: "id", keys: ["PK"] }] },
        { name: "TASK", attributes: [{ type: "uuid", name: "id", keys: ["PK"] }, { type: titleType, name: "title", keys: [] }] },
      ],
      relationships: [{ from: "USER", fromCardinality: "||", toCardinality: "o{", to: "TASK", label: "owns" }],
    },
    apiContract: {
      operations: [{ method: "POST", path: "/tasks", operationId: "createTask", requestModel: "TASK", responses: [{ status: "201", model: "TASK" }] }],
    },
    machines: [{
      name: "TaskLifecycle",
      initial: "Open",
      states: ["Done", "Open"],
      terminal: ["Done"],
      transitions: [{ from: "Open", event: "complete", to: "Done", guard: "canComplete", effect: "recordCompletion" }],
    }],
  };
}

function nestedProject(titleType = "string") {
  return {
    model: {
      entities: [
        { name: "TASK", attributes: [{ type: "uuid", name: "id", keys: ["PK"] }, { type: titleType, name: "title", keys: [] }] },
        { name: "TASK_LIST", attributes: [{ type: "TASK", name: "items", keys: [], array: true }] },
        {
          name: "TASK_REFERENCES",
          attributes: [
            { type: "TASK", name: "direct", keys: [] },
            { type: "TASK", name: "array", keys: [], array: true },
            { type: "TASK", name: "optional", keys: [], optional: true },
            { type: "TASK", name: "nullable", keys: [], nullable: true },
            { type: "string", name: "primitiveArray", keys: [], array: true },
          ],
        },
      ],
      relationships: [],
    },
    apiContract: {
      operations: [{ method: "GET", path: "/tasks", operationId: "listTasks", responses: [{ status: "200", model: "TASK_LIST" }] }],
    },
    machines: [],
  };
}

const origins = {
  models: { User: { file: "domain.md" }, Task: { file: "domain.md" } },
  operations: { createTask: { file: "api.md" } },
  machines: { TaskLifecycle: { file: "lifecycle.md" } },
};

test("builds stable contract identities and dependency edges", () => {
  const graph = createContractGraph(project(), origins);
  expect(graph.nodes.map((node) => node.id)).toContain("model:Task");
  expect(graph.nodes.map((node) => node.id)).toContain("operation:createTask");
  expect(graph.nodes.map((node) => node.id)).toContain("transition:TaskLifecycle:Open:complete");
  expect(graph.nodes.map((node) => node.id)).toContain("guard:TaskLifecycle:canComplete");
  expect(graph.nodes.map((node) => node.id)).toContain("effect:TaskLifecycle:recordCompletion");
  expect(graph.edges).toContainEqual({ from: "operation:createTask", to: "model:Task", relation: "request" });
  expect(graph.nodes.find((node) => node.id === "operation:createTask").source.file).toBe("api.md");
});

test("connects direct, array, optional, and nullable model fields to their referenced model", () => {
  const graph = createContractGraph(nestedProject());
  expect(graph.edges).toEqual(expect.arrayContaining([
    { from: "model:TaskList", to: "model:Task", relation: "field:items" },
    { from: "model:TaskReferences", to: "model:Task", relation: "field:direct" },
    { from: "model:TaskReferences", to: "model:Task", relation: "field:array" },
    { from: "model:TaskReferences", to: "model:Task", relation: "field:optional" },
    { from: "model:TaskReferences", to: "model:Task", relation: "field:nullable" },
  ]));
  expect(graph.edges.some((edge) => edge.relation === "field:primitiveArray")).toBe(false);
});

test("validates explicit implementation and test trace links", async () => {
  const root = await mkdtemp(join(tmpdir(), "mermaid-spec-trace-"));
  await Bun.write(join(root, "implementation.js"), "export function createTask() {}\n");
  await Bun.write(join(root, "contract.test.js"), "export const covered = true;\n");
  await Bun.write(join(root, "links.json"), `${JSON.stringify({
    version: 1,
    links: [
      { contract: "operation:createTask", role: "implementation", path: "implementation.js" },
      { contract: "operation:createTask", role: "test", path: "contract.test.js" },
    ],
    requirements: [{ kind: "operation", roles: ["implementation", "test"] }],
  })}\n`);

  const graph = createContractGraph(project(), origins);
  const trace = await loadTraceConfiguration(join(root, "links.json"));
  const validation = await validateTraceConfiguration(graph, trace);
  expect(validation.valid).toBe(true);
  expect(validation.coverage["operation:createTask"]).toEqual(["implementation", "test"]);
  expect(validation.coverageGaps).toEqual([]);

  const context = await createContractContext(graph, "operation:createTask", validation.links, { includeFiles: true });
  expect(context.dependencies.map((item) => item.contract.id)).toEqual(["model:Task", "model:Task"]);
  expect(context.links).toHaveLength(2);
  expect(context.linkedFiles[0].content).toContain("createTask");
  await expect(createContractContext(graph, "operation:missing")).rejects.toThrow("Unknown contract");
});

test("reports invalid trace configuration without guessing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mermaid-spec-invalid-trace-"));
  await Bun.write(join(root, "links.json"), `${JSON.stringify({
    version: 2,
    links: [
      { contract: "operation:missing", role: "owner", path: "missing.js" },
      { contract: "operation:missing", role: "owner", path: "missing.js" },
      null,
    ],
    requirements: [{ kind: "operation", roles: ["test"] }, { kind: "screen", roles: ["test"] }, { kind: "operation" }],
  })}\n`);
  const trace = await loadTraceConfiguration(join(root, "links.json"));
  const result = await validateTraceConfiguration(createContractGraph(project(), origins), trace);
  expect(result.valid).toBe(false);
  expect(result.diagnostics).toEqual(expect.arrayContaining([
    "Trace configuration must declare version 1",
    "Link 1 references unknown contract 'operation:missing'",
    "Link 1 has unsupported role 'owner'",
    "Linked file does not exist: missing.js",
    "Requirement 2 has unsupported contract kind 'screen'",
    "Contract 'operation:createTask' requires a test link",
  ]));
  expect(result.coverageGaps).toContainEqual({ contract: "operation:createTask", kind: "operation", role: "test" });
});

test("reports incomplete coverage without blocking bootstrap discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "mermaid-spec-bootstrap-trace-"));
  await Bun.write(join(root, "links.json"), `${JSON.stringify({
    version: 1,
    links: [],
    requirements: [{ kind: "operation", roles: ["implementation", "test"] }],
  })}\n`);
  const trace = await loadTraceConfiguration(join(root, "links.json"));
  const result = await validateTraceConfiguration(createContractGraph(project(), origins), trace, { enforceCoverage: false });

  expect(result.valid).toBe(true);
  expect(result.diagnostics).toEqual([]);
  expect(result.coverageGaps).toEqual([
    { contract: "operation:createTask", kind: "operation", role: "implementation" },
    { contract: "operation:createTask", kind: "operation", role: "test" },
  ]);
});

test("rejects linked files outside the trace directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "mermaid-spec-contained-trace-"));
  await Bun.write(join(root, "links.json"), `${JSON.stringify({
    version: 1,
    links: [{ contract: "operation:createTask", role: "implementation", path: "../outside.js" }],
  })}\n`);
  const trace = await loadTraceConfiguration(join(root, "links.json"));
  const result = await validateTraceConfiguration(createContractGraph(project(), origins), trace);
  expect(result.valid).toBe(false);
  expect(result.diagnostics).toContain("Linked path must stay inside the trace directory: ../outside.js");
  expect(result.links).toHaveLength(0);
});

test("propagates model changes to operations and their linked tests", () => {
  const baseline = createContractGraph(project(), origins);
  const current = createContractGraph(project("text"), origins);
  const links = [
    { contract: "operation:createTask", role: "implementation", path: "src/create-task.js", absolutePath: "/tmp/create-task.js" },
    { contract: "operation:createTask", role: "test", path: "test/create-task.test.js", absolutePath: "/tmp/create-task.test.js" },
  ];
  const impact = compareContractGraphs(current, baseline, links);
  expect(impact.changes.modified).toContain("model:Task");
  expect(impact.affected).toContain("operation:createTask");
  expect(impact.tests).toEqual(["test/create-task.test.js"]);
  expect(impact.reviewRequired).toEqual(["src/create-task.js"]);

  const withoutOperation = structuredClone(current);
  withoutOperation.nodes = withoutOperation.nodes.filter((node) => node.id !== "operation:createTask");
  withoutOperation.edges = withoutOperation.edges.filter((edge) => edge.from !== "operation:createTask");
  expect(compareContractGraphs(withoutOperation, current).changes.removed).toEqual(["operation:createTask"]);
  expect(() => compareContractGraphs({ version: 2 }, baseline)).toThrow("version 1");
});

test("propagates nested model changes through response wrappers to linked code", () => {
  const baseline = createContractGraph(nestedProject());
  const current = createContractGraph(nestedProject("text"));
  const links = [
    { contract: "operation:listTasks", role: "consumer", path: "frontend/tasks.js", absolutePath: "/tmp/tasks.js" },
    { contract: "operation:listTasks", role: "test", path: "test/list-tasks.test.js", absolutePath: "/tmp/list-tasks.test.js" },
  ];

  const impact = compareContractGraphs(current, baseline, links);
  expect(impact.changes.modified).toContain("model:Task");
  expect(impact.affected).toEqual(expect.arrayContaining(["model:Task", "model:TaskList", "operation:listTasks"]));
  expect(impact.tests).toEqual(["test/list-tasks.test.js"]);
  expect(impact.reviewRequired).toEqual(["frontend/tasks.js"]);
});
