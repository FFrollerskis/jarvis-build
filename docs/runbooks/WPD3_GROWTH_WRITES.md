# WP-D3 (D-459) - UA-4 Growth: skrivehandlinger, eksperimentregister og kreativ-intelligens

**Status: BYGGET, SOVENDE (AV som standard), IKKE VERIFISERT mot noen ekte plattform.** Alt under er testet mot lokale, falske leverandører (embedded Postgres + ekte `ToolGateway`); ingen ekte nettkall er gjort. Ingenting her er `VERIFIED` - det krever en kjøring på NAS mot sandkasse-/testkontoer (se «NAS-verifisering»).

Personvern: `docs/UA4_GROWTH_DPIA.md` (UTKAST, ikke juridisk gjennomgått) og `docs/security/PROCESSING_INVENTORY.md` (avsnittet «Vekst: eksperimentregister og plattform-skrivejournal»).

## 1. Hva er bygget (statusord)

| Kapabilitet | Status | Merknad |
|---|---|---|
| Skrivehandlinger mot Google Ads (14 skriv + 4 les) | DORMANT | `growth_googleads`; flagg `JARVIS_GROWTH_WRITE_PLATFORMS` |
| Skrivehandlinger mot Meta Ads (10 skriv + 4 les) | DORMANT | `growth_metaads` |
| GA4 nøkkelhendelser (2 skriv + 2 les) | DORMANT | `growth_ga4` |
| Search Console (2 skriv + 3 les) | DORMANT | `growth_searchconsole` |
| Google Business Profile (5 skriv + 3 les) | DORMANT / BLOCKED_EXTERNAL | `growth_gbp`; API-tilgang må godkjennes av Google |
| YouTube (3 skriv + 1 les) | DORMANT | `growth_youtube`; opplasting DEFERRED |
| LinkedIn Ads (3 skriv + 1 les) | DORMANT / BLOCKED_EXTERNAL | `growth_linkedin`; Marketing Developer Platform-godkjenning |
| TikTok Ads (4 skriv + 1 les) | DORMANT / BLOCKED_EXTERNAL | `growth_tiktok`; sti/felt UVERIFISERT |
| Skrivejournal `growth_write_journal` (før/etter, utfall, proveniens) | WIRED (når flagg på) | migrasjon 113 |
| Eksperimentregister v2 (plan, varianter, observasjoner, utfall) | DORMANT | `JARVIS_GROWTH_EXPERIMENTS=on`; migrasjon 112-113 |
| Kreativ-intelligens (rangering, utmattelse, lint) og statistikk | BUILT (rene funksjoner) | ingen eksterne kall; nås via `growth.*`-verktøyene |
| Attribusjon spend -> klikk -> lead -> møte -> kunde -> omsetning | PARTIAL | koblingspunkter bygget (se §8); resten DEFERRED |
| `executed` på utførelses-kommando (D-87) | WIRED (kun med bevis) | migrasjon 114; kun via `/growth/mutate` med `command_id` |
| Dashbord-registrering av de seks nye plattformene (CONNECTOR_REGISTRY, live-test, manifest) | DEFERRED | nye connectorer krever fullt manifest (WP-I-vakten); se §10 |

**Brukerflate:** kun eier-rutene `/growth/mutate`, `/growth/read`, `/growth/writes/list`, `/growth/experiments` (404 når flagg er av). INGEN av de nye verktøyene står på noen modellflate (chat/tale/Telegram/bakgrunn) - navnerommene `growth_*` står i `OWNER_ONLY_NAMESPACES` og `FORBIDDEN_MODEL_TOOL_IDS`, og en test låser at ingen flate har dem.

## 2. Flagg og konfigurasjon

Alle flagg er AV som standard. Med alle flagg av er verktøylister, intents, rate-grenser og ruter identiske med main (`JARVIS_GROWTH_*` tomme = ingen verktøy registrert, `deps.growthWrites` finnes ikke = 404).

| Variabel | Standard | Virkning |
|---|---|---|
| `JARVIS_GROWTH_WRITE_PLATFORMS` | tom | Kommaseparert: `google_ads, meta_ads, ga4, search_console, google_business_profile, linkedin, youtube, tiktok`. Kun listede plattformer får verktøy. |
| `JARVIS_GROWTH_WRITE_TARGETS` | tom | EKSAKT liste over eierens EGNE konto-/eiendoms-id-er: `<plattform>:<id>`, kommaseparert (`google_ads:123-456-7890,meta_ads:act_123...`). Ingen jokertegn; ugyldige oppføringer hoppes over. Tom = ingen skriving og ingen lesing. **Akseptanse/test: legg KUN inn sandkasse-/testkontoer** (blast radius). |
| `JARVIS_GROWTH_CREATIVE_URL_HOSTS` | tom | EKSAKTE vertsnavn en annonse-/profil-/innleggslenke kan peke til. Uten treff avvises kreativen (forsvar mot at ubetrodd tekst omdirigerer trafikk). |
| `JARVIS_GROWTH_EXPERIMENTS` | tom | `on` registrerer eksperiment-/kreativ-verktøyene (`growth.set_experiment_plan` m.fl.) og `/growth/experiments`. |
| `JARVIS_GOOGLE_ADS_API_VERSION`, `JARVIS_META_ADS_API_VERSION`, `JARVIS_LINKEDIN_API_VERSION` | `v25` / `v26.0` / `202601` | Leverandørens API-versjon (valideres mot et strengt mønster). |

**Credentials (kun vault-referanser, aldri i kode/fixtures/logger):** `JARVIS_GOOGLE_ADS_REFRESH_TOKEN` + `JARVIS_GOOGLE_ADS_DEVELOPER_TOKEN` (+ valgfri `JARVIS_GOOGLE_ADS_LOGIN_CUSTOMER_ID`), `JARVIS_META_ADS_ACCESS_TOKEN` (eksisterende lese-connectorer gjenbrukes), og NYE: `JARVIS_GOOGLE_ANALYTICS_REFRESH_TOKEN`, `JARVIS_GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN`, `JARVIS_GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN`, `JARVIS_YOUTUBE_REFRESH_TOKEN`, `JARVIS_LINKEDIN_ACCESS_TOKEN`, `JARVIS_TIKTOK_ACCESS_TOKEN`. Hver Google-tjeneste har sitt EGET refresh-token (eget samtykke/scope) - aldri ett token med alle scopes. Credential-refer er ikke-interne og dermed bundet til eieren (`credential_not_bound_to_identity` for alle andre).

Variablene står i `.env.example`, `SERVICE_ENV.api` (`infra/local/service-env.mjs`) og er regenerert i `infra/local/docker-compose.yml`. Kun API-prosessen registrerer verktøyene (worker/bakgrunn er read-only).

## 3. Autoritet og sikkerhetsmodell

Hver skrivehandling går UTELUKKENDE via `ToolGateway.execute()` (`modules/growth/src/write/tool-factory.ts`); eksekutoren (`executor.ts`) dupliserer ingen sjekk og har ingen direkte transportvei. Kjeden i rekkefølge:

1. **Eier-binding og eier-eksklusiv:** kun den autentiserte eieren i eierens tenant (delegat/annen person: `credential_not_bound_to_identity`).
2. **Policy Gateway** (kill switch, frys, credential-tilbakekall).
3. **Mål-autorisasjon** (`parameterAuthorizer`): kontoen/eiendommen MÅ stå eksakt i `JARVIS_GROWTH_WRITE_TARGETS` (`growth_target_not_authorized` / `missing_or_invalid_target`) - også for lesing. Leverandørobjekter som tilhører en annen konto leses som «ikke funnet».
4. **Step-up** (`step_up_required`): enhetssignert økt fra en eier-kanal (web/desktop/api/mobile) for ALLE skrivehandlinger (klasse C og D) - strengeste standard (Q-55). Se «Åpne spørsmål» om å lempe for `pause_*`.
5. **Klasse D-kjeden:** påkrevd idempotensnøkkel, klar varsler (Telegram), fersk tilstandslesing (`preflight_action`), målvalidering, deterministisk validator med spesifikk årsak, ledger-reservasjon, mutasjon, readback og `postcondition_predicate`, umiddelbart eier-varsel (utført / ukjent / ikke verifisert), `rollback_procedure` per handling.
6. **Transporten** leser tilstanden på nytt og kjører SAMME validator rett før mutasjonen (forsvar i dybden), mutér, leser tilbake og verifiserer. Mismatch/readback-feil = `outcome_unknown` (UTFALL UKJENT), aldri «ok».
7. **Journal** (`growth_write_journal`): én rad per forespørsel med digest, før/etter-tilstand (redigert og begrenset), utfall, proveniens (person/tenant/memory space/kilde/`task_id`/`session_id`). Samme nøkkel + samme forespørsel = samme rad; samme nøkkel for noe annet = `growth_write_idempotency_conflict`.

**Risikoklasser (A-D styrer HVORDAN, ikke OM eieren har kapabiliteten - D-41):**
- `pause_*` = C (reduserer utgift, reverserbar). `enable_*` kampanje/annonsegruppe/annonse = D (STARTER utgift). `enable_keyword`/`add_keywords`/`create_*` kreativer = C (opprettes PAUSET; utgift avgrenses av budsjettet).
- Budsjett-/budhandlinger = D (retningsbestemt). `remove_/delete_*` av kampanje/video = D, ikke reverserbar.
- Konfigurasjon uten utgift (nøkkelhendelse, nettstedskart, åpningstider, profil, innlegg, omtale-svar, videometadata/-synlighet) = C.

**Finans-nødbryter (UA-6 «finance kill switch stops new transactions») - IKKE et beløpstak:** handlinger som ØKER eller STARTER utgift (`enable_*`, budsjett/bud OPP, ENABLED-nøkkelord) nektes mens eierens nødbryter er PÅ og når tilstanden er UKJENT (probe feiler = fail-closed). Å redusere/pause er alltid tillatt. Finance Integrity Gateway brukes til revisjon/avstemming, ikke som obligatorisk beløpstak (D-41/UA-6); eierens sovereign-modus er uendret og det finnes ingen kunstig godkjenningssperre utover step-up.

**Ubetrodd innhold (regel 7):** kampanje-/annonse-/omtale-/søkeordstekst fra leverandøren er DATA: all leverandørtekst i tilstand er kontrolltegn-renset og lengdebegrenset (`cleanText`), merket `output_trust: untrusted` ved lesing, redigert for hemmeligheter og begrenset (dybde/lengde) før journalføring; ingen tilstandsverdi velger mål, parameter eller handling. Kreativers mål-URL må stå i verts-allowlisten. Anmelderes navn leses aldri.

**Hemmeligheter:** credential og access token havner aldri i URL (Meta/LinkedIn/TikTok bruker header; Google Bearer), aldri i feilmeldinger (kjente verdier vaskes, deretter den sentrale skanneren), aldri i journal/utdata.

## 4. Datamodell (migrasjon 112-114)

- **112** `marketing_experiment_plans`, `marketing_experiment_variants` (én kontroll per eksperiment), `marketing_experiment_observations` (UNIQUE variant/dato/kilde), `UNIQUE (tenant_id, experiment_id)`, utvidede hendelsestyper.
- **113** `marketing_experiment_outcomes` (append-only; vinner kun ved verdikt `winner`; unik på evalueringsdigest), `growth_write_journal` (trigger: uforanderlige kjernekolonner, lovlige overganger, terminale statuser), `UNIQUE (tenant_id, command_id)`.
- **114** `marketing_campaign_execution_commands`: `executed`/`execution_unknown`, `executed_at`, `execution_write_id`; databasevakt: `executed` krever en `applied` journalrad for SAMME kampanje, og er deretter uforanderlig. (Den strukturelle Finance Integrity-grensen fra D-87 er hevet KUN med bevis.)
- Alle tabeller: `tenant_id`, FORCE RLS (tenant + RESTRICTIVE memory space), sammensatte FK-er, proveniens på hver rad, registrert i slettplanen (`modules/erasure/src/plan.ts`).

## 5. Ruter (alle eier-eksklusive; 404 når flagg er av)

| Rute | Handling |
|---|---|
| `POST /growth/mutate` | `{provider, action, parameters, idempotency_key, command_id?, experiment_id?, variant_id?}` -> journalrad med utfall `SUCCESS`/`NOOP`/`UNKNOWN`/`PARTIAL`/`FAILED`. Eier + step-up. `command_id` binder en `reduce_budget`-kommando (kun kampanjenivå-budsjett; beløpet MÅ være kommandoens). |
| `POST /growth/read` | `{provider, action, parameters}` -> klasse A-lesing (ubetrodde data, merket). |
| `POST /growth/writes/list` | journalen (filtre: `campaign_id`, `status`, `provider`, `limit`). |
| `POST /growth/experiments` | `{action, parameters, idempotency_key?}` -> eksperimentregister/kreativ-intelligens (`growth.*`); skriving krever step-up. |

## 6. D-41 kapabilitetsrevisjon per connector

Kilder: kun `WebSearch` (WebFetch mot leverandørenes dokumentasjon var blokkert i hele bygget). **`VERIFIED_OFFICIAL_SEARCH_SNIPPET`** = flere uavhengige søketreff mot leverandørens egne sider; **`UNVERIFIED`** = ikke bekreftet mot primærkilde (må prøves i sandkasse FØR flagget slås på). Ingen scope er gjettet: der scope ikke er bekreftet står det.

| Connector | Leverandør tilbyr (relevant) | Bygget (les / skriv; klasse) | Scopes / tilgang (verifisering) | Gap (DEFERRED/PARTIAL) |
|---|---|---|---|---|
| Google Ads | REST `:mutate` (create/update+updateMask/remove, atomisk), GAQL; ingen idempotensnøkkel; `REMOVED` terminal; testkonto -> Basic (15 000 ops/dag) -> Standard | 4 les / 14 skriv (8 C, 6 D): budsjett, kampanje/annonsegruppe/annonse pause/aktiver, fjern kampanje, ad group-bud, nøkkelord (inkl. negative) legg til/aktiver/pause/fjern, RSA opprett PAUSET | OAuth `adwords` (kjent, UNVERIFIED i denne økten) + developer token; tilgangsnivåer VERIFIED_OFFICIAL_SEARCH_SNIPPET; `updateMask` camelCase og RSA-grenser (30/90/15) UNVERIFIED | kampanje-/budsjett-opprettelse, delt budsjett (nektes), budstrategi-bytte, RSA-tekstendring (`ads:mutate` ikke verifisert), kampanjenivå-negative nøkkelord, offline-konvertering, kontotilgang (tilgangsstyring) |
| Meta Ads | Graph `POST /{id}` (status/budsjett/bud), `POST act_{konto}/ads`, status ACTIVE/PAUSED/DELETED/ARCHIVED | 4 les / 10 skriv (4 C, 6 D): kampanje/annonsesett/annonse pause/aktiver, slett kampanje, annonsesett dagsbudsjett + bud, opprett PAUSET lenkeannonse | `ads_management` (Standard Access for EGEN konto; Advanced Access/forretningsverifisering for andres) VERIFIED_OFFICIAL_SEARCH_SNIPPET; header-form (`Authorization: Bearer`) UNVERIFIED | kampanje-/annonsesett-opprettelse, livstids-/CBO-budsjett, bilde/video, målgrupper, Conversions API, `assigned_users` (tilgangsstyring), null-desimal-valutaer (nektes) |
| GA4 (Admin API v1beta) | `keyEvents` create/delete/get/list/patch | 2 les / 2 skriv (C): opprett/slett nøkkelhendelse | `analytics.edit` for create/delete VERIFIED_OFFICIAL_SEARCH_SNIPPET; patch-scope UNVERIFIED; `analytics.manage.users` (accessBindings) UNVERIFIED for enkelt-create | patch av tellemetode, egendefinerte dimensjoner/metrikker, datastrømmer, Measurement Protocol (samtykke/JARVIS-084), målgrupper, Ads-lenking, `accessBindings` (v1alpha) |
| Search Console | `sitemaps` PUT/DELETE/list, `searchAnalytics.query`, `urlInspection.index.inspect` (2000/dag per nettsted) | 3 les / 2 skriv (C): registrer/fjern nettstedskart | `webmasters` (UNVERIFIED i denne økten); kvoter VERIFIED_OFFICIAL_SEARCH_SNIPPET | `sites.add`/`sites.delete` (eierskap/verifisering har egen flyt), brukertilgang |
| Business Profile | Business Information v1 `PATCH` (updateMask), v4 `localPosts`/`reviews.reply`; Account Management `admins` | 3 les / 5 skriv (C): åpningstider, profil (beskrivelse/nettsted), lokalt innlegg, svar på omtale, slett svar | `business.manage` delvis VERIFIED_OFFICIAL_SEARCH_SNIPPET; **API-tilgang krever Googles godkjenning (kvote 0 til den er innvilget) = BLOCKED_EXTERNAL**; feltnavn UNVERIFIED | lokasjonsopprettelse/-sletting, kategorier, attributter, medier, spørsmål/svar, verifisering, `admins` (tilgangsstyring; roller ikke bekreftet), slett lokalt innlegg |
| YouTube Data v3 | `videos.update` (50 enheter), `videos.delete` (50), `videos.insert` | 1 les / 3 skriv (2 C, 1 D): metadata, synlighet, slett video | `youtube.force-ssl` UNVERIFIED; kvote 10 000/dag VERIFIED_OFFICIAL_SEARCH_SNIPPET; uverifiserte API-prosjekter låser opplastinger til private (revisjon) | opplasting (`videos.insert`, resumable media + revisjon = BLOCKED_EXTERNAL), miniatyr, spillelister, kommentar-moderering |
| LinkedIn Ads | `/rest/adAccounts/{id}/adCampaigns/{id}` PARTIAL_UPDATE (`patch.$set`), `LinkedIn-Version`-header | 1 les / 3 skriv (1 C, 2 D): pause/aktiver, dagsbudsjett | `rw_ads` UNVERIFIED; Marketing Developer Platform-godkjenning (utvikling -> standard) VERIFIED_OFFICIAL_SEARCH_SNIPPET = BLOCKED_EXTERNAL; `w_organization_social` krever egen godkjenning | kampanje-/kampanjegruppe-opprettelse, kreativer, målgrupper, `totalBudget`, organiske poster, konvertering, `adAccountUsers` |
| TikTok Ads | Marketing API v1.3 `campaign/status/update` (ENABLE/DISABLE/DELETE), `campaign/update` (budsjett) | 1 les / 4 skriv (1 C, 3 D): pause/aktiver/slett, budsjett | sti-konflikt mellom kilder og budsjettfelt UNVERIFIED; app-godkjenning + annonsør-autorisasjon = BLOCKED_EXTERNAL; Content Posting `video.publish`: ureviderte klienter låses til private | annonsegruppe/annonse, kampanjeopprettelse, kreativer, Events API, Content Posting (revisjon 2-6 uker), tilgangsstyring |

**Eier-/delegert-oppførsel (alle):** kun eieren (Sovereign) - delegat/gjest/annen tenant nektes av eier-bindingen; ingen kunstig godkjenningssperre for eier utover step-up. **Idempotens:** ingen av leverandørene tilbyr idempotensnøkkel; Jarvis bruker absolutt-tilstand-oppdateringer, tilstandslesing før skriving, dedup av opprettelser (nøkkelord/RSA/annonse på navn/innlegg på tekst), readback og ledger. **Test-sandbox:** Google Ads testkonto (developer token med testtilgang), Meta testannonsekonto, øvrige: egne testeiendommer/-kanaler; legg KUN dem i `JARVIS_GROWTH_WRITE_TARGETS` under aksept.

## 7. «Utfall ukjent» (`outcome_unknown`) og avstemming

En 5xx/uleselig 2xx-respons ETTER en akseptert mutasjon, en readback som ikke bekrefter, eller et tidsavbrudd kastes som `outcome_unknown:...` (felles hjelper `afterAcceptedMutation`). Gatewayen merker ledger-raden `unverified` (aldri retry-bar med samme nøkkel), eieren varsles umiddelbart ("UTFALL UKJENT - sjekk hos leverandøren"), journalen står som `outcome_unknown`. En retry med samme nøkkel sender ALDRI en ny mutasjon. Eieren sjekker hos leverandøren og bruker en NY nøkkel for et nytt forsøk. Automatisk avstemming av `outcome_unknown`/`execution_unknown` er DEFERRED (journalen tillater overgang til `applied`/`failed`).

## 8. Attribusjon: koblingspunkter

| Ledd | Status |
|---|---|
| Spend, klikk, visninger per dag -> `marketing_spend_events` | WIRED (eksisterende lese-synk, D-83/D-335) |
| Klikk-ID (gclid) -> kampanje (`marketing_campaign_tracking_tags`) | WIRED (eksisterende, Google Ads); fbclid DEFERRED (ingen verifisert kilde) |
| Lead/møte/kunde -> kampanje (`marketing_attributions`, Business OS/WP-D2) | WIRED (eksisterende) |
| Omsetning (vunnet mulighet i øre) -> variant/kampanje | BUILT: `deriveObservationsFromCampaign` utleder observasjoner fra spend, attribusjoner og vunne muligheter |
| Budsjett-etterlevelse (journalførte endringer vs faktisk daglig utgift) | BUILT_UNWIRED: ren funksjon `budgetAdherence`; ingen leseaksjon ennå |
| Annonse-/variantnivå-synk (ad-nivå spend) | DEFERRED |
| Offline-konverteringsopplasting, GA4 Measurement Protocol, Meta Conversions API | DEFERRED (personopplysninger + samtykke; JARVIS-084 er utenfor omfang) |
| Systemidentitet (autonom utførelse uten step-up) | DEFERRED (egen beslutning) |

## 9. NAS-/sandbox-verifisering (steg for steg) - ALT `NOT VERIFIED`

Forutsetninger: testkonto/testeiendom per plattform du vil prøve (se §6 «Test-sandbox»), credentials lagt i hvelvet, `JARVIS_GROWTH_WRITE_TARGETS` inneholder KUN testkontoene.

1. **Flagg av = main:** med alle `JARVIS_GROWTH_*` tomme: `POST /growth/mutate` svarer 404 og `executive.get_capability_status` viser ingen `growth_*`-verktøy. `NOT VERIFIED`.
2. **Slå på ÉN plattform:** sett `JARVIS_GROWTH_WRITE_PLATFORMS=google_ads`, `JARVIS_GROWTH_WRITE_TARGETS=google_ads:<testkonto>`, `JARVIS_GROWTH_CREATIVE_URL_HOSTS=<testvert>`; `docker compose up -d api`. Loggen skal vise `growth_writes` med plattform og antall mål (aldri id-er/hemmeligheter). `NOT VERIFIED`.
3. **Les:** `/growth/read` `google_ads.get_campaign_state` på en testkampanje - bekreft felt og at utdata er merket `untrusted`. `NOT VERIFIED`.
4. **Budsjett NED (klasse D):** fra dashbordets enhetssignerte økt `/growth/mutate` `set_campaign_budget` (+ `idempotency_key`). Forvent Telegram-varsel «utført», journalrad `applied` med før/etter, og at beløpet stemmer i leverandørens grensesnitt (`updateMask`-formen verifiseres her). `NOT VERIFIED`.
5. **Replay:** samme nøkkel igjen: `replayed: true`, ingen ny endring hos leverandøren. `NOT VERIFIED`.
6. **Feil mål:** en konto som ikke står i listen: `growth_target_not_authorized` og ingen forespørsel til leverandøren. `NOT VERIFIED`.
7. **Nødbryter:** slå på finans-nødbryteren; budsjett OPP og `enable_*` nektes (`finance_kill_switch_active_or_unknown`), NED og `pause_*` virker. `NOT VERIFIED`.
8. **Pause/aktiver-syklus** og **nøkkelord/RSA (PAUSET)** på testkampanjen; bekreft at RSA/annonse aldri opprettes aktiv. `NOT VERIFIED`.
9. **Utførelses-kommando:** generer en `reduce_budget`-kommando på en koblet testkampanje, utfør med `command_id`: kommandoen blir `executed` med `execution_write_id`. `NOT VERIFIED`.
10. **Gjenta 2-8 per øvrig plattform** (Meta: verifiser `Authorization: Bearer`-header og at `ads_management` er innvilget; TikTok: verifiser sti og budsjettfelt FØR bruk). `NOT VERIFIED`.
11. **Rollback:** tøm `JARVIS_GROWTH_WRITE_PLATFORMS` (og `JARVIS_GROWTH_EXPERIMENTS`), restart api: rutene gir 404 og verktøyene er borte. Journal og eksperimentdata beholdes (ingen sletting). `NOT VERIFIED`.

## 10. BLOCKED_EXTERNAL og åpne punkter

- **Google Ads developer token** (Basic-tilgang kreves for produksjonskontoer; fra 9. sept. 2026 knyttes tilgang til Google Cloud-prosjektet med merkevareverifisering) - eier må søke. Til da: kun testkonto.
- **Meta:** Standard Access holder for egen konto, men `ads_management`/forretningsverifisering må være gjennomført av eier.
- **Business Profile:** Googles godkjenning av API-tilgang (kvote 0 før). **LinkedIn:** Marketing Developer Platform-godkjenning. **TikTok:** developer-app-godkjenning + annonsør-autorisasjon. **YouTube-opplasting:** API-revisjon.
- **Dashbord-registrering** (CONNECTOR_REGISTRY + live-test + manifest) for de seks nye plattformene er DEFERRED: ny connector = fullt manifest (WP-I-vakten); hvelv-/miljøoppsett fungerer uten.
- **Retensjonstid for journalen** og **juridisk gjennomgang av DPIA** er eierbeslutninger.

## 11. Kjente begrensninger (UVERIFISERT)

`updateMask`-form (Google Ads), RSA-tegngrenser, Meta Bearer-header, TikTok-sti/felt, scope-navn merket UNVERIFIED i §6, `readMask`/feltnavn for Business Profile, `TimeOfDay` 24:00. Kun 2-desimal-valutaer støttes for Meta/LinkedIn/TikTok-budsjett (øvrige nektes: `currency_not_supported`); Google Ads bruker mikroenheter og er valutauavhengig. Journalens `spend_effect` er `unknown` for retningsbestemte handlinger (retningen står i før/etter).

## 12. Rollback (flagg av)

Tøm `JARVIS_GROWTH_WRITE_PLATFORMS` og `JARVIS_GROWTH_EXPERIMENTS`, restart api. Ingen data slettes; skrivinger som allerede er gjort hos leverandøren rulles tilbake manuelt etter `rollback_procedure` i journalens/varselets handling (før-tilstanden er journalført). Migrasjonene 112-114 er additive og trygge å la stå.

## 13. Tester og vakter (lokalt kjørt)

`modules/growth/test/wpd3-write-engine.test.ts` (konfig, mål-autorisasjon, HTTP-regler, definisjonsinvarianter for alle 8, forespørselsformer), `wpd3-write-chain-db.test.ts` (ekte `ToolGateway` + embedded Postgres + falsk Google Ads/Meta: kjede, step-up, nødbryter, idempotens, utfall ukjent, tenant-isolasjon, kommando-binding, injeksjon), `wpd3-experiment-*` (statistikk og register), samt eksisterende vakter (manifest, modellflate, flagg-AV-baseline, env-drift, slettedekning, prosesseringsinventar D-420).
