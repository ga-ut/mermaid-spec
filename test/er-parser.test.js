import { expect, test } from "bun:test";
import { emitJsonSchema, emitModelTypeScript, emitSql, parseErDiagram } from "../src/index.js";

const source = `erDiagram
  USER ||--o{ ACCOUNT : owns
  USER {
    uuid id PK
    email email UK
  }
  ACCOUNT {
    uuid id PK
    uuid userId FK
  }`;

test("parses Mermaid ER entities and relationships", () => {
  const model = parseErDiagram(source);
  expect(model.entities).toHaveLength(2);
  expect(model.entities[0].attributes[0].keys).toEqual(["PK"]);
  expect(model.relationships[0].label).toBe("owns");
});

test("emits TypeScript, JSON Schema, and PostgreSQL DDL", () => {
  const model = parseErDiagram(source);
  expect(emitModelTypeScript(model)).toMatch(/interface User/);
  expect(JSON.parse(emitJsonSchema(model)).$defs.User.properties.email.format).toBe("email");
  expect(emitSql(model)).toMatch(/"id" UUID NOT NULL PRIMARY KEY/);
  expect(emitSql(model)).toMatch(/ALTER TABLE "account" ADD FOREIGN KEY \("user_id"\) REFERENCES "user"\("id"\)/);
});

test("quotes Mermaid-safe field names in generated TypeScript", () => {
  const model = parseErDiagram(`erDiagram
    USER_RECORD {
      uuid user-id PK
    }`);
  expect(emitModelTypeScript(model)).toMatch(/interface UserRecord/);
  expect(emitModelTypeScript(model)).toMatch(/"user-id": string/);
});

test("emits order-independent foreign keys after table creation", () => {
  const model = parseErDiagram(`erDiagram
    ACCOUNT {
      uuid id PK
      uuid userId FK
    }
    USER {
      uuid id PK
    }
    USER ||--o{ ACCOUNT : owns`);
  const sql = emitSql(model);
  expect(sql.indexOf("CREATE TABLE \"user\"")).toBeLessThan(sql.indexOf("ALTER TABLE \"account\""));
});

test("emits composite primary keys and rejects ambiguous foreign keys", () => {
  const composite = parseErDiagram(`erDiagram
    MEMBERSHIP {
      uuid userId PK
      uuid teamId PK
    }`);
  expect(emitSql(composite)).toMatch(/PRIMARY KEY \("user_id", "team_id"\)/);

  const ambiguous = parseErDiagram(`erDiagram
    MEMBERSHIP {
      uuid userId PK
      uuid teamId PK
    }
    AUDIT {
      uuid id PK
      uuid membershipId FK
    }`);
  expect(() => emitSql(ambiguous)).toThrow(/single-column primary key/);
});
