import type { PgRunner } from "./runner.mjs";

export declare const MANIFEST_VERSION: number;
export declare const DEFAULT_DATABASES: string[];
/** `system_identifier` fra pg_control som tekst (64-bit heltall, evt. negativt). */
export declare const SYSTEM_IDENTIFIER_RE: RegExp;
export interface BackupTableEntry {
  table: string;
  rows: number;
}
export interface BackupDatabaseEntry {
  database: string;
  file: string;
  sha256: string;
  size_bytes: number;
  server_version: string;
  tables: BackupTableEntry[];
}
export interface BackupManifest {
  manifest_version: number;
  created_at_utc: string;
  set: string;
  /** `system_identifier`: kildeklyngens pg_control-identifikator (valgfri: eldre sett har den ikke). Brukes til å nekte en scratch-server som er SAMME klynge. */
  source: { endpoint: string; mode: string; system_identifier?: string };
  recipient_fingerprint: string;
  globals: { file: string; sha256: string };
  databases: BackupDatabaseEntry[];
}
export declare function sha256File(path: string): Promise<string>;
export declare function runBackup(opts: {
  runner: PgRunner;
  databases?: string[];
  outDir: string;
  recipient: unknown;
  now?: Date;
  log?: (message: string) => void;
}): Promise<{ setDir: string; manifest: BackupManifest }>;
