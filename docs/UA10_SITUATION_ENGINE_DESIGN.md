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

**Arkitekt-review runde 4 (PR #85, HEAD c94457e):** 1 funn - `actOn()` kalte FORTSATT
`gateway.execute()` på nytt for en ALLEREDE terminal (`act_result` satt) ELLER bevis-bekreftet claim.
`ToolGateway.execute()` sin idempotency_key-dedupe er IKKE dens FØRSTE port - policy/parameter-
autorisasjon, rate limit, frozen/revoked, credential-oppslag og klasse C/D-preflight kjører ALLE FØR
dedupe-oppslaget. En retry kunne derfor treffe en SENERE, UBESLEKTET port-avvisning (rotert credential,
fryst connector, oppbrukt rate limit) FØR dedupe i det hele tatt ble konsultert, og `actOn()` ville da
STILLE OVERSKREVET en allerede bekreftet suksess med `denied`/`escalate` - eller nedgradere en allerede
levert `act_notify` tilbake til `act`. Rettet med et EKSPLISITT short-circuit: en allerede terminal
ELLER bevis-bekreftet claim leses DIREKTE fra den persisterte situasjonen/`tool_executions`-beviset
(pluss `gateway.get()` - et rent, side-effekt-fritt oppslag av verktøy-definisjonen for `output_trust`,
ALDRI en autorisasjon) og returneres UENDRET - `gateway.execute()` kalles ALDRI for en replay. Se §6
under.

**Arkitekt-review runde 5 (PR #85, HEAD de398f3):** 1 funn - runde 4 sin `terminal_replay` returnerte
UENDRET for TIDLIG: en krasj MELLOM ACT-persisteringen (`act_result='succeeded', stage='act'`) og
selve varsel-forsøket, ELLER MELLOM et FAKTISK bekreftet varsel-bevis og selve `stage='act_notify'`-
oppdateringen, lot situasjonen sitte FASTLÅST på `act` FOR ALLTID - INGEN fremtidig retry ville
noensinne forsøkt varselet igjen, siden `act_result !== null` alene sendte replayen rett ut UTEN å
sjekke varsel-nøkkelens EGET `tool_executions`-bevis. Rettet: `terminal_replay` sjekker nå EKSPLISITT
om `act_result === 'succeeded' && stage !== 'act_notify'` - i så fall kalles varsel-`execute()` PÅ
NYTT med SAMME deterministiske nøkkel (Funn 1+2 runde 3 sin advisory-lås GARANTERER at INGEN samtidig
i-flukt-tilstand er mulig her, så dette er ALLTID enten en trygg førstegangs-utsendelse ELLER en trygg,
dedupliserende bekreftelse - ALDRI en risiko for dobbel levering, og ALDRI en regresjon siden stadiet
KUN kan AVANSERE til `act_notify` på suksess, ALDRI regressere på en avvisning). Se §6 under.

**Arkitekt-review runde 6 (PR #85, HEAD f2ba9a6):** 1 funn - runde 5 sin varsel-rekonsiliering kalte
`gateway.execute(telegram.notify)` PÅ NYTT for å avgjøre om varselet allerede var levert - NØYAKTIG
samme feilmønster runde 4 rettet for selve ACT-en, bare for varselet i stedet: `ToolGateway.execute()`
sin idempotency_key-dedupe er IKKE dens FØRSTE port for VARSELET heller. Et FAKTISK bekreftet
varsel-bevis (krasjet FØR selve `stage='act_notify'`-oppdateringen) kunne derfor ALDRI bli lest hvis en
SENERE, UBESLEKTET port-endring (policy, credential, frozen connector, rate limit) fikk et NYTT
`execute()`-kall til å returnere `ok:false` FØR dedupe i det hele tatt ble konsultert - situasjonen
ville sittet fastlåst på `act` for alltid, PRESIS den floken runde 5 skulle løse. Rettet: varsel-
nøkkelens EGET `tool_executions`-bevis leses DIREKTE FØRST, ALDRI via et nytt, muterbart
`execute()`-kall - KUN når INGEN bevis finnes i det hele tatt (en EKTE førstegangs-situasjon, garantert
av advisory-låsen) er et NYTT `execute()`-kall trygt og nødvendig. Se §6 under.

**Arkitekt-review runde 7 (PR #85, HEAD 01a35a2):** 1 funn - runde 6 sin direkte
`tool_executions`-bevis-sjekk for varsel-nøkkelen sjekket KUN `status`, ALDRI at raden FAKTISK er
`tool_id='telegram'`/`action='notify'` - samme "bind hele operasjonen, ikke bare nøkkelen"-klasse av
funn som `act_operation_fingerprint` allerede lukker for selve ACT-claimen (runde 2 Funn 1), nå
gjeldende for selve REKONSILIERINGS-BEVISET også. En rad under nøkkelen fra et ANNET tool/action ville
blitt godtatt som "bekreftet levert" uten noen faktisk Telegram-sjekk. Rettet: spørringen henter nå
også `tool_id`/`action`, og en mismatch kastes EKSPLISITT (`SituationActNotificationEvidenceMismatchError`,
fail-closed) i stedet for stille godtatt ELLER et nytt, muterbart forsøk på en allerede mistenkelig
nøkkel. Se §6 under.

**Arkitekt-review runde 8 (PR #85, HEAD 9566231):** 1 funn - runde 7 sin `tool_id`/`action`-binding
(runde 7 Funn 1) bandt fortsatt IKKE selve MELDINGSINNHOLDET: `tool_executions` lagrer INGEN
meldingstekst, så en `succeeded`-rad UNDER den forutsigbare nøkkelen (`situation:<id>:<nøkkel>:notify`)
fra et ANNET, tidligere ELLER gjenbrukt `telegram.notify`-forsøk MED ET ANNET INNHOLD kunne likevel bli
godtatt som "bekreftet levert" for DENNE meldingen - en same-key/same-tool/action/ANNEN-melding-mismatch
ville stille avansert stadiet UTEN at den FAKTISKE meldingsteksten noensinne var bekreftet sendt. Rettet:
et innholds-avledet SHA-256-fingeravtrykk (samme primitiv som `act_operation_fingerprint`, runde 2 Funn
1) over den EKSAKTE varsel-meldingsteksten (avledet DETERMINISTISK av `situationId`/`reason`/`tool_id`/
`action` via `buildNotifyMessage()`) bindes DIREKTE INN I selve varsel-nøkkelen (`computeNotifyKey()`,
`modules/situations/src/service.ts`) - IKKE en ny kolonne på `tool_executions` (runde 3 sin beskjed "keep
... ToolGateway gates intact" respekteres: ToolGateway sin EGEN, allerede reviewte tabell/pipeline
røres ALDRI). Et forsøk med ET ANNET innhold produserer derfor en HELT ANNEN nøkkel og treffer ALDRI
rekonsilieringens SELECT i det hele tatt - faller naturlig tilbake til "INGEN bevis", en trygg
førstegangs-utsendelse for DENNE meldingen, ALDRI en stille feilaktig "bekreftet"-status på et
ubeslektet innhold. Se §6 under.

**Arkitekt-review runde 9 (PR #85, HEAD fa40004):** 1 funn - runde 8 sin innholdsbundne varsel-nøkkel
ble avledet av `reason`, som er MUTERBAR tilstand: `evaluateCandidate()` oppdaterer `reason` ved en
re-deteksjon OGSÅ etter at stadiet har nådd `act` (stadie-non-regresjonen beskytter kun `stage`).
Gyldig sekvens som brøt gjenopprettingen: ACT + `telegram.notify` lyktes under nøkkelen for reason A →
krasj FØR `stage='act_notify'` ble persistert → en re-deteksjon endret reason til B → retryen regnet ut
en ANNEN nøkkel fra B, fant ALDRI det bekreftede beviset under A, og sendte et DUPLIKAT-varsel (brudd
på «no duplicate spam»). Rettet: den EKSAKTE varselteksten FRYSES nå i ny kolonne
`situations.act_notify_message` ATOMISK SAMMEN med selve claimen (fra raden låst med `FOR UPDATE` i
claim-transaksjonen), og BÅDE første sending OG ALL senere gjenoppretting avleder nøkkel og melding KUN
fra den frosne teksten (`computeNotifyKey(finalKey, situationId, message)`) - ALDRI fra `reason` lest
på nytt. En DB-CHECK (`situations_act_notify_message_frozen_ck`) gjør en claim UTEN frossen tekst
strukturelt umulig, og en `BEFORE UPDATE`-trigger (`situations_act_claim_immutable`, samme plpgsql-
mønster som repoets append-only-triggere) nekter ENHVER senere endring av nøkkel, fingeravtrykk eller
frossen tekst mens claimen står - uansett kodesti; kun claim (NULL → verdi) og eksplisitt frigjøring
(alle → NULL, `releaseStuckActClaim()`) er tillatt. `reason` forblir
bevisst muterbar (det er deteksjonens beskrivelse) - det er VARSEL-NYTTELASTEN som er immutabel fra
claimen. Se §6 under.

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
   `actOn()` REKONSILIERER FØRST mot `tool_executions` (Funn 2 runde 2). Funn 1 (arkitekt-review runde
   4) SKJERPET selve rekonsilieringen: en ny `execute()`-kall var IKKE alltid trygt, fordi ToolGateway
   sin idempotency_key-dedupe IKKE er dens FØRSTE port (policy/rate-limit/frozen/revoked/credential/
   preflight kjører FØR dedupe) - en SENERE, UBESLEKTET port-avvisning kunne derfor feilaktig
   OVERSKRIVE et allerede bekreftet resultat. `actOn()` kaller nå ALDRI `gateway.execute()` på nytt for
   en claim som ENTEN allerede er terminal (`act_result` satt) ELLER har `tool_executions`-bevis - i
   BEGGE tilfeller leses utfallet DIREKTE fra den persisterte situasjonen/beviset (pluss `gateway.get()`
   - et rent, side-effekt-fritt verktøy-definisjon-oppslag for `output_trust`, ALDRI en autorisasjon)
   og returneres UENDRET. KUN når INGEN bevis finnes i det hele tatt forblir vi fail-closed, og
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
   (ToolGateway sin egen dedupe gjelder nå OGSÅ varselet, ikke bare selve ACT-handlingen). Funn 1
   (arkitekt-review runde 5) skjerpet DETTE videre: runde 4 sin `terminal_replay` (se punkt 2) må IKKE
   returnere UENDRET når ACT er bekreftet MEN varselet FORTSATT står uavgjort (`stage` fortsatt `act`,
   krasj FØR/UNDER varsel-forsøket eller MELLOM et bekreftet varsel-bevis og selve `stage`-
   oppdateringen) - en replay i DETTE tilfellet kaller varsel-`execute()` PÅ NYTT med SAMME nøkkel
   (advisory-låsen fra Funn 1+2 runde 3 garanterer dette ALLTID er en trygg førstegangs-utsendelse
   ELLER en trygg, dedupliserende bekreftelse), og AVANSERER (selv-helbreder) til `act_notify` KUN på
   en faktisk bekreftet suksess - ALDRI en regresjon, siden en avvisning her bare lar `stage` forbli
   uendret på `act`. Funn 1 (arkitekt-review runde 6) skjerpet DENNE rekonsilieringen videre: selve
   varsel-`execute()`-kallet MÅ IKKE gjøres FØR varsel-nøkkelens EGNE `tool_executions`-bevis er lest
   DIREKTE - et NYTT `execute()`-kall ville OGSÅ gått gjennom telegram-verktøyets muterbare
   policy-/rate-limit-/frozen-/credential-port FØR dedupe, og kunne dermed ALDRI lest et FAKTISK
   bekreftet varsel-bevis hvis EN AV DE portene nå avviser et fersk forsøk. `terminal_replay` leser nå
   beviset DIREKTE (`succeeded` → avanser stille til `act_notify`, ZERO transportkall; et annet avgjort
   utfall → forbli ærlig på `act`, ZERO transportkall) - et NYTT `execute()`-kall skjer KUN når INGEN
   bevis finnes i det hele tatt. Funn 1 (arkitekt-review runde 7) skjerpet selve BEVIS-LESINGEN: en rad under
   varsel-nøkkelen bekrefter INGENTING med mindre den FAKTISK har `tool_id='telegram'`/
   `action='notify'` - en mismatch kastes (`SituationActNotificationEvidenceMismatchError`), ALDRI
   stille godtatt som "levert". Funn 1 (arkitekt-review runde 8) skjerpet BEVIS-BINDINGEN videre til
   selve MELDINGSINNHOLDET: `tool_id`/`action` alene identifiserer FORTSATT ikke den EKSAKTE
   varselteksten - varsel-nøkkelen inkluderer nå et innholds-avledet fingeravtrykk
   (`computeNotifyKey()`) over den DETERMINISTISKE meldingsteksten (`buildNotifyMessage()`), slik at
   en `succeeded`-rad for ET ANNET innhold produserer en HELT ANNEN nøkkel og ALDRI treffer denne
   rekonsilieringens oppslag - faller trygt tilbake til "INGEN bevis" i stedet for en falsk
   "bekreftet"-status. Funn 1 (arkitekt-review runde 9) lukket det siste hullet i DENNE bindingen:
   teksten nøkkelen avledes av MÅ være IMMUTABEL fra claimen - `reason` er det IKKE (re-deteksjon
   oppdaterer den etter ACT). Varselteksten fryses derfor i `act_notify_message` atomisk med claimen,
   og nøkkel + melding avledes KUN derfra i første sending og all gjenoppretting - en senere endret
   `reason` kan ALDRI flytte nøkkelen bort fra det bekreftede beviset (duplikat umulig).
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
vente og kan ALDRI observere et falskt "ingen bevis" mens forsøket fortsatt pågår; OG fire nye
adversarielle tester (Funn 1, runde 4): en retry av en ALLEREDE fullført ACT etter at credentialen ble
tilbakekalt, connectoren ble fryst, eller rate-limiten ble oppbrukt returnerer ALLE det UENDREDE
opprinnelige resultatet med ZERO nye transportkall, og en retry etter et allerede levert ACT+NOTIFY med
Telegram-credentialen tilbakekalt beholder `act_notify` UENDRET - ALDRI nedgradert til `act`; to
krasj-grense-tester (Funn 1, runde 5): en retry etter en krasj MELLOM ACT-persistering og selve
varsel-forsøket forsøker varselet FOR FØRSTE gang og avanserer til `act_notify`; en retry etter en
krasj MELLOM et bekreftet varsel-bevis og selve `stage`-oppdateringen selv-helbreder til `act_notify`
UTEN noe nytt transportkall; OG fire nye tester (Funn 1, runde 6) som beviser DEN SAMME
selv-helbredingen selv når en FERSK varsel-policy-nektelse, en tilbakekalt Telegram-credential, en
fryst connector, ELLER en oppbrukt rate limit ville avvist et NYTT forsøk - `stage` avanserer likevel
korrekt til `act_notify`, ZERO nye transportkall i alle fire); en test (Funn 1, runde 7) som beviser at
en `tool_executions`-rad under varsel-nøkkelen MED ET ANNET `tool_id`/`action` avvises fail-closed
(`SituationActNotificationEvidenceMismatchError`) i stedet for stille godtatt; OG en ny test (Funn 1,
runde 8) som beviser at en `succeeded` `tool_executions`-rad under en varsel-nøkkel BEREGNET FOR ET
ANNET meldingsinnhold (en annen `reason`) ALDRI blir funnet av rekonsilieringen for DENNE meldingen -
`actOn()` sender i stedet ETT ferskt, ekte varsel MED DEN KORREKTE teksten (ZERO falsk "bekreftet"-
avansering på det ubeslektede beviset); OG fire nye tester (Funn 1, runde 9): reviewens eksakte
sekvens - bekreftet varsel for reason A + krasj før stage-oppdatering + re-deteksjon som endrer reason
til B + retry - gir ZERO nye transportkall og selv-helbreder til `act_notify`; krasj FØR varselet +
re-deteksjon gir ETT varsel med den FROSNE teksten (reason A, aldri B) og en ny retry etter enda en
re-deteksjon dedupliserer under SAMME nøkkel; databasen avviser en claim uten frossen tekst
(`situations_act_notify_message_frozen_ck`) OG enhver endring av claim-feltene mens claimen står
(`situations_act_claim_immutable` - frigjøring til NULL og endring av ikke-claim-felt som `reason`
forblir tillatt); og en normal fersk ACT fryser teksten ved claimen slik at en re-deteksjon etterpå
endrer `reason` men ALDRI `act_notify_message`).

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
