# WP-G4 (D-466): UA-10 Proactive Situation Engine - samlet hendelsesabonnement, helse-/hjem-/kamera-broer, modellassistert vurdering, simulering og tilbakemelding (runbook)

**Status: `DORMANT` (alt er AV som standard bak `JARVIS_SITUATION_*`) og `NOT VERIFIED` (ingenting er kjørt mot ekte Home Assistant, kamera, helsedata, lokal modell eller en NAS; alt er bevist mot lokale fakes, transport-spioner og en ekte embedded Postgres med NOSUPERUSER/NOBYPASSRLS-rolle og FORCE RLS).**

Ordforråd (kun disse brukes): `WIRED` (koblet i komposisjonsroten, men AV bak flagg), `DORMANT`, `BUILT_UNWIRED`, `PARTIAL`, `DEFERRED`, `BLOCKED_EXTERNAL`, `NOT_BUILT`. Ingenting her er `VERIFIED`.

## 0. Statusoversikt per prioritet

| Prio | Hva | Status | Merknad |
|---|---|---|---|
| P1a | Samlet hendelsesabonnement: eierens abonnementsregister (`situation_subscriptions`), inntaksbuss, hendelsesløper (tikk), signallogg, dedupe/undertrykking/stille timer gjenbrukt fra motoren, pause per domene og for hele motoren | `WIRED` + `DORMANT` (`JARVIS_SITUATION_SIGNALS=on`) | Polling (standard 60 s). HA-push (WebSocket/webhook) er `DEFERRED` (§12). Ingen abonnement = signalet forkastes (fail-closed). |
| P1b | Rene broer: hjem (dør/port åpen for lenge, lekkasje, alarm, uvanlig strøm), kamera (bevegelse, person, dørklokke, sikkerhetsvarsel, åpning, pakke), helse (hvilepuls, søvn, aktivitet mot egen baseline), hendelser (incidents i «sanntid») | `WIRED` + `DORMANT` (`_HOME`, `_VISION`, `_HEALTH`, `_INCIDENTS`) | Lukkede hendelsessett. Helse og kamera: aldri ACT, innholdsfri varseltekst. Home ACT kun via G2 D-kjeden + eierbundet autonomi (§5). |
| P1c | Modellassistert vurdering via `ModelGateway` (kategori, prioritetsforslag, forklaring) | `WIRED` + `DORMANT` (`_MODEL_ASSIST`) | Aldri ACT alene (eneste virkning: `low` -> `normal`, dvs. `remember` -> `inform`). Begrensede data kun lokal modell, fail-closed uten sky-fallback. Lokal modell er ikke verifisert på NAS (`BLOCKED_EXTERNAL`). |
| P2d | Kontrafaktisk simulering (ren, ingen sideeffekt) | `WIRED` (alltid under hovedbryteren, ren lesing) | `situations.get_situation_simulation`. |
| P2d | Tilbakemeldingslæring («nyttig»/«støy» justerer terskel innenfor harde grenser) | `WIRED` + `DORMANT` (`_FEEDBACK`) | Ett tall per regel, revidert, tilbakestillbart, ingen selvmodifikasjon (D-397). |
| P2e | Anomali-revisjon (spend/pipeline/infra/frister) + manglende rene detektorer | revisjon: ferdig; detektorer: `BUILT_UNWIRED` | Kostnadssprang og stilnet jobb er bygget og testet, men ingen leser mater dem (`DEFERRED`, §10). Bevis for at autonom klasse D-handling gir umiddelbart varsel + gjenopprettingskontekst: testet. |
| - | Eier-flate (rute/CLI/kontrollsenter-side) for abonnementer | `NOT_BUILT` (`DEFERRED`) | Samme mønster som eksisterende `situations`-handlinger (verktøy via ToolGateway; UA-11 komponerer dem). Se §12 og eierspørsmål Q-G4-4. |
| - | Gate «ACT/ACT+NOTIFY observert på NAS» | `BLOCKED_EXTERNAL` | Krever NAS, ekte Home Assistant og eierens signerte økt (§11). |

## 1. Flagg og konfigurasjon

Se `modules/situations/src/flags.ts`. Alle er AV som standard; kun den eksakte verdien `on` slår på (ingen `true`/`1`/`yes`). Hovedbryter `JARVIS_SITUATION_SIGNALS`; underflaggene gjelder kun under hovedbryteren (hovedbryter av = alt av, uansett underflagg).

| Flagg | Standard | Slår på |
|---|---|---|
| `JARVIS_SITUATION_SIGNALS` | AV | Abonnementsregister, inntaksbuss, løper, signallogg, kontroll-/lesehandlinger på `situations`, `expires_at` på `set_autonomy_policy`, kritisk-bypass av stille timer (valg), simulering |
| `JARVIS_SITUATION_HOME` | AV | Hjem-kilden: leser HA-tilstander via den EKSISTERENDE HA-connectoren (ny lese-handling `home-assistant.read_state_detail`, klasse A) |
| `JARVIS_SITUATION_VISION` | AV | Kamera-kilden: leser `vision_event_observations` via `VisionService` (WP-G3). Begrensede data |
| `JARVIS_SITUATION_HEALTH` | AV | Helse-kilden: avvik mot eierens egen baseline via `HealthService` (WP-G2-inntaket). Begrensede data |
| `JARVIS_SITUATION_INCIDENTS` | AV | Incidents (UA-5) via bussen i «sanntid» (samme nøkkel som det daglige sveipet) |
| `JARVIS_SITUATION_MODEL_ASSIST` | AV | Modellassistert vurdering |
| `JARVIS_SITUATION_FEEDBACK` | AV | `record_feedback`, `get_rule_tuning`, `reset_rule_tuning` og at tunede terskler brukes |
| `JARVIS_SITUATION_BUS_INTERVAL_SECONDS` | 60 (15-3600) | Tikkintervall. Ugyldig verdi gir standard |
| `JARVIS_SITUATION_LOG_RETENTION_DAYS` | 30 (7-365) | Oppbevaring av signalloggen. Ugyldig verdi gir standard |

Navnene står i `SERVICE_ENV.api` (`infra/local/service-env.mjs`), i den regenererte compose-blokken (`infra/local/docker-compose.yml`, kun disse 9 linjene er nye) og i `.env.example` (kun `NAME=`, aldri verdier). Vakten `modules/situations/test/wpg4-flags-wiring.test.ts` låser at ingen er satt som standard og at ingen når worker/voice/browser.

**Flagg AV = identisk med main** (målt, ikke antatt): verktøylisten (`situationsToolDefinitions` er byte-lik; `expires_at` finnes ikke i skjemaet uten hovedbryteren), `filterTools`/intents/rate-grenser/ruter og det daglige `situation-sweep` er uendret; `createSituationSignalsWiring` returnerer tom `tools`, `runner = null`, `registry = null` og logger ingenting. wph1/wph2-baselinene og restricted-tools-invarianten er grønne uten regenerering.

## 2. Flyt (én vei inn i motoren)

`observasjon` (minimert, bak kildeport) -> `lukket hendelsestype` -> `abonnementssjekk` (ingen abonnement = forkastet) -> `ren bro` (terskler fra `RULES`, tunet innenfor harde grenser) -> `pausesjekk` (prosess-cache OG varig `situation_domain_pauses`, domene eller `*`) -> `valgfri modellvurdering` -> `SituationEngine.evaluateCandidate()` (EKSISTERENDE dedupe/undertrykking/stille timer) -> `idempotent signallogg` (UNIK per kilde + `source_ref`). Deretter kjører løperen motorens EKSISTERENDE `deliverPendingInformNotifications()` og `autoActPending()` for samme (tenant, space). Bussen har selv ingen eksterne effekter.

* **Samme fysiske hendelse via to kilder = én situasjon og ett varsel:** HA-broen og kamerabroen (`opening_detected`) bruker samme nøkkel `home:opening:<entitet>@<ISO ms>`; incidents deler `infra_incident:<id>` med det daglige sveipet.
* **Feilisolasjon:** én kilde, ett (tenant, space) eller én observasjon som feiler velter aldri resten (tall og korte koder, aldri innhold). Aldri to tikk samtidig. `guard` (kill switch) sjekkes før første lesing og per (tenant, space); en kastet feil tolkes som «stanset».
* **Kadens:** hjem/kamera/hendelser hvert tikk, helse hvert 15. tikk (baselines endrer seg langsomt). Maks 5 modellkall per tikk.

## 3. Kilde-/bro-tabell (lukkede sett)

| Kilde | Regel (`kilde:type`) | Domene | Utløser (deterministisk) | Tunbar terskel (standard [min..maks], steg) | Høyeste stadium | ACT |
|---|---|---|---|---|---|---|
| `home_assistant` | `door_open_too_long` | home | Dør/vindu/port/garasjeport/åpning (rolle fra eierens filter) i `on`/`open`/`opening` lenger enn terskelen. `high` ved >= 4x terskelen; konfidens 0,9 KUN for lukkbar port/garasjeport ved >= 4x | `open_minutes` 15 [5..120], 5 | `suggest` (kun lukkbar port lenge åpen), ellers `inform` | Kun eierbundet autonomi + G2 D-kjede; sveipe-identiteten nektes av step-up (§5) |
| `home_assistant` | `water_leak` | home | Fuktsensor `on`. `high`, konfidens 0,95, `urgent` | ikke tunbar | `suggest` | som over |
| `home_assistant` | `alarm_triggered` | home | Alarmpanel `triggered`. `high`, konfidens 0,95, `urgent` | ikke tunbar | `suggest` | som over |
| `home_assistant` | `power_over_limit` | home | Effekt over eierens EGEN grense (`limit_w`, ingen standard) N tikk på rad (teller i minnet) | `sustained_ticks` 3 [2..20], 1 | `inform` | nei (ingen konfidens) |
| `vision` | `motion_detected` | vision | Hendelse fra `vision_event_observations`, sammenslått per kilde i `cooldown_minutes`. `low` på dagtid (`remember`), `normal` i eierens nattvindu (`night_hours_utc`, UTC) | `cooldown_minutes` 10 [5..120], 5 | `inform` | aldri (`NEVER_ACT_DOMAINS`) |
| `vision` | `person_present` | vision | som over; teksten er innholdsfri («Kamerahendelse registrert - åpne Jarvis for detaljer»). Ingen identifikasjon | 10 [5..120], 5 | `inform` | aldri |
| `vision` | `doorbell_event` | vision | Sensorutløst; fast tekst | `cooldown_minutes` 2 [1..30], 1 | `inform` | aldri |
| `vision` | `security_alert` | vision | Sensorutløst; `high` men aldri konfidens; `urgent` | ikke tunbar | `inform` | aldri |
| `vision` | `opening_detected` | home | Åpning sett av kamerakilden; `low`; samme nøkkel som HA-broen | ikke tunbar | `remember` (løftes av HA-broen) | nei |
| `vision` | `package_detected` | vision | `object_detected` hvis etiketten (ÅPENT ordforråd, ubetrodd) tilhører det lukkede settet «pakke»-ord; etiketten lagres/gis aldri videre | `cooldown_minutes` 60 [15..720], 15 | `inform` | aldri |
| `health` | `resting_heart_rate_deviation`, `sleep_duration_deviation`, `activity_deviation` | health | De 3 siste fullførte UTC-døgn ligger alle \|z\| >= terskel på SAMME side av eierens egen baseline (median/MAD, inntil 28 døgn, minst 14). Ingen verdi, baseline eller z i tekst/logg; kun lukket kategori + «ikke medisinsk rådgivning» | `z_score` 2 [1,5..4], 0,25 | `inform` | aldri |
| `incident` | `incident_active` | infra | Aktiv incident (alt unntatt `resolved`/`wont_fix`); alvorlighet -> prioritet; ingen konfidens | ikke tunbar | `inform` | nei |

Abonnementsfiltre er lukkede (`strict`): HA krever eksakt entitets-id (ingen jokertegn) og eierens egen ROLLE per entitet (`door`, `window`, `garage_door`, `gate`, `opening`, `leak`, `alarm`, `power`; `limit_w` kun og alltid for `power`); kamera kan begrenses til kilde-id-er og nattvindu; helse kun eierens egen person. Kilde -> tillatte rom: HA `home`, kamera `home`/`personal`, helse `health`, hendelser `business`.

## 4. Tabeller (migrasjon 139, kun denne er brukt av G4)

`situation_subscriptions`, `situation_signal_log`, `situation_feedback`, `situation_rule_tuning`, `situation_assessments` (alle: FORCE RLS med tenant- og space-policy, sammensatte FK-er med `tenant_id`, `task_id`/`session_id`/kilde/person på radene, minimale GRANT). I tillegg to `ALTER` på eksisterende tabeller: `situation_notification_policies.critical_bypass_quiet boolean NOT NULL DEFAULT false` og `situation_autonomy_policies.expires_at timestamptz`.

* `situation_signal_log.facts` er begrenset til 2048 byte og går gjennom `assertMinimalFacts` (kun lukkede nøkler og enkle verdier; aldri fritekst, etiketter, bilder eller rå helseverdier). Opprydding daglig etter `JARVIS_SITUATION_LOG_RETENTION_DAYS`.
* `situation_feedback` er append-only bortsett fra kolonnen `consumed_at` (kolonne-GRANT; `verdict` kan aldri endres).
* Sletting/innsyn: alle fem er registrert i `modules/erasure/src/plan.ts` (før `situations`) og i `docs/security/PROCESSING_INVENTORY.md` (D-420-vakten).

## 5. Autoritet og ACT (håndhevet i kode, ikke prompt)

1. **ACT krever alltid eierens eksplisitte, tilbakekallbare binding** (`situation_autonomy_policies`, kun sovereign eier). Bindingen kan ha `expires_at` (fremtid, høyst 365 dager; kun med hovedbryteren). `autoActPending()` slår opp bindingen på nytt rett før HVERT kall (hoppet over hvis tilbakekalt, deaktivert, utløpt eller endret midt i løpet).
2. **Forbudte domener:** `health` og `vision` kan aldri få ACT: binding avvises (`SituationActDomainForbiddenError`), `actOn()` nekter, og `autoActPending()` utelukker dem i SQL (også en rad satt direkte i databasen).
3. **Modellen kan aldri heve til ACT** (§7). Konfidens (som er det eneste som gir `suggest`) settes kun av deterministiske regler (lekkasje, alarm, lukkbar port lenge åpen).
4. **G2 D-kjeden gjelder uendret** for hjemhandlinger: mål-allowlist, step-up (`step_up_required`, enhetssignert økt fra en eier-kanal), preflight/readback, journal og umiddelbart varsel med gjenopprettingstekst (`ClassDNotifier`). Den autonome sveipe-identiteten har ikke en signert enhetsøkt, så `home-assistant.critical_*` NEKTES (`step_up_required:signed_device_session`) FØR noe kall til Home Assistant, og situasjonen blir `escalate` med ærlig årsak. Dette er målt mot de ekte G2-definisjonene (`modules/situations/test/wpg4-act-dchain.test.ts`) og er en fail-closed-egenskap, ikke en feil: en reell autonom port-lukking krever en eierbeslutning (Q-G2-1 / Q-G4-1).
5. **Stille timer:** sikkerhetssignaler (lekkasje, alarm; `urgent`) bryter stille timer KUN hvis eieren har valgt det (`set_critical_quiet_bypass`, standard nei, klasse C, reversibelt).
6. **Pause:** `pause_domain` og `pause_all` (`*`) gjelder bussen (før noe skrives), leveringen og auto-ACT. En pauset kilde regnes ikke som «sett»: signalet gjenoppdages etter at pausen er opphevet.

## 6. Begrensede data (helse, kamera = `SECRET_RESTRICTED`, kjent hull N1)

* Kun avledede, minimerte signaler forlater kildeporten. `reason`/Telegram-tekst er innholdsfri: helse bærer bare den lukkede kategorien (hvilepuls/søvn/aktivitet) + «ikke medisinsk rådgivning»; bildeavledede hendelser bærer en fast tekst. Ingen ansiktsidentifikasjon finnes (lukket hendelsessett, faste kategorier; G3-skanningen mot biometri-ord er grønn).
* Rå helseverdier aggregeres til ett tall per UTC-døgn INNE i `apps/api/src/situation-signals-wiring.ts` og forlater aldri prosessen. Den filen er en godkjent helse-importør (G2-vakten); `modules/situations` importerer aldri `@jarvis/health`.
* Klassifisering av begrensede signaler skjer KUN lokalt (§7). Telegram er en skykanal: derfor holdes teksten innholdsfri (N1).

## 7. Modellassistert vurdering (P1c)

* Inngangen er et lukket JSON-objekt (`regel`, `domene`, `prioritet`, `fakta`): ingen fritekst, ingen rå verdier, ingen etiketter. Systemprompten er fast og sier at alt er DATA.
* Svaret er UBETRODD: strengt skjema (lukkede sett for kategori `routine|attention|risk|noise|unknown` og prioritet `low|normal|high`), forklaring renset og kuttet (200 tegn), alt ukjent/ugyldig gir laveste nivå og lagres som `rejected`.
* **Eneste virkning:** `low` -> `normal` (`remember` -> `inform`) for kategori `attention`/`risk`. Aldri `high`, aldri nedgradering, aldri konfidens, aldri stadium, aldri ACT. Målt uttømmende (alle kombinasjoner) og med modellsvar som forsøker å heve til ACT (`wpg4-signal-bus.test.ts`).
* Kall: bakgrunnsjobb (`task_id` uten `session_id`), digest-cache per (situasjon, input) i `situation_assessments`, tak per tikk.
* **Begrensede data (helse, kamera):** `sensitivity: SECRET_RESTRICTED`, `mode: LOCAL`, `paid_models_allowed: false` og leverandørverifisering mot lokale navn (`local_llm`, `gemma_local`, `ollama`). Er den lokale modellen nede eller finnes ingen: INGEN vurdering og INGEN sky-fallback (målt med sky-spioner: null sky-kall). Ikke-begrensede domener (kun `incident`) sender verken skjema eller kapabilitetskrav.

## 8. Tilbakemeldingslæring og simulering (P2d)

* **Læring:** «nyttig»/«støy» (`situations.record_feedback`, klasse B, kun sovereign eier) kobles til regelen via signalloggen (`<domene>:untracked` for situasjoner uten loggført signal: registreres, tuner ingenting). Tre enige, ubrukte stemmer siste 30 døgn gir ETT steg; høyst ett steg per døgn per regel; «støy» slakker (aldri forbi maks), «nyttig» strammer tilbake mot standarden (aldri under). Sikkerhetsregler (lekkasje, alarm, sikkerhetsvarsel, hendelser) er ikke tunbare. Stemmer som utløste et steg, eller ble nullstilt av en tilbakestilling, er «brukt» og teller aldri igjen. Hver endring revideres i `audit_events` (`situation.rule_tuned`, kun regel/fra/til) i SAMME transaksjon; `reset_rule_tuning` (klasse C) revideres som `situation.rule_tuning_reset`. `resolveRuleThreshold` klemmer ALLTID mot kodens [min, maks] (korrupt rad kan ikke flytte en terskel utenfor), og `RULES` er dypt fryst: ingen regel, kode, prompt eller modellvekt endres (D-397).
* **Simulering:** `situations.get_situation_simulation` (klasse A) er en ren funksjon over registrerte rader: tid spart anslås KUN fra observerte, løste varigheter for lignende situasjoner (minst tre, ellers `null`), med eksplisitte antakelser og forbehold, hindringer (`no_binding`, `step_up_required` for klasse D, `stage_not_suggest`, `domain_never_act`) og en anbefaling (`keep_inform_only`, `consider_binding`, `already_bound`, `insufficient_data`). Ingen sideeffekt (målt: rad-tellinger og transport-spioner uendret).

## 9. Verktøy og ruter

Nye handlinger på det EKSISTERENDE, eier-eksklusive `situations`-verktøyet (ingen modellflate, `surfaces: []`; tenant/space/aktør kun fra den betrodde identiteten, `strict()`-skjemaer uten identitetsfelt): `list_subscriptions`, `list_signals`, `get_signal_status`, `list_assessments` (output `untrusted`), `get_situation_simulation` (A); `subscribe`, `set_subscription_enabled`, `remove_subscription`, `set_critical_quiet_bypass` (C); kun med `_FEEDBACK`: `record_feedback` (B), `get_rule_tuning` (A), `reset_rule_tuning` (C). Én ny lese-handling på HA-connectoren (kun med `_HOME`): `home-assistant.read_state_detail` (A, `states:read`, output `untrusted`, returnerer kun `state`/`last_changed`/`device_class`). Handlingsnavnene er valgt slik at manifest-utledningen ikke leser dem som `pay`/`control`. **Ingen nye HTTP-ruter, ingen nye intents, ingen nye rate-grenser utover verktøyenes egne.**

## 10. P2e: revisjon av anomali-dekningen

| Domene | Finnes allerede | Status |
|---|---|---|
| spend | 12 open-loop-typer (`marketing_spend_anomaly`, `payment_intent_anomaly`, `payment_intent_reconciliation_mismatch`, `finance_spend_unexpected`, `finance_spend_amount_deviation`, `finance_recurring_charge_missing`, `finance_recurring_charge_duplicate`, `finance_spend_correction_conflict`, `bank_transaction_unmatched`, `bank_consent_attention`, `card_anomaly_attention`, `finance_procurement_missing`) via `open-loop-bridge.ts` + daglig sveip | dekket, ikke gjenbygget |
| spend (Jarvis' egen AI-kostnad) | hardgrense (budsjettvakt), SLO-drift (`cost_per_call`), kostnadstrend/prognose (EV-16) i kontrollsentrene; ingen SITUASJON som varsler før grensen | hull -> `detectSpendSpike` (`BUILT_UNWIRED`) |
| pipeline | `overdue_followup`, `stalled_opportunity` | dekket |
| frister | `contract_renewal_due`, `contract_termination_deadline`, `contract_obligation_due`, `contract_review_required`; `operations_task_overdue` | dekket |
| infra | incidents (D-195-broen i det daglige sveipet + nå «sanntid» via bussen med samme nøkkel) | dekket |
| infra (planlagte jobber) | `scheduler_state` vises i kontrollsenteret/EV-19, men ingenting varsler når en jobb stilner | hull -> `detectStaleJobs` (`BUILT_UNWIRED`) |

**Nye rene detektorer** (`modules/situations/src/anomaly-detectors.ts`; ingen I/O, klokke injisert, ingen modell, harde grenser på alle terskler, kun INFORM-kandidater uten konfidens og uten beløp i teksten): `detectSpendSpike` (siste fullførte døgn mot egen baseline, kun oppover; krever robust z OG forholdstall OG absolutt økning; vanlig dag 0 gir ingen påstand) og `detectStaleJobs` (forventet kadens oppgis av eier/katalog, gjettes aldri; kandidat i domenet `operations`, ikke `infra`, fordi det daglige sveipet løser alle åpne `infra`-situasjoner som ikke er aktive incidents, `resolveStaleForDomain`).

**`BUILT_UNWIRED`:** ingen leser mater dem. Å koble dem til krever (a) en leser mot `cost_events`/`scheduler_state`, (b) en eierbeslutning om tenants, jobber og forventede kadenser, og (c) utvidelse av regelregisteret/abonnementsfilteret (`DEFERRED`). De kjører aldri i drift i dag.

**D-klasse-handlinger gir umiddelbart varsel + gjenopprettingskontekst** (D-kjeden finnes og er målt for situasjonsdrevet ACT): en autonom klasse D-handling går gjennom `ToolGateway`-kjeden og `ClassDNotifier` får «executed» med `recovery` = verktøyets gjenopprettingstekst; er varsleren ikke klar (eller kjeden ufullstendig), utføres handlingen ALDRI og situasjonen eskalerer (`wpg4-act-dchain.test.ts`). Motorens eget ACT+NOTIFY («Jarvis utførte en handling: ...») er et tillegg, ikke en erstatning.

## 11. NAS-verifisering steg for steg (`NOT VERIFIED`; gate «ACT/ACT+NOTIFY observert på NAS» = `BLOCKED_EXTERNAL`)

Forutsetninger (eier): NAS med kjørende compose, ekte Home Assistant med eierens long-lived token i hemmelighetslageret (`JARVIS_HA_TOKEN`, `JARVIS_HA_BASE_URL`), Telegram-varsler fungerer, test-/sandbox-ressurser for ALLE handlingstester (blast radius; dette sier ingenting om produksjonens tilgangsnivå). Ingen steg under er utført.

1. `git pull` grenen; `pnpm install --frozen-lockfile`; migrasjon 139 kjøres ved oppstart. Verifiser: `SELECT count(*) FROM situation_subscriptions` = 0, alle flagg `JARVIS_SITUATION_*` ubesatt/AV. Start api; bekreft ingen `situation_signals`-loggline og at verktøylisten er uendret.
2. Slå på `JARVIS_SITUATION_SIGNALS=on` alene. Forventet: startlogg `situation_signals` med `sources` alle `false`; `get_signal_status` viser `enabled: true`; ingen kilde leses (null HA-kall, null databaselesing mot helse/kamera).
3. Slå på `JARVIS_SITUATION_INCIDENTS=on`; opprett (sandbox) en incident; `subscribe` (`incident`/`incident_active`, rom `business`). Forventet: ÉN situasjon (`infra_incident:<id>`), ETT INFORM-varsel; det daglige sveipet gir ingen duplikat. Pause `infra` -> ingen nye varsler; opphev -> gjenoppdages.
4. Slå på `JARVIS_SITUATION_HOME=on`. Registrer en test-dørsensor (`binary_sensor.<test>`, rolle `door`) i et SANDBOX-hjem. Åpne den lenger enn terskelen (standard 15 min). Forventet: ett `inform`; tilsvarende for en lekkasjesensor (test-vann, aldri ekte) og at `critical_bypass_quiet` (standard av) holder varselet i stille timer.
5. ACT (BLOCKED_EXTERNAL-gaten): bind `home` til en test-`home-assistant.critical_cover` (eierens signerte økt kreves) mot en test-cover. Forventet i dag (Q-G2-1): sveipet forsøker, `step_up_required:signed_device_session`, ingen HA-kall, situasjonen `escalate`. En observert vellykket ACT/ACT+NOTIFY mot ekte utstyr krever en eierbeslutning (Q-G4-1) og kan ikke bevises uten NAS.
6. Slå på `JARVIS_SITUATION_VISION=on` (krever G3 på): abonner med kilde-id og nattvindu; en test-bevegelse gir `inform` med den innholdsfrie teksten; verifiser at Telegram-teksten ikke inneholder etikett, navn eller bilde.
7. `JARVIS_SITUATION_HEALTH=on` (krever G2-inntaket med minst 14 døgn baseline): `subscribe` med `person_id` = eier. Forventet: ingen varsel uten avvik; ved syntetisk avvik 3 døgn på rad ett `inform` uten tall. Aldri ACT.
8. `JARVIS_SITUATION_MODEL_ASSIST=on`: med lokal modell oppe: vurdering for kamera/helse; slå lokal modell AV og bekreft at INGEN sky-kall skjer (ModelGateway-trace) og at situasjonen står med deterministisk nivå.
9. `JARVIS_SITUATION_FEEDBACK=on`: gi tre «støy» på samme regel -> terskelen flyttes ett steg og `situation.rule_tuned` står i `audit_events`; `reset_rule_tuning` setter standard.
10. Bekreft `docker compose config` (kun de 9 nye linjene), at `.env` ikke inneholder verdier utover `on`, og at gitleaks er grønn.

## 12. `DEFERRED` / `BLOCKED_EXTERNAL` (ærlig liste)

* `DEFERRED`: HA-push (WebSocket `subscribe_events`/webhook-automasjon) - i dag polling; eier-flate for abonnementer (rute/CLI/kontrollsenter-side; handlingene finnes som verktøy); lært energi-baseline for `power_over_limit` (i dag eierens egen grense); tidssone-bevisste helsedøgn (UTC brukes), søvnstadier, ukestrender; kommunikasjon/forretning som kilder (`communications`/`business` har tomt hendelsessett i registeret; G1-forpliktelser kan kobles senere); «borte»-bevisst bevegelse (kun eierens nattvindu); sanntids-løsning av incidents (løses av det daglige sveipet); kobling av `detectSpendSpike`/`detectStaleJobs` (§10); første kostnad etter lang rolig periode og aldri-kjørte jobber (krever vedlikeholdskatalogen); kontrollsenter-side for situasjoner.
* `BLOCKED_EXTERNAL`: ACT/ACT+NOTIFY observert på NAS; lokal modell på NAS; ekte HA/kamera/helsedata.
* `NOT_BUILT` (bevisst, utenfor UA-10): selvmodifikasjon (D-397), modell som avgjør ACT alene, ny leverandør, lokalagent med filtilgang (Q-60), JARVIS-084.

## 13. D-41 kapabilitetsaudit (connector-lignende deler)

| Del | Les | Skriv | Slett | Tilgangsstyring | Status |
|---|---|---|---|---|---|
| HA tilstand (`read_state_detail`) | ja (`GET /api/states/<entity_id>`, klasse A; samme endepunkt som den eksisterende `read_state` fra D-388 allerede bruker) | ikke her: G2 `critical_*` (klasse D, step-up) eier skriving | n/a (HA har ingen «slett tilstand») | Tokenet er eierens egen long-lived token (eier-tilkoblet, `JARVIS_HA_TOKEN`); at HA-tokens ikke har scopes og at `last_changed` betyr «siste tilstandsendring» er IKKE verifisert mot offisiell dokumentasjon i denne økten og ikke mot en ekte instans (`unverified`) | lesing `PARTIAL` mot D-41 fordi push mangler (`DEFERRED`) og scope-verifiseringen mangler; skriving er G2 |
| Kamera (`VisionService.getRecentEvents`) | ja (minimerte hendelser) | nei | nei | ingen | bevisst lesing: G3 eier skriving; full kapabilitet ville bryte isolasjonen for bildedata |
| Helse (`HealthService.getRecentMetrics`) | ja (aggregert per døgn) | nei | nei | ingen | bevisst lesing: begrensede data (D-41-unntak: full kapabilitet ville bryte isolasjon) |
| Incidents (`listIncidents`) | ja | nei | nei | ingen | lesing; skriving (løsning) er det daglige sveipet |

Risikoklasse per handling, eier-/delegert-oppførsel og idempotens: alle nye handlinger er eier-eksklusive (delegat/modell har ingen flate), `subscribe`/`set_*` er idempotente (UNIK per kilde+type+filter-digest), og alle tester bruker sandbox/test-ressurser.

## 14. Rollback

Flaggene AV og restart (`JARVIS_SITUATION_SIGNALS` av stopper alt). Tabellene beholdes (ingen datasletting nødvendig); `critical_bypass_quiet` og `expires_at` er additive kolonner med trygge standardverdier. Eierens `pause_all` stopper bussen, leveringen og auto-ACT umiddelbart uten omstart. `reset_rule_tuning` tilbakestiller en tunet terskel; `remove_subscription` fjerner et abonnement (situasjoner og logg består).

## 15. Observasjoner og avvik

* **`resolveStaleForDomain("infra", ...)`** løser ALLE åpne `infra`-situasjoner som ikke er blant aktive incident-nøkler. Derfor gjenbruker bussens incident-kilde nøkkelen `infra_incident:<id>`, og enhver ny `infra`-kilde MÅ gjøre det samme eller bruke et annet domene (stale-jobb-detektoren bruker `operations`).
* **Additive port-utvidelser (ikke endret G1-G3-kode):** ny lese-handling `home-assistant.read_state_detail` (separat fra `homeAssistantTools()`; ny `case` i `home-assistant-transport.ts`). Ingen endring i G1/G2/G3-spesifikk kode utover dette.
* **Migrasjon 139** endrer to eksisterende tabeller additivt (to kolonner med standardverdier).

## 16. Åpne eierspørsmål (anbefaling)

* **Q-G4-1:** Skal en autonom ACT mot kritiske hjemhandlinger (port, lås, ventil) noen gang tillates uten eierens signerte økt? Anbefaling: nei; behold step-up-nektelsen og la eieren bekrefte i sanntid (Telegram-knapp som starter en signert økt), eventuelt en tidsavgrenset forhåndsgodkjenning per handling.
* **Q-G4-2:** Skal sikkerhetssignaler (lekkasje, alarm) få bryte stille timer? Anbefaling: ja for lekkasje og alarm (`set_critical_quiet_bypass`), men eieren velger; standard er nei.
* **Q-G4-3:** Kan ikke-begrensede vurderinger (incidents) bruke en skymodell? Anbefaling: ja (kun lukkede felt sendes), men først etter at lokal modell er verifisert for kamera/helse.
* **Q-G4-4:** Hvilken eier-flate skal brukes for abonnementer (kontrollsenter-side, CLI eller chat-kommando)? Anbefaling: kontrollsenter-side i UA-11 som komponerer `situations.*`.
* **Q-G4-5:** Hvilke tenants, jobber og forventede kadenser skal anomali-detektorene (kostnadssprang, stilnet jobb) gjelde for, og skal de kobles? Anbefaling: kun eierens egen tenant, AI-kostnad og de daglige jobbene, med eierens kadenser.

## 17. Testbevis (kommandoer og tall; alt mot lokale fakes og ekte embedded Postgres)

Målrettede filer (kjøres som OS-bruker `postgres` for DB-testene, maks 2 workers): `modules/situations/test/wpg4-bridges.test.ts` (36), `wpg4-signal-bus.test.ts` (27), `wpg4-signal-runner.test.ts` (15), `wpg4-signals-transport.test.ts` (8), `wpg4-flags-wiring.test.ts` (5), `wpg4-tuning-simulation.test.ts` (46), `wpg4-anomaly-detectors.test.ts` (14), `wpg4-act-dchain.test.ts` (7), `modules/tool-gateway/test/wpg4-ha-state-detail.test.ts` (6), `apps/api/test/wpg4-signals-wiring.test.ts` (13), `apps/api/test/wpg4-assist-runtime.test.ts` (11). Full suite og vaktbatch: se sluttrapporten.
