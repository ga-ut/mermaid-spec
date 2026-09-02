import { expect, test } from "bun:test";
import { emitJsonSchema, emitModelTypeScript, emitSql, parseErDiagram, validateJsonValue } from "../src/index.js";

const source = `erDiagram
  %% @model USER table
  %% @model Address value
  %% @model CreateUserInput schema
  %% @field USER.nickname optional nullable minLength=2 maxLength=40
  %% @field USER.status enum=active,suspended default="active"
  %% @field USER.score minimum=0 maximum=100
  %% @field CreateUserInput.address optional
  %% @field CreateUserInput.tags array minItems=1 maxItems=5
  USER {
    uuid id PK
    string nickname
    string status
    int score
  }
  Address {
    string city
    string country
  }
  CreateUserInput {
    email email
    Address address
    string tags
  }`;

test("separates table, schema, and value-object roles", () => {
  const model = parseErDiagram(source);
  expect(model.entities.map(({ name, role }) => ({ name, role }))).toEqual([
    { name: "USER", role: "table" },
    { name: "Address", role: "value" },
    { name: "CreateUserInput", role: "schema" },
  ]);
  const sql = emitSql(model);
  expect(sql).toContain('CREATE TABLE "user"');
  expect(sql).not.toContain('CREATE TABLE "address"');
  expect(sql).not.toContain('CREATE TABLE "create_user_input"');
});

test("emits optional, nullable, enum, array, nested, default, and constraints", () => {
  const model = parseErDiagram(source);
  const types = emitModelTypeScript(model);
  expect(types).toContain('"nickname"?: string | null;');
  expect(types).toContain('"status": "active" | "suspended";');
  expect(types).toContain('"address"?: Address;');
  expect(types).toContain('"tags": string[];');

  const schema = JSON.parse(emitJsonSchema(model));
  expect(schema.$defs.User.required).toEqual(["id", "status", "score"]);
  expect(schema.$defs.User.properties.nickname).toEqual({
    anyOf: [{ type: "string", minLength: 2, maxLength: 40 }, { type: "null" }],
  });
  expect(schema.$defs.User.properties.status).toEqual({ type: "string", enum: ["active", "suspended"], default: "active" });
  expect(schema.$defs.User.properties.score).toEqual({ type: "integer", minimum: 0, maximum: 100 });
  expect(schema.$defs.CreateUserInput.properties.address).toEqual({ $ref: "#/$defs/Address" });
  expect(schema.$defs.CreateUserInput.properties.tags).toEqual({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 });
});

test("rejects invalid model and field directives", () => {
  expect(() => parseErDiagram(`erDiagram
    %% @model USER unknown
    USER { uuid id PK }`)).toThrow(/Unsupported model role/);
  expect(() => parseErDiagram(`erDiagram
    %% @field USER.missing optional
    USER {
      uuid id PK
    }`)).toThrow(/unknown field/);
  expect(() => parseErDiagram(`erDiagram
    %% @field USER.score minimum=nope
    USER {
      int score
    }`)).toThrow(/Invalid minimum/);
  expect(() => parseErDiagram(`erDiagram
    USER {
      MissingType value
    }`)).toThrow(/Unknown model type/);
});

test("validates richer schemas at the runtime boundary", () => {
  const schema = JSON.parse(emitJsonSchema(parseErDiagram(source)));
  const valid = {
    email: "ada@example.test",
    address: { city: "Seoul", country: "KR" },
    tags: ["owner"],
  };
  expect(validateJsonValue(schema.$defs.CreateUserInput, valid, "$", schema.$defs)).toBeNull();
  expect(validateJsonValue(schema.$defs.CreateUserInput, { ...valid, tags: [] }, "$", schema.$defs)).toMatch(/at least 1 item/);
  expect(validateJsonValue(schema.$defs.User, { id: "123e4567-e89b-12d3-a456-426614174000", status: "deleted", score: 4 }, "$", schema.$defs)).toMatch(/allowed values/);
  expect(validateJsonValue(schema.$defs.User, { id: "123e4567-e89b-12d3-a456-426614174000", nickname: "x", status: "active", score: 101 }, "$", schema.$defs)).toMatch(/at least 2 characters|at most 100/);
  expect(validateJsonValue(schema.$defs.User, { id: "123e4567-e89b-12d3-a456-426614174000", nickname: null, status: "active", score: 10 }, "$", schema.$defs)).toBeNull();
});
