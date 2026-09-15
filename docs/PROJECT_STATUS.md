# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `tobias/manual-masterplan-ua9-vision-p0`, manuelt parallellarbeid
isolert fra issue #68 sin autonome kø, base `main=6f1c980c3493c6f68fe97bb2c8f045b4d196af75` - PR #82/
Q-34 sin merge-commit). **PR #83** - draft, IKKE merget. To arkitekt-review-runder mottatt og besvart
(se D-153-addendumet i DECISIONS_AND_ASSUMPTIONS.md for fullstendig begrunnelse begge runder).

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md (D-153), ikke her.

## UA-9 Vision & Physical World - provider-uavhengig P0-kjerne (ferdig, testet, to review-runder rettet)

Neste manuelle masterplan-slice ETTER Q-34 (PR #82, siden merget til `main`). D-64-porten kjørt
FØRST: `SYSTEM_OF_RECORD=JARVIS_CANONICAL`, `CAN_RUN_WITHOUT_PROVIDER=true` - ZERO leverandør
koblet til.

**Bygget:**
- Ny pakke `@jarvis/vision` (mirrorer `@jarvis/health`/`@jarvis/location` sin struktur):
  `types.ts`/`service.ts`/`sweep.ts`/`fake-source.ts`/`index.ts`.
- `055_vision.sql`: `vision_retention_policies`/`vision_rooms`/`vision_event_observations`.
- **Arkitekturvalg (bevisst): MULTI-SPACE (location-stil), IKKE health-stil enkelt-låst space** -
  ingen 'vision'-verdi reservert i `memory_spaces`-enumereringen (se D-153 for full begrunnelse).
- `vision_rooms`: romassosiasjon, strukturelt parallell til `location_zones` men uten
  geofence-geometri. `vision_event_observations`: allerede-klassifiserte hendelser
  (`event_type`/`object_label`/`confidence`), append-only (ingen `UPDATE`-grant). Biometrisk
  ansiktsgjenkjenning EKSPLISITT utenfor.
- D-129-lærdommen anvendt direkte: `person_id` sammensatt FK mot `person_tenants`; `room_id`
  (NULLABLE) sammensatt FK mot `vision_rooms` (Postgres MATCH SIMPLE).
- `getLastSeen()` dekker UA-9 akseptansekriterium 1 ("object identification and 'last seen'
  workflows") på canonical-laget.
- Q-20-erasure utvidet: `modules/erasure/src/plan.ts` (`planMemorySpace()`/`planPerson()`)
  registrerer `vision_event_observations` (barn-FK FØRST) + `vision_rooms`; `vision_retention_policies`
  bevisst utelatt (tenant/space-nivå policy-config, ikke person-eid data).
- Nytt `docs/UA9_VISION_DPIA.md` (samme form som `UA8_PERSONAL_TWIN_DPIA.md`).

**ARKITEKT-REVIEW-RUNDE 1 (forrige HEAD `f711099`, to P1-funn - BEGGE rettet):**
1. **Idempotens/atomisitet.** PÅKREVD `source_event_id` + DB-håndhevet scoped UNIQUE +
   `INSERT ... ON CONFLICT DO NOTHING` (deterministisk replay). `ingestFromSource()` validerer HELE
   batchen FØR noen INSERT og skriver den i ÉN delt transaksjon.
2. **Snapshot-livssyklus + klokke-tillit.** `snapshot_ref` strukturelt FORBUDT (DB-CHECK + fjernet
   fra input-schema) inntil en levetids-eid lagringsadapter finnes. `retention_expires_at` ankret på
   `recorded_at`/`now()` i stedet for det ubetrodde `observed_at`.
3. **Prosessinnvending** (PR #83 startet mens PR #82 var åpen): PR #82 har siden merget. Kravet om
   en fersk issue #68-oppgave rutet til Tobias direkte (motstrid med hans standing instruks for
   denne tracken) - han bekreftet tracken fortsatt gjelder uendret.

**ARKITEKT-REVIEW-RUNDE 2 (forrige HEAD `b5e7dec3`, to NYE P1-funn i selve runde 1-fiksen - BEGGE rettet):**
1. **Dedupe-kollisjonsdomenet manglet `source_instance_id`.** To uavhengige enheter/kameraer bak
   SAMME `source_type` kunne legitimt produsere en kolliderende lokal `source_event_id` - den andre
   enhetens EKTE hendelse ville blitt stille tapt som en falsk replay (datatap). **Rettet:**
   `source_instance_id` gjort PÅKREVD (var valgfri) OG lagt til i selve UNIQUE-nøkkelen -
   kollisjonsdomenet er nå eksplisitt `(tenant, space, person, source_type, source_instance_id,
   source_event_id)`.
2. **Same-key replay verifiserte ikke payload-identitet.** En `ON CONFLICT DO NOTHING`-replay
   returnerte den eksisterende raden UANSETT om den nye forsøkte payloaden faktisk var identisk -
   en nøkkel-gjenbruk/kilde-bug kunne stille konvertere til "suksess" med feil data. **Rettet:** en
   deterministisk `payload_fingerprint`-kolonne beregnes og sammenlignes ved hver konflikt; et avvik
   kaster en ny typet `VisionReplayConflictError` (fail-closed).
3. **Control-plane-prosessmerknad** (D156/worker-status-tilstand, urelatert til denne PR-ens
   innhold): eksplisitt issue #68/autonom-løkke-EGEN intern tilstand, IKKE noe denne branchens kode
   påvirker eller kan løse, og IKKE noe Tobias sin standing instruks ber om at røres herfra - notert
   på PR-en, ingen handling tatt, INGEN issue #68-post.

Full begrunnelse for alle fire fiksene og begge prosessavklaringene: D-153-addendumet i
`docs/DECISIONS_AND_ASSUMPTIONS.md` og PR #83 sin kommentartråd.

**Bevisst utsatt (`DEFERRED_WITHIN_UA9_BY_DEPENDENCY`, se DPIA §5):** live iPhone-kamera/Home
Assistant kamera-/dørklokke-/sikkerhetsevents (fysisk maskinvare + D-64/D-41-port), faktisk
objektklassifiseringsmodell-pipeline (leverandørvalg + D-64/D-41-port), biometrisk
ansiktsgjenkjenning (utenfor masterplanen), enkeltbilde-snapshot-lagring (krever en levetids-eid
adapter). UA-9 akseptansekriterium 3 ("sensitive camera streams are routed according to data
policy") er DELVIS: multi-space RLS-isolasjon for LAGREDE hendelser er strukturelt bevist; faktisk
kamerastrøm-ruting krever en live adapter, ikke bygget her.

## Tester (ekte, kjørt - ingen simulert)

- `modules/vision/test/{service-rls,room-scope-integrity}.test.ts`: **42/42** grønt (ekte embedded
  Postgres/RLS/FK-bevis: tenant-/space-isolasjon, retensjonsberegning/-håndhevelse ANKRET på
  recorded_at, validering (påkrevd `source_event_id`+`source_instance_id`, forbudt `snapshot_ref`),
  adversarielt fremtids-tidsstempel-bypass-forsøk lukket, `getLastSeen`,
  `ingestFromSource`-adapterkomposisjon, cross-tenant/-space/-person FK-avvisning `23503`,
  sweep-fan-out; idempotens-/atomisitet-blokk (eksakt retry, overlappende poll, samtidig
  duplikat-levering, valid-så-invalid-batch, trygg retry etterpå); OG en dedikert
  dedupe-kollisjonsdomene-/payload-fingerprint-blokk (to enheter med kolliderende event-id skriver
  BEGGE distinkte rader, eksakt-payload-replay OK, avvikende-payload-replay kaster
  `VisionReplayConflictError` for BÅDE `event_type`- og `observed_at`-avvik, samtidig
  eksakt-duplikat OG samtidig motstridende-payload begge bevist trygge - fortsatt presis én rad).
- `modules/erasure/test/vision-erasure.test.ts`: **3/3** grønt (ekte end-to-end
  `ErasureService.executeErasure()`-bevis).
- Regresjonssjekk `modules/health`+`modules/location`+`modules/erasure`: **108/108** grønt (uendret
  av denne sliceens endringer i delte filer).
- `pnpm -w typecheck`: **28/28** pakker grønt. `pnpm -w lint`: 0 feil.
- Full arbeidsområde-testsuite (`pnpm -w test`), kjørt PÅ NYTT etter runde 2-fiksene: **264/265
  filer, 4798/4799 tester** grønt. Den ENE feilen
  (`modules/core/test/embedded-postgres-ipv4-contention.test.ts`, sub-test "B.3") rører INGEN fil i
  denne diffen - kjent, pre-eksisterende port-bind-kontensjons-race-timingtest, reprodusert i
  fullstendig isolasjon i en tidligere runde denne økten, samme klasse uavhengig dokumentert på
  Q-34/PR #82.
- `git diff --check`: rent. Manuelt hemmelighetsskann: 0 reelle treff.

## Blokkeringer

Ingen. PR #83 er draft mot `main`. Ingen merge, ingen self-approval, ingen issue #68-post (per
manuelt-parallellarbeid-isolasjonskravet, bekreftet av Tobias etter runde 1 sin prosessinnvending).

## Neste anbefalte oppgave

Vente på arkitektens neste reviewrunde på PR #83 (alle fire P1-funn på tvers av begge runder er nå
rettet og pushet). Deretter: en egen, senere D-64/D-41-port-vurdert slice for EN konkret live
vision-leverandør ELLER en levetids-eid snapshot-lagringsadapter (fjerner `snapshot_ref`-CHECK-en).
Alternativt: en docs-only D-1xx-oppfølging for Q-34 dersom den ikke allerede er gjort i en annen økt.
