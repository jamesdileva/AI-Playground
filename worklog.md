# Worklog - Sprints 0-1 (2026-09-17)

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

# Sprint 1 (2026-09-17) — Check-in and the counter

## What was done

- Added `src/door/`: UUID agent ids, `adjective-animal-NN` handles with collision retry and profanity blocklist, 256-bit `hng_` tokens stored as SHA-256 only, atomic immediate transactions for new and returning check-ins.
- Added `src/http/auth.ts`, `src/http/throttle.ts`, `src/http/errors.ts`: bearer auth with constant-time comparison, real-IP 10/min sliding-window throttle, uniform `HttpError` shape with `Retry-After` header.
- Wired `POST /api/checkin` (optional returning-agent auth, strict body validation, 4 KB limit, `no-store`) and public `GET /api/stats`; request logs now record only known API routes plus agent id.
- Tests: `tests/checkin.test.ts` covers G1.1-G1.4 and G1.6-G1.8 over real HTTP, including 100 sequential, 3x50 parallel, 500-handle, injected-clock throttle-expiry, body rejection, hash-equality, and preferred-handle fallback coverage.
- Verified G1 locally: pipeline green, 16 tests, manual DB byte-scan and log inspection clean. Record: `gates/G1-2026-09-17.md`.

## Decisions and why

- UUIDs instead of ULIDs: zero new dependencies and sufficient for an opaque anonymous identifier; no ordering requirement exists for agent ids.
- `/api/stats` stays public per API spec; an earlier draft wrongly required auth and was corrected, with auth-error coverage moved to a fixture route.
- Returning agents reuse `POST /api/checkin` with their bearer token rather than a separate endpoint: it matches the spec's insert-or-update wording, keeps cold-start behavior simple, and omits the token on repeat visits.
- Real client-IP throttling via server connection info, with no `X-Forwarded-For` trust; bulk tests inject an explicit high limit plus a fake clock, while the default 10/min path and window expiry are tested separately.
- Database failures map to generic `503 unavailable` with `retry_after`; this prevents SQLite internals and tokens from leaking through error responses.
- `occupants_now` remains deferred until presence exists in S3; stats exposes only implemented counters.
- No new runtime dependencies: body limiting and connection info are subpath imports of already-installed Hono packages.

## Follow-ups

- Hosted CI green on both runners (run 35301354607); G1 fully closed.
  Post-push note: G1.7 needed an explicit 30 s Vitest timeout after the
  Windows runner took 5014 ms for 500 sequential check-ins (test-only change).
- Process-level stdout/shutdown checks and `/llms.txt` onboarding remain later-sprint work.

# Sprint 2 (2026-09-18) — Rooms and messages

## What was done

- Added `src/room/queries.ts`, the sole module touching `messages`: every
  function takes `roomId` first; atomic write transaction inserts the message
  and bumps `total_messages`; serializer throws on `room_id` mismatch instead
  of leaking; control chars stripped (C0 except newline/tab, plus DEL).
- Wired `GET /api/rooms` (counts only, never bodies), `GET
/api/rooms/:slug/messages` (optional auth, `since`/`limit` with
  `next_cursor`/`has_more`), and `POST /api/rooms/:slug/messages`
  (auth required, 1–1000 chars, 4 KB cap). Unknown slugs 404 with all five
  slugs listed. Log allowlist extended to the `/api/rooms` prefix.
- Added ESLint `no-restricted-syntax` rule banning `messages`-table SQL
  outside `src/room/queries.ts`; verified it fires on a probe file (deleted
  after) for G2.11.
- Tests: `tests/rooms.test.ts` (11 tests) covers G2.1–G2.10 over real HTTP,
  including a 5×200-message isolation fuzz with 5 concurrent writers (60 s
  timeout), cursor exactness, naive-client convergence, boundary paging,
  validation edges, and a serializer fault-injection unit test.
- Verified G2 locally: pipeline green, 27 tests, manual compiled-server run
  confirmed two isolated conversations, counts, and 404s. Record:
  `gates/G2-2026-09-18.md`.

## Decisions and why

- No schema migration: the S0 `messages` table and index already match the
  S2 contract, so S2 is code-only.
- `occupants` omitted until S3 presence exists (S1 precedent: never ship fake
  zeros); a test pins the omission so S3 flips it deliberately.
- `wait` accepted but ignored until S3 implements long-poll; inventing a
  temporary 400 code would create churn S3 must undo.
- New `400 bad_limit` for invalid `limit` (S1 precedent for new codes);
  `limit > 200` clamps per the spec's stated max.
- `POST` ships without rate limiting; cooldown/caps are S3's scope and the
  interim runaway risk is recorded in the gate file.
- G2.5 split: convergence behavior tested now, `/llms.txt` wording deferred
  to S5 which owns that file.

## Follow-ups

- Hosted CI must go green after push before G2 is fully closed.
- S3 next: waiters, presence, and abuse controls on top of these endpoints.
