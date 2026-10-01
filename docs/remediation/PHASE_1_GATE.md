# PHASE 1 GATE – Remediering del 1 av 10 (containment + baseline)

| Felt | Verdi |
|---|---|
| Dato | 2026-10-01 |
| Branch | `remediation/01-containment-baseline` (utgangspunkt: `main` @ `9706af0`, audit av `35075a2`) |
| PR | draft, **IKKE merget** (se `FINDINGS_LEDGER.md`) |
| Beslutning | D-363 · ADR-001 · Q-43 |
| Uavhengig review | **IKKE gjort.** Denne filen er Claude sin egen evidens, ikke en uavhengig godkjenning. |

## 1. Gate-utfall

**`PHASE 1 GATE = PASS_WITH_BLOCKED_EXTERNAL`** (repo-containment PASS; backup `BLOCKED_EXTERNAL` med ferdig verktøy/runbook).

- Aktive farlige flater i REPOET er containet og låst av tester + strukturell CI-sjekk (§2).
- Backup er **IKKE verifisert**: verktøy og runbook er ferdige og bevist mot to ekte lokale Postgres-klynger, men INGEN restore fra NAS-data er kjørt. Status `BLOCKED_EXTERNAL` inntil operatøren kjører kommandoen i `BACKUP_RESTORE_RUNBOOK.md` og restore-verifiseringen består.
- **Ingenting er kontrollert mot kjørende NAS/PC** (ingen host-tilgang fra denne økten). Containment er `CODE_FIXED`/`CONTAINED` i repoet, ikke `VERIFIED` i runtime. Ingen funn er erklært lukket.

## 2. Bevismatrise

Statusvokabular: ADR-001 §2.4. «Test» = kommando kjørt i denne økten (se §4 for totaler).

| Funn / krav | Tiltak (kode) | Bevis (test/kommando) | Status |
|---|---|---|---|
| **JARVIS-002/-001-kjeden** modellens fulle verktøymesh | `MODEL_SURFACE_ALLOWLIST` (5 klasse-A lesehandlinger), `resolveModelToolSurface` + boot-sjekk (api og worker), `allMeshTools()` ikke koblet, `delegate_code_task` fjernet fra chat, `ExecutiveService.modelSurface` | `apps/api/test/remediation-1-model-surface.test.ts` (9, mot ekte produksjonsdefinisjoner: flate = nøyaktig allowlist, ingen send/delete/pay/merge/owner-control, `TOOL_NOT_FOUND` uten å nå gateway); `d355-specialist-delegation-wiring.test.ts`; `executive-parity.test.ts` | `CONTAINED` (underliggende autoritetsmodell = senere fase) |
| **JARVIS-006** executive `command` | `TaskService.submit` avviser (`executive_command_disabled`, auditert); handler kjører ikke command; sandbox-opsjon fjernet | `modules/tasks/test/fase6-worker.test.ts` (avvisning); `apps/api` executive-tester | `CODE_FIXED` |
| **JARVIS-009** dev-ruter | `/worker/tick`, `/tools/critical-demo` kun bak `ApiDeps.enableDevRoutes` (aldri satt i `main.ts`) | `fase3-e2e.test.ts`, `coding-production-wiring.test.ts` (setter flagget eksplisitt); `check-containment` | `CODE_FIXED` |
| **JARVIS-007** backup/DR | `ops/backup`: `pg_dump -Fc --snapshot` → `age` (ingen klartekst på disk), manifest m/ tabellinventar + eksakte radtall fra samme snapshot, globals, SHA256SUMS, restore-verify mot separat scratch-server | `modules/core/test/remediation-1-backup-restore.test.ts` (13; to ekte PG-klynger, ekte pg_dump/pg_restore/age; nektet å restore mot kilde-endepunkt) | **`BLOCKED_EXTERNAL`** (ingen ekte NAS-restore) |
| **JARVIS-024/-026** (selvmodifikasjon, issue-#68/PC-worker) | `SelfModificationService`, sweeps, tool og Telegram `/godkjenn`/`/avvis` fjernet fra produksjonsoppstart; `ops/claude-worker` frosset (`JARVIS_CLAUDE_WORKER_UNFREEZE=remediation-part-9-reviewed`) | `ops/claude-worker/test/remediation-1-freeze.test.mjs`; claude-worker-suiten (41 filer/1363 tester) m/ eksplisitt unfreeze i vitest-config; `check-containment` | `CODE_FIXED` i repo; **PC-worker/schtask på host: `BLOCKED_EXTERNAL`** |
| **JARVIS-042/-052** pris/fantomkostnad | Eksplisitt pris for alle providere (`gemma_local`/`scripted` LOCAL/0), `assertExplicitPricing` i `ModelGateway`-konstruktør, `assertProvidersHaveExplicitPricing` ved oppstart; reversibel kompensasjonsplan (archive-then-zero, plan/apply/revert) | `modules/model-gateway/test/remediation-1-explicit-pricing.test.ts` (8); `modules/core/test/remediation-1-phantom-cost-compensation.test.ts` (6) | pris: `CODE_FIXED`; kompensasjon **ikke anvendt** (`BLOCKED_EXTERNAL`, krever Tobias + NAS) |
| **JARVIS-058** governance | ADR-001 (hierarki), D-363, Q-43, CLAUDE.md-peker, ledger | gjennomlesing; ingen krav diktet fra HF6 | `CODE_FIXED` (dok.); ADR er `PROPOSED` til merge |
| **JARVIS-059** motsagte påstander | `CLAIM_DISPUTED_BY_AUDIT`-merking + bannere i graduation-matrise, RUNTIME_GATES, IMPLEMENTATION_PLAN, PROJECT_STATUS | `git diff` på docs/ | `CODE_FIXED` (dok.) – påstandene er merket, ikke re-bevist |
| **JARVIS-080** voice rå-lyd | Dump fjernet fra compose; krever `JARVIS_VOICE_DEBUG_DUMP_CONSENT=I_ACCEPT_RAW_AUDIO_ON_DISK`; `/status` `audio_persistence` sannferdig; adapter-valg feiler lukket uten `JARVIS_VOICE_ALLOW_TEST_ADAPTERS=true` | `apps/voice-gateway/test/debug-audio-dump.test.ts`, `remediation-1-adapter-selection.test.ts`, `d212-voice-gateway-compose-wiring.test.ts` | `CODE_FIXED`; **eksisterende dumper på host ikke slettet** (`BLOCKED_EXTERNAL`) |
| **JARVIS-086** host-akseptansescript | 27 skript krever `JARVIS_HOST_ACCEPTANCE_CONSENT=I_UNDERSTAND_THIS_MUTATES_THE_LIVE_STACK` | `modules/core/test/remediation-1-host-script-guard.test.ts` (4) | `CODE_FIXED` |
| **JARVIS-089** flytende images | Alle kritiske images pinnet tag@digest (compose + 3 Dockerfiler) | `docker compose config`, `check-containment`, compose-wiring-tester | `CODE_FIXED`; **sammenligning mot deployet digest ikke gjort** (`BLOCKED_EXTERNAL`) |
| **JARVIS-092/-083** tomme/ugyldige env | `packages/contracts/src/env.ts` (`envInt/envHour/envPort`; blank = default, ugyldig = oppstartsfeil); `envPositiveInt` i 8 adaptere; ads API-versjon blank→default | `packages/contracts/test/env.test.ts`; `modules/growth/test/remediation-1-ads-api-version-env.test.ts` | `CODE_FIXED` |
| **JARVIS-100** dokumentdrift | kun 058/059-delen | – | `OPEN` |
| Porter (krav 5/verifisering 1) | Postgres/Infisical/Langfuse/api/voice på `127.0.0.1`; browser-gateway uten host-port | `docker compose config` før/etter (§3) | `CODE_FIXED`; **NAS `ss -tln` ikke kontrollert** |
| Strukturell sjekk (krav 7) | `ops/security/check-containment.mjs` (`pnpm check:containment`, i CI): avviser åpne 0.0.0.0-publiseringer av DB/vault/Langfuse/browser, ikke-pinnede images, farlige verktøy i modellflate, ubeskyttede dev-ruter | `ops/security/test/check-containment.test.mjs` (21) + `pnpm check:containment` → `containment invariants hold` | `CODE_FIXED` (erstatter ikke atferdstester) |
| Baseline (krav 2) | `BASELINE.md` + `ops/remediation/collect-runtime-baseline.sh` (read-only, ingen hemmeligheter) | `ops/remediation/test/collect-baseline.test.mjs` (4) | repo-delen ferdig; **runtime `NOT_COLLECTED`** |
| Escrow (krav 6) | `INFISICAL_KEY_ESCROW.md` (ingen nøkkel i repo; rotasjon `NOT_VERIFIED_AGAINST_OFFICIAL_DOCS`) | – | dokumentert; **escrow ikke utført** |

## 3. `docker compose config`-bevis (krav «ikke publisere DB/vault/Langfuse/browser på alle interfaces»)

Kjørt med dummy-env mot `infra/local/docker-compose.yml`:

| Tjeneste | Før (`9706af0`) | Etter |
|---|---|---|
| postgres | `0.0.0.0:5432` | `host_ip 127.0.0.1` |
| infisical | `0.0.0.0:3060` | `host_ip 127.0.0.1` |
| langfuse | `0.0.0.0:3050` | `host_ip 127.0.0.1` |
| api | `0.0.0.0:3010` | `host_ip 127.0.0.1` |
| voice-gateway | `127.0.0.1:3020` | `127.0.0.1:3020` (uendret) |
| browser-gateway | `0.0.0.0:3030` | ingen host-port |
| worker / migrate / redis / db-bootstrap | – | ingen host-porter |

Gjenta lokalt: `docker compose -f infra/local/docker-compose.yml config` og kontroller at ingen `published` port mangler `host_ip: 127.0.0.1`. Strukturell variant: `pnpm check:containment`.

## 4. Kvalitetsporter (kjørt i denne økten)

| Kommando | Resultat |
|---|---|
| `pnpm check:containment` | `containment invariants hold` (exit 0) |
| `pnpm typecheck` (alle pakker) | exit 0 |
| `pnpm lint` | 0 feil i sporede filer. Kommandoen feiler lokalt med 1014 feil som ALLE ligger i `.claude/worktrees/` (git-ignorert, lokal agent-worktree; finnes ikke i CI-checkout) – ikke i repoets filer. |
| `vitest run` (hele repoet, 1. kjøring, embedded Postgres som ikke-root) | 402 filer: 400 passert, 2 feilet; 6592 tester: 6589 passert, 3 feilet |
| – feil 1–2: `modules/core/test/d253-voice-gateway-local-stt-tts.test.ts` (2 tester) | **Forårsaket av denne PR-en** (digest-pinning endret `FROM`-linjene som regexene matchet). Regexene oppdatert; fil re-kjørt: **12/12 passert**. |
| – feil 3: `modules/core/test/embedded-postgres-ipv4-contention.test.ts` («B.3 check-to-bind», timeout 900 s) | **Ikke berørt av denne PR-en:** hverken filen, `modules/core/src/**` eller testhjelperne er endret siden baseline `9706af0` (`git diff --stat`). Miljørelatert port-/IPv4-kontensjon i sandbox-VM-en (samme familie som `embedded-postgres-port-lease`-flaken dokumentert i PROJECT_STATUS). Re-kjørt isolert: se status under. |
| Remediering-1-spesifikke tester | pris 8 · modellflate 9 · backup/restore 13 · fantomkostnad 6 · host-guard 4 · containment-sjekk 21 · baseline-collector 4 · env-tester · voice dump/adapter-valg · ads-env · claude-worker-frys (alle grønne i full kjøring) |
| `docker compose config` | se §3 |
| Hemmelighetsskanning | `git diff` gjennomgått; ingen nøkler/tokens; backup/baseline-skript skriver aldri secrets (testet med fake-verdier). Gitleaks kjøres i CI. |
| Full CI på PR | **Ikke kjørt ennå** – kjøres ved PR-opprettelse; resultat rapporteres i PR/status. |


## 5. `BLOCKED_EXTERNAL` / åpne punkter (krever Tobias eller host)

1. **NAS-baseline:** kjør `ops/remediation/collect-runtime-baseline.sh` på NAS og lim output inn i `BASELINE.md`.
2. **Backup:** første ekte kjøring av `ops/backup/nas-backup.sh`, kopi UTENFOR NAS, så `nas-restore-verify.sh` mot scratch → først da kan backup kalles verifisert (`JARVIS-007`). `age`/`node` på NAS må bekreftes installert.
3. **Infisical-nøkkel-escrow** (separat fra datakopien) – `INFISICAL_KEY_ESCROW.md`.
4. **PC-worker:** deaktiver Windows-oppgaven/schtask for issue-#68-loopen og roter PAT (`ops/claude-worker/README.md`); repoet fryser kun koden.
5. **Redeploy** av containment på NAS (`git pull` + `docker compose up -d --build`), deretter `ss -tln`/`docker port` og sammenligning av kjørende image-digest mot pinnene.
6. **Fantomkostnad:** vurder `ops/remediation/phantom-cost/01-plan.sql` (read-only), og anvend `02-apply.sql` kun etter Tobias sin bekreftelse (`jarvis.remediation_confirm`); `03-revert.sql` angrer.
7. **Eksisterende voice-rå-lyd** på host (gammel dump-volum) – slett etter Tobias sin godkjenning.
8. **Branch protection / required review på `main`** kan ikke settes fra denne økten (ingen verktøy for repository-innstillinger). GitHub → Settings → Branches → Add rule for `main`: *Require a pull request before merging*, *Require approvals ≥ 1*, *Require status checks* (`build-test`, `gitleaks`, `windows-git-auth`), *Do not allow bypassing*, *Block force pushes*, *Restrict deletions*. Status: `BLOCKED_EXTERNAL`.
9. **Q-43:** HF6/Continuous Intelligence v1.2 mangler → `MISSING_GOVERNING_INPUT`.
10. Uavhengig arkitekt-review av PR-en før merge (CLAUDE.md: Claude godkjenner ikke eget arbeid).

## 6. Bevisst IKKE gjort (del 2+)

Taint-gate/ubetrodd-innhold-modell, ekte autoritets-/bekreftelsesmodell for utvidet verktøyflate, kostnads-/budsjettgrenser utover eksplisitt pris, erasure/retention-wiring, minne-kvalitet, øvrige 79 `OPEN` funn i ledgeren. Ingen del 2-arbeid er startet.
