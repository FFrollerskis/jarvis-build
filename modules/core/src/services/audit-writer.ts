import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";

export interface AuditEntry {
  type: string;
  decision?: string;
  reason?: string;
  tool_id?: string;
  action?: string;
  capability_class?: string;
  payload?: Record<string, unknown>;
  /** D-394 (JARVIS-054): korrelasjon mot jobb og modellspor, slik at en handling kan rekonstrueres på tvers av tabeller. */
  task_id?: string;
  trace_id?: string;
}

/**
 * Append-only audit i samme transaksjon som skrivingen den dokumenterer -
 * en skriving uten audit-rad skal ikke kunne committes (akseptansekriterium 4).
 * Tabellen har trigger-vern mot UPDATE/DELETE.
 */
/**
 * D-131: `session_id`/`device_id` er nå EKSPLISITT valgfrie i typen. Kolonnene
 * har alltid vært nullbare (004_audit_cost.sql) og funksjonen har alltid
 * skrevet `?? null`, men typen krevde likevel feltene - så kallere uten en
 * sesjon (f.eks. innrullering, som skjer FØR noen sesjon finnes) måtte lyve
 * med en cast. En audit-primitiv som inviterer til cast er en audit-primitiv
 * som før eller siden får feil verdi inn.
 */
export type AuditSubject = Pick<IdentityContext, "tenant_id" | "person_id"> &
  Partial<Pick<IdentityContext, "session_id" | "device_id">>;

/** D-394: hvilken prosess (api/worker/…) som skrev raden - settes fra `JARVIS_PROCESS` (compose), ellers ukjent (NULL). */
function processName(): string | null {
  const name = process.env["JARVIS_PROCESS"];
  return name && name.length > 0 ? name.slice(0, 40) : null;
}

export async function writeAudit(client: pg.PoolClient, identity: AuditSubject, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (tenant_id, person_id, session_id, device_id, type, decision, reason, tool_id, action, capability_class, payload,
        task_id, trace_id, actor_kind, process)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      identity.tenant_id,
      identity.person_id,
      identity.session_id ?? null,
      identity.device_id ?? null,
      entry.type,
      entry.decision ?? null,
      entry.reason ?? null,
      entry.tool_id ?? null,
      entry.action ?? null,
      entry.capability_class ?? null,
      JSON.stringify(entry.payload ?? {}),
      entry.task_id ?? null,
      entry.trace_id ?? null,
      // Systemhandlinger (`person_id: "system"`) merkes eksplisitt i stedet for å se ut som en person.
      identity.person_id === "system" ? "system" : "person",
      processName()
    ]
  );
}
