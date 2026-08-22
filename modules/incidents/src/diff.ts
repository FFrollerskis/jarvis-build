import type { JsonValue } from "@jarvis/contracts";

export interface StateDiff {
  added: Record<string, JsonValue>;
  removed: Record<string, JsonValue>;
  changed: Record<string, { before: JsonValue; after: JsonValue }>;
}

function isPlainObject(value: JsonValue | null | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * D-105 (UA-5 kriterium 3, §I): deterministisk, GRUNN nøkkel-for-nøkkel-diff
 * - ALDRI LLM-sammenligning. Returnerer `null` (ikke et tomt/fabrikkert
 * diff-objekt) når enten `before`/`after` ikke er sammenlignbare
 * JSON-objekter (f.eks. `null` fordi tilstanden aldri ble fanget) - kalleren
 * skal da registrere et EKSPLISITT UNKNOWN/PARTIAL-utfall i stedet for å
 * late som en diff fant sted (byggeordrens §I: "If provider state cannot be
 * compared reliably: record outcome UNKNOWN/PARTIAL rather than inventing a
 * diff"). Grunn (ikke rekursiv) er en bevisst forenkling - alle produserte
 * tilstands-snapshots i denne sliceen (`docker.inspect_container`) er flate
 * objekter, ingen nestede strukturer å sammenligne dypt.
 */
export function computeStateDiff(before: JsonValue | null | undefined, after: JsonValue | null | undefined): StateDiff | null {
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return null;
  }
  const added: Record<string, JsonValue> = {};
  const removed: Record<string, JsonValue> = {};
  const changed: Record<string, { before: JsonValue; after: JsonValue }> = {};
  for (const key of Object.keys(after)) {
    if (!(key in before)) {
      added[key] = after[key]!;
    } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed[key] = { before: before[key]!, after: after[key]! };
    }
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      removed[key] = before[key]!;
    }
  }
  return { added, removed, changed };
}
