/**
 * Operativsystemets EFEMERE portintervall - lest, ikke antatt (D-139 A.3).
 *
 * D-137 gjorde en feil som saa ufarlig ut: naar intervallet ikke kunne leses,
 * substituerte den stille 32768 og behandlet resultatet som om det var lest.
 * Det er et udokumentert gjett forkledd som et faktum. Denne modulen skiller
 * derfor tre tilstander fra hverandre og lar ALDRI den ene se ut som den andre:
 *
 *   read        intervallet ble faktisk lest fra kjernen
 *   unreadable  kilden finnes for plattformen, men kunne ikke leses/tolkes
 *   unsupported vi har ingen kilde for denne plattformen
 *
 * Bare `read` kan gi et BEVIST disjunkt kandidatvindu. De to andre gir et
 * ANTATT vindu som eksplisitt er merket som ikke-bevist, og eksklusiviteten
 * hviler da i sin helhet paa portleien og paa den etterfoelgende
 * verifikasjonen av at Postgres faktisk bandt IPv4.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Aldri under dette - holder oss klar av well-known/registrerte tjenester. */
export const SAFETY_FLOOR = 10000;

/** Bredden paa kandidatvinduet naar det er plass til det. */
export const WINDOW_SPAN = 4096;

/**
 * Den laveste efemere startporten vi kjenner til paa tvers av plattformer
 * (Linux 32768; Windows og macOS starter paa 49152).
 *
 * Dette er en HEURISTIKK og brukes KUN naar intervallet ikke kunne leses. Den
 * presenteres aldri som bevis - vinduet den gir er merket `assumed`.
 */
export const CONSERVATIVE_EPHEMERAL_LOW = 32768;

export type EphemeralRangeReading =
  | { readonly kind: "read"; readonly low: number; readonly high: number; readonly source: string }
  | { readonly kind: "unreadable"; readonly source: string; readonly detail: string }
  | { readonly kind: "unsupported"; readonly platform: string };

export type CandidateWindow = {
  readonly low: number;
  readonly high: number;
  /** `true` bare naar vinduet er bevist disjunkt fra et FAKTISK lest intervall. */
  readonly proven: boolean;
  readonly basis: string;
};

export interface RangeProbes {
  readonly platform?: string;
  readonly readFile?: (path: string) => string;
  readonly runCommand?: (file: string, args: readonly string[]) => string;
}

function parsePair(text: string, source: string): EphemeralRangeReading {
  const numbers = text.trim().split(/\s+/).map((t) => Number.parseInt(t, 10)).filter((n) => Number.isInteger(n));
  const low = numbers[0];
  const high = numbers[1];
  if (low === undefined || high === undefined) {
    return { kind: "unreadable", source, detail: `fant ikke to heltall i ${JSON.stringify(text.slice(0, 120))}` };
  }
  if (low < 1 || high > 65535 || low > high) {
    return { kind: "unreadable", source, detail: `ugyldig intervall ${low}-${high}` };
  }
  return { kind: "read", low, high, source };
}

/** Leser det efemere intervallet fra kjernen paa plattformer vi har en kilde for. */
export function readEphemeralRange(probes: RangeProbes = {}): EphemeralRangeReading {
  const platform = probes.platform ?? process.platform;
  const readFile = probes.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const runCommand =
    probes.runCommand ??
    ((file: string, args: readonly string[]) =>
      execFileSync(file, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }));

  if (platform === "linux") {
    const source = "/proc/sys/net/ipv4/ip_local_port_range";
    try {
      return parsePair(readFile(source), source);
    } catch (err) {
      return { kind: "unreadable", source, detail: (err as Error).message };
    }
  }

  if (platform === "win32") {
    const source = "netsh int ipv4 show dynamicport tcp";
    try {
      const out = runCommand("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"]);
      // Utskriften er lokalisert; tallene staar som "<etikett> : <n>" i fast rekkefoelge
      // (startport, deretter antall porter). Vi leser tallene, ikke etikettene.
      const values = [...out.matchAll(/:\s*(\d+)/g)].map((m) => Number.parseInt(m[1] ?? "", 10));
      const start = values[0];
      const count = values[1];
      if (!Number.isInteger(start) || !Number.isInteger(count) || count === undefined || start === undefined || count < 1) {
        return { kind: "unreadable", source, detail: `klarte ikke tolke netsh-utskrift: ${JSON.stringify(out.slice(0, 160))}` };
      }
      return parsePair(`${start} ${Math.min(65535, start + count - 1)}`, source);
    } catch (err) {
      return { kind: "unreadable", source, detail: (err as Error).message };
    }
  }

  if (platform === "darwin") {
    const source = "sysctl net.inet.ip.portrange.first/last";
    try {
      const out = runCommand("sysctl", ["-n", "net.inet.ip.portrange.first", "net.inet.ip.portrange.last"]);
      return parsePair(out, source);
    } catch (err) {
      return { kind: "unreadable", source, detail: (err as Error).message };
    }
  }

  return { kind: "unsupported", platform };
}

/**
 * Kandidatvinduet vi trekker portforslag fra.
 *
 * Naar intervallet ER lest:
 *   - foerst et vindu STRENGT UNDER det, hvis det er plass over sikkerhetsgulvet;
 *   - ellers et vindu STRENGT OVER det, som er like beviselig disjunkt;
 *   - finnes ingen av delene, kastes det. Aa falle tilbake paa et gjett her ville
 *     vaert nettopp den stille substitusjonen D-139 A.3 forbyr.
 *
 * Naar intervallet IKKE er lest, er vinduet merket `proven: false`.
 */
export function candidateWindow(reading: EphemeralRangeReading, span: number = WINDOW_SPAN): CandidateWindow {
  if (reading.kind === "read") {
    const below = reading.low - 1;
    if (below > SAFETY_FLOOR) {
      const low = Math.max(SAFETY_FLOOR, below - span + 1);
      return { low, high: below, proven: true, basis: `strengt under lest efemert intervall ${reading.low}-${reading.high} (${reading.source})` };
    }
    if (reading.high < 65535) {
      const high = Math.min(65535, reading.high + span);
      return { low: reading.high + 1, high, proven: true, basis: `strengt over lest efemert intervall ${reading.low}-${reading.high} (${reading.source})` };
    }
    throw new Error(
      `Ingen trygg testport finnes: det efemere intervallet ${reading.low}-${reading.high} (${reading.source}) ` +
        `etterlater verken plass over sikkerhetsgulvet ${SAFETY_FLOOR} eller over 65535. Feiler lukket.`
    );
  }

  const detail = reading.kind === "unreadable" ? `${reading.source}: ${reading.detail}` : `plattform ${reading.platform} har ingen kjent kilde`;
  return {
    low: CONSERVATIVE_EPHEMERAL_LOW - span,
    high: CONSERVATIVE_EPHEMERAL_LOW - 1,
    proven: false,
    basis:
      `det efemere intervallet kunne IKKE leses (${detail}); vinduet er konservativt antatt og IKKE bevist disjunkt - ` +
      `eksklusiviteten hviler da paa portleien og paa verifisert IPv4-binding, ikke paa dette vinduet`
  };
}
