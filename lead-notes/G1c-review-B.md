TS: 2026-11-25T23:55:27.554Z
VERDICT: MERGE ETTER FIKSER. 0 HIGH og 1 MEDIUM. Triggerne holder som tillitsgrense mot app-rollen, men en gyldig signert Meta-batch over 256 KB mister STOP for alltid, og noen «LUKKET»-påstander i dokumentene er for sterke.

Alt jeg påstår under er kjørt. Kommandoen var `su postgres -c 'pnpm exec vitest run --maxWorkers=2 <filer>'` mot embedded PG16 med FORCE RLS og app-rolle (NOSUPERUSER, NOBYPASSRLS).
- **Egne prober:** 8 filer og 75 tester grønne i sluttkjøring (`run-all-final.log`, `run-final2.log`).
- **Guards:** 10 filer og 178 tester grønne (`run-guards.log`). Det er wph1/wph2 flag-av-baselines, drive-runtime-wiring, wpg1-comms-routes, wpg1c-legacy-notify-wiring, model-surface, part3-tool-manifest, env-drift, wpg1c-policy-denied-health og payload-fingerprint.
- **Hemmeligheter:** gitleaks over `71a31d8b..HEAD` ga «7 commits scanned, no leaks found».
- **Discord-id:** `git log -p` viser ingen 17–20-sifret id i de 7 pushede commits. Eneste hemmelighetslignende streng er `TEST_PEPPER="fake-pepper-for-test-not-real-0000…"`.
- **Worktree:** `git status --short` er tom og HEAD er `f43f06e6`.

## Funn (rangert)

**MEDIUM**
- **M1. Gyldig signert Meta-batch over 256 KB: STOP registreres aldri.**
  - **Kode:** `modules/comms/src/webhooks/ingest.ts:61` (`WEBHOOK_MAX_BYTES = 256*1024`), `apps/api/src/server.ts:1893` og `parsers.ts:46` (tak 1000).
  - **Probe** `zz-g1c-review-b-webhook` W1–W3. Dagens Meta-form gir ca. 266 B per melding, så 1000 meldinger er 266 202 B mot 262 144 B i grensen. Maks ca. 984 meldinger får plass, færre med lengre tekster eller statuses.
  - En gyldig signert batch på 1001 meldinger (266 469 B, STOP sist) ga HTTP 413 tre ganger på rad (første forsøk og to retries), og STOP var ikke registrert. 413 kommer før signaturen, så leverandørens retry er identisk til den gir opp.
  - Byggeren siterer selv «inntil 3 MB». Runbook:80 kaller det «kjent begrensning (UVERIFISERT)», men tabellen på :211 sier «K3 LUKKET».
  - **Over taket (W3a):** 1001 hendelser gir 503 `batch_over_cap`. Retry gir `duplicates:1000, deferred:1`, så hendelse nr. 1001 behandles aldri. «Sender på nytt, dedupe gjør gjentak trygt» gir trygghet men ingen fremdrift. STOP-først dekker bare nøkkelord.
  - **Fiks:** per-leverandør kroppsgrense, f.eks. `WEBHOOK_MAX_BYTES_BY_PROVIDER = { meta: 4*1024*1024 }`, brukt i `server.ts:1893` (HMAC over 4 MiB koster millisekunder; behold 256 KB for de andre og 30/min/IP). Sett K3 til «DELVIS» til det er gjort, og legg til en test med >256 KB signert Meta-batch.

**LOW**
- **L1. STOP-vakten for eldre notify omgås for Discord (`legacy-notify-guard.ts:40,55`).**
  - Uparsbar mottaker gir `null` og slippes gjennom, og `DiscordTransport` (`live-transports.ts:1200`) setter `channel_id` rått inn i URL-en.
  - **Probe `...-guard`:** `channel_id="123456789012345678/messages?"` gir `SENT via …/channels/123456789012345678/messages?/messages`, altså mot den avmeldte kanalen. Kontrollen med ren id blokkeres.
  - Slack `#navn` og `U…` slipper også gjennom (dokumentert).
  - Twilio, Telnyx og WhatsApp er robuste: 9 formateringsvarianter var enten blokkert av vakten eller avvist av `assertE164` (`^\+[1-9]\d{7,14}$`).
  - Runbook:231 «transportene validerer selv» er usant for Discord og Slack.
  - **Fiks:** for `discord`, kast `PolicyDeniedError("comms_policy_denied:recipient_invalid")` når verdien ikke matcher `^\d{17,20}$` etter trim. Discord-id-er er alltid snowflakes, så det er trygt.
- **L2. DELETE-vernet er en transaksjonslokal GUC som enhver app-tilkobling kan sette.**
  - **Probe db-bypass 2d:** `set_config('jarvis.erasure_in_progress','true',true)` etterfulgt av DELETE av en `owner_recorded`-rad lyktes og ble committet.
  - Brief ba om å fjerne granten eller bruke definer-funksjon. Grants står igjen: `jarvis_app=arwd` på opt-outs og journal, `ard` på receipts, ingen TRUNCATE/TRIGGER, ingen SECURITY DEFINER.
  - Runbook «Kjente begrensninger» er ærlig om dette. DPIA §10.7 («databasen avviser all annen sletting») er det ikke.
  - **Svar på (a):** ingen app-, modell- eller delegert flate kan utløse stien i dag. GUC-en settes bare av `ErasureService.executeErasure` (klasse D via PolicyGateway) og av `finance/scripts/lib/money-cleanup.ts`. `apps/api` har ingen kobling (privacy.ts: «ikke koblet i produksjon, JARVIS-060»).
  - Når erasure kobles inn, sletter romsletting (`plan.ts:365-372`) hele den tenant-brede avmeldingslisten. Det er bevisst men et åpent eierspørsmål.
- **L3. Testhull funnet av mine mutanter.** Byggeren påstår «ingen overlevende» på 121 mutanter.
  - **S08:** `141:120` med `GRANT … UPDATE` på `comms_inbound_receipts` overlever. Min probe 4b dreper den (`permission denied`).
  - **K03:** `store.ts:321` uten lås i `recordOptOutIn`, som er stien for eier-`record_opt_out` og leverandørfeil 21610. 8 samtidige kall gir `duplicate key … comms_recipient_opt_outs_active_…`. Probe `k03` dreper den.
  - **K10:** `store.ts:749` uten `LEAST(…, now())` på receipts-DELETE. Bare journal-linjen :750 testes.
- **L4. Pepperen godtar svake verdier (`channels.ts:158,170`).** Bare lengde ≥ 32 etter `trim()` kreves.
  - `"a"×32`, `"0"×32` og testfiksturen gir hashere (probe 1a).
  - Pepper med omkringliggende mellomrom gir samme nøkkel som uten.
  - Nøkkelen er skilt per formål (`content`/`request`), men ikke per tenant eller rom.
  - **Fiks:** avvis verdier med få unike tegn og sett tenant inn i HMAC-konteksten.
- **L5. Mottakerhashen er usaltet (`channels.ts:118-136`) og er en reversibel kodning for norske numre.**
  - **Svar på (d):** ca. 10^7–10^8 kandidater, og `recipient_hint` gir i tillegg første 3 og siste 3 tegn.
  - Kjente kontakter ligger allerede i klartekst i samme DB (`conversation_channel_links.channel_identifier`, `business_contacts.phone`), så det er ingen ny eksponering der. For ukjente STOP-avsendere er hash og hint eneste spor, og de kan trivielt gjettes.
  - «Et salt ville foreldreløst rader» er ikke tvingende. Samme dobbeltlesing som content-hash (versjonskolonne, oppslag på begge former, HMAC med purpose `recipient`) unngår det. DPIA er ærlig om saken.
- **L6. UVERIFISERT, verifiser først med en ekte wamid.** Fra min hukommelse av Metas ID-format koder `wamid.HBgL<base64>…` avsenderens telefonnummer (`HBgLNDc5OTk5OTk5OTk` dekoder til `\x1c\x18\x0b4799999999`).
  - `event_key` lagres rått i `comms_inbound_events` (30/1825 d), `comms_inbound_receipts` (1825 d) og `comms_recipient_opt_outs.evidence_ref` (til erasure; `ingest.ts:72`).
  - Hvis det stemmer, er «ingen mottaker, ingen tekst» for kvitteringstabellen (DPIA §10.6/inventar) usann, og pseudonymiseringen av STOP-avsendere er omgått.
  - **Fiks:** lagre HMAC av `event_key` i receipts og `evidence_ref` for WhatsApp.
- **L7. Dokumentasjon.**
  - `PROCESSING_INVENTORY.md:77` («tar alle fire tabellene», nå minst 6) og :78 («innholds-hashen … usaltet SHA-256») er foreldet etter K1.
  - Runbook:219 «K7 LUKKET» mot byggerrapporten, som sier Y5/Y19/X6 og komplementære-lag-tester ikke er gjort.
  - Runbook:211 K3 «LUKKET» mot M1.
  - Runbook:146 har den gamle «usaltet»-linjen uten egen historikk-merking.
  - DPIA §10.7 «all annen sletting» (se L2).
  - Verken DPIA eller runbook nevner innsyn eller sletting per mottaker. Ingen kodevei finnes (kun rom- og tenantsletting).
- **L8. `recipient_request` kan aldri løftes, verken av START eller av eier (b).**
  - **Kode:** trigger `141:56-66` og `liftIn`.
  - **Etterlevelse:** trygg retning. SMS-START kan spoofes (Twilio signerer ikke avsender), og en spoofet START ville ellers overstyre en avmelding mottakeren ba om utenfor kanalen.
  - **Personvern:** en mottaker som vil melde seg på igjen har ingen vei. Eneste utvei er `DISABLE TRIGGER` eller ny migrasjon. En feilregistrert `recipient_request` kan heller ikke angres.
  - `record_opt_out` (uten step-up, `server.ts:693`) kan opprette slike irreversible rader.
  - **Forslag (Q):** egen D-handling «resubscribe» med step-up, begrunnelse og beviskilde, eller en dokumentert driftsprosedyre.

**INFO**
- **I1. Step-up for `lift_owner_opt_out` er sesjonsnivå.** `ownerStepUpDenial(identity)` krever `auth_strength==='signed'` og en kanal blant web/desktop/api/mobile.
  - Håndheves både i ruten og i gatewayen (probe 5b).
  - Den er ikke bundet til nyttelasten. Bindingen skjer bare via G1b-idempotensavtrykket (usaltet 128-bit hash av `opt_out_id+reason` i ledger-nøkkelen).
  - Det er likt de andre D-handlingene. At kanalen er klient-påstått er ærlig merket i tool-tekst og runbook.
- **I2. Feilkoder avslører kilden bare til eier.** Ukjent id gir `preflight_target_not_found`, feil kilde gir `preflight_invalid:opt_out_not_liftable_by_owner:<source>` (probe 5d). Modell og delegert når ikke handlingen: gjest, agent og annen tenant gir `owner_only` rett i gatewayen (probe `gw`), og svak eier-økt gir `step_up_required`.
- **I3. Gjenspilling og begrunnelse.** Gjenspilling av en vellykket lift med samme nøkkel gir `preflight_target_not_found`, ikke `deduplicated` (5g; byggerens test godtar begge). Begrunnelsen finnes bare i `comms_recipient_opt_outs` (skann av alle tabeller og varsler, 1 treff). Begrunnelser med hemmelighet, linjeskift, tab, nullbyte, RTL, 2 eller 201 tegn avvises (5e).
- **I4. STOP-friskhetsunntaket er ufarlig (`ingest.ts:236`).** Det gjelder bare STOP, og dedupe-radene lever 1825 d (`ingest.ts:63`).
  - Replay av START etter at dedupe og kvittering er slettet (5 år) løfter en nyere STOP (probe 2d). Twilio og Meta har ingen signert tid.
  - Over-tak-loggen har kun `{msg, provider, events, cap, deferred}`.
  - Signatur kommer før telling (W4a: ugyldig signatur på 300-batch gir 401 uten DB-skriving).
- **I5. «STOP vinner» gjelder under lås-kø.** Ukontendert nær-samtidighet avgjøres av hvem som tildeler sekvens først. START mottatt etter STOP løfter (dokumentert restrisiko (b)). 20 runder med blandet rekkefølge: START løftet aldri `owner_recorded` eller `recipient_request` (5i).
- **I6. K4 `allow_shared_with` gjelder kontaktpar, ikke enkeltidentifikator** (probe `cg` 1). B sin senere nye private telefon festes til den delte identiteten uten ny avgjørelse. Jokertegn, tom streng, stor liste og kryss-tenant har ingen effekt. `split_identities` kan ikke godtas (DB CHECK). Forslagene viser bare ressursnavn, så eier avgjør «blind».
- **I7. Småting.**
  - 118-CHECK tillater `lifted_at` på en aktiv rad. Det rører ikke `status`.
  - `recorded_by`, `session_id`, `task_id` og journalens `before_state` kan omskrives av app-SQL.
  - `holidays.ts` kaster RangeError for år utenfor 1583–9999.
  - `store.ts:349` `liftByStartKeyword` har ingen produksjonskaller. Mutant K04 er derfor ekvivalent.

## Byggerens påstander mot dom

| Påstand | Dom | Bevis |
|---|---|---|
| K1: triggeren styrer hvem som kan løfte hva | BEKREFTET | Probe db-bypass 1a–1h, 2e/2f og 3a/3b: UPDATE av `source`, løft-varianter, upsert, DELETE+INSERT og kryss-tenant avvist. TRUNCATE, `session_replication_role`, DISABLE TRIGGER, CREATE FUNCTION/TRIGGER og SET ROLE gir `permission denied`/`must be owner`. S01–S04 drept. |
| K1: DELETE-grant fjernet eller smalest | DELVIS | Grants beholdt, vern er GUC (2d). Se L2. |
| K1: rom-CHECK | BEKREFTET | 3c: 10 ugyldige former avvist (health/home/guest/NULL/''/Business/…). 3d: 9 constraints validert uten health. S11/S12 drept. |
| K1: HMAC-pepper, fail-lukket | BEKREFTET (kode) | 1c: uten pepper `denied`, 0 adapterkall, `content_sha256` NULL. 1d: hverken pepper, usaltet sha256 eller tekst finnes i noen tabell. H01–H07 drept. Svak pepper godtas (L4). Aktivering `BLOCKED_EXTERNAL` er ærlig. |
| K1: gamle rader, dobbeltlesing | BEKREFTET | `before_state` skrives bare ved INSERT (`store.ts:556-561`). `v` er alltid 2. Ingen parameter gir nedgradering. H05/H06 drept. |
| K2: deterministisk STOP/START | BEKREFTET med restrisiko | 2a–2c, 5h, 5i. K01/K02/K09/K11 drept. Replay etter 5 år (2d) og feil leverandørrekkefølge (2b) er dokumentert. |
| K3: tak, STOP først, 503, lange id-er | DELVIS | W3a og W4a OK, W01–W07 drept. Over 256 KB gir 413 og STOP tapt (W2b), og over tak gir ingen fremdrift (M1). |
| K4: forslag fra ubetrodd synk | BEKREFTET | Bare `people/c\d{1,25}` (regex ved kilde og i DB). Kryss-tenant og jokertegn uten effekt. C01–C03 drept. |
| K5: eier-angre (klasse D) | BEKREFTET | 5a–5i og `gw`: step-up i gateway, `recipient_request`/stopp-ord/leverandørfeil avvist uten effekt, 20 runder START-race. L01–L03 drept. |
| K6 g5: vakt for eldre notify | DELVIS | Alle 5 transporter pakket, bare `notify` sender, DB-feil gir fail-lukket (G01 drept). Discord- og Slack-omgåelse (L1). Worker ikke dekket (ærlig PARTIAL). |
| K6 g4: `PolicyDeniedError` | BEKREFTET | P01/P02 drept. wpg1c-policy-denied-health 5/5. |
| K8: flagg AV lik main | DELVIS | 10 guardfiler/178 tester grønne. `COMMS_ENV` kun i `api` (`service-env.mjs:401`). Migrasjonene rører bare comms-tabeller. Ingen differensiell kjøring mot en main-kopi (jeg kan ikke lage worktree). |
| K9: ærlig dokumentasjon | DELVIS | L6 og L7. |
| Ingen hemmeligheter eller PII i logg/audit | BEKREFTET | 4 nye `warn`-kall, alle uten verdier. Probe 5f/1d. |

## Mutasjoner
`python3 mutants.py run` ga 51 kjørt, 46 drept og 5 overlevd. Hver mutant er én linje, `--bail=1` på de relevante testfilene, og filen er gjenopprettet med `git checkout` etter hver.
- **Drept (46):** S01–S07, S09–S12, K01, K02, K05–K09, K11, W01–W07, H01–H07, G01–G05, L01–L03, C01–C03, P01, P02.
- **Overlevde:**
  - S08: reelt testhull (L3).
  - K03: reelt testhull, samtidighet ved direkte `recordOptOut` (L3).
  - K10: reelt testhull (L3).
  - K04: ekvivalent i produksjon (dødkode, I7).
  - H08: praktisk ekvivalent (kun pre-A-M5-rader uten fingeravtrykk finnes ikke i produksjon).
- **Testendringer:** `git diff 71a31d8b..HEAD` på eksisterende testfiler viser ingen svekkede assertions. Endringene er tellinger (32→35 handlinger, 21→19 konstruktører), den nye `contentHasher`-parameteren, regex for innpakkede transporter og K3-fjerningen av «id over 1000 forkastes». `purged.inbound` ble flyttet til `first.inbound`.

## Ikke verifisert av meg
- **Ekte leverandører:** Metas batchstørrelse, retry-vindu, timeout og wamid-format, samt Slack og Twilio.
- **NAS og hemmeligheter:** NAS, vault og ekte pepper, og alle NAS-trinnene i runbook.
- **Hele suiten og statiske kontroller:** full suite, CI, typecheck og lint.
- **Worker:** worker-prosessen (vakten dekker den ikke).
- **Flagg AV:** differensiell kjøring mot en main-kopi (guards og kodelesing erstatter den).
- **Juss:** ekomloven og markedsføringsloven, og Lovdata-kontroll av helligdagene (algoritmen er sjekket mot 19 kjente påskedager).
- **Byggerens tall:** 4291 tester og 121 mutanter.
- **Utenfor mitt fokus:** K6 g1 (kontotak) og g3 (Slack-utfall), og reviewer A sin flate.

## Probe-mappe
`/tmp/lead/G1c-review-B-probes/` inneholder:
- **Probefiler:** `zz-g1c-review-b-{db-bypass,lift,guard,cg,gw,holidays,k03,webhook}.test.ts`.
- **Mutasjon:** `mutants.py` (resumable), `mutant-results.jsonl` og `mutants-run.log`.
- **Logger:** `run-*.log`.
- **Notater:** `NOTES.md`.
