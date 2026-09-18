# UA-11 — Design-notat (Executive Mode, P0)

**Status:** UA-11 «Executive Mode» — attention-ranking + samlet eier-kontrollflate P0-kjerne bygget
(2026-09-17, D-162). Samme form og disiplin som `UA10_SITUATION_ENGINE_DESIGN.md`: kort og teknisk.
Denne pakken (`@jarvis/executive`) eier INGEN egen tilstand og INGEN egen kilde. Den KOMPONERER
`@jarvis/situations` (UA-10, PRODUCTION_VERIFIED, D-161) - D-64: `situations` er allerede
JARVIS_CANONICAL, så komposisjon (ikke duplisering) er riktig retning for et lag som SAMLER hva som
trenger eierens oppmerksomhet.

## §1. Hvorfor komposisjon, ikke en ny motor

Masterplanens UA-11-mål («executive dashboard, daily brief, attention ranking», «one-tap
pause/override/revoke») beskriver en OVERFLATE, ikke en ny kilde til sannhet. `situations` (UA-10) er
ALLEREDE den kanoniske hendelses-/situasjons-tilstandsmaskinen (ignore -> remember -> inform -> suggest
-> act -> act_notify -> escalate), allerede tenant/space-isolert, allerede autoritets-/pause-/
policy-håndhevet. Å bygge en «Executive Situation Engine» ved siden av ville:

- duplisert `DomainPauseRegistry`/autonomi-policy-logikken (to sannheter om hva som er pauset),
- omgått den ALLEREDE reviewte D-68-identitets-disiplinen (`ToolInvocationContext`, ALDRI parametre),
- brutt D-64 (en ny, parallell kjerne for noe `situations` allerede eier kanonisk).

`@jarvis/executive` gjør derfor INGEN egen SQL. `ExecutiveService` sin konstruktør tar KUN en
`ToolGateway`-referanse - se §2.

## §2. Arkitektur: ETT nøstet ToolGateway-lag, aldri en sidevei

```
Eier/kaller (identity fra ToolInvocationContext, ALDRI fra parametre)
        │
        ▼
ToolGateway.execute({ tool_id: "executive", action, parameters })
        │  PolicyGateway.authorize() (SAMME sovereign-owner-modus/KillSwitch/freeze som ALT annet)
        ▼
ExecutiveTransport.invoke()
        │
        ▼
ExecutiveService (KUN en ToolGateway-referanse - ALDRI SituationEngine/DomainPauseRegistry direkte)
        │
        ▼  gateway.execute({ tool_id: "situations", action, parameters }, SAMME identity)
        │  PolicyGateway.authorize() KJØRER EN GANG TIL (dobbelt-gatet, ikke bypasset)
        ▼
SituationsTransport → SituationEngine / DomainPauseRegistry (UENDRET, D-160)
```

Dette er SAMME «nøstet ToolGateway-kall med uendret, videreført identitet» - mønsteret
`MeshToolExecutor`/`docker`-recovery/`incidents`-modulen allerede bruker for å komponere en annen
allerede-registrert kapabilitet (D-68 «SECURITY FIX #2»: den opprinnelige kallerens identitet gis
UENDRET videre til ethvert nøstet gateway-kall - denne pakken fabrikkerer eller eskalerer den aldri
selv). Konsekvensen: `executive.pause_domain` kan STRUKTURELT ikke gjøre noe `situations.pause_domain`
selv ikke også ville gjort - samme autoritetssjekk, samme audit-rad, samme database-tilstand.

## §3. Attention-ranking er deterministisk - ikke en modell, ikke en skjult heuristikk

`ranking.ts` er en REN modul: ingen database, ingen klokke unntatt en injisert `now`, ingen
ModelGateway/AI-kall. Faktorene som faktisk brukes (kun felt som finnes på `Situation`):

| Faktor | Kilde | Rolle |
|---|---|---|
| `stage` | `Situation.stage` | Primær vekt (`STAGE_ATTENTION_WEIGHT`) - `escalate` størst, `remember`/`ignore` filtreres helt ut (aldri attention-verdige). |
| `priority` | `Situation.priority` | Sekundær vekt (`PRIORITY_WEIGHT`) - kan ALDRI hoppe en hel stage-terskel. |
| `confidence` | `Situation.confidence` | Finjustering (±0,999) - kan ALDRI hoppe en hel priority-terskel. |
| `opened_at` | `Situation.opened_at` | Tie-break #1 ved lik score - eldre (mer «overdue») FØRST. |
| `last_notified_at` + `resuppress_hours` | `Situation.last_notified_at` / `situations.get_notification_policy` | Liten cooldown-nedvekting (aldri undertrykkelse - se §6). |
| `situation_id` | `Situation.situation_id` | Siste, ALDRI-tvetydige tie-break - garanterer total, replay-stabil orden selv ved to identiske rader. |

**Bevisst IKKE brukt:** «business impact» (masterplanens eksempelliste) - `Situation` har intet tallfelt
for forretningsmessig konsekvens. Å konstruere ett her ville vært oppfunnet semantikk dataene selv ikke
sier. Hører til en SENERE UA-11-slice DERSOM en kilde som faktisk bærer det kobles til `situations`
(samme D-64-disiplin).

**Determinisme bevist (ikke bare hevdet):** `modules/executive/test/ranking.test.ts` (21 tester) - samme
input gir alltid samme score (100 repetisjoner), input-rekkefølgen påvirker aldri sluttresultatet, en
komplett `JSON.stringify()`-likhet mellom to kjøringer med reversert inputrekkefølge.

## §4. Kontrollflaten (`tool_id: "executive"`)

| Action | Klasse | Gjennomslag til |
|---|---|---|
| `get_attention_queue` | A | `situations.get_queue` + `get_pause_state` + `list_autonomy_policies` + `get_notification_policy` (aggregert, rangert) |
| `get_attention_item` | A | Samme som over, filtrert til ETT `situation_id` + selve kilde-`Situation`-raden |
| `get_pause_state` | A | `situations.get_pause_state` |
| `pause_domain` | C | `situations.pause_domain` |
| `resume_domain` | C | `situations.unpause_domain` |
| `resolve_situation` | B | `situations.resolve` |
| `get_control_surface_status` | A | `owner_controls.get_control_state` + `situations.get_pause_state` (K1, D-164) |

Ingen handling har en HØYERE eller LAVERE kapabilitetsklasse enn den underliggende `situations.*`-
handlingen den videresender til - executive-laget innfører ALDRI en egen risikoklassifisering for
samme reelle mutasjon. `resolveIdentity()`-avslag/PolicyGateway-avslag/KillSwitch/freeze fra det
nøstede kallet PROPAGERES transparent (kastes videre av transporten, se `transport.ts` sin
`toolResultToTransportResult()`) - ALDRI en stille `ok:true` på executive-laget for noe det
underliggende laget faktisk nektet.

**K1-tillegg (2026-09-17, D-164): `get_control_surface_status`.** Lukker UA-11 akseptansekriterium 3
sitt siste gjenstående gap (D-163 §C(1)): eieren kunne se `situations`-domenepause via `executive.*`,
men IKKE den globale kill switch-/frys-/tilbakekall-tilstanden fra ÉN samlet overflate. Denne
handlingen komponerer `owner_controls.get_control_state` (den nye, durable/delte `@jarvis/owner-
controls`-pakken, D-164) OG `situations.get_pause_state` via TO nøstede `gateway.execute()`-kall -
SAMME komposisjonsdisiplin som §2 (`ExecutiveService` rører ALDRI `KillSwitch`/`OwnerControls`/
`DomainPauseRegistry` direkte). Svaret har TO EGNE, aldri-flettede felt: `owner_control` (global
sovereign-autoritet: kill switch + navngitte frosne connectorer/tilbakekalte credentials, hver med
reason/actor/changed_at) og `situation_domain_pauses` (domene-avgrenset UA-10-pausetilstand, KUN
domenenavn - `situations.get_pause_state` sin egen, pre-eksisterende kontrakt eksponerer ikke reason/
actor per domene, en dokumentert, IKKE-K1-relatert begrensning). Se `modules/executive/test/service-
transport.test.ts` gruppe G (5 tester: baseline, kill switch med reason/actor, frys+tilbakekall
samtidig, domenepause+connector-frys forblir distinkte lag, global KillSwitch nekter også denne
lesingen). Klasse A (les) - UENDRET av D-164/D-166 sitt selvgjenopprettings-unntak i `PolicyGateway`
(det unntaket gjelder KUN de tre navngitte `owner_controls`-handlingene
`get_control_state`/`deactivate_kill_switch`/`restore_credential` - sistnevnte lagt til av D-166 sin
B1-fiks, se der - ALDRI `executive.get_control_surface_status`: en aktiv kill switch nekter DENNE
lesingen også, se testen).

## §5. Persistens: NULL ny tabell

`ExecutiveService`/`ExecutiveTransport` gjør ZERO SQL. Attention-køen avledes DETERMINISTISK av
`situations.get_queue()` HVER gang - det finnes derfor ingen «cache» som kan bli stale, ingen
Q-20-erasure-registrering å legge til (ingen persondata lagres av denne pakken selv - `situations`
sin EGEN, allerede-registrerte erasure-plikt er uendret og fullt tilstrekkelig), ingen RLS å bygge
(RLS-grensen `situations` allerede håndhever er UENDRET arvet).

## §6. Sikkerhetsmodell (uendret, arvet - ikke re-implementert)

- **Identitet:** `ToolInvocationContext.identity` ALENE, ALDRI parametre (`.strict()`-skjemaer uten
  identitetsfelt - et forsøk på å oppgi `tenant_id`/`actor_person_id` i parametre avvises av
  `ToolGateway` som `invalid_parameters` FØR transporten nås - bevist i `service-transport.test.ts`).
- **Autoritet:** sovereign-eiermodus, KillSwitch, freeze, rate-limit - ALLE håndheves av DET NØSTEDE
  `situations.*`-kallets EGEN `PolicyGateway.authorize()`-runde, i tillegg til executive-lagets EGEN
  runde (dobbelt-gatet, aldri enkelt-gatet eller bypasset). Bevist: en global `KillSwitch.activate()`
  nekter LESING gjennom executive også, ikke bare mutasjon.
- **Tenant-/space-isolasjon:** RLS-grensen `situations` allerede håndhever - IKKE en egen
  policy-regel. En identitet for en tenant UTEN data får et gyldig, TOMT resultat (RLS - dette er
  IKKE et sikkerhetshull, se `service-transport.test.ts` sin eksplisitte, dokumenterte test av denne
  grensen: lesing er RLS-skopet, mutasjon er sovereign-owner-policy-gatet).
- **Cooldown ≠ undertrykkelse:** en nylig varslet situasjon nedvektes MARGINALT (§3), men forsvinner
  ALDRI fra køen - masterplanens «no duplicate spam»-krav gjelder SELVE VARSLINGEN (`situations`
  sin egen resuppress-mekanikk, uendret), ikke synligheten i attention-køen.

## §7. Bygges IKKE i denne sliceen (DEFERRED, eksplisitt - ikke glemt)

- **Executive dashboard/UI.** Kontrollflaten (ToolGateway-kapabiliteten) er bygget og testet; en
  eier-vendt visuell flate (HTTP-rute i `server.ts`, eller en klient) er en SENERE UA-11-slice - samme
  reifiseringsnivå `situations.*` selv har i dag (ingen dedikert HTTP-rute finnes for den heller).
- **Business health / personal-domenekilder** (cash/revenue/pipeline/churn/marketing/schedule/travel/
  home/health-signaler). `situations` har ingen slik kilde koblet til ennå (kun `business_open_loops`-
  broen fra UA-10 P1) - når/hvis en slik kilde kobles til `situations` (D-64-disiplinen: KOMPOSISJON),
  vil den automatisk vises i attention-køen uten en executive-side-endring.
- **Decision log, scenarios, risk register, goals/OKRs, delegation board.** Masterplan-bullets uten en
  eksisterende kanonisk kilde i repoet ennå.
- **"Business impact"-vekting i ranking** - se §3.
- **Modell-assistert ranking/klassifisering.** P0 er 100% deterministisk (byggeordrenes eksplisitte
  krav: en modell autoriserer ALDRI en handling alene, og fail-closed deterministisk fallback er
  påkrevd DERSOM modellbruk introduseres - P0 introduserer INGEN modellbruk i det hele tatt).
- **Worker-wiring.** `worker-main.ts` kobler bevisst ikke til `executive` (eller til `situations` -
  se D-162 sitt eget funn i DECISIONS_AND_ASSUMPTIONS.md: dette er en PRE-EKSISTERENDE, dokumentert
  tilstand fra D-160, ikke noe DENNE sliceen skaper). Executive Mode har, som `situations`, ingen
  faktisk kaller i workerens prosess - å koble den inn nå ville vært utestet, ubrukt kode.
- **Host-akseptanse-harness/RUNTIME_GATES-rad (P0-scope, uendret).** P0 selv introduserer ZERO ny
  migrasjon, ZERO ny leverandør, ZERO ny runtime-avhengighet - se RUNTIME_GATES.md for gate-status og
  begrunnelse. K1 (D-164, egen slice) la til migrasjon 058 + en EGEN host-harness
  (`modules/owner-controls/scripts/k1-owner-control-authority-host-run.ts`) for DEN sliceens
  `owner_controls.*`/durabilitets-gap - IKKE for `executive.*` sin egen kontrollflate, som forblir
  `HOST_ACCEPTANCE_REQUIRED=false` for alt utenom den nye `get_control_surface_status`-handlingen
  (som selv har ZERO ny migrasjon/credential - den leser KUN de to allerede-durable lagene).

## §8. Tester

- `modules/executive/test/ranking.test.ts` (21) - REN, ingen database: stage/priority-totalordning,
  determinisme, tie-break-stabilitet, replay-stabilitet, autoritetsstatus-felt, forklaringsfelt.
- `modules/executive/test/service-transport.test.ts` (17) - ekte embedded Postgres/RLS + ekte
  `ToolGateway`/`PolicyGateway`/`SituationEngine`/`DomainPauseRegistry`: komposisjon (ikke kopi) av
  `situations.get_queue`, tenant-isolasjon, memory-space-isolasjon, eier-autoritet, forfalsket
  identitet avvist, manglende invocation-context feiler lukket, global KillSwitch nekter lesing,
  pause/resume gjennom kanonisk `situations.*` (samme DB-tilstand, ingen duplikat-rad, ingen
  varsel-sideeffekt), pauset domene gjenspeiles korrekt i attention-køen, resolve/stale forsvinner
  fra køen, `get_attention_item` viser full begrunnelse + kilde-situation.
- `apps/api/test/executive-wiring.test.ts` (4) - komposisjons-rot-regresjonsvakt (SAMME mønster som
  `drive-runtime-wiring.test.ts`): `executiveToolDefinitions()` er INNI samme `additionalTools`-liste
  som `situationsToolDefinitions()`, `ExecutiveService` konstrueres med `toolGateway` (aldri motoren
  direkte), `worker-main.ts` importerer bevisst ikke `@jarvis/executive`.
- **K1-tillegg (D-164):** `service-transport.test.ts` gruppe G (5, se §4) beviser
  `get_control_surface_status` sin komposisjon. Selve `owner_controls.*`-namespacet (durabilitet,
  api-/worker-parity, autorisasjon, audit, restart) er dekket av EN EGEN suite,
  `modules/owner-controls/test/owner-control-authority.test.ts` (22) - se D-164, ikke duplisert her.

## §9. Akseptansekriterier - status etter P0

Masterplanens UA-11-akseptansekriterier:

1. **"Top priorities are source-backed and actionable."** Hvert attention-item peker til en
   `situation_id` (+ `source_open_loop_id`/`detection_key` der relevant) - INGEN item uten en
   kanonisk kilde. `action_kind` (`read`/`suggest`/`act`) sier eksplisitt hva som er handlingsbart.
2. **"Jarvis explains why something was prioritized or executed."** `explanation: string[]` +
   `recommended_next_action` på HVERT item - deterministisk avledet av de faktiske feltene som deltok
   i scoren (§3), aldri en skjult vektsum eller en modell-generert tekst.
3. **"Owner can stop/revoke/reconfigure any connector, provider, agent or autonomy domain from one
   control surface."** For P0: DELVIS - `executive.pause_domain`/`resume_domain` gir ÉN flate for
   Situation Engine-domener (komponerer `situations.*`). Connector-/provider-nivå kontroll
   (`OwnerControls`/`KillSwitch`) var fortsatt in-memory, per-prosess (D-163).
   **OPPDATERT 2026-09-17 (K1, D-164): gapet er nå IMPLEMENTERT.** `OwnerControls`/`KillSwitch` er
   durable+delt (migrasjon 058), eksponert som kanonisk `owner_controls.*` ToolGateway-namespace
   (aktivere/deaktivere kill switch, fryse/gjenåpne connector, tilbakekalle/gjenopprette credential -
   alle klasse C/D, sovereign-eier instant), OG `executive.get_control_surface_status` (§4) samler
   BÅDE dette laget og `situations`-domenepausen i ÉN lesing. Kriteriet er dermed oppfylt i kode/
   suite. **OPPDATERT 2026-09-18 (K1 host-akseptanse, D-165): kjernemekanismen (kill switch +
   connector-frys, api-/worker-cross-prosess-parity, restart-persistens, audit) er nå
   `PRODUCTION_VERIFIED` på ekte Windows/Docker Desktop-host (run_id `d7d5d246`, 10/10 PASS,
   `hard_fail=false`, EKTE `docker compose restart api worker`).** `executive.get_control_surface_status`/
   idempotency ble IKKE øvet av dette spesifikke host-harnesset og forblir suite/CI-proven, ikke
   overdrevet til host-proven - se RUNTIME_GATES.md for den eksplisitte distinksjonen. **OPPDATERT
   2026-09-18 (K1 B1-fiks, D-166): `revoke_credential`/`restore_credential` var IKKE bare "ikke øvet
   ennå" som antatt over - uavhengig arkitekt-review av PR #93 fant en REELL selv-lås-bug (`restore_credential`
   på den delte `credential_ref` ville blitt blokkert av sin egen tilbakekalt-credential-sjekk, ingen
   kanonisk gjenopprettingsvei). Fikset med en minimal, handlings-nivå selvgjenopprettings-mengde
   (`OWNER_CONTROLS_SELF_RECOVERY_ACTIONS`, delt av BÅDE `PolicyGateway`- og `ToolGateway`-gaten - se
   D-166 for samtidig-kill-switch-deadlock-analysen). Suite-bevist (30/30+809/809 grønne); host-harnesset
   utvidet men IKKE kjørt på nytt av Tobias - `FIXED_SUITE_VERIFIED_AFTER_B1`, `HOST_ACCEPTANCE_REQUIRED=true`,
   IKKE `PRODUCTION_VERIFIED`, for DENNE delkapabiliteten spesifikt.** `/infra/pause` (D-104,
   `InfraExecutionGate`) forblir en SEPARAT, allerede-dokumentert, snevrere mekanisme - fersk-verifisert
   IKKE en del av dette gapet (D-164 F), ikke rørt av K1.
