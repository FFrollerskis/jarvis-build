# WP-G2 (D-464): UA-8 Personlig digital tvilling - resterende deler (runbook)

**Status: `DORMANT` (alt er AV som standard bak `JARVIS_PERSONAL_*`-flagg) og `NOT VERIFIED` (ingenting er kjørt mot ekte Home Assistant, bil, iCloud, bank eller en iPhone/Watch; alt er bevist mot lokale fakes og en ekte embedded Postgres i tester).**
Bygget under eierens opphevelse av byggepausen (D-470) og masterplanen UA-8 (`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md`, «Personal Digital Twin»). Kjernen (kontekstmotor, lokasjon, helse-MVP, migrasjon 049-051) er fra D-130/D-131
og er uendret her; dette dokumentet beskriver det WP-G2 la til. Jussen i DPIA-en (`docs/UA8_PERSONAL_TWIN_DPIA.md`) er **utkast, ikke juridisk gjennomgått**.

**Ufravikelig, gjelder alt under:** (1) alt nytt er `DORMANT`: uten flagg er verktøylister, utvalg, intents, rate-grenser og ruter identiske med main (bevist av `wpg2-personal-flag-off-identity.test.ts` og de eksisterende `wph1`/`wph2`-baselinene);
(2) strengeste step-up (Q-55/D-468) for hver mutasjon - ingen «autonomi-binding», tale, Telegram, klokke eller system kan lempe på det; (3) ingen hemmeligheter i kode/logg/journal/varsel; (4) ubetrodd innhold (utstyr, leverandør, enhet) er data, aldri instruksjoner;
(5) JARVIS_CANONICAL: Jarvis eier handlingsjournalen, kontekstmodellen, lokasjons-/helsetilstanden og familie-/delt-rom-autoriteten; Home Assistant, bil-API, iCloud og bankene er kilder/sluk/utførere (D-64).

## 0. Status i ett blikk

| Del | Status | Bevis |
|---|---|---|
| P1a Kritiske hjemmehandlinger (lås, alarm, cover, ventil, bryter, scene, skript, klima-modus) | `BUILT`, `DORMANT` bak `JARVIS_PERSONAL_HOME_CRITICAL`; `NOT VERIFIED` mot ekte HA | `modules/tool-gateway/test/wpg2-home-critical-{unit,gateway}.test.ts` |
| Handlingsjournal (migrasjon 125) og eksekutor | `BUILT`, `DORMANT` | samme + `modules/erasure` (registrert), D-420-vakten |
| P1b Bil (`CarAdapter`, fake, D-kjede) | _se §3_ | _se §3_ |
| P1c Familie/delte rom | _se §4_ | _se §4_ |
| P1d Helse-inntak (enhetssignert) | _se §5_ | _se §5_ |
| P2e Apple Kalender/Påminnelser/Kontakter (CalDAV/CardDAV) | _se §6_ | _se §6_ |
| P2f Personlig økonomi-lesing | _se §7_ | _se §7_ |
| P2g Kontekstmotor + sesjonskontinuitet | _se §8_ | _se §8_ |

## 1. Flagg (alle AV som standard; kun eksakt `on`)

| Navn | Standard | Virkning |
|---|---|---|
| `JARVIS_PERSONAL_HOME_CRITICAL` | AV | Registrerer `home-assistant.critical_*` + `read_critical_state` og ruten `/personal/actions/*` (domene `home`); fjerner de gamle uherdede `lock_set`/`alarm_set` |
| `JARVIS_PERSONAL_HOME_TARGETS` | tom | EKSAKT liste over eierens EGNE entitets-id-er (`lock.inngang,cover.garasje,...`). Tom = hver mutasjon nektes (`home_target_not_authorized`) |
| `JARVIS_PERSONAL_HOME_SETTLE_MS` | 20000 | Hvor lenge Jarvis venter på sluttilstand (3000-120000); utenfor intervallet gir standarden |
| `JARVIS_PERSONAL_HOME_ALARM_CODE` (vault-ref) | tom | Alarmpanelets kode hvis panelet krever den; sendes kun til HA, aldri i journal/varsel/logg |

Flaggene står i `SERVICE_ENV.api` (`infra/local/service-env.mjs`), er generert inn i compose (`node ops/security/generate-compose-env.mjs --write`) og vaktes av `wpg2-flags-wiring.test.ts`. De når IKKE worker/voice/browser.

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
| Scopes | Ett langlivet tilgangstoken (`JARVIS_HA_TOKEN`): HA har ikke scope-oppdeling per tjeneste - **al begrensning gjøres av Jarvis** (mål-allowlist + step-up). `unverified`: om en bruker med færre rettigheter kan brukes |
| Risikoklasse | Alle mutasjoner D (retning i journalen); lesing A |
| Eier/delegert | Kun suveren eier (`owner_only`), ingen delegat; ingen modellflate (manifest: `control`, aldri `surfaces`) |
| Idempotens | Gatewayens ledger (nøkkel påkrevd) + journalens digest; lås/port/ventil/bryter/klima er idempotente ved enheten, scene/skript er ikke (aldri retry etter uavklart svar) |
| Sandbox | Egen test-HA-instans eller test-entiteter i `JARVIS_PERSONAL_HOME_TARGETS` (blast radius); ingenting her sier at produksjonstilgangen er begrenset |
| `DEFERRED` | `set_cover_position`/`set_valve_position` (delvis posisjon), `lock.open` (åpne fallen), `input_boolean`/`fan`/`humidifier`, skript-variabler, tilstandsabonnement (WebSocket) - HA REST eksponerer ikke area-registeret |
| `unverified` | At en gitt lås-/port-integrasjon oppdaterer tilstanden synkront med tjenestekallet (derfor vente-løkken); alarmpanel-kodekrav per panel |

## 9. Kjente restgap og åpne eierspørsmål
_Fylles ut i takt med resten av dokumentet (se de siste seksjonene)._
