# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `tobias/manual-masterplan-ua9-vision-p0`, manuelt parallellarbeid
isolert fra issue #68 sin autonome kø, base `main=091ba091141a15c86f7181cc6e0762136db72bcc` - D-150/
PR #81 sin merge-commit, ETTER Q-34/PR #82 som siden har merget). **PR #83** - draft, IKKE merget.
Én runde arkitekt-review mottatt og besvart (se D-153-addendumet i DECISIONS_AND_ASSUMPTIONS.md).

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md (D-153), ikke her.

## UA-9 Vision & Physical World - provider-uavhengig P0-kjerne (ferdig, testet, én review-runde rettet)

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

**ARKITEKT-REVIEW-RUNDE 1 (PR #83, eksakt forrige HEAD `f711099`, to P1-funn - BEGGE rettet):**
1. **Idempotens/atomisitet.** `ingestFromSource()` manglet kilde-stabil hendelsesidentitet og
   atomisk batch-semantikk - overlappende poll/transport-retry/en krasjet delvis batch kunne skrive
   stille duplikater eller committe et prefiks før en senere feil. **Rettet:** PÅKREVD
   `source_event_id` + DB-håndhevet scoped UNIQUE
   (`vision_event_observations_source_dedupe_key`) + `INSERT ... ON CONFLICT DO NOTHING`
   (deterministisk replay ved konflikt) + HELE batchen validert FØR noen INSERT og skrevet i ÉN
   delt transaksjon.
2. **Snapshot-livssyklus + klokke-tillit.** `snapshot_ref` hevdet håndhevet retensjon uten en
   levetids-eid lagringsadapter; `retention_expires_at` var ankret på det ubetrodde,
   kilde-produserte `observed_at` (en fremtids-tidsstemplet hendelse kunne omgå vinduet i årevis).
   **Rettet:** `snapshot_ref` strukturelt FORBUDT (DB-CHECK `IS NULL` + fjernet fra input-schema)
   inntil en ekte snapshot-lagringsadapter finnes; `retention_expires_at` ankret på
   `recorded_at`/`now()` (databasens EGEN mottakstid) i stedet - `observed_at` sin proveniens
   uendret for alt annet.
3. **Prosessinnvending** (PR #83 startet mens PR #82/Q-34 fortsatt var åpen): PR #82 har siden
   merget, løser sekvens-betingelsen. Kravet om en fersk issue #68-oppgave før videre implementasjon
   sto i direkte motstrid med Tobias sin eksplisitte, direkte instruks for denne
   manuelle-parallellarbeid-tracken - rutet til Tobias direkte (AskUserQuestion); Tobias bekreftet
   at tracken fortsatt gjelder uendret (ingen issue #68-post).

Full begrunnelse for begge fiksene og prosessavklaringen: D-153-addendumet i
`docs/DECISIONS_AND_ASSUMPTIONS.md` og PR #83 sin kommentartråd.

**Bevisst utsatt (`DEFERRED_WITHIN_UA9_BY_DEPENDENCY`, se DPIA §5):** live iPhone-kamera/Home
Assistant kamera-/dørklokke-/sikkerhetsevents (fysisk maskinvare + D-64/D-41-port), faktisk
objektklassifiseringsmodell-pipeline (leverandørvalg + D-64/D-41-port), biometrisk
ansiktsgjenkjenning (utenfor masterplanen), enkeltbilde-snapshot-lagring (krever en levetids-eid
adapter, se over). UA-9 akseptansekriterium 3 ("sensitive camera streams are routed according to
data policy") er DELVIS: multi-space RLS-isolasjon for LAGREDE hendelser er strukturelt bevist;
faktisk kamerastrøm-ruting krever en live adapter, ikke bygget her.

## Tester (ekte, kjørt - ingen simulert)

- `modules/vision/test/{service-rls,room-scope-integrity}.test.ts`: **35/35** grønt (ekte embedded
  Postgres/RLS/FK-bevis: tenant-/space-isolasjon, retensjonsberegning/-håndhevelse ANKRET på
  recorded_at, validering (inkl. påkrevd `source_event_id`, forbudt `snapshot_ref` - både
  tjenestelag OG rått DB-CHECK-forsøk), adversarielt fremtids-tidsstempel-bypass-forsøk lukket,
  `getLastSeen`, `ingestFromSource`-adapterkomposisjon, cross-tenant/-space/-person FK-avvisning
  `23503`, sweep-fan-out, OG en dedikert idempotens-/atomisitet-blokk: eksakt retry, overlappende
  poll, samtidig duplikat-levering (`Promise.all`), valid-så-invalid-batch (null rader committet),
  og trygg retry etter en rettet batch).
- `modules/erasure/test/vision-erasure.test.ts`: **3/3** grønt (ekte end-to-end
  `ErasureService.executeErasure()`-bevis - person-scope sletter FULLSTENDIG, person B upåvirket,
  retensjonspolicy overlever, idempotent replay).
- Regresjonssjekk `modules/health`+`modules/location`+`modules/erasure`: **108/108** grønt (uendret
  av denne sliceens endringer i delte filer `apps/api/src/main.ts`/`modules/erasure/src/plan.ts`).
- `pnpm -w typecheck`: **28/28** pakker grønt.
- `pnpm -w lint`: 0 feil.
- Full arbeidsområde-testsuite (`pnpm -w test`), kjørt PÅ NYTT etter review-fiksene: **263/264
  filer, 4758/4759 tester** grønt. Den ENE feilen
  (`modules/core/test/embedded-postgres-ipv4-contention.test.ts`, sub-test "B.3: ... helperen
  avviser den okkuperte kandidaten...") rører INGEN fil i denne diffen (`git diff --stat` mot
  `origin/main` bekrefter: KUN filer under `modules/vision/`, `modules/erasure/`, `docs/`,
  `apps/api/`, én migrasjon - INGEN `modules/core/src/`- eller testfil rørt). Reprodusert i
  FULLSTENDIG ISOLASJON i forrige runde (samme fil alene): timet ut på nøyaktig 900000ms, 9/10
  øvrige tester i SAMME fil grønt - kjent, pre-eksisterende port-bind-kontensjons-race-timingtest,
  samme klasse uavhengig dokumentert tidligere i DENNE økten på Q-34/PR #82.
- `git diff --check`: rent (ingen whitespace-feil).
- Manuelt hemmelighetsskann av full diff: 0 reelle treff.

## Blokkeringer

Ingen. PR #83 er draft mot `main`. Ingen merge, ingen self-approval, ingen issue #68-post (per
manuelt-parallellarbeid-isolasjonskravet, bekreftet av Tobias etter arkitektens prosessinnvending).

## Neste anbefalte oppgave

Vente på arkitektens neste reviewrunde på PR #83 (de to P1-funnene er rettet og pushet). Deretter:
en egen, senere D-64/D-41-port-vurdert slice for EN konkret live vision-leverandør (iPhone-kamera
ELLER Home Assistant kamera-/dørklokke-events - IKKE begge samtidig) ELLER en levetids-eid
snapshot-lagringsadapter (fjerner `snapshot_ref`-CHECK-en). Alternativt: en docs-only
D-1xx-oppfølging for Q-34 dersom den ikke allerede er gjort i en annen økt.
