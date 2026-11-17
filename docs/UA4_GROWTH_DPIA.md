# UA-4 Growth - DPIA / personvernnotat for produksjonssporing og annonseskriving (WP-D3, D-459)

**Status: UTKAST. IKKE juridisk gjennomgått. IKKE godkjent av eier. Ingen databehandleravtale (DPA) er verifisert.** Dette er et arbeidsdokument som dokumenterer behandlingene UA-4 introduserer, hva som er bygget, hva som er bevisst IKKE bygget, og hva som må være på plass FØR produksjonssporing slås på (masterplanens akseptansekriterium «documented for production tracking»). Det er ikke juridisk rådgivning og erstatter ikke vurdering fra jurist/personvernombud.

Tilknyttede dokumenter: `docs/security/PROCESSING_INVENTORY.md` (maskinvakt D-420), `docs/runbooks/WPD3_GROWTH_WRITES.md` (drift/rollback/verifisering), `docs/security/DPIA_DRAFT.md` (generell), `docs/UA3_BUSINESS_DPIA.md` (CRM/kontakter), `docs/security/PROCESSOR_REGION_MATRIX.md`.

## 1. Omfang

**Dekket her:** (a) skrivehandlinger mot annonse-/analyseplattformene (Google Ads, Meta Ads, GA4, Search Console, Google Business Profile, YouTube, LinkedIn, TikTok) og Jarvis' journal over dem; (b) eksperimentregisteret og kreativ-intelligens; (c) attribusjon (annonseutgift -> klikk -> lead -> møte -> kunde -> omsetning) der den bruker data Jarvis allerede har; (d) hva produksjonssporing på eierens nettsteder krever.

**IKKE dekket / IKKE bygget (utenfor WP-D3):** samtykkekontroller (JARVIS-084, Q-47f), Telegram-juridiske punkter (JARVIS-087), installasjon av sporingskoder/piksler/cookies på nettsteder, server-til-server-sending av personopplysninger til plattformene (offline-konvertering, GA4 Measurement Protocol, Meta Conversions API), lokal agent med filtilgang (Q-60).

**Dormant:** alle skrivehandlinger er AV (`JARVIS_GROWTH_WRITE_PLATFORMS` tom) og kan kun nå eierens egne, eksplisitt listede konti (`JARVIS_GROWTH_WRITE_TARGETS`). Ingen skrivehandling er prøvd mot en ekte plattform.

## 2. Behandlingene

| Id | Behandling | Personopplysninger? | Hvor | Grunnlag/merknad |
|---|---|---|---|---|
| B1 | Skriving av budsjett/bud/status/nøkkelord/kreativer mot eierens egne annonsekontoer | Nei (konto-/kampanje-id-er, tall, annonsetekst eieren selv skriver) | Plattformene + `growth_write_journal` | Eierens egen virksomhet; ingen sluttbrukerdata sendes |
| B2 | Synk av utgift/klikk/visninger per kampanje og dag (eksisterende, D-83/D-335) | Nei (aggregert) | `marketing_spend_events` | Aggregerte tall |
| B3 | Klikk-ID (gclid/fbclid) og UTM knyttet til kampanje (eksisterende, D-82) | **Ja, pseudonym** (klikk-ID er en online-identifikator) | `marketing_campaign_tracking_tags` | Krever rettslig grunnlag + samtykke ved nettsporing (se §4) |
| B4 | Attribusjon lead/møte/kunde/omsetning -> kampanje (eksisterende, D-82/WP-D2) | **Ja** (kobler en kontakt/lead til en kampanje) | `marketing_attributions` + `business_*` | Berettiget interesse (B2B) vurderes; se UA-3-DPIA for kontaktdata |
| B5 | Eksperimentregister (plan, varianter, daglige observasjoner, utfall) | Nei (aggregert per variant/dag; ingen sluttbrukeridentifikatorer) | `marketing_experiment_*` | Forretningsdata |
| B6 | Business Profile: les omtaler (kun eierens visning) og svar på dem | **Ja, potensielt** (omtaletekst er brukerskrevet og kan inneholde personopplysninger, også helse; anmelders navn leses ALDRI) | `list_reviews` viser teksten kun til eieren og LAGRER den ikke. Skrivekjeden (`reply_to_review`, `delete_review_reply`) bruker `get_review` (ÉN omtale): kun omtale-id, stjerner, tidspunkt, om eieren har svart og en sha256-digest av svaret - aldri omtalens tekst, anmelders navn eller svarteksten, hverken i `growth_write_journal`, `tool_executions.before/after_state` eller `audit_events` | Dataminimering: ingen omtaletekst/navn i noe som overlever erasure (ledger/audit er ikke slettbare). Verifisert i test mot en falsk leverandør med navn og helsetekst (`wpd3-write-chain-db`, gruppe M) |
| B7 | YouTube: metadata/synlighet på EGNE videoer | Nei (eierens eget innhold) | Plattformen + journal | - |
| B8 | GA4/Search Console: konfigurasjon (nøkkelhendelser, nettstedskart) og lesing av aggregerte søkedata | Nei (aggregert; søkeord er brukerskrevet tekst, behandles som ubetrodd data) | Plattformene | - |
| B9 | Kampanjetidslinje (`marketing_campaign_events`) for en skriving, lesbar for modellen via `growth.list_events` | Nei (kun id-er, statuser og tall; aldri leverandørtekst) | `marketing_campaign_events.metadata` | Review M2: modell-lesbar flate bærer ikke ubetrodd tekst (regel 7); den fulle, redigerte tilstanden ligger kun i eier-journalen |

## 3. Behandlere og overføring

Plattformene er databehandlere/selvstendige behandlere for dataene eieren legger inn. **Ingen DPA, SCC-er, region eller overføringsgrunnlag er verifisert i dette arbeidet - alt under er `IKKE VERIFISERT`.**

| Leverandør | Tjenester | Status | Merknad |
|---|---|---|---|
| Google (Google Ireland Ltd / Google LLC) | Ads, GA4, Search Console, Business Profile, YouTube | IKKE VERIFISERT | DPA/Google Ads Data Processing Terms og overføringsgrunnlag må kontrolleres av eier; GA4-retensjonsinnstilling må velges av eier |
| Meta (Meta Platforms Ireland) | Meta Ads | IKKE VERIFISERT | Samme |
| LinkedIn (LinkedIn Ireland) | LinkedIn Ads | IKKE VERIFISERT | Samme |
| TikTok | TikTok Ads | IKKE VERIFISERT | Overføring til tredjeland må vurderes særskilt FØR bruk |

Regel: ingen sensitive memory spaces (helse/personlig) sendes til noen av disse. Skrivehandlingene sender kun eierens egne kontoer og forretningsparametre, aldri kontaktdata. Region-matrisen (`PROCESSOR_REGION_MATRIX.md`) må få en rad per leverandør før produksjonsbruk (eierhandling).

## 4. Samtykke, cookies og nettsporing (produksjonssporing)

1. **Jarvis setter ingen cookies og installerer ingen sporingskoder.** Sporing på eierens nettsteder (GA4-tag, annonse-piksler, `gclid`/`fbclid`-lagring, cookies/localStorage) er eierens ansvar og er IKKE bygget i WP-D3.
2. **Samtykke:** lagring av eller tilgang til informasjon på sluttbrukerens enhet (cookies, annonse-ID-er, piksler) krever i Norge samtykke etter ekomloven § 3-15 (ePrivacy art. 5(3)), og behandling av de innsamlede personopplysningene krever gyldig grunnlag etter GDPR art. 6. Eier må ha en samtykkeløsning (CMP) på nettstedene som blokkerer sporing før samtykke og som styrer plattformenes «consent mode». Jarvis' egen samtykkemotor (`consent.evaluate_processing_decision`, D-91/D-92) kan avgjøre hvem som får hvilken behandling, men **samtykkekontrollene (JARVIS-084) er ikke endret eller bygget her** (Q-47f).
3. **Server-til-server med personopplysninger** (hashet e-post/telefon til Ads/Meta/GA4) er IKKE bygget og må ikke bygges før samtykkegrunnlaget er avklart; merket DEFERRED.
4. **Rettslig grunnlag for attribusjon (B4):** berettiget interesse (art. 6(1)(f)) for B2B-leads og kunder er en mulig vurdering, men er IKKE avgjort her; markedsføringskommunikasjon til enkeltpersoner har egne krav (ekomloven § 2-7b) og ligger utenfor denne slicen.

## 5. Dataminimering og lagring

- `growth_write_journal`: konto-/kampanje-/annonsegruppe-id-er, status, budsjett-/budbeløp, navn (≤ 500 tegn, kontrolltegn fjernet), utfall, proveniens (person, kilde, `task_id`, `session_id`). **Ingen hemmeligheter, ingen sluttbrukeridentifikatorer, ingen e-post/telefon (også lokasjonens telefonnummer leses ikke: Business Profile-`readMask` har ikke `phoneNumbers`, review N5a), ingen IP, ingen cookie-/enhets-ID-er, ingen omtaletekst/anmelder-navn.** All leverandørtekst i journalen går gjennom hemmelighetsskanner og lengdegrenser før lagring. Gatewayens egen ledger (`tool_executions`/`audit_events`, ikke slettbar via erasure) lagrer den rensede (kontrolltegn/lengde) før-/ettertilstanden uten hemmelighetsskanning; for omtaler er den begrenset til metadata (se B6). YouTube-journalen har kun flatet, kuttet beskrivelse (≤ 500 tegn).
- `marketing_experiment_*`: aggregerte tall (visninger, klikk, konverteringer, utgift og omsetning i øre) per variant og dag.
- Klikk-ID-er (B3) ligger kun i den eksisterende `marketing_campaign_tracking_tags` (D-82), uendret.
- **Retensjon:** følger kampanjens/eksperimentets levetid. **Utfallstabellen** (`marketing_experiment_outcomes`) har kun SELECT/INSERT for runtime (ingen UPDATE) pluss DELETE for erasure. **Journalen er IKKE append-only:** den er en tilstandsmaskin (INSERT `requested`, én UPDATE til terminal status; `outcome_unknown` kan senere avklares; terminale rader og kjernekolonner er uforanderlige via databasetrigger), og applikasjonsrollen har UPDATE (overgangene) og DELETE (kun Q-20-erasure). Databasevaktene beskytter mot kodefeil og utilsiktede skrivestier - IKKE mot en kompromittert applikasjonsrolle, som kan skrive journalen selv. Sletting av en memory space/tenant dekker alle nye tabeller (`modules/erasure/src/plan.ts`, testet). **Retensjonstid for journalen er en eierbeslutning (åpent spørsmål).** Data hos plattformene følger plattformenes egen retensjon (eier må velge, f.eks. GA4-datalagring) - ikke verifisert.
- **Rettigheter (innsyn/retting/sletting):** Jarvis' egne tabeller dekkes av sletteflyten. Sletting/innsyn hos plattformene (f.eks. GA4 brukersletting) er IKKE bygget (DEFERRED) og må gjøres av eier i plattformene.

## 6. Risikovurdering (kort)

| Risiko | Tiltak (bygget) | Restrisiko |
|---|---|---|
| Skriving mot feil/fremmed konto | Eksakt eier-liste (`JARVIS_GROWTH_WRITE_TARGETS`) håndhevet i gatewayen, også for lesing; objekter på annen konto leses som «ikke funnet»; sandkasse for aksept | Lav (avhenger av at eier fører riktig liste) |
| Økonomisk skade (budsjett/bud/aktivering) | Step-up (enhetssignert økt), klasse D-kjede med fersk lesing + readback + umiddelbart eier-varsel, finans-nødbryter for utgiftsøkning (fail-closed), absolutt-tilstand + `expected_*`-precondition, før/etter-journal | Lav/middels (ikke testet mot ekte plattform) |
| Ubetrodd tekst (kampanjenavn, omtaler, søkeord) styrer handling (prompt-injeksjon) | Leverandørtekst er data: renset, lengdebegrenset, `untrusted`, aldri velger mål/handling; ingen modellflate; kreativ-URL kun fra verts-allowlist | Lav |
| Hemmelighetslekkasje | Vault-refs; token i header aldri URL; vasking av feiltekst; skanner før journalføring | Lav |
| Dobbeltskriving / utfall ukjent | Idempotensnøkkel + ledger + journal; 5xx/uleselig svar = «utfall ukjent» uten ny mutasjon; eier varsles | Lav |
| Profilering / automatiserte avgjørelser | Eksperimentutfall er deterministiske tall (ingen modell avgjør vinner), registreres med `decided_by` (eier/regel) og har ingen rettsvirkning for enkeltpersoner; ingen individnivå-scoring bygget her | Lav |
| Tredjelandsoverføring | Ingen personopplysninger sendes i skrivehandlingene; leverandørvilkår IKKE VERIFISERT | Ukjent til verifisert |
| Anmelders personopplysninger (Business Profile) | Anmelders navn leses aldri; omtaletekst vises kun til eieren (`list_reviews`) og lagres ikke; skrivekjeden bruker `get_review` (id, stjerner, tidspunkt, svar ja/nei + digest) så ingen omtaletekst/svartekst havner i journal, `tool_executions` eller `audit_events` (ikke-slettbar sporing) | Lav (test mot falsk leverandør; ikke verifisert mot ekte API) |
| Ubetrodd leverandørtekst på en modell-lesbar flate | Tidslinjen (`growth.list_events`) bærer kun id-er/statuser/tall via en hvitliste; navn og tekster ligger kun i eier-journalen | Lav |
| Hemmeligheter i leverandørtekst (f.eks. et kampanjenavn) | Journalen skanner og redigerer; gatewayens ledger/audit lagrer renset (ikke skannet) tilstand | Lav/middels (kjent grense, dokumentert) |

## 7. Før produksjonssporing og skriving slås på (sjekkliste - alt åpent)

- [ ] Eier har lest og akseptert dette notatet; jurist/personvernombud har vurdert (UTKAST i dag).
- [ ] DPA/behandlervilkår og overføringsgrunnlag verifisert per leverandør (Google, Meta, LinkedIn, TikTok) og ført i `PROCESSOR_REGION_MATRIX.md`.
- [ ] Samtykkeløsning (CMP) og consent mode på eierens nettsteder; beslutning om samtykkekontroller (JARVIS-084/Q-47f).
- [ ] Retensjonstid for journalen og eksperimentdata besluttet; plattformenes retensjonsinnstillinger valgt.
- [ ] Rettighetsflyt (innsyn/sletting) hos plattformene definert.
- [ ] Akseptanse kjørt mot sandkasse-/testkontoer (se runbook §9) før noen produksjonskonto legges i `JARVIS_GROWTH_WRITE_TARGETS`.

## 8. Statusord

| Punkt | Status |
|---|---|
| Skriving mot plattformene | DORMANT (AV), NOT VERIFIED |
| Eksperimentregister/kreativ-intelligens | DORMANT (AV), ingen persondata |
| Produksjonssporing på nettsteder (tagger/cookies) | NOT_BUILT |
| Server-til-server-konvertering med personopplysninger | DEFERRED |
| Samtykkekontroller (JARVIS-084) | NOT_BUILT (utenfor omfang) |
| Behandleravtaler/overføringsgrunnlag | IKKE VERIFISERT |
| Juridisk gjennomgang | IKKE UTFØRT |
