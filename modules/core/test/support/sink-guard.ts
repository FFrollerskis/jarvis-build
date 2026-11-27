/**
 * WP-SEC2 fiks-runde 1 (review B, M4): felles hjelpere for strukturvaktene (`wpsec2-sink-guard.test.ts`, `wpsec2-fix1-raw-slice-guard.test.ts`): kommentarfjerning, funn av skrivinger (også dynamiske/siterte/skjemakvalifiserte)
 * og telling av skannebevis.
 */

/** Skanner-bevis på filnivå. `neutralizeUntrustedText`/`sanitizeDisplayText` er BEVISST ikke med (fiks-runde 1, M4): de fjerner styretegn og redigerer ikke hemmeligheter. */
export const GENERAL_EVIDENCE = /scanForSecrets|containsSecret|redactSecrets|redactVendorText|vendorText\(|scanStructuredForSecrets|sanitizeParameterValue|clipRedacted/;
const NOT_TABLES = new Set(["the", "a", "of", "set", "table", "from", "into", "values", "select", "where"]);
const UPDATE_SET_TAIL = /^\s+(?:AS\s+\w+\s+|\w+\s+)?SET\b/i;

/** Fjerner blokk- og linjekommentarer (best effort: `//` teller kun først på linjen eller etter blank/skilletegn, så `https://` i en streng ikke kutter resten av linjen). Et skannebevis i en kommentar er ikke et bevis. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[ \t;{}(),])\/\/[^\n]*/gm, "$1");
}

/** Én skriving: `INSERT INTO x`/`UPDATE x SET` med en vanlig tabell, eller en dynamisk/sitert/skjemakvalifisert (`${t}`, `"t"`, `s.t`) som vakten ikke kan klassifisere. */
const WRITE = /\b(INSERT\s+INTO|UPDATE)\s+(\$\{[^}\n]*\}|"[^"\n]+"(?:\."[^"\n]+")?|[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*|[a-z_][a-z0-9_]*)/gi;

export function writesIn(text: string): { tables: Map<string, number>; dynamic: number } {
  const code = stripComments(text);
  const tables = new Map<string, number>();
  let dynamic = 0;
  for (const m of code.matchAll(WRITE)) {
    const kind = (m[1] as string).toUpperCase();
    const target = m[2] as string;
    const tail = code.slice((m.index as number) + m[0].length, (m.index as number) + m[0].length + 60);
    if (kind === "UPDATE" && !UPDATE_SET_TAIL.test(tail)) continue;
    if (/^[a-z_][a-z0-9_]*$/i.test(target)) {
      const table = target.toLowerCase();
      if (NOT_TABLES.has(table)) continue;
      tables.set(table, (tables.get(table) ?? 0) + 1);
    } else dynamic += 1;
  }
  return { tables, dynamic };
}

export function evidenceCount(text: string, evidence: RegExp): number {
  return [...stripComments(text).matchAll(new RegExp(evidence.source, "g"))].length;
}
