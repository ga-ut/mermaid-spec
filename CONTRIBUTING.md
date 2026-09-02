# Contributing

Contributions that preserve deterministic contracts and the documented scope
are welcome.

## Before changing code

1. Read [`docs/syntax.md`](./docs/syntax.md) for the accepted grammar and
   [`docs/versioning.md`](./docs/versioning.md) for compatibility rules.
2. Install Bun 1.3.14 or newer and run `bun ci`.
3. Keep generated business decisions out of the compiler. Guards, effects,
   authorization, storage execution, and UI behavior belong to the application.

## Verification

```bash
bun run verify
```

A syntax or generator change needs parser rejection tests, emitted-artifact and
runtime tests where applicable, documentation, and at least one executable
example. Rebuild committed generated files with the repository scripts; do not
edit them by hand.

Keep commits focused and do not include private specifications, local databases,
coverage output, build directories, or other generated local state.

## Proposals

Open an issue before a broad grammar or architecture change. Describe the
contract that cannot currently be expressed, the deterministic output and
failure behavior, compatibility impact, and which application responsibility
remains outside the compiler.
