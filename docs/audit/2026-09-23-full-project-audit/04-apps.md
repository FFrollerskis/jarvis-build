# Audit report — slice `apps/api/`, `apps/web/`, `apps/mobile/`

**Files read: 49 / 49 in slice** (apps/api: 9 src + 28 test + 3 scripts + package.json + tsconfig.json = 42; apps/web: 3; apps/mobile: 4). Supporting reads outside the slice for claim verification: `modules/core/src/services/identity-service.ts`, `device-service.ts`, `modules/policy/src/policy-gateway.ts`, `modules/tool-gateway/src/{scheduler,mesh-bridge,integrations,gateway}.ts`, `modules/situations/src/transport.ts`, `modules/self-modification/src/types.ts`, `packages/contracts/src/{approval,canonical}.ts`, `.env.example`, `infra/local/docker-compose.yml`, `docs/DECISIONS_AND_ASSUMPTIONS.md` (grep). `npx tsc --noEmit -p apps/api` → exit 0.

---

## A. Bugs / holes

### apps/api/src/server.ts

**A1 · P0 · server.ts:810-829, 964-990, 995-1252 (15 routes)** — `/tasks/submit`, `/tools/critical-demo`, `/incidents/*` (8 routes), `/deployments/ingest/github`, `/infra/execution/mutate|get`, `/observability/docker/status`, `/infra/recovery/attempt`, `/infra/pause|resume|degrade|status` authenticate with a **client-supplied `identity` object including `auth_strength`**, validated only by `deps.identity.resolveIdentity()` → `checkAuthorizationOn()` (identity-service.ts:65-91: three existence SELECTs, no key/grant check) and `buildContext()` (identity-service.ts:99-110 copies `auth_strength` verbatim). In production `PolicyGateway` runs SOVEREIGN for the owner (main.ts:175-178; policy-gateway.ts:161-179 → class B/C ALLOW, class D ALLOW with `approval === undefined`), so anyone who can reach the port and knows the three public default IDs (`person-tobias`/`tenant-personal`/`jarvis-core`, seed.ts:27-36) can submit sandbox coding jobs, mutate/stop Docker containers, pause infra, and create repair tasks — no device proof, no grant. `main.ts:1153 server.listen(port)` binds all interfaces, `infra/local/docker-compose.yml:157` publishes the port, and the mobile clients target a LAN IP (WatchApp.swift:29). D-131 only fixed `/chat`, `/brief`, `/devices/register`. The `d131` test comment at server.ts:741-748 states the exact weakness ("VERIFISERTE EKSISTENS og autentiserte ingenting") but it was left in place for these routes.
Fix: route all 15 through `resolveFromGrant()` (grant_token body, `EXECUTIVE_QUERY_BODY_KEYS` shape) exactly like `/executive/*`; until then bind `127.0.0.1` outside the container. Log as a K-finding.

**A6 · P2 · server.ts:347-353, 360-366** — `readBody`/`readRawBody` have no size cap; an unauthenticated client can post an unbounded JSON/webhook body. Fix: cap at ~1 MiB, respond 413.

**A7 · P2 · server.ts:375-381** — Any unhandled error becomes `500 {message: err.message}`, so pg errors, `JSON.parse` messages and internal reasons like `device_owned_by_other_principal: &lt;id&gt;` (device-service.ts:107) reach the client; `/devices/challenge` and `/devices/challenge/verify` (773-785) have no try/catch around `readBody`, so invalid JSON is a 500 not a 400. Fix: log server-side, return generic `internal_error`; wrap the two device routes like `/session/authorize` does.

**A8 · P2 · server.ts:773-776 + device-service.ts:27,112-115** — `/devices/challenge` is unauthenticated, `body.device_id` is unvalidated (`undefined` is stored), and the in-memory `challenges` Map is only pruned on a successful `verifyChallenge`; expired entries are never evicted, so repeated requests grow memory without bound. Fix: validate `device_id` is a non-empty string; evict expired entries on issue; cap map size.

**A10 · P2 · server.ts:413-423** — `depRoutes` is stale: in health-mode `/brief`, `/executive/*`, `/governance/*`, `/owner-controls/*`, `/devices/*`, `/webhooks/*`, `/deployments/ingest/github`, `/incidents/correlate/db`, `/incidents/evidence/acquire_logs`, `/incidents/diagnosis/*`, `/infra/execution/*`, `/observability/*` return 404 instead of 503 `not_configured`. Fix: replace the list with "any POST when `!deps` → 503".

**A12 · P3 · server.ts:514-525** — If `conversation.handle` throws mid-SSE (any error other than Budget/cancelled/interrupted), the outer catch sees `headersSent` and just ends the stream; no `error`/`done` event, so `index.html:255-274` leaves "…" forever. Fix: `send("error", {reason})` before `res.end()`.

### apps/api/src/worker-main.ts

**A2 · P1 · worker-main.ts:122-129 vs main.ts:154-159** — Worker refreshes `PgDeviceRegistry` **once at startup only**; main.ts has a 30 s interval. The worker's `PolicyGateway.authorizeClassD` (policy-gateway.ts:195-199) verifies signed approvals against this cache, so devices enrolled after worker start are unknown and revoked/rotated keys stay trusted until restart. `drive-runtime-wiring.test.ts:257` even asserts "ingen interval her - uendret", codifying the drift. Fix: add the same `setInterval(...refresh...)` (no `unref`, worker is a dedicated process) and update the test.

**A4 · P1 · worker-main.ts:426 + modules/tool-gateway/src/mesh-bridge.ts:70-110** — The worker's `executive` handler hands the model `meshToolDefinitions()`, which includes `check_my_capabilities` (`tool_id: "executive"`) and `search_my_memory` (`tool_id: "memory"`), but the worker never registers `executive` or `memory` (worker-main.ts:291-337). Every such call returns `unknown_tool` (gateway.ts:362-364) — the model is offered tools that structurally cannot work in one of the two queue drainers. `executive-wiring.test.ts:37-41` / `memory-search-wiring.test.ts:41-45` assert this absence as intentional without noticing MESH_TOOLS is shared. Fix: either register `memory`+`executive` read-only in the worker, or pass `meshToolDefinitions(MESH_TOOLS.filter(registered))`.

### apps/api/src/main.ts

**A5 · P2 · main.ts:451-455** — `ownerIdentity.person_id` is hardcoded `"person-tobias"` while every other site uses `process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias"` (main.ts:119,176,862,911; worker-main.ts:339; seed.ts:28). With a non-default owner ID, all 17 scheduler jobs, the daily brief, Telegram `brief`/`status`, `sendTelegram` and the connector-health sweep run as a person that may not exist → `unknown_membership`/policy denials. Fix: reuse `ownerControlAuthority.owner_person_id`.

**A11 · P3 · main.ts:956,968,975,983,989,995,1008,1035,1056,1063,1071,1084,1094,1102,1110,1119,1136** — `Number(process.env[...] ?? N)` yields `NaN` on any non-numeric value; `scheduler.ts:30 hour &lt; NaN` is always false, so the job silently fires at the first tick after midnight. worker-main.ts validates its numeric envs (`parseWatchdogIntervalMs`, `parseCostHardLimitOre`); main.ts does not. Fix: shared `parseHourEnv(name, default)` that throws on invalid input (fail-closed like Q-21).

### apps/api/src/conversation.ts

**A3 · P1 · conversation.ts:233** — `system = \`${systemPrompt}\n\n${memoryContext}\`` places retrieved memory **after** `SAFETY_CRITICAL_SUFFIX`, so the file-header claim (lines 100-105: suffix "appendert UBETINGET og ALLTID sist") is false at runtime: the last text in the system role is memory-retrieval output, which per CLAUDE.md rule 7 may originate from ingested untrusted content. `d214-personality-system-prompt.test.ts:40-44,98-111` only checks `toContain`, never position. Fix: `system = [memoryContext ? \`&lt;memory&gt;\n${memoryContext}\n&lt;/memory&gt;\` : "", cosmetic, SAFETY_CRITICAL_SUFFIX].join("\n\n")` and add an `endsWith(SAFETY_CRITICAL_SUFFIX)` assertion.

**A13 · P3 · conversation.ts:335-340** — Council-not-configured path returns `routed: "model"` though no model call happened; trace/UI misattribute it. Fix: `routed: "fast"` or a new `"unavailable"`.

### apps/web/dashboard.html

**A9 · P2 · dashboard.html:725-729 used at 758, 811, 816, 821, 943-945, 1113, 1172, 1232, 1309-1311, 1319-1322** — `escapeHtml` (textContent→innerHTML) escapes `&amp; &lt; &gt;` but **not `"`**, yet it is used inside double-quoted attribute values (`data-situation-id`, `data-connector-id`, `data-credential-ref`, `data-domain`, `title`, `value`). `d` in `data-domain` (821) is owner-entered free text (`situations.pause_domain` schema is `z.string()`, transport.ts:195), so a domain like `x" onmouseover="…` breaks out of the attribute. Today this is owner self-XSS, but the extractable device key in localStorage (C8) makes it a key-theft primitive. `kr.progress_percent` (1308-1309) is inserted unescaped. Fix: also replace `"`→`&amp;quot;` (and `'`) in `escapeHtml`, or build these nodes with `dataset`/`textContent`.

### apps/mobile

**A14 · P3 · JarvisApp.swift:76-78, WatchApp.swift:80-82** — `/tools/critical-demo` bodies self-assert `auth_strength: "signed"` and use `session_id` `"-"` (iOS before first chat) / `"sess-watch"` (hardcoded). Unverified by the server (A1). Fix: falls out of the A1 fix; drop the self-asserted fields.

### Verified OK (no finding)
- Swift `ApprovalSigner` canonical form matches `approvalSigningBytes`/`canonicalStringify` (sorted keys, same 5 fields).
- Credential-paste UI never echoes the value (dashboard.html:1023-1025); server `setSecret` error strings are constants (gateway.ts:339); `type="password"`.
- `/session/authorize`, `/chat`, `/brief`, `/executive/*`, `/governance/*`, `/owner-controls/*`, `/devices/register` all use grant/enrollment authority with strict key allowlists — and are the only routes the e2e suites exercise.
- Startup: `buildDeps().catch → process.exit(1)` (main.ts:1146-1151) fails closed; optional deps degrade explicitly (`deviceRegistry.refresh` logs, DailyScheduler tick logs). No silent degradation found in main.ts itself.

---

## B. Placeholders / stubs / dead code

**B1 · P2 · server.ts:26-33, 964-990** — `/tools/critical-demo` is a phase-3 stub (`executed: "critical_demo_stub"`) still routed in production and reachable via A1; header comment says "ingen egen HTTP-autentisering ennå". Fix: remove or gate behind `JARVIS_ENV !== "production"`.

**B2 · P3 · conversation.ts:389-399** — `home_light` fast intent is a canned placeholder ("krever tilkoblet Home Assistant-instans"); no `HomeAdapter` wired anywhere in the slice. Fix: mark DEFERRED in docs or remove intent.

**B3 · P3 · conversation.ts:367-368** — `system_status` returns a constant "Database og policy er aktive" without checking anything. Fix: reuse `statusText()`-style real probe or reword.

**B4 · P3 · main.ts:843-848** — `statusText` hardcodes `fase: v4.0 UA-1 P1A + D-30 voice foundation` (stale since ~D-30). Fix: read from `PROJECT_STATUS.md`/package version or drop.

**B5 · P3 · JarvisClient.swift:274-277** — `dict()` unused; `proveDevice()` (224-232) unused by both apps. Fix: delete.

**B6 · P2 · apps/api/scripts/bo11-live.ts:28,41; p1a-drive-runtime-smoke.ts:123,130; bo11-1-delta-live.ts:54-61** — Scripts are outside `tsconfig include` (`src`,`test`) so never typechecked; they construct `new KillSwitch()` / `new OwnerControls(killSwitch)` (pre-K1 in-memory signatures) and `bo11-1-delta-live.ts` posts a pre-D-131 identity body to `/chat`, which now returns `400 malformed_request`. Fix: add `scripts` to tsconfig include, update or archive the two BO-11 scripts.

**B7 · P3 · server.ts:1250** — `/infra/status` `frozen_connectors` filters the hardcoded list `["github"]` — any other frozen connector (docker, vercel…) is never reported. Fix: use `controls.listFrozen()` (or the `owner_controls.get_control_state` data).

**B8 · P3 · seed.ts:42-45** — `dev-web` demo device is seeded in the production seed path (`migrate-main.ts:26`). Harmless without a key, but adds an attackable id for A1. Fix: gate on `JARVIS_ENV !== "production"`.

---

## C. Gaps

**C1 · P1 · untested routes (within apps/api/test)** — No test in the slice hits `/devices/challenge/verify`, `/incidents/get|list|evidence/acquire_logs|correlate/db|diagnosis/*|repair`, `/infra/execution/mutate|get`, `/observability/docker/status`, `/infra/pause|resume|degrade|status`, `/infra/recovery/attempt`, `/webhooks/stripe|vipps|neonomics|wallester`, `/worker/tick` (only as a helper). Only `/deployments/ingest/github`, `/incidents/create|correlate|evidence/add` (deployment-ingestion-api.test.ts) and `/tasks/submit` (coding-production-wiring.test.ts) are exercised. Fix: one HTTP e2e per route family, including the A1 auth regression.

**C2 · P2 · source-text tests** — 20 of 28 test files are `readFileSync` + regex/`indexOf` slices of `main.ts`/`server.ts`/`dashboard.html` (e.g. executive-mutate-wiring.test.ts:89-93 slices from `/executive/mutate` all the way to `/devices/register`, spanning other routes). They prove wiring text, not behaviour, and several slice on a comment string (`drive-runtime-wiring.test.ts:159 "BO-05: reboot-durabel morgenlevering"`). Acceptable given main.ts is un-importable, but the D-214 suite (A3) and drive-runtime O (A2) show they can enshrine bugs. Fix: extract `buildDeps()` into an importable module with an injectable pool so real composition tests become possible.

**C3 · P2 · `.env.example` missing 27 variables read by this slice** — `JARVIS_TENANT_ID`, `JARVIS_OWNER_PERSON_ID`, `JARVIS_OWNER_NAME`, `JARVIS_TELEGRAM_TOKEN`, `JARVIS_TELEGRAM_CHAT_ID`, `JARVIS_VOICE_URL`, `JARVIS_VOICE_DEVICE_ID`, `JARVIS_SANDBOX`, `JARVIS_TRACE_FILE`, `JARVIS_STREAM_DEBUG`, `JARVIS_COST_HARD_LIMIT_ORE`, `JARVIS_WATCHDOG_INTERVAL_MS`, `JARVIS_BRIEF_HOUR` (scheduler.ts:16), and all of `JARVIS_{FINANCE_SPEND_SWEEP,BUSINESS_SWEEP,BUSINESS_WEEKLY_BRIEF,BUSINESS_EVENTS_SYNC,CONVERSATION_GRAPH_SYNC,BUSINESS_SCORING,SUPPORT_INBOX_SYNC,GROWTH_RECOMMENDATION_SWEEP,LOCATION_RETENTION_SWEEP,HEALTH_RETENTION_SWEEP,VISION_RETENTION_SWEEP,SITUATION_SWEEP,CONNECTOR_HEALTH_SWEEP}_HOUR` + `JARVIS_BUSINESS_WEEKLY_BRIEF_WEEKDAY`. Only the four finance `*_SYNC_HOUR` vars are documented. Fix: add a "Runtime/scheduler" block to `.env.example`; add a test that diffs `process.env["..."]` reads against it.

**C4 · P2 · no rate limiting anywhere** — `/devices/challenge`, `/session/authorize`, `/devices/register` (ticket brute-force), the four webhooks and the A1 routes accept unlimited requests. Fix: simple per-IP token bucket middleware in `route()`.

**C5 · P2 · scheduler hour collisions (main.ts:939-1142)** — All jobs sharing an hour fire on the same 60 s tick concurrently in one process (scheduler.ts:48-53): hour 2 → 3 retention sweeps; hour 3 → stripe + vipps + neonomics (three provider network syncs at once); hour 5 → business-events-sync + conversation-graph-sync (both hit Gmail); hour 7 → daily-brief (default `JARVIS_BRIEF_HOUR=7`), business-weekly-brief, situation-sweep, business-scoring-recalc. Comments (1023-1024, 1067-1069) only reason about ordering *across* hours; within hour 7 there is no ordering guarantee between scoring recalculation and the situation sweep/weekly brief that may read scores (unverified whether they do). Fix: stagger defaults (e.g. 7/7:15 requires minute support) or a single scheduler that runs a dependency-ordered list.

**C6 · P2 · 14 sweeps discard their result — main.ts:957,969,976,984,990,996,1057,1064,1072,1085,1095,1103,1111,1120** — every `.then(() =&gt; undefined)` job returns a per-tenant result map whose provider sweeps catch errors internally (e.g. neonomics-sweep.ts:44, wallester-sweep.ts:38, stripe-sweep.ts:27) and location/health/vision return `failed[]`; all are thrown away, so DailyScheduler marks the day completed and nothing is logged. Only weekly-brief, situation-sweep (`assertSituationSweepHealthy`) and connector-health-sweep surface failures. Fix: `const logSweep = (name) =&gt; (r) =&gt; { if (hasFailures(r)) console.error({msg:`${name}_failures`, r}) }` and apply uniformly.

**C7 · P2 · worker parity undocumented** — main.ts registers `conversation_graph` (620), `governance` (661), `self_modification` (673) transports that worker-main.ts lacks; only `owner_controls`/`situations`/`executive` are documented as api-only (worker-main.ts:103-106; `memory` in memory-search-wiring.test.ts:41). Fix: list all seven api-only namespaces in the worker-main.ts header and in D-164/D-242 notes.

**C8 · P2 · index.html:99-118, dashboard.html:448-462, voice.html:147-161** — Device private key stored as an **extractable** JWK in `localStorage`; combined with A9 any script injection exfiltrates the enrolled Ed25519 key. Fix: `generateKey(..., extractable=false)` and persist the `CryptoKey` object in IndexedDB.

**C9 · P3 · dashboard.html:1430-1461** — `loadAll` uses `Promise.all`; one failing query (e.g. governance not registered) blanks all eight sections with a single "Feil:". Fix: `Promise.allSettled` per section.

**C10 · P3 · apps/mobile/project.yml:19-20** — `NSAllowsLocalNetworking: true` with a comment "Fjernes/strammes i prod (TLS)"; no TLS story exists for the LAN API (relevant to A1). `docs/APPLE_PHASE8_CHECKLIST.md` reference at line 2 — existence unverified.

---

## D. Improvements

**D1 · server.ts:553-738** — Five byte-identical grant-route blocks (`/executive/query|mutate`, `/owner-controls/connector-credentials`, `/governance/query|mutate`). Extract `grantToolRoute(deps, req, res, {tool_id, allowlist})`; the 1256-line if-chain then shrinks by ~200 lines and A1 becomes a one-place fix.

**D2 · main.ts:350-441 vs worker-main.ts:201-279** — ~90 duplicated lines of finance credential providers. Extract `apps/api/src/finance-credentials.ts` shared by both; today any env-name change must be made twice.

**D3 · server.ts:774,779,816,967,996,1010,1022,1033,1052,1074,1088,1098,1114,1136,1146,1167,1176,1184,1207,1228,1244** — Request bodies are `as {...}` casts with no zod; `zod` is already a devDependency (package.json:46). Validate with `.strict()` schemas even after A1.

**D4 · main.ts:1153** — Add `JARVIS_API_HOST` (default `127.0.0.1` when not in a container) and document the exposure decision in SECURITY_MODEL.md.

**D5 · main.ts:486-491** — `sendTelegram` ignores `toolGateway.execute()` results (acknowledged at 934-936); command replies and self-modification notifications can vanish silently. Log `!result.ok`.

**D6 · voice.html:259** — `techLog` stringifies every server frame (incl. `tts_frame` base64) into the DOM; skip `tts_frame`/`audio` types to keep the log usable.

---

## E. Doc / code drift

**E1 · server.ts:26-33** — Header still says "Fase 3 … ingen egen HTTP-autentisering ennå"; half the routes now use grants (D-131). Update, and state explicitly which routes still use identity-in-body (A1).

**E2 · server.ts:178-184 / dashboard.html:539** — "kun de to/tre LESE-handlingene" — `EXECUTIVE_QUERY_ACTIONS` has four.

**E3 · worker-main.ts:97-98** — "Kun ufarlige read-verktøy eksponeres (mesh-bridge)" — MESH_TOOLS now also exposes `executive.get_capability_status` and `memory.search`, neither registered in the worker (A4).

**E4 · main.ts:844** — hardcoded phase string (B4).

**E5 · drive-runtime-wiring.test.ts:257** — asserts "ingen interval her - uendret fra før" for the worker registry, documenting A2 as intended.

**E6 · conversation.ts:100-105** — "SAFETY_CRITICAL_SUFFIX … appendert UBETINGET og ALLTID sist" contradicts line 233 (A3).

**E7 · scripts/bo11-1-delta-live.ts:1-7, bo11-live.ts:1-3** — Documented run commands and request bodies predate D-131/K1 (B6).

**E8 · DECISIONS D-242** — Claims verified: `VercelTransport` is in both `main.ts:553` and `worker-main.ts:297`; sweep is api-only (main.ts:1135-1142). Consistent.

---

## Health summary

1. **One P0**: 15 mutating/infra routes in `server.ts` trust a client-asserted identity (existence check only) while the API listens on all interfaces and policy runs in sovereign-owner mode — LAN-reachable unauthenticated Docker/task/infra control. D-131 fixed the pattern for `/chat`/`/brief`/`/devices/register` but never propagated it.
2. **Three P1s**: worker never refreshes its device registry (stale approval keys), worker offers mesh tools it cannot execute, and the "safety suffix is always last" invariant is false because memory context is appended after it.
3. Composition roots are carefully commented and mostly consistent, but ~90 lines of finance credential wiring are duplicated and 14 of 17 scheduled sweeps discard failure results; 27 env vars read here are absent from `.env.example`.
4. Test coverage is strong for the grant-based routes and enrollment (real HTTP + Postgres), but 20/28 files are source-regex tests and no apps/api test touches the identity-in-body or webhook routes.
5. Web/mobile clients are structurally sound (grant flow, password inputs, no secret echo) but `escapeHtml` is unsafe in attribute context and the device key is an extractable JWK in localStorage — together a key-theft path once any injection lands.
