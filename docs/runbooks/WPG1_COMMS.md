# WP-G1 (D-463) - UA-7 Communications Hub, resterende deler: runbook

**Status: ALT er DORMANT (AV som standard, bak `JARVIS_COMMS_*`-flagg) og `NOT VERIFIED`.** Ingen live-test mot noen leverandør er kjørt; ingen ekte melding, samtale eller kontaktendring er sendt. Alt er testet mot falsk transport (stubbet `fetch`) og ekte embedded Postgres (RLS som app-rolle).
Ingenting her er `VERIFIED`. `UA7_COMPLETE=false`. Juridiske deler er UTKAST (`docs/UA7_COMMUNICATIONS_DPIA.md` §10). Beslutningsloggen (D-463) og lukkematrisen oppdateres av leder, ikke her. Rollback = sett flagget AV (se §9).

## 1. Hva er bygget - status per prioritet (ærlige statusord)

| Pri | Del | Status | Bevis (test) | Merknad |
|---|---|---|---|---|
| P1a | Conversation Graph: slack, discord, whatsapp, sms, teams, messenger, instagram, phone; E.164 eksakt; reversibel merge/split | **WIRED** (alltid på, kun utvidelse) | `modules/conversation-graph/test/wpg1-channels.test.ts` (20) | migrasjon 117; confidence uendret; D-121-forpliktelser dekker de nye kanalene |
| P1b | Felles utgående policy (`evaluateOutboundPolicy`) + trakt + journal + opt-out + konto-allowlist | **DORMANT** (`JARVIS_COMMS_OUTBOUND`) | `policy`, `funnel-db`, `gateway-chain`, `owner-actions` | migrasjon 118; klasse D `outbound_message`; ingen eier-godkjenning (suveren eier uendret) |
| P1c | Kapabilitetsutvidelse Slack/Discord/WhatsApp/Twilio/Telnyx (send, rediger, slett egen, reaksjon, lesing, maler, inngående, STOP) | **PARTIAL** | `adapters`, `adapters-extra`, `calls-reads-gateway` | se §4 (Telnyx-lesing, Discord-inngående, medie-opplasting, malopprettelse: DEFERRED/NOT_BUILT) |
| P1d | Innkommende webhooks (Slack, Meta, Twilio, Telnyx): signatur, gjenspillingsvern, idempotent, ubetrodd | **DORMANT** (`JARVIS_COMMS_WEBHOOKS`) | `webhooks-verify` (9), `webhooks-ingest` (21), `wpg1-comms-routes` | ruter finnes KUN med flagget |
| P2e | Google Contacts (liste/søk/hent/opprett/oppdater/slett + lenking) | **DORMANT** (`JARVIS_COMMS_CONTACTS`); live **BLOCKED_EXTERNAL** | `contacts` (12) | eget OAuth-scope og eier-samtykke kreves |
| P2f | Teams (kun delegert sending), Messenger, Instagram (Meta Send API) | **PARTIAL**; live **BLOCKED_EXTERNAL** | `adapters-extra` | Teams-lesing, redigering/sletting og rotert refresh-token-lagring: DEFERRED |
| P2g | Møtetranskripsjon (tekst inn; lyd via port) | tekst **DORMANT** (`JARVIS_COMMS_MEETINGS`); lyd **BUILT_UNWIRED** | `meetings` (13) | migrasjon 119; ingen møte-bot; ingen produksjonsadapter for tale bundet |
| P3h | Utgående AI-samtale: regler + `start_call` (Twilio) | **DORMANT** (`JARVIS_COMMS_CALLS`) | `calls-reads-gateway` (15) | Telnyx-samtale DEFERRED; opptak ikke støttet; ingen ekte samtale |
| P3i | Oppfølgingssveip: ubesvarte meldinger -> åpne oppfølginger -> V2-push | **DORMANT** (`JARVIS_COMMS_REPLY_SWEEP`) | `reply-sweep` (5) | selve pushen er V2-pushen (WP-C4, `JARVIS_V2_PUSH_ENABLED`); APNs **BLOCKED_EXTERNAL** |

## 2. Flagg og konfigurasjon (alle AV/tom som standard; kun eksakt `on` slår et flagg på)

| Variabel | Standard | Virkning | Krever |
|---|---|---|---|
| `JARVIS_COMMS_OUTBOUND` | AV | `comms.*`-verktøyene, `/comms/preview` og `/comms/action`, policyen | `JARVIS_COMMS_CHANNELS` (tom = ingen sending) |
| `JARVIS_COMMS_CHANNELS` | tom | slåtte-på kanaler (`slack,discord,whatsapp,sms,teams,messenger,instagram,phone`); ukjent verdi stopper oppstart | - |
| `JARVIS_COMMS_WEBHOOKS` | tom | hvilke av `/webhooks/comms/{slack,meta,twilio,telnyx}` som finnes | `JARVIS_COMMS_TENANT_ID` + hemmelighet, ellers 503 |
| `JARVIS_COMMS_TENANT_ID`, `_MEMORY_SPACE` | - / business | hvor innkommende hendelser skrives (aldri health/home/guest) | - |
| `JARVIS_COMMS_PUBLIC_BASE_URL` | tom | URL Twilio signerer mot (https, uten avsluttende `/`) | ellers Twilio-ruten 503 |
| `JARVIS_COMMS_VENDOR_READS` / `_CALLS` / `_CONTACTS` / `_MEETINGS` | AV | leverandør-lesing / `start_call` / Google Contacts / møtepipeline | `JARVIS_COMMS_OUTBOUND=on` (ellers stopper oppstarten) |
| `JARVIS_COMMS_REPLY_SWEEP`, `_REPLY_AFTER_HOURS` (24), `_REPLY_WINDOW_DAYS` (7) | AV | ubesvarte meldinger -> oppfølginger (sveip hver 30. min) | `JARVIS_COMMS_WEBHOOKS` (innkommende) og `JARVIS_V2_PUSH_ENABLED` for push |
| `JARVIS_COMMS_QUIET_HOURS` (`off` slår av), `_QUIET_START` (22), `_QUIET_END` (8) | PÅ | stille timer (Europe/Oslo) | - |
| `_MAX_PER_RECIPIENT_DAY` (3), `_MAX_COLD_PER_RECIPIENT_DAY` (1), `_MAX_PER_ACCOUNT_HOUR` (30), `_MAX_CALLS_PER_NUMBER_DAY` (1), `_CALL_WINDOW_START/_END` (9/20) | se | ratebegrensning og samtalevindu (konservative valg, ikke lovfestet) | - |
| `JARVIS_COMMS_AI_DISCLOSURE_TEXT`, `_TEMPLATES_WITH_DISCLOSURE`, `_MEDIA_URL_HOSTS` | standardtekst / tom / tom | opplysningstekst, WhatsApp-maler eieren har attestert, tillatte medie-verter | - |
| `JARVIS_COMMS_INBOUND_RETENTION_DAYS` (30), `_LOG_RETENTION_DAYS` (400), `_MEETING_RETENTION_DAYS` (180) | se | oppbevaring | - |
| `JARVIS_META_GRAPH_VERSION` | `v25.0` (UVERIFISERT) | Meta Graph-versjon | - |
| Credentials (vault-først, kun api): `JARVIS_SLACK_BOT_TOKEN`, `JARVIS_DISCORD_BOT_TOKEN`, `JARVIS_WHATSAPP_TOKEN`, `JARVIS_TWILIO_ACCOUNT_SID`/`_AUTH_TOKEN`, `JARVIS_TELNYX_API_KEY`, `JARVIS_META_PAGE_ACCESS_TOKEN`, `JARVIS_INSTAGRAM_ACCESS_TOKEN`, `JARVIS_TEAMS_REFRESH_TOKEN`, `JARVIS_GOOGLE_CONTACTS_TOKEN` | tom | leverandør-credentials | - |
| Webhook-hemmeligheter: `JARVIS_SLACK_SIGNING_SECRET`, `JARVIS_META_APP_SECRET`, `JARVIS_META_WEBHOOK_VERIFY_TOKEN`, `JARVIS_TWILIO_AUTH_TOKEN`, `JARVIS_TELNYX_WEBHOOK_PUBLIC_KEY` | tom | signaturverifisering | tom = 503 |

`JARVIS_COMMS_GATE_LEGACY_NOTIFY` (de eldre `*.notify`-verktøyene gjennom den felles policyen) er **DEFERRED** og flagget er fjernet (ingen virkningsløst flagg). Alle variabler står i `SERVICE_ENV.api` (`infra/local/service-env.mjs`), compose er regenerert, og `.env.example` dokumenterer dem (vakt: `env-drift.test.ts`).

## 3. Autoritet og sikkerhetsmodell

- **Kun eieren.** `comms` står i `OWNER_ONLY_NAMESPACES`, `FORBIDDEN_MODEL_TOOL_IDS` og `SMS_LIKE`/`PRIVATE_NAMESPACES`: ingen modellflate (chat, tale, Telegram, executive-jobber) får noe `comms.*`-verktøy. Autonom Jarvis-initiert sending uten eierrute er **DEFERRED** (krever en egen D-beslutning om system-identitet).
- **Eierruten** (`POST /comms/preview`, `POST /comms/action`): grant -> suveren eier (`ownerGate`, fail-closed) -> step-up (signert enhet fra eier-kanal) for alt unntatt lesing og avmeldingsregistrering -> `ToolGateway.execute()`. Ruten har ingen egen sendevei. Sending/redigering/sletting/reaksjon/`start_call`/kontakt-create/update/delete og `meeting_delete` krever idempotensnøkkel; for utgående er `request_id` = nøkkelen.
- **Klasse D-kjeden** (uendret): notifier klar, idempotensnøkkel, preflight (policy FØR ledger-reservasjon), ledger, kall (policy kjøres på nytt rett før leverandørkallet), readback, umiddelbart eier-varsel uten meldingstekst. «Forsterket revisjon, ikke obligatorisk godkjenning» (suveren eier-modus for D er UENDRET).
- **Ubetrodd innhold** (e-post-/chat-/transkript-/kontakttekst, leverandørsvar): data i Ingestion Zone - renset (kontrolltegn/usynlige tegn fjernet, hemmeligheter redigert), merket `untrusted`, aldri instruksjon, aldri direkte til minne eller sending. Inntaket har ingen vei til verktøy/modell.
- **Tenant/rom/proveniens:** alle rader bærer tenant, memory space, person, sesjon, kilde og `task_id`/`ingest_id`; FORCE RLS (tenant + RESTRICTIVE rom). Mottakere lagres kun som pseudonym (SHA-256) + maskert visning.
- **Delegert bruker:** avvises (eier-binding + `owner_only`); test: `owner-actions` D-blokk.

## 4. D-41-revisjon per connector (eier-tilkoblet: maksimal nyttig kapabilitet; A-D styrer HVORDAN, aldri OM)

Forklaring: **V** = metodenavn/tillatelse verifisert via søk mot offisiell dokumentasjon i denne økten (WebFetch var blokkert - kun søkeutdrag); **U** = UVERIFISERT (kjent fra tidligere dokumentasjon, ikke bekreftet nå); **NB** = NOT_BUILT; **DEF** = DEFERRED med begrunnelse.

| Connector | Leverandør tilbyr (utdrag) | Bygget (antall) | Handling -> klasse | Scopes/tillatelser | Gap | Idempotens | Trygg sandbox |
|---|---|---|---|---|---|---|---|
| **Slack** | send/rediger/slett, reaksjoner, tråd-/historikklesing, brukere, filer, planlagte meldinger, kanaladmin | 8: send, edit_message, delete_message, add_reaction, read_thread, list_users + inngående (Events) | send D, slett D, rediger C, reaksjon B, lesing A | `chat:write`, `reactions:write`, `*:history` (V metodenavn), `users:read` (U) | filer, planlagte meldinger, kanal-/brukergruppeadmin: NB (DEF) | `request_id`=nøkkel; ledger+journal | eget test-workspace + test-kanal |
| **Discord** | send/rediger/slett, reaksjon, lese melding, tråder, moderering, roller | 5: send, edit, delete, react, get_message | send D, slett D, rediger C, reaksjon B, lesing A | SEND_MESSAGES, VIEW_CHANNEL, READ_MESSAGE_HISTORY (V i eksisterende connector), ADD_REACTIONS (U) | inngående hendelser (Gateway/Interactions), tråder, moderering: NB (DEF) | som over | eget test-server |
| **WhatsApp Business** | tekst, maler, media, reaksjon, malhåndtering, inngående webhook | 4: send (tekst/mal/media), react, list_templates + inngående | send D, reaksjon B, lesing A | `whatsapp_business_messaging` (U), 24 t-vindu (V via flere kilder) | malopprettelse/-sletting, media-opplasting, lesekvittering: NB (DEF) | som over | Metas test-nummer |
| **SMS Twilio** | send, lese, samtale, status, STOP | 3: send, read_message, start_call + inngående (signatur) | send D, samtale D, lesing A | Basic AccountSid/AuthToken (U for detaljer), feil 21610 = STOP (V) | planlegging, medieutsending (MMS): NB (DEF) | som over | Twilio test-credentials/nummer |
| **SMS Telnyx** | send, lese, samtalekontroll | 1: send + inngående (Ed25519) | send D | Bearer API-nøkkel | lesing og samtale: DEF (opplysningen kan ikke garanteres først uten `call.answered`-flyt) | som over | Telnyx test-nummer |
| **Teams (Graph)** | chat-/kanalmeldinger, lesing, reaksjoner, redigering | 1: send (chat/kanal) | send D | `ChatMessage.Send`/`ChannelMessage.Send` finnes KUN som DELEGERTE (V); lese-scopes U | app-only kan ikke sende (V); lesing, redigering, sletting, reaksjon: NB (DEF); rotert refresh-token lagres ikke (DEF) | som over | eget test-tenant/-team |
| **Messenger / Instagram** | Send API (RESPONSE, tagger), lesing, inngående | 1 hver: send (kun RESPONSE) + inngående (`page`/`instagram`) | send D | `pages_messaging` + side-token (V); app-gjennomgang kreves | tagger/engangsvarsler/sponsede meldinger: bevisst IKKE bygget; Instagram-Login-variant: U/DEF | som over | Meta test-side/-konto |
| **Google Contacts** | liste/søk/hent/opprett/oppdater/slett | 8: list, search, get, check_target, create, update, delete, sync | lesing A, create C, update C (etag), delete D, sync C | `https://www.googleapis.com/auth/contacts` (V); `connections.list`/`searchContacts`-parametre U | «other contacts», grupper, bilder: NB (DEF) | create/update/delete krever nøkkel; sync idempotent | eget test-Google-konto |

Risikoklasser per handling står i verktøydefinisjonene (`modules/comms/src/tools.ts`) og i manifestet; ikke-implementert kapabilitet er merket DEF/NB over, aldri stille utelatt. **Connector-manifestvakten** (`modules/connector-sdk`) er uendret: de nye `comms.*`-verktøyene er IKKE lagt i `CONNECTOR_REGISTRY` (D3-presedens; fullt manifest per connector via `node ops/connector/new-connector.mjs` er DEFERRED og rapporteres som sikkerhetsflate), og `SKELETON_BASELINE` er ikke utvidet.

## 5. Innkommende webhooks (P1d)

| Rute | Metode | Signatur | Vindu / gjenspilling |
|---|---|---|---|
| `/webhooks/comms/slack` | POST | `X-Slack-Signature` (v0 over `v0:<ts>:<rå kropp>`), `X-Slack-Request-Timestamp` | ±300 s; hendelses-id UNIQUE |
| `/webhooks/comms/meta` | GET (håndtrykk, verifiseringstoken) + POST | `X-Hub-Signature-256` (HMAC-SHA256 over rå kropp med app-hemmeligheten) | ingen tidsstempel: UNIQUE hendelses-id + ferskhet mot retensjon |
| `/webhooks/comms/twilio` | POST (form) | `X-Twilio-Signature` over `JARVIS_COMMS_PUBLIC_BASE_URL` + sti + sorterte parametre | ingen tidsstempel: UNIQUE + ferskhet; suksess besvares med tom TwiML |
| `/webhooks/comms/telnyx` | POST | Ed25519 (`telnyx-signature-ed25519` + tidsstempel) | ±300 s; UNIQUE |

Felles: rå bytes med hard grense (256 KB) FØR signaturen; konstanttids-sammenligning; kun kontoer eieren har autorisert lagres; svar viser kun tellere; per-IP-streng grense (30/min per sti) kun på slåtte-på stier; 503 uten tenant/hemmelighet/base-URL. Webhook-ruter er IKKE modellverktøy.

## 6. Verifisering på NAS/sandbox - trinn for trinn (`NOT VERIFIED` til eieren har kjørt dem)

1. **Forhåndssjekk:** `git log` viser WP-G1-commitsene; kjør `pnpm typecheck`, `pnpm check:containment` og de målrettede testene (§8). Ta full backup (`docs/remediation/BACKUP_RESTORE_RUNBOOK.md`) FØR migrasjon 117-119 kjøres på NAS (expand-only).
2. **Migrasjon:** start `migrate`-tjenesten; bekreft at 117, 118, 119 er anvendt og at `comms_*`-tabellene har FORCE RLS (`\d+`).
3. **Konto-allowlist (sandbox):** sett `JARVIS_COMMS_OUTBOUND=on`, `JARVIS_COMMS_CHANNELS=sms` og test-credentials; autoriser test-kontoen (`authorize_account`); kjør `/comms/preview` -> forvent regelutfall uten journal.
4. **Send (sandbox):** `/comms/action` `send` til EGET test-nummer med ny nøkkel; kontroller: leverandørmelding mottatt med AI-opplysning, journal `sent` (kun hash/lengde), eier-varsel i Telegram uten tekst; gjenta med SAMME nøkkel -> ingen ny melding.
5. **STOP:** svar STOPP fra test-nummeret (webhook slått på, Twilio-signatur mot `JARVIS_COMMS_PUBLIC_BASE_URL`); forvent avmelding registrert og at neste send avslås `recipient_opted_out`; svar START -> opphevet. Test 21610-mapping bare hvis Twilio faktisk svarer slik.
6. **Webhook-signaturer:** send en bevisst feil signatur -> 401/403 uten skriving; en gammel (>300 s) -> avvist; samme gyldige hendelse to ganger -> kun én rad.
7. **Samtale (valgfritt, sandbox):** `JARVIS_COMMS_CALLS=on`; ring et EGET nummer innenfor tidsvinduet; verifiser at opplysningen sies først og at opptak ikke er på. Ring ALDRI en tredjepart under verifisering.
8. **Kontakter:** eieren lager en egen refresh-token med scope `contacts` (re-samtykke) -> `JARVIS_GOOGLE_CONTACTS_TOKEN`; test `contacts_list`, `contacts_create` på en test-kontakt, `contacts_update` med riktig/utdatert etag, `contacts_delete`.
9. **Møter:** `JARVIS_COMMS_MEETINGS=on`; behandle et test-transkript med `attest_legal_basis: true`; kontroller at teksten ikke finnes i basen, at forslag opprettes, og at godkjenning gir en `business_followups`-rad.
10. **Oppfølging:** `JARVIS_COMMS_REPLY_SWEEP=on` + `JARVIS_V2_PUSH_ENABLED=true`; la en testmelding stå ubesvart > terskelen; forvent én oppfølging og én Telegram-påminnelse innenfor rolig tid/døgngrense.
11. **Rollback-prøve:** sett alle `JARVIS_COMMS_*` AV og restart; bekreft at `/comms/*` og `/webhooks/comms/*` er 404 og at verktøylisten er som på main.

## 7. BLOCKED_EXTERNAL og DEFERRED

**BLOCKED_EXTERNAL (krever eier/leverandør):** Meta app-gjennomgang og side-/Instagram-tilgang (Messenger/Instagram live); Teams delegert samtykke (nytt scope) og Entra-app; Google Contacts re-samtykke (`contacts`-scope); WhatsApp Business-verifisering og godkjente maler; Twilio/Telnyx-nummer og -vilkår; Reservasjonsregisteret-oppslag og samtykkeregister (JARVIS-084/Q-47f, ikke bygget); APNs (iOS-push, `JARVIS_APNS_AUTH_KEY` reservert); jurist-gjennomgang av DPIA §10.
**DEFERRED (ikke bygget, begrunnet):** autonom Jarvis-initiert sending uten eierrute (krever D-beslutning); de eldre `*.notify`-verktøyene gjennom den felles policyen; Telnyx-samtale og -lesing; Discord-inngående; Teams-lesing/redigering/sletting/reaksjon og lagring av rotert refresh-token; filopplasting/planlagte meldinger/malhåndtering; tale-adapter bundet til lokal Whisper og lyd-inngang for møter (ingen filsti-flate); transkript > ~500 000 tegn (egen opplastingsrute); fullt connector-manifest og dashbord-registrering for `comms.*`; dashbord-UI for kommunikasjon; opptak av samtaler; møte-bot (`CORE_DEPENDENCY_DECISION_REQUIRED` hvis ønsket).
**Bevisst IKKE bygget (CLAUDE.md/brief):** JARVIS-084 samtykkekontroller (Q-47f), Telegram-juridiske punkter i JARVIS-087, lokal PC-agent med filtilgang (Q-60), noe utenfor UA-7, ekte samtaler/sendinger.

## 8. Testbevis (kommandoer)

`pnpm exec vitest run <fil> --maxWorkers=2` som `postgres` (embedded Postgres): `modules/conversation-graph/test/wpg1-channels.test.ts`, `modules/comms/test/{policy,adapters,adapters-extra,funnel-db,gateway-chain,owner-actions,calls-reads-gateway,contacts,meetings,reply-sweep,webhooks-verify,webhooks-ingest}.test.ts`, `apps/api/test/wpg1-comms-routes.test.ts`.
Vakter som må forbli grønne: `packages/contracts/test/env-drift.test.ts`, `apps/api/test/{wph1-flag-off-selection-baseline,wph2-flag-off-main-parity,part3-tool-manifest,remediation-1-model-surface}.test.ts`, `modules/tool-gateway/test/connector-registry.test.ts`, `modules/connector-sdk/test/guard.test.ts`, `modules/core/test/{remediation-2-compose-isolation,remediation-2-schema-invariants,d420-processing-inventory}.test.ts`, `modules/erasure/test/*`.

## 9. Rollback

Sett de aktuelle `JARVIS_COMMS_*`-flaggene tomme/AV og restart api: ingen `comms.*`-verktøy, ingen `/comms/*`- eller `/webhooks/comms/*`-ruter (404), ingen sveip, ingen oppstartslogg - identisk med main (låst av `wpg1-comms-routes.test.ts` og baselinevaktene). Migrasjon 117-119 er expand-only og trenger ikke rulles tilbake (tabellene blir stående tomme/ubrukte). Avmeldinger og journal beholdes (rettighetsvern/bevis). Lekket credential: roter i vaulten; frys connector via `owner_controls` (`comms`-navnerommet og kanalens connector-id respekteres FØR leverandørkallet).
