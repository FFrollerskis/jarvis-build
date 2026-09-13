# PROJECT STATUS

**Oppdatert:** 2026-09-14 (branch `claude/d132-worker-recovery-reconciliation`, PR #80 draft, base
`main=c67a7ba792b8d655a26379655ffec31b353b7101`). Aktiv runde: **D-137**, CI-blokker på PR #80
(testenes portvalg for embedded Postgres). Manuell recovery-økt - ingen Jarvis-task-proveniens.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Aktiv oppgave: D-137 - CI-blokkeren på PR #80 er funnet og rettet

**Feilen (lest ut av CI, ikke gjettet).** Run `34774371210` (pull_request) feilet i `build-test` med
`connect ECONNREFUSED 127.0.0.1:40688` i `runMigrations` for
`modules/business/test/scoring-service.test.ts`: 1 suite feilet, 243 passerte, 4082 tester passerte.
PUSH-kjøringen på NØYAKTIG samme tre (`34774369522`) var grønn - feilen er altså ikke innført av
PR-ens diff, som kun rører `ops/claude-worker/**` og `docs/**`.

**Rotårsak.** Postgres logget `listening on IPv6 address "::1", port 40688`, deretter
`could not bind IPv4 address "127.0.0.1": Address already in use`, og likevel
`database system is ready to accept connections`. En delvis bind-feil er ikke-fatal for postgres:
den binder IPv6 + unix-socket og melder «ready», `EmbeddedPostgres.start()` resolver, og testen som
kobler til `127.0.0.1` får ECONNREFUSED. Porten var opptatt fordi alle 117 kallsteder valgte
`30000 + random(20000)` - midt i Linux sitt efemere portintervall (typisk 32768-60999), som enhver
utgående forbindelse på runneren kan okkupere.

**Fiks (fail-closed, permanent, i repoet).** Ny delt allokator `allocateEmbeddedPostgresPort()` i
`modules/core/src/testing/embedded-postgres-port.ts` velger alltid en port strengt UNDER det efemere
intervallet (leser `/proc/sys/net/ipv4/ip_local_port_range` på Linux; konservativ fallback 32768
ellers, også trygt på Windows/macOS), og kaster heller enn å velge en utrygg port. Alle 117
kallsteder bruker den nå. D-136 ble samtidig ført i beslutningsloggen - den var implementert i kode
og README, men manglet der.

**Verifisert:** lint grønn; `pnpm -r run typecheck` grønn; claude-worker-suiten 672/672 (23 filer);
allokator-test 3/3; `node --check` grønn på alle 22 worker-runtime-filer; `git diff --check` ren;
ingen hemmeligheter i diffen.
**IKKE verifisert lokalt:** de DB-baserte suitene kjører ikke på Windows-hosten -
`scoring-service.test.ts` feiler identisk MED og UTEN endringen (hook-timeout i embedded-postgres).
Endelig bekreftelse må komme fra CI på Linux.

**Ikke gjort (bevisst):** ingen merge, ingen ny branch/PR, ingen scheduler startet
(`JarvisClaudeWorker`/`JarvisWorkerSupervisor` står fortsatt `Disabled`), ingen ad-hoc endringer i
worker-hostmappen `.jarvis-claude-worker`, ingen fabrikkert `Jarvis-Task-Id`/`Jarvis-Attempt-Id`.

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

## Herdingsrunde 3 på SAMME PR #80: D-134 (PR #80-review, REF_REVIEW_ID=5187359752)

TASK_ID `D134-PR80-PROVENANCE-CLOSEOUT-20260912-A` (kommentar 5647527873 på issue #68,
SUPERSEDES `D133-PR80-PROVENANCE-CLOSEOUT-20260911-A`). Kontrollert HEAD `86784d8`, base uendret
`c67a7ba`. ÉN gjenstående recovery-sikkerhetsblocker, lukket på SAMME branch og SAMME PR.

**Blockeren er en kategorifeil, ikke en manglende sjekk.** D-132 ga et gjenopptatt barn setningen
«HEAD ADVANCED during that attempt, so commits in that range are THIS TASK'S OWN WORK». Den
slutningen er ugyldig: `head_before != head_after` er to avlesninger av en ref på to tidspunkter -
den sier AT refen flyttet seg, aldri HVEM som flyttet den. Enhver prosess med tilgang til katalogen
kan flytte den inne i forsøksvinduet. Å ta feil i DENNE retningen er verre enn motsatt vei:
konsekvensen er at en fremmed commit adopteres som task-output og shippes i en PR. D-133 forsterket
feilen ved å beskrive den kommiterte halvdelen som «lukket» - den påstanden er nå eksplisitt RETTET
i D-133-raden i beslutningsloggen, ikke stille overskrevet.

**Rettet (nytt `lib/provenance.mjs`):**

1. To ULIKE typer attribusjon skilles. KATALOG-/DIRTY-STATE-attribusjon (D-133) er sann VED
   KONSTRUKSJON. COMMIT-forfatterskap følger IKKE av den, fordi claimen dekker katalogen og ikke
   hver skriving inn i den, og fordi en commit er et durabelt artefakt som havner i en PR.
2. POSITIVT BEVIS: forsøkets `attempt_id` (`randomUUID()`, durabel i claim og state FØR barnet
   finnes) gis KUN til det barnet, og barnet stempler hver commit med `Jarvis-Task-Id` +
   `Jarvis-Attempt-Id`. BEGGE kreves, begge med eksakt strenglikhet.
3. VERDIKTER: kun `unchanged` og `task_attributed` er VERIFISERT. `partially_attributed` (én
   uforklart commit forgifter hele spennet), `unattributed`, `diverged` (ref spolt tilbake),
   `drifted_after_attempt` og `unknown` er UVERIFISERT.
4. UVERIFISERT ER FAIL-CLOSED I BEGGE RETNINGER: arbeidet BEVARES, presenteres som UKJENT
   forfatterskap, og prompten autoriserer INGEN destruktiv rekonsiliering - den inneholder ingen
   `git stash`/`reset`/`revert`/`clean`/`--force`-instruks i det hele tatt.
5. Et lagret verdikt re-sjekkes mot worktreens FAKTISKE HEAD ved gjenopptagelse; drift eller
   uleselig HEAD DEGRADERER det. Ingen bane kan oppgradere et uverifisert spenn.
6. `observed_heads` merkes eksplisitt som observasjonslogg i kode, prompt og README. State fra en
   PRE-D134 worker leses som UVERIFISERT, aldri som forfatterskap.

**Ærlig grense, oppgitt og ikke skjult:** dette er bevis mot UVEDKOMMENDE skrivere. Det er IKKE
beskyttelse mot en bevisst forfalsker som allerede har lesetilgang til verten (`attempt_id` ligger
durabelt på disk og havner i en publisert commit-melding).

**Beholdt uendret:** isolerte per-task-worktrees, durable claims, task-eid dirty-state-recovery,
suksess-/eksplisitt-supersesjon, kanonisk terminal-status, fresh-before-retry, already-merged-
rekonsiliering, den strenge primære dirty-guarden og hele `lib/trust.mjs`.

**Kvalitetsporter for D-134 - faktisk kjørt lokalt 2026-09-12:**

- `npx vitest run ops/claude-worker/test`: **21/21 filer, 588/588 tester grønt** (fra 20/538; ingen
  eksisterende test svekket eller fjernet).
- Ny `test/provenance.test.mjs` (42 enhetstester) og ny ADVERSARIELL dekning i
  `test/worker-task-worktree.test.mjs` (16/16 grønt, 84s): en UVEDKOMMENDE SKRIVER committer inn i
  den isolerte task-worktreen MENS et forsøk kjører, synkronisert på fixturens `running`-markør.
  Bevist at neste resume ikke kaller commiten task-eid, ikke aksepterer den som task-output og ikke
  autoriserer destruktiv rekonsiliering. Dekker også blandet spenn, glemte trailere fra workerens
  EGET barn, ref spolt tilbake, og den positive motprøven.
- Den tidligere testen «a resumed attempt is told which commits are its OWN prior work»
  ASSERTERTE DEFEKTEN og er skrevet om; injeksjonen er beholdt ordrett som en tro modell av
  pre-D134-state, men den påkrevde konklusjonen er snudd.
- `npx eslint .`: 0 feil/advarsler. `pnpm -w typecheck`: grønt. `node --check` på alle endrede
  `.mjs`: OK.
- Hemmelighetsskann av full diff + begge nye filer (153 466 bytes, 10 mønstergrupper): **0 treff**.

Full detalj: **D-134** i DECISIONS_AND_ASSUMPTIONS.md.

## Herdingsrunde 4 på SAMME PR #80: D-135 (PR #80-review, REF_REVIEW_ID=5187449834)

TASK_ID `D135-PR80-PROVENANCE-FAIL-CLOSED-20260912-A` (kommentar 5647721653 på issue #68,
SUPERSEDES `D134-PR80-PROVENANCE-CLOSEOUT-20260912-A`). Kontrollert HEAD `37fafa1`, base uendret
`c67a7ba`. TO gjenstående fail-open-baner i proveniensmodellen, lukket som ÉN runde på SAMME branch
og SAMME draft-PR.

### Fail-open 1: verdiktet var bevis ingen handlet på

D-134 beregnet, logget og persisterte verdiktet - og den aller neste grenen i `worker.mjs` var
`if (completion.complete) { ...COMPLETED, successful, COMPLETION_CONFIRMED, release... }`, uten én
referanse til det. Det adversarielle tilfellet D-134 SELV satte opp endte derfor fortsatt i en ren
suksess hvis barnet OGSÅ postet en ekte, betrodd `STATUS=COMPLETE`: tasken ble `completed` OG
`successful`, `completion_confirmed` ble emittert, worktreen med den uforklarte commiten ble
FRIGITT, og recorden pensjonerte deretter strengt eldre, fortsatt gyldige tasks gjennom køens
fresh-truth-supersesjon. Tre fail-open-konsekvenser av én manglende betingelse.

**Rettet med en ren fullføringsport** (`evaluateCompletionGate`): terminal + `successful === true`
+ uverifisert proveniens (`unattributed`, `partially_attributed`, `diverged`,
`drifted_after_attempt`, `unknown`) ⇒ HOLDT. Tasken parkeres som `blocked` med `successful: false`
(eksplisitt `false`, ikke fraværende) og en durabel `completion_gate`-record; `completed_at` settes
ikke, `completion_confirmed` emitteres ikke, worktree og claim frigis ikke, exit-koden er 3 og ikke
0, og en statusnotis sier eksplisitt hva som IKKE ble gjort. **Alle fire fullføringsbanene er
portet** (`reconcileReportedTasks`, krasj-recovery, pre-dispatch-rekonsiliering, etter-dispatch) -
en port i bare én ville blitt gått rundt av neste kjøring gjennom en annen. Porten overstyrer fersk
sannhet i køen, og kun der; asymmetrien er argumentet: en holdt port kan bare gjøre en task MINDRE
vellykket, aldri mer, og kan derfor bare FORHINDRE en pensjonering. Også en eksplisitt
`SUPERSEDES=`-erklæring holdes - bevisst strengere enn D-133. Mislykkede terminalrapporter
(`BLOCKED`/`FAILED`) portes IKKE: de påstår ikke at arbeid landet, kan ikke frigi en worktree og
kan ikke skape suksess-supersesjon. Ingenting destrueres.

### Fail-open 2: >50-commit falsk-verifisering

`classifyCommitRange` hadde `for (const commit of commits.slice(0, MAX_RECORDED_COMMITS))` - ÉN
løkke som begrenset BESLUTNINGEN som bieffekt av å begrense RECORDEN. 51 commits der de 50 første
bar task-ens trailere og den 51. var fremmed ⇒ `task_attributed`, `verified: true`. Rettet ved å
skille grensene: `MAX_EXAMINED_COMMITS` (1000) begrenser hva som LESES OG KLASSIFISERES,
`MAX_RECORDED_COMMIT_DETAILS` (50) kun antall persisterte detaljrader per liste. Hver commit
klassifiseres; `*_count` er alltid FULLE tall og er det verdiktet avgjøres på; `details_truncated`
sier når listen er kuttet; `gitLogRange` ber om `limit + 1` og rapporterer `truncated` som et faktum,
og et trunkert spenn blir `unknown`.

**Beholdt uendret:** trailer-bundne ekte commits, manglende trailere, blandede spenn,
ref-drift/rewind, isolert dirty-state-resume, fremmed primær-dirt, suksess-only/eksplisitt
supersesjon, kanonisk terminal-status, already-merged-rekonsiliering, ingen duplisert branch/PR,
den strenge primære dirty-guarden og hele `lib/trust.mjs`.

**Kvalitetsporter for D-135 - faktisk kjørt lokalt 2026-09-12:**

- `npx vitest run ops/claude-worker/test`: **21/21 filer, 628/628 tester grønt** (fra 588; ingen
  eksisterende test svekket, endret eller fjernet).
- Fokuserte kjøringer: `provenance.test.mjs` 65/65 (fra 42), `queue.test.mjs` 46/46 (fra 41),
  `git.test.mjs` 17/17 (fra 13), `worker-queue-reconciliation.test.mjs` 16/16 (fra 15),
  `worker-task-worktree.test.mjs` D-135-gruppen 7/7 (76 s, ekte entrypoint + ekte git).
- **Hver ny test er kjørt som MOTPRØVE mot den gamle koden og feiler der** - ikke antatt:
  med porten deaktivert feiler 4/7 entrypoint-tester (`expected 'completed' to be 'blocked'`,
  `completion_confirmed` emittert, worktree frigitt, eldre task pensjonert); med
  køoverstyringen deaktivert feiler 2 kø-tester (`expected [ 'OLD-TASK' ] to deeply equal []`);
  med den gamle `slice`-løkken feiler 4 grensetester, deriblant nøyaktig den rapporterte defekten
  `expected 'task_attributed' to be 'partially_attributed'`. Alle motprøvene er reversert, og
  `grep TEMP-COUNTERFACTUAL` gir 0 treff.
- En KONTROLL-test (samme betrodde rapport, ingen fremmed commit) fullfører helt normalt, så suiten
  ikke kan tilfredsstilles av en worker som bare aldri fullfører noe.
- `npx eslint .`: 0 feil/advarsler (én `no-unused-vars` i ny testkode ble rettet). `node --check` på
  alle endrede `.mjs`: OK.
- Hemmelighetsskann over `ops/claude-worker/**` (7 mønstergrupper: `gh*_`, `github_pat_`, `sk-`,
  `xox*-`, private-key-header, `AKIA`, `Authorization:`): **0 treff i endret kode**. Det ene
  treffet i repoet er den uendrede sanitizer-testen i `test/health.test.mjs` med en oppdiktet verdi.
- `git status --porcelain`: kun de 11 tilsiktede filene. Ingen scratch-/hjelpe-/rapportfiler i
  repoet - alt slikt ligger i den tildelte scratch-katalogen.

Full detalj: **D-135** i DECISIONS_AND_ASSUMPTIONS.md, og C7 i `ops/claude-worker/README.md`.

## Blokkeringer

Ingen harde blockere. `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` fra oppgaven:
denne PR-en skal IKKE self-approves eller merges - uavhengig arkitektkontroll mot eksakt PR-HEAD
kreves først.

Den fulle arbeidsområde-suiten ER kjørt lokalt (to ganger) i tillegg til på CI. Resultatet, og
hvorfor de 31 lokale Windows-feilene ikke er en regresjon fra denne PR-en, står under
«Kvalitetsporter for D-133» over - ikke skjult, ikke hoppet over. D-134 og D-135 endrer ingen av de
fem berørte produkt-testfilene og berører utelukkende `ops/claude-worker/**` + `docs/**`.

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
