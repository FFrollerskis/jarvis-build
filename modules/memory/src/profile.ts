import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { listAllTenantIds, listTenantMemorySpaces } from "@jarvis/core";
import { withMemoryTransaction } from "./spaces.ts";

/**
 * D-386: kompilert, alltid-tilstede eierprofil per (tenant, space) - Letta sitt «core memory»-/LangMem sitt «profile»-mønster,
 * men DETERMINISTISK (ingen LLM som kan dikte): de viktigste aktive, betrodde minnene av varige typer (relasjon, preferanse,
 * prosjekt, praktisk, rutine) rangert på viktighet × hvor ofte eieren vender tilbake til dem. `special`-minner (helse/finans)
 * er ALDRI med i profilen (den sendes med hver tur, også til skymodeller); de hentes kun ved direkte treff (D-384).
 * Profilen versjoneres ved innholdsendring og lagres i `memory_profiles` (068); `contextWithMeta` prepender den.
 */
export const PROFILE_TYPES: readonly string[] = ["relation", "preference", "project", "operational", "procedure"];
const PROFILE_MAX_ITEMS = 25;
const PROFILE_MAX_CHARS = 1400;

const TYPE_LABEL: Readonly<Record<string, string>> = {
  relation: "relasjon", preference: "preferanse", project: "prosjekt", operational: "praktisk", procedure: "rutine"
};

export interface CompiledProfile {
  content: string;
  version: number;
  source_item_ids: string[];
  changed: boolean;
}

export async function compileMemoryProfile(pool: pg.Pool, tenantId: string, space: MemorySpace): Promise<CompiledProfile> {
  return withMemoryTransaction(pool, tenantId, [space], async (client) => {
    const rows = await client.query<{ memory_item_id: string; type: string; content: string }>(
      `SELECT memory_item_id, type, content
         FROM memory_items
        WHERE tenant_id = $1 AND space = $2 AND status = 'active' AND trust_level <> 'untrusted'
          AND sensitivity <> 'special' AND type = ANY($3) AND confidence >= 0.5
        ORDER BY importance DESC, access_count DESC, observed_at DESC
        LIMIT $4`,
      [tenantId, space, PROFILE_TYPES, PROFILE_MAX_ITEMS]
    );
    const lines: string[] = [];
    const ids: string[] = [];
    let used = 0;
    for (const r of rows.rows) {
      const line = `- [${TYPE_LABEL[r.type] ?? r.type}] ${r.content.replace(/\s+/g, " ").trim()}`;
      if (used + line.length > PROFILE_MAX_CHARS) break;
      lines.push(line);
      ids.push(r.memory_item_id);
      used += line.length + 1;
    }
    const content = lines.join("\n");
    const existing = await client.query<{ content: string; version: number }>(
      "SELECT content, version FROM memory_profiles WHERE tenant_id = $1 AND space = $2",
      [tenantId, space]
    );
    const prev = existing.rows[0];
    if (prev && prev.content === content) {
      return { content, version: prev.version, source_item_ids: ids, changed: false };
    }
    if (content.length === 0) {
      if (prev) await client.query("DELETE FROM memory_profiles WHERE tenant_id = $1 AND space = $2", [tenantId, space]);
      return { content, version: 0, source_item_ids: [], changed: Boolean(prev) };
    }
    const version = (prev?.version ?? 0) + 1;
    await client.query(
      `INSERT INTO memory_profiles (tenant_id, space, content, version, source_item_ids, generated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id, space) DO UPDATE SET content = EXCLUDED.content, version = EXCLUDED.version,
         source_item_ids = EXCLUDED.source_item_ids, generated_at = now()`,
      [tenantId, space, content, version, ids]
    );
    return { content, version, source_item_ids: ids, changed: true };
  });
}

export interface ProfileSweepSummary {
  compiled: number;
  changed: number;
  failed: Array<{ tenant_id: string; memory_space_id: string; error: string }>;
}

/** Nattlig rekompilering for alle tenanter/spaces (samme mønster som de andre sveipene). Fail-soft per space. */
export async function runMemoryProfileSweepForAllTenants(pool: pg.Pool): Promise<ProfileSweepSummary> {
  const summary: ProfileSweepSummary = { compiled: 0, changed: 0, failed: [] };
  for (const tenantId of await listAllTenantIds(pool, 200)) {
    let spaces: string[];
    try {
      spaces = await listTenantMemorySpaces(pool, tenantId);
    } catch (err) {
      summary.failed.push({ tenant_id: tenantId, memory_space_id: "*", error: (err as Error).message.slice(0, 200) });
      continue;
    }
    for (const space of spaces) {
      try {
        const result = await compileMemoryProfile(pool, tenantId, space as MemorySpace);
        summary.compiled += 1;
        if (result.changed) summary.changed += 1;
      } catch (err) {
        const failure = { tenant_id: tenantId, memory_space_id: space, error: (err as Error).message.slice(0, 200) };
        summary.failed.push(failure);
        console.error(JSON.stringify({ msg: "memory_profile_sweep_failed", ...failure }));
      }
    }
  }
  console.log(JSON.stringify({ msg: "memory_profile_sweep_done", ...summary, failed: summary.failed.length }));
  return summary;
}
