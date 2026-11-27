import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { scanForSecrets } from "./secret-scan.ts";
import { scanStructuredForSecrets } from "./secret-scan-structured.ts";

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

/**
 * WP-SEC2 (K7b, JARVIS-069): `audit_events` har ÉN skriver (denne funksjonen), så ALL fritekst og alle nyttelaster skannes her, sentralt - ikke hos hvert av de ~40 kallene. `reason` skannes som tekst; nyttelasten som struktur
 * (`scanStructuredForSecrets`: hver streng, søsken-strenger sammen, verdier under hemmelige nøkkelnavn, fail-closed dybde/syklus). Funnene lagres KUN som typer (`secret_redacted`), aldri verdier. Uten funn er `reason` og
 * nyttelasten BYTE-IDENTISK med før. Svikter skanneren, skrives en fail-closed erstatning (aldri uredigert tekst). `type`/`decision`/`tool_id`/`action`/`capability_class` er kontrollerte identifikatorer og skannes ikke.
 * `before_state`/`after_state`/`recovery` i nyttelasten (kopi av ledgerens gjenopprettingsgrunnlag) redigeres også her; recovery leser ledgeren (`tool_executions`/`infra_executions`), ikke denne kopien.
 */
function redactAuditEntry(entry: AuditEntry): { reason: string | null; payload: Record<string, unknown> } {
  try {
    const kinds = new Set<string>();
    let reason: string | null = null;
    // JS-kallere kan sende `reason: null` eller et tall (typen sier `string`): ikke-streng bli tekst i stedet for et unntak som kaster HELE nyttelasten (review B, L1).
    const rawReason: unknown = entry.reason;
    if (rawReason !== undefined && rawReason !== null) {
      const scanned = scanForSecrets(typeof rawReason === "string" ? rawReason : String(rawReason));
      for (const f of scanned.findings) kinds.add(f.kind);
      reason = scanned.text;
    }
    const scannedPayload = scanStructuredForSecrets(entry.payload ?? {});
    for (const f of scannedPayload.findings) kinds.add(f.kind);
    const payload = scannedPayload.value as Record<string, unknown>;
    return { reason, payload: kinds.size === 0 ? payload : { ...payload, secret_redacted: [...kinds] } };
  } catch (err) {
    // Fail-closed, men ikke stille og ikke alt-eller-ingenting (review B, L1): feilen logges (kun type og feilklasse, ALDRI innhold), og nyttelastens nøkler og ikke-strenger (tall/boolean/null) beholdes - strenger og objekter,
    // som ikke kunne skannes, erstattes av en markør. `reason` kunne ikke skannes og utelates.
    console.error(JSON.stringify({ msg: "audit_redaction_failed", type: safeAuditType(entry), error: err instanceof Error ? err.name : "non_error" }));
    return { reason: null, payload: failClosedPayload(entry) };
  }
}

const REDACTION_FAILED_MARKER = "[REDACTED:redaction_failed]";

function safeAuditType(entry: AuditEntry): string {
  try {
    return typeof entry.type === "string" ? entry.type.slice(0, 80) : "unknown";
  } catch {
    return "unknown";
  }
}

/** Nyttelasten når skanningen sviktet: `redaction_failed: true` + toppnivånøklene (skannet som tekst) med tall/boolean/null beholdt og alt annet som markør. Kan ikke nøklene leses, står kun `redaction_failed`. */
function failClosedPayload(entry: AuditEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(payload).slice(0, 64)) {
      let kept: unknown = REDACTION_FAILED_MARKER;
      try {
        const value = payload[key];
        if (typeof value === "number" || typeof value === "boolean" || value === null) kept = value;
      } catch {
        /* getter som kaster: markør */
      }
      let name = key.slice(0, 120);
      try {
        name = scanForSecrets(name).text;
      } catch {
        name = REDACTION_FAILED_MARKER;
      }
      out[name] = kept;
    }
  } catch {
    /* nøkkelliste som ikke kan leses: kun markøren under */
  }
  out["redaction_failed"] = true;
  return out;
}

export async function writeAudit(client: pg.PoolClient, identity: AuditSubject, entry: AuditEntry): Promise<void> {
  const clean = redactAuditEntry(entry);
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
      clean.reason,
      entry.tool_id ?? null,
      entry.action ?? null,
      entry.capability_class ?? null,
      JSON.stringify(clean.payload),
      entry.task_id ?? null,
      entry.trace_id ?? null,
      // Systemhandlinger (`person_id: "system"`) merkes eksplisitt i stedet for å se ut som en person.
      identity.person_id === "system" ? "system" : "person",
      processName()
    ]
  );
}
