# PROJECT STATUS

**Oppdatert:** 2026-09-02 (branch `claude/ua6-vendor-registry`, base `main=12f642b44f679bd8cf6f8604c78268e2ccb94b21`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her. Denne versjonen erstatter en
> historisk 5000+ linjers append-logg (tidligere sesjoner fulgte ikke "kort, overskrives"-regelen);
> ingenting er tapt - hele den gamle teksten forblir tilgjengelig i git-historikken for denne filen.

## Aktiv fase/oppgave

UA-6 Finance & Spend Integrity Gateway - HARDENING (D-116): lukker UA-6 sitt eneste gjenværende
D-115-arkitekturgap (masterplan-akseptansekriterium 3b, PARTIAL - syntaktisk gyldig men FEIL
`vendor_provider_ref` kunne ikke skilles fra korrekt uten enten live leverandørkall eller et
Jarvis-eid register). Eksplisitt Tobias-ordre: IKKE D-108, IKKE ekte credentials/leverandørkall,
IKKE UA-7, IKKE andre nye masterplanfaser før denne smale sliceen er ferdig.

## Ferdig arbeid (denne sliceen)

- Audit-før-design (byggeordrens §2): ingen reuse-kandidat funnet (`business_companies` er
  CRM-/kunde-orientert, ikke leverandør) - dokumentert avvisning, ny minimal struktur bygget.
- Migrasjon `045_finance_vendor_registry.sql`: `finance_vendors` + `finance_vendor_provider_bindings`
  (`UNIQUE (tenant_id, provider, provider_vendor_ref)`, FORCE RLS, opak referanse - ingen
  regex-gjetting), additiv `payment_intents.vendor_id`.
- `modules/finance/src/vendor-registry.ts`: choke-point-validatoren `assertValidVendorBinding()` +
  CRUD (`createVendor`/`bindVendorProvider`/`revokeVendorProviderBinding`/`listVendor*`).
- `FinanceService.submitPaymentIntent()`: gaten kjører FØR alle fire provider-grener
  (fiken/stripe/vipps/neonomics), betinget på `current.vendor_id !== null` (byte-for-byte
  bakoverkompatibelt for all historikk).
- `modules/erasure/src/plan.ts`: barn-FK-før-forelder-rekkefølge for de to nye tabellene.
- `ToolGateway`: `create_vendor`/`list_vendors`/`bind_vendor_provider`/
  `revoke_vendor_provider_binding`/`list_vendor_bindings` (+ valgfri `vendor_id` på
  `create_payment_intent`).
- `modules/finance/test/vendor-registry.test.ts`: 23 tester, ekte embedded Postgres/RLS, dekker
  byggeordrens 15 numrerte scenarier.
- `modules/finance/scripts/spend-integrity-live.ts`: tre nye guardede host-akseptanse-markører
  (`finance_vendor_binding_match`/`_mismatch_blocked`/`_tenant_isolation`), lokal Fiken-fake -
  ZERO ekte credentials/leverandørkall.
- Re-evaluert UA-6 akseptansekriterium 3 (alle fire delkrav, file:line-evidens):
  `UA6_ARCHITECTURE_ACCEPTANCE_COMPLETE` forfremmet fra `false` til `true`.
- D-116 logget i DECISIONS_AND_ASSUMPTIONS.md; ny "UA-6 HARDENING"-seksjon i
  IMPLEMENTATION_PLAN.md.

## Kvalitetsporter (denne sliceen, kjørt lokalt)

- `pnpm -r typecheck`: 20/20 pakker rent.
- `pnpm lint` (`eslint .`): rent.
- Målrettet: `vendor-registry.test.ts` 23/23 grønt.
- Full workspace-suite: **179/179 filer, 2858/2858 tester grønt** (opp fra 178/2835 - eksakt
  +1 fil/+23 tester, INGEN regresjon).
- gitleaks: ikke kjørbar lokalt i dette miljøet - kjøres i CI, manuell secret-mønster-grep av
  diffen gjort før commit.

## Flagg-status (uendret utover kriterium 3 over)

`UA6_IMPLEMENTATION_COMPLETE=true`, `UA6_ARCHITECTURE_ACCEPTANCE_COMPLETE=true` (NYTT),
`UA6_LIVE_PROVIDER_VERIFICATION_COMPLETE=false`, `UA6_CREDENTIAL_PHASE_COMPLETE=false`,
`D108_COMPLETE=false`, `UA6_COMPLETE=false` (nå styrt av D-108 alene),
`Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false`, `WALLESTER_LIVE_VERIFIED=false`,
`WALLESTER_LIVE_GATE=PENDING_CREDENTIALS`.

## Blokkeringer

Ingen. Branch/PR/host-akseptanse-status oppdateres her når de foreligger.

## Neste oppgave

Commit, push `claude/ua6-vendor-registry`, opprett draft PR, vent på fresh CI grønt. Host-
akseptanse (`spend-integrity-live-host-run.ts`) skal IKKE kjøres av Tobias før PR-head er endelig
og CI er grønt (jf. byggeordrens §14) - eksakt kommando gis i PR-beskrivelsen/sluttrapporten. INGEN
merge uten Tobias sin eksplisitte godkjenning. INGEN D-108. INGEN UA-7.
