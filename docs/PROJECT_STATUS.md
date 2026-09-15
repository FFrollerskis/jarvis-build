# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `claude/d145-merge-transition-provenance` = PR #81, base
`main=0c803bf1c1724413dc8e8071a7aabe7fd52562e4`). Aktiv ordre: **D-149**
(`D149-PR81-DURABLE-ORDER-BINDING-20260915-A`, issue #68 kommentar 5674803631,
`SUPERSEDES=D148-PR81-IMMUTABLE-MERGE-AUTHORITY-20260915-A`, `REF_REVIEW_ID=5205542132`).
`MERGE_AUTHORIZED=false`, `ARCHITECT_MERGE_APPROVED=false`, `SELF_APPROVAL=false`.

PR #80 er MERGET (merge-SHA `0c803bf1`). PR #81 er ÅPEN og DRAFT og inneholder D-145 + D-146 + D-147
+ D-148 + D-149. D-149 lukker den siste veien rundt merge-porten: en admittert task er nå durabelt og
UFORANDERLIG bundet til sin originale `ARCHITECT_TASK`-kommentar.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## Defekten (ferdig, testet)

D-148 gjorde merge-autoritet uforanderlig for en ordre som ER TIL STEDE - antallet kandidater avgjør,
og ≥ 2 feiler lukket. Men spørsmålet «hvilken ordre autoriserte denne tasken?» ble fortsatt besvart ved
å LESE MUTABEL TEKST PÅ FULLFØRINGSTIDSPUNKTET: kontroll-issuet slik det ser ut NÅ, timer og flere
worker-kjøringer etter at tasken ble admittert. Og den tomme mengden ble mappet rett på den billige
stien:

    |kandidater| == 0  ->  NO_TRUSTED_TASK  ->  claim = NONE  ->  «ikke en merge-task»
                           -> ingen overgangsverifisering, ingen påkrevd post-merge-CI,
                              ingen bundet closeout-rapport

HELE D-145/D-146/D-147-kravet kunne altså fjernes ved å FJERNE ORDREN. Alle disse gir null kandidater:

- den betrodde kommentaren SLETTES etter at tasken er admittert og dispatchet;
- den ERSTATTES av en ordre med en annen `TASK_ID`;
- `--paginate` mister eller avkorter siden den lå på;
- kontroll-lesningen FEILER og kalleren sender videre den tomme arrayen den satt igjen med;
- worker-state migreres fra en build som aldri noterte hvilken kommentar autoriteten var.

Aktøren som kan gjøre de to første er den samme D-148 ble skrevet mot: barnet kjører `gh` som
repo-eieren, så `DELETE`/`PATCH` på en issue-kommentar er like tilgjengelig som den `POST` det allerede
bruker for sin egen rapport. Og utfallet var STØRRE enn D-148s: en forfalsket duplikat gjør autoriteten
TVETYDIG (avvist), mens en SLETTING gjorde tasken VANLIG - den billige stien som passerer.

Samme feilklasse som D-136s null-proveniens-bypass og D-134s `head_before != head_after`: et spørsmål
som aldri ble besvart, registrert som et gunstig svar.

## Rettelsen (ferdig, testet)

**Bind ordren ved admittering, les bindingen etterpå.** Ny ren modul `lib/order-binding.mjs`. Ved
FØRSTE betrodde admittering i `runTask` - før prior-rekonsiliasjon, før quarantine, før dirty-guarden,
før en worktree finnes og før noe barn er skapt - persisteres `architect_order`:

| felt | hva det binder |
| --- | --- |
| `comment_id` | GitHubs EGEN id, aldri noe kroppen sier om seg selv |
| `created_at` | opprettelsestidspunktet slik det var ved admittering, når API-et ga et brukbart |
| `body_sha256` | SHA-256 over de EKSAKTE UTF-8-BYTENE, med domeneseparator |
| `body_bytes` | bytelengden, så en mismatch kan leses av et menneske uten å hente kroppen |

Digesten er over BYTES, ikke over en parset projeksjon: en projeksjon dekker bare feltene parseren
tilfeldigvis leser i dag, mens digesten dekker et framtidig felt i det øyeblikk det skrives. **Ingen
kropp lagres noe sted** - digesten er enveis, så en binding er trygg i logg, i state og i en
statuskommentar.

`bindOrderOnce` er den ENESTE veien til en binding og overskriver aldri en. Resume, retry,
rekonsiliasjon og migrering kan LESE den; ingen av dem kan erstatte eller rekompilere den fra tekst som
nå er ett adversarielt `gh api -X PATCH` unna ordren som faktisk ble reviewet. Et forsøk på å binde en
allerede bundet task til en ANNEN ordre er en navngitt refusjon, og dispatchen avvises (BLOCKED, ikke
retryable) uten at noe rebindes.

**Bundet klassifisering, egen inngang - ikke et flagg.** `classifyBoundMergeAuthorization` er nå eneste
funksjon de fire fullføringsveiene bruker (post-dispatch, krasjgjenoppretting, pre-seleksjons-
rekonsiliasjon, pre-dispatch-backstoppen). `classifyMergeAuthorization` beholdes som FØR-ADMITTERINGS-
primitiv, der «ingen ordre for denne id-en» fortsatt er et ærlig svar fordi ingenting ennå påstår noe
annet. Et boolsk flagg på den eksisterende funksjonen ble bevisst valgt bort: den trygge verdien måtte
da vært ikke-default, så enhver framtidig kaller som glemte det ville feilet ÅPENT, stille, på nøyaktig
den stien som betyr noe.

Rekkefølgen er:

1. **BINDINGEN.** Manglende, uleselig, fremmed eller fra en ustøttet versjon → `UNDECIDABLE`. Aldri
   reparert fra nåværende tekst.
2. **LESNINGEN.** En kommentarsamling som ikke er BEVIST komplett → `UNDECIDABLE`, før én eneste
   kandidat telles.
3. **MENGDEN.** D-148s antall, uendret - bortsett fra at NULL for en bundet task er `ORDER_ABSENT` og
   **aldri** `NONE`.
4. **IDENTITETEN.** Den ene kandidaten må VÆRE den bundne ordren: samme comment-id, samme body-digest,
   samme `created_at` der den ble bundet.
5. Først DA leses kroppen, etter uendrede D-147/D-148-regler.

Invarianten, sagt én gang: **en task som blir fullførings-gatet har nødvendigvis en original ordre** -
den ble admittert fra én - så «jeg finner den ikke nå» er et faktum om VÅR LESNING, aldri om ORDREN.

**Lesningen rapporterer sin egen kompletthet.** `parsePaginatedJsonDetailed`/
`fetchIssueCommentsDetailed` gir `{ ok, items, complete }` med tre distinkte tilstander: hver side lest
og parset (en tom `items` er da et BEVIST tomt sett), minst ett fragment tapt (fravær beviser
ingenting), eller lesningen feilet. Kompletthet måles også på GAPET mellom gjenkjente fragmenter, ikke
bare på parse-feil: en avkortet hale matcher ikke side-regexen i det hele tatt, så en ren
parse-feil-telling erklærte lesningen komplett mens en hel side var borte. Funnet og lukket under
implementeringen, med egen test. `complete` følger kommentarene gjennom hele kjøringen som ett
`control`-objekt, og post-dispatch foretrekkes den ferske lesningen når den LYKTES - ikke når den
tilfeldigvis var ikke-tom, slik `postComments.length > 0` gjorde.

**Migrering feiler lukket, og syntetiserer aldri.** En korrupt `architect_order` gjør HELE dokumentet
ugyldig (som ruter lasten til den verifiserte backupen) i stedet for å bli stille droppet - å droppe
den ville gjort en BUNDET task om til en UBUNDET, og ubundet er bare det gjenopprettelige tilfellet.
Fraværende binding er IKKE ugyldig: en før-D-149-post har legitimt ingen, og den BEVARES og MERKES
(`architect_order_missing_at_migration`) for ikke-terminale, allerede dispatchede poster - aldri
reparert. `bindOrderOnce` tar `alreadyAdmitted` fordi `existing === null` betyr to ulike ting og bare
kalleren (fra postens eget `attempts`-tall) vet hvilket.

**Semantikken er uendret.** Én unikt bundet false/false-ordre er fortsatt VANLIG ikke-merge og koster
NULL remote-kall. Én unikt bundet gyldig true/true-ordre krever fortsatt hele D-145..D-147-beviset.
Partiell/brukket/duplisert/redigert/slettet/ukjent autoritet er fortsatt navngitte fail-closed-utfall.
Når bindingen feiler gjøres INGEN overgangs-API-lesninger overhodet, ingen `completion_confirmed`
sendes, og worktree + claim beholdes urørt.

## Bevis

- `durable-order-binding.test.mjs` **60/60** - digest over bytes uten normalisering av
  whitespace/case/linjeskift og følsom for én byte; binding bygget, gjenbrukt, og nektet rebundet i
  alle fire retninger; korrupt/fremmed/framtidsversjonert binding; sletting, erstatning,
  én-byte-endring, WIDENING fra false/false til true/true, endret `created_at`, manglende binding,
  ubevist lesning, kompletthet sjekket FØR mengden; D-148s duplikat-/redigerings-verdikter bevart;
  overlappende pagineringskopi gir IKKE falsk tvetydighet; array-rekkefølge er ikke input; utrusted
  forfatter og `CLAUDE_REPORT` med samme id er ikke ordrer; state round-trip, resume som ikke kan
  overskrive, korrupt binding → ugyldig dokument → backup-gjenoppretting, nekt av persistering som
  ikke ville lastet tilbake, migrerings-merking for v2-legacy og eksplisitt `null` for v1; paginering
  komplett/inkomplett/avkortet/uleselig.
- `worker-order-binding.test.mjs` **24/24** mot EKTE git-repo og EKTE `worker.mjs run`, med ny fikstur
  `JARVIS_FAKE_CLAUDE_ORDER_TAMPER=delete|replace|edit|reissue`: barnet sletter/erstatter/redigerer/
  re-poster FAKTISK sin egen ordre. Med korrekt trailet commit, verifisert proveniens, ren worktree,
  ekte to-forelder-merge på remoten, alle tre påkrevde checks grønne og full bundet closeout-rapport
  forblir fullføringen HOLDT i hvert eneste tilfelle - uten `completion_confirmed`, med worktree og
  claim bevart, og med NULL overgangslesninger (bevist fra `api.log`, ikke antatt).
- Samme refusjon gjennom alle fire fullføringsveier: post-dispatch, krasjgjenoppretting,
  pre-seleksjons-rekonsiliasjon og pre-dispatch-backstoppen.
- Admittering bevist: bindingen skrives FØR dispatch; en legacy-post uten binding blir IKKE
  re-dispatchet og får IKKE en syntetisert binding; en endret ordre blokkerer re-dispatch uten å røre
  den lagrede bindingen; en normal retry GJENBRUKER dokumentet (samme `bound_at`).
- Positive kontroller: (a) uendret bundet vanlig task fullfører på proveniens + ren worktree med null
  overgangslesninger; (b) uendret bundet merge-task fullfører KUN med hele overgangs-/CI-/rapport-
  beviset, og holdes fortsatt på `HELD_MERGE_TRANSITION_UNVERIFIED` når ett remote-faktum er galt;
  (c) D-144s smale ikke-attribuerte enkelt-merge-unnskyldning er uendret, men forsvinner når ordren
  slettes. En overlappende pagineringsside er fortsatt ÉN ordre, og D-148s duplikat-refusjon fyrer
  fortsatt og navngir TVETYDIGHET - ikke bindingen.
- Sletting av en ANNEN tasks ordre fryser IKKE denne. Uten den grensen ville én sletting vært en DoS
  mot hele køen.

## Blokkeringer

1. **Forhøyet sesjon (uendret fra D-143/D-145/D-146/D-147/D-148).** Claude Code kjører FORHØYET, og
   PostgreSQL nekter å starte under en administrator-konto. Lokalt feiler dessuten tester utenfor
   `ops/claude-worker` på den pre-eksisterende Windows-`.cjs`-spawn-klassen (`EFTYPE`). Begge klassene
   er uavhengige av denne endringen - den er avgrenset til `ops/claude-worker` - og er GRØNNE på
   Linux-CI, som er den autoritative porten. D-149 unngår den siste klassen bevisst: pre-dispatch-
   proben kjører `worker.mjs` i en egen node-prosess i stedet for å importere den inn i vitest.
2. **Merge.** `MERGE_AUTHORIZED=false` og `ARCHITECT_MERGE_APPROVED=false` i D-149. PR #81 merges
   ikke før en NY `ARCHITECT_TASK` eksplisitt godkjenner det mot eksakt HEAD/base.

## Restfunn, ikke lukket (uendret fra D-148, krever arkitekt-beslutning)

`declaredExpectedHead` og `declaredSupersedes` i `ops/claude-worker/lib/queue.mjs` leser fortsatt
same-id «scope-oppdateringer» med SIST-VINNER-semantikk. En forfalsket duplikat kan derfor i prinsippet
re-peke `EXPECTED_HEAD_SHA` eller erklære `SUPERSEDES` mot en annen task. Dette er KØ-/seleksjons-
semantikk og ikke merge-autorisasjon, og å endre det ville endre dispatch-oppførselen bredt.
Rapportert til arkitekten, ikke endret her.

## Neste oppgave

Uavhengig arkitekt-gjennomgang av PR #81 mot faktisk diff/tester/CI på eksakt NYTT endelig HEAD.
Ingen merge uten en ny `ARCHITECT_TASK` med `ARCHITECT_MERGE_APPROVED=true` og eksakt HEAD/base-guard.
