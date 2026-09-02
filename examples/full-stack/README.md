# Full-stack Workboard

This example keeps one small product slice honest from Mermaid source to the browser:

- `specs/` defines persistent models, API input and error contracts, pagination, access requirements, state binding, and executable scenarios.
- `generated/` is deterministic compiler output and is committed for drift checks.
- `backend/` supplies application policy, lifecycle handlers, SQLite migrations, optimistic updates, and structured request logs.
- `frontend/` is a responsive service UI that creates and moves real persisted tasks through the generated API router.
- `test/` verifies invalid input, access denial, state rejection, UI output, pagination, schema migration, and restart recovery.
- `mermaid-spec.links.json` makes operations, models, transitions, the machine, and scenarios traceable to implementation, tests, and UI consumers where applicable.

Run the finite proof flow:

```bash
bun run example:full-stack
```

Run the actual service:

```bash
bun run example:full-stack:serve
```

Then open `http://localhost:3000`. Runtime data is written under `.data/`, which is ignored by Git.
