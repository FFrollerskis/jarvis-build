# Audit: `modules/model-gateway/`, `packages/provider-adapters/`, `packages/contracts/`

Files read: **62 / 62** (model-gateway 32 = 13 src + 14 test + 4 scripts + package.json/tsconfig; provider-adapters 15 = 10 src + 3 test + package.json/tsconfig; contracts 15 = 12 src + 1 test + package.json/tsconfig). `tsc --noEmit -p` is clean for all three packages. Direct-SDK grep (`openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `@google/genai`, `ollama`) over the whole repo: **zero hits** in code and in any `package.json` — every adapter uses `fetch` (rule 3 holds).

Severity legend: P0 = security/data-leak or budget-blocking now; P1 = real bug with production impact; P2 = correctness/audit gap; P3 = minor.

---

## A. Bugs / holes

### `modules/model-gateway/src/model-gateway.ts`
- **A1 · P1 · :674-702** `runCritic()` plans with `{ mode: "QUALITY", purpose: "CRITIQUE" }` only — it drops `input.sensitivity`, `input.paid_models_allowed` and `mode: "LOCAL"`; the critic request (:684-693) then ships the last user message (4 000 chars) and the primary answer (6 000 chars) to whichever cloud provider scores best. A `SECRET_RESTRICTED` or `paid_models_allowed=false` primary call with `critic: true` / `mode: "CRITIC"` therefore leaks to a paid cloud model. (Only `hosted_free_tier` is excluded, because sensitivity is undefined.) No production caller in `apps/` currently sets `critic`/CRITIC (grep), so latent. Fix: forward `sensitivity`, `paid_models_allowed` and (if `LOCAL`) `mode` into the critic plan.
- **A2 · P1 · :86-118, :249-296** `CompleteInput` carries no `memory_space_id`/identity, so the gateway cannot enforce PROCESSOR_REGION_MATRIX rule 2 (`health` never to an external processor) — enforcement depends entirely on callers setting `sensitivity`. The only production chat caller (`apps/api/src/conversation.ts:253`) hard-codes `sensitivity: "PUBLIC_OR_LOW_SENSITIVITY"` with no memory-space branch, so a `health`-space session (whose memory context is injected into `system` at :230-233) is eligible for the shared free tier `gemma_hosted`. `speechSensitivityForMemorySpace()` (`packages/contracts/src/speech.ts:216`) already maps `health → SECRET_RESTRICTED` but is unused on the LLM side. Fix: add optional `memory_space_id` to `CompleteInput`, derive a floor sensitivity via the existing contracts helper, and take `max(caller, floor)`.
- **A3 · P2 · :539-547** `stream()` on `hard_blocked`/`needs_approval` throws without the `kind: "budget"` trace span that `complete()` records (:264-275); budget refusals on the streaming path are invisible in traces. Fix: extract the trace+throw into a helper used by both.
- **A4 · P2 · :888-915 vs :832-874** `recordFailedAttempt` swallows DB errors silently (`catch {}`) while `recordCost` (success path) does not — a transient DB outage after a *billed* provider call makes the whole call fail with the cost row lost, whereas failed attempts vanish silently with no log line. Fix: log (JSON, no payload) in the catch; consider best-effort for both with a single warning.
- **A5 · P2 · :645-653, :634** `allowRepair()`'s return value is ignored, so the documented "model may repair ONE time (§25)" rule is not enforced — invalid arguments can be resent every round until `maxRounds`. Fix: if `!allowRepair()` return an error result that also sets `forceFinal`.
- **A6 · P3 · :917-926** Rate limiter is per-process, in-memory, and `callTimestamps` never evicts tenants; also throws a bare `Error("rate_limited…")` with no trace/cost row, unlike budget. Fix: dedicated `RateLimitedError` + trace span; prune empty buckets.
- **A7 · P3 · :325-329** A candidate whose `available()` flips to false between plan and execute is skipped silently and never added to `failedProviders` → `fallback_from` under-reports. Fix: push to `failedProviders` with a `not_configured` reason.
- **A8 · P3 · :26-34** Doc claim "adapternes egen historiske `JARVIS_MODEL_TIMEOUT_MS ?? 60000`-konvensjon" is false for `ollama.ts:18` and `local-llm.ts:71` (default 120 000). Fix: correct the comment or unify defaults.

### `modules/model-gateway/src/router.ts`
- **A9 · P2 · :300-349** AUTO tie-break (D-106 Defekt C, `AUTO_LOCAL_TIE_BREAK_BONUS`) covers only the `default:` branch. In `QUALITY`/`CRITIC` mode `openai` and `anthropic` both score 5·30+2 = 152 and the winner is decided by `Map` insertion order (stable sort) — i.e. by adapter registration order in `main.ts`, exactly the non-policy determinism the D-106 fix was written to remove. This decides the Council synthesis provider (`council.ts:572`) and every `QUALITY` collaboration synthesis. Fix: add a documented deterministic secondary key (e.g. `cost_class`, then provider name) for all modes.
- **A10 · P3 · :382-385** For undefined sensitivity the reason `PRIVACY_RESTRICTED` is emitted whenever `gemma_hosted` is merely configured, shadowing the more informative `REASONING_REQUIRED`/`LOCAL_PREFERRED_ON_TIE`/`LOW_COST` reasons (checked later). Documented as intended, but it makes `routing_reason` analytics in `cost_events` useless for the default path. Fix: only report `PRIVACY_RESTRICTED` when a sensitivity was *explicitly* set, otherwise record the exclusion in metadata.
- **A11 · P3 · :192-222** `SPECIFIC_PROVIDER` ignores health state entirely (including `UNAVAILABLE`) — intended, but not documented in the RouteInput doc comment. Fix: one line in the comment.

### `modules/model-gateway/src/pricing.ts`
- **A12 · P1 · :41-86, :89-91** `DEFAULT_PRICING.rates` has no `gemma_local` entry, so `rateFor("gemma_local", …)` falls through to `default_rate` (30 / 150 øre per 1k) — the *most expensive* rate in the table — for a local, zero-API-cost model. Every `gemma_local` call inflates `cost_events.amount_ore` (a 2k-in/1k-out call ≈ 2,10 kr) and eats the monthly budget that hard-blocks **all** providers at 3 000 kr (`budget-guard.ts:17-22`). Fix: add `gemma_local: { input_per_1k_ore: 0, output_per_1k_ore: 0, pricing_mode: "LOCAL" }` and a test asserting every `DEFAULT_PROFILES` provider has a rate.
- **A13 · P3 · :65** `kimi` rate has no `pricing_mode`/`pricing_verified_at` though the model was changed to `kimi-k3` (D-106); price not re-verified. Fix: verify and date, as done for gemini.

### `modules/model-gateway/src/capability-registry.ts`
- **A14 · P1 · :181-189** `kimi` profile claims `tool_calling`, but `kimi.ts:59-64` never sends `tools`/`tool_exchanges` and never parses `tool_calls`. The router therefore ranks `kimi` (score 122, tied with `anthropic` for CHAT) as a legitimate fallback for `completeWithTools`; if it is reached, tools are silently dropped, the model answers in prose, `classifyCompletionOutcome` says `USABLE_SUCCESS`, and the tool loop ends without tools — a silent capability downgrade, violating the file's own D-43 §3 rule (header :5-14). Fix: remove `tool_calling` from the kimi profile (or wire tools in `kimi.ts`, OpenAI-compatible schema).

### `modules/model-gateway/src/trace.ts`
- **A15 · P2 · :105-113** `LangfuseTraceSink.record` has no timeout/AbortSignal, and `recordAttemptResult` **awaits** it on the hot path (`model-gateway.ts:782`). A hanging Langfuse endpoint (Cloud or `http://langfuse:3000`) stalls every model call indefinitely; the "feil skal aldri stoppe samtalen" claim (:63) only covers thrown errors. Fix: `signal: AbortSignal.timeout(2_000)` and/or fire-and-forget with a bounded queue.
- **A16 · P3 · :36-44** `traceSinkFromEnv` activates Langfuse on truthy strings only; a `LANGFUSE_BASE_URL` with trailing `/` yields `//api/public/ingestion` (unverified whether Langfuse tolerates it). Fix: `new URL(...)` validation + `replace(/\/+$/, "")`.

### `modules/model-gateway/src/council.ts`
- **A17 · P2 · :668-688** `persistEvent` catches *everything* silently, including `EventEnvelopeSchema` zod failures (`payload: z.record(JsonValueSchema)` rejects any `undefined` value nested in the cast `payload`). The "audit first / No silent five-model spend" guarantee (:61-69) thus depends on a schema check that can fail without any log line. Fix: log a JSON error line in the catch; validate the payload with `JsonValueSchema` before append.
- **A18 · P3 · :629-636** `DEGRADED_NO_CONSENSUS` is unreachable in the default five-family path when the Gemma family is unresolved: `members` already excludes Gemma (4), so `round3.length &lt; members.length` is false → `CONSENSUS` reported while `full_council=false` (test P asserts `full_council` only). Fix: compare against `CANONICAL_COUNCIL_FAMILIES.length` or `unavailable.length &gt; 0`.
- **A19 · P3 · :198-201** `JARVIS_COUNCIL_MODEL_TIMEOUT_MS=""` → `Number("")` = 0 → `InvalidTimeoutError` at first Council run (documented as intended "fail loudly", but only discovered at runtime). Fix: validate at module load with a clear startup error.

### `modules/model-gateway/src/collaboration.ts`
- **A20 · P2 · :152-160** Model-generated `purpose` is cast `as ModelPurpose` without validation and then (a) steers routing via `CompleteInput.purpose`, (b) is persisted verbatim into `cost_events.purpose` (`model-gateway.ts:863`). Untrusted model output becomes routing input and a DB column (rule 7). Fix: `ModelPurposeSchema.safeParse(s.purpose)` and drop on failure.
- **A21 · P3 · :324-326** `assignRoles` uses `registry.get()` (not `profileOrGeneric`), so any adapter not in `DEFAULT_PROFILES` is silently unassignable. Fix: use `profileOrGeneric(name, model)` for parity with the router.

### `modules/model-gateway/src/decision-importance.ts`
- **A22 · P2 · :63-66** `NUMBER_PATTERN` accepts `.`/`,` thousand separators only; the Norwegian standard "100 000 kr" (space separator, also NBSP) never matches, so `financial_magnitude` has false negatives for the project's primary language. Fix: add `(?:[  ]\d{3})+` to the pattern (and normalise NBSP).

### `packages/provider-adapters/src/types.ts`
- **A23 · P3 · :231-236** `classifyHttpStatus` maps 408 (request timeout) and 409/425 to `bad_request` (non-retryable, blocks same-provider retry). Fix: `408 → timeout`, `409/425 → server`.
- **A24 · P3 · :239-246** `classifyFetchError` embeds the raw `err.message` in the `network` ProviderError; `provider-health.ts:57` stores 200 chars of it. Node's undici messages don't contain credentials today (unverified for all causes), but the field is not vetted like `diagnostic`. Fix: store only `err.name`/`cause.code`.

### `packages/provider-adapters/src/openai.ts`
- **A25 · P3 · :165-248** Streaming path never reads `usage.prompt_tokens_details.cached_tokens`, so cached prompts are billed at full input rate in stream mode while `complete()` (:139) discounts them. Fix: parse `chunk.usage.prompt_tokens_details?.cached_tokens`.
- **A26 · P3 (unverified) · :55** `temperature` is forwarded unconditionally; OpenAI reasoning models (`gpt-5`, default here) reject non-default `temperature` with 400 → `bad_request` → no retry, fallback to next provider. Fix: omit `temperature` for reasoning models or document the constraint.

### `packages/provider-adapters/src/anthropic.ts`
- **A27 · P3 · :163-164, :185-186** Stream path ignores `cache_read_input_tokens` from `message_start.usage` → same cached-token over-billing as A25. Fix: read `event.message.usage.cache_read_input_tokens`.

### `packages/provider-adapters/src/gemma.ts`
- **A28 · P3 (unverified) · :147-156** Function responses are sent with `role: "function"`; current Gemini API docs use `role: "user"` for `functionResponse` parts (older v1beta accepted `"function"`). No test covers a live tool round-trip. Fix: verify against official docs (D-41) and add a fixture.
- **A29 · P3 · :246-263** `candidates` absent (e.g. `promptFeedback.blockReason` safety block) → `invalid_response` → one same-provider retry of an identical, deterministic-blocked request. Fix: map `promptFeedback.blockReason` to a non-retryable `bad_request` with `provider_error_code`.

### `packages/provider-adapters/src/gemini.ts`
- **A30 · P3 · :46-129** Same `promptFeedback` retry waste as A29; and no `signal` support at all (cancellation cannot abort an in-flight Gemini call). Fix: as A29; thread `signal` through like `gemma.ts`.

### `packages/contracts/src/canonical.ts`
- **A31 · P3 · :8-18** `canonicalStringify` on an object containing `undefined` (possible at runtime despite the type) emits `"k":undefined` — not JSON, but stable; only matters if a non-validated object is signed. Fix: skip `undefined` values (JSON.stringify semantics).

---

## B. Placeholders / stubs / dead code

- **B1 · P3 · `packages/provider-adapters/src/types.ts:213-216`** `ProviderError.fallbackSafe` is never referenced anywhere in the repo (grep) — the gateway decides fallback solely by moving to the next candidate. Dead API that suggests a policy that does not exist. Fix: delete or actually use it (e.g. stop the chain on `not_configured`).
- **B2 · P3 · `packages/contracts/src/mobility.ts:99-141`** `FakeMobilityAdapter` (a test double) ships in production `src` of `@jarvis/contracts`; nothing imports `MobilityAdapter`/`FakeMobilityAdapter` outside this file (grep). Stated as intentional, but it is unreferenced code in the contracts package with zero tests. Fix: move fake to `test/` or `testing/` subpath.
- **B3 · P3 · `modules/model-gateway/src/model-gateway.ts:183-190`** `MeshStatus.router` is the literal `"HEALTHY"` — never computed. Fix: derive from `NoEligibleProviderError` rate or drop the field.
- **B4 · P3 · `packages/provider-adapters/src/scripted.ts:82-91`** `FailingAdapter` is exported from the production index but only tests use it (and most tests define their own). Fix: move to a `testing` export.
- **B5 · P3 · `modules/model-gateway/src/provider-health.ts:102`** `snapshot().last_error` is computed but `meshStatus()` (:723-732) drops it, so it is dead in production; if it were exposed, see A24. Fix: remove or vet.
- **B6 · P3 · `packages/provider-adapters/package.json:6`** description still lists only "Anthropic, OpenAI, Ollama og skriptet" (now 8 adapters). Fix: update.

---

## C. Gaps (untested logic, vacuous tests, undocumented env, missing providers)

- **C1 · P2 · `packages/provider-adapters/tsconfig.json:7`** `include: ["src"]` — the three test files are **not typechecked** by `pnpm typecheck`/CI. Running them under the base `tsconfig` flags yields 8 errors (`conformance.test.ts:235,250,410,448,649,662`, `sse-fixtures.test.ts:319` — `mock.calls[0]` typed `[] | undefined`). Tests pass at runtime only. Fix: `include: ["src", "test"]` and fix the casts (`vi.fn&lt;(u: string, i: RequestInit) =&gt; Promise&lt;Response&gt;&gt;`).
- **C2 · P3 · `modules/model-gateway/tsconfig.json:7`** `scripts/` (4 live scripts) excluded from typecheck. Fix: add `"scripts"`.
- **C3 · P2 · `modules/model-gateway/test/collaboration.test.ts:200-215`** Test "L: samme tenant_id/session_id/task_id videreføres til HVERT underliggende ModelGateway-kall" is vacuous: `seenTenants` is never populated (`void seenTenants`); it only asserts the adapter was called. Fix: capture `cost_events` inserts via a fakePool and assert `tenant/session/task` columns per row.
- **C4 · P2 · tests (all)** No test covers: (a) `runCritic` with `sensitivity`/`paid_models_allowed` (would have caught A1); (b) pricing coverage for every `DEFAULT_PROFILES` provider (A12); (c) registry↔adapter capability consistency (A14) — e.g. asserting `profile.capabilities.includes("streaming") === typeof adapter.stream === "function"` and `tool_calling` ⇔ adapter sends `tools`.
- **C5 · P2 · `modules/model-gateway/test/ua1-mesh.test.ts`, `d106-*.test.ts`** No test exercises `LangfuseTraceSink`/`JsonlTraceSink` (payload shape, no-secret invariant, timeout). Fix: mocked-fetch test asserting only whitelisted fields and a timeout.
- **C6 · P3 · `modules/model-gateway/test/gemma-first-routing.test.ts:18-26`, `d106-router-extensions.test.ts:17-26`, `ua1-mesh.test.ts:42-48`** `MODELS` still say `gemini-2.5-flash`/`kimi-latest` — stale but harmless (routing is name-based). Fix: align with registry.
- **C7 · P3 · `modules/model-gateway/test/d106-council-timeout.test.ts:592-605`** Test Ø asserts only `distinct.size === 1` (already covered by Z) — near-vacuous; the env-override path it names is never exercised because the constant is read at module load. Fix: test via `vi.resetModules()` + env stub.
- **C8 · P2 · `.env.example`** Undocumented env vars read by this slice: `JARVIS_MODEL_TIMEOUT_MS` (all adapters), `JARVIS_COUNCIL_MODEL_TIMEOUT_MS` (`council.ts:198`), `JARVIS_STREAM_DEBUG` (`model-gateway.ts:349`), `JARVIS_KIMI_URL`, `JARVIS_KIMI_MODEL`, `MOONSHOT_API_KEY` (`kimi.ts:33-35`), `JARVIS_OPENAI_MODEL`, `JARVIS_ANTHROPIC_MODEL`, `JARVIS_OLLAMA_MODEL`, `JARVIS_TRACE_FILE` (main.ts). Fix: add commented lines.
- **C9 · P3 · `packages/contracts/test/contracts.test.ts`** Covers 5 of 12 contract modules; `model.ts`, `session-grant.ts`, `voice-authority.ts`, `mobility.ts`, `speech.ts` have no tests in this package (speech/voice-authority are tested in `apps/voice-gateway/test`; `mobility.ts` has none anywhere). Fix: at least `voiceAuthorityFromGrant` expiry edge (`&lt;=`) and `SessionGrantSchema.strict` here.
- **C10 · P3 · `packages/provider-adapters/test/conformance.test.ts`** No conformance case for `LocalOpenAiCompatibleAdapter` registered as `gemma_local` (constructor `name` param) and no streaming-cancel test for `ScriptedAdapter`. Fix: add to `CASES`.
- **C11 · P2 · docs vs code** `docs/CANONICAL_SPEC.md:119`, `docs/INTEGRATIONS.md:241`, `docs/IMPLEMENTATION_PLAN.md:4575` list **OpenRouter** as a Model Gateway provider; no adapter exists. Conversely Gemini, Gemma (hosted/local), Kimi, `local_llm` exist but are absent from CANONICAL_SPEC §7. Fix: reconcile the provider list in CANONICAL_SPEC (authoritative doc) with `DEFAULT_PROFILES`.

---

## D. Improvements

- **D1 · P2 · `model-gateway.ts:255-304`** Router refusals (`NoEligibleProviderError`, `PaidModelsDisabledError`, `LocalModelUnavailableError`) throw before any trace/cost row — fail-closed privacy decisions are unauditable. Emit a `kind: "model_call"`-style refusal span with `routing_reason`.
- **D2 · P2 · `model-gateway.ts:888-911`** Failed-attempt rows omit `latency_ms`, `stream`, `ttft_ms`, `status`, and `diagnostic.provider_error_code`; D-204 had to add a `console.error` to see why `gemma_hosted` failed. Persist `status` + `provider_error_code` (already vetted safe) in `cost_events` or an `events` row.
- **D3 · P3 · `model-gateway.ts:262, :827-830`** `BudgetGuard.evaluate` = one `SUM(cost_events)` per call (plus one per adaptive retry); with Council (≤16 calls) that is 16 aggregate scans. Cache per tenant for a few seconds or maintain a running monthly total.
- **D4 · P3 · `budget-guard.ts:43-55`** Concurrent calls all pass the check before any row is written (Council parallelism) → bounded overshoot of the hard limit. Reserve budget optimistically (`SELECT … FOR UPDATE` on a per-tenant row) if strict enforcement is required.
- **D5 · P3 · `model-gateway.ts:338, :525`** `timeout` is in `retryableSameProvider`, so a 60 s timeout is retried once on the same provider (120 s) before fallback; under Council's 120 s override that is 240 s per member per round. Consider not retrying `timeout` same-provider when `request.timeoutMs` is already elevated.
- **D6 · P3 · `router.ts:264-278`** `mode: "LOCAL"` and `paid_models_allowed=false` implement the same filter twice with different errors; collapse into one `locality` gate with one error type carrying the reason.
- **D7 · P3 · `override-parser.ts:89-93`** `/\bbruke?\s+(bare\s+|kun\s+)?gpt\b/i` matches ordinary prose ("hvordan kan jeg bruke GPT i Excel") → `SPECIFIC_PROVIDER` override; with `openai` unconfigured the router throws `NoEligibleProviderError`, which `ConversationEngine.handle()` rethrows (`conversation.ts:315`, HTTP mapping unverified). Require an imperative position (sentence start / "Jarvis, bruk …") or an explicit prefix.
- **D8 · P3 · `council.ts:681`, `collaboration.ts:355`** Model-generated payloads are persisted with `trust_level: "internal"`; rule 7 would argue `untrusted` for LLM output that later feeds decisions. Use `untrusted` (or a new `model_generated` level).
- **D9 · P3 · `types.ts:268-287`** `sseLines` yields per `data:` line; SSE multi-line `data:` events would be split. Buffer until blank line per spec (no provider does this today).
- **D10 · P3 · `scripts/mesh-live.ts:15-19`** Constructs `LangfuseTraceSink` with `""` keys when env is unset → sends `Authorization: Basic Og==` to `http://langfuse:3000`. Use `traceSinkFromEnv()` like the other scripts.

---

## E. Doc / code drift

- **E1 · P1 · `docs/security/PROCESSOR_REGION_MATRIX.md:30`** LLM row is still `TBD / benchmark required` with "Velges i fase 3", while five cloud LLM processors (OpenAI, Anthropic, Google Gemini, Google Gemma free tier, Moonshot/Kimi) are live in `apps/api/src/main.ts:190-209` and Langfuse Cloud receives tenant/session/task ids + metadata (D-202). Rule 1 ("En rad med TBD kan ikke tas i produksjonsbruk. Punktum.") is violated by the matrix's own terms, and rule 2 is only enforced for speech. The code-side gate (`router.ts:156-161`) enforces `DataSensitivity`, but no matrix row maps provider → allowed memory spaces, so there is nothing for it to enforce *against*. Fix: fill LLM rows per provider (region, DPA, training, retention, allowed spaces) and add a Langfuse row; then derive `hosted_free_tier`/allowed-space data from that table.
- **E2 · P2 · `docs/OPEN_QUESTIONS.md:58` (Q-30)** Point (1) says `conversation.ts` sends no `sensitivity` (changed by D-203); point (3) says `ADAPTER_SUPPORT=false` for hosted Gemma streaming (closed by D-199-B/D-200). Fix: update Q-30 to reflect D-200/D-203/D-205.
- **E3 · P2 · `docs/DECISIONS_AND_ASSUMPTIONS.md:415-416` (D-204/D-205)** Gemma `bad_request` root cause **was** found and fixed (D-205: `stripAdditionalProperties`, `gemma.ts:108-121`, test `conformance.test.ts:340-376`); D-205 explicitly says "Host-redeploy + live-verifisering gjenstår". No later D-entry or PROJECT_STATUS line in my slice confirms live success → status is **fixed-in-code, live-unverified**. Fix: record the live outcome (or an explicit "still failing") under D-205.
- **E4 · P3 · `packages/contracts/src/speech.ts:37-43`** Header still states external speech processing is "AVVIST i dag … OpenAI-radene står IKKE VERIFISERT"; D-226 (2026-09-22) flipped OpenAI STT/TTS to `VERIFIED` (matrix :19-26, `voice-authority.ts:40-44` already updated). Fix: update the speech.ts header.
- **E5 · P3 · `modules/model-gateway/src/capability-registry.ts:5-14`, `packages/provider-adapters/src/anthropic.ts:16-17`, `test/multimodal.test.ts:49`** Comments say Anthropic is the "eneste adapter med EKTE bildestøtte" — `gemma_hosted` also has it (D-81). Fix: comment cleanup.
- **E6 · P3 · `packages/provider-adapters/src/local-llm.ts:33-35`** "Streaming: IKKE implementert … samme bevisste avgrensning som `GemmaHostedAdapter`" — Gemma now streams (D-199-B). Fix: comment.
- **E7 · P3 · `packages/contracts/src/identity.ts:57-60`** `desktop` channel value explicitly has no D-number ("Bør formaliseres … av en økt som har den tilgangen"). Fix: log a D-xx.
- **E8 · P3 · `docs/CANONICAL_SPEC.md:119` vs code** see C11 (OpenRouter listed, not built; Gemini/Gemma/Kimi/local built, not listed).

---

## Answers to the four scrutiny points

1. **router.ts AUTO scoring** — deterministic given identical inputs, but tie-breaking outside the AUTO/LOCAL branch depends on adapter registration order (A9). Sensitivity gate: `SECRET_RESTRICTED` → local only, `hosted_free_tier` requires explicit `PUBLIC_OR_LOW_SENSITIVITY`, owner override cannot bypass — correct and well tested. The fallback chain iterates only candidates that passed the same gate, so a failure cannot downgrade privacy class; every fallback is recorded (`cost_events.fallback`, trace `fallback_from`, stream `fallback` event). The two ways sensitive data can still reach a cloud provider are the critic path (A1) and callers never deriving sensitivity from memory space (A2/E1).
2. **cost_events** — success, adaptive retry and failed attempts each get a row with `tenant_id`/`task_id`/`session_id` (verified `model-gateway.ts:849-871, :897-909`; RLS applies via `withTenantTransaction`). Gaps: router refusals and rate-limit refusals produce no row (D1, A6); failed-attempt rows lack status/diagnostic/latency (D2); failed-row DB errors are swallowed silently (A4); `gemma_local` is mis-priced (A12).
3. **Adapters** — all use `fetch`; keys are read once in constructors from env, sent only in headers (`Authorization`/`x-api-key`/`x-goog-api-key`), never in URLs; `sanitizeEndpointForDiagnostics` keeps only `host+pathname` (drops query/fragment/credentials) and `extractProviderErrorCode` never copies free-text `message` — verified by reading and by the secret-never-leaks tests. `classifyHttpStatus` is shared and consistent; gemini/kimi/gemma attach diagnostics, openai/anthropic/ollama/local-llm do not (inconsistent, P3 improvement). Timeouts: `AbortSignal.timeout` everywhere; cancellation `signal` only in openai/anthropic/gemma. Streaming: openai/anthropic/gemma real SSE with cancel and error-event handling; token accounting misses cached tokens in stream mode (A25/A27). The kimi profile lies about tools (A14).
4. **Contracts** — all boundary schemas (`IdentityContext`, `ToolCall`, `SignedApproval`, `JobContract`, `EventEnvelope`, `SessionGrant`, `VoiceAuthorizationEvidence`, `VoiceSessionGrant`, `DeviceEnrollmentRequest`, `SpeechProcessorDeclaration`) are `.strict()`. `delegation_id` is `.optional()` and `modules/policy/src/authority.ts:49` checks `=== undefined` for owner authority — consistent (absent = owner, present = delegate never inherits). `JsonValueSchema` is a proper recursive `z.lazy`.

---

## Health summary

1. Architecture invariants hold: no direct provider SDK anywhere, keys never in URLs/logs/diagnostics, sensitivity gate fail-closed and owner-override-proof, fallbacks always recorded, tenant-scoped cost/trace rows.
2. Three real production bugs: `gemma_local` billed at the most expensive default rate (drains the hard budget), `kimi` falsely advertises `tool_calling` (silent tool loss on fallback), and the critic path bypasses sensitivity/paid-model policy (latent, opt-in).
3. The region matrix is not actually enforceable for LLMs: the LLM row is `TBD` while five cloud providers plus Langfuse Cloud are live, and the only production chat caller hard-codes `PUBLIC_OR_LOW_SENSITIVITY` regardless of memory space (`health` included).
4. Test coverage is broad and mostly genuine, but the adapter tests are excluded from typecheck (8 latent type errors), one collaboration test is vacuous, and there is no registry↔adapter consistency test or pricing-coverage test — exactly the tests that would have caught the bugs above.
5. The Gemma `bad_request` saga (D-204/D-205) is fixed in code with a regression test but has no recorded live confirmation; several docs (Q-30, speech.ts header, provider lists in CANONICAL_SPEC/INTEGRATIONS) lag the code by one to three decisions.
