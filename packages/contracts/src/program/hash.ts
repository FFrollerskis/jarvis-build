import { createHash } from "node:crypto";

/**
 * WP-PGA / PG1: hash og kanonisk serialisering. Kontraktfingeravtrykket er git-fritt og tidsfritt: samme bytes (etter LF-normalisering) gir alltid samme fingeravtrykk, på alle plattformer.
 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** CRLF og enslige CR blir LF, slik at en fil gir samme hash på Windows og Linux (samme regel som migrasjonssjekksummen). */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** JSON med sorterte objektnøkler (rekursivt) og bevart array-rekkefølge. Kaster for udefinert, ikke-endelige tall, funksjoner/symboler/bigint og sykler: en kanonisk form skal aldri gjette. */
export function canonicalJson(value: unknown): string {
  const stack = new Set<object>();
  const walk = (v: unknown): string => {
    if (v === null) return "null";
    switch (typeof v) {
      case "string":
        return JSON.stringify(v);
      case "boolean":
        return v ? "true" : "false";
      case "number":
        if (!Number.isFinite(v)) throw new Error("canonical_json_non_finite_number");
        return JSON.stringify(v);
      case "object": {
        if (stack.has(v)) throw new Error("canonical_json_cycle");
        stack.add(v);
        try {
          if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
          const obj = v as Record<string, unknown>;
          return `{${Object.keys(obj)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${walk(obj[k])}`)
            .join(",")}}`;
        } finally {
          stack.delete(v);
        }
      }
      default:
        throw new Error(`canonical_json_unsupported_type:${typeof v}`);
    }
  };
  return walk(value);
}

export interface FileHash {
  path: string;
  sha256: string;
}

/**
 * `sha256:<hex>` over de sorterte linjene `<sti>\t<sha256>\n`. Rekkefølgen filene oppgis i spiller ingen rolle; en sti og en hash kan ikke blandes (TAB skiller, og stier med TAB/linjeskift avvises);
 * duplikate stier avvises. En tom liste gir hashen av den tomme strengen (men komponenter uten kontraktfiler har `fingerprint: null`).
 */
export function contractFingerprint(files: readonly FileHash[]): string {
  const seen = new Set<string>();
  for (const f of files) {
    if (/[\t\r\n]/.test(f.path) || f.path === "") throw new Error("fingerprint_invalid_path");
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error("fingerprint_invalid_sha256");
    if (seen.has(f.path)) throw new Error("fingerprint_duplicate_path");
    seen.add(f.path);
  }
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path}\t${f.sha256}\n`);
  return `sha256:${sha256Hex(lines.join(""))}`;
}
