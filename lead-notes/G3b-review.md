TS: 2026-11-26T10:23:16.258Z
VERDICT: MERGE ETTER FIKSER (0 HIGH, 1 MEDIUM, 3 LOW). K1–K5 holder ved alle prober og mutanter jeg kjørte. Hullet er at den typede bekreftelsen ikke dekker G4-kjeden når `JARVIS_SITUATION_LOG_RETENTION_DAYS` er over 30.

Worktree er løsrevet på `36ea2665` og ren (`git status` tom, probefilene fjernet). Prober, mutantlister og logger ligger i `/tmp/lead/G3b-review-probes/`, fremdrift i `/tmp/pg-home/g3b-review-notes/NOTES.md`.

## (1) K1–K5

| Krav | Status | Bevis |
|---|---|---|
| K1 rute | BEKREFTET, unntatt F1/F2 | `zz-g3b-review-routes`: 78/78, ekte server, ekte Postgres (RLS) og produksjonens `ownerPredicate`. |
| K2 kort | BEKREFTET | `zz-g3b-review-card`: 10/10, se punkt (5). |
| K3 etikett-pin | BEKREFTET | Se nedenfor. |
| K4 flagg AV | BEKREFTET | Ingen diff i `infra`, `.env.example`, pakker eller lockfile. Eneste nye `process.env`-bruk er `visionFlagsFromEnv(process.env)` i `main.ts`, som er eksisterende mønster. `check:containment` er OK. |
| K5 tester/docs | BEKREFTET, med LOW-avvik | Se punkt (6). |

**K1 i detalj:**
- Identitetsmatrise: 13 tokens × get/set. Step-up krever `signed` og kanal web/api/mobile/desktop. Voice, telegram, system og watch får 403 på set, men leser. Delegat, annen tenant og ugyldig token får 403. Avslag skriver verken rad eller revisjon.
- Tenant og space kommer bare fra grantet: 12 forbudte identitetsfelt og 8 ukjente felt gir 400. Feil eller ugyldig `confirm_memory_space` gir 409.
- Validering: 21 ugyldige verdier (0, -1, 366, 1e308, 1.5, "30", [30], null, NUL-streng, utelatt, snapshot 91, snapshot > retention) gir stabile koder uten fritekst. Ugyldig JSON, duplikatnøkkel og kropp over 200 kB gir aldri 500.
- Forkortingsorakel: 756 overganger (28 forhåndstilstander × 27 nye) mot skriverens egne hjelpere `retentionDaysInTransaction` og `snapshotRetentionDaysInTransaction`. 0 forkortinger uten bekreftelse, 0 unødvendige bekreftelser.
- Kappløp: A holdt advisory-låsen med en ucommittet forlengelse, og B (som var en forkorting mot A) fikk 409 etter at A committet. I tillegg 12 samtidige HTTP-par uten avvik.
- Revisjon: en trigger som feiler `vision.retention_set` gir 5xx, uendret rad og ingen revisjon. Gjenspilling gir `changed:false` med uendret `updated_at` og ingen ny rad.
- Svar og modellverktøy: svarene inneholder ingen tenant-, person- eller space-id. Ingen `ToolDefinition` med `tool_id "vision"` finnes, og `part3-tool-manifest` er grønn.
- Flagg AV: `/vision/retention/*` gir samme 404 som en ukjent sti.
- Ikke testet separat: rate limit (rutene bruker uendret `authedRequest`).

**K3 i detalj:** Påstanden stemmer. Jeg strammet CHECK-en i en prøve-DB til å avvise «é», som JS godtar. `ingestObservation` feilet da med 23514 og ingen rad ble lagret. Gap-tallet 9 459 regnet jeg uavhengig og fikk samme tall.

## (2) Funn

**F1, MEDIUM: den typede bekreftelsen dekker ikke G4-kjeden når grunnvinduet er over 30.**
- Sted: `service.ts:154,197,303`. Forkortingen sammenlignes mot rutens standard (30). G4 bruker `min(JARVIS_SITUATION_LOG_RETENTION_DAYS, retention_days)`, og uten rad er vinduet `JARVIS_SITUATION_LOG_RETENTION_DAYS` (`signal-retention.ts:93`, `situation-signals-wiring.ts:258,266`). Env-verdien kan være 7–365.
- Scenario (probe S3): `JARVIS_SITUATION_LOG_RETENTION_DAYS=90`, ingen rad. Eieren setter retention 31. Ruten ser 30→31 som forlengelse, svarer 200 med `shortened:[]` og krever ingen bekreftelse. Neste sveip sletter vision-situasjoner på 40, 60 og 80 dager. Kontroll uten rutekallet: alle overlever.
- Fiks: la `main.ts` gi ruten G4-grunnvinduet (kun når `JARVIS_SITUATION_SIGNALS=on`). Regn `retention_days` som forkorting når `min(base, next) < (row ? min(base, row.retention_days) : base)`. Alternativt skriv begrensningen i D-485 og runbook.

**F2, LOW: API-kontrakten og 409 er stille om G4.**
- Sted: `vision-routes.ts:165` og `:306`. `applies_to:"new_records"` står i alle svar, og 409 nevner ikke avledede situasjoner.
- Probe S1: 30→7 med bekreftelse slettet vision-situasjonene på 10, 15 (`security_alert`), 20 og 40 dager. Den åpne situasjonen på 10 dager ble også slettet. Tilbakemeldingene ble kaskade-slettet. Situasjonen på 3 dager, den som er referert fra `decision_log`, og home- og health-situasjoner ble stående.
- Probe S4: forlengelse (365) gir ikke lengre levetid for avledede situasjoner, fordi G4 tar `min` mot grunnvinduet.
- Fiks: egen advarselskode i 409 og/eller `affects_existing:["signal_situations"]` når signalflagget er på. Skriv `min`-regelen i runbook §4 og DPIA.

**F3, LOW: NAS-trinn 11 (runbook l.153) er destruktivt uten advarsel.**
- Trinnet ender på 10/3 på eierens ekte space, uten steg for å sette tilbake `{30,null}`. Med G4 på fjerner neste sveip avledede situasjoner eldre enn 10 dager.
- Fiks: legg til tilbakestilling og en advarsel.

**F4, INFO: bekreftelsen er friksjon, ikke bevis.** 409 oppgir selv hva som skal ekkoes (`confirm_memory_space_required`). Det er samme mønster som `cameras/remove`. Det virkelige vernet er step-up og eier-port, og kanalpåstanden er klient-påstått til WP-S1.

**F5, INFO: gammel `setRetentionPolicy` (`service.ts:245`) omgår lås, bekreftelse og revisjon.** Ingen kaller den utenfor tester (grep). Bør merkes `@internal`.

**F6, INFO: svaret oppgir ikke hvilket space det gjelder.** En health-grant kan skrive en rad som kortet ikke viser.

## (3) G4-kjeden, bevist ende-til-ende

Probe: `zz-g3b-review-g4chain` (6/6). Den bruker ekte server, ekte `VisionService`, `createSituationSignalsWiring` og `runner.tick()`.
- Forkorting via ruten sletter avledede situasjoner i domenet `vision` (også åpne og `security_alert`) eldre enn det nye vinduet, pluss kaskade til `situation_feedback`. Det beskytter ikke at G4 tar `min` mot `JARVIS_SITUATION_LOG_RETENTION_DAYS`.
- Home- og health-situasjoner og situasjoner referert fra `decision_log` rammes ikke. Claim-tilstand kunne jeg ikke seede for `vision` (CHECK `situations_act_claim_tuple_ck`); `vision` er i `NEVER_ACT_DOMAINS`.
- Flagget AV etterpå (S6): raden blir stående og driver fortsatt G4-sveipet. D-153-sveipet og `sweep.ts` bruker lagret utløp og påvirkes ikke.
- En rad satt via en annen space-grant påvirker ikke home-rommet (S5).
- «Forkorting sletter IKKE eksisterende vision-rader» stemmer for alle vision-tabellsveipene. Tripwire-testen dekker `purgeExpiredObservations`, `purgeExpiredSnapshots`, `inventory.purgeExpired` og hele vedlikeholdssveipet. G4 står utenfor, og det er riktig oppgitt som unntak.
- Den typede bekreftelsen er ærlig om at noe kan slettes, men ikke om hva (F1, F2).

## (4) Mutanter: 75 egne

| Gruppe | Antall | Utfall |
|---|---|---|
| `service.ts` S01–S27 | 27 | 26 drept, S24 overlevde |
| `vision-routes.ts` R01–R18 | 18 | 18 drept |
| `privacy-vision.ts`/`register.ts`/`privacy.ts` C01–C14 | 14 | 12 drept, C05 og C14 overlevde |
| Etikett L01–L06 | 6 | 6 drept (inkl. L06: ny migrasjon som nevner CHECK-ene) |
| Runde 2: S28–S31, R19–R22, C15, C17 | 10 | 10 drept |

- Totalt overlevde 3. Byggerens «56 alle drept» er bekreftet for de gruppene jeg dekket, men med tre unntak:
  - **S24**: «skriversti uten min-klemme» overlevde i byggerens to G3b-filer. Den ble drept av `g3-lifecycle` og av min probe, så det er dekket av suiten.
  - **C05**: ytre `catch` i `buildVisionSection` er ikke nåbar med realistisk input.
  - **C14**: en feil i `retentionItems` ville gi hele seksjonen «utilgjengelig» i stedet for ett UNKNOWN-element. Det kan bare skje ved ødelagt `source.defaults`, som `main.ts` setter fra konstanter. Liten testhull.

## (5) Flagg AV = main

- Baseline-opptaket er autentisk. Jeg tok en byte-kopi av `privacy.ts` fra `71a31d8b` (`git show`) og kjørte byggerens tre scenarier mot den. Resultatet er byte-likt med `wpg3b-privacy-center-main-baseline.json`, og branchens senter uten `vision` er byte-likt med main.
- `registerControlCenters` fra branch mot en main-kopi: 83 kombinasjoner av senterflagg × visionflagg × kilde gir byte-lik rapport. Bare (kilde ∧ `JARVIS_VISION_ENABLED` eksakt `on` ∧ senter `on`) gir kortet. Ikke-eier-avslag er likt, og `status()` kalles aldri uten kort.
- Kortet viser bare tall, tilstander og koder. Hostile strenger (kamera-id, URL, bearer, `sk-ant`) og feiltekster når ikke rapporten. 1e308, NaN, Infinity og negative tall krasjer ikke senteret. RLS mot ekte DB utelater helse-rom og andre tenanter.
- Guard-kjøring: 79 filer / 1508 tester grønne (exit 0). Dekker `wpg3-*`, `wpg3b-*`, `wph0/1/2-*` (inkl. `wph1-flag-off-selection-baseline` 7 og `wph2-flag-off-main-parity` 12), `modules/vision/**`, `d420`, `d398-*`, `env-drift`, `part3-tool-manifest`, `wpg4-signals-retention-wiring` og `wpg4-fix-lifecycle`.
- Filtellingene stemmer med byggerens: wpg3b 4, wph0 18, wph1 11, wph2 15, wpg3 4, vision 18.
- `gitleaks origin/main..HEAD`: 9 commits, no leaks.

## (6) Docs mot kode

Stemmer: 12 ruter, 9 459 kodepunkt, filnavn og testtall, `NOT VERIFIED` er ikke presentert som fakta, og runbook er ærlig om at G4-kjeden ikke var bevist.

Avvik:
- **F3 (NAS-trinn 11):** trinnet er destruktivt uten advarsel eller tilbakestilling.
- **F2:** runbook og DPIA mangler `min`-regelen mot grunnvinduet og at åpne situasjoner og `security_alert` slettes. Runbook §4 sier fortsatt at ingen test dekker kjeden. Nå finnes `zz-g3b-review-g4chain`, som kan promoveres til en vanlig test.
- Runbook sier «tripwire mot alle sveipene». Tripwire dekker vision-tabellene; G4 er riktig nevnt som unntak i samme avsnitt.

## (7) Ikke verifisert av meg

- NAS og ekte HA, kamera eller modell. `en_US.UTF-8` (JARVIS-114 l) og ekte step-up-kanal (WP-S1/JARVIS-111).
- Rate limit på de nye rutene (uendret `authedRequest`-sti).
- Full suite, `typecheck` og `lint` (byggerens oppgitte exit 0 er ikke gjenkjørt av meg).
- Docs er ikke gjennomlest linje for linje utover diffen.
