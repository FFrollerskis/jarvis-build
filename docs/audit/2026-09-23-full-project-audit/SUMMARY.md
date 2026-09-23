# Full-project audit — 2026-09-23

Requested by Tobias, direkte i chat: *"Jeg vil at du skal gå igjennom absolutt hele prosjektet å se
etter hul feil placeholdefs forbedrings muligheter og mangler du skal inn i hver eneste fil og mappe
å se."* This document is the prioritized entry point. Full per-area findings (file:line, fix sketch,
verification notes) are in the 13 files alongside this one.

## Method

13 independent read-only audit agents, each assigned a disjoint slice of the repository with a shared
brief (categories A–E: bugs/holes, placeholders/stubs/dead code, gaps, improvements, doc/code drift;
severity P0–P3; every claim tied to a file:line; explicit `[unverified]` tag where something could not
be confirmed in this sandbox, e.g. no live provider credentials, no Windows host, no real Postgres for
DB-backed tests). Total: **every file in every module, app, package and `docs/` was read** — see each
report's header for exact file counts (1,000+ files across the 13 slices). No code was changed by the
audit itself; every fix below is a recommendation, not something already applied, **except D-243**
(the CRLF `.env`-parser bug), which was found live by Tobias during this same session and is already
fixed in PR #155.

| # | Slice | File |
|---|---|---|
| 1 | `modules/core` (identity, sessions, devices, DB/migrations, RLS) | [01-core.md](01-core.md) |
| 2 | `modules/finance` (Fiken, Stripe, Vipps, Neonomics, Wallester) | [02-finance.md](02-finance.md) |
| 3 | `modules/model-gateway`, `packages/provider-adapters`, `packages/contracts` | [03-model-gateway-packages.md](03-model-gateway-packages.md) |
| 4 | `apps/api`, `apps/web`, `apps/mobile` | [04-apps.md](04-apps.md) |
| 5 | `modules/knowledge`, `modules/memory`, `modules/context` | [05-knowledge-memory-context.md](05-knowledge-memory-context.md) |
| 6 | `modules/business`, `modules/growth` | [06-business-growth.md](06-business-growth.md) |
| 7 | `modules/situations`, `modules/executive`, `modules/governance`, `modules/erasure` | [07-situations-executive-governance-erasure.md](07-situations-executive-governance-erasure.md) |
| 8 | `apps/voice-gateway`, `modules/health`, `modules/location`, `modules/vision` | [08-voice-health-location-vision.md](08-voice-health-location-vision.md) |
| 9 | `modules/support`, `modules/agreements`, `modules/operations`, `modules/conversation-graph`, `modules/product`, `modules/consent` | [09-support-agreements-operations-convgraph-product-consent.md](09-support-agreements-operations-convgraph-product-consent.md) |
| 10 | `ops/claude-worker`, `infra/local`, `config/`, root files, env-var reconciliation | [10-ops-infra-config-root-env.md](10-ops-infra-config-root-env.md) |
| 11 | `modules/tool-gateway`, `modules/policy`, `modules/owner-controls` | [11-toolgateway-policy-ownercontrols.md](11-toolgateway-policy-ownercontrols.md) |
| 12 | `docs/` vs. code (drift, staleness, dangling references) | [12-docs-drift.md](12-docs-drift.md) |
| 13 | `modules/tasks`, `modules/incidents`, `modules/watchdog`, `modules/self-modification` | [13-tasks-incidents-watchdog-selfmod.md](13-tasks-incidents-watchdog-selfmod.md) |

## Overall health

The codebase is unusually disciplined for its size: RLS/tenant/space isolation is proven with real
Postgres tests almost everywhere, class-D approval signing and replay protection are sound, secrets
never leak into audit/logs, and the decision log repeatedly catches and fixes its own drift (D-122,
D-211, D-212, D-227, D-242 are all self-caught "code exists but was never wired in" incidents — this
audit found a sixth and seventh instance of that exact pattern, see Theme 1 below). Test coverage is
broad and mostly genuine. Against that baseline, three P0s and roughly twenty P1s are real, fixable,
and worth working through — none of them are exotic; most are one function or one migration away from
closed.

---

## P0 — fix first

### P0-1 — 15 mutating/infra HTTP routes trust a client-asserted identity with no proof
**`apps/api/src/server.ts:810-829,964-990,995-1252`** (slice 4). `/tasks/submit`, `/tools/critical-demo`,
all 8 `/incidents/*` routes, `/deployments/ingest/github`, `/infra/execution/mutate|get`,
`/observability/docker/status`, `/infra/recovery/attempt`, `/infra/pause|resume|degrade|status`
authenticate with a client-supplied `identity` object (including `auth_strength`) that is only checked
for *existence* (three SELECTs), never proven with a device signature or grant. Because
`PolicyGateway` runs the owner in SOVEREIGN mode, anyone who can reach the API port and knows the three
public default IDs (`person-tobias`/`tenant-personal`/`jarvis-core`, visible in `seed.ts`) can submit
sandboxed coding jobs, mutate/stop Docker containers, pause infra, and create repair tasks — with no
device proof at all. D-131 fixed exactly this pattern for `/chat`/`/brief`/`/devices/register` but it
was never propagated to these 15 routes. The API also binds all interfaces by default
(`main.ts:1153`), and the container port is published in `docker-compose.yml`.
**Fix:** route all 15 through the same `resolveFromGrant()` pattern already used by `/executive/*`;
until then, bind the API to `127.0.0.1` outside the container as an interim mitigation.

### P0-2 — a DB error on the *success* path can silently erase the idempotency record for an already-executed mutation
**`modules/tool-gateway/src/gateway.ts` (~line 623-639)** (slice 11). `deny()`'s audit write was
wrapped in try/catch by D-219; the **success**-path audit write was not. If it throws after
`transport.invoke()` already sent an email, moved money, deleted a file, or merged a PR, the whole DB
transaction — including the just-inserted `tool_executions` dedupe row — rolls back and the exception
propagates uncaught. A caller retry with the same idempotency key then finds no dedupe row and
**re-executes the mutation**, defeating the exact protection CLAUDE.md rules 2/8 exist to guarantee.
No test covers "audit write fails after a successful mutation" (only the deny path is tested).
**Fix:** wrap the success-path audit write the same way D-219 wrapped `deny()`, or make the
`tool_executions` insert durable before the audit write runs.

### P0-3 — CLAUDE.md and CANONICAL_SPEC.md still say "Phase 0, no code approved yet"
**`CLAUDE.md:6-7`, `docs/CANONICAL_SPEC.md:3,161-163`** (slice 12). The two documents CLAUDE.md itself
names as most authoritative still open with "ingen applikasjonskode er godkjent ennå. Vent på Tobias
sin eksplisitte godkjenning av fase 1" — directly above a document hierarchy and merge-authority
protocol (D-192) that assume the opposite, and above 150+ merged PRs of application code. This isn't a
security bug, but it's a real, load-bearing self-contradiction at the top of the project's own
instruction file — a future session (or a different reviewer) reading only the header could reasonably
conclude no code should be written at all.
**Fix:** update the phase header, or explicitly mark it frozen historical text with a pointer to
`PROJECT_STATUS.md` as the live source of truth.

---

## P1 — real bugs, fix soon

Grouped by area; each line names the exact location and the failure mode. Full detail (including
already-checked "not a bug" cases) is in the linked per-slice file.

**Data integrity / erasure**
- `session_grants` has no `ON DELETE` on its `sessions` FK, and `jarvis_app` has no DELETE grant on
  it, while `018_erasure.sql` DELETEs `sessions` directly — any erasure of a session that ever
  received a device grant fails with an FK violation and rolls back the whole erasure. (`01-core.md`)
- Concurrent first-session creation can produce two active sessions — the code's `FOR UPDATE` comment
  is wrong: it only locks rows that exist, and there is no partial unique index preventing two
  simultaneous inserts. (`01-core.md`)
- `business_contacts`/`business_companies`/`business_leads`/etc. are a known, still-open PII erasure
  gap — documented as a pre-existing gap in `erasure/src/plan.ts` comments at 6+ call sites, never
  closed. (`07-situations-executive-governance-erasure.md`)
- `memory_versions` keeps an append-only DELETE-forbidding trigger that erasure code tries to DELETE
  through — any erasure of a person/space whose memory was ever updated or invalidated fails closed
  with an FK/trigger violation and rolls back. (`05-knowledge-memory-context.md`)
- `MemoryWriter`: a fact can never be re-learned after `invalidate()` (UNIQUE constraint blocks
  re-insert), and a **trusted** update to a **quarantined** row leaves `trust_level` promoted while
  `status` stays `quarantined` — a trusted fact becomes permanently invisible. (`05-knowledge-memory-context.md`)

**Money / finance**
- Vipps capture/refund send the intent's `amount_ore` (a Postgres `bigint`, arrives as a JS string) as
  a JSON string instead of an integer — live capture will very likely be rejected by Vipps.
  (`02-finance.md`)
- A Stripe `refund.*` webhook overwrites the **parent payment intent's** `provider_status` with the
  refund's own status; a Vipps `CAPTURED` webhook does the same, blocking further partial captures
  until a sweep happens to refresh it. Both are real state-corruption paths, not just cosmetic.
  (`02-finance.md`)
- Fiken's journal-entry POST is inside the DB transaction, has no idempotency key, and is retried up to
  3× on 429/500/502/503/504 by the shared HTTP-retry helper — a timeout that actually posted can be
  posted again. "Retry cannot double-pay" does not hold for Fiken today. (`02-finance.md`)
- `gemma_local` (a local, zero-API-cost model) has no pricing-table entry and falls through to the
  **most expensive** default rate — every local call silently inflates spend against the hard monthly
  budget that blocks all providers. (`03-model-gateway-packages.md`)

**Authority / policy**
- `owner_controls.set_connector_credential` (installs a live secret for any registered connector,
  including class-D-gated ones) is classified capability class C, not D — no cryptographic signature
  required for a delegated actor to substitute a hostile credential. (`11-toolgateway-policy-ownercontrols.md`)
- Class-D signed-approval nonces are consumed **before** rate-limit/frozen/revoked checks run — a
  perfectly valid, first-use signature is burned even when the request was always going to be denied
  by an orthogonal gate, forcing a fresh signature for a legitimate retry. (`11-toolgateway-policy-ownercontrols.md`)
- The worker process refreshes its device registry **once at startup only** (main.ts has a 30s
  interval; worker-main.ts does not) — a device enrolled or revoked after worker start is unknown to
  the worker's class-D approval verification until restart. (`04-apps.md`)
- `SAFETY_CRITICAL_SUFFIX` is documented as "always appended last" but retrieved memory content is
  actually concatenated *after* it in the real system prompt — the safety suffix is not structurally
  last, contradicting the file's own header comment. (`04-apps.md`)

**Availability / recovery**
- No task-queue lease renewal: the default 60s lease is shorter than the coding agent's own 300s
  timeout, so any coding job that legitimately runs long can be reclaimed and **double-executed**,
  including a second live `git push`/PR-create — and the losing worker's outcome is discarded silently,
  with no log line. (`13-tasks-incidents-watchdog-selfmod.md`)
- A misconfigured local Piper TTS binary path crashes the **entire voice-gateway process** (no
  `proc.once("error", …)` handler, unlike the sibling Whisper adapter which has one). (`08-voice-health-location-vision.md`)
- The watchdog's only automated kill-switch trigger (`costExplosionCheck`) can be silently disabled
  forever by a single hung check — there is no per-check timeout, only an overlap guard.
  (`13-tasks-incidents-watchdog-selfmod.md`)
- `modules/knowledge`'s sync has no per-record `SAVEPOINT`: one bad row (a unique violation, an
  oversized `tsvector`) aborts the whole transaction and every subsequent record in that sync fails
  too. Its `UNIQUE` constraint also ignores `memory_space_id`, so the same external source synced into
  two memory spaces collides. (`05-knowledge-memory-context.md`)

**Tenant/scope isolation**
- `modules/product` is missing the cross-tenant/cross-space `company_id`/`contact_id` scope guard that
  its three sibling modules (support, agreements, operations) all received after the same architect
  finding — a caller-supplied ID from a different tenant is silently accepted if the row exists
  anywhere. (`09-support-agreements-operations-convgraph-product-consent.md`)
- Five transports (`support`/`agreements`/`operations`/`product`/`consent`) still read `tenant_id`
  from `parameters` rather than exclusively from `context.identity` — the exact pattern that was
  proven exploitable in `conversation_graph` before D-119 hardened it. Whether it's reachable from a
  model-facing caller could not be verified from this slice; flagged for an explicit architect
  decision. (`09-support-agreements-operations-convgraph-product-consent.md`)

**Infra / CI**
- The Windows-specific lock/crash-recovery test suite (`ops/claude-worker`'s most security-critical
  code, per its own README) runs in **no CI pipeline at all** — only manually, on Tobias's own host.
  (`10-ops-infra-config-root-env.md`)
- `INTEGRATIONS.md`'s connector table omits Vipps/Neonomics/Wallester entirely despite all three being
  shipped, live-testable finance connectors — the doc's own "exhaustive cross-check" claim is false.
  (`12-docs-drift.md`)
- `PROCESSOR_REGION_MATRIX.md`'s LLM row is still `TBD` while five cloud LLM providers are live in
  production — the exact "TBD next to live traffic" bug class D-122 already found and fixed once for
  speech, recurring here unfixed for text. (`12-docs-drift.md`)
- `D-243` (already fixed in PR #155, found live this session): the `.env` parser shared by
  Fiken/Google-Drive/Google-Gmail reauth scripts silently drops any value on a Windows CRLF `.env` file
  — see `docs/DECISIONS_AND_ASSUMPTIONS.md` D-243 for the full writeup.

---

## Cross-cutting themes

**Theme 1 — "the tool is registered but never actually wired to a real transport" keeps recurring.**
D-211 (Infisical), D-212 (voice daily-use surface), D-218→D-222 and D-227 (silently swallowed sweep
errors), D-242 (Vercel's `live_test` never got a real transport in `main.ts`/`worker-main.ts` for over
a month) are all independently self-caught instances of this exact pattern. This audit found the same
shape twice more: `connector-health-sweep.ts` only exercises the 11 registry entries that *have* a
`live_test`, not every `tool_id` actually registered in production (slice 11); and several scheduled
sweeps in `apps/api/src/main.ts` discard their per-tenant failure results entirely (slice 4, `C6`).
CLAUDE.md has no rule that would have caught this pattern by construction. **Recommendation:** add a
standing rule requiring a structural (grep-based) wiring test for any new adapter/transport/scheduled
job before it is considered done — the team has independently rediscovered this lesson five times.

**Theme 2 — Windows is a second-class, mostly-untested platform for a project that runs on Tobias's
Windows PC.** D-243 (this session), plus slice 10's finding that the Windows lock/crash-recovery suite
never runs in CI, plus slice 8's finding that local Whisper/Piper env vars are never wired into
`docker-compose.yml`, are three independent instances of the same underlying gap: code paths that only
execute on Windows get materially less test/CI coverage than the Linux-default paths.

**Theme 3 — erasure (GDPR-class deletion) has more gaps than its extensive test suite suggests.**
The *mechanism* (FK-graph-driven, heavily tested against a live `information_schema` query) is
excellent, but coverage has real, mostly-documented holes: `business_*` contact tables (known, P1),
`memory_versions`' append-only trigger (newly found, P1), and several tenant-scoped tables
(`person_tenants`, `session_grants`, `devices`, `business_scores`) that are neither registered nor
explicitly documented as intentional exclusions (slice 7).

**Theme 4 — money-path bugs cluster in the newest, least-live-verified connectors.** Every P1 in
`modules/finance` is in Vipps, Fiken, or a Stripe webhook edge case — Stripe's happy path (the only
connector with a real test-mode live run, D-225) has none. This tracks: live verification is the thing
that actually finds these bugs, and three of five finance connectors have never had one.

## What this document is not

This is a snapshot from one read-only pass on 2026-09-23. It is not a task list with owners or
deadlines, and none of the P1s above have been triaged into a build order yet — that's a decision for
Tobias (which ones matter enough to spend a session on, and in what order) not something this audit
should pre-empt. The 13 linked files are the primary source; this summary is a navigation aid, not a
replacement for reading the specific finding before acting on it.
