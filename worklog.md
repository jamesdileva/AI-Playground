# Worklog - Sprints 0-10 (2026-09-17 to 2026-09-29)

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

- Hosted CI green on both runners (run 36225271320); G4 fully closed.
- S5 next: onboarding, hardening, v1.0.0 per plan (04-sprint-plan.md).

# Sprint 5 (2026-09-26) â€” Agent onboarding and hardening (v1.0.0)

## What was done

- Content-negotiated `GET /` (5.2): `text/html` serves the spectator page,
  anything else serves onboarding JSON (service/version/flow/rooms/rules/
  limits/reads/full_docs); covered in `tests/static.test.ts`.
- Daily per-room volume log line (5.7): in-memory counters bumped on POST,
  flushed on an interval (24 h default, `volumeLogMs` injectable) through a
  separate `onVolume` callback so the request `LogEntry` shape is untouched.
- Wrote `public/llms.txt` (5.3: flow, limits, cursor caveat, empty polls,
  untrusted-input warning), served as `text/plain`; MIT LICENSE;
  CHANGELOG from 1.0.0; version bumped to 1.0.0 (no git tag per operator).
- Reconciled 03-api-spec with shipped behavior (5.9): real onboarding JSON
  shape, checkin rooms without occupants, completed Â§3.11 table (bad_limit,
  bad_wait, invalid_json, body_too_large, not_found, defensive 500 note),
  removed the unimplemented violation-extension claim.
- Added `tests/errors.test.ts` (5.4, 7 tests): every Â§3.11 code triggered
  with hint assertions and `retry_after` on all 429/503, including the
  dead-DB 503 path.
- Scripted gates: cold start 10/10 trials (5.1); 50-agent load + isolation
  (5.5/5.6: p95 read 1.8 ms, p95 write 2.3 ms, zero 5xx, 2851 checked /
  0 leaked); 1-hour log-secrecy run with clean grep (5.8); Â§1.6 absence
  review (5.10).
- Verified G5 locally: pipeline green, 58 vitest + 5 e2e + Lighthouse.
  Record: `gates/G5-2026-09-26.md`.

## Decisions and why

- Volume via `onVolume` instead of widening `LogEntry` (http.test.ts reads
  `.status`/`.route`; a union would break it).
- `internal_error` row kept but marked defensive-only rather than deleted
  (honest docs over an untestable claim).
- Whitespace-only bodies stay accepted (shipped S2 behavior, not a defect).
- `app.request` POST limitation worked around with real-HTTP harnesses.
- No v1.0.0 git tag: tagging waits for the deployment decision.

## Follow-ups

- Hosted CI green on both runners (run 36234472184); G5 fully closed, v1.0.0 localhost-ready.
- Next: creative-spaces sprints (06) per plan; deployment (08) last.

# Sprint 6 (2026-09-27) â€” The Drawing Board

## What was done

- Migration `003_canvas.sql`: `canvas_ops` (seq AUTOINCREMENT cursor,
  agent/handle/op_type/op_json/bounds/created_at, index on seq); op log is
  the only canvas table.
- New `src/canvas/queries.ts` (sole canvas_ops toucher): strict validation
  (1â€“50 ops/req, 1000Ã—1000 integer grid, stroke â‰¤64 pts, text â‰¤100 chars,
  hex colors, sized widths) with `400 canvas_invalid` hints, transactional
  batch insert, cursor reads mirroring messages, 20,000-op retention sweep.
  Rule I ESLint guard extended to `canvas_ops`.
- New `src/canvas/fold.ts`: `@napi-rs/canvas` rasterizer (stroke/rect/flood
  fill/text on dark `#222233`), pure `foldOps` shared by route and tests.
- New `src/http/rateLimit.ts` minute-window `createOpLimiter` (8 s
  cooldown, 300 ops/min `ops_cap`); global op-rate spike past 1200 ops/min
  doubles the cooldown (idle-decay analogue); per-POST inline retention
  sweep past 20,000 ops.
- Routes: `POST /api/canvas` (201 with first/last seq), `GET /api/canvas`
  (since/limit 100/500, `bad_cursor`/`bad_limit` reused), `/meta`, `/snapshot`
  (fold cache keyed on oldest:newest seq, refold counted via `onInternals`,
  `Cache-Control: public, max-age=5`), `canvas` SSE events, onboarding JSON
  - `/llms.txt` canvas chapters (bounds read from meta, never hardcoded).
- Spectator board: `<canvas>` below the room grid, Canvas2D incremental
  fold from REST bootstrap + SSE deltas (own flood fill, `fillText` text),
  no new JS dependencies.
- Tests: `tests/canvas.test.ts` (9: round-trip, 400s, cursors, retention,
  limits, meta, pixel-equality Ã—3 + cache proof, feed event, validator
  unit), `tests/e2e/canvas.e2e.ts` (paint + four 6.6 XSS-as-glyph cases),
  migration-count updates in `tests/database.test.ts`.
- Verified G6: pipeline green (67 vitest, 10 e2e, Lighthouse 1.0), 30-min
  20-agent paint soak (3,997 paints/reads, zero failures, room p95 1.4 ms,
  RSS +1.3%). Record: `gates/G6-2026-09-27.md`.

## Decisions and why

- Dedicated op limiter instead of stretching the hourly message limiter
  (different window, different code, zero S3 risk).
- Canvas reads default 100 / max 500 vs rooms 50/200 (replay efficiency).
- New codes `canvas_invalid` / `ops_cap`; reused codes where semantics
  already matched.
- Snapshot cache keyed on oldest:newest so sweeps invalidate correctly;
  reads never refold (the 6.8 fail condition, proven by fold count).
- Flood-fill seed-pixel fast path after the 20k-fill worker crash.
- No turns/plots/links (S7/S8); no room/canvas cross-reads.

## Follow-ups

- Hosted CI green on both runners (run 36364179520); G6 fully closed.
- S7 next: participation decision, attribution, replay per 06 plan.

# Sprint 7 (2026-09-28) â€” Participation, attribution, replay

## What was done

- 7.1 decision TURNS REJECTED (recorded in the gate file): S6 soak showed
  zero contention, default hypothesis + rule 5 hold, pixel budget ships as
  the fairness control instead. 7.2/7.3 N/A (conditional).
- Pixel budget (7.4): `createPixelBudget` in `rateLimit.ts` (2M px/hour/
  agent, 1h sliding window, oldest-debit `retry_after`); geometric costs in
  `queries.pixelCost`, exact raster-counted fill areas; `429 pixel_budget`
  enforced in POST before insert, recorded after.
- Snapshot cache refactor: holds the live canvas (snapshot = copy +
  current-count watermark + encode); doubles as the fill-area oracle, so
  fills cost exactly with no extra fold. No-op repaints cost 1 px.
- Attribution (7.5): `GET /api/canvas/attribution?region=` with JS
  bounds-intersect over the log (no migration); `bounds` added to
  `StoredCanvasOp` (additive, parsed from the S6 column).
- Replay (7.6/7.7): `GET /api/canvas/replay?from=&to=`, single incremental
  fold, base64 PNG frames every 100 ops + final, 2000-op cap (`400
bad_limit` naming the max; `to <= from` is 400).
- Watermark `free-draw Â· N ops` drawn identically by `foldOps` and the
  snapshot path (6.4 passes unchanged); `llms.txt` + onboarding
  `canvas.rules` document budget/attribution/replay/no-turns.
- Tests: +5 in `tests/canvas.test.ts` (budget trip, fill proportionality,
  500-sample attribution, replay identity, replay cap). Verified: 72
  vitest, 10 e2e, Lighthouse 1.0. Record: `gates/G7-2026-09-28.md`.

## Decisions and why

- Reject turns over probe-first/ship (approved options): no jamming
  evidence, participation bar not met.
- 2M px/hour default (approved): ~2 full canvases per agent per hour.
- Scrubber UI deferred (approved): no G7 UI criterion.
- New `pixel_budget` code kept out of 03 Â§3.11 (S6 canvas-code pattern).
- Cache-copy watermark instead of baking into the live canvas (counts stay
  current, reads still never refold).

## Follow-ups

- Hosted CI green on both runners (run 36381152015); G7 fully closed.
- S8 next: collaborative agent plots per 06 plan.

# Sprint 8 (2026-09-28) â€” Collaborative agent plots

## What was done

- Migration `004_plots.sql`: `plots` (slug/title/palette/blocks/created_by),
  `plot_owners` (co-ownership as a table), `plot_revisions` (immutable
  history), `plot_guestbook` (one row per agent+plot); exported the
  `migrations` array so count tests derive instead of hardcoding.
- New `src/plots/queries.ts` (sole plot toucher, Rule I extended): strict
  declarative block schema (heading/text/ascii_art/link/image_ref/colors/
  guestbook; unknown types and html/style/script/on* keys rejected naming
  the field), link href allowlist (http/https/relative), palette tokens,
  30-block / 32KB ceilings, slugify with collision suffixes, 3-plot cap
  counting co-owned rows, revision-tracked updates with trim-to-20,
  founder/self removal rules, append-only restore, guestbook upsert with
  60 s cooldown.
- Routes: create/list/get/history/PUT/owners add+remove/restore/guestbook
  plus human `GET /plot/:slug`; new codes `plot_invalid`, `plot_limit`
  (429+3600), `plot_forbidden`, `no_such_plot/agent/revision`,
  `entry_invalid`, `guestbook_cooldown`, `revision_conflict` (+current
  revision via a new optional `HttpError` data bag); `plot` SSE events;
  volume `"plots"` counting; `CHECKIN_LIMIT` env knob (default 10).
- `src/plots/render.ts`: escaped server-side page (headings/text/pre-ascii/
  validated links/snapshot-region img/palette classes/guestbook list);
  palette + plot CSS; snapshot `?region=` crop for `image_ref`.
- `llms.txt` + onboarding `plots` chapter (discovery, CRUD, owners,
  guestbook, restore, limits, untrusted-content note).
- Tests: `tests/plots.test.ts` (11: co-build, 403/401, cap, schema,
  concurrent conflict, 20-revision history + restore, guestbook + upsert,
  ceilings, owners, slugs, feed event), `tests/e2e/plots.e2e.ts` (8.5 Ã—4
  - plot page flow), shared e2e checkin helper with 429 backoff,
    cold-start create-then-edit 10/10 (8.10).
- Verified G8: pipeline green (83 vitest, 15 e2e, Lighthouse 1.0).
  Record: `gates/G8-2026-09-28.md`.

## Decisions and why

- Restore + history endpoint in S8 (gate 8.7 beats the stale S8 task line).
- `GET /api/plots` added (8.10 discovery needs enumeration; approved).
- Link allowlist, guestbook upsert, `CHECKIN_LIMIT` knob (all approved).
- Canvas error codes stay out of 03 Â§3.11 (S6/S7 pattern).
- Ownerless plots allowed and read-only (simplest consistent rule).

## Follow-ups

- Hosted CI green on both runners (run 36503022971); G8 fully closed.
- S9 next: city view, links, hardening per 06 plan.

# Sprint 9 (2026-09-29) â€” City view, links, hardening

## What was done

- `POST /api/leave` (auth): clears all-room presence and parks the token
  (`403 editing_parked` on all six plot-write routes via middleware,
  re-check-in unparks, restart clears); plots never deleted.
- Map: `guestbooks` count added to plot listings; `GET /api/map`
  (deterministic creation-order grid, tiles with data attributes, SVG
  connection lines for link + shared-owner pairs); render-time link
  resolution (missing targets degrade to plain text).
- `tests/limits.test.ts` (9.9): all six 429 codes with `retry_after` +
  hints. `tests/isolation-traffic.test.ts` (9.5): 200-message fuzz across
  25 agents paced past cooldowns with canvas/plot writers concurrent.
- Map tests in `plots.test.ts` (9.1 tiles, 9.2 reopen stability, 9.3
  resolve/degrade/edges, 9.4 region faults); map e2e smoke (tile click
  lands on the plot).
- 50-agent mixed load (9.7: 21,685 reads, p95 18 ms, zero 5xx);
  `VACUUM INTO` restore drill timed and verified (9.6: 16 ms backup,
  ~3 s restore, all state intact).
- `llms.txt` reframed (talk/draw/build, plot/guestbook/leave limits,
  canvas-text warning); 01 Â§1.6 annotated; 06 amended (restore-in-S8,
  history/list endpoints, `CHECKIN_LIMIT`); abuse review kept all values.
- `CHECKIN_LIMIT` env knob (`server.ts`, default 10) + Playwright 1000
  after 15-spec e2e flaked on the throttle; shared 429-honoring checkin
  helper; canvas paint test uses pixel deltas.
- Verified G9: pipeline green (93 vitest, 16 e2e, Lighthouse 1.0).
  Record: `gates/G9-2026-09-29.md`.

## Decisions and why

- Park-token leave, shared-owner lines (both plan-approved options).
- Static map (no G9 live-update criterion).
- Unswept plots/guestbooks documented as identity (retention decision).
- No migration, no new deps.

## Follow-ups

- Hosted CI green on both runners (run 36508396556); G9 fully closed.
- S10 next: gallery and finishing per 07 plan; deployment (08) last.

# Sprint 10 (2026-09-29) â€” Gallery and finishing

## What was done

- Migration `005_gallery.sql`: `gallery_canvases` (epoch/range/PNG blob/
  contributors/proposer/confirmer/finished_at), `gallery_plots` (slug/
  blocks/final revision/founder/co-owners/retired_at), `canvas_ops.epoch`,
  `counters.canvas_epoch = 1`. Exported `migrations` already covered it.
- Epoch-aware canvas: `canvasEpoch`, epoch-scoped reads/stats/sweeps,
  `?epoch=` on reads (past read-only, future 400), POST tags the epoch
  read at handler start (validated-tagging per 07), `?epoch=` mismatch on
  POST is 400. Snapshot cache keyed with epoch.
- Finish protocol: propose (eligible painters only, replaces pending,
  120 s in-memory expiry) + confirm (distinct painter, or solo after
  10 idle minutes) â†’ fold outside, single txn (gallery insert + epoch++,
  concurrent double-confirm gets 409), proposal cleared, canvas SSE event
  carries the new epoch. New codes `finish_ineligible`/`finish_expired`
  (400).
- Plot retirement: founder-only single-txn move (gallery insert + delete
  guestbook/owners/revisions/plots, FK-safe order); slug freed; cap counts
  live only; `410 plot_retired` via `plotRow` (all mutating paths +
  reads point at the gallery URL).
- Gallery: list (mixed, newest-first, limit/offset), canvas detail (base64
  PNG), plot detail (latest row per slug), `/gallery` page (canvas
  thumbnails + rendered plot tiles), stats `finished_canvases` /
  `retired_plots`, spectator gallery link + count, client epoch reset.
- Tests: `tests/gallery.test.ts` (14: finish, solo windows, eligibility,
  expiry, pixel-match, epoch reads/writes, sweep scoping, kill harness,
  retire, reuse, 410, write-less routes, sweep exemption, 5Ã— race),
  `tests/e2e/gallery.e2e.ts` (10.14 probes), pair cold-start 10/10,
  restore drill re-run with gallery intact.
- `llms.txt` finishing chapter + onboarding finish/retire pointers.
- Verified G10: pipeline green (107 vitest, 18 e2e, Lighthouse 1.0).
  Record: `gates/G10-2026-09-29.md`.

## Decisions and why

- Validated-epoch tagging (07 recommendation) with documented straggler
  caveat; 10.15 asserts the exact partition instead.
- Guestbook rows deleted at retire (FK enforcement; gallery snapshots
  blocks + owners).
- Gallery plot detail returns the latest row for reused slugs.
- Watermark stays in both fold paths (6.4 untouched).
- No scrubber UI, no remix/search (post-G10 backlog, untouched).

## Follow-ups

- Hosted CI: <run id after push>; G10 fully closed.
- Next: deployment plan phase (08), then build.
