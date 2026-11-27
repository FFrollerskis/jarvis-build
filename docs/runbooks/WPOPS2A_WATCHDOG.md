# WP-OPS2a: vakthunden, selvdiagnosen, EV-19-koblingen og C13/C14 i UA-0-gaten (JARVIS-041-resten, EV-1/H2, OPS-RUNTIME)

**Status (2026-11-26): BYGGET OG TESTET I SANDKASSEN (ekte embedded Postgres som begrenset rolle, falsk klokke, falsk `send`, falsk `docker`) - IKKE KJØRT MOT NAS-en, IKKE DEPLOYET, INGENTING ER `VERIFIED`.**
**Fiks-runde 1 (2026-11-27)** etter dobbel uavhengig review (reviewer A: K2/K3/wiring, reviewer B: K1/K4/K5/docs): 3 MEDIUM og 19 LOW er lukket i kode og tester, INFO er ført som kjente grenser i §11; oversikt punkt for punkt i §12. Fortsatt `NOT VERIFIED` på NAS.
Beslutning: **D-490** (føres i beslutningsloggen av lead; denne grenen rører ikke `DECISIONS_AND_ASSUMPTIONS.md`, `OPEN_QUESTIONS.md`, `FINDINGS_LEDGER.md`, `PROJECT_STATUS.md`, `CLOSURE_MATRIX_HF1_HF2.md` eller `OWNER_ACTIONS_HF1_HF2.md`).
Branch `claude/wp-ops2a-watchdog`, base `main` = `71a31d8b`. `CORE_DEPENDENCY_DECISION_REQUIRED=false`: ingen ny leverandør, ingen ny compose-tjeneste, ingenting i `.github/`. Den eksterne monitoren er **eierens eget valg** (ingen leverandør er bygget inn, ingen leverandørfakta er brukt).
Migrasjon: **ingen** (157 er reservert og ikke brukt). Designet trenger ingen: alt som leses (`incident_producer_runs`, migrasjon 098) og alt som telles (`tasks`) finnes fra før, og det skrives ingenting nytt.
Nytt miljø: KUN `JARVIS_WATCHDOG_HEARTBEAT_URL` og `JARVIS_WATCHDOG_HEARTBEAT_INTERVAL_SEC`, kun i `SERVICE_ENV.worker`, **AV uten URL**.

## 1. Oversikt: punkt, status, kode, test

`LUKKET FØR` = var allerede rettet før denne grenen (verifisert mot koden, ikke gjort på nytt). `LUKKET HER` = bygget og testet her. `DEFERRED` = bevisst ikke bygget (se §9). Statusord følger `CLOSURE_MATRIX_HF1_HF2.md`.

| Punkt | Status | Statusord | Kode | Test |
|---|---|---|---|---|
| JARVIS-041: tenant-kontekst på `stuck_tasks` (ledgerens «alltid 0» er foreldet) | LUKKET FØR (D-393) | `CODE_FIXED` | `modules/watchdog/src/watchdog.ts:291` (`stuckTasksCheck`, `withTenantTransaction`) | `modules/watchdog/test/fase10-ops.test.ts` (D-393-blokken, l.162) |
| JARVIS-041: tidsavbrudd per sjekk (ledgerens «ingen tidsavbrudd» er foreldet) | LUKKET FØR (D-393) | `CODE_FIXED` | `watchdog.ts:156` (`checkTimeoutMs = 20_000`), `watchdog.ts:215` (`Promise.race`) | `fase10-ops.test.ts` (hengende sjekk gir `critical`-tidsavbruddsvarsel) |
| JARVIS-041: `stuck_tasks` ser BARE eier-tenanten (en fastlåst jobb i en business-tenant var usynlig) | LUKKET HER | `WIRED` (i worker; `NOT VERIFIED` på NAS) | `watchdog.ts:343` (`stuckTasksAllTenantsCheck`), `apps/api/src/worker-main.ts:616`, `modules/core/src/services/tenant-catalog.ts:67` (`listAllTenantIds`, ny `quiet`) | `modules/watchdog/test/wpops2a-stuck-tasks-all-tenants.test.ts` (16), `wpops2a-fix1-stuck-tasks.test.ts` (15, ekte Postgres), `w1-production-wiring.test.ts` (oppdatert bevisst) |
| EV-1/H2: «watchdog UKJENT» i selvdiagnosen (ingen leser) | LUKKET HER | `WIRED` for lesing; `DORMANT` uten `JARVIS_INCIDENT_PRODUCERS_ENABLED=true` | `apps/api/src/watchdog-status.ts:89` (`observeWatchdogRun`), `self-model-readers.ts:204`, `modules/executive/src/self-model/limitations.ts:82`, `main.ts:228` og `main.ts:1191` | `apps/api/test/wpops2a-watchdog-reader.test.ts` (23), `wpops2a-fix1-k1-reader.test.ts` (19), `wpops2a-watchdog-reader-db.test.ts` (6, ekte Postgres), `modules/executive/test/wpops2a-watchdog-limitation.test.ts` (3), `wpops2a-fix1-ops-proposals.test.ts` (7) |
| JARVIS-041: en død/hengt worker er stille (vakthunden kan ikke varsle om seg selv) | LUKKET HER som ekstern dead man's switch | `DORMANT` (AV uten URL); eierens monitor er `BLOCKED_EXTERNAL` | `watchdog.ts:187` (`lastCompletedTickAt`) og `:195` (`lastCompletedTickAgeMs`, monoton), `apps/api/src/watchdog-heartbeat.ts:127` (`startWatchdogHeartbeat`), `worker-main.ts:654`, `heartbeat-sender.ts:54` (`validateHeartbeatUrl`) og `:106` (`makeSendPing`, generalisert) | `wpops2a-watchdog-heartbeat.test.ts` (26), `wpops2a-heartbeat-generalization.test.ts` (8), `wpops2a-fix1-heartbeat-clock.test.ts` (6), `wpops2a-fix1-heartbeat-url.test.ts` (10), `wpops2a-fix1-heartbeat-wiring.test.ts` (8), `modules/watchdog/test/wpops2a-last-completed-tick.test.ts` (6), `wpops2a-fix1-watchdog.test.ts` (7), `wpc2-heartbeat-sender.test.ts` (15, urørt) |
| EV-19-koblingen (OPS-RUNTIME: `BUILT_UNWIRED`, «viser backup som utført» var ikke koblet) | LUKKET HER | `WIRED` (kun lesing; kun med `JARVIS_BACKUP_STATUS_FILE`) | `apps/api/src/evolution-source.ts:336` (`MAINTENANCE_COVERAGE`), `:368` (`backupCoverage`), `:412` (`maintenanceSection`), `main.ts:256` | `evolution-source.test.ts` (55), `wpb-evolution-source-db.test.ts` (10, ekte fil), `wpops2a-ev19-wiring.test.ts` (4), `wpops2a-fix1-k4-coverage.test.ts` (9) |
| C13 (backup-status) og C14 (vakthund) i UA-0-gaten | LUKKET HER | `BUILT` (`NOT VERIFIED` på NAS) | `ops/acceptance/nas-ua0-gate.sh:149` (C13), `:217` (C14) | `ops/acceptance/test/nas-ua0-gate.test.mjs` (23), `wpops2a-fix1-ua0-gate.test.mjs` (22), `apps/api/test/wpops2a-fix1-c14-sql.test.ts` (7, ekte Postgres) |
| JARVIS-075: migrator (lås, sjekksum, navnevakt, plan, admin-konfig) | LUKKET FØR (D-395) | `CODE_FIXED` (delvis) | `modules/core/src/db/migrator.ts:116` (advisory lock), `:78` (`planMigrations`), `:166` (`runMigrationsAsAdmin`) | `modules/core/test/d395-migrator.test.ts`. Resten (ned-migrasjoner, backup før migrasjon, PG16 til 17) er vertshandlinger: `DEFERRED`, se §9 punkt 7 |
| JARVIS-054-resten | `DEFERRED` | ligger i WP-P3 | - | - |
| JARVIS-053-resten | `DEFERRED` | eierbeslutninger (JARVIS-030/074: oppbevaring og sletting av `audit_events`/`policy_decisions`) | - | - |
| Vakthund som egen prosess, varig tilstand uavhengig av hendelsesautomatikken, API-side «vakthund står»-produsent, EV-1 confidence-gate, EV-7 i CI, connector-helse via DB, backup-før-migrasjon, claude-worker | `DEFERRED` (OPS2b) | se §9 | - | - |

## 2. Flagg og miljøvariabler

| Variabel | Prosess | Standard | Verdi | Virkning |
|---|---|---|---|---|
| `JARVIS_WATCHDOG_HEARTBEAT_URL` | **worker** (kun) | tom = **AV** | `https://...` med et offentlig vertsnavn (`http://` kun mot 127.0.0.1/localhost; https mot loopback, privat, link-local eller uspesifisert IP-literal og `localhost` avvises, og det samme gjelder IPv6-literaler og understrek i vert, som utsendingsvernet uansett ville avvist). Ugyldig verdi starter IKKE heartbeaten og logger `watchdog_heartbeat_config_invalid` (variabelnavnet, aldri URL-en) | workeren pinger din EGEN eksterne monitor kun mens vakthunden lever (se §6). URL-en er en kapabilitet (nøkkelen står ofte i stien): behandle den som en hemmelighet, den logges aldri |
| `JARVIS_WATCHDOG_HEARTBEAT_INTERVAL_SEC` | **worker** (kun) | 60 | heltall 10-3600 (ugyldig: samme logglinje, ingen oppstart) | tid mellom pingene |
| `JARVIS_INCIDENT_PRODUCERS_ENABLED` | api, worker (fra før, WP-E1) | tom = AV | kun eksakt `true` | **forutsetning for K1 og C14**: uten den registreres vakthundens tikk ikke varig, og selvdiagnosen/C14 viser UKJENT med den årsaken |
| `JARVIS_BACKUP_STATUS_FILE` | api (fra før, WP-C2) | tom | absolutt sti til den monterte statusfilen | forutsetning for K4 (EV-19) og for backup-leseren i selvdiagnosen; uten den er backup-oppgavene i EV-19 «ikke dekket» |
| `JARVIS_WATCHDOG_INTERVAL_MS` | api, worker (fra før, D-187) | 60000 | 1000-3600000 | vakthundens tikk-intervall; terskelen er maks(3 x dette, 2 min) både for heartbeaten (K3) og for selvdiagnosens `watchdog`-leser (K1, fiks 1): raden leseren ser skrives per vakthund-tikk |

Variablene er lagt i `infra/local/service-env.mjs` (worker) og generert inn i `docker-compose.yml` med `node ops/security/generate-compose-env.mjs --write`; `.env.example` har dem kommentert (AV). Kun for test (ikke drift): `JARVIS_ACCEPTANCE_BACKUP_STATUS_CMD`, `JARVIS_ACCEPTANCE_BACKUP_STATUS_TIMEOUT_SEC`, `JARVIS_ACCEPTANCE_NODE_BIN` (UA-0-gaten). Er en av dem satt, står «(OVERSTYRT, kun test)» på C13-raden (skjerm og evidensfil), slik at en PASS fra en test-seam aldri kan forveksles med en ekte måling.

## 3. Det som endrer standard drift på NAS (alt annet er AV)

1. **`stuck_tasks` teller alle tenants.** Navn, runbook, nedkjøling (30 min) og melding er uendret når katalogen har nøyaktig én tenant (`N jobber med utløpt lease`). Med flere tenants får meldingen suffikset ` (i k tenants)`, og en fastlåst jobb i en business-tenant gir et (ønsket) varsel som tidligere uteble. Tom tenant-katalog, opptellingsfeil, en tenant som ikke kan leses og flere enn 200 tenants gir `ok:false` (warning) - aldri «0 = frisk». **Feilsti (fiks 1, A-L3):** den gamle sjekken kastet ved en feil og ble `critical` «sjekk feilet: <tekst>» (kun én tenant). Den nye gir `critical` («N av N tenants kunne ikke leses») når ALLE vurderte tenants er uleselige (RLS-/rettighetsfeil på `tasks`, en hengt lås, tidsbudsjettet gikk ut før første tenant), og `warning` når bare noen er det. Meldingen har kun antall; årsakene (SQLSTATE) står i loggen `watchdog_stuck_tasks_tenant_read_failed`, aldri rå feiltekst eller tenant-id (den gamle meldingen kunne sitere feilteksten). Hver tenant-telling har `SET LOCAL statement_timeout` på 8 s (en hengt spørring avbrytes og frigir tilkoblingen), og eierens tenant vurderes alltid først (også når katalogen er lengre enn 200). NAS-steg for å vite om du merker noe: `SELECT count(*) FROM tenants`. Ønsker du ikke varsler fra business-tenants, si fra (Q-forslag i sluttrapporten).
2. **Selvdiagnosen: `watchdog` har nå en leser.** Uten produsentene: UKJENT med «incident-produsentene er AV: vakthundens tikk registreres ikke varig» (tidligere UKJENT med «ingen måling tilgjengelig»). Med produsentene på: OK / DEGRADED / DOWN, se §4. Begrensningen `no_cross_process_watchdog_state` får en presis tekst bare når produsentene er på.
3. **EV-19 (Evolusjon-rapporten): `backup_status` og `disaster_recovery_sample_restore` kan bli dekket** (kun med `JARVIS_BACKUP_STATUS_FILE`, kun når filen leses uten feil). En månedlig restore-verifisering som er satt opp men aldri kjørt (`never_run`) gir `ATTENTION` i EV-19 til du har gjort en (ærlig, endrer rapportens status). Er restore-verifisering IKKE satt opp (`restore_verify.state = not_configured`), har oppgaven ingen utfører: den er «ikke dekket» (7 av 23 i stedet for 8) med en `Merk:`-linje, og gir ikke `ATTENTION` (fiks 1, B-L4). Står change freeze på (åpen hendelse, ukjent innsignal), er den i stedet «Stoppet: ... (change_freeze)» uten `ATTENTION`.
4. **UA-0-gaten har 14 sjekker** (C13, C14 er nye), og `nas-hf1-hf2-gate.sh` videreformidler dem i H01: UNKNOWN/WARN gir H01 WARN, FAIL gir H01 FAIL. Uten `JARVIS_BACKUP_DIR` er C13 UNKNOWN; uten produsentene er C14 UNKNOWN. **H01 er derfor WARN som standard** (C14 er UNKNOWN uten `JARVIS_INCIDENT_PRODUCERS_ENABLED=true`, og C13 er WARN så lenge restore-verifisering eller off-site ikke er satt opp); det er forventet og ikke en feil, og heartbeaten for vakthunden (§6) gjør ikke C14 grønn.

Worker uten `JARVIS_WATCHDOG_HEARTBEAT_URL`: ingen timer, ingen utgående kall, ingen loggrad (bevist av testen «AV uten URL»).

## 4. K1: vakthunden i selvdiagnosen

Kilden er den ENE varige sporet av at vakthunden tikker: raden `incident_producer_runs` / `producer='watchdog'` som den eksisterende broen (`createWatchdogIncidentBridge`) skriver for hvert fullførte tikk når produsentene er på. Leseren skriver aldri noe (ingen ny skrivevei, ingen ny tabell). Rent funksjonskall `observeWatchdogRun(rad, nå, vakthund-intervall)` (`JARVIS_WATCHDOG_INTERVAL_MS`; API-et leser samme variabel via `watchdogIntervalMsFromEnv`, tom streng = standard 60 s, ugyldig verdi gir UKJENT):

| Tilfelle | Status |
|---|---|
| ingen rad (`null`/`undefined`), ugyldige verdier (ukjent `last_status`, ugyldig eller manglende tidspunkt, ugyldig klokke, negative/ikke-heltall), ugyldig intervall, **lesefeil** | `UNKNOWN` (aldri OK, aldri en TypeError-tekst; feilteksten siteres aldri) |
| alder under -2 s (klokkeavvik mellom worker og API); en alder mellom -2 s og 0 (en rad workeren skrev mens API-et leste) regnes som 0 | `UNKNOWN` |
| alder over maks(3 x vakthund-intervallet, 2 min) (standard 60 s gir 3 min; SAMME formel som heartbeaten, `watchdogFreshLimitMs`), «har ikke tikket på N min» | `DOWN` |
| `last_status` `failed`/`skipped`, eller `facts_seen` over 0 («N sjekker feiler») | `DEGRADED` |
| ellers | `OK` |

`data = {age_s, failing_checks, consecutive_failures}`, `observed_at = last_started_at`. Aldri sjekkens meldingstekst og aldri `last_error` (ubetrodd tekst, regel 7). Klokken tas ETTER lesingen av raden. Grensene (2:59 / 3:00 / 3:01 ved standard, og gulvet på 2 min) er testet; nøyaktig grensen er fortsatt OK (strengt «over»). Kosmetikk (B-I3): ved 3:01 står «har ikke tikket på 3 min (grensen er 3 min)» fordi minutter rundes ned.
Fiks 1 (B-L1): før rettingen ble grensen regnet av incident-produsentenes intervall (standard 5 min, dvs. 15 min), men raden skrives per VAKTHUND-tikk; et vakthund-intervall på 1 time ga falsk `DOWN`, og et produsent-intervall på 1 time ga for sen `DOWN`. `control-center/operations.ts:266-269` er IKKE rørt: produsent-raden `watchdog` i Drift-senteret viser allerede tikk-alderen, og `watchdog_direct` forblir `UNKNOWN` (sant: sjekkresultatene deles ikke, kun tikk-alderen).

## 5. K2: `stuck_tasks` på tvers av tenants

`stuckTasksAllTenantsCheck(pool)` = `listAllTenantIds(pool, 201, {quiet:true})` (en ekstra rad avslører at katalogen er lengre enn 200) + telling per tenant i `withTenantTransaction` (samme RLS-trygge mønster som D-393). Én feilende tenant stopper ikke de øvrige; et tidsbudsjett på 15 s (under sjekk-fristen på 20 s) gjør uleste tenants til «kunne ikke leses» i stedet for å la kjøringer hope seg opp. Aldri tenant-id i melding eller logg: kun antall og SQLSTATE-koder. Fiks 1: alle uleste = `critical` (delvis = `warning`); `SET LOCAL statement_timeout = 8000` per tenant-telling; `ownerTenantId` (worker-main sender `owner.tenant_id`) vurderes alltid først, så en katalog over 200 tenants ikke kutter eieren bort. `quiet` hindrer en ny loggrad (`all_tenants_enumerated`) hvert minutt; sveipene logger som før. Den gamle `stuckTasksCheck` er uendret og eksportert.

## 6. K3: ekstern dead man's switch for vakthunden (oppsett er eierens handling)

Prinsipp: **stillhet = alarm**. Workeren pinger KUN mens (1) vakthundens siste FULLFØRTE tikk er yngre enn maks(3 x `JARVIS_WATCHDOG_INTERVAL_MS`, 2 min) - målt med en MONOTON klokke (`Watchdog.lastCompletedTickAgeMs`, `performance.now()`), så et hopp i veggklokken (NTP) verken gir falske pings under en hengt vakthund eller falsk stillhet under en frisk - OG (2) `SELECT 1` svarer innen 3 s. Ellers sendes ingenting, og aldri et «feiler»-ping. Et tikk som henger (en sjekk som aldri blir ferdig, en varslingssink som aldri svarer) flytter ikke tidspunktet; et hoppet overlappende tikk setter det ikke. En `SELECT 1` som fortsatt henger fra forrige runde stables ikke på. Første ping kommer ca. vakthund-intervallet + heartbeat-intervallet etter oppstart, ca. 2 min ved standard (worker har ingen umiddelbar første vakthund-tikk, kun `setInterval`, og heartbeatens eget tikk ved 60 s kommer mens det første vakthund-tikket pågår); med `JARVIS_WATCHDOG_INTERVAL_MS=300000` blir det ca. 6 min, med 600000 ca. 11 min. Sett monitorens frist til minst det pluss perioden (ellers falsk alarm ved hver omstart av worker). Ved oppstart logges `watchdog_heartbeat_selfcheck_failed` (`silent_ticks: 1`) til første vakthund-tikk er ferdig: forventet, ikke en feil. URL-en valideres med samme vern som utsendingen (`assertSafeVendorUrl`): IPv6-literaler og understrek i vert avvises ved oppstart (ikke stille ved hver ping), og https mot loopback/privat/link-local/uspesifisert IP-literal, `localhost` og `metadata.google.internal` avvises (bruk et offentlig vertsnavn; et vertsnavn som via DNS peker til en privat adresse fanges ikke). Worker-containeren må kunne nå monitoren over utgående HTTPS (som API-ets oppetids-heartbeat); pinget har ingen kropp og ingen data, kun en GET. Ugyldig konfig gir én logglinje og ingen ping: en monitor i «ny»-status varsler ikke før første ping, så steg 3-4 under er obligatoriske.

Eierens steg (`BLOCKED_EXTERNAL`, `NOT VERIFIED`):
1. Opprett en EGEN sjekk hos en monitor du velger (ikke gjenbruk backup- eller API-sjekken). Periode ca. 3 x `JARVIS_WATCHDOG_HEARTBEAT_INTERVAL_SEC` + 1-2 min (standard 60 s gir ca. 4-5 min), og fristen (grace) minst vakthund-intervallet + heartbeat-intervallet i tillegg (standard ca. 2 min), så en omstart av worker ikke gir falsk alarm.
2. Legg URL-en i `.env` som `JARVIS_WATCHDOG_HEARTBEAT_URL=...` (aldri i chat eller commit), og kjør `docker compose up -d worker`.
3. Bekreft i monitoren at pinget kommer. Se i worker-loggen: `watchdog_heartbeat_started` (kun opprinnelsen vises).
4. **Stopp workeren** (`docker compose stop worker`) og bekreft at monitoren varsler etter fristen. Start den igjen og bekreft at varselet løses.

## 7. K4 og K5: EV-19 og UA-0-gaten

**EV-19:** `backupCoverage` er en ren funksjon. Dekket KUN når statusfilen er lest uten feil og gyldig; manglende/ulesbar/ugyldig fil, en kilde som kaster og klokkeavvik (over 5 min frem i tid, samme toleranse som backup-leseren) og et tidspunkt som ikke er et tidspunkt gir «ikke dekket» (6 av 23 har utfører) - aldri en fabrikkert tid og aldri en falsk «forfalt». Klokketoleransen er nøyaktig 5 min (+300000 ms dekket, +300001 ms klokkeavvik). Gyldig fil: `backup_status` har `last_run = generated_at`; `disaster_recovery_sample_restore` har `last_run = restore_verify.last_success_at`, eller ingen `last_run` (forfalt) hvis den er satt opp men aldri verifisert (`never_run`); er restore-verifisering ikke satt opp (`not_configured`), er oppgaven «ikke dekket» (7 av 23, notat, ingen `ATTENTION`). Notatet i rapporten («Merk: ... ikke vurdert: ...») har en fast tekst, aldri filinnhold. Oppgavene UTFØRES av backup-skriptet på verten; rapporten kjører ingenting (`acts:false`).

**UA-0-gaten:** C13 kjører `ops/backup/nas-schedule.sh "$JARVIS_BACKUP_DIR" status --json` (3 forfalt = `FAIL`, 4/5 = `WARN`, alt annet `UNKNOWN`; exit 0 er `PASS` KUN når JSON-en har en gyldig `exit_code` lik exit-koden, alder og begge tilstander er kjent og restore-verifisering og off-site er `ok` - `restore=never_run|not_configured` og `offsite=not_configured|pending` gir `WARN`, nøyaktig som H07; JSON leses med en lukket mal, detaljen er kun koder og tall). Kommandoen kjøres med `timeout -k 5`, og en relativ `JARVIS_BACKUP_DIR` gjøres absolutt. C14 leser alderen på `incident_producer_runs`/`watchdog` via `psqlq` (opptil 300 s `PASS`, opptil 900 s `WARN`, over `FAIL`, ingen rad `UNKNOWN`). Se `docs/runbooks/UA0_NAS_ACCEPTANCE.md`.

## 8. Eierens `NOT VERIFIED`-steg (ingenting under er kjørt på NAS)

1. **Selvdiagnose:** sett `JARVIS_INCIDENT_PRODUCERS_ENABLED=true` (se `docs/runbooks/INCIDENT_LIFECYCLE.md` for hva det setter i gang: hendelser flyter til situasjonsmotoren og oppmerksomhetskøen), `docker compose up -d api worker`, vent 2 min og spør Jarvis «hva er galt med deg». Forvent `Watchdog: OK` med alder i sekunder. Stopp workeren i 4 min og spør igjen: forvent `DOWN` («har ikke tikket på 4 min»; grensen er 3 min ved standard vakthund-intervall).
2. **Dead man's switch:** §6.
3. **UA-0-gaten:** `JARVIS_BACKUP_DIR=<mappen nas-backup.sh skriver til> ops/acceptance/nas-ua0-gate.sh`. Forvent 14 sjekker; C13 `PASS`/`WARN`/`FAIL` etter backupens tilstand, C14 `PASS` når produsentene er på og worker kjører. Lim utskriften inn.
4. **Tenant-tall:** `SELECT count(*) FROM tenants` (via `docker compose exec postgres psql ...`). Er svaret 1, er `stuck_tasks` uendret. Er det flere, forvent varsler for fastlåste jobber i alle tenants.
5. **EV-19:** med `JARVIS_BACKUP_STATUS_FILE` satt: åpne Evolusjon-senteret og les «Vedlikeholdsplan» (8 av 23 har utfører når restore-verifisering er satt opp, ellers 7 av 23 med en `Merk:`-linje; en satt opp, men aldri kjørt restore-oppgave er forfalt til første vellykkede restore-verifisering).

## 9. OPS2b: bevisst utsatt (`DEFERRED`)

1. **Vakthund som egen prosess/compose-profil** (AV som standard) med `JARVIS_WATCHDOG_EXTERNAL` mot duplikat. Krever Docker/NAS og en ny compose-tjeneste: utenfor «Bygges IKKE»-grensen her. Ekstern dead man's switch (K3) dekker «død worker» uten dette.
2. **Vakthundens varige tilstand UAVHENGIG av hendelsesautomatikken** (egen tabell, migrasjon 157, eller direkte skriving til `incident_producer_runs`). Eieren velger. I dag krever K1/C14 at `JARVIS_INCIDENT_PRODUCERS_ENABLED=true`.
3. **API-side «vakthund står»-produsent** (krever migrasjon: `CHECK` på produsentnavn i `incident_producer_runs`).
4. **EV-1 confidence-gate koblet til en beslutning** (`modules/executive/src/self-model/confidence-gate.ts` har ingen bruker). Eieren velger beslutningssted; anbefalt: skygge-visning i ops-forslag først.
5. **EV-7 i CI:** `ops/evolution/dependency-check.ts:12-14` sier at `.github/workflows` er beskyttet og krever eierens aksept. Ikke rørt.
6. **Connector-helse og rate-teller delt via DB** (JARVIS-025-resten).
7. **Backup-før-migrasjon-vakt** (JARVIS-075-resten): vertshandling.
8. **claude-worker-robusthet** (JARVIS-088): PC-siden.

## 10. Rollback

Ingen migrasjon og ingen ny tabell: det finnes ingenting å rulle tilbake i databasen, og det er ingen data å rydde. Alt under er konfig eller en revert av ett punkt (hver del er egen commit):

| Del | Slik slår du den av / ruller tilbake |
|---|---|
| K3 ekstern heartbeat | fjern `JARVIS_WATCHDOG_HEARTBEAT_URL` fra `.env` og kjør `docker compose up -d worker`: ingen timer og ingen utgående kall. Slå av (eller pause) sjekken hos monitoren, ellers varsler den (riktig, fordi pinget uteblir) |
| K1 selvdiagnose + K5 C14 | sett `JARVIS_INCIDENT_PRODUCERS_ENABLED` tilbake til tom/`false`: `watchdog` blir UKJENT med årsaken, og C14 blir UKJENT. Ingen data endres (leseren skriver aldri) |
| K4 EV-19-kobling | fjern `JARVIS_BACKUP_STATUS_FILE` (eller revert linjen i `main.ts` som sender `backupStatus` til evolusjonskildene): EV-19 dekker 6 av 23 som før |
| K2 alle tenants | revert én linje i `worker-main.ts` (`stuckTasksAllTenantsCheck(pool, { ownerTenantId: owner.tenant_id })`) til `watchdog.register(stuckTasksCheck(pool, owner.tenant_id))` (den gamle sjekken er uendret og eksportert) og importen. `listAllTenantIds` er bakoverkompatibel (`quiet` er valgfri) |
| K5 gaten | revert committen; C13/C14 er UNKNOWN uten `JARVIS_BACKUP_DIR` og uten produsentene, og endrer ingen exit-kode før de gir FAIL |

## 11. Kjente grenser og bivirkninger (meldt, ikke skjult)

* **K3 beviser ikke at monitoren varsler:** den beviser at workeren er stille når den skal. At varselet når deg er eierens steg (§6).
* **C13 `PASS` er ikke bevis for at kopiene virker, men `PASS` krever nå `restore=ok` og `offsite=ok`.** Statusskriptet gir exit 0 for `restore=never_run|not_configured` og `offsite=not_configured|pending` (ingenting har feilet ennå); C13 gjør dem til `WARN`, som H07 i HF-gaten. En status-JSON uten gyldig `exit_code`, med ukjent alder eller ukjent tilstand er `UNKNOWN`, aldri `PASS`. Selve restore-testen er fortsatt `nas-restore-verify.sh`.
* **`nas-schedule.sh status`** leser backup-skriptets eget oppsett (`.env`) og kan bygge `age`-imaget første gang (lang kjøretid): C13 har en frist (standard 120 s) og gir da `UNKNOWN`.
* **Pinget beviser «vakthunden lever og databasen svarer», ikke «køen behandles»** (A-I1): en hengt `drain()` (`modules/tasks/src/worker.ts`, `draining`-flagget) med fornyet lease stopper køen uten at verken pinget eller `stuck_tasks` reagerer.
* **Doble pings maskerer en død worker** (A-I2): to `startWatchdogHeartbeat`-kall (eller to workere) mot samme URL gir doble pings, og en levende worker skjuler en død. `worker-main.ts` har ÉN heartbeat (testet); bruk én worker eller én sjekk per worker.
* **Ugyldig heartbeat-konfig gir stillhet, ikke varsel** (A-I4): én logglinje (`watchdog_heartbeat_config_invalid`, uten URL) og ingen ping; en monitor i «ny»-status varsler ikke før første ping. Avbøtes av eierens steg 3-4 i §6.
* **EV-19 uten backup-statuskilde er ikke byte-lik forrige versjon** (B-I1): rapporten har en ny `Merk:`-linje (årsaken), `source` nevner `backup-status.json`, og oppsummeringen har ny ordlyd. Status, dekning (6 av 23) og forfalt-listen er identiske (reviewer B kjørte en differensial mot forrige `maintenanceSection` på tre fixturer).
* **H01 i HF-gaten er `WARN` som standard** (B-I2): C14 er `UNKNOWN` uten `JARVIS_INCIDENT_PRODUCERS_ENABLED=true`, og C13 er `WARN` til restore-verifisering og off-site er satt opp. Heartbeaten for vakthunden (§6) gjør ikke C14 grønn.
* **Terskelen følger vakthund-intervallet** (B-L1): settes `JARVIS_WATCHDOG_INTERVAL_MS` høyt, blir `DOWN`-grensen i selvdiagnosen og stillhetsgrensen for heartbeaten tilsvarende lang (3 x intervallet). Sett heartbeatens monitorfrist deretter (§6).
* **Uavhengig gjennomgang anbefalt:** `worker-main.ts`, `watchdog-heartbeat.ts`, `self-model-readers.ts`, `heartbeat-sender.ts` (generaliseringen og URL-vernet).

## 12. Fiks-runde 1 (2026-11-27): hva reviewene fant og hvordan det er lukket

Alle punkt har egne tester (se `git log` for `fix:`-commitene). For kodefiksene var testene røde før og er grønne etter; for testhull (A-L8, B-L10, B-L11) er testene vist å drepe reviewernes overlevende mutanter. Nye testfiler heter `wpops2a-fix1-*`; eksisterende tester er kun endret der oppførselen er bestemt endret (påstander er ikke svekket).

| Funn | Lukket slik | Kode | Test |
|---|---|---|---|
| B-M1 | C13 gir aldri `PASS` fra `{}`, `{"ok":true}` eller ukjent alder/tilstand: `UNKNOWN` | `nas-ua0-gate.sh:149-215` | `wpops2a-fix1-ua0-gate.test.mjs` |
| B-M2 | C13 `WARN` for `restore=never_run\|not_configured`, `offsite=not_configured\|pending` (som H07); paritetstest mot H07 | samme | samme (paritet) |
| B-M3 | omstartforslag KUN ved `watchdog` `DOWN`; `UKJENT`-teksten sier ikke «ingen leser» | `ops-proposals.ts:85-90` | `modules/executive/test/wpops2a-fix1-ops-proposals.test.ts` |
| A-L1 | første ping = vakthund-intervall + heartbeat-intervall (§6, `.env.example`) | docs | - |
| A-L2 | `Watchdog.lastCompletedTickAgeMs` (monoton); selvsjekken bruker den | `watchdog.ts:195`, `watchdog-heartbeat.ts:81` | `wpops2a-fix1-watchdog.test.ts`, `wpops2a-fix1-heartbeat-clock.test.ts` |
| A-L3, A-L4, A-L5 | `critical` når alle uleste; `SET LOCAL statement_timeout`; eier først | `watchdog.ts:343` | `wpops2a-fix1-stuck-tasks.test.ts` (ekte Postgres) |
| A-L6, A-L7 | `validateHeartbeatUrl` kaller `assertSafeVendorUrl`; https mot loopback/privat/link-local avvises | `heartbeat-sender.ts:39,54` | `wpops2a-fix1-heartbeat-url.test.ts` |
| A-L8 | testhull W03/W08/H01/H11/H12/H21/H25/H29/K09/K20/K23/S13 | - | `wpops2a-fix1-watchdog.test.ts`, `-stuck-tasks`, `-heartbeat-wiring`, `-heartbeat-url` |
| B-L1, B-L2, B-L3 | terskel fra vakthund-intervallet; klokke etter lesing + 2 s toleranse; robust ren funksjon | `watchdog-status.ts:21-45,89`, `self-model-readers.ts:205`, `main.ts:228` | `wpops2a-fix1-k1-reader.test.ts` |
| B-L4, B-L5 | `not_configured` = ikke dekket; NaN-tidspunkt = ikke dekket | `evolution-source.ts:368` | `wpops2a-fix1-k4-coverage.test.ts`, `evolution-source.test.ts` |
| B-L6 til B-L9 | `timeout -k 5`; header og UA0-doc om `.env`; absolutt `JARVIS_BACKUP_DIR`; «(OVERSTYRT, kun test)» | `nas-ua0-gate.sh` | `wpops2a-fix1-ua0-gate.test.mjs` |
| B-L10, B-L11 | C14-SQL kjørt mot Postgres; `fmtAge`, 5-min-grensen, `never_run`, seks-årsakstak, gren uten `timeout` | - | `wpops2a-fix1-c14-sql.test.ts`, `-k1-reader`, `-k4-coverage`, `-ua0-gate` |

Bevisst IKKE gjort: ingen migrasjon, ingen nytt flagg, ingen ny compose-tjeneste. `LOOPBACK_HOSTS` har aldri inneholdt `0.0.0.0` (reviewerens S13 var en mutant som la den til); det var et testhull, nå pinnet. En C14 for `JARVIS_ACCEPTANCE_*` finnes ikke (C14 leser via docker/psql uten test-seam), så merknaden «(OVERSTYRT, kun test)» gjelder C13.
