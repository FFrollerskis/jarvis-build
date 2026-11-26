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

/**
 * Dreper HELE prosessgruppen `proc` leder (krever `detached: true` ved spawn), ALDRI kun selve PID-en: en wrapper-script/binær kan
 * ha barneprosesser som arver stdout-pipen - å drepe bare toppen lar pipen stå åpen (Node ser aldri `close`) og et kall henger til
 * barnet gir opp. `ESRCH` (allerede borte) svelges bevisst - det er det forventede, harmløse utfallet.
 */
export function killProcessGroup(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGTERM"): void {
  if (proc.exitCode !== null || proc.pid === undefined || (signal === "SIGTERM" && proc.killed)) {
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    // ESRCH: allerede avsluttet.
  }
}
