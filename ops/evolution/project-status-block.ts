// Kjøres direkte med Nodes type-stripping: `node --experimental-transform-types ops/evolution/project-status-block.ts [flagg]`
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConstitutionError, buildConstitution, loadConstitution, type BudgetCaps } from "../../modules/self-modification/src/constitution.ts";
import {
  UsageSnapshotSchema, checkStatusBlock, renderEvolutionStatusBlock, spliceStatusBlock, type StatusConstitution, type UsageSnapshot
} from "../../modules/self-modification/src/evolution/status-block.ts";

/**
 * WP-EV0 (HF2 kap. 29/31 pkt. 18, PC2): genererer Evolution-blokken for `docs/PROJECT_STATUS.md` fra det SIGNERTE manifestet (takene, øre/minutter) og et forbruksbilde
 * (`--usage`, ellers «ikke målt» - aldri 0). Kjøres av en PERSON eller docs-agenten; ALDRI av Jarvis selv, leser aldri en privatnøkkel og skriver kun til filen som gis med `--write`.
 *
 *   uten flagg           skriv blokken til stdout
 *   --write <fil.md>     bytt ut blokken mellom `<!-- EVOLUTION_STATUS_BEGIN -->` og `<!-- EVOLUTION_STATUS_END -->` (markørene må finnes: første gang settes de inn for hånd)
 *   --check <fil.md>     kontroller at blokken i filen stemmer med manifestet (versjon + SHA-256 av takene); funn gir exit 1
 *   --manifest/--sig/--pubkey <sti>   standard: config/evolution/constitution.v1.json / .v1.sig / constitution.pub.pem (ved siden av manifestet)
 *   --pinned <sha256>    festet nøkkelfingeravtrykk (standard: miljøvariabelen JARVIS_CONSTITUTION_PUBKEY_SHA256); uten det kan signaturen ikke verifiseres og blokken merkes UTKAST
 *   --usage <fil.json>   forbruksbilde (`UsageSnapshotSchema`); uten: alt faktisk forbruk vises som «ikke målt»
 *   --now <ISO>          tidspunktet som skrives i blokken (standard: nå)
 *   --cwd <katalog>      katalogen standardstiene regnes fra (standard: repo-roten)
 *
 * EXIT-KONTRAKT: 0 = ok. 1 = `--check` fant avvik (foreldet/manglende/ødelagt blokk). 2 = bruksfeil, ugyldig/svekket manifest, ugyldig forbruksbilde eller IO-feil - ALDRI 0 ved slik svikt,
 * og aldri tak fra et manifest som ble avvist. Et usignert/ikke-verifisert manifest vises som UTKAST med feilkoden (takene er ikke autoritative før eieren har signert).
 */
export interface StatusBlockResult {
  exit: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

export interface StatusBlockArgs {
  manifest?: string;
  sig?: string;
  pubkey?: string;
  pinned?: string | null;
  usage?: string;
  now?: string;
  check?: string;
  write?: string;
  cwd?: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UNVERIFIED_CODES = new Set(["constitution_unsigned", "constitution_key_not_pinned", "constitution_key_mismatch", "constitution_signature_invalid"]);
const fail = (message: string): StatusBlockResult => ({ exit: 2, stdout: "", stderr: `${message}\n` });

export function parseArgs(argv: readonly string[]): StatusBlockArgs | string {
  const out: Record<string, string> = {};
  const known = new Set(["manifest", "sig", "pubkey", "pinned", "usage", "now", "check", "write", "cwd"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--") || !known.has(a.slice(2))) return `ukjent flagg: ${a}`;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return `flagget ${a} mangler verdi`;
    out[a.slice(2)] = value;
    i++;
  }
  return out as StatusBlockArgs;
}

export async function runStatusBlock(args: StatusBlockArgs, env: Readonly<Record<string, string | undefined>> = process.env): Promise<StatusBlockResult> {
  if (args.check !== undefined && args.write !== undefined) return fail("bruk enten --check eller --write, ikke begge");
  const root = args.cwd === undefined ? REPO_ROOT : resolve(args.cwd);
  const manifestPath = resolve(root, args.manifest ?? "config/evolution/constitution.v1.json");
  const dir = dirname(manifestPath);
  const signaturePath = resolve(root, args.sig ?? join(dir, "constitution.v1.sig"));
  const publicKeyPath = resolve(root, args.pubkey ?? join(dir, "constitution.pub.pem"));
  if (!existsSync(manifestPath)) return fail(`fant ikke manifestet: ${manifestPath}`);

  const now = args.now ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(now) || Number.isNaN(Date.parse(now))) return fail(`--now må være ISO-8601 UTC (ÅÅÅÅ-MM-DDTHH:MM:SSZ): ${now}`);

  let manifestJson: string;
  try {
    manifestJson = readFileSync(manifestPath, "utf8");
  } catch (err) {
    return fail(`kunne ikke lese manifestet: ${(err as Error).message}`);
  }

  // Verifiser signaturen hvis mulig. Et manifest som er signert men avvist (svekket/ugyldig/nedgradert) gir aldri tak. Et usignert manifest vises som UTKAST.
  let constitution: StatusConstitution;
  let version: number;
  let caps: BudgetCaps;
  const pinned = args.pinned === undefined ? env["JARVIS_CONSTITUTION_PUBKEY_SHA256"] ?? null : args.pinned;
  try {
    const c = await loadConstitution({ manifestPath, signaturePath, publicKeyPath, pinnedPublicKeySha256: pinned });
    constitution = { version: c.version, digest: c.digest, signed: true, verification_code: null };
    version = c.version;
    caps = c.budget;
  } catch (err) {
    const code = err instanceof ConstitutionError ? err.code : "constitution_load_failed";
    if (!UNVERIFIED_CODES.has(code)) return fail(`manifestet er avvist (${code}${err instanceof Error ? `: ${err.message}` : ""}) - ingen tak vises fra et avvist manifest`);
    try {
      const draft = buildConstitution(JSON.parse(manifestJson));
      constitution = { version: draft.version, digest: draft.digest, signed: false, verification_code: code };
      version = draft.version;
      caps = draft.budget;
    } catch (inner) {
      return fail(`manifestet er ugyldig eller svekket (${(inner as Error).message}) - ingen tak vises`);
    }
  }

  let usage: UsageSnapshot | null = null;
  if (args.usage !== undefined) {
    try {
      const parsed = UsageSnapshotSchema.safeParse(JSON.parse(readFileSync(resolve(root, args.usage), "utf8")));
      if (!parsed.success) return fail(`ugyldig forbruksbilde (${parsed.error.issues[0]?.path.join(".") ?? "skjema"}: ${parsed.error.issues[0]?.message ?? ""})`);
      usage = parsed.data;
    } catch (err) {
      return fail(`kunne ikke lese forbruksbildet: ${(err as Error).message}`);
    }
  }

  if (args.check !== undefined) {
    let md: string;
    try {
      md = readFileSync(resolve(root, args.check), "utf8");
    } catch (err) {
      return fail(`kunne ikke lese ${args.check}: ${(err as Error).message}`);
    }
    const findings = checkStatusBlock(md, { version, caps });
    return findings.length === 0
      ? { exit: 0, stdout: `Evolution-blokken i ${args.check} stemmer med manifestet (versjon ${version}).\n`, stderr: "" }
      : { exit: 1, stdout: `Evolution-blokken i ${args.check} er IKKE i orden:\n${findings.map((f) => `- ${f}`).join("\n")}\n`, stderr: "" };
  }

  const block = renderEvolutionStatusBlock({ generated_at: now, constitution, caps, usage });
  if (args.write !== undefined) {
    const target = resolve(root, args.write);
    let md: string;
    try {
      md = readFileSync(target, "utf8");
    } catch (err) {
      return fail(`kunne ikke lese ${args.write}: ${(err as Error).message}`);
    }
    const next = spliceStatusBlock(md, block);
    if (next === null) return fail(`${args.write} har ingen gyldig markørblokk (<!-- EVOLUTION_STATUS_BEGIN --> ... <!-- EVOLUTION_STATUS_END -->) - sett inn markørene for hånd først; filen er ikke endret`);
    try {
      writeFileSync(target, next);
    } catch (err) {
      return fail(`kunne ikke skrive ${args.write}: ${(err as Error).message}`);
    }
    return { exit: 0, stdout: `Oppdaterte Evolution-blokken i ${args.write} (manifestversjon ${version}, ${constitution.signed ? "signert" : "UTKAST"}).\n`, stderr: "" };
  }
  return { exit: 0, stdout: block, stderr: "" };
}

export function isDirectRun(argv1: string | undefined, metaUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    process.stderr.write(`${parsed}\n`);
    process.exitCode = 2;
  } else {
    runStatusBlock(parsed).then(
      (r) => {
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
        process.exitCode = r.exit;
      },
      (err: unknown) => {
        process.stderr.write(`uventet feil: ${(err as Error).message}\n`);
        process.exitCode = 2;
      }
    );
  }
}
