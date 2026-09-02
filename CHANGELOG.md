# Changelog

All notable changes are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## 1.1.0 - 2026-09-03

CLI distribution through npm. Bun remains the required runtime.

### Added

- `--help` / `-h`, help on an empty invocation, and command help without
  reading a specification.
- `--version` / `-v` reporting the installed package version.
- CLI-first instructions for `bunx`, global installation, a runnable first
  specification, and optional version pinning for teams and CI.
- Release packaging checks for installed CLI commands, package exports, and
  accidentally included local artifacts.

### Unchanged

- Contract syntax, generated artifact shapes, and application runtime behavior.
- Generated example manifests record the new compiler version.

## 1.0.0 - 2026-09-03

First GA-UT source release.

### Added

- Deterministic compilation of Mermaid-compatible ER, sequence, and state
  diagrams into TypeScript, JSON Schema, PostgreSQL DDL, OpenAPI, validating
  Fetch routing, and executable state machines.
- Explicit table, schema, and value-object roles with optional, nullable, array,
  nested, enum, default, and constraint support.
- Typed HTTP parameters, structured errors, pagination, media declarations, and
  security metadata.
- Model-bound workflows and behavioral scenarios that execute application guard
  and effect handlers.
- Stable contract graph, explicit code/test/consumer links, bounded context,
  change impact, compatibility, and migration-safety commands.
- Bootstrap-aware `impact` and `context` reports that expose missing required
  trace roles without relaxing completion-oriented verification.
- Nested model change propagation through direct, array, optional, and nullable
  references to affected APIs, implementations, consumers, and tests.
- Persistent Bun SQLite full-stack example with access policy, optimistic
  updates, structured logs, responsive UI, restart recovery, and trace coverage.
- Bun-only cross-platform CI, generated-artifact verification, OpenAPI linting,
  TypeScript checks, coverage gates, and installed-package smoke tests.

### Boundaries

- Business logic, identity and authorization decisions, database execution,
  framework UI, deployment, and operations remain application responsibilities.
- Multipart and streaming HTTP, generated browser clients, general unions,
  composite workflows, and distributed recovery are outside version 1.
