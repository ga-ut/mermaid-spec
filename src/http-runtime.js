function matchPath(template, pathname) {
  const expected = template.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index];
    if (segment.startsWith("{") && segment.endsWith("}")) params[segment.slice(1, -1)] = decodeURIComponent(actual[index]);
    else if (segment !== actual[index]) return null;
  }
  return params;
}

async function requestBody(request, declaredType = "application/json") {
  if (["GET", "HEAD"].includes(request.method)) return undefined;
  const body = await request.text();
  if (!body) return undefined;
  if (!request.headers.get("content-type")?.includes(declaredType)) throw new TypeError(`Request body must use ${declaredType}`);
  return JSON.parse(body);
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function propertyPath(path, property) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property) ? `${path}.${property}` : `${path}[${JSON.stringify(property)}]`;
}

function cookiesFrom(request) {
  const result = {};
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name) result[name] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return result;
}

function parameterSchema(parameter) {
  const type = ["int", "integer"].includes(parameter.type) ? "integer" : parameter.type === "float" ? "number" : parameter.type === "boolean" ? "boolean" : "string";
  const format = ["uuid", "email", "date"].includes(parameter.type) ? parameter.type : parameter.type === "datetime" ? "date-time" : undefined;
  const schema = { type, ...(format ? { format } : {}) };
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "pattern", "enum"]) if (parameter[key] !== undefined) schema[key] = parameter[key];
  return schema;
}

function coerceParameter(parameter, raw) {
  if (["int", "integer"].includes(parameter.type)) return /^-?\d+$/.test(raw) ? Number(raw) : raw;
  if (parameter.type === "float") return raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  if (parameter.type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
}

function parseParameters(route, request, url, matchedPath) {
  const queryParams = {};
  const headerValues = {};
  const cookieValues = {};
  const params = { ...matchedPath };
  const cookies = cookiesFrom(request);
  for (const parameter of route.parameters ?? []) {
    const raw = parameter.in === "path" ? matchedPath[parameter.name]
      : parameter.in === "query" ? url.searchParams.get(parameter.name)
        : parameter.in === "header" ? request.headers.get(parameter.name)
          : cookies[parameter.name];
    if (raw === undefined || raw === null || raw === "") {
      if (parameter.required) return { error: `${parameter.in} parameter '${parameter.name}' is required` };
      continue;
    }
    const value = coerceParameter(parameter, raw);
    const error = validateJsonValue(parameterSchema(parameter), value, `${parameter.in}.${parameter.name}`);
    if (error) return { error };
    if (parameter.in === "path") params[parameter.name] = value;
    else if (parameter.in === "query") queryParams[parameter.name] = value;
    else if (parameter.in === "header") headerValues[parameter.name] = value;
    else cookieValues[parameter.name] = value;
  }
  return { params, queryParams, headers: headerValues, cookies: cookieValues };
}

/** Validate the JSON Schema subset emitted by mermaid-spec. Returns null when valid. */
export function validateJsonValue(schema, value, path = "$", definitions = {}) {
  if (!schema || typeof schema !== "object") return `${path} has no schema`;
  if (schema.$ref) {
    const name = schema.$ref.match(/^#\/\$defs\/(.+)$/)?.[1];
    if (!name || !definitions[name]) return `${path} references unknown schema '${schema.$ref}'`;
    return validateJsonValue(definitions[name], value, path, definitions);
  }
  if (Array.isArray(schema.anyOf)) {
    const errors = schema.anyOf.map((candidate) => validateJsonValue(candidate, value, path, definitions));
    return errors.some((error) => error === null) ? null : errors[0];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} must be one of the allowed values`;
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object, received ${valueType(value)}`;
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) return `${propertyPath(path, required)} is required`;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((property) => !Object.hasOwn(properties, property));
      if (extra) return `${propertyPath(path, extra)} is not allowed`;
    }
    for (const [property, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, property)) continue;
      const error = validateJsonValue(propertySchema, value[property], propertyPath(path, property), definitions);
      if (error) return error;
    }
    return null;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string, received ${valueType(value)}`;
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return `${path} must be a UUID`;
    if (schema.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return `${path} must be an email address`;
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${path} must be an ISO date`;
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) return `${path} must be an ISO date-time`;
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} must contain at least ${schema.minLength} characters`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} must contain at most ${schema.maxLength} characters`;
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern).test(value))) return `${path} must match ${schema.pattern}`;
    return null;
  }
  if (schema.type === "integer" || schema.type === "number") {
    const valid = schema.type === "integer" ? Number.isInteger(value) : typeof value === "number" && Number.isFinite(value);
    if (!valid) return `${path} must be ${schema.type === "integer" ? "an integer" : "a finite number"}, received ${valueType(value)}`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
    return null;
  }
  if (schema.type === "boolean") return typeof value === "boolean" ? null : `${path} must be a boolean, received ${valueType(value)}`;
  if (schema.type === "null") return value === null ? null : `${path} must be null`;
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array, received ${valueType(value)}`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items`;
    for (let index = 0; index < value.length; index += 1) {
      const error = validateJsonValue(schema.items, value[index], `${path}[${index}]`, definitions);
      if (error) return error;
    }
    return null;
  }
  return `${path} uses unsupported schema type '${schema.type}'`;
}

function contractError(message) {
  return Response.json({ error: "contract_violation", message }, { status: 500 });
}

export function createFetchHandler(routes, handlers, schemas = {}) {
  return async function handle(request) {
    const url = new URL(request.url);
    const route = routes.find((candidate) => candidate.method === request.method && matchPath(candidate.path, url.pathname));
    if (!route) return Response.json({ error: "not_found" }, { status: 404 });
    const handler = handlers[route.operationId];
    if (typeof handler !== "function") return Response.json({ error: "not_implemented" }, { status: 501 });
    const matchedPath = matchPath(route.path, url.pathname);
    const parameters = parseParameters(route, request, url, matchedPath);
    if (parameters.error) return Response.json({ error: "invalid_request", message: parameters.error }, { status: 400 });
    let body;
    try {
      body = await requestBody(request, route.content?.request ?? "application/json");
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) return Response.json({ error: "invalid_request", message: error.message }, { status: 400 });
      throw error;
    }
    if (Object.hasOwn(route, "requestModel")) {
      if (route.requestModel === null && body !== undefined) return Response.json({ error: "invalid_request", message: "Request body is not allowed" }, { status: 400 });
      if (route.requestModel !== null) {
        const schema = schemas[route.requestModel];
        if (!schema) return contractError(`Missing request schema '${route.requestModel}'`);
        const error = validateJsonValue(schema, body, "$", schemas);
        if (error) return Response.json({ error: "invalid_request", message: error }, { status: 400 });
      }
    }
    const result = await handler({ ...parameters, query: url.searchParams, body, raw: request });
    if (!result || typeof result !== "object" || !Number.isInteger(result.status)) return contractError("Handler must return an integer HTTP status");
    if (route.responses) {
      const status = String(result.status);
      if (!Object.hasOwn(route.responses, status)) return contractError(`Handler returned undeclared HTTP status '${status}'`);
      const responseModel = route.responses[status];
      if (responseModel === null && result.body !== undefined) return contractError(`HTTP ${status} must not include an undeclared response body`);
      if (responseModel !== null) {
        const schema = schemas[responseModel];
        if (!schema) return contractError(`Missing response schema '${responseModel}'`);
        const error = validateJsonValue(schema, result.body, "$", schemas);
        if (error) return contractError(`Invalid HTTP ${status} response: ${error}`);
      }
    }
    const headers = new Headers(result.headers);
    if (result.body === undefined) return new Response(null, { status: result.status, headers });
    if (!headers.has("content-type")) headers.set("content-type", route.content?.response ?? "application/json");
    return new Response(JSON.stringify(result.body), { status: result.status, headers });
  };
}
