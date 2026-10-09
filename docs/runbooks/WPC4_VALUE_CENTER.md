# WP-C4 Value Center og verdi-løkkene V2-V5 - slik bruker og aktiverer du dem

**Formål:** UA0-RUNRATE trenger tall for hva Jarvis faktisk gjør for deg (Value Track kap. 9). Value Center er en ren lese-rapport over eksisterende tabeller. I tillegg er V2 (oppfølgingsvarsel på Telegram),
V3 (Builder Loop-beredskap) og V5 (forslag til driftshandlinger) bygget som **sovende** deler. Alt som sender eller skriver er **AV som standard**.

> **Ærlig status (bygget i en container uten Docker/NAS/Telegram):** koden er enhets- og databasetestet (ekte Postgres som app-rolle, RLS), men **ikke kjørt på NAS-en og ikke mot ekte Telegram**.
> Ingenting under er "produksjonsklart" før du har kjørt verifiseringen nederst på NAS-en og lest resultatet.

## Status per løkke
| Løkke | Status | Hva som finnes | Hva som mangler |
|---|---|---|---|
| V1 Daily Executive Brief | `WIRED` (fantes) + bruksmetrikk | genererte/leverte briefer, daglig løpers helse (tapte døgn, nye forsøk) | "åpnet/besvart" kan ikke måles (Telegram gir ingen lesekvittering) |
| V2 Unified Follow-up | pull `WIRED`, **push `DORMANT`** | åpne/lukkede oppfølginger, alder, påminnelser; planlagt push-løper (rolig tid, døgngrense, dedupe, ledger) | flagget `JARVIS_V2_PUSH_ENABLED=true` + din vurdering |
| V3 Builder Loop | **`DORMANT`** (sover) | ren beredskapsvurdering (7 krav) i rapporten | aktivering finnes ikke i kode, og kan ikke slås på av kode (`activation_decision` er alltid `false`) |
| V4 Business Operating Loop | `NOT_BUILT` | - | venter Business-tenant-topologi (Q-48) |
| V5 Autonomous Operations | **`BUILT_UNWIRED`** | ren logikk som gjør funn om til FORSLAG med risikoklasse A-D (`executes: false`) | levering via bekreftelsesveien (bekreftelser utløper etter 5 min) og et signert D-løp for omstart |

## Slik leser du rapporten
- **Chat:** «hva har du hjulpet meg med», «verdi», «bruk», «verdirapport» (hurtigbane, ingen modell; samme verktøy som modellen: `executive.get_value_report`, klasse A).
- **Dashbord:** seksjonen «Verdi og bruk» (leser `POST /value/query` med ditt grant; ruten har eget lese-allowlist og videresender aldri parametre fra kroppen).
- Vinduer er **hele lokale døgn i Europe/Oslo**: «siste 7/30 døgn» inkluderer i dag. Rapporten viser selv de eksakte grensene.
- **«ikke målbart»** betyr at kilden ikke kunne leses (eller at noe aldri måles: spart tid, dine korrigeringer, åpnet/besvart). Det er aldri et påstått 0. «–» betyr "ingen grunnlag" (f.eks. snittalder uten åpne saker).
- Rapporten inneholder kun tall, tidsstempler og faste etiketter - aldri meldingstekst, oppfølgingstitler, mål eller årsaker.

| Gruppe | Metrikker (kilde) |
|---|---|
| V1 | genererte/leverte briefer, døgn med brief, daglig løper: fullført/tapt/nytt forsøk (`cost_events`, `tool_executions`, `scheduler_state`) |
| V2 | åpne/forfalte/opprettet/fullført/avbrutt oppfølginger, snittalder, åpne løkker, påminnelser (`business_followups`, `business_open_loops`, `audit_events`) |
| Jobber | opprettet/fullført/feilet, andel fullført, åpne nå, modellkost (`tasks`, `cost_events`) |
| Samtaler | meldinger fra deg, økter, døgn med bruk, chat-modellkall og andel som ba om verktøy (`messages`, `cost_events`) |
| Godkjenninger | bekreftelser forespurt/godkjent/avvist/utløpt, svartid, signerte D-godkjenninger (`action_confirmations`, `approvals`) |
| Kost | modellkost totalt og per fullført jobb (`cost_events`) |
| Drift | åpne hendelser, jobber som har ventet >15 min (`incidents`, `tasks`) |

Helse- og gjesterom leses aldri. Den daglige løperen (`scheduler_state`, én delt tabell uten tenant-RLS) vises kun for eierens tenant. Svar caches i 30 sekunder per tenant.

## Miljøvariabler (alle valgfrie, alle AV/trygge som standard)
| Variabel | Standard | Betydning |
|---|---|---|
| `JARVIS_V2_PUSH_ENABLED` | av | kun eksakt `true` slår på V2-varsling (krever også Telegram token + chat-id) |
| `JARVIS_V2_PUSH_MAX_PER_DAY` | 3 | høyst N meldinger per rullerende døgn (1-20); ugyldig verdi stopper oppstarten |
| `JARVIS_V2_PUSH_QUIET_START` / `_QUIET_END` | 22 / 7 | rolig tid, lokal time Europe/Oslo. Start = slutt betyr HELE døgnet rolig (fail-closed) |
| `JARVIS_V5_PROPOSALS_ENABLED` | av | kun eksakt `true` viser driftsforslag i rapporten. Forslag utfører aldri noe |
| `JARVIS_VALUE_VERIFIED_GATES` | tom | porter DU erklærer verifisert for V3-beredskapen (`D-32`, `WORKER_ISOLATION`; ukjente navn forkastes). Kode utleder dem aldri |

Variablene står i `infra/local/service-env.mjs` (kun api-tjenesten), den genererte `docker-compose.yml` og `.env.example`.

## V2 push - slik fungerer den (og slik slår du den på)
**Hva sendes:** én kort melding til din egen Telegram-chat (via den eksisterende `telegram.notify`: Policy Gateway, kill switch, frys, revisjon og idempotens gjelder) med opptil 5 forfalte eller snart forfalne saker fra
dine egne lister (`personal`/`business`/`project`). Oppfølgingstitler vises som sitert DATA (lenker, @-omtaler, /-kommandoer og markup fjernes, maks 60 tegn); systemdetekterte løkker vises med en fast etikett.
AI-foreslåtte løkker og helse-/gjesterom varsles aldri. Løkker forfalt >14 dager varsles ikke (de står i morgenbriefen).

**Garantier:** rolig tid; høyst N per døgn og minst 60 min mellom meldinger; samme sak varsles ikke to ganger for samme forfallsdato (flyttes fristen, er det en ny periode); reservasjon skrives FØR sending
(høyst én gang - ved usikkert utfall sendes meldingen ikke på nytt); to samtidige tikk/prosesser kan aldri begge sende (advisory-lås per tenant). Uten kilde eller ledger sendes ingenting.

**Aktivering (du):**
1. Sjekk at morgenbriefen kommer på Telegram i dag (V1) - V2 bruker samme kanal.
2. Les gjennom rolig tid og døgngrense over; sett om nødvendig `JARVIS_V2_PUSH_QUIET_START/_END` og `_MAX_PER_DAY` i `.env`.
3. Sett `JARVIS_V2_PUSH_ENABLED=true`, start `api` på nytt. Loggen viser `v2_push_started` (eller `v2_push_disabled` / `v2_push_enabled_but_no_channel`).
4. Første tikk kommer ca. ett minutt etter oppstart, deretter hvert kvarter. **Slå av igjen:** fjern flagget og start `api` på nytt (eller aktiver kill switch - `telegram.notify` nektes da).

**Revisjonsspor** (append-only `audit_events`, kun nøkler og tall - aldri tekst), som databaseadmin:
```sql
SELECT at, type, payload->>'message_key' AS melding, payload->>'count' AS antall, reason
FROM audit_events WHERE type LIKE 'followup.push_%' ORDER BY audit_id DESC LIMIT 20;
```
`push_reserved` -> `push_sent` (levert), `push_failed` (avvist/feilet - saken frigis og forsøkes igjen), `push_unknown` (usikkert utfall, f.eks. tidsavbrudd - saken regnes som varslet og sendes IKKE på nytt).
Logglinjen `v2_push_tick` viser kun utfallet (`sent`, `source_unavailable`, `ledger_unavailable`, `send_failed`, `send_unknown`) - rolige utfall (rolig tid, ingenting nytt, døgngrense, minsteavstand) logges ikke.

## V3 Builder Loop (sover) og V5 (forslag)
- **V3:** rapporten viser 6 tekniske krav (EV-0-konstitusjon verifisert, endringsregister intakt, ingen change freeze, GitHub-tilkobling frisk, D-32, worker-isolasjon) og ett krav som ingen kode kan oppfylle (`owner_decision:V3`).
  Ukjent er aldri "oppfylt". Selv med alle krav oppfylt står det «klar for eierens beslutning», aldri "aktiv". Ingen kodevei starter selvendring; en statisk test låser at modulene ikke kan utføre noe.
- **V5:** med `JARVIS_V5_PROPOSALS_ENABLED=true` viser rapporten FORSLAG (maks 8) som «kjør connector-test på nytt» (klasse A), «kjør backup» / «rydd gamle artefakter» (klasse C) og «start tjeneste på nytt» (klasse D, trinn-opp/signert).
  Hvert forslag har `executes: false`; omstart/backup/opprydding beskrives som verter-runbook (API-et kan ikke restarte seg selv). Ingenting leveres via bekreftelsesveien ennå.

## Verifisering (NOT VERIFIED i byggeøkten - kjør på NAS-en)
```
cd /volume1/jarvisbuild-data/jarvisbuild && git pull
# 1. Rapporten leses (uten V2/V5 på): i dashbordet «Verdi og bruk», eller i chat: «hva har du hjulpet meg med»
# 2. Tallene stemmer med virkeligheten: sammenlign «Daily Brief levert» med antall briefer du har fått på Telegram siste 7 døgn
# 3. api-loggen viser v2_push_disabled når flagget ikke er satt:   docker compose -f infra/local/docker-compose.yml logs api | grep v2_push
```
Testkommandoene (kjøres som ikke-root fordi embedded Postgres ikke starter som root):
```
npx vitest run modules/executive apps/api/test/wpc4-value-source-db.test.ts apps/api/test/wpc4-follow-up-push-db.test.ts apps/api/test/wpc4-value-wiring.test.ts apps/api/test/wpc4-value-query-e2e.test.ts modules/core/test/fast-router.test.ts
```

## Kjente begrensninger
- Vinduene dekkes av dagens oppbevaring (D-395): `tool_executions` beholdes 180 døgn, `scheduler_state` 90 døgn og `approvals` 30 døgn etter utløp - alle lengre enn 30-døgnsvinduet. Skulle oppbevaringen senkes til under 30 døgn, vil 30-døgnstallene for levering, daglig løper og signerte godkjenninger undertelle uten at rapporten selv ser det.
- «Daily Brief levert» teller første del av planlagte morgenlevering (nøkkel `brief-…-0`); en brief hentet i chat teller ikke. Daglig løper er global (én løper), derfor kun synlig for eierens tenant.
- «Andel chat-kall som ba om verktøy» er på modellkall-nivå, ikke tur-nivå.
- Modellkost dekker ikke stemme (STT/TTS) eller connector-/API-kostnader (se run-rate-rapporten).
- V2 ledger bruker `audit_events` (ingen ny tabell/migrasjon); et usikkert sendeutfall regnes som sendt (høyst én gang) - du kan derfor i sjeldne tilfeller miste en påminnelse, men aldri få den to ganger.
