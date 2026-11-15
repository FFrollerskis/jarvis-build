#!/usr/bin/env node
/**
 * WP-I (D-472) - SCAFFOLD-GENERATOR for en ny connector. Lager et UTKAST (manifest, fake-adapter, kontraktstest og runbook-stub) fra Connector SDK-ets maler, slik at å legge til og revidere en connector er en
 * standard, testbar prosedyre. Ren Node (ESM, ingen avhengigheter, ingen nettverk) - kjøres av en person, aldri av Jarvis selv.
 *
 *   node ops/connector/new-connector.mjs --id <connector_id> --name "<Visningsnavn>" [--vendor "<Leverandør>"] [--tool-id <tool_id>] [--write] [--root <mappe>] [--dry-run]
 *
 * Filene (relativt til --root, standard repo-roten):
 *   modules/connector-sdk/src/manifests/<id>.ts              manifest (skeleton, UTKAST - må fylles ut til `full`)
 *   modules/connector-sdk/test/connectors/<id>.fake.ts       fake-adapter (createFakeConnector)
 *   modules/connector-sdk/test/connectors/<id>.contract.test.ts   kontraktstest (runConnectorContract)
 *   docs/runbooks/CONNECTOR_<ID>.md                          runbook-stub (norsk, D-64/D-41-maler)
 *
 * NEKTER Å OVERSKRIVE: finnes en av målfilene fra før, skrives INGENTING (avslutter med kode 2). Ugyldige argumenter gir kode 1. `--dry-run` skriver ingenting.
 * Generatoren velger ingen leverandør og kjører ingen D-64-/D-41-vurdering - malene PEKER på dem (CLAUDE.md regel 11 og 12); å gjøre dem er arbeidet etterpå.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
export const DEFAULT_TEMPLATES_DIR = join(REPO_ROOT, "modules", "connector-sdk", "templates");

/**
 * Connector-id: snake_case uten ledende/avsluttende/doble understreker (2-41 tegn) - SAMME form som `CONNECTOR_ID` i manifestskjemaet (en test låser at de er like). Den gamle formen tillot `ab_` og `a__b`, som
 * ga en generert hvelvreferanse `JARVIS_AB__TOKEN` som ikke er en gyldig hvelvreferanse (utkastet validerte ikke).
 */
export const ID_PATTERN = /^(?=.{2,41}$)[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const TOOL_ID_PATTERN = /^[a-z][a-z0-9_-]{0,40}$/;
/**
 * Visningstekst havner i TS-kommentarer, TS-strenger og markdown: ingen kontrolltegn og ingen usynlige/retningsstyrende tegn (Unicode-kategori C: kontroll inkl. NUL og U+0085, formattegn som nullbredde-mellomrom/
 * U+200B-200F, bidi U+202A-202E og U+2066-2069, U+FEFF; ubrukte/private), ingen linje-/avsnittsseparatorer (U+2028/U+2029), og ingen anførselstegn, backslash, backtick, $, `*`, `|`, klammer eller `<` `>`.
 */
const TEXT_PATTERN = /^[^\p{C}\p{Zl}\p{Zp}"'\\`$*|{}<>]{1,80}$/u;

export class GeneratorError extends Error {
  /** @param {string} message @param {number} exitCode 1 = ugyldig bruk, 2 = ville overskrive */
  constructor(message, exitCode) {
    super(message);
    this.name = "GeneratorError";
    this.exitCode = exitCode;
  }
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ id?: string; name?: string; vendor?: string; toolId?: string; write: boolean; root: string; templates: string; dryRun: boolean; help: boolean }} */
  const o = { write: false, root: REPO_ROOT, templates: DEFAULT_TEMPLATES_DIR, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new GeneratorError(`${a} krever en verdi`, 1);
      return v;
    };
    switch (a) {
      case "--id": o.id = value(); break;
      case "--name": o.name = value(); break;
      case "--vendor": o.vendor = value(); break;
      case "--tool-id": o.toolId = value(); break;
      case "--root": o.root = resolve(value()); break;
      case "--templates": o.templates = resolve(value()); break;
      case "--write": o.write = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--help": case "-h": o.help = true; break;
      default: throw new GeneratorError(`ukjent argument: ${String(a).slice(0, 40)}`, 1);
    }
  }
  return o;
}

const pascal = (id) => id.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

/** Validerer og normaliserer inndata. Kaster `GeneratorError` (kode 1) ved brudd. */
export function normalize(o) {
  if (o.id === undefined || !ID_PATTERN.test(o.id)) throw new GeneratorError("--id må være snake_case (a-z, 0-9, _), 2-41 tegn, starte med en bokstav, uten ledende, avsluttende eller doble understreker (samme form som connector-id i registeret)", 1);
  if (o.name === undefined || !TEXT_PATTERN.test(o.name)) throw new GeneratorError("--name er påkrevd (1-80 tegn uten kontroll-, usynlige og retningsstyrende tegn, linjeskift, anførselstegn, backslash, backtick, $, *, |, { } < >)", 1);
  if (o.vendor !== undefined && !TEXT_PATTERN.test(o.vendor)) throw new GeneratorError("--vendor har ugyldige tegn (samme regler som --name)", 1);
  const toolId = o.toolId ?? o.id;
  if (!TOOL_ID_PATTERN.test(toolId)) throw new GeneratorError("--tool-id må være a-z, 0-9, _ eller -, starte med en bokstav (verktøy-id i verktøydefinisjonene)", 1);
  return { id: o.id, name: o.name, vendor: o.vendor, toolId, write: o.write };
}

function actionsCode(toolId, write) {
  const read = `  {
    key: ${JSON.stringify(`${toolId}.list_items`)}, kind: "read", effect: "read",
    authority: { risk_class: "A", step_up_required: false, owner_only: false },
    reversibility: { reversible: true, rollback_method: "none", rollback_procedure: "ingen (lesing)", compensating_action: null, destructive: false, evidence: { before_state: false, postcondition: "none" } },
    idempotency: { requirement: "none", provider_idempotent: true },
    trust: { output: "untrusted" },
    limits: { rate_limit_per_minute: 30 }, // TODO(manifest): fra ToolDefinition.rate_limit_per_minute
    operations: { timeout_ms: 10_000 }, // TODO(manifest): fra ToolDefinition.timeout_ms
    data: { input_required: [], identity_fields: [] } // TODO(manifest): påkrevde parametre fra inndataskjemaet
  }`;
  if (!write) return read;
  const mutation = `  {
    key: ${JSON.stringify(`${toolId}.create_item`)}, kind: "write", effect: "write",
    authority: { risk_class: "B", step_up_required: false, owner_only: false },
    reversibility: {
      reversible: true,
      rollback_method: unknownField("TODO: provider_revert | compensating_action | restore_from_snapshot | manual | none"),
      rollback_procedure: "TODO: beskriv hvordan handlingen reverseres (eller at den ikke kan det)",
      compensating_action: unknownField("TODO: kompenserende handling"),
      destructive: false,
      evidence: { before_state: false, postcondition: "none" } // TODO(manifest): klasse C/D krever fersk lesing og readback
    },
    idempotency: { requirement: "recommended", provider_idempotent: false }, // TODO(manifest): fra ToolDefinition (klasse D/send/pay = required)
    trust: { output: "internal" },
    limits: { rate_limit_per_minute: 10 }, // TODO(manifest): fra ToolDefinition
    operations: { timeout_ms: 15_000 }, // TODO(manifest): fra ToolDefinition
    data: { input_required: [], identity_fields: [] }
  }`;
  return `${read},\n${mutation}`;
}

/** Bygger plassholder-verdiene (alt som havner i en TS-streng er JSON-escapet). */
export function placeholders(n) {
  const idUpper = n.id.toUpperCase();
  return {
    ID: n.id,
    ID_JSON: JSON.stringify(n.id),
    CONST: idUpper,
    PASCAL: pascal(n.id),
    NAME_COMMENT: n.name,
    NAME_MD: n.name,
    NAME_JSON: JSON.stringify(n.name),
    VENDOR_VALUE: n.vendor === undefined ? 'unknownField("TODO: leverandørnavn")' : JSON.stringify(n.vendor),
    TOOL_ID: n.toolId,
    SECRET_REF_JSON: JSON.stringify(`JARVIS_${idUpper}_TOKEN`),
    RUNBOOK_JSON: JSON.stringify(`docs/runbooks/CONNECTOR_${idUpper}.md`),
    FAKE_PATH_JSON: JSON.stringify(`modules/connector-sdk/test/connectors/${n.id}.fake.ts`),
    CONTRACT_PATH_JSON: JSON.stringify(`modules/connector-sdk/test/connectors/${n.id}.contract.test.ts`),
    ACTIONS: actionsCode(n.toolId, n.write),
    WRITE_STATUS: JSON.stringify(n.write ? "implemented" : "not_implemented"),
    IDEMPOTENCY: n.write
      ? '{ dedupe_key: "jarvis_idempotency_key", retry_semantics: unknownField("TODO"), exactly_once_target: unknownField("TODO") }'
      : '{ dedupe_key: "none", retry_semantics: { on_timeout: "safe_retry", on_rate_limit: "retry_after", on_server_error: "safe_retry" }, exactly_once_target: "not_applicable" }',
    TIMEOUT_MS: n.write ? "15_000" : "10_000",
    LEVEL: n.write ? "A" : "R"
  };
}

/** Fyll malen. Ukjent plassholder eller en rest `{{...}}` etterpå er en programmeringsfeil (kode 1), aldri en stille tom verdi. */
export function render(template, values, label = "mal") {
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key) => {
    if (!(key in values)) throw new GeneratorError(`${label}: ukjent plassholder {{${key}}}`, 1);
    return String(values[key]);
  });
  if (/\{\{[A-Z_]+\}\}/.test(out)) throw new GeneratorError(`${label}: plassholder igjen etter utfylling`, 1);
  return out;
}

/** Planlagte filer (relative stier + innhold). Leser malene; skriver ingenting. */
export function planFiles(n, templatesDir = DEFAULT_TEMPLATES_DIR) {
  const values = placeholders(n);
  const tpl = (name) => {
    const p = join(templatesDir, name);
    if (!existsSync(p)) throw new GeneratorError(`mal mangler: ${name}`, 1);
    return readFileSync(p, "utf8");
  };
  const idUpper = n.id.toUpperCase();
  return [
    { path: `modules/connector-sdk/src/manifests/${n.id}.ts`, content: render(tpl("manifest.ts.tmpl"), values, "manifest.ts.tmpl") },
    { path: `modules/connector-sdk/test/connectors/${n.id}.fake.ts`, content: render(tpl("fake-adapter.ts.tmpl"), values, "fake-adapter.ts.tmpl") },
    { path: `modules/connector-sdk/test/connectors/${n.id}.contract.test.ts`, content: render(tpl("contract.test.ts.tmpl"), values, "contract.test.ts.tmpl") },
    { path: `docs/runbooks/CONNECTOR_${idUpper}.md`, content: render(tpl("runbook.md.tmpl"), values, "runbook.md.tmpl") }
  ];
}

/** Er `child` lik `parent` eller en etterkommer av den? Håndterer en rot som allerede ender på skilletegn (`--root /`). */
function within(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Går fra roten ned til `dir` og stopper ved den første symlenken som peker UT av roten (`baseReal` = rotens realpath) eller er dinglende. En symlenke som peker til et annet sted INNE i roten er lov.
 * Returnerer en kort beskrivelse (relativ sti, aldri innholdet), eller `null` når stien er trygg. Det som ikke finnes ennå (`lstat` feiler) kan heller ikke være en symlenke.
 */
function symlinkEscape(dir, base, baseReal) {
  const rel = relative(base, dir);
  if (rel === "") return null;
  let cur = base;
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch { return null; }
    if (!st.isSymbolicLink()) continue;
    let real;
    try { real = realpathSync(cur); } catch { return `${relative(base, cur)} er en dinglende symlenke`; }
    if (!within(real, baseReal)) return `${relative(base, cur)} er en symlenke ut av roten`;
  }
  return null;
}

/** Mapper som mangler mellom `dir` og det som finnes, grunnest først (det en `mkdir -p` av `dir` ville opprettet). */
function missingDirs(dir) {
  const out = [];
  let cur = dir;
  while (!existsSync(cur)) {
    out.push(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out.reverse();
}

/**
 * Skriver planen under `root`. NEKTER å overskrive: alle mål sjekkes FØR noe skrives (kode 2), og filene åpnes med `wx` (feiler om en fil dukker opp underveis - da fjernes det denne kjøringen allerede har laget,
 * både filer og mapper den selv opprettet; en mappe som ikke er tom fjernes aldri). ALDRI utenfor `--root`: stien sjekkes både leksikalt og via `realpath` (en symlenke inne i roten som peker ut, f.eks.
 * `manifests/ -> /annet`, gir kode 1 før noe skrives). Selve `--root` kan være en symlenke - den er eierens eksplisitte valg.
 * @returns {string[]} absolutte stier som ble skrevet (tom ved dry-run)
 */
export function writePlan(root, plan, { dryRun = false } = {}) {
  const base = resolve(root);
  const rootExists = existsSync(base);
  const baseReal = rootExists ? realpathSync(base) : base;
  const targets = plan.map((f) => {
    const abs = resolve(join(base, f.path));
    if (abs === base || !within(abs, base)) throw new GeneratorError(`målstien havner utenfor --root: ${f.path}`, 1);
    // Symlenker: ingen mappe på veien ned fra roten kan være en symlenke som peker ut av den (eller en dinglende). Finnes ikke roten ennå, finnes det heller ingen symlenke inni den.
    const escape = rootExists ? symlinkEscape(dirname(abs), base, baseReal) : null;
    if (escape !== null) throw new GeneratorError(`målstien går via en symlenke ut av --root (${escape}): ${f.path}`, 1);
    return { abs, content: f.content, rel: f.path };
  });
  const existing = targets.filter((t) => existsSync(t.abs)).map((t) => t.rel);
  if (existing.length > 0) throw new GeneratorError(`nekter å overskrive eksisterende filer: ${existing.join(", ")} - ingenting er skrevet`, 2);
  if (dryRun) return [];
  const created = [];
  const createdDirs = [];
  try {
    for (const t of targets) {
      const dir = dirname(t.abs);
      createdDirs.push(...missingDirs(dir));
      mkdirSync(dir, { recursive: true });
      writeFileSync(t.abs, t.content, { encoding: "utf8", flag: "wx" });
      created.push(t.abs);
    }
  } catch (err) {
    for (const f of created) rmSync(f, { force: true });
    // Mapper denne kjøringen opprettet fjernes dypest først, og BARE hvis de er tomme (`rmdir`, aldri rekursivt): noe en annen har lagt i dem røres ikke.
    for (const d of [...createdDirs].reverse()) {
      try { rmdirSync(d); } catch { /* ikke tom, finnes ikke, eller ikke vår - la den være */ }
    }
    if (err && (err.code === "EEXIST" || err.code === "ENOTDIR")) throw new GeneratorError("en sti er i veien eller en målfil dukket opp underveis - nekter å overskrive; filene og mappene denne kjøringen laget er fjernet", 2);
    throw err;
  }
  return created;
}

const USAGE = `Bruk: node ops/connector/new-connector.mjs --id <connector_id> --name "<Visningsnavn>" [--vendor "<Leverandør>"] [--tool-id <tool_id>] [--write] [--root <mappe>] [--dry-run]
  --id        snake_case connector-id (som i connector-registeret), f.eks. acme_tasks
  --name      visningsnavn (som i registeret: display_name)
  --vendor    leverandørnavn (valgfritt; ellers en TODO-markør)
  --tool-id   verktøy-id i verktøydefinisjonene (standard: samme som --id)
  --write     utkastet får også en skrivehandling (klasse B) og krever dermed akseptansenivå A
  --root      mappen filene skrives under (standard: repo-roten)
  --dry-run   vis hva som ville blitt skrevet, uten å skrive
Avslutter 0 = ok, 1 = ugyldig bruk, 2 = ville overskrive (ingenting skrives).`;

/** @param {string[]} argv @returns {number} exit code */
export function main(argv, io = { log: (s) => console.log(s), err: (s) => console.error(s) }) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) { io.log(USAGE); return 0; }
    const n = normalize(opts);
    const plan = planFiles(n, opts.templates);
    const created = writePlan(opts.root, plan, { dryRun: opts.dryRun });
    io.log(opts.dryRun ? "TØRRKJØRING - ingenting er skrevet. Ville laget:" : "Laget (UTKAST - ikke en ferdig connector):");
    for (const f of plan) io.log(`  ${f.path}`);
    if (!opts.dryRun && created.length !== plan.length) throw new GeneratorError("uventet: ikke alle filene ble skrevet", 1);
    io.log(`
NESTE STEG (CLAUDE.md regel 11 og 12 - ingen snarvei):
  1. D-64 Core-vs-Adapter-porten (runbook-stubbens punkt 1), så D-41 kapabilitetsrevisjonen mot offisiell dokumentasjon (punkt 2). Blir leverandøren en kjerneavhengighet: STOPP og meld CORE_DEPENDENCY_DECISION_REQUIRED=true.
  2. Registrer connectoren i modules/tool-gateway/src/connector-registry.ts og verktøydefinisjonene i modules/tool-gateway/src/integrations.ts (registeret er sannheten).
  3. Fyll ut hver unknownField/TODO i manifestet, sett completeness til "full" og source til "authored", og legg manifestet til i FULL_MANIFESTS (modules/connector-sdk/src/manifests/index.ts).
  4. Kjør: pnpm exec vitest run modules/connector-sdk  (kontraktstest-kit + CI-vakt). Akseptansegapene er arbeidslisten.
  5. Skriv runbooken ferdig; live smoke mot sandbox er BLOCKED_EXTERNAL til eieren har gitt credential.`);
    return 0;
  } catch (err) {
    if (err instanceof GeneratorError) {
      io.err(`FEIL: ${err.message}`);
      return err.exitCode;
    }
    io.err(`UVENTET FEIL: ${err && err.message ? String(err.message).slice(0, 200) : "ukjent"}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
