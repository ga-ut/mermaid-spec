export class InvalidTransitionError extends Error {
  constructor(state, event) {
    super(`Invalid transition: ${state} --${event}--> ?`);
    this.name = "InvalidTransitionError";
  }
}

export class MissingHandlerError extends Error {
  constructor(kind, name) {
    super(`Missing ${kind} handler '${name}'`);
    this.name = "MissingHandlerError";
  }
}

export async function transition(spec, state, event, context, handlers = {}) {
  const candidate = spec.transitions.find((item) => item.from === state && item.event === event);
  if (!candidate) throw new InvalidTransitionError(state, event);
  if (candidate.guard) {
    const guard = handlers.guards?.[candidate.guard];
    if (!guard) throw new MissingHandlerError("guard", candidate.guard);
    if (!(await guard(context))) throw new InvalidTransitionError(state, event);
  }
  let nextContext = context;
  if (candidate.effect) {
    const effect = handlers.effects?.[candidate.effect];
    if (!effect) throw new MissingHandlerError("effect", candidate.effect);
    const result = await effect(context);
    if (result !== undefined) nextContext = result;
  }
  return { state: candidate.to, context: nextContext };
}

export async function transitionRecord(spec, record, event, context, handlers = {}) {
  if (!spec.binding) throw new Error(`State machine '${spec.name}' is not bound to a model field`);
  if (!record || typeof record !== "object") throw new TypeError("Bound transition requires a record object");
  const state = record[spec.binding.field];
  const result = await transition(spec, state, event, context, handlers);
  return { ...result, record: { ...record, [spec.binding.field]: result.state } };
}

export function testExamples(spec) {
  return spec.examples.map((example) => {
    const candidate = spec.transitions.find((item) => item.from === example.from && item.event === example.event);
    const actual = candidate?.to ?? "!invalid";
    return { ...example, actual, passed: actual === example.expected };
  });
}

function matchesExpectation(actual, expected) {
  if (!expected || typeof expected !== "object") return Object.is(actual, expected);
  if (!actual || typeof actual !== "object") return false;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => matchesExpectation(actual[index], item));
  return Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && matchesExpectation(actual[key], value));
}

export async function testScenarios(spec, handlers = {}) {
  const results = [];
  for (const scenario of spec.scenarios ?? []) {
    let actual = "!invalid";
    let actualContext = scenario.context;
    let error;
    try {
      const result = await transition(spec, scenario.from, scenario.event, structuredClone(scenario.context), handlers);
      actual = result.state;
      actualContext = result.context;
    } catch (cause) {
      if (!(cause instanceof InvalidTransitionError)) {
        actual = "!harness-error";
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    const contextPassed = scenario.expectedContext === undefined || matchesExpectation(actualContext, scenario.expectedContext);
    results.push({ ...scenario, actual, actualContext, ...(error ? { error } : {}), passed: actual === scenario.expected && contextPassed });
  }
  return results;
}
