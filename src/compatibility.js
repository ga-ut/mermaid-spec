import { compareContractGraphs } from "./harness.js";
import { emitSql, modelSqlName } from "./model-emitter.js";

const SQL_TYPES = { uuid: "UUID", string: "VARCHAR(255)", text: "TEXT", email: "VARCHAR(320)", datetime: "TIMESTAMPTZ", date: "DATE", int: "INTEGER", integer: "INTEGER", float: "DOUBLE PRECISION", boolean: "BOOLEAN", json: "JSONB" };

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function change(contract, kind, level, code, message) {
  return { contract, kind, level, code, message };
}

function migration(model, field, safety, action, message, sql = null) {
  return { model, ...(field ? { field } : {}), safety, action, message, sql };
}

function attributeMap(entity) {
  return new Map((entity.attributes ?? []).map((attribute) => [attribute.name, attribute]));
}

function sqlLiteral(value) {
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function addColumnSql(entity, attribute) {
  const primitive = SQL_TYPES[attribute.type.toLowerCase()];
  if (!primitive) return null;
  let type = primitive;
  if (attribute.array) type += "[]";
  const clauses = [];
  if (attribute.default !== undefined) clauses.push(`DEFAULT ${sqlLiteral(attribute.default)}`);
  if (!attribute.optional && !attribute.nullable) clauses.push("NOT NULL");
  return `ALTER TABLE "${modelSqlName(entity.name)}" ADD COLUMN "${modelSqlName(attribute.name)}" ${type}${clauses.length ? ` ${clauses.join(" ")}` : ""};`;
}

function constraintTightened(current, baseline) {
  if (baseline.optional && !current.optional) return true;
  if (baseline.nullable && !current.nullable) return true;
  if (current.minimum !== undefined && (baseline.minimum === undefined || current.minimum > baseline.minimum)) return true;
  if (current.maximum !== undefined && (baseline.maximum === undefined || current.maximum < baseline.maximum)) return true;
  if (current.minLength !== undefined && (baseline.minLength === undefined || current.minLength > baseline.minLength)) return true;
  if (current.maxLength !== undefined && (baseline.maxLength === undefined || current.maxLength < baseline.maxLength)) return true;
  if (current.minItems !== undefined && (baseline.minItems === undefined || current.minItems > baseline.minItems)) return true;
  if (current.maxItems !== undefined && (baseline.maxItems === undefined || current.maxItems < baseline.maxItems)) return true;
  if (current.pattern !== baseline.pattern && current.pattern !== undefined) return true;
  if (current.enum && !baseline.enum) return true;
  if (baseline.enum && (!current.enum || baseline.enum.some((value) => !current.enum.includes(value)))) return true;
  return false;
}

function classifyModel(currentNode, baselineNode, changes, migrations, graphModels) {
  const contract = currentNode?.id ?? baselineNode.id;
  const current = currentNode?.details.entity;
  const baseline = baselineNode?.details.entity;
  if (!baseline) {
    changes.push(change(contract, "model", "non-breaking", "MODEL_ADDED", `Model '${current.name}' was added`));
    if ((current.role ?? "table") === "table") {
      let sql = null;
      try {
        sql = emitSql({ entities: graphModels, relationships: [] }).split("\n\n").filter((part) => part.startsWith(`CREATE TABLE "${modelSqlName(current.name)}"`) || part.startsWith(`ALTER TABLE "${modelSqlName(current.name)}"`)).join("\n\n") || null;
      } catch {
        // A complete generated schema remains available when an isolated table plan needs review.
      }
      migrations.push(migration(current.name, null, sql ? "safe" : "review", "add-table", `Add table '${current.name}'`, sql));
    }
    return;
  }
  if (!current) {
    changes.push(change(contract, "model", "breaking", "MODEL_REMOVED", `Model '${baseline.name}' was removed`));
    if ((baseline.role ?? "table") === "table") migrations.push(migration(baseline.name, null, "unsafe", "drop-table", `Dropping table '${baseline.name}' is destructive`));
    return;
  }
  if ((current.role ?? "table") !== (baseline.role ?? "table")) changes.push(change(contract, "model", "breaking", "MODEL_ROLE_CHANGED", `Model '${current.name}' changed role`));
  const currentFields = attributeMap(current);
  const baselineFields = attributeMap(baseline);
  for (const [name, attribute] of currentFields) {
    const previous = baselineFields.get(name);
    if (!previous) {
      const compatible = attribute.optional || attribute.nullable || attribute.default !== undefined;
      changes.push(change(contract, "model", compatible ? "non-breaking" : "breaking", compatible ? "OPTIONAL_FIELD_ADDED" : "REQUIRED_FIELD_ADDED", `${compatible ? "Optional" : "Required"} field '${current.name}.${name}' was added`));
      if ((current.role ?? "table") === "table") {
        const statement = addColumnSql(current, attribute);
        const safety = attribute.keys?.includes("FK") || (!attribute.optional && !attribute.nullable && attribute.default !== undefined) ? "review" : compatible && statement ? "safe" : "unsafe";
        migrations.push(migration(current.name, name, safety, "add-column", safety === "unsafe" ? `Field '${current.name}.${name}' requires a backfill before it can be required` : `Add column '${current.name}.${name}'`, safety === "unsafe" ? null : statement));
      }
      continue;
    }
    if (same(attribute, previous)) continue;
    const shapeChanged = attribute.type !== previous.type || Boolean(attribute.array) !== Boolean(previous.array) || !same(attribute.keys, previous.keys);
    const tightened = constraintTightened(attribute, previous);
    changes.push(change(contract, "model", shapeChanged || tightened ? "breaking" : "non-breaking", shapeChanged ? "FIELD_SHAPE_CHANGED" : tightened ? "FIELD_CONSTRAINT_TIGHTENED" : "FIELD_CONSTRAINT_RELAXED", `Field '${current.name}.${name}' changed`));
    if ((current.role ?? "table") === "table") migrations.push(migration(current.name, name, shapeChanged ? "unsafe" : "review", "alter-column", `Review existing values before altering '${current.name}.${name}'`));
  }
  for (const [name] of baselineFields) {
    if (currentFields.has(name)) continue;
    changes.push(change(contract, "model", "breaking", "FIELD_REMOVED", `Field '${baseline.name}.${name}' was removed`));
    if ((baseline.role ?? "table") === "table") migrations.push(migration(baseline.name, name, "unsafe", "drop-column", `Dropping column '${baseline.name}.${name}' is destructive`));
  }
  if (!same(currentNode.details.relationships, baselineNode.details.relationships)) changes.push(change(contract, "model", "review", "RELATIONSHIP_CHANGED", `Relationships for '${current.name}' changed`));
}

function operationParameters(operation) {
  return new Map((operation.parameters ?? []).map((parameter) => [`${parameter.in}:${parameter.name}`, parameter]));
}

function classifyOperation(currentNode, baselineNode, changes) {
  const contract = currentNode?.id ?? baselineNode.id;
  const current = currentNode?.details;
  const baseline = baselineNode?.details;
  if (!baseline) return changes.push(change(contract, "operation", "non-breaking", "OPERATION_ADDED", `Operation '${current.operationId}' was added`));
  if (!current) return changes.push(change(contract, "operation", "breaking", "OPERATION_REMOVED", `Operation '${baseline.operationId}' was removed`));
  if (current.method !== baseline.method || current.path !== baseline.path) changes.push(change(contract, "operation", "breaking", "ROUTE_CHANGED", `Route for '${current.operationId}' changed`));
  if (current.requestModel !== baseline.requestModel) changes.push(change(contract, "operation", "breaking", "REQUEST_MODEL_CHANGED", `Request model for '${current.operationId}' changed`));
  if (!same(current.access, baseline.access)) changes.push(change(contract, "operation", "breaking", "ACCESS_CHANGED", `Access requirement for '${current.operationId}' changed`));
  if (!same(current.content, baseline.content)) changes.push(change(contract, "operation", "breaking", "CONTENT_CHANGED", `Media contract for '${current.operationId}' changed`));
  if (!same(current.pagination, baseline.pagination)) changes.push(change(contract, "operation", "breaking", "PAGINATION_CHANGED", `Pagination contract for '${current.operationId}' changed`));
  const currentParams = operationParameters(current);
  const baselineParams = operationParameters(baseline);
  for (const [id, parameter] of currentParams) {
    const previous = baselineParams.get(id);
    if (!previous) changes.push(change(contract, "operation", parameter.required ? "breaking" : "non-breaking", parameter.required ? "REQUIRED_PARAMETER_ADDED" : "OPTIONAL_PARAMETER_ADDED", `${parameter.required ? "Required" : "Optional"} parameter '${id}' was added`));
    else if (!same(parameter, previous)) changes.push(change(contract, "operation", "breaking", "PARAMETER_CHANGED", `Parameter '${id}' changed`));
  }
  for (const [id] of baselineParams) if (!currentParams.has(id)) changes.push(change(contract, "operation", "breaking", "PARAMETER_REMOVED", `Parameter '${id}' was removed`));
  const currentResponses = new Map((current.responses ?? []).map((response) => [response.status, response.model ?? null]));
  const baselineResponses = new Map((baseline.responses ?? []).map((response) => [response.status, response.model ?? null]));
  for (const [status, model] of currentResponses) {
    if (!baselineResponses.has(status)) changes.push(change(contract, "operation", "review", "RESPONSE_ADDED", `Response '${status}' was added to '${current.operationId}'`));
    else if (baselineResponses.get(status) !== model) changes.push(change(contract, "operation", "breaking", "RESPONSE_MODEL_CHANGED", `Response model for '${current.operationId}' status '${status}' changed`));
  }
  for (const [status] of baselineResponses) if (!currentResponses.has(status)) changes.push(change(contract, "operation", "breaking", "RESPONSE_REMOVED", `Response '${status}' was removed from '${current.operationId}'`));
}

function classifyNode(currentNode, baselineNode, changes, migrations, graphModels) {
  const node = currentNode ?? baselineNode;
  if (node.kind === "model") return classifyModel(currentNode, baselineNode, changes, migrations, graphModels);
  if (node.kind === "operation") return classifyOperation(currentNode, baselineNode, changes);
  if (!baselineNode) return changes.push(change(node.id, node.kind, "non-breaking", `${node.kind.toUpperCase()}_ADDED`, `${node.kind} '${node.name}' was added`));
  if (!currentNode) return changes.push(change(node.id, node.kind, "breaking", `${node.kind.toUpperCase()}_REMOVED`, `${node.kind} '${node.name}' was removed`));
  if (node.kind === "machine") {
    const breaking = currentNode.details.initial !== baselineNode.details.initial || !same(currentNode.details.states, baselineNode.details.states) || !same(currentNode.details.binding, baselineNode.details.binding);
    return changes.push(change(node.id, node.kind, breaking ? "breaking" : "review", breaking ? "MACHINE_SHAPE_CHANGED" : "MACHINE_TERMINAL_CHANGED", `State machine '${node.name}' changed`));
  }
  if (node.kind === "transition") return changes.push(change(node.id, node.kind, "breaking", "TRANSITION_CHANGED", `Transition '${node.name}' changed`));
  changes.push(change(node.id, node.kind, "review", `${node.kind.toUpperCase()}_CHANGED`, `${node.kind} '${node.name}' changed`));
}

export function compareContractCompatibility(current, baseline, links = []) {
  if (current.version !== 1 || baseline.version !== 1) throw new Error("Contract compatibility requires version 1 graph artifacts");
  const impact = compareContractGraphs(current, baseline, links);
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, node]));
  const graphModels = current.nodes.filter((node) => node.kind === "model").map((node) => node.details.entity);
  const changes = [];
  const migrations = [];
  for (const id of [...new Set([...impact.changes.added, ...impact.changes.modified, ...impact.changes.removed])].sort()) {
    const currentNode = currentNodes.get(id);
    classifyNode(currentNode, baselineNodes.get(id), changes, migrations, graphModels);
  }
  const summary = {
    breaking: changes.filter((item) => item.level === "breaking").length,
    review: changes.filter((item) => item.level === "review").length,
    nonBreaking: changes.filter((item) => item.level === "non-breaking").length,
    unsafeMigrations: migrations.filter((item) => item.safety === "unsafe").length,
    reviewMigrations: migrations.filter((item) => item.safety === "review").length,
    safeMigrations: migrations.filter((item) => item.safety === "safe").length,
  };
  return { version: 1, compatible: summary.breaking === 0, migrationSafe: summary.unsafeMigrations === 0, summary, changes, migrations, impact };
}
