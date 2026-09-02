import { expect, test } from "bun:test";
import { emitTypeScript, InvalidTransitionError, MissingHandlerError, parseStateDiagram, SpecError, testExamples, testScenarios, transition, transitionRecord, validateStateMachine } from "../src/index.js";

const validDiagram = `stateDiagram-v2
  [*] --> Pending
  Pending --> Paid : pay
  Paid --> Completed : complete
  Completed --> [*]`;

test("parses a deterministic state machine IR", () => {
  expect(parseStateDiagram(validDiagram, { name: "Order" })).toEqual({
    version: 1,
    kind: "stateMachine",
    name: "Order",
    initial: "Pending",
    states: ["Completed", "Paid", "Pending"],
    terminal: ["Completed"],
    transitions: [
      { from: "Pending", event: "pay", to: "Paid" },
      { from: "Paid", event: "complete", to: "Completed" },
    ],
    examples: [],
    scenarios: [],
  });
});

test("rejects an unlabeled transition instead of guessing", () => {
  expect(() => parseStateDiagram("stateDiagram-v2\n[*] --> A\nA --> B")).toThrow(SpecError);
  expect(() => parseStateDiagram("stateDiagram-v2\n[*] --> A\nA --> B")).toThrow(/requires an event label/);
});

test("rejects nondeterministic duplicate events", () => {
  expect(() => parseStateDiagram("stateDiagram-v2\n[*] --> A\nA --> B : go\nA --> C : go")).toThrow(SpecError);
  expect(() => parseStateDiagram("stateDiagram-v2\n[*] --> A\nA --> B : go\nA --> C : go")).toThrow(/Duplicate event/);
});

test("reports unreachable states", () => {
  const spec = parseStateDiagram("stateDiagram-v2\n[*] --> A\nA --> [*]\nB --> C : go");
  expect(validateStateMachine(spec).map((item) => item.code)).toEqual(["UNREACHABLE_STATE", "UNREACHABLE_STATE"]);
});

test("emits runnable TypeScript state transition code", () => {
  const output = emitTypeScript(parseStateDiagram(validDiagram, { name: "Order" }));
  expect(output).toMatch(/export type OrderState/);
  expect(output).toMatch(/export async function transitionOrder/);
  expect(output).toMatch(/"pay": "Paid"/);
});

test("executes guards and effects in the runtime", async () => {
  const spec = parseStateDiagram("stateDiagram-v2\n[*] --> Pending\nPending --> Paid : pay [approved] / record");
  const result = await transition(spec, "Pending", "pay", { approved: true }, {
    guards: { approved: (context) => context.approved },
    effects: { record: (context) => ({ ...context, recorded: true }) },
  });
  expect(result).toEqual({ state: "Paid", context: { approved: true, recorded: true } });
});

test("requires declared handlers", async () => {
  const spec = parseStateDiagram("stateDiagram-v2\n[*] --> A\nA --> B : go [allowed]");
  await expect(transition(spec, "A", "go", {}, {})).rejects.toBeInstanceOf(MissingHandlerError);
});

test("reports invalid runtime transitions", async () => {
  const spec = parseStateDiagram("stateDiagram-v2\n[*] --> A\nA --> B : go");
  await expect(transition(spec, "B", "go", {})).rejects.toBeInstanceOf(InvalidTransitionError);
});

test("runs embedded transition examples", () => {
  const spec = parseStateDiagram("stateDiagram-v2\n[*] --> A\nA --> B : go\n%% @test A --go--> B\n%% @test B --go--> !invalid");
  expect(testExamples(spec).every((example) => example.passed)).toBe(true);
});

test("executes behavioral scenarios through real handlers", async () => {
  const spec = parseStateDiagram(`stateDiagram-v2
[*] --> Pending
Pending --> Paid : pay [approved] / record
%% @scenario accepted Pending --pay--> Paid context={"approved":true} expect={"recorded":true}
%% @scenario rejected Pending --pay--> !invalid context={"approved":false}`);
  const results = await testScenarios(spec, {
    guards: { approved: (context) => context.approved },
    effects: { record: (context) => ({ ...context, recorded: true }) },
  });
  expect(results.every((result) => result.passed)).toBe(true);
  expect(results[0].actualContext.recorded).toBe(true);
});

test("does not treat a missing scenario handler as an expected rejection", async () => {
  const spec = parseStateDiagram(`stateDiagram-v2
[*] --> Pending
Pending --> Paid : pay [approved]
%% @scenario rejected Pending --pay--> !invalid context={"approved":false}`);
  const [result] = await testScenarios(spec);
  expect(result.passed).toBe(false);
  expect(result.actual).toBe("!harness-error");
  expect(result.error).toMatch(/Missing guard handler/);
});

test("transitions a record through its bound state field", async () => {
  const spec = parseStateDiagram(`stateDiagram-v2
%% @name Payment
%% @bind PAYMENT.status
[*] --> Pending
Pending --> Paid : pay`);
  const result = await transitionRecord(spec, { id: "one", status: "Pending" }, "pay", {}, {});
  expect(result.record).toEqual({ id: "one", status: "Paid" });
  expect(emitTypeScript(spec)).toMatch(/transitionPaymentRecord/);
});

test("rejects malformed and duplicate state directives", () => {
  expect(() => parseStateDiagram("stateDiagram-v2\n%% @scenario bad A --go--> B context=nope\n[*] --> A\nA --> B : go")).toThrow(/compact JSON/);
  expect(() => parseStateDiagram("stateDiagram-v2\n%% @bind A.state\n%% @bind B.state\n[*] --> A")).toThrow(/Duplicate @bind/);
});
