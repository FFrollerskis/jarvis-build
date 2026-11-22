/**
 * WP-I (D-472): felles helseordforråd. Speiler `HealthState` (`ToolGateway.health` / Integrasjonssenteret). Brukes av connector-gjeld (`debt.ts`, hovedinngangen) og av kontraktstest-kittet (`contract/types.ts`,
 * test-inngangen). Bare en TYPE - ingen kjøretidskode - slik at hovedinngangen aldri trenger å importere noe fra `contract/` (se `test/testing-split.test.ts`).
 */
export type HealthState = "healthy" | "degraded" | "rate_limited" | "auth_failed" | "unavailable";
