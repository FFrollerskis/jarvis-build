export declare const SET_NAME_RE: RegExp;
export declare const AGE_MAGIC: Buffer;
export declare const MANIFEST_AGE: string;
export declare const LOCAL_MARKER: string;
/** Mønsteret for den lokale adapterens egne halvferdige kopier (`.incoming-<sett>-<8 hex>`). */
export declare const INCOMING_RE: RegExp;
export declare const STALE_INCOMING_MIN_MS: number;
/** Kopierer én fil fra et åpnet håndtak uten å følge symlenker; avviser alt som ikke stemmer med `expect` (forhåndssjekken) og fjerner da kopien. */
export declare function copyRegularNoFollow(src: string, dest: string, expect?: { size?: number; sha256?: string; ageHeader?: boolean }): Promise<void>;
export declare class OffsiteError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
