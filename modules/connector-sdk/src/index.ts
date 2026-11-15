/**
 * HOVEDINNGANGEN til `@jarvis/connector-sdk` (WP-I, D-472): manifestmodellen (skjema, validator), avledning fra registeret, katalog/drift, de håndskrevne referansemanifestene, CI-vakten og connector-gjeld.
 * Alt her er ren beskrivelse/validering uten test-doubles. Kontraktstest-kittet, fake-harnessen, den virtuelle klokken og Appendiks B-scoringen ligger BEVISST IKKE her: de nås kun via subpath-en
 * `@jarvis/connector-sdk/testing` (`src/testing.ts`) - samme grense som `@jarvis/core/testing` (D-139 A.4, D-396/JARVIS-096). En test (`test/testing-split.test.ts`) låser at ingen fake-/harness-symboler
 * og ingen import fra `contract/` når hovedinngangen.
 */
export * from "./manifest.ts";
export * from "./validate.ts";
export * from "./derive.ts";
export * from "./production-definitions.ts";
export * from "./catalogue.ts";
export * from "./builders.ts";
export * from "./manifests/index.ts";
export * from "./guard.ts";
export * from "./debt.ts";
export type { HealthState } from "./health-state.ts";
