# Worklog - Sprint 0 (2026-09-17)

## What was done

- Scaffolded the repo: TypeScript strict (ES2023, NodeNext), ESLint 10 flat config, Prettier, Vitest 5, tsx watcher, Node 24 engines pin.
- Implemented the walking skeleton: src/server.ts (loopback-only listener on 127.0.0.1, PORT env, graceful SIGINT/SIGTERM shutdown), src/http/app.ts (Hono app factory with JSON error middleware, structured request logs, GET /api/health), src/database.ts (WAL + foreign_keys + busy_timeout, idempotent migrations), src/migrate.ts (standalone runner), migrations/001_init.sql and 002_seed_rooms.sql.
- Tests: tests/database.test.ts (seed correctness, idempotency, reopen persistence, failure rollback, newer-DB rejection) and tests/http.test.ts (real-HTTP health, 404/500 error shaping, closed-connection unhealthy path, log secrecy).
- CI workflow (Windows + Ubuntu, Node 24, read-only permissions): npm ci -> typecheck -> lint -> test. No image build, no Docker anywhere, per revised plan.
- Verified Gate G0: all five criteria PASS. Record with raw output: gates/G0-2026-09-17.md.

## Decisions and why

- Node 24 instead of the docs Node 20: it is the runtime actually installed locally (v24.14.1) and Node 20 is near EOL; docs, engines, and CI were aligned so there is one supported version, not two.
- PRAGMA user_version for migration tracking instead of a schema_version table: SQLite already provides a persistent 32-bit app-version integer for exactly this purpose, so no extra table or read-modify-write transaction is needed; SQLite internal schema_version was rejected because it is reserved for the engine and changes on DDL outside our control.
- Migrations run inside a single immediate transaction with the version bump in it: either schema and version land together or neither does; openDatabase rejects a database whose user_version exceeds the known migration list before touching journal mode, so a newer DB is never modified on open (caught by review, regression test added).
- Local-first scope honored: DB at project root (hangout.db, gitignored), loopback-only binding, no Docker/hosting files; deployment work stays in 08-deployment.md.
- G0.2 criterion changed (chmod -> deterministic closed-connection query failure): file permissions are unreliable against an already-open SQLite connection on Windows, and the gate must test the property (db_ok reflects a live query) not a platform quirk; doc updated before verification, no public fault endpoint exists.
- G0.5 local allowance used: origin did not exist during implementation, so the gate accepts the recorded local run of the exact CI sequence; hosted CI run will be confirmed on first push (remote now exists at github.com/jamesdileva/AI-Playground).
- Vitest 5 and ESLint 10 upgrades applied before verification because npm audit flagged a moderate path-traversal advisory in the vitest mocker range that package.json originally pinned; final audit: 0 vulnerabilities.
- scripts/db-dump.mjs added as a read-only inspection helper for gate evidence; not part of the runtime.

## Known limitations / follow-ups

- Hosted CI verified green on origin after push: run 35215567612, both OS jobs passed (0 vulnerabilities, 6/6 tests). Minor follow-up: bump actions/checkout and actions/setup-node to Node 24–compatible majors to silence the deprecation warning.
- Process-level checks (stdout secrecy in production, signal shutdown, startup failure output) are not yet automated; documented as a coverage gap for a later sprint, not an observed defect.
- hangout.db currently holds only seed data (agents=0, messages=0, counters=0), so deleting it before S1 costs nothing.
