# PROJECT STATUS

**Oppdatert:** 2026-09-15 (branch `tobias/manual-masterplan-ua9-vision-p0`, manuelt parallellarbeid
isolert fra issue #68 sin autonome kø, base `main=091ba091141a15c86f7181cc6e0762136db72bcc` - D-150/
PR #81 sin merge-commit, ETTER Q-34/PR #82). Ny PR (nummer settes ved opprettelse rett etter denne
commiten) - draft, IKKE merget.

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md (D-153), ikke her.

## UA-9 Vision & Physical World - provider-uavhengig P0-kjerne (ferdig, testet)

Neste manuelle masterplan-slice ETTER Q-34 (PR #82, PASS_CODE_REVIEW, HOLD på eksterne
control-plane-gates - IKKE rørt videre her). D-64-porten kjørt FØRST: `SYSTEM_OF_RECORD=
JARVIS_CANONICAL`, `CAN_RUN_WITHOUT_PROVIDER=true` - ZERO leverandør koblet til.

**Bygget:**
- Ny pakke `@jarvis/vision` (mirrorer `@jarvis/health`/`@jarvis/location` sin struktur):
  `types.ts`/`service.ts`/`sweep.ts`/`fake-source.ts`/`index.ts`.
- `055_vision.sql`: `vision_retention_policies`/`vision_rooms`/`vision_event_observations`.
- **Arkitekturvalg (bevisst): MULTI-SPACE (location-stil), IKKE health-stil enkelt-låst space** -
  ingen 'vision'-verdi reservert i `memory_spaces`-enumereringen; en ny verdi ville krevd å røre
  svært mange urelaterte tabellers CHECK-constraints (se D-153 for full begrunnelse).
- `vision_rooms`: romassosiasjon, strukturelt parallell til `location_zones` men uten
  geofence-geometri. `vision_event_observations`: allerede-klassifiserte hendelser
  (`event_type`/`object_label`/`confidence`), `snapshot_ref` en PEKER (ALDRI rå bilde-/videobytes),
  append-only (ingen `UPDATE`-grant). Biometrisk ansiktsgjenkjenning EKSPLISITT utenfor.
- D-129-lærdommen anvendt direkte: `person_id` sammensatt FK mot `person_tenants`; `room_id`
  (NULLABLE) sammensatt FK mot `vision_rooms` (Postgres MATCH SIMPLE).
- Retensjon: eier-konfigurert per (tenant, space), fallback 30 dager (KORTERE enn location sitt
  90-dagers-vindu). `vision-retention-sweep` koblet inn i `DailyScheduler`
  (`apps/api/src/main.ts`, `JARVIS_VISION_RETENTION_SWEEP_HOUR`).
- `getLastSeen()` dekker UA-9 akseptansekriterium 1 ("object identification and 'last seen'
  workflows") på canonical-laget.
- Q-20-erasure utvidet: `modules/erasure/src/plan.ts` (`planMemorySpace()`/`planPerson()`)
  registrerer `vision_event_observations` (barn-FK FØRST) + `vision_rooms`; `vision_retention_policies`
  bevisst utelatt (tenant/space-nivå policy-config, ikke person-eid data).
- Nytt `docs/UA9_VISION_DPIA.md` (samme form som `UA8_PERSONAL_TWIN_DPIA.md`).

**Bevisst utsatt (`DEFERRED_WITHIN_UA9_BY_DEPENDENCY`, se DPIA §5):** live iPhone-kamera/Home
Assistant kamera-/dørklokke-/sikkerhetsevents (fysisk maskinvare + D-64/D-41-port), faktisk
objektklassifiseringsmodell-pipeline (leverandørvalg + D-64/D-41-port), biometrisk
ansiktsgjenkjenning (utenfor masterplanen). UA-9 akseptansekriterium 3 ("sensitive camera streams
are routed according to data policy") er DELVIS: multi-space RLS-isolasjon for LAGREDE hendelser er
strukturelt bevist; faktisk kamerastrøm-ruting krever en live adapter, ikke bygget her.

## Tester (ekte, kjørt - ingen simulert)

- `modules/vision/test/{service-rls,room-scope-integrity}.test.ts`: **26/26** grønt (ekte embedded
  Postgres/RLS/FK-bevis: tenant-/space-isolasjon, retensjonsberegning/-håndhevelse, validering,
  `getLastSeen`, `ingestFromSource`-adapterkomposisjon, cross-tenant/-space/-person FK-avvisning
  `23503`, sweep-fan-out).
- `modules/erasure/test/vision-erasure.test.ts`: **3/3** grønt (ekte end-to-end
  `ErasureService.executeErasure()`-bevis - person-scope sletter FULLSTENDIG, person B upåvirket,
  retensjonspolicy overlever, idempotent replay).
- Regresjonssjekk `modules/health`+`modules/location`+`modules/erasure`: **108/108** grønt (uendret
  av denne sliceens endringer i delte filer `apps/api/src/main.ts`/`modules/erasure/src/plan.ts`).
- `pnpm -w typecheck`: **28/28** pakker grønt.
- `pnpm -w lint`: 0 feil.
- Full arbeidsområde-testsuite (`pnpm -w test`): **263/264 filer, 4749/4750 tester** grønt. Den ENE
  feilen (`modules/core/test/embedded-postgres-ipv4-contention.test.ts`, sub-test "B.3: ... helperen
  avviser den okkuperte kandidaten...") rører INGEN fil i denne diffen (`git diff --stat` mot
  `origin/main` bekrefter: KUN nye/endrede filer under `modules/vision/`, `modules/erasure/`,
  `docs/`, `apps/api/src/main.ts`, `apps/api/package.json`, `modules/core/src/db/migrations/
  055_vision.sql` - INGEN annen `modules/core/src/`- eller testfil rørt). **Reproduserte i FULLSTENDIG
  ISOLASJON** (samme fil alene, ingen annen test kjørende samtidig): timet ut på nøyaktig 900000ms,
  9/10 øvrige tester i SAMME fil grønt - en pre-eksisterende port-bind-kontensjons-race-timingtest,
  IKKE en regresjon fra denne sliceen. Samme kjente flake-klasse som ble uavhengig dokumentert og
  reprodusert tidligere i DENNE økten på Q-34/PR #82 (`embedded-postgres-ipv4-contention.test.ts`
  lokalt / `embedded-postgres-port-lease.test.ts` på CI).
- `git diff --check`: rent (ingen whitespace-feil).
- Manuelt hemmelighetsskann av full diff: 0 reelle treff.

## Blokkeringer

Ingen. PR opprettes som draft mot `main`. Ingen merge, ingen self-approval, ingen issue #68-post
(per manuelt-parallellarbeid-isolasjonskravet).

## Neste anbefalte oppgave

En egen, senere D-64/D-41-port-vurdert slice for EN konkret live vision-leverandør (iPhone-kamera
ELLER Home Assistant kamera-/dørklokke-events - IKKE begge samtidig, egen godkjenning per
byggeordrens splitte-kriterier: fysisk/ekstern-credential-avhengighet). Alternativt: en tilsvarende
docs-only D-1xx-oppfølging for Q-34 (`DECISIONS_AND_ASSUMPTIONS.md`) dersom den ikke allerede er
gjort i en annen økt - PR #82 dokumenterte selv at den var bevisst utsatt til etter PR #81-merge.
