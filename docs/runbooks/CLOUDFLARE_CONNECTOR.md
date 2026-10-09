# Cloudflare-connector (WP-E1, UA-5) - eier-oppsett, sikkerhetsmodell og akseptanse

**Status (2026-10-09): BYGGET OG TESTET MOT EN LOKAL FAKE CLOUDFLARE-SERVER - SOVENDE - IKKE KJØRT MOT ET EKTE CLOUDFLARE.** Ingen test har truffet
`api.cloudflare.com`. Endepunkter og token-tillatelser er verifisert mot Cloudflares offisielle dokumentasjon via søk 2026-10-09 (direkte nedlasting av
dokumentasjonen var blokkert i byggemiljøet, så tillatelsesNAVNENE er lest fra søkeutdrag av de offisielle referansesidene). Hver `NOT VERIFIED`-linje under
er noe DU bekrefter i token-dialogen/mot en sandbox-sone før du stoler på det. Connectoren gjør ingenting før `JARVIS_CLOUDFLARE_API_TOKEN` er satt.

**D-64 (Core-vs-Adapter):** Cloudflare er en ADAPTER - `EXTERNAL_CANONICAL` for DNS, WAF-regler og sone-innstillinger (leverandøren eier tilstanden).
Jarvis eier hendelses-/eksekusjonsjournalen (`infra_executions`), policyen, revisjonen og gjenopprettingsplanen. Ingen Jarvis-domenemodell avhenger av
Cloudflares API-form (`CORE_DEPENDENCY_DECISION_REQUIRED=false`). **D-41 (maksimal kapabilitet):** hele den verifiserte skrive-/slette-flaten er bygget; det
som ikke er det står i §7 som `DEFERRED`/`PARTIAL` - aldri stille utelatt.

## 1. Hva connectoren kan (verktøy-id `cloudflare`, eier-eksklusivt navnerom - aldri på en modellflate)

| Handling | Klasse | Token-tillatelse (API-navn; dashbord: Edit = Write) | Status |
|---|---|---|---|
| `check_token` (status/utløp - selve tokenet returneres aldri) | A | ingen ekstra | IMPLEMENTED |
| `list_zones`, `get_zone` | A | Zone Read | IMPLEMENTED |
| `list_dns_records`, `find_dns_records`, `get_dns_record` | A | DNS Read (eller DNS Write) | IMPLEMENTED |
| `get_ruleset` (WAF custom / rate limiting / managed - kun lesing) | A | Zone WAF Read (eller Zone WAF Write) | IMPLEMENTED |
| `get_zone_setting`, `list_zone_settings` | A | Zone Settings Read | IMPLEMENTED |
| `list_account_members`, `list_audit_logs` (audit-logg v2) | A | Account Settings Read | IMPLEMENTED (kun metadata) |
| `list_api_tokens` (metadata - aldri verdier) | A | Account API Tokens Read | IMPLEMENTED |
| `list_account_roles` | A | Account Settings Read - **NOT VERIFIED** for listeendepunktet (bare enkelt-rolle-oppslaget er verifisert) | PARTIAL |
| `create_dns_record` / `update_dns_record` / `delete_dns_record` (A, AAAA, CNAME, TXT, MX, NS) | **D** | DNS Write | IMPLEMENTED |
| `create_waf_rule` / `update_waf_rule` / `delete_waf_rule` (`http_request_firewall_custom`, `http_ratelimit`) | **D** | Zone WAF Write | IMPLEMENTED |
| `update_zone_setting` (`ssl`, `min_tls_version`, `always_use_https`, `development_mode`, `security_level`, `tls_1_3`) | **D** | Zone Settings Write | PARTIAL (kun de seks verifiserte innstillingene) |
| `purge_cache` (everything/files/hosts/prefixes/tags) | **C** | Cache Purge | IMPLEMENTED |

**Risikoklasse styrer HVORDAN, aldri OM (D-41).** DNS-/WAF-/innstillingsendringer og sletting er klasse D fordi de endrer hva internett ser av produksjonen
din og (DNS/WAF) kan ta deg av lufta. `purge_cache` er klasse C: den flytter produksjonslast mot opprinnelsen og kan ikke angres teknisk, men har ingen
lesbar før-/etter-tilstand å journalføre - derfor C med dokumentert «ingen reversering», ikke D. Eieren (Tobias) har full kapabilitet; sovereign owner-modus er
uendret (ingen kunstig godkjenningssperre for eieren), men KJEDEN under kjøres alltid.

## 2. Klasse D-kjeden (deterministisk kode, aldri prompt)

For hver skrivehandling i klasse D håndhever `ToolGateway.execute()` (ikke transporten, så den kan ikke omgås):
1. **Policy + InfraExecutionGate**: `PAUSED` stanser all skriving (B/C/D), `DEGRADED` stanser D, lesing (A) stanses aldri. Modusen er delt mellom `api` og `worker` via `owner_control_state` (D-438).
2. **Mål-autorisasjon**: sonen MÅ stå eksakt i `JARVIS_CLOUDFLARE_MUTATION_ZONES` (32 tegn hex, ingen wildcard), OG sonen må tilhøre `JARVIS_CLOUDFLARE_ACCOUNT_ID` (sjekkes mot Cloudflare selv). Tom liste = ingen skriving.
3. **Preflight med målvalidering**: fersk lesing før mutasjonen (`preflight_requires_target`/`preflight_target_check`) - et mål som ikke finnes avvises FØR noe skrives.
4. **Snapshot**: den eksisterende posten/regelen/innstillingen lagres som `before_state` (i `tool_executions` og i den sammenhengende journalen `infra_executions`).
5. **Idempotens-nøkkel PÅKREVD**; samme nøkkel + samme handling gir den eksisterende journalraden uten ny utførelse, samme nøkkel for noe annet er en eksplisitt konflikt.
6. **Readback (etterbetingelse)**: leses på nytt og sammenlignes med det som ble bedt om (DNS-innhold sammenlignes uavhengig av Cloudflares normalisering: TXT-anførselstegn, CNAME-punktum, IPv6-skrivemåte). «HTTP 200 er ikke suksess»: lyktes kallet men holdt ikke etterbetingelsen, journalføres `PARTIAL` (tidsavbrudd = `UNKNOWN`), aldri en fabrikkert `SUCCESS`.
7. **Umiddelbar varsling** (Telegram, ute-av-bånd). Er varsleren ikke klar, er handlingen utilgjengelig.
8. **Kompensasjon**: `POST /infra/recovery/attempt` (se §5) setter tilbake fra journalens før-tilstand - men BARE hvis objektet fortsatt er slik mutasjonen etterlot det (drift-vern, §5).

Mutasjoner gjentas ALDRI automatisk på 5xx (bivirkningen kan ha skjedd); bare 429 (avslag før behandling) og lesing gjentas. Tokenet vaskes ut av alle feilmeldinger.
Utdata er hvitlistet per ressurs, e-post i medlemslisten maskeres, og audit-loggen leveres uten aktørens e-post/IP.

**Eier- og delegert oppførsel:** kun den autentiserte eieren kan bruke connectoren (credential-binding, D-377); en delegert identitet får `credential_not_bound_to_identity`.
Modellen har INGEN direkte tilgang til tokenet eller til verktøyet (`cloudflare` står i `FORBIDDEN_MODEL_TOOL_IDS`/`OWNER_ONLY_NAMESPACES`); verktøyet utfører, ikke modellen.

## 3. EIERHANDLING - opprett ET token med minste nødvendige rettigheter

Dette er noe KUN du kan gjøre (Cloudflare krever Super Administrator for kontoeide tokens). Claude oppretter aldri tokens.

1. Cloudflare-dashbordet -> **Manage Account -> Account API Tokens -> Create Token -> Create Custom Token**. Foretrekk et **kontoeid token** (Account API Token) framfor et brukereid; Cloudflare anbefaler kontotokens for tjenester.
2. Navn: `jarvis-control-plane` (hva det brukes til, ikke hvem).
3. **Permissions** (dashbord-navn; «Edit» = Write i API-dokumentasjonen). Velg KUN det du faktisk vil at Jarvis skal gjøre - hver rad du utelater gir en tydelig 403 i stedet for en stille svekkelse:
   - Zone -> **Zone** -> Read
   - Zone -> **DNS** -> Edit
   - Zone -> **Zone WAF** -> Edit (eldre dashbord kan kalle den «Firewall Services»; gruppe-id-ene er autoritative, navnene er kosmetiske)
   - Zone -> **Zone Settings** -> Edit
   - Zone -> **Cache Purge** -> Purge
   - Account -> **Account Settings** -> Read (medlemsliste, audit-logg, kontoverifisering)
   - Account -> **Account API Tokens** -> Read (token-metadata; NOT VERIFIED at dette er riktig dashbord-navn for kontoeide tokens)
   - **IKKE** gi `Account API Tokens -> Edit`: et token som kan opprette tokens er privilegie-eskalering (se §7).
4. **Zone Resources:** `Include -> Specific zone -> <kun sonene Jarvis skal styre>`. Aldri «All zones». Under **Account Resources:** kun denne kontoen.
5. **Client IP Address Filtering:** legg inn NAS-ens utgående IP (Cloudflare anbefaler dette og/eller TTL for å begrense skaden ved lekkasje). **TTL:** sett en utløpsdato (f.eks. 90 dager) og legg rotasjon i kalenderen.
6. Opprett tokenet og **kopier det én gang** (vises aldri igjen). Lim det rett inn i Jarvis-dashbordet (Integrasjoner -> Cloudflare -> `JARVIS_CLOUDFLARE_API_TOKEN`, lagres i Infisical) - ALDRI i chat, issue, commit eller skjermbilde. Limte du det noe annet sted: tilbakekall det i Cloudflare og lag et nytt.
7. Finn **konto-id-en** (32 tegn hex; Cloudflare -> konto -> Overview/URL) og legg den i dashbordet som `JARVIS_CLOUDFLARE_ACCOUNT_ID`. Uten den kan INGEN skriving skje (sone->konto-bindingen kan ikke bevises).

## 4. Konfigurasjon (miljøvariabler)

| Variabel | Standard | Effekt |
|---|---|---|
| `JARVIS_CLOUDFLARE_API_TOKEN` | tom | Credential. Tom = hele connectoren er `credential_unavailable` (sovende). Kan settes via dashbordet (Infisical) eller `.env`. |
| `JARVIS_CLOUDFLARE_ACCOUNT_ID` | tom | Konto-id (32 hex) alle soner MÅ tilhøre. Uten den feiler skriving lukket, og `list_zones` filtrerer ikke på konto. |
| `JARVIS_CLOUDFLARE_MUTATION_ZONES` | tom | Kommaseparert liste av EKSAKTE sone-id-er (32 hex) Jarvis får SKRIVE til. Tom = ingen skriving. Kan KUN endres på verten (`.env` + restart), aldri via dashbordet eller en modell. En ugyldig enkelt-id hoppes over (aldri en løs autorisasjon for resten). |

Etter endring i `.env`: `docker compose up -d api worker` (vanlig oppskrift). Lesing styres av tokenets tillatelser; skriving av tokenet OG sonelisten (begge må tillate).

## 5. Bruk, journal og gjenoppretting (alle kall med `grant_token` i kroppen, som øvrige kontrollruter)

```
POST /infra/cloud/mutate
{ "grant_token": "<session-grant>", "provider": "cloudflare", "action": "update_dns_record",
  "parameters": { "zone_id": "<32 hex>", "record_id": "<32 hex>", "content": "192.0.2.10" },
  "idempotency_key": "cf-2026-10-09-1", "incident_id": "<valgfri>" }
```
Svaret er den sammenhengende `infra_executions`-raden: aktør/enhet, risikoklasse, mål (`cloudflare:<sone>:dns:<post>`), `before_state`, `after_state`, `state_diff`,
`verification_outcome` (SUCCESS/PARTIAL/FAILED/UNKNOWN), `recovery_plan` og om automatisk gjenoppretting er mulig. Hent den senere med `POST /infra/execution/get`.

```
POST /infra/recovery/attempt
{ "grant_token": "<session-grant>", "tool_id": "cloudflare", "action": "update_dns_record",
  "idempotency_key": "cf-2026-10-09-1", "parameters": {}, "execution_id": "<valgfri, må samsvare>" }
```
Kompensasjonen leser ALLTID målet fra den journalførte eksekusjonen (aldri fra kallerens parametre; avviker verktøy/handling/mål/eksekusjons-id gir den `recovery_target_mismatch` og
INGENTING utføres), og den:
- sjekker **drift**: er objektet endret av noen andre etter mutasjonen, overskrives det ALDRI blindt - `FAILED` med `state_drifted_since_execution` og dagens tilstand i svaret; du avgjør,
- er idempotent (allerede gjenopprettet = `SUCCESS` uten skriving),
- kjøres via samme `ToolGateway`-kjede (infra-pause stanser også gjenopprettingen), og
- **verifiserer** sluttilstanden ved ny lesing (landet den feil: `PARTIAL`).

| Mutasjon | Kompensasjon | Begrensning |
|---|---|---|
| `create_dns_record` | sletter posten mutasjonen selv opprettet | angres aldri hvis posten fantes fra før |
| `update_dns_record` | setter tilbake innhold/ttl/proxied/kommentar/prioritet fra før-tilstand | ttl på proxiede poster er alltid automatisk (1) hos Cloudflare |
| `delete_dns_record` | gjenskaper posten fra snapshot | **posten får NY id** |
| `create_waf_rule` / `update_waf_rule` | sletter / setter tilbake regelen | |
| `delete_waf_rule` | gjenskaper regelen fra snapshot | **regelen får NY id**; regler med `action_parameters` (skip/execute/egen respons) gjenskapes IKKE automatisk - `PARTIAL` med snapshotet i svaret, gjenopprett manuelt |
| `update_zone_setting` | setter tilbake verdien | |
| `purge_cache` | **ingen** (`UNKNOWN`/`no_recovery_strategy_registered`) | cachen fylles på igjen fra opprinnelsen; ved belastningsproblem: bruk mindre purge eller `development_mode` |

Infra-pause/degradert modus: `POST /infra/pause` (eier) stanser all skriving mot connectoren umiddelbart og i begge prosesser; lesing virker fortsatt.

## 6. Akseptanse mot en SANDBOX-sone (`NOT VERIFIED` til du har kjørt den)

Test- og akseptanseløp begrenses til sandbox-ressurser (blast radius) - dette sier ingenting om produksjonens tilgangsnivå. Bruk en egen, uviktig sone (f.eks. et ubrukt domene) og sett DEN ALENE i `JARVIS_CLOUDFLARE_MUTATION_ZONES` under testen.

1. Token + konto-id satt, `JARVIS_CLOUDFLARE_MUTATION_ZONES=<sandbox-sone-id>`, `api`/`worker` restartet. Dashbord -> Integrasjoner -> Cloudflare -> «Test tilkobling» (kjører `check_token`): forventet `status: active`, `kind: account`.
2. Lesing: `list_zones` (kun din konto), `list_dns_records` for sandbox-sonen.
3. Skriving med full revisjon: `create_dns_record` (TXT `_jarvis-accept.<sone>`), deretter `update_dns_record`, deretter `delete_dns_record`, hver med unik `idempotency_key`. Forventet: `verification_outcome: SUCCESS`, ny Telegram-melding per klasse D-handling, og en `infra_executions`-rad med `before_state`/`after_state`/`state_diff`.
4. Gjenoppretting: `POST /infra/recovery/attempt` for `delete_dns_record`-nøkkelen - posten skal være tilbake (med ny id). Gjenta kallet: `noop: record_already_restored`.
5. Drift-vern: endre posten manuelt i Cloudflare-dashbordet etter en `update_dns_record`, kjør recovery - forventet `FAILED`/`state_drifted_since_execution`, og posten er urørt.
6. Sonegrense: forsøk en skriving mot en sone som IKKE står i listen - forventet `cloudflare_zone_not_authorized`, ingen endring.
7. Pause: `POST /infra/pause`, forsøk en skriving - forventet `infra_paused`; `POST /infra/resume`.
8. Revisjon: sammenlign `infra_executions`-radene med Cloudflares egen audit-logg (`list_audit_logs`) - begge skal vise de samme endringene.

Lim utfallet (uten token) inn i chatten; først da regnes Cloudflare-connectoren som VERIFIED mot ekte leverandør.

## 7. Kjente begrensninger (D-41: `DEFERRED`/`PARTIAL`, aldri stille utelatt)

- **DEFERRED:** strukturerte DNS-typer (SRV/CAA/HTTPS/LOC/SSHFP/TLSA …), DNS-batch/import/eksport og tags (krever per-type `data`-skjema som ikke er verifisert enkeltvis); WAF `skip`/`execute`/managed-ruleset-overstyringer og egen blokkeringsrespons (krever `action_parameters`-skjema som ikke er verifisert; legacy Firewall Rules/Filters er deprecated siden 2025-06-15 og brukes ikke); øvrige sone-innstillinger enn de seks verifiserte (batch-endepunktet er deprecated, EOL 2027-03-31, og brukes ikke).
- **DEFERRED (tilgangsstyring skriv):** opprette/endre/slette medlemmer og roller, og opprette/tilbakekalle API-tokens. Et token som kan opprette tokens er privilegie-eskalering, og rot-credentials skal aldri nås av modellen; krever en egen eierbeslutning og et eget isolert token.
- **DEFERRED:** Workers/Pages/R2/Tunnel/Zero Trust/Load Balancing/Page Rules/Cache Rules/Transform Rules/Logpush/GraphQL-analyse - utenfor masterplanens «Cloudflare (DNS/WAF)»-avgrensning; hver krever egen D-41-verifisering.
- **PARTIAL:** `list_account_roles` (tillatelse for listeendepunktet ikke bekreftet); audit-logg leses kun første side (cursor-paginering ikke bygget; `since`/`before` er påkrevd av Cloudflare, standard er siste 24 timer); `list_dns_records` er begrenset til 10 sider à 100 poster (avkorting meldes).
- Rate limit hos Cloudflare: 1200 forespørsler / 5 min per bruker (429 + `Retry-After` respekteres, begrenset til 10 s). Purge-listen er begrenset til 30 elementer per kall (konservativt, ikke bekreftet maks).
- Cloudflare som sone-leverandør er proxy for trafikken din uavhengig av Jarvis hvis sonen er proxiet; Jarvis sender kun infrastrukturkonfigurasjon og API-token (rad i `docs/security/PROCESSOR_REGION_MATRIX.md`, region/DPA/retensjon `IKKE VERIFISERT`, `NEEDS_TOBIAS`).

## 8. Avvikling og nødstopp

- **Stopp skriving umiddelbart:** `POST /infra/pause` (eier), eller tøm `JARVIS_CLOUDFLARE_MUTATION_ZONES` og restart `api`/`worker`.
- **Fjern hele kapabiliteten:** tilbakekall tokenet i Cloudflare (Account API Tokens -> Roll/Delete) og fjern verdien fra Jarvis-dashbordet; connectoren er da `credential_unavailable`.
- **Token lekket:** tilbakekall i Cloudflare FØRST, deretter nytt token (§3). Kontroller Cloudflares audit-logg for endringer mellom lekkasje og tilbakekall.

## 9. Kilder (offisiell dokumentasjon, lest via søk 2026-10-09)

- Token-verifisering: `GET /accounts/{account_id}/tokens/verify` og `GET /user/tokens/verify` (status `active`/`disabled`/`expired`, `expires_on`, `not_before`).
- DNS-poster: `/zones/{zone_id}/dns_records` (DNS Write / DNS Read). Rulesets API: `/zones/{zone_id}/rulesets/phases/{fase}/entrypoint`, `/rulesets/{id}/rules` (Zone WAF Write / Read). Sone-innstilling: `PATCH /zones/{zone_id}/settings/{setting_id}` (Zone Settings Write). Cache-purge: `POST /zones/{zone_id}/purge_cache` (Cache Purge).
- Konto: `GET /accounts/{account_id}/members` (Account Settings Read/Write, SCIM Provisioning), `GET /accounts/{account_id}/tokens` (Account API Tokens Read/Write), `GET /accounts/{account_id}/logs/audit` (v2; Account Settings Read/Write; `since` og `before` påkrevd).
- Token-oppsett: «Create token» (kontoeid token krever Super Administrator og `Account API Tokens -> Edit` på bootstrap-tokenet; IP-filtrering og TTL anbefales).

**Hold dokumentasjonen levende:** når Cloudflare endrer tillatelsesnavn eller utfaser et endepunkt, oppdater `CLOUDFLARE_CAPABILITIES` i `modules/tool-gateway/src/cloudflare-target-policy.ts` (testet av `e1-cloudflare-policy.test.ts`) og denne runbooken sammen.
