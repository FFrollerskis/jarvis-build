#!/usr/bin/env node
// WP-J (D-450): evidens-opptaker for verifiseringsøkten. Kjører ÉN kommando (uten skall), fjerner kjente hemmelighetsformer fra utdataene og skriver en
// evidensfil som lukkingsmatrisen kan lenke til (`docs/evidence/<dato>-<id>.md`). En rad i `docs/CLOSURE_MATRIX_HF1_HF2.md` kan først stå som `VERIFIED`
// når den lenker til en slik fil (vakt: modules/core/test/wpj-closure-matrix.test.ts).
//
//   node ops/acceptance/record-evidence.mjs <id> [--note "tekst"] [--out-dir <mappe>] [--timeout-s 600] -- <kommando> [argumenter...]
//   <kommando> | node ops/acceptance/record-evidence.mjs <id> --stdin [--note "tekst"]
//   <tekst> | node ops/acceptance/record-evidence.mjs --scan        (skriver KUN «regel=antall»-linjer for hemmelighetstreff - aldri tekst; exit 1 ved treff)
//
// Ærlighet: opptakeren beviser KUN hva kommandoen skrev akkurat da, på denne vertens kode (git-SHA står i filen). Den vurderer ikke om utfallet er riktig – det
// gjør du og jeg sammen, og vurderingen føres i filen («Vurdering»). Med --stdin har opptakeren ikke kjørt noe: exit-koden er ukjent og filen sier det.
// Redaksjonen er en siste sikring, ikke en lisens til å skrive hemmeligheter: den er mønsterbasert (en hemmelighet uten kjent form og uten nøkkelord
// fanges ikke), så les utdataene før filen committes (gitleaks kjører også i CI). Evidensfilen reserveres FØR kommandoen kjører (samme id to ganger
// kjører aldri kommandoen to ganger). Exit: 0 = kommandoen ga 0 og filen er skrevet, 1 = kommandoen feilet (filen skrives likevel – feilen ER evidens),
// 2 = bruksfeil, 3 = kunne ikke skrive/reservere filen.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const MAX_OUTPUT_BYTES = 200_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,60}$/;
const R = "«REDIGERT»";

/** Verdier som aldri er hemmeligheter selv om nøkkelen heter token/secret: «ikke-satt», tall for token-budsjetter, plassholdere og miljøvariabel-referanser. */
const BENIGN_VALUE = /^(?:ikke[ _-]?satt|satt|ukjent|unknown|true|false|on|off|none|null|nil|yes|no|ok|set|unset|bearer|basic|digest|redacted|n\/a|\*+|x+|-+|\.{3}|<[^<>\r\n]{0,60}>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)$/i;
const NUMERIC_KEY = /(?:max|min|limit|count|total|usage|used|expir|ttl|length|size|num|remaining|rate|budget|quota)/i;
const KV_KEYWORDS = /(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|account[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|session[_-]?key|subscription[_-]?key|client[_-]?key|app[_-]?key|license[_-]?key|webhook[_-]?key|credentials?)/gi;
const IDENT = /[A-Za-z0-9_.-]/;

/**
 * Nøkkel=verdi i alle vanlige former: `KEY=v`, `KEY: v`, `"key": "v"`, `key: 'v'`, `{ token: 'v' }`, `export KEY="v"`, `PGPASSWORD=v`, `apiToken: v`. LINEÆR: søker nøkkelordet (billig regex), utvider høyst 40 tegn til
 * hver side og leser verdien ÉN gang; etter en håndtert verdi fortsetter søket bak den. Kun verdien redigeres (nøkkelen står igjen, så evidensen viser HVILKEN variabel som var satt).
 */
function redactKeyValue(text) {
  let out = "";
  let last = 0;
  let n = 0;
  KV_KEYWORDS.lastIndex = 0;
  let m;
  while ((m = KV_KEYWORDS.exec(text)) !== null) {
    if (m.index < last) continue; // inne i en verdi vi allerede har redigert
    const kwStart = m.index;
    let j = kwStart + m[0].length;
    const limit = Math.min(text.length, j + 40);
    while (j < limit && IDENT.test(text[j])) j += 1;
    let keyStart = kwStart;
    for (let c = 0; c < 40 && keyStart > 0 && IDENT.test(text[keyStart - 1]); c += 1) keyStart -= 1;
    const key = text.slice(keyStart, j);
    if (text[j] === '"' || text[j] === "'") j += 1; // sluttapostrof på selve nøkkelen (JSON)
    let k = j;
    while (k < text.length && (text[k] === " " || text[k] === "\t")) k += 1;
    if (text[k] !== "=" && text[k] !== ":") continue;
    k += 1;
    while (k < text.length && (text[k] === " " || text[k] === "\t")) k += 1;
    if (k >= text.length) continue;
    let vStart = k;
    let vEnd;
    const q = text[k];
    if (q === '"' || q === "'") {
      vStart = k + 1;
      let e = vStart;
      const cap = Math.min(text.length, vStart + 300);
      while (e < cap && text[e] !== q && text[e] !== "\n" && text[e] !== "\r") e += 1;
      vEnd = e; // lukkende apostrof (eller slutten av linjen/taket hvis den mangler - da redigerer vi resten av linjen)
      if (vEnd - vStart < 4) continue;
    } else {
      let e = k;
      while (e < text.length && !/[\s"',;]/.test(text[e])) e += 1;
      vEnd = e;
      if (vEnd - vStart < 6) continue;
    }
    const value = text.slice(vStart, vEnd);
    if (value.startsWith("«") || BENIGN_VALUE.test(value)) continue;
    if (/^\d+$/.test(value) && NUMERIC_KEY.test(key)) continue;
    out += text.slice(last, vStart) + R;
    last = vEnd;
    n += 1;
    KV_KEYWORDS.lastIndex = vEnd;
  }
  return { text: out + text.slice(last), n };
}

/** Kjente hemmelighetsformer. Rekkefølgen betyr noe (lange/spesifikke først). Regex-regler er lineære (ingen nøstede ubegrensede kvantorer); funksjonsregler returnerer {text, n}. */
export const REDACTIONS = [
  ["pem_block", /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8000}?-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g],
  // En PEM som er avkortet (utdata-taket), uten END, eller med kropp over 8000 tegn: alt fra BEGIN og ut regnes som nøkkeldata.
  ["pem_block_open", /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*/g],
  ["age_secret", /AGE-SECRET-KEY-1[0-9A-Z]{20,100}/g],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,255}\b/g],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g],
  ["gitlab_token", /\bglpat-[A-Za-z0-9_-]{16,100}\b/g],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,500}\b/g],
  ["openai_key", /\bsk-[A-Za-z0-9_-]{20,500}\b/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,200}\b/g],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["google_oauth", /\b(?:ya29\.[A-Za-z0-9_-]{20,500}|GOCSPX-[A-Za-z0-9_-]{20,60})/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g],
  ["bearer", /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g],
  // Leverandørformer vi faktisk møter i verifiseringsøkten (gjennomgang av PR #320): Stripe (underscore, ikke bindestrek som OpenAI), Telegram-bot, npm, Vault, Infisical, HF, Groq, SendGrid, Notion, Mailgun, m.fl.
  ["stripe_key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["stripe_webhook_secret", /\bwhsec_[A-Za-z0-9]{16,}\b/g],
  ["telegram_bot_token", /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}\b/g],
  ["npm_token", /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ["vault_token", /\bhv[sbr]\.[A-Za-z0-9_-]{20,}\b/g],
  ["infisical_service_token", /\bst\.[A-Za-z0-9]{6,}\.[A-Za-z0-9]{16,}\.[A-Za-z0-9]{16,}\b/g],
  ["huggingface_token", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["groq_key", /\bgsk_[A-Za-z0-9]{30,}\b/g],
  ["sendgrid_key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g],
  ["notion_token", /\b(?:secret_|ntn_)[A-Za-z0-9]{30,}\b/g],
  ["mailgun_key", /\bkey-[0-9a-f]{32}\b/g],
  ["digitalocean_token", /\bdop_v1_[0-9a-f]{40,}\b/g],
  ["shopify_token", /\bshp(?:at|ca|pa|ss)_[0-9a-f]{32}\b/g],
  // Cookie-hoder (sesjonsidentitet) redigeres helt. Alle Authorization-skjemaer (Basic/Digest/Token/...), ikke bare Bearer. Verdier som allerede er redigert telles ikke på nytt.
  ["cookie_header", /^([ \t]*(?:set-)?cookie[ \t]*:[ \t]*)(?!«)([^\r\n]{4,})/gim, `$1${R}`],
  ["authorization_header", /\b((?:proxy-)?authorization)\s*[:=][ \t]*(?![ \t]|(?:Bearer[ \t]+)?«)[^\r\n]{6,}/gi, `$1: ${R}`],
  // Hoder hvis NAVN ender på -key/-token/-secret/-password/-signature/-auth (X-Api-Key, X-Auth-Token, Ocp-Apim-Subscription-Key, X-Amz-Security-Token ...).
  ["secret_header", /^([ \t]*[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){0,5}-(?:key|token|secret|password|signature|auth)[ \t]*:[ \t]*)(?!«)([^\r\n]{6,})/gim, `$1${R}`],
  ["api_key_header", /\b(x-api-key|x-auth-token|x-access-token|x-goog-api-key|private-token|api-key|apikey)\s*[:=]\s*(?!«)[^\s"',;]{8,}/gi, `$1: ${R}`],
  // URL med credentials (også tom bruker: redis://:PASS@host) og hemmelige spørreparametre (?token=, ?key=, ?sig=, ?code= ...).
  ["url_credentials", /\b([a-z][a-z0-9+.-]{1,12}:\/\/)[^\s/@:]{0,100}:[^\s/@]{1,200}@/g, `$1${R}@`],
  ["url_secret_param", /([?&][A-Za-z0-9_.-]{0,30}(?:key|token|secret|password|passwd|pwd|sig|signature|auth|code|credential)[A-Za-z0-9_.-]{0,20}=)(?!«)[^&\s"'#]{6,}/gi, `$1${R}`],
  // Nøkkel=verdi i alle former (shell, ini, yaml, JSON, JS-objekter), se redactKeyValue.
  ["kv_secret", redactKeyValue],
  // Kommandolinje-flagg: --password PASS, --db-token=X, --api-key X og -u/--user bruker:PASS (HTTP Basic). (Kort-flagg som -pPASS kan ikke skilles fra andre flagg og redigeres IKKE.)
  ["cli_secret_flag", /(\s--[a-z0-9-]{0,30}(?:password|passwd|pwd|passphrase|secret|token|api-?key|apikey|access-?key|private-?key|auth)[a-z0-9-]{0,20})(?:=|[ \t]+)(?!-|«)("[^"\r\n]{4,300}"|'[^'\r\n]{4,300}'|[^\s"']{6,})/gi, `$1 ${R}`],
  ["cli_user_flag", /(\s(?:-u|--user)[ \t]+)([^\s:«]{1,64}):(?!«)([^\s]{1,200})/g, `$1$2:${R}`, (_m, _flag, user, pass) => !(/^\d+$/.test(user) && /^\d+$/.test(pass))],
  // Siste sikring: et nøkkelord (token/secret/password/api key) med en lang, blandet streng rett etter («Cloudflare token abc…», «webhook_secret 3f9a…») - uten kjent format. Krever både bokstaver og siffer
  // (en vanlig lang identifikator redigeres ikke), maks 12 tegn mellom ordet og strengen, og strengen må være minst 32 tegn.
  ["keyword_long_secret", /(?<![A-Za-z0-9])((?:token|secret|password|passwd|api[ _-]?key)s?\b[^\n«]{0,12}?)(?<![A-Za-z0-9_+/=-])([A-Za-z0-9_+/=-]{32,})(?![A-Za-z0-9_+/=»-])/gi, `$1${R}`, (_m, _kw, candidate) => /[A-Za-z]/.test(candidate) && /\d/.test(candidate)]
];

/** Fjerner kontrolltegn som kan skjule eller forfalske innhold (ANSI/ESC, NUL, usynlige bredde-null-tegn) FØR redigering - et skjult tegn midt i en hemmelighet skal ikke omgå mønstrene. */
export function sanitize(text) {
  // Kontrolltegn i regulære uttrykk er hele poenget her (no-control-regex slås av bevisst for akkurat disse tre linjene).
  /* eslint-disable no-control-regex */
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\x1b\][^\x07\x1b]{0,2000}(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]{0,40}[ -/]{0,4}[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, "");
  /* eslint-enable no-control-regex */
}

export function redact(text) {
  let out = text;
  const counts = {};
  for (const [name, rule, replacement, guard] of REDACTIONS) {
    if (typeof rule === "function") {
      const r = rule(out);
      out = r.text;
      if (r.n > 0) counts[name] = r.n;
      continue;
    }
    let n = 0;
    out = out.replace(rule, (...args) => {
      if (guard !== undefined && !guard(...args)) return args[0];
      n += 1;
      if (replacement === undefined) return R;
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
      return null; // git-feil er «ukjent», aldri «rent»
    }
  };
  // Evidensmappen selv regnes ikke som «ucommittede endringer»: den første evidensfilen ville ellers merke alle senere filer.
  const status = run(["status", "--porcelain", "--", ".", ":(exclude)docs/evidence"]);
  return { sha: run(["rev-parse", "HEAD"]) || "ukjent", branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) || "ukjent", dirty: status === null ? null : status.length > 0 };
}

function parseArgs(argv) {
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const cmd = sep === -1 ? [] : argv.slice(sep + 1);
  const opts = { id: "", note: "", outDir: "", timeoutS: 600, stdin: false, scan: false };
  for (let i = 0; i < own.length; i += 1) {
    const a = own[i];
    if (a === "--note") opts.note = own[++i] ?? "";
    else if (a === "--out-dir") opts.outDir = own[++i] ?? "";
    else if (a === "--timeout-s") opts.timeoutS = Number(own[++i]);
    else if (a === "--stdin") opts.stdin = true;
    else if (a === "--scan") opts.scan = true;
    else if (a.startsWith("--")) throw new Error(`ukjent flagg ${a}`);
    else if (!opts.id) opts.id = a;
    else throw new Error(`uventet argument ${a}`);
  }
  if (opts.scan) {
    if (opts.id || cmd.length > 0 || opts.stdin) throw new Error("--scan tar kun stdin (ingen id, kommando eller --stdin)");
    return { opts, cmd };
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

/**
 * Kjører kommandoen i en EGEN prosessgruppe (ikke Windows): tidsavbrudd og tidlig exit rydder hele gruppen, og pipene tvinges lukket slik at et barnebarn som holder dem åpne ikke kan henge opptakeren.
 * SIGTERM først (så skript kan rydde), SIGKILL etter 2 s.
 */
function runCommand(cmd, timeoutS) {
  return new Promise((resolveRun) => {
    const sink = { chunks: [], bytes: 0, truncated: false };
    let timedOut = false;
    let finished = false;
    let exitInfo = null;
    const timers = [];
    const posix = process.platform !== "win32";
    const child = spawn(cmd[0], cmd.slice(1), { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], shell: false, detached: posix });
    const killTree = (signal) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* prosessen/gruppen er allerede borte */
      }
    };
    // Ctrl-C/SIGTERM mot opptakeren skal ikke etterlate en løpsk prosessgruppe (barnet kjører i en egen gruppe).
    const onSignal = () => killTree("SIGTERM");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      for (const t of timers) clearTimeout(t);
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* ignorer */ }
      resolveRun({ code: code ?? (signal ? 128 : 1), signal, output: Buffer.concat(sink.chunks), truncated: sink.truncated, timedOut });
    };
    capture(child.stdout, sink);
    capture(child.stderr, sink);
    timers.push(setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      timers.push(setTimeout(() => killTree("SIGKILL"), 2000));
    }, timeoutS * 1000));
    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      for (const t of timers) clearTimeout(t);
      resolveRun({ code: 127, signal: null, output: Buffer.from(`kunne ikke starte kommandoen: ${err.code ?? err.name}\n`), truncated: false, timedOut });
    });
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
      // Pipene lukkes normalt av seg selv (close). Holder et etterkommer-prosess dem åpne, tvinges opprydding etter 1 s.
      timers.push(setTimeout(() => { killTree("SIGKILL"); finish(code, signal); }, 1000));
    });
    child.on("close", (code, signal) => finish(exitInfo?.code ?? code, exitInfo?.signal ?? signal));
  });
}

async function readStdin() {
  const sink = { chunks: [], bytes: 0, truncated: false };
  capture(process.stdin, sink);
  await new Promise((r) => process.stdin.on("end", r));
  return { code: null, fromStdin: true, signal: null, output: Buffer.concat(sink.chunks), truncated: sink.truncated, timedOut: false };
}

/** Lengste rekke med backticks i teksten - gjerdet rundt utdataene må være lengre, ellers kan utdata lukke gjerdet og forfalske «Vurdering»-seksjonen. */
function fenceFor(text) {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(4, longest + 1));
}

export function renderEvidence({ id, note, cmd, result, counts: outputCounts, info, now, host, output }) {
  const quote = (a) => (/[\s"'`$\\]/.test(a) ? JSON.stringify(a) : a);
  const cmdRedacted = redact(sanitize(cmd.map(quote).join(" ")));
  const noteRedacted = note ? redact(sanitize(note).replace(/[\r\n]+/g, " ").slice(0, 500)) : { text: "", counts: {} };
  const counts = { ...outputCounts };
  for (const extra of [cmdRedacted.counts, noteRedacted.counts]) for (const [k, v] of Object.entries(extra)) counts[k] = (counts[k] ?? 0) + v;
  const redactedTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  const body = (output ?? "").replace(/\n+$/, "");
  const fence = fenceFor(body);
  const exitLine = result.fromStdin
    ? "ukjent (utdata ble pipet inn via --stdin – opptakeren har IKKE kjørt kommandoen og kjenner ikke exit-koden)"
    : result.timedOut
      ? `${result.code} (tidsavbrudd – kommandoen ble drept)`
      : result.signal
        ? `${result.code} (signal ${result.signal})`
        : String(result.code);
  const lines = [
    `# Evidens ${id} – ${now.slice(0, 10)}`,
    "",
    result.fromStdin
      ? "Generert av `ops/acceptance/record-evidence.mjs` (WP-J, D-450) fra **pipet/innlimt utdata (`--stdin`)**: opptakeren har ikke kjørt noe og kan ikke bevise hvor teksten kom fra. Svakere enn en kjørt kommando - vurder den deretter. Vurderingen nederst er menneskelig."
      : "Generert av `ops/acceptance/record-evidence.mjs` (WP-J, D-450). Filen beviser kun hva kommandoen skrev akkurat da, på koden under. Vurderingen nederst er menneskelig.",
    "",
    `- **Tidspunkt (UTC):** ${now}`,
    `- **Vert:** ${host}`,
    `- **Git:** \`${info.sha}\` på \`${info.branch}\`${info.dirty === true ? " (**ucommittede endringer i arbeidstreet**)" : info.dirty === null ? " (**git-status ukjent**)" : ""}`,
    `- **Kommando:** ${cmd.length ? "`" + cmdRedacted.text.replace(/`/g, "'") + "`" : "(lest fra stdin)"}`,
    `- **Exit:** ${exitLine}`,
    `- **Redigert:** ${redactedTotal === 0 ? "ingen treff" : Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", ")}${result.truncated ? " · **utdata avkortet ved 200 kB**" : ""}`
  ];
  if (note) lines.push(`- **Merknad:** ${noteRedacted.text}`);
  lines.push("", "## Utdata", "", fence + "text", body, fence, "", "## Vurdering", "", "- **Resultat:** _(PASS / WARN / FAIL / UNKNOWN – fylles ut av eier og Claude etter å ha lest utdataene)_", "- **Gjelder matriserad(er):** _(f.eks. EV-0, UA0-RUNRATE)_", "- **Merknader:** _(avvik, hva som ikke ble dekket)_", "");
  return lines.join("\n");
}

/** --scan: les stdin, skriv KUN «regel=antall» (aldri tekst). Brukes av NAS-porten (H12) slik at den deler mønsterlisten med opptakeren. Exit 1 ved treff. */
async function scanMain() {
  const input = await readStdin();
  const { counts } = redact(sanitize(input.output.toString("utf8")));
  const names = Object.keys(counts).sort();
  for (const name of names) console.log(`${name}=${counts[name]}`);
  if (input.truncated) console.log("avkortet=1");
  return names.length > 0 ? 1 : 0;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`bruksfeil: ${err.message}`);
    console.error('bruk: node ops/acceptance/record-evidence.mjs <id> [--note "tekst"] [--out-dir <mappe>] [--timeout-s N] -- <kommando> [args...]   |   <tekst> | … --scan');
    return 2;
  }
  const { opts, cmd } = parsed;
  if (opts.scan) return scanMain();
  const now = new Date().toISOString();
  const outDir = resolve(opts.outDir || process.env.JARVIS_EVIDENCE_DIR || join(ROOT, "docs", "evidence"));
  const file = join(outDir, `${now.slice(0, 10)}-${opts.id}.md`);
  // Reserver filen FØR kommandoen kjører: samme id to ganger skal aldri kjøre kommandoen to ganger og forkaste utdataene (og `wx` er atomisk mot samtidige kjøringer).
  let fd;
  try {
    mkdirSync(outDir, { recursive: true });
    fd = openSync(file, "wx", 0o644);
  } catch (err) {
    if (err.code === "EEXIST") console.error(`filen finnes allerede: ${file} (evidens overskrives aldri – velg en ny id eller slett den bevisst). Kommandoen ble IKKE kjørt.`);
    else console.error(`kunne ikke reservere evidensfilen: ${err.code ?? err.name}`);
    return 3;
  }
  let result;
  try {
    result = opts.stdin ? await readStdin() : await runCommand(cmd, opts.timeoutS);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(file); } catch { /* ignorer */ }
    console.error(`opptakeren feilet før filen ble skrevet: ${err.code ?? err.name}`);
    return 3;
  }
  const { text, counts } = redact(sanitize(result.output.toString("utf8")));
  const body = renderEvidence({ id: opts.id, note: opts.note, cmd, result, counts, info: gitInfo(), now, host: hostname(), output: text });
  const cmdHits = redact(cmd.join(" ")).counts;
  try {
    writeSync(fd, body);
    closeSync(fd);
  } catch (err) {
    try { closeSync(fd); } catch { /* ignorer */ }
    try { unlinkSync(file); } catch { /* ignorer */ }
    console.error(`kunne ikke skrive evidensfilen: ${err.code ?? err.name}`);
    return 3;
  }
  console.log(`Evidens skrevet til: ${file}`);
  const hits = Object.values(counts).reduce((a, b) => a + b, 0) + Object.values(cmdHits).reduce((a, b) => a + b, 0);
  if (hits > 0) console.log(`ADVARSEL: ${hits} hemmelighetslignende treff ble redigert – les filen før den committes.`);
  if (opts.stdin) return 0;
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
