import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageMetadata from "../package.json";
import { buildProject, compileProject } from "../src/index.js";

const cli = join(import.meta.dir, "..", "src", "cli.js");

async function runCli(args, cwd) {
  const child = Bun.spawn({ cmd: [process.execPath, cli, ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("CLI help works without a project or filesystem input", async () => {
  for (const args of [[], ["--help"], ["-h"], ["build", "--help"], ["context", "missing-specs", "-h"]]) {
    const result = await runCli(args, tmpdir());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: mermaid-spec <command> <path> [options]");
    expect(result.stdout).toContain("--baseline <file>");
    expect(result.stdout).toContain(`Requires Bun ${packageMetadata.engines.bun}`);
  }
});

test("CLI version matches the installed package metadata", async () => {
  for (const flag of ["--version", "-v"]) {
    const result = await runCli([flag], tmpdir());
    expect(result).toEqual({ exitCode: 0, stdout: `${packageMetadata.version}\n`, stderr: "" });
  }
});

test("invalid CLI invocations still fail with a help hint", async () => {
  for (const args of [["unknown"], ["unknown", "--help"], ["build"], ["--version", "unexpected"]]) {
    const result = await runCli(args, tmpdir());
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("mermaid-spec --help");
  }
});

test("README first specification validates, detects a change, and rebuilds", async () => {
  const root = await mkdtemp(join(tmpdir(), "mermaid-spec-readme-cli-"));
  try {
    const readme = (await Bun.file(new URL("../README.md", import.meta.url)).text()).replaceAll("\r\n", "\n");
    const source = readme.match(/````markdown\n([\s\S]*?)\n````/)?.[1];
    expect(source).toBeDefined();
    const spec = join(root, "task.md");
    await Bun.write(spec, source);
    for (const command of ["check", "test", "build", "verify"]) {
      const result = await runCli([command, "./task.md"], root);
      expect(result.exitCode).toBe(0);
    }
    const changed = source.replace("Todo --> Done : complete", "Todo --> Done : finish");
    await Bun.write(spec, changed);
    const failingTest = await runCli(["test", "./task.md"], root);
    expect(failingTest.exitCode).toBe(1);
    expect(failingTest.stdout).toContain("FAIL");
    const drift = await runCli(["verify", "./task.md"], root);
    expect(drift.exitCode).toBe(1);
    expect(drift.stderr).toContain("drift");
    await Bun.write(spec, changed.replaceAll("--complete-->", "--finish-->"));
    for (const command of ["test", "build", "verify"]) {
      const result = await runCli([command, "./task.md"], root);
      expect(result.exitCode).toBe(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("impact and context guide a new contract before strict verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "mermaid-spec-bootstrap-cli-"));
  const baselineSpecs = join(root, "baseline-specs");
  const currentSpecs = join(root, "current-specs");
  const generated = join(root, "generated");
  const linksFile = join(root, "links.json");
  await mkdir(baselineSpecs);
  await mkdir(currentSpecs);

  const domain = `# Domain\n\n\`\`\`mermaid\nerDiagram\n  TASK {\n    uuid id PK\n  }\n\`\`\`\n`;
  const createOperation = `  Browser->>API: POST /tasks (createTask)\n  API-->>Browser: 201 TASK\n`;
  const archiveOperation = `  %% @param archiveTask path task-id uuid required\n  Browser->>API: POST /tasks/{task-id}/archive (archiveTask)\n  API-->>Browser: 200 TASK\n`;
  await Bun.write(join(baselineSpecs, "domain.md"), domain);
  await Bun.write(join(currentSpecs, "domain.md"), domain);
  await Bun.write(join(baselineSpecs, "api.md"), `# API\n\n\`\`\`mermaid\nsequenceDiagram\n  participant Browser\n  participant API\n${createOperation}\`\`\`\n`);
  await Bun.write(join(currentSpecs, "api.md"), `# API\n\n\`\`\`mermaid\nsequenceDiagram\n  participant Browser\n  participant API\n${createOperation}${archiveOperation}\`\`\`\n`);
  await Bun.write(join(root, "implementation.js"), "export function createTask() {}\n");
  await Bun.write(join(root, "contract.test.js"), "export const covered = true;\n");
  const links = [
    { contract: "operation:createTask", role: "implementation", path: "implementation.js" },
    { contract: "operation:createTask", role: "test", path: "contract.test.js" },
  ];
  const writeLinks = () => Bun.write(linksFile, `${JSON.stringify({
    version: 1,
    links,
    requirements: [{ kind: "operation", roles: ["implementation", "test"] }],
  })}\n`);
  await writeLinks();

  const baseline = await compileProject(baselineSpecs);
  const baselineGraph = join(root, "baseline-graph.json");
  await Bun.write(baselineGraph, `${JSON.stringify(baseline.graph, null, 2)}\n`);
  await buildProject(currentSpecs, generated);

  const impact = await runCli(["impact", currentSpecs, "--baseline", baselineGraph, "--links", linksFile, "--json"], root);
  expect(impact.exitCode).toBe(0);
  expect(JSON.parse(impact.stdout).coverageGaps).toEqual([
    { contract: "operation:archiveTask", kind: "operation", role: "implementation" },
    { contract: "operation:archiveTask", kind: "operation", role: "test" },
  ]);

  const context = await runCli(["context", currentSpecs, "--id", "operation:archiveTask", "--links", linksFile, "--json"], root);
  expect(context.exitCode).toBe(0);
  expect(JSON.parse(context.stdout).coverageGaps).toHaveLength(2);

  const verification = await runCli(["verify", currentSpecs, "--out", generated, "--links", linksFile], root);
  expect(verification.exitCode).toBe(1);
  expect(verification.stderr).toContain("Contract 'operation:archiveTask' requires an implementation link");
  expect(verification.stderr).toContain("Contract 'operation:archiveTask' requires a test link");

  await Bun.write(join(root, "archive.js"), "export function archiveTask() {}\n");
  await Bun.write(join(root, "archive.test.js"), "export const archiveCovered = true;\n");
  links.push(
    { contract: "operation:archiveTask", role: "implementation", path: "archive.js" },
    { contract: "operation:archiveTask", role: "test", path: "archive.test.js" },
  );
  await writeLinks();

  const completedVerification = await runCli(["verify", currentSpecs, "--out", generated, "--links", linksFile], root);
  expect(completedVerification.exitCode).toBe(0);

  await Bun.write(join(currentSpecs, "api.md"), `# API\n\n\`\`\`mermaid\nsequenceDiagram\n  participant Browser\n  participant API\n${createOperation}${archiveOperation.replace("200 TASK", "202 TASK")}\`\`\`\n`);
  const repeatedImpact = await runCli(["impact", currentSpecs, "--baseline", join(generated, "contract-graph.generated.json"), "--links", linksFile, "--json"], root);
  expect(repeatedImpact.exitCode).toBe(0);
  const repeatedReport = JSON.parse(repeatedImpact.stdout);
  expect(repeatedReport.changes.modified).toContain("operation:archiveTask");
  expect(repeatedReport.reviewRequired).toEqual(["archive.js"]);
  expect(repeatedReport.tests).toEqual(["archive.test.js"]);
  expect(repeatedReport.coverageGaps).toEqual([]);
});
