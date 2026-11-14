import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterAccessError, ControlCenterRegistry, type ControlCenterDefinition, type ControlCenterId, type ControlCenterReport } from "@jarvis/executive";
import { createAgentCenter } from "../src/control-center/agent.ts";
import { createFinanceCenter } from "../src/control-center/finance.ts";
import { createMemoryCenter } from "../src/control-center/memory.ts";
import { CONTROL_CENTER_FLAGS, createControlCenterRegistry, registerControlCenters } from "../src/control-center/register.ts";
import { flagOn, mergeBy, safeCategory } from "../src/control-center/shared.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { ScriptedPool, type ScriptedRule } from "./support/scripted-pool.ts";

/**
 * WP-H1 Finans-, Minne- og Agent-senter - ENHETSTESTER uten database (ekte SQL/RLS bevises i wph1-*-center-db.test.ts):
 *  1. FLAGG: AV som standard og kun den eksakte verdien «on» slår et senter på; uten flagg er oppførselen identisk med H0 (senteret står som «ikke koblet inn»);
 *  2. EIER-KUN: kun den suverene eieren fra en signert enhetsøkt får noe; alle andre og svak autentisering nektes (via den ene produksjonsfabrikken);
 *  3. IDENTITETSBUNDET: all tenant-lesing skjer under identitetens tenant; health leses aldri sammen med andre rom; kun lesing (ingen skrive-SQL);
 *  4. ÆRLIG UKJENT: kilder som er nede gir UKJENT (aldri OK); tomme kilder gir aldri «i orden» for det som krever en måling;
 *  5. REDAKSJON: hemmelighetsformede strenger fra data når aldri rapporten; kategorier slås sammen (to rare verdier blir ikke to like id-er).
 */
const authority = { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] };
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const NOW = new Date("2026-11-14T10:00:00.000Z");
const defs = productionToolDefinitions();
const toolGateway = { get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a), list: () => defs } as never;
const H1_CENTERS: ReadonlyArray<ControlCenterId> = ["finance", "memory", "agent"];

type Factory = (pool: ScriptedPool, env?: Record<string, string | undefined>) => ControlCenterDefinition;
const FACTORIES: Record<"finance" | "memory" | "agent", Factory> = {
  finance: (pool) => createFinanceCenter({ pool: pool.asPool(), toolGateway }),
  memory: (pool, env = {}) => createMemoryCenter({ pool: pool.asPool(), env }),
  agent: (pool) => createAgentCenter({ pool: pool.asPool(), toolGateway })
};

async function build(id: keyof typeof FACTORIES, pool: ScriptedPool, identity: IdentityContext = owner, env: Record<string, string | undefined> = {}): Promise<ControlCenterReport> {
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(FACTORIES[id](pool, env));
  return (await registry.report(id, identity)) as ControlCenterReport;
}
const everythingFails = (): ScriptedPool => new ScriptedPool([{ match: /./, rows: new Error("connect ECONNREFUSED 10.9.9.9:5432 password=hemmelig") }]);

describe("flagg: AV som standard, kun «on» slår et senter på", () => {
  const wiring = (env: Record<string, string | undefined>) => ({ pool: new ScriptedPool([]).asPool(), env, toolGateway });
  const registered = (env: Record<string, string | undefined>): string[] => {
    const registry = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(registry, wiring(env));
    return registry.list().map((c) => c.id);
  };

  it("uten noen flagg registreres INGEN av de tre (H0-oppførselen er uendret: de står som «ikke koblet inn»)", async () => {
    expect(registered({})).toEqual([]);
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registerControlCenters(registry, wiring({}));
    const overview = await registry.overview(owner);
    expect(overview.centers).toEqual([]);
    expect(overview.unregistered).toEqual(expect.arrayContaining([...H1_CENTERS]));
    expect(overview.status).toBe("UNKNOWN");
  });

  it("hvert flagg slår på nøyaktig sitt senter", () => {
    expect(registered({ [CONTROL_CENTER_FLAGS.finance]: "on" })).toEqual(["finance"]);
    expect(registered({ [CONTROL_CENTER_FLAGS.memory]: "on" })).toEqual(["memory"]);
    expect(registered({ [CONTROL_CENTER_FLAGS.agent]: "on" })).toEqual(["agent"]);
    expect(registered({ [CONTROL_CENTER_FLAGS.finance]: "on", [CONTROL_CENTER_FLAGS.memory]: "on", [CONTROL_CENTER_FLAGS.agent]: "on" })).toEqual(["finance", "memory", "agent"]);
  });

  it("kun den EKSAKTE verdien «on» teller: true, 1, ON, yes, on med mellomrom, tom streng og off er alle AV", () => {
    for (const value of ["true", "1", "ON", "On", "yes", " on", "on ", "", "off", "false", "enabled"]) {
      expect(registered({ [CONTROL_CENTER_FLAGS.finance]: value, [CONTROL_CENTER_FLAGS.memory]: value, [CONTROL_CENTER_FLAGS.agent]: value }), JSON.stringify(value)).toEqual([]);
    }
    expect(flagOn({ X: "on" }, "X")).toBe(true);
    expect(flagOn({}, "X")).toBe(false);
  });

  it("flaggnavnene er stabile og dokumentert i `.env.example`", () => {
    // H1-flaggene er uendret (WP-H2 la til fire til - se wph2-control-centers.test.ts for hele settet).
    expect(CONTROL_CENTER_FLAGS).toMatchObject({ finance: "JARVIS_CONTROL_CENTER_FINANCE", memory: "JARVIS_CONTROL_CENTER_MEMORY", agent: "JARVIS_CONTROL_CENTER_AGENT" });
    const envExample = readFileSync(fileURLToPath(new URL("../../../.env.example", import.meta.url)), "utf8");
    for (const name of [...Object.values(CONTROL_CENTER_FLAGS), "JARVIS_GOVERNANCE_PROVENANCE"]) expect(envExample, name).toContain(name);
  });

  it("Finans og Agenter trenger verktøyregisteret (risikoklassen til knappene); uten det registreres de ikke selv med flagget på - Minne trenger det ikke", () => {
    const registry = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(registry, { pool: new ScriptedPool([]).asPool(), env: { [CONTROL_CENTER_FLAGS.finance]: "on", [CONTROL_CENTER_FLAGS.memory]: "on", [CONTROL_CENTER_FLAGS.agent]: "on" } });
    expect(registry.list().map((c) => c.id)).toEqual(["memory"]);
  });
});

describe("eier-kun: kun den suverene eieren fra en signert enhetsøkt (produksjonsfabrikken)", () => {
  const NON_OWNERS: ReadonlyArray<readonly [string, IdentityContext, string]> = [
    ["annen person i eierens tenant", { ...owner, person_id: "person-member" }, "control_center_owner_only"],
    ["delegat", { ...owner, delegation_id: "deleg-1" }, "control_center_owner_only"],
    ["gjest", { ...owner, person_id: "person-guest", memory_space_id: "guest" }, "control_center_owner_only"],
    ["eierens person i annen tenant", { ...owner, tenant_id: "tenant-annen" }, "control_center_owner_only"],
    ["eieren, passiv økt (tale)", { ...owner, channel: "voice", auth_strength: "passive" }, "control_center_requires_signed_device_session"],
    ["eieren, aktiv økt uten enhetssignatur", { ...owner, auth_strength: "active" }, "control_center_requires_signed_device_session"]
  ];

  for (const id of H1_CENTERS as ReadonlyArray<keyof typeof FACTORIES>) {
    it(`${id}: alle ikke-eiere og svak autentisering nektes FØR noe bygges (ingen spørring mot databasen)`, async () => {
      const pool = new ScriptedPool([]);
      const registry = createControlCenterRegistry({ authority, now: () => NOW });
      registry.register(FACTORIES[id](pool));
      for (const [label, identity, reason] of NON_OWNERS) {
        await expect(registry.report(id, identity), label).rejects.toMatchObject({ name: "ControlCenterAccessError", reason });
        await expect(registry.overview(identity), label).rejects.toBeInstanceOf(ControlCenterAccessError);
      }
      expect(pool.queries).toEqual([]);
      expect(await registry.report(id, owner)).not.toBeNull();
      expect(pool.queries.length).toBeGreaterThan(0);
    });
  }
});

describe("identitetsbundet og kun lesing", () => {
  const other: IdentityContext = { ...owner, tenant_id: "tenant-annen", person_id: "person-annen" };

  for (const id of H1_CENTERS as ReadonlyArray<keyof typeof FACTORIES>) {
    it(`${id}: ALL tenant-lesing skjer under identitetens egen tenant - aldri en annen, og aldri uten tenant (unntatt de globale driftstabellene)`, async () => {
      for (const identity of [owner, other]) {
        const pool = new ScriptedPool([]);
        await build(id, pool, identity);
        const tenants = pool.tenantsUsed();
        for (const t of tenants) expect(t === null || t === identity.tenant_id, `${id}/${identity.tenant_id}: ${t}`).toBe(true);
        // spørringer uten tenant er KUN de globale driftstabellene (scheduler_state) - aldri en tenant-eid tabell
        for (const q of pool.queries.filter((x) => x.tenant === null)) expect(q.sql, q.sql.slice(0, 80)).toMatch(/scheduler_state/);
        // tenant-id-en er alltid første parameter i tenant-skopede spørringer
        for (const q of pool.queries.filter((x) => x.tenant !== null && x.params.length > 0 && typeof x.params[0] === "string")) expect(q.params[0]).toBe(identity.tenant_id);
      }
    });

    it(`${id}: ingen skrive-SQL (INSERT/UPDATE/DELETE/DDL) og health leses aldri sammen med andre rom`, async () => {
      const pool = new ScriptedPool([]);
      await build(id, pool, owner, { JARVIS_GOVERNANCE_PROVENANCE: "on" });
      expect(pool.queries.length).toBeGreaterThan(3);
      for (const q of pool.queries) {
        expect(q.sql, q.sql.slice(0, 80)).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+|CREATE\s+(TABLE|INDEX)|GRANT\s)/i);
        if (q.spaces !== null && q.spaces.split(",").includes("health")) expect(q.spaces, q.sql.slice(0, 60)).toBe("health");
      }
    });
  }

  it("Minne leser health i en EGEN lesing som ett antall (aldri innhold), uavhengig av de øvrige rommene", async () => {
    const pool = new ScriptedPool([]);
    await build("memory", pool);
    const healthReads = pool.queries.filter((q) => q.spaces === "health");
    expect(healthReads.length).toBeGreaterThanOrEqual(2);
    for (const q of healthReads) expect(q.sql).toMatch(/count\(\*\)/i);
    for (const q of healthReads) expect(q.sql).not.toMatch(/\b(content|subject|title|keywords)\b/i);
  });
});

describe("ærlig ukjent", () => {
  for (const id of H1_CENTERS as ReadonlyArray<keyof typeof FACTORIES>) {
    it(`${id}: når ALLE kilder er nede er hver seksjon UKJENT og ikke målt, senteret er UKJENT - aldri OK - og feilmeldingen (verten, passordet) lekker ikke`, async () => {
      const r = await build(id, everythingFails());
      expect(r.sections.length).toBeGreaterThan(0);
      for (const s of r.sections) {
        expect(s.status, s.id).toBe("UNKNOWN");
        expect(s.measured, s.id).toBe(false);
      }
      expect(r.status).toBe("UNKNOWN");
      const text = JSON.stringify(r);
      expect(text).not.toContain("10.9.9.9");
      expect(text).not.toContain("hemmelig");
      expect(text).toContain("kunne ikke leses");
    });

    it(`${id}: tomme kilder (ingen rader) gir aldri en sammenlagt «i orden» for det som krever en måling`, async () => {
      const r = await build(id, new ScriptedPool([]));
      expect(r.sections.every((s) => s.measured)).toBe(true);
      expect(r.status).not.toBe("OK");
      // Finans og Agenter: det som krever en måling (avstemming, synk, worker-bevis) er ukjent. Minne: styringsjournalens proveniens-skriving er AV (advarsel) - aldri «i orden».
      expect(r.status).toBe(id === "memory" ? "WARN" : "UNKNOWN");
    });
  }

  it("én kilde som svikter gir UKJENT kun for sin seksjon: Finans uten avstemmingstabellen, Agenter uten artefakter, Minne uten sletting", async () => {
    const fin = await build("finance", new ScriptedPool([{ match: /FROM finance_reconciliation_runs/, rows: new Error("permission denied for table finance_reconciliation_runs") }]));
    expect(fin.sections.find((s) => s.id === "reconciliation")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(fin.sections.find((s) => s.id === "intents")?.measured).toBe(true);
    const ag = await build("agent", new ScriptedPool([{ match: /FROM artifacts/, rows: new Error("permission denied for table artifacts") }]));
    expect(ag.sections.find((s) => s.id === "artifacts")?.measured).toBe(false);
    expect(ag.sections.find((s) => s.id === "jobs")?.measured).toBe(true);
    const mem = await build("memory", new ScriptedPool([{ match: /FROM erasure_requests/, rows: new Error("permission denied for table erasure_requests") }]));
    expect(mem.sections.find((s) => s.id === "erasure")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(mem.sections.find((s) => s.id === "memories")?.measured).toBe(true);
  });

  it("en seksjon som trenger to kilder er UKJENT (ikke OK) når den ene mangler: Minne-synk uten daglige jobber", async () => {
    const mem = await build("memory", new ScriptedPool([{ match: /FROM scheduler_state/, rows: new Error("relation scheduler_state does not exist") }]));
    expect(mem.sections.find((s) => s.id === "sync")?.status).toBe("UNKNOWN");
  });
});

describe("redaksjon og kategorier", () => {
  // Bygges i to deler uten nøkkelord rett foran den lange delen (skanneren leser kildeteksten; verdien settes sammen først ved kjøring).
  const FAKE_KEY = `${["sk", "ant", "api03"].join("-")}-${"FALSKNOKKELFORTEST".concat("0123456789ABCDEF")}`;

  it("en hemmelighetsformet streng fra data (avviksflagg, synkkilde, artefaktart) når aldri rapporten gjennom produksjonsregisteret (siste forsvarslinje)", async () => {
    const rules: ScriptedRule[] = [
      { match: /jsonb_array_elements_text/, rows: [{ source: "intents", flag: FAKE_KEY, n: 1 }] },
      { match: /FROM knowledge_documents/, rows: [{ source_type: FAKE_KEY, documents: 1, tombstoned: 0, instances: 1, last_synced_at: NOW.toISOString() }] },
      { match: /FROM artifacts WHERE tenant_id = \$1 AND created_at/, rows: [{ kind: FAKE_KEY, n: 1, chars: 10, last_at: NOW.toISOString() }] }
    ];
    for (const id of H1_CENTERS as ReadonlyArray<keyof typeof FACTORIES>) {
      const registry = createControlCenterRegistry({ authority, now: () => NOW });
      registry.register(FACTORIES[id](new ScriptedPool(rules)));
      const text = JSON.stringify(await registry.report(id, owner));
      expect(text, id).not.toContain(FAKE_KEY);
      expect(text, id).not.toContain("FALSKNOKKELFORTEST");
    }
  });

  it("to ulike rare verdier blir begge «annet» og slås sammen - de gir aldri to like id-er (som ville gjort hele senteret UKJENT)", async () => {
    const rules: ScriptedRule[] = [{ match: /jsonb_array_elements_text/, rows: [{ source: "intents", flag: "rar verdi med mellomrom", n: 2 }, { source: "intents", flag: "{\"obj\":1}", n: 3 }] }];
    const r = await build("finance", new ScriptedPool(rules));
    const anomalies = r.sections.find((s) => s.id === "anomalies")!;
    expect(anomalies.measured).toBe(true);
    expect(anomalies.items.filter((i) => i.id === "flag:intents:annet")).toHaveLength(1);
    expect(anomalies.items.find((i) => i.id === "flag:intents:annet")?.facts).toMatchObject({ count: 5 });
    expect(r.sections.every((s) => s.measured)).toBe(true); // én rar rad velter ikke senteret
  });

  it("safeCategory og mergeBy: kun trygge kategorinavn slipper gjennom, resten blir «annet»; sammenslåing bevarer rekkefølgen", () => {
    expect(safeCategory("settled")).toBe("settled");
    expect(safeCategory("failed:timeout")).toBe("failed:timeout");
    for (const bad of ["", "a b", "x".repeat(61), "<script>", null, undefined, 5, { a: 1 }]) expect(safeCategory(bad), String(bad)).toBe("annet");
    expect(mergeBy([{ k: "a", n: 1 }, { k: "b", n: 1 }, { k: "a", n: 2 }], (x) => x.k, (p, q) => ({ k: p.k, n: p.n + q.n }))).toEqual([{ k: "a", n: 3 }, { k: "b", n: 1 }]);
  });
});

describe("innhold: tekstene har aldri beløp (de ligger kun i *_ore-fakta, som aldri går til en modell)", () => {
  it("Finans: ingen «kr» i noen tekst, og alle fakta som bærer beløp har nøkkel som ender på _ore", async () => {
    const rules: ScriptedRule[] = [
      { match: /FROM payment_intents WHERE tenant_id = \$1 GROUP BY state/, rows: [{ state: "settled", n: 3, ore: "1500000" }] },
      { match: /FROM finance_spend_records/, rows: [{ category: "marketing_spend", n: 4, ore: "987654", estimated: 1, unreconciled: 0, conflicts: 0 }] }
    ];
    const r = await build("finance", new ScriptedPool(rules));
    const strings = r.sections.flatMap((s) => [s.summary_no, ...s.items.flatMap((i) => [i.label, i.detail_no ?? ""])]).join("\n");
    expect(strings).not.toMatch(/\bkr\b|\bNOK\b|\d[ \u00a0\u202f]\d{3}\b/);
    const settled = r.sections.find((s) => s.id === "intents")?.items.find((i) => i.id === "state:settled");
    expect(settled?.facts).toMatchObject({ count: 3, amount_ore: 1_500_000 });
    expect(JSON.stringify(r)).not.toContain("987654 kr");
  });
});
