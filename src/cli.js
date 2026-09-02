#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProject, compareContractCompatibility, compareContractGraphs, compileProject, createContractContext, emitTypeScript, extractMermaidDiagrams, loadTraceConfiguration, parseStateDiagram, testExamples, testProject, testProjectScenarios, testScenarios, validateStateMachine, validateTraceConfiguration, verifyProject } from "./index.js";

function usage() {
  console.error("Usage: mermaid-spec <check|test|ir|emit|build|verify|graph|context|impact|compatibility|migration> <path> [options]");
}

function option(args, key) {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
}

function graphSummary(graph, trace) {
  const counts = Object.groupBy(graph.nodes, (node) => node.kind);
  const lines = [
    `Contract graph: ${graph.nodes.length} nodes, ${graph.edges.length} dependencies`,
    ...Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)).map(([kind, nodes]) => `  ${kind}: ${nodes.length}`),
  ];
  if (trace) lines.push(`Trace links: ${trace.links.length} verified`);
  return `${lines.join("\n")}\n`;
}

function contextSummary(context) {
  const lines = [
    `${context.subject.id} (${context.subject.kind})`,
    `Source: ${context.subject.source?.file ?? "unknown"}`,
    "Dependencies:",
    ...context.dependencies.map((item) => `  ${item.relation} -> ${item.contract.id}`),
    "Dependents:",
    ...context.dependents.map((item) => `  ${item.relation} <- ${item.contract.id}`),
    "Linked files:",
    ...context.links.map((link) => `  ${link.role}: ${link.path}`),
  ];
  if (context.coverageGaps?.length) {
    lines.push("Missing required links:", ...context.coverageGaps.map((gap) => `  ${gap.role}: ${gap.contract}`));
  }
  if (context.linkedFiles) {
    for (const file of context.linkedFiles) lines.push(`\n## ${file.role}: ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``);
  }
  return `${lines.join("\n")}\n`;
}

function impactSummary(impact) {
  const lines = [
    `Contract changes: ${impact.changes.added.length} added, ${impact.changes.modified.length} modified, ${impact.changes.removed.length} removed`,
    ...impact.changes.added.map((id) => `  ADDED ${id}`),
    ...impact.changes.modified.map((id) => `  MODIFIED ${id}`),
    ...impact.changes.removed.map((id) => `  REMOVED ${id}`),
    `Affected contracts: ${impact.affected.length}`,
    ...impact.affected.map((id) => `  ${id}`),
    "Tests:",
    ...impact.tests.map((path) => `  ${path}`),
    "Review required:",
    ...impact.reviewRequired.map((path) => `  ${path}`),
  ];
  if (impact.coverageGaps?.length) {
    lines.push("Missing required links:", ...impact.coverageGaps.map((gap) => `  ${gap.contract}: ${gap.role}`));
  }
  return `${lines.join("\n")}\n`;
}

function compatibilitySummary(report) {
  const lines = [
    `Compatibility: ${report.compatible ? "PASS" : "BREAKING"} (${report.summary.breaking} breaking, ${report.summary.review} review, ${report.summary.nonBreaking} non-breaking)`,
    ...report.changes.map((item) => `  ${item.level.toUpperCase()} ${item.code} ${item.contract}: ${item.message}`),
    `Migration safety: ${report.migrationSafe ? "PASS" : "UNSAFE"} (${report.summary.safeMigrations} safe, ${report.summary.reviewMigrations} review, ${report.summary.unsafeMigrations} unsafe)`,
  ];
  return `${lines.join("\n")}\n`;
}

function migrationSummary(report) {
  const lines = [
    `Migration plan: ${report.summary.safeMigrations} safe, ${report.summary.reviewMigrations} review, ${report.summary.unsafeMigrations} unsafe`,
    ...report.migrations.flatMap((item) => [
      `  ${item.safety.toUpperCase()} ${item.action} ${item.model}${item.field ? `.${item.field}` : ""}: ${item.message}`,
      ...(item.sql ? item.sql.split("\n").map((line) => `    ${line}`) : []),
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

async function scenarioHandlers(args) {
  const file = option(args, "--handlers");
  if (!file) return {};
  const loaded = await import(pathToFileURL(resolve(file)).href);
  return loaded.default ?? loaded.handlers ?? loaded;
}

async function traceFor(args, graph, additionalContractIds = [], options = {}) {
  const file = option(args, "--links");
  if (!file) return null;
  const trace = await loadTraceConfiguration(file);
  const validation = await validateTraceConfiguration(graph, trace, { additionalContractIds, enforceCoverage: options.enforceCoverage });
  if (!validation.valid) throw new Error(validation.diagnostics.join("\n"));
  return validation;
}

async function main() {
  const [, , command, file, ...args] = Bun.argv;
  if (!command || !file || !["check", "test", "ir", "emit", "build", "verify", "graph", "context", "impact", "compatibility", "migration"].includes(command)) {
    usage();
    return 2;
  }

  if (command === "build") {
    const output = option(args, "--out") ?? "generated";
    const project = await buildProject(file, output);
    console.log(`Built ${Object.keys(project.artifacts).length} artifacts from ${project.sources.length} spec files into ${output}`);
    return 0;
  }
  if (command === "verify") {
    const output = option(args, "--out") ?? "generated";
    const result = await verifyProject(file, output);
    if (!result.valid) {
      console.error(`Generated artifacts have drift: ${result.drift.join(", ")}`);
      return 1;
    }
    const trace = await traceFor(args, result.project.graph);
    console.log(`Verified ${Object.keys(result.project.artifacts).length} generated artifacts`);
    if (trace) console.log(`Verified ${trace.links.length} implementation and test links`);
    return 0;
  }
  if (["graph", "context", "impact", "compatibility", "migration"].includes(command)) {
    const project = await compileProject(file);
    if (["impact", "compatibility", "migration"].includes(command)) {
      const baselineFile = option(args, "--baseline");
      if (!baselineFile) throw new Error(`${command} requires --baseline <contract-graph.generated.json>`);
      const baseline = await Bun.file(baselineFile).json();
      const trace = await traceFor(args, project.graph, baseline.nodes?.map((node) => node.id) ?? [], { enforceCoverage: command !== "impact" });
      if (command !== "impact") {
        const report = compareContractCompatibility(project.graph, baseline, trace?.links ?? []);
        if (command === "compatibility") {
          await Bun.write(Bun.stdout, args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : compatibilitySummary(report));
          return !report.compatible && !args.includes("--allow-breaking") ? 1 : 0;
        }
        await Bun.write(Bun.stdout, args.includes("--json") ? `${JSON.stringify({ version: report.version, migrationSafe: report.migrationSafe, summary: report.summary, migrations: report.migrations }, null, 2)}\n` : migrationSummary(report));
        return !report.migrationSafe && !args.includes("--allow-unsafe") ? 1 : 0;
      }
      const baseImpact = compareContractGraphs(project.graph, baseline, trace?.links ?? []);
      const impact = trace ? { ...baseImpact, coverageGaps: trace.coverageGaps } : baseImpact;
      await Bun.write(Bun.stdout, args.includes("--json") ? `${JSON.stringify(impact, null, 2)}\n` : impactSummary(impact));
      return 0;
    }
    const trace = await traceFor(args, project.graph, [], { enforceCoverage: command !== "context" });
    if (command === "graph") {
      const result = trace ? { ...project.graph, trace: { links: trace.links.map(({ absolutePath, ...link }) => link), coverage: trace.coverage } } : project.graph;
      await Bun.write(Bun.stdout, args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : graphSummary(project.graph, trace));
      return 0;
    }
    const contractId = option(args, "--id");
    if (!contractId) throw new Error("context requires --id <contract-id>");
    const baseContext = await createContractContext(project.graph, contractId, trace?.links ?? [], { includeFiles: args.includes("--include-files") });
    const context = trace ? { ...baseContext, coverageGaps: trace.coverageGaps.filter((gap) => gap.contract === contractId) } : baseContext;
    await Bun.write(Bun.stdout, args.includes("--json") ? `${JSON.stringify(context, null, 2)}\n` : contextSummary(context));
    return 0;
  }
  if (command === "test" && (await stat(file)).isDirectory()) {
    const project = await compileProject(file);
    const examples = testProject(project);
    const scenarios = await testProjectScenarios(project, await scenarioHandlers(args));
    if (!examples.length && !scenarios.length) throw new Error("No %% @test examples or %% @scenario cases found");
    for (const result of examples) console.log(`${result.passed ? "PASS" : "FAIL"} [${result.machine}] ${result.from} --${result.event}--> ${result.expected}`);
    for (const result of scenarios) console.log(`${result.passed ? "PASS" : "FAIL"} [${result.machine}:${result.name}] ${result.from} --${result.event}--> ${result.expected}${result.error ? ` (${result.error})` : ""}`);
    return [...examples, ...scenarios].some((result) => !result.passed) ? 1 : 0;
  }

  const source = await Bun.file(file).text();
  const diagrams = extractMermaidDiagrams(source);
  if (diagrams.length > 1) throw new Error("Multiple state diagrams require explicit names; split them into separate files for now");
  const defaultName = basename(file, extname(file)).replace(/[^A-Za-z0-9_$]/g, "_");
  const spec = parseStateDiagram(diagrams[0], { name: option(args, "--name") ?? defaultName });
  const diagnostics = validateStateMachine(spec);

  if (diagnostics.length > 0) {
    for (const item of diagnostics) console.error(`${item.level.toUpperCase()} ${item.code}: ${item.message}`);
    return 1;
  }

  if (command === "check") {
    console.log(`Valid ${spec.kind} '${spec.name}': ${spec.states.length} states, ${spec.transitions.length} transitions`);
    return 0;
  }

  if (command === "test") {
    const examples = testExamples(spec);
    const loadedHandlers = await scenarioHandlers(args);
    const handlers = loadedHandlers[spec.name] ?? loadedHandlers;
    const scenarios = await testScenarios(spec, handlers);
    if (!examples.length && !scenarios.length) throw new Error("No %% @test examples or %% @scenario cases found");
    for (const result of examples) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.from} --${result.event}--> ${result.expected}`);
    for (const result of scenarios) console.log(`${result.passed ? "PASS" : "FAIL"} [${result.name}] ${result.from} --${result.event}--> ${result.expected}${result.error ? ` (${result.error})` : ""}`);
    return [...examples, ...scenarios].some((result) => !result.passed) ? 1 : 0;
  }

  const output = command === "ir" ? `${JSON.stringify(spec, null, 2)}\n` : emitTypeScript(spec);
  const outputFile = option(args, "--out");
  if (outputFile) await Bun.write(outputFile, output);
  else await Bun.write(Bun.stdout, output);
  return 0;
}

const exitCode = await main().catch((error) => {
  console.error(error.message);
  return 1;
});

if (exitCode) process.exitCode = exitCode;
