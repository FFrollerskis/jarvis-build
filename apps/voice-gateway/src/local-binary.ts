import type { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * WP-V2 (K1c, audit D1): tilgjengelighetssjekk for lokale binærer (whisper.cpp/piper) og stemme-/språkmodeller.
 *
 * `available()` på de lokale adapterne sjekket før kun at miljøvariablene var satt. Med en feil sti (slettet binær, manglende
 * execute-bit, feil modellfil) ble adapteren likevel valgt og feilet først midt i en samtale. Nå avgjøres det ved valg og i `/health`.
 * Kun lesende operasjoner (`stat`/`access`) - ingen disk-skriving (§22).
 */
export type LocalBinaryProblem = "not_configured" | "binary_not_executable" | "model_not_readable";

/** Finner en kjørbar fil: en sti med `/` sjekkes direkte; et rent kommandonavn søkes i PATH (som `spawn` selv gjør). */
export function findExecutable(bin: string): string | undefined {
  const candidates = bin.includes("/")
    ? [bin]
    : (process.env["PATH"] ?? "")
        .split(delimiter)
        .filter((d) => d.length > 0)
        .map((d) => join(d, bin));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      }
    } catch {
      // Ikke her - prøv neste.
    }
  }
  return undefined;
}

/** `undefined` = alt på plass. Ellers en kort kode (aldri en sti) som kan vises i `/status`. */
export function probeLocalBinary(binPath: string | undefined, modelPath: string | undefined): LocalBinaryProblem | undefined {
  if (!binPath || !modelPath) {
    return "not_configured";
  }
  if (findExecutable(binPath) === undefined) {
    return "binary_not_executable";
  }
  try {
    accessSync(modelPath, fsConstants.R_OK);
    if (!statSync(modelPath).isFile()) {
      return "model_not_readable";
    }
  } catch {
    return "model_not_readable";
  }
  return undefined;
}

/** FIX-7 (F7): hvor lenge et tilgjengelighetssvar gjenbrukes (ms). Kort nok til at en rettet konfigurasjon synes raskt, lang nok til at `/health` og hver TTS-chunk ikke går til disk. */
export const AVAILABILITY_CACHE_MS = 5_000;

/**
 * FIX-7 (F7): `probeLocalBinary` gjør SYNKRON `statSync`/`accessSync`, og `available()` kalles fra `/health` og for HVER TTS-chunk (`usableReserve`). Mot en hengende
 * nettmontering (NAS) kan ett slikt kall fryse hele event-loopen og dermed alle økter. Svaret (også «ikke tilgjengelig») gjenbrukes i `ttlMs`. Klokken er
 * injiserbar; en klokke som går bakover gir ny sjekk (aldri et evig cachet svar).
 */
export class AvailabilityCache {
  private cached: LocalBinaryProblem | undefined;
  private checkedAt = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly probe: () => LocalBinaryProblem | undefined,
    private readonly ttlMs: number = AVAILABILITY_CACHE_MS,
    private readonly now: () => number = Date.now
  ) {}

  get(): LocalBinaryProblem | undefined {
    const t = this.now();
    if (t - this.checkedAt >= this.ttlMs || t < this.checkedAt) {
      this.cached = this.probe();
      this.checkedAt = t;
    }
    return this.cached;
  }
}

/**
 * Dreper HELE prosessgruppen `proc` leder (krever `detached: true` ved spawn), ALDRI kun selve PID-en: en wrapper-script/binær kan
 * ha barneprosesser som arver stdout-pipen - å drepe bare toppen lar pipen stå åpen (Node ser aldri `close`) og et kall henger til
 * barnet gir opp. `ESRCH` (allerede borte) svelges bevisst - det er det forventede, harmløse utfallet.
 *
 * FIX-4 (runde 2): en prosess som er drept av et SIGNAL har `exitCode === null` men `signalCode` satt - begge sjekkes, ellers kunne en forsinket SIGKILL
 * (opptrappings-tidtakere) treffe en fremmed prosessgruppe som har overtatt den gamle pid-en.
 */
export function killProcessGroup(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGTERM"): void {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined || (signal === "SIGTERM" && proc.killed)) {
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    // ESRCH: allerede avsluttet.
  }
}
