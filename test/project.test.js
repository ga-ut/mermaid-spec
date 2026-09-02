import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProject, compileProject, testProject, testProjectScenarios, verifyProject } from "../src/index.js";

const productSpecs = fileURLToPath(new URL("../examples/product/specs", import.meta.url));

test("compiles a product directory into deterministic artifacts", async () => {
  const project = await compileProject(productSpecs);
  expect(project.model.entities).toHaveLength(3);
  expect(project.machines[0].name).toBe("OAuthConnection");
  expect(project.artifacts["models.generated.ts"]).toBeTruthy();
  expect(project.artifacts["oauth-connection.machine.generated.js"]).toBeTruthy();
  expect(project.artifacts["openapi.generated.json"]).toBeTruthy();
  expect(project.artifacts["api.generated.js"]).toBeTruthy();
  expect(project.artifacts["api.generated.js"]).toMatch(/export const schemas/);
  expect(project.artifacts["contract-graph.generated.json"]).toBeTruthy();
  expect(JSON.parse(project.artifacts["mermaid-spec.manifest.json"]).compiler).toEqual({
    name: "mermaid-spec",
    version: "1.0.0",
  });
  expect(project.graph.nodes.map((node) => node.id)).toContain("operation:connectOAuth");
  expect(testProject(project).every((result) => result.passed)).toBe(true);
});

test("binds state models and exposes executable scenarios in the graph", async () => {
  const input = await mkdtemp(join(tmpdir(), "mermaid-spec-binding-"));
  await Bun.write(join(input, "contracts.md"), `\`\`\`mermaid
erDiagram
  %% @field ORDER.status enum=Pending,Paid
  ORDER {
    string status
  }
\`\`\`

\`\`\`mermaid
stateDiagram-v2
  %% @name OrderFlow
  %% @bind ORDER.status
  [*] --> Pending
  Pending --> Paid : pay / mark
  %% @scenario paid Pending --pay--> Paid context={} expect={"marked":true}
\`\`\`\n`);
  const project = await compileProject(input);
  expect(project.graph.edges).toContainEqual({ from: "machine:OrderFlow", to: "model:Order", relation: "state:status" });
  expect(project.graph.nodes.map((node) => node.id)).toContain("scenario:OrderFlow:paid");
  const results = await testProjectScenarios(project, { OrderFlow: { effects: { mark: (context) => ({ ...context, marked: true }) } } });
  expect(results.every((result) => result.passed)).toBe(true);
});

test("rejects a bound field whose enum drifts from machine states", async () => {
  const input = await mkdtemp(join(tmpdir(), "mermaid-spec-binding-drift-"));
  await Bun.write(join(input, "contracts.md"), `\`\`\`mermaid
erDiagram
  %% @field ORDER.status enum=Pending
  ORDER {
    string status
  }
\`\`\`

\`\`\`mermaid
stateDiagram-v2
  %% @bind ORDER.status
  [*] --> Pending
  Pending --> Paid : pay
\`\`\`\n`);
  await expect(compileProject(input)).rejects.toThrow(/enum must exactly match/);
});

test("builds and verifies generated artifacts without drift", async () => {
  const output = await mkdtemp(join(tmpdir(), "mermaid-spec-test-"));
  await buildProject(productSpecs, output);
  expect(await Bun.file(join(output, "schema.generated.sql")).text()).toMatch(/ALTER TABLE "oauth_account" ADD FOREIGN KEY \("user_id"\) REFERENCES "user"\("id"\)/);
  expect((await verifyProject(productSpecs, output)).valid).toBe(true);
});

test("rejects entity names that collide after generation", async () => {
  const input = await mkdtemp(join(tmpdir(), "mermaid-spec-collision-"));
  const file = join(input, "models.md");
  await Bun.write(file, `\`\`\`mermaid
erDiagram
  USER_RECORD {
    uuid id PK
  }
\`\`\`

\`\`\`mermaid
erDiagram
  UserRecord {
    uuid id PK
  }
\`\`\`\n`);
  await expect(compileProject(input)).rejects.toThrow(/collides with another generated TypeScript model name/);
});
