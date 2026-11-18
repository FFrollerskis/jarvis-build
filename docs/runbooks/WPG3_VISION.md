# WP-G3 (D-465) - UA-9 Syn og fysisk verden: kilder, lokal klassifisering, bilde-lagring, «sist sett» og iPhone-opptak

**Status: BYGGET, SOVENDE (AV som standard), IKKE VERIFISERT mot noe ekte kamera, ingen ekte Home Assistant og ingen ekte visjonsmodell.** Alt under er testet mot lokale, falske kilder/servere
(embedded Postgres + ekte `ModelGateway`/ekte adapter mot en lokal HTTP-server); ingen ekte nettkall og ingen ekte kamera er brukt. Ingenting her er `VERIFIED`.

Personvern: `docs/UA9_VISION_DPIA.md` (UTKAST, IKKE juridisk gjennomgått - særlig for andre personer i bildet og arbeidsplass) og `docs/security/PROCESSING_INVENTORY.md` (avsnittet «Syn og fysisk verden»).

## 1. Hva er bygget (statusord)

| Del | Kapabilitet | Status | Merknad |
|---|---|---|---|
| P1a | `VisionSource`-adapter + Home Assistant-implementasjon (hendelses-øyeblikksbilder, aldri kontinuerlig video) | DORMANT | `JARVIS_VISION_ENABLED` + `JARVIS_VISION_HA_POLL`; poller (`modules/vision/src/poller.ts`) med eier-kontroll-port |
| P1a | Lagring via `StorageAdapter` (lokal disk, 0700/0600) med oppbevaring | DORMANT | `JARVIS_VISION_STORE_SNAPSHOTS` + `JARVIS_VISION_STORAGE_DIR`; kun sone `home` + policy `store_snapshot` |
| P1a | Idempotens på (kilde, ekstern hendelses-id); ubetrodd innhold = data | DORMANT | `source_event_id = <entity>@<last_changed>`; sjekkes FØR bilde/modell |
| P1b | Klassifisering med LOKAL visjonsmodell via `ModelGateway` (`local_vision`) | DORMANT | `JARVIS_VISION_CLASSIFIER` + `JARVIS_VISION_LOCAL_URL`; skybilder forbudt i kode OG test; adapteren sender bilder (`image_url` data-URL) kun med `{ vision: true }` |
| P1c | Embeddings i eksisterende vektorlager, temporalt minne, romassosiasjon, inventar (confidence/utløp), «sist sett» | DORMANT | migrasjon 135; `ref_kind = 'vision_event'`; kun lokal embedding; «hvor er nøklene» = `POST /vision/last-seen` |
| P1c | Retensjon/sletting håndhevet + erasure-suiten utvidet | WIRED (når flagg på) | daglig + lett vedlikehold; `modules/erasure/test/vision-g3-erasure.test.ts` |
| P2d | iPhone-kamera på forespørsel: serverkontrakt (forespørsel -> enhetssignert opplasting av ETT bilde -> samme pipeline) + fake enhet | DORMANT (server) / **BLOCKED_EXTERNAL** (app) | `/vision/capture/*`; iPhone-appen er ikke bygget |
| P2e | Deterministisk strømruting per kamera/sone (home/workplace/shared); kamerabilder forlater aldri maskinen; akseptansekriterium 3 bevist i test | DORMANT | `modules/vision/src/policy.ts` (ren funksjon) + DB-CHECK |
| P3f | `no_biometric`-vakt og vakt mot kontinuerlig rå video (+ ingen egen nettverksvei) | WIRED (CI-port) | `modules/vision/test/g3-guards.test.ts`, med mutasjonsbevis |
| - | Eier-API `/vision/*` (kamera-register, «sist sett», inventar, opptak) | DORMANT | `deps.vision` finnes kun med `JARVIS_VISION_ENABLED=on`; ellers 404 |
| - | Modellvendt vision-verktøy (chat kan spørre «hvor er nøklene?») | **DEFERRED** | krever restricted-/utførelsesvern (kjent åpent hull N1), intents, manifest og baselines |
| - | HA WebSocket-push, kamerastyring, visuell romgjenkjenning, fraværs-utleding, bildeembeddinger, app-nivå-kryptering | **DEFERRED** | se §7 |
| - | iPhone-appen, APNs | **BLOCKED_EXTERNAL** | fysisk enhet/entitlements |

**Brukerflate:** kun eier-API-et `POST /vision/...` (alle ruter er POST med `grant_token`). Ingen modellverktøy, ingen nye intents, ingen endring i verktøylister, rate-grenser eller andre ruter (flagg av = identisk med main; bevist i `apps/api/test/wph1-flag-off-selection-baseline.test.ts`, `wph2-flag-off-main-parity.test.ts` og `wpg3-vision-runtime.test.ts`).

## 2. Flagg og konfigurasjon

Alle flagg er AV som standard og slås på KUN med eksakt verdi `on` (`true`/`1`/`ON` gjør ingenting). `JARVIS_VISION_ENABLED` er hovedbryter: uten den er alle underflagg uten virkning.

| Variabel | Standard | Virkning |
|---|---|---|
| `JARVIS_VISION_ENABLED` | tom | Hovedbryter: `/vision/*`, pipeline, vedlikeholdssveip. Uten den bygges ingenting. |
| `JARVIS_VISION_CLASSIFIER` | tom | Registrerer `local_vision`-adapteren (krever `JARVIS_VISION_LOCAL_URL`). |
| `JARVIS_VISION_LOCAL_URL` | tom | OpenAI-kompatibelt LOKALT endepunkt (f.eks. `http://host.docker.internal:11434`). MÅ være loopback/privat IP/`.local`/`.lan`/`.internal`/`.home.arpa`/enkelt-label (docker-tjeneste); en offentlig adresse eller brukerinfo i URL-en STOPPER oppstarten (`vision_config_invalid:local_url_not_local`). Redirects følges aldri. |
| `JARVIS_VISION_LOCAL_MODEL` | `local-vision` | Modellnavn på det lokale endepunktet (en visjonsmodell - eierens valg). |
| `JARVIS_VISION_MODEL_TIMEOUT_MS` | `90000` | 5000-600000. |
| `JARVIS_VISION_STORE_SNAPSHOTS` | tom | Lagre hendelsesbilder (kun kameraer med policy `store_snapshot` i sone `home`). Krever `JARVIS_VISION_STORAGE_DIR`. |
| `JARVIS_VISION_STORAGE_DIR` | tom | ABSOLUTT mappe i api-containeren. Eieren må montere et skrivbart volum selv (rootfs er read-only) - se §5, steg 5. |
| `JARVIS_VISION_HA_POLL` | tom | Poll Home Assistant for utløsere hos påslåtte HA-kameraer. Bruker de EKSISTERENDE `JARVIS_HA_BASE_URL`/`JARVIS_HA_TOKEN` (vault-kjeden). |
| `JARVIS_VISION_POLL_INTERVAL_SECONDS` | `20` | 5-3600. |
| `JARVIS_VISION_MAINTENANCE_INTERVAL_MINUTES` | `15` | Lett vedlikehold (gravsteiner, pending-bilder, utløp av opptaksforespørsler), 1-1440. |
| `JARVIS_VISION_MAINTENANCE_HOUR` | `3` | Daglig full vedlikeholdskjøring (bilde-retensjon, inventar, vektorer). |
| `JARVIS_VISION_RETENTION_SWEEP_HOUR` | `2` | Uendret fra D-153: daglig retensjon for hendelser. |

Variablene står i `.env.example`, `SERVICE_ENV.api` (`infra/local/service-env.mjs`) og er regenerert i `infra/local/docker-compose.yml` (kun api; worker bruker dem ikke). En ugyldig kombinasjon (manglende/ikke-lokal URL, lagring uten mappe, relativ mappe) KASTER ved oppstart.

**Credentials:** ingen nye. HA bruker de eksisterende `JARVIS_HA_BASE_URL`/`JARVIS_HA_TOKEN` fra secret-kjeden (Infisical primær). Tokenet leses ved hvert kall, settes kun som `Authorization`-header og står aldri i URL, feilkoder eller logg. HA-tokens har INGEN scope-begrensning på HA-siden - anbefaling: eget HA-bruker med minimale rettigheter for dette tokenet (eierens oppsett).

## 3. Datapolicy og strømruting (P2e)

`routeVisionEvent` (`modules/vision/src/policy.ts`) er en ren funksjon; pipelinen handler KUN etter avgjørelsen. `egress` er bokstavelig `"none"`: ingen rute lar et kamerabilde forlate maskinen.

| Sone | Policy | Hentes bilde | Klassifiseres lokalt | Lagres bilde | Hendelse skrives |
|---|---|---|---|---|---|
| `home` | `store_snapshot` (+ global lagring på) | ja | ja | **ja** | ja |
| `home` | `local_only` | ja | ja | nei | ja |
| `home`/alle | `discard` | nei | nei | nei | **nei** (hele hendelsen forkastes) |
| `workplace`/`shared` | `store_snapshot` | (kan ikke settes: DB-CHECK + service; en inkonsistent rad nedgraderes til `local_only`) | | nei | |
| `workplace`/`shared` | `local_only` | ja | ja | nei | ja |
| kontinuerlig strøm | (finnes ikke) | forkastes alltid (`continuous_stream_forbidden`) | | | |

Enhver manglende forutsetning (global av, kamera av, lagring av, klassifisering av) gjør avgjørelsen STRENGERE, aldri løsere. Et bilde hentes kun hvis hendelsen er yngre enn 60 s (HA `camera_proxy` leverer «nå», ikke «ved hendelsen»).

**Kamerabilder og sky (tre uavhengige lag, ingen overstyring):** (1) `ModelGateway` låser bilder med `restricted: true` til `SECRET_RESTRICTED` + lokal modus + ingen betalte modeller FØR ruting; (2) utførelseslåsen i `executePlan` blokkerer enhver ikke-lokal kandidat (ukjent leverandør regnes som sky) uavhengig av ruteren; (3) `anthropic`/`gemma_hosted` kaster før noe sendes. Er den lokale modellen nede feiler klassifiseringen lukket (`model_unavailable`) - det finnes ingen sky-fallback. Bevist med den ekte gatewayen og skyspioner i `apps/api/test/wpg3-vision-runtime.test.ts` og `modules/model-gateway/test/wpg3-restricted-media.test.ts`.

## 4. Autoritet og sikkerhetsmodell (`/vision/*`)

Rekkefølge: kropp (størrelse/JSON) -> forbudte identitetsfelt (`tenant_id`, `person_id`, `memory_space`, `device_id` ... = 400) -> hvitelistede felt -> grant -> enhets-rate-limit -> eier-port (`ownerGate`) -> step-up -> domenet. Identitet, tenant, person, space og ENHET kommer utelukkende fra det verifiserte grantet. Svar inneholder aldri bildebytes, modellens rå tekst eller hemmeligheter.

| Rute | Klasse (risiko) | Krav | Merknad |
|---|---|---|---|
| `/vision/cameras/list`, `/vision/last-seen`, `/vision/inventory` | A (lesing) | grant + eier | «sist sett» bærer forbehold (kun kamerahendelser, rom = kameraplassering, modellklassifisering er ubetrodd) |
| `/vision/cameras/register`, `/vision/cameras/update` | B (egen konfigurasjon) | grant + eier + step-up (signert enhetsøkt, eier-kanal) | ingen standardpolicy (`route_policy` må oppgis); arbeidsplass kan aldri lagre; duplikat kilde = 409 |
| `/vision/cameras/remove` | D-lignende (sletting) | grant + eier + step-up + TYPET bekreftelse (`confirm: true` + `confirm_camera_id`) | sletter kameraets bilder (kaskade + gravstein); hendelsene beholdes (egen retensjon). Full D-kjede (ledger/readback) er IKKE brukt - lokal sletting av Jarvis-eid tilstand; DEFERRED hvis det blir et modellverktøy |
| `/vision/capture/request` | C (personvernrelevant, reversibel) | grant + eier + step-up | kun iPhone-kamera med policy ≠ `discard`; maks 3 åpne per kamera; idempotensnøkkel; levetid 30 s-15 min |
| `/vision/capture/pending` | A | grant (enhetens egen økt) | enhet = grantets `device_id`; ser kun forespørsler adressert til seg |
| `/vision/capture/upload` | B (ingestion) | grant + enhetssignert Ed25519 over request/tenant/person/enhet/hash/lengde/type/tid | engangs (betinget forbruk), ±5 min skjevhet, hash/lengde/magic bytes, maks 5 MiB, samme pipeline; enhetens økt MÅ ha samme memory space som kameraet |

Bakgrunnspolleren: kjører kun med `JARVIS_VISION_HA_POLL=on`, sjekker kill switch / frosset `home-assistant`-connector / tilbakekalt `JARVIS_HA_TOKEN` før første lesing og før hvert space (kastet feil = stanset), aldri to runder samtidig, én feil velter ikke resten.

## 5. D-41-revisjon per adapter (OVERRIDES: `unverified` der det ikke er verifisert mot offisiell dokumentasjon)

Verifisering her er gjort via nettsøk (utdrag fra developers.home-assistant.io m.fl.); direkte oppslag mot dokumentasjonsdomenet var blokkert i økten. Alt merket `unverified` er IKKE lest i sin helhet eller bekreftet mot en ekte instans.

**Jarvis eier (JARVIS_CANONICAL, D-64):** kamera-register, hendelser, bildemetadata/-objekter, inventar, embeddings, retensjon, proveniens. HA og iPhone er kilder/transporter (`EXTERNAL_CANONICAL`); den lokale modellen er en utskiftbar adapter. Ingen kjerneavhengighet av en leverandør (`CORE_DEPENDENCY_DECISION_REQUIRED` er IKKE utløst).

| Adapter | Kapabilitet (les/skriv/slett/tilgang) | Leverandør tilbyr | Bygget | Klasse | Idempotens | Verifisert | Sandbox |
|---|---|---|---|---|---|---|---|
| HA REST | Lese tilstand `GET /api/states/<entity>` | ja (dokumentert; `Bearer` langlevd token) | ja (poller; kun lukkede nøkler `state`/`last_changed`/`device_class`) | A | lesing; `source_event_id` fra `last_changed` | søk-utdrag + falsk server; `last_updated` ikke brukt (`unverified`) | HA-testinstans |
| HA REST | Hente stillbilde `GET /api/camera_proxy/<camera>` | ja (dokumentert) | ja (ETT bilde per hendelse; `?time=` ikke brukt, `unverified`) | A | lesing | søk-utdrag + falsk server | HA-testinstans med kamera som viser et fast testbilde |
| HA REST | Event-entiteter (`event.*`: tilstand = tidspunkt for siste hendelse) | ja | ja (doorbell/motion) | A | som over | **`unverified`** mot ekte instans | HA-testinstans |
| HA | Strøm (`camera_proxy_stream`/MJPEG), opptak/snapshot-tjenester (skriver filer på HA-verten) | ja | **bevisst IKKE brukt** (utenfor UA-9; byggevakt) | - | - | - | - |
| HA | Kamerastyring (av/på, PTZ), tjenestekall (skriving) | ja | **DEFERRED** (D-41: ville vært klasse C; ikke bygget) | C | må spesifiseres | - | - |
| HA | WebSocket-push (`subscribe_events`/`subscribe_trigger`) | ja | **DEFERRED** (poller i dag) | A | - | - | - |
| HA | Tilgangsstyring (brukere/tokens) | ja; tokens er IKKE scoped | ikke bygget (eierens oppsett); dokumentert gap | - | - | - | - |
| iPhone | Kamerabilde på forespørsel | ingen server-side kamera-API; krever app i forgrunnen (`unverified` mot Apple-dokumentasjon) | serverkontrakt (request -> signert opplasting av ETT bilde) | C (be om) / B (laste opp) | idempotensnøkkel + engangsforespørsel + sha256 | fake enhet (Ed25519) | **BLOCKED_EXTERNAL** (TestFlight på egen iPhone) |
| Lokal visjonsmodell (Ollama/llama.cpp) | Bildeforståelse (`/v1/chat/completions` med `image_url` base64 data-URL) | ja (formatet fra dokumentasjonsutdrag, `unverified` mot ekte server) | ja (`local_vision`) | A (inferens, ingen bivirkning) | n/a (temperatur 0; svar kan variere) | falsk OpenAI-server; ekte HTTP lokalt | lokal modell på eierens maskin |
| Lokal modell | Modellstyring (pull/slett modeller) | ja (Ollama) | ikke bygget (vertens ansvar) | - | - | - | - |
| StorageAdapter (lokal disk) | skriv/les/slett (atomisk skriving, symlink-/sti-vern) | (egen) | ja | slett = automatisk etter policy | idempotent (gravstein/reaper) | ekte filsystem i test | tmp-mappe i test |

Ikke-implementert kapabilitet er merket DEFERRED/PARTIAL over - aldri stille utelatt. Read-only HA er valgt fordi UA-9 sin kilderolle er å LESE hendelser og ETT stillbilde; kontroll/skriving mot kamera er en egen D-41-vurdering, ikke en kunstig sperre (eieren har HA-kapabiliteten via den eksisterende `home-assistant`-connectoren).

## 6. Slik verifiserer eieren (alle steg er `NOT VERIFIED`; ingenting nedenfor er kjørt)

Forutsetninger: Home Assistant-instans med en kamera-entity (`camera.*`) og en bevegelsessensor (`binary_sensor.*`, `device_class: motion`); en visjonsmodell på en lokal Ollama/llama.cpp (`ollama pull <modell>`; modellvalget er eierens); Jarvis-stakken oppe med migrasjon 133-137. Bruk en SANDBOX/testkamera først (aldri første gang mot soverom/inngang med andre personer).

1. **Standard = av.** Alle `JARVIS_VISION_*` tomme. Forventet: `POST /vision/cameras/list` gir `404`; ingen vision-poller i loggen.
2. **Hovedbryter.** `JARVIS_VISION_ENABLED=on`, start om. Forventet: `404` er borte; uten grant `401`, med annen person `403 owner_required`. Ingen poller, ingen modell.
3. **Lokal modell.** `JARVIS_VISION_CLASSIFIER=on`, `JARVIS_VISION_LOCAL_URL=http://host.docker.internal:11434`, `JARVIS_VISION_LOCAL_MODEL=<modell>`, start om. Prøv også `JARVIS_VISION_LOCAL_URL=https://api.openai.com` - forventet: oppstart stoppes med `vision_config_invalid:local_url_not_local`. Gjenopprett riktig URL.
4. **Registrer HA-kamera** (signert eier-økt; `grant_token` fra dashbordet): `POST /vision/cameras/register` med `{ "label": "Test", "source_type": "home_assistant", "source_ref": "camera.<id>", "trigger_entities": ["binary_sensor.<id>"], "zone_kind": "home", "route_policy": "local_only" }`. Slå på `JARVIS_VISION_HA_POLL=on`, start om; utløs bevegelse i HA. Forventet: en observasjon (`motion_detected`) + `object_detected` fra modellen i `vision_event_observations`, ingen rad i `vision_snapshots`. Sjekk at samme HA-tilstand ved neste poll gir duplikat (ingen ny rad, ingen ny modellkall).
5. **Lagring (valgfritt).** Monter et skrivbart volum for api-containeren (eier-override; eierskap/rettigheter i containeren er IKKE verifisert), f.eks. `services.api.volumes: ["jarvis_vision:/var/lib/jarvis-vision"]` + `volumes: { jarvis_vision: {} }`, sett `JARVIS_VISION_STORAGE_DIR=/var/lib/jarvis-vision` og `JARVIS_VISION_STORE_SNAPSHOTS=on`, og oppdater kameraet til `route_policy: "store_snapshot"` (kun sone `home`). Forventet: en fil per hendelse (0600 i 0700-katalog) + rad i `vision_snapshots`; `snapshot_retention_days` (standard 7) og `retention_days` (30) styrer sletting.
6. **Sletting.** `POST /vision/cameras/remove` med `confirm: true` + `confirm_camera_id`. Forventet: kameraets bilder borte fra `vision_snapshots` og fra disk innen ett lett vedlikeholdsintervall (15 min; følg `vision_snapshot_tombstones` til tom).
7. **«Aldri sky»-bevis.** Mens du klassifiserer: kjør pakkefangst/brannmurlogg på verten (eller blokker all utgående trafikk fra api-containeren utenom HA og modellen) og bekreft (a) at klassifiseringen fortsatt virker, (b) at ingen trafikk går til skyleverandører, (c) i modellsporet/kostloggen at kun `local_vision` er brukt til visjon. Stans den lokale modellen og bekreft at klassifiseringen feiler (`classification_status = model_unavailable`) uten at noe går til sky.
8. **Eier-kontroller.** Aktiver kill switch / frys `home-assistant`-connectoren / tilbakekall `JARVIS_HA_TOKEN`: forventet at polleren stanser (ingen nye HA-kall) og gjenopptas når kontrollen oppheves.
9. **iPhone** - **BLOCKED_EXTERNAL.** Kontrakten er klar (`/vision/capture/request|pending|upload`); appen må (a) hente `pending` med sin egen økt (samme memory space som kameraet), (b) ta ETT bilde i forgrunnen (JPEG/PNG/WebP, ≤ 5 MiB - ikke HEIC), (c) signere `jarvis.vision.capture.v1`-meldingen med enhetsnøkkelen og laste opp. Ikke testet mot en ekte enhet.

## 7. Bevisst utsatt / blokkert

| Del | Status | Begrunnelse |
|---|---|---|
| iPhone-app + APNs | BLOCKED_EXTERNAL | fysisk enhet og Apple-entitlements |
| Verifisering mot ekte HA/kamera/modell (§6) | NOT VERIFIED | fysisk maskinvare |
| Modellvendt vision-verktøy | DEFERRED | må gå via restricted-/utførelsesvern (N1), intents, manifest, baselines |
| HA WebSocket-push | DEFERRED | persistent kanal; byggevakten krever bevisst oppdatering |
| Kamerastyring/HA-skriving | DEFERRED | D-41-vurdering per handling |
| Visuell romgjenkjenning, fraværs-utleding | DEFERRED | rom = kameraets plassering; inventar sier «sist sett», ikke «borte» |
| Bildeembeddinger | DEFERRED | ny modellleverandør (D-64) |
| Kryptering av lagrede bilder på applikasjonsnivå | DEFERRED | filrettigheter + verts-diskkryptering i dag |
| Samtykke/orientering for andre personer (JARVIS-084), arbeidsplass-jus | Utenfor WP-G3 | egen WP / juridisk gjennomgang |
| Biometrisk ansiktsgjenkjenning, kontinuerlig rå video | Utenfor planen | forbudt; byggevakter |

## 8. Tilbakerulling

**Flagg av** er hele tilbakerullingen: fjern/tøm `JARVIS_VISION_ENABLED` (og underflaggene), start api om. Da: ingen `/vision/*`-ruter (404), ingen poller, ingen `local_vision`-adapter, ingen vedlikeholdsjobber - identisk med main. Data som allerede er lagret ligger igjen til retensjonen tar den (hendelser 30 d, bilder 7 d) - men siden vedlikeholdsjobbene da er av, slettes bilde-objektene først når flagget slås på igjen. Vil du fjerne alt med én gang: slå flagget på midlertidig, fjern kameraene (typet bekreftelse) og la en lett vedlikeholdskjøring reape gravsteinene, eller bruk Q-20-erasure (person/space). Migrasjonene 133-137 er additive og trenger ikke rulles tilbake (tomme tabeller når flagget er av).

## 9. Testbevis (sandbox; ingenting er VERIFIED mot virkeligheten)

19 testfiler / 329 tester grønne i én kjøring (embedded Postgres 16 som `postgres`-bruker, 2 workers): `modules/vision` (g3-pure 14, g3-policy 11, g3-classifier 15, g3-migrations 19, g3-pipeline 27, g3-lifecycle 11, g3-capture 15, g3-ha-source 27, g3-ha-pipeline 6, g3-poller 11, g3-guards 29, + eksisterende service-rls 34 / room-scope-integrity 8), `modules/erasure` (vision-g3-erasure 2 + eksisterende vision-erasure 3), `modules/model-gateway` (wpg3-restricted-media 15), `packages/provider-adapters` (wpg3-local-vision 12), `apps/api` (wpg3-vision-runtime 57, wpg3-vision-routes 13). Byggevaktene er mutasjonsprøvd mot ekte filer (11 mutasjoner, alle felt), og redirect-herdingen av `local_vision` er mutasjonsprøvd (fjernes den, feller to tester).

Kjent avgrensning: HA-kilden er testet mot en lokal falsk HA med en kontrakts-`fetch`, og mot den ENDELIGE `guardedFetch` i `apps/api`; det er ikke testet mot HA sine faktiske svar. Modellformatet er testet mot en falsk OpenAI-kompatibel server.
