import type { JsonValue } from "./capability.js";

/**
 * Deterministisk JSON-serialisering: objektnøkler sorteres rekursivt.
 * Brukes som signaturgrunnlag for godkjenningsobjekter, slik at samme
 * innhold alltid gir samme bytes uavhengig av nøkkelrekkefølge.
 */
export function canonicalStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k] as JsonValue)}`);
  return `{${entries.join(",")}}`;
}

/** Dyp likhet for JSON-verdier (parametersammenligning i godkjenninger). */
export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}
