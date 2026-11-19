TS: 2026-11-18T22:47:25.415Z
VERDICT: **MERGE ETTER FIKSER**. Jeg fant ingen HIGH, men to MEDIUM bør rettes før merge. Rapporten ligger i `/tmp/lead/G3-review-B.md`. Mappen `g3-rev-b` er ren (HEAD 0716b6a9, `git status --short` tom).

**Viktigste funn**
1. **MEDIUM-1: bildefiler slettes ikke når `JARVIS_VISION_STORE_SNAPSHOTS` er av.** `vision-runtime.ts:154-156` bygger lagringstjenesten bare når lagring er på, og `sweep.ts:130` og `:144` hopper da over sletting av bilder og gravsteiner. Probe P3 viser at fila blir liggende etter vedlikehold, mens den reapes når flagget er på. Retensjon, erasure og kamera-fjerning etterlater dermed bytes på disk, og erasure meldes likevel «completed». Runbook §8 foreslår erasure som alternativ, men også den trenger en kjørende reaper. Fiks: bygg lagringsadapter og snapshot-tjeneste når `STORAGE_DIR` er satt, og la flagget styre bare skriving.
2. **MEDIUM-2: tenant-fiksen d5ea5d73 er bare låst i selve polleren.** Koblingen `tenantIds: [deps.ownerTenantId]` (`vision-runtime.ts:178`) er ikke pinnet av noen test, og en mutant som la til en annen tenant overlevde. Koden er riktig i dag. Fiks: en test på koblingen.
3. **Svakheter i testene (LOW-6):** mutanten uten `state = 'pending'` i engangsforbruket overlever byggerens «3 samtidige»-test (`g3-capture.test.ts:128-136`). Min deterministiske probe P1 gir én vinner på ekte kode og tre på mutanten. Opplastingens hevede kroppstak er heller ikke testet.
4. **LOW (kort):**
   - Ingen revisjonsrad for kamera register, update og remove (LOW-3).
   - Opplastingsruta leser ca. 7 MB før grantet sjekkes (LOW-4).
   - Ukjent `room_id` ved registrering gir 500 (LOW-5).
   - Kvotetaket er mykt: 2 av 8 samtidige slapp gjennom for plass til ett bilde (LOW-7).
   - Stuck-gravsteiner og poller-status eskaleres aldri (LOW-8).
   - Brede UPDATE-grants på nye tabeller (LOW-9).
   - Runbook §6 steg 5 gir et root-eid volum der api (`USER node`) ikke kan skrive (LOW-10).
   - Beholdt inventar og vektorer etter kamera-fjerning (LOW-11).
   - Én ikke-diskriminerende assertion i `g3-ha-pipeline.test.ts:148` (LOW-12).

**Bekreftet**
- **Tilgang:** eier-sjekk, step-up, `device_id` fra grant og typet bekreftelse ved fjerning. Ingen rute tar bilde-ID eller hendelses-ID, og ingen rute serverer bildebytes.
- **Opplasting:** Ed25519 over request, tenant, person, enhet, hash, lengde, type og tid, og engangsforbruket er atomisk.
- **HA-kilde:** kun GET, lukket tegnsett for entity-id, ingen redirect, og token står ikke i logger.
- **Migrasjoner:** 133-137 har FORCE RLS og sammensatte FK-er, og det er ingen nummerkollisjon (G1 117-119, G2 125-128).
- **Endrede tester:** d442, migration-order, service-rls og d395 er legitime og ikke svekket.
- **gitleaks:** ingen funn. De tre ignore-oppføringene er konstruerte test-kanarier.
- **Kjøring:** 21 målrettede testfiler grønne (230, 121 og 113 tester). `tsc --noEmit` for vision, api og erasure og eslint på 58 filer er rene.
- **Prøvemerge:** `git merge-tree` mot integ2@d09dfc32 gir bare de to trivielle konfliktene byggeren oppga (`.gitleaksignore` og `main.ts`).

**Mutasjoner:** 25 kjørt, 21 drept, 3 overlevde (M4, M9, M17) og 1 funksjonelt ekvivalent (M15).

**Ikke verifisert:** full suite (forbudt), ekte HA, Docker-volum og NAS, typecheck av de andre pakkene, mutasjoner mot tabell-CHECK-ene i 136, og reviewer A sine områder. Til A: `assertLocalVisionEndpoint` godtar enhver enkelt-label vert (`vision-runtime.ts:83`); dette er dokumentert i DPIA §7.8, så det er ikke mitt funn.

Probe-testene ligger i `/tmp/lead/G3-review-B-probes.test.ts` (P1-P5). De ble kopiert midlertidig inn i `apps/api/test` og slettet etterpå.
