import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { FORBIDDEN_PATH_PATTERNS, ZERO_REVIEW_ALLOWLIST, classifySelfModification, normalizeChangedPath } from "./policy.ts";

/**
 * EV-0 (Evolution Masterplan v1.2, D-406): signert «Safety Constitution» for selvendring.
 *
 * Manifestet er DATA som eieren signerer OFFLINE (Ed25519). Kjøretiden nekter et manifest som er usignert, signert med en
 * annen nøkkel enn den eieren har festet (fingeravtrykk i miljøet, utenfor repoet), eller eldre enn siste kjente versjon.
 * Jarvis kan aldri signere, bytte nøkkel eller heve egne grenser - privatnøkkelen ligger aldri i systemet (E3).
 *
 * Endringsklasser (plan kap. 7): E0 auto (kun kjøretids-handlinger, aldri en kode-diff), E1 canary, E2 eiergodkjenning,
 * E3 forbudt. En kode-diff kan derfor bare gi E1/E2/E3. Klassifiseringen er ALDRI svakere enn `classifySelfModification`
 * (strengeste regel vinner): manifestet kan stramme inn, ikke løsne.
 */

export const EvChangeClassSchema = z.enum(["E0", "E1", "E2", "E3"]);
export type EvChangeClass = z.infer<typeof EvChangeClassSchema>;

const PathRuleSchema = z
  .object({ kind: z.enum(["prefix", "exact", "suffix", "basename"]), value: z.string().min(1).max(200) })
  .strict();
export type PathRule = z.infer<typeof PathRuleSchema>;

/** Handlinger Evolution Engine aldri kan utføre (plan kap. 7, E3). Alle må stå i et gyldig manifest. */
export const REQUIRED_E3_ACTIONS: readonly string[] = [
  "raise_own_authority_or_budget_limits",
  "modify_kill_switch",
  "modify_approval_verifier",
  "modify_audit_integrity",
  "read_break_glass_key",
  "grant_self_root"
];

/**
 * Stier som ALLTID må være beskyttet (E3) i ethvert gyldig manifest - sonder mot de hardkodede mønstrene pluss
 * constitution-filene selv. Et signert, men svekket manifest avvises (`constitution_weakened`).
 */
export const REQUIRED_PROTECTED_PROBES: readonly string[] = [
  "modules/policy/src/gateway.ts",
  "modules/owner-controls/src/service.ts",
  "modules/self-modification/src/policy.ts",
  "modules/tool-gateway/src/gateway.ts",
  "modules/core/src/db/migrations/001_init.sql",
  ".github/workflows/ci.yml",
  "infra/local/docker-compose.yml",
  "package.json",
  "apps/api/package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".env",
  ".env.production",
  "docs/security/SECURITY_MODEL.md",
  "CLAUDE.md",
  "config/evolution/constitution.v1.json",
  "config/evolution/constitution.v1.sig",
  "config/evolution/constitution.pub.pem",
  "ops/security/sign-constitution.mjs",
  "ops/break-glass/freeze-jarvis.sh"
];

/**
 * EV-0 budsjettlåser (plan kap. 6): grenser for hvor mye Evolution-motoren kan gjøre uten eieren. Ligger i det SIGNERTE manifestet - altså
 * kan Evolution aldri heve dem selv (E3 `raise_own_authority_or_budget_limits`); å heve en grense krever at eieren signerer et nytt manifest offline.
 */
export const BudgetCapsSchema = z
  .object({
    /** Automatiske (E1) merger pr. UTC-døgn. */
    max_auto_merges_per_day: z.number().int().min(0),
    /** Deploys (alle klasser) pr. UTC-døgn. */
    max_deploys_per_day: z.number().int().min(0),
    /** Nye E2-forslag som sendes til eieren pr. UTC-døgn (eierens tid er et budsjett). */
    max_owner_proposals_per_day: z.number().int().min(0),
    /** Evolution-kost (modell/research) pr. kalendermåned, i øre. */
    max_evolution_cost_ore_per_month: z.number().int().min(0)
  })
  .strict();
export type BudgetCaps = z.infer<typeof BudgetCapsSchema>;

/** Harde tak i koden: selv et signert manifest kan ikke sette grensene høyere (`constitution_weakened`). */
export const BUDGET_HARD_CEILINGS: Readonly<BudgetCaps> = Object.freeze({
  max_auto_merges_per_day: 20,
  max_deploys_per_day: 10,
  max_owner_proposals_per_day: 50,
  max_evolution_cost_ore_per_month: 100_000
});

export const ConstitutionManifestSchema = z
  .object({
    schema_version: z.literal(1),
    constitution_id: z.string().min(1).max(80),
    /** Monoton økende; kjøretiden nekter nedgradering mot `minVersion` (rollback-vern). */
    version: z.number().int().min(1),
    issued_at: z.string().datetime(),
    issued_by: z.string().min(1).max(80),
    protected_paths: z.array(PathRuleSchema).min(1).max(200),
    /** Eksakte stier som kan gi E1 (canary). Må være delmengde av den hardkodede `ZERO_REVIEW_ALLOWLIST`. */
    e1_allowlist: z.array(z.string().min(1).max(200)).max(20),
    e3_actions: z.array(z.string().min(1).max(80)).min(1).max(50),
    budget_caps: BudgetCapsSchema
  })
  .strict();
export type ConstitutionManifest = z.infer<typeof ConstitutionManifestSchema>;

export type ConstitutionErrorCode =
  | "constitution_missing"
  | "constitution_unsigned"
  | "constitution_key_not_pinned"
  | "constitution_key_mismatch"
  | "constitution_signature_invalid"
  | "constitution_invalid"
  | "constitution_weakened"
  | "constitution_rollback";

export class ConstitutionError extends Error {
  constructor(readonly code: ConstitutionErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.name = "ConstitutionError";
  }
}

/** Deterministisk serialisering (sorterte nøkler, ingen mellomrom) - det som signeres. */
export function canonicalizeManifest(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function publicKeyFingerprint(key: KeyObject): string {
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

function matchesRule(rule: PathRule, path: string): boolean {
  switch (rule.kind) {
    case "prefix": return path.startsWith(rule.value);
    case "exact": return path === rule.value;
    case "suffix": return path.endsWith(rule.value);
    case "basename": return path === rule.value || path.endsWith(`/${rule.value}`);
  }
}

export interface Constitution {
  readonly manifest: ConstitutionManifest;
  readonly version: number;
  /** Signerte budsjettgrenser (EV-0). */
  readonly budget: Readonly<BudgetCaps>;
  /** SHA-256 av kanonisk manifest - skrives i endringsregisteret så hver endring kan knyttes til konstitusjonen som gjaldt. */
  readonly digest: string;
  /** E1/E2/E3 for en kode-diff. Tom diff og alt som ikke kan normaliseres trygt er E3. Aldri svakere enn `classifySelfModification`. */
  classify(changedPaths: readonly string[]): EvChangeClass;
  /** Er handlingen forbudt for Evolution Engine (E3)? Ukjent handling = ikke forbudt her, men aldri auto (se `isActionForbidden`-bruk). */
  isActionForbidden(action: string): boolean;
}

/** Bygger en Constitution fra et allerede VERIFISERT manifest. Kaster `constitution_invalid`/`constitution_weakened`. */
export function buildConstitution(raw: unknown): Constitution {
  const parsed = ConstitutionManifestSchema.safeParse(raw);
  if (!parsed.success) throw new ConstitutionError("constitution_invalid", parsed.error.issues[0]?.message ?? "schema");
  const manifest = parsed.data;

  const protectedBy = (path: string): boolean => manifest.protected_paths.some((rule) => matchesRule(rule, path));
  for (const probe of REQUIRED_PROTECTED_PROBES) {
    if (!protectedBy(probe)) throw new ConstitutionError("constitution_weakened", `unprotected:${probe}`);
  }
  for (const action of REQUIRED_E3_ACTIONS) {
    if (!manifest.e3_actions.includes(action)) throw new ConstitutionError("constitution_weakened", `e3_action_missing:${action}`);
  }
  for (const path of manifest.e1_allowlist) {
    if (!ZERO_REVIEW_ALLOWLIST.has(path)) throw new ConstitutionError("constitution_weakened", `e1_not_in_hardcoded_allowlist:${path}`);
    if (protectedBy(path)) throw new ConstitutionError("constitution_invalid", `e1_path_is_protected:${path}`);
  }

  for (const key of Object.keys(BUDGET_HARD_CEILINGS) as Array<keyof BudgetCaps>) {
    if (manifest.budget_caps[key] > BUDGET_HARD_CEILINGS[key]) throw new ConstitutionError("constitution_weakened", `budget_above_ceiling:${key}`);
  }

  const e1 = new Set(manifest.e1_allowlist);
  const digest = createHash("sha256").update(canonicalizeManifest(manifest)).digest("hex");

  return {
    manifest,
    version: manifest.version,
    budget: Object.freeze({ ...manifest.budget_caps }),
    digest,
    classify(changedPaths) {
      if (changedPaths.length === 0) return "E3";
      const normalized = changedPaths.map(normalizeChangedPath);
      // Strengeste vinner: hardkodet (policy.ts) OG manifestet må begge tillate, ellers blir klassen den strengeste av dem.
      const legacy = classifySelfModification(changedPaths);
      if (legacy === "forbidden" || normalized.some((p) => protectedBy(p) || FORBIDDEN_PATH_PATTERNS.some((rx) => rx.test(p)))) {
        return "E3";
      }
      if (legacy === "zero_review" && normalized.every((p) => e1.has(p))) return "E1";
      return "E2";
    },
    isActionForbidden(action) {
      return manifest.e3_actions.includes(action);
    }
  };
}

export interface VerifyConstitutionInput {
  manifestJson: string;
  /** Base64-kodet Ed25519-signatur over `canonicalizeManifest(manifest)`. */
  signatureB64: string | null;
  publicKeyPem: string | null;
  /** SHA-256 (hex) av SPKI-DER for eierens offentlige nøkkel - festet i miljøet, utenfor repoet. */
  pinnedPublicKeySha256: string | null;
  /** Laveste akseptable versjon (rollback-vern). */
  minVersion?: number;
}

/** Ren verifisering uten I/O - fail-closed. Kaster `ConstitutionError`. */
export function verifyConstitution(input: VerifyConstitutionInput): Constitution {
  if (input.signatureB64 === null || input.signatureB64.trim() === "") throw new ConstitutionError("constitution_unsigned");
  if (input.publicKeyPem === null || input.publicKeyPem.trim() === "") throw new ConstitutionError("constitution_unsigned", "no_public_key");
  const pinned = input.pinnedPublicKeySha256?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(pinned)) throw new ConstitutionError("constitution_key_not_pinned");

  let key: KeyObject;
  try {
    key = createPublicKey(input.publicKeyPem);
  } catch {
    throw new ConstitutionError("constitution_invalid", "public_key");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new ConstitutionError("constitution_invalid", "key_type");
  if (publicKeyFingerprint(key) !== pinned) throw new ConstitutionError("constitution_key_mismatch");

  let raw: unknown;
  try {
    raw = JSON.parse(input.manifestJson);
  } catch {
    throw new ConstitutionError("constitution_invalid", "json");
  }
  let ok = false;
  try {
    ok = cryptoVerify(null, Buffer.from(canonicalizeManifest(raw), "utf8"), key, Buffer.from(input.signatureB64.trim(), "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw new ConstitutionError("constitution_signature_invalid");

  const constitution = buildConstitution(raw);
  if (input.minVersion !== undefined && constitution.version < input.minVersion) {
    throw new ConstitutionError("constitution_rollback", `${constitution.version}<${input.minVersion}`);
  }
  return constitution;
}

export interface LoadConstitutionInput {
  manifestPath: string;
  signaturePath: string;
  publicKeyPath: string;
  pinnedPublicKeySha256: string | null;
  minVersion?: number;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Leser og verifiserer fra disk. Mangler manifestet: `constitution_missing`; mangler signatur/nøkkel: `constitution_unsigned`. */
export async function loadConstitution(input: LoadConstitutionInput): Promise<Constitution> {
  const manifestJson = await readOptional(input.manifestPath);
  if (manifestJson === null) throw new ConstitutionError("constitution_missing");
  return verifyConstitution({
    manifestJson,
    signatureB64: await readOptional(input.signaturePath),
    publicKeyPem: await readOptional(input.publicKeyPath),
    pinnedPublicKeySha256: input.pinnedPublicKeySha256,
    ...(input.minVersion !== undefined ? { minVersion: input.minVersion } : {})
  });
}
