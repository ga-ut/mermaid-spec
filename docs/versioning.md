# Versioning policy

`mermaid-spec` follows Semantic Versioning for its supported CLI, JavaScript
exports, source directives, intermediate contract graph, generated artifact
shapes, and documented runtime behavior.

## Guarantees within a major version

- The same `mermaid-spec` version and source bytes produce the same generated
  bytes on every supported operating system.
- Supported source syntax does not change meaning in a minor or patch release.
- Stable contract IDs and graph fields remain compatible unless a major release
  explicitly migrates them.
- Existing CLI commands and flags keep their meaning. New optional flags may be
  added in a minor release.
- Patch releases correct behavior without intentionally expanding or narrowing
  accepted contracts.

## Change levels

A major release is required to remove or reinterpret accepted syntax, change a
generated public shape incompatibly, remove an export or CLI option, change
validation outcomes incompatibly, or alter contract graph identities.

A minor release may add an opt-in directive, emitter, report field, CLI option,
or runtime capability while preserving existing behavior.

A patch release may fix incorrect parsing, validation, generation, reporting,
documentation, or packaging when the documented contract already determines
the corrected result.

Generated files include the compiler version in their manifest. Upgrade the
package, rebuild every committed artifact, inspect the diff, and run the full
verification gate in the same change.

## Product contracts are versioned separately

Package SemVer describes the compiler. The contracts compiled for an
application have their own compatibility boundary.

Before replacing a released baseline, run:

```bash
bunx mermaid-spec compatibility ./specs \
  --baseline ./baseline/contract-graph.generated.json
bunx mermaid-spec migration ./specs \
  --baseline ./baseline/contract-graph.generated.json
```

An intentional application breaking change may use `--allow-breaking` only
after its consumers have an explicit migration plan. `--allow-unsafe` changes
the migration command's exit status; it never emits or executes destructive
SQL.

## Deprecation

When practical, a public feature is documented as deprecated for at least one
minor release before removal in the next major release. Security or correctness
issues may require immediate failure; the release notes must explain the
affected input and replacement.
