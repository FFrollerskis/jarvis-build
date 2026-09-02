# PROJECT STATUS

**Oppdatert:** 2026-09-02 (branch `claude/ua6-vendor-registry`, PR #66, base `main=12f642b44f679bd8cf6f8604c78268e2ccb94b21`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

UA-6 Finance & Spend Integrity Gateway - HARDENING (D-116) + HOST FIX #1 (D-117). D-116 lukket
UA-6 sitt eneste gjenværende D-115-arkitekturgap (vendor-korrekthets-registeret). Første ekte
host-akseptanse (`run_id=f271e1db`) feilet (`hard_fail=true`) - rotårsak sporet og fikset denne
runden (se under). Eksplisitt Tobias-ordre fortsatt bindende: IKKE D-108, IKKE ekte
credentials/leverandørkall, IKKE UA-7.

## D-116 (implementert, PR #66)

Ny `finance_vendors`/`finance_vendor_provider_bindings` (migrasjon `045_finance_vendor_registry.sql`,
`UNIQUE(tenant_id, provider, provider_vendor_ref)`, FORCE RLS), ny `assertValidVendorBinding()`
choke-point kalt fra `FinanceService.submitPaymentIntent()` FØR alle fire provider-grener,
erasure-plan/ToolGateway-wiring, 23 nye tester (`vendor-registry.test.ts`). UA-6
akseptansekriterium 3 re-evaluert (alle fire delkrav PASS) ->
`UA6_ARCHITECTURE_ACCEPTANCE_COMPLETE=true`. Full detalj: D-116 i DECISIONS_AND_ASSUMPTIONS.md,
«UA-6 HARDENING»-seksjon i IMPLEMENTATION_PLAN.md.

## D-117 HOST FIX #1 (denne runden)

**Faktisk host-funn (Tobias, `run_id=f271e1db`):** `finance_vendor_binding_mismatch_blocked=PASS`,
`finance_vendor_binding_tenant_isolation=PASS`, MEN `finance_vendor_binding_match=NOT_RUN`,
`hard_fail=true`.

**Rotårsak verifisert fra kode (ikke gjettet):** `service.ts` sin pre-eksisterende
`provider==="fiken"`-gren (uendret siden D-107/D-109) krever BÅDE `vendor_provider_ref` OG
`counter_account_code` (`MissingCounterAccountError` ellers) FØR Fiken-transporten nås.
`spend-integrity-live.ts` sin nye "VENDOR BINDING MATCH"-fixture satte `vendor_provider_ref` men
glemte `counter_account_code` - D-116-gaten (`assertValidVendorBinding()`) PASSERTE korrekt, men
utførelsen kastet deretter på den eldre, urelaterte Fiken-kontrollen. Mismatch-/
tenant-isolasjon-testene var upåvirket (de kaster FØR Fiken-grenen nås uansett).
**Klassifisering: `HARNESS_FIXTURE_FAILURE`, IKKE `VENDOR_REGISTRY_RUNTIME_FAILURE`** - selve
choke-pointen fungerte som designet i alle tre scenarier.

**Fiks (minimal, kun i fixturen):** lagt til `counter_account_code: "1920"` (samme syntetiske
verdi som resten av UA-6 sine Fiken-fixturer) i `spend-integrity-live.ts` sin VENDOR BINDING
MATCH-seksjon. `MissingCounterAccountError`-kravet i produksjonskoden IKKE svekket/fjernet.
Mismatch-/tenant-isolasjon-fixturene urørt.

**Regresjon:** ny `modules/finance/test/spend-integrity-live-wiring.test.ts` (1 strukturell test,
samme kildekode-lese-mønster som `ua3-host-run-wiring.test.ts`) - bekrefter
`counter_account_code` er til stede i VENDOR BINDING MATCH-seksjonen.

**Historisk mislykket kjøring bevart ærlig:** `run_id=f271e1db`,
`finance_vendor_binding_match=NOT_RUN`, `hard_fail=true` - IKKE slettet/omskrevet, logget i D-117.

## Kvalitetsporter (denne HOST FIX-runden, kjørt lokalt)

- `pnpm -r typecheck`: 20/20 pakker rent.
- `pnpm lint` (`eslint .`): rent.
- Målrettet: `vendor-registry.test.ts` (23) + ny `spend-integrity-live-wiring.test.ts` (1) = 24/24
  grønt.
- Full workspace-suite: kjøres nå - eksakt tall og ny HEAD SHA registreres etter push (se
  PR #66 og sesjonens sluttrapport for eksakte tall - unngår SHA-drift mellom dokumenter).
- gitleaks: ikke kjørbar lokalt i dette miljøet - kjøres i CI.

## Flagg-status

`UA6_IMPLEMENTATION_COMPLETE=true`, `UA6_ARCHITECTURE_ACCEPTANCE_COMPLETE=true`,
`UA6_LIVE_PROVIDER_VERIFICATION_COMPLETE=false`, `UA6_CREDENTIAL_PHASE_COMPLETE=false`,
`D108_COMPLETE=false`, `UA6_COMPLETE=false`, `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false`,
`WALLESTER_LIVE_VERIFIED=false`, `WALLESTER_LIVE_GATE=PENDING_CREDENTIALS`,
`D116_HOST_ACCEPTANCE_FINAL=false` (host-akseptansen må kjøres PÅ NYTT mot den nye HEAD-en denne
fiksen produserer).

## Blokkeringer

Ingen.

## Neste oppgave

Commit/push HOST FIX #1 til PR #66 (samme PR, HEAD flyttes), vent på fresh CI grønt på den NYE
HEAD-en, rapporter eksakt ny SHA til Tobias sammen med eksakt host-kommando. Host-akseptanse skal
IKKE kjøres på nytt før CI er grønt på den nye HEAD-en. INGEN merge uten Tobias sin eksplisitte
godkjenning. INGEN D-108. INGEN UA-7.
