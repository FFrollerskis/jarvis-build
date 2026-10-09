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
export declare function buildDefaultDeps(config: ScheduleConfig, env?: NodeJS.ProcessEnv, overrides?: Record<string, unknown>): TickDeps;
export declare function runTick(config: ScheduleConfig, deps: TickDeps, env?: NodeJS.ProcessEnv): Promise<TickResult>;
