# WP-SEC2 (D-487) - felles hemmelighetsskanner og redaksjon: runbook

**Status: koden er `WIRED` (alltid på: den delte skanneren er deterministisk kode uten flagg og uten migrasjon) og `NOT VERIFIED`.** Ingen NAS-observasjon er gjort; alt er testet med enhetstester og mot ekte embedded Postgres der det trengs. Ingenting her er `VERIFIED`. Leverandørfakta (token-formater) er `unverified` til offisiell dokumentasjon er lest (D-41): docs-vertene (`docs.github.com`, `docs.gitlab.com`, `docs.npmjs.com`, `www.twilio.com`) ga `ENOTFOUND` fra byggemiljøet (Q-68 pkt 6), så ALLE nye formater under er `unverified`.

Funn som dekkes: JARVIS-013 (P1), JARVIS-069 (P2), H2 N5 (DPIA-etiketter) og Q-65 pkt 2 («utvid `scanForSecrets`: ja, egen liten WP»). Innstramming/additiv; eieren kan veto. Ingen nye flagg, ingen migrasjon (155 var reservert og er ikke brukt), eksisterende API (`scanForSecrets`, `containsSecret`, `describeSecretFindings`) er uendret for kallere. D-369 («vanlig eier-tekst er trusted minnekilde») er IKKE endret.

## 1. Status per krav

| Krav | Status | Kode | Test |
|---|---|---|---|
| K1 evasjonsbestandig (normalisert visning + indekskart) | **WIRED** | `modules/core/src/services/secret-scan-view.ts`, `secret-scan.ts` | `modules/core/test/wpsec2-secret-scan.test.ts` (K1) |
| K2a delte tokens (klemt visning, kun prefiks-forankrede regler) | **WIRED** (fast lengde krever eksakt sum; se §6) | `secret-scan.ts` (`SQUEEZE_RULES`) | `wpsec2-secret-scan.test.ts` (K2a) |
| K2b `scanStructuredForSecrets` (søsken limes sammen) | **WIRED** (via `writeAudit`) | `secret-scan-structured.ts` | `wpsec2-structured.test.ts` |
| K3 nøkkelnavn-bevisst (JSON-tekst, Authorization, Cookie, strukturert) | **WIRED** | `secret-scan-keys.ts`, `secret-scan.ts` | `wpsec2-secret-scan.test.ts` (K3), `wpsec2-structured.test.ts` |
| K4 nye formater + hex/base64-policy | **WIRED**, alle formater `unverified` | `secret-scan.ts` (`PATTERNS`) | `wpsec2-secret-scan.test.ts` (K4) |
| K5 falsk-positiv-port | **WIRED** | `modules/core/test/fixtures/secret-scan-benign.txt` (114 linjer) | `wpsec2-benign-corpus.test.ts` |
| K6 ytelse/vinduer | **WIRED** | `secret-scan-view.ts` (`windowStarts`) | `wpsec2-secret-scan.test.ts` (K6), `wpsec2-structured.test.ts` |
| K7 alle lagringssteder via skanneren | **PARTIAL** (se §7) | `audit-writer.ts`, `message-store.ts`, `gateway.ts`, ... | `wpsec2-sinks.test.ts`, `wpsec2-sink-guard.test.ts`, m.fl. |
| K8 DPIA-etiketter som hviteliste (H2 N5) | **WIRED** | `apps/api/src/control-center/privacy.ts` (`DPIA_TRIGGER_LABELS`) | `apps/api/test/wph2-privacy-doc-reader.test.ts` (driftvakt mot det ekte dokumentet) |
| K9 JARVIS-013 ende-til-ende | **WIRED** | `conversation.ts` (uendret), `memory-writer.ts` (uendret) | `apps/api/test/part3-conversation-secrets.test.ts`, `modules/memory/test/memory.test.ts` |
| K10 AV/uendret + docs | **WIRED** | dette dokumentet | `d398-doc-banners`, `wpj-closure-matrix` |

## 2. Slik virker skanneren

1. **Visning (K1).** Mønstrene kjøres ikke mot den rå teksten, men mot en normalisert visning: NFKC per kodepunkt (fullbredde/kompatibilitet -> ASCII, `ﬁ` -> `fi`), alt usynlig fjernet (format-tegn `\p{Cf}` som nullbredde/bidi/myk bindestrek/tag-tegn, kontrolltegn unntatt `\n \t \r` (`\v \f` og NEL blir mellomrom), kombinerende merker `\p{Mn}/\p{Me}` inkl. variantvelgere og CGJ, løse surrogater, privat bruk, «default ignorable» som Hangul-fyllere, brailleblankt), tankestreker (U+2010-2015, U+2212) -> `-`, og en liten håndvalgt homoglyf-tabell (kyrillisk/gresk/latinsk utvidelse -> ASCII; `unverified`, IKKE hentet fra Unicode TR39; full TR39-dekning er `DEFERRED`). Hvert visningstegn husker kodepunktet det kom fra (indekskart), og et treff erstatter HELE det opprinnelige spennet (første til siste tegn, også skjulte tegn midt i) med `[REDACTED:<type>]`. Skjulte tegn UTENFOR spennet (før/etter) beholdes. **Tekst uten funn er BYTE-IDENTISK uendret** (testet for æøåÆØÅ i NFC/NFD, emoji med ZWJ, ligaturer, kombinerende aksenter, CJK, arabisk, hindi, kyrillisk); skanningen er idempotent.
2. **Konflikter.** Mønstrene kjøres i prioritetsrekkefølge (`PATTERNS`); et treff på hele teksten forkastes hvis tegn allerede eies av en annen type, og et treff med verdigruppe (`NAVN=verdi`, URL-passord) forkastes hvis verdien begynner i et eid område (samme oppførsel som da mønstrene kjørte etter hverandre på en stadig mer redigert tekst). Samme type på samme sted slås sammen til ett spenn; funn telles per sammenslått spenn.
3. **Klemt visning (K2a).** Visningen med mellomrom/linjeskift fjernet der begge naboer er token-tegn (`[A-Za-z0-9_.+/=-]`). KUN de prefiks-forankrede reglene kjøres mot den (`ghp_ gho_ ghu_ ghs_ ghr_`, `github_pat_`, `sk-ant-`, `sk-`, `xox?-`, `AKIA/ASIA`, `eyJ` (JWT), `-----BEGIN ... PRIVATE KEY`, `SG.`, `npm_`, `gl*-`, `hf_`), og prefikset må stå ved en ordgrense i den vanlige visningen. For formater med FAST kropp (`ghp_` 36, `github_pat_` 82, `AKIA` 16, `npm_` 36; `unverified`) godtas et delt treff kun når den sammenslåtte kroppen er EKSAKT så lang (prosa etter et ferdig token og et prefiks nevnt i en setning gir da så godt som aldri treff); variable formater krysser kun blanke mens kroppen er kortere enn minstelengden og neste fragment er langt eller ser ut som en token-hale (siffer/store bokstaver midt i). Mellomrom mellom HVERT tegn («g h p _ x x x ...») fanges også (enkelttegn-modus etter to enkelttegn-fragmenter). Høyst 8 flerteckens-blank-rekker per treff.
4. **Vinduer (K6).** Inndata over `SCAN_WINDOW_CHARS` (262 144 UTF-16-enheter) skannes i vinduer med `SCAN_OVERLAP_CHARS` (16 384, minst 8 KiB) overlapp; vindusstart flyttes bakover til en ordgrense. En hemmelighet på høyst overlappets lengde ligger helt i minst ett vindu. En privat nøkkel uten avslutning bæres videre mellom vinduer (fail-closed til slutten av teksten). Hemmeligheter lengre enn overlappet uten mellomrom kan få en uredigert hale over en vindusgrense: kjent gap.
5. **Strukturert (K2b/K3).** `scanStructuredForSecrets(value)`: hver streng skannes; søsken-strenger i samme objekt/liste limes med linjeskift og skannes sammen (`["ghp_", "A1b2…"]` fanges, uavhengige ord røres ikke); en hemmelig NØKKEL gjør verdien (og alt under den) til en hemmelighet uansett format; teller-/metadatanøkler beholder verdien; dybde over 64, over 500 000 noder og sykliske referanser gir `[REDACTED:structure_limit]` (fail-closed, aldri stakkoverflyt). Uendrede verdier returneres som samme objekt.

## 3. Hva som fanges (type, format, kilde)

Alle formater under «ny» er `unverified`: kjent offentlig praksis, IKKE lest i offisiell dokumentasjon (se toppen). «gammel» = fantes før WP-SEC2 (også `unverified`).

| Type | Format | Merknad |
|---|---|---|
| `private_key` | `-----BEGIN [<ord>] PRIVATE KEY[ BLOCK]-----` ... `END` (eller til slutten) | gammel; nå også med skjulte tegn og delt over blanke |
| `jwt` | `eyJ….eyJ….<sig>` | gammel; nå også delt |
| `github_token` | `gh[pousr]_` + 20+ / `github_pat_` + 20+ | gammel |
| `anthropic_key`, `openai_key` | `sk-ant-…`, `sk-[proj-]…` | gammel |
| `stripe_key`, `slack_token`, `aws_access_key`, `google_api_key`, `telegram_bot_token`, `enrollment_ticket` | `sk_live_…`, `xox?-…`, `AKIA/ASIA…`, `AIza…`, `<id>:<35>`, `enr_…` | gammel |
| `bearer_token` | `Bearer <16+ tegn>` | gammel; erstatter hele «Bearer <token>» (uendret: `modules/growth/test/wpd3-write-engine.test.ts` låser det) |
| `url_credentials` | `skjema://bruker:passord@vert` (kun passordet) | gammel |
| `named_secret` | `NAVN=verdi`/`NAVN: verdi` (TOKEN/SECRET/PASSWORD/PASSWD/API_KEY/PRIVATE_KEY/CREDENTIAL/AUTH i navnet; store-bokstav-`*_KEY`) | gammel; stakksporinger som `auth.js:41:11` er nå unntatt (kildeplassering, ikke verdi) |
| `named_secret` (JSON) | `"navn":"verdi"`, `'navn':'verdi'`, `\"navn\":\"verdi\"` når NAVNET er en hemmelighet (§4) | ny |
| `authorization_header` | `Authorization: <skjema> <credential>` for alle skjemaer (`Basic Bearer Token ApiKey Bot SSWS OAuth ...`); kun credential redigeres; `Digest`/`AWS4-HMAC-SHA256`/`Hawk`/`OAuth` redigeres til linjeslutt; også `Proxy-Authorization` og JSON-form | ny; fikser «Authorization: Bearer abc123» (ordet «Bearer» ble redigert og `abc123` stod igjen) |
| `cookie_header` | `Cookie:`/`Set-Cookie:` med `navn=verdi` først | ny |
| `spoken_password`, `spoken_code`, `card_number` | «passordet mitt er …», «PIN-koden er …», Luhn | gammel (kortregelen er IKKE utvidet) |
| `sendgrid_key` | `SG.<16+>.<16+>` | ny, `unverified` |
| `npm_token` | `npm_` + 30+ | ny, `unverified` |
| `gitlab_token` | `gl<pat\|dt\|rt\|ptt\|ft\|imt\|agent\|cbt\|soat\|oas>-` + 20+ | ny, `unverified` |
| `google_oauth_token` | `ya29.` + 20+, `GOCSPX-` + 20+, `1//0` + 30+ | ny, `unverified` |
| `slack_app_token` | `xapp-<siffer>-…` | ny, `unverified` |
| `huggingface_token` | `hf_` + 30+ | ny, `unverified` |
| `azure_key` | `AccountKey=`/`SharedAccessKey=`/`PrimaryMasterKey=`/`SecondaryMasterKey=` + verdi; `sv=<dato>…&sig=<verdi>` (SAS) | ny, `unverified` |
| `secret_blob` | hex (≥ 32) eller base64 (≥ 32, blandet store/små/siffer) KUN rett etter `secret/key/token/password/passwd/passord/credential/hmac/salt/pepper/signature/seed/nøkkel/hemmelighet` | ny; AWS hemmelig nøkkel dekkes kun i nøkkelkontekst (`aws_secret_access_key=…`/JSON), ikke som nakne 40 tegn |

Kjente formater UTEN connector/måling som IKKE er lagt til (`DEFERRED`, fordi de er `unverified` og uten Jarvis-connector): Groq (`gsk_`), xAI (`xai-`), Supabase (`sbp_`), DigitalOcean (`dop_v1_`), Shopify (`shpat_`), Notion, Linear, Sentry, Twilio-auth-token (32 hex, kun i kontekst), Cloudflare API-token (ingen prefiks; dekkes kun i `NAVN=verdi`/JSON-kontekst).

## 4. Nøkkelnavn (K3)

Navnet normaliseres (camelCase delt, små bokstaver, skilletegn likestilt) og deles i ord. En nøkkel er en hemmelighet når dens SISTE meningsbærende ord er et hemmelighetsord i ENTALL (`password passwd pwd passord passphrase kodeord hemmelighet secret token credential(s) cookie authorization bearer jwt otp pin auth` + sammenskrevne `accesstoken/clientsecret`) eller `<api|private|secret|access|signing|encryption|master|license|auth|service|session|hmac|webhook|client|shared|bearer> key`; ord som `value text string plain raw data pem hex base64 b64 code` strippes først (`token_value`, `private_key_pem`, `pin_code`). Nøkler der hemmelighetsordet står FORAN noe annet beskriver noe relatert og røres ikke (`credential_binding: "owner_bound"`, `secret_manager`, `token_endpoint`) - ellers ville enum-/metadatafelt og connector-manifester bli ødelagt (oppdaget av `modules/connector-sdk/test/contract-kit.test.ts`). **Hviteliste:** nøkler som ender på et teller-/metadataord (`count checked at type length size total required enabled set present ttl expires expiry version status name ref id kind source provider scope hint algorithm format policy mode min max limit rate hash digest fingerprint url uri endpoint path file header ...`) beholder verdien (`token_count`, `passwords_checked`, `token_type`, `expires_at`, `secret_name`, `password_hash`, `api_key_id`). Flertall (`tokens`, `passwords`) er aldri hemmelighetsord alene (tellere: `input_tokens`, `max_tokens`). Tall under en nøkkel redigeres kun under STERKE nøkler (passord/PIN/privat nøkkel/API-nøkkel), aldri under `token`; boolske verdier og `null` aldri; korte verdier under ikke-sterke nøkler (`auth: "none"`) ikke. Alt dette er håndvalgt og `unverified` mot leverandørenes feltnavn.

## 5. Falsk-positiv-policy (K5)

- **Korpus:** `modules/core/test/fixtures/secret-scan-benign.txt` (114 linjer: norske e-poster, kalender, møtenotater, kontonummer/KID/org.nr./telefon/fakturanr., git-SHA, UUID, docker-digest, filstier, stakksporinger, kode med `password`/`token` uten verdi, lange sammensatte norske ord, URL uten credentials, JSON med `token_count`, prefikser nevnt i prosa, Authorization/Cookie i prosa) skal gå byte-identisk gjennom skanneren (hver linje, NFC/NFD, hele filen). Hver ny regel har minst ett nytt godartet tilfelle der.
- **Hex/base64 frittstående flagges ALDRI** (policy, ikke gap): hasher, digester (`sha256:`), trace-id-er, git-SHA-er, UUID-er og base64-data (`data:`-URI, vedlegg) står overalt i audit-/ledger-/forhåndsvisningsdata, og en frittstående 64-hex kan like gjerne være et sjekksum som en hemmelighet. De redigeres kun med et hemmelighetsord rett foran (`secret_blob`), og aldri hvis verdien er en UUID, en ren sifferrekke, en slug eller en sti. En frittstående hemmelighet i hex/base64 uten kontekst slipper dermed gjennom (kjent gap; en entropiklassifikator uten terskel og godartet korpus er utenfor omfanget - «Bygges IKKE»). Lead/eier kan overstyre.
- Kortnummerregelen (Luhn) er IKKE utvidet.
- Kjente falske positiver som FINNES: et ferdig token med prosa uten skilletegn rett etter, hvis tokenet er kortere enn standardlengden og prosaen akkurat fyller opp lengden; et prefiks i prosa fulgt av nøyaktig så mange tegn kort tekst uten skilletegn som kroppen skal ha (sjeldent, og skaden er et par ord).

## 6. Grenser og ytelse (K6)

Alle adversarielle tester tar under 2 s (testet; typisk tosifret ms): 1 MB nullbredde/kombinerende/fullbredde, 500 KB gjentatt `ghp_` uten kropp, gjentatt `-----BEGIN PRIVATE KEY-----` uten END, `eyJ`+punktum-flom, `a.`-flom, mellomrom mellom token-tegn, `Cookie:`-/`Authorization:`-/JSON-nøkkel-flom, JSON-dybde 10 000 og 100 000 søsken-strenger. Grenser: vindu 262 144 tegn, overlapp 16 384, strukturert dybde 64, maks 500 000 noder, søsken limes bare under 1 MiB. Alle regexer har avgrensede kvantifikatorer; en kvadratisk regel i en tidligere lokal kopi (`[A-Z0-9_]*` uten tak i `redact.ts`/`docker-transport.ts`) er fjernet ved konsolideringen (§7).

## 7. K7: lagringssteder (inventar)

Maskinlesbar baseline: `modules/core/test/fixtures/secret-sink-baseline.json` (alle 101 `INSERT INTO`/`UPDATE ... SET`-filer i produktkoden). Vakten `modules/core/test/wpsec2-sink-guard.test.ts` feller en NY (fil, tabell)-skriving som ikke er klassifisert, og feller hvis et `verified`-sted mister skannebeviset sitt.

| Sted | Status | Merknad |
|---|---|---|
| `audit_events` (`writeAudit`, `modules/core/src/services/audit-writer.ts`) | **SKANNET** (var UBEHANDLET) | én skriver; `reason` som tekst, nyttelast strukturert (nøkkelnavn, søsken, skjult/delt); funn lagres kun som typer i `secret_redacted`; uten funn byte-identisk |
| `messages` (`MessageStore.save`) | **SKANNET** (var kun skannet for eierens tekst i samtalemotoren) | alle roller (assistent/verktøy/system); idempotent mot allerede redigert bruker-tekst |
| `tool_executions.postcondition_reason` og feiltekst i ledger/audit (`gateway.ts`) | **SKANNET** (skann-først-kutt-etterpå via `clipRedacted`) | |
| `tool_executions.before_state`/`after_state` (ledger) | **DEFERRED** | er GJENOPPRETTINGSGRUNNLAGET (`incidents/recovery.ts` leser dem; se `vendor-text.ts`). Redaksjon ville ødelagt gjenoppretting av en hemmelighetsbærende tilstand. Audit-kopien (`before_state`/`after_state`/`recovery` i nyttelasten) ER redigert. Forslag: eget D-valg (kryptering i hvile eller egen hvelv-rad) |
| `artifacts` (`ArtifactStore.save`, `tasks/coding.ts`) | **SKANNET** (var kuttet FØR skann) | skann (inntil 4 MiB), kutt til 100 000 etterpå |
| `policy_decisions` (`policy-audit-sink.ts`) | **SKANNET** (var kuttet til 4096 og kontrolltegn byttet FØR skann) | skann først, kontrolltegn etterpå |
| `vendor-text.ts` (leverandørtekst til verktøysvar/ledger) | **SKANNET** (var kuttet til 64 KB FØR skann) | nå 1 MiB-tak |
| `tasks.goal` (`task-service.ts`, `chat-jobs.ts`), `incident*` (`incidents/service.ts`), `claim_*`, `memory_*` (`memory-writer.ts`), `action_confirmations`, `comms_*`, `growth_write_journal`, `personal_action_journal` | **SKANNET** (filnivå; bevist per sted for `tasks`, `incidents`, `incident_evidence`, `claim_evidence`, `memory_items`) | `incidents`-delen bruker nå felles `redactLogText` |
| Resten (72 filer: `business_*`, `operations_*`, `support_tickets`, `governance` (`goals/risks/decision_log`), `agreements/contracts`, `product_*`, `situations`, `conversation-graph`, `family/*`, `comms_meetings`, `model-gateway` council/collaboration-artifacts, `knowledge/sync.ts`, `memory/summaries|profile|vectors`, `self-modification`, `health/location/vision` (sensorstruktur), `finance/*` (belop/id/enum), `*_webhook_events`) | **UBEHANDLET (DEFERRED/PARTIAL)** | klassifisert som `unreviewed` i baseline; hver krever en enkeltvis vurdering av hvilke kolonner som er fritekst fra ubetrodde kilder. Mest aktuelle neste: `support_tickets`/`support_ticket_events` (kundetekst), `business_*`-notater, `council`/`collaboration` (modellutdata) og `knowledge/sync.ts` |
| Logger (`console.*` med `.message`): `modules/tool-gateway`, `modules/finance` | **SKANNET** via `redactForLog` (24 steder: `scheduler`, `oauth-refresh`, `live-transports` (Telegram), alle finance-sveip og `service`/`card-service` rydde-/tilbakerullingslogger) | én linje, skann først, kutt sist, aldri kastet feil |
| Logger: `apps/voice-gateway` | **DEFERRED** | Voice Gateway er egen prosess og har `@jarvis/core` kun som devDependency (kjøretid: `@jarvis/contracts` + `ws`); å importere skanneren ville bryte isolasjonen (CLAUDE.md regel 5) og produksjonsinstallasjonen. Forslag: trekk skanneren ut i en liten pakke uten DB-avhengighet (egen D-beslutning) |
| Logger: `apps/api` (`server.ts`, `main.ts`, `worker-main.ts`, `executive.ts`, `conversation.ts` m.fl., ca. 25 steder) | **PARTIAL** | `conversation.ts` skanner allerede to steder; resten logger `err.message` uten felles redaksjon. Ikke endret her: kildevaktene (`d449-*`, `wpn1-*`) bruker naive kommentarstrippere på `server.ts`/`main.ts` |
| Konsolidering (K7d) | **WIRED** | `incidents/src/redact.ts` og `tool-gateway/src/docker-transport.ts` bruker nå ÉN felles `redactLogText` (`@jarvis/core`; lokale former + sentralen; aldri svakere). Gjenværende mønsterkopier: `tool-gateway/src/github-app-auth.ts` (`TOKEN_PATTERN`, bevisst egen loggerregel), `ops/claude-worker/lib/health.mjs` og `ops/acceptance/record-evidence.mjs` (host-verktøy i `.mjs` som ikke kan importere TypeScript-kjernen) - `PARTIAL` |

## 8. K8: DPIA-etiketter (H2 N5)

`safeDpiaLabel` (`apps/api/src/control-center/privacy.ts`) var en svarteliste. Nå slipper kun de 12 eksakte, normaliserte (NFC, blanke slått sammen) etikettene i `DPIA_TRIGGER_LABELS` (radene i `docs/security/PROCESSING_INVENTORY.md` §3) gjennom, og det som returneres er alltid konstanten; alt annet gir `DPIA-trigger N` med `filtered: true`. Driftvakt: `wph2-privacy-doc-reader.test.ts` leser det ekte dokumentet og feller når en rad i §3 ikke står i konstanten (og omvendt). **Integrasjon:** andre pakker kan endre §3 - da feller driftvakten ved sammenslåing, og `DPIA_TRIGGER_LABELS` må oppdateres bevisst (samt `apps/api/test/fixtures/wpg3b-privacy-center-main-baseline.json` om den syntetiske oversikten endres). Opptaket ble regenerert én gang (to ekte etiketter i den syntetiske oversikten; gammel svarteliste og ny hviteliste ga byte-identisk rapport for dem).

## 9. Kjente gap

- Frittstående hex/base64 (policy, §5), prefiks-formater uten leverandørdokumentasjon (`unverified`), homoglyfer utover den lille tabellen og forhåndssammensatte diakritiske bokstaver (`ġhp_`): `DEFERRED`.
- Delte tokens av ikke-standard lengde (fast-lengde-formater krever eksakt sum) fanges bare for den sammenhengende delen; tokens delt av tegn som ikke er blanke (`> ` i sitert e-post) fanges ikke over delingen.
- En hemmelighet lengre enn 16 KiB uten mellomrom over en vindusgrense kan få uredigert hale.
- En privat nøkkel uten avslutning i ET søsken (strukturert) sluker ikke søsknene (hver streng skannes for seg), men BEGIN i ett og END i neste fanges.
- `before_state`/`after_state` i ledger (§7), voice-gateway-logger (§7) og de uklassifiserte lagringsstedene er ikke dekket.
- Overstyring av `Authorization`-tekst med ukjent skjema: credential = første ord etter et kjent skjemaord, ellers første ord; en hemmelighet med mellomrom i en ukjent-skjema-header kan stå delvis igjen.

## 10. NOT VERIFIED: slik verifiseres det på NAS (eier/lead, ikke gjort)

1. Etter utrulling: send en melding med et nullbredde-token i testkanalen og bekreft i `messages` (og `audit_events`) at kun `[REDACTED:<type>]` er lagret (`SELECT content FROM messages ORDER BY created_at DESC LIMIT 3`).
2. Kjør `docker logs` på `api`/`worker` etter en bevisst leverandørfeil og bekreft at `error`-feltet ikke inneholder en hemmelighet.
3. Åpne Personvern-senteret og bekreft at DPIA-radene viser de 12 kjente etikettene (ingen `DPIA-trigger N`).
4. Sjekk at ingen merkbar forsinkelse er kommet på `writeAudit`-tunge flyter (skanning er lineær; mål p95 for en samtaletur før/etter).
