import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { listAllTenantIds, listTenantMemorySpaces, writeAudit } from "@jarvis/core";
import { classifyContentSensitivity } from "@jarvis/model-gateway";
import { stricterItemSensitivity, type ItemSensitivity } from "./memory-writer.ts";
import { withMemoryTransaction } from "./spaces.ts";

/**
 * Gjennomgang av WP-A (D-451): `memory_items.sensitivity` regnes ut MED ordforrådet som gjaldt da elementet ble skrevet. Q-52 A utvidet ordforrådet (ADHD, psykiater, kontoutskrift, …), så elementer lagret FØR
 * står som `normal`/`sensitive` selv om de nå ville vært `special`. Samtalemotoren klassifiserer derfor også selve minneblokkteksten (sikkerhetsnett), men et element som står riktig merket er bedre: `special`
 * tas bare med ved direkte treff og holdes utenfor profilen og de kommende forpliktelsene.
 *
 * Sveipet regner sensitiviteten på nytt for aktive elementer som ikke allerede er `special` (emne + innhold + nøkkelord + ALLE tidligere versjoner, som vises som «tidligere: …» i konteksten) og kan KUN
 * HEVE nivået (`stricterItemSensitivity`) - aldri senke. Standard er `report`: ingenting skrives, kun tellinger logges (`memory_resensitize_sweep_done`), slik at eieren ser omfanget først. `apply` skriver, med
 * revisjonsspor per element (`memory.resensitize`: kun id og fra/til - aldri innhold) fra en dedikert systemidentitet. Etter `apply` rekompilerer det nattlige profilsveipet profilen uten de nye `special`-elementene.
 */
const SYSTEM_PERSON_ID = "system-memory-resensitize";

function systemIdentity(tenantId: string, space: MemorySpace): IdentityContext {
  return { person_id: SYSTEM_PERSON_ID, tenant_id: tenantId, memory_space_id: space, session_id: "sess-memory-resensitize-sweep", device_id: "jarvis-core", channel: "api", auth_strength: "active" };
}

export type ResensitizeMode = "off" | "report" | "apply";

export function resensitizeModeFromEnv(raw: string | undefined): ResensitizeMode {
  const value = raw?.trim().toLowerCase();
  return value === "off" || value === "apply" ? value : "report";
}

export interface ResensitizeSweepSummary {
  mode: ResensitizeMode;
  scanned: number;
  /** Elementer som ville blitt (eller ble, i `apply`) hevet, per nytt nivå. */
  raised: { sensitive: number; special: number };
  /** Antall som faktisk ble skrevet (alltid 0 utenom `apply`). */
  written: number;
  failed: Array<{ tenant_id: string; memory_space_id: string; error: string }>;
  truncated: boolean;
}

interface ItemRow {
  memory_item_id: string;
  subject: string;
  content: string;
  keywords: string[] | null;
  sensitivity: ItemSensitivity;
  previous: string[] | null;
}

/** Strengeste nivå for et element, regnet over ALL tekst det kan bære inn i en kontekst. */
export function recomputedItemSensitivity(row: Pick<ItemRow, "subject" | "content" | "keywords" | "previous" | "sensitivity">): ItemSensitivity {
  const texts = [`${row.subject} ${row.content}`, ...(row.keywords ?? []), ...(row.previous ?? [])];
  const level = classifyContentSensitivity({ texts }).sensitivity;
  const computed: ItemSensitivity = level === "SECRET_RESTRICTED" ? "special" : level === "PRIVATE" || level === "BUSINESS_CONFIDENTIAL" ? "sensitive" : "normal";
  return stricterItemSensitivity(row.sensitivity, computed);
}

export async function runMemoryResensitizeSweepForAllTenants(
  pool: pg.Pool,
  options: { mode?: ResensitizeMode; maxRows?: number } = {}
): Promise<ResensitizeSweepSummary> {
  const mode = options.mode ?? "report";
  const summary: ResensitizeSweepSummary = { mode, scanned: 0, raised: { sensitive: 0, special: 0 }, written: 0, failed: [], truncated: false };
  if (mode === "off") return summary;
  let remaining = options.maxRows ?? 5000;
  const tenantIds = await listAllTenantIds(pool, 200);
  for (const tenantId of tenantIds) {
    if (remaining <= 0) { summary.truncated = true; break; }
    let spaces: string[];
    try {
      spaces = await listTenantMemorySpaces(pool, tenantId);
    } catch (err) {
      summary.failed.push({ tenant_id: tenantId, memory_space_id: "*", error: (err as Error).message.slice(0, 200) });
      continue;
    }
    for (const space of spaces as MemorySpace[]) {
      if (remaining <= 0) { summary.truncated = true; break; }
      // Helse-rommet er `special` per definisjon (`itemSensitivity`), og alt i det er allerede utenfor skyen via rommet.
      if (space === "health") continue;
      try {
        const done = await withMemoryTransaction(pool, tenantId, [space], async (client) => {
          const rows = (
            await client.query<ItemRow>(
              `SELECT m.memory_item_id, m.subject, m.content, m.keywords, m.sensitivity,
                      (SELECT array_agg(v.subject || ' ' || v.content) FROM memory_versions v WHERE v.memory_item_id = m.memory_item_id) AS previous
                 FROM memory_items m
                WHERE m.tenant_id = $1 AND m.space = $2 AND m.status = 'active' AND m.sensitivity <> 'special'
                ORDER BY m.updated_at DESC LIMIT $3`,
              [tenantId, space, remaining]
            )
          ).rows;
          let written = 0;
          for (const row of rows) {
            const next = recomputedItemSensitivity(row);
            if (next === row.sensitivity) continue;
            if (next === "special") summary.raised.special += 1;
            else summary.raised.sensitive += 1;
            if (mode !== "apply") continue;
            await client.query("UPDATE memory_items SET sensitivity = $1 WHERE memory_item_id = $2 AND tenant_id = $3", [next, row.memory_item_id, tenantId]);
            await writeAudit(client, systemIdentity(tenantId, space), { type: "memory.resensitize", payload: { memory_item_id: row.memory_item_id, from: row.sensitivity, to: next } });
            written += 1;
          }
          return { scanned: rows.length, written };
        });
        summary.scanned += done.scanned;
        summary.written += done.written;
        remaining -= done.scanned;
      } catch (err) {
        const failure = { tenant_id: tenantId, memory_space_id: space, error: (err as Error).message.slice(0, 200) };
        summary.failed.push(failure);
        console.error(JSON.stringify({ msg: "memory_resensitize_sweep_failed", ...failure }));
      }
    }
  }
  console.log(JSON.stringify({ msg: "memory_resensitize_sweep_done", mode, scanned: summary.scanned, raised: summary.raised, written: summary.written, failed: summary.failed.length, truncated: summary.truncated }));
  return summary;
}
