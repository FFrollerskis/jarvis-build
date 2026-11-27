import { z } from "zod";
import { compareFindings, type Finding } from "./findings.ts";
import { evidenceWeaknesses, type EvidenceFacts, type EvidenceWeakness, WEAKNESS_TEXT } from "./evidence-header.ts";
import { canonicalJson, contractFingerprint } from "./hash.ts";
import { GATE_ID_PATTERN, GateIdSchema, GateStatusSchema, OperationalGateChangedPayloadSchema, ORL_ID_PATTERN, OrlIdSchema, type GateStatus } from "./gate-events.ts";
import { ComponentIdSchema, EvidenceRefSchema, type ComponentShard, type EvidenceRef } from "./schema.ts";

/**
 * WP-PGA / PG3 (HF6 §26-27, PGA-D-08, H6-PG10/OR01): Program Completion-portene (17) og Operational Readiness Levels (ORL0-5) som DATA. Alle står OPEN i dag; en port kan bare stå PASS med en
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
  if (g.status === "PASS" && g.evidence_ref === null) add(["evidence_ref"], "PASS krever en evidence_ref (PGA-D-08)");
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
/** En bundet komponents tilstand slik portene ser den. */
export interface GateComponentState {
  /** Fingeravtrykket som er LAGRET i skjerven. */
  contract_fingerprint: string | null;
  changed_at: string | null;
  /**
   * Fingeravtrykket regnet fra kontraktfilene NÅ (M3): `null` = komponenten har ingen kontraktfiler, `"unreadable"` = minst én fil mangler eller kan ikke leses (teller som foreldet). `undefined` = ikke
   * målt (kun hånd-bygde kontekster i tester; `makeGateContext` setter alltid en verdi).
   */
  live_fingerprint?: string | null;
}

/** Verdien `live_fingerprint` har når en kontraktfil ikke kan leses: aldri lik et ekte fingeravtrykk, så en slik komponent er alltid foreldet. */
export const UNREADABLE_CONTRACT = "unreadable" as const;

export interface GateContext {
  /** Komponentens tilstand (lagret fingeravtrykk, live fingeravtrykk og siste kontraktendring). `undefined` = komponenten finnes ikke i indeksen. */
  component: (id: string) => GateComponentState | undefined;
  /** sha256 (hex) av evidensfilen slik den ligger nå; null hvis den ikke finnes. */
  evidence_sha256: (path: string) => string | null;
  /** Toppteksten i evidensfilen slik den ligger nå (til vurdering av evidensstyrke, M2); null hvis den ikke finnes/kan leses. */
  evidence_facts: (path: string) => EvidenceFacts | null;
}

/** Kildene `makeGateContext` trenger fra repoet: filhash (evidens og kontraktfiler) og evidensens topptekst. */
export interface GateReader {
  file_sha256: (path: string) => string | null;
  evidence_facts: (path: string) => EvidenceFacts | null;
}

/**
 * Bygger `GateContext` fra komponentene og en leser av filer. Felles for orkestratoren og registreringsverktøyet. Fingeravtrykket regnes LIVE fra kontraktfilene (M3, lazy og cachet per komponent),
 * så en kontraktfil som er endret uten `fingerprint --write` åpner porten med en gang: lagret fingeravtrykk alene er ikke nok.
 */
export function makeGateContext(components: ReadonlyArray<Pick<ComponentShard, "component_id" | "contract">>, reader: GateReader): GateContext {
  const byId = new Map(components.map((c) => [c.component_id, c]));
  const live = new Map<string, string | null>();
  const liveOf = (c: Pick<ComponentShard, "component_id" | "contract">): string | null => {
    if (live.has(c.component_id)) return live.get(c.component_id) as string | null;
    let value: string | null;
    if (c.contract.files.length === 0) value = null;
    else {
      const hashes = c.contract.files.map((path) => ({ path, sha256: reader.file_sha256(path) }));
      try {
        value = hashes.some((h) => h.sha256 === null) ? UNREADABLE_CONTRACT : contractFingerprint(hashes.map((h) => ({ path: h.path, sha256: h.sha256 as string })));
      } catch {
        value = UNREADABLE_CONTRACT;
      }
    }
    live.set(c.component_id, value);
    return value;
  };
  return {
    component: (id) => {
      const c = byId.get(id);
      return c === undefined ? undefined : { contract_fingerprint: c.contract.fingerprint, changed_at: c.contract.changed_at, live_fingerprint: liveOf(c) };
    },
    evidence_sha256: reader.file_sha256,
    evidence_facts: reader.evidence_facts
  };
}

export type GateReason =
  | { code: "evidence_missing" }
  | { code: "evidence_file_missing"; path: string }
  | { code: "evidence_hash_mismatch"; path: string }
  | { code: "component_unknown"; component_id: string }
  | { code: "stale_contract_changed_after_evidence"; component_id: string; changed_at: string; verified_at: string }
  | { code: "stale_fingerprint_changed"; component_id: string }
  | { code: "stale_contract_files_changed"; component_id: string }
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
    // M3: skjervens lagrede fingeravtrykk kan ligge etter filene (ingen har kjørt `fingerprint --write` ennå): sammenlign øyeblikksbildet mot det LIVE fingeravtrykket også. Ulesbar fil = foreldet.
    else if (c.live_fingerprint !== undefined && e.contract_fingerprints[id] !== c.live_fingerprint) reasons.push({ code: "stale_contract_files_changed", component_id: id });
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

/**
 * Svakhetene ved evidensen for en deklarert PASS (M2). Tom liste = sterk evidens. Leser toppteksten i evidensfilen slik den ligger NÅ og vurderer den (exit 0, kjørt av opptakeren, tidspunkt og git-SHA
 * fra filen, rent arbeidstre, ekstern-markør for `external`-porter): `verified_at_source` i dataene stoles ikke på, siden en håndredigert port-fil kan påstå hva som helst.
 */
export function gateWeaknesses(g: Pick<Gate, "evidence_ref" | "external">, ctx: GateContext): EvidenceWeakness[] {
  const e = g.evidence_ref;
  if (e === null) return [];
  const facts = ctx.evidence_facts(e.path);
  if (facts === null) return ["evidence_unreadable"];
  return evidenceWeaknesses(facts, { external: g.external, verified_at: e.verified_at });
}

// ---------------------------------------------------------------------------------------------------------------------
// Skanning av port-/ORL-dataene
// ---------------------------------------------------------------------------------------------------------------------
export const GATE_RULES = ["gate_set_incomplete", "gate_unknown_component", "gate_stale", "gate_evidence_invalid", "gate_prerequisite_violation", "gate_weak_evidence", "gate_bound_untracked_component"] as const;
export type GateRule = (typeof GATE_RULES)[number];

const EVIDENCE_CODES = new Set(["evidence_missing", "evidence_file_missing", "evidence_hash_mismatch"]);
const STALE_CODES = new Set(["stale_contract_changed_after_evidence", "stale_fingerprint_changed", "stale_contract_files_changed", "stale_binding_missing"]);

export interface GateScanInput {
  gates: readonly Gate[];
  orls: readonly Orl[];
  /** Komponent-id-ene som finnes i indeksen. */
  component_ids: ReadonlySet<string>;
  ctx: GateContext;
  /** BYGDE komponenter uten `contract.files` (staleness er blind for dem). En port bundet til en av dem er et funn (L5). Utelatt = ingen. */
  untracked_components?: ReadonlySet<string>;
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
  const untracked = input.untracked_components ?? new Set<string>();
  const checkBindings = (id: string, bound: readonly string[]): void => {
    for (const c of bound) {
      if (!input.component_ids.has(c)) add("gate_unknown_component", `${id}:${c}`, `${id} er bundet til ${c}, som ikke finnes i indeksen`);
      else if (untracked.has(c)) add("gate_bound_untracked_component", `${id}:${c}`, `${id} er bundet til den bygde komponenten ${c}, som ikke har contract.files: uten kontraktfingeravtrykk er foreldelse blind for den (fyll inn contract.files)`);
    }
  };
  const weak = (g: Pick<Gate, "id" | "evidence_ref" | "external">, e: GateEvaluation): void => {
    if (e.effective !== "PASS") return;
    const w = gateWeaknesses(g, input.ctx);
    if (w.length > 0) add("gate_weak_evidence", g.id, `${g.id} står som PASS, men evidensen er svak: ${w.map((x) => WEAKNESS_TEXT[x]).join("; ")}`);
  };
  const effectiveGate = new Map<string, GateStatus>();
  for (const g of input.gates) {
    checkBindings(g.id, g.bound_components);
    const e = evaluateGate(g, input.ctx);
    effectiveGate.set(g.id, e.effective);
    classify(g.id, e);
    weak(g, e);
  }
  const effectiveOrl = new Map<string, GateStatus>();
  for (const o of [...input.orls].sort((a, b) => a.level - b.level)) {
    checkBindings(o.id, o.bound_components);
    const e = evaluateOrl(o, input.ctx, (id) => effectiveGate.get(id) ?? "OPEN", (id) => effectiveOrl.get(id) ?? "OPEN");
    effectiveOrl.set(o.id, e.effective);
    classify(o.id, e);
    weak(o, e);
    for (const r of e.reasons) if (r.code === "prerequisite_not_pass") add("gate_prerequisite_violation", `${o.id}:${r.prerequisite}`, `${o.id} står som PASS, men ${r.prerequisite} er ikke PASS`);
  }
  return [...found.values()].sort(compareFindings);
}

export { GATE_ID_PATTERN, ORL_ID_PATTERN };
