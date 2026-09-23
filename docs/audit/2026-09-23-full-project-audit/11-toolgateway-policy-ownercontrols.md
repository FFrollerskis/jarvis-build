# Security Audit Report — Jarvis Tool Gateway / Policy / Owner-Controls Slice

**Files read: 77 of 77 in scope** (tool-gateway: 14 src + 3 scripts + 30 test + 2 config = 49; policy: 9 src + 2 test + 2 config = 13; owner-controls: 5 src + 4 scripts + 4 test + 2 config = 15). Every file in the three module directories was opened and read in full. Cross-referenced (not counted in the 77): `packages/contracts/src/{approval,identity,capability}.ts`, `modules/core/src/services/audit-writer.ts`, `modules/core/src/db/migrations/{010,054}*.sql`, `modules/business/src/transport.ts` (partial), `modules/executive/src/transport.ts` (partial), `.env.example` (grep).

---

## A — Bugs / Holes

**P0 — `modules/tool-gateway/src/gateway.ts` (success path inside `withTenantTransaction`, the `writeAudit(client, ..., {type: postconditionVerified ? "tool.executed" : ...})` call, ~line 623-639).**
Claim: unlike `deny()` (which D-219 wrapped in `.catch()`), the **success-path** audit write has no try/catch. If it throws (DB blip) *after* `transport.invoke()` already executed a real side effect (email sent, payment submitted, `drive.delete_permanent`, `docker.stop_container`, `github.merge_pr`, …), the whole DB transaction — including the just-inserted `tool_executions` idempotency row — rolls back, and the exception propagates uncaught out of `execute()`. A caller retry with the same `idempotency_key` then finds no dedupe row and **re-executes the mutation**, defeating the exact double-charge/double-send protection CLAUDE.md rules 2/8 and the whole `tool_executions` mechanism exist for.
Fix: wrap the success-path `writeAudit` (and/or commit the `tool_executions` insert in a guaranteed-durable step before the audit write) with the same fail-safe/log-and-continue pattern D-219 already applied to `deny()`, so an audit-write failure can never erase the idempotency record for a mutation that truly happened.
Test gap: `modules/tool-gateway/test/gateway-deny-audit-failure.test.ts` only covers the DENY path; no test exercises "audit write fails after a successful class C/D mutation."

**P1 — `modules/policy/src/policy-gateway.ts` (`authorizeClassD` nonce consumption) vs `modules/tool-gateway/src/gateway.ts:373-450` (ordering).**
Claim: `policy.authorize()` — which burns the single-use signed-approval nonce for class D — runs *before* `withinRateLimit()`, `isFrozenDurable()` and `isRevokedDurable()` in `execute()`. A perfectly valid, first-use signed approval is therefore permanently consumed even when the request is about to be denied for `rate_limited`, `connector_frozen`, or `credential_revoked`, forcing the owner/device to mint an entirely new signature to retry a request that was legitimate.
Fix: move rate-limit/frozen/revoked checks before `policy.authorize()`, or make nonce consumption the *last* step of `authorizeClassD` conditional on all other gates already having passed (it already tries to be "last step" within its own function, but the surrounding gateway checks happen after it, not before).

**P1 — `modules/owner-controls/src/transport.ts` (`ownerControlsToolDefinitions`, `set_connector_credential` definition, capability_class `"C"`).**
Claim: this action installs a brand-new live secret value for any connector listed in `CONNECTOR_REGISTRY` (e.g. `JARVIS_STRIPE_SECRET_KEY`, `JARVIS_GITHUB_TOKEN`, `JARVIS_WALLESTER_PRIVATE_KEY_PEM`) — a capability-equivalent action to installing/rotating credentials for every class-D provider action those refs unlock. Class C only requires a pre-registered mandate string for a SCOPED/delegated identity (no per-call cryptographic signature), whereas class D requires an Ed25519 signed device approval. This looks under-classified against CLAUDE.md's own D-class criteria ("tilgangsendring"). For the sovereign owner the practical effect is identical (both C and D execute instantly), but for any future delegated actor with a `owner_controls:set_connector_credential` mandate, a hostile/compromised credential could be substituted without cryptographic proof of intent.
Fix: reclassify to `D`, or require a signed approval specifically for this action regardless of general class-C mandate policy.

**P1 (systemic, unverified for current state — `main.ts` is outside this slice) — `modules/tool-gateway/src/integrations.ts` (`transport(key)` → `UnconfiguredHttpTransport` fallback), pattern documented at `modules/tool-gateway/src/live-transports.ts:822-838` (D-242 Vercel fix).**
Claim: the code's own comments document that this exact bug class — a `tool_id` carrying a `live_test`/production credential but never actually wired to a real transport in `apps/api/src/main.ts`/`worker-main.ts`, silently falling to `UnconfiguredHttpTransport` — has recurred **five times** (D-211/D-212/…/D-242 for Vercel). Nothing in this slice structurally prevents a sixth occurrence: `connector-health-sweep.ts` only exercises the 11 `CONNECTOR_REGISTRY` entries that have `live_test`, not every `tool_id` registered via `firstWaveTools()` (e.g. `googleads`, `business`, `support`, `contract`, `growth`, `consent`, `product`, `operations`, `conversation_graph`). Whether the current wiring in `apps/api/src/main.ts` is complete cannot be verified from this slice.
Fix: a structural test (in a slice that can see `main.ts`) asserting every production-registered `tool_id:action` resolves to a non-`UnconfiguredHttpTransport` instance would close this recurring gap once and for all.

**P3 — `modules/tool-gateway/src/gateway.ts` (`parameterAuthorizer` runs after `policy.authorize()`), same ordering issue as above but for `docker.*` target authorization specifically.**
A class-D docker action (`stop_container`/`start_container`) with a valid signed approval against a target that `docker-target-policy.ts` will reject burns the nonce before `dockerTargetAuthorizer` ever runs. Same fix as the P1 ordering item above (move `parameterAuthorizer` before `policy.authorize()`, or at minimum before nonce consumption specifically).

---

## B — Placeholders / Stubs / Dead Code

**P3 — `modules/tool-gateway/test/docker-transport.test.ts:132-141` ("F: get_logs respekterer en HARD tail-grense…").**
Claim: the test body is `expect(true).toBe(true);` — the comment itself admits "the fake script always returns 2 lines regardless of `--tail`" and that this test proves nothing about the actual argv sent to the subprocess. Vacuous assertion.
Fix: assert on the actual `docker logs --tail <n>` argv the fake script recorded (the fake script already has access to `process.argv`; have it echo the received `--tail` value to state and assert `<=200`).

**No other dead code or vacuous tests found.** `UnconfiguredHttpTransport`/`FakeTransport` are intentional, actively-used test doubles, not dead code.

---

## C — Gaps

**P2 — `modules/tool-gateway/src/gateway.ts` (`withinRateLimit`, `private readonly callTimes = new Map()`).**
Rate limiting is a per-`ToolGateway`-instance in-memory `Map`, not shared across `api`/`worker` processes (unlike kill-switch/freeze/revoke, which are all Postgres-backed and explicitly documented as needing cross-process consistency). A caller alternating between the two processes can exceed the declared `rate_limit_per_minute` by up to 2×. Not silently broken (still bounds abuse per-process), but the guarantee CLAUDE.md rule 6 implies ("Policy Gateway aldri hoppes over") is weaker than it looks for this one control.
Fix: back `callTimes` with the same Postgres pattern `GithubRateLimitController`/`PgGithubRateLimitStore` already established for GitHub specifically, generalized to all tools.

**P2 — `modules/tool-gateway/src/integrations.ts`, several class-D tools without `preflight_action`: `email.send`, `finance.submit_payment_intent`, `finance.enable_kill_switch`/`disable_kill_switch`, `finance_stripe.submit_refund`, `finance_vipps.submit_capture`/`submit_refund`, `owner_controls.activate_kill_switch`/`deactivate_kill_switch`.**
`preflight_action`/`postcondition_predicate` (before/after evidence, structural fail-closed-on-unknown-target) is opt-in per `ToolDefinition`. These D-class financial-execution and kill-switch actions get *no* before/after audit evidence from `ToolGateway` itself — correctness relies entirely on `idempotent_external: true` + `tool_executions` dedupe plus whatever internal state-machine checks live in `@jarvis/business`'s `FinanceService` (out of this slice, unverified). Given payment execution is the highest-consequence action class in the system, this is worth flagging even though it may be legitimately covered downstream.
Fix: verify (in a slice covering `@jarvis/business`) that `FinanceService.submitPaymentIntent()` re-checks intent status immediately before the provider call; if not, consider giving these actions a lightweight `preflight_action` (e.g. `get_payment_intent`) purely for the structural target-existence guard.

**P2 — `.env.example` appears to be missing several credential refs actually read by this slice: `JARVIS_HA_TOKEN`, `JARVIS_VERCEL_TOKEN`, `JARVIS_TELEGRAM_TOKEN`, `JARVIS_TELEGRAM_CHAT_ID`, `JARVIS_GITHUB_REPO`, `JARVIS_BRIEF_HOUR`, `JARVIS_BUSINESS_INTERNAL_TOKEN`.**
Two independent greps against `.env.example` for these exact keys found no `KEY=` line for any of them (only one comment mentioning `JARVIS_VERCEL_TOKEN` in passing). D-236 already proved that ambiguity/absence in `.env.example` around a connector's env vars produces real production misconfiguration (the Vipps empty-string bug). Unverified with full certainty (grep, not exhaustive review of the file), but the signal is consistent across two searches.
Fix: audit `.env.example` against every `credential_ref` in `integrations.ts`/`home-assistant.ts`/`connector-registry.ts` and add the missing placeholder lines.

**P3 — `modules/tool-gateway/src/live-transports.ts` (`GoogleAccessToken()` call inside every `Gmail/Calendar/Drive` `invoke()`).**
No caching of the OAuth access token between calls — every single Gmail/Calendar/Drive action round-trips Google's token endpoint first. Purely a performance/quota concern, not a security hole.
Fix: cache the access token per refresh-token with the expiry Google returns, reactive-refresh on 401 (same pattern `InfisicalSecretProvider` already uses).

**P3 — `modules/tool-gateway/src/github-rate-limit-controller.ts` (`ProcessMutationGate`, self-documented at file header §14).**
Mutation serialization (min-1s spacing) is explicitly process-local, not cross-process. Already honestly documented in the code; flagging only because two API/worker processes mutating GitHub concurrently could still trip GitHub's secondary rate limiting despite this gate.

**P3 — `modules/tool-gateway/src/connector-registry.ts` (`export const CONNECTOR_REGISTRY: ConnectorDefinition[] = [...]`).**
Mutable, unfrozen module-level array. Production code (`owner_controls.set_connector_credential`/`test_connector` in `transport.ts`) does `CONNECTOR_REGISTRY.find(...)` against it, and `modules/owner-controls/scripts/infisical-live.ts` legitimately mutates it at runtime (`push`/`splice`) for its own test scaffolding. No external exploit path is visible from this slice, but it is a soft hardening gap.
Fix: `Object.freeze(CONNECTOR_REGISTRY)` in production wiring, or give the live-acceptance script its own registry copy instead of mutating the shared singleton.

**P3 — `modules/tool-gateway/src/integrations.ts` (`consent.record_decision`, `evidence: z.record(z.string(), z.unknown())`).**
The schema does not structurally prevent secrets or full raw personal data from being placed in `evidence`, relying purely on the doc-comment convention ("ALDRI hemmeligheter... ELLER full rå persondata-payload"). Confirmed this field is *not* part of what `ToolGateway.execute()` writes to `audit_events` (audit payload is limited to `credential_ref`/`external_id`/`scopes`/`rollback`/before-after state), so no leak within this slice — but downstream storage of `evidence` itself is in `@jarvis/business`, out of scope and unverified.

---

## D — Improvements

- Reorder `execute()` in `gateway.ts` so `withinRateLimit`/`isFrozenDurable`/`isRevokedDurable`/`parameterAuthorizer` all run **before** `policy.authorize()` for class D, so a valid nonce is never burned on a request that was always going to be denied by an orthogonal gate (ties directly to the P1/P3 findings above).
- Cache Google OAuth access tokens (perf, see C above).
- Extend the Postgres-backed rate-limit pattern already built for GitHub to the generic `ToolGateway.withinRateLimit()`.
- `Object.freeze(CONNECTOR_REGISTRY)` outside of test/script contexts.

---

## E — Doc / Code Drift

**P3 — `packages/contracts/src/identity.ts:57-60`.**
The file's own comment self-flags that the `"desktop"` `ChannelSchema` value was added "uten et eget logget D-nummer i docs/DECISIONS_AND_ASSUMPTIONS.md" and asks a future session with doc-write access to formalize it. Whether this has since been closed is unverifiable from this slice (docs are out of scope) — flagged as an open item since the code itself says it's unresolved as of that commit.

---

## Verified clean (no findings — stated explicitly per the audit brief's specific asks)

- **No audit row anywhere in this slice writes a credential value** — `gateway.ts`'s audit payload is structurally limited to `credential_ref`/`external_id`/`scopes`/`rollback`/before-after state; `docker-transport.ts` redacts secrets from logs before return; Infisical `set()`/`get()` error paths never interpolate the value (tested explicitly in `d213-writable-secret-provider.test.ts`).
- **No non-owner identity can reach SOVEREIGN**: `resolveAuthorityMode()` requires exact `person_id` + `tenant_id` match and `delegation_id === undefined`; delegation structurally excludes sovereign, tested extensively (`ua0-sovereign.test.ts`, `ua1-p1a-dclass-mesh.test.ts`).
- **Class D approval is cryptographically verified with replay protection**: Ed25519 signature over canonical bytes, action+parameter equality, expiry, atomic fail-closed nonce consumption (`approval-verifier.ts`, `nonce-store.ts`, `policy-gateway.ts`), thoroughly tested.
- **No `credential_ref` mismatches found** across all ~350 tool definitions in `integrations.ts` — every provider-calling action's `credential_ref` matches its actual provider (Stripe/Vipps/Neonomics/Wallester/Fiken/Google Ads split from local-only `finance_*` siblings correctly), verified by manual cross-check.
- **`mesh-bridge.ts`**: the model can call at most 6 fixed, trusted-layer-defined tools (all A-class reads except a knowingly-safe internal search); untrusted tool output is truncated and returned as plain data, never re-injected as instructions.
- **`docker-target-policy.ts`**: production mutation target allowlist is fail-closed in every direction (unconfigured → empty set; unknown name → denied; `redeploy_container` structurally deferred for all non-sentinel targets regardless of configuration).

---

## 5-line health summary

This slice's core security machinery (PolicyGateway class D signing/replay, sovereign-authority scoping, kill-switch/freeze/revoke durability, credential redaction) is sound and unusually well-tested, including deliberately adversarial and negative-path tests. The most serious finding (P0) is a real idempotency hole: a DB error during the *success*-path audit write can silently undo the `tool_executions` dedupe row for a mutation that already executed, enabling a double-execution on retry — the exact failure class the dedupe system exists to prevent, and it has no test coverage. Two P1 findings — nonce burned before rate-limit/frozen/revoked checks, and `set_connector_credential` classified C instead of D — are narrower but genuine gaps in the class-D guarantee. The recurring "registered tool never actually wired to a real transport" pattern (5 prior incidents) remains structurally undetectable from this slice alone. No secrets were ever found leaking into audit/logs, and no credential_ref/capability_class mismatches were found across the ~350-entry tool registry.
