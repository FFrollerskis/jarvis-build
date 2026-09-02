# PROJECT STATUS

**Oppdatert:** 2026-09-02 (branch `claude/ua6-vendor-registry`, PR #66, base `main=12f642b44f679bd8cf6f8604c78268e2ccb94b21`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

UA-6 Finance & Spend Integrity Gateway - HARDENING (D-116) + to host-fix-runder (D-117/D-118).
D-116 lukket UA-6 sitt eneste gjenværende D-115-arkitekturgap (vendor-korrekthets-registeret). To
påfølgende ekte host-akseptanse-forsøk har feilet - begge rotårsak-sporet til host-HARNESSET
(IKKE vendor-registeret/Fiken-produksjonskoden) og fikset denne runden. Eksplisitt Tobias-ordre
fortsatt bindende: IKKE D-108, IKKE ekte credentials/leverandørkall, IKKE UA-7.

## D-116 (implementert, PR #66)

Ny `finance_vendors`/`finance_vendor_provider_bindings` (migrasjon `045_finance_vendor_registry.sql`,
`UNIQUE(tenant_id, provider, provider_vendor_ref)`, FORCE RLS), ny `assertValidVendorBinding()`
choke-point kalt fra `FinanceService.submitPaymentIntent()` FØR alle fire provider-grener,
erasure-plan/ToolGateway-wiring, 23 nye tester (`vendor-registry.test.ts`). UA-6
akseptansekriterium 3 re-evaluert (alle fire delkrav PASS) ->
`UA6_ARCHITECTURE_ACCEPTANCE_COMPLETE=true`. Full detalj: D-116 i DECISIONS_AND_ASSUMPTIONS.md.

## D-117 HOST FIX #1 (ferdig, i tidligere HEAD 8c0a328)

Første host-run (`run_id=f271e1db`): `finance_vendor_binding_match=NOT_RUN`, `hard_fail=true`.
Rotårsak: VENDOR BINDING MATCH-fixturen manglet `counter_account_code` (påkrevd av den
pre-eksisterende, urelaterte Fiken-innsendingskontrollen i `service.ts`, uendret siden
D-107/D-109). Klassifisert `HARNESS_FIXTURE_FAILURE`. Fikset (kun fixturen), ny regresjonstest
`spend-integrity-live-wiring.test.ts`. Full detalj: D-117 i DECISIONS_AND_ASSUMPTIONS.md.

## D-118 HOST FIX #2 (denne runden)

**Faktisk host-funn (Tobias, `run_id=c0c91446`, testet HEAD 8c0a328 etter D-117):**
`finance_vendor_binding_mismatch_blocked=PASS`, `finance_vendor_binding_tenant_isolation=PASS`,
`finance_spend_cleanup=PASS`, MEN `finance_vendor_binding_match=FAIL`, `hard_fail=true`.

**Rotårsak verifisert fra kode (ikke gjettet):** den EKSISTERENDE, uendrede Fiken-grenen i
`service.ts` (linje 638) setter `state = 'provider_acknowledged'` rett etter en vellykket
`createGeneralJournalEntry()` - ALDRI `'submitted'`. `spend-integrity-live.ts` sin VENDOR BINDING
MATCH-assertion forventet feilaktig `submitted.state === "submitted"`. Vendor-bindingen ble
godtatt korrekt, Fiken-faken ble nådd EKSAKT én gang, hele flyten fullførte normalt - kun den
forventede strengen var feil.

**Klassifisering: `HARNESS_EXPECTATION_FAILURE`, IKKE `VENDOR_REGISTRY_RUNTIME_FAILURE`, IKKE
`FIKEN_RUNTIME_FAILURE`.**

**Fiks (minimal, kun forventet streng):** `submitted.state === "submitted"` ->
`submitted.state === "provider_acknowledged"` i `spend-integrity-live.ts`. INGEN endring i
`FinanceService.submitPaymentIntent()`, Fiken-tilstandsovergangen, vendor-registeret,
`assertValidVendorBinding()`, nødbryteren, provider-dispatch, idempotens, mismatch-/
tenant-isolasjon-testene, eller credential-/provider-abstraksjonene.

**Regresjon:** utvidet den EKSISTERENDE `spend-integrity-live-wiring.test.ts` (fra D-117) med ett
nytt testtilfelle som låser at suksess-assertionen forventer `"provider_acknowledged"` og ALDRI
`"submitted"`.

**Begge historiske mislykkede kjøringer bevart ærlig, ingen brukt som final D-116
host-akseptanse:** `run_id=f271e1db` (D-117, `HARNESS_FIXTURE_FAILURE`) og `run_id=c0c91446`
(D-118, `HARNESS_EXPECTATION_FAILURE`).

## Kvalitetsporter (denne HOST FIX #2-runden, kjørt lokalt)

- `pnpm -r typecheck`: 20/20 pakker rent.
- `pnpm lint` (`eslint .`): rent.
- Målrettet: `vendor-registry.test.ts` (23) + `spend-integrity-live-wiring.test.ts` (2) = 25/25 grønt.
- Full workspace-suite: 2817 passed / 43 skipped (`wallester-service.test.ts`, `afterAll`
  pool-cleanup-timeout - environment-flake, IKKE en regresjon; re-kjørt isolert 43/43 grønt).
  Effektivt 2860/2860.
- gitleaks: ikke kjørbar lokalt i dette miljøet - kjøres i CI, manuell secret-mønster-grep av
  diffen gjort før commit.

## Flagg-status

`UA6_IMPLEMENTATION_COMPLETE=true`, `UA6_ARCHITECTURE_ACCEPTANCE_COMPLETE=true`,
`UA6_LIVE_PROVIDER_VERIFICATION_COMPLETE=false`, `UA6_CREDENTIAL_PHASE_COMPLETE=false`,
`D108_COMPLETE=false`, `UA6_COMPLETE=false`, `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false`,
`WALLESTER_LIVE_VERIFIED=false`, `WALLESTER_LIVE_GATE=PENDING_CREDENTIALS`,
`D116_HOST_ACCEPTANCE_FINAL=false` (host-akseptansen må kjøres PÅ NYTT - en TREDJE gang - mot den
nye HEAD-en denne fiksen produserer).

## Blokkeringer

Ingen.

## Neste oppgave

Commit/push HOST FIX #2 til PR #66 (samme PR, HEAD flyttes), vent på fresh CI grønt på den NYE
HEAD-en, rapporter eksakt ny SHA til Tobias sammen med eksakt host-kommando. Host-akseptanse skal
IKKE kjøres på nytt før CI er grønt på den nye HEAD-en. INGEN merge uten Tobias sin eksplisitte
godkjenning. INGEN D-108. INGEN UA-7.
