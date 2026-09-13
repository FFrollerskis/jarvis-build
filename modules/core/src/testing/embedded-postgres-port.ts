/**
 * Trygt portvalg for embedded Postgres i tester (D-137).
 *
 * Bakgrunn: testene valgte tidligere port med `30000 + random(20000)`. Det
 * intervallet overlapper operativsystemets EFEMERE portintervall (Linux:
 * typisk 32768-60999). En vilkaarlig utgaaende TCP-forbindelse fra en hvilken
 * som helst prosess paa maskinen kan derfor allerede holde porten paa IPv4.
 *
 * Postgres behandler en delvis bind-feil som IKKE-fatal: den binder IPv6 (::1)
 * og unix-socketen, logger `could not bind IPv4 address "127.0.0.1": Address
 * already in use`, og melder likevel `database system is ready to accept
 * connections`. `EmbeddedPostgres.start()` ser ready-meldingen og resolver -
 * men testen kobler til 127.0.0.1 og faar ECONNREFUSED langt nede i
 * migrasjonene. Det er ikke en flaky test, det er et reelt portvalg-defekt.
 *
 * Fiksen er fail-closed: velg alltid en port STRENGT UNDER det efemere
 * intervallet, slik at kjernen aldri kan dele ut porten til en utgaaende
 * forbindelse. Funksjonen er synkron med vilje - kallstedene evaluerer porten
 * paa modulnivaa (`const PORT = allocateEmbeddedPostgresPort()`).
 */

import { readFileSync } from "node:fs";

/** Konservativ nedre grense for efemere porter naar OS-verdien ikke kan leses. */
const FALLBACK_EPHEMERAL_LOW = 32768;

/** Bredden paa vinduet vi trekker fra, naar det er plass til det. */
const WINDOW_SPAN = 12288;

/** Aldri gaa under dette - holder oss klar av well-known/registrerte tjenester. */
const HARD_FLOOR = 10000;

/**
 * Nedre grense for operativsystemets efemere portintervall.
 * Leses fra kjernen paa Linux; ellers brukes en konservativ fallback som ogsaa
 * er trygg paa Windows og macOS (dynamisk intervall der starter paa 49152).
 */
function ephemeralLowBound(): number {
  if (process.platform !== "linux") return FALLBACK_EPHEMERAL_LOW;
  try {
    const raw = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8");
    const first = raw.trim().split(/\s+/)[0] ?? "";
    const low = Number.parseInt(first, 10);
    if (Number.isInteger(low) && low > HARD_FLOOR) return low;
  } catch {
    // Ikke lesbar (container/sandbox): fall tilbake til den konservative verdien.
  }
  return FALLBACK_EPHEMERAL_LOW;
}

/**
 * Returnerer en port som er trygg aa binde for en embedded Postgres-instans:
 * strengt under OS-ets efemere intervall, og dermed utenfor rekkevidde for
 * automatisk tildelte utgaaende porter.
 *
 * @throws naar maskinen ikke har et brukbart vindu under det efemere
 * intervallet - da er stille fortsettelse verre enn aa stoppe.
 */
export function allocateEmbeddedPostgresPort(): number {
  const ephemeralLow = Math.min(ephemeralLowBound(), FALLBACK_EPHEMERAL_LOW);
  const high = ephemeralLow - 1;
  const low = Math.max(HARD_FLOOR, high - WINDOW_SPAN + 1);
  if (high < low) {
    throw new Error(
      `Ingen trygg testport tilgjengelig: efemert intervall starter paa ${ephemeralLow}, ` +
        `som ikke etterlater et vindu over ${HARD_FLOOR}.`
    );
  }
  return low + Math.floor(Math.random() * (high - low + 1));
}
