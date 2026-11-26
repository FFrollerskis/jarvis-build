# WP-OPS2a: vakthunden, selvdiagnosen, EV-19-koblingen og C13/C14 i UA-0-gaten (JARVIS-041-resten, EV-1/H2, OPS-RUNTIME)

**Status (2026-11-26): BYGGET OG TESTET I SANDKASSEN (ekte embedded Postgres som begrenset rolle, falsk klokke, falsk `send`, falsk `docker`) - IKKE KJØRT MOT NAS-en, IKKE DEPLOYET, INGENTING ER `VERIFIED`.**
Beslutning: **D-490** (føres i beslutningsloggen av lead; denne grenen rører ikke `DECISIONS_AND_ASSUMPTIONS.md`, `OPEN_QUESTIONS.md`, `FINDINGS_LEDGER.md`, `PROJECT_STATUS.md`, `CLOSURE_MATRIX_HF1_HF2.md` eller `OWNER_ACTIONS_HF1_HF2.md`).
Branch `claude/wp-ops2a-watchdog`, base `main` = `71a31d8b`. `CORE_DEPENDENCY_DECISION_REQUIRED=false`: ingen ny leverandør, ingen ny compose-tjeneste, ingenting i `.github/`. Den eksterne monitoren er **eierens eget valg** (ingen leverandør er bygget inn, ingen leverandørfakta er brukt).
Migrasjon: **ingen** (157 er reservert og ikke brukt). Designet trenger ingen: alt som leses (`incident_producer_runs`, migrasjon 098) og alt som telles (`tasks`) finnes fra før, og det skrives ingenting nytt.
Nytt miljø: KUN `JARVIS_WATCHDOG_HEARTBEAT_URL` og `JARVIS_WATCHDOG_HEARTBEAT_INTERVAL_SEC`, kun i `SERVICE_ENV.worker`, **AV uten URL**.

## 1. Oversikt: punkt, status, kode, test

`LUKKET FØR` = var allerede rettet før denne grenen (verifisert mot koden, ikke gjort på nytt). `LUKKET HER` = bygget og testet her. `DEFERRED` = bevisst ikke bygget (se §9). Statusord følger `CLOSURE_MATRIX_HF1_HF2.md`.

| Punkt | Status | Statusord | Kode | Test |
|---|---|---|---|---|
| JARVIS-041: tenant-kontekst på `stuck_tasks` (ledgerens «alltid 0» er foreldet) | LUKKET FØR (D-393) | `CODE_FIXED` | `modules/watchdog/src/watchdog.ts:278` (`stuckTasksCheck`, `withTenantTransaction`) | `modules/watchdog/test/fase10-ops.test.ts` (D-393-blokken, l.162) |
| JARVIS-041: tidsavbrudd per sjekk (ledgerens «ingen tidsavbrudd» er foreldet) | LUKKET FØR (D-393) | `CODE_FIXED` | `watchdog.ts:154` (`checkTimeoutMs = 20_000`), `watchdog.ts:203` (`Promise.race`) | `fase10-ops.test.ts` (hengende sjekk gir `critical`-tidsavbruddsvarsel) |
| JARVIS-041: `stuck_tasks` ser BARE eier-tenanten (en fastlåst jobb i en business-tenant var usynlig) | LUKKET HER | `WIRED` (i worker; `NOT VERIFIED` på NAS) | `watchdog.ts:318` (`stuckTasksAllTenantsCheck`), `apps/api/src/worker-main.ts:603`, `modules/core/src/services/tenant-catalog.ts:67` (`listAllTenantIds`, ny `quiet`) | `modules/watchdog/test/wpops2a-stuck-tasks-all-tenants.test.ts` (16), `w1-production-wiring.test.ts` (oppdatert bevisst) |
| EV-1/H2: «watchdog UKJENT» i selvdiagnosen (ingen leser) | LUKKET HER | `WIRED` for lesing; `DORMANT` uten `JARVIS_INCIDENT_PRODUCERS_ENABLED=true` | `apps/api/src/watchdog-status.ts:64` (`observeWatchdogRun`), `self-model-readers.ts:204`, `modules/executive/src/self-model/limitations.ts:82`, `main.ts:227` og `main.ts:1163` | `apps/api/test/wpops2a-watchdog-reader.test.ts` (23), `wpops2a-watchdog-reader-db.test.ts` (6, ekte Postgres), `modules/executive/test/wpops2a-watchdog-limitation.test.ts` (3) |
| JARVIS-041: en død/hengt worker er stille (vakthunden kan ikke varsle om seg selv) | LUKKET HER som ekstern dead man's switch | `DORMANT` (AV uten URL); eierens monitor er `BLOCKED_EXTERNAL` | `watchdog.ts:183` (`lastCompletedTickAt`), `apps/api/src/watchdog-heartbeat.ts:123` (`startWatchdogHeartbeat`), `worker-main.ts:641`, `heartbeat-sender.ts:35` og `:77` (generalisert) | `wpops2a-watchdog-heartbeat.test.ts` (27), `wpops2a-heartbeat-generalization.test.ts` (8), `modules/watchdog/test/wpops2a-last-completed-tick.test.ts` (6), `wpc2-heartbeat-sender.test.ts` (urørt) |
| EV-19-koblingen (OPS-RUNTIME: `BUILT_UNWIRED`, «viser backup som utført» var ikke koblet) | LUKKET HER | `WIRED` (kun lesing; kun med `JARVIS_BACKUP_STATUS_FILE`) | `apps/api/src/evolution-source.ts:336` (`MAINTENANCE_COVERAGE`), `:365` (`backupCoverage`), `:393` (`maintenanceSection`), `main.ts:255` | `evolution-source.test.ts` (54), `wpb-evolution-source-db.test.ts` (10, ekte fil), `wpops2a-ev19-wiring.test.ts` (4) |
| C13 (backup-status) og C14 (vakthund) i UA-0-gaten | LUKKET HER | `BUILT` (`NOT VERIFIED` på NAS) | `ops/acceptance/nas-ua0-gate.sh:148` (C13), `:199` (C14) | `ops/acceptance/test/nas-ua0-gate.test.mjs` (23) |
| JARVIS-075: migrator (lås, sjekksum, navnevakt, plan, admin-konfig) | LUKKET FØR (D-395) | `CODE_FIXED` (delvis) | `modules/core/src/db/migrator.ts:116` (advisory lock), `:78` (`planMigrations`), `:166` (`runMigrationsAsAdmin`) | `modules/core/test/d395-migrator.test.ts`. Resten (ned-migrasjoner, backup før migrasjon, PG16 til 17) er vertshandlinger: `DEFERRED`, se §9 punkt 7 |
| JARVIS-054-resten | `DEFERRED` | ligger i WP-P3 | - | - |
| JARVIS-053-resten | `DEFERRED` | eierbeslutninger (JARVIS-030/074: oppbevaring og sletting av `audit_events`/`policy_decisions`) | - | - |
| Vakthund som egen prosess, varig tilstand uavhengig av hendelsesautomatikken, API-side «vakthund står»-produsent, EV-1 confidence-gate, EV-7 i CI, connector-helse via DB, backup-før-migrasjon, claude-worker | `DEFERRED` (OPS2b) | se §9 | - | - |

## 2. Flagg og miljøvariabler

| Variabel | Prosess | Standard | Verdi | Virkning |
|---|---|---|---|---|
| `JARVIS_WATCHDOG_HEARTBEAT_URL` | **worker** (kun) | tom = **AV** | `https://...` (`http://` kun mot loopback). Ugyldig verdi starter IKKE heartbeaten og logger `watchdog_heartbeat_config_invalid` (variabelnavnet, aldri URL-en) | workeren pinger din EGEN eksterne monitor kun mens vakthunden lever (se §6). URL-en er en kapabilitet (nøkkelen står ofte i stien): behandle den som en hemmelighet, den logges aldri |
| `JARVIS_WATCHDOG_HEARTBEAT_INTERVAL_SEC` | **worker** (kun) | 60 | heltall 10-3600 (ugyldig: samme logglinje, ingen oppstart) | tid mellom pingene |
| `JARVIS_INCIDENT_PRODUCERS_ENABLED` | api, worker (fra før, WP-E1) | tom = AV | kun eksakt `true` | **forutsetning for K1 og C14**: uten den registreres vakthundens tikk ikke varig, og selvdiagnosen/C14 viser UKJENT med den årsaken |
| `JARVIS_BACKUP_STATUS_FILE` | api (fra før, WP-C2) | tom | absolutt sti til den monterte statusfilen | forutsetning for K4 (EV-19) og for backup-leseren i selvdiagnosen; uten den er backup-oppgavene i EV-19 «ikke dekket» |
| `JARVIS_WATCHDOG_INTERVAL_MS` | api, worker (fra før, D-187) | 60000 | 1000-3600000 | vakthundens tikk-intervall; terskelen for heartbeaten er maks(3 x dette, 2 min) |

Variablene er lagt i `infra/local/service-env.mjs` (worker) og generert inn i `docker-compose.yml` med `node ops/security/generate-compose-env.mjs --write`; `.env.example` har dem kommentert (AV). Kun for test (ikke drift): `JARVIS_ACCEPTANCE_BACKUP_STATUS_CMD`, `JARVIS_ACCEPTANCE_BACKUP_STATUS_TIMEOUT_SEC`, `JARVIS_ACCEPTANCE_NODE_BIN` (UA-0-gaten).

## 3. Det som endrer standard drift på NAS (alt annet er AV)

1. **`stuck_tasks` teller alle tenants.** Navn, runbook, nedkjøling (30 min) og melding er uendret når katalogen har nøyaktig én tenant (`N jobber med utløpt lease`). Med flere tenants får meldingen suffikset ` (i k tenants)`, og en fastlåst jobb i en business-tenant gir et (ønsket) varsel som tidligere uteble. Tom tenant-katalog, opptellingsfeil, en tenant som ikke kan leses og flere enn 200 tenants gir `ok:false` (warning) - aldri «0 = frisk». NAS-steg for å vite om du merker noe: `SELECT count(*) FROM tenants`. Ønsker du ikke varsler fra business-tenants, si fra (Q-forslag i sluttrapporten).
2. **Selvdiagnosen: `watchdog` har nå en leser.** Uten produsentene: UKJENT med «incident-produsentene er AV: vakthundens tikk registreres ikke varig» (tidligere UKJENT med «ingen måling tilgjengelig»). Med produsentene på: OK / DEGRADED / DOWN, se §4. Begrensningen `no_cross_process_watchdog_state` får en presis tekst bare når produsentene er på.
3. **EV-19 (Evolusjon-rapporten): `backup_status` og `disaster_recovery_sample_restore` kan bli dekket** (kun med `JARVIS_BACKUP_STATUS_FILE`, kun når filen leses uten feil). En månedlig restore-verifisering som aldri er gjort gir `ATTENTION` i EV-19 til du har gjort en (ærlig, endrer rapportens status). Står change freeze på (åpen hendelse, ukjent innsignal), er den i stedet «Stoppet: ... (change_freeze)» uten `ATTENTION`.
4. **UA-0-gaten har 14 sjekker** (C13, C14 er nye), og `nas-hf1-hf2-gate.sh` videreformidler dem i H01: UNKNOWN/WARN gir H01 WARN, FAIL gir H01 FAIL. Uten `JARVIS_BACKUP_DIR` er C13 UNKNOWN; uten produsentene er C14 UNKNOWN.

Worker uten `JARVIS_WATCHDOG_HEARTBEAT_URL`: ingen timer, ingen utgående kall, ingen loggrad (bevist av testen «AV uten URL»).

## 4. K1: vakthunden i selvdiagnosen

Kilden er den ENE varige sporet av at vakthunden tikker: raden `incident_producer_runs` / `producer='watchdog'` som den eksisterende broen (`createWatchdogIncidentBridge`) skriver for hvert fullførte tikk når produsentene er på. Leseren skriver aldri noe (ingen ny skrivevei, ingen ny tabell). Rent funksjonskall `observeWatchdogRun(rad, nå, produsent-intervall)`:

| Tilfelle | Status |
|---|---|
| ingen rad, ugyldige verdier (ukjent `last_status`, ugyldig tidspunkt, negative/ikke-heltall), ugyldig intervall, **lesefeil** | `UNKNOWN` (aldri OK; feilteksten siteres aldri) |
| alder under 0 (klokkeavvik mellom worker og API) | `UNKNOWN` |
| alder over 3 x produsent-intervallet (standard 300 s, dvs. over 15 min; samme regel som `compose.ts`), «har ikke tikket på N min» | `DOWN` |
| `last_status` `failed`/`skipped`, eller `facts_seen` over 0 («N sjekker feiler») | `DEGRADED` |
| ellers | `OK` |

`data = {age_s, failing_checks, consecutive_failures}`, `observed_at = last_started_at`. Aldri sjekkens meldingstekst og aldri `last_error` (ubetrodd tekst, regel 7). Grensene 14:59 / 15:00 / 15:01 er testet (nøyaktig 15:00 er fortsatt OK, strengt «over»).
`control-center/operations.ts:266-269` er IKKE rørt: produsent-raden `watchdog` i Drift-senteret viser allerede tikk-alderen, og `watchdog_direct` forblir `UNKNOWN` (sant: sjekkresultatene deles ikke, kun tikk-alderen).

## 5. K2: `stuck_tasks` på tvers av tenants

`stuckTasksAllTenantsCheck(pool)` = `listAllTenantIds(pool, 201, {quiet:true})` (en ekstra rad avslører at katalogen er lengre enn 200) + telling per tenant i `withTenantTransaction` (samme RLS-trygge mønster som D-393). Én feilende tenant stopper ikke de øvrige; et tidsbudsjett på 15 s (under sjekk-fristen på 20 s) gjør uleste tenants til «kunne ikke leses» i stedet for å la kjøringer hope seg opp. Aldri tenant-id i melding eller logg: kun antall og SQLSTATE-koder. `quiet` hindrer en ny loggrad (`all_tenants_enumerated`) hvert minutt; sveipene logger som før. Den gamle `stuckTasksCheck` er uendret og eksportert.

## 6. K3: ekstern dead man's switch for vakthunden (oppsett er eierens handling)

Prinsipp: **stillhet = alarm**. Workeren pinger KUN mens (1) vakthundens siste FULLFØRTE tikk er yngre enn maks(3 x `JARVIS_WATCHDOG_INTERVAL_MS`, 2 min) OG (2) `SELECT 1` svarer innen 3 s. Ellers sendes ingenting, og aldri et «feiler»-ping. Et tikk som henger (en sjekk som aldri blir ferdig, en varslingssink som aldri svarer) flytter ikke tidspunktet; et hoppet overlappende tikk setter det ikke. En `SELECT 1` som fortsatt henger fra forrige runde stables ikke på. Første ping kommer ca. 75 s etter oppstart (første vakthund-tikk etter 60 s, deretter heartbeatens eget tikk); monitorens frist må være lengre enn det.

Eierens steg (`BLOCKED_EXTERNAL`, `NOT VERIFIED`):
1. Opprett en EGEN sjekk hos en monitor du velger (ikke gjenbruk backup- eller API-sjekken). Periode ca. 3 x `JARVIS_WATCHDOG_HEARTBEAT_INTERVAL_SEC` + 1-2 min (standard 60 s gir ca. 4-5 min).
2. Legg URL-en i `.env` som `JARVIS_WATCHDOG_HEARTBEAT_URL=...` (aldri i chat eller commit), og kjør `docker compose up -d worker`.
3. Bekreft i monitoren at pinget kommer. Se i worker-loggen: `watchdog_heartbeat_started` (kun opprinnelsen vises).
4. **Stopp workeren** (`docker compose stop worker`) og bekreft at monitoren varsler etter fristen. Start den igjen og bekreft at varselet løses.

## 7. K4 og K5: EV-19 og UA-0-gaten

**EV-19:** `backupCoverage` er en ren funksjon. Dekket KUN når statusfilen er lest uten feil og gyldig; manglende/ulesbar/ugyldig fil, en kilde som kaster og klokkeavvik (over 5 min frem i tid, samme toleranse som backup-leseren) gir «ikke dekket» (6 av 23 har utfører) - aldri en fabrikkert tid og aldri en falsk «forfalt». Gyldig fil: `backup_status` har `last_run = generated_at`; `disaster_recovery_sample_restore` har `last_run = restore_verify.last_success_at`, eller ingen `last_run` (forfalt) hvis den aldri er verifisert. Notatet i rapporten («Merk: ... ikke vurdert: ...») har en fast tekst, aldri filinnhold. Oppgavene UTFØRES av backup-skriptet på verten; rapporten kjører ingenting (`acts:false`).

**UA-0-gaten:** C13 kjører `ops/backup/nas-schedule.sh "$JARVIS_BACKUP_DIR" status --json` (exit 0 = `PASS`, 3 forfalt = `FAIL`, 4/5 = `WARN`, alt annet `UNKNOWN`; JSON leses med en lukket mal, detaljen er kun koder og tall). C14 leser alderen på `incident_producer_runs`/`watchdog` via `psqlq` (opptil 300 s `PASS`, opptil 900 s `WARN`, over `FAIL`, ingen rad `UNKNOWN`). Se `docs/runbooks/UA0_NAS_ACCEPTANCE.md`.

## 8. Eierens `NOT VERIFIED`-steg (ingenting under er kjørt på NAS)

1. **Selvdiagnose:** sett `JARVIS_INCIDENT_PRODUCERS_ENABLED=true` (se `docs/runbooks/INCIDENT_LIFECYCLE.md` for hva det setter i gang: hendelser flyter til situasjonsmotoren og oppmerksomhetskøen), `docker compose up -d api worker`, vent 5 min og spør Jarvis «hva er galt med deg». Forvent `Watchdog: OK` med alder i sekunder. Stopp workeren i 16 min og spør igjen: forvent `DOWN` («har ikke tikket på 16 min»).
2. **Dead man's switch:** §6.
3. **UA-0-gaten:** `JARVIS_BACKUP_DIR=<mappen nas-backup.sh skriver til> ops/acceptance/nas-ua0-gate.sh`. Forvent 14 sjekker; C13 `PASS`/`WARN`/`FAIL` etter backupens tilstand, C14 `PASS` når produsentene er på og worker kjører. Lim utskriften inn.
4. **Tenant-tall:** `SELECT count(*) FROM tenants` (via `docker compose exec postgres psql ...`). Er svaret 1, er `stuck_tasks` uendret. Er det flere, forvent varsler for fastlåste jobber i alle tenants.
5. **EV-19:** med `JARVIS_BACKUP_STATUS_FILE` satt: åpne Evolusjon-senteret og les «Vedlikeholdsplan» (8 av 23 har utfører; restore-oppgaven er forfalt til første vellykkede restore-verifisering).

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
| K2 alle tenants | revert én linje i `worker-main.ts`: `watchdog.register(stuckTasksCheck(pool, owner.tenant_id))` (den gamle sjekken er uendret og eksportert) og importen. `listAllTenantIds` er bakoverkompatibel (`quiet` er valgfri) |
| K5 gaten | revert committen; C13/C14 er UNKNOWN uten `JARVIS_BACKUP_DIR` og uten produsentene, og endrer ingen exit-kode før de gir FAIL |

## 11. Kjente grenser og bivirkninger (meldt, ikke skjult)

* **DEGRADED gir omstartforslag.** `modules/executive/src/value/ops-proposals.ts` behandler `DEGRADED` for `watchdog` som «svekket» og foreslår omstart av worker (klasse D, step-up, `executes:false`, kun med `JARVIS_V5_PROPOSALS_ENABLED=true`). Fordi K1 gir `DEGRADED` når en sjekk feiler (f.eks. `cost_warning` over varselgrensen), kan et omstartforslag dukke opp selv om vakthunden lever. Festet av en test (`KJENT BIVIRKNING`). Kildefilen er urørt; anbefalt senere: la forslagene reagere kun på `DOWN` eller på `data.consecutive_failures`.
* **«ikke målt (ingen leser)»** i ops-forslag er ordrett uendret, men teksten er unøyaktig nå som en leser finnes (den sier UKJENT).
* **Terskelen 3 x produsent-intervall** (standard 15 min) er romslig mot et vakthund-intervall på 60 s, og gir for tidlig `DOWN` hvis `JARVIS_WATCHDOG_INTERVAL_MS` settes over 5 min. Samme regel som driftsstatusen i `compose.ts`, så de to visningene er enige. Sett begge om du endrer det.
* **K3 beviser ikke at monitoren varsler:** den beviser at workeren er stille når den skal. At varselet når deg er eierens steg (§6).
* **C13 `PASS` er ikke bevis for at kopiene virker:** `verify=never_run` uten feil gir exit 0. Restore-verifiseringen vises i detaljen.
* **`nas-schedule.sh status`** leser backup-skriptets eget oppsett (`.env`) og kan bygge `age`-imaget første gang (lang kjøretid): C13 har en frist (standard 120 s) og gir da `UNKNOWN`.
* **Uavhengig gjennomgang anbefalt:** `worker-main.ts`, `watchdog-heartbeat.ts`, `self-model-readers.ts`, `heartbeat-sender.ts` (generaliseringen).
