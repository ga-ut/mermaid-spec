# Spec-driven development harness

`mermaid-spec` assigns stable identities to compiled models, API operations,
state machines, transitions, guards, and effects. The generated contract graph
lets a repository declare which implementation and test files realize each
contract without guessing code semantics.

## Contract graph

Every project build emits `contract-graph.generated.json`. Representative IDs
look like:

```text
model:CreateTaskInput
operation:createTask
machine:TaskLifecycle
transition:TaskLifecycle:Open:complete
guard:TaskLifecycle:canComplete
effect:TaskLifecycle:recordCompletion
```

Dependencies point from a consumer to the contract it uses. For example,
`operation:createTask` depends on its request and response models, and a state
machine depends on its transitions. Model fields also depend on referenced
models, including direct, array, optional, and nullable references. A nested
model change therefore propagates through response wrappers to the operations,
implementations, consumers, and tests that use it.

Inspect the graph with:

```bash
bunx mermaid-spec graph ./specs
bunx mermaid-spec graph ./specs --json
```

## Explicit implementation and test links

Keep a trace configuration at the implementation repository root. Paths are
relative to that file and must remain inside its directory tree.

```json
{
  "version": 1,
  "links": [
    {
      "contract": "operation:createTask",
      "role": "implementation",
      "path": "src/tasks/create-task.ts"
    },
    {
      "contract": "operation:createTask",
      "role": "test",
      "path": "test/tasks/create-task.test.ts"
    }
  ],
  "requirements": [
    {
      "kind": "operation",
      "roles": ["implementation", "test"]
    }
  ]
}
```

Supported roles are `implementation`, `test`, `consumer`, and
`documentation`. Validation fails for unknown contract IDs, missing files,
duplicate links, unsupported roles, or a contract that lacks a required role.

```bash
bunx mermaid-spec verify ./specs --out ./generated \
  --links ./mermaid-spec.links.json
```

Links are intentionally explicit. The harness does not infer that an arbitrary
file correctly implements a contract merely because it imports a generated
type.

## Bounded implementation context

Retrieve the contract, its dependencies, dependents, and linked files for one
work item:

```bash
bunx mermaid-spec context ./specs \
  --id operation:createTask \
  --links ./mermaid-spec.links.json
```

Add `--include-files` to include the linked source text in the local output for
a human or coding agent. Individual linked files are limited to 64 KiB. Use
`--json` for tool integration. `context` remains available while a new contract
is missing required links and reports those roles as `coverageGaps`; malformed,
unknown, missing, duplicate, or out-of-tree link targets still fail.

## Change impact

Compare the current specifications with a previously generated graph before
overwriting the baseline:

```bash
bunx mermaid-spec impact ./specs \
  --baseline ./generated/contract-graph.generated.json \
  --links ./mermaid-spec.links.json
```

The report separates added, modified, and removed contracts; propagates changes
to dependent contracts; lists linked tests; and marks non-test files for review.
It does not claim that an implementation is semantically correct without a
passing conformance test.

When an added contract has not been implemented yet, `impact` reports each
required but missing implementation, test, consumer, or documentation role in
`coverageGaps` instead of stopping discovery. A coding agent can use the
contract context to create those targets and add explicit links. Completion is
still strict: `verify`, `graph`, `compatibility`, and `migration` fail until all
configured role requirements are satisfied.

For CI, keep the baseline graph on the target branch or retrieve it from Git,
run `impact`, then rebuild and run the listed tests. A release verification
should still run the full test suite.

## Compatibility and migration safety

Use a committed graph from the last released contract as the baseline before rebuilding generated files:

```bash
bunx mermaid-spec compatibility ./specs \
  --baseline ./baseline/contract-graph.generated.json \
  --links ./mermaid-spec.links.json

bunx mermaid-spec migration ./specs \
  --baseline ./baseline/contract-graph.generated.json
```

`compatibility` exits non-zero for breaking changes. It classifies model fields, HTTP inputs and responses, access requirements, state-machine shape, and transitions as breaking, non-breaking, or requiring review. `--allow-breaking` is an explicit escape hatch for an intentionally versioned release.

`migration` extracts database changes from the same comparison. Additive nullable columns and new tables can include reviewable PostgreSQL statements. Required columns without a default, removed tables or columns, and unsafe shape changes are never emitted as destructive SQL and make the command fail. Changes such as a required field with a default or a new foreign key are marked for review because existing data size and locking behavior are application concerns. `--allow-unsafe` only changes the CLI exit status; it does not execute SQL.

The JSON forms are stable inputs for CI annotations or an AI coding harness:

```bash
bunx mermaid-spec compatibility ./specs --baseline ./baseline/contract-graph.generated.json --json
bunx mermaid-spec migration ./specs --baseline ./baseline/contract-graph.generated.json --json
```
