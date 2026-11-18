# UA-9 — DPIA / data-governance-notat (Vision & Physical World)

**Status:** UA-9 «Vision & Physical World» — P0-kjerne (D-153, 2026-09-15) + **WP-G3 (D-465, 2026-11-18): live kilder, lokal klassifisering,
bilde-lagring med oppbevaring, embeddings, inventar, «sist sett» og iPhone-opptak på forespørsel — bygget DORMANT/AV bak `JARVIS_VISION_*`-flagg
og IKKE verifisert mot ekte kamera, ekte Home Assistant eller ekte lokal modell** (se `docs/runbooks/WPG3_VISION.md` for hva som er verifisert og ikke).
Samme form og disiplin som `UA8_PERSONAL_TWIN_DPIA.md`/`UA3_BUSINESS_DPIA.md`: kort og teknisk, ikke juridisk teater — og det utfyller,
erstatter ikke, `docs/security/DPIA_DRAFT.md`.

> **Jarvis avgjør ALDRI selv et rettslig grunnlag.** Samme prinsipp som `modules/consent` (D-91) og `UA8_PERSONAL_TWIN_DPIA.md` (D-130).
> Ingenting i dette notatet er en påstand fra Jarvis om at et gitt grunnlag faktisk er gyldig.
>
> **Dette er et UTKAST. Ingen juridisk gjennomgang er gjort.** Kameraer i hjemmet, hos andre personer (familie, gjester, tilsatte, leietakere) og på en arbeidsplass
> reiser særskilte krav (personvernforordningen/GDPR og norsk rett om kameraovervåking, herunder regler om kontroll og overvåking i arbeidsforhold). Notatet viser
> hva systemet teknisk gjør og hvilke garantier som er bygget; det konkluderer ikke på lovligheten av noe enkelt oppsett. Se §3 og §7.

## 1. Hvilke data behandles (faktisk, ikke planlagt)

Alt under er **AV som standard** og finnes bare når eieren selv slår på `JARVIS_VISION_ENABLED=on` (og de enkelte underbryterne). Uten dem skrives, hentes og lagres ingenting.

| Datakategori | Tabell / sted | Hva som faktisk lagres |
|---|---|---|
| **Hendelses-/romobservasjoner** | `vision_event_observations`/`vision_rooms` (`055`, utvidet av `133`/`137`) | KLASSIFISERTE hendelser (`event_type` fra et LUKKET sett: `motion_detected`, `doorbell_event`, `object_detected`, `person_present`, `security_alert`, `opening_detected`; valgfri normalisert `object_label`/`confidence`/`room_id`), PEKER til kilde (`source_type`, `source_instance_id`, kilde-stabil `source_event_id`), `payload_fingerprint`, `observed_at`, og merking per regel 4: `task_id`/`session_id`/`classification_status`/`classifier` (leverandør/modell-id, aldri innhold). |
| **Kamera-register** | `vision_cameras` (`133`) | Eierens KONFIGURASJON: `label`, `source_type` (`home_assistant`/`iphone`), `source_ref` (HA `camera.*`-entity eller enhets-id), `trigger_entities`, valgfritt rom, **`zone_kind`** (`home`/`workplace`/`shared`), **`route_policy`** (`discard`/`local_only`/`store_snapshot` — ingen standard, ingen sky-verdi), `cooldown_seconds`, `enabled`. Ingen bilder, ingen credentials. |
| **Hendelsesbilde (stillbilde)** | `vision_snapshots` (`134`) + selve bildet i en LOKAL `StorageAdapter` (diskmappe `JARVIS_VISION_STORAGE_DIR`, katalog 0700/fil 0600) | ETT stillbilde (JPEG/PNG/WebP, ≤ 5 MiB, ≤ 20 MiB DB-CHECK) per hendelse — **aldri video, aldri en strøm**. Kun når (a) kameraets sone er `home`, (b) policyen er `store_snapshot` og (c) `JARVIS_VISION_STORE_SNAPSHOTS=on`. Metadata: `sha256`, `byte_length`, `media_type`, ugjennomsiktig `storage_key`, utløpstid. Behandles som **BEGRENSET** data (`SECRET_RESTRICTED`). |
| **Slette-gravsteiner** | `vision_snapshot_tombstones` (`134`) | Kun lagringsnøkler for objekter som skal slettes fra disk (operasjonelt; innholdsfritt). Fjernes først når lagringen har bekreftet sletting. |
| **Objekt-embeddings** | `memory_vectors` med `ref_kind = 'vision_event'` (`135`; den EKSISTERENDE minne-vektorlagringen, ingen ny vektorleverandør) | En vektor av den NORMALISERTE objekt-etiketten (f.eks. «nøkler») — **aldri av bildet**, aldri av modellens rå tekst. Kun lokal embedding-leverandør (`assertLocalEmbedding`). |
| **Inventar** | `vision_inventory_items` (`135`) | Per (person, rom, etikett): blandet `confidence` som forfaller med tid (halveringstid 24 t), `seen_count`, `first_seen_at`/`last_seen_at`, `expires_at`. «Sist sett i rommet der kameraet står» — ikke visuell romgjenkjenning. |
| **iPhone-opptaksforespørsler** | `vision_capture_requests` (`136`) | Livssyklus (`pending`→`fulfilled`/`expired`/`cancelled`/`rejected`), `device_id`, idempotensnøkkel, `upload_sha256`. Selve bildet går gjennom samme pipeline som alle andre. |
| **Midlertidig i minnet** | api-prosessen | Bildebytes mens ETT bilde behandles (validering, lokal klassifisering). Bildet sendes som base64 `data:`-URL til et LOKALT modell-endepunkt (`JARVIS_VISION_LOCAL_URL`, validert som loopback/privat/.local ved oppstart), aldri som ekstern URL. |

**Ikke behandlet (eksplisitt, ikke stilltiende utelatt):**
- **Ingen kontinuerlig video** — hverken innhenting, lagring eller visning. Kilden kan bare hente ETT stillbilde per hendelse (`camera_proxy`); `camera_proxy_stream`/MJPEG/HLS/RTSP/WebRTC/opptakstjenester brukes ikke, og en byggevakt (`g3-guards.test.ts`) feller bygget hvis slik kode introduseres.
- **Ingen biometrisk identifikasjon** — ingen ansiktsgjenkjenning, ingen ansikts-/stemmeavtrykk, ingen identitet på personer. Modellen får kun si «en person er synlig» (`person_present`, uten etikett) og generiske gjenstandsnavn; personbeskrivende ord fjernes. En `no_biometric`-vakt feller bygget ved enhver kolonne/tabell/CHECK-verdi/identifikator for slikt.
- **Ingen kamerabilder til sky** — se §4.
- **Ingen lyd.** Ingen lagring av modellens rå tekst. Ingen HA-attributter utover to lukkede nøkler (`device_class`, tilstand/tidspunkt) — `friendly_name` og annen fritekst leses aldri.
- **Ingen kamerastyring** (PTZ, av/på, opptak) — DEFERRED, ikke bygget.

## 2. Retensjon

| Data | Retensjon | Håndhevet av |
|---|---|---|
| Vision-hendelsesobservasjoner | Eier-KONFIGURERT vindu per (tenant, space) (`vision_retention_policies`) — i fravær av konfigurasjon **30 dager**. Utløpet ankres på `recorded_at`/`now()` (databasens betrodde klokke), ikke på kildens `observed_at`. | `VisionService.purgeExpiredObservations()`, daglig (`vision-retention-sweep`, `JARVIS_VISION_RETENTION_SWEEP_HOUR`, standard 02) |
| **Hendelsesbilder** | **`min(snapshot_retention_days ?? 7, retention_days)`** — standard **7 dager**, aldri lengre enn hendelsene. Ankret på databaseklokken. Når siste observasjon som peker på et bilde slettes, slettes bildet også (trigger). | `purgeExpiredSnapshots` + gravsteiner/reaper (se §6.16), daglig full kjøring (`vision-maintenance-sweep`, `JARVIS_VISION_MAINTENANCE_HOUR`, standard 03) og lett kjøring hvert kvarter (`JARVIS_VISION_MAINTENANCE_INTERVAL_MINUTES`) |
| Embeddings | Følger hendelsen: slettes av trigger når observasjonen slettes (ingen foreldreløs vektor). | DB-trigger `vision_observation_release_vector` (`135`) |
| Inventar | `expires_at` = siste observasjon + hendelsesretensjonen (standard 30 dager), forankret på databaseklokken; forfalt `confidence` regnes ikke som «til stede». | `VisionInventoryService.purgeExpired`, daglig full kjøring |
| Opptaksforespørsler | Levetid 30 s – 15 min (standard 5 min); utløpte markeres `expired`; oppgjorte slettes etter 7 dager. | `VisionCaptureService.maintain`, lett + full kjøring |
| Kamera-register | Ingen tidsbasert retensjon (eierens konfigurasjon); fjerning krever typet bekreftelse og sletter kameraets bilder (kaskade + gravstein). | `removeCamera`, Q-20-erasure |
| Slette-gravsteiner | Fjernes når lagringen har bekreftet sletting; «stuck»-antall rapporteres (ingen stille opphoping). | `reapTombstones` |

Q-20-sletting (person-/space-erasure) treffer ALLE vision-tabellene (barn før foreldre) inkludert vektorer (via trigger) og bildeobjekter (via gravstein), bevist end-to-end i `modules/erasure/test/vision-g3-erasure.test.ts`. Gravsteiner slettes bevisst IKKE av erasure (de er innholdsfrie og er selve mekanismen som sletter objektene; `d395` baseline `OPERATIONAL`).

## 3. Rettsgrunnlag

| Behandling | Registrert grunnlag | Merknad |
|---|---|---|
| Eierens egne kameraer i eget hjem, eget system, egen maskin | Eierens egen behandling av egne data i eget system (husholdningsunntaket forutsetter at ingen andre berøres på en måte unntaket ikke dekker) | **Utkast.** Kamera som også fanger andre personer (familie, gjester, naboer, leverandører, barn) eller som peker mot offentlig sted/felles areal er IKKE avklart her |
| Kamera på arbeidsplass (`zone_kind = workplace`) | **Ingen registrert.** | Tekniske rammer: bilder LAGRES ALDRI (DB-CHECK `vision_cameras_zone_storage_rule` + policy-ruter nedgraderer til `local_only`); klassifisering skjer lokalt og kun hendelsen/objektet skrives. Regler for kontroll og overvåking i arbeidsforhold og ev. samtykke/drøfting er IKKE vurdert — krever juridisk gjennomgang før bruk |
| Delt sone (`zone_kind = shared`) | **Ingen registrert.** | Samme tekniske rammer som arbeidsplass (aldri lagring) |
| Lokal bildeklassifisering (visjonsmodell på eierens maskin) | Samme som første rad; ingen tredjepart mottar noe | Modell og vekter er eierens valg og må vurderes separat (lisens, kjente feil/skjevheter). Modellens svar er UBETRODD data |
| iPhone-opptak på forespørsel | Eieren ber selv om opptaket på sin egen enhet | Krever iPhone-appen (BLOCKED_EXTERNAL, ikke bygget); serverkontrakten er bygget og testet mot en fake enhet |
| Multi-space | Generell RESTRICTIVE RLS-space-policy (som `location_*`) | Se D-153 |

## 4. Databehandlere

**Ingen tredjeparts databehandler mottar kamerabilder eller observasjoner.**

- **Home Assistant** (eierens egen instans, lokalt nett) er en KILDE som Jarvis leser fra (`GET /api/states`, `GET /api/camera_proxy`). Jarvis sender ingenting til HA utover disse lesingene, og bruker den EKSISTERENDE HA-connectorens credential (`JARVIS_HA_TOKEN`/`JARVIS_HA_BASE_URL`, vault-kjeden). HA-tokenet er et langlevd token UTEN scope-begrensning på HA-siden — anbefaling i runbooken: egen HA-bruker med minimale rettigheter.
- **Lokal visjonsmodell** (Ollama/llama.cpp/tilsvarende på eierens maskin/LAN) mottar bildet. URL-en valideres deterministisk ved oppstart (loopback/privat/`.local`/enkelt-label — en offentlig adresse stopper oppstarten), redirects følges aldri, og kamerabilder har tre uavhengige lag mot sky: (1) `ModelGateway` låser bilder merket `restricted` til `SECRET_RESTRICTED` + lokal modus og nekter betalte modeller FØR ruting, (2) utførelseslåsen i `executePlan` blokkerer enhver ikke-lokal kandidat uavhengig av ruteren, (3) skyadapterne (`anthropic`, `gemma_hosted`) kaster før noe sendes. Det finnes ingen overstyring, og ingen sky-fallback når den lokale modellen er nede (klassifiseringen feiler lukket).
- **Ingen ny leverandør** er valgt (D-64): Jarvis eier domenemodellen, tilstanden, retensjonen og proveniensen (`JARVIS_CANONICAL`); HA og iPhone er kilder/transporter (`EXTERNAL_CANONICAL`), den lokale modellen er en utskiftbar adapter bak `ModelGateway`. `CORE_DEPENDENCY_DECISION_REQUIRED` er ikke utløst.

`docs/security/PROCESSOR_REGION_MATRIX.md` trenger ingen ny rad så lenge dette er sant; velger eieren en skybasert visjonsmodell til kamerabilder er det forbudt av koden (ikke en konfigurasjonsvalg) og ville krevd en ny, eksplisitt beslutning.

## 5. Bevisst utsatt innenfor UA-9 (`DEFERRED`/`BLOCKED_EXTERNAL`)

| Kapabilitet | Status | Port som må kjøres først |
|---|---|---|
| iPhone-appen (kamera-capture i forgrunnen, enhetssignering, APNs-varsling) | **BLOCKED_EXTERNAL** | Fysisk iPhone, Apple-entitlements, app-bygg. Serverkontrakten (`/vision/capture/*`) er bygget og testet mot en fake enhet |
| Verifisering mot ekte Home Assistant / ekte kamera / ekte lokal visjonsmodell | **NOT VERIFIED** | Fysisk maskinvare; stegvis plan i runbooken |
| HA WebSocket-push (sanntid i stedet for polling) | DEFERRED | Persistent kanal må godkjennes bevisst (vakten feller `new WebSocket` til den oppdateres) |
| Modellvendt vision-verktøy (chat kan spørre «hvor er nøklene?») | DEFERRED | Restricted-/utførelsesvern mot skymodeller (OVERRIDES 6c, kjent åpent hull N1), intents, connector-manifest og baselines |
| Visuell romgjenkjenning, utleding av fravær («nøklene er borte») | DEFERRED | Egen beslutning; i dag er rom = kameraets plassering |
| Bildeembeddinger (CLIP e.l.) | DEFERRED | Ville vært en ny modellleverandør (D-64) |
| Kryptering av lagrede bilder på applikasjonsnivå | DEFERRED | I dag: filrettigheter 0700/0600 + diskkryptering på verten (eierens ansvar) |
| Kamerakontroll (PTZ/av-på/opptak), HA-skriving | DEFERRED (D-41: lesing er klasse A, skriving ikke bygget) | D-41-gjennomgang per handling |
| Biometrisk ansiktsgjenkjenning | **Utenfor planen** | Ikke bygget, ikke forberedt; felles byggevakt `no_biometric` |
| Kontinuerlig rå videolagring | **Utenfor planen** | Ikke bygget; byggevakt |
| Samtykke-/orienteringskontroller for andre personer (JARVIS-084) | Utenfor dette arbeidspakken | Egen WP |

## 6. Hva som er STRUKTURELT håndhevet (ikke bare skrevet)

1. **Tenant+space-isolasjon** — `ENABLE`/`FORCE ROW LEVEL SECURITY` + tenant-policy + RESTRICTIVE space-policy på ALLE vision-tabeller (også de fem nye i `133`–`136`: kameraer, bilder, gravsteiner, inventar, opptaksforespørsler); bevist med ekte RLS-sesjonstester.
2. **Kryss-tenant/kryss-space/kryss-person integritet** — sammensatte fremmednøkler med `tenant_id` i hver nøkkel (rom, kamera, bilde, forespørsel); `person_id` mot `person_tenants`.
3. **Retensjon er reell sletting** — `purgeExpiredObservations`, `purgeExpiredSnapshots`, `purgeExpired` (inventar) og `maintain` er koblet inn i `DailyScheduler` (+ lett intervall) i `apps/api/src/main.ts` — kun når flagget er på.
4. **Ingen sensordata uten kilde-peker; append-only** for observasjoner (uendret fra P0).
5. **Q-20-erasure dekker hele vision-domenet** (se §2).
6. **Idempotent, atomisk kilde-ingestion** (§6.8 fra P0) — nå også «idempotens FØR kost»: en gjentatt poll av samme HA-tilstand gir samme `source_event_id` og en duplikat uten at bilde hentes eller modell kalles.
7. **Payload-verifisert replay** (P0).
8. **Datapolicy-ruteren (P2e) er en ren funksjon** (`modules/vision/src/policy.ts`): `egress` er bokstavelig `"none"`; en kontinuerlig strøm forkastes alltid; lagring kun for sone `home` + policy `store_snapshot` + global lagring på; enhver manglende forutsetning gjør avgjørelsen STRENGERE; alle kombinasjoner er testet. DB-CHECK `vision_cameras_zone_storage_rule` hindrer en inkonsistent rad.
9. **Kamerabilder er BEGRENSET data** og når aldri en skymodell (§4): tre uavhengige lag + app-nivå-test med den ekte `ModelGateway` og skyspioner (`apps/api/test/wpg3-vision-runtime.test.ts`).
10. **Modellens svar er UBETRODD** (regel 7): streng parser (lukket nøkkelsett, kun `object_detected`/`person_present`, ukjente typer forkastes, person med etikett avvises, personbeskrivende og strukturelle/instruksjonslignende etiketter forkastes, maks 8 objekter, normalisert etikett). Ingenting fra modellen utføres; det er data i observasjonen.
11. **Bilde-validering før alt annet** (`image.ts`): magic bytes avgjør formatet (JPEG/PNG/WebP; MP4/WebM/AVI/GIF/SVG/HTML/HEIC avvises), størrelsesgrense, lesing med hard bytegrense, deklarert type brukes kun som konsistenssjekk.
12. **HA-kilden** (`ha-source.ts`): kun GET mot `/api/states/<entity>` og `/api/camera_proxy/<camera>`; entity-id-er valideres mot et lukket tegnsett FØR de settes i en URL; token kun som header og aldri i feil/logg; alle feil er stabile koder; redirects følges ikke; global `fetch` brukes aldri (injisert `guardedFetch`).
13. **iPhone-opptak** (`capture.ts`): engangsforespørsel (betinget forbruk), enhetssignert (Ed25519 over request/tenant/person/enhet/hash/lengde/type/tid), signaturen er bundet til forespørselen, ±5 min skjevhet, `device_id` kommer fra grantet (aldri kroppen), personbundet, maks 3 åpne per kamera, idempotensnøkkel.
14. **Eier-kontroller** — polleren leser KUN eierens tenant (HA-credentialen tilhører eieren; ingen kryss-tenant-lesing via en delt credential), sjekker kill switch, frosset `home-assistant`-connector og tilbakekalt `JARVIS_HA_TOKEN` før første lesing og før hvert space; en kastet feil tolkes som stanset (fail-closed). Skriving i `/vision/*` krever eier + signert enhetsøkt (step-up); sletting av kamera krever typet bekreftelse.
15. **Lagringstak** — bilder har et mykt tak per (tenant, space) (standard 2 GiB, `JARVIS_VISION_MAX_STORED_MB`): over taket lagres bildet ikke og hendelsen skrives uten bilde, slik at en støyende sensor eller en ondsinnet kilde ikke kan fylle eierens disk (bevist i `g3-lifecycle.test.ts`). Øvrige flomvern: cooldown per kamera og hendelsestype (5-3600 s), 60 s maks alder for bilde, idempotens på kilde-hendelse.
16. **Endelig konsistent bildesletting** — rad slettes → BEFORE DELETE-trigger skriver gravstein → reaper sletter objektet via `StorageAdapter` (idempotent, med forsøkstelling og «stuck»-rapport) og fjerner graven først etter bekreftelse. Kameraet kan fjernes uten foreldreløse filer.
17. **Byggevakter** (`g3-guards.test.ts`): `no_biometric`, ingen kontinuerlig video, ingen egen nettverksvei/leverandør-SDK i visjonsmodulen — hver med non-vakuitetstester og mutasjonsbevis.

Bevist i `modules/vision/test/*`, `modules/erasure/test/vision-g3-erasure.test.ts`, `modules/model-gateway/test/wpg3-restricted-media.test.ts`, `packages/provider-adapters/test/wpg3-local-vision.test.ts` og `apps/api/test/wpg3-vision-*.test.ts` (eksakte tall: se runbooken/rapporten). Alt er testet mot falske kilder/servere — **ikke mot ekte kamera, ekte HA eller en ekte visjonsmodell**.

**Historisk (P0, erstattet):** P0 forbød `snapshot_ref` strukturelt fordi ingen lagringsadapter fantes. `134` fjerner CHECK-en og erstatter den med en FK til `vision_snapshots` (`ON DELETE SET NULL (snapshot_ref)`), og punkt 15 over er adapteren med faktisk sletting.

## 7. Kjent, dokumentert restrisiko (ikke skjult)

1. **Ikke verifisert mot virkeligheten.** HA-svarformatet for `event.*`-entiteter, `last_changed`-semantikk, `camera_proxy`-oppførsel, og Ollama/llama.cpp-bildeformatet (`image_url` med base64 `data:`-URL) er verifisert via søk/dokumentasjonsutdrag og mot falske servere, ikke mot ekte instanser (`unverified`).
2. **Øyeblikksbildet er «nå», ikke «ved hendelsen».** HA `camera_proxy` leverer gjeldende bilde; vi bruker ikke `?time=`. Derfor får hendelser eldre enn 60 s ikke bilde (kun hendelsen skrives).
3. **Modellens treffsikkerhet er ukjent og ikke validert.** Gjenstandsetiketten er et forslag fra en lokal modell; «sist sett» er «sist en kameraplassering så en gjenstand med dette navnet», ikke en fakta-påstand. Svaret bærer forbehold (`based_on_camera_events_only`, `room_from_camera_placement_not_visual_recognition`, `model_classification_is_untrusted`).
4. **Andre personer i bildet.** Selv uten identifikasjon kan et lagret stillbilde vise personer. Lagring er derfor begrenset til sone `home` + eksplisitt policy + global bryter, kort standardretensjon (7 dager), og BEGRENSET klassifisering. Krav til orientering/samtykke for andre personer er IKKE bygget (JARVIS-084) og ikke vurdert juridisk.
5. **Lagrede bilder ligger ukryptert på applikasjonsnivå** (filrettigheter + verts-diskkryptering er eierens ansvar). Docker-volumet for `JARVIS_VISION_STORAGE_DIR` må monteres av eieren (eierskap/rettigheter er ikke verifisert i container).
6. **HA-tokenet er bredt** (HA har ikke scoped tokens). Anbefalt HA-side-begrensning er eierens oppsett.
7. **`memory_spaces` er tenant-scoped, ikke person-scoped** (Q-15/Q-31): en delt husholdnings-space gir like tilgang til alle medlemmer — spesielt relevant for kameradata.
8. **Lokalt endepunkt kan peke utenfor via DNS.** URL-valideringen er syntaktisk (ingen DNS-oppløsning); et lokalt navn som i praksis peker utenfor er eierens nettverksoppsett. Redirects følges aldri.
9. **Modellvendt tilgang er ikke bygget** — så lenge den ikke er det, kan ingen chat/modell be om kameradata; `/vision/*` er kun eier-API. Når det bygges må det gå gjennom restricted-/utførelsesvernet (N1).

## 8. Oppdateringsplikt

Dette notatet oppdateres FØR — ikke etter — hver ny kamera-/hendelses-/klassifiseringsdatabehandler eller kilde tas i bruk: ekte iPhone-app, HA WebSocket, en annen visjonsmodell/-leverandør, kamerakontroll, delte/arbeidsplass-kameraer i drift, eller enhver endring som lagrer mer enn ett stillbilde per hendelse. Samme regel som `PROCESSOR_REGION_MATRIX.md`: en rad som ikke er fylt ut, er ikke i produksjonsbruk.
