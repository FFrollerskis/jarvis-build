# PROJECT STATUS

**Oppdatert:** 2026-09-11 (branch `claude/d132-worker-recovery-reconciliation`, PR #80 draft, base
`main=c67a7ba792b8d655a26379655ffec31b353b7101`). Aktiv runde: **D-133**, PR #80-review-herding.

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

## Herdingsrunde 2 på SAMME PR #80: D-133 (PR #80-review, REF_REVIEW_ID=5175627340)

TASK_ID `D132-PR80-REVIEW-HARDENING-20260911-A` (kommentar 5630497923 på issue #68). En NY
uavhengig arkitektkontroll av D-132 sin eksakte HEAD `4f1b7b4` fant TO sammenhengende
kontrollplan-blokkere. Rettet som ÉN runde på SAMME branch og SAMME PR - ingen ny PR.

**Blocker 1 - commit-SHA-er er ikke en proveniensmodell.** D-132 registrerte hvilke COMMITS en task
eide, men et forsøk som avslutter/krasjer uten betrodd rapport ETTER legitime UKOMMITERTE endringer
etterlot dem som anonymt skitt i den DELTE checkouten. Ingenting attribuerte dem til en task, så
neste kjørings dirty-guard blokkerte - korrekt - og arbeidet var strandet, med bare de to forbudte
utveiene igjen (adoptere uattribuerte filer, eller stashe/resette dem bort). Manglende STRUKTUR,
ikke manglende regel: det fantes ikke noe sted en tasks ukommiterte arbeid kunne bo som ikke også
var brukerens arbeidsområde.

Rettet med **isolasjon + claim** (nytt `lib/worktree.mjs`, ny `worktreeRoot`-konfig):

1. Hver task får sin EGEN linkede git-worktree, nøklet på `TASK_ID`, UTENFOR den primære checkouten
   (standard: en SØSKENKATALOG av `scratchRoot` - bevisst ikke under den, som gis barnet som TEMP). Barnet kjører med den som
   `cwd`; prompten oppgir stien, baseline-commiten og forbudet mot å mutere primær-checkouten.
2. En DURABEL CLAIM (`.claims/<TASK_ID>.json`, fsynced) skrives FØR `git worktree add` og
   re-verifiseres før gjenbruk. Den binder katalogen til eksakt `task_id`, betrodd
   `task_comment_id`, repo + lokal repo-sti, kontroll-issue, `baseline_sha`, `worktree_path` og
   attempt-identitet. **Eierskap hevdes FRAMOVER før noe røres og BARE sjekkes etterpå - det utledes
   aldri BAKOVER fra hvilke filer som er skitne**, fordi det «beviset» er like forenlig med
   brukerens eget arbeid.
3. Skitt under en gyldig claim for DENNE tasken er task-eid ved konstruksjon og leveres til et
   gjenopptatt barn som «dette er DITT eget arbeid - aldri stash/reset/checkout over/clean/slett».
   Skitt alle andre steder er UKJENT og FAIL-CLOSED: rapportert med eksakt sti, aldri adoptert,
   aldri endret. En nyere task kan hverken dispatches inn i eller blokkeres av en annen tasks
   skitne kontekst.
4. Opprydding kun etter terminal OG VELLYKKET rekonsiliering, kun når worktreen er ren, kun via
   `git worktree remove` UTEN `--force` (git nekter selv hvis våre garder tar feil). Claim-filen
   slettes ALDRI - den merkes `released`, så beviset overlever katalogen.

**Blocker 2 - supersesjon pensjonerte arbeid på et ikke-bevis.** `isComplete` godtok ENHVER terminal
rapport, inkludert `BLOCKED`/`FAILED` der `assessCompletion()` allerede hadde beregnet
`successful: false` uten at noen leste det - og fordi workeren skriver slike utfall som
`completed, successful: false`, ville en fiks som bare så på ferske kommentarer sluppet feilen inn
igjen fra state-filen. Nå kreves POSITIVT bevis: `newer_task_completed_successfully` (kanonisk
vellykket terminalutfall, `successful === true`; `undefined` er ikke suksess) eller
`explicit_trusted_supersedes_declaration` (`SUPERSEDES=<eksakt TASK_ID>` i en strengt nyere BETRODD
`ARCHITECT_TASK` - eksakt, retningsbestemt, aldri selvrefererende, aldri fra ubetrodd innhold).
Grunnlaget er auditbart: `superseded_basis` + `superseded_declared_by_comment_id` i state, i
statusmeldingen og i `--dry-run`.

**Kvalitetsporter for D-133 - faktisk kjørt:**

- Worker-suiten: **20/20 filer, 538/538 tester grønt** (fra 470; ingen eksisterende test svekket
  eller fjernet - den ene endrede assertionen ER den tilsiktede oppførselsendringen i blocker 2).
- Ny `test/worktree.test.mjs` (34 enhetstester) og ny `test/worker-task-worktree.test.mjs`
  (10 prosess-tester mot det EKTE entrypointet og et EKTE git-repo - `JARVIS_WORKER_GIT` bevisst
  IKKE satt, fordi påstanden er fysisk og en fake-git bare ville vært enig med workeren).
- Nye entrypoint- og enhetstester for supersesjon i `worker-queue-reconciliation.test.mjs` og
  `queue.test.mjs`.
- `fixtures/fake-git.mjs` modellerer nå `git worktree list/add/remove` (inkl. at en ikke-tvunget
  `remove` FEILER på en skitten worktree); `fixtures/fake-claude.mjs` gjør EKTE tracked/untracked
  mutasjoner og commits i sin `cwd`; ny `fixtures/real-git-repo.mjs`.
- `npx eslint .`: 0 feil/advarsler. `pnpm -w typecheck`: grønt.
- Hemmelighetsskann av full diff: 0 treff (og CI-jobben `gitleaks` grønn).
- **CI mot eksakt ny HEAD `e58a870`:** BEGGE kjøringene grønne på alle tre jobber -
  push-run `34578080627` og PR-run `34578084000` (`build-test` 3960 passed / 6 skipped / 0 failed,
  `gitleaks`, `windows-git-auth`). PR-runens første forsøk feilet på
  `modules/conversation-graph/test/d125-owner-telegram-link.test.ts` med `ECONNREFUSED` fra embedded
  Postgres under `runMigrations` - et oppstartsproblem i testinfrastrukturen, ikke en assertion; den
  ble kjørt på nytt og er grønn, og push-runen på NØYAKTIG samme SHA var grønn hele tiden.

**Lokale Windows-feil som rapporteres som de er, ikke bortforklares:** den fulle
arbeidsområde-suiten lokalt gir **31 feilede tester i 5 produkt-testfiler**, reproduserbart i to
uavhengige kjøringer: `modules/tool-gateway/test/docker-transport.test.ts` (12),
`apps/api/test/worker-coding-wiring.test.ts` (8), `modules/tasks/test/sandbox-docker-extra-env.test.ts`
(5), `modules/tasks/test/claude-code-agent.test.ts` (4),
`modules/business/test/ua3-live-pool-separation.test.ts` (2). Feilsignaturene er verts-/
plattformspesifikke: `spawnSync ... docker.cjs EFTYPE` (Windows kan ikke eksekvere en `.cjs` som
binærfil), `ENOENT` på fake-docker sin `record.json`, og kildetekst-assertions som feiler på CRLF vs.
LF (`expected 'await selfHeal();\r\n ...' to contain '...\n...'`). HELE grenen (D-132 + D-133)
berører utelukkende `ops/claude-worker/**` og `docs/**` - ingen av de fem filene, og ingen kode de
importerer, er i diffen (`git diff c67a7ba..HEAD --name-only`), og de samme filene er grønne på
Linux-CI mot eksakt samme HEAD. Dette er altså et kjent Windows-vertsproblem i produkttester, ikke
en regresjon fra denne PR-en - og det er heller ikke fikset her, fordi det er utenfor oppgavens
scope.

Stashen `worker-dirty-backup-2026-09-11` er URØRT. Full detalj: **D-133** i
DECISIONS_AND_ASSUMPTIONS.md.

## Blokkeringer

Ingen harde blockere. `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` fra oppgaven:
denne PR-en skal IKKE self-approves eller merges - uavhengig arkitektkontroll mot eksakt PR-HEAD
kreves først.

Den fulle arbeidsområde-suiten ER nå kjørt lokalt (to ganger) i tillegg til på CI. Resultatet, og
hvorfor de 31 lokale Windows-feilene ikke er en regresjon fra denne PR-en, står under
«Kvalitetsporter for D-133» over - ikke skjult, ikke hoppet over.

## Vertsoppgave som følger av D-133 (ikke en blocker for review)

Isolerte task-worktrees legger administrasjonsposter under `<repoPath>/.git/worktrees/` når en task
kjører. Det er git sin egen standardmekanisme og påvirker ikke `git status` i arbeidstreet, men det
er en reell endring i den lokale checkouten som er verdt å kjenne til. `worktreeRoot` er valgfri i
config og faller tilbake til en søskenkatalog av `scratchRoot`, så eksisterende `config.json` på
verten trenger ingen endring.

## Neste oppgave

1. Vent på uavhengig arkitektkontroll av denne PR-en mot eksakt HEAD, og på fersk CI på samme HEAD.
2. Etter godkjent merge: verifiser fersk post-merge CI på merge-SHA og trygg lokal main-sync.
3. Deretter: egen, dedikert cross-domene-audit-slice for **Q-34** (FØR en generisk `gateway.ts`-fiks
   vurderes), som var den neste produktleveransen i køen før denne kontrollplan-herdingen.
