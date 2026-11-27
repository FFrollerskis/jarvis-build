import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/sink-guard.ts";

/**
 * WP-SEC2 fiks-runde 1 (review B, M3): STATISK VAKT mot «kutt FØR skann» i `modules/{tool-gateway,finance}/src`. En feiltekst fra en leverandør/transport/DB som kuttes med `.slice(0, n)` før den skannes kan la et halvt token stå igjen
 * (under skannerens minstelengde), så alle slike steder skal bruke `clipRedacted(tekst, n)` (skann først, kutt etterpå) eller `redactForLog`. Reviewerens mutanter (`clipRedacted(x, 80)` -> `x.slice(0, 80)`) overlevde fordi bare vaktens
 * tekst-regex så dem; nå felles vakten dem OG atferdstestene (`wpsec2-fix1-*-sinks.test.ts`) dem. Mønstrene: `.message.slice(`, `raw.slice(`, `rawBody.slice(` (reviewerens) og `reason.slice(`, `String(err)).slice(` (GW8/GW9/F1-mutantene).
 * Unntak står i `ALLOWED` med begrunnelse; en ny forekomst feller testen. Kjent, DEFERRED utenfor denne vakten (kutt på transportnivå før gatewayens skann): `stderr.slice(0, 160)` i docker-transport og `(x.message ?? "").slice(` i gce/live-transports.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATTERN = /\.message\.slice\(|\braw\.slice\(|\brawBody\.slice\(|\breason\.slice\(|String\(err\)\)\.slice\(/g;

/** (fil, utdrag som må inneholde forekomsten) -> begrunnelse. Kun forekomster som IKKE er tekst fra en leverandør/feil. */
const ALLOWED: ReadonlyArray<{ file: string; contains: string; why: string }> = [
  { file: "modules/tool-gateway/src/github-app-auth.ts", contains: "raw.slice(0, MAX_REPOSITORIES + 1)", why: "`raw` er en liste med repositorier (array-slice for å begrense antall), ikke tekst" },
  { file: "modules/tool-gateway/src/personal/apple-dav.ts", contains: "raw.slice(1)", why: "iCalendar-linjefolding: fjerner ett ledende blankt tegn fra en fortsettelseslinje, ikke en kutt av feiltekst" }
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
}

/** Alle forekomster (fil -> linjer) av mønstrene i produktkode (kommentarer fjernet). */
export function rawSliceHits(text: string): string[] {
  const hits: string[] = [];
  for (const line of stripComments(text).split("\n")) if (new RegExp(PATTERN.source).test(line)) hits.push(line.trim());
  return hits;
}

describe("K7f: ingen rå `.slice(` av feiltekst i tool-gateway og finance (skann først, kutt etterpå)", () => {
  it("hver forekomst er en eksplisitt, begrunnet unntaksrad - en ny `x.message.slice(0, n)` feller testen", () => {
    const files: string[] = [];
    for (const mod of ["tool-gateway", "finance"]) walk(join(ROOT, "modules", mod, "src"), files);
    const unexpected: string[] = [];
    const used = new Set<number>();
    for (const file of files) {
      const rel = relative(ROOT, file);
      for (const hit of rawSliceHits(readFileSync(file, "utf8"))) {
        const allowed = ALLOWED.findIndex((a) => a.file === rel && hit.includes(a.contains));
        if (allowed >= 0) used.add(allowed);
        else unexpected.push(`${rel}: ${hit.slice(0, 160)}`);
      }
    }
    expect(unexpected, "kutt-før-skann: bruk clipRedacted(tekst, n) (eller redactForLog) i stedet for tekst.slice(0, n):\n" + unexpected.join("\n")).toEqual([]);
    // et unntak som ikke lenger finnes skal fjernes (listen skal ikke råtne)
    expect([...used].length, "ubrukt unntaksrad i ALLOWED - fjern den").toBe(ALLOWED.length);
  });

  it("vakten selv fanger reviewerens mutanter (GW1-GW12/F1-F9-formene) og lar lovlige former stå", () => {
    for (const mutant of [
      "const m = (err as Error).message.slice(0, 80);", "const r = failure.message.slice(0, 120);", "reason.slice(0, 200)", "const t = raw.slice(0, 60);", "const t = rawBody.slice(0, 200).trim();",
      "(err instanceof Error ? err.message : String(err)).slice(0, 80)", "parsed.error.message.slice(0, 200)", "const x = String(err)).slice(0, 5)"
    ]) expect(rawSliceHits(mutant), mutant).toHaveLength(1);
    for (const fine of ["const m = clipRedacted((err as Error).message, 80);", "// (err as Error).message.slice(0, 80) står i en kommentar", "const first = items.slice(0, 10);", "const id = token.slice(0, 8);"]) expect(rawSliceHits(fine), fine).toHaveLength(0);
  });
});
