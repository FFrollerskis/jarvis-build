import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";
import { redactVendorText } from "../vendor-text.ts";
import type { RiskDirection } from "./critical-ops.ts";

/**
 * WP-G2 (D-464, UA-8): HANDLINGSJOURNALEN (`personal_action_journal`, migrasjon 125) - ÉN rad per eier-initiert kritisk fysisk handling (hjem/bil), med FØR-/ETTER-tilstand, forespørselens digest, utfall og proveniens
 * (person/tenant/memory space/kilde/task_id/session_id, regel 4). Samme modell som `growth_write_journal` (WP-D3): Jarvis' EGEN, kanoniske sannhet om «hva ble gjort» (D-64: Home Assistant/bil-API er utførere).
 *
 * IDEMPOTENS: `(tenant_id, idempotency_key)` er unik. Samme nøkkel + samme forespørsel (digest) = den eksisterende raden; samme nøkkel for NOE ANNET = `personal_action_idempotency_conflict`.
 * Terminale statuser (`applied`/`failed`) er uforanderlige (databasevakt). `outcome_unknown` kan senere avklares til `applied`/`failed`.
 * UBETRODD TEKST: tilstand fra utstyret/leverandøren er data. Alt som lagres går gjennom `sanitizeActionState` (dybde-/lengdegrenser, kontrolltegn fjernet, hemmeligheter -> `[REDACTED:...]`).
 */
export type ActionDomain = "home" | "car";
export type ActionStatus = "requested" | "applied" | "failed" | "outcome_unknown";
export type ActionSource = "owner_route" | "script" | "system";

export interface PersonalActionRow {
  action_id: string; tenant_id: string; memory_space_id: string; domain: ActionDomain; tool_id: string; action: string; risk_class: "C" | "D"; risk_direction: RiskDirection;
  target_ref: string; idempotency_key: string; request_digest: string; status: ActionStatus; failure_code: string | null; before_state: JsonValue | null; after_state: JsonValue | null;
  external_id: string | null; actor_person_id: string; source: ActionSource; task_id: string | null; session_id: string | null; trace_id: string | null;
  requested_at: string; completed_at: string | null; created_at: string; updated_at: string;
}

export interface BeginActionInput {
  domain: ActionDomain; tool_id: string; action: string; risk_class: "C" | "D"; risk_direction: RiskDirection; target_ref: string; idempotency_key: string; request_digest: string;
  actor_person_id: string; source: ActionSource; task_id?: string; session_id?: string; trace_id?: string;
}

export interface CompleteActionInput {
  status: Exclude<ActionStatus, "requested">;
  failure_code?: string | null;
  before_state?: JsonValue | null;
  after_state?: JsonValue | null;
  external_id?: string | null;
}

/** Deterministisk JSON (sorterte nøkler) - grunnlaget for forespørselens digest. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function actionRequestDigest(domain: string, action: string, parameters: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify({ domain, action, parameters })).digest("hex");
}

/** Begrenset, redigert kopi av en tilstand til journalen (dybde 6, 100 elementer, 60 nøkler, 500 tegn per tekst). */
export function sanitizeActionState(value: unknown, depth = 0): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactVendorText(value.replace(/\p{Cc}/gu, " "), 500);
  if (depth >= 6) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitizeActionState(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 60)) out[redactVendorText(k, 80)] = sanitizeActionState(v, depth + 1);
    return out;
  }
  return null;
}

const asRow = (row: unknown): PersonalActionRow => row as PersonalActionRow;

export class PersonalActionJournal {
  constructor(private readonly pool: pg.Pool) {}

  /** Åpner (eller finner) journalraden for en nøkkel. `created=false` = en replay av en tidligere forespørsel med identisk digest. */
  async begin(tenantId: string, memorySpace: MemorySpace, input: BeginActionInput): Promise<{ row: PersonalActionRow; created: boolean }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const inserted = await client.query(
        `INSERT INTO personal_action_journal
           (action_id, tenant_id, memory_space_id, domain, tool_id, action, risk_class, risk_direction, target_ref, idempotency_key, request_digest, status, actor_person_id, source, task_id, session_id, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'requested',$12,$13,$14,$15,$16)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING *`,
        [
          `pers-act-${randomUUID()}`, tenantId, memorySpace, input.domain, input.tool_id, input.action, input.risk_class, input.risk_direction, input.target_ref.slice(0, 200), input.idempotency_key,
          input.request_digest, input.actor_person_id, input.source, input.task_id ?? null, input.session_id ?? null, input.trace_id ?? null
        ]
      );
      if (inserted.rows[0]) return { row: asRow(inserted.rows[0]), created: true };
      const { rows } = await client.query(`SELECT * FROM personal_action_journal WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, input.idempotency_key]);
      const existing = asRow(rows[0]);
      if (existing.request_digest !== input.request_digest || existing.domain !== input.domain || existing.action !== input.action) throw new Error("personal_action_idempotency_conflict");
      return { row: existing, created: false };
    });
  }

  async complete(tenantId: string, memorySpace: MemorySpace, actionId: string, patch: CompleteActionInput): Promise<PersonalActionRow> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE personal_action_journal
            SET status = $3, failure_code = $4, before_state = COALESCE($5::jsonb, before_state), after_state = COALESCE($6::jsonb, after_state),
                external_id = COALESCE($7, external_id), completed_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND action_id = $2 RETURNING *`,
        [
          tenantId, actionId, patch.status, patch.failure_code === undefined || patch.failure_code === null ? null : patch.failure_code.slice(0, 160),
          patch.before_state === undefined || patch.before_state === null ? null : JSON.stringify(sanitizeActionState(patch.before_state)),
          patch.after_state === undefined || patch.after_state === null ? null : JSON.stringify(sanitizeActionState(patch.after_state)),
          patch.external_id === undefined || patch.external_id === null ? null : redactVendorText(patch.external_id, 300)
        ]
      );
      if (!rows[0]) throw new Error("personal_action_not_found");
      return asRow(rows[0]);
    });
  }

  async findByKey(tenantId: string, memorySpace: MemorySpace, idempotencyKey: string): Promise<PersonalActionRow | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM personal_action_journal WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, idempotencyKey]);
      return rows[0] ? asRow(rows[0]) : null;
    });
  }

  async list(tenantId: string, memorySpace: MemorySpace, filter: { domain?: ActionDomain; status?: ActionStatus; target_ref?: string; limit?: number } = {}): Promise<PersonalActionRow[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["tenant_id = $1"];
      const params: unknown[] = [tenantId];
      for (const [column, value] of [["domain", filter.domain], ["status", filter.status], ["target_ref", filter.target_ref]] as const) {
        if (value !== undefined) { params.push(value); conditions.push(`${column} = $${params.length}`); }
      }
      params.push(Math.min(200, Math.max(1, filter.limit ?? 50)));
      const { rows } = await client.query(`SELECT * FROM personal_action_journal WHERE ${conditions.join(" AND ")} ORDER BY requested_at DESC LIMIT $${params.length}`, params);
      return rows.map(asRow);
    });
  }
}
