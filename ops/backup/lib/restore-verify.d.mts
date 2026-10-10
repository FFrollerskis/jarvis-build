import type { BackupManifest } from "./backup.mjs";
import type { PgRunner } from "./runner.mjs";

export declare const SCRATCH_DB_PREFIX: string;
export declare const SCRATCH_ALLOWED_DB: RegExp;
/** Tom liste = manifestet har forventet form (settet er ubetrodd; tabell-/databasenavn limes inn i SQL). */
export declare function manifestProblems(manifest: unknown): string[];
/**
 * Beviser at scratch-serveren er en tom, kastbar instans FØR noe skrives dit (kun lesing). Har manifestet `source.system_identifier`, nektes også en scratch med SAMME identifikator
 * (`systemIdentifier: "checked"`); uten (eldre sett) er svaret `"absent"` og kun tom-sjekken gjelder.
 */
export declare function checkScratchServer(
  scratchRunner: PgRunner,
  manifest: { databases: Array<{ database: string }>; source?: { system_identifier?: string } }
): Promise<{ ok: true; systemIdentifier: "checked" | "absent" } | { ok: false; error: string }>;
export interface RestoreVerifyDatabaseReport {
  database: string;
  ok: boolean;
  tables_expected: number;
  tables_restored: number;
  total_rows_expected: number;
  missing_tables: string[];
  extra_tables: string[];
  row_count_mismatches: Array<{ table: string; expected: number; restored: number }>;
}
export interface RestoreVerifyReport {
  ok: boolean;
  stage: "manifest" | "integrity" | "scratch_guard" | "globals" | "restore" | "complete";
  set?: string;
  source_endpoint?: string;
  scratch_endpoint?: string;
  error?: string;
  /** Antall setninger fra globals.sql som ble kjørt, antall passord-hasher som ble FJERNET (roller restores uten passord), og antall setninger om verifisererens egen innloggingsrolle som ble hoppet over. */
  globals?: { statements: number; passwords_stripped: number; login_role_statements_skipped: number };
  integrity: Array<{ file: string; ok: boolean }>;
  databases: RestoreVerifyDatabaseReport[];
}
export declare function runRestoreVerify(opts: {
  setDir: string;
  identityFile: string;
  scratchRunner: PgRunner;
  allowSameServer?: boolean;
  keepScratch?: boolean;
  now?: Date;
  log?: (message: string) => void;
}): Promise<RestoreVerifyReport>;
export declare function listBackupSets(outDir: string): Array<{ name: string; dir: string; manifest: BackupManifest }>;
export declare function backupAgeHours(outDir: string, now?: Date): number | undefined;
export declare function pruneBackupSets(outDir: string, retainDays: number, now: Date, remove: (dir: string) => void): string[];
