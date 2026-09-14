# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `claude/d145-merge-transition-provenance`, base
`main=0c803bf1c1724413dc8e8071a7aabe7fd52562e4`). Aktiv ordre: **D-145**
(`D145-MERGE-TRANSITION-PROVENANCE-20260915-A`, issue #68 kommentar 5672177452).
`MERGE_AUTHORIZED=false`, `ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false`.

PR #80 er MERGET (merge-SHA `0c803bf1`, to foreldre `c67a7ba7` + `78202147`, fersk post-merge-CI
groenn). D-139 til D-143 er dermed landet. D-144 var selve merge-closeouten; den lyktes, men
workeren parkerte den feilaktig som BLOCKED - det er defekten D-145 lukker.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Fase A - defekten D-145 lukker (ferdig, testet)

D-144 utførte en guardet merge av PR #80 og lyktes fullstendig. Workeren rapporterte likevel
`STATUS=BLOCKED` (issue #68 kommentar 5672082571) med `GATE REASON=commit_provenance_unverified`.

Årsaken er ikke en feil i proveniensmodulen. Barnet synket sin egen worktree til merge-SHA-en,
HEAD gikk fram med nøyaktig én commit - og den commiten er GENERERT AV GITHUB. Claude skrev den
aldri og kunne derfor aldri stemple `Jarvis-Attempt-Id` på den. Porten krevde bevis for noe som
aldri var sant (at Claude forfattet merge-commiten) i stedet for bevis for det som faktisk betydde
noe: at den autoriserte OVERGANGEN skjedde, og skjedde nøyaktig som autorisert.

Dette er en falsk NEGATIV, ikke en fail-open. Ingenting ble akseptert som ikke skulle vært det.

## Fase B - hva som bevises i stedet (ferdig, testet)

Ny ren modul `ops/claude-worker/lib/merge-transition.mjs`. Autorisasjonen leses KUN fra denne
taskens EGEN betrodde `ARCHITECT_TASK` på kontroll-issuet:

- eksakt `TASK_ID`, `ARCHITECT_MERGE_APPROVED=true` OG `MERGE_AUTHORIZED=true` (begge kreves),
- eksakt `PR_NUMBER`, `EXPECTED_BASE_SHA`, `EXPECTED_HEAD_SHA`, riktig `REPO`,
- `MERGE_METHOD` (når deklarert) lik `merge`.

Alt øvrig leses FERSKT fra remote (`getPullMergeState`, `getCommit`, `getCommitCheckRuns` i
`github.mjs`): `merged=true`, PR-head lik godkjent head, merge-commiten har NØYAKTIG TO foreldre
med parent 1 = godkjent base og parent 2 = godkjent head, merge-treet identisk med det godkjente
head-treet, og alle check-runs på MERGE-COMMITEN ferdige og grønne.

Parentstrukturen alene avviser squash (én forelder) og rebase - ingen påstand om metode blir trodd.
Uleselig er aldri grønn, tomt er aldri grønt, uferdig er aldri grønt.

## Fase C - innsnevringen som hindrer at dette blir en bypass (ferdig, testet)

`mergeTransitionExcusesProvenance` sier IKKE «overgangen er ok, altså er rekkevidden ok». Den
krever at MENGDEN uforklarte commits er PRESIS `{ merge-SHA }`. Porten holder derfor fortsatt ved:

- en fremmed commit ved siden av merge-commiten,
- trunkert rekkevidde (`range_truncated`) eller trunkert detaljliste (`details_truncated`),
- et antall som overstiger de navngitte,
- `diverged`, `drifted_after_attempt`, `unknown`,
- en post nedgradert av et TIDLIGERE funn,
- `null`-proveniens (D-136 uendret),
- dirty task-worktree (D-139 B uendret).

Porten får en EGEN pass-grunn, `authorized_merge_transition_verified`, som aldri forveksles med
`commit_provenance_verified`. Regelen fra D-134/D-136 står uendret: rå `head_before`/`head_after`
eller observert bevegelse er ALDRI eierskapsbevis. Alle fire fullføringsveier (post-dispatch,
krasjgjenoppretting, pre-seleksjon, pre-dispatch) bruker samme port.

## Fase D - bevis

- `merge-transition.test.mjs`: **60/60**. D-144s EKSAKTE historiske sekvens som regresjonsfikstur
  (ekte kommentar-ider, ekte SHA-er, ekte tre `484facfc`), pluss motstanderfall for feil andre-
  forelder, feil base, feil foreldrerekkefølge, squash, rebase, octopus, tre-avvik, ikke-merget PR,
  flyttet PR-head, feil PR-nummer, uleselig PR/commit/head, BLOCKED/FAILED/manglende rapport,
  feilet/uferdig/manglende/uleselig CI, feil task-binding, utrusted forfatter, PR-body som
  «autoriserer» seg selv, og alle sju innsnevringsreglene.
- `worker-merge-transition.test.mjs`: **19/19** mot EKTE git-repo og EKTE worker-entrypoint. En
  EKTE to-forelder merge-commit bygget med `commit-tree` og GitHubs committer-identitet, et EKTE
  barn som synker sin isolerte worktree til den, og en EKTE betrodd `STATUS=COMPLETE`: retireres nå
  som `successful` med `completion_confirmed` og frigjort worktree, MENS `commit_provenance`
  fortsatt sier `unattributed` med `attributed_count=0`. Samme sekvens retireres også via
  krasjgjenopprettingsveien. Alle motstanderfall er fortsatt holdt, med worktree og claim bevart.
  Positiv kontroll: en vanlig task med korrekt trailede commits fullfører fortsatt på
  `commit_provenance_verified`.
- Full `ops/claude-worker`-suite kjørt som regresjonskontroll for beskyttelsene fra PR #80:
  isolerte per-task-worktrees og durable claims, tracked+untracked dirty recovery, streng
  primær-dirty-guard, successful-only/eksplisitt supersesjon, stale/duplikat som ikke kan preempte,
  kanonisk terminalstatus, fresh-before-retry-rekkefølge, already-merged-rekonsiliasjon,
  prosess-/leie-fencing, og ingen destruktiv rekonsiliasjon.

Nøyaktige tall, lint/typecheck-resultat og CI-run-ID rapporteres i CLAUDE_REPORT på issue #68, ikke
her - en dokumentoppdatering ville flyttet HEAD og ugyldiggjort nettopp den CI-kjøringen.

## Blokkeringer

1. **Forhøyet sesjon (uendret fra D-143).** Claude Code kjører FORHØYET, og PostgreSQL nekter å
   starte under en administrator-konto, så de repo-testene som krever ekte embedded PostgreSQL kan
   ikke kjøres lokalt. Bevist å være en egenskap ved SESJONEN, ikke ved endringen. Ingen av D-145s
   endringer berører de filene - alt endret ligger i `ops/claude-worker`, som ikke bruker PostgreSQL.
   CI på Linux er den autoritative porten.
2. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-145. PR-en merges ikke
   før en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av D-145-PR-en mot faktisk diff/tester/CI på eksakt endelig HEAD.
Ingen merge uten en ny `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard.
