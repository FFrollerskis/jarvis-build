export declare const GLOBALS_MAX_BYTES: number;
export declare class GlobalsRejectedError extends Error {
  readonly code: "globals_rejected";
  readonly reason: string;
  readonly line: number | null;
  constructor(reason: string, line?: number | null);
}
/** Whitelist-filter for den UBETRODDE globals.sql: kaster `GlobalsRejectedError` ved alt utenfor de kjente rolle-setningene; ellers returneres gjenoppbygd, trygg SQL. */
export declare function sanitizeGlobals(text: string): { sql: string; statements: number; passwordsStripped: number };
