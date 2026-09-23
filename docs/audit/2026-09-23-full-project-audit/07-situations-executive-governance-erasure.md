# Audit Report — Slice: situations / executive / governance / erasure

**Files read: 67** (situations 25/25, executive 14/14, governance 8/8, erasure 20/20 — every file in the four target directories, no sampling) plus cross-referenced migrations `018_erasure.sql`, `056_situations.sql`, `057_situations_activation.sql`, `059_governance.sql`, and all ~128 `CREATE TABLE` statements in `modules/core/src/db/migrations/*.sql` for the erasure cross-check.

---

## A — Bugs / holes

**A1 [P2] `modules/erasure/src/plan.ts` `planTenant()` (lines 608-632) does not delete the `tenants`, `person_tenants`, or `memory_spaces` rows themselves.**
A `{type:"tenant"}` erasure removes all content (messages/sessions/artifacts/business/finance/etc.) but leaves the tenant shell, its space registry, and membership rows intact. Verified by contrast: `modules/erasure/scripts/q20-erasure-live.ts` `cleanupTenant()` deletes `tenants`/`person_tenants`/`memory_spaces` itself via `adminPool`, outside `ErasureService` — i.e. the public erasure API's "tenant" scope is content-only, not full tenant-lifecycle-end, despite comments elsewhere (`043_wallester.sql`) describing "a TENANT-SLETTING (hele tenants livssyklus avsluttes)". Not confirmed against `docs/DATA_ERASURE.md` prose (not fully read), so intent is unverified — but the code behavior itself is confirmed.
*Fix sketch:* either extend `planTenant()` to delete `tenants`/`person_tenants`/`memory_spaces`, or document explicitly in `plan.ts` that tenant erasure is content-only and shell removal is a separate admin step.

**A2 [P3] `059_governance.sql` `owner_person_id` FK is not scope-safe, unlike `situations.owner_person_id`.**
`decision_log`, `scenarios`, `risks`, `goals` all declare `owner_person_id text REFERENCES people (person_id)` — a plain, tenant-unaware FK. `056_situations.sql` explicitly added a composite `situations_owner_scope_fk FOREIGN KEY (owner_person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id)` for exactly this reason (arkitekt-review round 2 finding 6, "a NULLABLE owner_person_id doesn't mean scope integrity can be dropped"). `059_governance.sql` (a later migration, same author/repo discipline) does not carry this forward — `GovernanceService` also does not app-level-check it. A governance row can name an `owner_person_id` from a completely different tenant. Not a privilege-escalation (owner_person_id isn't used for authorization), but a real, verifiable data-integrity drift from the repo's own established pattern.
*Fix sketch:* add `..._owner_scope_fk FOREIGN KEY (owner_person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id)` to all four governance tables, mirroring `situations`.

No other logic bugs found in `situations`/`executive`. The auto-ACT path, terminal-state monotonicity, advisory-lock ordering, and crash-recovery reconciliation described in PR #85's eight review rounds all hold under direct re-reading of `service.ts` and are independently re-proven by `act-on.test.ts` (1460 lines, sections A–P) and `activation.test.ts` — see Verification notes below.

---

## B — Placeholders / stubs / dead code

**B1 [P3] `modules/erasure/src/erasure-service.ts` — none found; the service is fully implemented, no TODOs/stubs.**

**B2 [P3] `modules/governance/src/types.ts`/`service.ts` — "delegation board" deliberately has no table** (`059_governance.sql` filehead) — this is documented composition, not a stub.

No dead code, placeholder returns, or `throw new Error("not implemented")` patterns found anywhere in the four modules. Every exported function in `situations`, `executive`, `governance`, `erasure` has a real implementation. This slice is unusually free of B-category findings compared to typical audits — the codebase's extremely dense inline documentation and iterative arkitekt-review process appear to have already caught most such gaps before merge.

---

## C — Gaps

### C1 — Erasure coverage: table-by-table (the required cross-check)

Cross-referenced all 128 `CREATE TABLE` statements against `modules/erasure/src/plan.ts`. Tables below are every tenant-scoped table **not** registered in the erasure plan, split into legitimate documented exclusions vs. real gaps.

**Legitimate, documented exclusions (not gaps — verified by explicit in-code comments):**
`audit_events`, `tool_executions`, `cost_events`, `events`, `deployments`, `infra_executions`, `infra_recovery_actions`, `incident_repair_tasks`, `incident_diagnosis_evidence` (append-only audit/evidence or `ON DELETE CASCADE`), `erasure_requests`, `erasure_fingerprints` (the ledger itself), `situation_notification_policies`, `situation_autonomy_policies`, `consent_enforcement_policies`, `location_retention_policies`, `health_retention_policies`, `vision_retention_policies` (owner-configured policy, not event/content data — each has an explicit `plan.ts` comment), `owner_control_state`, `situation_domain_pauses`, `self_modification_requests` (global, not tenant-partitioned, same class as `KillSwitch`).

**Real gaps — tenant-scoped, person-identifying data, NOT in plan.ts, and NOT documented as an intentional exclusion:**

| Table | Migration | Columns of concern | Severity |
|---|---|---|---|
| `business_companies`/`business_contacts`/`business_leads`/`business_opportunities`/`business_activities`/`business_followups` | `019_business.sql` | tenant_id, owner_person_id, direct contact PII (name/email presumed) | **P1** — documented as a *known* pre-existing gap in `plan.ts` comments (Q-25 pt.9) at 6+ separate call sites, but never closed. This is the single largest unaddressed erasure hole in the repo; `business_contacts` in particular holds real personal contact data. |
| `person_tenants` | `001_identity.sql` | person_id, tenant_id (membership row) | **P2** — `planPerson()` never removes the membership row itself; after a person-scope erasure the person still appears as a tenant member. Not documented anywhere as excluded. |
| `session_grants`, `devices`, `device_enrollment_tickets` | `053_session_grants.sql`, `001_identity.sql` | person_id, tenant_id, device fingerprints | **P2** — device/session authorization records tied to a specific person are never touched by any erasure scope, and (unlike the policy-table exclusions above) there is no comment anywhere explaining this as intentional. |
| `business_scores` | `022_business_scoring.sql` | tenant_id, memory_space_id | **P2** — derived scoring data over the (unerasable) business_* tables; not registered, not documented as excluded. |
| `tasks` | `003_tasks_capabilities_approvals.sql` | tenant_id, person_id (unverified content — schema body not read in full) | **P3 (unverified)** — flagged for follow-up; not registered, not documented. |
| `memory_sources` | `008_memory.sql` | tenant_id (referenced by `memory_items.source_id`) | **P3** — `plan.ts` deletes `memory_items` but never `memory_sources`; rows referencing deleted items become orphans after every memory-space/person erasure (content sensitivity of `memory_sources` columns unverified — flagged as resource/hygiene gap at minimum). |

### C2 — Untested logic / vacuous tests
None found. Every non-trivial branch in `service.ts` (situations), `plan.ts` (erasure), and `service.ts`/`ranking.ts` (executive) has a corresponding test asserting behavior, not just "doesn't throw." The erasure test suite in particular is unusually rigorous: each domain-erasure test (contracts/growth/operations/product/support/vision/PDT) independently re-derives the FK dependency graph via a live `information_schema` query (`schema-drevet FK-audit`) rather than trusting the hand-written `plan.ts` ordering comments — a strong anti-pattern-in-tests defense.

### C3 — Undocumented env vars
`JARVIS_OWNER_PERSON_ID`, `JARVIS_TENANT_ID` (used by `modules/executive/scripts/d174-executive-control-surface-live.ts`, defaulting to `"person-tobias"`/`"tenant-personal"`) were not found in a `.env.example` grep from this slice's working directory context. `JARVIS_SITUATION_SWEEP_HOUR` (used in `apps/api/src/main.ts:1035`, outside this slice but referenced by situations wiring) is similarly not confirmed documented. Unverified — `.env.example` was grepped but returned no matches; could not confirm the file's full contents from this slice.

### C4 — Advisory-lock scope note (design, not a bug)
`withDomainAdvisoryLocks()` (`advisory-lock.ts`) keys locks purely on `hashtext(domain)` with **no tenant_id in the key**. Since `situation_domain_pauses` is explicitly, deliberately global (documented at length in `domain-pause.ts`'s filehead, "same global scope as KillSwitch"), this is intentional — but it does mean an `actOn()` for domain `"spend"` in tenant A will serialize behind a `pauseDurable("spend", ...)` call from tenant B. This is a genuine cross-tenant contention point, correctly reasoned about but worth flagging as a scalability note, not a correctness bug.

---

## D — Improvements

**D1 [P3]** `modules/erasure/src/erasure-service.ts:161-170` — `failErasureRequest()` failure is caught and logged (D-220/D-221 lineage), but the *original* transaction failure and the *secondary* persistence failure are both swallowed into a single `{status:"failed"}` return with no `erasure_requests` row at all in the double-failure case (test R confirms this exact scenario is possible and only mitigated by structured console logging). Consider a durable dead-letter mechanism for this specific double-failure window rather than relying solely on log scraping.

**D2 [P3]** `modules/governance/src/service.ts` has no pagination on `listDecisions`/`listScenarios`/`listRisks`/`listGoals` — unbounded `SELECT * ... ORDER BY`. Low risk today (internal journal, low row-count domain) but worth a `LIMIT`/cursor before this becomes a real dataset.

**D3 [P3]** `modules/executive/src/types.ts` documents (D-209 comment) that `connector_health` is reactive-only ("a tool_id with no entry means 'not tried yet in this process's lifetime', never 'healthy'") — this is a reasonable, explicitly-flagged limitation, not a bug, but a proactive health-ping primitive would close a real observability gap the comment itself acknowledges as future work.

---

## E — Doc/code drift vs. design docs

Checked `docs/UA10_SITUATION_ENGINE_DESIGN.md` and `docs/UA11_EXECUTIVE_MODE_DESIGN.md` against the code. No drift found — both docs are unusually current: UA10's §10 (P1 activation) and UA11's §7 (deferred list) and §9 (acceptance criteria) match the actual `service.ts`/`transport.ts` implementations line-for-line where checked (auto-ACT gating, delegation-board composition source, `revoke_device` tenant-binding via D-175, D-176 self-recovery exception scope). This is the one area of the slice where documentation is fully synchronized with code — no E-category findings.

---

## Verification notes (scrutiny items from the task)

1. **Can ACT run without an explicit autonomy policy?** No — confirmed by direct code read of `autoActPending()` (`service.ts:1432`): the SQL join requires `situation_autonomy_policies p ... AND p.enabled = true`; absence of a row means the query returns zero candidates. `activation.test.ts` section C explicitly proves "uten policy: en 'suggest'-situasjon utløser INGEN handling."
2. **Is terminal ACT state monotonic (no re-execution on retry)?** Yes — confirmed via the `ClaimOutcome` discriminated union (`terminal_replay`/`evidence_replay`/`fresh`) and the DB-level `situations_act_claim_tuple_ck` + `situations_act_claim_immutable` trigger (`056_situations.sql`). `act-on.test.ts` section L proves this under credential-revocation/rate-limit/connector-freeze interference — all confirm the replay path never calls `gateway.execute()` again once `act_result` is set.
3. **Advisory-lock keys collide across tenants?** By design, yes — see C4. Not a bug given the documented global-pause semantics, but a real contention surface at scale.
4. **Do executive mutations bypass ToolGateway/D-68 identity?** No — every mutating `ExecutiveService` method is a pure passthrough to `gateway.execute({identity, tool_id: "situations"|"owner_controls"|"finance", ...})`, never touching `SituationEngine`/`DomainPauseRegistry`/`KillSwitch`/`OwnerControls` directly. Confirmed structurally (constructor takes only `ToolGateway`) and by test (`service-transport.test.ts` sections C/D/H/I, including forged-identity-in-parameters rejection).
5. **Is the read-only allowlist actually read-only?** Yes for `situations`/`executive`/`governance` — every `read(...)` tool definition maps to a `SELECT`-only service method; verified by reading every branch of all three `transport.ts` files.
6. **Governance RLS / decision-log immutability?** RLS confirmed correct (tenant + restrictive space policy, tested in `service-rls.test.ts` sections F/G). Decision log is explicitly *not* append-only by design (`reverseDecision()` mutates status) — this is intentional per the migration's own filehead ("append-lignende, men IKKE strengt append-only"), not a bug.
7. **Is erasure reachable only via a class-D path?** Yes — `executeErasure()` calls `PolicyGateway.authorize()` directly with `capability_class: "D"` (not via `ToolGateway.execute()`, deliberately, to avoid storing a content copy in `tool_executions.before_state`). Sovereign-owner or signed-approval is required; confirmed by `erasure-service.test.ts`'s dedicated §7/§8 describe block (denied without approval, allowed with a valid ed25519-signed approval).

---

## Health summary
- **situations**: mechanically sound; auto-ACT, claim monotonicity, and advisory-lock ordering all hold under direct re-verification. No new bugs found beyond the already-known, intentional global-lock/global-pause contention surface.
- **executive**: a clean, zero-new-state composition layer; every mutation demonstrably passes through the real `ToolGateway`/`PolicyGateway` gates with unforgeable identity.
- **governance**: functionally correct and RLS-safe, but has a real, fixable scope-safety regression on `owner_person_id` relative to the pattern `situations` already established (A2/C1).
- **erasure**: the dominant real risk in this slice is coverage, not mechanism — the deletion/idempotency/rollback machinery is excellent and heavily tested, but `business_contacts`/`business_companies`/etc. remain a known, unfixed, PII-bearing gap (C1), and `person_tenants`/`session_grants`/`devices` are undocumented gaps that should at minimum be explicitly excluded-and-commented or closed.
- **Overall**: this is a high-quality, heavily self-reviewed slice (visible via the extensive arkitekt-review-round commentary); the two concrete action items worth escalating are the business_* erasure gap (P1, already known) and the governance owner_person_id scope-safety FK (P3, newly found here).
