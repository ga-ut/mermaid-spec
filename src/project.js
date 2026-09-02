import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { emitJavaScript, emitTypeScript } from "./emitter.js";
import { emitApiJavaScript, emitApiTypeScript, emitOpenApi } from "./api-emitter.js";
import { parseErDiagram } from "./er-parser.js";
import { extractMermaidBlocks } from "./markdown.js";
import { emitJsonSchema, emitModelTypeScript, emitSql, modelSqlName, modelTypeName } from "./model-emitter.js";
import { parseStateDiagram } from "./parser.js";
import { parseSequenceDiagram } from "./sequence-parser.js";
import { testExamples, testScenarios } from "./runtime.js";
import { validateStateMachine } from "./validate.js";
import { createContractGraph } from "./harness.js";

const packageMetadata = await Bun.file(new URL("../package.json", import.meta.url)).json();

function hash(content) {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function slug(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function markdownFiles(input) {
  const info = await stat(input);
  if (info.isFile()) return [input];
  const entries = await readdir(input, { withFileTypes: true });
  const nested = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
    const path = join(input, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  }));
  return nested.flat();
}

export async function compileProject(input) {
  const inputInfo = await stat(input);
  const root = inputInfo.isDirectory() ? input : dirname(input);
  const sources = [];
  const machines = [];
  const entities = [];
  const relationships = [];
  const apiOperations = [];
  const origins = { models: {}, machines: {}, operations: {} };

  for (const file of await markdownFiles(input)) {
    const content = await Bun.file(file).text();
    const sourceFile = relative(root, file).replaceAll("\\", "/");
    sources.push({ file: sourceFile, hash: hash(content) });
    const blocks = extractMermaidBlocks(content);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.type === "unsupported") throw new Error(`Unsupported Mermaid diagram in ${file}`);
      if (block.type === "stateMachine") {
        const fallbackName = basename(file, extname(file)).replace(/[^A-Za-z0-9_$]/g, "_") + (index ? `_${index + 1}` : "");
        const machine = parseStateDiagram(block.source, { name: fallbackName });
        const diagnostics = validateStateMachine(machine);
        if (diagnostics.length) throw new Error(diagnostics.map((item) => `${file}: ${item.message}`).join("\n"));
        machines.push(machine);
        origins.machines[machine.name] = { file: sourceFile };
      } else if (block.type === "entityModel") {
        const model = parseErDiagram(block.source);
        entities.push(...model.entities);
        relationships.push(...model.relationships);
        for (const entity of model.entities) origins.models[modelTypeName(entity.name)] = { file: sourceFile };
      } else {
        const operations = parseSequenceDiagram(block.source).operations;
        apiOperations.push(...operations);
        for (const operation of operations) origins.operations[operation.operationId] = { file: sourceFile };
      }
    }
  }

  const duplicateEntity = entities.find((entity, index) => entities.findIndex((item) => item.name === entity.name) !== index);
  if (duplicateEntity) throw new Error(`Duplicate entity '${duplicateEntity.name}' across project specs`);
  const duplicateTypeName = entities.find((entity, index) => entities.findIndex((item) => modelTypeName(item.name) === modelTypeName(entity.name)) !== index);
  if (duplicateTypeName) throw new Error(`Entity '${duplicateTypeName.name}' collides with another generated TypeScript model name '${modelTypeName(duplicateTypeName.name)}'`);
  const tableEntities = entities.filter((entity) => (entity.role ?? "table") === "table");
  const duplicateSqlName = tableEntities.find((entity, index) => tableEntities.findIndex((item) => modelSqlName(item.name) === modelSqlName(entity.name)) !== index);
  if (duplicateSqlName) throw new Error(`Entity '${duplicateSqlName.name}' collides with another generated SQL table name '${modelSqlName(duplicateSqlName.name)}'`);
  const duplicateMachine = machines.find((machine, index) => machines.findIndex((item) => item.name === machine.name) !== index);
  if (duplicateMachine) throw new Error(`Duplicate state machine '${duplicateMachine.name}'`);
  const duplicateOperation = apiOperations.find((operation, index) => apiOperations.findIndex((item) => item.operationId === operation.operationId || (item.method === operation.method && item.path === operation.path)) !== index);
  if (duplicateOperation) throw new Error(`Duplicate API operation '${duplicateOperation.operationId}' or route '${duplicateOperation.method} ${duplicateOperation.path}'`);

  const model = { version: 1, kind: "entityModel", entities, relationships };
  const apiContract = { version: 1, kind: "apiContract", operations: apiOperations };
  const modelNames = new Set(JSON.parse(emitJsonSchema(model)).$defs ? Object.keys(JSON.parse(emitJsonSchema(model)).$defs) : []);
  for (const machine of machines) {
    if (!machine.binding) continue;
    const entity = entities.find((candidate) => candidate.name === machine.binding.model || modelTypeName(candidate.name) === modelTypeName(machine.binding.model));
    if (!entity) throw new Error(`State machine '${machine.name}' binds unknown model '${machine.binding.model}'`);
    const attribute = entity.attributes.find((candidate) => candidate.name === machine.binding.field);
    if (!attribute) throw new Error(`State machine '${machine.name}' binds unknown field '${machine.binding.model}.${machine.binding.field}'`);
    if (!["string", "text"].includes(attribute.type.toLowerCase()) || !attribute.enum) throw new Error(`Bound state field '${machine.binding.model}.${machine.binding.field}' must declare a string enum`);
    const missing = machine.states.filter((state) => !attribute.enum.includes(state));
    const extra = attribute.enum.filter((state) => !machine.states.includes(state));
    if (missing.length || extra.length) throw new Error(`Bound state field '${machine.binding.model}.${machine.binding.field}' enum must exactly match machine '${machine.name}' states`);
  }
  for (const operation of apiOperations) {
    for (const name of [operation.requestModel, ...operation.responses.map((response) => response.model)].filter(Boolean)) {
      if (!modelNames.has(modelTypeName(name))) throw new Error(`API operation '${operation.operationId}' references unknown model '${name}'`);
    }
    if (operation.pagination) {
      const success = operation.responses.find((response) => response.status.startsWith("2") && response.model);
      const responseModel = entities.find((entity) => success && modelTypeName(entity.name) === modelTypeName(success.model));
      if (!responseModel?.attributes.some((attribute) => attribute.name === operation.pagination.response)) {
        throw new Error(`Pagination on '${operation.operationId}' requires response field '${operation.pagination.response}' on a successful response model`);
      }
    }
  }
  const artifacts = {};
  if (entities.length) {
    artifacts["models.generated.ts"] = emitModelTypeScript(model);
    artifacts["models.schema.json"] = emitJsonSchema(model);
  }
  if (tableEntities.length) {
    artifacts["schema.generated.sql"] = emitSql(model);
  }
  if (apiOperations.length) {
    const schema = JSON.parse(emitJsonSchema(model));
    artifacts["openapi.generated.json"] = emitOpenApi(apiContract, schema);
    artifacts["api.generated.ts"] = emitApiTypeScript(apiContract);
    artifacts["api.generated.js"] = emitApiJavaScript(apiContract, schema);
  }
  for (const machine of machines) {
    artifacts[`${slug(machine.name)}.machine.generated.ts`] = emitTypeScript(machine);
    artifacts[`${slug(machine.name)}.machine.generated.js`] = emitJavaScript(machine);
  }

  const graph = createContractGraph({ apiContract, machines, model }, origins);
  artifacts["contract-graph.generated.json"] = `${JSON.stringify(graph, null, 2)}\n`;

  const manifest = {
    version: 1,
    compiler: { name: packageMetadata.name, version: packageMetadata.version },
    sources: sources.map((item) => ({ file: item.file, sha256: item.hash })),
    models: entities.map((entity) => entity.name),
    machines: machines.map((machine) => machine.name),
    operations: apiOperations.map((operation) => operation.operationId),
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([file, content]) => [file, { sha256: hash(content) }])),
  };
  artifacts["mermaid-spec.manifest.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  return { apiContract, artifacts, graph, machines, model, sources };
}

export async function buildProject(input, output) {
  const project = await compileProject(input);
  await mkdir(output, { recursive: true });
  for (const [file, content] of Object.entries(project.artifacts)) await Bun.write(join(output, file), content);
  return project;
}

export async function verifyProject(input, output) {
  const project = await compileProject(input);
  const drift = [];
  for (const [file, expected] of Object.entries(project.artifacts)) {
    try {
      const actual = await Bun.file(join(output, file)).text();
      if (actual !== expected) drift.push(file);
    } catch {
      drift.push(file);
    }
  }
  try {
    const actualFiles = await readdir(output);
    for (const file of actualFiles) if (!Object.hasOwn(project.artifacts, file)) drift.push(file);
  } catch {
    // Every expected artifact has already been recorded as missing.
  }
  return { valid: drift.length === 0, drift, project };
}

export function testProject(project) {
  return project.machines.flatMap((machine) => testExamples(machine).map((result) => ({ machine: machine.name, ...result })));
}

export async function testProjectScenarios(project, handlers = {}) {
  const results = [];
  for (const machine of project.machines) {
    const machineHandlers = handlers[machine.name] ?? {};
    for (const result of await testScenarios(machine, machineHandlers)) results.push({ machine: machine.name, ...result });
  }
  return results;
}
