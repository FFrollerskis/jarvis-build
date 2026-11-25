import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";
import {
  BLANK_MODEL, CLOUD, IDENTITY_ID, KEEP, LOCAL, LOOP_IDS, OWNER, TENANT, UNKNOWN_MODEL, buildWorld, identity, run, seedConversationGraph, seedOpenLoops,
  type ModelArg, type World
} from "./support/n1b-finance-world.ts";
import { ROWS, type Row } from "./support/n1b-rows.ts";

/**
 * WP-N1b fiks-runde 1 (FIX-5, FIX-7: «ingen orakel»): et skysvar skal ha SAMME FORM og samme innhold med og uten finansdata. Ellers kan en skymodell lese at finansdata finnes (antall, plassering, tomme lister, tall) selv når innholdet
 * er fjernet - et orakel. Testen bygger to tenanter med de samme ikke-finansielle radene, den ene også med finansdata, og sammenligner skysvaret fra HVER håndterte sti (alle rader i kartleggingstabellen unntatt enkeltoppslag av ett
 * finanselement, der «merket i stedet for ikke funnet» er akseptert, antakelse 10), normalisert for tidsstempler og id-suffikser. Pluss to målrettede kontroller av vedlikeholdsloggen (platstjeling av `recent`, og minuttsummen).
 *
 * Kjent og akseptert unntak (dokumentert i runbooken): AGGREGATTELLINGER som blander finans og ikke-finans uten å kunne skille dem (Drift-senterets antall åpne hendelser, antall kontrollhandlinger i Sikkerhet-senteret) - de bærer
 * ingen navn og ingen innhold; derfor er Drift-senteret ikke med i sammenligningen.
 */
const TENANT_B = "tenant-n1b-nofin";
const OWNER_B = "person-n1b-nofin";
const IDENTITY_ID_B = `${IDENTITY_ID}-b`;
const identityB = { ...identity, tenant_id: TENANT_B, person_id: OWNER_B };

let db: H0Db;
let aBase: World;
let aCenters: World;
let bBase: World;
let bCenters: World;

const CENTER_FLAGS = { JARVIS_CONTROL_CENTER_MEMORY: "on", JARVIS_CONTROL_CENTER_AGENT: "on", JARVIS_CONTROL_CENTER_PRIVACY: "on", JARVIS_CONTROL_CENTER_SECURITY: "on" };
const CENTER_TOOLS = ["memory", "agent", "privacy", "security"] as const;

/** Tenant B: de samme ikke-finansielle radene som tenant A (med `-b`-suffiks på id-ene), ingen finansløkker, ingen finansvedlikehold. */
async function seedTenantWithoutFinance(admin: H0Db["adminPool"]): Promise<void> {
  await seedTenants(admin, [{ tenant_id: TENANT_B, person_id: OWNER_B }]);
  await admin.query("INSERT INTO business_contacts (contact_id, tenant_id, memory_space_id, name, email) VALUES ('contact-n1b-1-b', $1, 'business', 'Kari Kunde', 'kari@example.test')", [TENANT_B]);
  await admin.query("INSERT INTO conversation_identities (identity_id, tenant_id, memory_space_id, display_name, linked_business_contact_id, status) VALUES ($1, $2, 'business', 'Kari Kunde', 'contact-n1b-1-b', 'active')", [IDENTITY_ID_B, TENANT_B]);
  await admin.query("INSERT INTO conversation_channel_links (link_id, tenant_id, memory_space_id, identity_id, channel, channel_identifier, confidence, match_method, status) VALUES ('link-n1b-1-b', $1, 'business', $2, 'email', 'kari@example.test', 1, 'exact_email', 'active')", [TENANT_B, IDENTITY_ID_B]);
  for (const [id, type, reason, next, priority, contact] of [
    [LOOP_IDS.ok1, "overdue_followup", `Følg opp ${KEEP.followup} før fredag`, "Ring kunden", "normal", "contact-n1b-1-b"],
    [LOOP_IDS.ok2, "support_ticket_overdue", `Sak ${KEEP.ticket} mangler svar`, "Svar kunden", "high", null]
  ] as const) {
    await admin.query(
      `INSERT INTO business_open_loops (open_loop_id, tenant_id, memory_space_id, loop_type, detection_key, reason, next_action, priority, status, opened_at, contact_id)
       VALUES ($1, $2, 'business', $3, $4, $5, $6, $7, 'open', now() - interval '2 days', $8)`, [`${id}-b`, TENANT_B, type, `${type}:${id}-b`, reason, next, priority, contact]
    );
  }
}

beforeAll(async () => {
  db = await startH0Db("n1boracle");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT, person_id: OWNER }]);
  await seedOpenLoops(db.adminPool);
  await seedConversationGraph(db.adminPool);
  await seedTenantWithoutFinance(db.adminPool);
  aBase = buildWorld({ pool: db.appPool, guard: true });
  bBase = buildWorld({ pool: db.appPool, guard: true, financeData: false, tenantId: TENANT_B, ownerId: OWNER_B });
  aCenters = buildWorld({ pool: db.appPool, guard: true, realCenters: true, centerFlags: CENTER_FLAGS, centerTools: [...CENTER_TOOLS] });
  bCenters = buildWorld({ pool: db.appPool, guard: true, financeData: false, tenantId: TENANT_B, ownerId: OWNER_B, realCenters: true, centerFlags: CENTER_FLAGS, centerTools: [...CENTER_TOOLS] });
  // tenant A: frosne koblinger/credentials (finans og vanlig) og tilkoblingshelse; tenant B: kun de vanlige (minnebasert kontroll i verdenen)
  for (const c of ["stripe", "finance_vipps", "github"]) await (aCenters.ownerControls as NonNullable<World["ownerControls"]>).freezeConnectorDurable(c, `begrunnelse-${c}`, OWNER);
  for (const r of ["JARVIS_VIPPS_CLIENT_SECRET", "JARVIS_GITHUB_TOKEN"]) await (aCenters.ownerControls as NonNullable<World["ownerControls"]>).revokeCredentialDurable(r, `begrunnelse-${r}`, OWNER);
  for (const w of [aBase, aCenters, bBase, bCenters]) (w.gateway.health as Map<string, unknown>).set("github", { state: "healthy", at: "2026-11-25T09:00:00.000Z" });
  for (const w of [aBase, aCenters]) (w.gateway.health as Map<string, unknown>).set("finance_stripe", { state: "auth_failed", at: "2026-11-25T09:00:00.000Z", detail: "N1B-HEALTH-DETAIL" });
  await db.adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore, provider, model, purpose, success) VALUES ($1, 'model_call', 77123, 'anthropic', 'claude', 'CHAT', true)", [TENANT]);
  for (const [tenant, connector, reason, minutes] of [[TENANT, "stripe", "N1B-VEDLIKEHOLD-STRIPE", 30], [TENANT, "neonomics", "N1B-VEDLIKEHOLD-NEONOMICS", 20], [TENANT, "github", "N1B-VEDLIKEHOLD-GITHUB", 10], [TENANT_B, "github", "N1B-VEDLIKEHOLD-GITHUB", 10]] as const) {
    await db.adminPool.query("INSERT INTO connector_maintenance_log (tenant_id, connector_id, event_kind, minutes, reason, recorded_by) VALUES ($1, $2, 'manual_fix', $3, $4, 'test')", [tenant, connector, minutes, reason]);
  }
}, 300_000);

afterAll(async () => { await db?.stop(); }, 120_000);

const MODELS_CLOUD: Array<[string, ModelArg]> = [["sky", CLOUD], ["ukjent leverandør", UNKNOWN_MODEL], ["blank leverandør", BLANK_MODEL]];

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** Normaliserer det som uansett skiller to tenanter (tidsstempler, `-b`-suffiks på id-ene, tenant- og personid). Alt annet må være likt. */
const norm = (value: unknown): string => JSON.stringify(value ?? null)
  .replace(ISO, "T")
  .replace(/\b(loop-ok-\d|ident-n1b-\d|contact-n1b-\d|link-n1b-\d)-b\b/g, "$1")
  .replaceAll(TENANT_B, TENANT).replaceAll(OWNER_B, OWNER);

const paramsFor = (params: Record<string, unknown> | undefined, forB: boolean): Record<string, unknown> => {
  const p = { ...(params ?? {}) };
  if (!forB) return p;
  if (p["tenant_id"] === TENANT) p["tenant_id"] = TENANT_B;
  if (p["identity_id"] === IDENTITY_ID) p["identity_id"] = IDENTITY_ID_B;
  return p;
};

const answer = async (row: Row, forB: boolean, model: ModelArg): Promise<unknown> => {
  const world = forB ? (row.world === "centers" ? bCenters : bBase) : (row.world === "centers" ? aCenters : aBase);
  const r = await run(world.gateway, row.tool, row.action, paramsFor(row.params, forB), model, forB ? identityB : identity);
  expect(r.ok, `${row.id} ${forB ? "uten" : "med"} finansdata: ${JSON.stringify(r)}`).toBe(true);
  return r.data;
};

describe("orakel: skysvaret er identisk med og uten finansdata - ALLE håndterte stier (kartleggingstabellen)", () => {
  for (const row of ROWS.filter((r) => r.single !== true)) {
    for (const [label, model] of MODELS_CLOUD) {
      it(`${row.id} ${row.path}: ${label} får samme svar med og uten finansdata`, async () => {
        const withFinance = norm(await answer(row, false, model));
        const without = norm(await answer(row, true, model));
        expect(withFinance, `${row.id}: skysvaret avslører finansdata (ulik form/innhold)`).toBe(without);
      });
    }
  }

  it("kontroll: lokal modell får FORSKJELLIG svar med og uten finansdata (sammenligningen er ikke tom)", async () => {
    for (const row of ROWS.filter((r) => r.single !== true && ["R01", "R03", "R07", "R10", "R11", "R22", "R24a", "R25"].includes(r.id))) {
      const withFinance = norm(await answer(row, false, LOCAL));
      const without = norm(await answer(row, true, LOCAL));
      expect(withFinance, `${row.id}: lokal modell skal se finansdataene`).not.toBe(without);
    }
  });

  it("de øvrige H2-sentrene (minne, agent, personvern) er også like med og uten finansdata - Drift er unntatt (aggregattellinger, se toppen)", async () => {
    for (const center of ["memory", "agent", "privacy"]) {
      const a = await run(aCenters.gateway, "executive", "get_control_center", { center }, CLOUD);
      const b = await run(bCenters.gateway, "executive", "get_control_center", { center }, CLOUD, identityB);
      expect(a.ok && b.ok, center).toBe(true);
      expect(norm(a.data), `${center}: skysvaret avslører finansdata`).toBe(norm(b.data));
    }
  });
});

describe("vedlikeholdsloggen (FIX-5): finansrader stjeler ikke plassene i `recent` (LIMIT 5) og summeres ikke inn i `minutes_30d`", () => {
  const T3 = "tenant-n1b-maint";
  const O3 = "person-n1b-maint";
  const id3 = { ...identity, tenant_id: T3, person_id: O3 };
  let w3: World;
  const ask = async (m: ModelArg): Promise<{ minutes_30d: number; by_connector: Array<{ connector_id: string; minutes: number }>; recent: Array<{ connector_id: string }>; finance_withheld?: true }> =>
    (await run(w3.gateway, "run_rate", "list_connector_maintenance", {}, m, id3)).data as never;
  const insert = (connector: string, minutes: number, hoursAgo: number, reason: string) =>
    db.adminPool.query("INSERT INTO connector_maintenance_log (tenant_id, connector_id, event_kind, minutes, reason, recorded_by, occurred_at) VALUES ($1, $2, 'manual_fix', $3, $4, 'test', now() - make_interval(hours => $5))", [T3, connector, minutes, reason, hoursAgo]);

  beforeAll(async () => {
    await seedTenants(db.adminPool, [{ tenant_id: T3, person_id: O3 }]);
    w3 = buildWorld({ pool: db.appPool, guard: true, tenantId: T3, ownerId: O3 });
    for (const [c, m, ago] of [["github", 10, 3], ["github", 5, 4], ["slack", 5, 5]] as const) await insert(c, m, ago, "vanlig");
  }, 120_000);

  it("fem NYE finansrader (nyere enn de vanlige) endrer ikke skyens `recent`, `by_connector` eller `minutes_30d` (platstjeling røpet at finansvedlikehold finnes)", async () => {
    const before = await ask(CLOUD);
    expect(before.recent.map((r) => r.connector_id)).toEqual(["github", "github", "slack"]);
    expect(before.minutes_30d).toBe(20);
    for (let i = 0; i < 5; i += 1) await insert("stripe", 10, 1, "fin");
    await insert("neonomics", 7, 2, "fin");
    const after = await ask(CLOUD);
    expect(JSON.stringify(after, (k, v) => (k === "occurred_at" ? "T" : v))).toBe(JSON.stringify(before, (k, v) => (k === "occurred_at" ? "T" : v)));
    expect(after.minutes_30d).toBe(20);
    expect(after.by_connector.map((c) => c.connector_id).sort()).toEqual(["github", "slack"]);
  });

  it("lokal modell og eier får ALT: finansradene er med i `recent` og i summen (kontroll)", async () => {
    for (const m of [LOCAL, undefined]) {
      const full = await ask(m);
      expect(full.recent.map((r) => r.connector_id)).toContain("stripe");
      expect(full.minutes_30d).toBe(20 + 50 + 7);
      expect(full.by_connector.map((c) => c.connector_id)).toContain("neonomics");
    }
  });
});
