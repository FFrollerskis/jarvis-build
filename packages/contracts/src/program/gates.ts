import { z } from "zod";
import { compareFindings, type Finding } from "./findings.ts";
import { canonicalJson } from "./hash.ts";
import { GATE_ID_PATTERN, GateIdSchema, GateStatusSchema, OperationalGateChangedPayloadSchema, ORL_ID_PATTERN, OrlIdSchema, type GateStatus } from "./gate-events.ts";
import { ComponentIdSchema, EvidenceRefSchema, type EvidenceRef } from "./schema.ts";

/**
 * WP-PGA / PG3 (HF6 §26-27, D-PROG-08, H6-PG10/OR01): Program Completion-portene (17) og Operational Readiness Levels (ORL0-5) som DATA. Alle står OPEN i dag; en port kan bare stå PASS med en
 * gjenverifiserbar `evidence_ref` (sti + sha256 + git-SHA), og er OPEN igjen så snart en bundet komponents kontrakt er endret etter evidensen (staleness-regelen).
 *
 * Data bor i `config/program/gates/G01.json ... G17.json` og `config/program/orl/ORL0.json ... ORL5.json` (én fil per port: parallelle evidensregistreringer berører ulike filer).
 * Tekstene i dataene er egne, korte formuleringer (ikke planens ordlyd). Ren modul: ingen filsystem; hashen av evidensfilen gis inn av kalleren.
 */
export const PROGRAM_GATE_IDS = Array.from({ length: 17 }, (_, i) => `G${String(i + 1).padStart(2, "0")}`) as readonly string[];
export const ORL_IDS = ["ORL0", "ORL1", "ORL2", "ORL3", "ORL4", "ORL5"] as const;

const TEXT = (min: number, max: number) => z.string().min(min).max(max);
const HistorySchema = z.array(OperationalGateChangedPayloadSchema).max(200);

/** Felles invarianter for en ports/nivås tilstand: PASS krever evidens, og historikken er en ubrutt, tidsmessig stigende kjede som ender i gjeldende status og evidens. */
function validateState(
  g: { id: string; kind: "program_gate" | "orl"; status: GateStatus; evidence_ref: EvidenceRef | null; history: ReadonlyArray<z.infer<typeof OperationalGateChangedPayloadSchema>>; bound_components: readonly string[] },
  ctx: z.RefinementCtx
): void {
  const add = (path: (string | number)[], message: string): void => ctx.addIssue({ code: "custom", path, message });
  if (g.status === "PASS" && g.evidence_ref === null) add(["evidence_ref"], "PASS krever en evidence_ref (D-PROG-08)");
  if (new Set(g.bound_components).size !== g.bound_components.length) add(["bound_components"], "duplikate bundne komponenter");
  if (g.history.length === 0) {
    if (g.status !== "OPEN") add(["status"], "en port uten historikk er OPEN");
    if (g.evidence_ref !== null) add(["evidence_ref"], "en port uten historikk har ingen evidens");
    return;
  }
  let prev: GateStatus = "OPEN";
  let prevAt = "";
  g.history.forEach((h, i) => {
    if (h.gate_id !== g.id) add(["history", i, "gate_id"], "oppføringen tilhører en annen port");
    if (h.gate_kind !== g.kind) add(["history", i, "gate_kind"], "oppføringen har feil gate_kind");
    if (h.prior_status !== prev) add(["history", i, "prior_status"], `kjeden er brutt: forrige status skal være ${prev}`);
    if (prevAt !== "" && Date.parse(h.changed_at) < Date.parse(prevAt)) add(["history", i, "changed_at"], "historikken må være tidsmessig stigende");
    prev = h.new_status;
    prevAt = h.changed_at;
  });
  const last = g.history[g.history.length - 1]!;
  if (last.new_status !== g.status) add(["status"], "status må være siste overgangs nye status");
  const expected = last.evidence_refs[0] ?? null;
  const same = (expected === null && g.evidence_ref === null) || (expected !== null && g.evidence_ref !== null && canonicalJson(expected) === canonicalJson(g.evidence_ref));
  if (!same) add(["evidence_ref"], "evidence_ref må være siste overgangs evidens (og tom ved gjenåpning)");
}

const GateStateFields = {
  title: TEXT(3, 80),
  /** Eget, kort kriterium (ikke planens ordlyd): hva som må være bevist for PASS. */
  pass_criterion: TEXT(10, 300),
  /** Komponenter hvis kontraktendring åpner porten igjen. */
  bound_components: z.array(ComponentIdSchema).max(40),
  /** Krever NAS-kjøring, pilot, eier-signoff eller annen handling som ikke kan kodes i repoet. */
  external: z.boolean(),
  status: GateStatusSchema,
  evidence_ref: EvidenceRefSchema.nullable(),
  history: HistorySchema
};

export const GateSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    kind: z.literal("program_gate"),
    id: GateIdSchema,
    number: z.number().int().min(1).max(17),
    ...GateStateFields
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.id !== `G${String(g.number).padStart(2, "0")}`) ctx.addIssue({ code: "custom", path: ["number"], message: "id og number må høre sammen" });
    validateState({ ...g, kind: "program_gate" }, ctx);
  });
export type Gate = z.infer<typeof GateSchema>;

export const OrlSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    kind: z.literal("orl"),
    id: OrlIdSchema,
    level: z.number().int().min(0).max(5),
    ...GateStateFields,
    /** Eget kriterium (ikke planens ordlyd) for å forlate nivået. */
    exit_criterion: TEXT(10, 300),
    /** Nivåene er kumulative: hvert nivå krever det forrige (ORL0 ingen). */
    requires_orl: OrlIdSchema.nullable(),
    requires_gates: z.array(GateIdSchema).max(17)
  })
  .omit({ pass_criterion: true })
  .strict()
  .superRefine((o, ctx) => {
    if (o.id !== `ORL${o.level}`) ctx.addIssue({ code: "custom", path: ["level"], message: "id og level må høre sammen" });
    const expectedPrev = o.level === 0 ? null : `ORL${o.level - 1}`;
    if (o.requires_orl !== expectedPrev) ctx.addIssue({ code: "custom", path: ["requires_orl"], message: `nivå ${o.level} krever ${expectedPrev ?? "ingen"}` });
    if (new Set(o.requires_gates).size !== o.requires_gates.length) ctx.addIssue({ code: "custom", path: ["requires_gates"], message: "duplikate krevde porter" });
    validateState({ ...o, kind: "orl" }, ctx);
  });
export type Orl = z.infer<typeof OrlSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Evaluering: effektiv status (staleness-regelen)
// ---------------------------------------------------------------------------------------------------------------------
export interface GateContext {
  /** Komponentens nåværende kontraktfingeravtrykk og siste kontraktendring (null = ukjent/ingen). `undefined` = komponenten finnes ikke i indeksen. */
  component: (id: string) => { contract_fingerprint: string | null; changed_at: string | null } | undefined;
  /** sha256 (hex) av evidensfilen slik den ligger nå; null hvis den ikke finnes. */
  evidence_sha256: (path: string) => string | null;
}

export type GateReason =
  | { code: "evidence_missing" }
  | { code: "evidence_file_missing"; path: string }
  | { code: "evidence_hash_mismatch"; path: string }
  | { code: "component_unknown"; component_id: string }
  | { code: "stale_contract_changed_after_evidence"; component_id: string; changed_at: string; verified_at: string }
  | { code: "stale_fingerprint_changed"; component_id: string }
  | { code: "stale_binding_missing"; component_id: string }
  | { code: "prerequisite_not_pass"; prerequisite: string };

export interface GateEvaluation {
  declared: GateStatus;
  effective: GateStatus;
  reasons: GateReason[];
}

/** Bevis- og ferskhetssjekk for en deklarert PASS. Tom liste = beviset holder. */
function proveFresh(g: { evidence_ref: EvidenceRef | null; bound_components: readonly string[] }, ctx: GateContext): GateReason[] {
  const e = g.evidence_ref;
  if (e === null) return [{ code: "evidence_missing" }];
  const reasons: GateReason[] = [];
  const actual = ctx.evidence_sha256(e.path);
  if (actual === null) reasons.push({ code: "evidence_file_missing", path: e.path });
  else if (actual !== e.sha256) reasons.push({ code: "evidence_hash_mismatch", path: e.path });
  for (const id of g.bound_components) {
    const c = ctx.component(id);
    if (c === undefined) {
      reasons.push({ code: "component_unknown", component_id: id });
      continue;
    }
    if (!Object.hasOwn(e.contract_fingerprints, id)) reasons.push({ code: "stale_binding_missing", component_id: id });
    else if (e.contract_fingerprints[id] !== c.contract_fingerprint) reasons.push({ code: "stale_fingerprint_changed", component_id: id });
    if (c.changed_at !== null && Date.parse(c.changed_at) > Date.parse(e.verified_at)) {
      reasons.push({ code: "stale_contract_changed_after_evidence", component_id: id, changed_at: c.changed_at, verified_at: e.verified_at });
    }
  }
  return reasons;
}

export function evaluateGate(gate: Pick<Gate, "status" | "evidence_ref" | "bound_components">, ctx: GateContext): GateEvaluation {
  if (gate.status !== "PASS") return { declared: gate.status, effective: gate.status, reasons: [] };
  const reasons = proveFresh(gate, ctx);
  return { declared: "PASS", effective: reasons.length === 0 ? "PASS" : "OPEN", reasons };
}

export function evaluateOrl(orl: Pick<Orl, "status" | "evidence_ref" | "bound_components" | "requires_gates" | "requires_orl">, ctx: GateContext, gateEffective: (id: string) => GateStatus, orlEffective: (id: string) => GateStatus): GateEvaluation {
  if (orl.status !== "PASS") return { declared: orl.status, effective: orl.status, reasons: [] };
  const reasons = proveFresh(orl, ctx);
  for (const g of orl.requires_gates) if (gateEffective(g) !== "PASS") reasons.push({ code: "prerequisite_not_pass", prerequisite: g });
  if (orl.requires_orl !== null && orlEffective(orl.requires_orl) !== "PASS") reasons.push({ code: "prerequisite_not_pass", prerequisite: orl.requires_orl });
  return { declared: "PASS", effective: reasons.length === 0 ? "PASS" : "OPEN", reasons };
}

// ---------------------------------------------------------------------------------------------------------------------
// Skanning av port-/ORL-dataene
// ---------------------------------------------------------------------------------------------------------------------
export const GATE_RULES = ["gate_set_incomplete", "gate_unknown_component", "gate_stale", "gate_evidence_invalid", "gate_prerequisite_violation"] as const;
export type GateRule = (typeof GATE_RULES)[number];

const EVIDENCE_CODES = new Set(["evidence_missing", "evidence_file_missing", "evidence_hash_mismatch"]);
const STALE_CODES = new Set(["stale_contract_changed_after_evidence", "stale_fingerprint_changed", "stale_binding_missing"]);

export interface GateScanInput {
  gates: readonly Gate[];
  orls: readonly Orl[];
  /** Komponent-id-ene som finnes i indeksen. */
  component_ids: ReadonlySet<string>;
  ctx: GateContext;
}

export function scanGates(input: GateScanInput): Finding[] {
  const found = new Map<string, Finding>();
  const add = (rule: GateRule, subject: string, message: string): void => {
    const id = `${rule}:${subject}`;
    if (!found.has(id)) found.set(id, { rule, component_id: null, subject, id, message });
  };
  const gateById = new Map(input.gates.map((g) => [g.id, g]));
  const orlById = new Map(input.orls.map((o) => [o.id, o]));
  for (const id of PROGRAM_GATE_IDS) if (!gateById.has(id)) add("gate_set_incomplete", id, `programporten ${id} mangler i config/program/gates (alle 17 skal finnes)`);
  for (const id of ORL_IDS) if (!orlById.has(id)) add("gate_set_incomplete", id, `nivået ${id} mangler i config/program/orl (alle seks skal finnes)`);

  const classify = (id: string, e: GateEvaluation): void => {
    if (e.reasons.some((r) => EVIDENCE_CODES.has(r.code))) add("gate_evidence_invalid", id, `${id} står som PASS, men evidensen kan ikke gjenverifiseres (fil mangler, hash avviker eller evidens mangler)`);
    else if (e.reasons.some((r) => STALE_CODES.has(r.code))) add("gate_stale", id, `${id} står som PASS, men er OPEN igjen: en bundet komponent er endret etter evidensen (${e.reasons.filter((r) => STALE_CODES.has(r.code)).map((r) => ("component_id" in r ? `${r.code}:${r.component_id}` : r.code)).join(", ")})`);
  };
  const effectiveGate = new Map<string, GateStatus>();
  for (const g of input.gates) {
    for (const c of g.bound_components) if (!input.component_ids.has(c)) add("gate_unknown_component", `${g.id}:${c}`, `${g.id} er bundet til ${c}, som ikke finnes i indeksen`);
    const e = evaluateGate(g, input.ctx);
    effectiveGate.set(g.id, e.effective);
    classify(g.id, e);
  }
  const effectiveOrl = new Map<string, GateStatus>();
  for (const o of [...input.orls].sort((a, b) => a.level - b.level)) {
    for (const c of o.bound_components) if (!input.component_ids.has(c)) add("gate_unknown_component", `${o.id}:${c}`, `${o.id} er bundet til ${c}, som ikke finnes i indeksen`);
    const e = evaluateOrl(o, input.ctx, (id) => effectiveGate.get(id) ?? "OPEN", (id) => effectiveOrl.get(id) ?? "OPEN");
    effectiveOrl.set(o.id, e.effective);
    classify(o.id, e);
    for (const r of e.reasons) if (r.code === "prerequisite_not_pass") add("gate_prerequisite_violation", `${o.id}:${r.prerequisite}`, `${o.id} står som PASS, men ${r.prerequisite} er ikke PASS`);
  }
  return [...found.values()].sort(compareFindings);
}

export { GATE_ID_PATTERN, ORL_ID_PATTERN };
