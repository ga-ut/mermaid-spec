import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject, createFetchHandler, emitApiTypeScript, emitOpenApi, parseSequenceDiagram } from "../src/index.js";

const source = `sequenceDiagram
  %% @param listIssues path team-id uuid required
  %% @param listIssues query status string optional
  %% @param listIssues query limit int optional minimum=1 maximum=100
  %% @param listIssues query cursor string optional
  %% @param listIssues header x-request-id uuid required
  %% @param listIssues cookie locale string optional
  %% @security listIssues bearer
  %% @error listIssues 401 ApiError
  %% @pagination listIssues cursor limit nextCursor
  %% @content listIssues response=application/json
  actor Client
  participant API
  Client->>API: GET /teams/{team-id}/issues (listIssues)
  API-->>Client: 200 IssuePage
  API-->>Client: 401 ApiError`;

test("parses typed HTTP parameter and pagination directives", () => {
  const operation = parseSequenceDiagram(source).operations[0];
  expect(operation.parameters).toEqual(expect.arrayContaining([
    { in: "path", name: "team-id", type: "uuid", required: true },
    { in: "query", name: "limit", type: "int", required: false, minimum: 1, maximum: 100 },
    { in: "header", name: "x-request-id", type: "uuid", required: true },
  ]));
  expect(operation.errors).toEqual([{ status: "401", model: "ApiError" }]);
  expect(operation.access).toEqual({ scheme: "bearer" });
  expect(operation.pagination).toEqual({ cursor: "cursor", limit: "limit", response: "nextCursor" });
  expect(operation.content).toEqual({ response: "application/json" });
});

test("emits typed OpenAPI parameter and pagination contracts", () => {
  const contract = parseSequenceDiagram(source);
  const openapi = JSON.parse(emitOpenApi(contract, { $defs: { Issue: { type: "object" }, IssuePage: { type: "object", properties: { items: { type: "array", items: { $ref: "#/$defs/Issue" } } } }, ApiError: { type: "object" } } }));
  const operationSpec = openapi.paths["/teams/{team-id}/issues"].get;
  expect(operationSpec.parameters.find((parameter) => parameter.name === "limit").schema).toEqual({ type: "integer", minimum: 1, maximum: 100 });
  expect(operationSpec.parameters.find((parameter) => parameter.name === "x-request-id").in).toBe("header");
  expect(operationSpec.responses["401"].description).toBe("Contract error 401");
  expect(operationSpec["x-mermaid-spec-pagination"]).toEqual({ cursor: "cursor", limit: "limit", response: "nextCursor" });
  expect(JSON.stringify(openapi)).toContain('"BearerAuth"');
  expect(JSON.stringify(openapi)).toContain('"scheme":"bearer"');
  expect(openapi.components.schemas.IssuePage.properties.items.items.$ref).toBe("#/components/schemas/Issue");

  const types = emitApiTypeScript(contract);
  expect(types).toContain('"team-id": string');
  expect(types).toContain('"limit"?: number');
  expect(types).toContain('"x-request-id": string');
});

test("parses declared HTTP input before handlers run", async () => {
  const routes = [{
    method: "GET",
    path: "/teams/{team-id}/issues",
    operationId: "listIssues",
    requestModel: null,
    responses: { 200: null },
    parameters: [
      { in: "path", name: "team-id", type: "uuid", required: true },
      { in: "query", name: "limit", type: "int", required: false, minimum: 1, maximum: 100 },
      { in: "header", name: "x-request-id", type: "uuid", required: true },
      { in: "cookie", name: "locale", type: "string", required: false },
    ],
  }];
  let received;
  const handle = createFetchHandler(routes, {
    listIssues: async (request) => {
      received = request;
      return { status: 200 };
    },
  });
  const url = "https://example.test/teams/123e4567-e89b-12d3-a456-426614174000/issues?limit=20";
  const missingHeader = await handle(new Request(url));
  expect(missingHeader.status).toBe(400);
  const invalid = await handle(new Request(url.replace("20", "0"), {
    headers: { "x-request-id": "123e4567-e89b-12d3-a456-426614174000" },
  }));
  expect(invalid.status).toBe(400);
  const valid = await handle(new Request(url, {
    headers: { "x-request-id": "123e4567-e89b-12d3-a456-426614174000", cookie: "locale=ko" },
  }));
  expect(valid.status).toBe(200);
  expect(received.params["team-id"]).toBe("123e4567-e89b-12d3-a456-426614174000");
  expect(received.queryParams.limit).toBe(20);
  expect(received.headers["x-request-id"]).toBe("123e4567-e89b-12d3-a456-426614174000");
  expect(received.cookies.locale).toBe("ko");
});

test("rejects inconsistent HTTP directives", () => {
  expect(() => parseSequenceDiagram(`sequenceDiagram
    %% @param missing query q string optional
    Client->>API: GET /items (listItems)
    API-->>Client: 200`)).toThrow(/unknown operation/);
  expect(() => parseSequenceDiagram(`sequenceDiagram
    %% @error listItems 400 ApiError
    Client->>API: GET /items (listItems)
    API-->>Client: 200`)).toThrow(/must match a declared response/);
  expect(() => parseSequenceDiagram(`sequenceDiagram
    %% @param listItems path missing uuid required
    Client->>API: GET /items/{id} (listItems)
    API-->>Client: 200`)).toThrow(/does not exist in route/);
});

test("validates the declared pagination response field across specs", async () => {
  const root = await mkdtemp(join(tmpdir(), "mermaid-spec-http-"));
  const valid = `\`\`\`mermaid
erDiagram
  %% @model IssuePage schema
  %% @model ApiError schema
  %% @field IssuePage.nextCursor optional nullable
  IssuePage {
    string nextCursor
  }
  ApiError {
    string error
  }
\`\`\`

\`\`\`mermaid
${source}
\`\`\`\n`;
  await Bun.write(join(root, "contract.md"), valid);
  expect((await compileProject(root)).apiContract.operations[0].pagination.response).toBe("nextCursor");
  await Bun.write(join(root, "contract.md"), valid.replace("@pagination listIssues cursor limit nextCursor", "@pagination listIssues cursor limit missingCursor"));
  await expect(compileProject(root)).rejects.toThrow(/requires response field/);
});
