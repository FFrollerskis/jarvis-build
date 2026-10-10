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
| `JARVIS_V2_PUSH_TITLES` | `true` | tom/usatt/`true` = oppfølgingstitler vises (vasket, se under). ALT annet (`false`, `FALSE`, `0`, skrivefeil) = meldingen har KUN antall og «åpne dashbordet» - den sikreste varianten |
| `JARVIS_V5_PROPOSALS_ENABLED` | av | kun eksakt `true` viser driftsforslag i rapporten. Forslag utfører aldri noe |
| `JARVIS_VALUE_VERIFIED_GATES` | tom | porter DU erklærer verifisert for V3-beredskapen (`D-32`, `WORKER_ISOLATION`; ukjente navn forkastes). Kode utleder dem aldri |

Variablene står i `infra/local/service-env.mjs` (kun api-tjenesten), den genererte `docker-compose.yml` og `.env.example`.

## V2 push - slik fungerer den (og slik slår du den på)
**Hva sendes:** én kort melding til din egen Telegram-chat (via den eksisterende `telegram.notify`: Policy Gateway, kill switch, frys, revisjon og idempotens gjelder) med opptil 5 forfalte eller snart forfalne saker fra
dine egne lister (`personal`/`business`/`project`). Oppfølgingstitler er DATA, ikke instruks, og vaskes etter hvitelisteprinsippet (de kan komme fra modellopprettede oppfølginger): alt som kan bli klikkbart - lenker, domener med
hvilket som helst toppdomene (`evil.pro`, `evil.xn--p1ai`), e-postadresser, telefon-/kortnumre og IBAN - blir `[lenke]`, og kun bokstaver, sifre, mellomrom og `.,:;!?()-–'’%` beholdes (maks 60 tegn); `/ \ @ # * _ [ ] < >`,
backticks, emoji og retningstegn fjernes uansett posisjon. Systemdetekterte løkker vises med en fast etikett. AI-foreslåtte løkker og helse-/gjesterom varsles aldri. Løkker forfalt >14 dager varsles ikke (de står i morgenbriefen).
**Enda sikrere:** `JARVIS_V2_PUSH_TITLES=false` gir en melding med kun antall («3 saker trenger deg (2 forfalt, 1 snart forfall)») og «åpne dashbordet» - ingen fritekst fra noen kilde når meldingen.

**Garantier:**
- Rolig tid; høyst N meldinger per rullerende døgn og minst 60 min mellom FORSØK (også et forsøk som ble avvist og frigitt teller); samme sak varsles ikke to ganger for samme forfallsdato (flyttes fristen, er det en ny periode);
  to samtidige tikk/prosesser kan aldri begge sende (advisory-lås per tenant). Uten kilde eller ledger sendes ingenting.
- **Høyst én gang (ikke «minst én»).** Reservasjonen skrives FØR sending og frigis KUN når utfallet er BEVIST «ikke sendt» (tabellen under). Alt annet - tidsavbrudd, 5xx (også «502» der Telegram faktisk leverte), nettverksbrudd, ugyldig svar,
  ukjent feil - regnes som SENDT og forsøkes aldri på nytt. **Restrisiko:** i sjeldne tilfeller (Telegram mottok aldri meldingen, men svarte med 5xx eller tidsavbrudd) går en påminnelse TAPT - den står som `push_unknown` i revisjonssporet.
  Den kan ikke komme to ganger så lenge revisjonssporet (`audit_events`) er intakt - det er ledgeren som husker at saken er varslet.
- **Forsøkstak og backoff.** En melding som bevisst ikke ble sendt forsøkes på nytt etter 15 min, så 1 t, så 4 t (antall feil på meldingen avgjør trinnet; minsteavstanden på 60 min mellom forsøk gjelder i tillegg), og høyst 3 forsøk per melding
  per rullerende døgn. Deretter er løperen stille for den meldingen (`attempts_exhausted`) til det eldste forsøket er 24 timer gammelt.
- **Stopp før noe forsøkes.** Kill switch, frosset connector `telegram`, tilbakekalt `JARVIS_TELEGRAM_TOKEN` og infra-pause sjekkes FØR noe reserveres. Mens systemet er stanset skjer ingenting (ingen audit-rader, ingen Telegram-kall); loggen
  sier `send_blocked` én gang (ikke hvert kvarter), og meldingen sendes straks etter at bryteren er av.

**Hvilke utfall frigir reservasjonen?** (positiv tillatelsesliste i `classifyNotifyFailure`; strengene er hentet fra `ToolGateway`/`PolicyGateway`/`TelegramTransport` og låst av `apps/api/test/wpc4-follow-up-push-gateway.test.ts`)

| Utfall fra gatewayen | Frigis? | Hvorfor |
|---|---|---|
| `kill_switch_active`, `connector_frozen`, `credential_revoked`, `credential_unavailable`, `credential_not_bound_to_identity`, `class_b_requires_active_auth`, `invalid_identity_context`, `invalid_tool_call`, `unknown_tool`, `invalid_parameters`, `rate_limited`, `infra_paused`, `infra_degraded_blocks_class_d`, `infra_mode_unavailable`, `scope_mismatch:*` | **ja** | avslag FØR leverandørkallet - ingenting gikk ut |
| `tool_failed:telegram_chat_id_not_configured`, `tool_failed:unsafe_vendor_url:*` | **ja** | transporten avviste før noen forespørsel ble sendt |
| `tool_failed:telegram_error_400/401/403/404/429` | **ja** | Telegram avviste selve kallet; ingen melding opprettet |
| `tool_failed:tool_timeout` | nei | gatewayens 10 s-frist: Telegram kan levere etterpå |
| `tool_failed:telegram_error_5xx` (500, 502, 503, 504 ...) | nei | Telegram/mellomledd kan ha lagret meldingen og svart feil |
| `tool_failed:telegram_error_<annen 4xx>` (408, 409, 499 ...) | nei | kan komme fra mellomledd - ikke bevis |
| `tool_failed:fetch failed`, `tool_failed:The operation was aborted due to timeout`, ugyldig svarkropp | nei | nettverksbrudd/frist kan skje etter sending |
| `postcondition_unverified:*`, `postcondition_mismatch`, `execution_in_flight_or_outcome_unknown` | nei | gatewayen selv sier at utfallet er ukjent |
| kastet unntak, tom/ukjent tekst, alt som ikke står i listen over | nei | standarden er «ukjent» |

**Aktivering (du):**
1. Sjekk at morgenbriefen kommer på Telegram i dag (V1) - V2 bruker samme kanal.
2. Les gjennom rolig tid og døgngrense over; sett om nødvendig `JARVIS_V2_PUSH_QUIET_START/_END` og `_MAX_PER_DAY` i `.env`.
3. Sett `JARVIS_V2_PUSH_ENABLED=true`, start `api` på nytt. Loggen viser `v2_push_started` (eller `v2_push_disabled` / `v2_push_enabled_but_no_channel`).
4. Første tikk kommer ca. ett minutt etter oppstart, deretter hvert kvarter.

**Slik stanser du V2-pushen** (det finnes ingen egen «pause»-bryter; dette er veiene, fra mykest til hardest):
1. **Slå den av alene:** fjern `JARVIS_V2_PUSH_ENABLED` (eller sett noe annet enn `true`) i `.env` og kjør `docker compose --env-file .env -f infra/local/docker-compose.yml up -d api`. Loggen viser `v2_push_disabled`. Morgenbrief og andre varsler er uberørt.
2. **Frys connector `telegram`:** dashbordet -> Kontroll -> «Frys connector» (connector_id `telegram`, begrunnelse påkrevd). Stanser ALL utsendelse på Telegram, også morgenbriefen. Opphev med «Opphev» på samme sted.
   (Det samme gjelder «Tilbakekall credential» for `JARVIS_TELEGRAM_TOKEN`.)
3. **Kill switch:** dashbordet -> Kontroll -> «Aktiver kill switch» (klasse D) stanser ALT. Opphev med «Opphev kill switch».
Fra og med rettelsene etter gjennomgangen sjekker V2-løperen punkt 2 og 3 FØR noe reserveres: ingen forsøk, ingen audit-rader og ingen Telegram-kall mens bryteren er på (loggen sier `send_blocked` én gang). Når bryteren er av igjen,
sendes en fortsatt forfalt sak ved neste tikk (innenfor døgngrensen) - ikke etter en lang kø av mislykkede forsøk.

**Revisjonsspor** (append-only `audit_events`, kun nøkler og tall - aldri tekst), som databaseadmin:
```sql
SELECT at, type, payload->>'message_key' AS melding, payload->>'count' AS antall, reason
FROM audit_events WHERE type LIKE 'followup.push_%' ORDER BY audit_id DESC LIMIT 20;
```
`push_reserved` -> `push_sent` (levert), `push_failed` (BEVIST ikke sendt, tabellen over - saken frigis og forsøkes igjen etter backoff, høyst 3 per melding per døgn), `push_unknown` (usikkert utfall: tidsavbrudd, 5xx, nettverksbrudd,
ukjent feil - saken regnes som varslet og sendes IKKE på nytt). Hvert forsøk er en `push_reserved`-rad, også de som senere frigis; de teller mot minsteavstanden og forsøkstaket.
Logglinjen `v2_push_tick` viser kun utfallet (`sent`, `source_unavailable`, `ledger_unavailable`, `send_failed`, `send_unknown`). `send_blocked` (kill switch/frys/tilbakekalt credential) og `attempts_exhausted` (tre forsøk brukt, stille til
døgnet er rundt) logges bare når tilstanden oppstår eller endres, med `blocked_by` eller meldingens hash - aldri tittel eller innhold; `v2_push_state_cleared` når den er over. Rolige utfall (rolig tid, ingenting nytt, døgngrense,
minsteavstand, ventetid etter en feil) logges ikke.

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
npx vitest run modules/executive apps/api/test/wpc4-value-source-db.test.ts apps/api/test/wpc4-follow-up-push-db.test.ts apps/api/test/wpc4-follow-up-push-gateway.test.ts apps/api/test/wpc4-value-wiring.test.ts apps/api/test/wpc4-value-query-e2e.test.ts modules/core/test/fast-router.test.ts
```
`wpc4-follow-up-push-gateway.test.ts` kjører pushen mot den EKTE `ToolGateway`/`PolicyGateway`/`TelegramTransport` (kun Telegram-HTTP er en mock) og viser at 502-med-levering, nettverksbrudd etter sending og gateway-timeout ikke gir mer enn én levert melding.
**Ikke verifisert mot ekte Telegram.** På NAS-en, etter at du har slått på V2: frys connector `telegram` en stund og se `docker compose ... logs api | grep v2_push` (forventet: ÉN `send_blocked`, ingen `followup.push_*`-rader i `audit_events`); opphev frysen og se én melding.

## Kjente begrensninger
- Vinduene dekkes av dagens oppbevaring (D-395): `tool_executions` beholdes 180 døgn, `scheduler_state` 90 døgn og `approvals` 30 døgn etter utløp - alle lengre enn 30-døgnsvinduet. Skulle oppbevaringen senkes til under 30 døgn, vil 30-døgnstallene for levering, daglig løper og signerte godkjenninger undertelle uten at rapporten selv ser det.
- «Daily Brief levert» teller første del av planlagte morgenlevering (nøkkel `brief-…-0`); en brief hentet i chat teller ikke. Daglig løper er global (én løper), derfor kun synlig for eierens tenant.
- «Andel chat-kall som ba om verktøy» er på modellkall-nivå, ikke tur-nivå.
- Modellkost dekker ikke stemme (STT/TTS) eller connector-/API-kostnader (se run-rate-rapporten).
- V2 ledger bruker `audit_events` (ingen ny tabell/migrasjon). Reglen er **høyst én gang**: et usikkert sendeutfall (tidsavbrudd, 5xx, nettverksbrudd) regnes som sendt, så du kan i sjeldne tilfeller MISTE en påminnelse (den står som `push_unknown`), men aldri få den to ganger.
- Titler: datoer med skilletegn (`15.10.2026`), beløp over 7 sifre (`1 250 000`), filnavn (`rapport.pdf`) og forkortelser som `f.eks.` kan bli `[lenke]` i meldingen - trygg side. Forfallet står uansett i meldingen («forfalt 2 d»), og `JARVIS_V2_PUSH_TITLES=false` fjerner titlene helt.
- Tilgang: `executive.get_value_report` og `POST /value/query` gir tall (ikke innhold) til enhver identitet med et gyldig grant, på linje med `get_slo_report` og `get_cost_overview`. Gjest-/delegert-grants kan altså lese tellingene; det finnes ikke et etablert eier-krav
  for lesing av `executive.*`, og det er ikke innført bare for denne rapporten.
