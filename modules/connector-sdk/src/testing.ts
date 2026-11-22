/**
 * TEST-SUPPORT-GRENSEN for `@jarvis/connector-sdk` (D-396-mønsteret, jf. `@jarvis/core/testing`): kontraktstest-kittet (`runConnectorContract`), fake-adapter-harnessen (`createFakeConnector`,
 * `FAKE_DEFECTS`), den virtuelle klokken, hemmelighetsformene/innsprøytingsteksten kittet bruker og Appendiks B-scoringen.
 *
 * Denne barrelen er BEVISST ikke re-eksportert fra hovedinngangen (`src/index.ts`). Harnessen bærer med vilje brutale defekter (`leaks_credential`, `cross_tenant_allowed` ...) og hører ikke hjemme i
 * noen produksjons-API-modulgraf (JARVIS-096): hvis `apps/api` en dag får pakken som avhengighet (connector-gjeld, runbook §8), skal den KUN importere `@jarvis/connector-sdk`, aldri `/testing`.
 * Tester, scaffold-malene og `scripts/report.ts` bruker denne inngangen.
 */
export * from "./contract/index.ts";
