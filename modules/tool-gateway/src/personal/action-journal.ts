import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { writeAudit } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { redactVendorText } from "../vendor-text.ts";
import type { RiskDirection } from "./critical-ops.ts";

/**
 * WP-G2 (D-464, UA-8): HANDLINGSJOURNALEN (`personal_action_journal`, migrasjon 125) - ÉN rad per eier-initiert kritisk fysisk handling (hjem/bil), med FØR-/ETTER-tilstand, forespørselens digest, utfall og proveniens
 * (person/tenant/memory space/kilde/task_id/session_id, regel 4). Samme modell som `growth_write_journal` (WP-D3): Jarvis' EGEN, kanoniske sannhet om «hva ble gjort» (D-64: Home Assistant/bil-API er utførere).
 *
 * IDEMPOTENS: `(tenant_id, idempotency_key)` er unik. Samme nøkkel + samme forespørsel (digest) = den eksisterende raden; samme nøkkel for NOE ANNET = `personal_action_idempotency_conflict`.
 * Terminale statuser (`applied`/`failed`) er uforanderlige (databasevakt). `outcome_unknown` kan senere avklares til `applied`/`failed`: av en samtidig replay med samme nøkkel (`complete`) eller av eierens AVSTEMMING
 * (`recordReconcile`, migrasjon 144 - `action-reconcile.ts`: kun etter at målets faktiske tilstand er lest på nytt; aldri en automatisk retry av kommandoen).
 * UBETRODD TEKST: tilstand fra utstyret/leverandøren er data. Alt som lagres går gjennom `sanitizeActionState` (dybde-/lengdegrenser, kontrolltegn fjernet, hemmeligheter -> `[REDACTED:...]`).
 */
export type ActionDomain = "home" | "car";
export type ActionStatus = "requested" | "applied" | "failed" | "outcome_unknown";
export type ActionSource = "owner_route" | "script" | "system";

export interface PersonalActionRow {
  action_id: string; tenant_id: string; memory_space_id: string; domain: ActionDomain; tool_id: string; action: string; risk_class: "C" | "D"; risk_direction: RiskDirection;
  target_ref: string; idempotency_key: string; request_digest: string; status: ActionStatus; failure_code: string | null; before_state: JsonValue | null; after_state: JsonValue | null;
  external_id: string | null; actor_person_id: string; source: ActionSource; task_id: string | null; session_id: string | null; trace_id: string | null;
  /** Ble det umiddelbare eier-varselet levert? `null` = ikke forsøkt/ukjent; `false` + `notify_error` = handlingen står, men eieren ble IKKE varslet (retry-markør). */
  notified: boolean | null; notify_error: string | null;
  /** Migrasjon 144: de VALIDERTE parameterne forespørselen hadde (kun det handlingens strenge skjema godtar). `null` = ikke lagret (rad fra før 144, eller forespørselen bestod ikke skjemaet): raden kan da ikke avstemmes. */
  request_params: Record<string, JsonValue> | null;
  /** Migrasjon 144: antall avstemmingsforsøk (0 = aldri avstemt), tidspunktet for det siste, en kort KODE for hvorfor raden ble avgjort/står, og den redigerte nåtilstanden som ble lest ved det siste forsøket. */
  reconcile_attempts: number; reconciled_at: string | null; reconcile_basis: string | null; reconciled_state: JsonValue | null;
  requested_at: string; completed_at: string | null; created_at: string; updated_at: string;
}

export interface BeginActionInput {
  domain: ActionDomain; tool_id: string; action: string; risk_class: "C" | "D"; risk_direction: RiskDirection; target_ref: string; idempotency_key: string; request_digest: string;
  actor_person_id: string; source: ActionSource; task_id?: string; session_id?: string; trace_id?: string;
  /** Kun parametre som BESTOD handlingens strenge skjema (aldri rå klient-JSON). Utelatt/`null` = ikke lagret. */
  request_params?: Record<string, JsonValue> | null;
}

export interface CompleteActionInput {
  status: Exclude<ActionStatus, "requested">;
  failure_code?: string | null;
  before_state?: JsonValue | null;
  after_state?: JsonValue | null;
  external_id?: string | null;
  /** Varslingsstatus fra klasse D-kjeden (`undefined` = ikke forsøkt/ukjent: eksisterende verdi beholdes). */
  notified?: boolean | undefined;
  notify_error?: string | null | undefined;
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
           (action_id, tenant_id, memory_space_id, domain, tool_id, action, risk_class, risk_direction, target_ref, idempotency_key, request_digest, status, actor_person_id, source, task_id, session_id, trace_id, request_params)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'requested',$12,$13,$14,$15,$16,$17::jsonb)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING *`,
        [
          `pers-act-${randomUUID()}`, tenantId, memorySpace, input.domain, input.tool_id, input.action, input.risk_class, input.risk_direction, input.target_ref.slice(0, 200), input.idempotency_key,
          input.request_digest, input.actor_person_id, input.source, input.task_id ?? null, input.session_id ?? null, input.trace_id ?? null,
          input.request_params === undefined || input.request_params === null ? null : JSON.stringify(input.request_params)
        ]
      );
      if (inserted.rows[0]) return { row: asRow(inserted.rows[0]), created: true };
      const { rows } = await client.query(`SELECT * FROM personal_action_journal WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, input.idempotency_key]);
      const existing = asRow(rows[0]);
      if (existing.request_digest !== input.request_digest || existing.domain !== input.domain || existing.action !== input.action) throw new Error("personal_action_idempotency_conflict");
      return { row: existing, created: false };
    });
  }

  /**
   * Ferdigstiller en ÅPEN rad (`requested`, eller `outcome_unknown` som avklares). Er raden allerede terminal (`applied`/`failed`) - en samtidig forespørsel med SAMME nøkkel rakk det først - gjelder det LAGREDE utfallet:
   * raden returneres uendret, aldri et databaseunntak hos taperen og aldri en overskriving (fiks-runde review A LOW-5). Kalleren sammenligner `row.status` med det den ville skrevet.
   */
  async complete(tenantId: string, memorySpace: MemorySpace, actionId: string, patch: CompleteActionInput): Promise<PersonalActionRow> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE personal_action_journal
            SET status = $3, failure_code = $4, before_state = COALESCE($5::jsonb, before_state), after_state = COALESCE($6::jsonb, after_state),
                external_id = COALESCE($7, external_id), notified = COALESCE($8::boolean, notified), notify_error = CASE WHEN $8::boolean IS NULL THEN notify_error ELSE $9 END,
                completed_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND action_id = $2 AND status IN ('requested', 'outcome_unknown') RETURNING *`,
        [
          tenantId, actionId, patch.status, patch.failure_code === undefined || patch.failure_code === null ? null : patch.failure_code.slice(0, 160),
          patch.before_state === undefined || patch.before_state === null ? null : JSON.stringify(sanitizeActionState(patch.before_state)),
          patch.after_state === undefined || patch.after_state === null ? null : JSON.stringify(sanitizeActionState(patch.after_state)),
          patch.external_id === undefined || patch.external_id === null ? null : redactVendorText(patch.external_id, 300),
          patch.notified === undefined ? null : patch.notified, patch.notify_error === undefined || patch.notify_error === null ? null : patch.notify_error.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 160)
        ]
      );
      if (rows[0]) return asRow(rows[0]);
      const existing = await client.query(`SELECT * FROM personal_action_journal WHERE tenant_id = $1 AND action_id = $2`, [tenantId, actionId]);
      if (!existing.rows[0]) throw new Error("personal_action_not_found");
      return asRow(existing.rows[0]);
    });
  }

  async findById(tenantId: string, memorySpace: MemorySpace, actionId: string): Promise<PersonalActionRow | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM personal_action_journal WHERE tenant_id = $1 AND action_id = $2`, [tenantId, actionId]);
      return rows[0] ? asRow(rows[0]) : null;
    });
  }

  /**
   * Finnes det en NYERE handling mot SAMME mål (domene + mål) som kan ha endret målets tilstand (`requested`/`applied`/`outcome_unknown`; en `failed` rad endret ingenting)? Brukes av avstemmingen: en observert sluttilstand kan da ikke tilskrives den
   * ELDRE raden. Sammenligningen skjer i databasen mot radens egen `requested_at` (mikrosekunder). Synlig innen (tenant, memory space) - samme RLS som resten av journalen.
   */
  async hasLaterAction(tenantId: string, memorySpace: MemorySpace, actionId: string): Promise<boolean> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM personal_action_journal later, personal_action_journal cur
          WHERE cur.tenant_id = $1 AND cur.action_id = $2 AND later.tenant_id = cur.tenant_id AND later.domain = cur.domain AND later.target_ref = cur.target_ref
            AND later.action_id <> cur.action_id AND later.requested_at > cur.requested_at AND later.status IN ('requested', 'applied', 'outcome_unknown') LIMIT 1`,
        [tenantId, actionId]
      );
      return rows.length > 0;
    });
  }

  /**
   * Registrerer ETT avstemmingsforsøk på en `outcome_unknown`-rad (migrasjon 144): `applied`/`failed` når beviset holder, ellers raden forblir `outcome_unknown` - i alle tilfeller med tidspunkt, kort begrunnelseskode og den leste tilstanden, og
   * en revisjonsrad (`personal.action_reconciled`, uten innhold) i SAMME transaksjon (ingen endring uten revisjon). Betinget på at raden FORTSATT er `outcome_unknown`: en samtidig avgjørelse vinner, og da returneres raden uendret (`updated: false`).
   * Det opprinnelige `before_state`/`after_state`/`external_id` røres aldri (bevis for det som skjedde den gangen); `failure_code` settes til `reconciled_not_executed` ved `failed` og tømmes ved `applied` (en replay skal ikke vise den gamle feilkoden på en rad som nå er utført).
   */
  async recordReconcile(
    identity: Pick<IdentityContext, "tenant_id" | "person_id"> & Partial<Pick<IdentityContext, "session_id" | "device_id">>,
    memorySpace: MemorySpace,
    actionId: string,
    patch: { status: "applied" | "failed" | "outcome_unknown"; basis: string; observed: JsonValue | null }
  ): Promise<{ row: PersonalActionRow; updated: boolean }> {
    return withMemoryTransaction(this.pool, identity.tenant_id, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE personal_action_journal
            SET status = $3,
                failure_code = CASE WHEN $3 = 'failed' THEN 'reconciled_not_executed' WHEN $3 = 'applied' THEN NULL ELSE failure_code END,
                completed_at = CASE WHEN $3 = 'outcome_unknown' THEN completed_at ELSE now() END,
                reconcile_attempts = reconcile_attempts + 1, reconciled_at = now(), reconcile_basis = $4, reconciled_state = $5::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND action_id = $2 AND status = 'outcome_unknown' RETURNING *`,
        [identity.tenant_id, actionId, patch.status, patch.basis, patch.observed === null ? null : JSON.stringify(sanitizeActionState(patch.observed))]
      );
      if (!rows[0]) {
        const current = await client.query(`SELECT * FROM personal_action_journal WHERE tenant_id = $1 AND action_id = $2`, [identity.tenant_id, actionId]);
        if (!current.rows[0]) throw new Error("personal_action_not_found");
        return { row: asRow(current.rows[0]), updated: false };
      }
      const row = asRow(rows[0]);
      await writeAudit(client, identity, {
        type: "personal.action_reconciled", decision: "ALLOW", reason: patch.basis, tool_id: row.tool_id, action: row.action,
        payload: { action_id: row.action_id, domain: row.domain, target_ref: row.target_ref, result: patch.status, basis: patch.basis, attempts: row.reconcile_attempts, source: "owner_route" }
      });
      return { row, updated: true };
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
