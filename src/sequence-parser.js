import { SpecError } from "./errors.js";

const METHODS = "GET|POST|PUT|PATCH|DELETE";
const PARAMETER_TYPES = new Set(["string", "text", "email", "uuid", "date", "datetime", "int", "integer", "float", "boolean"]);
const PARAMETER_LOCATIONS = new Set(["path", "query", "header", "cookie"]);
const JSON_MEDIA_TYPES = new Set(["application/json", "application/problem+json"]);

function parameterModifiers(text, lineNumber) {
  const result = {};
  for (const part of text.trim().split(/\s+/).filter(Boolean)) {
    const assignment = part.match(/^([A-Za-z][A-Za-z0-9]*)=(.+)$/);
    if (!assignment) throw new SpecError(`Invalid parameter constraint '${part}'`, lineNumber);
    const key = assignment[1];
    const raw = assignment[2];
    if (!["minimum", "maximum", "minLength", "maxLength", "pattern", "enum"].includes(key)) throw new SpecError(`Unsupported parameter constraint '${key}'`, lineNumber);
    if (["minimum", "maximum", "minLength", "maxLength"].includes(key)) {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new SpecError(`Invalid ${key} '${raw}'`, lineNumber);
      result[key] = value;
    } else if (key === "enum") result.enum = raw.split(",").filter(Boolean);
    else result[key] = raw;
  }
  return result;
}

function validatePath(path, line) {
  const parameters = new Set();
  for (const segment of path.split("/")) {
    if (!/[{}]/.test(segment)) continue;
    const parameter = segment.match(/^\{([A-Za-z_][A-Za-z0-9_-]*)\}$/);
    if (!parameter) throw new SpecError(`Invalid path parameter segment '${segment}'`, line);
    if (parameters.has(parameter[1])) throw new SpecError(`Duplicate path parameter '${parameter[1]}'`, line);
    parameters.add(parameter[1]);
  }
  return [...parameters];
}

export function parseSequenceDiagram(source) {
  const participants = new Set();
  const operations = [];
  const pending = [];
  const directives = { parameters: [], access: [], errors: [], pagination: [], content: [] };
  let foundHeader = false;
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line || /^(autonumber|activate\s+|deactivate\s+)/.test(line)) continue;
    if (line.startsWith("%%")) {
      const parameter = line.match(/^%%\s*@param\s+([A-Za-z_][A-Za-z0-9_-]*)\s+(path|query|header|cookie)\s+([A-Za-z_][A-Za-z0-9_-]*)\s+([A-Za-z_][A-Za-z0-9_-]*)\s+(required|optional)(?:\s+(.+))?$/);
      if (parameter) {
        const [, operationId, location, name, type, necessity, constraints] = parameter;
        if (!PARAMETER_LOCATIONS.has(location)) throw new SpecError(`Unsupported parameter location '${location}'`, lineNumber);
        if (!PARAMETER_TYPES.has(type)) throw new SpecError(`Unsupported parameter type '${type}'`, lineNumber);
        const modifiers = constraints ? parameterModifiers(constraints, lineNumber) : {};
        const numeric = ["int", "integer", "float"].includes(type);
        if (!numeric && (modifiers.minimum !== undefined || modifiers.maximum !== undefined)) throw new SpecError(`Numeric constraints require a numeric parameter '${name}'`, lineNumber);
        if (numeric && (modifiers.minLength !== undefined || modifiers.maxLength !== undefined || modifiers.pattern !== undefined)) throw new SpecError(`String constraints require a string parameter '${name}'`, lineNumber);
        if (modifiers.minimum !== undefined && modifiers.maximum !== undefined && modifiers.minimum > modifiers.maximum) throw new SpecError("minimum cannot exceed maximum", lineNumber);
        directives.parameters.push({ operationId, in: location, name, type, required: necessity === "required", ...modifiers, lineNumber });
        continue;
      }
      const access = line.match(/^%%\s*@security\s+([A-Za-z_][A-Za-z0-9_-]*)\s+(bearer|apiKey(?:\s+(?:header|query|cookie)\s+[A-Za-z_][A-Za-z0-9_-]*)?)$/);
      if (access) {
        const parts = access[2].split(/\s+/);
        directives.access.push({ operationId: access[1], scheme: parts[0], ...(parts[0] === "apiKey" ? { in: parts[1], name: parts[2] } : {}), lineNumber });
        continue;
      }
      const error = line.match(/^%%\s*@error\s+([A-Za-z_][A-Za-z0-9_-]*)\s+(\d{3})\s+([A-Za-z_][A-Za-z0-9_-]*)$/);
      if (error) {
        if (Number(error[2]) < 400 || Number(error[2]) > 599) throw new SpecError(`@error status must be between 400 and 599`, lineNumber);
        directives.errors.push({ operationId: error[1], status: error[2], model: error[3], lineNumber });
        continue;
      }
      const pagination = line.match(/^%%\s*@pagination\s+([A-Za-z_][A-Za-z0-9_-]*)\s+([A-Za-z_][A-Za-z0-9_-]*)\s+([A-Za-z_][A-Za-z0-9_-]*)\s+([A-Za-z_][A-Za-z0-9_-]*)$/);
      if (pagination) {
        directives.pagination.push({ operationId: pagination[1], cursor: pagination[2], limit: pagination[3], response: pagination[4], lineNumber });
        continue;
      }
      const content = line.match(/^%%\s*@content\s+([A-Za-z_][A-Za-z0-9_-]*)\s+(.+)$/);
      if (content) {
        const values = {};
        for (const part of content[2].split(/\s+/)) {
          const assignment = part.match(/^(request|response)=(.+)$/);
          if (!assignment || !JSON_MEDIA_TYPES.has(assignment[2])) throw new SpecError(`Unsupported content declaration '${part}'`, lineNumber);
          values[assignment[1]] = assignment[2];
        }
        directives.content.push({ operationId: content[1], ...values, lineNumber });
        continue;
      }
      if (/^%%\s*@(param|security|error|pagination|content)\b/.test(line)) throw new SpecError(`Invalid HTTP directive '${line}'`, lineNumber);
      continue;
    }
    if (line === "sequenceDiagram") {
      foundHeader = true;
      continue;
    }
    if (!foundHeader) throw new SpecError("Expected sequenceDiagram header", lineNumber);
    const participant = line.match(/^(?:participant|actor)\s+([A-Za-z_][A-Za-z0-9_-]*)(?:\s+as\s+.+)?$/);
    if (participant) {
      participants.add(participant[1]);
      continue;
    }
    const message = line.match(/^([A-Za-z_][A-Za-z0-9_-]*?)\s*(->>|-->>|->|-->)\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
    if (!message) throw new SpecError(`Unsupported sequence statement '${line}'`, lineNumber);
    const [, from, arrow, to, label] = message;
    participants.add(from);
    participants.add(to);
    const request = label.match(new RegExp(`^(${METHODS})\\s+(/\\S*)\\s+\\(([A-Za-z_][A-Za-z0-9_-]*)\\)(?:\\s+body=([A-Za-z_][A-Za-z0-9_-]*))?$`));
    if (request && !arrow.startsWith("--")) {
      const pathParameterNames = validatePath(request[2], lineNumber);
      pending.push({ client: from, server: to, method: request[1], path: request[2], operationId: request[3], ...(request[4] ? { requestModel: request[4] } : {}), responses: [], parameters: pathParameterNames.map((name) => ({ in: "path", name, type: "string", required: true })) });
      operations.push(pending[pending.length - 1]);
      continue;
    }
    const response = label.match(/^(\d{3})(?:\s+([A-Za-z_][A-Za-z0-9_-]*))?$/);
    if (response && arrow.startsWith("--")) {
      if (Number(response[1]) < 100 || Number(response[1]) > 599) throw new SpecError(`Invalid HTTP response status '${response[1]}'`, lineNumber);
      const operation = [...pending].reverse().find((item) => item.server === from && item.client === to);
      if (!operation) throw new SpecError(`Response '${label}' has no matching HTTP request`, lineNumber);
      operation.responses.push({ status: response[1], ...(response[2] ? { model: response[2] } : {}) });
      continue;
    }
    // Internal interactions remain documentation and are preserved by Mermaid, but are not HTTP contracts.
  }

  if (!foundHeader) throw new SpecError("Expected sequenceDiagram header");
  for (const operation of operations) {
    if (!operation.responses.length) throw new SpecError(`Operation '${operation.operationId}' has no response`);
  }
  function target(directive) {
    const operation = operations.find((candidate) => candidate.operationId === directive.operationId);
    if (!operation) throw new SpecError(`HTTP directive references unknown operation '${directive.operationId}'`, directive.lineNumber);
    return operation;
  }
  for (const directive of directives.parameters) {
    const operation = target(directive);
    if (directive.in === "path" && !operation.path.includes(`{${directive.name}}`)) throw new SpecError(`Path parameter '${directive.name}' does not exist in route '${operation.path}'`, directive.lineNumber);
    if (directive.in === "path" && !directive.required) throw new SpecError(`Path parameter '${directive.name}' must be required`, directive.lineNumber);
    const duplicate = operation.parameters.findIndex((parameter) => parameter.in === directive.in && parameter.name.toLowerCase() === directive.name.toLowerCase());
    const { operationId, lineNumber, ...parameter } = directive;
    if (duplicate >= 0 && directive.in !== "path") throw new SpecError(`Duplicate parameter '${directive.in}:${directive.name}' on '${operation.operationId}'`, lineNumber);
    if (duplicate >= 0) operation.parameters[duplicate] = parameter;
    else operation.parameters.push(parameter);
  }
  for (const directive of directives.access) {
    const operation = target(directive);
    if (operation.access) throw new SpecError(`Duplicate @security directive for '${operation.operationId}'`, directive.lineNumber);
    const { operationId, lineNumber, ...access } = directive;
    operation.access = access;
  }
  for (const directive of directives.errors) {
    const operation = target(directive);
    const response = operation.responses.find((candidate) => candidate.status === directive.status && candidate.model === directive.model);
    if (!response) throw new SpecError(`@error for '${operation.operationId}' must match a declared response`, directive.lineNumber);
    operation.errors ??= [];
    if (operation.errors.some((candidate) => candidate.status === directive.status)) throw new SpecError(`Duplicate @error status '${directive.status}' for '${operation.operationId}'`, directive.lineNumber);
    operation.errors.push({ status: directive.status, model: directive.model });
  }
  for (const directive of directives.pagination) {
    const operation = target(directive);
    if (operation.pagination) throw new SpecError(`Duplicate @pagination directive for '${operation.operationId}'`, directive.lineNumber);
    const cursor = operation.parameters.find((parameter) => parameter.in === "query" && parameter.name === directive.cursor);
    const limit = operation.parameters.find((parameter) => parameter.in === "query" && parameter.name === directive.limit);
    if (!cursor || !limit) throw new SpecError(`Pagination on '${operation.operationId}' requires declared cursor and limit query parameters`, directive.lineNumber);
    operation.pagination = { cursor: directive.cursor, limit: directive.limit, response: directive.response };
  }
  for (const directive of directives.content) {
    const operation = target(directive);
    if (operation.content) throw new SpecError(`Duplicate @content directive for '${operation.operationId}'`, directive.lineNumber);
    const { operationId, lineNumber, ...content } = directive;
    operation.content = content;
  }
  return { version: 1, kind: "apiContract", participants: [...participants], operations };
}
