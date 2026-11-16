import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";
import { redactVendorText } from "@jarvis/tool-gateway";

/**
 * WP-D3 (UA-4 Growth, D-459): SKRIVEJOURNALEN (`growth_write_journal`, migrasjon 113) - ÉN rad per eier-initiert skriving mot en annonse-/analyseplattform, med FØR-/ETTER-tilstand, forespørselens digest, utfall og
 * proveniens (person/tenant/memory space/kilde/task_id/session_id, regel 4). Journalen er Jarvis' EGEN, kanoniske sannhet om «hva ble gjort» (D-64: plattformen er et sluk, ikke domenet) og beviset databasen krever
 * før en utførelses-kommando kan stå som `executed` (migrasjon 114).
 *
 * IDEMPOTENS: `(tenant_id, idempotency_key)` er unik. Samme nøkkel + samme forespørsel (digest) = den eksisterende raden; samme nøkkel for NOE ANNET = `growth_write_idempotency_conflict` (aldri en stille gjenbruk).
 * Terminale statuser (`applied`/`failed`) er uforanderlige (databasevakt). `outcome_unknown` kan senere avklares (avstemming) til `applied`/`failed`.
 * HEMMELIGHETER/INJEKSJON: tilstand fra leverandøren er ubetrodd tekst. Alt som lagres går gjennom `sanitizeJournalState` (dybde-/lengdegrenser, kontrolltegn fjernet, hemmeligheter -> `[REDACTED:...]`).
 */
export type WriteStatus = "requested" | "applied" | "failed" | "outcome_unknown";
export type WriteSource = "owner_route" | "script" | "system";
export type JournalSpendEffect = "none" | "reduces" | "increases" | "starts" | "structural" | "unknown";

export interface GrowthWriteRow {
  write_id: string; tenant_id: string; memory_space_id: string; provider: string; action: string; risk_class: "B" | "C" | "D"; spend_effect: JournalSpendEffect;
  target_ref: string; resource_ref: string | null; campaign_id: string | null; experiment_id: string | null; variant_id: string | null; command_id: string | null;
  idempotency_key: string; request_digest: string; status: WriteStatus; failure_code: string | null; before_state: JsonValue | null; after_state: JsonValue | null; external_id: string | null;
  actor_person_id: string; source: WriteSource; task_id: string | null; session_id: string | null; trace_id: string | null;
  requested_at: string; completed_at: string | null; created_at: string; updated_at: string;
}

export interface BeginWriteInput {
  provider: string; action: string; risk_class: "B" | "C" | "D"; spend_effect: JournalSpendEffect; target_ref: string; idempotency_key: string; request_digest: string;
  actor_person_id: string; source: WriteSource; campaign_id?: string | null; experiment_id?: string | null; variant_id?: string | null; command_id?: string | null;
  task_id?: string; session_id?: string; trace_id?: string;
}

export interface CompleteWriteInput {
  status: Exclude<WriteStatus, "requested">;
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

export function writeRequestDigest(provider: string, action: string, parameters: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify({ provider, action, parameters })).digest("hex");
}

/** Begrenset, redigert kopi av en leverandørtilstand til journalen (dybde 6, 100 elementer, 60 nøkler, 500 tegn per tekst). */
export function sanitizeJournalState(value: unknown, depth = 0): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactVendorText(value.replace(/\p{Cc}/gu, " "), 500);
  if (depth >= 6) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitizeJournalState(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 60)) out[redactVendorText(k, 80)] = sanitizeJournalState(v, depth + 1);
    return out;
  }
  return null;
}

const asRow = (row: unknown): GrowthWriteRow => row as GrowthWriteRow;

export class GrowthWriteJournal {
  constructor(private readonly pool: pg.Pool) {}

  /** Åpner (eller finner) journalraden for en nøkkel. `created=false` = en replay av en tidligere forespørsel med identisk digest. */
  async begin(tenantId: string, memorySpace: MemorySpace, input: BeginWriteInput): Promise<{ row: GrowthWriteRow; created: boolean }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const inserted = await client.query(
        `INSERT INTO growth_write_journal
           (write_id, tenant_id, memory_space_id, provider, action, risk_class, spend_effect, target_ref, campaign_id, experiment_id, variant_id, command_id,
            idempotency_key, request_digest, status, actor_person_id, source, task_id, session_id, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'requested',$15,$16,$17,$18,$19)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING *`,
        [
          `grw-wr-${randomUUID()}`, tenantId, memorySpace, input.provider, input.action, input.risk_class, input.spend_effect, input.target_ref.slice(0, 200), input.campaign_id ?? null,
          input.experiment_id ?? null, input.variant_id ?? null, input.command_id ?? null, input.idempotency_key, input.request_digest, input.actor_person_id, input.source,
          input.task_id ?? null, input.session_id ?? null, input.trace_id ?? null
        ]
      );
      if (inserted.rows[0]) return { row: asRow(inserted.rows[0]), created: true };
      const { rows } = await client.query(`SELECT * FROM growth_write_journal WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, input.idempotency_key]);
      const existing = asRow(rows[0]);
      if (existing.request_digest !== input.request_digest || existing.provider !== input.provider || existing.action !== input.action) throw new Error("growth_write_idempotency_conflict");
      return { row: existing, created: false };
    });
  }

  async complete(tenantId: string, memorySpace: MemorySpace, writeId: string, patch: CompleteWriteInput): Promise<GrowthWriteRow> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE growth_write_journal
            SET status = $3, failure_code = $4, before_state = COALESCE($5::jsonb, before_state), after_state = COALESCE($6::jsonb, after_state),
                external_id = COALESCE($7, external_id), completed_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND write_id = $2 RETURNING *`,
        [
          tenantId, writeId, patch.status, patch.failure_code === undefined || patch.failure_code === null ? null : patch.failure_code.slice(0, 160),
          patch.before_state === undefined || patch.before_state === null ? null : JSON.stringify(sanitizeJournalState(patch.before_state)),
          patch.after_state === undefined || patch.after_state === null ? null : JSON.stringify(sanitizeJournalState(patch.after_state)),
          patch.external_id === undefined || patch.external_id === null ? null : redactVendorText(patch.external_id, 300)
        ]
      );
      if (!rows[0]) throw new Error("growth_write_not_found");
      return asRow(rows[0]);
    });
  }

  async get(tenantId: string, memorySpace: MemorySpace, writeId: string): Promise<GrowthWriteRow | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM growth_write_journal WHERE tenant_id = $1 AND write_id = $2`, [tenantId, writeId]);
      return rows[0] ? asRow(rows[0]) : null;
    });
  }

  async list(tenantId: string, memorySpace: MemorySpace, filter: { campaign_id?: string; status?: WriteStatus; provider?: string; limit?: number } = {}): Promise<GrowthWriteRow[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["tenant_id = $1"];
      const params: unknown[] = [tenantId];
      for (const [column, value] of [["campaign_id", filter.campaign_id], ["status", filter.status], ["provider", filter.provider]] as const) {
        if (value !== undefined) { params.push(value); conditions.push(`${column} = $${params.length}`); }
      }
      params.push(Math.min(200, Math.max(1, filter.limit ?? 50)));
      const { rows } = await client.query(`SELECT * FROM growth_write_journal WHERE ${conditions.join(" AND ")} ORDER BY requested_at DESC LIMIT $${params.length}`, params);
      return rows.map(asRow);
    });
  }
}
