#!/usr/bin/env node
// WP-J (D-450): evidens-opptaker for verifiseringsøkten. Kjører ÉN kommando (uten skall), fjerner kjente hemmelighetsformer fra utdataene og skriver en
// evidensfil som lukkingsmatrisen kan lenke til (`docs/evidence/<dato>-<id>.md`). En rad i `docs/CLOSURE_MATRIX_HF1_HF2.md` kan først stå som `VERIFIED`
// når den lenker til en slik fil (vakt: modules/core/test/wpj-closure-matrix.test.ts).
//
//   node ops/acceptance/record-evidence.mjs <id> [--note "tekst"] [--out-dir <mappe>] [--timeout-s 600] -- <kommando> [argumenter...]
//   <kommando> | node ops/acceptance/record-evidence.mjs <id> --stdin [--note "tekst"]
//
// Ærlighet: opptakeren beviser KUN hva kommandoen skrev akkurat da, på denne vertens kode (git-SHA står i filen). Den vurderer ikke om utfallet er riktig – det
// gjør du og jeg sammen, og vurderingen føres i filen («Vurdering»). Redaksjonen er en siste sikring, ikke en lisens til å skrive hemmeligheter: se utdataene før
// filen committes (gitleaks kjører også i CI). Exit: 0 = kommandoen ga 0 og filen er skrevet, 1 = kommandoen feilet (filen skrives likevel – feilen ER evidens),
// 2 = bruksfeil, 3 = kunne ikke skrive filen.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const MAX_OUTPUT_BYTES = 200_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,60}$/;

/** Kjente hemmelighetsformer. Rekkefølgen betyr noe (lange/spesifikke først). Hvert mønster er lineært (ingen nøstede kvantorer). */
export const REDACTIONS = [
  ["pem_block", /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g],
  ["age_secret", /AGE-SECRET-KEY-1[0-9A-Z]{20,100}/g],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,255}\b/g],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,200}\b/g],
  ["openai_key", /\bsk-[A-Za-z0-9_-]{32,200}\b/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,200}\b/g],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g],
  ["bearer", /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g],
  ["url_credentials", /\b([a-z][a-z0-9+.-]{1,12}:\/\/)[^\s/@:]{1,100}:[^\s/@]{1,200}@/g, "$1«REDIGERT»@"],
  ["kv_secret", /\b((?:[A-Z][A-Z0-9_]*_)?(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*(?!«)[^\s"',;]{6,}/gi, "$1=«REDIGERT»"]
];

export function redact(text) {
  let out = text;
  const counts = {};
  for (const [name, re, replacement] of REDACTIONS) {
    let n = 0;
    out = out.replace(re, (...args) => {
      n += 1;
      if (replacement === undefined) return "«REDIGERT»";
      // enkel $1-støtte (JS-replace-strenger støtter det, men vi bruker callback for å telle)
      return replacement.replace(/\$(\d)/g, (_, d) => (typeof args[Number(d)] === "string" ? args[Number(d)] : ""));
    });
    if (n > 0) counts[name] = n;
  }
  return { text: out, counts };
}

function gitInfo() {
  const repo = process.env.JARVIS_EVIDENCE_REPO ? resolve(process.env.JARVIS_EVIDENCE_REPO) : ROOT;
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
    } catch {
      return "";
    }
  };
  return { sha: run(["rev-parse", "HEAD"]) || "ukjent", branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) || "ukjent", dirty: run(["status", "--porcelain"]).length > 0 };
}

function parseArgs(argv) {
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const cmd = sep === -1 ? [] : argv.slice(sep + 1);
  const opts = { id: "", note: "", outDir: "", timeoutS: 600, stdin: false };
  for (let i = 0; i < own.length; i += 1) {
    const a = own[i];
    if (a === "--note") opts.note = own[++i] ?? "";
    else if (a === "--out-dir") opts.outDir = own[++i] ?? "";
    else if (a === "--timeout-s") opts.timeoutS = Number(own[++i]);
    else if (a === "--stdin") opts.stdin = true;
    else if (a.startsWith("--")) throw new Error(`ukjent flagg ${a}`);
    else if (!opts.id) opts.id = a;
    else throw new Error(`uventet argument ${a}`);
  }
  if (!ID_RE.test(opts.id)) throw new Error("id mangler eller er ugyldig (bokstaver/tall/punktum/bindestrek/understrek, 2-61 tegn)");
  if (!Number.isFinite(opts.timeoutS) || opts.timeoutS < 1 || opts.timeoutS > 3600) throw new Error("--timeout-s må være 1-3600");
  if (opts.stdin && cmd.length > 0) throw new Error("--stdin kan ikke kombineres med en kommando");
  if (!opts.stdin && cmd.length === 0) throw new Error("oppgi en kommando etter «--», eller bruk --stdin");
  return { opts, cmd };
}

function capture(stream, sink) {
  stream.on("data", (chunk) => {
    if (sink.bytes < MAX_OUTPUT_BYTES) {
      const room = MAX_OUTPUT_BYTES - sink.bytes;
      sink.chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
    } else sink.truncated = true;
    sink.bytes += chunk.length;
    if (sink.bytes > MAX_OUTPUT_BYTES) sink.truncated = true;
  });
}

function runCommand(cmd, timeoutS) {
  return new Promise((resolveRun) => {
    const sink = { chunks: [], bytes: 0, truncated: false };
    let timedOut = false;
    const child = spawn(cmd[0], cmd.slice(1), { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], shell: false });
    capture(child.stdout, sink);
    capture(child.stderr, sink);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutS * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: 127, signal: null, output: Buffer.from(`kunne ikke starte kommandoen: ${err.code ?? err.name}\n`), truncated: false, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? (signal ? 128 : 1), signal, output: Buffer.concat(sink.chunks), truncated: sink.truncated, timedOut });
    });
  });
}

async function readStdin() {
  const sink = { chunks: [], bytes: 0, truncated: false };
  capture(process.stdin, sink);
  await new Promise((r) => process.stdin.on("end", r));
  return { code: 0, signal: null, output: Buffer.concat(sink.chunks), truncated: sink.truncated, timedOut: false };
}

export function renderEvidence({ id, note, cmd, result, counts: outputCounts, info, now, host }) {
  const quote = (a) => (/[\s"'`$\\]/.test(a) ? JSON.stringify(a) : a);
  const cmdRedacted = redact(cmd.map(quote).join(" "));
  const counts = { ...outputCounts };
  for (const [k, v] of Object.entries(cmdRedacted.counts)) counts[k] = (counts[k] ?? 0) + v;
  const redactedTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  const fence = "````"; // fire backticks: utdata kan inneholde tre
  const lines = [
    `# Evidens ${id} – ${now.slice(0, 10)}`,
    "",
    "Generert av `ops/acceptance/record-evidence.mjs` (WP-J, D-450). Filen beviser kun hva kommandoen skrev akkurat da, på koden under. Vurderingen nederst er menneskelig.",
    "",
    `- **Tidspunkt (UTC):** ${now}`,
    `- **Vert:** ${host}`,
    `- **Git:** \`${info.sha}\` på \`${info.branch}\`${info.dirty ? " (**ucommittede endringer i arbeidstreet**)" : ""}`,
    `- **Kommando:** ${cmd.length ? "`" + cmdRedacted.text.replace(/`/g, "'") + "`" : "(lest fra stdin)"}`,
    `- **Exit:** ${result.timedOut ? `${result.code} (tidsavbrudd – kommandoen ble drept)` : result.signal ? `${result.code} (signal ${result.signal})` : result.code}`,
    `- **Redigert:** ${redactedTotal === 0 ? "ingen treff" : Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", ")}${result.truncated ? " · **utdata avkortet ved 200 kB**" : ""}`
  ];
  if (note) lines.push(`- **Merknad:** ${note.replace(/[\r\n]+/g, " ").slice(0, 500)}`);
  lines.push("", "## Utdata", "", fence + "text", "__OUTPUT__", fence, "", "## Vurdering", "", "- **Resultat:** _(PASS / WARN / FAIL / UNKNOWN – fylles ut av eier og Claude etter å ha lest utdataene)_", "- **Gjelder matriserad(er):** _(f.eks. EV-0, UA0-RUNRATE)_", "- **Merknader:** _(avvik, hva som ikke ble dekket)_", "");
  return lines.join("\n");
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`bruksfeil: ${err.message}`);
    console.error('bruk: node ops/acceptance/record-evidence.mjs <id> [--note "tekst"] [--out-dir <mappe>] [--timeout-s N] -- <kommando> [args...]');
    return 2;
  }
  const { opts, cmd } = parsed;
  const result = opts.stdin ? await readStdin() : await runCommand(cmd, opts.timeoutS);
  const { text, counts } = redact(result.output.toString("utf8"));
  const now = new Date().toISOString();
  const outDir = resolve(opts.outDir || process.env.JARVIS_EVIDENCE_DIR || join(ROOT, "docs", "evidence"));
  const file = join(outDir, `${now.slice(0, 10)}-${opts.id}.md`);
  const body = renderEvidence({ id: opts.id, note: opts.note, cmd, result, counts, info: gitInfo(), now, host: hostname() }).replace("__OUTPUT__", () => text.replace(/\r\n/g, "\n").trimEnd());
  const cmdHits = redact(cmd.join(" ")).counts;
  try {
    mkdirSync(outDir, { recursive: true });
    if (existsSync(file)) {
      console.error(`filen finnes allerede: ${file} (evidens overskrives aldri – velg en ny id eller slett den bevisst)`);
      return 3;
    }
    writeFileSync(file, body, { flag: "wx", mode: 0o644 });
  } catch (err) {
    console.error(`kunne ikke skrive evidensfilen: ${err.code ?? err.name}`);
    return 3;
  }
  console.log(`Evidens skrevet til: ${file}`);
  const hits = Object.values(counts).reduce((a, b) => a + b, 0) + Object.values(cmdHits).reduce((a, b) => a + b, 0);
  if (hits > 0) console.log(`ADVARSEL: ${hits} hemmelighetslignende treff ble redigert – les filen før den committes.`);
  return result.code === 0 ? 0 : 1;
}

/** Kjøres filen direkte (også via symlink)? En feilet sjekk betyr «importert som modul», aldri «gjør ingenting stille». */
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => process.exit(code));
}
