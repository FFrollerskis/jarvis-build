TS: 2026-11-25T21:19:44.783Z
Branch `claude/wp-g1c-comms-rest` is pushed at `f43f06e6`. All of WP-G1c (K1–K9) is built but DORMANT and `NOT VERIFIED`. K6 g5 is PARTIAL and the K7 gaps from review B are only partly covered (both explained below).

**Blockers**
- `CORE_DEPENDENCY_DECISION_REQUIRED=false`. There is no new vendor, connector or SaaS.
- No `HARD_EXTERNAL_BLOCKER` stops the build. Activation is `BLOCKED_EXTERNAL` on two points. The owner must supply the pepper `JARVIS_COMMS_CONTENT_PEPPER`; without it all comms sending fails closed. The NAS steps and live provider tests are not run.

**Delivery**
- Pushed: yes (origin equals local HEAD), no PR, no merge, no force-push.
- Diff against main: 65 files, +3709/−195.
- Commits:
  - f43f06e6 docs: runbook and DPIA
  - ebd2403b test: mutation findings for contact conflicts
  - 4d0bd89e feat: contact conflicts (K4, migration 143)
  - c113f4ec test: best-link and mutation findings (K7)
  - 111dfb4d feat: K6 (g1–g5)
  - 056b8493 feat: K3 batch cap and long ids
  - 058bf005 feat: K1/K2/K5, migrations 141–142
- gitleaks over `origin/main..HEAD`: no leaks found.
- History repair: gitleaks flagged a fake Discord id literal in my local K6 commit. I ran `git reset --soft` on two unpublished commits and recommitted them with runtime-built ids. No published history was rewritten.

**Status per K**
- **K1 (DB guards):** done.
  - Migration 141 adds a state-machine trigger for who may lift what, erasure-only DELETE, and immutable core columns.
  - Migration 142 adds journal immutability, a retention-based DELETE guard, and the stricter room CHECK (NOT VALID plus attempted VALIDATE).
  - The content hash is HMAC with a pepper from the existing vault chain, fail-closed, with `content_hash_version` 1/2.
  - Tests: `stop-start-order`, `optout-guard`, `content-hash`, `migrations-upgrade` (empty DB and upgrade from main).
- **K2 (STOP/START order):** done. A DB sequence plus a per-recipient advisory lock decide the order, and "STOP wins" holds. 20+ rounds of real concurrency pass. The residual risk is documented as accepted in runbook §10.
- **K3 (batch cap):** done. The cap is 1000 and STOP/START are processed first. Over the cap the service returns 503 `batch_over_cap`. Long ids are hashed. The 1000 figure is `unverified` (see Contradictions).
- **K4 (contact conflicts as proposals):** done (migration 143).
  - New actions `list_contact_conflicts` (read) and `decide_contact_conflict` (class C).
  - Accept links the contact via the additive `allow_shared_with`; it works only for `shared_identity`, enforced by code and the DB CHECK.
  - `contact_sync` links stay cold, pinned by a test. This awaits owner confirmation (Q-72 pt 11).
- **K5 (owner undo):** done. `lift_owner_opt_out` is class D with step-up, mandatory reason, audit and idempotency, and only for `owner_recorded` rows. Step-up is client-asserted until WP-S1 (JARVIS-111). `record_opt_out` still has no step-up.
- **K6:**
  - g1 account cap across rooms: already correct in code, now locked by tests.
  - g2 Norwegian holidays and Sundays in the call window: done, on local Oslo date.
  - g3 Slack `fatal_error`/`internal_error` as `outcome_unknown`: done.
  - g4 `PolicyDeniedError` so policy denials don't count against connector health: done, with flag-off parity tests.
  - g5 STOP guard for legacy `*.notify` tools: PARTIAL. It covers the api process only; the worker is not covered, because comms env and flags exist only in api and enabling them needs compose and env-drift changes. There are no caps or journal for these tools.
- **K7:** the best-link probe from review A is now permanent, with mutants. Review B's Y13 (status events on the same long id) is also added. Y5/Y19/X6 and the complementary-layer scenarios from review B are not done.
- **K8:** flags OFF are identical to main. The wph1, wph2, part3, model-surface, env-drift, compose and schema guards are green. The new env secret is in `SERVICE_ENV.api` and compose is regenerated.
- **K9:** `docs/runbooks/WPG1_COMMS.md` (§2, 3, 5, 6, 7, 8, 9 and new §10 "WP-G1c") and the DPIA §10 are updated. NAS-verifiable steps are included, all `NOT VERIFIED`.

**Migrations (all expand-only; rollback = flags off, triggers and columns stay)**
- 141: `comms_event_seq`, `comms_inbound_receipts`, new columns on opt-outs, the guard trigger, erasure-only DELETE guards.
- 142: `content_hash_version`, journal guard and delete trigger, room CHECK on 7 tables.
- 143: `comms_contact_conflicts` (FORCE RLS, guard trigger, erasure-only DELETE).

**Tests and static checks**
- Final run as `postgres` with `--maxWorkers=2`: 285 files, 4291 tests, 4288 green, 3 red. The 3 red are the known `wpc3-review1-hardening` F10a/b/c failures, unchanged code.
- Selection: `modules/comms/test` (40 files, 574 tests), `modules/tool-gateway/test` (146 files, 2104), `modules/core/test` without the two `embedded-postgres-*` files, erasure, conversation-graph, connector-sdk, env-drift, and the api guards.
- `embedded-postgres-port-lease` is green alone. `embedded-postgres-ipv4-contention` hangs in the large run and has 5 failures alone. It and the helpers in `modules/core/src/testing` are unchanged by this work, so I count it as sandbox contention, not a regression. It stays `NOT VERIFIED` as an exception.
- `pnpm -r --workspace-concurrency=2 run typecheck`, `pnpm lint` and `pnpm check:containment` all exit 0. Full suite not run.
- Mutants: 121 in four batches. 114 were killed first time and 7 survived: `liftOwnerOptOut` without the lock, the `unknown_lifter` trigger branch, `source` immutability, denied rows written with version 1, cap denials without the typed error, a fingerprint ignoring the conflict set, and a decision without a person. All 7 were killed after strengthening tests. No survivors remain.

**Security surfaces for independent review**
- `modules/core/src/db/migrations/141_comms_optout_lifecycle.sql:44,92,102,116-117` (guard function, delete guards, triggers)
- `142_comms_journal_integrity.sql:17,40,42-58` (journal guard, delete trigger, room CHECK)
- `143_comms_contact_conflicts.sql:70,73` (guard and delete triggers)
- `modules/comms/src/store.ts:306,311,316,356,370,404,445,497,516,682,744` (lock, sequence, STOP/START, owner lift, conflicts)
- `modules/comms/src/channels.ts:156-176` (pepper and hasher)
- `modules/comms/src/funnel.ts:221-268,348-380` (fail-closed hashing, replay)
- `modules/comms/src/webhooks/ingest.ts:184-196,236` (priority, cap, STOP freshness exemption)
- `modules/comms/src/tools.ts:62,172-177,246-249` (lift tool and K4 tools)
- `modules/comms/src/transport.ts:97,258,262,367` (conflict recording, K4 and lift cases)
- `modules/comms/src/legacy-notify-guard.ts` (whole file)
- `apps/api/src/main.ts:872-976` and `apps/api/src/comms-wiring.ts:48,53,69,102,131`
- `modules/tool-gateway/src/policy-denied.ts` and `gateway.ts:1178` (the only shared-gateway change)
- `modules/conversation-graph/src/service.ts:336-340` (`allow_shared_with`)
- `modules/erasure/src/plan.ts:369-371`, `modules/comms/src/policy.ts:457-460`
- Existing baseline changed: `apps/api/test/drive-runtime-wiring.test.ts`. The slack, discord, twilio, whatsapp and telnyx lines now show the wrapped form, and the bare empty-constructor count went from 21 to 19.
- Also changed: the all-off return-object regex in `apps/api/test/wpg1-comms-routes.test.ts`, and `infra/local/service-env.mjs:309` plus compose and `.env.example`.

**Contradictions I did not resolve silently**
- The brief says `recipient_request` rows are liftable "by the recipient's own START, as today". The code has never allowed that, and the trigger enforces "never". I kept the code; opening it is a one-line change (Q proposal below).
- K4 mentions "same contact, different values". The only conflicts the code knows are a shared identifier and identifiers on different identities, so only those are built.
- K6 g1 says the account cap is counted per memory space, but the code already counted across rooms. I added tests only.
- developers.facebook.com and docs.slack.dev were unreachable, so the Meta batch size of 1000, the 3 MB Meta payload and the Slack error semantics are from search snippets only. They are marked `UNVERIFIED`.

**Proposed D-481 text**
D-481: WP-G1c closes JARVIS-112 b, c, d, f, g, h in code, DORMANT and `NOT VERIFIED`. A single advisory lock and the DB sequence `comms_event_seq` order STOP and START, and the platform's reception order is final (provider time is not used). DB triggers enforce lift sources, delete guards and the room CHECK. The content hash is HMAC with a vault pepper, fail-closed, versioned. Contact conflicts are proposals that the owner decides. Policy denials are typed (`PolicyDeniedError`). The legacy-notify STOP guard covers the api process only.

Assumptions to record with D-481:
1. The accepted STOP/START residual risk is: a provider delivering a later STOP before an earlier START can let that START lift it.
2. The Meta batch cap of 1000 is `unverified`.
3. Recipient hashes stay unsalted; a salt would orphan existing opt-outs.
4. Ressource names in `comms_contact_conflicts` are pseudonymous identifiers.
5. Julaften, nyttårsaften and the evening-before holiday peace are not holidays in the rule.
6. The legacy guard checks the identity tenant plus the webhook tenant.
7. The owner's own number gets no exemption from the guard.

**Q proposals**
- Should START lift `recipient_request` rows?
- Should erasure of a room delete the tenant-wide opt-out rows stored in it?
- What should the raw body limit be given Meta's possible 3 MB payloads (ours is 256 KB)?
- Should the owner's own number be exempt from the legacy guard?
- Should the worker be covered (needs compose env changes)?
- Should recipient hashes get a salt (needs a re-keying migration)?
- Should signed provider time (Meta, Telnyx, Slack) be an extra protection for STOP/START order?
- Should holiday peace hours and julaften apply to calls?
- Confirm the cold rule for contact-book links (Q-72 pt 11).

**Proposed JARVIS-112 status**
- (a) and (e): closed in G1b.
- (b), (c), (d), (f), (h): closed in code, DORMANT, `NOT VERIFIED`.
- (g): g1–g4 closed in code; g5 is PARTIAL (api guard yes, worker no).
- Open: activation needs the pepper (`BLOCKED_EXTERNAL`), live provider verification, a jurist review of the DPIA, and the decisions above.
