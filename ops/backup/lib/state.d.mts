export interface BackupStatusFile {
  schema: number;
  created_at: string | null;
  updated_at: string | null;
  last_tick_at: string | null;
  backup: { last_attempt_at: string | null; last_success_at: string | null; last_set: string | null; duration_s: number | null; size_bytes: number | null; consecutive_failures: number; retry_after: string | null; last_error_code: string | null; last_error: string | null };
  retention: { last_pruned_at: string | null; last_pruned_count: number; last_skipped_reason: string | null };
  offsite: { state: string; adapter: string | null; last_attempt_at: string | null; last_success_at: string | null; last_verified_at: string | null; last_set: string | null; verification: string | null; consecutive_failures: number; retry_after: string | null; last_error_code: string | null; last_error: string | null };
  restore_verify: { state: string; last_attempt_at: string | null; last_success_at: string | null; last_set: string | null; duration_s: number | null; fetch_duration_s: number | null; tables: number | null; rows: number | null; source: string | null; reported_by: string | null; consecutive_failures: number; retry_after: string | null; last_error_code: string | null; last_error: string | null };
  heartbeat: { configured: boolean; last_ping_at: string | null; last_ping_kind: string | null; last_ping_ok: boolean | null; last_error_code: string | null };
}
export declare const STATUS_SCHEMA: number;
export declare const STATUS_FILE: string;
export declare const EXPORT_FILE: string;
export declare const VERIFY_REPORT_FILE: string;
export declare const ERROR_CODES: readonly string[];
export declare function emptyStatus(): BackupStatusFile;
export declare function readStatusFile(file: string): { status: BackupStatusFile; problem: string | null; existed: boolean };
export declare function writeJsonAtomic(file: string, data: unknown, options?: { mode?: number; dirMode?: number }): void;
export declare function buildExport(status: BackupStatusFile, ctx: { now: Date; intervalMs: number; verifyIntervalMs: number; newest: { name: string; createdAt: string; sizeBytes: number } | null; setsOnDisk: number }): Record<string, unknown>;
