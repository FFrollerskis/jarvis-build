# Jarvis Claude-worker og recovery-supervisor (ikke-produkt infrastruktur)

Kilden til den lokale worker-loopen mellom ChatGPT-arkitekten og Claude, og til
recovery-supervisoren som henter den opp igjen når den stopper.

**Dette er IKKE en Jarvis-produktkapabilitet.** Katalogen ligger utenfor pnpm-
workspacet, bygges ikke, deployes ikke med produktet, og importeres aldri av
`apps/` eller `modules/`. Se D-126 i
[DECISIONS_AND_ASSUMPTIONS.md](../../docs/DECISIONS_AND_ASSUMPTIONS.md) for
hvorfor kilden likevel er sporet her, mens KJØRETIDEN fortsatt ligger utenfor
repoet i `%USERPROFILE%\.jarvis-claude-worker\`.

## Hvorfor v2 finnes

Loopen stoppet gjentatte ganger og måtte reddes manuelt fra mobil PowerShell.
Fire uavhengige feil, alle reelle og alle observert i produksjon:

| # | Feil | Konsekvens | Rettet i |
|---|------|-----------|----------|
| A | Claude skrev ACK/report-kladd INN i repoet; `.claude-ack-d125-merge.md` ble liggende | dirty-guard blokkerte hver eneste kjøring for alltid | `lib/quarantine.mjs` |
| B | `processed_task_ids.push()` kjørte uansett utfall | `spawnSync claude ETIMEDOUT` ble registrert som «ferdig»; D125-arbeidet forsvant | `lib/state.mjs`, `lib/reconcile.mjs` |
| C | Låsen brukte pid + aldersbudsjett | en frisk 50-minutters jobb kunne erklæres «stale», og en gjenbrukt pid kunne se levende ut | `lib/lock.mjs` |
| D | Ingen retry-grense, ingen synlig status | blokkert worker gikk stille ut med exit 0 | `lib/reconcile.mjs`, `worker.mjs` |

I tillegg: en håndskrevet patch av wrapperen fra mobil innførte et fremmed tegn,
ga ParserError, og stoppet alt uten at noe rapporterte det. Derfor er alle
`.ps1`-filer nå ren ASCII, sporet i repoet, og verifisert av `verify-scripts.ps1`.

## Hvorfor v2.1 finnes (D-126 arkitekt-review, 2026-09-07)

Den uavhengige arkitekt-reviewen av den faktiske v2-koden fant syv reelle feil
som CI ikke fanget. Hver enkelt er reprodusert lokalt av arkitekten, og hver
enkelt har nå en test som feiler på den gamle implementasjonen:

| # | Faktisk feil i v2 | Reprodusert som | Rettet i |
|---|-------------------|-----------------|----------|
| 1 | Kandidat ble valgt FØR låsen, og `isEligibleNow` avviser alltid `IN_PROGRESS`. En krasj/reboot midt i dispatch nådde derfor aldri rekonsilieringen: tasken kunne aldri kjøre igjen. Barnets pid ble dessuten lagret FØRST etter at `runClaude` returnerte, så under hele dispatchen fantes barnet kun i låsen — som slettes ved reclaim av død forelder. | `CRASHED_IN_PROGRESS_ELIGIBLE=false` | `worker.mjs` (lås → state → recovery → kandidat), `lib/recovery.mjs`, `lib/procid.mjs`, `lib/dispatch.mjs` (`onSpawn`) |
| 2 | `acquireLock` publiserte en TOM `wx`-fil, lukket fd og skrev JSON etterpå; tomme/ugyldige låser ble slettet umiddelbart. `heartbeat` trunkerte samme fil på hvert slag. Samtidige reclaimere kunne slette hverandres ferske låser. State ble lastet FØR låsen og skrevet uten lås. | `EMPTY_LOCK_RECLAIMED=true` | `lib/lock.mjs` (link-atomisk publisering, rename-atomisk heartbeat, innholdsverifisert reclaim, eierskaps-token), `lib/statusjournal.mjs`, `worker.mjs` |
| 3 | `saveStateAtomic` kopierte en korrupt primær over den eneste gode backupen rett etter gjenoppretting. `migrateState(null)` og annen syntaktisk gyldig, ugyldig JSON ble stille til tom historikk. | `BACKUP_AFTER_RECOVERY_SAVE=corrupt`, `NULL_STATE_ACCEPTED_AS_EMPTY=true` | `lib/state.mjs` (skjemavalidering, verifisert backup-rotasjon, `first_run` skilt fra tapt state) |
| 4 | `install.ps1` kopierte over levende deployment fil for fil og slettet `run-worker-safe.ps1` mens den registrerte oppgaven kunne peke på den. `install-task.ps1` avregistrerte fungerende oppgave FØR ny registrering kunne feile. Rollback lot innførte moduler/oppgaver stå igjen og håndhevet ikke gamle hasher. | — | `lib/deploy.mjs` + `deploy.mjs` (stage → verifiser → bytt → auto-rollback), `install.ps1`, `rollback.ps1`, `install-task.ps1`, `install-supervisor.ps1`, `run-worker.ps1` (pending-activation-handoff) |
| 5 | Kommanderte restarts hoppet over døgnbudsjett/backoff; kommandoer ble validert i én batch, så to like `COMMAND_ID` i samme poll kjørte begge; `performRestart` merket kommandoen utført FØR starten uten noen rekonsiliering, så en krasj før start mistet forespørselen for alltid; utsatte forespørsler ble konsumert; `Start-ScheduledTask` kunne returnere ok etter en ikke-terminerende feil. | — | `supervisor.mjs` (intent → effect → result → receipt), `lib/supervise.mjs`, `lib/wintask.mjs` |
| 6 | Hele TASK_ID-sluggen finnes ikke i faktiske branch-navn, så `existingBranch`/`PR` ble `null` selv når PR-en fantes — og en retry ville duplisert branch/PR/merge. Feilede GitHub-oppslag ble til tomme lister. | `KNOWN_D125_BRANCH=null KNOWN_PR=null` | `lib/reconcile.mjs` (eksakte assosiasjoner), `lib/github.mjs` (`{ok, items, error}`, paginering) |
| 7 | `gitStatusLines` ignorerte exit/feil og leste manglende stdout som «rent». `claudeArgs` defaultet til `--dangerously-skip-permissions`. Ingen grensesjekk, ingen path-containment, ingen TASK_ID-validering før bruk som katalognavn, ingen ekte vertsbinding. `TEMP` hindrer ikke relative kladdefiler. | — | `lib/git.mjs`, `lib/config.mjs`, `lib/state.mjs` (`isValidTaskId`), `lib/dispatch.mjs` (scratch-disiplin i prompten) |

## Runde 3 (v2.2) - låsen er ikke lenger «reclaim», men en append-only hevdelses-hovedbok

Arkitektens review av den faktiske v2-koden (issue #68, kommentar 5565113307)
bekreftet en KILDEDEFEKT, ikke en flaky test: `removeVerified` flyttet den
NÅVÆRENDE låsen til en tombstone FØR bytene ble sammenlignet med det
klassifiserte øyeblikksbildet. rename-så-sammenlign er ikke en atomisk
compare-and-delete; i vinduet er den offentlige stien tom, en utfordrer kan
publisere og tro at den eier den kritiske seksjonen, og gjenopprettingen feiler
med `EEXIST`. Heartbeatens check-then-rename hadde samme klasse feil.

Reprodusert på nøyaktig efa62d7-modulen (ett tillagt observasjonspunkt rett
etter `renameSync`, ingen endret beslutning):

```
v2: existingOwnerAcquired=true challengerAcquired=true
    reclaimResult=lock_changed_during_reclaim
    existingOwnerStillHolds=false challengerStillHolds=true
v3: existingOwnerAcquired=true challengerAcquired=false
    reclaimResult=active
    existingOwnerStillHolds=true  challengerStillHolds=false
```

**Serialiseringsprimitivet i v3 er CREATE-IF-ABSENT** (`link()` / `open(wx)`) -
den eneste ekte enkeltvinner-operasjonen filsystemet tilbyr. Låsen er en
append-only hovedbok `<lockFile>.d/` med `<generasjon>.claim`-filer:

- **eierskap** = «jeg opprettet det EFFEKTIVE kravet - den høyeste claim-filen
  som ikke er `void` - og innholdet er fortsatt mitt og fortsatt `held`»;
- **anskaffelse** = append `maks+1` med create-if-absent; taperen får `EEXIST`
  fra kjernen, ikke fra en byte-sammenligning;
- **reclaim finnes ikke** - en foreldet claim BLIR ERSTATTET av en høyere
  generasjon; den flyttes, tømmes eller slettes aldri;
- **release** = merk MIN EGEN claim `released` (atomisk rename over egen sti);
- **tilbaketrekning** = merk MIN EGEN claim `void` når bekreftelsen etter
  publisering viser at den aldri eide noe.

Ufravikelig invariant: *ingen prosess omdøper, overskriver, trunkerer eller
sletter en sti den ikke selv opprettet med create-if-absent.* Derfor kan en
levende eiers hevdelse aldri forsvinne fra den offentlige stien - ikke engang i
et mikrosekund - og en foreldet reclaimer sitt verste utfall er at den legger
til en generasjon som allerede er forbigått, oppdager at den ikke er maksimum og
trekker tilbake KUN sin egen fil.

Feil-/gjenopprettingssemantikk: en krasjet eier etterlater sin claim som
maksimum med `state: "held"`; neste anskaffer klassifiserer den på
prosessidentitet (pid + starttid + host) og heartbeat-alder og kan bare
erstatte den når den beviselig ikke lever. `active`, `foreign_host`,
`unproven_identity` og `stale_no_heartbeat` erstattes ALDRI automatisk. Ukjent
identitet, uleselig claim eller enhver filsystemfeil er fail-closed. En uleselig
claim slettes aldri - etter et grace-vindu blir den bare forbigått, så korrupsjon
kan heller ikke låse workeren ute permanent. En pre-v3 vanlig låsefil respekteres
(vi nekter mens den ser levende ut) men skrives, flyttes eller slettes aldri.

Testharnessen ble også avvist med rette: veggklokke-barriere og telling av
`acquired=true` beviser ikke overlappende eierskap. `test/fixtures/lock-racer.mjs`
kjører nå en eksplisitt READY -> START -> ATTEMPT -> RELEASE-protokoll, og
`test/lock.test.mjs` dømmer ut fra INTERVALLER for den kritiske seksjonen: ingen
to intervaller får overlappe. Alle forventede barn må returnere en resultatfil og
avslutte med exit 0; ingenting filtreres bort.

En EKTE Windows-defekt i v3 ble funnet av nettopp denne harnessen og rettet før levering: libuv
åpner vanlige filer uten `FILE_SHARE_DELETE`, så et `rename` over en claim en annen prosess akkurat
leser feiler forbigående med `EPERM`/`EACCES`. Uten håndtering ga det (1) en heartbeat som ikke
landet, lest som «jeg har mistet låsen» - som ville avbrutt en frisk 50-minutters kjøring, og (2) en
claim som ikke kunne LESES, klassifisert som «uleselig» og dermed forbigåelig - altså kunne en
utfordrer forbigått en levende eier. Rettet med bundet retry + backoff på forbigående
filsystemfeil, og med et eget `unreadable`-verdikt som er FAIL-CLOSED: en claim vi ikke har SETT
blir aldri forbigått. Harnessen skiller nå `heartbeat_write_failures` fra faktisk tap av eierskap.

### Runde 4 (v2.3) - en tilbaketrukket claim kan ikke lenger maskere en levende forgjenger

Arkitektens review av `f839668` fant og reproduserte en gjenstående P1-feil i selve hovedboken.
`confirmOwnership()` re-probet generasjon N-1 riktig, men `retractOwnClaim()` skrev N som en
ORDINÆR `state: "released"`, og eierskap ble lest av RÅ maksimum. Da kunne en FEILET utfordrer gi
bort låsen: generasjon 1 lever, en foreldet reclaimer publiserer 2, bekreftelsen ser korrekt at 1
lever og trekker 2 tilbake - men en tredje anskaffer leser bare maksimum, ser en «released»
generasjon 2, konkluderer at låsen er fri, publiserer 3 og re-sjekker kun mot 2. Den levende
generasjon 1 mistet `holdsLock()`, og utfordreren gikk inn i den kritiske seksjonen.

Reprodusert lokalt på nøyaktig `f839668`-modulen og på den rettede modulen, fra samme driver:

```
f839668: firstAcquired=true secondAcquired=false generation2StateOnDisk=released
         thirdAcquired=true  firstStillOwnsLock=false thirdOwnsLock=true
v2.3:    firstAcquired=true secondAcquired=false generation2StateOnDisk=void
         thirdAcquired=false firstStillOwnsLock=true  thirdOwnsLock=false
```

Rettelsen er en tredje krav-tilstand, ikke en rekkefølgelapp. En claim er nå `held`, `released`
eller `void`:

- `released` betyr «denne claimen EIDE låsen og eieren ga slipp» - den avslutter avstamningen, for
  alt under den var allerede avgjort da eieren ble bekreftet;
- `void` betyr «denne claimen EIDE ALDRI noe» - den er TRANSPARENT, og oppslaget går videre NEDOVER
  forbi den til første krav som faktisk sier noe (det EFFEKTIVE kravet).

`acquireLock`, `holdsLock`, `heartbeat`, `releaseLock` og `readLockRaw` bruker det effektive
kravet; en ny generasjon appendes fortsatt over RÅ maksimum, så generasjonstelleren går aldri
bakover. `confirmOwnership()` re-klassifiserer den EFFEKTIVE forgjengeren (ikke blindt N-1) med
samme dom som før publisering, slik at også en uleselig eller ubevist forgjenger feiler lukket.
Kan avstamningen ikke bevises - et hull under et void-krav, eller en ren void-kjede som ikke når
generasjon 1 - nektes anskaffelsen; den leses ALDRI som «fri». En claim retrahert av en eldre bygg
(`released` + `release_reason: "retracted"`) leses som `void`.

I tillegg lukkes den gjenstående deployment-forpliktelsen: `install-task.ps1` og
`install-supervisor.ps1` skriver nå en DURABEL INTENSJON i install-manifestet FØR
noen registrering forsøkes, og AVBRYTER installasjonen hvis den ikke kan skrives.
Bekreftelsen skjer etterpå og har lov til å feile; `reconcile-task-intents` løser
et krasj-vindu fra vertens eget svar, og rollback avregistrerer også ubekreftede
intensjoner for oppgaver som ikke fantes fra før.

## Hva som faktisk garanteres

Worker (`worker.mjs`):

- **A.** Kladd havner utenfor repoet ved konstruksjon (`TEMP`/`TMP`/`TMPDIR`
  peker på `tmp/`), OG prompten oppgir den absolutte scratch-stien eksplisitt med
  kladdedisiplin — miljøvariabler alene stopper ikke en relativ filsti. Gamle
  etterlatenskaper flyttes til unik karantene FØR dirty-guarden, men bare hvis
  filnavnet treffer en fullt ankret allowlist, filen er en vanlig fil (aldri
  symlink/reparse point), innholdet faktisk er et protokolldokument, og `TASK_ID`
  er kjent for workeren. Bytes hashes før og etter. Ukjente og sporede filer røres
  aldri. Ingen `git clean/reset/stash`, ingen `.gitignore`.
- **B.** Timeout, exit≠0, spawn-feil eller manglende report gir ALDRI
  «processed». Fullført krever en matchende betrodd `CLAUDE_REPORT` for akkurat
  den `TASK_ID`-en, postet etter dispatch, med terminal `STATUS`. State skrives
  atomisk med en VERIFISERT backup; en korrupt primær overskriver aldri en god
  backup. Er både primær og backup ulesbar, nekter workeren å kjøre i stedet for
  å miste replay-beskyttelsen. Ekte førstegangskjøring rapporteres eksplisitt og
  kan aldri forveksles med tapt historikk.
- **C.** Låsen tas FØRST, og dekker state-lesing, preflight, karantene, dispatch
  og alle state-skriv. Levende eier avgjøres av prosessidentitet (pid + starttid
  + host) og heartbeat, ikke av alder. Eierskap er et token, ikke en pid. En
  aktiv, fremmed eller uverifiserbar lås ryddes aldri automatisk, publisering er
  link-atomisk, heartbeat er rename-atomisk, og en reclaim fjerner kun de
  nøyaktige bytene som ble klassifisert.
- **C2 (crash-recovery).** Under låsen, FØR noen kandidat velges, gjenopprettes
  hver task som en krasjet forelder etterlot `IN_PROGRESS`: et beviselig levende
  barn beskyttes (identitet, aldri pid alene, med etterkommere rapportert),
  en eksisterende betrodd report lukker tasken uten ny dispatch, og ellers går
  tasken tilbake til den vanlige retry-banen. Et uprøvbart pid blokkerer kun
  innenfor barnets eget levetidsbudsjett — pid-gjenbruk kan aldri stoppe loopen
  permanent.
- **C3 (kø-rekonsiliering og supersesjon, D-132).** FERSK kontroll-issue-sannhet
  slår stale lokal bokføring, og køvalget er totalt og deterministisk:
  - Terminal `STATUS` leses KANONISK (`normalizeReportStatus()` +
    `TERMINAL_STATUS_ALIASES`), ikke med eksakt strengsammenligning.
    `COMPLETE`/`COMPLETED`/`MERGED`/`DELIVERED`/`BLOCKED`/`FAILED` m.fl. er samme
    kanoniske utfall uansett case, markdown-utheving, kodefencing, sitattegn,
    etterstilt parentes eller bindestrek-vs-understrek. En status som er
    GJENKJENT og ikke-terminal (`IN_PROGRESS`) er fortsatt retry; en status som
    IKKE er gjenkjent i det hele tatt parkeres som BLOCKED med vokabularet oppgitt
    — retry på en uleselig status er selve feilklassen D-132 lukker.
  - FØR noen kandidat velges pensjoneres hver ikke-terminal task med
    `attempts>0` som har en betrodd terminal `CLAUDE_REPORT` — uavhengig av
    backoff, og uavhengig av om den ville blitt kjøringens kandidat.
  - En aldri-utsendt task slår ALLTID en retry (tiering), så en nyere gyldig
    uprosessert `ARCHITECT_TASK` kan ikke preemptes av stale retry-bokføring.
    Ordningen er total: tier → tid → comment-id (ferske eldst-først, retries
    nyest-først).
  - En ikke-terminal task som er STRENGT ELDRE enn en task som har fullført
    VELLYKKET blir `superseded` — terminal, med `superseded_by`/`superseded_at`/
    `superseded_basis` registrert og én statusmelding postet. Ingenting slettes
    stille, og verken restart, supervisor-restart eller tilbakespolt
    backoff-klokke kan gjenopplive en terminal eller superseded task.
  - En gjenopptatt task får merge-sannheten (`merge_commit_sha`, `mergedAt`) i
    prompten, slik at en allerede utført merge VERIFISERES i stedet for å kjøres
    på nytt. `head_before → head_after` og `observed_heads` gis også, men KUN
    som observasjoner — D-132 lot dem stå som påstand om forfatterskap, og den
    slutningen er fjernet i D-134 (se C6).
- **C4 (supersesjon krever POSITIVT bevis, PR #80-review).** En retirement er
  permanent, så terskelen er positivt bevis for at arkitektens nyere ordre
  FAKTISK gikk igjennom. En eldre task pensjoneres KUN på ett av to grunnlag,
  og grunnlaget registreres (`superseded_basis`) og rapporteres:
  - `newer_task_completed_successfully` — en strengt nyere task har et KANONISK
    VELLYKKET terminal-utfall, enten fra en fersk betrodd report
    (`successful === true`) eller fra en lokal post som POSITIVT sier
    `successful: true`. `STATUS=BLOCKED`/`FAILED`, en ugjenkjent status, og en
    `completed`-post som aldri registrerte suksess (f.eks. en v1-migrert rad)
    pensjonerer INGENTING. Fersk sannhet vinner begge veier: en fersk
    `BLOCKED`-report stopper supersesjon selv om state-filen fortsatt sier
    `completed, successful: true`.
  - `explicit_trusted_supersedes_declaration` — en strengt nyere BETRODD
    `ARCHITECT_TASK` inneholder `SUPERSEDES=<eksakt TASK_ID>`. Eksakt
    strenglikhet mot en task workeren faktisk kjenner (ingen prefiks, ingen
    normalisering), retningsbestemt (en eldre erklæring kan aldri pensjonere en
    nyere task), aldri selvrefererende, og auditbar — den erklærende
    kommentar-ID-en registreres og oppgis i statusmeldingen. Erklæringen leses
    KUN fra betrodd kontroll-issue-innhold, aldri fra PR-body, CI-logg eller
    annet ubetrodd innhold.
- **C5 (ISOLERT TASK-WORKTREE og task-eid UKOMMITERT tilstand, D-133).** Et avbrutt
  forsøk som etterlot LEGITIME UKOMMITERTE endringer var tidligere anonymt
  skitt i den delte checkouten: ingenting attribuerte det til en task, så neste
  kjørings dirty-guard blokkerte — korrekt — og arbeidet var strandet, med kun
  to utveier, begge forbudte (adopter uattribuerte filer, eller stash/reset dem
  bort). Det manglet en STRUKTUR, ikke en regel:
  - Hver task får sin EGEN linkede git-worktree, nøklet på `TASK_ID`, UTENFOR
    den primære checkouten (`worktreeRoot`, standard en SØSKENKATALOG av
    `scratchRoot` — bevisst ikke under den, siden `scratchRoot` gis barnet som
    `TEMP` — og `assertOutsideRepo`-håndhevet). Barnet kjører med den som
    `cwd`. Brukerens
    checkout kan derfor ikke bli skitten på en tasks vegne, og task A sitt
    ukommiterte arbeid ligger et sted task B aldri ser.
  - En DURABEL CLAIM (`<worktreeRoot>/.claims/<TASK_ID>.json`) skrives og
    fsynces FØR `git worktree add` kjøres, og re-verifiseres før en worktree
    gjenbrukes. Den binder katalogen til eksakt `TASK_ID`, betrodd
    kommentar-ID, repo (owner/name + lokal sti), kontroll-issue, baseline-SHA,
    worktree-sti og attempt-identitet. Eierskap hevdes FRAMOVER før noe røres
    og BARE sjekkes etterpå — det utledes aldri BAKOVER fra skitne filer, for
    den slutningen er nøyaktig den utrygge (en endret fil er like forenlig med
    brukerens eget arbeid).
  - Skitt inne i en katalog dekket av en GYLDIG claim for DENNE tasken er
    task-eid ved konstruksjon, og gis til et gjenopptatt barn som eksplisitt
    «dette er DITT eget arbeid — aldri stash/reset/checkout over/clean/slett det».
    Skitt alle andre steder (primær checkout, uclaimet katalog, katalog med
    claim for en annen task/repo/kommentar) er UKJENT og forblir fail-closed:
    rapportert med eksakt sti, aldri adoptert, aldri endret.
  - **Rekkevidden er UKOMMITERT TILSTAND I EN KATALOG, og stopper der.** Claimen
    dekker katalogen, ikke hver enkelt skriving inn i den, og en COMMIT er et
    durabelt artefakt som havner i en PR. Hvem som har FORFATTET en commit er
    derfor et annet spørsmål med et annet bevis — se C6. Å la
    katalog-attribusjon smitte over på commit-forfatterskap er nøyaktig
    kategorifeilen D-134 lukker.
  - Et krasj mellom claim og worktree er rekonsilierbart (claimen har sin egen
    livssyklus `creating → ready → released`, altså staged intensjon → effekt →
    resultat), og en uleselig claim er en NEKTELSE, ikke en invitasjon til å
    overskrive.
  - Opprydding skjer kun etter en terminal og VELLYKKET rekonsiliering, kun når
    worktreen er ren, og kun via `git worktree remove` UTEN `--force` — så git
    selv nekter å ødelegge ukommitert arbeid hvis våre egne garder skulle ta
    feil. Claim-filen slettes ALDRI; den merkes `released` slik at beviset
    overlever katalogen.
- **C6 (COMMIT-FORFATTERSKAP krever eget POSITIVT bevis, D-134 / PR #80-review).**
  D-132 fortalte et gjenopptatt barn at «HEAD flyttet seg i forsøksvinduet,
  altså er commitene i spennet TASK-ENS EGET ARBEID». Den slutningen er ugyldig:
  `head_before != head_after` er to avlesninger av en ref på to tidspunkter. Den
  sier AT en ref flyttet seg, aldri HVEM som flyttet den — enhver prosess med
  tilgang til katalogen (brukeren, et script, en editor, en annen
  worker-instans) kan gjøre det, og workeren kan ikke se forskjell. Å ta feil i
  DEN retningen er verre enn å ta feil motsatt vei, for den ender med at en
  fremmed commit adopteres som task-output og shippes i en PR.
  - **To ULIKE typer attribusjon, bevisst ikke slått sammen.**
    KATALOG-/DIRTY-STATE-attribusjon (C5) er sann VED KONSTRUKSJON: workeren
    lagde en tom worktree fra en kjent baseline, skrev claimen FØR noe ble rørt,
    og pekte nøyaktig ett barn dit. COMMIT-forfatterskap følger IKKE av det.
  - **Beviset (`lib/provenance.mjs`).** Hvert forsøk har en fersk tilfeldig
    `attempt_id`, generert av workeren, registrert durabelt i claim og state FØR
    barnet finnes, og gitt KUN til det barnet. En commit som bærer
    `Jarvis-Task-Id: <TASK_ID>` OG `Jarvis-Attempt-Id: <attempt_id>` som trailere
    er bundet til nøyaktig den tasken og det forsøket. Begge halvdeler kreves,
    begge sammenlignes med eksakt strenglikhet: task-ID-en alene er offentlig og
    gjettbar, attempt-ID-en alene sier ikke hvilken task den gjaldt.
  - **Utfall.** Kun `unchanged` og `task_attributed` er VERIFISERT. `partially_
    attributed` (én uforklart commit forgifter hele spennet), `unattributed`,
    `diverged` (refen ble spolt tilbake/erstattet), `drifted_after_attempt`
    (refen flyttet seg ETTER at forsøket var ferdig) og `unknown` (git kunne
    ikke svare) er UVERIFISERT.
  - **Uverifisert er fail-closed I BEGGE RETNINGER.** Arbeidet BEVARES, blir
    presentert for barnet som UKJENT forfatterskap, og barnet får beskjed om å
    verifisere og rekonsilere FRAMOVER. Ingen destruktiv rekonsiliering
    autoriseres — ikke stash, reset, revert, clean, checkout over, force-push,
    rebase eller re-apply av et eldre snapshot. Uverifisert er ikke det samme
    som uønsket, og workeren har ikke myndighet til å avgjøre hvilket det er.
  - **Et lagret verdikt gjelder bare for HEAD-en det ble beregnet på.** Ved
    gjenopptagelse sammenlignes det med worktreens FAKTISKE HEAD nå; har refen
    driftet, eller kan HEAD ikke leses, degraderes verdiktet. Ingenting i denne
    banen kan OPPGRADERE et uverifisert spenn til et verifisert.
  - **Ærlig grense, oppgitt og ikke skjult:** dette er bevis mot UVEDKOMMENDE
    skrivere. Det er IKKE beskyttelse mot en bevisst forfalsker som allerede har
    lesetilgang til verten — `attempt_id` ligger durabelt på disk og havner i en
    publisert commit-melding. Workeren kan ikke bevise forfatterskap mot en
    angriper som allerede eier maskinen, og påstår ikke at den kan.
  - `observed_heads` er en LOGG OVER OBSERVASJONER og merkes eksplisitt som det
    i både kode og prompt: den sier at disse commitene fantes da workeren så
    etter, ikke at tasken lagde noen av dem.
- **C7 (UVERIFISERT PROVENIENS ER EN EKTE FULLFØRINGSPORT, D-135 / PR
  #80-review runde 4).** D-134 svarte ærlig på forfatterskapsspørsmålet og gjorde
  så ingenting med svaret. Fullføringsbanen leste `completion.complete` og
  ingenting annet, så det adversarielle tilfellet D-134 selv satte opp — en
  uvedkommende skriver flytter den claimede worktreens HEAD mens barnet kjører —
  endte fortsatt i en ren suksess hvis barnet OGSÅ postet en betrodd
  `STATUS=COMPLETE`. Tre fail-open-konsekvenser av én manglende betingelse:
  tasken ble markert `completed` OG `successful`, `completion_confirmed` ble
  emittert, worktreen med den uforklarte commiten ble frigitt, og recorden gikk
  videre og pensjonerte strengt eldre, fortsatt gyldige tasks gjennom køens
  fresh-truth-supersesjon.
  - **Porten (`evaluateCompletionGate`).** Er rapporten terminal OG
    `successful === true`, men proveniensen IKKE verifisert (`unattributed`,
    `partially_attributed`, `diverged`, `drifted_after_attempt`, `unknown`),
    HOLDES fullføringen. Tasken parkeres som `blocked` med `successful: false`
    og en durabel `completion_gate`-record; `completed_at` settes ikke.
  - **Alle fire fullføringsbanene er portet**, ikke bare dispatch-banen:
    `reconcileReportedTasks`, krasj-recovery (`COMPLETE_FROM_REPORT`),
    pre-dispatch-rekonsilieringen i `runTask` og etter-dispatch-sjekken. En port
    i bare én av dem ville blitt gått rundt av neste kjøring gjennom en annen.
    De tre ikke-dispatch-banene UTLEDER nå ferskt verdikt (se C8); D-135 lot dem
    arve det durabelt registrerte, og et krasj i det ordinære vinduet etterlater
    ingen slik record.
  - **Porten overstyrer fresh truth i køen — og kun der.** Køen avgjør
    supersesjon fra ferske kontroll-issue-kommentarer med vilje, men den ferske
    sannheten HER er nettopp `STATUS=COMPLETE`-rapporten hvis suksesspåstand
    workeren avviste. Uten den durable overstyringen ville en nettopp parkert
    task pensjonert eldre arbeid på neste kjøring. Asymmetrien er hele
    sikkerhetsargumentet: en holdt port kan bare gjøre en task MINDRE vellykket,
    aldri mer, og kan derfor bare FORHINDRE en pensjonering.
  - **Også en eksplisitt `SUPERSEDES=`-erklæring holdes** når porten er holdt.
    Dette er bevisst strengere enn D-133-regelen om at erklæringen er arkitektens
    egen myndighet: en task som påsto suksess over commits ingen kan gjøre rede
    for, er ikke et trygt grunnlag for å pensjonere annet arbeid før et menneske
    har rekonsilert. Å gjenutstede pensjoneringen er én kommentar; arbeidet som
    går tapt ved å ta feil er ikke like billig å hente tilbake.
  - **Mislykkede terminalrapporter portes IKKE.** `STATUS=BLOCKED`/`FAILED` får
    fortsatt være terminale: de påstår ikke at arbeid landet, kan ikke frigi en
    worktree (frigivelse krever allerede `successful === true`) og kan ikke skape
    suksess-supersesjon (som allerede krever positiv suksess).
  - **Ingenting destrueres.** Alle commits og filer blir stående nøyaktig der
    forsøket forlot dem, worktreen og claimen beholdes, og statusnotisen sier
    eksplisitt hva som IKKE ble gjort. Exit-koden er 3 (blokkert), aldri 0.
  - **Beslutningen dekker HVER commit i spennet.** `MAX_EXAMINED_COMMITS` (1000)
    begrenser hvor mye som LESES OG KLASSIFISERES; `MAX_RECORDED_COMMIT_DETAILS`
    (50) begrenser kun hvor mange detaljrader som PERSISTERES per liste. Den
    gamle koden brukte ett tall til begge (`commits.slice(0, 50)`), så et spenn
    på 51 commits der de 50 første bar task-ens trailere og den 51. var fremmed
    ble klassifisert `task_attributed`, `verified: true` — en positiv
    eierskapspåstand om en commit som aldri ble lest. Nå er `*_count` alltid de
    FULLE tallene, `details_truncated` sier når listen er kuttet, og et spenn
    større enn lesegrensen er `unknown` — aldri et verdikt om prefiksen git
    tilfeldigvis returnerte først.
- **C8 (FRAVÆR AV BEVIS ER IKKE BEVIS — KRASJVINDUET, D-136 / PR #80-review
  runde 5).** D-135 sendte porten med ett bevisst hull, skrevet ut i sin egen
  kommentar som en egenskap: «den finner ikke opp bevis. Når det IKKE finnes noen
  proveniens-record i det hele tatt — en state-rad skrevet før D-134 fantes —
  slipper porten gjennom og sier det.» Den slutningen er feil på nøyaktig samme
  måte som den D-134 fjernet. `provenance === null` betyr ikke «spennet var i
  orden»; det betyr at INGEN SÅ ETTER, og en port som gjør «ingen så etter» om
  til «vellykket fullføring akseptert» er en fail-open-default med et ærlig navn.
  - **Det var heller ikke begrenset til pre-D-134-rader.** Workerens EGEN
    rekkefølge lager vinduet, på hver eneste dispatch: `IN_PROGRESS`, barnets
    identitet og den durable claimen skrives FØR spawn, mens `commit_provenance`
    skrives KUN i etter-dispatch-sjekkpunktet ETTER at barnet har avsluttet. En
    forelder som dør imellom — det ordinære krasjet hele delsystemet finnes for —
    etterlater durabel claim, ekte worktree, en betrodd `STATUS=COMPLETE` postet
    av barnet, og INGEN record. Krasj-recovery leste `null`, slapp gjennom, og
    markerte tasken `completed` OG `successful`, frigav worktreen og lot recorden
    pensjonere eldre tasks. Alle D-135s egne tester passerte fortsatt, fordi hver
    eneste av dem gikk gjennom ETTER-DISPATCH-banen, der et verdikt alltid finnes.
  - **`null` HOLDER nå** (`COMPLETION_GATE.HELD_NO_PROVENANCE_RECORD`).
  - **Men de tre ikke-dispatch-banene lener seg ikke på den nektelsen alene** —
    en port som bare sier «nei» til enhver legitim krasj-recovery ville vært
    ubrukelig. De UTLEDER ferskt verdikt (`deriveReconciliationProvenance`) FØR
    hver suksess-rekonsiliering, av ting som finnes på disk og som ikke kommer
    fra barnet: (1) den DURABLE CLAIMEN, verifisert eksakt mot task/repo/
    kontroll-kommentar/worktree-sti og krav om `ready`; (2) ATTEMPT-ID-ene
    workeren selv genererte og registrerte der; (3) BASELINE-commiten claimen ble
    opprettet på; (4) worktreens FAKTISKE HEAD akkurat nå. Hele spennet
    `baseline..nå` klassifiseres med de samme bundne fail-closed-reglene som
    dispatch-banen bruker.
  - **Ankeret er claimens BASELINE, ikke forsøkets `head_before`.** Det er
    bevisst strengere: det dekker hver commit som noen gang har dukket opp i
    katalogen, på tvers av alle forsøk, så en fremmed commit fra et TIDLIGERE
    forsøk ikke kan hvitvaskes av et senere som tilfeldigvis startet etter den.
  - **Manglende claim/worktree/baseline/attempt-ID, uleselige git-fakta, drift,
    divergens, delvis/uattribuerte commits eller avkortet bevis er UKJENT** og
    uverifisert — aldri «rent». Alt bevares; utledningen skriver, fjerner og
    omskriver ingenting.
  - **Bevis kan KUN degradere.** Et ferskt verdikt kan ikke slette et gammelt
    funn: et spenn et tidligere forsøk klassifiserte `unattributed` kan se
    `unchanged` ut nå bare fordi refen er flyttet tilbake. Porten ser derfor det
    VERSTE av registrert og utledet verdikt (`reconciliationProvenanceForGate`),
    og VERIFISERT krever BEGGE. En registrert verifisert record kjøper ingenting
    alene — utledningen må stå på egne bein.
  - **En holdt port overlever i exit-koden uansett hvor den fyrte.** D-135 bar
    kun pre-seleksjons-passet inn i exit-koden, så en hold reist under
    krasj-recovery — nettopp banen D-136-vinduet lander på — avsluttet med 0. Nå
    gir enhver holdt port exit 3, også når kjøringen etterpå dispatchet en annen
    task uten problemer.
- **C9 (ÉN UFORANDERLIG, FULLSTENDIG LEST, UNIKT IDENTIFISERT ORDRE PER TASK,
  D-150).** En admittert task eksekverer nøyaktig ÉN ordre, eller ingen. Porten
  (`lib/order-authority.mjs`, `selectAdmissibleOrder`) kjører FØR bindingen, før
  quarantine, før dirty-guarden, før en worktree finnes og før noe barn er
  skapt — så en refusjon her dispatcher ingenting i det hele tatt.
  - **Kompletthet er et krav, ikke en advarsel.** Kontroll-lesningen må være
    `ok=true` OG `complete=true`. En lesning vi ikke kan gå god for kan verken
    bevise at ordren er unik eller at den er til stede, og det en tapt
    `--paginate`-side skjuler er nøyaktig den andre ordren.
  - **Unikhet avgjøres av MENGDENS STØRRELSE, ikke av et valg.** Nøyaktig én
    DISTINKT betrodd `ARCHITECT_TASK` for `TASK_ID`-en. Overlappende
    pagineringskopier (identisk id + kropp + `created_at`) er ÉN ordre; enhver
    avvikende kropp under samme id er to. Det skannes aldri framover etter en
    brukbar ordre.
  - **Deterministisk identitet og ordning kreves:** GitHubs egen comment-id og en
    parsbar `created_at`. En redigert kommentar (`created_at !== updated_at`, kun
    når begge finnes) er ikke en ordre.
  - **SAME-ID `TASK_UPDATE` ER IKKE LENGER EKSEKVERBAR SEMANTIKK.** En ny
    kommentar med en eksisterende `TASK_ID` er en ANDRE ORDRE, ikke et tillegg.
    Den er en KANDIDAT som beviser en refusjon, og når ALDRI prompten,
    `EXPECTED_HEAD_SHA` eller `SUPERSEDES`. **Endret eller konsolidert scope
    utstedes som en FERSK `TASK_ID` med eksplisitt `SUPERSEDES=<gammel id>`** —
    det er den støttede, retningsbestemte og reviderbare veien (se C4). Det
    finnes med vilje ingen kompatibilitetssti: en allerede admittert eller
    tvetydig legacy-post HOLDER og krever en fersk id.
  - **To ulike hold, med vilje.** Er funnet om VÅR LESNING (feilet/inkomplett) er
    tasken ikke-terminal og helt urørt — ingen state-rad, ingen brukt attempt,
    ingen worktree — og neste kjøring med hel lesning admitterer den normalt; å
    gjøre én tapt side terminal ville vært en denial of service mot køen. Er
    funnet om ORDREN (fraværende/tvetydig/redigert/uidentifisert/uordnet) er det
    terminalt BLOCKED, fordi en retry stiller identisk spørsmål: gjenopprettingen
    er et menneske og en fersk `TASK_ID`.
  - **Prompten bærer eksakt de bundne bytene.** `resolveExecutableOrder` krever at
    bytene som er i ferd med å sendes hasher til nøyaktig digesten som ble
    registrert ved admittering; ellers `unbound_executable_order`, returnert FØR
    `buildPrompt` og FØR `spawn`. Håndhevet både i `runClaude` og i `buildPrompt`
    selv — samme argument som for `promptDelivery` under — og `buildPrompt` har
    ingen løkke igjen som kan rendre en ubunden kropp.
  - **`dry-run` viser den samme dommen** (`next_candidate_order_authority`), så
    en forhåndsvisning aldri kan vise en dispatchbar kandidat som den ekte
    kjøringen ville refusert.
- **C10 (ÉN FULLSTENDIG, UFORANDERLIG AUTORITETS-SNAPSHOT PER SYKLUS, D-151).**
  En worker-syklus avgjør fra ÉTT komplett, frosset snapshot, eller den avgjør
  ingenting. D-150 stilte det riktige spørsmålet på feil sted: porten kjørte
  SENT, for den ENE tasken køen allerede hadde valgt, mens alt foran den
  fortsatt kjørte på en ubevist lesning og på en autoritet avgjort en andre,
  svakere vei.
  - **Snapshotet tas ØVERST i den eide kjøringen** (`lib/authority-snapshot.mjs`,
    `captureAuthoritySnapshot`), rett etter auth- og lesebeviset og FØR enhver
    beslutning. Er lesningen feilet, inkomplett, avkortet eller ubevist (også en
    bar array uten kompletthetsbevis): navngitt, ikke-null TRANSIENT resultat, og
    syklusen gjør INGENTING — ingen krasj-recovery-beslutning, ingen
    kø-seleksjon, ingen rapport-retirering, ingen supersession, ingen
    task-state-mutasjon, ingen worktree-/scratch-/repo-handling, ingen
    transition-API-lesning, ingen prompt og ingen barneprosess. Hver eksisterende
    task, claim og worktree står byte-for-byte som før.
  - **Autoriteten klassifiseres ÉN gang, for HVER task-id i snapshotet**, av den
    ene klassifisereren, og dommen REISER MED entryen gjennom kø-seleksjon til
    dispatch. `collectTrustedTasks` grupperer og teller nå, og publiserer verken
    `uniqueAuthority` (en telling som ikke kan se en redigering) eller en
    representant valgt av ARRAY-POSISJON (som køen rangerte og beviste retning
    fra). `runTask` sjekker den MEDBRAGTE dommen; den utleder ingen ny.
  - **En inadmissibel ordre bidrar med INGENTING semantisk.** `order`/`comment` er
    `null`, så `EXPECTED_HEAD_SHA`, `SUPERSEDES`, rangeringsposisjon, egnethet og
    eksekverbar kropp er strukturelt utilgjengelige — den feiler lukket av
    konstruksjon, ikke ved at noen husker å sjekke et flagg. Den får sin egen
    navngitte grunn (`INELIGIBLE.INADMISSIBLE_AUTHORITY`), rapporteres og
    retireres FØR seleksjonen, og kan derfor aldri preempte en gyldig ordre.
  - **Uprovbar utstedelsesrekkefølge retirerer ingenting.** `created_at`/comment-id
    som ikke lot seg lese ble tidligere `0`, som gjorde ordren eldre enn alt som
    noensinne er utstedt — og «strengt eldre» er hele det retningsbestemte
    argumentet for å retirere. Nå er svaret: vi vet ikke, og da retireres
    ingenting.
  - **Supersession er en durabel destruktiv beslutning.** Den krever komplett
    snapshot OG en admissibel deklarerende ordre, og HVER admissibel deklarasjon
    registreres med comment-id OG kroppens digest (`superseded_declarations`,
    `superseded_snapshot_complete`). Ingenting løses lenger ved å beholde den
    «første» eller «siste» — en comment-id alene beviser ingenting når den samme
    GitHub-innloggingen workeren stoler på kan redigere kommentaren.
  - **`dry-run` viser alt dette uten å mutere noe:** snapshot-kompletthet
    (`snapshot_usable`, `control_comments_complete`), HVER ordres dom
    (`order_authority`), og om en foreslått retirering ville blitt utført
    (`supersession_preview`, med deklarerende comment-id og digest). En ubevist
    lesning gir `would_exit: TRANSIENT` og INGEN kø, kandidat eller retirering.
- **C11 (ET UBRUKELIG SNAPSHOT SKRIVER INGENTING, D-152).** D-151 plasserte
  grensen riktig og skrev deretter gjennom den: refusjonsgrenen kalte
  `reportStatus`, som ikke er en observasjon men TRE skrivinger.
  - **`postComment` publiserte til KONTROLL-ISSUEN — køens egen inngang.** En
    syklus som nettopp hadde erklært at den ikke kunne lese den issuen, la
    likevel til i den, og hver senere syklus leser kommentaren tilbake som en del
    av SITT autoritets-snapshot. Én flaky `gh api --paginate` ble et permanent,
    globalt synlig artefakt forfattet av en syklus uten autoritet.
  - **`postComment` skrev først en body-fil inn i `scratchRoot`** og opprettet
    katalogen — scratch-aktivitet som holdets egen melding SAMTIDIG påstod ikke
    hadde skjedd.
  - **`recordPostedStatus` appendet til dedupliseringsjournalen.** Det er durabel
    beslutningstilstand, og den avgjør FRAMTIDEN: når nøkkelen er journalført,
    undertrykkes det samme funnet i `statusRepeatHours`. En ubevist lesning
    kjøpte seg altså stille seks timers taushet om en tilstand som til da kan ha
    blitt reell og genuint verdt å rapportere.
  - **Alle tre er fjernet fra refusjonsgrenen.** Det som står igjen er den eneste
    kategorien som ikke kan korrumpere en senere beslutning: LOKALT APPEND-ONLY
    BEVIS. Logg og health-journal skrives på denne verten, leses aldri tilbake
    som autoritet, og er nøyaktig det en operatør trenger.
  - **Beviset er falsifiserbart, ikke bare taust.** Health-eventen
    `control_authority_snapshot_unusable` bærer `snapshot_reason`,
    `snapshot_detail`, `held: true`, `exit: 4` og — positivt formulert —
    `status_comment_posted: false`, `posted_status_recorded: false`,
    `durable_state_written: false`. Loggen navngir funnet og det holdte
    TRANSIENT-utfallet, og påstår aldri at en status-kommentar ble postet.
  - **Komplett-snapshot-stien er uendret.** Forbudet gjelder å skrive FRA EN
    SYKLUS SOM BEVISTE AT DEN IKKE KUNNE LESE — ikke å skrive i det hele tatt.
    Legitim status-/rapport-posting etter et bevist komplett snapshot virker som
    før, dedupliseringen inkludert.
  - **`JARVIS_WORKER_FAULT=control_read_unproven`** (TEST-ONLY) forfalsker BARE
    lesningens form, slik at `READ_UNPROVEN` — som ellers er unåbar utenfra,
    fordi `fetchIssueCommentsDetailed` alltid leverer kompletthetsbevis — kan
    testes gjennom den ekte entrypointen. Armeringen annonseres høylytt i logg og
    health som alle andre faults.
- **D.** Bundet retry med eksponentiell backoff og et hardt tak. Gjentatt feil
  gir en deduplisert `CLAUDE_WORKER_STATUS` på kontroll-issuen (dedup i egen
  append-only journal, så den aldri trenger den eksklusive låsen). Exit-koden er
  aldri 0 når noe er blokkert.
- **E.** Bare allerede autoriserte tasks kjøres. Ingen oppfunnet neste arbeid.
- **F.** Egne health-hendelser per steg, så «scheduleren kjørte» aldri forveksles
  med «arbeidet ble fullført».
- **Fail-closed.** Et git-spørsmål som ikke kan besvares er UKJENT, aldri «rent».
  `origin` må peke på det konfigurerte repoet. `claudeArgs` er påkrevd og
  eksplisitt — det finnes ingen permissiv default, og et permission-bypass-flagg
  krever `acknowledgeDangerousClaudeArgs: true` i samme fil. Alle numeriske
  grenser er endelige og validerte, alle skrivestier må ligge utenfor repoet, og
  `TASK_ID` valideres som én trygg path-komponent før den brukes som katalognavn.
- **`promptDelivery` er `stdin` og INGENTING annet** (D-126e, addendum-punkt 4).
  `argv`-levering la hele oppgaven på kommandolinjen som ble gitt til `spawn`, så
  barnet kunne lese og begynne å utføre den autoriserte oppgaven FØR den durable
  handoff-gaten hadde commitet — og ingen etterfølgende abort kan bevise at den
  ikke allerede var konsumert. Med `stdin` ER prompten oppgaven, og den skrives
  først når identitetsrecord og lås-heartbeat er durable. Avvisningen håndheves
  både i `loadWorkerConfig` OG i `runClaude` selv, FØR `spawn` — et direkte
  modulkall går aldri gjennom konfigurasjonsvalidering, og det var nettopp slik
  gapet ble reprodusert. Utfallet er `unsupported_prompt_delivery`: ingen prosess
  opprettes, så det finnes ikke noe barn som kunne ha konsumert oppgaven.

Supervisor (`supervisor.mjs`), autorisert av scope-oppdateringen på
WORKER-SELF-RECOVERY-20260907 — ÉN recovery-supervisor, aldri en andre
implementasjons-worker:

- observerer den eksisterende `JarvisClaudeWorker`-oppgaven og workerens egen
  health-journal/lås (kun lesing),
- poller SAMME betrodde issue for nøyaktig to kommandoer: `STATUS` og
  `RESTART_WORKER`, med ankret skjema, unik `COMMAND_ID`, host-/worker-binding,
  kort utløp, avvisning av redigerte og replayede kommentarer,
- validerer hver kommando I DET ØYEBLIKKET den utføres, mot fersk observasjon —
  to like `COMMAND_ID` i samme poll kan ikke begge kjøre,
- starter den eksisterende oppgaven når workeren beviselig er en død
  kø-konsument, innenfor et døgnbudsjett og med backoff — som gjelder KOMMANDERTE
  restarts på nøyaktig samme måte,
- bruker durable stadier (intent → effect → result → receipt): en krasj rundt
  starten rekonsilieres fra faktisk host-bevis (workerens egen health-journal),
  en kvittering som ikke ble postet forsøkes på nytt UTEN å gjenta effekten, og
  en forespørsel går aldri tapt,
- **utsetter, konsumerer ikke**: en `RESTART_WORKER` mot en travel worker bevares
  og revurderes hver poll til den trygt kan utføres eller utløper eksplisitt,
- **avbryter aldri levende arbeid** og **avslutter aldri en prosess**.

## Exit-koder (både worker og supervisor)

| Kode | Betydning |
|------|-----------|
| 0 | frisk: ledig kø, eller en task fullført med verifisert bevis |
| 3 | blokkert: trenger et menneske eller en ny TASK_ID — ikke «frisk» |
| 4 | forbigående: auth/nett/retry-bar feil, prøver igjen med backoff |
| 1 | fatal: config- eller parse-feil |

En Windows-oppgave i `Ready` med `LastTaskResult=0` betyr KUN at scheduleren
kjørte. Ekte køhelse: `node worker.mjs health`.

## Installasjon (transaksjonell: stage → verifiser → bytt → auto-rollback)

```powershell
cd <repo>\ops\claude-worker
.\verify-scripts.ps1              # alle .ps1 parser (ekte AST) og er ASCII; alle .mjs parser med node
.\install.ps1 -WhatIf             # full plan, endrer ingenting
.\install.ps1                     # stage + hash-verifiser + bytt
```

Motoren ligger i `lib/deploy.mjs`/`deploy.mjs` (Node, ikke PowerShell), nettopp
for at hele feilbanen kan kjøres med ekte filer og injiserte feil i CI. PowerShell
beholder kun det som virkelig krever det: registrering av oppgaver.

Garantier:

- alt stages og hash-verifiseres i `staging\<versjon>\` FØR noe levende røres;
- en levende worker- ELLER supervisor-lås gir UTSATT aktivering med en
  `pending-activation.json`-markør — ingenting overskrives, ingenting drepes.
  En installasjon startet av workeren selv kan derfor aldri overskrive sin egen
  forelder. **Markøren anvendes av den kontrollerte bootstrap-handoffen**
  (`deploy.mjs bootstrap-handoff`), som `install.ps1` starter fra KILDETREET i
  samme øyeblikk aktiveringen utsettes. Den venter på at den EKSAKTE legitime
  forelder-identiteten (pid + starttid + host) avslutter av seg selv, sjekker
  worker- og supervisor-quiescence på nytt, og aktiverer først da
  transaksjonelt. Den dreper ingenting og rører ingen scheduled task.
  **Den blir også VÆRENDE i live og poller fail-closed innenfor ÉN fast bundet
  deadline** for enhver lås den ikke kan gjøre om til en eksakt identitet:
  syntaktisk uleselig, semantisk malformed, ekte legacy-form uten `host`, eller
  midlertidig utilgjengelig (lese-/tilgangsfeil). Slike låser ble tidligere lagt
  i en `unreadable`-liste ingen konsumerte, eller stille utelatt helt — da fanget
  handoffen null identiteter, ventet på ingenting og returnerte `deferred` med én
  gang. På en legacy-installasjon finnes det ingen fremtidig konsument for
  markøren, så handoffen ble forlatt for godt (D-126e, addendum-punkt 5). Den
  aktiverer først når blokkererne er borte eller trygt klassifiserbare OG alle
  eksakt fangede eiere er bevist avsluttet; en ny eier som dukker opp underveis
  gir ny utsettelse, aldri overskriving, og markøren blir alltid liggende.
  `run-worker.ps1` sin `apply-pending` er et ANDRE nett som kun hjelper når den
  nye runneren allerede ER den installerte entrypointen: en installasjon startet
  av en GAMMEL deployert worker kan ikke regne med at neste scheduler-tikk
  anvender markøren, fordi det tikket kjører den gamle filen (D-126d, funn 3);
- hver fil skrives ved siden av målet og `rename`-es over — et entrypoint
  forsvinner aldri, ikke et øyeblikk;
- `run-worker-safe.ps1` fjernes KUN når ingen registrert oppgave refererer den,
  og aldri i det hele tatt hvis oppgavene ikke kunne spørres;
- enhver feil under byttet ruller automatisk tilbake til de registrerte gamle
  hashene og fjerner filer installasjonen innførte;
- `config.json`, `supervisor.config.json`, `state.json`, `logs/` og `tmp/` er
  aldri i payloaden og røres aldri.

Etter installasjon (registrerer ingenting av seg selv):

```powershell
copy config.example.json config.json                       # claudeArgs er PÅKREVD og eksplisitt
copy supervisor.config.example.json supervisor.config.json # sett host til EKSAKT hostname
node worker.mjs status
node worker.mjs run --dry-run     # kun lesing: tar ingen lås og skriver ingenting
node supervisor.mjs status
node supervisor.mjs run --dry-run
.\install-task.ps1                # worker-schedule (samme ene worker som før)
.\install-supervisor.ps1          # supervisor-schedule (startup + intervall)
```

`install-task.ps1`/`install-supervisor.ps1` gjenbruker hostens EKSISTERENDE
principal (UserId/LogonType/RunLevel) og faktiske shell — ingen stille
substitusjon til `powershell.exe`/S4U. De eksporterer eksisterende definisjon,
PRØVER registreringen under et midlertidig navn først (så et avslag aldri ødelegger
en fungerende oppgave), erstatter deretter med `Register-ScheduledTask -Force`
(aldri avregistrer-så-registrer), verifiserer resultatet og gjenoppretter backupen
hvis verifikasjonen feiler. Ingen rettigheter endres for å omgå et avslag.

Rollback:

```powershell
.\rollback.ps1 -WhatIf
.\rollback.ps1 -RestoreTasks
```

Rollback håndhever manifestets gamle SHA256, fjerner filer og oppgaver
installasjonen innførte, gjenoppretter filer den fjernet, og rører ingen
operasjonelle data.

En oppgave regnes som «innført» kun når den ikke fantes fra før:
`install-task.ps1` og `install-supervisor.ps1` kaller da
`node deploy.mjs record-introduced-task`, som skriver navnet inn i det siste
install-manifestet. Rollback avregistrerer nøyaktig de navnene og aldri en
oppgave installasjonen ikke opprettet.

## Kontrollkommandoer til supervisoren

Postes som kommentar på kontroll-issuen av repo-eieren. Alle felt er
obligatoriske; ukjente nøkler avvises.

```
ARCHITECT_CONTROL
COMMAND_ID=restart-20260907-0155-abc
COMMAND=RESTART_WORKER
TARGET_HOST=<eksakt hostname>
TARGET_WORKER=JarvisClaudeWorker
ISSUED_AT=2026-09-07T01:55:00Z
EXPIRES_AT=2026-09-07T02:25:00Z
```

Avvises ved: feil forfatter, ikke-OWNER, redigert kommentar, gjenbrukt
`COMMAND_ID`, utløpt, levetid over én time, feil host/worker, ukjent kommando
eller nøkkel. `TARGET_HOST` må dessuten være maskinen supervisoren FAKTISK kjører
på — konfigurasjonen valideres mot `os.hostname()` ved oppstart. Supervisoren
tolker aldri fritekst, stier eller argumenter.

## Sikkerhet

Ingen token håndteres, leses eller logges her — all GitHub-tilgang går gjennom
`gh`, som eier sin egen lagrede auth. Alt som skrives til logg, manifest eller
en kommentar går gjennom `sanitize()`. Manifestet inneholder stier og hasher,
aldri filinnhold. Ingen tillits- eller godkjenningsgrense er svekket av denne
reparasjonen: merge-autoritet (D-120) er uendret, supervisoren kan ikke merge,
og ingen permission-bypass legges til implisitt noe sted.

## Tester

```bash
npx vitest run ops/claude-worker/test
```

628 tester (kjørt 2026-09-12 på `claude/d132-worker-recovery-reconciliation`:
21 filer / 628 passed; 21 filer / 588 etter D-134, 20 filer / 538 etter D-133,
18 filer / 470 etter D-132, 16 filer / 428 før). I tillegg
til v2-dekningen (karantene inkludert den eksakte D125-filen, symlink, reparse
point, kollisjon, sporede filer; completion-bevis; backoff; status-dedup;
tillitsgrensen; hemmelighetsvask) dekker v2.1/v2.2:

- **ekte samtidighet med intervall-bevis**: åtte separate OS-prosesser med
  eksplisitt READY/START/ATTEMPT/RELEASE-koordinering (`test/fixtures/lock-racer.mjs`);
  gjensidig utelukkelse avgjøres av at ingen to kritiske seksjoner overlapper,
  ikke av en telling. Alle barn må levere resultatfil og avslutte med exit 0;
- **den bekreftede kildedefekten**: kontrollert stale-read -> erstatningseier ->
  forsinket reclaim -> utfordrer, deterministisk via `hooks.afterClassify`
  (nøyaktig punktet v2 var utrygt);
- **ekte crash-recovery mot det FAKTISKE entrypointet**: `node worker.mjs run`
  startes som prosess og drepes før spawn, under barnets kjøring og etter
  report men før completion-lagring (`test/worker-crash-recovery.test.mjs`);
- **feilinjeksjon i durabilitet**: korrupt primær + gyldig backup, avbrutt
  skriving, `null`/`[]`/`{}`-state;
- **installasjon/rollback som fixtures**: injisert feil i hvert steg av byttet,
  hash-håndhevet rollback, fjerning av innførte filer, bevaring av operasjonelle
  data, utsatt aktivering under levende lås;
- **supervisor-protokollen ende-til-ende**: to like `COMMAND_ID` i samme poll,
  budsjett for to unike restarts, krasj før/etter `Start-ScheduledTask`, feilet
  kvittering, og bevart utsettelse fra travel til ledig.

og v2.7 (D-132) legger til:

- **kø-ordning og supersesjon** (`test/queue.test.mjs`, 23 tester): tiering,
  total deterministisk ordning inkl. like tidsstempler, supersesjon drevet av
  ferske kommentarer når lokal state er stale, og at terminal/superseded state
  ikke kan gjenopplives av en tilbakespolt backoff-klokke;
- **kanonisk statusparsing** (`test/reconcile.test.mjs`): `STATUS=COMPLETE`
  lukker tasken, staveformer og formateringsstøy normaliseres, og en UGJENKJENT
  status skilles eksplisitt fra gjenkjent framdrift;
- **NØYAKTIG D-131-sekvensen mot det EKTE entrypointet**
  (`test/worker-queue-reconciliation.test.mjs`, 7 tester): eldre recovery-task →
  nyere merge-task → ACK → merge lykkes → prosess-/rapportavbrudd → restart, med
  bevis for at den gamle task-en aldri dispatches igjen og at tre påfølgende
  restarter ikke gjenoppliver den; pluss at en allerede merget task får
  merge-commit og «ikke merge igjen» i resume-prompten, og at en gjenopptatt
  task får sin egen head-proveniens.

Merk: `fixtures/fake-claude.mjs` poster som standard `STATUS=COMPLETE` — den
EKTE staveformen. Den postet tidligere `STATUS=COMPLETED`, som ingen ekte
barneprosess bruker, og det er grunnen til at 428 grønne tester kunne sameksistere
med en worker som ikke kjente igjen en eneste ekte fullføringsrapport.

og v2.8 (D-133, PR #80-review) legger til:

- **claim-modellen og klassifiseringen** (`test/worktree.test.mjs`, 34 tester):
  sti-validering av `TASK_ID`, alle claim-felter, MISSING vs. UNUSABLE, eksakt
  `verifyClaim` (ingen prefiks, ingen case-variant), og HVER fail-closed gren i
  `classifyTaskWorktree` — inkludert at en uleselig claim er en NEKTELSE, at et
  uanswerbart `worktree list` aldri leses som «ingenting registrert», og at
  eierskap ikke kan utledes bakover fra vilkårlige skitne filer;
- **ISOLASJON MOT EKTE GIT** (`test/worker-task-worktree.test.mjs`):
  disse setter bevisst IKKE `JARVIS_WORKER_GIT`. Påstanden er fysisk — hvilken
  katalog havnet bytene i, er brukerens checkout fortsatt ren, nekter git faktisk
  å slette ukommitert arbeid — og en fake-git ville bare vært enig med workeren.
  Dekker: exit 0 + ingen rapport + ekte tracked/untracked mutasjoner → restart →
  gjenopptagelse i samme beviste kontekst; primær checkout ren gjennom alt;
  brukerens egne skitne filer byte-for-byte urørt; uclaimet katalog og fremmed
  claim avvist uten mutasjon; nyere task kjører i sin egen worktree og blokkeres
  ikke av den eldres skitt; to tasks skitne samtidig; restart dupliserer ingen
  commit; krasjet `IN_PROGRESS`-forelder gjenopptas i samme claimede kontekst;
  og opprydding kun ved suksess, med claimen bevart som `released`;
- **supersesjon krever positivt suksessbevis** (`test/queue.test.mjs` +
  `test/worker-queue-reconciliation.test.mjs`): nyere `BLOCKED`/`FAILED`
  pensjonerer ikke en eldre retry — og den eldre KJØRER faktisk etterpå; et
  lokalt rekonsilert `successful: false` pensjonerer ikke; ekte suksess
  pensjonerer fortsatt og registrerer grunnlaget; eksplisitt `SUPERSEDES` er
  eksakt, retningsbestemt og auditbar; `SUPERSEDES` fra UBETRODD innhold
  ignoreres helt.

og v2.9 (D-134, PR #80-review runde 3) legger til:

- **bevismodellen** (`test/provenance.test.mjs`, 42 tester): trailer-parsing
  (case, whitespace, CRLF, og at PROSA som bare NEVNER ID-ene ikke er et
  trailer), at BEGGE halvdelene kreves (task-ID alene er offentlig; attempt-ID
  alene sier ikke hvilken task), at et TIDLIGERE forsøk av SAMME task godtas,
  og hvert eneste verdikt inkludert `unknown` for uleselig git. Rendringen
  testes separat fra klassifiseringen, fordi en modul som klassifiserer riktig
  men fortsatt skriver «dette er ditt eget arbeid» ville vært like farlig som
  defekten;
- **ADVERSARIELL TEST MOT EKTE ENTRYPOINT OG EKTE GIT**
  (`test/worker-task-worktree.test.mjs`): en UVEDKOMMENDE SKRIVER — test-
  prosessen, med en annen git-identitet, på en fil barnet aldri rører — committer
  inn i den isolerte task-worktreen MENS et forsøk faktisk kjører (synkronisert
  på fixturens egen `running`-markør, ikke på en sleep). Alt workeren kan
  observere er da identisk med en legitim egen commit. Bevist: neste resume
  kaller den IKKE task-eid, aksepterer den IKKE som task-output, og autoriserer
  INGEN destruktiv rekonsiliering — prompten inneholder heller ikke noen
  `git stash`/`reset`/`revert`/`clean`/`--force`-instruks i det hele tatt. Dekker
  også BLANDET spenn (egen + fremmed commit → hele spennet uverifisert),
  glemte trailere fra workerens EGET barn (uverifisert, men bevart), refen
  spolt tilbake mellom forsøk (`drifted_after_attempt`, ingenting gjenopprettet),
  og den POSITIVE motprøven: et barn som stempler trailerne korrekt FÅR sine
  commits presentert som beviselig sine egne;
- **migrering**: state skrevet av en pre-D134 worker (kun `head_before`/
  `head_after`, ingen verdikt) leses som UVERIFISERT, ikke som forfatterskap.

Merk også: `fixtures/fake-git.mjs` modellerer `git worktree list/add/remove`,
og en ikke-tvunget `remove` FEILER der på en skitten worktree akkurat som i ekte
git — en alltid-lykkes-stub ville skjult nettopp egenskapen testen skal bevise.
`fixtures/fake-claude.mjs` kan opptre både som et VELOPPDRAGENT barn (stempler
trailerne fra den attempt-ID-en workeren faktisk eksporterte) og som et
GLEMSOMT barn (`JARVIS_FAKE_CLAUDE_NO_TRAILER=1`), fordi de to skal gi ULIKE
verdikter og begge må kunne uttrykkes.

og v2.10 (D-135, PR #80-review runde 4) legger til:

- **fullføringsporten som en EGENSKAP, ikke bare en record**
  (`test/provenance.test.mjs`): hvert av de fem uverifiserte verdiktene holder en
  suksessrapport, mens `unchanged`/`task_attributed` slipper gjennom; en
  MISLYKKET terminalrapport portes ikke; et verdikt som SER verifisert ut men har
  `verified` degradert (nøyaktig formen `provenanceForResume` produserer ved
  drift) holdes likevel, fordi begge halvdelene kreves; og `completionGateHeld`
  leser kun et POSITIVT `held === true` — ikke en manglende, legacy- eller
  misformet verdi;
- **ADVERSARIELL TEST MOT EKTE ENTRYPOINT: fremmed commit + betrodd
  `STATUS=COMPLETE`** (`test/worker-task-worktree.test.mjs`). Begge halvdelene er
  ekte: rapporten er faktisk postet av den betrodde forfatteren med
  `STATUS=COMPLETE`, og commiten er faktisk en annen git-identitets, racet inn i
  den claimede worktreen mens forsøket kjører. Bevist: tilstanden blir `blocked`
  med `successful: false` (ikke `completed`), `completed_at` settes ikke,
  `completion_confirmed` emitteres ALDRI, worktreen/claimen og den fremmede
  commiten består, og recorden pensjonerer ikke en strengt eldre task — den
  eldre KJØRER faktisk på neste runde. Én test kjører med en REN worktree, siden
  frigivelse uansett nekter på en skitten worktree: uten den ville retensjonen
  ikke kunne tilskrives porten. En KONTROLL med samme rapport og ingen fremmed
  commit fullfører helt normalt, så testene ikke kan tilfredsstilles av en worker
  som bare aldri fullfører noe;
- **porten i rekonsilieringsbanen** (`test/worker-queue-reconciliation.test.mjs`):
  en `COMPLETE`-rapport som ankommer utenfor et forsøk parkeres mot det durabelt
  registrerte verdiktet, blir ikke re-dispatchet, og gir ikke exit 0;
- **eksakte grensetester for >50-commit-kanten** (`test/provenance.test.mjs`):
  nøyaktig 50 ekte commits er verifisert; 51 der den ENESTE fremmede er den
  siste — den eksakte saken den gamle koden verifiserte feilaktig — er
  `partially_attributed`, uverifisert, med den fremmede commiten NAVNGITT;
  fremmed commit på plass 500 av 500 finnes fortsatt; og et spenn workeren nektet
  å lese i sin helhet er `unknown`, aldri et verdikt om prefiksen. `gitLogRange`
  ber om `limit + 1` og rapporterer `truncated` som et faktum
  (`test/git.test.mjs`).

og v2.11 (D-136, PR #80-review runde 5) legger til:

- **KRASJVINDUET MOT EKTE ENTRYPOINT OG EKTE GIT**
  (`test/worker-crash-provenance.test.mjs`, 10 tester). Vinduet lages ikke opp:
  et ekte barn poster en ekte betrodd `STATUS=COMPLETE`, og forelderen
  SIGKILL-es av testen mens rapporten finnes og etter-dispatch-sjekkpunktet ennå
  ikke er nådd. Én test fastslår selve FORMEN — `status=in_progress`,
  `commit_provenance` `undefined`, `head_after` `undefined`, men durabel claim,
  ekte worktree og en betrodd COMPLETE-rapport — altså nøyaktig det D-135 slapp
  gjennom. Så flytter en UVEDKOMMENDE SKRIVER (annen git-identitet, egen fil)
  den claimede worktreens HEAD. Bevist ved restart: exit 3, `blocked`,
  `successful: false`, ingen `completed_at`, ALDRI `completion_confirmed`, ingen
  frigivelse, ingen fjerning, ingen supersesjon — og claim, worktree, den
  fremmede commiten og filen dens står nøyaktig der de var. Den holdte recorden
  pensjonerer heller ikke en strengt ELDRE task: den eldre kjører på neste runde.
- **POSITIVE KONTROLLER i samme vindu**, uten hvilke alt over ville vært
  tilfredsstilt av en worker som bare aldri fullfører noe etter et krasj:
  (a) URØRT HEAD + betrodd COMPLETE og (b) et FULLSTENDIG trailer-attribuert
  spenn + betrodd COMPLETE rekonsilieres begge normalt, uten re-dispatch, med
  `completion_confirmed` emittert og — i (b) — worktreen frigitt og claimen
  beholdt som `released`.
- **MIGRERING**: en pre-D-133-rad (ingen claim i det hele tatt) og en
  pre-D-134-rad (rå `head_after`, intet verdikt) parkeres begge, aldri fullføres;
  fravær av verdikt gir ingen tillit.
- **utledningen som enhet** (`test/reconcile-provenance.test.mjs`, 32 tester,
  ekte git og ekte linked worktrees): de positive utfallene (urørt HEAD, fullt
  attribuert spenn, commit stemplet av et TIDLIGERE forsøk av samme task), de
  adversarielle (fremmed commit, blandet spenn, manglende trailere, tilbakespolt
  ref), og hver eneste nektelse som UKJENT — manglende/uleselig/fremmed/
  ikke-`ready` claim, manglende baseline, manglende attempt-ID, fjernet worktree,
  uregistrert sti, uleselig `worktree list`, uleselig HEAD, uleselig spenn og
  usikker `TASK_ID`. Pluss at ankeret er claimens baseline (en fremmed commit fra
  et tidligere forsøk telles fortsatt), at degradering kun går én vei, og at
  utledningen ikke skriver, fjerner eller omskriver noe som helst.

Ikke dekket av vitest og må kjøres på hosten: ekte PowerShell AST-parsing
(`verify-scripts.ps1`), ekte Task Scheduler-registrering, og ekte
reboot-persistens.

En ferdig CI-jobb som kjører den EKTE PowerShell-parseren og hele worker-suiten
på `windows-latest` ligger i `ci/worker-scripts-windows.job.yml`. Den kunne ikke
legges inn i `.github/workflows/ci.yml` herfra: GitHub-tokenet mangler
`workflow`-scope (`remote rejected ... without workflow scope`). Lim den inn rett
før `gitleaks:` med et token som har det scopet.
