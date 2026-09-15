# UA-10 — Design-/data-governance-notat (Proactive Situation Engine, P0)

**Status:** UA-10 «Proactive Situation Engine» — provider-uavhengig, kilde-uavhengig P0-kjerne bygget
(2026-09-15). Samme form og disiplin som `UA8_PERSONAL_TWIN_DPIA.md`/`UA3_BUSINESS_DPIA.md`: kort og
teknisk, ikke juridisk teater. `situations` behandler ALDRI en ny sensitiv persondata-KATEGORI i seg
selv (det er en TILSTANDSMASKIN over allerede-eksisterende, allerede-styrte forhold — se §1) — dette
notatet dekker likevel D-64-porten, retensjon/erasure og sikkerhetsgrensene eksplisitt, samme
disiplin som enhver ny UA.

**Arkitekt-review runde 1 (PR #85, opprinnelig HEAD 767d100):** 6 P1-funn (atomisk kollisjonsdomene/
identitets-konflikt i `evaluateCandidate()`, scope-safe `source_open_loop_id`, atomisk claim +
eksakt-én-gang i `actOn()`, manglende `ToolResult.ok`-sjekk på Telegram-varselet, stille-timer-hull
under resuppress-non-regresjon, `DomainPauseRegistry` sin restart-flyktighet) — ALLE rettet, se §4/§6/§7
under for det oppdaterte designet og `modules/situations/test/*` for de nye adversarielle testene
(kollisjons-/race-/identitets-konflikt-/scope-/claim-/telegram-ok-false-/stille-under-resuppress-/
restart-overlevelse-tester).

## 1. D-64 Core-vs-Adapter-porten (kjørt FØRST)

`CAPABILITY` = hendelses-/situasjons-tilstandsmaskin (klassifisering, dedupe/suppression/quiet-hours,
komponert ACT) for UA-10. `SYSTEM_OF_RECORD = JARVIS_CANONICAL` — Jarvis eier selv tilstandsmaskinen
og dedupe-/suppression-logikken; INGEN ekstern leverandør er stedet den bor. `CAN_RUN_WITHOUT_PROVIDER
= true` — ZERO live hendelseskilde koblet til i denne sliceen, samme "kontrakt FØR leverandør/kilde"-
disiplin D-130/D-153 etablerte for UA-8/UA-9. `evaluateCandidate()` (`modules/situations/src/service.ts`)
er en STABIL inngangskontrakt en HVILKEN SOM HELST fremtidig kilde kan kalle uten å røre denne
pakken igjen.

## 2. Hva som FAKTISK behandles (ikke planlagt)

| Data | Tabell | Hva som faktisk lagres |
|---|---|---|
| Situasjoner (hendelses-/anomali-tilstand) | `situations` (`056_situations.sql`) | Fri-tekst `domain`, idempotent `detection_key`, tilstandsmaskin-`stage`, `priority`/`confidence`, `reason` (fritekst begrunnelse), valgfri `owner_person_id`, valgfri SCOPE-SAFE peker til `business_open_loops` (`source_open_loop_id` — sammensatt FK mot `(open_loop_id, tenant_id, memory_space_id)`, arkitekt-review runde 1 Funn 2: en `source_open_loop_id` fra et ANNET tenant/space enn situasjonen selv avvises av databasen, race-fritt), tynne ACT-pekere (`act_tool_id`/`act_action`/`act_result`/`act_idempotency_key`/`act_claimed_at` — ALDRI en kopi av `tool_executions` sitt evidence). |
| Varslingspolicy | `situation_notification_policies` (`056_situations.sql`) | Eier-konfigurert stille-timer-vindu + re-suppress-vindu per (tenant, space). |

**Ikke behandlet i dag (eksplisitt, ikke stilltiende utelatt):** INGEN ny anomali-detektor for
infra/home/health (kun spend/pipeline/deadlines har en eksisterende signalkilde i dag,
`business_open_loops`/`OpenLoopService` — se §5). INGEN live bro FRA `business_open_loops` TIL
`situations` (ingen sweep kaller `evaluateCandidate()` automatisk ennå). INGEN modell-assistert
klassifisering (`computeTargetStage()` er REN, deterministisk regel-logikk — ingen ModelGateway/AI
Council-kall). INGEN counterfactual/simulation/feedback-learning. INGEN autonom/tidsstyrt auto-ACT
(`actOn()` krever en EKSPLISITT kaller).

## 3. Tilstandsmaskinen

Masterplanens egen rekkefølge, ordrett: `ignore -> remember -> inform -> suggest -> act -> act_notify
-> escalate`. `evaluateCandidate()` tildeler KUN `remember`/`inform`/`suggest` (deterministisk, se
`computeTargetStage()`) — stadiet REGRESSERER ALDRI ved en re-deteksjon (en situasjon som har nådd
`act`/`act_notify`/`escalate` forblir der inntil `actOn()` eller `resolve()` endrer den eksplisitt).
`act`/`act_notify`/`escalate` nås UTELUKKENDE via `actOn()`.

## 4. "No duplicate spam for same event" — strukturelt håndhevet

1. **Deteksjons-dedupe**: `UNIQUE (tenant_id, memory_space_id, detection_key)` (arkitekt-review runde 1
   utvidet kollisjonsdomenet med `memory_space_id` — samme flerspace-disiplin som resten av tabellen;
   opprinnelig `(tenant_id, detection_key)` alene ville feilaktig kollidert på tvers av spaces). Selve
   skrivingen er et ATOMISK `INSERT ... ON CONFLICT DO NOTHING` FØRST, deretter en race-fri `FOR UPDATE`
   fetch KUN ved konflikt (samme "prøv insert FØRST"-mønster som vision sin
   `insertValidatedInTransaction()`) — IKKE en separat SELECT-så-branch, som tidligere kunne race på en
   ukontrollert unique-constraint-feil for to samtidige kandidater med en HELT NY nøkkel. En re-deteksjon
   for SAMME nøkkel hvis IDENTITET (`domain`/`owner_person_id`/`source_open_loop_id`) er ENDRET fra det
   lagrede avvises EKSPLISITT (`SituationDetectionKeyConflictError`), overskriver ALDRI stille.
2. **Varslings-suppression**: `last_notified_at` + eier-konfigurert `resuppress_hours` (fallback 24
   timer) — `newly_actionable` (returnert av `evaluateCandidate()`) er `false` for en re-deteksjon
   INNENFOR vinduet, selv om raden faktisk oppdateres. KUN `newly_actionable: true` bør en kaller
   faktisk levere en varsling for.
3. **Stille timer (quiet hours)**: eier-konfigurert UTC-vindu (`isWithinQuietHours()`, ren funksjon,
   håndterer et vindu som krysser midnatt) — holder stadiet på `remember` under vinduet, ALDRI
   `inform`/`suggest` umiddelbart. Et nullbredde-vindu (`start === slutt`) tolkes EKSPLISITT som
   "deaktivert", ALDRI som "stille hele døgnet". Arkitekt-review runde 1: `newly_actionable` sjekker
   NÅ `!withinQuiet` EKSPLISITT, ikke kun indirekte via beregnet stadium — stadie-non-regresjon (§3)
   kan HOLDE et eksisterende `inform`/`suggest`-nivå OPPE selv når det NÅVÆRENDE beregnede stadiet er
   `remember` (stille timer), og UTEN denne eksplisitte sjekken ville et resuppress-vindu som utløp
   MIDT I et stille-timer-vindu feilaktig telt som en NY varsling.

Bevist i `modules/situations/test/{service-rls,stage-rules}.test.ts`.

## 5. Anomali-deteksjon — hva som FINNES og hva som er BEVISST utsatt

`business_open_loops`/`OpenLoopService` dekker I DAG spend/pipeline/deadlines (og flere
bedriftsdomener utover masterplanens egen liste). **INGEN eksisterende signalkilde finnes for
infra/home/health** — å bygge disse detektorene NÅ ville vært å OPPFINNE nye anomali-kilder uten en
faktisk kilde/brukstilfelle, i strid med byggeordrens "ikke gjett" disiplin. Presedens: selv
spend/pipeline-detektorene ble bygget INKREMENTELT over flere separate UA-3/UA-4/UA-6-slicer, ikke
alle på én gang. En fremtidig, EGEN slice per domene (infra/home/health) er derfor riktig neste steg,
IKKE en del av denne P0-leveransen.

## 6. ACT — komponert, ikke oppfunnet

`SituationEngine.actOn()` bygger INGEN ny sikkerhetsmekanikk. Den KOMPONERER den allerede
arkitekt-reviewte `ToolGateway.execute()`-pipelinen (Q-34/D-130-hardnet: preflight/readback/
postcondition/audit/evidence/recovery for klasse C/D) og `PolicyGateway.authorize()` (SOVEREIGN
eier-modus eller signert godkjenning — UENDRET). "logs reason/evidence" og "recovery context" er
derfor ALLEREDE dekket av `execute()` sin egen audit-pipeline — `actOn()` legger KUN til:

1. **Domene-pause SJEKKES FØRST**, FØR `execute()` i det hele tatt kalles (`SituationDomainPausedError`,
   fail-closed, INGEN ekstern effekt) — `DomainPauseRegistry` (`modules/situations/src/domain-pause.ts`)
   er in-memory/deterministisk, samme "instantly"-disiplin som `KillSwitch` (SECURITY_MODEL §8), men
   domene-navngitt (fri tekst — nye domener trenger INGEN kode-endring for å kunne pauses).
   `KillSwitch` sin GLOBALE virkning er UENDRET og virker SAMTIDIG (sjekkes inne i `execute()`).
   Arkitekt-review runde 1 Funn 6: registeret har nå EN `*Durable()`-variant (Postgres-skrive-gjennom
   + `restore()`) som gjør en pause OMSTART-OVERLEVENDE (fail-closed oppstartsgjenoppretting) når et
   `pool` gis ved konstruksjon — den synkrone in-memory-kjernen (selve `isPaused()`-sjekken `actOn()`
   bruker) er UENDRET "instantly", ingen DB-rundtur på selve sjekken. Ekte SANNTIDS tvers-av-prosess-
   konsistens (flere SAMTIDIG kjørende worker-prosesser) er FORTSATT en kjent, delt begrensning med
   `KillSwitch`/`OwnerControls` (begge fortsatt rent in-memory i dag) — IKKE løst isolert her.
2. **En ATOMISK, VARIG, EKSKLUSIV claim på situasjons-raden FØR `execute()`** (Funn 3, arkitekt-review
   runde 1): `act_idempotency_key`/`act_claimed_at` (056_situations.sql) sikrer at KUN ÉN `actOn()`-
   kall noensinne får lov til å faktisk starte det eksterne kallet for en gitt situasjon — en SAMTIDIG
   "taper" (samme utledede nøkkel, men forrige forsøk IKKE ferdig persistert ennå) avvises DETERMINISTISK
   (`SituationActInFlightError`, IKKE et nytt `execute()`-kall), mens en SEKVENSIELL retry ETTER en
   allerede FULLFØRT persistering claimer på nytt trygt (`ToolGateway.execute()` sin egen
   idempotency_key-dedupe er pålitelig for det sekvensielle tilfellet). `idempotency_key` er nå ALLTID
   satt (kaller-gitt ELLER deterministisk utledet `situation-act:<situation_id>`) - aldri valgfritt i
   praksis.
3. **ETT Telegram-varsel-kall ETTER en BEKREFTET suksess** (`ok: true`, ALDRI før, ALDRI på en
   nektet/ubekreftet handling — `ToolResult.ok === false` dekker BEGGE, se `gateway.ts` sin egen
   kommentar) — best-effort, en varslingsfeil reverserer ALDRI den allerede skrevne ACT-raden. Arkitekt-
   review runde 1 Funn 4: `notifyResult.ok` sjekkes nå EKSPLISITT (ikke kun implisitt via try/catch) —
   et Telegram-kall som returnerer NORMALT med `{ok: false}` (f.eks. policy-/parameter-nektet, INGEN
   kastet feil) holder stadiet på `act`, ALDRI et falskt `act_notify`.
4. Et avvist/ubekreftet forsøk (`ok: false`) flytter situasjonen til `escalate` MED den faktiske
   avslagsgrunnen lagret i `reason` — ALDRI stille tilbake til et tidligere stadium, ALDRI et
   varsel om en handling som IKKE faktisk ble bekreftet utført.

Bevist i `modules/situations/test/act-on.test.ts` (vellykket ACT, policy-nektelse,
postcondition-svikt, domene-pause FØR ethvert transportkall, pauseAll, unpause, deterministisk
claim-i-flukt-avvisning, claim-konflikt med ulik nøkkel, krasj-gjenopprettings-retry, Telegram
ok:false uten kast).

## 7. Retensjon og Q-20-erasure

`situations` er OPERASJONELL tilstand (som `business_open_loops`), IKKE append-only historikk — INGEN
egen tidsbasert retensjonssweep i P0 (en situasjon fjernes eksplisitt via `resolve()` + en fremtidig
opprydding, eller via Q-20). `modules/erasure/src/plan.ts` sin `planMemorySpace()` registrerer
`situations` (tenant+space-scoped, samme mønster som `business_open_loops`) — bevist end-to-end mot en
EKTE `ErasureService.executeErasure()`-kjøring (`modules/erasure/test/situations-erasure.test.ts`).
`situation_notification_policies` BEVISST utelatt (tenant/space-nivå policy-konfigurasjon, ikke
hendelsesdata — samme prinsipp som `location_retention_policies`/`health_retention_policies`).

**Kjent, DELT begrensning (ikke en ny, egen gap — samme som `business_open_loops` allerede har i
dag):** `owner_person_id` er IKKE en del av en person-scoped (`planPerson()`) erasure-registrering.
`business_open_loops.owner_person_id` har PRESIS samme, allerede-aksepterte begrensning i dagens
`plan.ts` — en situasjon speiler typisk et allerede-skjedd, ikke nødvendigvis person-eid forhold
(samme begrunnelse som `open-loop-service.ts` dokumenterer for sin egen `owner_person_id`). Flagget
eksplisitt her, ikke silently arvet.

## 8. Sikkerhetsgrenser (bevisst utsatt, dokumentert per §5 i byggeordren)

| Kapabilitet | Port som må kjøres først |
|---|---|
| Live bro fra `business_open_loops` (eller vision/helse/lokasjon) til `situations` | En egen, senere wiring-only slice — `evaluateCandidate()`-kontrakten er allerede stabil og klar |
| Nye anomali-detektorer for infra/home/health | Egen, separat slice PER domene (ingen eksisterende signalkilde i dag, se §5) |
| Modell-assistert klassifisering | Krever ModelGateway/AI Council — en leverandøravhengighet, egen D-64/D-41-port |
| Counterfactual/simulation, feedback learning | ML-tungt, masterplanens egen "where useful"-kvalifikator — egen, senere slice |
| Autonom/tidsstyrt auto-ACT (en sweep som kaller `actOn()` uten et eksplisitt kall) | Egen sikkerhetsgrense/blast-radius-vurdert slice — P0 beviser at MEKANISMEN er trygg når kalt, ikke at den bør trigges uten et menneske/en egen-vurdert autonomi-beslutning i løkken |
| Wiring inn i `apps/api/src/main.ts`/en offentlig API-/kommando-overflate | Naturlig FØLGER av broen/auto-ACT-beslutningen over — ingen mening i å koble til en komposisjons-rot FØR det finnes en reell kaller |

## 9. Oppdateringsplikt

Dette notatet oppdateres FØR — ikke etter — hver ny hendelseskilde (en `business_open_loops`-bro,
nye infra-/home-/health-detektorer), modell-assistert klassifisering, eller autonom auto-ACT-wiring.
Samme regel som `PROCESSOR_REGION_MATRIX.md` sin egen: et kapittel som ikke er fylt ut, er ikke i
produksjonsbruk.
