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

**Arkitekt-review runde 2 (PR #85, HEAD fd2cf3e):** 6 SKJERPEDE/NYE funn på runde 1 sin fiksing - (1)
selve OPERASJONEN (tool_id/action/parametre) var ikke bundet til claim-nøkkelen + en caller-gitt nøkkel
kunne (i teorien) kollidere på tvers av to ULIKE situasjoner, (2) `SituationActInFlightError` var en
PERMANENT floke uten noen gjenopprettingsvei, (3) en `actOn()`-retry kunne sende et DUPLIKAT
Telegram-varsel, (4) `identity` sitt eget tenant/space ble ALDRI sjekket mot situasjonens eget, (5)
domene-pause-gaten var FORTSATT kun den synkrone in-memory-cachen (ALDRI en autoritativ DB-sjekk) OG
`*Durable()`-mutasjoner hadde INGEN autorisasjonssjekk i det hele tatt, (6) `owner_person_id` manglet
scope-safe FK mot `person_tenants`. ALLE rettet - se §6/§8 under.

**Arkitekt-review runde 3 (PR #85, HEAD 63bf3f6):** 2 DYPERE funn på runde 2 sin fiksing - (1) runde 2
sin "autoritative transaksjonelle" pause-sjekk var FORTSATT racy: en SELECT låser ikke fraværet av en
rad, OG selve `execute()`-kallet skjedde UTENFOR claim-transaksjonen (etter at den allerede hadde
committet) - en `pauseDurable()` kunne committe I DET vinduet uten effekt på et allerede claimet
forsøk; (2) `releaseStuckActClaim()` var verken eier-autorisert (kun scope-likhet) eller race-fri mot
selve `execute()`-kallet (en `FOR UPDATE`-lås på `situations` fenser ikke ToolGateway, som skriver
`tool_executions` FØRST ETTER at transporten returnerer). Begge lukket med EKTE, tvers-av-prosess
Postgres advisory locks (`modules/situations/src/advisory-lock.ts`) - se §6 under.

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
| Situasjoner (hendelses-/anomali-tilstand) | `situations` (`056_situations.sql`) | Fri-tekst `domain`, idempotent `detection_key`, tilstandsmaskin-`stage`, `priority`/`confidence`, `reason` (fritekst begrunnelse), valgfri SCOPE-SAFE `owner_person_id` (sammensatt FK mot `person_tenants (person_id, tenant_id)`, arkitekt-review runde 2 Funn 6 — en eier fra et ANNET tenant avvises av databasen), valgfri SCOPE-SAFE peker til `business_open_loops` (`source_open_loop_id` — sammensatt FK mot `(open_loop_id, tenant_id, memory_space_id)`, runde 1 Funn 2: en `source_open_loop_id` fra et ANNET tenant/space enn situasjonen selv avvises av databasen, race-fritt), tynne ACT-pekere (`act_tool_id`/`act_action`/`act_result`/`act_idempotency_key`/`act_claimed_at`/`act_operation_fingerprint` — sistnevnte binder claimen til DEN FAKTISKE operasjonen, runde 2 Funn 1 — ALDRI en kopi av `tool_executions` sitt evidence). |
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

0. **Identitetens EGET scope MÅ matche situasjonens** (Funn 4, arkitekt-review runde 2) — SJEKKET
   FØRST, FØR noe DB- eller gateway-kall (`SituationActScopeMismatchError`, zero side-effekt) — en
   handling autorisert/utført for ETT tenant/space skal ALDRI kunne registreres som resultatet av en
   situasjon i et ANNET. Samme sjekk i `releaseStuckActClaim()` (se punkt 2 under).
1. **Domene-pause er EKTE, tvers-av-prosess gjensidig utelukkelse via Postgres advisory locks**
   (Funn 1, arkitekt-review runde 3 — SKJERPET fra Funn 5 runde 2 sin "autoritative transaksjonelle"
   DB-sjekk, som FORTSATT var racy: en SELECT låser ikke fraværet av en rad, og selve `execute()`-
   kallet skjedde UTENFOR claim-transaksjonen, ETTER at den allerede hadde committet — en
   `pauseDurable()` kunne committe NØYAKTIG I DET vinduet uten noen effekt på et allerede claimet
   forsøk). `actOn()` HOLDER NÅ `pg_advisory_lock(hashtext(domene))` for BÅDE situasjonens eget domene
   OG `ALL_DOMAINS` (`modules/situations/src/advisory-lock.ts`) gjennom HELE sin kritiske seksjon —
   pause-sjekk, claim OG selve det eksterne `ToolGateway.execute()`-kallet, IKKE bare claim-
   transaksjonen. `DomainPauseRegistry.pauseDurable()`/`unpauseDurable()` tar SAMME lås FØR de skriver
   (domain-pause.ts) — en pause-mutasjon og et `actOn()`-forsøk for samme domene kan derfor ALDRI kjøre
   samtidig: enten er mutasjonen FERDIG (og garantert synlig) FØR `actOn()` i det hele tatt får
   fortsette forbi sin egen pause-sjekk, ELLER mutasjonen MÅ vente til et allerede PÅBEGYNT `actOn()`-
   forsøk er helt ferdig (uansett utfall) FØR den selv kan committes. Låser tas ALLTID i SAMME
   rekkefølge (det spesifikke domenet FØRST, deretter `ALL_DOMAINS`) på tvers av ALLE kallesteder for å
   gjøre deadlock strukturelt umulig. Den synkrone `DomainPauseRegistry.isPaused()`-cachen er NÅ KUN en
   billig, valgfri "fail fast"-optimalisering FØR advisory-låsen i det hele tatt tas. `*Durable()`-
   mutasjoner krever et konfigurert `DomainPauseAuthority` PLUSS en matchende `actorPersonId` når et
   `pool` er gitt (`DomainPauseUnauthorizedError` ellers, fail-closed, INGEN skriving). `KillSwitch` sin
   GLOBALE virkning er UENDRET og virker SAMTIDIG (sjekkes inne i `execute()`).
2. **En ATOMISK, VARIG, EKSKLUSIV claim på situasjons-raden FØR `execute()`**, BUNDET til DEN FAKTISKE
   OPERASJONEN (Funn 3 runde 1, SKJERPET av Funn 1+2 runde 2): `situation_id` er ALLTID en del av selve
   nøkkelen som sendes til `ToolGateway.execute()` (`situation:<id>:<nøkkel>`) — STRUKTURELT umulig for
   to ULIKE situasjoner å dele samme `tool_executions`-rad og "arve" hverandres bekreftede resultat,
   UANSETT hvilken `idempotency_key` en kaller selv oppgir. `act_operation_fingerprint`
   (`computeActOperationFingerprint()` — SHA-256 av situation_id+tool_id+action+kanonisk parametre)
   bindes ATOMISK til claimen — en retry med SAMME nøkkel men et ULIKT tool/action/parametersett
   avvises (`SituationActOperationMismatchError`), ALDRI gjenbruk av et tidligere, ANNERLEDES bekreftet
   resultat. En SAMTIDIG "taper" (samme nøkkel+fingeravtrykk, men INGEN `tool_executions`-bevis ennå)
   avvises DETERMINISTISK (`SituationActInFlightError`) — men denne er IKKE lenger en permanent floke:
   `actOn()` REKONSILIERER FØRST mot `tool_executions` (Funn 2 runde 2) — finnes DET beviset (uansett
   status), er en ny `execute()`-kall alltid trygt (ToolGateway sin egen dedupe re-invokerer ALDRI
   transporten); KUN når INGEN bevis finnes i det hele tatt forblir vi fail-closed, og
   `SituationEngine.releaseStuckActClaim()` gir en EKSPLISITT, fail-closed administrativ
   gjenopprettings-transisjon (re-verifiserer race-fritt at INGEN bevis har dukket opp FØR frigjøring —
   ALDRI en blind tidsavbrudd-basert auto-frigjøring, `SituationActClaimNotReleasableError` hvis bevis
   FAKTISK finnes). Funn 2 (arkitekt-review runde 3) skjerpet DENNE metoden ytterligere: (a) krever nå
   et konfigurert `SituationRecoveryAuthority` PLUSS at `identity.person_id` FAKTISK matcher
   (`SituationRecoveryUnauthorizedError` ellers) — scope-likhet ALENE var IKKE tilstrekkelig
   autorisasjon for en operatør-/eier-handling; (b) tar NÅ SAMME advisory-lås som `actOn()` FØR den
   rekonsiliérer — en `FOR UPDATE`-lås på `situations` fenser IKKE `ToolGateway.execute()` (som ALDRI
   låser den raden og skriver `tool_executions` FØRST ETTER at transporten returnerer), så en
   rekonsiliering UTEN advisory-låsen kunne observere et FALSKT "ingen bevis" midt i et EKTE pågående
   forsøk. Med låsen er "ingen bevis funnet" nå et race-fritt utsagn: et ekte i-flukt-forsøk for samme
   domene MÅ være helt ferdig FØR `releaseStuckActClaim()` i det hele tatt kan fortsette forbi
   lås-tildelingen.
3. **ETT Telegram-varsel-kall ETTER en BEKREFTET suksess** (`ok: true`, ALDRI før, ALDRI på en
   nektet/ubekreftet handling — `ToolResult.ok === false` dekker BEGGE, se `gateway.ts` sin egen
   kommentar) — best-effort, en varslingsfeil reverserer ALDRI den allerede skrevne ACT-raden. Arkitekt-
   review runde 1 Funn 4: `notifyResult.ok` sjekkes nå EKSPLISITT (ikke kun implisitt via try/catch) —
   et Telegram-kall som returnerer NORMALT med `{ok: false}` (f.eks. policy-/parameter-nektet, INGEN
   kastet feil) holder stadiet på `act`, ALDRI et falskt `act_notify`. Runde 2 Funn 3: selve
   varsel-kallet har NÅ SITT EGET, deterministiske `idempotency_key` (avledet av ACT-ens egen nøkkel) —
   en `actOn()`-retry ETTER en allerede FULLFØRT ACT+NOTIFY sender derfor ALDRI et duplikat-varsel
   (ToolGateway sin egen dedupe gjelder nå OGSÅ varselet, ikke bare selve ACT-handlingen).
4. Et avvist/ubekreftet forsøk (`ok: false`) flytter situasjonen til `escalate` MED den faktiske
   avslagsgrunnen lagret i `reason` — ALDRI stille tilbake til et tidligere stadium, ALDRI et
   varsel om en handling som IKKE faktisk ble bekreftet utført.

Bevist i `modules/situations/test/act-on.test.ts` (vellykket ACT, policy-nektelse,
postcondition-svikt, domene-pause FØR ethvert transportkall via BÅDE in-memory-cache OG en
direkte-i-databasen-satt pause, pauseAll, unpause, dedupliserende retry MENS det opprinnelige forsøket
fortsatt er i flukt, claim-konflikt med ulik nøkkel, operasjons-fingeravtrykk-mismatch,
kryss-situasjon-nøkkelkollisjon strukturelt umulig, krasj-gjenopprettings-rekonsiliering +
`releaseStuckActClaim()`, Telegram ok:false uten kast, Telegram-dedupe på retry, scope-mismatch FØR
ethvert kall, OG to DETERMINISTISKE to-sesjons-barriere-tester (Funn 1+2, runde 3): en `pauseDurable()`
forsøkt midt i et in-flight `actOn()` MÅ vente til det er ferdig og kan ALDRI påvirke det allerede
påbegynte forsøket; en `releaseStuckActClaim()` forsøkt midt i et in-flight `actOn()` MÅ på samme måte
vente og kan ALDRI observere et falskt "ingen bevis" mens forsøket fortsatt pågår).

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
