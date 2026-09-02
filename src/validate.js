export function validateStateMachine(spec) {
  const diagnostics = [];
  const reachable = new Set([spec.initial]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const transition of spec.transitions) {
      if (reachable.has(transition.from) && !reachable.has(transition.to)) {
        reachable.add(transition.to);
        changed = true;
      }
    }
  }

  for (const state of spec.states) {
    if (!reachable.has(state)) {
      diagnostics.push({ level: "error", code: "UNREACHABLE_STATE", message: `State '${state}' is unreachable` });
    }
  }
  return diagnostics;
}
