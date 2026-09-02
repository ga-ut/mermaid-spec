import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { modelTypeName } from "./model-emitter.js";

const LINK_ROLES = new Set(["implementation", "test", "consumer", "documentation"]);
const CONTRACT_KINDS = new Set(["model", "operation", "machine", "transition", "guard", "effect", "scenario"]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function graphNode(id, kind, name, details, source) {
  return { id, kind, name, fingerprint: fingerprint(details), details, ...(source ? { source } : {}) };
}

function sortGraph(graph) {
  graph.nodes.sort((left, right) => left.id.localeCompare(right.id));
  graph.edges = [...new Map(graph.edges.map((edge) => [JSON.stringify(edge), edge])).values()]
    .sort((left, right) => `${left.from}\0${left.to}\0${left.relation}`.localeCompare(`${right.from}\0${right.to}\0${right.relation}`));
  return graph;
}

/** Build stable contract identities and dependency edges from a compiled project. */
export function createContractGraph(project, origins = {}) {
  const graph = { version: 1, nodes: [], edges: [] };
  const relationships = project.model.relationships ?? [];
  const entityNames = new Set(project.model.entities.map((entity) => entity.name));

  for (const entity of project.model.entities) {
    const name = modelTypeName(entity.name);
    const related = relationships.filter((item) => item.from === entity.name || item.to === entity.name)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    graph.nodes.push(graphNode(`model:${name}`, "model", name, { entity, relationships: related }, origins.models?.[name]));
    for (const attribute of entity.attributes) {
      if (!entityNames.has(attribute.type)) continue;
      graph.edges.push({
        from: `model:${name}`,
        to: `model:${modelTypeName(attribute.type)}`,
        relation: `field:${attribute.name}`,
      });
    }
  }

  for (const operation of project.apiContract.operations) {
    const id = `operation:${operation.operationId}`;
    graph.nodes.push(graphNode(id, "operation", operation.operationId, operation, origins.operations?.[operation.operationId]));
    if (operation.requestModel) graph.edges.push({ from: id, to: `model:${modelTypeName(operation.requestModel)}`, relation: "request" });
    for (const response of operation.responses) {
      if (response.model) graph.edges.push({ from: id, to: `model:${modelTypeName(response.model)}`, relation: `response:${response.status}` });
    }
  }

  for (const machine of project.machines) {
    const machineId = `machine:${machine.name}`;
    const source = origins.machines?.[machine.name];
    graph.nodes.push(graphNode(machineId, "machine", machine.name, {
      initial: machine.initial,
      states: machine.states,
      terminal: machine.terminal,
      ...(machine.binding ? { binding: machine.binding } : {}),
    }, source));
    if (machine.binding) graph.edges.push({ from: machineId, to: `model:${modelTypeName(machine.binding.model)}`, relation: `state:${machine.binding.field}` });
    for (const transition of machine.transitions) {
      const transitionId = `transition:${machine.name}:${transition.from}:${transition.event}`;
      graph.nodes.push(graphNode(transitionId, "transition", `${transition.from} --${transition.event}--> ${transition.to}`, transition, source));
      graph.edges.push({ from: machineId, to: transitionId, relation: "transition" });
      if (transition.guard) {
        const guardId = `guard:${machine.name}:${transition.guard}`;
        if (!graph.nodes.some((node) => node.id === guardId)) graph.nodes.push(graphNode(guardId, "guard", transition.guard, { name: transition.guard }, source));
        graph.edges.push({ from: transitionId, to: guardId, relation: "guard" });
      }
      if (transition.effect) {
        const effectId = `effect:${machine.name}:${transition.effect}`;
        if (!graph.nodes.some((node) => node.id === effectId)) graph.nodes.push(graphNode(effectId, "effect", transition.effect, { name: transition.effect }, source));
        graph.edges.push({ from: transitionId, to: effectId, relation: "effect" });
      }
    }
    for (const scenario of machine.scenarios ?? []) {
      const scenarioId = `scenario:${machine.name}:${scenario.name}`;
      graph.nodes.push(graphNode(scenarioId, "scenario", scenario.name, scenario, source));
      graph.edges.push({ from: machineId, to: scenarioId, relation: "scenario" });
      const transition = machine.transitions.find((candidate) => candidate.from === scenario.from && candidate.event === scenario.event);
      if (transition) graph.edges.push({ from: scenarioId, to: `transition:${machine.name}:${transition.from}:${transition.event}`, relation: "exercises" });
    }
  }

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  if (nodeIds.size !== graph.nodes.length) throw new Error("Contract graph contains duplicate stable IDs");
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error(`Contract graph edge references an unknown node: ${edge.from} -> ${edge.to}`);
  }
  return sortGraph(graph);
}

/** Load an explicit contract-to-code trace file. Paths are relative to that file. */
export async function loadTraceConfiguration(file) {
  const configuration = await Bun.file(file).json();
  return { file, baseDirectory: dirname(resolve(file)), configuration };
}

/** Validate trace targets, required roles, and linked file existence. */
export async function validateTraceConfiguration(graph, trace, options = {}) {
  const diagnostics = [];
  const coverageGaps = [];
  const configuration = trace.configuration ?? {};
  const links = Array.isArray(configuration.links) ? configuration.links : [];
  const requirements = Array.isArray(configuration.requirements) ? configuration.requirements : [];
  const knownIds = new Set([...graph.nodes.map((node) => node.id), ...(options.additionalContractIds ?? [])]);
  if (configuration.version !== 1) diagnostics.push("Trace configuration must declare version 1");
  if (!Array.isArray(configuration.links)) diagnostics.push("Trace configuration must declare a links array");
  if (configuration.requirements !== undefined && !Array.isArray(configuration.requirements)) diagnostics.push("Trace configuration requirements must be an array");

  const normalizedLinks = [];
  const duplicateKeys = new Set();
  for (const [index, link] of links.entries()) {
    if (!link || typeof link !== "object") {
      diagnostics.push(`Link ${index + 1} must be an object`);
      continue;
    }
    if (!knownIds.has(link.contract)) diagnostics.push(`Link ${index + 1} references unknown contract '${link.contract}'`);
    if (!LINK_ROLES.has(link.role)) diagnostics.push(`Link ${index + 1} has unsupported role '${link.role}'`);
    if (typeof link.path !== "string" || !link.path) {
      diagnostics.push(`Link ${index + 1} must declare a file path`);
      continue;
    }
    const absolutePath = resolve(trace.baseDirectory, link.path);
    const normalizedPath = relative(trace.baseDirectory, absolutePath).replaceAll("\\", "/");
    if (normalizedPath === ".." || normalizedPath.startsWith("../") || isAbsolute(normalizedPath)) {
      diagnostics.push(`Linked path must stay inside the trace directory: ${link.path}`);
      continue;
    }
    const key = `${link.contract}\0${link.role}\0${normalizedPath}`;
    if (duplicateKeys.has(key)) diagnostics.push(`Duplicate trace link '${link.contract}' ${link.role} ${link.path}`);
    duplicateKeys.add(key);
    try {
      const information = await stat(absolutePath);
      if (!information.isFile()) diagnostics.push(`Linked path is not a file: ${normalizedPath}`);
    } catch {
      diagnostics.push(`Linked file does not exist: ${normalizedPath}`);
    }
    normalizedLinks.push({ contract: link.contract, role: link.role, path: normalizedPath, absolutePath });
  }

  for (const [index, requirement] of requirements.entries()) {
    if (!requirement || typeof requirement !== "object" || typeof requirement.kind !== "string" || !Array.isArray(requirement.roles)) {
      diagnostics.push(`Requirement ${index + 1} must declare a kind and roles array`);
      continue;
    }
    if (!CONTRACT_KINDS.has(requirement.kind)) diagnostics.push(`Requirement ${index + 1} has unsupported contract kind '${requirement.kind}'`);
    for (const role of requirement.roles) if (!LINK_ROLES.has(role)) diagnostics.push(`Requirement ${index + 1} has unsupported role '${role}'`);
    for (const node of graph.nodes.filter((candidate) => candidate.kind === requirement.kind)) {
      for (const role of requirement.roles) {
        if (!LINK_ROLES.has(role) || normalizedLinks.some((link) => link.contract === node.id && link.role === role)) continue;
        coverageGaps.push({ contract: node.id, kind: node.kind, role });
        const article = role === "implementation" ? "an" : "a";
        if (options.enforceCoverage !== false) diagnostics.push(`Contract '${node.id}' requires ${article} ${role} link`);
      }
    }
  }

  const coverage = Object.fromEntries(graph.nodes.map((node) => [node.id, uniqueSorted(normalizedLinks.filter((link) => link.contract === node.id).map((link) => link.role))]));
  coverageGaps.sort((left, right) => `${left.contract}\0${left.role}`.localeCompare(`${right.contract}\0${right.role}`));
  return { valid: diagnostics.length === 0, diagnostics, links: normalizedLinks, coverage, coverageGaps };
}

/** Return the bounded dependency and source context for one contract identity. */
export async function createContractContext(graph, contractId, links = [], options = {}) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const subject = nodeById.get(contractId);
  if (!subject) throw new Error(`Unknown contract '${contractId}'`);
  const dependencies = graph.edges.filter((edge) => edge.from === contractId).map((edge) => ({ relation: edge.relation, contract: nodeById.get(edge.to) }));
  const dependents = graph.edges.filter((edge) => edge.to === contractId).map((edge) => ({ relation: edge.relation, contract: nodeById.get(edge.from) }));
  const relatedLinks = links.filter((link) => link.contract === contractId);
  const linkedFiles = [];
  if (options.includeFiles) {
    for (const link of relatedLinks) {
      const file = Bun.file(link.absolutePath);
      if (file.size > (options.maxBytes ?? 65_536)) throw new Error(`Linked file exceeds context limit: ${link.path}`);
      linkedFiles.push({ role: link.role, path: link.path, content: await file.text() });
    }
  }
  return { version: 1, subject, dependencies, dependents, links: relatedLinks.map(({ absolutePath, ...link }) => link), ...(options.includeFiles ? { linkedFiles } : {}) };
}

/** Compare two graph artifacts and propagate dependency changes to their consumers. */
export function compareContractGraphs(current, baseline, links = []) {
  if (current.version !== 1 || baseline.version !== 1) throw new Error("Contract graph comparison requires version 1 artifacts");
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, node]));
  const added = [...currentNodes.keys()].filter((id) => !baselineNodes.has(id)).sort();
  const removed = [...baselineNodes.keys()].filter((id) => !currentNodes.has(id)).sort();
  const modified = [...currentNodes.keys()].filter((id) => baselineNodes.has(id) && currentNodes.get(id).fingerprint !== baselineNodes.get(id).fingerprint).sort();
  const affected = new Set([...added, ...removed, ...modified]);
  const edges = [...current.edges, ...baseline.edges];
  const queue = [...affected];
  while (queue.length) {
    const changed = queue.shift();
    for (const edge of edges.filter((candidate) => candidate.to === changed)) {
      if (!affected.has(edge.from)) {
        affected.add(edge.from);
        queue.push(edge.from);
      }
    }
  }
  const affectedContracts = [...affected].sort();
  const affectedLinks = links.filter((link) => affected.has(link.contract)).map(({ absolutePath, ...link }) => link);
  return {
    version: 1,
    changes: { added, removed, modified },
    affected: affectedContracts,
    links: affectedLinks,
    tests: uniqueSorted(affectedLinks.filter((link) => link.role === "test").map((link) => link.path)),
    reviewRequired: uniqueSorted(affectedLinks.filter((link) => link.role !== "test").map((link) => link.path)),
  };
}
