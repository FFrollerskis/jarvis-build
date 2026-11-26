import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { FORBIDDEN_PATH_PATTERNS, ZERO_REVIEW_ALLOWLIST, classifySelfModification, isInvalidPathKey, normalizeChangedPath, protectionKey } from "./policy.ts";

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

/**
 * Handlinger Evolution Engine aldri kan utføre (plan kap. 7, E3). Alle må stå i et gyldig manifest - gulvet er monotont (en handling fjernes aldri).
 * De seks første er den opprinnelige E3-listen; de sju siste (WP-EV0, før første signering) er handlinger planen nevner som forbudt for motoren
 * (kap. 5/6/13/28), men som manglet i gulvet: å rotere/eksportere break-glass-nøkkelen, å deaktivere en alarm, å godkjenne egen endring, å skrive til
 * beskyttet gren, å heve autonominivå og å endre protected-path-manifestet utenom eier-prosessen.
 */
export const REQUIRED_E3_ACTIONS: readonly string[] = [
  "raise_own_authority_or_budget_limits",
  "modify_kill_switch",
  "modify_approval_verifier",
  "modify_audit_integrity",
  "read_break_glass_key",
  "grant_self_root",
  "rotate_break_glass_key",
  "export_break_glass_key",
  "disable_security_alarm",
  "self_approve_change",
  "push_to_protected_branch",
  "raise_autonomy_level",
  "modify_protected_path_manifest"
];

/**
 * Stier som ALLTID må være beskyttet (E3) i ethvert gyldig manifest - sonder mot de hardkodede mønstrene pluss
 * constitution-filene selv. Et signert, men svekket manifest avvises (`constitution_weakened`).
 *
 * Gulvet er MONOTONT: en sonde fjernes aldri (de 20 første er den opprinnelige listen; `modules/policy/src/gateway.ts` er et gammelt filnavn som
 * beholdes). Tilleggene (WP-EV0, før første signering) dekker Authority Plane-listen i HF2 kap. 5: policy-gatewayen/godkjenningsverifisereren/kill switch,
 * klasse D-kjeden og modellflaten, step-up, revisjonsintegritet, godkjenningslager og identitets-/sesjons-/enhetsautoritet, databasens tenant-kontekst,
 * confidence-gaten, program-indeksen, containment/backup/worker-isolasjon og ADR-ene. Testet: hver sonde er forbudt av de hardkodede mønstrene ALENE, og hvert
 * mønster treffes av en sonde. Sondene er representative filer - selve beskyttelsen er mønstrene/prefiksene (så en omdøpt fil faller fortsatt under prefikset).
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
  "ops/break-glass/freeze-jarvis.sh",
  // --- WP-EV0 ---
  "modules/policy/src/policy-gateway.ts",
  "modules/policy/src/approval-verifier.ts",
  "modules/policy/src/kill-switch.ts",
  "modules/tool-gateway/src/class-d-pipeline.ts",
  "modules/tool-gateway/src/finance-class-d.ts",
  "modules/tool-gateway/src/model-tool-surface.ts",
  "apps/api/src/step-up.ts",
  "modules/core/src/services/audit-writer.ts",
  "modules/core/src/services/policy-audit-sink.ts",
  "modules/core/src/services/approval-store.ts",
  "modules/core/src/services/identity-service.ts",
  "modules/core/src/services/session-grant-service.ts",
  "modules/core/src/services/device-authority.ts",
  "modules/core/src/services/channel-session-authority.ts",
  "modules/core/src/services/voice-session-authority.ts",
  "modules/core/src/services/telegram-owner-authority.ts",
  "modules/core/src/services/runtime-role.ts",
  "modules/core/src/db/pool.ts",
  "modules/executive/src/self-model/confidence-gate.ts",
  "config/program/index.json",
  "docs/remediation/ADR-001-dokumenthierarki.md",
  "docs/SECURITY_MODEL.md",
  "docs/CANONICAL_SPEC.md",
  "modules/core/src/db/migrations/001_identity.sql",
  "ops/security/check-containment.mjs",
  "ops/backup/jarvis-backup.mjs",
  "ops/job-runner/egress-proxy.mjs",
  "ops/job-runner/credential-helper.mjs",
  "ops/claude-worker/worker.mjs"
];

/** Kostnadskategorier for Evolution-motoren (HF2 kap. 29): hver har et eget månedstak i det signerte manifestet; totalen har `max_evolution_cost_ore_per_month`. */
export const EVOLUTION_COST_CATEGORIES = ["radar", "eval", "redteam", "shadow", "review"] as const;
export type EvolutionCostCategory = (typeof EVOLUTION_COST_CATEGORIES)[number];

/** Hvilket `budget_caps`-felt som er taket (øre pr. kalendermåned) for hver kategori. */
export const CATEGORY_CAP_KEYS = {
  radar: "max_radar_cost_ore_per_month",
  eval: "max_eval_cost_ore_per_month",
  redteam: "max_redteam_cost_ore_per_month",
  shadow: "max_shadow_cost_ore_per_month",
  review: "max_review_cost_ore_per_month"
} as const satisfies Record<EvolutionCostCategory, string>;

const capInt = z.number().int().min(0);

/**
 * EV-0 budsjettlåser (plan kap. 6 og 29): grenser for hvor mye Evolution-motoren kan gjøre uten eieren. Ligger i det SIGNERTE manifestet - altså
 * kan Evolution aldri heve dem selv (E3 `raise_own_authority_or_budget_limits`); å heve en grense krever at eieren signerer et nytt manifest offline.
 * Manifestet er KILDEN (øre/minutter); `docs/PROJECT_STATUS.md` er kun en generert visning (WP-EV0, PC2). Hvert felt er påkrevd - ingen stille standard.
 */
export const BudgetCapsSchema = z
  .object({
    /** Automatiske (E1) merger pr. UTC-døgn. */
    max_auto_merges_per_day: capInt,
    /** Deploys (alle klasser) pr. UTC-døgn. */
    max_deploys_per_day: capInt,
    /** Deploys (alle klasser) pr. hel UTC-time (HF2 kap. 15: deploybudsjett pr. time OG døgn). Kan ikke overstige døgnet. */
    max_deploys_per_hour: capInt,
    /** Nye E2-forslag som sendes til eieren pr. UTC-døgn (eierens tid er et budsjett). */
    max_owner_proposals_per_day: capInt,
    /** TOTAL Evolution-kost (modell/research) pr. kalendermåned, i øre. Kategoritakene under summerer til høyst dette. */
    max_evolution_cost_ore_per_month: capInt,
    /** Kategori-tak pr. kalendermåned, i øre (se `CATEGORY_CAP_KEYS`): radar, eval, red team, shadow/canary, uavhengig review. */
    max_radar_cost_ore_per_month: capInt,
    max_eval_cost_ore_per_month: capInt,
    max_redteam_cost_ore_per_month: capInt,
    max_shadow_cost_ore_per_month: capInt,
    max_review_cost_ore_per_month: capInt,
    /** Eierens tidsbudsjett for Evolution (godkjenninger, merking, review, styring), minutter pr. UTC-ISO-uke (mandag 00:00). */
    owner_time_budget_minutes_per_week: capInt,
    /** Maks eier-minutter pr. autonom endring (summert over endringens levetid). Kan ikke overstige ukebudsjettet. */
    max_owner_minutes_per_autonomous_change: capInt
  })
  .strict();
export type BudgetCaps = z.infer<typeof BudgetCapsSchema>;

/**
 * Harde tak i koden: selv et signert manifest kan ikke sette grensene høyere (`constitution_weakened`). Evolution totalt ≤ 1000 kr/mnd
 * (ADR-001 §2.3 pkt 4: 3000 kr/mnd for hele Jarvis). Hvert felt MÅ ha et tak (testet: nøklene er identiske med skjemaets).
 * Kategoritakene har samme tak som totalen: det som binder er summeregelen (kategorier ≤ total), ikke et eget kategoritak.
 */
export const BUDGET_HARD_CEILINGS: Readonly<BudgetCaps> = Object.freeze({
  max_auto_merges_per_day: 20,
  max_deploys_per_day: 10,
  max_deploys_per_hour: 3,
  max_owner_proposals_per_day: 50,
  max_evolution_cost_ore_per_month: 100_000,
  max_radar_cost_ore_per_month: 100_000,
  max_eval_cost_ore_per_month: 100_000,
  max_redteam_cost_ore_per_month: 100_000,
  max_shadow_cost_ore_per_month: 100_000,
  max_review_cost_ore_per_month: 100_000,
  owner_time_budget_minutes_per_week: 600,
  max_owner_minutes_per_autonomous_change: 60
});

export const ConstitutionManifestSchema = z
  .object({
    /** 2 = WP-EV0 (HF2 EV-0): kategori-tak, eier-tid og deploys pr. time. Format 1 (4 felt) ble aldri signert og avvises. */
    schema_version: z.literal(2),
    constitution_id: z.string().min(1).max(80),
    /** Monoton økende; kjøretiden nekter nedgradering mot `minVersion` (rollback-vern). */
    version: z.number().int().min(1),
    issued_at: z.string().datetime(),
    issued_by: z.string().min(1).max(80),
    /** Fri tekst som signeres sammen med resten (f.eks. utkast-merknad). Aldri maskinlest som regel. */
    notes: z.string().min(1).max(2000).optional(),
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

/**
 * Regelverdier og stier sammenlignes i FOLDET form (`protectionKey`: små bokstaver, NFKC, ingen `.`-segmenter): en regel som ikke kan foldes (ugyldig) treffer
 * ingenting (fail-safe: de hardkodede mønstrene gjelder uansett). `path` er allerede en nøkkel.
 */
function matchesRule(rule: PathRule, key: string): boolean {
  const value = protectionKey(rule.value);
  if (isInvalidPathKey(value)) return false;
  switch (rule.kind) {
    case "prefix": return key.startsWith(value);
    case "exact": return key === value;
    case "suffix": return key.endsWith(value);
    case "basename": return key === value || key.endsWith(`/${value}`);
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

  const protectedBy = (path: string): boolean => {
    const key = protectionKey(path);
    return !isInvalidPathKey(key) && manifest.protected_paths.some((rule) => matchesRule(rule, key));
  };
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
  // Koherens (etter takene, så et tak-brudd alltid vinner): manifestet må ikke love mer enn det selv tillater.
  const caps = manifest.budget_caps;
  const categorySum = EVOLUTION_COST_CATEGORIES.reduce((n, c) => n + caps[CATEGORY_CAP_KEYS[c]], 0);
  if (categorySum > caps.max_evolution_cost_ore_per_month) throw new ConstitutionError("constitution_invalid", "budget_categories_exceed_total");
  if (caps.max_deploys_per_hour > caps.max_deploys_per_day) throw new ConstitutionError("constitution_invalid", "deploys_per_hour_above_per_day");
  if (caps.max_owner_minutes_per_autonomous_change > caps.owner_time_budget_minutes_per_week) {
    throw new ConstitutionError("constitution_invalid", "owner_change_minutes_above_weekly_budget");
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
      // En sti som ikke kan normaliseres trygt er E3 (WP-EV0): aldri en «godkjenn»-vei for en endring som kan skjule en beskyttet fil.
      const keys = changedPaths.map(protectionKey);
      if (keys.some(isInvalidPathKey)) return "E3";
      // Strengeste vinner: hardkodet (policy.ts) OG manifestet må begge tillate, ellers blir klassen den strengeste av dem.
      const legacy = classifySelfModification(changedPaths);
      if (legacy === "forbidden" || keys.some((k) => manifest.protected_paths.some((rule) => matchesRule(rule, k)) || FORBIDDEN_PATH_PATTERNS.some((rx) => rx.test(k)))) {
        return "E3";
      }
      // E1-allowlisten er EKSAKT (som `ZERO_REVIEW_ALLOWLIST`): kun nøyaktig den navngitte filen.
      const normalized = changedPaths.map(normalizeChangedPath);
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
