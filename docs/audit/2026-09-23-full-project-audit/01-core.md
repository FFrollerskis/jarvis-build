# Audit report — `modules/core/` (124/124 files read)

Legend: **P0** blocker · **P1** real bug · **P2** gap · **P3** improvement. All claims verified by reading code; anything not verifiable in this sandbox is marked *unverified*. `npx tsc --noEmit -p modules/core` passes.

## A. BUGS / LOGIC HOLES

### `src/db/migrations/053_session_grants.sql` + `018_erasure.sql` + erasure plan
- **P1** `053:44` `session_grants.session_id text NOT NULL REFERENCES sessions (session_id)` with no `ON DELETE` clause, and `053:114-115` grants `jarvis_app` only SELECT/INSERT/UPDATE on `session_grants` (comment: "ALDRI DELETE"). But `018:45-49` grants DELETE on `sessions` and `modules/erasure/src/plan.ts:444,604,619` really executes `DELETE FROM sessions ...` for conversation/person/tenant erasure. Any session that ever received a device grant (every voice/mobile/desktop authorization since D-131) will now make Q-20 erasure fail with an FK violation, and the whole erasure transaction rolls back. Fix: either `ON DELETE CASCADE` on the FK, or register `session_grants` in the erasure plan and add a DELETE grant. Same latent shape for `device_enrollment_tickets.person_id → people` if person deletion is ever added (not today).

### `src/services/session-service.ts`
- **P1** `66-101` + `002:13`: comment (`63-64`) claims `FOR UPDATE` prevents two concurrent authorizations creating two active sessions. `FOR UPDATE` only locks rows that exist; when a person has no active session, both transactions see zero rows and both `INSERT`. There is no partial unique index `(tenant_id, person_id) WHERE status='active'` in `002_sessions_events.sql`. Fix: add `CREATE UNIQUE INDEX sessions_one_active_idx ON sessions (tenant_id, person_id) WHERE status = 'active'` and handle the conflict (re-select).

### `src/services/event-writer.ts`
- **P1** `43-50`: audit row is written with fabricated identity values `person_id: "system"`, `session_id: "none"`, `device_id: "none"`. `audit_events.person_id` is `NOT NULL` (004:7) so the code invents a principal. Contradicts CLAUDE.md rule 4 and the repo's own stance in `033:29-32`. Fix: make `audit_events.person_id` nullable via a new migration (or add `actor_kind`), write `null`, never `"none"`.

### `src/services/device-service.ts`
- **P2** `27,112-116,146-150`: `challenges` is an unbounded in-process `Map`; expired entries never pruned (only deleted when presented). `apps/api/src/server.ts:775` exposes `issueChallenge()` on an unauthenticated route → memory DoS; multi-instance breaks challenge/response silently. Fix: prune on issue, cap per-device, or store in Postgres.
- **P2** `156`: `verify(null, ...)` only works for Ed25519/Ed448 keys; `createPublicKey()` at `51`/`120` accepts any PEM, so an RSA device enrolls but can never authenticate. Fix: reject non-Ed25519 at registration.
- **P3** `63-74`: catching `23505/23503/42501` inside a transaction leaves it aborted; `COMMIT` silently becomes `ROLLBACK`. Document or use SAVEPOINT.

### `src/services/telegram-owner-authority.ts`
- **P2** `128-153`: `resumeOrCreate()` (writes session + audit) runs before `resolveIdentity()` — the "denial mutates session" pattern D-131 closed for voice/channel authorities. `test/d125-telegram-owner-authority.test.ts:272-279` asserts the wrong order. Fix: `checkAuthorizationOn` first.

### `src/services/context-builder.ts`
- **P2** `25-30`: open-task lookup only tenant-scoped; returns tasks of every person in the tenant and ignores memory space although `tasks.owner_person_id` exists. Leaks task goals across persons into LLM context. Fix: `AND owner_person_id = $1`.

### `src/services/session-grant-service.ts`
- **P3** `209-221`: revoked/expired grants audit `session_grant.denied`, but `grant_not_found` produces no audit → token brute-force invisible. Fix: log not-found attempts.

### `src/services/runtime-role.ts`
- **P3** `62-73`: password interpolated as SQL literal into `CREATE/ALTER ROLE`; with `log_statement='all'` plaintext lands in server log. Mitigation: `SET LOCAL log_statement='none'` or pre-hashed SCRAM.

### `src/db/migrator.ts`
- **P2** `14-44`: no advisory lock; concurrent migrate/api/worker startups can race on same file. Fix: `pg_advisory_lock`.
- **P3** `36-38`: if ROLLBACK throws, original error masked.

### `src/db/pool.ts`
- **P3** `26,42`: `Number(env.JARVIS_DB_PORT)` accepts NaN. `50`: `max:10` hardcoded. `76-78`: rollback masking.

### `src/db/migrations/014_embeddings_pgvector.sql`, `017_knowledge.sql`
- **P2** `014:17-18`, `017:81-82`: HNSW index built on `(vec::vector(64))` — hard-coded 64 while comment says "dim settes av data". Only `FakeEmbedder` (64) matches; a real embedder (768/1536) fails on insert. Also environment-conditional: pgvector added after migration ran → `vec` never created. Fix: dedicated forward migration with explicit dim.

### `src/db/migrations/043_wallester.sql`
- **P2** `254`: `wallester_webhook_events.tenant_id` nullable unlike siblings (`040:94`,`041:96`,`042:192`). Dead nullable under RLS. Fix: NOT NULL.

### `src/db/migrations/060_self_modification.sql` / `061`
- **P2** `060:27-29` branch/pr_number/pr_url NOT NULL but `061:5-9` says unknown for code_change → `service.ts:301` inserts `""` placeholders. Fix: `061` DROP NOT NULL.

### `src/db/migrations/005_rls.sql`
- **P3** `56-62`: `people_via_membership` WITH CHECK (true) — app can insert any people row. Document.

### `scripts/lib/q21-env-recovery.ts`
- **P2** `20-27`,`118-133`: CRLF `.env` captures trailing `\r` into values and rewrites mixed line endings; quoted values unsupported. *Unverified on host.* Fix: strip `\r`, handle quotes.

### `scripts/google-drive-reauth.ts`
- **P3** `580`: access token in query string to tokeninfo. Use Bearer header. `595-599`: bare `catch {}` swallows network vs 4xx.

## B. PLACEHOLDERS / STUBS / DEAD CODE
- **P2** `device-authority.ts:85-95,167-173`: `RollbackDenial` declared/caught, never thrown anywhere. Delete or use.
- **P2** `device-service.ts:235-254`: `ApnsPushAdapter.send()` always throws `apns_unverified`; `FakePushAdapter` only working impl; neither referenced from apps/. Dead in production.
- **P3** `device-service.ts:212-233`: `PgDeviceRegistry` cache has no TTL/invalidation; stale key after rotation until restart (*unverified* whether periodic refresh exists in apps).
- **P3** `fast-router.ts:12-13,21`: `home_light` intent untested; "stedsbevisst" promise undeliverable (no IdentityContext param).
- **P3** `scripts/q20-host-run.ts:134-143`: `envPath` param dead.
- **P3** `testing/port-lease.ts:513-517,529`: v2 legacy shim.
- **P3** `049_context_engine.sql:76`: `confidence` column "ubrukt i v1".

## C. GAPS
- **P2** Tables without `tenants` FK on tenant_id: `audit_events` (004:6), `memory_versions` (008:45), `memory_item_entities` (008:84), `embeddings` (008:104), `artifacts` (009:13), `knowledge_embeddings` (017:40). Orphans survive tenant erasure. Decide + document.
- **P2** `session_grants` (053:46,49): `memory_space`/`channel` no CHECK; `sessions.last_channel` (002:8) unchecked. Add CHECKs.
- **P2** Cross-tenant simple FKs (048:35-36 vs its own rule at 048:48-56; 019-047 throughout). Accept+document or add composite keys.
- **P2** No retention/cleanup for `approvals` (003:25-33), `session_grants`, `device_enrollment_tickets` — append-only, no expires_at index, no sweep.
- **P2** Global no-RLS tables (`capabilities`, `scheduler_state`, `github_rate_limit_state`, `situation_domain_pauses`, `owner_control_state`, `self_modification_requests`) — one documented list in SECURITY_MODEL.
- **P3** `tasks_queue_idx` partial on `status='created'` (006:9) but `claim_next_task` (035:31-33) also scans `running AND lease_expires_at < now()` + `contract->>'agent_profile'` — unindexed.
- **P3** `messages` no `(session_id, created_at)` index though `MessageStore.history()` orders by it; `cost_events` no `(tenant_id, at)`.
- **P3** 11 migrations repeat `DROP CONSTRAINT business_open_loops_loop_type_check` relying on auto name; enum re-listed each time.
- **P2** No test for `ContextBuilder.build()`; `EventWriter` "system"/"none" asserted as acceptable (`data-foundation.test.ts:282-285`).
- **P2** No test for concurrent `resumeOrCreate` with no active session; none for erasure of a session with a grant.
- **P2** `runtime-role.test.ts` K (123-152): no test that unset `memory_spaces` → default deny.
- **P3** ~9 `*-wiring.test.ts` files are source-text assertions; `google-drive-reauth-wiring.test.ts:19-22` strips `//` but not `/* */`.
- **P3** `d125-telegram-owner-authority.test.ts:272-279` locks in the wrong order.
- **P3** `pg-date.test.ts:47-59` `import.meta.url.pathname` breaks on Windows drive letters (*unverified*).
- **P2** `tenant-catalog.ts:72-79` `listTenantMemorySpaces` exported publicly without caller check.
- **P2** `erasure-ledger.ts:104-113` `completeErasureRequest` no tenant predicate (RLS-only) vs `failErasureRequest` which has it.

## D. IMPROVEMENTS
- **P3** `device-authority.ts:110-166` + `device-enrollment-service.ts:150-243` duplicate membership→lock→fingerprint preamble.
- **P3** `session-grant-service.ts:69-71` + `device-enrollment-service.ts:90-92` reintroduce private `sha256Hex` copies despite `fingerprintPem`.
- **P3** `runtime-role.ts:106-115` doesn't check `jarvis_app` membership at startup (host script does).
- **P3** `pool.ts:54-56` log `err.code` too. `migrator.ts:21` fail loudly on mis-named `.sql`.
- **P3** reauth scripts: no EADDRINUSE retry; `.env.bak.<epoch>` plaintext snapshots never pruned.
- **P3** Mixed `ADD COLUMN IF NOT EXISTS` vs plain across migrations.

## E. DOC / CODE DRIFT
- `voice-session-authority.ts:13-27`, `telegram-owner-authority.ts:9-19`, `053:26-29` cite `resolveIdentity/resumeOrCreate` path; code uses `authorizeProvenDevice`.
- `session-service.ts:63-64` FOR UPDATE claim false when no session exists.
- `device-authority.ts:85-95` describes a rollback-denial path with no thrower.
- `014:16` "dim settes av data" vs hard-coded vector(64).
- `053:111-113` "ALDRI DELETE" conflicts with 018's DELETE on sessions + FK.
- `048:48-56` rule vs simple FKs in same file.
- `device-service.ts:9-15` claims shared sha256 helper; two private copies exist.
- `audit-writer.ts:14-17` "no write without audit" true only for callers using writeAudit in same tx.
- `google-drive-reauth-lib.ts:25` Gmail comment stale (google-email-reauth.ts exists).
- `ua2-p1a-host-run-wiring.test.ts:68-74` title vs assertion mismatch.

## Summary
1. Core authority code (device/channel/voice/enrollment/grant) is strong; typecheck clean.
2. Two real structural bugs: session_grants→sessions FK breaks Q-20 erasure once any grant exists (P1); concurrent first-session creation can yield two active sessions (P1); fabricated "system"/"none" audit principals (P1 by rule 4).
3. Migration hygiene mostly consistent; drifts: nullable wallester_webhook_events.tenant_id, six early tables without tenants FK, hard-coded vector(64), NOT NULL placeholders in self_modification_requests, no cleanup for approvals/grants/tickets.
4. Tests deep for authority code, thin for plumbing; ~9 brittle source-text wiring suites.
5. Scripts careful about secrets but Windows-fragile (CRLF, token-in-URL).
