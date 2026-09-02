# Product readiness

`mermaid-spec` 1.0 is a production-ready contract compiler and traceability
harness for the bounded syntax it documents. It is not a general application
generator or a complete source of truth for every concern in a production
system.

## Evidence in this repository

Every supported contract layer is exercised in CI:

- `examples/product` covers OAuth-shaped request validation, application
  handlers, and generated transitions.
- `examples/issue-tracker` covers related persistence models, typed HTTP
  operations, request rejection, executable scenarios, and a bound lifecycle.
- `examples/full-stack` covers a persistent task service and responsive browser
  UI. It runs versioned Bun SQLite migrations, app-owned access policy,
  optimistic updates, structured request logs, generated routing and lifecycle
  code, pagination, restart recovery, and browser-consumer trace links.

The release gate rebuilds and runs every example, executes structural and
behavioral scenarios, enforces per-file test coverage thresholds, verifies
generated-file and trace-link drift, compiles generated TypeScript, validates
all generated OpenAPI documents, checks compatibility and migration reports,
and installs the packed archive for CLI and module smoke tests. CI runs the same
gate on Linux, macOS, and Windows with Bun.

This proves that the compiler can own the declared contracts for a bounded
vertical slice. It does not prove that generated artifacts replace application
design, security review, or operational validation.

## Practical fit

| Fit | Suitable use | Application responsibilities |
| --- | --- | --- |
| Strong | Internal tools, CRUD services, approval flows, webhook adapters, integration services, and lifecycle-heavy bounded contexts | Business handlers, identity and authorization, storage runtime, UI, logging, deployment |
| Conditional | Small public APIs and persistent products whose contracts fit the documented schema, HTTP, and state subsets | Versioning policy, migration review, concurrency, security, observability, backups, failure recovery |
| Additional architecture required | Payments, regulated data, public platform APIs, event-sourced systems, and distributed workflows | Idempotency, audit, transactional boundaries, secrets, threat controls, retries, compensation, availability design |

The last row is not a ban on using `mermaid-spec`. It means its contracts can be
one verified layer inside a larger architecture, not the evidence that the
whole system is safe or complete.

## Deliberate v1 boundaries

- JSON HTTP bodies only; no multipart, binary, streaming, or OAuth-flow setup.
- Security directives describe OpenAPI requirements and handler integration
  points; application code authenticates and authorizes requests.
- No general unions or polymorphic schemas.
- No generated framework components or browser SDK. Frontend code consumes the
  generated HTTP and model contracts and can be linked as a `consumer`.
- Flat deterministic state machines only; no composite states, timers, retries,
  or distributed compensation.
- Initial PostgreSQL DDL plus reviewable migration planning; no migration
  execution, transaction policy, arbitrary indexes, or online-schema-change
  orchestration.
- Bun is the supported runtime. Generated OpenAPI and schemas remain portable,
  but the CLI and JavaScript runtime are not tested under Node.js.

These boundaries keep the project focused on explicit contracts and
conformance. A feature should enter the compiler only when it can be represented
deterministically and tested end to end.

## Mermaid contribution path

Mermaid's primary product remains diagram rendering and documentation. Mermaid
documents an external-diagram registration API and a process for adding diagram
types; a broader plugin-based syntax proposal remains open. `mermaid-spec`
therefore fits today as an independent compiler over compatible source, not as a
claim that Mermaid core should generate applications.

Version 1 provides enough implementation evidence for a narrow upstream design
discussion. The credible proposal is a stable semantic-export or source-location
integration point that independent tools can consume. It should not ask Mermaid
to own business-code generation.

Before proposing it upstream:

1. Validate supported diagrams against Mermaid's current parser and preserve
   existing visual meaning.
2. Document concrete semantic-export consumers beyond this repository.
3. Prototype a separate diagram only when a new rendered diagram type is
   actually needed; do not silently redefine ER, sequence, or state diagrams.
4. Follow Mermaid's own contribution toolchain and visual regression process.

Current upstream references:

- [Mermaid project purpose](https://github.com/mermaid-js/mermaid#about)
- [External diagram registration API](https://mermaid.js.org/config/setup/mermaid/interfaces/Mermaid.html#registerexternaldiagrams)
- [Adding a new diagram](https://mermaid.js.org/community/new-diagram.html)
- [Mermaid contribution guide](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/docs/community/contributing.md)
- [Open plugin-based syntax proposal #7677](https://github.com/mermaid-js/mermaid/issues/7677)

## Release claim

The accurate public description is:

> A deterministic Mermaid contract compiler and traceability harness for
> bounded full-stack vertical slices.

Avoid describing it as a no-code app generator, a replacement for application
tests, or an official Mermaid extension.
