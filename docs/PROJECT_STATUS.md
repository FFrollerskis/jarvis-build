# PROJECT STATUS

**Oppdatert:** 2026-09-07 (branch `claude/worker-self-recovery-20260907`, PR #75, base
`main=94e4aaa528477fbdc87ce8f4f6c37cb9d3bebb1d`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

**Infrastrukturreparasjon, review-runde 7: `D126-HEARTBEAT-CI-CLOSEOUT-20260907-F`** (byggeordre
5574439334 på issue #68, `REVIEW_RESULT=CHANGES_REQUIRED`,
`TASK_TYPE=BOUNDED_REVIEW_FIX_AND_EVIDENCE_RECONCILIATION`, base-HEAD `3734c0e`).
Samme branch, samme PR #75.
**Eksplisitt bestilt av eieren, IKKE en masterplan-slice og IKKE en ny produktkapabilitet.**
Ingen faseport er passert, ingen UA-slice er startet, ingen produkt-sannhetsflagg er flippet.
Full begrunnelse: D-126, D-126a til D-126f i DECISIONS_AND_ASSUMPTIONS.md.

Runde 7 lukker nøyaktig tre ting: den gjenstående defekten i dispatch-ens feilbane (heartbeat-
callbackene lå utenfor handoff-gaten), en CI-divergens på SAMME SHA som måtte diagnostiseres i
stedet for kjøres bort, og en read-only rekonsiliering av host-sannhet. Ingenting annet.

## Runde 1 (v2) - hva som ble reparert

Fire uavhengige, produksjonsobserverte feil i den lokale worker-loopen: kladd i repoet som blokkerte
dirty-guarden permanent (A), `processed_task_ids.push()` som registrerte en `ETIMEDOUT` som «ferdig»
(B), en lås basert på pid + aldersbudsjett (C), og en blokkert worker som gikk stille ut med exit 0
(D). I tillegg en håndredigert `.ps1` fra mobil som ga ParserError uten at noe rapporterte det.

## Runde 2 (v2.1) - syv P1-feil arkitekten fant i den faktiske v2-koden

Grønn CI beviste dem ikke fraværende: ingen test kjørte det ekte entrypointet under krasj, ingen
brukte ekte samtidige prosesser, ingen injiserte feil i durabilitets- eller installasjonsbanen.

| # | Faktisk feil | Arkitektens repro | Rettet |
|---|--------------|-------------------|--------|
| 1 | Kandidat valgt FØR låsen + `isEligibleNow` avviser alltid `IN_PROGRESS` ⇒ krasj midt i dispatch kunne aldri kjøre igjen. Barnets pid lagret først ETTER `runClaude`. | `CRASHED_IN_PROGRESS_ELIGIBLE=false` | rekkefølge lås → state → recovery → kandidat; identitet (pid+starttid+host) persistert ved spawn; levende foreldreløst barn beskyttes med etterkommer-regnskap; bundet levetidsbudsjett så pid-gjenbruk aldri blokkerer permanent |
| 2 | Låsen publisert som TOM `wx`-fil før JSON; heartbeat trunkerte samme fil; tomme låser slettet umiddelbart; samtidige reclaimere slettet hverandres låser; state lest før og skrevet uten lås | `EMPTY_LOCK_RECLAIMED=true` | link-atomisk publisering, rename-atomisk heartbeat, innholdsverifisert reclaim, eierskaps-token, state lest ETTER låsen, egen append-only journal for status-dedup |
| 3 | Korrupt primær kopiert over eneste gode backup; `migrateState(null)` ble tom historikk | `BACKUP_AFTER_RECOVERY_SAVE=corrupt`, `NULL_STATE_ACCEPTED_AS_EMPTY=true` | skjemavalidering (worker + supervisor), backup-rotasjon kun fra verifisert gyldig primær, `first_run` skilt fra tapt state |
| 4 | In-place kopiering over levende deployment; `run-worker-safe.ps1` slettet mens en oppgave kunne peke på den; fungerende oppgave avregistrert FØR ny registrering kunne feile; rollback lot innførte moduler/oppgaver stå og håndhevet ikke gamle hasher | — | transaksjonell stage → verifiser → bytt → auto-rollback i Node (`lib/deploy.mjs`), rename-over per fil, utsatt aktivering med handoff-markør ved levende lås, probe-basert registrering som bevarer hostens principal/shell, hash-håndhevet rollback som også fjerner det installasjonen innførte |
| 5 | Kommanderte restarts hoppet over budsjett/backoff; to like `COMMAND_ID` i én batch kjørte begge; kommando merket utført FØR start uten rekonsiliering; utsatte forespørsler ble konsumert; `Start-ScheduledTask` kunne rapportere ok etter ikke-terminerende feil | — | durable intent → effect → result → receipt; per-kommando revalidering mot fersk observasjon; rekonsiliering fra faktisk host-bevis; kvitterings-retry uten å gjenta effekten; bevart utsettelse; terminerende PowerShell-feil med verifisert sentinel |
| 6 | Hele TASK_ID-sluggen finnes ikke i faktiske branch-navn ⇒ retry ville duplisert branch/PR/merge; feilede GitHub-oppslag ble tomme lister | `KNOWN_D125_BRANCH=null KNOWN_PR=null` | eksakte persisterte branch-/PR-assosiasjoner fra state og betrodde protokollkommentarer; paginering; `{ok, items, error}` så et feilet oppslag aldri leses som «ingen PR finnes» |
| 7 | `gitStatusLines` ignorerte exit/feil og leste manglende stdout som «rent»; `claudeArgs` defaultet til `--dangerously-skip-permissions`; ingen grense-/path-/TASK_ID-/vertsbindingsvalidering; `TEMP` hindrer ikke relative kladdefiler | — | `lib/git.mjs` fail-closed; `lib/config.mjs` påkrevd eksplisitt `claudeArgs` + bounds + path-containment + ekte vertsbinding; `isValidTaskId`; eksplisitt scratch-sti og kladdedisiplin i prompten |

## Runde 3 (v2.2) - bekreftet kildedefekt i låsen, og harness-defekten

Arkitekten bekreftet en KILDEDEFEKT, ikke en flaky test: `removeVerified` omdøpte den NÅVÆRENDE
låsen til en tombstone FØR bytene ble sammenlignet med det klassifiserte øyeblikksbildet.
rename-så-sammenlign er ikke en atomisk compare-and-delete; i vinduet er den offentlige stien tom.

Reprodusert lokalt på nøyaktig `efa62d7`-modulen (kopi i scratch, ett tillagt observasjonspunkt rett
etter `renameSync`, ingen endret beslutning), og samme skjema mot den nye koden:

```
v2 (efa62d7): existingOwnerAcquired=true  challengerAcquired=true
              reclaimResult=lock_changed_during_reclaim
              existingOwnerStillHolds=false challengerStillHolds=true
v3 (denne):   existingOwnerAcquired=true  challengerAcquired=false
              reclaimResult=active
              existingOwnerStillHolds=true  challengerStillHolds=false
```

Rettet ved å bytte primitiv: **create-if-absent** (`link()` / `open(wx)`) er den eneste ekte
enkeltvinner-operasjonen filsystemet gir, og låsen er nå en append-only hovedbok `<lockFile>.d/`
med `<generasjon>.claim`. Ingen prosess omdøper, overskriver eller sletter en sti den ikke selv
opprettet; en foreldet claim BLIR FORBIGÅTT av en høyere generasjon, aldri fjernet. Full
beskrivelse av primitivet og feil-/gjenopprettingssemantikken: `ops/claude-worker/README.md` og
D-126b.

Harness-defekten er også rettet: `lock-racer.mjs` bruker eksplisitt READY → START → ATTEMPT →
RELEASE, og gjensidig utelukkelse dømmes av INTERVALLER (ingen to kritiske seksjoner får overlappe),
ikke av en telling av `acquired`. Alle forventede barn må levere resultatfil og avslutte med exit 0.

Deployment-forpliktelsen er lukket i denne runden: `install-task.ps1`/`install-supervisor.ps1`
skriver en DURABEL INTENSJON i install-manifestet FØR noen registrering og avbryter installasjonen
hvis den ikke kan skrives; `reconcile-task-intents` løser krasj-vinduet fra vertens eget svar; og
rollback avregistrerer også ubekreftede intensjoner for oppgaver som ikke fantes fra før.

## Runde 4 (v2.3) - en tilbaketrukket claim kunne fortsatt maskere en levende forgjenger

Arkitekten leste den faktiske `lock.mjs` på `f839668` og reproduserte deterministisk én gjenstående
P1-feil - i selve den NYE append-only hovedboken. Den grønne CI-kjøringen 34086249211 dekket ikke
dette interleavinget.

`confirmOwnership()` re-probet generasjon N-1 korrekt, men `retractOwnClaim()` skrev N som en
ORDINÆR `state: "released"`, og eierskap ble lest av RÅ maksimum. Da kunne en FEILET utfordrer gi
bort låsen: gen 1 lever → en foreldet reclaimer publiserer gen 2 → bekreftelsen ser korrekt at 1
lever og trekker 2 tilbake → en tredje anskaffer ser bare en «released» gen 2, tror låsen er fri,
publiserer gen 3 og re-sjekker KUN mot 2. Den levende gen 1 mistet `holdsLock()`.

Reprodusert lokalt på nøyaktig `f839668`-modulen og på den rettede modulen, fra samme driver, uten
sleeps (scratch utenfor repoet):

```
f839668: firstAcquired=true  secondAcquired=false generation2StateOnDisk=released
         thirdAcquired=true  firstStillOwnsLock=false thirdOwnsLock=true
v2.3:    firstAcquired=true  secondAcquired=false generation2StateOnDisk=void
         thirdAcquired=false firstStillOwnsLock=true  thirdOwnsLock=false
```

Rettelsen er en tredje krav-tilstand, ikke en rekkefølgelapp: `released` = «EIDE låsen og ga slipp»
(avslutter avstamningen), `void` = «EIDE ALDRI noe» (TRANSPARENT - oppslaget går videre nedover til
det EFFEKTIVE kravet). Ny generasjon appendes fortsatt over RÅ maksimum, så telleren går aldri
bakover. `confirmOwnership()` re-klassifiserer den EFFEKTIVE forgjengeren med samme dom som før
publisering, så også en uleselig forgjenger feiler nå lukket. Kan avstamningen ikke bevises (hull
under et void-krav, uleselig krav på veien, void-kjede som ikke når gen 1) nektes anskaffelsen -
aldri «fri». Eldre `released` + `release_reason: "retracted"` leses som `void`.

## Runde 5 (v2.4) - tre gjenstående P1-blokkere fra den komplette gjennomgangen

Alle tre deler én rot: **en operasjon som IKKE lyktes fikk lov til å se ut som om den hadde
lyktes.**

**Funn 1 - barn-identitet var best-effort, ikke en forutsetning.** `onSpawn` fanget
`persistState`-/heartbeat-feil og logget bare en warning, og `dispatch.mjs` fanget i tillegg enhver
`onSpawn`-exception og lot barnet fortsette. Arkitektens direkte modul-repro med `onSpawn` som
kaster `durable write failed`:

```
f123e650: {"outcome":"completed_exit_0","code":0,"childPid":14}
v2.4:     {"outcome":"handoff_failed","childPid":14,
           "handoff":{"child_terminated":true,"untracked_child_live":false,"identity_state":"gone"}}
```

Rettet med et nytt utfall `HANDOFF_FAILED` og en HÅNDHEVET gate: `onSpawn` kaster nå, og sjekker at
lås-heartbeaten faktisk landet. Feiler handoffen etter prosess-opprettelse, avbrytes barnet i en
bundet eskalering (SIGTERM → grace → SIGKILL) gjennom child-HANDLE - aldri PID-alene - og den
EKSAKTE fangede identiteten re-sjekkes; kun `GONE`/`REUSED` teller som bevis. `MATCH`/`UNPROVEN`/
probe-feil rapporteres sannferdig som `untracked_child_live`. **Child-start-handshake:** ved
`promptDelivery=stdin` skrives prompten - som ER oppgaven - først når identitetsrecord og heartbeat
er durable, så oppgaven kan ikke starte før handoffen er commitet. Barn bevist borte →
`FAILED_RETRYABLE` (exit 4); ikke bevist borte → `BLOCKED` (exit 3) med `child_identity` BEVART.

**Funn 2 - semantisk malformede claims omgikk grace-/fail-closed-regelen.** Bare claims som ikke lot
seg PARSE ble merket malformed, så `{"state":"held"}` fikk `verdict.state:"malformed"` og falt
gjennom `judgeIncumbent` til `ok:true`:

```
f123e650: fersk gen 1 = {"state":"held"} + malformedGraceMs=60000 → acquired=true
v2.4:     samme input → acquired=false, verdict.state=publishing (fersk),
          og etter grace-vinduet: acquired=true, claimen aldri slettet
```

Rettet med `validateClaimSchema` + skjemavalidering FØR noe konkluderes av innholdet (også før
`released`/`void`), og `judgeMalformedClaim` som gir ÉN fail-closed policy for både parse- og
semantisk malformed. Uleselig I/O er fortsatt aldri automatisk supersederbar. Kun en GYLDIG
void-claim er transparent og kun en GYLDIG release frigjør låsen - ellers kunne `{"state":"void"}`
viske ut en levende forgjenger. Sidefunn lukket: uparsbart `heartbeat_at` ga `NaN`, hoppet over
staleness-sjekken og leste som en evig «active» eier.

**Funn 3 - utsatt aktivering var ikke en bevist bootstrap-handoff.** Den nye `run-worker.ps1`
anvender markøren, men den filen ligger selv bare i den stagede payloaden. Startes installasjonen av
den deployerte GAMLE workeren, kaller neste scheduler-tikk den GAMLE entrypointen, som aldri har
hørt om `pending-activation.json`. Påstanden «neste tikk anvender den» var sirkulær, og host-bevis
sier at hosten fortsatt kjører v1.

Rettet med `captureQuiescenceOwners` + `runBootstrapHandoff` (`deploy.mjs bootstrap-handoff`), som
kjøres fra KILDETREET og derfor er kjørbar FØR payloaden byttes. Den venter på at den EKSAKTE
legitime forelder-identiteten avslutter av seg selv, sjekker worker- OG supervisor-quiescence på
nytt, og aktiverer først da transaksjonelt med rollback. Den terminerer ingenting, rører ingen
scheduled task, og krever aldri at den nystagede runneren er aktiv. `install.ps1` starter den
detached ved utsatt aktivering. Den sirkulære påstanden er fjernet fra `run-worker.ps1`,
`activateRelease`, `writePendingActivation` og README; `apply-pending` er nå dokumentert som et
ANDRE nett.

## Runde 6 (v2.5) - de to uoppfylte addendum-kravene

Begge deler én rot: **en garanti som bare gjaldt den banen vi tilfeldigvis testet.**

**Punkt 4 - `argv`-levering omgikk hele den durable pre-execution-gaten.** `config.mjs` aksepterte
fortsatt `promptDelivery: "argv"`, og `dispatch.mjs` bygget `args` ved å legge HELE prompten bakerst
og ga den til `spawn` FØR `onSpawn`. Handoff-gaten fra runde 5 kunne avbryte etter en feilet durabel
skriving, men et argv-barn kunne allerede ha lest og begynt å utføre den autoriserte oppgaven, og en
abort i ettertid kan ikke bevise at den ikke ble konsumert. Alle nye dispatch-tester brukte `stdin`,
så den aksepterte argv-banen var helt utestet.

Rettet med det arkitekten anga som foretrukket: **`stdin` er eneste aksepterte modus.** `argv` og alt
annet avvises i `loadWorkerConfig` OG i `runClaude` selv, FØR `spawn` og før prompten i det hele tatt
bygges - et direkte modulkall går aldri gjennom konfigurasjonsvalidering, og det var nettopp slik
gapet ble reprodusert. Nytt utfall `unsupported_prompt_delivery`: ingen prosess opprettes, så det
finnes ikke noe barn som kunne ha konsumert oppgaven. Prompten er aldri lenger et argv-element;
kommandolinjen bærer bare operatørens `claudeArgs`. `worker.mjs` håndterer utfallet eksplisitt som
BLOCKED i stedet for å falle gjennom til fullførings-vurderingen.

**Punkt 5 - bootstrap-handoffen kunne forlate en utsatt legacy-installasjon for godt.**
`captureQuiescenceOwners` la syntaktisk uleselige låser i en `unreadable`-liste ingen konsumerte, og
utelot semantisk malformede dommer (`classifyLock` → `malformed`, som er nøyaktig det en ekte
legacy-lås uten `host` gir) HELT fra `owners`. `runBootstrapHandoff` konsumerte kun `owners`: med
null fangede identiteter ventet den på ingenting, nådde `assessQuiescence` - som DERIMOT teller de
låsene som blokkere - og returnerte `deferred` med én gang. Den frittstående prosessen avsluttet
deretter. På en legacy-installasjon har den registrerte entrypointen ingen markør-støtte, så
markøren hadde ingen garantert fremtidig konsument.

Rettet: `captureQuiescenceOwners` returnerer nå `{ owners, blockers, unreadable }`, der `blockers`
dekker uleselig, semantisk malformed, ekte legacy-form uten `host`, og lese-/tilgangsfeil.
`runBootstrapHandoff` BLIR VÆRENDE i live og poller fail-closed innenfor ÉN fast bundet deadline på
BÅDE de eksakte fangede identitetene OG blokkererne. Den aktiverer først når alle eiere er bevist
avsluttet (kun `GONE`/`REUSED`) og alle blokkere er borte eller trygt klassifiserbare, og
re-sjekker deretter quiescence. Den terminerer aldri noe, substituerer aldri en annen prosess for en
fanget eier, og lar markøren ligge ved enhver nekting. `assessQuiescence` behandler nå også en
lesefeil som blocker i stedet for som fravær.

## Runde 7 (v2.6) - heartbeat-callbackene, CI-divergensen og host-sannheten

**Funn 1 (kilde) - gaten var definert av ÉN funksjon, ikke av egenskapen.** Handoff-gaten dekket
`onSpawn`, men ikke de to `onHeartbeat`-stedene, og de feiler på tre ulike måter:

- **1a - det umiddelbare kallet lå utenfor try/catch OG over listener-oppsettet.** `dispatch.mjs`
  kalte `onHeartbeat` rett etter en vellykket `onSpawn`, men før `finish`, `close`-/`error`-
  listenerne og timeout-timeren i det hele tatt fantes. En exception der slapp ut av Promise-
  executoren, så `runClaude` REJECTED med et levende barn som ingenting kunne settle. Arkitektens
  repro mot faktisk `runClaude`:

  ```
  3734c0e: {"rejected":"heartbeat persistence failed","kills":0,"writes":0,
            "closeListeners":0,"errorListeners":0}
  v2.6:    {"outcome":"handoff_failed","handoff":{"stage":"first_heartbeat","aborted":true,
            "child_terminated":true},"stdinPayload":undefined,"signals":["SIGTERM"]}
  ```

  `writes:0` var den ENESTE gode verdien der, og den er bevart: prompten - som ER oppgaven - leveres
  fortsatt aldri.
- **1b - tapt eierskap var usynlig.** `lock.heartbeat` rapporterer tapt eierskap ved å returnere
  `false`, ikke ved å kaste. `onSpawn` sjekket dette eksplisitt; `onHeartbeat` i `worker.mjs` kastet
  returverdien.
- **1c - den periodiske callbacken hadde ingen exception-grense.** En throw i en `setInterval`-
  callback er en uncaught exception som river ned hele workeren midt i dispatch.

Rettet: hele settlement-apparatet settes opp FØR handoffen; den første heartbeaten er nå andre
halvdel av gaten inne i samme try/catch (både throw og strikt `false` gir bundet, identitets-sikker
`HANDOFF_FAILED` med `handoff.stage`); intervallet opprettes først når gaten har passert; den
periodiske callbacken har egen grense som REGISTRERER feil i `result.heartbeat` og aldri dreper
barnet - et barn som gjør ekte autorisert arbeid henrettes ikke for vår bokføring. `worker.mjs`
returnerer nå heartbeat-resultatet og feiler LUKKET på `heartbeat.unrecovered`: `BLOCKED` (exit 3)
med bevart `child_identity`, selv når barnet avsluttet med 0 og postet en ekte betrodd rapport.

**Funn 2 (CI) - to kjøringer, samme SHA, ulikt resultat.** Kjøring 34132097909 (`event: push`) feilet
på `apps/api/test/fase3-e2e.test.ts:479`; 34132101745 (`event: pull_request`) var grønn. BEGGE på
`headSha=3734c0e`, samme workflow, samme `ubuntu-24.04`. Det er per definisjon ikke en checkout-
eller event-kontekstforskjell. Diagnose mot faktisk kilde:

- `SessionService.resumeOrCreate` velger aktiv sesjon på `tenant_id`+`person_id` ALENE
  (`session-service.ts:29-34`), så `dev-web` og `dev-voice` deler sesjon og meldingshistorikk.
- `ScriptedAdapter` er deterministisk gitt sin request; det eneste ikke-deterministiske inputet er
  historikken. `conversation.ts:164-168` sender `context.history.slice(-20)`, og tool-scriptet ser
  KUN på `messages.at(-1)`.
- Testen rett foran (§8.D, linje 436) avbryter en SSE-strøm etter 2 tokens. Serversiden lagrer da
  `"… [avbrutt av bruker]"` (`conversation.ts:230`) i en skrivning testen ALDRI venter på. Lander den
  etter neste tests brukermelding, er siste historikk-melding ikke lenger kalenderspørsmålet, tool-
  kallet uteblir, og runde 1s standardtekst returneres - nøyaktig
  `expected 'Hei Tobias, dette er et modellsvar.' to contain 'standup 09:00'`.

Dette er en **test-synkroniseringsdefekt**, ikke en produktdefekt i tool-broen. Ingen assertion er
svekket, ingen rerun-until-green, og **ingen produktendring er gjort** - foreslått bundet scope
ligger til uavhengig review (se `CLAUDE_REPORT`). **Sannferdig om reproduksjon:** 7 lokale kjøringer
av filen på denne HEAD ga 18/18 hver gang. Racet ble IKKE reprodusert lokalt, og det påstås ikke.

**Funn 3 (host) - rekonsiliert READ-ONLY.** `install-manifest.json` for deployment `20260907-140934`
er lest. De registrerte `new_sha256` for `worker.mjs`, `supervisor.mjs` og `lib/dispatch.mjs` er
bit-identiske med `git show 3734c0e:`-versjonene; `task_intents` viser `JarvisClaudeWorker`
`replaced` (bekreftet 14:11:19Z) og `JarvisWorkerSupervisor` `introduced` (bekreftet 14:11:28Z).
Workerloggen viser ubrutt 5-minutters kø-polling 14:16:20Z → 18:26:20Z, og at DEN DEPLOYERTE
workeren dispatchet denne oppgaven 18:31:20Z på `head=3734c0e`. De utdaterte påstandene «ikke
installert» / «hosten kjører v1» er dermed rettet nedenfor. **Merk:** den deployerte
`lib/dispatch.mjs` er pre-fix - rettelsen i denne runden er IKKE deployert.

**Presist nektet, ikke omgått:** `sha256sum` mot de installerte filene og `schtasks /query` ble
nektet av øktens tillatelseslag. Manifest-hashene er derfor manifest-REGISTRERTE, ikke re-hashede
bytes på disk. Ingen installasjon, aktivering, restart, reboot eller task-reregistrering er utført.

## Kvalitetsporter (kjørt i denne økten)

- **`npx vitest run ops/claude-worker/test` → 15 filer / 421 tester passed, kjørt TO ganger,
  421/421 begge ganger** (387 → 421; 34 nye i runde 7). Nye tester i runde 7:
  - `dispatch.test.mjs` (21 → 36), direkte modulkall: arkitektens repro RESOLVER nå til
    `HANDOFF_FAILED` i stedet for å reject-e; `handoff.stage=first_heartbeat`; barnet SIGTERM-es
    (`kills` er ikke lenger 0); `close`- og `error`-listenerne er allerede tilkoblet NÅR callbacken
    kjører (begge var 0); null prompt-bytes (`stdinEnded=false`); ingen armert heartbeat-intervall og
    ingen armert timeout-timer etter abort; eksakt identitet bevart ved `MATCH`; strikt `false` fra
    første beat feiler gaten akkurat som en throw; `undefined` er fortsatt SUKSESS; og for den
    periodiske banen: en throw rejecter ikke og dreper ikke barnet, oppgaven ER levert, utfallet
    rapporteres sannferdig som `completed_exit_0` MEN med `heartbeat.unrecovered=true`; en feil som
    kommer seg er `degraded` men ikke `unrecovered`; tapt eierskap er sticky og stopper beatingen; en
    helt frisk kjøring rapporterer null degradering; beatingen stopper når dispatchen settler.
  - `worker-crash-recovery.test.mjs` (37 → 56), EKTE entrypoint som OS-prosess: fire nye
    fault-injections (`first_heartbeat_throw`, `first_heartbeat_lost_lock`,
    `periodic_heartbeat_throw`, `periodic_heartbeat_lost_lock`). Første-beat-feil gir non-zero exit,
    `HANDOFF FAILED`, ingen `UnhandledPromiseRejection`, ingen `prompt.txt`, null usporede levende
    barn, sannferdig abort-verifisering, frigjort lås og nøyaktig én ny dispatch etterpå. Periodisk
    feil bruker ny fixture-modus `report-slow`: barnet POSTER en ekte betrodd `CLAUDE_REPORT` og
    avslutter med 0 etter å ha overlevd ett heartbeat-intervall - workeren krasjer ikke, dreper ikke
    barnet, og parkerer likevel `BLOCKED` (exit 3) med `heartbeat_failures`/`heartbeat_ownership_lost`
    registrert, og en påfølgende kjøring starter ingen ny Claude. Kontrolltest: en UFAULTET treg
    kjøring fullfører normalt, så fail-closed-grenen fyrer ikke på en frisk lang kjøring.

  Historikk fra runde 6, uendret (359 → 387):
  - `dispatch.test.mjs` (11 → 21): `stdin` er hele det aksepterte settet; direkte modulkall med
    `argv`, `carrier-pigeon`, `""`, `null` og `undefined` spawner INGENTING (`spawned=0`,
    `promptBuilt=false`, aldri `completed_exit_0`); prompten er aldri i argv; og for HVER akseptert
    modus: injisert persistens-feil OG injisert heartbeat-feil gir null prompt-bytes til barnet
    (`stdinEnded=false`, ikke bare tom payload), pluss rekkefølgebevis for at persist og heartbeat
    begge commiter før første prompt-byte;
  - `config.test.mjs` (26 → 28): `argv` avvises med begrunnelsen, `stdin` aksepteres både eksplisitt
    og som default;
  - `worker-crash-recovery.test.mjs` (31 → 37): ekte entrypoint (`node worker.mjs run` som OS-
    prosess) nekter å starte på `argv`-config (null invocations, ingen `prompt.txt`, ingen
    `argv.json`, tasken aldri berørt); et EKTE barn får aldri oppgaven på kommandolinjen (fixturen
    logger nå sin egen `process.argv`, som er nøyaktig to elementer); og med persistens- eller
    heartbeat-feil injisert er argv rent OG `prompt.txt`/`report-posted` finnes ikke - null
    prompt-konsum, null oppgave-effekt;
  - `deploy.test.mjs` (56 → 66): syntaktisk malformed JSON, ekte legacy-form uten `host` og
    lese-/tilgangsfeil registreres alle som blokkere (ikke som fravær); handoffen POLLER gjennom hver
    av dem og aktiverer når de klarner (`polls >= 3`); en blokker som aldri klarner bruker opp ÉN
    deadline og utsetter med `deadline_expired`, byte-identisk låsefil og markøren intakt; en fanget
    eier som aldri avslutter bruker SAMME ene deadline og den eksakte identiteten bevares i
    rapporten; en ny eier som dukker opp under pollingen gir utsettelse i stedet for overskriving og
    blir aldri adoptert som «forelder»; og en eksplisitt regresjonstest for at den GAMLE feilen -
    utsettelse på poll null - er borte.

Historikk fra runde 5, uendret:

- **`npx vitest run ops/claude-worker/test` → 15 filer / 359 tester passed, kjørt TO ganger,
  359/359 begge ganger.** Nye tester i runde 5:
  - `worker-crash-recovery.test.mjs` (16 → 31): fault-injection gjennom det FAKTISKE entrypointet
    (`node worker.mjs run` som ekte OS-prosess) for state-write-feil OG tapt lås under `onSpawn`.
    Beviser null usporet levende barn, ingen duplikat-dispatch, sannferdig non-zero utfall, at
    oppgaven aldri leveres til barnet, og trygg recovery etterpå (inkludert at en for tidlig retry
    ikke dispatcher, og at nøyaktig én ny dispatch skjer når backoffen er ute). Egen test for at en
    handoff som fortsetter å feile bruker opp forsøksbudsjettet og ender BLOCKED på 4/4 med
    `retry budget exhausted`, exit 3 og fortsatt null usporet levende barn - «forsøket skjedde
    egentlig ikke» er ikke en lisens til å prøve for alltid;
  - `dispatch.test.mjs` (NY, 11): arkitektens eksakte repro, pluss grenene en OS-prosess ikke kan
    fremtvinge - barn som ikke dør, `UNPROVEN`, `REUSED`, probe som kaster, og exit 0 midt i abort;
  - `lock.test.mjs` (42 → 49): fersk/aldret semantisk-malformed, manglende/ugyldig pid, manglende
    host, ugyldig state/owner_token/generation/start_time, uparsbare tidsstempler, `released`/`void`
    uten pid, uleselig I/O uansett alder, og samtidig publisering/re-read;
  - `deploy.test.mjs` (40 → 56): fixture som starter fra en LEGACY deployert destination der
    installert `run-worker.ps1` IKKE har markør-støtte og den registrerte oppgaven peker på den
    gamle entrypointen. Beviser install startet av sitt barn → utsatt og legacy-entrypoint urørt →
    forelder avslutter av seg selv (aldri drept) → kontrollert handoff aktiverer de EKSAKTE stagede
    hashene → scheduled task fortsatt kjørbar. Pluss feilinjeksjon før/etter hvert handoff-steg
    (`beforeWait`, `afterParentExit`, `beforeActivate`, `beforeSwitch`, `afterObsoleteRemoval`,
    `afterActivate`) med bevist rollback, ingen manglende entrypoint, urørt operasjonell data og en
    ren retry.

  `JARVIS_WORKER_FAULT` er TEST-ONLY, følger konvensjonen fra `acquireLock` sin `hooks.afterClassify`,
  og annonseres høylytt i logg + health når den er armert.

Historikk fra runde 4, uendret:

- **`npx vitest run ops/claude-worker/test` → 14 filer / 310 tester passed, kjørt TRE ganger,
  310/310 hver gang. Ingen intermitterende feil observert i den runden.**
  Seks nye tester i `lock.test.mjs`: den eksakte tre-parts-sekvensen deterministisk via
  `hooks.afterClassify` (levende gen 1 → spekulativ gen 2 → tilbaketrukket → gen 3 NEKTES, eieren
  beholder låsen); at eieren fortsatt kan heartbeate og release på tvers av det tilbaketrukne
  kravet OG at låsen ikke deadlocker etterpå; re-lesing fra disk i en HELT NY Node-prosess med
  ekte prosess-prober (restart-oppførsel); bakoverkompatibel lesing av eldre
  `release_reason: "retracted"`; fail-closed på uløselig avstamning; og at en ekte frivillig
  release fortsatt frigjør låsen.

Historikk fra runde 3, uendret:

- **`npx vitest run ops/claude-worker/test` → 14 filer / 304 tester passed.**
  **Sannferdig historikk, ikke en ubetinget påstand:** underveis feilet suiten intermitterende
  (to av fem kjøringer ga 303/304). Feilen ble IKKE kjørt bort. Den ble diagnostisert til
  `lock.test.mjs > a live heartbeating owner is never displaced by six concurrent challengers`,
  der eieren rapporterte `lost_ownership_during_hold=true` - og årsaken var en EKTE Windows-defekt
  i den nye koden, ikke en flaky test: libuv åpner vanlige filer uten `FILE_SHARE_DELETE`, så et
  `rename` over en claim en annen prosess akkurat leser feiler forbigående med `EPERM`/`EACCES`,
  og en lesing under et samtidig `rename` feiler på samme måte. Det ga to reelle feilmoduser:
  (1) en heartbeat som ikke landet ble lest som «jeg har mistet låsen» - som ville avbrutt en frisk
  50-minutters kjøring; (2) en claim som ikke kunne LESES ble klassifisert som «uleselig» og kunne
  dermed forbigås - altså kunne en utfordrer forbigått en levende eier. Rettet: forbigående
  filsystemfeil (`EPERM`/`EACCES`/`EBUSY`/`EMFILE`/`ENFILE`/`EAGAIN`) gir bundet retry med backoff,
  en claim som ikke kunne leses gir `unreadable` og FAIL-CLOSED (aldri «kan forbigås»), og
  harnessen skiller nå `heartbeat_write_failures` fra faktisk tap av eierskap. Ingen assertion er
  svekket. Etter rettelsen: grønt.
  Nye tester i runde 3:
  - `lock.test.mjs` (36 → nå 42): den deterministiske stale-read → erstatningseier → forsinket reclaim →
    utfordrer-sekvensen via `hooks.afterClassify` (nøyaktig punktet v2 var utrygt), åtte ekte
    samtidige OS-prosesser med intervall-bevis, legacy v1/v2-låsefil som respekteres men aldri
    røres, GC som aldri fjerner maksimum;
  - `deploy.test.mjs` (40): åtte nye for durabel registreringsintensjon, inkludert krasj mellom
    registrering og journalføring, «jeg kunne ikke spørre verten» som ALDRI løser en intensjon, og
    at en pre-eksisterende oppgave aldri avregistreres av en rollback.
  Fra runde 2, uendret og fortsatt grønne:
  - `worker-crash-recovery.test.mjs` (16): starter det FAKTISKE `node worker.mjs run` som prosess og
    dreper det før spawn, under barnets kjøring og etter report men før completion-lagring; verifiserer
    at et levende barn beskyttes uten at en andre Claude startes, at en eksisterende report lukker
    tasken uten ny dispatch, og at git-/remote-/dirty-feil blokkerer i stedet for å dispatche;
  - `state.test.mjs` (33): korrupt primær + gyldig backup (eksakt arkitekt-repro), avbrutt skriving,
    `null`/`[]`/`{}`-avvisning, supervisor-skjema;
  - `deploy.test.mjs` (31): injisert feil i hvert steg av byttet, hash-håndhevet rollback, fjerning av
    innførte filer OG av oppgaver installasjonen innførte, bevaring av operasjonelle data, utsatt
    aktivering under levende lås;
  - `supervisor-run.test.mjs` (16) + `supervise-protocol.test.mjs` (19): to like `COMMAND_ID` i én
    poll, budsjett for to unike restarts, krasj før/etter `Start-ScheduledTask`, feilet kvittering,
    bevart utsettelse fra travel til ledig;
  - `config.test.mjs` (26), `git.test.mjs` (13), `recovery.test.mjs` (20).
- `pnpm lint` (eslint på hele repoet): **rent** (runde 7).
- `pnpm typecheck` (alle workspace-pakker): **rent, exit 0** (runde 7).
- `npx vitest run apps/api/test/fase3-e2e.test.ts` kjørt **7 ganger** på denne HEAD: **18/18 hver
  gang.** CI-racet ble IKKE reprodusert lokalt; det påstås ikke å være borte, det er diagnostisert.
- `node --check` på alle endrede `.mjs`-moduler og `JSON.parse` på `config.example.json`: **rent.**
- **Ekte PowerShell-AST-parsing ble IKKE kjørt, og CI-jobben kunne ikke pushes. To uavhengige,
  presist nektede operasjoner:**
  1. `powershell.exe -NoProfile -Command "echo PSOK"` → «This command requires approval».
     PowerShell-kjøring er nektet av tillatelseslaget i denne økten, så
     `System.Management.Automation.Language.Parser` kunne ikke kjøres lokalt.
  2. `git push origin claude/worker-self-recovery-20260907` →
     `! [remote rejected] ... (refusing to allow an OAuth App to create or update workflow`
     `.github/workflows/ci.yml` `without workflow scope)`. GitHub-tokenet mangler `workflow`-scope,
     så CI-jobben kunne ikke legges inn i `.github/workflows/ci.yml` herfra.

  Jobben er derfor levert som **`ops/claude-worker/ci/worker-scripts-windows.job.yml`** — ferdig
  YAML som limes inn rett før `gitleaks:` i `.github/workflows/ci.yml` av noen med `workflow`-scope.
  Den kjører `verify-scripts.ps1` med den EKTE PowerShell-parseren OG hele worker-suiten på Windows.
  **Ingenting er utelatt stille**, og ingen påstand om «alle scripts parser» gjøres uten den kjøringen.
  Statisk kontroll som FAKTISK ble kjørt: alle 8 `.ps1` er ren ASCII uten kontrolltegn (byte-nivå),
  og alle 19 `.mjs` er `node --check`-rene.
- Full produktsuite ble ikke kjørt lokalt i sin helhet (endringene rører ingen produktkode; utenfor
  `ops/` er kun dokumentasjon endret - `.github/` er URØRT, se den nektede push-operasjonen over).
  Den ENE filen CI-divergensen gjaldt er kjørt lokalt 7 ganger, se over. CI på eksakt endelig HEAD
  rapporteres i `CLAUDE_REPORT` på issue #68.

## Flagg-status - oppdatert mot faktisk host-bevis i runde 7

`DEPLOYED_TO_HOST=true` · `SUPERVISOR_INSTALLED=true` · `REMOTE_RESTART_VERIFIED=true` ·
`WORKER_SELF_RECOVERY_VERIFIED=false` · `REBOOT_PERSISTENCE=UNVERIFIED` ·
`SOURCE_CHANGED=true` · `ARCHITECT_MERGE_APPROVED=false`.

**Hva de tre true-flaggene faktisk betyr - ikke mer:**

- `DEPLOYED_TO_HOST=true`: deployment `20260907-140934`, manifest-registrerte `new_sha256` for
  `worker.mjs`/`supervisor.mjs`/`lib/dispatch.mjs` er bit-identiske med `git show 3734c0e:`.
- `SUPERVISOR_INSTALLED=true`: `JarvisWorkerSupervisor` `introduced`/`confirmed` 14:11:28Z, og
  supervisoren har postet en ekte `SUPERVISOR_RECEIPT` på issue #68.
- `REMOTE_RESTART_VERIFIED=true`: KUN kommandert start av en FRISK worker - supervisor-kvittering
  14:15:23Z fulgt av kø-poll 14:15:24.949Z. Kvitteringen selv sier at den ikke er beviset; polleren
  er det. **Ingen prosess ble terminert, så dette er ikke crash recovery.**

**Fortsatt ubevist, og påstås ikke:** automatisk crash recovery (ingen krasj er indusert), reboot-
persistens, en post-restart probe med ACK+REPORT, og full E2E PASS. **Den deployerte
`lib/dispatch.mjs` er pre-fix** - heartbeat-rettelsen i runde 7 er IKKE deployert. Ingenting er
installert, registrert, startet, restartet eller reregistrert av denne økten.

Uendret av denne oppgaven: `UA7_COMPLETE=false`, `UA7_ACCEPTANCE_4=PARTIAL`,
`Q32_POINT1=OPEN_EXTERNAL_OWNER_ACTION`, `D108_COMPLETE=false`, `UA6_COMPLETE=false`,
`NEW_PROVIDERS_ADDED=0`, `NEW_CREDENTIALS_OR_SCOPES=0`, `CORE_DEPENDENCY_DECISION_REQUIRED=false`.

## Normativ endring, akseptert av arkitekten

`D126_AMENDMENT_ACCEPTED=true` (byggeordre 5563925449): kilden til worker-infrastrukturen spores i
`ops/claude-worker/`, eksplisitt utenfor pnpm-workspacet og produktbygget, mens deployert
runtime/state/scratch forblir utenfor repoet i `%USERPROFILE%\.jarvis-claude-worker\`.

## Blokkeringer

- **Ekte PowerShell-parse-verifisering ikke kjørt lokalt** - `powershell.exe` nektet av
  tillatelseslaget i økten. Må kjøres på hosten (`.\verify-scripts.ps1`) før installasjon.
- **CI-jobben for Windows kunne ikke pushes** - GitHub-tokenet mangler `workflow`-scope
  (`remote rejected ... without workflow scope`). YAML-en ligger klar i
  `ops/claude-worker/ci/worker-scripts-windows.job.yml` og må limes inn i
  `.github/workflows/ci.yml` av noen med det scopet. Dette er en ekstern tilgangsblokkering, ikke et
  utelatt krav.
- **Ny deployment av heartbeat-rettelsen avventer bevisst fersk uavhengig arkitekt-review.** Hosten
  kjører nå D-126-koden fra `3734c0e` (bevist i runde 7), men den er PRE-FIX for denne rundens
  dispatch-korreksjon. Ingen merge, ingen installasjon, ingen restart/reboot/reregistrering utført av
  denne økten - en senere, uavhengig gjennomgått oppgave må autorisere oppdatert deployment + probe.
- **Åpen, ikke-autorisert i denne runden: test-synkroniseringsdefekten i `fase3-e2e.test.ts`.**
  Diagnostisert (se runde 7 over), men bevisst IKKE rettet - byggeordren krever uavhengig review av
  et eventuelt separat produkt-/testscope først. Foreslått bundet scope ligger i `CLAUDE_REPORT`.
- `HARD_EXTERNAL_BLOCKER=true`, `BLOCKER_SCOPE=WINDOWS_HOST_VERIFICATION_AND_LATER_INSTALLATION_ONLY`.
  Blokkeringen gjelder PowerShell-/Task Scheduler-verifisering på hosten og senere installasjon;
  den blokkerer ikke kildekorreksjonene over, og den er ikke omgått.

## Neste oppgave

1. Fersk uavhengig ChatGPT-arkitekt-review av den rettede diffen på PR #75 (INGEN self-approval,
   `ARCHITECT_MERGE_APPROVED=false`).
2. Etter godkjent review, på hosten i rekkefølge: `.\verify-scripts.ps1` → `.\install.ps1 -WhatIf` →
   `.\install.ps1` (utsettes automatisk hvis workeren kjører; installasjonen starter da den
   kontrollerte bootstrap-handoffen, som venter på at den eksakte forelderen avslutter og deretter
   aktiverer - den krever IKKE at den nye `run-worker.ps1` allerede er live) → config-filer →
   `node worker.mjs status` / `run --dry-run` → `.\install-task.ps1` → `.\install-supervisor.ps1`.
3. Endelig akseptanse krever, i tillegg til fixture-testene: deployerte skript-hasher/versjon, den
   FAKTISKE registrerte scheduled-task-kommandolinjen på hosten (for å bekrefte hvilken entrypoint
   som virkelig kjører), en observert ekte bootstrap-handoff, en ekte planlagt kjøring som fullfører
   en ufarlig autorisert probe, og en ekte `RESTART_WORKER`-kvittering. Først da kan
   `WORKER_SELF_RECOVERY_VERIFIED`, `SUPERVISOR_INSTALLED` og `REMOTE_RESTART_VERIFIED` settes true -
   individuelt, aldri samlet. **Installasjon er ikke påstått fra fixtures.**

Ingen påstand om at alle framtidige feil er umulige. Runde 2 fjerner syv konkrete, uavhengig
reproduserte feilmoduser, runde 3 og 4 hver sin uavhengig reproduserte P1-feil i gjensidig
utelukkelse, runde 5 tre gjenstående P1-blokkere fra den komplette gjennomgangen, runde 6 de to
uoppfylte addendum-kravene (argv-levering uten pre-execution-gate, og en bootstrap-handoff som kunne
forlate en utsatt legacy-installasjon), runde 7 de tre heartbeat-callback-stedene som lå utenfor
handoff-gaten - og resten gjøres synlig i stedet for stille. At denne bundne oppgaven er ferdig
betyr IKKE at de gjenstående gruppene i den opprinnelige gjennomgangen er godkjent.
