import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * WP-PGA fiks 1 (M1): eksklusiv lås og «bytt hvis uendret»-skriving for de to skrivende stiene (`gate-recorder.ts` og `fingerprint-tool.ts`). Uten dem kunne to samtidige registreringer av samme port
 * begge melde `ok` mens bare den ene overgangen sto igjen i historikken (tapt oppdatering).
 *
 * LÅSEN er en fil som lages med `wx` (O_EXCL: atomisk, feiler hvis den finnes). Den som ikke får den, nektes (`held`): ingen venting og ingen blind retry. Innholdet er et unikt token, så `release`
 * aldri fjerner en lås som er overtatt av en annen. En lås eldre enn 60 s (mtime) regnes som foreldet (en avbrutt registrering) og kan overtas med en tydelig melding. Overtakelsen er BESTE INNSATS
 * (to samtidige overtakere av samme foreldede lås er teoretisk mulig); sikkerhetsnettet er re-lesingen rett før rename, som nekter å skrive over en fil en annen har rørt.
 *
 * Ren filsystembruk, ingen nettverk, ingen avhengigheter. Ikke eksportert fra `@jarvis/contracts`-barrelen (BUILT_UNWIRED).
 */
export const STALE_LOCK_MS = 60_000;

/** Er en lås med denne mtime foreldet nå? Strengt eldre enn grensen (nøyaktig 60 s er ikke foreldet). */
export const isStale = (mtimeMs: number, nowMs: number, staleMs: number = STALE_LOCK_MS): boolean => nowMs - mtimeMs > staleMs;

export type LockResult =
  | { ok: true; release: () => void; took_over_stale: boolean }
  | { ok: false; reason: "held" | "unavailable"; detail: string };

export interface LockOptions {
  /** «Nå» i ms (injiseres av testene). */
  now_ms?: number;
  stale_ms?: number;
}

const errCode = (err: unknown): string => ((err as { code?: unknown }).code as string | undefined) ?? "UKJENT";

/** Prøver å lage låsfilen. Returnerer tokenet ved suksess, «exists» hvis den finnes, ellers feilkoden. */
function tryCreate(lockPath: string, token: string): { kind: "created" } | { kind: "exists" } | { kind: "error"; code: string } {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o644);
  } catch (err) {
    return errCode(err) === "EEXIST" ? { kind: "exists" } : { kind: "error", code: errCode(err) };
  }
  try {
    writeSync(fd, token);
  } catch (err) {
    // En låsfil uten token kan aldri frigis av oss: fjern den og meld at låsen ikke kunne lages.
    try {
      closeSync(fd);
      unlinkSync(lockPath);
    } catch {
      // ingenting mer å gjøre
    }
    return { kind: "error", code: errCode(err) };
  }
  closeSync(fd);
  return { kind: "created" };
}

export function acquireLock(lockPath: string, opts: LockOptions = {}): LockResult {
  const nowMs = opts.now_ms ?? Date.now();
  const staleMs = opts.stale_ms ?? STALE_LOCK_MS;
  const token = `${process.pid} ${nowMs} ${randomBytes(8).toString("hex")}\n`;
  const handle = (tookOver: boolean): LockResult => ({
    ok: true,
    took_over_stale: tookOver,
    release: () => {
      try {
        if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
      } catch {
        // låsen er allerede borte eller overtatt: ingenting å rydde
      }
    }
  });

  const first = tryCreate(lockPath, token);
  if (first.kind === "created") return handle(false);
  if (first.kind === "error") return { ok: false, reason: "unavailable", detail: `kunne ikke lage låsen (${first.code})` };

  // Låsen finnes. Er den foreldet (en avbrutt registrering), tas den over; ellers er en annen registrering i gang.
  let mtime: number;
  let seen: string;
  try {
    mtime = statSync(lockPath).mtimeMs;
    seen = readFileSync(lockPath, "utf8");
  } catch {
    // Den forsvant mellom forsøkene: prøv nøyaktig én gang til.
    const again = tryCreate(lockPath, token);
    return again.kind === "created" ? handle(false) : { ok: false, reason: "held", detail: "en annen registrering holder låsen" };
  }
  if (!isStale(mtime, nowMs, staleMs)) return { ok: false, reason: "held", detail: "en annen registrering holder låsen" };
  try {
    // Fjern kun hvis det fortsatt er DEN foreldede låsen (ikke en fersk en annen akkurat har laget).
    if (readFileSync(lockPath, "utf8") === seen) unlinkSync(lockPath);
  } catch {
    // borte allerede: fortsett til forsøket under
  }
  const second = tryCreate(lockPath, token);
  if (second.kind === "created") return handle(true);
  return { ok: false, reason: "held", detail: "en annen registrering tok over den foreldede låsen først" };
}

export type ReplaceResult = "written" | "changed_since_read" | "tmp_exists";

export interface ReplaceOptions {
  file: string;
  /** Midlertidig fil i SAMME katalog (samme filsystem, så rename er atomisk). */
  tmp: string;
  text: string;
  /** Kalles ETTER at den midlertidige filen er skrevet og RETT FØR rename: er filen fortsatt slik vi leste den? `false` = en annen har rørt den. */
  unchanged: () => boolean;
}

/**
 * Skriver `text` til `file` via en midlertidig fil og rename, men bare hvis `unchanged()` fortsatt er sann rett før rename. Den midlertidige filen lages med `wx`: en eksisterende (en annens halvferdige
 * skriving) overskrives aldri og ryddes aldri bort her (`tmp_exists`). Vår egen midlertidige fil ryddes alltid hvis rename ikke skjer.
 */
export function replaceFileAtomically(opts: ReplaceOptions): ReplaceResult {
  try {
    writeFileSync(opts.tmp, opts.text, { flag: "wx" });
  } catch (err) {
    if (errCode(err) === "EEXIST") return "tmp_exists";
    throw err;
  }
  let renamed = false;
  try {
    if (!opts.unchanged()) return "changed_since_read";
    renameSync(opts.tmp, opts.file);
    renamed = true;
    return "written";
  } finally {
    if (!renamed) {
      try {
        unlinkSync(opts.tmp);
      } catch {
        // allerede borte
      }
    }
  }
}
