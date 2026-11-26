import { randomUUID } from "node:crypto";
import type { RowFactory, RowFactoryArgs } from "@jarvis/core/testing";

/**
 * WP-MC8a K4: tabeller bevist mot den STRENGE databasen (alle CHECK/FK/triggere på): fabrikkene lager GYLDIGE rader, inkludert foreldrerader (tenants, sites, people).
 * Det viser at den automatiske, constraint-strippede fixturen og de ekte radene gir samme isolasjonsutfall. Legg nye pakkers fabrikker i EGNE filer i denne mappen.
 */
const SPACES = ["personal", "business", "project", "health", "home", "guest", "shared"] as const;

const ensureTenant = (a: RowFactoryArgs): Promise<void> => a.seedParent("tenants", { tenant_id: a.tenant, name: `Tenant ${a.tenant}`, kind: "business" });
const uid = (a: RowFactoryArgs, prefix: string): string => `${prefix}-${a.tenant}-${a.seq}`;

export const strict: Record<string, RowFactory> = {
  tenants: (a) => ({ tenant_id: a.tenant, name: `Tenant ${a.tenant}`, kind: "business" }),
  sites: async (a) => {
    await ensureTenant(a);
    return { site_id: uid(a, "site"), tenant_id: a.tenant, name: `Site ${a.seq}` };
  },
  rooms: async (a) => {
    await ensureTenant(a);
    await a.seedParent("sites", { site_id: uid(a, "site"), tenant_id: a.tenant, name: `Site ${a.seq}` });
    return { room_id: uid(a, "room"), site_id: uid(a, "site"), tenant_id: a.tenant, name: `Room ${a.seq}` };
  },
  projects: async (a) => {
    await ensureTenant(a);
    return { project_id: uid(a, "project"), tenant_id: a.tenant, name: `Project ${a.seq}` };
  },
  organizations: async (a) => {
    await ensureTenant(a);
    return { org_id: uid(a, "org"), tenant_id: a.tenant, name: `Org ${a.seq}` };
  },
  memory_spaces: async (a) => {
    await ensureTenant(a);
    return { memory_space_id: uid(a, "ms"), tenant_id: a.tenant, space: SPACES[a.seq % SPACES.length] };
  },
  cost_events: async (a) => {
    await ensureTenant(a);
    return { tenant_id: a.tenant, kind: "iso", amount_ore: a.seq };
  },
  audit_events: (a) => ({ tenant_id: a.tenant, person_id: `iso-person-${a.seq}`, type: "iso.probe" }),
  devices: async (a) => {
    await ensureTenant(a);
    await a.seedParent("people", { person_id: "iso-person", display_name: "Iso Person" });
    return { device_id: uid(a, "device"), tenant_id: a.tenant, person_id: "iso-person", kind: "web" };
  },
  events: async (a) => {
    await ensureTenant(a);
    return { event_id: randomUUID(), idempotency_key: uid(a, "evt"), tenant_id: a.tenant, source: "iso", type: "iso.probe", trust_level: "trusted", payload: {}, occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, a.seq)).toISOString() };
  },
  brief_seen: async (a) => {
    await ensureTenant(a);
    return { tenant_id: a.tenant, item_key: `item-${a.seq}` };
  }
};
