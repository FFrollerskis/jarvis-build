// WP-PGA / PG1+PG3 (D-PROG-01..09): kommandolinje for programindeksen. Kjøres fra repo-roten:
//   node --experimental-transform-types packages/contracts/scripts/program-index.ts <kommando> [valg]
//
//   report [--json] [--max <n>]            Kjør skanningen og skriv rapporten. Exit 1 ved rød dom (modus: manifest + PROGRAM_INDEX_MODE).
//   index                                  Skriv den sammenslåtte, kanoniske indeksen (JSON) til stdout.
//   fingerprint [<id>...] [--write] [--bump patch|minor|major]
//                                          Vis (eller med --write: oppdater) kontraktfingeravtrykk og changed_at i komponentskjervene.
//   gate <G01..G17|ORL0..ORL5> <PASS|FAIL|OPEN> --reason <tekst> --by <owner|platform_operator> [--evidence docs/evidence/<fil>.md] [--verified-at <ISO>] [--write]
//                                          Registrer en porteovergang (OperationalGateChanged). Uten --write er det en tørrkjøring.
//                                          Bruk ops/acceptance/record-gate-evidence.mjs: den screener --reason for hemmelighetsformer (denne kommandoen gjør det ikke).
//   Felles: --root <mappe> (standard: repo-roten).
//
// Exit: 0 = ok, 1 = rød dom eller registrering/oppdatering nektet, 2 = bruksfeil. Ren lesing med unntak av `fingerprint --write` og `gate --write` (én fil per endring, atomisk).
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordGate } from "../src/program/gate-recorder.ts";
import { refreshFingerprints, type BumpKind } from "../src/program/fingerprint-tool.ts";
import { ProgramDataError } from "../src/program/fs-loader.ts";
import { formatReport, runProgramIndex } from "../src/program/run.ts";
import { GUARD_MODE_ENV, GuardModeError } from "../src/program/mode.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..", "..");

class UsageError extends Error {}

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["--root", "--max", "--bump", "--reason", "--by", "--evidence", "--verified-at"]);
const BOOL_FLAGS = new Set(["--json", "--write"]);

function parse(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      if (BOOL_FLAGS.has(a)) flags.set(a, true);
      else if (VALUE_FLAGS.has(a)) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} krever en verdi`);
        if (flags.has(a)) throw new UsageError(`${a} er oppgitt to ganger`);
        flags.set(a, v);
        i += 1;
      } else throw new UsageError(`ukjent valg ${a}`);
    } else positional.push(a);
  }
  return { positional, flags };
}

const flag = (p: Parsed, name: string): string | undefined => {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

const USAGE = [
  "bruk: node --experimental-transform-types packages/contracts/scripts/program-index.ts <kommando>",
  "  report [--json] [--max <n>]",
  "  index",
  "  fingerprint [<id>...] [--write] [--bump patch|minor|major]",
  "  gate <G01..G17|ORL0..ORL5> <PASS|FAIL|OPEN> --reason <tekst> --by <owner|platform_operator> [--evidence docs/evidence/<fil>.md] [--verified-at <ISO>] [--write]",
  "  felles: --root <mappe>"
].join("\n");

/** HEAD for repoet i `root` selv (ikke et overordnet git-repo som mappen tilfeldigvis ligger i): ellers ville evidensen få en fremmed SHA. */
function gitHead(root: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim().split("\n");
    if (out.length !== 2 || realpathSync(out[0] as string) !== realpathSync(root)) return null;
    return /^[0-9a-f]{40}$/.test(out[1] as string) ? (out[1] as string) : null;
  } catch {
    return null;
  }
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv, out: (line: string) => void, err: (line: string) => void): number {
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const [command, ...rest] = parsed.positional;
  const root = resolve(flag(parsed, "--root") ?? DEFAULT_ROOT);
  const write = parsed.flags.get("--write") === true;
  try {
    switch (command) {
      case "report": {
        if (rest.length > 0) throw new UsageError("report tar ingen argumenter");
        const run = runProgramIndex({ root, env: env[GUARD_MODE_ENV] });
        const max = Number(flag(parsed, "--max") ?? "60");
        if (!Number.isInteger(max) || max < 0 || max > 10_000) throw new UsageError("--max må være et heltall 0-10000");
        if (parsed.flags.get("--json") === true) {
          out(JSON.stringify({ mode: run.mode, digest: run.index.digest, counts: run.counts, findings: run.findings, baseline: run.baseline, verdict: run.verdict }, null, 2));
        } else out(formatReport(run, max));
        return run.verdict.ok ? 0 : 1;
      }
      case "index": {
        if (rest.length > 0) throw new UsageError("index tar ingen argumenter");
        out(JSON.stringify(runProgramIndex({ root, env: env[GUARD_MODE_ENV] }).index, null, 2));
        return 0;
      }
      case "fingerprint": {
        const bump = flag(parsed, "--bump");
        if (bump !== undefined && bump !== "patch" && bump !== "minor" && bump !== "major") throw new UsageError("--bump må være patch, minor eller major");
        if (bump !== undefined && !write) throw new UsageError("--bump krever --write");
        const changes = refreshFingerprints(root, { ids: rest, write, ...(bump !== undefined ? { bump: bump as BumpKind } : {}), now: new Date().toISOString() });
        let problems = 0;
        for (const c of changes) {
          if (c.problem !== null) problems += 1;
          out(`${c.component_id}: ${c.changed ? (c.written ? "oppdatert" : "AVVIK (kjør med --write)") : "à jour"}${c.version_before !== c.version_after ? ` (versjon ${c.version_before} -> ${c.version_after})` : ""}${c.problem !== null ? ` [${c.problem}]` : ""}`);
        }
        const drift = changes.filter((c) => c.changed && !c.written).length;
        out(`${changes.length} komponenter sjekket, ${changes.filter((c) => c.changed).length} med endring, ${changes.filter((c) => c.written).length} skrevet`);
        return problems > 0 || (!write && drift > 0) ? 1 : 0;
      }
      case "gate": {
        const [gateId, status, ...extra] = rest;
        if (gateId === undefined || status === undefined || extra.length > 0) throw new UsageError("gate krever <port> <status>");
        if (status !== "PASS" && status !== "FAIL" && status !== "OPEN") throw new UsageError("status må være PASS, FAIL eller OPEN");
        const reason = flag(parsed, "--reason");
        const by = flag(parsed, "--by");
        if (reason === undefined) throw new UsageError("--reason er påkrevd");
        if (by !== "owner" && by !== "platform_operator") throw new UsageError("--by må være owner eller platform_operator (en rolle, aldri et navn)");
        const result = recordGate({
          root,
          gate_id: gateId,
          status,
          evidence_path: flag(parsed, "--evidence") ?? null,
          reason,
          by,
          now: new Date().toISOString(),
          verified_at: flag(parsed, "--verified-at") ?? null,
          git_sha: gitHead(root),
          write
        });
        if (!result.ok) {
          err(`NEKTET (${result.problem}): ${result.detail}`);
          return 1;
        }
        for (const w of result.warnings) err(`ADVARSEL: ${w}`);
        out(`${result.gate_id}: ${result.prior_status} -> ${result.new_status}${result.evidence_ref !== null ? ` (evidens ${result.evidence_ref.path}, sha256 ${result.evidence_ref.sha256.slice(0, 12)}, git ${result.evidence_ref.git_sha.slice(0, 10)}, verified_at ${result.evidence_ref.verified_at} [${result.evidence_ref.verified_at_source}])` : ""}`);
        out(result.written ? "skrevet" : "tørrkjøring: ingenting er skrevet (bruk --write)");
        return 0;
      }
      default:
        throw new UsageError(command === undefined ? "mangler kommando" : `ukjent kommando ${command}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof ProgramDataError) {
      err(`DATAFEIL (${e.code}): ${e.detail}`);
      return 1;
    }
    if (e instanceof GuardModeError) {
      err(`NEKTET: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

// Kjør kun som skript, aldri ved import (testene importerer `main`).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env, (l) => process.stdout.write(`${l}\n`), (l) => process.stderr.write(`${l}\n`));
}
