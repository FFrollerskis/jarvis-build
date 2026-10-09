# WP-D2 – Business OS: bedrifts-tenant, lead-/mulighetsoppdatering, produktbruk og churn (runbook)

**Status: UTKAST – bygget og testet i sandkasse, IKKE verifisert på NAS.** Alt under «Forventet» er hva koden og testene sier, ikke observert drift. Alt som skriver er **av som
standard** eller bak eierens bekreftelse. Ingenting provisjoneres, importeres eller handles automatisk. Beslutninger som er dine (tenant-topologi, SLA-vinduer, churn-terskler) er
merket **NEEDS_TOBIAS** – de er forslag, ikke vedtak. Se også `docs/UA3_BUSINESS_DPIA.md` (personvern) og `docs/security/PROCESSING_INVENTORY.md`.

Alle kommandoer kjøres fra repoets rot på NAS-en (`/volume1/jarvisbuild-data/jarvisbuild`, der compose og `.env` finnes).

## 1. Opprett en bedrifts-tenant (JARVIS-044, Q-44/Q-48 C)

**Hvorfor:** seeden lager kun en `person`-tenant, men alle business-/situasjonssveip enumererer `kind='business'` – uten en bedrifts-tenant er hvert sveip en no-op. Du velger selv navn
og topologi (Q-48 C: «la stå til tenant-topologien er besluttet» gjelder fortsatt for planlagte jobber – se punkt 1.3).

```bash
ops/nas/provision-business-tenant.sh "Kundeoppfølging AS"                                    # dry-run: viser planen, skriver ingenting
ops/nas/provision-business-tenant.sh "Kundeoppfølging AS" --confirm tenant-kundeoppfolging-as  # oppretter (idempotent – trygt å kjøre flere ganger)
```

- Slug utledes fra navnet (`tenant-kundeoppfolging-as`); vil du ha `tenant-kundeoppfolging`, oppgi slug eksplisitt som andre argument. `--confirm` må være NØYAKTIG tenant-id-en dry-run viste.
- Oppretter i én transaksjon: `tenants(kind='business')`, memory spaces `business` og `project`, eier-medlemskap og revisjon (i begge tenants). Samme navn/slug gir samme tenant; samme slug
  med annet navn, eller en id som allerede er en person-tenant, avvises. Rapporten viser om sveipene nå finner tenanten (`jarvis_list_business_tenant_ids`) og (når rollen håndhever RLS)
  at en fremmed tenant-kontekst ser 0 rader.
- Alternativ: dashbord-ruten `POST /owner/business-tenants` (eier-grant + signert enhet + typet bekreftelse). Den er **av** (404) med mindre `JARVIS_BUSINESS_TENANT_PROVISIONING=true`.
- Aldri et modellverktøy, aldri koblet til oppstart/seed/migrering.

### 1.1 Det du MÅ gjøre etterpå (ingenting av det skjer automatisk)

1. **Eier-autoritet i tenanten:** sett `JARVIS_OWNER_EXTRA_TENANTS=tenant-kundeoppfolging-as` i `.env` (api OG worker) og start dem på nytt. Utvider KUN hvor du som autentisert eier er
   suveren og kan bruke eier-tilkoblede connectorer; gir ingenting til andre personer, til `system` eller til planlagte jobber. Kode: `ownerTenantsFromEnv` (`packages/contracts/src/owner-config.ts`).
2. **Enhet i tenanten** (chat/dashbord er per tenant): `ops/nas/enroll-device.sh <https-adresse> dashboard tenant-kundeoppfolging-as`.
3. **Planlagte jobber** (`business-events-sync`, `conversation-graph-sync`, `support-inbox-sync`) kaller Gmail/Kalender som `system` og avvises med `credential_not_bound_to_identity` (D-377)
   inntil du velger A eller B i Q-48. De vises som feilet (D-442/D-443) – det er ærlig, ikke en feil i provisjoneringen. **Ingen kodeendring av credentialBinding i denne PR-en.**
4. Sveipene (open loops, scoring, brief, finans, vekst) finner tenanten ved neste kjøring; den starter tom.

## 2. Lead-/mulighetsoppdatering (JARVIS-049)

Opprett/oppdater lead og opportunity, flytt stadium/status, sett neste handling, lukk med utfall og slett – via chat (eller transport), alltid i **din bedrifts-tenant** og **etter din bekreftelse**
(bekreftelseskort). Klasse B: opprett, oppdater, sett neste handling. Klasse C: lukk, slett (kun suveren eier). Hver faktisk endring gir én rad i `business_change_log` (full før/etter-tilstand,
aktør, valgfri `idempotency_key`); samme nøkkel gir samme effekt, aldri to ganger. Sletting detacher avhengige rader og bevarer før-tilstanden i loggen. Ingenting kan skrive i en person-tenant.

## 3. Produktbruk og churn («churn/product usage»)

Hendelser fra DINE egne produkter blir deterministiske, forklarbare churn-signaler per **kundekonto** (aldri person). Resultatet er en open loop `customer_churn_risk` (INFORM; SUGGEST kun ved
høy prioritet og confidence ≥ 0.75; auto-ACT kun via en autonomi-policy du selv binder til domenet `retention`). Dormant: ingen kilde er på før du slår den på.

### 3.1 Hendelsesformat (webhook og fil)

Felt: `event_id` (din unike id, ≥ 6 tegn), `account_ref` (pseudonym), `feature` (`chat.send`, små bokstaver), `occurred_at` (ISO 8601), `quantity` (heltall, standard 1), valgfritt `user_ref`
(pseudonym) og `kind: "billing_status"` (da kreves `quantity` = antall forfalte fakturaer, 0 = ingen, og `feature`/`user_ref` er forbudt).

- `account_ref`/`user_ref` MÅ være pseudonymer: **du** hasher id-ene (f.eks. `HMAC-SHA256(eget salt, intern id)` som hex). e-post, telefon, fødselsnummer-lignende tall og IP-adresser avvises; ukjente felt
  avvises (og en CSV med ukjent kolonne avvises i sin helhet).
- `event_id` er idempotensnøkkelen **på tvers av kilder** (webhook, CSV, JSONL): samme id teller aldri to ganger; samme id med annet innhold telles som konflikt og anvendes ikke.
  Bruk et prefiks per produkt hvis to produkter kan finne på samme id.
- Eldre enn 400 dager eller mer enn 5 minutter frem i tid avvises. Rå hendelser slettes automatisk etter 400 dager.

### 3.2 Innkommende webhook (valgfritt – av som standard)

Sett i `.env` (api; hemmeligheten kan også ligge i Infisical):

```
JARVIS_PRODUCT_USAGE_TENANT_ID=tenant-kundeoppfolging-as      # må være en BEDRIFTS-tenant; uten denne finnes ruten ikke (404)
JARVIS_PRODUCT_USAGE_WEBHOOK_SECRET=<minst 32 tegn, tilfeldig>  # uten/for kort: ruten svarer 503
```

Signering (HMAC-SHA256 over `<t>.<rå kropp>`, hex, header `X-Jarvis-Signature: t=<unix>,v1=<hex>`, ±300 s):

```bash
BODY='{"events":[{"event_id":"evt-000001","account_ref":"acct-0001abc","feature":"chat.send","occurred_at":"2026-10-09T10:00:00Z","quantity":3}]}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$JARVIS_PRODUCT_USAGE_WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -sS -X POST https://<jarvis-api-host>/webhooks/product-usage -H "x-jarvis-signature: t=$TS,v1=$SIG" -H 'content-type: application/json' --data-binary "$BODY"
```

Svar: `200 {"received":true,"events":{received,inserted,duplicates,conflicts,rejected},"rejected_detail":[{position,reason}]}` (aldri hendelsesinnhold). `401 invalid_signature` (uten årsak),
`400 payload_*` (hele kroppen ugyldig), `413` (over 512 KiB), `429` (maks 30 kall per minutt per IP), `503 not_configured`. Maks 500 hendelser per kall.

### 3.3 CSV/JSONL-import (NAS)

Filen sendes på stdin (ingen filstier). Dry-run er standard:

```bash
ops/nas/product-usage.sh import --tenant tenant-kundeoppfolging-as --format csv --label 2026-10 < bruk.csv             # validerer, skriver ingenting
ops/nas/product-usage.sh import --tenant tenant-kundeoppfolging-as --format csv --label 2026-10 --confirm < bruk.csv   # lagrer
```

CSV har header med `event_id,account_ref,feature,occurred_at` (+ valgfritt `quantity,user_ref,kind`). Ukjent kolonne (f.eks. `email`) avviser hele filen.

### 3.4 Koble kontoer til kundeselskaper (kreves før en vurdering finnes)

En konto uten kobling får ingen vurdering og ingen loop (ingen kan handle på et pseudonym).

```bash
ops/nas/product-usage.sh accounts --tenant tenant-kundeoppfolging-as --unlinked
ops/nas/product-usage.sh link --tenant tenant-kundeoppfolging-as --account <konto-ref> --company <company_id> --confirm
```

Eller i chat: «koble produktkonto <konto-ref> til <kunde>» (klasse B, bak bekreftelse). Slutter en kunde å være aktuell: `unlink` (vurdering og churn-loop forsvinner).

### 3.5 Hvordan vurderingen leses

Churn-sveipet kjører sammen med open-loop-sveipet. Score 0–100 fra signalene (v1, **forslag – NEEDS_TOBIAS**): ingen bruk 14/30 dager (25/45), fall i bruk ≥ 40/70 % (15/30, krever nok grunnlag),
åpne supportsaker (10/20, +10 ved høy prioritet), forfalte fakturaer (15/25). Nivå: ≥ 55 høy, ≥ 30 middels. «Ingen bruksdata» gir score 0 – fravær av data er aldri et signal. Chat: «hva skjer med kunde X?»
viser churn-vurderingen; «hvem risikerer vi å miste?» bruker `business.get_churn_overview`.

### 3.6 «Glem bruker»

```bash
ops/nas/product-usage.sh forget-user --tenant tenant-kundeoppfolging-as --user <bruker-ref> --confirm
```
Nuller `user_ref` på alle hendelser (volum per konto beholdes). Revisjonen bærer aldri pseudonymene (kun tellere og en kort hash).

## 4. Confidence og kalibrering (JARVIS-045) og SLA-regelen (JARVIS-082)

- **Confidence** skrives nå fra flere signaler (persistens, forfallsstørrelse, uavhengig bekreftelse fra andre domener hos samme kunde, flere signalfamilier i churn-regelen) – lagret med forklaring
  i `business_open_loops.confidence_basis`. En heuristikk (stagnert mulighet, churn …) kan ikke nå SUGGEST-terskelen (0.75) før kalibreringen viser nok merkede utfall og treffrate ≥ 0.75.
- **Utfall** gir kalibreringsgrunnlag: når du lukker en loop (chat: «lukk loopen, jeg ringte kunden» – klasse C, bak bekreftelse), oppgi `outcome` (`acted` = du handlet, `dismissed` = irrelevant). Uten
  utfall er loopen umerket (verken treff eller bom). Et merket utfall **forsvinner ikke** hvis samme vilkår gjenåpner loopen etter 7-dagers-undertrykkelsen: det flyttes til `closure_history` på raden
  (uten det ville kun lukkinger som faktisk løste saken overlevd, og treffraten blitt overvurdert).
- `business.get_calibration_report` (chat: «hvor treffsikre er forslagene dine?») viser forutsagt mot observert per loop-type (treffrate, gap, Brier, pålitelighetsbøtter) og endrer ingenting av seg selv –
  justering skjer som ny regelversjon etter din vurdering (**NEEDS_TOBIAS**). Kalibreringen får først effekt ved ≥ 20 merkede utfall per loop-type.
- En enkeltdetektor kjørt utenom det fulle sveipet nullstiller ikke confidence til grunnverdien: detektoren skriver kun grunnverdien for en NY eller gjenåpnet loop, og `refineConfidence` er ellers eneste skriver.
- **SLA-regelen** `support_ticket_overdue` var koblet til felt ingen skrev (`next_response_due_at`). Den utleder nå svarfrist fra faktiske data: siste ubesvarte kundemelding + vindu per prioritet
  (forslag: urgent 4 t, high 8 t, normal 24 t, low 72 t – **NEEDS_TOBIAS**). Overstyr med `JARVIS_SUPPORT_SLA_HOURS=urgent=4,high=8,normal=24,low=72` eller slå av med `JARVIS_SUPPORT_SLA_HOURS=off`
  (da gjelder kun eksplisitte frister). Variabelen leses av **både api og worker** (samme policy, API/worker-parity) og står kommentert i `.env.example`; ugyldig verdi stopper oppstarten av begge (fail closed).
  Kalenderstimer (ikke kontortid) – kontortid er en senere, eksplisitt beslutning. Regelen leser faktiske kundemeldinger (`support_ticket_events`, skrevet av support-innboks-synken); en manuell ticket uten
  kundemelding har ingen utledet frist, og `waiting_customer` har ingen klokke.

## 5. For å verifisere (NOT VERIFIED – kjør på NAS, ett steg om gangen)

1. Migrasjoner 089–091 er anvendt: `migrate`-tjenesten kjører dem ved vanlig oppdatering (`sudo docker compose --env-file .env -f infra/local/docker-compose.yml up -d --build`, se
   `docs/runbooks/NAS_UPDATE_2026-10-07.md`; `migrate` skal stå som Exited (0)). Sjekk i databasen: `SELECT name FROM schema_migrations WHERE name >= '089' ORDER BY 1;` – forventet `089_…`, `090_…`, `091_…`.
   (Koordinatoren kan ha renummerert hvis et nummer var tatt av en annen gren – denne PR-en bidrar med nøyaktig tre nye migrasjonsfiler: lead-/mulighetsoppdatering, produktbruk/churn og confidence-kalibrering.)
2. Tenant: `ops/nas/provision-business-tenant.sh "Test AS" testas` (dry-run) → `--confirm tenant-testas`. Forventet: «sveipene finner tenanten: true».
3. Import: `ops/nas/product-usage.sh import …` uten `--confirm` viser tellere og skriver ingenting; med `--confirm` lagres de; samme kommando igjen gir «allerede lagret: N».
4. Webhook (kun hvis slått på): signert `curl` over gir `200`; samme kall med endret kropp gir `401`.
5. Sveip: etter at en konto er koblet og har ≥ 30 dagers stillhet, vises en `customer_churn_risk`-loop i brifen/«åpne saker».

## 6. Ærlige begrensninger

- Ingenting her er kjørt mot NAS, Docker eller eksterne tjenester; sandkasse-tester bruker ekte Postgres men ingen eksterne API-er.
- Terskler, vekter, SLA-vinduer og confidence-justeringer er forslag. Kalibreringsrapporten er verktøyet for å justere dem, men trenger merkede utfall over tid.
- Q-48 (credentialBinding for planlagte jobber) er uendret; `JARVIS_OWNER_EXTRA_TENANTS` løser kun eierens egen suverenitet.
- Webhooken har ikke persistent replay-ledger utover hendelses-id-idempotens og 300 s-vinduet (replay innen vinduet er harmløst: samme hendelse teller aldri to ganger).
