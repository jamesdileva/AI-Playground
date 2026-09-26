# Worklog - Sprints 0-4 (2026-09-17 to 2026-09-25)

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

- Hosted CI green on both runners (run 35411949293); G2 fully closed.
- S3 next: waiters, presence, and abuse controls on top of these endpoints.

# Sprint 3 (2026-09-23) — Long-poll, presence, abuse controls

## What was done

- Added `src/waiters/registry.ts` (per-room waiter sets; `wait` resolves
  woke/timeout/aborted with timer + abort-listener cleanup, room entry
  deleted when its set empties) and wired long-poll into
  `GET /api/rooms/:slug/messages`: `wait` parsed (400 `bad_wait` for
  negative/non-numeric, clamp to 25 s), empty read blocks, re-reads after
  wake/timeout, POST wakes the room after insert.
- Added `src/presence/tracker.ts` (90 s TTL keyed by room slug string;
  touch/leave/sweep/occupancy) with 15 s sweeper; `occupants` now appears on
  the room list and message reads, `occupants_now` on stats (flipping the S2
  omission test), plus `POST /api/rooms/:slug/leave` -> 204.
- Added `src/http/rateLimit.ts` (per-agent-per-room cooldown 8 s + 60/hour
  cap, `retry_after` seconds) enforced before the write transaction, and a
  `409 consecutive_post` check inside the `postMessage` transaction;
  cooldown doubles when the room posted >200 messages in the last 10 min
  (idle decay). Retention sweep keeps the newest 500 per room and drops rows
  older than 7 days (5 min sweeper); both sweepers skippable via options.
- Migrated S2 tests to the new write semantics (alternating agents,
  `RELAXED_MESSAGE_LIMITS` harness injection, `\u0000`/`\u0007` escapes) and
  added `tests/s3.test.ts` (13 tests) covering G3.1-G3.4, G3.6-G3.9, idle
  decay, presence, and retention with an injected clock.
- Verified G3 locally: pipeline green, 40 tests, plus three manual load runs
  against the compiled server: 3.5 (500 aborted long-polls, registry 0,
  RSS ratio 1.0), 3.10 (two-agent ping-pong, 120 messages ≤ 150, hourly caps
  engaged), 3.13 (20 agents / 30 min, 13,636 requests, zero 5xx, DB flat at
  4.32 MB, RSS bounded). Record: `gates/G3-2026-09-23.md`.

## Decisions and why

- Check order cooldown -> hourly cap -> consecutive-post (429s win over 409);
  consecutive check lives inside the write transaction for atomicity.
- `wait` clamps silently above 25 s but 400s below 0 / non-numeric, so naive
  pollers keep working while malformed input is rejected loudly.
- Presence keyed by room slug string (not numeric id) to match the existing
  read path; `§3.11`-style spec wording deferred to S5 like G2.5.
- Soak ran two-wave check-in (10 + 10, 65 s apart) because the production
  check-in throttle allows 10/minute per IP; a first 10-agent attempt is kept
  as supporting evidence only.

## Follow-ups

- Hosted CI green on both runners (run 35942925517); G3 fully closed.
- S4 next: per plan (04-sprint-plan.md).

# Sprint 4 (2026-09-25) — Spectator UI

## What was done

- Added `src/feed/hub.ts` (typed pub/sub: message/checkin/presence,
  throwing subscribers isolated) and `GET /api/feed` SSE in
  `src/http/app.ts` via `hono/streaming` (serialized writes, `:keepalive`
  every 20 s injectable, unsubscribe on disconnect). Check-in, POST, touch,
  leave, and the presence sweeper publish; presence events fire only on
  occupancy change (sweep-aware diff over slug union).
- `postMessage` now also returns the stored (sanitized) body for feed
  events; presence gained an additive `snapshot()`; `DB_PATH` env override
  added so e2e/perf/manual runs never touch `hangout.db`.
- Built `public/` (dependency-free): `index.html` (counter, connection
  status, five room sections), `app.js` (EventSource with backoff,
  10 s polling fallback after 3 failures, REST re-bootstrap on `since`,
  `textContent`-only rendering, 60-message cap, scroll-pause, quiet-for-Nm
  tick), `style.css` (5/2/1 responsive grid, `prefers-color-scheme`,
  per-room accents). Served from memory at startup with exact content
  types and `no-store`.
- Test infra: `@playwright/test` + `globals` + `lighthouse` devDeps,
  `playwright.config.ts` (own chromium webServer on :3210 with fresh e2e
  DB, `*.e2e.ts` match so vitest ignores them), `test:e2e` and `perf`
  scripts, CI extended with build + browser install + e2e + perf.
- Tests: `tests/feed.test.ts` (7: hub unit + SSE message/checkin/
  presence-change-only/keepalive/unsubscribe-on-abort),
  `tests/static.test.ts` (serving + 4.5 no-sink assertion),
  `tests/e2e/spectator.e2e.ts` (4.2 + four 4.4 XSS cases, fail on dialog).
- Verified G4: pipeline green (49 vitest, 5 e2e, Lighthouse 1.0),
  manual browser block (4.1/4.3/4.2-live/4.6 kill/4.7 pause with verified
  overflow/4.8 viewports/4.10 placeholders), 2-hour memory soak (4.11).
  Record: `gates/G4-2026-09-25.md`.

## Decisions and why

- Dedicated hub instead of reusing the S3 waiters registry (request-scoped
  long-poll is the wrong shape for fan-out).
- Plain filenames + `no-store` over 02-architecture's hashed long-cache
  (freshness wins on localhost; recorded as a deviation).
- REST re-bootstrap instead of `Last-Event-ID` replay (simple, correct).
- `npm ci` in the worktree was blocked by a locked better-sqlite3 binary
  while the 4.11 soak held it; verified on a byte-identical copy, then
  restored the worktree with `npm ci` after the soak.

## Follow-ups

- Hosted CI: <run id after push>; G4 fully closed.
- S5 next: onboarding, hardening, v1.0.0 per plan (04-sprint-plan.md).
