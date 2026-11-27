import { normalizeLineEndings } from "./hash.ts";

/**
 * WP-PGA fiks 1 (M2): lesing av TOPPTEKSTEN i en evidensfil (den faste delen `ops/acceptance/record-evidence.mjs` skriver før «## Utdata») og vurderingen av hvor sterk evidensen er. Ren modul (ingen
 * filsystem): kalleren gir teksten. Evidensfilen er UBETRODD tekst: kun toppsonen (til «## Utdata», høyst 30 linjer) leses for verdier; utdataene under hashes, men tolkes aldri.
 *
 * ÆRLIGHET: dette er en vakt mot SLURV (evidens fra en kommando som feilet, innlimt tekst, uren arbeidstre, hjemmelaget fil), ikke mot en som forfalsker en hel evidensfil. En håndskrevet fil kan påstå
 * hva som helst; sterk evidens betyr bare «fila ser ut som et ekte, vellykket opptak fra `record-evidence.mjs`».
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const TIME_LINE = /^- \*\*Tidspunkt \(UTC\):\*\* (\S+)\s*$/;
const GIT_LINE = /^- \*\*Git:\*\* `([0-9a-f]{40})`(.*)$/;
const EXIT_LINE = /^- \*\*Exit:\*\* (.*)$/;
const COMMAND_LINE = /^- \*\*Kommando:\*\* (.*)$/;
const NOTE_LINE = /^- \*\*Merknad:\*\* (.*)$/;
/** Markør i `--note` til opptakeren («ekstern-kilde: NAS-kjøring ...» eller «eier-bekreftet: ...»): evidensen kommer fra en ekstern kilde eller er bekreftet av eieren. 3-200 tegn. */
const EXTERNAL_NOTE = /^(?:ekstern-kilde|eier-bekreftet):[ \t]+(\S.{2,199})$/;
const MAX_HEADER_LINES = 30;

export interface EvidenceHeader {
  recorded_time: string | null;
  git_sha: string | null;
  /** Evidensen er tatt på et arbeidstre med ucommittede endringer (svakere bevis). */
  dirty: boolean;
}

/** Toppsonen: linjene før første «## Utdata» (høyst 30; uten «## Utdata» de første 30). */
function headerLines(text: string): string[] {
  const lines = normalizeLineEndings(text).split("\n");
  const end = lines.findIndex((l) => l.startsWith("## Utdata"));
  return lines.slice(0, Math.min(end === -1 ? MAX_HEADER_LINES : end, MAX_HEADER_LINES));
}

/** Leser KUN den faste toppteksten: utdataene under er ubetrodd og leses aldri for verdier. Første treff vinner. */
export function parseEvidenceHeader(text: string): EvidenceHeader {
  let recorded: string | null = null;
  let sha: string | null = null;
  let dirty = false;
  for (const line of headerLines(text)) {
    const t = TIME_LINE.exec(line);
    if (t !== null && recorded === null && ISO_INSTANT.test(t[1] as string) && Number.isFinite(Date.parse(t[1] as string))) recorded = new Date(Date.parse(t[1] as string)).toISOString();
    const g = GIT_LINE.exec(line);
    if (g !== null && sha === null) {
      sha = g[1] as string;
      dirty = /ucommittede endringer|git-status ukjent/.test(g[2] as string);
    }
  }
  return { recorded_time: recorded, git_sha: sha, dirty };
}

/**
 * Hva `Exit:`-linjen sier:
 *  - `code`: et rent tall (`0`, `1` ...);
 *  - `abnormal`: et tall MED tidsavbrudd/signal (kommandoen ble drept);
 *  - `stdin`: «ukjent (... --stdin ...)»: opptakeren kjørte ingenting og kjenner ikke exit-koden;
 *  - `missing`: ingen Exit-linje i toppsonen;
 *  - `unrecognized`: flere Exit-linjer (tvetydig) eller en form vi ikke kjenner.
 */
export type ExitKind = "code" | "abnormal" | "stdin" | "missing" | "unrecognized";

export interface EvidenceDetails {
  exit_kind: ExitKind;
  /** Koden når den står som tall (`code`/`abnormal`), ellers null. */
  exit_code: number | null;
  /** Utdata pipet inn (`--stdin`) i stedet for en kommando opptakeren selv kjørte. */
  from_stdin: boolean;
  /** Teksten etter markøren `ekstern-kilde:`/`eier-bekreftet:` i Merknad-linjen, ellers null. */
  external_source: string | null;
}

export function parseEvidenceDetails(text: string): EvidenceDetails {
  const lines = headerLines(text);
  const exits = lines.filter((l) => EXIT_LINE.test(l));
  let kind: ExitKind;
  let code: number | null = null;
  if (exits.length === 0) kind = "missing";
  else if (exits.length > 1) kind = "unrecognized";
  else {
    const value = (EXIT_LINE.exec(exits[0] as string)?.[1] ?? "").trim();
    const plain = /^(\d{1,3})$/.exec(value);
    const killed = /^(\d{1,3}) \((?:tidsavbrudd|signal)\b[^)]*\)$/.exec(value);
    if (plain !== null) {
      kind = "code";
      code = Number(plain[1]);
    } else if (killed !== null) {
      kind = "abnormal";
      code = Number(killed[1]);
    } else if (/^ukjent \(.*--stdin.*\)$/.test(value)) kind = "stdin";
    else kind = "unrecognized";
  }
  const command = lines.map((l) => COMMAND_LINE.exec(l)).find((m) => m !== null);
  const fromStdin = kind === "stdin" || (command !== undefined && command !== null && (command[1] as string).trim() === "(lest fra stdin)");
  const note = lines.map((l) => NOTE_LINE.exec(l)).find((m) => m !== null);
  const external = note === undefined || note === null ? null : EXTERNAL_NOTE.exec((note[1] as string).trim());
  return { exit_kind: kind, exit_code: code, from_stdin: fromStdin, external_source: external === null ? null : (external[1] as string) };
}

export type EvidenceFacts = EvidenceHeader & EvidenceDetails;

export function parseEvidenceFacts(text: string): EvidenceFacts {
  return { ...parseEvidenceHeader(text), ...parseEvidenceDetails(text) };
}

export const EVIDENCE_WEAKNESSES = [
  "evidence_unreadable",
  "header_time_missing",
  "verified_at_after_header",
  "git_sha_missing",
  "dirty_tree",
  "from_stdin",
  "exit_not_zero",
  "exit_unknown",
  "external_marker_missing"
] as const;
export type EvidenceWeakness = (typeof EVIDENCE_WEAKNESSES)[number];

/** Kort, lesbar forklaring per svakhet (brukes i funnmeldingen og i advarslene ved registrering). */
export const WEAKNESS_TEXT: Readonly<Record<EvidenceWeakness, string>> = Object.freeze({
  evidence_unreadable: "evidensfilen kunne ikke leses",
  header_time_missing: "ingen tidsangivelse i toppteksten (verified_at er ikke støttet av filen)",
  verified_at_after_header: "verified_at er senere enn tidspunktet i toppteksten",
  git_sha_missing: "ingen git-SHA i toppteksten",
  dirty_tree: "tatt på et arbeidstre med ucommittede endringer eller ukjent git-status",
  from_stdin: "innlimt utdata (--stdin): opptakeren kjørte ingenting",
  exit_not_zero: "kommandoen lyktes ikke (exit er ikke 0, eller den ble drept)",
  exit_unknown: "ingen gjenkjennelig exit-linje: lyktes kommandoen?",
  external_marker_missing: "porten krever en ekstern kilde, men evidensen har ingen markør (--note «ekstern-kilde: ...» eller «eier-bekreftet: ...»)"
});

export interface WeaknessContext {
  /** Porten/nivået er `external: true` (krever NAS-kjøring, pilot eller eier-signoff). */
  external: boolean;
  /** `verified_at` slik den står i evidensreferansen. */
  verified_at: string;
}

/** Svakhetene ved en evidensfil for en PASS. Tom liste = sterk evidens. Rekkefølgen er fast. */
export function evidenceWeaknesses(f: EvidenceFacts, ctx: WeaknessContext): EvidenceWeakness[] {
  const out: EvidenceWeakness[] = [];
  if (f.recorded_time === null) out.push("header_time_missing");
  else if (Date.parse(ctx.verified_at) > Date.parse(f.recorded_time)) out.push("verified_at_after_header");
  if (f.git_sha === null) out.push("git_sha_missing");
  if (f.dirty) out.push("dirty_tree");
  if (f.from_stdin) out.push("from_stdin");
  else if (f.exit_kind === "abnormal" || (f.exit_kind === "code" && f.exit_code !== 0)) out.push("exit_not_zero");
  else if (f.exit_kind === "missing" || f.exit_kind === "unrecognized") out.push("exit_unknown");
  if (ctx.external && f.external_source === null) out.push("external_marker_missing");
  return out;
}
