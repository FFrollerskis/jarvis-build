# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `claude/d145-merge-transition-provenance` = PR #81, base
`main=0c803bf1c1724413dc8e8071a7aabe7fd52562e4`). Aktiv ordre: **D-147**
(`D147-PR81-MERGE-GATE-NO-PROVENANCE-BYPASS-20260915-A`, issue #68 kommentar 5673481484,
`SUPERSEDES=D146-...`, `REF_REVIEW_ID=5204693024`). `MERGE_AUTHORIZED=false`,
`ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false`.

PR #80 er MERGET (merge-SHA `0c803bf1`). PR #81 er AAPEN og DRAFT og inneholder D-145 + D-146 +
D-147. D-147 lukker den gjenvaerende INTEGRASJONS-bypassen i D-146: bevisene var riktige, men
workeren spurte aldri etter dem naar den generiske commit-proveniensen tilfeldigvis verifiserte.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Defekten (ferdig, testet)

D-145/D-146 bygget et fullstendig merge-bevis og koblet det inn som et TILBAKEFALL: overgangen ble
kun verifisert naar commit-proveniensen allerede hadde feilet
(`if (!isVerifiedVerdict(...) || verified !== true)`, duplisert paa fire fullføringssteder).

Hele beviset var dermed hoppbart, og å hoppe over det krevde ingen angrep. Gi SAMME betrodde
merge-ordre et barn som stempler ÉN vanlig commit korrekt - eller som aldri flytter HEAD - så er
rekkevidden `task_attributed`/`unchanged` og VERIFISERT. Tilbakefalls-betingelsen er usann,
`verifyMergeTransition` kalles aldri, ingen PR leses, ingen påkrevd check inspiseres, ingen
closeout-rapport bindes, og tasken retireres som `commit_provenance_verified` - etter å ha bevist
bare at Claude skrev Claudes egne commits. En merge-tasks leveranse er en TILSTANDSOVERGANG PÅ
REMOTEN, som Claude verken forfatter eller kan trailere; commit-forfatterskap er ikke bevis om den.

## Rettelsen (ferdig, testet)

**Klassifisering før proveniens.** `classifyMergeAuthorization` avgjør «er dette en merge-task?»
fra taskens EGEN betrodde `ARCHITECT_TASK` og ingenting annet. Tre svar:

- `NONE` - ingen merge påstått. Den vanlige veien, uendret, og den koster fortsatt NULL remote-kall.
- `AUTHORIZED` - begge flagg, eksakt PR/base/head, kjent metode, riktig repo, og en post-merge-policy
  som løser seg. Fersk overgangsverifisering er da OBLIGATORISK uansett hva proveniensen sier.
- `UNDECIDABLE` - en merge er PÅSTÅTT men kravet kan ikke avgjøres. Halv autorisasjon
  (`ARCHITECT_MERGE_APPROVED=true` med `MERGE_AUTHORIZED=false`) ga før D-147 nøyaktig samme funn som
  «ingen merge påstått», så den falt ned i den billige veien. Nå er den et eget navngitt
  fail-closed-avslag, og det samme gjelder manglende PR/base/head, ukjent metode, feil repo og et
  tomt påkrevd check-sett.

**To nye portutfall.** `HELD_MERGE_AUTHORIZATION_UNDECIDABLE` (evalueres FØRST, så ingen nedstrøms
bevis kan snakke porten bort fra en uleselig ordre) og `HELD_MERGE_TRANSITION_UNVERIFIED` (en
merge-autorisert task uten verifisert overgang holdes selv med en perfekt commit-rekkevidde bak seg).
`PASSED_PROVENANCE_VERIFIED` er dermed UOPPNÅELIG for en merge-autorisert task ved konstruksjon.

**Én semantisk beslutning.** De fire `if`-ene er borte. `completionEvidenceFor` er det ENESTE stedet
som avgjør om en task skyldte et overgangsbevis, og både dispatch-veien og de tre
rekonsiliasjonsveiene går gjennom den. En betingelse duplisert på fire steder er fire sjanser til å
drive fra hverandre.

**D-145s innsnevring er urørt.** En verifisert overgang unnskylder fortsatt NØYAKTIG den ene
uavhengig verifiserte GitHub-merge-commiten. D-136 (`null`-proveniens holder), D-139 B (skitten
worktree holder) og D-134/D-136 (rå HEAD-bevegelse er aldri eierskapsbevis) står uendret.

## Bevis

- `merge-authorization-gate.test.mjs` **30/30** - klassifiseringens tre svar, utrusted forfatter,
  feil task-id, alle fire halv-flagg-kombinasjoner, manglende PR/base/head, tomt check-sett, feil
  metode, feil repo, pluss portens nye utfall og alle uendrede D-136/D-139 B/D-145-grener.
- `worker-merge-gate.test.mjs` **45/45** mot EKTE git-repo og EKTE worker-entrypoint, med en NY
  fikstur: en merge-autorisert task hvis barn gjør ÉN korrekt trailet commit, så `commit_provenance`
  er `task_attributed` og `verified=true` (asserted FØR bruk). Mot den fiksturen er ikke-merget PR,
  halv autorisasjon, manglende `EXPECTED_HEAD_SHA`, tomt påkrevd sett, kun urelatert grønn check,
  manglende/duplisert/uferdig/`neutral`/`skipped`/`cancelled`/`failure` påkrevd check, ingen checks,
  bakvendte foreldre, squash, flyttet PR-head, rapport uten closeout-bevis, `MERGE_SHA`/`PARENT_1`/
  `PARENT_2`/`EXPECTED_BASE_SHA`/`EXPECTED_HEAD_SHA`/PR-avvik, `LOCAL_HEAD`/`ORIGIN_MAIN`-avvik,
  `WORKTREE_CLEAN` falsk/manglende/duplisert, `SELF_APPROVAL=true` og rapport-CI som motsier remote
  ALLE fortsatt BLOCKED, uten `completion_confirmed`, med worktree og claim bevart.
- Samme obligatoriske port kjørt gjennom post-dispatch, krasjgjenoppretting og
  pre-seleksjons-rekonsiliasjon via prosess-entrypointet, og gjennom pre-dispatch-stedet ved å kalle
  nøyaktig den delte funksjonen det stedet kaller. Det stedet er en BACKSTOP som pre-seleksjonspasset
  alltid foregriper når begge ser samme kommentarer, så det kan ikke nås ved å kjøre prosessen - det
  står eksplisitt i testen i stedet for å bli stilltiende udekket.
- Positive kontroller: (a) en vanlig ikke-merge-task med verifisert proveniens og ren worktree
  fullfører fortsatt på `commit_provenance_verified` og koster NULL overgangslesninger (bevist fra en
  ny `api.log` i `fake-gh`, ikke antatt); (b) en merge-autorisert task med verifisert proveniens
  fullfører KUN når hele overgangen, de eksakte påkrevde checkene og den bundne rapporten holder;
  (c) D-144s eksisterende ikke-attribuerte enkelt-merge-fikstur retireres fortsatt gjennom den smale
  unnskyldningen (`worker-merge-transition.test.mjs` 38/38 uendret). En UAVGJØRBAR ordre koster
  dessuten NULL remote-kall - den feiler lukket før nettverket.

## Blokkeringer

1. **Forhøyet sesjon (uendret fra D-143/D-145/D-146).** Claude Code kjører FORHØYET, og PostgreSQL
   nekter å starte under en administrator-konto. Lokalt feiler dessuten tester utenfor
   `ops/claude-worker` på den pre-eksisterende Windows-`.cjs`-spawn-klassen (`EFTYPE`), og enkelte
   `ops`-testfiler kan ikke PARSES av vitest lokalt fordi de importerer en shebang-`.mjs`-CLI.
   Begge klassene er uavhengige av denne endringen og er GRØNNE på Linux-CI, som er den autoritative
   porten. D-147 unngår den siste klassen bevisst: pre-dispatch-proben kaller `worker.mjs` i en egen
   node-prosess i stedet for å importere den inn i vitest.
2. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-147. PR #81 merges
   ikke før en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av PR #81 mot faktisk diff/tester/CI på eksakt NYTT endelig HEAD.
Ingen merge uten en ny `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard.
