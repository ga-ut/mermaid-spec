import { SpecError } from "./errors.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function assertIdentifier(value, line) {
  if (!IDENTIFIER.test(value)) {
    throw new SpecError(`Invalid state identifier '${value}'`, line);
  }
}

/** Parse a strict, deterministic subset of Mermaid stateDiagram-v2. */
export function parseStateDiagram(source, options = {}) {
  let name = options.name ?? "StateMachine";
  const states = new Set();
  const transitions = [];
  const examples = [];
  const scenarios = [];
  let binding = null;
  let initial = null;
  const terminal = new Set();
  let foundHeader = false;

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith("%%")) {
      const nameDirective = line.match(/^%%\s*@name\s+([A-Za-z_][A-Za-z0-9_-]*)$/);
      if (nameDirective) {
        name = nameDirective[1];
        continue;
      }
      const bindDirective = line.match(/^%%\s*@bind\s+([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_-]*)$/);
      if (bindDirective) {
        if (binding) throw new SpecError("Duplicate @bind directive", lineNumber);
        binding = { model: bindDirective[1], field: bindDirective[2] };
        continue;
      }
      const example = line.match(/^%%\s*@test\s+([A-Za-z_][A-Za-z0-9_-]*)\s+--([A-Za-z_][A-Za-z0-9_-]*)-->\s+([A-Za-z_][A-Za-z0-9_-]*|!invalid)$/);
      if (example) {
        examples.push({ from: example[1], event: example[2], expected: example[3] });
        continue;
      }
      const scenario = line.match(/^%%\s*@scenario\s+([A-Za-z_][A-Za-z0-9_-]*)\s+([A-Za-z_][A-Za-z0-9_-]*)\s+--([A-Za-z_][A-Za-z0-9_-]*)-->\s+([A-Za-z_][A-Za-z0-9_-]*|!invalid)\s+context=(\S+)(?:\s+expect=(\S+))?$/);
      if (scenario) {
        if (scenarios.some((item) => item.name === scenario[1])) throw new SpecError(`Duplicate scenario '${scenario[1]}'`, lineNumber);
        let context;
        let expectedContext;
        try {
          context = JSON.parse(scenario[5]);
          if (scenario[6]) expectedContext = JSON.parse(scenario[6]);
        } catch {
          throw new SpecError(`Scenario '${scenario[1]}' requires compact JSON context values`, lineNumber);
        }
        if (!context || typeof context !== "object" || Array.isArray(context)) throw new SpecError(`Scenario '${scenario[1]}' context must be an object`, lineNumber);
        if (expectedContext !== undefined && (!expectedContext || typeof expectedContext !== "object" || Array.isArray(expectedContext))) throw new SpecError(`Scenario '${scenario[1]}' expectation must be an object`, lineNumber);
        if (scenario[4] === "!invalid" && expectedContext !== undefined) throw new SpecError(`Invalid scenario '${scenario[1]}' cannot declare a context expectation`, lineNumber);
        scenarios.push({ name: scenario[1], from: scenario[2], event: scenario[3], expected: scenario[4], context, ...(expectedContext !== undefined ? { expectedContext } : {}) });
        continue;
      }
      if (/^%%\s*@(test|scenario|bind)\b/.test(line)) throw new SpecError(`Invalid state directive '${line}'`, lineNumber);
      continue;
    }

    if (/^stateDiagram(?:-v2)?$/.test(line)) {
      if (foundHeader) throw new SpecError("Duplicate stateDiagram header", lineNumber);
      foundHeader = true;
      continue;
    }
    if (!foundHeader) throw new SpecError("Expected stateDiagram-v2 header", lineNumber);
    if (/^direction\s+(TB|BT|LR|RL)$/.test(line)) continue;

    const declaration = line.match(/^state\s+"([^"]+)"\s+as\s+([A-Za-z_][A-Za-z0-9_-]*)$/);
    if (declaration) {
      states.add(declaration[2]);
      continue;
    }

    const transition = line.match(/^(\[\*\]|[A-Za-z_][A-Za-z0-9_-]*)\s*-->\s*(\[\*\]|[A-Za-z_][A-Za-z0-9_-]*)(?:\s*:\s*(.+))?$/);
    if (!transition) {
      throw new SpecError(`Unsupported or ambiguous statement '${line}'`, lineNumber);
    }

    const [, from, to, rawLabel] = transition;
    if (from !== "[*]") assertIdentifier(from, lineNumber);
    if (to !== "[*]") assertIdentifier(to, lineNumber);

    if (from === "[*]") {
      if (to === "[*]") throw new SpecError("Start cannot transition directly to end", lineNumber);
      if (initial) throw new SpecError(`Multiple initial states: '${initial}' and '${to}'`, lineNumber);
      initial = to;
      states.add(to);
      continue;
    }

    states.add(from);
    if (to === "[*]") {
      terminal.add(from);
      continue;
    }

    states.add(to);
    const label = rawLabel?.trim();
    if (!label) {
      throw new SpecError(`Transition '${from} --> ${to}' requires an event label`, lineNumber);
    }
    const labelParts = label.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:\s*\[([A-Za-z_][A-Za-z0-9_-]*)\])?(?:\s*\/\s*([A-Za-z_][A-Za-z0-9_-]*))?$/);
    if (!labelParts) throw new SpecError(`Invalid transition label '${label}'`, lineNumber);
    const [, event, guard, effect] = labelParts;

    if (transitions.some((item) => item.from === from && item.event === event)) {
      throw new SpecError(`Duplicate event '${event}' from state '${from}'`, lineNumber);
    }
    transitions.push({ from, event, to, ...(guard ? { guard } : {}), ...(effect ? { effect } : {}) });
  }

  if (!foundHeader) throw new SpecError("Expected stateDiagram-v2 header");
  if (!initial) throw new SpecError("State diagram requires exactly one initial transition");
  for (const scenario of scenarios) {
    if (!states.has(scenario.from)) throw new SpecError(`Scenario '${scenario.name}' starts from unknown state '${scenario.from}'`);
    if (scenario.expected !== "!invalid" && !states.has(scenario.expected)) throw new SpecError(`Scenario '${scenario.name}' expects unknown state '${scenario.expected}'`);
  }

  return {
    version: 1,
    kind: "stateMachine",
    name,
    initial,
    states: [...states].sort(),
    terminal: [...terminal].sort(),
    transitions,
    examples,
    scenarios,
    ...(binding ? { binding } : {}),
  };
}
