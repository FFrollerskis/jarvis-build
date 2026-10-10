export declare const GLOBALS_MAX_BYTES: number;
/** Tak per setning (tegn); en lengre setning nektes med `kind: "statement_too_long"`. */
export declare const GLOBALS_MAX_STATEMENT_CHARS: number;
/** Parametere `ALTER ROLE … SET` får sette på scratch-serveren; alt annet nektes. */
export declare const ROLE_SET_ALLOWLIST: ReadonlySet<string>;
export declare class GlobalsRejectedError extends Error {
  readonly code: "globals_rejected";
  readonly reason: string;
  readonly line: number | null;
  /** Stabil, maskinlesbar årsak: `rejected` (generell), `statement_too_long`, `too_many_statements`, `too_large`, `reserved_role_name`, `role_setting_not_allowed`, `login_role_invalid`. */
  readonly kind: string;
  constructor(reason: string, line?: number | null, kind?: string);
}
export interface SanitizeGlobalsOptions {
  /** Rollen verifisereren selv logger inn som på scratch-serveren (standard `postgres`). Setninger som angår DEN rollen slippes aldri gjennom. */
  loginRole?: string;
}
/** Whitelist-filter for den UBETRODDE globals.sql: kaster `GlobalsRejectedError` ved alt utenfor de kjente rolle-setningene; ellers returneres gjenoppbygd, trygg SQL. */
export declare function sanitizeGlobals(text: string, options?: SanitizeGlobalsOptions): { sql: string; statements: number; passwordsStripped: number; skippedLoginRole: number };
