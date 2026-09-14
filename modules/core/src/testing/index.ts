/**
 * Test-support-grensen for @jarvis/core (D-139 A.4).
 *
 * Denne barrelen er BEVISST ikke re-eksportert fra `@jarvis/core`. Alt her er
 * Node-spesifikk testinfrastruktur (node:net, node:fs, node:child_process) og
 * hoerer ikke hjemme i produksjons-API-et eller i kjernens avhengighetsgraf.
 * Den naas kun via subpath-en `@jarvis/core/testing`.
 */
export * from "./ephemeral-range.ts";
export * from "./port-lease.ts";
export * from "./embedded-postgres.ts";
