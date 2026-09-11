# PROJECT STATUS

**Oppdatert:** 2026-09-11 (branch `claude/d132-worker-recovery-reconciliation`, base
`main=c67a7ba792b8d655a26379655ffec31b353b7101`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Forrige leveranse lukket: PR #79 / D-131b er MERGET

- PR #79 MERGET 2026-09-11T05:23:48Z av eieren `tsworkflow` (IKKE av Claude).
- Merge-commit `c67a7ba792b8d655a26379655ffec31b353b7101`, ekte two-parent merge:
  `5df11e5add901f3fff10c2ef266c40e3e35e3f48` + `f12ff3b2f344d17f8e020088083b3bf88129585d`.
- Fersk post-merge CI på nøyaktig merge-SHA: run `34565797633`, `completed/success`
  (build-test, gitleaks, windows-git-auth alle grønne).
- Lokal `main` var allerede nøyaktig merge-SHA-en; ingen fast-forward var nødvendig, ingen
  reset/clean/stash utført. Stashen `worker-dirty-backup-2026-09-11` er IKKE rørt.

## Aktiv oppgave: D-132 - permanent herding av worker-kontrollplanen

TASK_ID `D132-WORKER-RECOVERY-RECONCILIATION-20260911-A`. Ikke produktarbeid: worker-laget
re-dispatchet den ELDRE `D131-PR79-STASH-RECOVERY-20260911-A` kl. 05:38:07Z, ETTER at den nyere
merge-tasken allerede hadde merget PR #79 kl. 05:23:48Z.

**Rotårsak utledet fra kode OG fra hostens egen `state.json` - to uavhengige defekter:**

1. **Terminal-status-vokabularet var ikke kanonisk.** `TERMINAL_REPORT_STATUSES` inneholdt
   `COMPLETED`; Claude poster `STATUS=COMPLETE`, og sammenligningen var eksakt streng. Registrert
   ordrett på hosten for to tasks: `exit_0_without_matching_report (report_status_not_terminal
   (COMPLETE))` - blant dem merge-tasken som ALLEREDE hadde utført den autoriserte merge-handlingen
   (`head_after=c67a7ba`). Suiten var grønn samtidig fordi test-fixturen postet `STATUS=COMPLETED`,
   en dialekt den ekte barneprosessen ikke bruker.
2. **Kandidatvalget lot en eldre task preempte en nyere.** `tasks.find(isEligibleNow)` over en
   ELDST-FØRST-sortert liste valgte alltid den eldste task-en med utløpt backoff, uansett hvor mange
   nyere, aldri-utsendte ARCHITECT_TASK som lå i køen.

**Begge reprodusert mot base-commiten `c67a7ba` i et isolert worktree FØR fiksen**, ikke antatt:
`ROOT_CAUSE_1_reason = report_status_not_terminal (COMPLETE)` og
`ROOT_CAUSE_2_chosen_at_0538 = D131-PR79-STASH-RECOVERY-20260911-A`.

**Rettet som ÉN sammenhengende infrastruktur-PR (kun `ops/claude-worker/**` + docs):**

1. Kanonisk statusklassifisering i `lib/reconcile.mjs`: `normalizeReportStatus()` +
   `TERMINAL_STATUS_ALIASES` + eksplisitt `NON_TERMINAL_STATUSES`. Avgjørende nytt skille mellom
   «gjenkjent, ikke-terminal» (`IN_PROGRESS` → retry er riktig) og «ikke gjenkjent»
   (`statusRecognised=false` → parkeres som BLOCKED, ALDRI retryet i det uendelige).
2. Nytt rent modul `lib/queue.mjs` (`selectNextTask()`): TIERING (aldri-utsendt task slår alltid en
   retry), TOTAL DETERMINISTISK ORDNING (tier → tid → comment-id) og SUPERSESJON (ikke-terminal task
   som er strengt eldre enn en COMPLETE task pensjoneres).
3. Ny terminal `TASK_STATUS.SUPERSEDED` med `superseded_by`/`superseded_at`. Ingenting slettes
   stille - worker poster én statusmelding til issue #68. Verken restart, supervisor-restart eller
   tilbakespolt backoff-klokke kan gjenopplive en terminal/superseded task.
4. Fersk GitHub-sannhet slår stale lokal state: ny `reconcileReportedTasks()`-pass kjører UNDER
   låsen FØR kandidatvalg, over alle ikke-terminale tasks med `attempts>0` (bruker
   `findUnreconciledTasks()`, ubrukt i `state.mjs` siden D-126), uavhengig av backoff.
5. Idempotent post-merge-rekonsiliering: `merge_commit_sha`/`mergedAt` hentes nå og legges i
   resume-prompten, så en gjenopptatt merge-task VERIFISERER overgangen den allerede forårsaket i
   stedet for å kjøre en foreldet pre-merge-instruks mot post-merge-tilstand.
6. Task-eiet proveniens: `observed_heads` registreres, og en gjenopptatt barneprosess får eksplisitt
   `head_before → head_after` med instruksen om at commitene i spennet er TASK-ENS EGET ARBEID -
   aldri stash/reset/force/revert/re-apply over dem. Det er nettopp den forvekslingen som skapte
   stashen `worker-dirty-backup-2026-09-11`.

**Uendret og ikke svekket:** den strenge dirty-worktree-beskyttelsen (ingen `git clean/reset/stash`,
ukjente/sporede filer røres aldri) og tillitsgrensen i `lib/trust.mjs` (betrodd forfatter + eksakt
TASK_ID kreves fortsatt for all autoritet).

**Kvalitetsporter - faktisk kjørt:**

- Worker-suiten: **18/18 filer, 470/470 tester grønt** (baseline før endring: 16 filer / 428 tester;
  ingen eksisterende test svekket eller fjernet).
- Ny `test/queue.test.mjs` (23 tester) og ny `test/worker-queue-reconciliation.test.mjs` (7
  integrasjonstester mot den EKTE `node worker.mjs run`-prosessen), som replayer NØYAKTIG
  D-131-sekvensen: eldre recovery-task → nyere merge-task → ACK → merge lykkes → prosess-/
  rapportavbrudd → restart, og beviser at den gamle task-en aldri dispatches igjen.
- `npx eslint .`: 0 feil/advarsler.

**Ikke gjort (bevisst, per oppgavens eksplisitte grenser):** Q-34, D-108/provider-live, nye
credentials, deploy, merge, self-approval, produktkapabilitet-endringer, urelatert opprydding.

Full detalj: **D-132** i DECISIONS_AND_ASSUMPTIONS.md.

## Blokkeringer

Ingen harde blockere. `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` fra oppgaven:
denne PR-en skal IKKE self-approves eller merges - uavhengig arkitektkontroll mot eksakt PR-HEAD
kreves først.

Merk som miljøfakta, ikke som en test som ble hoppet over: den fulle arbeidsområde-suiten
(`pnpm test`) starter embedded Postgres for produktmodulene. Denne oppgaven endrer null produktkode,
og CI kjører hele suiten på eksakt PR-HEAD uansett; det som er kjørt lokalt her er hele
worker-suiten (som er det denne diffen faktisk berører) pluss `eslint .` over hele repoet.

## Neste oppgave

1. Vent på uavhengig arkitektkontroll av denne PR-en mot eksakt HEAD, og på fersk CI på samme HEAD.
2. Etter godkjent merge: verifiser fersk post-merge CI på merge-SHA og trygg lokal main-sync.
3. Deretter: egen, dedikert cross-domene-audit-slice for **Q-34** (FØR en generisk `gateway.ts`-fiks
   vurderes), som var den neste produktleveransen i køen før denne kontrollplan-herdingen.
