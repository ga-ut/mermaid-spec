import { expect, test } from "bun:test";
import { emitApiTypeScript, emitOpenApi, parseSequenceDiagram } from "../src/index.js";

const source = `sequenceDiagram
  actor Client
  participant API
  Client->>API: POST /users (createUser) body=User
  API-->>Client: 201 User`;

test("parses HTTP contracts from a Mermaid sequence diagram", () => {
  const contract = parseSequenceDiagram(source);
  expect(contract.operations[0].responses).toEqual([{ status: "201", model: "User" }]);
});

test("emits OpenAPI 3.1 paths", () => {
  const openapi = JSON.parse(emitOpenApi(parseSequenceDiagram(source), { $defs: { User: { type: "object" } } }));
  expect(openapi.paths["/users"].post.operationId).toBe("createUser");
  expect(openapi.paths["/users"].post.responses["201"].content["application/json"].schema.$ref).toBe("#/components/schemas/User");
});

test("declares OpenAPI path parameters", () => {
  const contract = parseSequenceDiagram(`sequenceDiagram
    Client->>API: GET /users/{user-id} (get-user)
    API-->>Client: 200 User`);
  const openapi = JSON.parse(emitOpenApi(contract, { $defs: { User: { type: "object" } } }));
  expect(openapi.paths["/users/{user-id}"].get.parameters).toEqual([{
    name: "user-id",
    in: "path",
    required: true,
    schema: { type: "string" },
  }]);
});

test("quotes operation identifiers in generated TypeScript", () => {
  const contract = parseSequenceDiagram(`sequenceDiagram
    Client->>API: GET /users (get-user)
    API-->>Client: 200 USER_RECORD`);
  const output = emitApiTypeScript(contract);
  expect(output).toMatch(/"get-user"\(request:/);
  expect(output).toMatch(/Models\.UserRecord/);
});

test("rejects malformed and duplicate path parameters", () => {
  expect(() => parseSequenceDiagram(`sequenceDiagram
    Client->>API: GET /users/{id}.json (getUser)
    API-->>Client: 200 User`)).toThrow(/Invalid path parameter/);
  expect(() => parseSequenceDiagram(`sequenceDiagram
    Client->>API: GET /users/{id}/{id} (getUser)
    API-->>Client: 200 User`)).toThrow(/Duplicate path parameter/);
});
