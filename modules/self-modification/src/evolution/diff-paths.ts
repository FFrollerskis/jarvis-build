import type { Constitution, EvChangeClass } from "../constitution.ts";

/**
 * WP-EV0 fix1 (A-F1): hvordan en FREMTIDIG Evolution-motor skal hente endrede stier fra git. Standard `git diff --name-only` har rename-deteksjon på og viser da kun det NYE navnet:
 * `git mv modules/policy modules/policy-x && ln -s policy-x modules/policy` gir listen [`modules/policy`, `modules/policy-x/src/...`] og skjuler at policy-kildene forsvant. Derfor:
 *
 *   git diff --no-renames --raw -z <base> <head>
 *
 * `--no-renames`: en omdøping er en sletting av kilden + en ny fil, så BEGGE stier er med. `--raw`: filmodusene (gammel/ny) er med. `-z`: NUL-skilte, usitert og ukodede stier (uten `-z` siterer
 * git en sti med uvanlige tegn som `"modules/caf\303\251.ts"`, som `protectionKey` avviser). Modusene `120000` (symlink) og `160000` (gitlink/submodul) er ALDRI vanlig innhold - de kan peke
 * en beskyttet sti til et ubeskyttet tre eller trekke inn ukontrollert kode - og regnes derfor som E3 uansett sti, på begge sider av endringen.
 *
 * Ren logikk (ingen I/O, kjører ikke git): parseren og klassifiseringen under er det en konsument bruker på utdataen. Alt som ikke kan tolkes entydig er E3 (fail-closed).
 */
export const SPECIAL_GIT_MODES: ReadonlySet<string> = new Set(["120000", "160000"]);

export interface RawDiffEntry {
  /** Git-statusbokstav (`A`, `M`, `D`, `T`, ...). `R`/`C` skal ikke forekomme med `--no-renames`, men håndteres med to stier. */
  status: string;
  old_mode: string;
  new_mode: string;
  paths: string[];
}

export interface RawDiffParse {
  entries: RawDiffEntry[];
  /** Alle stier som er berørt (alle sider av hver oppføring), uten duplikater, i rekkefølge. */
  paths: string[];
  /** Hver oppføring der gammel eller ny modus er symlink/gitlink: `<modus>:<sti>`. */
  special_modes: string[];
}

const HEADER = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{4,64} [0-9a-f]{4,64} ([ACDMRTUXB])(\d{0,3})$/;

/** Tolker utdata fra `git diff --no-renames --raw -z`. `null` = kan ikke tolkes (ikke-git-utdata, avkortet, ukjent form): kalleren MÅ da regne endringen som E3. Tom utdata gir en tom liste (ingen endring). */
export function parseRawDiffZ(raw: string): RawDiffParse | null {
  if (typeof raw !== "string") return null;
  const tokens = raw.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const entries: RawDiffEntry[] = [];
  const special: string[] = [];
  const seen = new Set<string>();
  const paths: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const header = HEADER.exec(tokens[i] ?? "");
    if (header === null) return null;
    const status = header[3] as string;
    const pathCount = status === "R" || status === "C" ? 2 : 1;
    const entryPaths = tokens.slice(i + 1, i + 1 + pathCount);
    if (entryPaths.length !== pathCount || entryPaths.some((p) => p === "" || p.startsWith(":"))) return null;
    const entry: RawDiffEntry = { status, old_mode: header[1] as string, new_mode: header[2] as string, paths: entryPaths };
    entries.push(entry);
    for (const p of entryPaths) {
      if (!seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
      for (const mode of [entry.old_mode, entry.new_mode]) if (SPECIAL_GIT_MODES.has(mode)) special.push(`${mode}:${p}`);
    }
    i += 1 + pathCount;
  }
  return { entries, paths, special_modes: special };
}

/**
 * Klassen for en rå git-diff: E3 når utdataen ikke kan tolkes, når ingenting er endret (tom diff er aldri «trygg»), eller når en symlink/gitlink er med (gammel eller ny modus); ellers klassen
 * konstitusjonen gir for ALLE berørte stier (kilde og mål av en omdøping inkludert).
 */
export function classifyRawDiff(constitution: Pick<Constitution, "classify">, raw: string): EvChangeClass {
  const parsed = parseRawDiffZ(raw);
  if (parsed === null || parsed.special_modes.length > 0) return "E3";
  return constitution.classify(parsed.paths);
}
