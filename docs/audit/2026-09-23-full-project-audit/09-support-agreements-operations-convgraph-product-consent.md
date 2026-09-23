# Audit Report — Slice: support, agreements, operations, conversation-graph, product, consent

**Files read: 71/71** (support 18, agreements 12, operations 11, conversation-graph 11, product 10, consent 9 — every `.ts`, `.json`, and paired migration `.sql` in the six modules, plus the relevant `tool-gateway/src/integrations.ts` registrations and `apps/api/src/main.ts` wiring for cross-checks).

---

## A — Bugs / Holes

**A1 [P1] `modules/product/src/service.ts:37-49` (`createItem`) and `:162-185` (`linkReporter`) — missing cross-tenant/cross-space scope guard on `company_id`/`contact_id`.**
Claim: unlike `support` (`assertCompanyContactInScope`, service.ts:432-457), `agreements` (service.ts:533-558) and `operations` (service.ts:163-188) — all three added after the explicit Q-33/D-130 "MERGE BLOCKER" architect finding that a bare FK does not enforce tenant/space scope because Postgres FK checks bypass RLS — `ProductService.createItem`/`linkReporter` insert/update `company_id`/`contact_id` straight into `product_items` with no equivalent check. A caller-supplied `company_id`/`contact_id` from a different tenant (or a different memory_space in the same tenant) is silently accepted as long as the FK target row exists anywhere, exactly the class of bug D-129/D-130 fixed in the sibling modules. No test in `modules/product/test/*` exercises this (confirmed — no cross-tenant/cross-space reporter-link test exists, unlike `agreements-timeline-atomicity.test.ts` "Blocker B" or `operations/test/scope-integrity.test.ts`).
Fix: add the same `assertCompanyContactInScope()` helper (copy the support/agreements/operations pattern) and call it before insert in `createItem` and before update in `linkReporter`; add a scope-integrity test mirroring `operations/test/scope-integrity.test.ts`.

**A2 [P2] `modules/support/src/state-machine.ts:9-19` — `resolved -> pending` transition is reachable but arguably semantically wrong (unverified as a real bug, flagging for review).**
`TICKET_TRANSITIONS.resolved` includes `pending`, which lets an operator move a resolved ticket straight to `pending` (bypassing `open`) via `setStatus`. This does not fire `reopened` classification (`service.ts:172`: only `resolved`/`closed`→non-terminal transitions become `"reopened"`, others `"status_changed"` — so `resolved`→`pending` correctly becomes `"reopened"` since `isTerminalTicketStatus(current)===true`). On closer read this is consistent, not a bug — downgrading to informational, no fix needed. (Kept for transparency that it was checked, not asserted as a finding.)

---

## B — Placeholders / Stubs / Dead Code

**B1 [P3] `modules/support/src/service.ts` — `SupportTicket.next_action_due_at` (types.ts:47) is defined and selected via `SELECT *` but never written by any service method.**
Only `next_response_due_at` has a setter (`setNextResponseDue`). `next_action_due_at` exists in schema/types but has no write path anywhere in the module — dead column from the caller's perspective (support-sweep/open-loop code reads `COALESCE(next_response_due_at, next_action_due_at)` in `modules/business/src/open-loop-service.ts:146`, so it's schema-complete but functionally unreachable via `@jarvis/support`).
Fix: either add a `setNextActionDue()` method or document explicitly that it's reserved for a future channel and unused in this slice.

**B2 [P3] `modules/consent/src/enforcement-service.ts` — enforcement is wired into exactly one call site (`GrowthService.attributeToCampaign`/`attributeFromTracking`), making the `audit`/`enforce` rollout machinery effectively single-purpose today.**
Verified via grep: `ConsentEnforcementService`/`@jarvis/consent` is referenced only in `apps/api/src/main.ts` (construction + injection into `GrowthService`), `modules/growth/src/service.ts`, and consent's/growth's/erasure's own tests. No other module (support, agreements, operations, product) consults consent enforcement despite all of them writing customer-linked records. This is not a bug (the `purpose` enum is deliberately closed to `attribution`/`tracking` per D-91, and growth is the only capability with those purposes) but is worth flagging as a scope note — not a defect, downgraded from initial suspicion after verifying the wiring is real and correctly gated (`this.consentEnforcement` is optional and a true no-op when unset, per `growth/src/service.ts:60-65`).

---

## C — Gaps (spec vs. reality, untested logic, D-64 boundary, env vars)

**C1 [P1] Tenant-authority pattern used by support/agreements/operations/product/consent transports is the SAME class of bug D-119 fixed adversarially in conversation-graph — unverified whether it's actually exploitable here, but the asymmetry is real and undocumented.**
`ConversationGraphTransport` (transport.ts:1-85) was hardened (D-119 "FINAL AUTHORITY / TENANT-BOUNDARY HARDENING") specifically because an adversarial probe proved a tenant-A-authenticated caller could read/write tenant-B rows by setting `parameters.tenant_id` — `PolicyGateway.authorize()` checks `request.identity`, never `request.parameters`, and the old transport read `tenant_id` from parameters. After the fix, `tenant_id`/`memory_space` come exclusively from `context.identity`, and `.strict()` zod schemas reject any caller who still sends those fields.
`SupportTransport` (transport.ts:41-42), `AgreementsTransport` (:19-20), `OperationsTransport` (:19-20), `ProductTransport` (:19-20), and `ConsentTransport` (:19-20) all still read `tenant_id`/`memory_space` directly from `parameters`, with only a code comment asserting "parameters MÅ komme via de zod-validerte parameters, bygget av TRUSTED kallerlag" — i.e. the same assumption D-119's own file header says was proven false for conversation_graph. Whether this is exploitable depends on code outside this slice (whether the model-facing tool-calling loop can ever place `tenant_id` under a caller's control, e.g. via a crafted request) — I could not verify this within the six assigned modules and explicitly did not open agent/orchestration code outside my slice. Flagging as **unverified but structurally identical to a proven-exploitable pattern**, worth an explicit architect decision (either confirm the trusted-caller-layer boundary genuinely can't be reached by a model, or apply the same `context.identity`-only hardening to these five transports).
Fix / next step: architect review of whether `firstWaveTools()` callers for `support.*`/`contract.*`/`operations.*`/`product.*`/`consent.*` can ever originate `tenant_id` from model output; if so, apply the D-119 pattern (identity-derived tenant/space, `.strict()` schemas dropping `tenant_id`/`memory_space`).

**C2 [P2] `docs/UA7_COMMUNICATIONS_DPIA.md` referenced in the task brief does not exist under that name — could not verify conversation-graph module against it.**
Task context named `docs/UA7_COMMUNICATIONS_DPIA.md`; the actual file in the repo is `docs/UA3_BUSINESS_DPIA.md` (found via grep) — no `UA7`-named DPIA exists in `docs/`. I did not locate a UA-7-specific DPIA to check conversation-graph's PII minimisation/retention promises against. Flagging as a documentation gap: either the DPIA file was never created for UA-7 (Communications Hub / Conversation Graph) despite D-119/D-121 handling identity/contact PII, or it exists under an undiscovered name.
Fix: confirm with Tobias/architect whether a UA-7-specific DPIA is required per the project's own DPIA convention (UA-3 has one); if required and missing, log as an open question in `docs/OPEN_QUESTIONS.md`.

**C3 [P2] `modules/conversation-graph` retention: no TTL/expiry mechanism for `conversation_channel_links`/`conversation_identities`, and no automatic purge for tombstoned (`status='merged'`) identities.**
Confirmed by reading `046_conversation_graph.sql` in full: merged identities are retained forever (tombstoned, never deleted) and revoked channel links are retained forever as "historikk" (explicitly by design for split-reversibility). Erasure is grep-confirmed to exist (`GRANT DELETE` present, Q-20 pattern) but is triggered only by explicit tenant/space erasure, not by any age-based retention policy. This may be intentional (append-only revisibility is the design goal per D-119), but there is no documented retention limit anywhere in the migration or service comments — worth an explicit decision log entry if a data-minimisation requirement applies to communications metadata.
Fix: log a decision (or an open question) on whether channel-link/identity retention needs a TTL under UA-7's PII-minimisation goals, or explicitly confirm indefinite retention is accepted.

**C4 [P3] Identity linking is exact-match only (email lowercase/trim, Telegram chat-id trim) — confirmed no fuzzy/display-name matching exists anywhere in `conversation-graph`.**
Verified: `normalizeChannelIdentifier` (normalize.ts) only lowercases/trims for email and trims for Telegram; no `display_name`-based matching path exists in `service.ts`'s `linkChannelIdentity`. This directly satisfies the audit brief's concern ("same display name ≠ same person") — no finding, confirmed correct by design.

**C5 [P3] `modules/consent` — `evidence` JSONB column has no schema/size validation at the transport layer.**
`ConsentTransport.record_decision` (transport.ts:29) passes `parameters["evidence"] as Record<string, unknown> | undefined` straight through with only a type-cast, no size cap or secret-pattern scan, despite the type comment (`types.ts:71-80`) explicitly warning "MÅ ALDRI inneholde hemmeligheter... `ConsentTransport` validerer IKKE innholdet utover typen... ALLE kallere er ansvarlige." This is an honestly-documented gap (not a silent one), consistent with CLAUDE.md's honesty requirement — downgraded to informational; no code fix required unless the project wants defense-in-depth (e.g. a size cap or a forbidden-key-pattern scan).

---

## D — Improvements

**D1 [P2] `modules/support/src/email-ingress.ts:79-87` `isSupportMessage()` only inspects `to`/`cc` — a support reply sent with the account BCC'd or via a distribution alias not in `JARVIS_SUPPORT_INBOX_EMAILS` would be silently dropped as `ignored_not_support` unless the thread is already a known ticket.**
This is deterministic and safe (fails closed toward "not a ticket," never toward "trust content"), matching CLAUDE.md rule 7, but is a real operational gap: if the configured inbox address ever changes or a customer emails a personal/alias address not listed, in-flight threads with no prior ticket will never become tickets. Not a security bug — an operability improvement.
Fix: consider also checking `from` against a known-agent allowlist as a defense against typo'd `JARVIS_SUPPORT_INBOX_EMAILS`, or add a metrics/alert on sustained `ignored_not_support` spikes.

**D2 [P3] `modules/operations/src/service.ts` — `escalateTask` has no upper bound on `escalation_level`.**
`escalation_level integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0)` (048_operations.sql:119) only floors at zero; repeated `escalateTask` calls increment without limit (test "gjentatt escalateTask inkrementerer nivaaet videre" confirms this is intentional/tested behavior, not a bug). Minor robustness suggestion: an unbounded escalation_level could be a footgun for any future UI/alerting threshold logic; consider a documented practical ceiling.

**D3 [P3] Cross-module `as unknown as JsonValue` casts (pervasive across all six modules' transports) bypass structural verification of DB row shape vs. the declared TS interfaces.**
This is the codebase's standard, consistent idiom (every transport in the six modules does `row as unknown as JsonValue`), and the underlying rows are `SELECT *` from a schema-validated table, so risk is low. Flagging only as a general improvement opportunity: a lightweight zod-parse-on-read (or a generated-type check) at the DB boundary would catch column drift between migrations and `types.ts` at test time rather than silently at runtime. Not module-specific, not a bug in this slice.

---

## E — Doc/Code Drift

**E1 [P3] `modules/support/src/state-machine.ts:14` comment says reopening uses "den eksplisitte reopen-veien i service.ts," but `TICKET_TRANSITIONS.resolved`/`.closed` already list `open`/`pending` as directly reachable via `setStatus` too** — the comment slightly understates that manual reopening via `setStatus` is also fully supported, not just the automatic customer-message reopen path. Purely cosmetic; behavior itself is correct and tested (state-machine.test.ts "F: gjenaapning").

**E2 [P3] Task brief's reference to "D-66 (support)" and "D-68 (support.reply forwards the caller's identity unchanged)" are both verified accurate against code** — `transport.ts:114-135` and `email-ingress.ts:148-188` correctly forward `context.identity`/`context.approval` unchanged into the nested `email.send` call, and `support-reply-authority-propagation.test.ts` (304 lines) provides strong adversarial proof (owner sovereign, delegate requires exact-match signed approval, nonce replay rejected, cross-tenant escalation rejected). No drift — documentation matches implementation precisely.

---

## Scrutiny-focused findings summary (per the four areas called out in the brief)

1. **Support email-ingress routing**: deterministic, address-based only (`to`/`cc` header match against configured inbox list, or thread-continuity check) — confirmed no email subject/body content can influence routing or trigger any action beyond classification (`email-ingress-routing.test.ts` proves ignored-by-default). `support.reply` is class-checked (capability_class "C" wrapping a nested class-D `email.send`) and forwards the real caller identity unchanged (D-68, verified). **No findings beyond A1-adjacent scope note.**

2. **Consent enforcement**: genuinely wired into a real production write path (`GrowthService.attributeToCampaign`/`attributeFromTracking`, constructed and injected in `apps/api/src/main.ts:318-336`), not just exercised in tests — my initial grep suggested otherwise but a corrected search confirmed real wiring. Fail-closed confirmed: `disabled` (no row) is safe-default, `UNKNOWN_NOT_CONFIGURED`/`DENIED` both block in `enforce` mode, `unresolved` subject fails closed in `enforce` mode (never silently treated as "no data subject"). **No enforcement-logic findings; C1 above is the only open concern (transport-level tenant-authority pattern, shared with 4 other modules).**

3. **Conversation-graph identity linking**: exact-match only (email/chat-id), no display-name or fuzzy matching exists — confirmed correct. PII minimisation: only structured addresses cross the ingestion boundary, never subject/body text (adversarially tested in `security.test.ts`). Retention: no TTL (C3). DPIA file name mismatch (C2).

4. **Agreements/operations/product state machines and tenant scoping**: agreements and operations both have the Q-33/D-130 cross-scope guard and are RLS/atomicity-tested; **product does not (A1, P1)**. All three state machines are fully enumerated, tested against unreachable/invalid transitions, and have no gaps found.

---

## Health Summary
The six-module slice is high quality: deterministic state machines, RLS-scoped queries throughout, append-only audit trails where required, and unusually thorough adversarial test suites (especially `support`/`conversation-graph`) that explicitly re-prove prior security fixes (D-67/D-68/D-119/D-129/D-130). One real regression was found: `modules/product` is missing the cross-tenant/cross-space `company_id`/`contact_id` scope guard that its three sibling modules (support, agreements, operations) all received after the same architect finding (A1, P1) — this should be fixed before product is considered on par with its siblings. The single most consequential open question is whether the tenant-authority-from-parameters pattern in support/agreements/operations/product/consent transports is exploitable the same way conversation-graph's was before D-119 hardened it (C1) — this needs an architect decision, as I could not verify the model-facing tool-invocation boundary from within this slice. Consent enforcement is genuinely and correctly wired into growth's attribution write path, not merely test-only. No prompt-injection-via-email routing or identity-spoofing issues were found in support or conversation-graph.
