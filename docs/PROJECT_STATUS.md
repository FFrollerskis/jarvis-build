# PROJECT STATUS

**Oppdatert:** 2026-09-23 (branch `claude/fase-d250-nas-migration-runbook`, PR #159, D-250 - NAS-
flytting, Trinn 1). Tobias, direkte i chat etter en lang live-feilsøkingsøkt (Tailscale/tale):
"det skal ligge på u green jobbe på pc og skal ha direkte tilgagn til jarvis". Dette er
`DEPLOYMENT_STRATEGY.md` §2 sitt allerede planlagte "Trinn 1", ikke en ny beslutning. Kildekode-
gjennomgang bekreftet portabilitetsløftet holder (ingen PC-spesifikke stier i compose/Dockerfile/
migrasjoner). Levert: `docs/runbooks/D250_NAS_MIGRATION.md` - trinnvis oppskrift (full
`pg_dumpall`-backup FØR noe røres, `.env`/backup direkte mellom Tobias sine egne maskiner,
gjenoppretting og verifisering på NAS-en FØR PC-stacken stoppes, eksplisitt rollback). Selve
utførelsen krever SSH-tilgang denne økten ikke har - et oppskrift-dokument, ikke en kjørt migrering.
**Live utførelse pågår nå direkte med Tobias i chat** (PC → NAS `.env`/backup-overføring via PuTTY
`pscp`, deretter `git`/Postgres-restore på NAS-en via en engangs `alpine/git`-container og en dedikert
read-only SSH deploy-key) - flere reelle infrastrukturproblemer løst underveis (manglende SSH-klient
på PC-en, NAS-ens SFTP-delsystem sandboxet til `/docker` - løst med legacy SCP-protokoll i stedet,
`Jarvis`-brukeren manglet hjemmekatalog/`docker`-gruppemedlemskap, NAS-ens EGEN native Postgres
okkuperte port 5432 - løst med `JARVIS_DB_PORT=5433`); Postgres kjører nå friskt på NAS-en, selve
databaserestoreringen (Trinn 4) pågår. Se D-250 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.

**Forrige milepæl (uendret, MERGET): D-249 - `/voice`-siden manglet ekkokansellering
(selvutløst barge-in + forgiftet STT) og TTS-lydrammer klikket ved bufferskjøter.** Begge fikset i
`apps/web/voice.html` (`getUserMedia` ber nå om ekkokansellering, `playTtsFrame()` fader inn/ut per
ramme), pluss en `cache-control: no-cache`-header lagt til på `/`/`/dashboard`/`/voice` (uten den
kunne en mobilnettleser fortsette å servere en gammel, allerede-fikset side fra cache). Se D-249 i
DECISIONS_AND_ASSUMPTIONS.md for full detalj. Tale er FORTSATT rapportert ustabil av Tobias etter
disse fiksene ("starter men stopper, skurer") - uavklart om gjenstående nettverksjitter over
Tailscale eller en tredje, ikke identifisert kodefeil; venter på teknisk-logg fra klienten for videre
diagnose, satt på vent mens NAS-flyttingen prioriteres.

**Forrige milepæl (uendret, MERGET): D-244 - full-prosjekt-revisjon (PR #156), etter merge av
oppdatert `main`** som da inkluderte BÅDE PR #154/D-242 (`27e523d`) OG PR #155/D-243 (`48e95f0`),
begge merget under D-192. Ingen kodekonflikt for selve D-244-revisjonen - kun docs
(`DECISIONS_AND_ASSUMPTIONS.md`/denne filen, D-24x kronologisk rekkefølge: 240-248). Se D-244 i
DECISIONS_AND_ASSUMPTIONS.md for full detalj.

**Forrige milepæl (uendret, MERGET): D-242 (PR #154, `27e523d`)** - merget under D-192 (CI grønt,
ingen åpne review-tråder). PR #155 (D-243)/PR #156 (D-244) fikk ny merge-konflikt mot oppdatert
`main` (samme docs-filer som #154 rørte) - løst (D-24x kronologisk rekkefølge: 240/241/242/243/245/
246/247/248), typecheck rent på berørte pakker, begge pushet på nytt for fersk CI. To uavhengige,
kjente flaky race-condition-tester (`ops/claude-worker/test/task-admission.test.mjs` PROOF 4 for
#155, `modules/core/test/embedded-postgres-port-lease.test.ts` for #156 - INGEN av dem rørt av disse
PR-enes docs-only-diff) feilet først, re-kjørt via `rerun_failed_jobs` for å bekrefte flake før
videre merge under D-192.

**Forrige milepæl (uendret, MERGET):** Vercel (D-248) og GitHub begge "tilkobling OK" på Tobias sin
host (se forrige milepæl for Vercel-detaljene). **Gmail bekreftet fortsatt live** ("tilkobling OK") -
IKKE en ny fiks denne runden, men en nyttig korreksjon: Gmail har ALLEREDE et eget, dedikert
reauth-script (`modules/core/scripts/google-email-reauth.ts`, bevisst SEPARAT fra
`google-drive-reauth.ts` - eget scope-sett `gmail.readonly`/`gmail.send`, samme persisterte
Desktop-OAuth-klient) som ble host-verifisert i D-47 (2026-08-17, `run_id 0f43f39d`,
`p1b_gmail_list_messages_live=PASS`) - `JARVIS_EMAIL_TOKEN` fra DEN kjøringen er fortsatt gyldig.
En tidligere feilaktig antakelse denne økten (fra en utdatert `.env.example`-kommentar alene, uten å
sjekke D-45/D-46/D-47/det eksisterende scriptet) foreslo å slå sammen Drive- og Gmail-reauth til
ett script - korrigert FØR noe ble bygget: det ville vært feil retning, stikk i strid med et bevisst
designvalg (egen fil, egen scope, rører aldri Drive/Calendar sin credential). Telegram (D-247) ikke
eksplisitt re-testet live ennå av Tobias denne runden. **GitHub Actions-betalingsblokkeringen ser ut
til å være løst** (rerun av det gamle, feilede run #999 på `main` fullførte i `in_progress`/reelle
steg, ikke lenger umiddelbar `startup_failure`) - men PR #154-#157 sine egne branch-commits har
FORTSATT aldri hatt en eneste sjekk-kjøring (`total_count: 0`), siden GitHub kun trigger CI på et nytt
push/pull_request-event, ikke retroaktivt. Denne commiten er delvis en test av om #157 nå faktisk får
en ekte CI-kjøring.

**Forrige milepæl (uendret): D-247/D-248:
"ALLE SKAL FUNGERE ABSOLUTT ALLE"-SYSTEMATISK GJENNOMGANG AV DE 6 GJENVÆRENDE CONNECTORENE** (Tobias
direkte i chat: "men alle skal fungere absolutt alle begynn på det") - github/google_calendar/gmail/
google_drive VERIFISERT TRYGGE (token kommer via standard Infisical-aware `ToolGateway.execute()`,
ingen bypass-lukking). **D-247 (Telegram):** `TelegramTransport.chatId` var frosset fra
`process.env` ved konstruksjon - SAMME Infisical-bypass-bug-klasse som D-246, pluss manglende
`JARVIS_TELEGRAM_CHAT_ID` i `credential_refs` (D-245-klasse). Fikset: konstruktøren tar nå en
resolver-funksjon mot `readSecretProvider`/`toolSecretProvider`, slått opp PÅ NYTT ved hvert
`notify`-kall. **D-248 (Vercel), STØRRE FUNN:** `VercelTransport` fantes ALDRI noe sted i
kodebasen - `transport("vercel")` falt ALLTID tilbake til `UnconfiguredHttpTransport`
(`vercel_not_configured`), uansett credential. Den tidligere antatte "Vercel fungerer nå etter
Docker-rebuild"-konklusjonen (forrige milepæl) var FEIL/prematur - rebuilden løste kun en separat
stale-image-årsak, aldri denne strukturelle mangelen. Bygget en ekte `VercelTransport` mot Vercel
sin offisielle REST API v6 (`GET /v6/deployments`), wiret inn i begge prosesser. 88 relevante
DB-uavhengige tester grønne (inkl. 5 nye for Vercel), typecheck/lint rene. Se D-247/D-248 i
DECISIONS_AND_ASSUMPTIONS.md for full detalj.

**Forrige milepæl (uendret, IKKE MERGET): D-246 - STØRRE STRUKTURELL BUG FUNNET OG FIKSET,
LIVE-DEBUGGET SAMMEN MED TOBIAS** - Neonomics feilet FORTSATT
etter D-245 (alle tre felt ✓ i dashbordet), Tobias: "når vi må kjøre det hver gang fungerer jo ikke
dash". Root cause: `stripeCredentialsProvider`/`vippsCredentialsProvider`/
`neonomicsCredentialsProvider`/`wallesterCredentialsProvider`/`fikenCredentialsProvider` sine
`getCredentials()`-lukkinger i `main.ts`/`worker-main.ts` leste rå `process.env[...]`, HELT UTENOM
den Infisical-primære `readSecretProvider`/`toolSecretProvider`-kjeden dashbordets "lim inn
ny verdi" (D-213) faktisk skriver til - en verdi lagret KUN i Infisical var derfor strukturelt
usynlig for selve finans-tjenestene, uansett hva dashbordets ✓ viste. Fikset i alle fem, begge
prosesser. **Samtidig funnet, samme runde:** `credential_refs` manglet `JARVIS_VIPPS_MSN` (vipps) og
`JARVIS_WALLESTER_API_BASE_URL`/`_ACCOUNT_ID` (wallester) - samme bug-klasse som D-245. 50 tester
re-kjørt grønt, typecheck/lint rene. Se D-246 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.

**Forrige milepæl (uendret, IKKE MERGET): D-245 (PR #157) - Neonomics manglet DEVICE_ID i
`credential_refs`** - Tobias, rett etter at Vercel ble bekreftet fungerende (D-242, lokal
branch-kjøring): "feilet: tool_failed:neonomics_credentials_unavailable:tenant-personal" på Neonomics
sin "Test tilkobling", til tross for at både CLIENT_ID og CLIENT_SECRET viste ✓ som lagret.
Root cause: `neonomicsCredentialsProvider.getCredentials()` (`main.ts`) har siden D-111 krevd et
TREDJE felt, `JARVIS_NEONOMICS_DEVICE_ID` (en Jarvis-generert, stabil enhets-UUID), men
`connector-registry.ts` sin `neonomics`-oppføring listet kun de to første i `credential_refs` -
dashbordets "lim inn ny verdi"-felt for DEVICE_ID ble derfor ALDRI vist, og testknappen kunne
STRUKTURELT aldri lykkes uansett credentials. Fikset (DEVICE_ID lagt til i `credential_refs`), 30
eksisterende tester (`connector-registry.test.ts`/`d213-connector-credentials.test.ts`) re-kjørt
uendret grønt. Samme funn-klasse som D-236 og finance-sliceen i D-244s full-prosjekt-revisjon (Fiken
sin tilsvarende company-slug-gap). Se D-245 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.

**Forrige milepæl (uendret, IKKE MERGET): D-244 (PR #156) - full-prosjekt-revisjon**, D-243 (PR #155)
- `.env`-parser CRLF-fiks, D-242 (PR #154) - connector-helsesjekk (Vercel/Fiken/Stripe/Vipps
`live_test`), alle tre fortsatt blokkert på GitHub Actions-betaling (ingen CI-kjøring i det hele
tatt, samme kontobrede fantom-`BuildFailed`-feil som rammer FERSKE pushes til `main` også). Merges
under D-192 så snart CI faktisk kan kjøre og blir grønt. **Bekreftet av Tobias, live på egen host:**
Vercel-fiksen (D-242) fungerer etter en lokal `git checkout claude/fase-d242-connector-health-sweep`
+ `docker compose ... up -d --build api worker` (MERK: `--force-recreate` alene bygger IKKE et nytt
image fra endret kildekode - `--build` er påkrevd), UTEN å vente på selve CI/merge.

**Forrige milepæl (uendret, MERGET): D-240 (PR #152, `19e8538`) - EKTE INFRA-BUG FUNNET
OG FIKSET** - Tobias fikk `403 tool_denied: tool_failed:fetch failed` FØRSTE gang han faktisk prøvde
D-213s "lim inn nøkkel"-skriving live (rett etter D-239-merge). Sporet PRESIST via
`docker compose logs infisical` til `DatabaseError: database "infisical" does not exist` -
`infra/local/docker-compose.yml` sin `postgres`-tjeneste oppretter KUN `jarvis`-databasen
(`POSTGRES_DB`, offisiell Postgres-image-begrensning); INGENTING opprettet noensinne de separate
`infisical`/`langfuse`-databasene begge containerne kobler til. Hullet lå skjult siden D-35s BO-07
(2026-08-13, databasen må ha eksistert fra en manuell, aldri kodifisert handling den gangen) helt til
D-213s skrive-sti (bygget en måned senere) faktisk traff `InfisicalSecretProvider.set()` for FØRSTE
gang i dag. **Umiddelbar unblocking gitt til Tobias** (`CREATE DATABASE infisical;` + `restart
infisical`, live i chat) FØR selve kodefiksen: ny `db-bootstrap`-engangstjeneste (SAMME
`pgvector/pgvector:pg16`-image som `postgres`) kjører `infra/local/bootstrap-databases.sql`
(idempotent `CREATE DATABASE ... WHERE NOT EXISTS ...\gexec`) FØR `infisical`/`langfuse` startes.
**Verifisert, ikke antatt:** `docker compose config` (ekte v5.1.1-binær) validerte hele filen
syntaktisk; SQL-logikken kjørt DIREKTE mot en ekte lokal PostgreSQL 16 (denne sandboxens
`postgresql-16`-pakke som `postgres`-systembrukeren) TO GANGER - første kjøring opprettet begge
databasene, andre kjøring (begge allerede eksisterende, SAMME situasjon som Tobias sitt
`jarvis-pgdata`-volum etter fiksen) var et REELT no-op, exit 0. 8 nye strukturelle wiring-tester
(`modules/core/test/d240-db-bootstrap-compose-wiring.test.ts`), 29 eksisterende compose-wiring-tester
re-kjørt uendret grønt. Se D-240 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.

**Forrige milepæl (uendret, MERGET): D-239 (PR #151, `7105b85`) - RENT kosmetisk dashbord-restyling**,
Tobias direkte i chat: "forbedre dashbordet til og se moderne og jarvis ut".
`apps/web/dashboard.html` sin HELE `<style>`-blokk skrevet om til et mørkt/cyan "HUD"-tema med CSS
custom properties (`--bg`/`--panel`/`--accent`/`--success-*`/`--warn-*`/`--danger-*`/`--info-*`)
i stedet for hardkodede heksfarger - HVER selector (ID/klasse) UENDRET, INGEN HTML-struktur/JS/
datamodell-endring. Nytt: sticky/blurred header med pulserende statusprikk (rent CSS ::before,
ingen HTML-endring), cyan-aksentert typografi med gradient-skillelinjer, panel-skygger+hover-kant,
ensartede fokusringer, tilpasset scrollbar - INGEN ekstern font-/CDN-avhengighet (regel 9). Verifisert
FØR endringen at ingen test søker etter spesifikke fargeverdier/klassenavn/eksakt header-markup (null
testrisiko for en ren egenskapsverdi-endring), OG visuelt (samme fetch()-mock+headless Chromium-
metode som D-238, gjennom HELE den ekte enhets-/grant-/lasteflyten med syntetiske data for alle
seksjoner inkl. de 64 connectorene i fem kategorier) - kontrast, fokus/hover, pulserende prikk og
D-238s kollapsbare connector-grupper fungerer alle som før, kun med nytt utseende. De fire dashbord-
relaterte wiring-testsuitene (connector-credentials/governance/executive-mutations/voice-page, 48
tester) grønt uendret etter endringen. Se D-239 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.

**Forrige milepæl (uendret): D-237+D-238 (PR #150, MERGET, `1b8d8f0`) - EKTE KODEFIKS + UX-forbedring**,
samme Tobias-melding ("gjør dash mer kult ... viktig at han vet om alt han kan gjøre og har tilgang
til"):
- **D-237 (selv-bevissthet):** `check_my_capabilities`/`executive.get_capability_status` sin
  `chat_accessible_tools` viste FØR bare om et mesh-verktøy STRUKTURELT fantes, aldri om det
  underliggende credential-referansen faktisk var konfigurert - Charlie kunne dermed liste
  `read_recent_email` som "tilgjengelig" selv om `JARVIS_EMAIL_TOKEN` var tomt. Ny
  `meshToolBindings()`-eksport (`@jarvis/tool-gateway`) + `gateway.hasSecret()`-oppslag per binding i
  `ExecutiveService.getCapabilityStatus()` gir nå et `configured: boolean`-felt per verktøy. 10
  tester i `capability-status.test.ts` (opp fra 8), 2 nye som beviser BÅDE positiv/negativ
  `configured`-status og fail-closed for en ikke-registrert binding.
- **D-238 (dashbord-UX):** "Integrasjoner"-seksjonen (64 connectorer i én flat liste) fikk
  kategorisert/kollapsbar gruppering (`<details>`/`<summary>`, "X/Y konfigurert" per gruppe), et
  samlet "N av M konfigurert" og et klientside-søkefelt (navn/kategori, ingen nytt nettverkskall).
  RENT presentasjon - `ConnectorStatusReport`-API-et uendret. Verifisert visuelt med en
  fetch()-mock + headless Chromium-skjermbilde gjennom HELE den ekte enhets-/grant-/lasteflyten
  (siden denne sandboxen ikke har Docker/Postgres) - gruppering/telling/åpen-lukket-standard
  fungerte eksakt som beskrevet. Fant OG rettet, FØR commit, en vacuous test-regresjon jeg selv
  introduserte (`dashboard-connector-credentials-wiring.test.ts` sitt eksakte
  `"function renderConnectors(data)"`-strengsøk sluttet å matche etter signaturendringen, ga
  `idx=-1` og en TOM `block` som gjorde `not.toMatch(...)` sann av feil grunn - rettet til et åpent
  prefiks-søk PLUSS eksplisitte lengde-/indeks-vakter).

Se D-237/D-238 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.

**Forrige milepæl (uendret): D-236 (PR #149, MERGET, `1a73ab4`).** `EnvSecretProvider.get()`
(`modules/tool-gateway/src/gateway.ts`) behandlet en tom-men-satt `.env`-linje (f.eks.
`JARVIS_VIPPS_CLIENT_ID=`) som en "verdi" (kun `process.env[ref] ?? null`, som ALDRI fanger tom
streng) - dashbordets "Integrasjoner"-seksjon viste derfor connectorer som Vipps som `konfigurert`
selv om Tobias aldri hadde limt inn ekte credentials. Funnet av Tobias SELV, live på sin egen ferske
Docker-kjøring ("VIPPS ER IKKE INTEGRERT Å DET STÅR DET ER DET"), rotårsak sporet til kildekoden
(ikke gjettet), fikset til `return value ? value : null`. 5 nye tester
(`env-secret-provider-empty-value.test.ts`), eksisterende `connector-registry.test.ts`/
`d213-writable-secret-provider.test.ts` re-kjørt uendret grønt. Se D-236 i
DECISIONS_AND_ASSUMPTIONS.md for full detalj.

**Forrige milepæl (uendret): branch `claude/fase-status-update-post-d235` (PR #148, MERGET, `b1d4257`),
ren dokumentasjonsøkt.** `PROJECT_STATUS.md` hadde blitt stående med "ÅPEN SOM DRAFT"/"IKKE
MERGET"-merkinger for PR-er som en tidligere økt faktisk fulgte opp og merget rett etterpå (samme
D-192-fullmakt, PR-monitorering+merge er en egen, senere handling enn selve kode-PR-en). Den
oppdateringen rettet dét, uten å endre den historiske hendelsesbeskrivelsen.

**Alle PR-er t.o.m. #147 er MERGET til `main`.** Siden forrige `PROJECT_STATUS.md`-skriving har
følgende blitt fulgt opp og merget, alle under direkte D-192(-tillegg)-fullmakt i chat, CI grønt,
ingen åpne review-tråder, eksakt HEAD-/base-guard rett før hver merge:
- **PR #141 (D-228, Stripe host-akseptanse) → MERGET** (`c34732e`). `STRIPE_LIVE_GATE` sin kode-side
  er dermed FERDIG - kun uavhengig gjennomgang av selve host-bevisdet (eller Tobias sitt eget
  direkte akseptvedtak, se "Blokkeringer") gjenstår før `PASS_PENDING_ARCHITECT_REVIEW` blir et
  ubetinget `PASS`.
- **PR #142 (D-231, kuratert integrasjons-backlog registrert i `INTEGRATIONS.md`) → MERGET** (`406412a`).
- **PR #143 (D-230, K2-styringsdashbord `POST /governance/query`/`/mutate` + UI) → MERGET** (`34bcac9`,
  krevde manuell konfliktløsning i `DECISIONS_AND_ASSUMPTIONS.md` mot D-231, begge D-ID-radene
  beholdt i rekkefølge).
- **PR #144 (D-232, 50 backlog-connectorer synlige i dashbordet) → MERGET** (`80f5b2d`).
- **PR #145 (D-233, Q-36 Supabase lukket - kun Postgres-hosting, ingen connector) → MERGET** (`8d060d4`).
- **PR #146 (D-234, Q-37/Q-38 Neo4j+1Password droppet fra backlogen) → MERGET** (`2403577`).
- **PR #147 (D-235, D-35 Infisical host-akseptansescript LEVERT, IKKE host-kjørt) → MERGET** (`c06286c`).

**Netto resultat av D-231→D-235-rekken:** Tobias sin kuraterte ~73-punkts integrasjonsliste er nå
FULLT registrert - 16 var allerede bygget, 2 allerede dekket, 50 lagt til som synlig-men-ikke-
konfigurert backlog i dashbordet (6 av dem krever i tillegg en egen D-64 Core-vs-Adapter-port før de
kan bygges), 2 er ikke connectorer (Windows/macOS). Av D-231 sine fem flaggede avklaringspunkter er
FIRE lukket (Q-36 Supabase, Q-37 Neo4j, Q-38 1Password, pluss D-64-gaten selv registrert eksplisitt)
- **kun Q-39 (Windows/macOS) står fortsatt åpen**, se `OPEN_QUESTIONS.md`.

**Ingen kjent, byggbar-uten-Tobias kode gjenstår akkurat nå.** Det som står igjen er enten (a) noe
kun Tobias kan gjøre (host-kjøre D-235s Infisical-script, kredential-oppsett for de 50 nye backlog-
connectorene, Apple/HA/Google Ads-kontoer osv.), (b) en avklaring fra Tobias (Q-39), eller (c)
målingsbaserte spørsmål som venter på reell bruksdata (Q-03/Q-06/Q-09/Q-10/Q-11/Q-12/Q-19). Se
"Neste oppgave" for full liste.

**Historikk før PR #141-147 (uendret, fortsatt gjeldende på `main`): D-228** - Tobias sin FØRSTE
faktiske host-kjøring av Stripe-akseptansescriptet (D-225) er GRØNN. Fem reelle kodefeil funnet og
rettet underveis (feil ToolGateway-`tool_id`, en `??=`-sentinel som ikke overskrev en tom streng, et
ikke-eksisterende Stripe CLI-flagg, en webhook-seksjon som ventet på en allerede-tapt hendelse,
manglende CLI-autentisering) - `STRIPE_LIVE_GATE=PASS_PENDING_ARCHITECT_REVIEW` (alle tre navngitte
kriterier PASS med ekte Stripe-bevis, IKKE et ubetinget `PASS` før uavhengig arkitektgjennomgang,
samme presedens som W1 watchdog opprinnelig fulgte). **PR #97 (W1 watchdog) LUKKET UTEN MERGE** -
funnet ved forsøk på merge under D-192-tillegg at feature-en allerede var implementert (MER
gjennomarbeidet, fem ekstra bugfikser) og merget via en parallell PR #96 tilbake i 2026-09-19; se
"Andre åpne PR" under for full historikk. Tobias bekreftet direkte at issue #68 sin
ChatGPT-arkitektgjennomgang ikke lenger er en aktiv sti - rutine-PR-er avgjøres videre under direkte
D-192(-tillegg)-fullmakt i chat, ikke via issue #68.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19) - GJELDENDE VIDERE

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd, helt til punktet der videre fremgang
faktisk krever credentials/kontoer/MCP-koblinger - IKKE start ny scope utover masterplanen. issue #68
BEHOLDES som logg. Claude har STÅENDE FULLMAKT til å merge rutinemessige PR-er når CI er grønt/tester
består/ingen åpne funn. D-201 presiserer sluttmålet: hele masterplanen bygget/fungerende, ALLE eksterne
integrasjoner unntatt `Fiken`/`Walley` (permanent ekskludert), en helt autonom agent, drift på
UGREEN-NAS-en + Tobias sin PC (`gemma_local`) som tilleggskraft inntil dedikert maskin. Se
D-192/D-201 i DECISIONS_AND_ASSUMPTIONS.md og `CLAUDE.md` §Merge-autoritet.

**VIKTIG PRESEDENS (D-208, 2026-09-20):** D-192s delegering er IKKE ubegrenset - den gjelder rutine-
implementasjonsvalg INNENFOR eksisterende arkitektur/CLAUDE.md sine Ufravikelige regler, ALDRI en
fullmakt til å fjerne selve håndhevingsmekanismen en ufravikelig regel krever skal eksistere. Samme
grense bekreftet igjen for tale (D-212, Q-32 punkt 1) og for selvendring (D-208→D-214): eieren avslo
full ugjennomgått selvpatching TO GANGER etter eksplisitt risikogjennomgang - den vedtatte retningen
var et to-lags-kompromiss, ikke en full fullmakt.

**LÆRDOM (D-218→D-222, 2026-09-21):** "lokalt kodbart arbeid oppbrukt" er IKKE en selv-uttalt
konklusjon som skal stå uimotsagt - Tobias sitt "Fortsatt å bygg"/"fortsett å bygg" (FEM separate
ganger samme dag) etter nøyaktig en slik påstand utløste fem runder som alle fant en reell, ubestridt
bug av SAMME anti-mønster-klasse (`.catch(() => undefined)`/bar `catch {}` som svelger feil sporløst).
D-220 ble tatt av CI for en feil DB-atferds-antakelse i egen test; D-221 anvendte den lærdommen
PROAKTIVT (dokumenterte/verifiserte `.catch()`-kjeding krever avviste løfter, ikke synkrone kast, OG at
en simulert ROLLBACK-feil likevel må utføre en EKTE ROLLBACK for å ikke korrumpere senere tester FØR
push) - CI grønt på FØRSTE forsøk. D-221s egen metode-lærdom: D-220s editering av to filer etterlot
tre søsken i SAMME filer - et grep bør derfor lete etter BÅDE `.catch(() => undefined)` OG et bart
`catch { }` uten fanget feil-variabel (sistnevnte er et STERKERE signal - ingen mulighet til å logge
originalfeilen uten en kodeendring). D-222s egen metode-lærdom: da D-221 sin egen "ingen kjent uløst
kandidat gjenstår"-konklusjon (korrekt, INGEN navngitt kandidat var glemt) møtte en ny "fortsett å
bygg", var riktig neste steg et HELT FRISKT, BREDT søk på tvers av HELE `apps/`/`modules/` (ikke bare
filene forrige runde rørte ved) - fant fire helt nye forekomster i TRE andre moduler
(`tool-gateway`/`situations`/`apps/api`), utenfor erasure-domenet D-218→D-221 hadde fokusert på.
Praktisk konklusjon for neste runde: sjekk FØRST om forrige runde selv la igjen en navngitt, uløst
kandidat; er den listen tom, kjør et helt friskt bredt søk FØR "oppbrukt" konkluderes igjen.

## Hvor `main` står nå

- **D-235 (2026-09-22, egen isolert worktree/branch `claude/fase-d235-infisical-host-acceptance`,
  PR #147 MERGET, `c06286c`):** Reproduserbart host-akseptansescript levert for D-35 sin 10-punkts
  Infisical-produksjonsport - `modules/owner-controls/scripts/infisical-live.ts`+
  `infisical-live-host-run.ts` (samme mønster som `stripe-real-payment-acceptance.ts`/
  `k1-owner-control-authority-host-run.ts`, plassert i `owner-controls` for å unngå en sirkulær
  pakkeavhengighet mot `tool-gateway`). Dekker alle 10 punkter, inkl. TRE reelt NYE (punkt 8
  rotasjon/tilbakekalling via Infisical sin egen `DELETE /api/v3/secrets/raw/:secretName`, verifisert
  mot Infisical sin egen backend-kildekode; punkt 10 hvelv-spesifikk `pg_dump`/restore-backup for
  `infisical`-databasen; D-213 sin skrive-sti `owner_controls.set_connector_credential`
  ende-til-ende). Punkt 4 (TLS) dokumentert `N/A_DOCUMENTED` med forbehold, ikke fabrikkert.
  `.env.example` fikk de seks manglende `INFISICAL_*`-variablene. 26 nye DB-uavhengige strukturtester.
  `pnpm -w typecheck`/`npx eslint .` rene, begge CI-jobber grønne. **KODE LEVERT, IKKE HOST-KJØRT** -
  `D-35=PRODUCTION_VERIFIED` gjenstår til Tobias faktisk kjører scriptet mot sin ekte
  Docker-Infisical-instans. Se D-235 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.
- **D-234 (2026-09-22, PR #146 MERGET, `2403577`):** Q-37 (Neo4j) og Q-38 (1Password) LUKKET - BEGGE
  DROPPET fra backlogen ("Hvis vi ikke trenger neo4j eller 1passord så dropper vi de" - Tobias,
  direkte chat). Business Graph (UA-3) dekker Neo4j-behovet, Infisical dekker 1Password-behovet -
  begge allerede produksjonsverifiserte/wired. Kun Q-39 (Windows/macOS) står igjen åpen av D-231 sine
  fem flaggede punkter.
- **D-233 (2026-09-22, PR #145 MERGET, `8d060d4`):** Q-36 (Supabase) LUKKET - Tobias bekreftet
  direkte at Supabase på D-231-listen betyr kun Postgres-hosting, ikke Supabase-spesifikke API-er.
  Ingen konflikt med regel 9, ingen ny connector, ingen kode.
- **D-232 (2026-09-22, egen isolert worktree/branch `claude/fase-d232-backlog-connectors-visible`,
  PR #144 MERGET, `80f5b2d`):** 50 nye backlog-connector-oppføringer i
  `modules/tool-gateway/src/connector-registry.ts` (64 totalt, opp fra 14), synlige i dashbordets
  "Integrasjoner"-seksjon som "ikke konfigurert" (ingen `live_test`, ingen credential satt). To nye
  `category`-verdier (`backlog`/`backlog_d64_gate`). `.env.example` fikk 50 nye tomme placeholder-
  linjer. 10 nye DB-uavhengige tester. `pnpm -w typecheck` (32/32)/`npx eslint .` rene. RENT
  SYNLIGHET - ingen D-64-port kjørt, ingen kode for noen faktisk leverandør-integrasjon. Se D-232 i
  DECISIONS_AND_ASSUMPTIONS.md.
- **D-231 (2026-09-22, egen isolert docs-only worktree/branch `claude/fase-d231-integration-backlog-plan`,
  parallelt med D-230/K2-dashboard-agenten på en ANNEN branch):** Tobias sin kuraterte 73-punkts
  integrasjonsliste registrert som backlog i `INTEGRATIONS.md` §4 (16 `ALLEREDE_BYGGET`/2
  `ALLEREDE_DEKKET`/53 `NY_BACKLOG`/2 `IKKE EN CONNECTOR`), fire nye åpne spørsmål lagt til
  (Q-36 Supabase, Q-37 Neo4j, Q-38 1Password, Q-39 Windows/macOS - se `OPEN_QUESTIONS.md`). REN
  DOKUMENTASJON - ingen kode, ingen credentials, `EXTERNAL_CREDENTIAL_SETUP_POLICY` (D-108) uendret.
- **PR #106-#140 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123), selvendring - EKTE requires_approval-produsent for vilkårlig kode + merge-
  koblingen (D-215, PR #125), UA-11 executive dashboard mutasjons-delen (D-216, PR #126), lokal
  whisper.cpp/piper STT/TTS - EKTE subprosess-implementasjon (D-217, PR #128), FEM uavhengige "silent
  error swallowing"-fikser (D-218 scheduler/D-219 policy-avslag-audit/D-220 erasure-fail-status-persist/
  D-221 erasure-rollback-stier/D-222 telegram+advisory-lock+device-registry, PR #130+#132+#133+#134+#135)
  - se git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **D-223 (2026-09-22, PR #136 MERGET, `78ca6c1` - ren dokumentasjons-/statusoppdatering, INGEN
  kodeendring):** Q-32 punkt 3 (lokal whisper.cpp/piper) er nå FULLSTENDIG lukket, ikke bare kode.
  Tobias lastet ned og installerte `whisper-cli.exe`+`ggml-small.bin` (whisper.cpp, fra `b5130`
  nightly-CI-releasen, IKKE hovedreleasen som kun har kildekode) og `piper.exe`+
  `no_NO-talesyntese-medium.onnx` (piper, norsk stemme fra `rhasspy/piper-voices`) på sin egen
  Windows-maskin, satte alle fire `JARVIS_WHISPER_*`/`JARVIS_PIPER_*`-miljøvariabler, og bekreftet EKTE
  norsk tale-syntese (`piper.exe` produserte en reell `.wav`-fil fra norsk tekst, avspilt og bekreftet
  å faktisk høres ut som norsk). D-217 sine `UNVERIFIED`-CLI-flagg-antakelser er nå bevist korrekte mot
  ekte binærer. Se D-223 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.
- **D-224 (2026-09-22, PR #137 MERGET - ren dokumentasjons-/statusoppdatering, INGEN kodeendring):**
  Stripe - ekte credentials konfigurert OG faktisk API-tilkobling bevist. Tobias opprettet en
  Stripe-konto, satte `JARVIS_STRIPE_SECRET_KEY` (`rk_live_...` restricted key)/
  `JARVIS_STRIPE_WEBHOOK_SECRET` (via `stripe listen --all-snapshot
  --live`)/`JARVIS_STRIPE_TENANT_ID` i `.env`, og et direkte `curl` mot `api.stripe.com/v1/balance`
  returnerte et ekte autentisert svar (`livemode:true`, `nok`). **PRESIST: dette er IKKE
  `STRIPE_LIVE_GATE=PASS`** - ingen eksisterende kodesti øvde faktisk `stripe_payment_execution`/
  `stripe_refund_execution`/`stripe_webhook_reachability` mot disse credentialene på dette tidspunktet (
  `stripe-live.ts`/`stripe-live-host-run.ts` bruker bevisst en fake transport-factory uansett ekte
  nøkler). Gate oppdatert fra `PENDING_CREDENTIALS` til
  `CREDENTIALS_CONFIGURED_AWAITING_LIVE_ACCEPTANCE_SCRIPT`. Se D-224 i DECISIONS_AND_ASSUMPTIONS.md,
  `docs/RUNTIME_GATES.md`, `docs/SOVEREIGN_GRADUATION_MATRIX.md` for full detalj.
- **D-225 (2026-09-22, PR #138 MERGET - EKTE KODE, ikke docs):** "gå videre med Stripe-
  akseptanseskriptet" - bygget `modules/finance/scripts/stripe-real-payment-acceptance.ts`+
  `-host-run.ts`, som lukker DEN NØYAKTIGE mangelen D-224 flagget - et akseptanseskript som faktisk
  gjør EKTE Stripe-API-kall (gjenbruker den allerede ferdigbygde `StripeTransport`, INGEN ny
  produksjonstransportkode) mot en Stripe TEST-modus-nøkkel (ny env-var `JARVIS_STRIPE_TEST_SECRET_KEY`,
  ALDRI den ekte live D-224-nøkkelen - tre uavhengige D-41-blast-radius-lag). Beviser, NÅR faktisk
  host-kjørt: `stripe_payment_execution` (ekte create+bekreft-med-test-kort+refresh),
  `stripe_refund_execution` (ekte refusjon), `stripe_webhook_reachability` (spawner ekte `stripe
  listen`, fanger dens ferske `whsec_`, lar Stripe sin EGEN ekte webhook-hendelse ankomme den kjørende
  serveren - ingen håndlaget fake-signatur denne gangen). `pnpm -w typecheck` (32/32)/`npx eslint .`
  rene. **IKKE ENNÅ HOST-KJØRT** - `STRIPE_LIVE_GATE` forblir UENDRET
  `CREDENTIALS_CONFIGURED_AWAITING_LIVE_ACCEPTANCE_SCRIPT` inntil Tobias faktisk henter en gratis Stripe
  TEST-nøkkel og kjører scriptet. Se D-225 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.
- **D-226 (2026-09-22, PR #139 MERGET - EKTE KODE, ikke docs):** Q-32 punkt 1 (OpenAI som
  taleprosessor) FULLSTENDIG lukket - Tobias verifiserte selv, live i chat, alle fire
  matrise-regel-3-felt (region=EU, DPA godkjent, trening-på-data korrigert fra en feilaktig "av"-
  antakelse til faktisk AV funnet PÅ og deretter DEAKTIVERT av Tobias, retensjon inntil 30 dager/ZDR
  tilgjengelig). `OpenAiStt`/`OpenAiTts` sin `processor_terms_status` flippet fra `"NOT_VERIFIED"` til
  `"VERIFIED"` i produksjonskode - OpenAI STT/TTS er nå `ALLOWED_EXTERNAL_PROCESSOR` for alle memory
  spaces UNNTATT `health` (D-23, uendret) og `CLIENT_ASSERTED`-autoritet (D-123, uendret). Alle berørte
  tester oppdatert. Se D-226 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.
- **D-227 (2026-09-22, PR #140 MERGET):** TOLV nye `catch {}`-steder som svelget feil helt sporløst i periodiske per-tenant
  sveipjobber - SAMME anti-mønster-klasse som D-218→D-222, denne runden ALVORLIGERE fordi en reell
  per-tenant-feil var UMULIG å skille fra legitim null-aktivitet i det returnerte sveipresultatet. Ni
  sveipfiler (`modules/finance/src/{neonomics,vipps,stripe,spend,wallester}-sweep.ts`,
  `modules/business/src/{open-loop,scoring}-sweep.ts`, `modules/business/src/business-event-sync.ts`,
  `modules/growth/src/action-recommendation-sweep.ts`) PLUSS tre søsken-steder i de underliggende
  `syncPending{Stripe,Vipps,Neonomics}Payments()`-metodene i `modules/finance/src/service.ts` (samme
  kallkjede, samme usynlighetsproblem). Fiks: strukturert `console.error` per steg, isolasjon/
  `failed`-tellere/retur-kontrakter UENDRET i alle 12 steder. Eksplisitt vurdert og UTELATT (dokumentert
  begrunnelse): `modules/knowledge/src/filesystem-source.ts` (forventet filsystem-churn, korrekt stille
  ved design), `modules/knowledge/src/sync.ts` (allerede har et synlig `report.failed`-signal til én
  direkte kaller, egen lavere-prioritert post), `service.ts` sine tre `catch { throw new Error(...) }`
  webhook-envelope-steder (IKKE stille - kaster synkront videre til HTTP-kalleren, tap av detalj er et
  separat, mindre problem). `pnpm -w typecheck` (32/32)/`npx eslint .` på alle 10 endrede filer rene.
  Kjørbare tester grønne (0 `AssertionError` i hele testkjøringen); alle 30 feilende testfiler feiler
  UTELUKKENDE på kjent sandbox-begrensning (`initdb: Permission denied`), ikke regresjon. CI (GitHub
  Actions) grønt på ALLE tre jobber (`gitleaks`/`build-test`/`windows-git-auth`). Se D-227 i
  DECISIONS_AND_ASSUMPTIONS.md for full detalj.
- **D-228 (2026-09-22, PR #141 MERGET, `c34732e` - EKTE KODE, fire iterative fiks-commits):** Tobias sin FØRSTE
  faktiske host-kjøring av D-225 sitt Stripe-akseptansescript. Fem reelle kodefeil funnet og rettet
  UNDERVEIS, live sammen med Tobias via skjermdeling: (1) `submit_payment_intent` kalt via feil
  ToolGateway-`tool_id` (`finance_stripe` i stedet for `finance`) - `unknown_tool`; (2) en
  `JARVIS_FIKEN_REFRESH_TOKEN`-sentinel som brukte `??=`, som IKKE overskriver en allerede TOM streng
  arvet fra `.env.example` - `credential_unavailable`; (3) `--all-snapshot` er IKKE et ekte Stripe
  CLI-flagg (verifisert mot Tobias sin FAKTISKE `stripe listen --help`, D-41 - aldri gjettet) - fjernet;
  (4) webhook-seksjonen ventet på en `payment_intent.succeeded`-hendelse som allerede var sendt/tapt
  FØR `stripe listen`-tunnelen koblet til (CLI-en er en LIVE tunnel, ALDRI en hendelses-omspilling) -
  rettet ved å trigge en FERSK betaling INNE i seksjonen, etter tilkobling; (5) CLI-en krevde separat
  interaktiv `stripe login` - rettet ved å sende test-nøkkelen direkte via `--api-key`. **Sluttresultat,
  FAKTISK host-kjørt og grønt** (`run_id=f3f70055`, `hard_fail=false`): ALLE tre navngitte kriterier
  PASS med ekte Stripe-bevis (en ekte PaymentIntent-ID/en ekte refusjons-ID/
  en ekte webhook-hendelses-ID), pluss `secret_redaction`/`cleanup` PASS.
  **`STRIPE_LIVE_GATE=PASS_PENDING_ARCHITECT_REVIEW`** (scriptets egen presise status - IKKE et
  ubetinget `PASS`, venter på uavhengig arkitektgjennomgang, samme presedens som W1 watchdog).
  `pnpm -w typecheck`/`npx eslint` rene for alle fire delfikser. Se D-228 i DECISIONS_AND_ASSUMPTIONS.md
  for full detalj.

- **D-230 (2026-09-22, branch `claude/fase-d230-k2-governance-dashboard`, PR #143 MERGET, `34bcac9`
  - krevde manuell konfliktløsning i `DECISIONS_AND_ASSUMPTIONS.md` mot D-231, begge D-ID-rader
  beholdt i rekkefølge, `pnpm -w typecheck` re-verifisert etter merge):** K2-dashboardet -
  `@jarvis/governance` (D-207) fikk sin første HTTP-rute/UI-flate.
  `apps/api/src/server.ts`: `GOVERNANCE_QUERY_ACTIONS`/`GOVERNANCE_MUTATE_ACTIONS` bak nye
  `POST /governance/query`/`POST /governance/mutate` (SAMME `deps.executive.gateway`-instans,
  `tool_id: "governance"`, ingen ny `ApiDeps`-nøkkel); `get_delegation_board` lagt til den
  eksisterende `EXECUTIVE_QUERY_ACTIONS` (nå fire, ikke tre, medlemmer). `apps/web/dashboard.html`:
  ny "Styring (K2)"-seksjon (beslutningslogg/scenarier/risikoregister/mål-OKR/delegeringstavle),
  ingen bekreftelsesmodal for governance-skriving (alle handlinger klasse A/B). 37 nye DB-uavhengige
  tester (`governance-query-mutate-wiring.test.ts`: 16, `dashboard-governance-wiring.test.ts`: 21) +
  `executive-query-wiring.test.ts`/`executive-mutate-wiring.test.ts` oppdatert for det fjerde
  `EXECUTIVE_QUERY_ACTIONS`-medlemmet - alle 57 relevante tester kjørt DIREKTE og grønne lokalt.
  `pnpm -w typecheck` (32/32)/`npx eslint .` rene. Full `pnpm -w test` i bakgrunnen: 856 linjer output
  over store deler av workspacet FØR verktøyets egen bakgrunnstidsavgrensning avsluttet prosessen (IKKE
  et eksplisitt sluttresultat denne økten) - eksplisitt grep for `FAIL`/`AssertionError`/`✗` i alle 856
  linjene ga NULL treff utenom kjent `initdb: Permission denied`-sandbox-begrensning (D-193→D-229).
  Verifiseres fullstendig av CI. Se D-230 i DECISIONS_AND_ASSUMPTIONS.md for full detalj.

## Andre åpne PR (utenfor denne øktens D-192-scope)

Ingen - **PR #97 LUKKET 2026-09-22, IKKE merget, ingen kode tatt inn.** Tobias bekreftet direkte i
chat at issue #68 sin ChatGPT-arkitektgjennomgang ikke lenger er en aktiv sti, og ga direkte fullmakt
(D-192-tillegg) til å avgjøre PR #97 selv. Ved forsøk på å merge (`mergeable_state=dirty`, 123 commits
bak `main`) ble konflikten undersøkt og avdekket at **PR #96** - opprettet ETT MINUTT etter PR #97,
samme dag (2026-09-19) - implementerte NØYAKTIG samme W1-watchdog-feature, gikk gjennom FEM
ytterligere reelle bugfikser (D-181 BLOCKER B1 t.o.m. D-193 BLOCKER B5, inkludert D-191 BLOCKER B4 -
kostnadssikringsmekanismen kunne strukturelt ALDRI utløses i produksjon under ekte RLS-håndhevet
runtime-rolle før den fiksen), besto host-akseptanse (16/16 markører, `run_id=28c2059a`), og ble
**merget** samme dag under DIREKTE D-192-fullmakt. `main` har derfor lenge hatt den komplette,
mer gjennomarbeidede watchdog-implementasjonen - PR #97 sin egen host-akseptanse (`run_id=2e40685c`,
2026-09-21) testet en allerede-utdatert kodeversjon som PASSET korrekt for det den faktisk inneholdt,
men manglet minst fem kjente, rettede feil. Å merge PR #97 ville stille re-introdusert allerede
rettede kritiske feil. Dette var en bokføringsglipp fra en tidligere økt (to parallelle branches for
samme oppgave, kun én fulgt opp til lukking) - lukket med forklarende kommentar, ingen ny kode.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå - **all lokalt kodbar arbeid er FERDIG t.o.m. PR #147.**
`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - dekker resten av masterplanen: Growth-stack
live-evidens, iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

**Q-32 er FULLSTENDIG LUKKET på alle tre punkter, EKTE på `main`** (D-226, PR #139 MERGET) - ingen
gjenstående handling for denne kapabiliteten, se `docs/OPEN_QUESTIONS.md`.

**Stripe (D-224/D-225/D-228): FAKTISK HOST-KJØRT OG GRØNT, PR #141 MERGET.**
`STRIPE_LIVE_GATE=PASS_PENDING_ARCHITECT_REVIEW` er nå det ENESTE gjenstående - siden issue #68 sin
ChatGPT-arkitektgjennomgang ikke lenger er en aktiv sti (Tobias bekreftet direkte), er dette et
Tobias-avgjørelsespunkt: enten en uavhengig gjennomgang av selve host-bevisdet et annet sted, eller
et direkte Tobias-akseptvedtak i chat om at den allerede leverte host-evidensen (`run_id=f3f70055`)
er tilstrekkelig til å kalle gaten et ubetinget `PASS`. Ingen ytterligere kode gjenstår.

**PR #97 (W1 watchdog) LUKKET uten merge, se "Andre åpne PR" over** - main har allerede en mer
gjennomarbeidet, allerede-merget watchdog-implementasjon (PR #96).

**D-35s 10-punkts host-produksjonsport for Infisical: reproduserbart akseptansescript LEVERT OG
MERGET (D-235, PR #147), MEN FORTSATT IKKE runtime-verifisert** - Tobias må selv kjøre
`infisical-live-host-run.ts` før `D-35=PRODUCTION_VERIFIED` kan erklæres.

**Q-39 (Windows/macOS) står åpen** - trenger en presisering fra Tobias om hva han faktisk mener med
disse to som egne "integrasjoner" før noe klassifiseres som byggbar backlog, se `OPEN_QUESTIONS.md`.

**De 50 nye backlog-connectorene (D-232) er RENT SYNLIGHET** - ingen credentials, ingen `live_test`,
ingen faktisk API-kode for noen av dem. Faktisk oppkobling venter på D-108
(`EXTERNAL_CREDENTIAL_SETUP_POLICY=DEFER_UNTIL_FINAL_INTEGRATION_PHASE`) - en samlet fremtidig fase,
ikke noe som bør startes stykkevis uten at Tobias ber om det. Seks av dem
(HubSpot/Pipedrive/Linear/Jira/Trello/Todoist, `category:"backlog_d64_gate"`) krever i tillegg en
egen D-64 Core-vs-Adapter-beslutningsport FØR noen kode skrives for dem.

Embedded-Postgres DB-avhengige tester (`initdb: Permission denied`) kan fortsatt ikke kjøres i DENNE
sandbox-økten - kjent, uendret begrensning; CI (GitHub Actions) kjører dem derimot uten problemer.

## Neste oppgave

**D-242 (denne PR-en) venter på CI/merge - når den er merget er det, per samme repo-gjennomgang som
fant D-242, IGJEN ingen kjent "byggbar uten Tobias"-kode.** Gjenstående punkter under er ellers enten
Tobias-handlinger, en Tobias-avklaring, eller målingsbaserte spørsmål som venter på reell bruksdata:

1. **D-35 Infisical (D-235, PR #147 MERGET) - Tobias kjører scriptet.** `node --env-file=.env
   --experimental-transform-types modules/owner-controls/scripts/infisical-live-host-run.ts` mot sin
   ekte Docker-Infisical-instans. Krever de seks `INFISICAL_*`-variablene satt i `.env` (se
   `.env.example`) OG at et Infisical-prosjekt/maskinidentitet allerede er opprettet
   (BO-07-prosedyren, `docs/RUNTIME_GATES.md`). Output limes inn for gjennomgang FØR
   `D-35=PRODUCTION_VERIFIED` kan erklæres.
2. **Stripe (D-228, PR #141 MERGET) - Tobias-avgjørelsespunkt.** `STRIPE_LIVE_GATE` er kode-messig
   FERDIG og host-kjørt grønt. Siden issue #68 ikke lenger er en aktiv sti, må Tobias selv bestemme om
   den allerede leverte host-evidensen holder til et ubetinget `PASS`, eller om han vil ha en ekstra
   uavhengig gjennomgang.
3. **Q-39 (Windows/macOS) - avklaring fra Tobias.** Mener han lokal skrivebordsautomatisering på
   Windows-PC-en (analogt Apple Shortcuts-punktet), noe knyttet til det eksisterende
   Apple/macOS-D-36-sporet, eller noe annet? Se `OPEN_QUESTIONS.md`.
4. **50 backlog-connectorer (D-232) - venter på samlet credential-fase.** Synlige i dashbordet, ingen
   kode/credentials ennå (D-108). Seks av dem (HubSpot/Pipedrive/Linear/Jira/Trello/Todoist) krever i
   tillegg en egen D-64-port før koding starter. Ikke noe å starte stykkevis uten Tobias sin
   prioritering av hvilken connector som er først.
5. **Fersk, BREDT kode-nivå gap-søk** (grep etter BÅDE `.catch(() => undefined)` OG et bart
   `catch { }` uten fanget feil-variabel, HELE `apps/`/`modules/`) hvis bedt om å fortsette å bygge -
   ingen kjent, allerede-registrert uløst kandidat gjenstår fra DENNE anti-mønster-klassen akkurat nå
   (D-227 lukket alle kjente sveip-relaterte funn).
6. **OpenAI-taleprosessoren (Q-32 punkt 1, D-226 MERGET) - valgfritt neste skritt.** Verifisere
   ende-til-ende at en ekte OpenAI STT/TTS-samtale faktisk fungerer i praksis (host-akseptanse, som
   D-223 gjorde for lokal tale) - ikke eksplisitt bedt om av Tobias ennå.
7. **Anthropic/OpenAI/Gemini connector-helsesjekk (D-242 - eksplisitt avgrenset, ikke bygget) -
   valgfritt neste skritt hvis Tobias ber om det.** De tre modell-leverandørene forblir
   `presence_only` i dashbordet - de går via `ModelGateway`, ikke `ToolGateway` (intet
   `tool_id`/`action` finnes for dem), så `ConnectorHealthSweep`/`live_test`-mønsteret dekker dem
   IKKE. En egen probe (lett, autentisert kall mot hver leverandørs modell-liste-endepunkt) er mulig,
   men krever egen design - ikke gjettet frem i D-242.
8. **`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - alle krever Tobias-kontoer/maskinvare/tilgang:**
   iPhone/Watch/Home/Personal/Health LIVE-bevis, Growth-stack live-evidens, off-site backup/monitoring,
   Apple Developer-konto/HA-instans, Google Ads-konto, Gemini-nøkler.
9. **Måles/avgjøres senere, ikke diskuteres nå:** Q-03 (STT/TTS-leverandør), Q-06 (WSL2 vs VM),
   Q-09 (kø-motstack), Q-10 (grafdatabase-behov), Q-11 (lokal GPU-økonomi), Q-12
   (satellitt-maskinvare), Q-19 (tale-latens-herding).
10. Merk: Tobias sin `rk_live_...` Stripe-nøkkel og en fersk `sk_test_...`-nøkkel ble begge limt inn
   direkte i chat (D-224 og en senere test-nøkkel) - han er selv klar over dette og har bekreftet at
   han roterer den live-nøkkelen senere; ingen handling påkrevd fra Claude nå utover å ikke glemme å
   nevne rotering om anledningen byr seg.
