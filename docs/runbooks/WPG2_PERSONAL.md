# WP-G2 (D-464): UA-8 Personlig digital tvilling - resterende deler (runbook)

**Status: `DORMANT` (alt er AV som standard bak `JARVIS_PERSONAL_*`-flagg) og `NOT VERIFIED` (ingenting er kjørt mot ekte Home Assistant, bil, iCloud, bank, en iPhone/Watch eller en ekte familiesirkel; alt er bevist mot lokale fakes og en ekte embedded Postgres i tester).**
Bygget under eierens opphevelse av byggepausen (D-470) og masterplanen UA-8 (`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md`, «Personal Digital Twin»). Kjernen (kontekstmotor, lokasjon, helse-MVP, migrasjon 049-051) er fra D-130/D-131
og er uendret her; dette dokumentet beskriver det WP-G2 la til. Jussen i DPIA-en (`docs/UA8_PERSONAL_TWIN_DPIA.md`) er **utkast, ikke juridisk gjennomgått**. Status per kapabilitet står også i kode (`PERSONAL_CAPABILITY_STATUS`, `modules/tool-gateway/src/personal/status.ts`),
og en test låser at id-ene under henger sammen med denne filen.

**Ufravikelig, gjelder alt under:** (1) alt nytt er `DORMANT`: uten flagg er verktøylister, utvalg, intents, rate-grenser og ruter identiske med main (bevist av seksjon A i `apps/api/test/wpg2-personal-routes.test.ts`, `wpg2-family-routes.test.ts`, `wpg2-health-intake.test.ts` og de eksisterende `wph1`/`wph2`-baselinene);
(2) strengeste step-up (Q-55/D-468) for hver mutasjon - ingen «autonomi-binding», tale, Telegram, klokke eller system kan lempe på det; (3) ingen hemmeligheter i kode/logg/journal/varsel; (4) ubetrodd innhold (utstyr, leverandør, enhet, listetekst) er data, aldri instruksjoner;
(5) JARVIS_CANONICAL: Jarvis eier handlingsjournalen, kontekstmodellen, lokasjons-/helsetilstanden og familie-/delt-rom-autoriteten; Home Assistant, bil-API, iCloud og bankene er kilder/sluk/utførere (D-64).

## 0. Status i ett blikk

| Id (`PERSONAL_CAPABILITY_STATUS`) | Del | Status | Bevis |
|---|---|---|---|
| `p1a_home_critical` | P1a Kritiske hjemmehandlinger (lås, alarm, cover, ventil, bryter, scene, skript, klima-modus) | `DORMANT` bak `JARVIS_PERSONAL_HOME_CRITICAL`; `NOT VERIFIED` mot ekte HA | `modules/tool-gateway/test/wpg2-home-critical-{unit,gateway}.test.ts` (36 + 26) |
| (samme) | Handlingsjournal (migrasjon 125) og eksekutor | `DORMANT`; slettekjeden og D-420 dekker tabellen | samme + `modules/erasure` + `modules/core/test/d420-processing-inventory.test.ts` |
| `p1b_car` | P1b Bil bak leverandørnøytral `CarAdapter` | `DORMANT` bak `JARVIS_PERSONAL_CAR`; live `BLOCKED_EXTERNAL` (ingen leverandør valgt) | `wpg2-car-{unit,gateway}.test.ts` (24 + 15, inkl. kontraktskit) |
| `p1c_family` | P1c Familie/delte rom (medlemmer, roller, deling, «på vegne av», lister, kalender) | `DORMANT` bak `JARVIS_PERSONAL_FAMILY`; `PARTIAL` (provisjonering og verge-tilgang ikke bygget) | `modules/context/test/family-service.test.ts` (30), `modules/erasure/test/wpg2-family-erasure.test.ts`, `apps/api/test/wpg2-family-{routes,integration}.test.ts` |
| `p1d_health_ingest` | P1d Enhetssignert helse-inntak | `DORMANT` bak `JARVIS_PERSONAL_HEALTH_INGEST`; appen `BLOCKED_EXTERNAL` | `modules/health/test/intake.test.ts` (15), `apps/api/test/wpg2-health-intake{,-db}.test.ts` |
| `p2e_apple_dav`, `p2e_eventkit` | P2e Apple Kalender/Påminnelser/Kontakter | `DEFERRED` (ikke bygget), live `BLOCKED_EXTERNAL`; EventKit `DEFERRED` | - (se §6) |
| `p2f_finance_read` | P2f Personlig økonomi-lesing | `DEFERRED` (ikke bygget; ingen betaling bygges) | - (se §7) |
| `p2g_context` | P2g Kontekstavledninger (tid på døgnet, reiser) | `BUILT_UNWIRED` | `modules/context/test/derive.test.ts` (5) |
| `p2g_session_continuity` | P2g Sesjonskontinuitet | `EXISTING_UNCHANGED` (PASS med bevis, ingenting bygget) | `modules/core/test/channel-session-authority.test.ts` D |
| `local_agent_q60` | Lokalagent med filtilgang (Q-60) | `DEFERRED` - bygges IKKE, ingen kontrakt laget | - |

## 1. Flagg (alle AV som standard; kun eksakt `on`)

| Navn | Standard | Virkning |
|---|---|---|
| `JARVIS_PERSONAL_HOME_CRITICAL` | AV | Registrerer `home-assistant.critical_*` + `read_critical_state` og ruten `/personal/actions/*` (domene `home`); fjerner de gamle uherdede `lock_set`/`alarm_set` |
| `JARVIS_PERSONAL_HOME_TARGETS` | tom | EKSAKT liste over eierens EGNE entitets-id-er (`lock.inngang,cover.garasje,...`). Tom = hver mutasjon nektes (`home_target_not_authorized`) |
| `JARVIS_PERSONAL_HOME_SETTLE_MS` | 20000 | Hvor lenge Jarvis venter på sluttilstand (3000-120000); utenfor intervallet gir standarden |
| `JARVIS_PERSONAL_HOME_ALARM_CODE` (vault-ref) | tom | Alarmpanelets kode hvis panelet krever den; sendes kun til HA, aldri i journal/varsel/logg |
| `JARVIS_PERSONAL_CAR` | AV | Registrerer `car.*` (`read_vehicle_state`, `lock`, `unlock`, `climate_set`, `charge_set`) og domene `car` i `/personal/actions/*`; uten injisert adapter er adapteren `unconfigured` og hver bilhandling feiler lukket |
| `JARVIS_PERSONAL_CAR_TARGETS` / `_CAR_SETTLE_MS` / `_CAR_CREDENTIAL` | tom / 60000 (5000-300000) / tom | Eierens EGNE kjøretøy-id-er (allowlist) / ventetid på sluttilstand / vault-ref til leverandørtoken (aldri i journal/logg) |
| `JARVIS_PERSONAL_FAMILY` | AV | Registrerer `/personal/family/*` (26 POST-ruter). Registreres IKKE uten eierens person-id fra eierkonfigurasjonen (fail closed); ingen modellverktøy |
| `JARVIS_PERSONAL_HEALTH_INGEST` | AV | Registrerer `POST /personal/health/ingest` (ingen verktøy) |
| `JARVIS_PERSONAL_APPLE_DAV`, `_APPLE_DAV_ACCOUNTS`, `_APPLE_DAV_USER`, `_APPLE_DAV_APP_PASSWORD`, `JARVIS_PERSONAL_FINANCE_READ`, `JARVIS_PERSONAL_CONTEXT` | AV | **RESERVERT, ingen effekt** (delene er `DEFERRED`/`BUILT_UNWIRED`, se §6-§8); navnene står i compose slik at en senere pakke ikke trenger en ny kompose-endring |

Flaggene står i `SERVICE_ENV.api` (`infra/local/service-env.mjs`), er generert inn i compose (`node ops/security/generate-compose-env.mjs --write`) og vaktes av `wpg2-flags-wiring.test.ts`. De når IKKE worker/voice/browser. Oppstartsloggen får linjen `personal_twin` KUN når minst ett flagg er på.
**Tilbakerulling = flagget AV og restart:** rutene forsvinner (404), verktøyene avregistreres, de gamle `lock_set`/`alarm_set` kommer tilbake. Data (journal, familie, helseprøver) blir stående og er fortsatt tilgjengelig for sletting; migrasjon 125-128 er additive og trenger ikke rulles tilbake.

## 2. P1a Kritiske hjemmehandlinger (Home Assistant)

### 2.1 Revisjon av det som fantes (`home-assistant.ts`, D-388, Q-34)
`lock_set`/`alarm_set` var klasse D med preflight/readback/mål-sjekk, men: (1) `entity` på `lock_set` var et vilkårlig `lock.*` uten eier-allowlist; (2) ingen step-up; (3) alarm-normaliseringen regnet `arming`/`pending`/`disarming` som «armert»;
(4) readback kom rett etter kommandoen uten å vente på at utstyret nådde sluttilstanden (en lås som er «locking» ble «verifisert» som feil); (5) ingen journal. **Disse er uendret (flagg AV = main).** Med flagget på lever de ikke side om side med den strenge
familien: `legacyCriticalActionsToDrop` fjerner dem fra registeret (worker-prosessen registrerer dem fortsatt: den får ikke flagget, og de står aldri på en modellflate - dokumentert restgap).

### 2.2 Handlinger (alle klasse D, alle med hele kjeden)
`read_critical_state` (A) og `critical_lock`, `critical_alarm`, `critical_cover`, `critical_valve`, `critical_switch`, `critical_scene`, `critical_script`, `critical_climate_mode`. Kjeden per mutasjon (`critical-ops.ts`):
mål-allowlist FØR transporten (`parameterAuthorizer`) -> step-up (`step_up_required`, enhetssignert eier-økt) -> fersk lesing av NØYAKTIG målet + målvalidering (finnes, brukbar, ikke i overgang, forutsetning uendret) -> idempotensnøkkel + ledger ->
kommando -> VENT på sluttilstand (lås/port/ventil/alarm er ikke øyeblikkelige) -> readback av faktisk resulterende tilstand + etterbetingelse -> umiddelbart Telegram-varsel -> journal.
**Alle** er klasse D (kjeden håndheves av gatewayen bare for D; strengeste standard er enklest å bevise). Risiko**retningen** (`reduces`: låse/armere/lukke/av - `increases`: låse opp/avarmere/åpne/på - `neutral`) ligger i journalen.

### 2.3 Utfall - feil sluttilstand vises umiddelbart
`SUCCESS` (readback viste ønsket sluttilstand) - `MISMATCH` (kommando akseptert, men readback viste noe annet: `jammed`, fortsatt `closing`, feil modus; journal `outcome_unknown`, kode `postcondition_mismatch`) - `UNKNOWN` (tidsavbrudd, 5xx, nullstilt tilkobling, uleselig readback: aldri en ny kommando med samme nøkkel) -
`FAILED` (avvist før utstyret eller entydig avvist av HA, 4xx). En avvisning på en replay nedgraderer aldri en rad som kan ha vært utført. Eieren får et umiddelbart out-of-band-varsel (klasse D-varsleren) for utført, ikke verifisert OG ukjent utfall; handlingen er utilgjengelig hvis varsleren ikke er klar.

### 2.4 Scene/skript (PARTIAL)
En scenes tilstand ER tidspunktet for siste aktivering; et skripts `last_triggered` er siste start (HA-dokumentasjonen). Derfor krever `critical_scene`/`critical_script` en forutsetnings-markør fra forhåndsvisningen (`expected_last_activated`/`expected_last_triggered`) og readback krever at markøren har RYKKET FREM (uavhengig av klokkeforskjell).
Skript verifiseres kun som STARTET - effekten av skriptet verifiseres ikke (`PARTIAL`); skript-variabler er `DEFERRED` (injeksjonsflate).

### 2.5 Ruter (kun med flagget på; ellers 404)
`POST /personal/actions/preview` (les ett mål + valider + gi bindeverdier), `.../read`, `.../mutate` (eier + enhetssignert økt -> eksekutor + journal), `.../list` (journalen). Identitet kommer fra grantet; kroppen kan aldri sette tenant/person.

### 2.6 D-41-revisjon: Home Assistant (kritiske handlinger)
| Punkt | Svar |
|---|---|
| Leverandøren tilbyr | REST: `GET /api/states/<id>`, `POST /api/services/<domain>/<service>` (blokkerer til tjenesten er ferdig; svarer med endrede tilstander) - verifisert mot offisiell HA-dokumentasjon (søk 2026-11-18) |
| Bygget (antall) | 8 mutasjoner + 1 lesing (pluss de eksisterende `list_states`/`read_state`/`light_set`/`climate_set`, uendret) |
| Scopes | Ett langlivet tilgangstoken (`JARVIS_HA_TOKEN`): HA har ikke scope-oppdeling per tjeneste - **all begrensning gjøres av Jarvis** (mål-allowlist + step-up). `unverified`: om en bruker med færre rettigheter kan brukes |
| Risikoklasse | Alle mutasjoner D (retning i journalen); lesing A |
| Eier/delegert | Kun suveren eier (`owner_only`), ingen delegat; ingen modellflate (manifest: `control`, aldri `surfaces`) |
| Idempotens | Gatewayens ledger (nøkkel påkrevd) + journalens digest; lås/port/ventil/bryter/klima er idempotente ved enheten, scene/skript er ikke (aldri retry etter uavklart svar) |
| Sandbox | Egen test-HA-instans eller test-entiteter i `JARVIS_PERSONAL_HOME_TARGETS` (blast radius); ingenting her sier at produksjonstilgangen er begrenset |
| `DEFERRED` | `set_cover_position`/`set_valve_position` (delvis posisjon), `lock.open` (åpne fallen), `input_boolean`/`fan`/`humidifier`, skript-variabler, tilstandsabonnement (WebSocket) - HA REST eksponerer ikke area-registeret |
| `unverified` | At en gitt lås-/port-integrasjon oppdaterer tilstanden synkront med tjenestekallet (derfor vente-løkken); alarmpanel-kodekrav per panel |

## 3. P1b Bil (`CarAdapter`, ingen leverandør valgt)

**D-64-port:** en bil-leverandør blir kjerneavhengighet hvis den er et aggregat-API som alle biler går gjennom. Ingen er valgt; kontrakten (`car-adapter.ts`) er Jarvis' egen, og enhver leverandør er en tynn adapter bak den. **Velger eieren et aggregat-API: `CORE_DEPENDENCY_DECISION_REQUIRED=true` - ikke noe stille valg.**
Kontrakten: `readState(vehicleId) -> CarState | null` (reachable, lås, klima, lading, ladenivå, `fresh` + alder ≤ 30 min, `observed_at`) og `command(vehicleId, kommando, {idempotencyKey, signal})`; `CarAdapterError(code, outcomeKnown)`; `UnconfiguredCarAdapter` feiler lukket (`car_provider_not_configured`). Alle fire handlinger (`lock`, `unlock`, `climate_set`, `charge_set`) er klasse D med samme kjede som §2.2:
mål-allowlist (`JARVIS_PERSONAL_CAR_TARGETS`), step-up, fersk tilstand (en gammel tilstand er ikke brukbar), vent på sluttilstand (biler er trege), readback + etterbetingelse, umiddelbart varsel, journal (domene `car`). Utfall som §2.3; en bil som ikke svarer er `UNKNOWN`, aldri «ferdig». Verktøy-id `car` er eier-eksklusiv og står på ingen modellflate.

| D-41 (bil) | Svar |
|---|---|
| Leverandøren tilbyr | `unverified` - INGEN leverandør er valgt; kapabiliteten kan derfor ikke verifiseres mot dokumentasjon |
| Bygget | Kontrakt + 4 handlinger + lesing mot en falsk adapter; kontraktskit (`test/support/car-adapter-contract.ts`) som enhver ekte adapter må bestå |
| Risikoklasse / eier / idempotens | D for alle fire / kun suveren eier / adapteren får idempotensnøkkelen; uavklart svar er `UNKNOWN` og gjentas aldri |
| `DEFERRED` | Alt leverandørspesifikt (autentisering, OEM-/aggregat-API), vindu-/bagasjerom-/ladeport-handlinger, lokasjon (sporing er en egen DPIA-kategori) |
| Sandbox | Leverandørens testkjøretøy/-konto; aldri eierens bil ved første kjøring |

## 4. P1c Familie/delte rom (autoritetslag)

### 4.1 Hvorfor et eget lag (revisjon av det som fantes)
Identitetsmodellen er tenant-skopet, ikke person-skopet (Q-15/D-130): enhver person med medlemskap og innrullert enhet får tilgang til HVERT rom tenanten har. Et «delt familierom» i eierens hovedtenant ville gitt hvert medlem tilgang til eierens `personal`/`health`/`business`. Identitetsmodellen og samtykkekontrollene (JARVIS-084) er
**uendret**; migrasjon 126/127 legger et autoritetslag oppå. **Sirkelen skal bo i en DEDIKERT tenant der kun rommet `shared` finnes** (`family_members`, ...); `invite`/`acceptInvitation` nekter ellers (`circle_not_dedicated`, fail closed), og `topology` (kun eier) viser om tenanten er dedikert. Alle familieoperasjoner krever et grant scopet til `shared` (`shared_space_required`).

### 4.2 Autoritetsmodell
| Regel | Håndhevelse |
|---|---|
| Helse og lokasjon er KUN synlig for personen selv; en annen ser det bare via en deling subjektet SELV har gitt | DB-CHECK `granted_by_person_id = subject_person_id`; tjenesten bruker alltid den innloggede som subjekt; ingen eier-bakdør (eieren får `share_required` som alle andre) |
| Seer-rollen sjekkes både ved opprettelse OG ved lesing; deling utløper (maks 365 d) og kan tilbakekalles av subjekt OG seer | `readShared` re-sjekker rolle, utløp, tilbakekall og at subjektet fortsatt er medlem av datatenanten; alle avslag er samme `share_required` og revideres (committet) |
| Det som leveres er avledet og minimalt: sonenavn (aldri koordinater), skritt i dag og søvnminutter siste natt | `personal-family-readers.ts`; ingen data = `null`, aldri 0; puls/vekt/HRV leses aldri |
| «På vegne av» kun med prinsipalens egen delegasjon: lukket scope (`shared_lists`, `shared_calendar`; ingen penger/helse/kommunikasjon/klasse D), påkrevd utløp (standard 30 d, maks 90), kun voksne/eier kan være agent | DB-CHECK `granted_by = principal`; agentens rolle sjekkes ved BRUK; bruk uten delegasjon = `delegation_required` + committet DENY-revisjon; proveniens (`on_behalf_of_person_id`) på hver rad |
| Invitasjon bundet til en innrullert person som kun den selv kan akseptere; utløp maks 30 d; én ventende per person | DB-CHECK `decided_by = invitee`; utløpte markeres utløpt (committet) og blokkerer ikke en ny |
| Fjerning/forlating tilbakekaller ALLE delinger og delegasjoner som involverer personen i samme transaksjon; eier kan ikke fjernes/forlate; rolle endres aldri på et aktivt medlem | triggere + tjeneste |
| Kun to lukkede delingskategorier (`location`, `health_summary`); gjest kan ingenting; barn kan se og dele lokasjon, aldri se eller dele helse | `FAMILY_ROLE_ACTIONS` (ren tabell, testet) |

Rolle-matrisen: eier = alt; voksen = alt unntatt invitere/fjerne; barn = se roster, lister (lese/legge til/avkrysse), kalender (lese), dele egen LOKASJON (aldri helse), se andres delte lokasjon; gjest = ingenting.
`family_members.data_tenant_id` (tenanten der egne helse-/lokasjonsdata bor) har **bevisst ingen FK**: tenant-kryssende FK er forbudt av scope-FK-vakten (JARVIS-076, baseline tom). Medlemskap verifiseres i tjenesten mot `person_tenants` under datatenantens egen RLS-kontekst, ved skriving og ved hver lesing.

### 4.3 Ruter (kun med flagget; alle POST, grant -> signert økt for alt som endrer autoritet eller leser andres data)
`bootstrap`, `topology` (kun eier fra konfigurasjonen), `circle`, `invite`, `invitations`, `invitation/{revoke,accept,decline}`, `member/remove`, `leave`, `data-tenant`, `share/{grant,revoke}`, `shares`, `shared/read`, `delegation/{grant,revoke}`, `delegations`, `list/create`, `lists`, `list/items`, `list/item/{add,done}`, `event/create`, `events`, `event/cancel`
(alle under `/personal/family/`). «På vegne av» krever i tillegg signert økt. Listetekst og tittel leveres merket `untrusted_user_content`. Nøkler som `person_id`/`delegation_id` er forbudte identitetsnøkler i API-et og heter derfor `member_person_id`/`family_delegation_id`.

### 4.4 Sletting og personvern
Alle sju tabeller (`family_members`, `family_invitations`, `family_shares`, `family_delegations`, `family_lists`, `family_list_items`, `family_events`) er registrert i slettekjeden (rom-, person- og tenant-scope; testet end-to-end) og i behandlingsinventaret. Sletter man en person, slettes også delinger/delegasjoner begge veier, felles innhold personen har opprettet eller som gjelder personen (en liste tar sine elementer med), og invitasjoner.

| D-41 (familie) | Svar |
|---|---|
| Ekstern leverandør | Ingen: dette er Jarvis' egen autoritet (`JARVIS_CANONICAL`); D-41 gjelder derfor kun hva som er bygget |
| Bygget / `DEFERRED` | Roller, invitasjon, deling, delegasjon, delte lister/kalender / provisjonering av sirkel-tenant og innrullering (CLI), verge-tilgang for barn, notifikasjon til subjektet ved bruk av en deling, gjenbruk i voice/Telegram (kun web/desktop/api/mobile med signert økt) |
| Risikoklasse | Ingen klasse D-handlinger; delegasjon er bevisst begrenset til lister/kalender |

## 5. P1d Helse-inntak (enhetssignert, appen er `BLOCKED_EXTERNAL`)

**Rute:** `POST /personal/health/ingest` finnes KUN med `JARVIS_PERSONAL_HEALTH_INGEST=on`. Krav: verifisert grant med `auth_strength: signed`, kanal `mobile` eller `watch`, scopet til `health`-rommet; dataene tilhører grantets person og kilden er fast `apple_health` med grantets enhet som kilde-peker (en prøve som oppgir kilde selv avvises).
Kropp: `{ grant_token, samples: [{ metric_type, value, unit, observed_at, external_sample_id }], deleted_external_sample_ids: [...] }` (maks 250 + 250 per kall: API-ets 64 KiB-grense er den bindende). Svar: `{ source, results: [{ index, status, reason? }], counts }` med `created`/`duplicate`/`conflict`/`invalid`/`expired` per prøve - aldri verdier.

**Lukket metrikkliste (ti) - verifisert mot Apples offisielle dokumentasjon 2026-11-18** (`developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/<id>`; koden har samme tabell i `METRIC_HEALTHKIT_SOURCE`):
| `metric_type` | HealthKit | Aggregering (Apple) | Kanonisk enhet | Grenser | Appens omregning |
|---|---|---|---|---|---|
| `heart_rate` | `heartRate` | discrete, count/time | `bpm` | 1-300 | ingen |
| `steps` | `stepCount` | cumulative, count | `count` | 0-200000 | ingen; delprøver kan slås sammen av HealthKit |
| `sleep_duration_minutes` | `sleepAnalysis` (kategori) | - | `minutes` | 0-1440 | appen summerer `HKCategoryValueSleepAnalysis.allAsleepValues` (stadiene overlapper ikke) |
| `weight_kg` | `bodyMass` | discrete, mass | `kg` | 1-500 | til kg |
| `resting_heart_rate` | `restingHeartRate` | discrete, count/time | `bpm` | 20-220 | ingen; Apple kan slette og erstatte tidligere estimater |
| `heart_rate_variability_ms` | `heartRateVariabilitySDNN` | discrete, time | `ms` | 0-2000 | til ms (SDNN, ikke RMSSD) |
| `oxygen_saturation_percent` | `oxygenSaturation` | discrete, percent | `percent` | 50-100 | **gang med 100**: `HKUnit.percent()` er 0.0-1.0 hos Apple; en brøk (0.97) AVVISES synlig |
| `respiratory_rate` | `respiratoryRate` | discrete, count/time | `breaths_per_min` | 1-100 | ingen |
| `active_energy_kcal` | `activeEnergyBurned` | cumulative, energy | `kcal` | 0-10000 | til kcal; delprøver kan slås sammen |
| `exercise_minutes` | `appleExerciseTime` | cumulative, time | `minutes` | 0-1440 | til minutter |

`unverified` (appen finnes ikke): de konkrete `HKUnit`-konstruktørene appen bruker, at samme `HKObject.uuid` beholdes når en prøve synkroniseres mellom enheter, og hvordan `HKDeletedObject`-henting (midlertidig i HealthKit ifølge Apple) kjøres i bakgrunnen. En ny metrikk er en migrasjon + en verifisert rad + en test - aldri konfigurasjon.

**Idempotens:** unik per (tenant, person, kilde, `external_sample_id` = HealthKit-`uuid`). Samme prøve = `duplicate`; samme id med ANNET innhold = `conflict` (lagres ikke; HealthKit-prøver er uforanderlige). **Retensjon (DPIA §2-§3):** fail-closed uten eier-konfigurert oppbevaringstid (`health_retention_policies`; 409 `health_retention_policy_required`); utløpt ved ankomst = `expired`; framtid > 10 min = avvist.
**Sletting:** appen sender slettede `uuid`-er; kun personens egne rader fra denne kilden fjernes. **Kjent begrensning:** kumulative metrikker kan slås sammen av HealthKit (nye uuid-er) - uten slettingen telles de dobbelt (`DEFERRED`: serverdeteksjon av overlapp). **Revisjon:** én rad per kall med KUN antall og metrikktyper.
**Utførelsesvern (SECRET_RESTRICTED):** helsedata er KUN en rute - ingen verktøy, ingen modellflate-tildeling, ingen logg av verdier (feil logges som klassenavn). Vakt-tester over hele kildetreet: kun tre filer importerer helsepakken, kun helsemodulen og slettekjeden refererer tabellen, inntaket importerer aldri modell-/verktøygatewayen. Lesing av egne helsedata i Jarvis-samtaler er `DEFERRED` og krever en egen utførelseslås mot skymodeller (jf. Q-64/Q-66).

| D-41 (Apple Health-kilde) | Svar |
|---|---|
| Leverandøren tilbyr | HealthKit-lesing på enheten (ingen server-API fra Apple); verifisert: identifikatorer, enhetsfamilier, aggregering, `HKUnit.percent()`, `HKObject.uuid`, `HKDeletedObject`, søvnkategoriene |
| Bygget | Kun serversiden (rute + tjeneste); ingen skriving TIL Apple Health (kapabiliteten finnes, men er bevisst ikke bygget: ingen brukstilfelle) |
| Eier/delegert | Personens egen enhet og egen person; ingen delegat, ingen eier-tilgang til andres data |
| Sandbox | Fake-prøver mot en test-tenant (som i testene); ingen ekte helsedata ved første kjøring |

## 6. P2e Apple Kalender/Påminnelser/Kontakter - `DEFERRED`

Ikke bygget i dette omfanget (ærlig utsatt, ikke stille utelatt). Flaggene `JARVIS_PERSONAL_APPLE_DAV*` er reservert uten effekt. **Neste skritt (i denne rekkefølgen):** (1) eieren oppretter et app-spesifikt passord på Apple-ID-en (D-108) og velger hvilke kalendere/adressebøker som er med; (2) D-41-revisjon mot offisiell dokumentasjon (iCloud CalDAV/CardDAV-endepunkter, påminnelser som VTODO over CalDAV, app-spesifikt passord og 2FA - alt `unverified` i dag);
(3) iCalendar/vCard-kodek med CRLF-/escape-vern, DAV-klient bak et transportgrensesnitt og en falsk transport (aldri ekte nettkall i tester); (4) eier-kun-verktøy: lesing A, opprett/endre/slett med step-up og etag-forutsetning (`If-Match`), sletting med eksplisitt bekreftelse; (5) full connector-manifest (`ops/connector/new-connector.mjs`, aldri stille inn i `SKELETON_BASELINE`) og behandlingsinventar-rad. Apple-DAV er en kilde/sluk (`EXTERNAL_CANONICAL`): Jarvis' kalender-/kontaktmodell forblir kanonisk. **EventKit** (lokal Apple-API) er `DEFERRED` til en iPhone/Mac-app finnes.

## 7. P2f Personlig økonomi-lesing - `DEFERRED`

Ikke bygget; ingen betaling bygges. Eksisterende `finance_neonomics` (D-111) er uendret. Strengeste regel (Q-64) gjelder: finansdata er `restricted`, men de eksisterende `finance_*`-verktøyene har kun **valg-lås** (aksept i `wph1-restricted-tools-invariant.test.ts`), ikke utførelseslås mot skymodeller, og samtalehistorikken bærer ingen begrenset-merking (Q-66/N1).
Å bygge personlig bankinnsyn oppå det ville utvidet to kjente hull. **Neste skritt:** eierbeslutning om hvilken tenant/hvilket samtykke en personlig bankkobling hører til, og den generelle utførelseslåsen + N1-merkingen (Q-64 pkt 3, Q-66) som egen pakke; deretter en skrivebeskyttet fasade i `finance_neonomics`-namespacet.
Flagget `JARVIS_PERSONAL_FINANCE_READ` er reservert uten effekt.

## 8. P2g Kontekstmotor og sesjonskontinuitet

**Kontekstmotoren finnes** (`modules/context`, D-130: sted/enhet/møte/aktivitet, deterministisk foretrukket over inferert, ferskhetsbevisst) og er uendret. **Nytt (`BUILT_UNWIRED`):** rene funksjoner `deriveTimeContext` (natt/morgen/dag/kveld, ukedag, helg i en tidssone) og `detectTrips` (reise = hendelse med sted utenfor hjemmesteder som varer ≥ 4 t eller er heldags; ≤ 36 t mellom hendelsene slår dem sammen; uten sted kun en `inferred` gjetning fra reiseord;
e-post er kun et SIGNAL knyttet til reisen som id - aldri kilde til dato/sted, og emnetekst er aldri en del av utfallet). Ingen rute, sveip eller flagg-effekt ennå (`JARVIS_PERSONAL_CONTEXT` reservert). **Sesjonskontinuitet = PASS uten ny bygging:** `SessionService` gjenopptar én server-eid sesjon per person på tvers av kanaler, og autoriteten ligger i separate enhetsbundne grants (D-131); bevis: `modules/core/test/channel-session-authority.test.ts` (test D: kanalbytte mobile -> web gjenopptar SAMME sesjon; E: bevis bundet til feil person avvises).

## 9. Autoritetsmodell og kjente restgap

- **Autonomi (D-160/Q-55):** situasjons-bindinger kjører med sveipens identitet (kanal `system`) og NEKTES av `step_up_required` på alle kritiske handlinger i §2-§3 (fail closed). Et unntak for kun risikoreduserende retninger (`reduces`) er IKKE bygget; retningen ligger i journalen som grunnlag. Eierspørsmål Q-G2-1.
- Worker-prosessen registrerer fortsatt de gamle `lock_set`/`alarm_set` (flagget er kun for API); de står aldri på en modellflate. Journalen har ingen automatisk retensjon (`DEFERRED`, eierbeslutning).
- Familie: ingen CLI for å opprette sirkel-tenant/innrullere (gjøres med eksisterende innrulleringsprosedyre + SQL, se §10); barn og verge-tilgang er ikke løst juridisk (DPIA); delinger varsler ikke subjektet ved bruk (revisjonen viser det).
- Helse: ingen rute for å sette oppbevaringstid (`HealthService.setRetentionPolicy` via engangskjøring/SQL; `DEFERRED`: eier-rute); ingen lesing av egne helsedata i samtale (`DEFERRED`).

## 10. NAS-/sandbox-verifisering steg for steg (alt under er `NOT VERIFIED`; kjør i sandbox/test-ressurser)

1. **Forberedelse:** bytt til branchen, `pnpm install --frozen-lockfile` (apps/api har ny avhengighet `@jarvis/context`), start stacken; migrasjon 125-128 kjører ved oppstart. Kontroller at INGEN `JARVIS_PERSONAL_*` er satt og at `/personal/actions/mutate` svarer 404 (flagg AV = main).
2. **Hjem (P1a):** opprett en test-lås/-bryter i en test-HA, sett `JARVIS_PERSONAL_HOME_CRITICAL=on`, `JARVIS_PERSONAL_HOME_TARGETS=<kun testentiteten>`, restart. `POST /personal/actions/preview` (domene `home`, handling `critical_lock`) -> forventet `valid: true` og bindeverdi; `mutate` med signert økt -> `SUCCESS`; sjekk journalen (`/personal/actions/list`) og Telegram-varselet. Prøv en entitet UTENFOR listen (forventet `home_target_not_authorized`) og en jammet lås (forventet `MISMATCH`).
3. **Bil (P1b):** `BLOCKED_EXTERNAL` til leverandør er valgt; verifiser kun at `JARVIS_PERSONAL_CAR=on` gir `adapter: unconfigured` i loggen og at hver bilhandling feiler lukket.
4. **Familie (P1c):** (a) opprett en NY tenant (`kind person`), én `memory_spaces`-rad `shared`, enroll eier + én testperson med eksisterende innrullering (`person_tenants`); (b) `JARVIS_PERSONAL_FAMILY=on`, restart; (c) `topology` (eier) -> `dedicated: true`; `bootstrap`; `invite` -> `invitation/accept` som testpersonen; (d) testpersonen deler lokasjon (`share/grant`), eieren leser (`shared/read`) -> kun sonenavn; uten deling -> `share_required`; (e) `delegation/grant` og en liste/hendelse «på vegne av»; (f) `member/remove` og bekreft at delinger er tilbakekalt. Alle endringer krever signert økt.
5. **Helse (P1d):** sett oppbevaringstid for tenanten (`INSERT INTO health_retention_policies` som admin eller engangskjøring av `HealthService.setRetentionPolicy`), `JARVIS_PERSONAL_HEALTH_INGEST=on`, restart. Send et lite batch med FAKE prøver med et `health`-grant fra en signert `mobile`-økt (curl) -> `created`; send på nytt -> `duplicate`; send en SpO2-brøk (0.97) -> `value_out_of_range`; send `deleted_external_sample_ids` -> `deleted`. Kontroller at loggen ikke inneholder verdier og at revisjonsraden bare har antall.
6. **Rollback-prøve:** sett alle flagg AV, restart, bekreft 404 på `/personal/*` og at verktøylisten er lik main.

## 11. Tester (kommandoer)

`pnpm -r run typecheck`; `pnpm lint`; `pnpm check:containment`; DB-tester som OS-bruker `postgres`: `modules/context/test/family-service.test.ts`, `modules/erasure/test/wpg2-family-erasure.test.ts`, `modules/health/test/intake.test.ts`, `apps/api/test/wpg2-*.test.ts`, `modules/tool-gateway/test/wpg2-*.test.ts`; guard-batch: D-420-inventar, erasure-dekning (`d395`), schema-invarianter (`remediation-2`), `wph1`/`wph2`-baselinene, `wph1-restricted-tools-invariant`.

## 12. Åpne eierspørsmål (med anbefaling)

| Id | Spørsmål | Anbefaling |
|---|---|---|
| Q-G2-1 | Skal autonome bindinger få utføre KUN risikoreduserende kritiske handlinger (låse, armere, lukke, slå av) uten signert økt? | Ja, via en navngitt D-beslutning per handling; låse opp/åpne/avarmere aldri autonomt |
| Q-G2-2 | Bil-leverandør (D-64)? Et aggregat-API er `CORE_DEPENDENCY_DECISION_REQUIRED` | Sjekk bilmerkets eget API først; hold adapteren tynn; ikke gjør et aggregat til domenekjerne |
| Q-G2-3 | Familiesirkel: dedikert tenant, provisjonerings-CLI, verge-tilgang for barn og rettslig grunnlag for mindreårige | Dedikert tenant opprettet av eieren; ingen deling av barns helse før juridisk vurdering |
| Q-G2-4 | Helse-inntak: transportvei fra telefonen (egen tunnel eller en tredjepartsrelé = databehandler) og oppbevaringstid | Egen tunnel (Tailscale/egen domene), ingen tredjepartsrelé; 365 dager som startpunkt |
| Q-G2-5 | Personlig økonomi: tenant/samtykke for personlig bankkobling, og utførelseslås for begrensede verktøy (Q-64 pkt 3/Q-66) | Gjør låsen + N1-merkingen først, deretter en lesefasade |
| Q-G2-6 | Apple-DAV: app-spesifikt passord og hvilke kalendere/adressebøker | CalDAV/CardDAV først; EventKit når appen finnes |
| Q-G2-7 | Retensjon for handlingsjournalen og familiens samtykke-poster (delinger/delegasjoner) | 12 måneder for journal; samtykke-poster beholdes til sirkelen/personen slettes |
