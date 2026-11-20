// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { scanForSecrets, withTenantTransaction, writeAudit } from "@jarvis/core";

/**
 * WP-H2 (gjennomgang L1): revisjonsraden som skrives og COMMITTES FØR eierens autonomi-binding slettes (`ExecutiveService.revokeAutonomyBinding` kaller den; `main.ts` injiserer den som `autonomyAudit`).
 * Én kort tenant-transaksjon mot den append-only `audit_events`-tabellen (`writeAudit`, samme primitiv som resten av revisjonen) - kaster den, utføres ingen sletting (fail-closed i tjenesten).
 *
 * Før-bildet (domene, verktøy, handling, aktiv/av, parametre) er bindingens EGNE verdier, eierens egen konfigurasjon, så den kan gjenopprettes med `set_autonomy_policy`. Hver streng i raden går likevel
 * gjennom hemmelighetsskanneren (`scanForSecrets`) før den lagres, og et for stort parameterobjekt erstattes av en størrelsesmerknad (revisjonsraden er ikke et lager).
 */

/** Øvre grense for den serialiserte lengden på ett parameterobjekt i revisjonsraden. */
export const AUTONOMY_AUDIT_MAX_VALUE_CHARS = 4_000;
const MAX_DEPTH = 6;

/** Redigerer hemmeligheter i alle strenger (blader og nøkler) i en JSON-lignende verdi, og kapper dybde og størrelse. Aldri kaster. */
export function redactAuditValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scanForSecrets(value).text;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[avkortet: for dypt]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactAuditValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) out[scanForSecrets(key).text] = redactAuditValue(v, depth + 1);
    return out;
  }
  return null;
}

/** Hvert objekt-/liste-felt i `payload.before` større enn grensen (serialisert) erstattes av en størrelsesmerknad; resten redigeres. */
export function redactAuditPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(payload)) {
    let value = redactAuditValue(raw);
    if (key === "before" && value !== null && typeof value === "object") {
      const before = value as Record<string, unknown>;
      const serializedParameters = JSON.stringify(before["parameters"] ?? null);
      if (serializedParameters.length > AUTONOMY_AUDIT_MAX_VALUE_CHARS) value = { ...before, parameters: null, parameters_omitted: `for stort (${serializedParameters.length} tegn)` };
    }
    out[key] = value;
  }
  return out;
}

export type AutonomyAuditWriter = (
  identity: IdentityContext,
  entry: { type: string; tool_id: string; action: string; payload: Record<string, unknown> }
) => Promise<void>;

export function createAutonomyAudit(pool: pg.Pool): AutonomyAuditWriter {
  return (identity, entry) =>
    withTenantTransaction<void>(pool, identity.tenant_id, (client) =>
      writeAudit(client, identity, { type: entry.type, decision: "ALLOW", tool_id: entry.tool_id, action: entry.action, capability_class: "C", payload: redactAuditPayload(entry.payload) })
    );
}
