import { modelTypeName } from "./model-emitter.js";

function modelType(name) {
  return name ? `Models.${modelTypeName(name)}` : "unknown";
}

function parameterSchema(parameter) {
  const type = ["int", "integer"].includes(parameter.type) ? "integer" : parameter.type === "float" ? "number" : parameter.type === "boolean" ? "boolean" : "string";
  const format = parameter.type === "uuid" || parameter.type === "email" || parameter.type === "date" ? parameter.type : parameter.type === "datetime" ? "date-time" : undefined;
  const schema = { type, ...(format ? { format } : {}) };
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "pattern", "enum"]) if (parameter[key] !== undefined) schema[key] = parameter[key];
  return schema;
}

function operationParameters(operation) {
  return operation.parameters ?? [...operation.path.matchAll(/\{([^{}]+)\}/g)].map((match) => ({ in: "path", name: match[1], type: "string", required: true }));
}

function openApiParameter(parameter) {
  return { name: parameter.name, in: parameter.in, required: parameter.required, schema: parameterSchema(parameter) };
}

function accessSchemeName(access) {
  if (access.scheme === "bearer") return "BearerAuth";
  return `ApiKey_${access.in}_${access.name}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function parameterType(parameter) {
  return ["int", "integer", "float"].includes(parameter.type) ? "number" : parameter.type === "boolean" ? "boolean" : "string";
}

function openApiSchema(value) {
  if (Array.isArray(value)) return value.map(openApiSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "$ref" && typeof item === "string" ? item.replace(/^#\/\$defs\//, "#/components/schemas/") : openApiSchema(item)]));
}

function parameterObject(operation, location) {
  const parameters = operationParameters(operation).filter((parameter) => parameter.in === location);
  if (!parameters.length) return "Record<string, never>";
  return `{ ${parameters.map((parameter) => `${JSON.stringify(parameter.name)}${parameter.required ? "" : "?"}: ${parameterType(parameter)}`).join("; ")} }`;
}

function routeMetadata(operation) {
  const metadata = {
    method: operation.method,
    path: operation.path,
    operationId: operation.operationId,
    requestModel: operation.requestModel ? modelTypeName(operation.requestModel) : null,
    responses: Object.fromEntries(operation.responses.map((response) => [response.status, response.model ? modelTypeName(response.model) : null])),
  };
  const parameters = operationParameters(operation);
  if (parameters.length) metadata.parameters = parameters;
  if (operation.access) metadata.access = operation.access;
  if (operation.content) metadata.content = operation.content;
  if (operation.pagination) metadata.pagination = operation.pagination;
  if (operation.errors) metadata.errors = operation.errors;
  return metadata;
}

function emitRoutes(contract) {
  return contract.operations.map((operation) => `  ${JSON.stringify(routeMetadata(operation))}`).join(",\n");
}

export function emitOpenApi(contract, modelSchema) {
  const paths = {};
  const securitySchemes = {};
  for (const operation of contract.operations) {
    const responses = {};
    for (const response of operation.responses) {
      const error = operation.errors?.some((candidate) => candidate.status === response.status);
      const mediaType = operation.content?.response ?? "application/json";
      responses[response.status] = {
        description: error ? `Contract error ${response.status}` : `HTTP ${response.status}`,
        ...(response.model ? { content: { [mediaType]: { schema: { $ref: `#/components/schemas/${modelTypeName(response.model)}` } } } } : {}),
      };
    }
    const parameters = operationParameters(operation);
    const requestMediaType = operation.content?.request ?? "application/json";
    let access;
    if (operation.access) {
      const name = accessSchemeName(operation.access);
      securitySchemes[name] = operation.access.scheme === "bearer"
        ? { type: "http", scheme: "bearer" }
        : { type: "apiKey", in: operation.access.in, name: operation.access.name };
      access = [{ [name]: [] }];
    }
    paths[operation.path] ??= {};
    paths[operation.path][operation.method.toLowerCase()] = {
      operationId: operation.operationId,
      ...(parameters.length ? { parameters: parameters.map(openApiParameter) } : {}),
      ...(operation.requestModel ? { requestBody: { required: true, content: { [requestMediaType]: { schema: { $ref: `#/components/schemas/${modelTypeName(operation.requestModel)}` } } } } } : {}),
      ...(access ? { security: access } : {}),
      ...(operation.pagination ? { "x-mermaid-spec-pagination": operation.pagination } : {}),
      responses,
    };
  }
  return `${JSON.stringify({ openapi: "3.1.0", info: { title: "Generated API", version: "1.0.0" }, paths, components: { schemas: openApiSchema(modelSchema.$defs ?? {}), ...(Object.keys(securitySchemes).length ? { securitySchemes } : {}) } }, null, 2)}\n`;
}

export function emitApiTypeScript(contract) {
  const handlers = contract.operations.map((operation) => {
    const outputs = operation.responses.map((response) => `ApiResponse<${Number(response.status)}, ${response.model ? modelType(response.model) : "never"}>`).join(" | ");
    const request = operation.requestModel ? modelType(operation.requestModel) : "undefined";
    return `  ${JSON.stringify(operation.operationId)}(request: ApiRequest<${request}, ${parameterObject(operation, "path")}, ${parameterObject(operation, "query")}, ${parameterObject(operation, "header")}, ${parameterObject(operation, "cookie")} >): Promise<${outputs}>;`;
  }).join("\n");
  return `// Generated by mermaid-spec. Do not edit.\nimport type * as Models from "./models.generated.js";\n\nexport interface ApiRequest<Body = unknown, Params = Record<string, string>, Query = Record<string, never>, HeaderValues = Record<string, never>, Cookies = Record<string, never>> { params: Params; query: URLSearchParams; queryParams: Query; headers: HeaderValues; cookies: Cookies; body: Body; raw: Request; }\nexport interface ApiResponse<Status extends number = number, Body = unknown> { status: Status; body?: Body; headers?: Record<string, string>; }\n\nexport interface ApiHandlers {\n${handlers}\n}\n\nexport const routes = [\n${emitRoutes(contract)}\n] as const;\n`;
}

export function emitApiJavaScript(contract, modelSchema = {}) {
  const schemas = modelSchema.$defs ?? {};
  return `// Generated by mermaid-spec. Do not edit.\nimport { createFetchHandler } from "@ga-ut/mermaid-spec/http";\n\nexport const routes = [\n${emitRoutes(contract)}\n];\n\nexport const schemas = ${JSON.stringify(schemas, null, 2)};\n\nexport function createApiHandler(handlers) {\n  return createFetchHandler(routes, handlers, schemas);\n}\n`;
}
