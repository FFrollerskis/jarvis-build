import { mergeSecretSpans, scanForSecrets, scanSecretSpans, type SecretFinding, type SecretSpan } from "./secret-scan.ts";
import { classifyKey, isAuthCredential, isBenignSecretValue } from "./secret-scan-keys.ts";

/**
 * WP-SEC2 (JARVIS-013/069, K2b/K3): hemmelighetsskanning av STRUKTURERT data (JSON-lignende: objekter, lister, strenger, tall). Brukes der teksten ikke er én streng - audit-nyttelaster, ledger-tilstand, verktøysvar.
 *
 *  1. HVER streng skannes (med hele `scanForSecrets`), men søsken-strenger i samme objekt/liste skannes SAMMEN (limt med linjeskift): `["ghp_", "A1b2…"]` og `{ a: "ghp_", b: "A1b2…" }` fanges, mens to uavhengige ord
 *     på hver sin linje røres ikke. Et funn som krysser en delgrense redigerer det overlappede spennet i HVER del (`[REDACTED:<type>]` i hver) og telles én gang.
 *  2. NØKKELNAVN-bevisst (`secret-scan-keys.ts`): ligner nøkkelen en hemmelighet (`password`, `passord`, `api_key`, `client_secret`, `Authorization`, `cookie` ...) redigeres VERDIEN uansett format (strenger; tall kun under sterke
 *     nøkler som passord/PIN/privat nøkkel), med unntak for teller-/metadatanøkler (`token_count`, `passwords_checked`, `token_type`, `expires_at` ...). En hemmelig nøkkel gjør at ALLE strenger under den (rekursivt) redigeres,
 *     bortsett fra under metadatanøkler (`type`, `name`, `id` ...). Selve nøkkelnavnene skannes også (en nøkkel kan være en hemmelighet).
 *  3. FAIL-CLOSED og begrenset: dybde over `STRUCTURED_MAX_DEPTH`, over `STRUCTURED_MAX_NODES` noder, sykliske referanser og noder som KASTER ved lesing (kastende getter, Proxy-felle, tilbakekalt Proxy, kastende `toJSON`)
 *     erstattes av `[REDACTED:structure_limit]` (funnet rapporteres) - aldri stakkoverflyt, aldri en uendelig løkke, aldri en kastet feil ut av skanningen. Tekst/verdier uten funn returneres UENDRET (samme referanse: kallere må ikke mutere resultatet).
 *     En `Error` skannes som et vanlig objekt (enumerable egenskaper som `config.headers.Authorization` serialiseres av `JSON.stringify`); `message`/`stack` er ikke enumerable og er ikke en del av en serialisert nyttelast.
 */
export interface StructuredScanResult {
  value: unknown;
  findings: SecretFinding[];
}

export const STRUCTURED_MAX_DEPTH = 64;
export const STRUCTURED_MAX_NODES = 500_000;
/** Søsken limes sammen til ett tekst-skann bare under denne størrelsen (ellers skannes hver streng for seg). */
export const STRUCTURED_JOIN_MAX_CHARS = 1_048_576;

const NAMED = "[REDACTED:named_secret]";
/** Alt utenfor synlig ASCII (+ linjeskift/tabulator): kan skjule en BEGIN-linje (fullbredde, nullbredde). */
const NON_ASCII = /[^\x20-\x7e\n\t\r]/;
const LIMIT = "[REDACTED:structure_limit]";

interface State {
  nodes: number;
  counts: Map<string, number>;
  ancestors: Set<object>;
}

const bump = (state: State, kind: string, n = 1): void => {
  state.counts.set(kind, (state.counts.get(kind) ?? 0) + n);
};

const startsWithMarker = (text: string): boolean => text.startsWith("[REDACTED");

/** Skanner en gruppe søsken-strenger sammen (se 1. over). Returnerer nye tekster i samme rekkefølge. */
function scanSiblings(texts: readonly string[], state: State): string[] {
  if (texts.length === 0) return [];
  const only = texts[0] as string;
  if (texts.length === 1) {
    const r = scanForSecrets(only);
    for (const f of r.findings) bump(state, f.kind, f.count);
    return [r.text];
  }
  let total = texts.length - 1;
  for (const t of texts) total += t.length;
  if (total > STRUCTURED_JOIN_MAX_CHARS) {
    return texts.map((t) => {
      const r = scanForSecrets(t);
      for (const f of r.findings) bump(state, f.kind, f.count);
      return r.text;
    });
  }
  const offsets: number[] = [];
  let at = 0;
  for (const t of texts) {
    offsets.push(at);
    at += t.length + 1;
  }
  const spans: SecretSpan[] = scanSecretSpans(texts.join("\n"), { noUnterminatedKey: true });
  // En privat nøkkel uten avslutning i EN del gir ikke noe spenn i den limte teksten (den ville spist alle søsken): hver del med BEGIN skannes for seg.
  texts.forEach((t, i) => {
    // A-L3: også en SKJULT/fullbredde BEGIN (`BE<ZWSP>GIN`, `－－－ＢＥＧＩＮ`) - rå tekst kan ikke avgjøre det, så all ikke-ASCII-tekst skannes for seg.
    if (!t.includes("BEGIN") && !NON_ASCII.test(t)) return;
    for (const s of scanSecretSpans(t)) spans.push({ ...s, start: s.start + (offsets[i] as number), end: s.end + (offsets[i] as number) });
  });
  if (spans.length === 0) return [...texts];
  const merged = mergeSecretSpans(spans);
  const ranges: Array<Array<{ start: number; end: number; kind: string }>> = texts.map(() => []);
  let part = 0;
  for (const s of merged) {
    bump(state, s.kind);
    while (part > 0 && (offsets[part] as number) > s.start) part -= 1;
    for (let i = part; i < texts.length; i += 1) {
      const off = offsets[i] as number;
      const end = off + (texts[i] as string).length;
      if (off >= s.end) break;
      if (end <= s.start) {
        part = i;
        continue;
      }
      const from = Math.max(s.start, off) - off;
      const to = Math.min(s.end, end) - off;
      if (to > from) (ranges[i] as Array<{ start: number; end: number; kind: string }>).push({ start: from, end: to, kind: s.kind });
    }
  }
  return texts.map((t, i) => {
    const rs = ranges[i] as Array<{ start: number; end: number; kind: string }>;
    if (rs.length === 0) return t;
    let out = "";
    let last = 0;
    for (const r of rs) {
      out += `${t.slice(last, r.start)}[REDACTED:${r.kind}]`;
      last = r.end;
    }
    return out + t.slice(last);
  });
}

function walk(value: unknown, depth: number, secretCtx: boolean, state: State): unknown {
  state.nodes += 1;
  if (state.nodes > STRUCTURED_MAX_NODES) {
    bump(state, "structure_limit");
    return LIMIT;
  }
  if (typeof value === "string") {
    if (secretCtx && value.length > 0 && !startsWithMarker(value)) {
      bump(state, "named_secret");
      return NAMED;
    }
    return scanSiblings([value], state)[0] as string;
  }
  if (typeof value !== "object" || value === null) return value;
  try {
    if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    if (depth >= STRUCTURED_MAX_DEPTH || state.ancestors.has(value)) {
      bump(state, "structure_limit");
      return LIMIT;
    }
    state.ancestors.add(value);
    try {
      if (Array.isArray(value)) return walkArray(value, depth, secretCtx, state);
      const toJson = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJson === "function") return walk((toJson as () => unknown).call(value), depth + 1, secretCtx, state);
      if (value instanceof Map || value instanceof Set) return value;
      return walkObject(value as Record<string, unknown>, depth, secretCtx, state);
    } finally {
      state.ancestors.delete(value);
    }
  } catch {
    // Fail-closed (A-L4): en node som kaster ved lesing (getter, Proxy-felle, tilbakekalt Proxy, toJSON) kan ikke skannes og erstattes; resten av strukturen skannes videre.
    bump(state, "structure_limit");
    return LIMIT;
  }
}

function walkArray(arr: unknown[], depth: number, secretCtx: boolean, state: State): unknown {
  const out: unknown[] = new Array<unknown>(arr.length);
  const leaves: number[] = [];
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    if (typeof v === "string" && !(secretCtx && v.length > 0 && !startsWithMarker(v))) {
      out[i] = v;
      leaves.push(i);
    } else out[i] = walk(v, depth + 1, secretCtx, state);
  }
  const scanned = scanSiblings(leaves.map((i) => arr[i] as string), state);
  leaves.forEach((i, k) => {
    out[i] = scanned[k];
  });
  return out.every((v, i) => v === arr[i]) ? arr : out;
}

function walkObject(obj: Record<string, unknown>, depth: number, secretCtx: boolean, state: State): unknown {
  const keys = Object.keys(obj);
  const outKeys: string[] = [];
  const values: unknown[] = new Array<unknown>(keys.length);
  const leaves: number[] = [];
  for (let n = 0; n < keys.length; n += 1) {
    const key = keys[n] as string;
    const v = obj[key];
    const cls = classifyKey(key);
    // Verdier under en hemmelig nøkkel (eller under en hemmelig forelder, bortsett fra metadatanøkler) er hemmeligheter uansett format.
    const redactAll = (cls.secret || (secretCtx && !cls.metadata)) && !cls.safe;
    if (typeof v === "string") {
      // `authorization_header: "Basic …"` (A-L6): verdien er en hemmelighet bare når den er en credential med skjema; et headernavn (`X-Api-Key`) og en plassholder røres ikke.
      if (cls.authHeader && isAuthCredential(v)) {
        bump(state, "named_secret");
        values[n] = NAMED;
      } else if (redactAll && v.length > 0 && !startsWithMarker(v) && (secretCtx || cls.strong || v.length >= 6) && !isBenignSecretValue(v, cls)) {
        // (statusverdier og plassholdere som `required`/`YOUR_API_KEY` er ikke hemmeligheter, A-L9)
        bump(state, "named_secret");
        values[n] = NAMED;
      } else {
        values[n] = v;
        leaves.push(n);
      }
    } else if (typeof v === "number" || typeof v === "bigint") {
      if (cls.secret && cls.strong) {
        bump(state, "named_secret");
        values[n] = NAMED;
      } else values[n] = v;
    } else values[n] = walk(v, depth + 1, redactAll && (cls.secret || secretCtx), state);
    outKeys.push(key);
  }
  const scanned = scanSiblings(leaves.map((n) => values[n] as string), state);
  leaves.forEach((n, k) => {
    values[n] = scanned[k];
  });
  // Nøkkelnavn kan selv være hemmeligheter (en token som nøkkel i et objekt): skann dem, og unngå kollisjoner når to nøkler blir like.
  const seen = new Set<string>();
  const nextSuffix = new Map<string, number>(); // A-M2: neste ledige suffiks per grunnnavn (ellers kvadratisk når mange nøkler får samme redigerte navn)
  let changed = false;
  const finalKeys = outKeys.map((key) => {
    let k = key;
    if (key.length >= 7) {
      const r = scanForSecrets(key);
      if (r.text !== key) {
        for (const f of r.findings) bump(state, f.kind, f.count);
        k = r.text;
        changed = true;
      }
    }
    let unique = k;
    if (seen.has(unique)) {
      let i = nextSuffix.get(k) ?? 2;
      while (seen.has(`${k}~${i}`)) i += 1;
      unique = `${k}~${i}`;
      nextSuffix.set(k, i + 1);
    }
    if (unique !== key) changed = true;
    seen.add(unique);
    return unique;
  });
  if (!changed && values.every((v, n) => v === obj[keys[n] as string])) return obj;
  const out: Record<string, unknown> = {};
  finalKeys.forEach((key, n) => {
    Object.defineProperty(out, key, { value: values[n], enumerable: true, writable: true, configurable: true });
  });
  return out;
}

/**
 * Skanner `value` (rekursivt) og returnerer en kopi med hemmeligheter redigert, pluss funnene (kun typer og antall). Se filhodet for reglene. Aldri en kastet feil på uventede former (fail-closed erstatning i stedet).
 */
export function scanStructuredForSecrets(value: unknown): StructuredScanResult {
  const state: State = { nodes: 0, counts: new Map(), ancestors: new Set() };
  let out: unknown;
  try {
    out = walk(value, 0, false, state);
  } catch {
    // (kun for det uventede: `walk` fanger selv kastende noder) - fail-closed, aldri en kastet feil.
    out = LIMIT;
    bump(state, "structure_limit");
  }
  return { value: out, findings: [...state.counts.entries()].map(([kind, count]) => ({ kind, count })) };
}
