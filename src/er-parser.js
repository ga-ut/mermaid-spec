import { SpecError } from "./errors.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const MODEL_ROLES = new Set(["table", "schema", "value"]);
const PRIMITIVE_TYPES = new Set(["uuid", "string", "text", "email", "datetime", "date", "int", "integer", "float", "boolean", "json"]);
const FLAG_MODIFIERS = new Set(["optional", "nullable", "array"]);
const VALUE_MODIFIERS = new Set(["enum", "default", "minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems"]);

function parseFieldModifiers(text, lineNumber) {
  const modifiers = {};
  const parts = text.trim().split(/\s+/).filter(Boolean);
  for (const part of parts) {
    if (FLAG_MODIFIERS.has(part)) {
      if (modifiers[part]) throw new SpecError(`Duplicate field modifier '${part}'`, lineNumber);
      modifiers[part] = true;
      continue;
    }
    const assignment = part.match(/^([A-Za-z][A-Za-z0-9]*)=(.+)$/);
    if (!assignment || !VALUE_MODIFIERS.has(assignment[1])) throw new SpecError(`Unsupported field modifier '${part}'`, lineNumber);
    const key = assignment[1];
    const raw = assignment[2];
    if (Object.hasOwn(modifiers, key)) throw new SpecError(`Duplicate field modifier '${key}'`, lineNumber);
    if (["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"].includes(key)) {
      const value = Number(raw);
      const isCount = ["minLength", "maxLength", "minItems", "maxItems"].includes(key);
      if (!Number.isFinite(value) || (isCount && (!Number.isInteger(value) || value < 0))) throw new SpecError(`Invalid ${key} '${raw}'`, lineNumber);
      modifiers[key] = value;
    } else if (key === "enum") {
      const values = raw.split(",").filter(Boolean);
      if (!values.length || new Set(values).size !== values.length) throw new SpecError(`Invalid enum '${raw}'`, lineNumber);
      modifiers.enum = values;
    } else if (key === "default") {
      try {
        modifiers.default = JSON.parse(raw);
      } catch {
        throw new SpecError(`Invalid default '${raw}'; use a compact JSON literal`, lineNumber);
      }
    } else modifiers[key] = raw;
  }
  if (modifiers.minimum !== undefined && modifiers.maximum !== undefined && modifiers.minimum > modifiers.maximum) throw new SpecError("minimum cannot exceed maximum", lineNumber);
  if (modifiers.minLength !== undefined && modifiers.maxLength !== undefined && modifiers.minLength > modifiers.maxLength) throw new SpecError("minLength cannot exceed maxLength", lineNumber);
  if (modifiers.minItems !== undefined && modifiers.maxItems !== undefined && modifiers.minItems > modifiers.maxItems) throw new SpecError("minItems cannot exceed maxItems", lineNumber);
  return modifiers;
}

export function parseErDiagram(source) {
  const entities = [];
  const relationships = [];
  const modelDirectives = new Map();
  const fieldDirectives = new Map();
  const lines = source.split(/\r?\n/);
  let foundHeader = false;
  let current = null;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith("%%")) {
      const modelDirective = line.match(/^%%\s*@model\s+([A-Za-z_][A-Za-z0-9_-]*)\s+([A-Za-z]+)$/);
      if (modelDirective) {
        const name = modelDirective[1];
        const role = modelDirective[2];
        if (!MODEL_ROLES.has(role)) throw new SpecError(`Unsupported model role '${role}'`, lineNumber);
        if (modelDirectives.has(name)) throw new SpecError(`Duplicate @model directive for '${name}'`, lineNumber);
        modelDirectives.set(name, { role, lineNumber });
        continue;
      }
      const fieldDirective = line.match(/^%%\s*@field\s+([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_-]*)\s+(.+)$/);
      if (fieldDirective) {
        const entity = fieldDirective[1];
        const field = fieldDirective[2];
        const key = `${entity}.${field}`;
        if (fieldDirectives.has(key)) throw new SpecError(`Duplicate @field directive for '${key}'`, lineNumber);
        fieldDirectives.set(key, { entity, field, modifiers: parseFieldModifiers(fieldDirective[3], lineNumber), lineNumber });
        continue;
      }
      if (/^%%\s*@(model|field)\b/.test(line)) throw new SpecError(`Invalid model directive '${line}'`, lineNumber);
      continue;
    }
    if (line === "erDiagram") {
      if (foundHeader) throw new SpecError("Duplicate erDiagram header", lineNumber);
      foundHeader = true;
      continue;
    }
    if (!foundHeader) throw new SpecError("Expected erDiagram header", lineNumber);

    if (current) {
      if (line === "}") {
        entities.push(current);
        current = null;
        continue;
      }
      const attribute = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s+([A-Za-z_][A-Za-z0-9_-]*)(?:\s+((?:(?:PK|FK|UK)(?:\s*,\s*)?)+))?(?:\s+"([^"]*)")?$/);
      if (!attribute) throw new SpecError(`Invalid entity attribute '${line}'`, lineNumber);
      const keys = attribute[3] ? attribute[3].split(/\s*,\s*|\s+/).filter(Boolean) : [];
      if (current.attributes.some((item) => item.name === attribute[2])) {
        throw new SpecError(`Duplicate attribute '${attribute[2]}' in '${current.name}'`, lineNumber);
      }
      current.attributes.push({ type: attribute[1], name: attribute[2], keys, ...(attribute[4] ? { comment: attribute[4] } : {}) });
      continue;
    }

    const entityStart = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*\{$/);
    if (entityStart) {
      if (!IDENTIFIER.test(entityStart[1])) throw new SpecError(`Invalid entity '${entityStart[1]}'`, lineNumber);
      current = { name: entityStart[1], role: "table", attributes: [] };
      continue;
    }

    const relation = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s+([|o}{]{2})--([|o}{]{2})\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
    if (relation) {
      relationships.push({ from: relation[1], fromCardinality: relation[2], toCardinality: relation[3], to: relation[4], label: relation[5].trim() });
      continue;
    }
    throw new SpecError(`Unsupported ER statement '${line}'`, lineNumber);
  }

  if (current) throw new SpecError(`Entity '${current.name}' is missing closing '}'`);
  if (!foundHeader) throw new SpecError("Expected erDiagram header");
  const names = new Set(entities.map((entity) => entity.name));
  for (const [name, directive] of modelDirectives) {
    const entity = entities.find((candidate) => candidate.name === name);
    if (!entity) throw new SpecError(`@model references unknown model '${name}'`, directive.lineNumber);
    entity.role = directive.role;
  }
  for (const directive of fieldDirectives.values()) {
    const entity = entities.find((candidate) => candidate.name === directive.entity);
    const attribute = entity?.attributes.find((candidate) => candidate.name === directive.field);
    if (!attribute) throw new SpecError(`@field references unknown field '${directive.entity}.${directive.field}'`, directive.lineNumber);
    Object.assign(attribute, directive.modifiers);
  }
  for (const entity of entities) {
    if (entity.role !== "table" && entity.attributes.some((attribute) => attribute.keys.length)) throw new SpecError(`Only table models may declare PK, FK, or UK keys: '${entity.name}'`);
    for (const attribute of entity.attributes) {
      if (!PRIMITIVE_TYPES.has(attribute.type.toLowerCase()) && !names.has(attribute.type)) throw new SpecError(`Unknown model type '${attribute.type}' on '${entity.name}.${attribute.name}'`);
      if ((attribute.minItems !== undefined || attribute.maxItems !== undefined) && !attribute.array) throw new SpecError(`Array constraints require the array modifier on '${entity.name}.${attribute.name}'`);
      if (attribute.enum && !["string", "text"].includes(attribute.type.toLowerCase())) throw new SpecError(`enum requires a string or text field on '${entity.name}.${attribute.name}'`);
    }
  }
  for (const relation of relationships) {
    if (!names.has(relation.from) || !names.has(relation.to)) {
      throw new SpecError(`Relationship references an undeclared entity: ${relation.from} -> ${relation.to}`);
    }
    const from = entities.find((entity) => entity.name === relation.from);
    const to = entities.find((entity) => entity.name === relation.to);
    if (from?.role !== "table" || to?.role !== "table") throw new SpecError(`Relationships may only connect table models: ${relation.from} -> ${relation.to}`);
  }
  return { version: 1, kind: "entityModel", entities, relationships };
}
