# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `claude/d145-merge-transition-provenance` = PR #81, base
`main=0c803bf1c1724413dc8e8071a7aabe7fd52562e4`). Aktiv ordre: **D-151**
(`D151-PR81-ATOMIC-AUTHORITY-SNAPSHOT-20260915-A`, issue #68 kommentar 5677099821,
`SUPERSEDES=D150-PR81-IMMUTABLE-EFFECTIVE-ORDER-20260915-A`, `ARCHITECT_REVIEW_ID=5207453857`).
`MERGE_AUTHORIZED=false`, `ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false`.

PR #80 er MERGET (merge-SHA `0c803bf1`). PR #81 er ÅPEN og DRAFT og inneholder D-145 + D-146 + D-147
+ D-148 + D-149 + D-150 + D-151 som én sammenhengende kontrollplan-leveranse. D-151 flytter
autoritetsspørsmålet fra dispatch-øyeblikket til toppen av hele syklusen: en worker-syklus avgjør fra
ETT komplett, uforanderlig snapshot - eller den avgjør ingenting.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Defekten (ferdig, testet)

D-150 bygget `selectAdmissibleOrder` og regelen «en admittert task eksekverer nøyaktig ÉN uforanderlig,
fullstendig lest, unikt identifisert ordre». Regelen er riktig. Men porten ble spurt ÉN gang, SENT -
inne i `runTask`, for den ENE tasken køen allerede hadde valgt - mens alt foran den fortsatt kjørte på
en ubevist lesning og på en autoritet avgjort en andre, svakere vei. Fire sømmer, alle verifisert i
koden på `67b30849`:

1. **INKOMPLETT LESNING VAR FORTSATT BARE EN ADVARSEL ØVERST I KJØRINGEN.** `worker.mjs` logget
   «WARNING: the control issue read is INCOMPLETE» og gikk rett videre inn i `recoverAbandonedTasks`,
   `collectTrustedTasks`, `reconcileReportedTasks`, `selectNextTask`, `retireIneligibleTasks` og
   `runTask`. Krasj-recovery-retirering, rapport-rekonsiliasjon, SUPERSEDED-retirering og hver
   `persistState` på den stien ble altså avgjort fra et snapshot med hull i - og hver eneste av dem er
   TERMINAL og lener seg på at noe er FRAVÆRENDE. Bare det aller siste steget, dispatch, refuserte.
2. **AUTORITETEN BLE AVGJORT TO GANGER, OG DEN TIDLIGE AVGJØREREN VAR DEN SVAKE.**
   `collectTrustedTasks` regnet ut sin egen `uniqueAuthority = distinctOrderCount === 1` og valgte
   `comment: ordered[0]` på ARRAY-POSISJON. Den representanten var det `queue.mjs` leste `createdMs`/
   `commentId` fra når den rangerte og beviste retning, og den boolean visste ingenting om lesningens
   kompletthet, om redigeringssjekken, om comment-id-en eller om `created_at`.
3. **SEMANTISKE FELT FRA EN INADMISSIBEL ORDRE FLYTTET FORTSATT STATE.** `declaredExpectedHead` og
   `declaredSupersedes` portet kun på `uniqueAuthority`. En UNIK men REDIGERT ordre deklarerte derfor
   fortsatt `SUPERSEDES=` og retirerte et offer PERMANENT; en unik ordre med uparsbar `created_at`
   eller uten brukbar comment-id fikk `createdMs = 0`/`commentId = 0`, sorterte FORREST i fresh-tieren
   og preemptet en levende ordre med sin `EXPECTED_HEAD_SHA`. Alle tre ble refusert av
   `selectAdmissibleOrder` - etter at retireringen allerede var persistert.
4. **TVETYDIGHET BLE LØST VED Å VELGE.** `queue.mjs:390` beholdt den FØRSTE deklarasjonen per offer
   (`// first (oldest) declaration wins`) og forkastet resten, og det persisterte beviset var én
   comment-id uten digest - så en durabel destruktiv retirering kunne ikke knyttes til bytene som
   beordret den.

## Rettelsen (ferdig, testet)

**Ett atomisk snapshot, tatt øverst, klassifisert én gang.** Ny ren modul `lib/authority-snapshot.mjs`
(`captureAuthoritySnapshot`), kjørt i `runOwned` rett etter auth- og lesebeviset og FØR enhver
beslutning.

| lesning | funn | resultat |
| --- | --- | --- |
| kastet/`ok:false` | `READ_FAILED` | hele syklusen HOLDES, exit 4 (TRANSIENT) |
| `complete:false` | `READ_INCOMPLETE` | hele syklusen HOLDES, exit 4 |
| bar array / `complete` aldri satt | `READ_UNPROVEN` | hele syklusen HOLDES, exit 4 |
| `ok:true` + `complete:true` | `USABLE` | hver task-id klassifiseres ÉN gang, dommen reiser med |

En holdt syklus gjør INGENTING: ingen recovery-beslutning, ingen kø-seleksjon, ingen
rapport-retirering, ingen supersession, ingen task-state-mutasjon, ingen worktree-/scratch-/
repo-handling, ingen transition-API-lesning, ingen prompt og ingen barneprosess. Hver eksisterende
task, claim og worktree står byte-for-byte som før.

**`collectTrustedTasks` avgjør ingenting lenger.** Den grupperer og teller
(`{ taskId, candidates, distinctOrderCount }`). `uniqueAuthority` og den array-posisjonsvalgte
`comment` er FJERNET, ikke bare omgått - det finnes ikke lenger noe felt et framtidig kall kan lese en
autoritet ut av. `runTask` sjekker den MEDBRAGTE dommen (`candidate.authority`); en entry uten dom er
aldri admissibel, fordi «ikke klassifisert» aldri er «godkjent».

**En inadmissibel ordre bidrar med ingenting semantisk - strukturelt.** En refusert entry bærer
`order: null` og `comment: null`, så `EXPECTED_HEAD_SHA`, `SUPERSEDES`, rangeringsposisjon, egnethet
og eksekverbar kropp er utilgjengelige: den feiler lukket AV KONSTRUKSJON, ikke ved at noen husker å
sjekke et flagg. Kandidat-ID-ene beholdes (en refusjon ingen kan gå og se på er ikke reviderbar), men
id-er er ikke semantikk. Refusjonen får sin egen grunn (`INELIGIBLE.INADMISSIBLE_AUTHORITY`),
rapporteres og retireres FØR seleksjonen, og tar ingen plass i rangeringen.

**Uprovbar utstedelsesrekkefølge retirerer ingenting.** `issuePositionOf` krever BÅDE parsbar
`created_at` OG brukbar comment-id fra den ADMITTERTE ordren; `strictlyOlder` returnerer `false` når
en posisjon mangler. Den gamle `0`-koersjonen gjorde en ordre uten ordningsmetadata eldre enn alt som
noensinne er utstedt - og «strengt eldre» er hele det retningsbestemte argumentet for å retirere.

**Supersession som durabel destruktiv beslutning.** `selectNextTask` tar nå `snapshotComplete`
(tri-state, default `null`), og BÅDE den eksplisitte og den suksess-baserte basisen krever `true`. En
retirering krever i tillegg en ADMISSIBEL deklarerende ordre og et ADMISSIBELT offer med provbar
posisjon. Ingenting velges: HVER admissibel deklarasjon registreres i `superseded_declarations` med
`task_id`, `comment_id`, `created_at`, `body_sha256` og `body_bytes`, sammen med
`superseded_snapshot_complete`. Alle refusjoner beholdes som `supersessionProposals` med navngitt
grunn, så en foreslått retirering kan forhåndsvises UTEN å mutere noe.

**`dry-run` viser det samme, og muterer ingenting.** Nye felt: `snapshot_usable`/`snapshot_reason`/
`control_comments_complete`/`control_comment_count`, `order_authority` (HVER ordres dom),
`supersession_preview` (offer, deklarerende task, admissibel ja/nei, grunn, comment-id og digest) og
`inadmissible_authority`. `next_candidate_order_authority` leses fra snapshotet som valgte kandidaten
i stedet for å utledes på nytt. En ubevist lesning gir `would_exit: TRANSIENT` og INGEN kø, kandidat
eller retirering.

**Ingenting av D-145..D-150 er svekket.** Strenge dirty-/proveniens-/isolasjonsporter, den
uforanderlige original-ordre-bindingen, obligatorisk merge-overgangsverifisering uansett proveniens,
eksakte påkrevde CI-identiteter, eksakt bundet closeout-rapport, den smale enkelt-merge-commit-
unnskyldelsen og «ingen self-approval» står uendret. D-150s promptgrense er uendret. ENDRET
RAPPORTERING (bevisst, og strengere): en inkomplett/feilet lesning var i D-150 en PER-TASK hold med
`task_id` og exit 3; den er nå en HEL-SYKLUS hold med exit 4 og health-grunn
`control_authority_snapshot_unusable`, fordi den ikke lenger inntreffer etter at recovery,
rekonsiliasjon og retirering allerede har kjørt. De tilhørende D-150-testene er oppdatert til den nye,
sterkere oppførselen - ingen dekning er fjernet.

## Bevis

- `authority-snapshot.test.mjs` **22/22** - feilet/inkomplett/avkortet/ubevist/bar-array/ingenting;
  hver task-id klassifisert, ikke bare den som spørres om; admissibel entry bærer ordren og dens
  identitet; duplikat/redigert/uten-id/uten-`created_at` bærer `order: null`, `comment: null`,
  `orderCommentId: null`; kandidat-id-er beholdt; identisk pagineringskopi er ÉN ordre; utrusted
  forfatter er ikke i snapshotet; én refusert id påvirker ikke en annen; snapshot, kommentarliste og
  entries er FROSNE og tåler ikke mutasjon; mutasjon av kallerens array etterpå endrer ingenting;
  bevis og beskrivelse bærer aldri ordretekst.
- `worker-authority-snapshot.test.mjs` **22/22** mot EKTE git-repo og EKTE `worker.mjs run`, med ny
  fikstur `fail.json { commentsOmit: [<id>] }` som mister en side som FAKTISK inneholdt noe - den
  farlige formen, der det som kommer tilbake er et perfekt selvkonsistent sett som sier noe USANT.
  Inkomplett lesning som skjuler en SENERE same-id-duplikat, inkomplett lesning som skjuler en
  TIDLIGERE, avkortet side som etterlater én tilsynelatende unik ordre, og lesefeil etter state-load:
  alle med bevist NULL barn, NULL prompt-bytes, NULL worktree, NULL claim, NULL overgangs-API-
  lesninger, NULL `completion_confirmed`, NULL supersession, byte-for-byte uendret `state.json` og
  exit 4. En holdt syklus gjør heller INGEN krasj-recovery og lar en abandonert IN_PROGRESS-task stå.
  Samme kø går normalt igjennom når lesningen er hel (ingen attempt brukt).
- Destruktivt: et seedet eldre, kjørbart offer + en nyere REDIGERT / ID-løs / `created_at`-løs /
  DUPLISERT deklarerende task lar offeret stå BYTE-FOR-BYTE uendret, uten supersession-event, uten
  worktree/claim/prompt/barn og uten overgangslesning, mens den deklarerende tasken blir terminalt
  BLOCKED uten binding. Offeret KJØRER deretter normalt, så en refusert deklarasjon koster det
  ingenting. `EXPECTED_HEAD_SHA` fra en ordre uten ordningsmetadata preempter ikke lenger: den
  admissible ordren kjører, den uordnede blir BLOCKED.
- Positive kontroller: komplett snapshot med én admissibel ordre dispatcher EKSAKT sine bundne bytes;
  identisk overlappende pagineringskopi gir ingen falsk tvetydighet; en admissibel fersk ordre
  superseder et eldre task MED persistert comment-id OG digest; en ELDRE admissibel deklarasjon kan
  fortsatt ikke retirere en NYERE task; `dry-run` viser snapshot-kompletthet, hver ordres dom og en
  admissibel supersession-forhåndsvisning UTEN å mutere noe; body-drift er fortsatt en
  uforanderlig-binding-refusjon (D-149 uendret).
- `queue.test.mjs` **50/50**, `queue-head-staleness.test.mjs` **22/22**, `trust.test.mjs`,
  `admission-order-authority.test.mjs` og `dispatch.test.mjs` oppdatert til den nye entry-formen.
  Kø-testene bygger nå entries gjennom den EKTE klassifisereren (`test/fixtures/authority-entries.mjs`)
  i stedet for å håndlage `{ uniqueAuthority: true }` - som var å asserte mot en form produksjonen
  aldri produserte, og som pre-deklarerte nøyaktig den boolean D-151 fjerner.

## Blokkeringer

1. **Forhøyet sesjon (uendret fra D-143/D-145..D-150).** Claude Code kjører FORHØYET, og PostgreSQL
   nekter å starte under en administrator-konto. Lokalt feiler dessuten tester utenfor
   `ops/claude-worker` på den pre-eksisterende Windows-`.cjs`-spawn-klassen (`EFTYPE`). Begge klassene
   er uavhengige av denne endringen - den er avgrenset til `ops/claude-worker` + docs - og er GRØNNE på
   Linux-CI, som er den autoritative porten.
2. **To worker-testfiler kan ikke PARSES lokalt på Windows (pre-eksisterende, IKKE rørt her).**
   `deploy-cli.test.mjs` og `supervisor-run.test.mjs` feiler lokalt med
   `SyntaxError: Invalid or unexpected token` allerede ved import, så de rapporterer «no tests» -
   de kjørte altså IKKE i det lokale løpet under. Verifisert årsak: de er de to ENESTE testfilene som
   `import`-erer en entrypoint med shebang (`ops/claude-worker/deploy.mjs`, `supervisor.mjs`), og på
   denne Windows-utsjekkingen har shebang-linjen CRLF (`#!/usr/bin/env node\r\n`) - vitest/esbuild sin
   shebang-håndtering bryter på det. Begge filene er ASCII, passerer `node --check`, er UROERT av
   D-151 (begge testfilene OG begge entrypointene er umodifiserte), og er GRØNNE på Linux-CI (LF) på
   eksakt PR-head. Klassen er altså miljøspesifikk, ikke en regresjon fra denne endringen, og er
   bevisst ikke «fikset» her: det ville krevd å røre urelaterte entrypoints/`.gitattributes` utenfor
   D-151s mandat. Autoritativt bevis for disse to filene er CI.
3. **Embedded-Postgres-flake (eksplisitt avdekket, IKKE rørt her).** Den tilbakevendende 16-prosess/
   16-port-flaken i repo-suiten utenfor `ops/claude-worker` er fortsatt kjent og udekket. Ingen dekning
   er svekket, hoppet over eller nøytralisert for å oppnå grønn CI.
4. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-151. PR #81 merges ikke
   før en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av PR #81 mot faktisk diff/tester/CI på eksakt NYTT endelig HEAD.
Ingen merge uten en ny `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard.
