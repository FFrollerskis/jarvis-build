import type { ScheduleConfig } from "./config.mjs";

export declare const EXIT: {
  readonly OK: 0;
  readonly USAGE: 1;
  readonly BACKUP_FAILED: 2;
  readonly OVERDUE: 3;
  readonly VERIFY_FAILED: 4;
  readonly OFFSITE_FAILED: 5;
  readonly OFFSITE_NOT_CONFIGURED: 6;
};
export interface Decision {
  due: boolean;
  reason: string;
}
export interface TickResult {
  exitCode: number;
  outcome: string;
  actions: string[];
  failed: string[];
  decisions: Record<string, Decision>;
  newest_set: string | null;
  /** Hva retensjonen gjorde i dette tikket: `paused` = årsaken til at den lot være (`pipeline_stale`, `status_unusable`, `time_gap_hold`, `offsite_failing`, `verify_failing`), ellers antall slettede sett/tomme kataloger. */
  retention?: { paused: string | null; pruned: number; orphans_removed: number };
  duration_ms: number;
}
/** Avhengigheter til et tikk (opak her; bygges av `buildDefaultDeps`). */
export type TickDeps = Record<string, unknown>;
export interface CompleteSet {
  name: string;
  dir: string;
  createdAt: string;
  createdMs: number;
  sizeBytes: number;
}
export declare class ScheduleError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
export declare function retryDelayMs(failures: number, baseMs: number): number;
/** Komplette sett, eldste først. Med `nowMs` hoppes sett datert i fremtiden (klokkeavvik > 5 min) over. */
export declare function listCompleteSets(outDir: string, options?: { nowMs?: number }): CompleteSet[];
/** Tom liste = alle filene manifestet lister finnes (vanlig fil, ikke tom, riktig størrelse). */
export declare function setFileProblems(dir: string, manifest: unknown): string[];
/** Sett med manifest som likevel ikke er komplette (hule). */
export declare function findHollowSets(outDir: string): Array<{ name: string; problems: string[] }>;
/** Navn på komplette sett datert i fremtiden (klokkeavvik). */
export declare function findFutureSets(outDir: string, nowMs: number): string[];
/**
 * Settkataloger uten manifest.json (review runde 2, M3): `removable` = bare helt TOMME kataloger eldre enn terskelen (bevist `ENOENT` på manifestet, aldri et beskyttet navn), `withData` = har innhold og
 * slettes ikke (rapporteres), `unverified` = en annen fs-feil enn ENOENT hindret avgjørelsen (røres ikke).
 */
export declare function scanManifestlessSets(
  outDir: string,
  nowMs: number,
  options?: { maxAgeMs?: number; protect?: Array<string | null> }
): { removable: string[]; withData: Array<{ name: string; entries: number }>; unverified: Array<{ name: string; code: string }> };
/** Tomme foreldreløse settkataloger som kan ryddes (se `scanManifestlessSets`). */
export declare function findOrphanSets(outDir: string, nowMs: number, maxAgeMs?: number, protect?: Array<string | null>): string[];
/** `jarvis-backup-<UTC>` -> epoch-ms, eller null når navnet ikke er en ekte dato (også `99999999T999999Z`, måned 00, 30. februar). */
export declare function setNameMs(name: unknown): number | null;
/** Mønsteret for arbeidsmappene en off-site-henting lager i backup-mappen (`.verify-tmp-XXXXXX`). */
export declare const VERIFY_TMP_RE: RegExp;
/** Foreldede `.verify-tmp-*`-kataloger (rester etter en avbrutt henting): ekte kataloger eldre enn `maxAgeMs` (standard 12 t). */
export declare function findStaleTempDirs(outDir: string, nowMs: number, maxAgeMs?: number): string[];
export declare function buildDefaultDeps(config: ScheduleConfig, env?: NodeJS.ProcessEnv, overrides?: Record<string, unknown>): TickDeps;
export declare function runTick(config: ScheduleConfig, deps: TickDeps, env?: NodeJS.ProcessEnv): Promise<TickResult>;
