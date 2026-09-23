# Audit Report — modules/tasks, modules/incidents, modules/watchdog, modules/self-modification

Files read in full: **79** (module source, tests, package.json, tsconfig.json across the four assigned modules) — tasks 28, incidents 26, watchdog 13, self-modification 12 — matching every file the task listed, no sampling. Additional cross-reference reads outside the slice (for wiring verification only, not counted above): `apps/api/src/main.ts` (targeted sections), `apps/api/src/worker-main.ts` (targeted sections), `apps/api/src/server.ts` (targeted sections), `apps/api/src/personality-config.ts`, `modules/core/src/db/migrator.ts`, migrations 006/007/009/023/035/060/061, `modules/tool-gateway/src/docker-target-policy.ts`.

Adversarial `classifySelfModification` cases explicitly tried and verified against code (not just tests): empty diff, `.env` variants, `../` traversal, absolute path, backslash/double-slash, mixed allowlisted+other file, mixed allowlisted+forbidden file, case-sensitivity, trailing slash. All fail closed (never spuriously `zero_review`) — see finding E1 for the one place the code comment overstates what actually happens.

## A — Bugs / holes

**A1 [P1] modules/tasks/src/worker.ts:41-84 + modules/tasks/src/pg-task-queue.ts:28-36 — no lease renewal; long jobs can be double-executed.**
`saveCheckpoint()` (pg-task-queue.ts) never touches `lease_expires_at`, and nothing else extends it while a handler runs. `InProcessWorker`/`TaskService` construct with the default `leaseSeconds=60`, yet `ClaudeCodeAgent`'s own default timeout is `300_000`ms and coding jobs also clone+test+push — comfortably longer than 60s. `claim_next_task()` reclaims any `running` row whose lease expired, so a second worker can start executing the *same* coding job (same branch `jarvis/<task_id>`) while the first is still mid-flight, including a second live `git push`/PR-create attempt. `InProcessWorker.tick()` (line ~70-76) also discards the boolean returned by `queue.complete()`/`queue.fail()` without any logging, so the "losing" worker's outcome — and its already-happened git push — vanishes silently.
Fix: extend `lease_expires_at` from `saveCheckpoint()` (or add a periodic heartbeat call from `InProcessWorker`), and log when `complete()`/`fail()` returns `false`/`"stale"`.

**A2 [P2] modules/watchdog/src/watchdog.ts:152-204 — `tick()` has no per-check timeout; one hang wedges the watchdog forever.**
The `ticking` guard (added for D-180) prevents *overlap*, but a single `check.run()` that never resolves (e.g. a DB call stuck on pool exhaustion) leaves `ticking=true` permanently — every future tick is dropped with only the repeated `watchdog_tick_skipped_overlap` log line, no distinct "watchdog is wedged" alert. This includes `costExplosionCheck`, the only automated kill-switch trigger, so the safety net can go silently inert.
Fix: wrap each `check.run()` in a timeout (`Promise.race`) so one hung check can't disable the whole watchdog.

**A3 [P2] modules/self-modification/src/service.ts:547-558 — `resolveApproval()` has no owner check, unlike every other public method.**
`proposePersonalityChange`/`proposeCodeChange` both call `this.assertOwner(identity)`. `resolveApproval(requestId, decision, actorPersonId)` takes a bare `string` and never validates it against `this.deps.ownerPersonId`; it relies entirely on the caller (`apps/api/src/main.ts`'s Telegram handler, verified at lines ~906-923: `actorPersonId` is hardcoded from `JARVIS_OWNER_PERSON_ID`, never from message text) to only ever supply the owner. Correct today, but the class's own invariant ("owner-only") is enforced inconsistently — one method is a single missing check away from an owner-authority bypass if any future caller is added.
Fix: change the signature to take `IdentityContext` and call `assertOwner()`, matching the other two public methods.

**A4 [P2] modules/self-modification/src/service.ts:457-489 — CI status and merge head SHA are fetched via two separate, unlinked calls.**
`attemptMerge()` checks `getCombinedCiStatus(repoSlug, request.branch)` (by branch name) *before* fetching `getPullRequestHeadSha()`. If a new commit lands on the branch between those two calls, the CI status checked may not correspond to the exact SHA later used as the merge precondition — CLAUDE.md's "exact HEAD-SHA guard right before merge" is satisfied for the *merge call itself* (405 on stale SHA), but not for the CI-gate that authorizes reaching the merge call at all.
Fix: fetch `headSha` once, query CI status for that specific SHA, re-verify the diff, and merge — all against the same SHA.

## B — Placeholders / stubs / dead code

**B1 [P2] modules/watchdog/src/watchdog.ts:143 — `registerAction()` is fully built and tested but never wired in production.**
`grep -rn "registerAction"` across `apps/api/` and `modules/watchdog/` finds only the method definition and `fase10-ops.test.ts`'s unit test. Neither `main.ts` nor `worker-main.ts` calls `watchdog.registerAction(...)` for `database`, `stuck_tasks`, or `cost_explosion` — the "reversible, max-N-attempts self-recovery action" capability the class comment advertises is currently a no-op in production; watchdog is detect+alert only (plus the durable kill-switch write inside `costExplosionCheck` itself).
Fix: either wire a real reclaim/restart action for `stuck_tasks`, or correct the module's doc comment/README claims to say "detect + alert, no automated remediation wired yet."

**B2 [P3] modules/incidents/src/types.ts:73 — `DeploymentSource: "docker_redeploy"` is declared but never produced.**
No code in this slice calls `DeploymentService.recordDeployment()` with `source: "docker_redeploy"`; `executeInfraMutation()` (infra-execution.ts) writes to `infra_executions`, not `deployments`. Dead enum value.
Fix: wire `executeInfraMutation` to also record a `deployments` row for redeploys, or remove the value with a note.

## C — Gaps (untested logic, undocumented env vars, coverage blind spots)

**C1 [P2] modules/watchdog/src/watchdog.ts:293-321 — `costExplosionCheck` is scoped to exactly one hardcoded tenant.**
Wired in `worker-main.ts` with `process.env["JARVIS_TENANT_ID"] ?? "tenant-personal"` — a single tenant. The module's own D191 tests (`w1-durable-emergency-shutdown.test.ts`) explicitly prove a *different* tenant's massive overspend never trips the kill switch. Given CLAUDE.md's business-tenant model, any non-personal tenant has no automated cost-explosion protection at all.
Fix: loop the check across `jarvis_list_business_tenant_ids()` (the existing SECURITY DEFINER catalog function already used for this exact fan-out pattern elsewhere), or explicitly log this as a DEFERRED gap per the D-41 discipline CLAUDE.md requires.

**C2 [P3] modules/self-modification/src/github-client.ts:50-59 — `getCombinedCiStatus` queries the legacy Combined-Status endpoint, not check-runs.**
`GET /repos/{repo}/commits/{ref}/status` reflects the classic Statuses API (`POST .../statuses`); GitHub Actions results are Checks (`check-runs`), which are a materially different API. If the repo's Actions-based CI (`.github/workflows/ci.yml`) never posts to the classic Statuses API, `state` would stay perpetually non-`success`, and zero-review rows would sit in `pending_ci` forever, never auto-merging — the opposite failure mode of "unsafe" (blocks the intended automation) but still a real functional defect. **Unverified** — I cannot fetch live GitHub API docs/responses from this sandbox; this needs an empirical check (does `/commits/{ref}/status` for this repo's HEAD actually reflect Actions conclusions, or is it always empty/pending?).
Fix if confirmed: switch to the Checks API (`GET .../commits/{ref}/check-runs`) and require all required check-runs to be `completed`/`success`, in addition to (or instead of) the legacy status endpoint.

**C3 [P3] modules/incidents/src/observability.ts:57 vs. src/service.ts / src/diagnosis.ts — `redactSecrets()` is applied to container-log evidence only.**
`acquireContainerLogs()` redacts before persisting; `IncidentService.addEvidence()` and `DiagnosisService.createDiagnosis()` store free-text `summary`/`conclusion` with no redaction pass, so a manually pasted secret (e.g. copied from a stack trace into an evidence note) would persist unredacted.
Fix: apply `redactSecrets()` uniformly to any free-text evidence/diagnosis field before insert.

## D — Improvements

**D1 [P2] modules/tasks/src/sandbox.ts:37-68 — `ProcessSandboxRunner` (the production default) has no network restriction.**
Both `apps/api/src/main.ts` and `worker-main.ts` only switch to `DockerSandboxRunner` (which sets `--network none`) when `JARVIS_SANDBOX=docker` is explicitly set; the default is `ProcessSandboxRunner`, which restricts nothing beyond `cwd`/env. Every coding-agent job (self-modification code-change, incident repair) therefore runs `git clone`/tests/etc. with full host network access unless an operator opts into Docker mode.
Fix: default to the Docker sandbox in production wiring, or add an explicit deny-network wrapper for the process sandbox and document the gap prominently in DEPLOYMENT_STRATEGY.

**D2 [P3] modules/incidents/src/recovery.ts:48-78, 163-172 — recovery target is caller-supplied, not derived from the execution being recovered.**
`attemptRecovery()` looks up `before_state` solely by `(tenant_id, idempotency_key)`, but the docker target `name` used for the actual restore call comes from the caller's `parameters`, not from the original mutation's row. `docker-target-policy.ts`'s authorizer still constrains the real mutation, so this isn't a privilege escalation, but an already-authorized caller could recover container X using container Y's `before_state`, producing confusing/incorrect recovery semantics.
Fix: derive/cross-check the target name from the same execution row as `before_state`.

**D3 [P3] modules/self-modification/src/service.ts (proposePersonalityChange, ~150-230) — no `withSecretRedaction` around its own inline git error paths.**
Unlike the production coding pipeline (`worker-main.ts` wraps `createCodingHandler` with `withSecretRedaction([ANTHROPIC_API_KEY, JARVIS_GITHUB_TOKEN])`), `proposePersonalityChange`'s own `mustOk()`-thrown errors rely solely on the credential-helper's "token never in argv/stderr" guarantee (well tested elsewhere) with no second redaction layer.
Fix: wrap the method's git-error throws with the same `redactSecrets`/`withSecretRedaction` pattern for defense-in-depth consistency.

**D4 [P3] modules/tool-gateway/src/docker-transport.ts / modules/tasks/src/sandbox.ts DockerSandboxRunner — no CPU limit, read-only rootfs, or `--security-opt=no-new-privileges`.**
`--network none`, `--memory 256m`, `--pids-limit 128` are set; nothing bounds CPU or hardens the container filesystem/privileges.
Fix: add `--cpus`, `--read-only` (+ tmpfs for writable paths), `--security-opt=no-new-privileges` when adopting Docker sandboxing more broadly.

## E — Doc/code drift

**E1 [P3] modules/self-modification/src/policy.ts:68-84 — comment overstates `normalizePath`'s fail-closed behavior.**
The doc comment claims an unnormalizable path (`..`, leading `/`) is "klassifisert BEVISST som om den matchet et forbudt mønster" ("deliberately classified as if it matched a forbidden pattern"). In fact the sentinel `"\0invalid-path"` matches none of `FORBIDDEN_PATH_PATTERNS` (all are anchored, literal-prefix regexes); the real outcome is `requires_approval` (fails the allowlist-only check), not `forbidden`. The result is still safe (never `zero_review`), and the module's own tests (D1-D3 in policy.test.ts) correctly assert only `.not.toBe("zero_review")`, not `.toBe("forbidden")` — the test author evidently knew the comment overstates it.
Fix: correct the comment to say "falls to requires_approval," or add an explicit pattern so invalid paths genuinely classify `forbidden` as claimed.

## Confirmed correct under adversarial scrutiny (no finding, listed for traceability)

- `classifySelfModification`: forbidden always wins over zero_review in a mixed diff (tests C14, H5); a second file sneaking into the "one allowed file" diff always falls to `requires_approval`/`forbidden`, never `zero_review` (tests B2, D3); the module can never modify its own protections (`modules/self-modification/` is itself in `FORBIDDEN_PATH_PATTERNS`).
- Merge path (`attemptMerge`) re-fetches actual changed files from GitHub immediately before merging and re-runs `classifySelfModification` against them, comparing both the exact path set *and* the risk classification against the stored row — a force-push that changes files, or that (re-)introduces a forbidden path, is caught before merge (tests D4, I2). Merge always uses `merge_method: "merge"` (two-parent, no squash/rebase/force) via a narrow, separate `github-client.ts`, never `github.merge_pr`/ToolGateway class D — matches D-96/D-100/D-101/D-208/D-215.
- `InfraExecutionGate`/`OwnerControls.freezeConnector`/`KillSwitch` all uniformly gate `attemptRecovery`/`executeInfraMutation` for docker, identically to github — no bypass path found (infra-execution.test.ts I/J/K/L/W/X/Y).
- Docker target authorization (`docker-target-policy.ts`) is fail-closed in all directions and enforced at the `ToolGateway.execute()` boundary itself (`parameterAuthorizer`), so recovery/redeploy calls can never reach an unconfigured production target regardless of caller input (D3 above only concerns *which* already-authorized target gets used, not whether authorization can be bypassed).
- Git credential handling (`git-auth.ts` + its two dedicated test files) never puts the token in argv, `.git/config`, or any thrown error message; `ProcessSandboxRunner`/`DockerSandboxRunner` never invoke a shell (`shell:false`), so task/goal text cannot cause command injection.
- Tenant isolation is enforced consistently via `withTenantTransaction`/RLS across tasks, incidents, and infra execution/recovery tables, proven against a real non-superuser RLS-bound role (not just an admin pool) in the D191 watchdog tests and the infra-execution/repair test suites.

## Health summary

The four modules are unusually well-instrumented: nearly every security-relevant claim in the code comments is backed by a targeted regression test, and the two-tier self-modification model, CI/diff re-verification, and infra-mutation target policy all held up against deliberate adversarial probing. The most consequential real finding is **A1**: no lease renewal means any coding job that legitimately runs longer than the 60s default lease (which the agent's own 300s default timeout guarantees will happen) can be silently double-executed with live git-push side effects. **A2/B1/C1** together show the watchdog's automated-recovery story is thinner than its interface suggests — detection and alerting are solid, but self-healing actions are unwired and a single hung check can permanently silence the only automated safety trigger. **C2** needs an empirical GitHub API check that this sandbox cannot perform. No findings expand the trust boundary beyond what's already documented (owner git-token compromise, or an already-authorized caller misusing its own authority) — nothing found lets an untrusted actor reach a class-C/D action.
