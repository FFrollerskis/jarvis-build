import type { ControlCenterPool } from "../../src/control-center/shared.ts";

/**
 * WP-H0: en «pool» som svarer på SQL etter mønster og husker hvilken tenant hver spørring kjørte under (`set_config('jarvis.tenant_id', ...)`), slik at enhetstester kan bevise at lesingen er identitetsbundet
 * uten en database. Ekte SQL mot ekte tabeller (RLS, kolonner) bevises separat i de databasekjørte testene.
 */
export interface ScriptedRule {
  match: RegExp;
  /** Rader å svare med, en funksjon av parameterne, eller en feil som kastes (simulerer at kilden er nede). */
  rows: Array<Record<string, unknown>> | ((params: unknown[]) => Array<Record<string, unknown>>) | Error;
}

export interface RecordedQuery { sql: string; params: unknown[]; tenant: string | null }

export class ScriptedPool {
  readonly queries: RecordedQuery[] = [];
  constructor(private readonly rules: ScriptedRule[]) {}

  private answer(sql: string, params: unknown[], tenant: string | null): { rows: Array<Record<string, unknown>> } {
    this.queries.push({ sql, params, tenant });
    for (const rule of this.rules) {
      if (!rule.match.test(sql)) continue;
      if (rule.rows instanceof Error) throw rule.rows;
      return { rows: typeof rule.rows === "function" ? rule.rows(params) : rule.rows };
    }
    return { rows: [] };
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    return this.answer(sql, params, null);
  }

  async connect(): Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; release: () => void }> {
    let tenant: string | null = null;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [] };
        if (/set_config\('jarvis\.tenant_id'/.test(sql)) { tenant = String(params[0]); return { rows: [] }; }
        return this.answer(sql, params, tenant);
      },
      release: () => undefined
    };
  }

  /** Typet som appens pool (kontrollsentrene bruker kun `query` og `connect`). */
  asPool(): ControlCenterPool {
    return this as unknown as ControlCenterPool;
  }

  /** Tenantene alle tenant-skopede spørringer faktisk kjørte under. */
  tenantsUsed(): Set<string | null> {
    return new Set(this.queries.map((q) => q.tenant));
  }
}
