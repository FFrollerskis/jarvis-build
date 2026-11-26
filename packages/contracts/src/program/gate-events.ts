import { z } from "zod";
import { EvidenceRefSchema } from "./schema.ts";

/**
 * WP-PGA / PG3 (HF6 App. B): HENDELSESKONTRAKTEN `OperationalGateChanged` - kun type og skjema. Ingen produsent og ingen konsument finnes ennå (BUILT_UNWIRED): kontrakten er fastlagt nå så
 * en senere produsent (porteoppdatering) og konsument (statusvisning) kan bygges mot samme form. Nyttelasten er også formen på hver oppføring i en ports/ORL-nivås `history` (append-only):
 * historikken er dermed en hendelseslogg som kan spilles av som hendelser uten oversetting.
 *
 * Eier av hendelsen: `program.operational-gates` (indeksen). Idempotens: `<gate_id>:<changed_at>` er en naturlig nøkkel (en port endres høyst én gang per tidspunkt).
 */
export const OPERATIONAL_GATE_CHANGED_TYPE = "OperationalGateChanged" as const;
export const OPERATIONAL_GATE_CHANGED_VERSION = "1.0.0" as const;

export const GateStatusSchema = z.enum(["OPEN", "PASS", "FAIL"]);
export type GateStatus = z.infer<typeof GateStatusSchema>;
export const GATE_ID_PATTERN = /^G(?:0[1-9]|1[0-7])$/;
export const ORL_ID_PATTERN = /^ORL[0-5]$/;
export const GateIdSchema = z.string().regex(GATE_ID_PATTERN);
export const OrlIdSchema = z.string().regex(ORL_ID_PATTERN);

export const OperationalGateChangedPayloadSchema = z
  .object({
    gate_kind: z.enum(["program_gate", "orl"]),
    gate_id: z.string().regex(/^(?:G(?:0[1-9]|1[0-7])|ORL[0-5])$/),
    prior_status: GateStatusSchema,
    new_status: GateStatusSchema,
    /** PASS og FAIL har nøyaktig én evidensreferanse; en gjenåpning (OPEN) har ingen. */
    evidence_refs: z.array(EvidenceRefSchema).max(3),
    /** Rollen som besluttet/registrerte overgangen (aldri et personnavn). */
    owner: z.enum(["owner", "platform_operator"]),
    changed_at: z.string().datetime(),
    reason: z.string().min(3).max(200)
  })
  .strict()
  .superRefine((p, ctx) => {
    const add = (path: string, message: string): void => ctx.addIssue({ code: "custom", path: [path], message });
    if ((p.gate_kind === "program_gate") !== p.gate_id.startsWith("G")) add("gate_kind", "gate_kind passer ikke til gate_id");
    if (p.prior_status === p.new_status) add("new_status", "en overgang må endre status");
    if (p.new_status === "OPEN" && p.evidence_refs.length !== 0) add("evidence_refs", "en gjenåpning (OPEN) har ingen evidensreferanse");
    if (p.new_status !== "OPEN" && p.evidence_refs.length !== 1) add("evidence_refs", "PASS og FAIL krever nøyaktig én evidensreferanse");
  });
export type OperationalGateChangedPayload = z.infer<typeof OperationalGateChangedPayloadSchema>;

export const OperationalGateChangedEventSchema = z
  .object({
    type: z.literal(OPERATIONAL_GATE_CHANGED_TYPE),
    schema_version: z.literal(OPERATIONAL_GATE_CHANGED_VERSION),
    payload: OperationalGateChangedPayloadSchema
  })
  .strict();
export type OperationalGateChangedEvent = z.infer<typeof OperationalGateChangedEventSchema>;
