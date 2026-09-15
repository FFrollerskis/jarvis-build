# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `claude/d145-merge-transition-provenance` = PR #81, base
`main=0c803bf1c1724413dc8e8071a7aabe7fd52562e4`). Aktiv ordre: **D-148**
(`D148-PR81-IMMUTABLE-MERGE-AUTHORITY-20260915-A`, issue #68 kommentar 5674178693,
`SUPERSEDES=D147-...`, `REF_REVIEW_ID=5205163513`). `MERGE_AUTHORIZED=false`,
`ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false`.

PR #80 er MERGET (merge-SHA `0c803bf1`). PR #81 er ÅPEN og DRAFT og inneholder D-145 + D-146 +
D-147 + D-148. D-148 lukker det gjenværende merge-autoritets-hullet: én TASK_ID skal ha ÉN
uforanderlig original `ARCHITECT_TASK`-autoritet.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Defekten (ferdig, testet)

D-147 stilte riktig spørsmål til feil input. Autorisasjonen ble lest ut av «denne taskens betrodde
ordrer» - FLERTALL - ved at `findMergeAuthorization` skannet kommentarlisten og returnerte den
FØRSTE som parset.

Et framoverskann etter en kandidat som passerer er ikke en autoritetsregel. Det gjør merge-autoritet
MUTABEL for enhver som kan poste en `ARCHITECT_TASK` under den betrodde loginen - og det dispatchede
barnet ER en slik aktør: det poster sin egen CLAUDE_ACK og CLAUDE_REPORT gjennom `gh` autentisert som
repo-eieren, som er nøyaktig den loginen workeren stoler på.

Konkret: gi et barn en VANLIG ordre, la det poste en andre `ARCHITECT_TASK` med sin EGEN `TASK_ID`
pluss `ARCHITECT_MERGE_APPROVED=true`/`MERGE_AUTHORIZED=true`, og skannet fant den. Tasken ble
merge-autorisert på styrken av en kommentar barnet selv skrev, og alle nedstrøms porter verifiserte
deretter lydig det DEN ordren sa. Forfatter-sjekken kan ikke se forskjell: det er samme konto. En
forfatter-sjekk er ikke en ROLLEGRENSE når begge roller deler login. Array-rekkefølgen var dessuten
en input, og `gh api --paginate` lover ingen rekkefølge.

## Rettelsen (ferdig, testet)

**Et ANTALL, ikke et valg.** `selectCanonicalArchitectTask` bygger kandidatmengden ved filtrering
(betrodd forfatter + `ARCHITECT_TASK`-header + EKSAKT samme `TASK_ID`) og avgjør på mengdens
STØRRELSE:

- **0** - ingen ordre binder tasken (`NONE`, vanlig task, uendret billig vei).
- **1** - den kommentaren ER autoriteten, og kan ikke være noe annet.
- **≥ 2** - `AMBIGUOUS_AUTHORITY`. Avvist, i alle retninger.

Ingen `find`, ingen `[0]`, ingen sortering, ingen tidlig retur over kommentarlisten. En mengdes
størrelse er den samme uansett hvordan mengden ble enumerert, så ARRAY-REKKEFØLGE KAN IKKE NÅ
BESLUTNINGEN - derfor kjøres hver flerordre-test i BEGGE retninger. En duplikat kan ikke lenger gi,
reparere, utvide eller erstatte autoritet; den kan bare gjøre spørsmålet uavgjørbart, og uavgjørbart
feiler LUKKET. `TASK_UPDATE`, CLAUDE_ACK/REPORT, worker-statusnotiser, PR-tekst og review-tekst har
ingen kodesti inn i autoriteten i det hele tatt.

**Det ene som kollapses.** Identisk `id` + identisk `body` + identisk `created_at` er ÉN kommentar
(overlappende `--paginate`-side) - ellers ville en korrekt task feilet lukket på en transport-artefakt.
Én `id` med ULIKT innhold kollapses aldri; kommentarer uten brukbar id telles hver for seg.

**Prisen, bevisst valgt.** Også en VANLIG task blir uavgjørbar hvis en andre same-id-ordre dukker opp.
Workeren kan ikke skille «arkitekten postet en scope-oppdatering» fra «barnet forfalsket en ordre» -
samme login, samme form. Å avvise er gjenopprettelig (utsted en FRISK `TASK_ID`); å godta er det ikke.
Framtidige scope-endringer må derfor gå i en frisk `TASK_ID`.

**Tillegg ut over ordrens bokstav (flagget for arkitekten).** En REDIGERT kanonisk ordre (`created_at`
og `updated_at` begge til stede og ulike) er også `UNDECIDABLE` (`AUTHORITY_COMMENT_EDITED`): den som
kan poste som den betrodde loginen kan også redigere som den, så en redigering som la til de to
merge-flaggene ville omgått antalls-regelen i ett API-kall. Regelen er konservativ og identisk med den
`validateControlCommand` allerede bruker. Konsekvens arkitekten kan overstyre: en rettet skrivefeil i
en ordre holder den taskens fullføring, med samme frisk-id-remedie.

**D-145/D-146/D-147 er uendret.** Én unik gyldig merge-ordre krever fortsatt fersk
overgangsverifisering + eksakt påkrevd post-merge-CI + eksakt bundet closeout-rapport. Én unik vanlig
ordre tar fortsatt den billige veien. Den smale D-145-unnskyldningen er urørt.
`HELD_MERGE_AUTHORIZATION_UNDECIDABLE` evalueres FØRST, så tvetydig autoritet holder FØR proveniens
kan slippe den forbi, og koster NULL overgangslesninger. Porten bærer nå også
`merge_authority_comment_id`, `merge_authority_candidate_count` og
`merge_authority_duplicate_comment_ids`.

## Bevis

- `merge-authority-immutability.test.mjs` **32/32** - hele akseptansematrisen (a)-(f) i BEGGE
  array-retninger: vanlig original + senere autoriserende duplikat; brukket original + senere
  autoriserende; autorisert original + senere false/false; autorisert original + senere
  brukket/motstridende; to distinkte, identisk formulerte autoriserte ordrer; duplikate ider,
  like/manglende/ugyldige `created_at`, og hver rotasjon av en omstokket paginerings-samling. Pluss:
  ekte pagineringsgjentakelse kollapses, én id med to kropper gjør det ikke, utrusted forfatter kan
  ikke skape tvetydighet (ellers er én kommentar en DoS mot køen), annen task-id teller ikke,
  rapporter/acks/statusnotiser/PR-tekst er ikke ordrer, same-id `TASK_UPDATE` avvises som den andre
  ordren den er, redigeringsregelen i begge retninger, og positive kontroller for én ordre.
- `worker-merge-authority.test.mjs` **16/16** mot EKTE git-repo og EKTE worker-entrypoint, med ny
  fikstur `JARVIS_FAKE_CLAUDE_FORGE_ORDER`: barnet poster FAKTISK en andre `ARCHITECT_TASK` for sin
  egen task-id under den betrodde loginen. Med verifisert proveniens, ren worktree, ekte
  to-forelder-merge på remoten og alle tre påkrevde checks grønne forblir fullføringen HOLDT, uten
  `completion_confirmed`, med worktree og claim bevart, og med NULL overgangslesninger (bevist fra
  `api.log`, ikke antatt).
- Samme refusjon gjennom post-dispatch, krasjgjenoppretting, pre-seleksjons-rekonsiliasjon og
  pre-dispatch-backstoppen - sistnevnte også i REVERSERT kommentarrekkefølge.
- Positive kontroller: (a) én vanlig ordre fullfører normalt og koster null overgangslesninger;
  (b) én gyldig merge-ordre fullfører KUN med hele D-145..D-147-beviset, og holdes fortsatt på
  `HELD_MERGE_TRANSITION_UNVERIFIED` når ett remote-faktum er galt; (c) D-144s smale ikke-attribuerte
  enkelt-merge-unnskyldning er uendret, men forsvinner når autoriteten er duplisert; og en
  overlappende pagineringsside ser IKKE ut som et duplikat.
- D-147s egen test «en velformet ordre vinner over en brukket tvilling» er eksplisitt ERSTATTET -
  den regelen VAR hullet.

## Blokkeringer

1. **Forhøyet sesjon (uendret fra D-143/D-145/D-146/D-147).** Claude Code kjører FORHØYET, og
   PostgreSQL nekter å starte under en administrator-konto. Lokalt feiler dessuten tester utenfor
   `ops/claude-worker` på den pre-eksisterende Windows-`.cjs`-spawn-klassen (`EFTYPE`), og enkelte
   `ops`-testfiler kan ikke PARSES av vitest lokalt fordi de importerer en shebang-`.mjs`-CLI.
   Begge klassene er uavhengige av denne endringen og er GRØNNE på Linux-CI, som er den autoritative
   porten. D-148 unngår den siste klassen bevisst: pre-dispatch-proben kjører `worker.mjs` i en egen
   node-prosess i stedet for å importere den inn i vitest.
2. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-148. PR #81 merges
   ikke før en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.

## Restfunn, ikke lukket (krever arkitekt-beslutning)

`declaredExpectedHead` og `declaredSupersedes` i `ops/claude-worker/lib/queue.mjs` leser fortsatt
same-id «scope-oppdateringer» med SIST-VINNER-semantikk. En forfalsket duplikat kan derfor i prinsippet
re-peke `EXPECTED_HEAD_SHA` eller erklære `SUPERSEDES` mot en annen task. Dette er KØ-/seleksjons-
semantikk og ikke merge-autorisasjon, og det står utenfor D-148s fire punkter; å endre det ville endre
dispatch-oppførselen bredt. Rapportert til arkitekten, ikke endret her.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av PR #81 mot faktisk diff/tester/CI på eksakt NYTT endelig HEAD.
Ingen merge uten en ny `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard.
