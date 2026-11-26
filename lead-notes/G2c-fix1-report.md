TS: 2026-11-26T05:18:16.888Z
# Sluttrapport: WP-G2c fiks-runde 1

Alle seks fikser og INFO-punktene er gjort. Ingenting er DEFERRED, og 29 av 29 mutanter drepes.

**Gren:** `claude/wp-g2c-personal-rest`, **ny tipp `cdec4cb4`** (var `2bd0dedc`), pushet. Treet er rent.
**9 commits** (`git log --oneline 2bd0dedc..HEAD`): `ad7b6766` LOW-4, `e32a2ee1` LOW-1, `0b4b5f32` LOW-2/LOW-5/I-1/I-2, `525ab545` LOW-3, `9a74d308` M21/M30, `9db4f82b` docs, `47f6e44b` lint, `6c294837` test (tapt svar), `cdec4cb4` kommentar. Ingen nye flagg, migrasjoner eller pakker, og `.gitleaksignore` er urørt.

## Per fiks
- **FIX-1 (LOW-1), `action-reconcile.ts:115,128-134`, `home-critical-transport.ts:41,77`:**
  - `failed` krever nå ingen nyere handling (alle grener) og en lagret `before_state.state` som tekst (`before_state_missing`).
  - Transporten måler skjevheten fra HTTP-`Date` (`clock_skew_ms` på lese-handlingens tilstand). Over 30 s i begge retninger, eller en uleselig måling, gir `unknown ha_clock_skew`.
  - Probescenariet (HA 5 min bak, revert etter 90 s) gir nå `unknown`. Probens 61 s-forventning er rettet: terskelen er 150 s.
  - Rød før fiks: 4 feilet i decision-testen, pluss 5 i DB-testfilen.
  - Tester: `wpg2c-reconcile-decision` (33), `wpg2c-home-clock-skew` (5, ny), `wpg2c-reconcile-db` (38).
  - Et tapt svar etter at HA mottok kommandoen beholder `before_state`, så `failed` kan fortsatt avgjøres (testet).
- **FIX-2 (LOW-2), `action-journal.ts:89` `jsonbSafe`, `action-executor.ts:146`:**
  - NUL og ensomme surrogater (også nøstet og i nøkler) gir `request_params = null`, ikke rå DB-feil.
  - Rød før fiks: den syntetiske handlingen fikk DB-feil. Selve probe-R1 var allerede grønn etter FIX-4, fordi skjemaet nå avviser strengene.
- **FIX-3 (LOW-3), `personal-dav.ts:67,102,220`:**
  - Step-up for mutasjoner kommer nå før grensen. Grensene avgjøres samlet, så en avvisning bruker aldri budsjett.
  - Glidende vindu med 10 000 nøkler og fail-closed for nye, i stedet for fast vindu. Ventetiden er den lengste av de blokkerte grensene.
  - Rød før fiks: 9 feilet. Testene inkluderer B DV3, A K3d, tenant-separasjon (X03), nøkkeltak og et orakel over 4 000 tilfeldige forespørsler.
- **FIX-4 (LOW-4), `home-critical.ts:205-207`:**
  - `expected_state` er nå `/^[a-z_]{1,40}$/`, markørene er `ISO_INSTANT` eller `null`. `"kode-1234-hemmelig-pin"` avvises.
  - Alle tilstandsord normalisereren kan gi, og HAs mikrosekundformat, passerer.
  - Rød før fiks: 10 av 12 feilet. Test: `wpg2c-request-params-shape` (12, ny).
- **FIX-5 (LOW-5):** testhullene er lukket.
  - M21: `apps/api/test/wpg2c-reconcile-wiring.test.ts` (4, ny).
  - M28: matrisetest på `hasLaterAction` pluss A-R4.
  - M30: deterministisk kø via `pg_stat_activity` og dobbel-aksept (`family-service` 34 til 37).
  - M54: `toEqual` på de sju nøklene i revisjonen.
  - N12/X09: fiendtlig `read.reason` lagres som trygg kode. Ikke-tekst gir tom kode.
  - N23: `state_malformed`.
  - X02: ids med prefiks avvises.
  - X03: se FIX-3.
- **FIX-6 (LOW-6):** `WPG2_PERSONAL.md` er rettet på alle punktene du listet. «Koordinatene leses aldri» er omformulert (lastes, eksponeres aldri). `getPersonLocation` er uendret.
  - Antakelse 8 mot 1: tre atferdsforskjeller mot main med flagg AV (pool, K4, migrasjon 144).
  - §10 steg 7 er rettet: HA frem er forsiktig, HA bak kan være farlig.
  - Pool-anbefaling: behold 30 s, øk til 60 s ved kø over 10 s, aldri `0`, ikke under 10 s.
  - Inventory og DPIA er ordlagt om.
- **INFO:**
  - I-1: eier-assert i `reconcilePersonalAction` (delegat eller annen person gir `personal_action_reconcile_owner_only`, 403 i ruten).
  - I-2: revisjonens `decision` er `UNKNOWN` ved `outcome_unknown`, ellers `ALLOW`.
  - I-3 til I-5: skrevet i runbook (§2.7, §9).

## Mutanter
Alle 9 overlevende er nå drept (M21, M28, M30, M54, N12, N23, X02, X03, X09). I tillegg 20 nye mot fiks-rundens kode (F01-F20), alle drept av en feilet assertion. Ingen syntaksfeil eller timeout, og treet er rent etterpå. Runner og oppskrift ligger i scratchpad `.../scratchpad/fix1/` (`mut.py`, `mutants.json`).

## Verifikasjon
- De 14 wpg2c-filene: 207 grønne (de 11 opprinnelige pluss 3 nye).
- Guards: 14 filer / 310 grønne. Dekker wph1, wph2, D-420, tool-manifest, env-drift, compose-isolation, schema-invarianter, erasure, d124, connector, migration-order, pool og autonomy-step-up.
- Bred batch (wpg2*, health, context): 45 filer / 657 grønne.
- `pnpm -r --workspace-concurrency=2 run typecheck`: exit 0.
- `pnpm lint`: exit 0 (en ubrukt variabel i min egen test ble rettet).
- `pnpm check:containment`: exit 0.
- gitleaks `origin/main..HEAD`: 21 commits, «no leaks found».

## Nye antakelser til D-483 (fra nr. 13)
13. `failed` krever ingen nyere handling (også scene/skript), lagret før-tilstand med tilstandsord for tilstandshandlinger, og måling ≤ 30 s når `Date` finnes. Uten `Date`, eller bak en proxy på en annen maskin, er oppførselen som før.
14. `clock_skew_ms` ligger kun på lese-handlingens tilstand. Siden preflight bruker den, havner det også i `before_state` og `observed_state` (verifisert). Mutasjonens interne lesinger er uendret.
15. `entity`/`vehicle_id` forblir regex-begrensede alias og lagres også for mål utenfor eierens liste (som `target_ref` alltid har gjort).
16. `request_params` lagres kun når skjemaet består og det tåler jsonb. Ellers `null`, og avvisningen er som før.
17. DAV: rekkefølgen er grant, eier, step-up, grense, vakt, revisjon. Atomisk avgjørelse, glidende 60 s-vindu og lengste ventetid.
18. Revisjonens `decision` er `ALLOW` når raden avgjøres og `UNKNOWN` ellers. Eier-assert gjelder også direkte kall.
19. Flagg AV er ikke lik main på tre punkter: pool-tidsavbrudd, K4-låsrekkefølgen og migrasjon 144.

## Q-forslag
- **Q-A (HA-klokkeskjevhet):** skal `failed` slås av når HA ikke gir en brukbar `Date` (proxy på annen maskin)? Anbefaling: behold «som før» og mål på NAS-en.
- **Q-B (DAV-vindu):** skal 30/60/10 per minutt (glidende vindu) bli miljøkonfigurerbart? Anbefaling: nei før eieren treffer taket i praksis.

## NOT VERIFIED
- `Date`-målingen er bevist kun mot fake-HA med styrt `Date`-header. Ikke mot ekte HA eller proxy.
- DAV-grensen er kun i prosessminne. Ikke mot ekte iCloud.
- Pool-kø under NAS-last er ikke målt.
- Alt mot ekte HA, bil, iCloud og NAS er uverifisert, som før.
- Full suite og `embedded-postgres-ipv4-contention` er ikke kjørt, etter instruks.
