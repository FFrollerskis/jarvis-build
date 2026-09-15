# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `claude/d145-merge-transition-provenance` = PR #81, base
`main=0c803bf1c1724413dc8e8071a7aabe7fd52562e4`). Aktiv ordre: **D-150**
(`D150-PR81-IMMUTABLE-EFFECTIVE-ORDER-20260915-A`, issue #68 kommentar 5676504358,
`SUPERSEDES=D149-PR81-DURABLE-ORDER-BINDING-20260915-A`, `ARCHITECT_REVIEW_ID=5206916211`).
`MERGE_AUTHORIZED=false`, `ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false`.

PR #80 er MERGET (merge-SHA `0c803bf1`). PR #81 er ÅPEN og DRAFT og inneholder D-145 + D-146 + D-147
+ D-148 + D-149 + D-150 som én sammenhengende kontrollplan-leveranse. D-150 lukker den siste
autorisasjons-integritetsgrensen FØR dispatch: en admittert task eksekverer nøyaktig ÉN uforanderlig,
fullstendig lest, unikt identifisert ordre - eller ingen.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Defekten (ferdig, testet)

D-149 gjorde en ADMITTERT tasks autoritet uforanderlig, og lot kontroll-lesningen rapportere sin egen
kompletthet. Men begge deler virket bare ETTER admittering - og admittering er der barnet faktisk får
instruksjonene sine. Ingen senere refusjon kan u-fortelle et barn hva det ble fortalt. Tre sømmer
overlevde, alle verifisert i koden på `6183a5a0`:

1. **INKOMPLETT LESNING VAR BARE EN ADVARSEL.** `control.complete === false` ga en loggelinje, og
   kjøringen gikk videre til å binde, opprette worktree og dispatche. En ordre som i virkeligheten var
   ledsaget av en ANDRE same-id-ordre på en side `--paginate` mistet, ble admittert som unik.
2. **ADMITTERING VALGTE PÅ ARRAY-POSISJON.** `collectTrustedTasks` gjorde den FØRSTE same-id-
   kommentaren kanonisk og arkiverte resten som `updates`. D-148s telle-baserte refusjon ble ikke
   konsultert ved admittering i det hele tatt, så en forfalsket duplikat ble REFUSERT ved fullføring og
   STILLE AKSEPTERT ved dispatch.
3. **UBUNDNE KROPPER VAR EKSEKVERBARE.** `buildPrompt` skrev hver `updates[]`-kropp inn i prompten som
   «ADDITIVE SCOPE UPDATE». Bindingen dekker KUN den kanoniske kommentaren, så de bytene var
   eksekverbar autoritet ingen binding dekket og ingen review behøvde å ha sett - mens
   `classifyBoundMergeAuthorization` klassifiserte tasken UTEN dem. Instruksjonen Claude eksekverte og
   ordren workeren holdt seg til kunne altså avvike, stille.

I tillegg leste `declaredExpectedHead`/`declaredSupersedes` fortsatt same-id-kropper med SIST-VINNER -
restfunnet D-149 rapporterte og ikke lukket.

## Rettelsen (ferdig, testet)

**En admitteringsport, før alt annet.** Ny ren modul `lib/order-authority.mjs`. `selectAdmissibleOrder`
kjøres i `runTask` FØR bindingen, før prior-rekonsiliasjon, før quarantine, før dirty-guarden, før en
worktree finnes, før scratch-/repo-mutasjon og før noe barn er skapt. Fire spørsmål, i rekkefølge:

| # | spørsmål | hvorfor det er først |
| --- | --- | --- |
| 1 | `ok=true` OG `complete=true`? | det en tapt side skjuler er nøyaktig den ANDRE ordren |
| 2 | nøyaktig ÉN distinkt betrodd ordre? | mengdens størrelse avgjør; ingenting VELGES |
| 3 | GitHub-id + parsbar `created_at`? | det er det bindingen og køen sammenligner på |
| 4 | finnes en kropp, og er den uredigert? | reviewet tekst må beviselig være eksekvert tekst |

**To ulike hold, med vilje.** Er funnet om VÅR LESNING (feilet/inkomplett) er tasken ikke-terminal og
HELT URØRT: ingen state-rad, ingen brukt attempt, ingen worktree. Neste kjøring med hel lesning
admitterer den normalt. Å gjøre dette terminalt ville gjort én tapt side om til en denial of service
mot køen. Er funnet om ORDREN (fraværende/tvetydig/redigert/uidentifisert/uordnet) er det TERMINALT
BLOCKED - en retry stiller identisk spørsmål og får identisk svar, og gjenopprettingen er et menneske
og en fersk `TASK_ID`.

**Same-id `TASK_UPDATE` er fjernet som eksekverbar semantikk.** En andre same-id-kommentar er en ANDRE
ORDRE. `collectTrustedTasks` samler dem som `duplicates` med `distinctOrderCount`/`uniqueAuthority` -
bevis for en refusjon, aldri input til noe eksekverbart: ikke prompten, ikke `EXPECTED_HEAD_SHA`, ikke
`SUPERSEDES`. `declaredExpectedHead`/`declaredSupersedes` leser nå KUN `entry.comment.body`, og KUN når
`uniqueAuthority === true`; begge retninger er fail-safe. Restfunnet fra D-148/D-149 er dermed lukket.
Det finnes med vilje INGEN kompatibilitetssti - en shim som «fortsatt eksekverer den gamle formen når
den ser trygg ut» er nøyaktig den framover-skanningen porten fjerner.

**Prompten bærer eksakt de bundne bytene.** `resolveExecutableOrder` i `dispatch.mjs` krever at bytene
som er i ferd med å sendes hasher til nøyaktig digesten fra admittering; ellers ny
`OUTCOME.UNBOUND_EXECUTABLE_ORDER`, returnert FØR `buildPrompt`, FØR `spawn` og før enhver sideeffekt.
`buildPrompt` håndhever det samme og KASTER, for et direkte modulkall - og har ingen løkke igjen som
kan rendre en ubunden kropp. `runTask` bygger dispatch-objektet EKSPLISITT (`taskId`, `comment`,
`orderBinding`) i stedet for å spre kø-entryen, så et framtidig kø-felt ikke kan bli eksekverbar
autoritet ved uhell.

**Delt telling.** `commentIdentity`, `collapseIdenticalOrderRepeats` og `orderByIssueSequence` ligger i
løvmodulen `order-binding.mjs` og brukes av BÅDE admitteringsporten og D-148s
`selectCanonicalArchitectTask`, så de to ikke kan drifte til ulike svar på «er autoriteten unik?».

**Ingenting av D-145..D-149 er svekket.** En unikt bundet false/false-ordre er fortsatt VANLIG
ikke-merge og koster NULL remote-kall; en unikt bundet true/true-ordre skylder fortsatt hele
overgangs-/CI-/rapport-beviset.

## Bevis

- `admission-order-authority.test.mjs` **29/29** - feilet/inkomplett/ubevist lesning; kompletthet sjekket
  FØR mengden; bevist tomt sett; identisk pagineringskopi vs konflikterende duplikat vs to ordrer med én
  id; same-id `TASK_UPDATE`; ingen framover-skanning; nabotask påvirker ikke; utrusted forfatter og
  `CLAUDE_REPORT` er ikke ordrer; redigert kommentar; manglende comment-id; uparsbar `created_at`;
  helper-renhet; kø-entry og port er enige; beskrivelsen bærer id-er og aldri ordretekst. Hver rangert
  sak kjøres i BEGGE array-retninger.
- `dispatch.test.mjs` **46/46** (10 nye) - bunden pass; manglende binding; binding for annen task; ekstra
  same-id-kropper; redigert kropp; annen comment-id; ny `created_at`; fraværende ordre. Hver med null
  spawn, ingen prompt bygget, navngitt `orderReason`, og `buildPrompt` som kaster på direkte kall.
- `worker-admission-authority.test.mjs` **21/21** mot EKTE git-repo og EKTE `worker.mjs run`, med ny
  fikstur `fail.json { commentsTruncated: true }` som gir en lesning som LYKKES og likevel ikke er
  komplett (én velformet side + én avkortet - nøyaktig slik `gh api --paginate` mister en side):
  inkomplett lesning dispatcher ingenting og lar tasken være helt urørt; samme task dispatcher normalt
  når lesningen er hel (ingen attempt brukt); feilet lesning når aldri admittering; inkomplett lesning
  admitterer ikke engang en task som ALLEREDE har binding. Konflikterende duplikat før første
  admittering, same-id `TASK_UPDATE`, reversert kommentar-rekkefølge, redigert ordre og ordre uten
  parsbar `created_at`: alle med bevist NULL barn, NULL prompt-bytes, NULL worktree, NULL claim, NULL
  overgangs-API-lesninger og NULL `completion_confirmed`. Et barn som FORFALSKER en true/true
  same-id-ordre kan ikke eskalere på retry: ikke re-dispatchet, forfalskningen nådde ALDRI noen prompt,
  bindingen uendret, worktree og claim bevart.
- Samme refusjon gjennom krasjgjenoppretting, pre-seleksjons-rekonsiliasjon og pre-dispatch-backstoppen
  - én delt regel, ikke to.
- Positive kontroller: en unik uendret vanlig ordre dispatcher EKSAKT sine bundne bytes (digest
  sammenlignet, `ADDITIVE SCOPE UPDATE` fraværende, null overgangslesninger); en unik merge-autorisert
  ordre skylder fortsatt HELE D-145..D-149-beviset og holdes fortsatt når ett remote-faktum er galt; en
  FERSK erstatnings-`TASK_ID` med eksplisitt `SUPERSEDES` kjører mens den gamle tvetydige aldri kan
  eksekvere; brukerens primære checkout er urørt av enhver refusjon.

## Blokkeringer

1. **Forhøyet sesjon (uendret fra D-143/D-145..D-149).** Claude Code kjører FORHØYET, og PostgreSQL
   nekter å starte under en administrator-konto. Lokalt feiler dessuten tester utenfor
   `ops/claude-worker` på den pre-eksisterende Windows-`.cjs`-spawn-klassen (`EFTYPE`). Begge klassene
   er uavhengige av denne endringen - den er avgrenset til `ops/claude-worker` + docs - og er GRØNNE på
   Linux-CI, som er den autoritative porten.
2. **Embedded-Postgres-flake (eksplisitt avdekket, IKKE rørt her).** Den tilbakevendende 16-prosess/
   16-port-flaken i repo-suiten utenfor `ops/claude-worker` er fortsatt kjent og udekket. Ingen dekning
   er svekket, hoppet over eller nøytralisert for å oppnå grønn CI.
3. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-150. PR #81 merges ikke
   før en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av PR #81 mot faktisk diff/tester/CI på eksakt NYTT endelig HEAD.
Ingen merge uten en ny `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard.
