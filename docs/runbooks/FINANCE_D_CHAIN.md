# Klasse D-kjeden for penger (WP-F1, UA-6) - runbook for eieren

Gjelder: `finance.submit_payment_intent`, `finance_stripe.submit_refund`, `finance_vipps.submit_capture`, `finance_vipps.submit_refund` (de fire handlingene som flytter penger),
samt avstemming, webhooks og ukjent utfall. Kilder: D-375 (klasse D-minimumspipeline), D-392 (finansintegritet), D-228 (Stripe testmodus), Q-47 (a), D-462 (WP-F1), CLAUDE.md regel 2/8/11.
Prinsipp: **strengeste sikkerhetsregel vinner.** Ingen pengehandling kan nås av modellen, og ingen kan utføres uten hele kjeden under.

## 0. Status i ett blikk

| Del | Status | Bevis / merknad |
|---|---|---|
| Klasse D-kjeden for de fire handlingene (fersk lesing, målvalidering, recovery, idempotens, etterbetingelse, varsel) | **Bygget og testet** (ekte Postgres, testdobler for leverandørene) | `wpf1-d-chain.test.ts`, `wpf1-finance-class-d.test.ts`, `wpf1-gateway-extensions.test.ts` |
| Dobbeltbetalingsvern (reservasjon + lease, leverandørens Idempotency-Key, 23 t-vindu, ukjent utfall) | **Bygget og testet** (samtidighet mot ekte Postgres) | `wpf1-double-pay-service.test.ts`, `wpf1-d-chain.test.ts` B-D |
| Eierens vei (preview -> bundet bekreftelse -> step-up-godkjenning) | **Bygget og testet** mot ekte API-server, ToolGateway, ConfirmationStore og FinanceService | `apps/api/test/wpf1-finance-actions-route.test.ts` |
| Binding av bekreftelsen til **beløp + valuta + mottaker** og uforanderlige pengekolonner (DB-trigger) | **Bygget og testet** | `wpf1-immutable-money.test.ts`, route-test G, `wpf1-d-chain.test.ts` J |
| Webhook-herding (Stripe, Vipps, Neonomics, Wallester) | **Bygget og testet** | `wpf1-webhook-hardening.test.ts`, `wpf1-webhook-status-mapping.test.ts` |
| Leverandørlesing uten DB-transaksjon/radlås (JARVIS-019) | **Bygget og testet** | `wpf1-refresh-no-lock.test.ts` |
| Deterministisk avstemming + sveip + `finance.get_reconciliation_status` | **Bygget og testet; DORMANT** uten Fiken-credentials (Fiken-delen) | `wpf1-reconciliation.test.ts` |
| **Live-verifisert mot ekte leverandør** | **KUN Stripe testmodus** (D-228, `STRIPE_LIVE_GATE=PASS_PENDING_ARCHITECT_REVIEW`) - og det var FØR WP-F1. Den nye kjeden er IKKE kjørt mot noen ekte leverandør. | Se §8 for kommandoer |
| Vipps, Neonomics (bank), Wallester (kort), Fiken (regnskap) | `BLOCKED_EXTERNAL` - bygget dormant, ingen credentials | Se §5 |
| `mcp_zapier.call_tool`, `microsoft_outlook.send_mail` | **DEFERRED** (uendret, begrunnet i §9) | `EXPECTED_DEFERRED` i `part3-class-d-pipeline.test.ts` |

## 1. Hvorfor modellen aldri når pengehandlingene

* De fire handlingene står på **ingen modellflate**: namerommene `finance`, `finance_stripe`, `finance_vipps` er eier-eksklusive (`OWNER_ONLY_NAMESPACES`), og handlingene står ikke på `MODEL_SURFACE_ALLOWLIST` (låst av `wpf1-d-chain.test.ts` I og manifest-invariantene).
* `ToolDefinition.step_up_required` håndheves **i ToolGateway selv** (ikke bare i rutene): uten en enhetssignert økt (`auth_strength: signed`) fra en eier-kanal (`web`/`desktop`/`api`/`mobile`) avvises kallet FØR noe leses eller reserveres - også for eieren. Tale, Telegram, meldingsplattformer, klokke og system har aldri step-up.
* Eier-binding: leverandørens credential bindes til den autentiserte eieren i eierens tenant (`credential_not_bound_to_identity` for alle andre, også gjester og delegater).
* Rask bane hopper over LLM, **aldri** over Policy Gateway; policy-, parameter-, rate-limit- og frys-portene kjører FØR step-up og før credential-oppslaget.

## 2. Slik godkjenner eieren en pengehandling

Alle tre trinn krever **step-up** (signert enhetsøkt). Grant får du via `POST /session/authorize` (samme enhetsbevis som resten av eierflaten). `tenant_id` og person kommer alltid fra grantet - aldri fra kroppen.

1. **Forhåndsvisning** (ingen mutasjon) - viser fersk, redigert tilstand, om handlingen kan sendes nå og hvorfor ikke, samt den **bundne forventningen** (beløp, valuta, mottaker-digest):

   ```
   POST /finance/actions
   { "grant_token": "<grant>", "action": "preview",
     "parameters": { "tool": "finance.submit_payment_intent", "payment_intent_id": "fin-pi-..." } }
   ```
   `tool` er en av de fire handlingene; id-parameteren er `payment_intent_id` (intensjon), `refund_id` (Stripe/Vipps-refusjon) eller `capture_id` (Vipps-capture). For en intensjon kan `confirm_possible_duplicate_of: ["fin-pi-..."]` oppgis når et avslag `possible_duplicate_of:<id>` er kontrollert. Alle andre felt avvises (`unknown_parameter:<navn>`), også `expected_*` - klienten kan aldri sette bindingen selv.

2. **Forespørsel** - samme validering; er den OK opprettes en **bundet, engangs, utløpende (5 min)** bekreftelse for NØYAKTIG dette kallet (inkl. beløp/valuta/mottaker). Ingenting utføres:

   ```
   POST /finance/actions   { "grant_token": "<grant>", "action": "request", "parameters": { ...som over } }
   -> 200 { confirmation_id, expires_at, summary: "betaling 1 234,56 NOK til <leverandør> [ref …1234 (11)] via fiken (intensjon fin-pi-...)", next: "approve_via_confirmations_with_step_up" }
   -> 409 { error: "not_submittable", reason: "<årsak>" }   // opprettes ingen bekreftelse
   ```

3. **Godkjenning** - først nå kjører det lagrede kallet gjennom klasse D-pipelinen, med bekreftelses-id som idempotensnøkkel (`confirmation:<id>`). Avvisning krever ikke step-up (den reduserer risiko):

   ```
   POST /confirmations   { "grant_token": "<grant>", "action": "list", "parameters": {} }
   POST /confirmations   { "grant_token": "<grant>", "action": "decide", "parameters": { "confirmation_id": "conf-...", "decision": "approve" } }
   ```

Etter utførelse: umiddelbart varsel på Telegram (`Klasse D-handling utført` / `UTFØRT MEN IKKE VERIFISERT` / `UTFALL UKJENT`, med redigert sammendrag, ekstern id og gjenopprettingsplan). Mislykkes varselet gjøres det synlig (`notified:false` + audit `tool.class_d_notification_failed`); handlingen ruller aldri tilbake på grunn av det.

## 3. Hva kjeden gjør (rekkefølge)

| # | Lag | Hva som stoppes |
|---|---|---|
| 1 | Policy/parameter/rate-limit/frys | Alt som ikke er autorisert; ukjente felt (`strict` skjema, inkl. `expected_*`-format) |
| 2 | Step-up i ToolGateway | `step_up_required:<årsak>` |
| 3 | Credential per intensjonens provider (`credential_ref_resolver`, JARVIS-072) | `credential_ref_unresolved` (ukjent intensjon/provider), `credential_unavailable`, `credential_revoked`, `credential_not_bound_to_identity`. En Stripe/Vipps-intensjon krever IKKE lenger Fiken-token |
| 4 | Klasse D-krav | `class_d_idempotency_key_required`, `class_d_notifier_missing`/`_not_ready`, `class_d_pipeline_incomplete:<mangler>` |
| 5 | **Fersk tilstandslesing + målvalidering** (`check_submit_*`, rene validatorer) | `preflight_invalid:<kode>`: `finance_kill_switch_active`, `target_mismatch`, `bound_amount_mismatch`/`bound_currency_mismatch`/`bound_recipient_mismatch`/`bound_incomplete`, `not_submittable:<tilstand>`, `amount_not_positive_integer_ore`, `amount_too_large`, `currency_invalid`, `currency_not_supported_for_provider:fiken`, `invalid_account_code`, `missing_counter_account_code`, `missing_vendor_provider_ref`, `debtor_account_*`, `vendor_binding_*`, `integrity_flag:*`, `possible_duplicate_of:<id>`, `exceeds_parent_amount`, `parent_not_settled:*`, `parent_not_capturable:*`, `parent_not_authorized:*`, `currency_mismatch_with_parent`, `submit_in_flight`, `submit_outcome_unknown_reconcile_required`, `submit_window_expired_reconcile_required`, `malformed_state` (fail-closed). Mangler tilstanden: `preflight_target_not_found` |
| 6 | Ledger-reservasjon (`tool_executions`) + tjenestens egen reservasjon (`draft -> submitted`, `FOR UPDATE`, kort tx) | Samme nøkkel igjen = lagret utfall (`deduplicated`); samtidig kall = `execution_in_flight_or_outcome_unknown` |
| 7 | Leverandørkall UTEN åpen DB-transaksjon, med leverandørens Idempotency-Key (Stripe/Vipps) | 4xx = `failed` (ingen bivirkning, samme nøkkel kan prøves igjen etter retting); tidsavbrudd/5xx/408/409 = **ukjent utfall** (§4) |
| 8 | **Etterbetingelse via readback** (leverandør-ID + tilstandsovergang + leverandørens ekko av beløp/valuta) | Mangler/avviker: `unverified` + varsel - aldri stille suksess |
| 9 | Umiddelbart varsel + audit + ledger (`succeeded`/`unverified`) | - |

Kill switch (`finance.enable_kill_switch` / dashbordet) stopper nye transaksjoner umiddelbart: den sjekkes i målvalideringen OG på nytt inne i tjenestens reservasjon (race-vern). Passiv synk, webhooks og avstemming påvirkes ikke.

## 4. Ukjent utfall (timeout/nettverk/5xx) - aldri en ny betaling

Etter et ukjent utfall får raden `unverified` i ledgeren (listet av `ToolGateway.reconcile()`), intensjonen får flagget `SUBMIT_OUTCOME_UNKNOWN`, og eieren varsles (`UTFALL UKJENT`). Samme nøkkel kan **aldri** gjentas av pipelinen.

| Leverandør | Hva som kan gjøres | Hva eieren gjør |
|---|---|---|
| Stripe, Vipps (har Idempotency-Key) | Etter at leasen (2 min) er utløpt og **innenfor 23 timer fra første forsøk** kan innsendingen gjenopptas med SAMME leverandørnøkkel (ny forespørsel + godkjenning) - leverandøren slår sammen kallene, ingen dobbel effekt. Utenfor vinduet: `submit_window_expired_reconcile_required` | Sjekk leverandørens dashbord (Stripe: Payments/Refunds, Vipps-portalen) FØR gjenopptakelse. Utenfor 23 t: bekreft hos leverandøren, deretter manuell disposisjon (se under) |
| Fiken, Neonomics (ingen Idempotency-Key) | **Aldri** automatisk gjenopptakelse (`submit_outcome_unknown_reconcile_required`) | Fiken: søk i Fiken etter markøren `[J:<12 tegn>]` (står i bilagsteksten; de 12 tegnene er starten på intensjons-id-en etter `fin-pi-`). Finnes bilaget: det er postert - ikke send på nytt. Neonomics: sjekk betalingsstatus hos banken |

**Manuell disposisjon (ikke bygget som verktøy - bevisst):** tilstandsmaskinen tillater kun `submitted -> provider_acknowledged|failed`, og det finnes ingen verktøyhandling som setter leverandør-ID/utfall etter et ukjent utfall (en slik handling ville la en påstand overstyre pengesannheten). Inntil et eget, step-up-bundet `resolve_submit_outcome` er besluttet (se «Åpne spørsmål» i sluttrapporten) gjør eieren/operatøren dispositionen direkte i databasen som admin-rolle, etter å ha verifisert hos leverandøren, og dokumenterer den i `payment_intent_events`. ALDRI opprett en ny intensjon for samme betaling før den første er bekreftet ikke-gjennomført.

Avstemmingen (§6) viser alle slike intensjoner som `submit_outcome_unknown`, og - for Fiken - finner bilaget igjen via markøren (`fiken_posting_unlinked`, «utfallet kan avklares») når Fiken-lesing er aktiv.

## 5. Aktivering per leverandør (alle `BLOCKED_EXTERNAL` til eieren leverer credentials)

Uten credentials er alt dormant: handlingene gir `credential_unavailable` (fail-closed), sveipene er no-op, webhook-ruter gir `503 not_configured`. Verdier legges i `.env` / SOPS - **aldri** i kode, logger eller chat.

| Leverandør | Variabler (se `.env.example`) | Webhook (eier registrerer hos leverandøren) | Eierhandling |
|---|---|---|---|
| Fiken | `JARVIS_FIKEN_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN`, `_COMPANY_SLUG` | - | Kjør `fiken-reauth.ts` (OAuth) og velg firma |
| Stripe | `JARVIS_STRIPE_SECRET_KEY`, `JARVIS_STRIPE_WEBHOOK_SECRET`, `JARVIS_STRIPE_TENANT_ID` (test: `JARVIS_STRIPE_TEST_SECRET_KEY`) | `POST /webhooks/stripe` (`Stripe-Signature`, toleranse 300 s) | Opprett webhook-endepunkt i Stripe Dashboard |
| Vipps | `JARVIS_VIPPS_CLIENT_ID`, `_CLIENT_SECRET`, `_SUBSCRIPTION_KEY`, `_MSN`, `_ENVIRONMENT`, `_WEBHOOK_SECRET`, `_TENANT_ID` | `POST /webhooks/vipps` (HMAC over metode/sti/dato/vert/innholds-hash) | Registrer webhook i Vipps-portalen (gir hemmeligheten) |
| Neonomics | `JARVIS_NEONOMICS_CLIENT_ID`, `_CLIENT_SECRET`, `_DEVICE_ID`, `_ENVIRONMENT`, `_REALM`, `_WEBHOOK_API_KEY`, `_TENANT_ID` | `POST /webhooks/neonomics` (header `x-api-key`) | Merchant-portalen; BankID/SCA hos banken er en menneskelig handling |
| Wallester | `JARVIS_WALLESTER_ACCOUNT_ID`, `_API_BASE_URL`, `_API_KEY`, `_PRIVATE_KEY_PEM`, `_ENVIRONMENT`, `_WEBHOOK_BASIC_USER`, `_WEBHOOK_BASIC_PASSWORD`, `_TENANT_ID` | `POST /webhooks/wallester` (Basic-auth) | KYC/avtale hos Wallester. **Enhet for `amount` (minste enhet vs. desimal) er ikke verifisert mot primærkilden** - et desimalt beløp AVVISES (ikke feilskalert) |

Valgfritt: `JARVIS_FINANCE_RECONCILE_HOUR` (standard 5), `JARVIS_STRIPE_SYNC_HOUR`, `JARVIS_VIPPS_SYNC_HOUR`, `JARVIS_NEONOMICS_SYNC_HOUR` (3), `JARVIS_FINANCE_SPEND_SWEEP_HOUR` (4), `JARVIS_WALLESTER_SYNC_HOUR` (5).

## 6. Avstemming (`finance-reconcile-sweep`, `finance.get_reconciliation_status`)

Daglig kl. 5 (etter leverandørsynkene, før open-loop-sveipet). **Observasjon + varsel - aldri korreksjon.** Eneste skriving utenfor funn-/kjøringstabellene er avviksflagget `RECONCILE_<ART>` på selve intensjonen (settes/fjernes av avstemmingen, rører ikke andre flagg) som den eksisterende open-loop-flaten (`payment_intent_anomaly`, også for oppgjorte/feilede/kansellerte intensjoner) viser.

| Funn (`kind`) | Alvor | Betyr |
|---|---|---|
| `provider_amount_mismatch` / `provider_currency_mismatch` | critical | Leverandøren oppgir et annet beløp/en annen valuta enn intensjonen |
| `provider_ref_missing` | critical | `provider_acknowledged`/`settled` uten leverandør-ID |
| `submit_outcome_unknown` | critical | Innsending med ukjent utfall (flagg eller reservasjon eldre enn leasen) - se §4 |
| `over_refunded` / `over_captured` | critical | Aktive refusjoner/captures overstiger betalingen |
| `possible_duplicate_payment` | warning | To sendte intensjoner mot samme leverandør/beløp/valuta innen 24 t |
| `webhook_rejected` / `webhook_unprocessed` | warning | Avvist (permanent ugyldig) eller hengende leverandørhendelse |
| `settled_unreconciled` | info | Oppgjort > 7 dager uten avstemming |
| `fiken_posting_unlinked` | critical/warning | Fiken-bilag med Jarvis-markør uten kjent intensjon, to bilag for én intensjon, bilag for en usendt intensjon, eller intensjon uten bilags-ID der Fiken har bilaget |
| `fiken_posting_mismatch` | critical | Bokført beløp i Fiken avviker (kun når Fiken oppgir linjene) |
| `fiken_posting_missing` | critical | Bekreftet intensjon peker på et bilag som ikke finnes - **kun med bevist komplett Fiken-liste** |

Rapporten (`finance.get_reconciliation_status`, klasse A; for eieren: `POST /finance/actions` med `{ "grant_token": "<grant>", "action": "reconciliation_status", "parameters": {} }` - samme eier-/step-up-regler, ren lesing, tenant fra grantet) viser siste kjøring med `checks`: `local: ok`, og `fiken`: `ok` / `incomplete` (listen er ikke bevist komplett) / `skipped_no_credentials` / `skipped_not_configured` / `failed:<kode>`. Dormant er aldri «grønt». Nye/gjenåpnede funn varsles én gang på Telegram; et funn lukkes først når betingelsen ikke lenger er sann i en kjøring der sjekken faktisk kjørte.

**Fiken er ikke verifisert** (se §9): leseren melder alltid `complete:false` inntil pagineringen er verifisert mot Fikens primærdokumentasjon. Fiken-bilaget får en kort markør `[J:...]` i beskrivelsen (avkortet til 140 tegn) så bilag kan knyttes til intensjon.

## 7. Webhooks

* Signatur/autentisering FØR noe lagres: Stripe (`t=...,v1=...` HMAC + 300 s toleranse), Vipps (HMAC + innholds-hash; **ingen tidsvindu** fordi Vipps' retry er lengre enn et trygt replay-vindu), Neonomics (`x-api-key`), Wallester (Basic). Ugyldig signatur/autentisering gir `400 invalid_signature` (Stripe) eller `401` (Vipps, Neonomics, Wallester), og ingenting lagres.
* **Replay:** hendelsesnøkkel (`evt_...` / idempotensnøkkel / betalings-id+status) er primærnøkkel - samme hendelse igjen = `duplicate`, aldri anvendt to ganger; en eldre hendelse overskriver aldri nyere tilstand (ordens-vokter per leverandør, ISO 20022-rangering for Neonomics).
* **Innhold er ubetrodd data:** strengt heltall i minste enhet (NaN/Infinity/negative/brøk/for stort avvises), trygge id-er, gyldig dato (2000-2100), tre-bokstavs valuta; ingen `Number()`-coercion, ingen «EUR»-standard.
* Permanent ugyldig innhold lagres som dødbrev `rejected` (kort årsakskode, aldri innholdet; ikke-identifiserbar nyttelast under `malformed:<sha256>`) og besvares **200** - ingen evig retry. `failed_retryable` = **502** (leverandøren prøver igjen; retry behandler hendelsen på nytt). Tilstanden hentes uansett inn igjen av den planlagte oppfriskingen.

## 8. Verifisering (hva er bevist, hva må eieren kjøre)

**Bevist her (sandbox, ingen nettverk, testdobler for leverandørene):** `npx vitest run modules/finance modules/tool-gateway modules/erasure modules/business apps/api/test` + `tsc --noEmit` per pakke, `eslint`, `node ops/security/check-containment.mjs`, `gitleaks protect --staged`. Se sluttrapporten for resultater.

**IKKE verifisert mot ekte leverandør (kommandoer eieren kjører):**
1. Stripe testmodus, hele den nye kjeden: sett `JARVIS_STRIPE_TEST_SECRET_KEY` og kjør
   `node --env-file=.env --experimental-transform-types modules/finance/scripts/stripe-real-payment-acceptance-host-run.ts`
   (bruker aldri live-nøkkelen; skriptet er justert for per-provider credential og kjøre-unike leverandørnavn, men er IKKE kjørt etter WP-F1). Kjør deretter eierveien i §2 mot en testintensjon og bekreft Telegram-varselet.
2. Fiken: `modules/finance/scripts/fiken-live-host-run.ts` (poster en PERMANENT regnskapspost kun med `JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE=true`). Verifiser i tillegg (a) hva `POST /generalJournalEntries` faktisk returnerer (JSON-kropp eller kun `Location`-header) og (b) pagineringen på `GET /journalEntries` - se §9.
3. Vipps/Neonomics/Wallester: `*-live-host-run.ts` (kun dormant wiring-bevis uten credentials; ekte verifisering krever egne konti).

## 9. Kjente begrensninger og DEFERRED (ærlig)

* **`mcp_zapier.call_tool` - forblir DEFERRED.** Handlingen er per D-350 en vilkårlig, dynamisk oppdaget Zapier-handling: Jarvis kan ikke vite hva et gitt verktøy gjør, og det finnes ingen deterministisk fersk lesing, målvalidering eller readback som beviser at «riktig ting skjedde». Uten dem er kjeden ikke komplett (regel 2/11: ikke-implementert kapabilitet merkes DEFERRED, aldri stille utelatt).
* **`microsoft_outlook.send_mail` - forblir DEFERRED.** Graph `sendMail` returnerer 202 uten melding-ID. Utkast-først-mønsteret (opprett utkast med egendefinert `x-`-header -> send utkastet -> les Sent Items) er den riktige veien, og offisiell Graph-dokumentasjon (via søk; direkte henting var blokkert) bekrefter: `POST /me/messages` støtter `internetMessageHeaders` (kun ved opprettelse, `x-`-prefiks), `POST /me/messages/{id}/send` gir 202 uten kropp og er asynkron (kopien i Sent Items kan komme sent), og `Prefer: IdType="ImmutableId"` finnes. **Men:** dokumentasjonen er selvmotsigende om meldings-ID-en overlever sending, og når `internetMessageId` tildeles på et utkast er ikke dokumentert - begge må verifiseres mot en ekte tenant før postcondition kan bygges. Ingen ekte Outlook-konto finnes her.
* **Fiken API-form er ikke verifisert:** `POST /generalJournalEntries` kan returnere JSON med `journalEntryId` eller kun `Location` uten kropp. Transporten tolker begge konservativt (id fra kroppen, ellers fra en `Location` som ender på `/journalEntries/<tall>` eller `/generalJournalEntries/<tall>`); uten sikker id er utfallet UKJENT (`outcome_unknown:`, §4) - aldri en gjettet id og aldri en ny postering. Paginering på `GET /journalEntries` er ikke bekreftet (header- eller parameterbasert), og vi vet ikke om svaret bærer posteringslinjer. `generalJournalEntries` har ingen Idempotency-Key.
* **Ingen verktøy for manuell disposisjon av ukjent utfall** (§4) - bevisst; forslag til `resolve_submit_outcome` (step-up, bundet, med bevis-tekst og revisjonsspor) ligger som åpent spørsmål.
* Vipps: ingen tidsvindu på `x-ms-date` (replay stoppes av dedupe + ordens-vokter). Vipps' idempotensvindu er ikke verifisert (behandles konservativt som 23 t).
* Wallester: beløpsenhet og webhook-skjema ikke verifisert mot primærkilden; strengt avvisende.
* Pengekolonnene er uforanderlige (migrasjon 101): en feil rettes ved å kansellere og opprette en NY intensjon. Fixtures som må tvinge en tilstand bruker `ALTER TABLE ... DISABLE TRIGGER` som tabelleier (appen kan ikke).
* Ingen interne beløpsgrenser i Sovereign Mode (budsjetter/caps er valgfri eier-policy, uendret). Formatgrensen `MAX_AMOUNT_MINOR_UNITS` (10 mrd. i hovedenhet) er en numerisk sikkerhetsgrense, ikke policy.

## 10. Feilsøking

* «Ingenting skjer ved godkjenning»: bekreftelsen er utløpt (5 min) eller allerede brukt (404) - be om en ny.
* `403 step_up_required:*`: bruk en signert enhetsøkt fra web/desktop/api/mobile.
* `409 not_submittable`: les `reason` i §3; `bound_*` betyr at beløp/valuta/mottaker er endret siden forhåndsvisningen - be om ny forhåndsvisning og kontroller hvorfor raden er endret.
* `credential_unavailable`: leverandørens credential mangler (§5); `class_d_notifier_not_ready`: Telegram-token/chat-id mangler (klasse D er da utilgjengelig - fail-closed).
* Funn i avstemmingen: `finance.get_reconciliation_status`; åpne loops i attention-køen (`payment_intent_anomaly`).
