# Jarvis builder brief - COMMON RULES (read fully before touching code)

You are a builder for Jarvis, Tobias' personal long-term AI operating system (repo `tsworkflow/jarvisbuild`, TypeScript/Node 22/pnpm monorepo).
The owner lifted the build pause (decision D-470, 2026-11-14, "bygg videre"). You build ONE work package (WP) described in your task prompt.
The lead (main Claude session) integrates, opens the PR, runs CI and the independent review. You do NOT open PRs and do NOT merge.

## 0. Setup (do this first)
- Your cwd is an isolated git worktree of /home/user/jarvisbuild. The checked-out branch is STALE - ignore it.
- `git fetch origin main && git checkout -b <your-branch> origin/main` (branch name is in your task prompt). Never work on another branch.
- `pnpm install --frozen-lockfile` (store is cached, takes seconds).
- Read in this order: `CLAUDE.md` (12 non-negotiable rules - especially 1,2,3,4,7,8,10,11,12), the docs named in your task prompt, the
  closure-matrix row for your WP in `docs/CLOSURE_MATRIX_HF1_HF2.md`, and the TEMPLATE WP named in your task (copy its structure and idioms:
  look at `git log` / the files the template PR touched).
- Mandate context: `docs/DECISIONS_AND_ASSUMPTIONS.md` D-450, D-468, D-470; `docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` (sections named in your prompt).
- THE CONTAINER CAN RESTART AND WIPES EVERYTHING NOT PUSHED. Push your branch after EVERY milestone (at least every ~45 minutes of work). Unpushed work is lost.
- Machine: 4 CPUs / 15 GB RAM shared with another agent. Never run two full test suites at once; run the full suite with `pnpm exec vitest run --maxWorkers=2`.

## 1. Non-negotiable engineering rules
1. **DORMANT/OFF by default.** Every new capability sits behind an env flag/config that defaults to off; with the flag off, existing behaviour and
   existing tests are unchanged (this includes tool lists/intents/routing/rate limits: a review found that registering tools unconditionally changed behaviour with flags off - register per flag).
   New flags must reach the container: add them to `SERVICE_ENV.api` in `infra/local/service-env.mjs` and regenerate compose (`node ops/security/generate-compose-env.mjs --write`), with a guard test.
2. **No secrets** in code, tests, fixtures, logs, docs, commits. Use the existing credential/secret providers (`CredentialResolver`/Infisical/vault refs). Test fixtures must
   not look like real keys (gitleaks scans full history; use obviously fake values such as `fake-token-for-test`, never provider-shaped key formats or variable names like SECRET_*).
3. **All vendors behind adapters** (ModelGateway, SpeechAdapter, WorkflowAdapter, StorageAdapter, HomeAdapter, ToolTransport...). No vendor SDK imported
   in core modules. Tests use fake transports/servers; NO real network calls in tests; inject clocks.
4. **Class D (critical) actions are enforced in deterministic code** with signed approval objects / existing step-up and confirmation machinery - never by prompt rules.
   Reuse the existing patterns (`modules/tool-gateway/src/tool-manifest.ts` invariants, `class-d-pipeline.ts`, taint + bound confirmations, `authorizeInfraStatus`-style owner+device-signed checks).
   Fast path may skip the LLM, never the Policy Gateway. Enforce data-sensitivity locks at EXECUTION time, not only in tool selection (a review found a selection-only lock leaked finance state to cloud models).
5. **Untrusted content** (email, web, tool output, MCP, transcripts, camera/IoT payloads) is data in the ingestion zone - never instructions, never straight into authoritative memory.
6. **Everything written is tagged** person/tenant/memory space/source and `task_id`/`session_id` (rule 4). New tables: tenant_id + RLS + composite FKs like the existing migrations
   (read `modules/core/src/db/migrations/` 078-108 and the schema-invariant tests). Migrations are append-only: use ONLY the number range given in your task prompt.
7. **Connectors (D-41 + D-64)**: before building any connector write a short capability audit (read/write/delete/access-control, scopes needed for FULL useful access verified against
   OFFICIAL vendor docs via WebSearch/WebFetch - never guessed, risk class A-D per action, owner vs delegated behaviour, idempotency, safe test sandbox). Not-implemented = mark
   `DEFERRED`/`PARTIAL` explicitly in code comments, runbook and report; never silently omitted. Read-only only when the vendor offers nothing more / scope missing / law requires.
   Core-vs-Adapter gate (D-64): Jarvis owns the canonical domain model; external services are sources/sinks/adapters. If a vendor would become a CORE DEPENDENCY: STOP that part and put
   `CORE_DEPENDENCY_DECISION_REQUIRED=true` + the reason at the top of your report. Never pick a vendor silently.
8. `HARD_EXTERNAL_BLOCKER` (missing credential that cannot be obtained safely, payment, physical host action, legal acceptance) stops only the affected sub-part: build everything else, mark it `BLOCKED_EXTERNAL`.
9. Self-modification stays frozen (D-397). Nothing you build may change Jarvis' own production code/config/prompts at runtime.
10. Do NOT build: JARVIS-084 consent-control changes (Q-47f), Telegram legal items of JARVIS-087, local PC agent with filesystem access (Q-60), anything outside your WP scope. When in doubt: smaller scope, explicit `DEFERRED`.
11. Honest status words only: WIRED / DORMANT / BUILT_UNWIRED / PARTIAL / DEFERRED / BLOCKED_EXTERNAL / NOT_BUILT. Never write "done/works/production ready" without test evidence. Nothing is `VERIFIED` (that needs a NAS run).

## 2. Quality gate (all must pass before you report)
- Tests are written WITH the code, in the same commits. Cover: happy path, flag-off no-op (identical to origin/main), authority/tenant isolation, error/timeout paths, idempotency, redaction, prompt-injection/untrusted-input handling where relevant.
- Run and report results of: `pnpm typecheck`, `pnpm lint`, `pnpm check:containment`, targeted `pnpm exec vitest run <paths>` for everything you touched AND the full suite
  (CI `build-test` runs everything; do not leave surprises). Embedded Postgres refuses to start as root: run DB tests as OS user `postgres` (e.g. `su postgres -s /bin/bash -c 'cd <worktree> && pnpm exec vitest run ...'`; make the worktree readable for that user).
  Known sandbox-only failures to prove/ignore (they also fail on clean origin/main): d124-migration-encoding 081/089, embedded-postgres-ipv4-contention B.3 (hangs; exclude it), ops/backup redact-proc, knowledge/wpd1-claim-service (needs UTF-8 DB), git 'dubious ownership' failures when not root.
- Schema/manifest/baseline guards (tool counts, scope-fk baseline, processing inventory D-420, connector registry, env-drift) must stay green - update the guarded baseline files only when the guard's own docs say how, and mention it in the report. Never weaken a guard; if a guard must be widened, say so explicitly under "security surfaces".
- Secrets scan of YOUR commits before every push (must print `no leaks found`; if the clone is shallow run `git fetch --unshallow` first):
  `set -o pipefail; /tmp/gitleaks-bin/gitleaks detect --source . --no-banner --log-opts="origin/main..HEAD" 2>&1 | tail -3` (binary missing? download release v8.24.3 from github.com/gitleaks/gitleaks into /tmp/gitleaks-bin).
- Commits: small, `feat:`/`fix:`/`test:`/`docs:` prefix, end each message with these two trailer lines:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01DjaWBW7BCa7u4mUsiHFwH4`
- Push your branch with `git push -u origin <your-branch>` at each milestone. Never force-push, never `git reset --hard` on pushed history, never rewrite published history, never push to `main`, never delete branches.
- In source/prose avoid literal `\uXXXX` escape sequences; write non-ASCII (æøå) directly in UTF-8.

## 3. Docs you write (Norwegian; code identifiers English)
- ONE runbook `docs/runbooks/WP<ID>_<NAME>.md`: what is built, the flags (name, default, effect), data/tables, authority model, how the owner verifies it on the NAS step by step (clearly `NOT VERIFIED`), known gaps (`DEFERRED`/`PARTIAL`), rollback/off-switch.
- If the WP handles personal data, add/update the DPIA file named in your prompt (`docs/UA*_DPIA.md`) and the processing inventory (`docs/security/PROCESSING_INVENTORY.md` - there is a CI guard, D-420).
- Do NOT edit these shared files (lead consolidates them to avoid merge conflicts): `docs/DECISIONS_AND_ASSUMPTIONS.md`, `docs/OPEN_QUESTIONS.md`, `docs/PROJECT_STATUS.md`, `docs/CLOSURE_MATRIX_HF1_HF2.md`.
  (Exception: WP-K may edit the rows of `docs/remediation/FINDINGS_LEDGER.md` for the finding IDs it works on, and nothing else in that file.)

## 4. Final report (your last message; max ~70 lines, Norwegian or English, plain facts)
1. `CORE_DEPENDENCY_DECISION_REQUIRED` / `HARD_EXTERNAL_BLOCKER` lines first, if any.
2. Branch name, head SHA (`git rev-parse HEAD`), pushed? (yes/no), commit list (`git log --oneline origin/main..HEAD`), files changed/insertions.
3. What is built (per capability: status word), flags + defaults, migrations used, new tools/routes/pages.
4. Test evidence: each command + result counts; anything not run and why.
5. Security-relevant surfaces that need an INDEPENDENT review (file:line), including any place you were unsure.
6. Text for the decision log (D-id from your prompt): decision, rationale, consequences - 5-10 lines.
7. Closure-matrix rows to add/update (status words) and `Gjenstår`/verification steps for the NAS.
8. Open questions for the owner (only genuine owner decisions), and deviations from this brief.
9. For connectors: the D-41 capability audit table.

Be economical: do not spawn your own agents, do not re-read huge files repeatedly, do not paste large outputs back.

## 5. Kjente guards som kan bli røde av legitime tillegg (lagt til 2026-11-15)
- `apps/api/test/wph1-flag-off-selection-baseline.test.ts` og `wph2-flag-off-main-parity.test.ts` sammenligner flagg-AV-utvalg/mutate-svar mot et snapshot av main@ec3e684e. Legger din WP legitimt til verktøy, intents eller mutate-navn, blir de røde. Regenerer fixturene fra din egen branch-tupp (kontrollsenter-flaggene AV) etter overskriften i testen, rapporter det under «security surfaces», og løs ALDRI opp assertions.
- Restricted-verktøy (SECRET_RESTRICTED): utvalgslås alene er IKKE nok - håndhev ved utførelse (se `wph1-restricted-tools-invariant.test.ts`). Kjent åpent hull N1: tidligere lokale svar i samtalehistorikken er ikke merket begrenset og kan nå en senere skytur; ikke bygg noe nytt som er avhengig av at historikken er ren.
- CONNECTOR-MANIFEST-VAKTEN (WP-I, i CI): legger du til en ny connector i CONNECTOR_REGISTRY, feller `built_connector_unreviewed`/`skeleton_baseline_stale` testene til connectoren har et FULLT manifest (modules/connector-sdk/src/manifests/, med d41_audit, core_boundary.system_of_record og decision_refs for `audited`). Bruk `node ops/connector/new-connector.mjs --help` (generator) og `pnpm exec tsx modules/connector-sdk/scripts/report.ts` (rapport; se runbook docs/runbooks/WPI_CONNECTOR_SDK.md §10). Løs ALDRI opp vakten ved å legge id-en i SKELETON_BASELINE uten å si det under «security surfaces».
