# UA-9 — DPIA / data-governance-notat (Vision & Physical World)

**Status:** UA-9 «Vision & Physical World» — provider-uavhengig P0-kjerne bygget (D-153, 2026-09-15).
Dette notatet dekker den ENE nye persondata-kategorien D-153 introduserer: hendelses-/
romobservasjoner (`vision_rooms`/`vision_event_observations`). Samme form og disiplin som
`UA8_PERSONAL_TWIN_DPIA.md`/`UA3_BUSINESS_DPIA.md`: kort og teknisk, ikke juridisk teater — og det
utfyller, erstatter ikke, `docs/security/DPIA_DRAFT.md`.

> **Jarvis avgjør ALDRI selv et rettslig grunnlag.** Samme prinsipp som `modules/consent` (D-91) og
> `UA8_PERSONAL_TWIN_DPIA.md` (D-130). Ingenting i dette notatet er en påstand fra Jarvis om at et
> gitt grunnlag faktisk er gyldig.

## 1. Hvilke data behandles (faktisk, ikke planlagt)

| Datakategori | Tabell | Hva som faktisk lagres |
|---|---|---|
| **Hendelses-/romobservasjoner** | `vision_event_observations`/`vision_rooms` (`055_vision.sql`) | Allerede KLASSIFISERTE hendelser (`event_type`, valgfri `object_label`/`confidence`/`room_id`), PEKER til kilde (`source_type`/`source_instance_id`) og til et eventuelt lagret enkeltbilde (`snapshot_ref` - en PEKER, aldri en kopi), `observed_at`. Eier-definerte navngitte rom (`vision_rooms`) uten geometri. |

**Ikke behandlet i dag (eksplisitt, ikke stilltiende utelatt):** INGEN live kamera-/leverandør-
tilkobling (ingen iPhone-kamera, ingen Home Assistant kamera-events, ingen dørklokke-/
sikkerhetssystem-API) — kun den kanoniske, provider-nøytrale ingestion-/lagringskontrakten. INGEN
faktisk bilde-/objektklassifiseringsmodell er koblet til — `event_type`/`object_label`/`confidence`
forutsettes PRODUSERT av en fremtidig, ikke bygget adapter/modell-pipeline før de når denne tjenesten.
INGEN rå bilde-/videobytes lagres NOEN steder i denne sliceen (kun `snapshot_ref`-PEKERE). INGEN
biometrisk ansiktsgjenkjenning (eksplisitt utenfor masterplan v4.0 UA-9 med mindre separat besluttet
og lovlig implementert). Se §5.

## 2. Retensjon

| Data | Retensjon | Håndhevet av |
|---|---|---|
| Vision-hendelsesobservasjoner | Eier-KONFIGURERT vindu per (tenant, space) (`vision_retention_policies`, mirrorer `location_retention_policies`-mønsteret) — i FRAVÆR av konfigurasjon brukes et KORTERE, personvern-beskyttende standardvindu (30 dager, KORTERE enn lokasjon sitt 90-dagers-vindu — kamera-/hendelsesdata avslører BÅDE tilstedeværelse OG aktivitet) | `VisionService.purgeExpiredObservations()`, kjørt daglig via `DailyScheduler` (`vision-retention-sweep`, `apps/api/src/main.ts`) |
| Vision-rom (`vision_rooms`) | INGEN egen tids-basert retensjon (strukturell definisjonstabell, samme som `location_zones` — et rom slettes eksplisitt via eier-handling eller Q-20-erasure, ikke automatisk over tid) | Q-20/erasure-fundament (`modules/erasure/src/plan.ts`) |

Q-20-sletting treffer begge tabellene direkte (ikke bare via retensjonsvinduet) — se §6.

## 3. Rettsgrunnlag

| Behandling | Registrert grunnlag | Merknad |
|---|---|---|
| Eierens egen vision-/hendelsesdata i eget system | Eierens egen behandling av egne data i eget system | Ingen tredjepart involvert i denne sliceen (ingen ekstern kamera-/klassifiseringsleverandør koblet til) |
| Multi-space (D-153, IKKE health-stil enkelt-låst space) | Generell RESTRICTIVE RLS-space-policy (samme mekanisme som `location_*`) | Ingen ny 'vision'-verdi i den kanoniske `memory_spaces`-enumereringen — se D-153 for begrunnelsen (unngår et unødvendig stort, urelatert migrasjons-blast-radius) |
| Fremtidig ekstern kamera-/klassifiseringsleverandør (iPhone-kamera, Home Assistant, dørklokke-/sikkerhetssystem) | **INGEN registrert ennå** — kapabiliteten finnes ikke i denne sliceen | Får ikke bygges før en D-64/D-41-port er kjørt PER provider (samme presedens som Apple Health/lokasjonstjeneste) og — for kamera-/hendelsesdata spesifikt — dette notatet er utvidet FØR bygging |

## 4. Databehandlere

**Ingen.** Denne sliceen kobler INGEN ekstern databehandler til for vision-/hendelsesdata.
`VisionEventSource`-adapterkontrakten (`modules/vision/src/types.ts`) er et provider-nøytralt
GRENSESNITT — kun `FakeVisionEventSource` (test-only) implementerer den i dag.
`docs/security/PROCESSOR_REGION_MATRIX.md` skal utvides med en rad FØRST når en faktisk leverandør
velges og kobles til (samme regel D-122/D-130 etablerte: en `TBD`-rad ved siden av et live
leverandørkall er en usann rad — men her finnes INGEN live kall ennå, så INGEN rad er lagt til enda
heller, per samme prinsipp motsatt vei).

## 5. Bevisst utsatt innenfor UA-9 (`DEFERRED_WITHIN_UA9_BY_DEPENDENCY`)

| Kapabilitet | Port som må kjøres først |
|---|---|
| Live iPhone-kamera-integrasjon | Fysisk iPhone + kamera-/bildebehandlings-entitlement (ekstern/fysisk gate) + D-64/D-41-port. `VisionEventSource`-kontrakten finnes klar til å implementeres mot |
| Live Home Assistant kamera-/dørklokke-/sikkerhetsevents | Fysisk kamera-/dørklokke-maskinvare koblet til Home Assistant + D-64/D-41-port |
| Faktisk objekt-/hendelsesklassifisering (den egentlige ML-modell-inferensen på et kamerabilde) | En valgt, koblet modell-pipeline (D-64/D-41-port) — denne sliceen lagrer KUN det strukturerte RESULTATET, produserer det ALDRI selv |
| Biometrisk ansiktsgjenkjenning | Eksplisitt UTENFOR masterplan v4.0 UA-9 med mindre separat besluttet og lovlig implementert — INGEN kode/kolonne/felt i denne sliceen forbereder dette |
| Kontinuerlig rå videolagring | Eksplisitt UTENFOR masterplan v4.0 UA-9 ("event snapshots by default instead of continuous raw video") — `snapshot_ref` er en PEKER til ETT enkeltbilde, ALDRI en videostrøm |

## 6. Hva som er STRUKTURELT håndhevet (ikke bare skrevet)

1. **Tenant+space-isolasjon** — `ENABLE`/`FORCE ROW LEVEL SECURITY` + tenant-policy + RESTRICTIVE
   space-policy på BEGGE nye tabeller (samme mønster som `location_*`, D-91/D-129). Bevist med ekte
   RLS-sesjonstester (ikke applikasjonslag-filter), inkl. et negativt kontrolltilfelle.
2. **Kryss-tenant/kryss-space/kryss-person relasjons-integritet for rom** —
   `vision_event_observations` bruker en sammensatt `(tenant_id, memory_space_id, person_id, room_id)`-
   fremmednøkkel mot `vision_rooms` (D-129-lærdommen anvendt direkte på ny kode) — bevist med rå
   cross-scope/cross-person-INSERT-tester som viser ekte Postgres FK-avvisning (`23503`).
3. **Composite membership FK** — `person_id` er sammensatt FKet mot `person_tenants (person_id,
   tenant_id)` på begge tabeller, IKKE en enkel `people`-FK — en person må være et EKTE registrert
   medlem av tenanten en rad hevder å tilhøre.
4. **Retensjon er reell sletting, ikke en udokumentert kolonne** — `purgeExpiredObservations()` er
   faktisk koblet inn i `DailyScheduler` (`apps/api/src/main.ts`, `vision-retention-sweep`, daglig),
   ikke bare skrevet og aldri kalt. Multi-space fan-out (`listAllTenantIds` +
   `listTenantMemorySpaces`, location-mønsteret) — IKKE health sitt enkelt-space-mønster.
5. **Ingen sensordata uten kilde-peker** — `source_type`/`source_instance_id`/`snapshot_ref` er alle
   PEKERE, aldri en kopi av rå leverandør-/bildepayload (samme "peker, aldri kopi"-prinsipp som
   `location_observations`/`health_metric_observations`).
6. **Append-only** — `vision_event_observations`/`vision_rooms` har INGEN `UPDATE`-grant (samme
   strukturelle, ikke bare konvensjonelle, disiplin som `health_metric_observations`).
7. **Q-20-erasure dekker faktisk vision-domenet** — `modules/erasure/src/plan.ts` sin `planPerson()`/
   `planMemorySpace()` registrerer BÅDE `vision_event_observations` (barn-FK FØRST) OG `vision_rooms`,
   BEVISST med `vision_retention_policies` utelatt (tenant/space-nivå policy-konfigurasjon, ikke
   person-eid data) — bevist end-to-end mot en ekte `ErasureService.executeErasure()`-kjøring, IKKE
   kun en kode-lesning av `plan.ts`.

Bevist i `modules/vision/test/{service-rls,room-scope-integrity}.test.ts` (37) og
`modules/erasure/test/vision-erasure.test.ts` (3).

## 7. Kjent, dokumentert restrisiko (ikke skjult)

1. **Ingen live kamera-/klassifiseringsleverandør betyr denne sliceens praktiske eksponering er lav**
   — men modellen/RLS/retensjon er bygget NÅ, FØR en leverandør kobles til, nettopp for at koblingen
   senere ikke skal presse frem en hastig, uferdig datamodell (samme rekkefølge-disiplin som D-64
   krever generelt).
2. **`memory_spaces` er tenant-scoped, ikke person-scoped** (samme kjente funn som Q-15/Q-31 (D-130) i
   `OPEN_QUESTIONS.md`, gjentatt her for vision) — en "delt husholdnings-space" gir i dag samme
   tilgang til alle personer med medlemskap+registrert enhet i tenanten, ingen finere per-person-ACL.
   Relevant her fordi kamera-/hendelsesdata er en spesielt sensitiv kategori — flagget eksplisitt,
   ikke silently akseptert som "godt nok".
3. **`getLastSeen()`/`object_label` forutsetter at oppstrøms klassifisering allerede er korrekt** —
   denne tjenesten validerer STRUKTUR (gyldig `event_type`, `confidence` i [0,1], gyldig tidsstempel),
   ALDRI det semantiske INNHOLDET i en `object_label`-streng (det er en fremtidig adapter/modell-
   pipelines ansvar, ikke bygget her) — dokumentert grense, ikke skjult som en falsk "vet"-tilstand.
4. **Ingen finere per-rom-tilgangsstyring i P0** — `vision_rooms` er person-eid (samme mønster som
   `location_zones`); en fremtidig DELT husholdnings-rom-liste er en SEPARAT, senere beslutning.

## 8. Oppdateringsplikt

Dette notatet oppdateres FØR — ikke etter — hver ny kamera-/hendelses-/klassifiseringsdatabehandler
tas i bruk: iPhone-kamera, Home Assistant kamera-/dørklokke-/sikkerhetsevents, en valgt
objektklassifiseringsmodell-pipeline, eller enhver annen ekstern kilde/sluk for denne kategorien.
Samme regel som `PROCESSOR_REGION_MATRIX.md` sin egen: en rad som ikke er fylt ut, er ikke i
produksjonsbruk.
