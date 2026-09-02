import { expect, test } from "bun:test";
import { createFetchHandler, validateJsonValue } from "../src/index.js";

const userSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
  },
  required: ["id", "email"],
};

test("dispatches typed-style Fetch handlers with path params", async () => {
  const handle = createFetchHandler([{ method: "POST", path: "/users/{id}", operationId: "updateUser" }], {
    updateUser: async ({ params, body }) => ({ status: 200, body: { id: params.id, name: body.name } }),
  });
  const response = await handle(new Request("https://example.test/users/a%20b", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ada" }) }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: "a b", name: "Ada" });
});

test("returns deterministic HTTP errors", async () => {
  const handle = createFetchHandler([], {});
  expect((await handle(new Request("https://example.test/missing"))).status).toBe(404);
});

test("rejects malformed and non-JSON request bodies", async () => {
  const route = [{ method: "POST", path: "/users", operationId: "createUser" }];
  const handle = createFetchHandler(route, { createUser: async () => ({ status: 201 }) });
  const wrongType = await handle(new Request("https://example.test/users", { method: "POST", body: "plain text" }));
  expect(wrongType.status).toBe(400);
  const malformed = await handle(new Request("https://example.test/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  }));
  expect(malformed.status).toBe(400);
});

test("validates generated request and response contracts", async () => {
  let calls = 0;
  const routes = [{ method: "POST", path: "/users", operationId: "createUser", requestModel: "User", responses: { 201: "User" } }];
  const handle = createFetchHandler(routes, {
    createUser: async ({ body }) => {
      calls += 1;
      return { status: 201, body };
    },
  }, { User: userSchema });

  const invalid = await handle(new Request("https://example.test/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "not-a-uuid" }),
  }));
  expect(invalid.status).toBe(400);
  expect(calls).toBe(0);

  const validBody = { id: "123e4567-e89b-12d3-a456-426614174000", email: "ada@example.test" };
  const valid = await handle(new Request("https://example.test/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody),
  }));
  expect(valid.status).toBe(201);
  expect(await valid.json()).toEqual(validBody);
  expect(calls).toBe(1);
});

test("returns 500 for handler contract violations", async () => {
  const routes = [{ method: "GET", path: "/users", operationId: "listUsers", requestModel: null, responses: { 200: "User" } }];
  const wrongStatus = createFetchHandler(routes, { listUsers: async () => ({ status: 202 }) }, { User: userSchema });
  const undeclared = await wrongStatus(new Request("https://example.test/users"));
  expect(undeclared.status).toBe(500);
  expect((await undeclared.json()).error).toBe("contract_violation");

  const wrongBody = createFetchHandler(routes, { listUsers: async () => ({ status: 200, body: { id: "bad", email: "bad" } }) }, { User: userSchema });
  const invalid = await wrongBody(new Request("https://example.test/users"));
  expect(invalid.status).toBe(500);
  expect((await invalid.json()).message).toMatch(/Invalid HTTP 200 response/);
});

test("rejects bodies that are absent from the generated contract", async () => {
  const routes = [{ method: "POST", path: "/jobs", operationId: "startJob", requestModel: null, responses: { 202: null } }];
  const handle = createFetchHandler(routes, { startJob: async () => ({ status: 202 }) });
  const response = await handle(new Request("https://example.test/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unexpected: true }),
  }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe("invalid_request");
});

test("does not misclassify handler TypeErrors as invalid requests", async () => {
  const handle = createFetchHandler([{ method: "GET", path: "/failure", operationId: "fail" }], {
    fail: async () => { throw new TypeError("internal handler failure"); },
  });
  await expect(handle(new Request("https://example.test/failure"))).rejects.toThrow(/internal handler failure/);
});

test("validates the emitted JSON Schema subset", () => {
  expect(validateJsonValue(userSchema, { id: "123e4567-e89b-12d3-a456-426614174000", email: "ada@example.test" })).toBeNull();
  expect(validateJsonValue(userSchema, { id: "123e4567-e89b-12d3-a456-426614174000", email: "ada@example.test", role: "admin" })).toMatch(/role.*not allowed/);
  expect(validateJsonValue({ type: "object" }, null)).toMatch(/received null/);
  expect(validateJsonValue({ type: "object" }, [])).toMatch(/received array/);
  expect(validateJsonValue({ type: "integer" }, 1)).toBeNull();
  expect(validateJsonValue({ type: "number" }, Number.POSITIVE_INFINITY)).toMatch(/finite number/);
  expect(validateJsonValue({ type: "boolean" }, "true")).toMatch(/must be a boolean/);
  expect(validateJsonValue({ type: "array", items: { type: "string" } }, ["ok"])).toBeNull();
});
