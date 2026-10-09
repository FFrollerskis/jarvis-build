export declare const SET_NAME_RE: RegExp;
export declare const AGE_MAGIC: Buffer;
export declare const MANIFEST_AGE: string;
export declare const LOCAL_MARKER: string;
export declare class OffsiteError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
