# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `claude/d145-merge-transition-provenance` = PR #81, base
`main=0c803bf1c1724413dc8e8071a7aabe7fd52562e4`). Aktiv ordre: **D-146**
(`D146-PR81-POSTMERGE-EVIDENCE-GATE-20260915-A`, issue #68 kommentar 5672478071,
`SUPERSEDES=D145-...`). `MERGE_AUTHORIZED=false`, `ARCHITECT_MERGE_APPROVED=false`,
`SELF_APPROVAL=false`.

PR #80 er MERGET (merge-SHA `0c803bf1`). PR #81 er AAPEN og DRAFT og inneholder D-145 + D-146.
D-146 lukker de to fail-open-hullene den uavhengige exact-head-gjennomgangen (review 5204049777)
fant i D-145s post-merge-bevis.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Hull 1 - «en grønn check er ikke en påkrevd check» (ferdig, testet)

`classifyPostMergeChecks` godtok HVILKE SOM HELST check-runs remoten returnerte og spurte aldri
hvilke som var PÅKREVD. Én urelatert grønn check passerte mens `build-test` manglet, og
`neutral`/`skipped` lå på listen over akseptable konklusjoner.

Påkrevd sett løses nå fra BETRODD POLICY i synkende autoritet: taskens egen `ARCHITECT_TASK`
(`REQUIRED_POST_MERGE_CHECKS=`) → workerens `config.json` → repoets faktiske CI-jobber
(`build-test`, `windows-git-auth`, `gitleaks`). Aldri fra PR-tekst, branch-navn, CI-logger eller
barnets rapport. Hvert navn må finnes NØYAKTIG ÉN GANG med `status=completed` og
`conclusion=success`; manglende, duplisert, uferdig, `neutral`, `skipped`, `cancelled` og `failed`
feiler alle lukket. En check UTENFOR settet kan aldri erstatte én innenfor - extras har egen
eksplisitt policy (`ignore` / `must_not_fail` / `forbid`) som bare kan gjøre svaret verre.

## Hull 2 - «rapporten bidro ingenting» (ferdig, testet)

Verifiseringen tok bare `complete`/`successful`. Et barn kunne poste `STATUS=COMPLETE` FØR det
synket sin checkout til mergen, eller med skitten worktree, og bli godtatt når remote-CI ble grønn.

Den EKSAKTE betrodde terminalrapporten completion assessment valgte bindes nå felt for felt:
`TASK_ID`, `STATUS`, `PR_NUMBER`, `EXPECTED_BASE_SHA`, `EXPECTED_HEAD_SHA`, `MERGED`, `MERGE_SHA`,
`PARENT_1`/`PARENT_2`, `TWO_PARENT_MERGE_VERIFIED`, `POST_MERGE_CI_RUN`, de tre `POST_MERGE_*`
kryssjekket mot FERSKE remote-checks, `LOCAL_HEAD`, `ORIGIN_MAIN`, `WORKTREE_CLEAN=true`,
`SELF_APPROVAL=false`, `HARD_EXTERNAL_BLOCKER=false`. `reportBody` og `reportCommentId` reiser
sammen ut av `assessCompletion`, så ingen kaller kan pare én tasks verdikt med en annen tasks tekst.
`readAllFields` beholder ALLE forekomster - et duplisert felt er tvetydig enten verdiene er enige
eller ikke, og tvetydighet er ikke bevis.

**Skillet holdes strengt:** rapporten beviser fortsatt INGENTING om remoten. All D-145 fersk
remote-verifisering står uendret; rapportens påstander om remoten blir bare KRYSSJEKKET, og uenighet
feiler lukket. Det rapporten alene beviser er den LOKALE halvdelen (`LOCAL_HEAD`, `ORIGIN_MAIN`,
`WORKTREE_CLEAN`), som workeren ikke kan reobservere etter at barnet har avsluttet. De tre er merket
`evidence: "local"` og surfaces som `report_local_evidence_fields` på hvert resultat.

## Skjema og innsnevring (ferdig, testet)

Fremtidige betrodde merge-tasks deklarerer `REQUIRED_POST_MERGE_CHECKS=`,
`EXTRA_POST_MERGE_CHECKS=`, `POST_MERGE_EVIDENCE_PROFILE=` og `REQUIRED_CLOSEOUT_FIELDS=`
(`KEY:rule[:binding]`). For lite policy til å avgjøre er en NAVNGITT avvisning, aldri tilbakefall
til «godta hvilken som helst grønn check». Deklarerte felt kan kun LEGGE TIL, aldri svekke.

D-145s innsnevring er uendret: en verifisert overgang unnskylder fortsatt NØYAKTIG den ene
uavhengig verifiserte GitHub-merge-commiten. Vanlige uforklarte commits, `null`/trunkert/`drifted`/
`diverged` proveniens, tidligere verre funn og skitne/ukjente task-worktrees feiler fortsatt lukket.

## Sidefunn - en ekte bug

`lib/merge-transition.mjs` manglet i deploy-`PAYLOAD`, så en DEPLOYET worker ville krasjet på uløst
import. Det er nettopp denne ESM-closure-testen som var RØD i CI på `b168f829`. Den og
`lib/postmerge-evidence.mjs` er lagt inn.

## Bevis

- `postmerge-evidence.test.mjs` **60/60**, `merge-transition.test.mjs` **62/62**.
- `worker-merge-transition.test.mjs` **38/38** mot EKTE git-repo og EKTE worker-entrypoint:
  kun-urelatert-grønn-check, manglende påkrevd check, duplisert navn (også når begge er grønne),
  `neutral`/`skipped`, uferdig, tomt påkrevd sett, rapport uten lokal sync, `LOCAL_HEAD`/
  `ORIGIN_MAIN`-avvik, skitten rapport, `MERGE_SHA`/PR/task-avvik, rapport lånt fra en annen task,
  motstridende og enige duplikater, og remote-CI som motsier rapporten.
- Positiv kontroll: D-144s historiske fikstur retireres fortsatt, men KUN når de eksakte påkrevde
  remote-checkene OG hvert bundet lokalt closeout-felt holder. Den D-145-formede rapporten
  (kun `STATUS`) passerer ikke lenger.
- Hele `ops/claude-worker`-suiten **852/852**; lint og rekursiv typecheck grønne; `node --check` på
  alle endrede filer.

## Blokkeringer

1. **Forhøyet sesjon (uendret fra D-143/D-145).** Claude Code kjører FORHØYET, og PostgreSQL nekter
   å starte under en administrator-konto. Lokalt feiler dessuten 31 tester i 5 filer utenfor
   `ops/claude-worker` på den pre-eksisterende Windows-`.cjs`-spawn-klassen (`EFTYPE`), og 2
   `ops`-testfiler kan ikke PARSES av vitest lokalt fordi de importerer en shebang-`.mjs`-CLI.
   Begge klassene er uavhengige av denne endringen (filene er urørte) og er GRØNNE på Linux-CI.
   CI på Linux er den autoritative porten.
2. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-146. PR #81 merges
   ikke før en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av PR #81 mot faktisk diff/tester/CI på eksakt NYTT endelig HEAD.
Ingen merge uten en ny `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard.
