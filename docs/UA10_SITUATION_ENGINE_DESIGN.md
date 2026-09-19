# UA-10 — Design-/data-governance-notat (Proactive Situation Engine, P0)

**Status:** UA-10 «Proactive Situation Engine» — provider-uavhengig, kilde-uavhengig P0-kjerne bygget
(2026-09-15). **P1-aktiveringen (D-160, §10) er PRODUCTION_VERIFIED på ekte Windows/Docker-host
2026-09-17 (D-161; run_id `0562c48a`, main `e34cb8a9`, 18/18 markører PASS, `hard_fail=false`,
`blocked_external=0`) - runtime-gaten er lukket.** Samme form og disiplin som `UA8_PERSONAL_TWIN_DPIA.md`/`UA3_BUSINESS_DPIA.md`: kort og
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
på nytt. En DB-CHECK gjør en claim UTEN frossen tekst strukturelt umulig (skjerpet i runde 10 til
HELE claim-tuppelet, `situations_act_claim_tuple_ck`), og en `BEFORE UPDATE`-trigger (`situations_act_claim_immutable`, samme plpgsql-
mønster som repoets append-only-triggere) nekter ENHVER senere endring av nøkkel, fingeravtrykk eller
frossen tekst mens claimen står - uansett kodesti; kun claim (NULL → verdi) og eksplisitt frigjøring
(alle → NULL, `releaseStuckActClaim()`) er tillatt. `reason` forblir
bevisst muterbar (det er deteksjonens beskrivelse) - det er VARSEL-NYTTELASTEN som er immutabel fra
claimen. Se §6 under.

**Arkitekt-review runde 10 (PR #85, HEAD 9ea4a6e):** 1 funn - runde 9 sin strukturelle håndhevelse var
IKKE lukket: CHECK-en dekket kun «nøkkel ⇒ melding», og triggeren avviste kun endringer når BÅDE gammel
og ny nøkkel var satt. En UPDATE som nullet KUN `act_idempotency_key` (og lot `act_claimed_at`/
fingeravtrykk/melding stå) passerte derfor begge - neste `actOn()` ville sett raden som uclaimet og
kunne claimet/utført en ANNEN operasjon oppå eksisterende claim/bevis (duplikat ekstern utførelse).
Tilsvarende ble nøkkel+melding UTEN fingeravtrykk godtatt. Rettet: claimen håndheves nå som ETT ATOMISK
TUPPEL over alle fire feltene (`act_claimed_at`, `act_idempotency_key`, `act_operation_fingerprint`,
`act_notify_message`) - `situations_act_claim_tuple_ck` krever alle NULL eller alle satt (avviser ENHVER
delvis-NULL-permutasjon, både delvis frigjøring og delvis claim), og `situations_act_claim_immutable`
sammenligner nå også `act_claimed_at` (avviser enhver delvis ERSTATNING mens claimen står). Sammen
tillater de KUN komplett NULL → claimet, uendret claimet, og komplett claimet → NULL. Se §6 under.

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
| INFORM/SUGGEST-leveranse (P1, D-160) | `situations.inform_message` / `situations.inform_delivered_at` (`057_situations_activation.sql`) | Den FROSNE varselteksten (satt atomisk med ankeret `last_notified_at`) og bokført leveranse for NØYAKTIG det ankeret — se §10. |
| Autonomi-policy (P1, D-160) | `situation_autonomy_policies` (`057_situations_activation.sql`) | Eierens EKSPLISITTE auto-ACT-binding per (tenant, space, domene): `tool_id`/`action`/statiske `parameters` (kun immutable plassholdere), `enabled`, `actor_person_id` (sammensatt FK mot `person_tenants`). FRAVÆR av rad = ingen auto-ACT. |

**Behandlet fra og med P1 (D-160, se §10):** en LIVE bro FRA `business_open_loops` TIL `situations`
(sveipen `runSituationSweep()` kaller `evaluateCandidate()` for hver åpen loop — domenene
pipeline/support/deadlines/spend/product/operations, uttømmende kartlagt i `open-loop-bridge.ts`),
faktisk leveranse av INFORM/SUGGEST-varsler via `telegram.notify`, og auto-ACT UTELUKKENDE under en
eier-bundet policy.

**Ikke behandlet i dag (eksplisitt, ikke stilltiende utelatt):** INGEN ny anomali-detektor for
infra/home/health (ingen eksisterende signalkilde — se §5). INGEN modell-assistert klassifisering
(`computeTargetStage()` er REN, deterministisk regel-logikk — ingen ModelGateway/AI Council-kall).
INGEN counterfactual/simulation/feedback-learning. INGEN auto-ACT uten en eksplisitt eier-policy
(`actOn()` uten policy krever fortsatt en EKSPLISITT kaller).

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

**P1 (D-160):** de detektorene som FINNES (alle 26 `OpenLoopType`-verdiene i `@jarvis/business`) er
nå faktisk koblet til motoren gjennom broen i `open-loop-bridge.ts` — uttømmende `switch` med
`never`-sjekk, så en NY loop-type uten en eksplisitt domene-avgjørelse feiler typecheck og kan ALDRI
stille havne i et domene eieren ikke har pauset/bundet. Broen OPPFINNER fortsatt ingen detektor.

**Infra-slice (D-195):** `modules/incidents` (UA-5/D-104/D-105 Production Operations Control Plane)
ble bygget SENERE, uavhengig av UA-10 P0/P1 - den er nå den faktiske signalkilden §5 sin opprinnelige
"ingen eksisterende signalkilde"-begrunnelse ventet på, for infra SPESIFIKT. `infra-incident-bridge.ts`
følger NØYAKTIG samme mønster som `open-loop-bridge.ts`: aktive incidents (alt unntatt
`resolved`/`wont_fix`) -> `SituationCandidateInput` i domene `"infra"`, `detection_key` prefikset
`infra_incident:`, alvorlighetsgrad->prioritet, INGEN eier (samme identitets-begrunnelse som
business-broen - en incident kan re-tildeles). Resolusjon skjer IKKE via `source_open_loop_id` (den FK-
en er business-open-loop-spesifikk) - en ny, generalisert `SituationEngine.resolveStaleForDomain
(tenantId, memorySpace, domain, activeDetectionKeys)` resolverer alt åpent i domenet som kilden ikke
lenger rapporterer som aktivt. Home/health forblir UENDRET deferred - ingen signalkilde finnes ennå for
dem. Se `docs/IMPLEMENTATION_PLAN.md` sin "UA-10 infra-slice"-seksjon for full leveranse/testliste.

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
(`situations_act_claim_tuple_ck`) OG enhver endring av claim-feltene mens claimen står
(`situations_act_claim_immutable` - frigjøring til NULL og endring av ikke-claim-felt som `reason`
forblir tillatt); og en normal fersk ACT fryser teksten ved claimen slik at en re-deteksjon etterpå
endrer `reason` men ALDRI `act_notify_message`); OG en test (Funn 1, runde 10) som går gjennom HELE
permutasjonsmatrisen for claim-tuppelet: hvert av de fire feltene nullet ALENE på en claimet rad avvises
(inkl. reviewens eksakte «kun nøkkel nullet»-permutasjon), hvert felt satt ALENE og tre-av-fire (inkl.
nøkkel+melding uten fingeravtrykk) på en uclaimet rad avvises, raden er uendret etter hver avvisning, og
KUN komplett claim og komplett frigjøring godtas).

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
| Live bro fra `business_open_loops` til `situations` | **LUKKET i P1 (D-160, §10)** — `runSituationSweep()`/`open-loop-bridge.ts`. Vision-/helse-/lokasjonskilder: fortsatt egne, senere wiring-slicer mot SAMME `evaluateCandidate()`-kontrakt |
| Nye anomali-detektorer for infra/home/health | **infra LUKKET (D-195, se §5)** — `infra-incident-bridge.ts` mot `modules/incidents` (UA-5). home/health forblir egne, separate slicer PER domene (fortsatt ingen eksisterende signalkilde for dem, se §5) |
| Modell-assistert klassifisering | Krever ModelGateway/AI Council — en leverandøravhengighet, egen D-64/D-41-port |
| Counterfactual/simulation, feedback learning | ML-tungt, masterplanens egen "where useful"-kvalifikator — egen, senere slice |
| Autonom/tidsstyrt auto-ACT | **LUKKET i P1 (D-160, §10) med en EKSPLISITT grense:** auto-ACT skjer KUN for situasjoner i `suggest` hvis domene har en AKTIVERT, eier-bundet `situation_autonomy_policies`-rad. Uten policy: ingenting. Domene-pause, global KillSwitch, PolicyGateway og hele ToolGateway-preflight-/postcondition-pipelinen gjelder UENDRET for hvert kall |
| Wiring inn i `apps/api/src/main.ts`/en kontrollflate | **LUKKET i P1 (D-160, §10)** — motor + durable pause (`restore()` ved oppstart) + `situations`-verktøyet + `situation-sweep`-jobben er wiret i komposisjons-roten |

## 10. P1 Aktivering (D-160) — motoren blir levende, på eierens premisser

P0 beviste at MEKANISMEN var trygg når den ble kalt — og ingenting kalte den: `@jarvis/situations` var
importert ingen steder utenfor sin egen pakke, ingen sveip kalte `evaluateCandidate()`, `last_notified_at`
ble stemplet uten at noen sendte varselet, og `actOn()` var kun nåbar fra tester. Masterplanens DoD
("Situation Engine performs autonomous ACT/ACT+NOTIFY with explainability, dedupe and owner
pause/revoke") krever at den faktisk KJØRER. P1 lukker det gapet uten å røre P0 sine reviewede
garantier.

**Sveipen (`sweep.ts`, `DailyScheduler`-jobb `situation-sweep`, `JARVIS_SITUATION_SWEEP_HOUR`, default
07 — ETTER `business-open-loop-sweep` kl. 06)** kjører per (tenant, space) i fast rekkefølge:

1. **INGEST** — hver åpen `business_open_loop` → `mapOpenLoopToCandidate()` → `evaluateCandidate()`.
   `detection_key` = `open_loop:` + loopens egen nøkkel (samme idempotente identitet, aldri duplikat).
   `owner_person_id` settes BEVISST IKKE fra loopen: en loop kan lovlig re-tildeles, og motoren
   avviser (korrekt) en re-deteksjon med endret identitet — eieren leses via `source_open_loop_id`.
2. **RESOLVE** — situasjoner hvis kilde-loop er løst, løses (`resolveForResolvedSources()`, idempotent).
3. **DELIVER** — `deliverPendingInformNotifications()`: ANKER (`last_notified_at`, P0-semantikk uendret)
   er skilt fra LEVERANSE (`inform_delivered_at`). Varselteksten fryses (`inform_message`) ATOMISK med
   ankeret i selve `evaluateCandidate()`-transaksjonen (samme lærdom som `act_notify_message`, runde 9).
   Nøkkelen mot `tool_executions` er `situation:<id>:inform:<anker-ISO>:<sha256(tekst)>` — ett varsel
   per SYKLUS, aldri per sveip. Evidens-først: en `succeeded` `telegram`/`notify`-rad under nøkkelen
   bokfører leveransen UTEN nytt kall (krasj mellom sending og bokføring); en rad som IKKE er
   `telegram`/`notify` er fail-closed (`evidence_mismatch`, aldri godtatt); transportfeil lar varselet
   stå ventende og prøves igjen under SAMME nøkkel (ToolGateway sin egen dedupe gjør et duplikat
   strukturelt umulig). En ny syklus etter resuppress-vinduet er et nytt anker + ny frosset tekst.
4. **AUTO-ACT** — `autoActPending()`: for åpne, uclaimede situasjoner i `suggest` (høy prioritet,
   konfidens ≥ 0,75) med en AKTIVERT `situation_autonomy_policies`-rad for domenet → `actOn()` med
   policyens `tool_id`/`action`/`parameters`. Parametre kan KUN referere immutable plassholdere
   (`{{situation_id}}`, `{{source_open_loop_id}}`, `{{domain}}`, `{{detection_key}}` — ALDRI `reason`,
   som er muterbar og ville brutt `act_operation_fingerprint` ved retry); en ukjent plassholder
   avvises ved BINDING, en manglende verdi hopper over situasjonen. Ekstra nøkler injiseres aldri
   (verktøyenes strenge `input_schema` avgjør). Pauset domene/allerede claimet ⇒ `skipped`, aldri et
   kall. Eksakt-én-gang-garantien er P0 sin claim, uendret.

**Autoritet.** Å BINDE/fjerne en autonomi-policy krever den SAMME sovereign-eieren som
`releaseStuckActClaim()` (`recoveryAuthority.owner_person_id`, fail-closed uten) og tar SAMME
advisory-lås som `actOn()`/pause for domenet, så en policy-endring aldri kappløper med et auto-ACT i
flukt. Hvert faktiske kall autoriseres i tillegg av `PolicyGateway.authorize()` inne i `execute()`.
Sveipen kjører under eierens identitet i sveipens space per tenant; en tenant eieren ikke er
autorisert for avvises av PolicyGateway (fail-closed), aldri av en stille utelatelse.

**Kontrollflaten (`transport.ts`, verktøy `situations`).** `get_queue`/`get_pause_state`/
`get_notification_policy`/`list_autonomy_policies` (A), `resolve` (B), `pause_domain`/`unpause_domain`/
`pause_all`/`unpause_all`/`set_notification_policy`/`set_autonomy_policy`/`clear_autonomy_policy`/
`release_stuck_act_claim` (C). Tenant/space/aktør avledes UTELUKKENDE fra den betrodde
`ToolInvocationContext.identity` (D-68) som `ToolGateway.execute()` selv setter fra den server-side-
oppløste `request.identity` — ALDRI fra parametre (skjemaene er `strict()` uten identitetsfelter;
manglende context feiler lukket med `situations_missing_invocation_context`). Dette lukker "Owner can
pause a domain or entire Situation Engine instantly" I PRAKSIS og er den kontrakten UA-11 sin samlede
kontrollflate skal komponere.

**Scheduler-grensen er fail-closed.** `runSituationSweepForAllTenants()` isolerer feil per steg/tenant
(tellinger + `errors[]`) slik at én tenant aldri velter de andre — men resultatet KASTES deretter av
`assertSituationSweepHealthy()` hvis noen tenant har ikke-tom `errors[]`, `identity_conflicts > 0`,
`delivery.evidence_mismatch > 0` eller `delivery.pending > 0`. `DailyScheduler.start()` kaller
`markCompleted()` KUN etter at `deliver()` resolvet, så dagens `scheduler_state`-rad blir stående med
`completed_at IS NULL` (varig, observerbar "ikke fullført") og en strukturert `situation_sweep_failed`-
logglinje skrives. `auto_act.denied`/`skipped` er ærlige, forventede utfall og teller ikke som feil.

**Bevis.** `modules/situations/test/activation.test.ts` (ekte Postgres/RLS, ekte `OpenLoopService`,
ekte `ToolGateway`/`PolicyGateway`, transport-spioner): ingest/idempotens/tenant-isolasjon/kildebasert
løsning; ETT varsel per syklus, null på re-sveip, rekonsiliering fra bevis uten kall, transportfeil →
retry med nøyaktig ett vellykket kall, fremmed bevis fail-closed, stille timer, resuppress → ny syklus;
auto-ACT: ingenting uten policy, nøyaktig ett `actOn` med rendrede plassholdere (preflight/mutasjon/
readback + ett ACT-varsel), pause vinner, kildeløs situasjon hoppes over, autoritet/`*`/ukjent
plassholder avvises, RLS-isolerte policyer, clear/disabled; kontrollflaten gjennom ekte gateway (varig
pause som overlever `restore()`, ikke-eier avvist). `open-loop-bridge.test.ts`: uttømmende
domene-kartlegging, kandidat-mapping, plassholder-rendring, RLS-trygg tenant-orkestrering.

**Arkitekt-review runde 1 (PR #86, HEAD c8a5c13, review 5229219808):** 3 funn. (1) Sekvens: PR #83
(UA-9) skal rekonsilieres mot main FØR neste slice (D163/D164) — en kontrollplan-beslutning PR-en ikke
kan lukke; PR #86 forblir draft/umerget til arkitekten har avklart. (2) Kontrollflaten leste
`tenant_id`/`memory_space`/`actor_person_id` (og hele `identity` for `release_stuck_act_claim`) fra
verktøyPARAMETRE: en kaller kunne oppgi eierens `person_id` selv, og motorens "uavhengige" sovereign-
port sammenlignet mot forfalskede data. RETTET: identitet kun fra `ToolInvocationContext` (se
kontrollflate-avsnittet over); bevist med forfalskede parametre gjennom ekte gateway
(`invalid_parameters` før transporten nås) og direkte mot transporten under en ANNEN context-identitet
(`DomainPauseUnauthorizedError`/`SituationAutonomyUnauthorizedError`/
`SituationRecoveryUnauthorizedError`), manglende context kaster, og tenant B sin identitet ser tom kø.
(3) Scheduler-wiringen kastet sveiperesultatet (`.then(() => undefined)`): evidensmismatch/leveranse-/
auto-ACT-feil ble bokført som vellykket daglig jobb. RETTET: `assertSituationSweepHealthy()` (se
scheduler-avsnittet over); bevist med en EKTE `DailyScheduler` mot embedded Postgres — evidensmismatch
og transportfeil lar `completed_at` stå NULL, et sunt sveip setter det.

## 9. Oppdateringsplikt

Dette notatet oppdateres FØR — ikke etter — hver ny hendelseskilde (en `business_open_loops`-bro,
nye infra-/home-/health-detektorer), modell-assistert klassifisering, eller autonom auto-ACT-wiring.
Samme regel som `PROCESSOR_REGION_MATRIX.md` sin egen: et kapittel som ikke er fylt ut, er ikke i
produksjonsbruk.
