import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import { EVOLUTION_DECISION_AUDIT_TYPE, EVOLUTION_DECISION_REFUSALS, controlAction, type ControlCenterReport, type EvolutionReport } from "@jarvis/executive";
import { ChangeLedger, evaluateAllReadiness, type ReadinessFacts } from "@jarvis/self-modification";
import type { Ev0BootStatus } from "../src/ev0-boot.ts";
import { createEvolutionDecisionRecorder, isDecidableChangeId } from "../src/evolution-decisions.ts";
import { createEvolutionCenter } from "../src/control-center/evolution.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-B3 (D-475, EV-23) - SKRIVEREN for eierens avgjørelse om et endringsforslag mot EKTE Postgres som app-rollen (`jarvis_app`, RLS) og det EKTE endringsregisteret (hash-kjede, migrasjon 075):
 *  - skriver ÉN append-only revisjonsrad (`evolution.owner_decision`) med før-bilde, og INGENTING annet: endringsregisteret er urørt (samme rader og intakt hash-kjede), ingen andre tabeller endres;
 *  - IDEMPOTENT og samtidighetssikker: samme avgjørelse for samme versjon skrives ikke på nytt; parallelle klikk gir nøyaktig én rad; kjeden av før-bilder er sammenhengende;
 *  - BUNDET til versjonen: et omforeslått/endret forslag kan ikke avgjøres på den gamle digesten, og en avgjørelse om den gamle versjonen teller ikke for den nye;
 *  - E3 kan aldri godkjennes; lukkede/ukjente forslag avvises; ugyldig input (injeksjon, hemmelighetsform, lengde) avvises FØR databasen røres; databasefeil blir en fast kode uten feiltekst;
 *  - TENANT-isolert (RLS): en annen tenants avgjørelse påvirker verken idempotens eller visning; ingen forslagstekst/sti/evidens/gren havner i revisjonsraden;
 *  - Evolusjon-senteret viser avgjørelsen fra den EKTE tabellen og tilbyr riktige knapper.
 */
let db: H0Db;
const TENANT_A = "tenant-b3a-a";
const TENANT_B = "tenant-b3a-b";
const OWNER_A = "person-b3a-a";
const OWNER_B = "person-b3a-b";
const DIGEST = "e".repeat(64);
const SECRET_SUBJECT = "HEMMELIG FORSLAGSTEKST som aldri skal kopieres";
const SECRET_PATH = "config/hemmelig-sti-som-aldri-skal-kopieres.json";
const SECRET_EVIDENCE = "HEMMELIG-EVIDENS-MARKØR";
const SECRET_BRANCH = "hemmelig-gren-som-aldri-skal-kopieres";
const idFor = (person: string, tenant: string, extra: Partial<IdentityContext> = {}): IdentityContext => ({
  person_id: person, tenant_id: tenant, memory_space_id: "personal", session_id: `s-${person}`, device_id: `dev-${person}`, channel: "web", auth_strength: "signed", ...extra
});
const A = idFor(OWNER_A, TENANT_A);
const B = idFor(OWNER_B, TENANT_B);
const NOW = new Date();
let recorder: ReturnType<typeof createEvolutionDecisionRecorder>;

async function lastHash(changeId: string): Promise<string> {
  return String((await db.adminPool.query("SELECT entry_hash FROM evolution_change_ledger WHERE change_id = $1 ORDER BY seq DESC LIMIT 1", [changeId])).rows[0].entry_hash);
}
const seedLedger = new Map<string, string>();

interface AuditRow { audit_id: string; tenant_id: string; person_id: string; session_id: string | null; device_id: string | null; type: string; decision: string | null; tool_id: string | null; action: string | null; capability_class: string | null; payload: Record<string, unknown> }
async function decisionRows(changeId?: string, tenant?: string): Promise<AuditRow[]> {
  const rows = (await db.adminPool.query(
    // `ORDER BY audit_events.audit_id`: en bar `audit_id` ville pekt på tekst-aliaset (utdatakolonner går foran) og sortert leksikografisk.
    "SELECT audit_id::text AS audit_id, tenant_id, person_id, session_id, device_id, type, decision, tool_id, action, capability_class, payload FROM audit_events WHERE type = $1 ORDER BY audit_events.audit_id", [EVOLUTION_DECISION_AUDIT_TYPE]
  )).rows as AuditRow[];
  return rows.filter((r) => (changeId === undefined || r.payload["change_id"] === changeId) && (tenant === undefined || r.tenant_id === tenant));
}
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["audit_events", "evolution_change_ledger", "cost_events", "tasks", "payment_intents", "memory_items", "owner_control_state", "situation_autonomy_policies", "tenants", "people", "devices"]) {
    out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  }
  return out;
}
async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (err) { return (err as Error).message; }
  return "ingen feil";
}
const record = (identity: IdentityContext, change_id: string, decision: string, digest?: string) =>
  recorder.record(identity, { change_id, proposal_digest: digest ?? seedLedger.get(change_id) ?? "0".repeat(64), decision: decision as never });

beforeAll(async () => {
  db = await startH0Db("b3a");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: OWNER_A }, { tenant_id: TENANT_B, person_id: OWNER_B }]);
  recorder = createEvolutionDecisionRecorder(db.appPool);
  const ledger = new ChangeLedger(admin);
  const row = (change_id: string, change_class: "E0" | "E1" | "E2" | "E3", decision: "proposed" | "approved" | "rejected" | "blocked") =>
    ledger.append({ change_id, change_class, decision, constitution_digest: DIGEST, subject: SECRET_SUBJECT, paths: [SECRET_PATH, "docs/x.md"], branch: SECRET_BRANCH, head_sha: null, evidence: { note: SECRET_EVIDENCE }, recorded_by: "hemmelig-forslagsstiller" });
  const open = async (id: string, cls: "E0" | "E1" | "E2" | "E3"): Promise<void> => { await row(id, cls, "proposed"); seedLedger.set(id, await lastHash(id)); };
  await open("a1", "E1");
  await open("a2", "E2");
  await open("a3", "E3");
  await open("a7", "E0");
  await open("a9", "E2");
  await row("a4", "E2", "proposed"); await row("a4", "E2", "rejected"); seedLedger.set("a4", await lastHash("a4"));
  await row("a5", "E2", "proposed"); await row("a5", "E2", "approved"); seedLedger.set("a5", await lastHash("a5"));
  await row("a6", "E1", "proposed"); seedLedger.set("a6-old", await lastHash("a6")); await row("a6", "E1", "rejected"); await row("a6", "E1", "proposed"); seedLedger.set("a6", await lastHash("a6"));
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("1. skriver ÉN revisjonsrad med før-bilde - og ingenting annet", () => {
  it("registrerer en godkjenning: raden har riktig type/handling/klasse, hvem (person/enhet/økt), versjonen, klassen, før-bildet og at det er uten virkning", async () => {
    const before = await counts();
    const result = await record(A, "a1", "approve");
    expect(result).toEqual({ outcome: "recorded", decision: "approve", change_id: "a1", proposal_digest: seedLedger.get("a1"), previous_decision: null, effect: "none", activation_decision: false });
    const rows = await decisionRows("a1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, person_id: OWNER_A, session_id: `s-${OWNER_A}`, device_id: `dev-${OWNER_A}`, type: "evolution.owner_decision", decision: "ALLOW", tool_id: "executive", action: "record_evolution_decision", capability_class: "C" });
    expect(rows[0]?.payload).toMatchObject({
      change_id: "a1", proposal_digest: seedLedger.get("a1"), change_class: "E1", decision: "approve", before: { decision: null, decided_at: null },
      ledger: { state: "proposed" }, effect: "none", activation_decision: false, channel: "web", auth_strength: "signed", memory_space: "personal"
    });
    expect(typeof (rows[0]?.payload["ledger"] as { seq: unknown }).seq).toBe("string");
    expect(String(rows[0]?.payload["note"])).toContain("INGEN virkning");
    const after = await counts();
    expect(after["audit_events"]).toBe((before["audit_events"] ?? 0) + 1);
    for (const table of Object.keys(before).filter((t) => t !== "audit_events")) expect(after[table], table).toBe(before[table]);
  });

  it("endringsregisteret er URØRT: samme rader, intakt hash-kjede, og forslaget er fortsatt `proposed` (ingenting er godkjent der)", async () => {
    const verify = await new ChangeLedger(db.adminPool).verify();
    expect(verify.ok).toBe(true);
    const latest = (await db.adminPool.query("SELECT decision FROM evolution_change_ledger WHERE change_id = 'a1' ORDER BY seq DESC LIMIT 1")).rows[0];
    expect(latest.decision).toBe("proposed");
    expect(Number((await db.adminPool.query("SELECT count(*) AS n FROM evolution_change_ledger WHERE decision IN ('approved', 'merged', 'deployed') AND change_id = 'a1'")).rows[0].n)).toBe(0);
  });

  it("INNHOLDSVERN: ingen forslagstekst, sti, evidens, gren eller forslagsstiller havner i revisjonsraden", async () => {
    const out = JSON.stringify(await decisionRows());
    for (const secret of [SECRET_SUBJECT, SECRET_PATH, SECRET_EVIDENCE, SECRET_BRANCH, "hemmelig-forslagsstiller", "docs/x.md"]) expect(out, secret).not.toContain(secret);
  });
});

describe("2. idempotent og sammenhengende før-bilder", () => {
  it("samme avgjørelse for samme versjon skrives ikke på nytt (`already_recorded`), og det forrige svaret står i resultatet", async () => {
    const before = (await decisionRows("a1")).length;
    const again = await record(A, "a1", "approve");
    expect(again).toMatchObject({ outcome: "already_recorded", decision: "approve", previous_decision: "approve", effect: "none", activation_decision: false });
    expect((await decisionRows("a1")).length).toBe(before);
  });

  it("ombestemmelse: den nye avgjørelsen overstyrer, før-bildet (forrige avgjørelse + når) står i den nye raden, og A→B→A gir tre rader", async () => {
    const reject = await record(A, "a1", "reject");
    expect(reject).toMatchObject({ outcome: "recorded", decision: "reject", previous_decision: "approve" });
    const approveAgain = await record(A, "a1", "approve");
    expect(approveAgain).toMatchObject({ outcome: "recorded", decision: "approve", previous_decision: "reject" });
    const rows = await decisionRows("a1");
    expect(rows.map((r) => r.payload["decision"])).toEqual(["approve", "reject", "approve"]);
    expect(rows.map((r) => (r.payload["before"] as { decision: unknown }).decision)).toEqual([null, "approve", "reject"]);
    expect(typeof (rows[1]?.payload["before"] as { decided_at: unknown }).decided_at).toBe("string");
    expect(await record(A, "a1", "approve")).toMatchObject({ outcome: "already_recorded" });
  });

  it("samtidighet: åtte parallelle klikk på samme avgjørelse gir NØYAKTIG én rad (advisory-lås per forslag)", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => record(A, "a7", "defer")));
    expect(results.filter((r) => r.outcome === "recorded")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "already_recorded")).toHaveLength(7);
    expect(await decisionRows("a7")).toHaveLength(1);
  });

  it("samtidighet med ULIKE avgjørelser: ingen to like etter hverandre, og hvert før-bilde er den forrige radens avgjørelse - kjeden er sammenhengende", async () => {
    const order = ["approve", "reject", "defer", "approve", "reject", "defer", "reject", "approve", "defer", "reject"];
    await Promise.all(order.map((d) => record(A, "a9", d)));
    const rows = await decisionRows("a9");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.length).toBeLessThanOrEqual(order.length);
    const seq = rows.map((r) => r.payload["decision"] as string);
    const befores = rows.map((r) => (r.payload["before"] as { decision: string | null }).decision);
    expect(befores[0]).toBeNull();
    for (let i = 1; i < rows.length; i += 1) {
      expect(seq[i], `rad ${i}`).not.toBe(seq[i - 1]);
      expect(befores[i], `rad ${i}`).toBe(seq[i - 1]);
    }
  });
});

describe("3. bundet til versjonen: et endret/omforeslått forslag kan ikke avgjøres på den gamle digesten", () => {
  it("a6 er omforeslått (proposed → rejected → proposed): den gamle digesten avvises, den nye godtas", async () => {
    expect(await refusal(record(A, "a6", "approve", seedLedger.get("a6-old")))).toBe("proposal_digest_mismatch");
    expect(await decisionRows("a6")).toHaveLength(0);
    expect(await record(A, "a6", "approve")).toMatchObject({ outcome: "recorded", previous_decision: null });
  });

  it("en avgjørelse om versjon 1 teller IKKE for versjon 2: etter omforeslaget er `previous_decision` null og den nye raden er uavhengig", async () => {
    const ledger = new ChangeLedger(db.adminPool);
    const base = { change_class: "E2" as const, constitution_digest: DIGEST, subject: SECRET_SUBJECT, paths: [], branch: "", head_sha: null, evidence: {}, recorded_by: "test" };
    await ledger.append({ ...base, change_id: "a8", decision: "proposed" });
    const v1 = await lastHash("a8");
    expect(await record(A, "a8", "approve", v1)).toMatchObject({ outcome: "recorded", previous_decision: null });
    await ledger.append({ ...base, change_id: "a8", decision: "rejected" });
    await ledger.append({ ...base, change_id: "a8", decision: "proposed" });
    const v2 = await lastHash("a8");
    expect(v2).not.toBe(v1);
    expect(await refusal(record(A, "a8", "approve", v1))).toBe("proposal_digest_mismatch");
    expect(await record(A, "a8", "approve", v2)).toMatchObject({ outcome: "recorded", previous_decision: null });
    const rows = await decisionRows("a8");
    expect(rows.map((r) => r.payload["proposal_digest"])).toEqual([v1, v2]);
  });
});

describe("4. avslag med FASTE koder: ukjent, lukket, E3, og ugyldig input - uten rader", () => {
  it("ukjent forslag og lukkede forslag (avvist, godkjent i registeret) avvises; ingenting skrives", async () => {
    const before = (await decisionRows()).length;
    expect(await refusal(record(A, "finnes-ikke", "approve", DIGEST))).toBe("proposal_not_found");
    expect(await refusal(record(A, "a4", "approve"))).toBe("proposal_not_open");
    expect(await refusal(record(A, "a5", "reject"))).toBe("proposal_not_open");
    expect((await decisionRows()).length).toBe(before);
  });

  it("E3 kan aldri godkjennes (registeret forbyr godkjent E3) - men kan avvises og utsettes", async () => {
    expect(await refusal(record(A, "a3", "approve"))).toBe("proposal_class_forbidden");
    expect(await record(A, "a3", "reject")).toMatchObject({ outcome: "recorded", decision: "reject" });
    expect(await record(A, "a3", "defer")).toMatchObject({ outcome: "recorded", decision: "defer", previous_decision: "reject" });
    expect((await decisionRows("a3")).map((r) => r.payload["decision"])).toEqual(["reject", "defer"]);
  });

  it("ugyldig input avvises FØR databasen røres (pool som kaster ved all bruk): injeksjon, hemmelighetsform, lengde, digest og avgjørelse", async () => {
    const poison = { connect: () => { throw new Error("databasen skal ikke røres"); }, query: () => { throw new Error("databasen skal ikke røres"); } } as unknown as pg.Pool;
    const guarded = createEvolutionDecisionRecorder(poison);
    const secretLike = ["sk", "ant", "Kanarifugl", "0123456789"].join("-");
    const good = { change_id: "a1", proposal_digest: DIGEST, decision: "approve" } as const;
    const bad: Array<Record<string, unknown>> = [
      { ...good, change_id: "x'; DROP TABLE audit_events; --" }, { ...good, change_id: "a1 OR 1=1" }, { ...good, change_id: "" }, { ...good, change_id: "x".repeat(61) }, { ...good, change_id: secretLike },
      { ...good, change_id: "har mellomrom" }, { ...good, change_id: "../../etc/passwd" }, { ...good, change_id: 5 }, { ...good, change_id: null },
      { ...good, proposal_digest: "E".repeat(64) }, { ...good, proposal_digest: "abc" }, { ...good, proposal_digest: `${"e".repeat(63)}'` }, { ...good, proposal_digest: 5 },
      { ...good, decision: "execute" }, { ...good, decision: "APPROVE" }, { ...good, decision: "" }, { ...good, decision: null }
    ];
    for (const input of bad) expect(await refusal(guarded.record(A, input as never)), JSON.stringify(input)).toBe("invalid_evolution_decision_input");
    expect(await refusal(guarded.record(A, null as never))).toBe("invalid_evolution_decision_input");
    expect(isDecidableChangeId("a1")).toBe(true);
    expect(isDecidableChangeId(secretLike)).toBe(false);
  });

  it("en databasefeil blir den FASTE koden `decision_record_failed` - feilteksten (vert, passord) når aldri kalleren", async () => {
    const broken = { connect: async () => { throw new Error("connect ECONNREFUSED hemmelig-db-vert.example:5432 password=hunter2"); } } as unknown as pg.Pool;
    const msg = await refusal(createEvolutionDecisionRecorder(broken).record(A, { change_id: "a1", proposal_digest: DIGEST, decision: "approve" }));
    expect(msg).toBe("decision_record_failed");
    expect((EVOLUTION_DECISION_REFUSALS as readonly string[]).includes(msg)).toBe(true);
  });

  it("alle faste avslagskoder skriveren kan kaste står i den lukkede listen", () => {
    for (const code of ["invalid_evolution_decision_input", "proposal_not_found", "proposal_not_open", "proposal_digest_mismatch", "proposal_class_forbidden", "decision_record_failed"]) {
      expect((EVOLUTION_DECISION_REFUSALS as readonly string[]).includes(code), code).toBe(true);
    }
  });
});

describe("5. tenant-isolasjon (RLS): en annen tenants avgjørelse påvirker verken idempotens eller visning", () => {
  it("B kan registrere SAMME avgjørelse om SAMME versjon uten å bli `already_recorded` av A sin - og hver tenant ser kun sine egne rader", async () => {
    const aApprove = (await decisionRows("a2", TENANT_A)).length;
    expect(await record(A, "a2", "approve")).toMatchObject({ outcome: "recorded", previous_decision: null });
    expect(await record(B, "a2", "approve")).toMatchObject({ outcome: "recorded", previous_decision: null });
    expect(await record(B, "a2", "approve")).toMatchObject({ outcome: "already_recorded" });
    expect((await decisionRows("a2", TENANT_A)).length).toBe(aApprove + 1);
    expect((await decisionRows("a2", TENANT_B)).length).toBe(1);
    const seenBy = async (tenant: string): Promise<string[]> => withTenantTransaction(db.appPool, tenant, async (c) =>
      (await c.query("SELECT tenant_id FROM audit_events WHERE type = $1", [EVOLUTION_DECISION_AUDIT_TYPE])).rows.map((r: { tenant_id: string }) => r.tenant_id));
    expect([...new Set(await seenBy(TENANT_A))]).toEqual([TENANT_A]);
    expect([...new Set(await seenBy(TENANT_B))]).toEqual([TENANT_B]);
  });

  it("raden bærer den identiteten som kalte (tenant og person fra konteksten) - aldri en annen", async () => {
    for (const r of await decisionRows("a2")) {
      if (r.tenant_id === TENANT_A) expect(r.person_id).toBe(OWNER_A);
      else expect(r.person_id).toBe(OWNER_B);
    }
  });
});

describe("6. Evolusjon-senteret viser avgjørelsen fra den EKTE tabellen og tilbyr riktige knapper", () => {
  const FACTS: ReadinessFacts = { constitution_verified: true, ledger_ok: true, change_freeze_off: true, proven_connectors: 0, job_runner_configured: false, declared_gates: new Set<string>() };
  const BOOT: Ev0BootStatus = { constitution: { status: "verified", version: 1, digest: "a".repeat(64) }, ledger: { status: "ok", count: 3, head_hash: "b".repeat(64) } };
  const report = async (): Promise<Pick<EvolutionReport, "sections"> & { as_of: string }> => ({ as_of: NOW.toISOString(), sections: [] });

  async function centerFor(identity: IdentityContext, approval: boolean): Promise<ControlCenterReport> {
    const registry = createControlCenterRegistry({ authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }, now: () => new Date() });
    registry.register(createEvolutionCenter({
      pool: db.appPool, env: {}, evolutionReport: report, readiness: async () => evaluateAllReadiness(FACTS), ev0Status: () => BOOT,
      ...(approval ? { approval: { risk_class: () => "C" as const, requires_step_up: true } } : {})
    }));
    return (await registry.report("evolution", identity)) as ControlCenterReport;
  }
  const item = (r: ControlCenterReport, id: string) => r.sections.find((s) => s.id === "ledger")?.items.find((i) => i.id === id);

  it("avgjørelsen vises for riktig versjon, knappen for den gjeldende avgjørelsen er skjult, E3 har aldri en godkjenn-knapp, og lukkede forslag er ikke listet", async () => {
    const r = await centerFor(A, true);
    expect(item(r, "proposal:a1")?.facts).toMatchObject({ owner_decision: "approve" });
    expect(item(r, "proposal:a3")?.facts).toMatchObject({ owner_decision: "defer" });
    expect(item(r, "proposal:a7")?.facts).toMatchObject({ owner_decision: "defer" });
    expect(item(r, "proposal:a4")).toBeUndefined();
    expect(item(r, "proposal:a5")).toBeUndefined();
    const decisionsFor = (id: string) => r.actions.filter((a) => a.item_id === `proposal:${id}`).map((a) => a.body["parameters"] && (a.body["parameters"] as Record<string, unknown>)["decision"]);
    expect(decisionsFor("a1")).toEqual(["reject", "defer"]);
    expect(decisionsFor("a3")).toEqual(["reject"]);
    expect(decisionsFor("a6")).toEqual(["reject", "defer"]);
    // a8 ble omforeslått og så godkjent på versjon 2: senteret viser avgjørelsen om DEN GJELDENDE versjonen
    expect(item(r, "proposal:a8")?.facts).toMatchObject({ owner_decision: "approve" });
  });

  it("versjonsbundet visning: en avgjørelse om versjon 1 vises IKKE for versjon 2 etter et omforslag - og alle tre knapper er tilbake", async () => {
    const ledger = new ChangeLedger(db.adminPool);
    const base = { change_class: "E2" as const, constitution_digest: DIGEST, subject: SECRET_SUBJECT, paths: [], branch: "", head_sha: null, evidence: {}, recorded_by: "test" };
    await ledger.append({ ...base, change_id: "a10", decision: "proposed" });
    const v1 = await lastHash("a10");
    expect(await record(A, "a10", "reject", v1)).toMatchObject({ outcome: "recorded" });
    const first = await centerFor(A, true);
    expect(item(first, "proposal:a10")?.facts).toMatchObject({ owner_decision: "reject" });
    expect(first.actions.filter((a) => a.item_id === "proposal:a10")).toHaveLength(2);
    await ledger.append({ ...base, change_id: "a10", decision: "rejected" });
    await ledger.append({ ...base, change_id: "a10", decision: "proposed" });
    const second = await centerFor(A, true);
    expect(item(second, "proposal:a10")?.facts).toMatchObject({ owner_decision: "none" });
    expect(second.actions.filter((a) => a.item_id === "proposal:a10")).toHaveLength(3);
    expect(await decisionRows("a10")).toHaveLength(1);
  });

  it("«siste» er den høyeste audit_id - IKKE den nyeste `at` (samtidige klikk kan få låsen i en annen rekkefølge enn de startet): både skriveren og senteret følger audit_id", async () => {
    const ledger = new ChangeLedger(db.adminPool);
    await ledger.append({ change_id: "a11", change_class: "E2", decision: "proposed", constitution_digest: DIGEST, subject: SECRET_SUBJECT, paths: [], branch: "", head_sha: null, evidence: {}, recorded_by: "test" });
    const digest = await lastHash("a11");
    const insert = (decision: string, minutesAgo: number): Promise<unknown> => db.adminPool.query(
      `INSERT INTO audit_events (at, tenant_id, person_id, type, decision, tool_id, action, capability_class, payload)
       VALUES (now() - make_interval(mins => $1), $2, $3, $4, 'ALLOW', 'executive', 'record_evolution_decision', 'C', $5::jsonb)`,
      [minutesAgo, TENANT_A, OWNER_A, EVOLUTION_DECISION_AUDIT_TYPE, JSON.stringify({ change_id: "a11", proposal_digest: digest, decision })]
    );
    await insert("approve", 0); // lavere audit_id, NYERE `at`
    await insert("reject", 5); // høyere audit_id, ELDRE `at` = den som faktisk ble registrert sist
    const r = await centerFor(A, true);
    expect(item(r, "proposal:a11")?.facts).toMatchObject({ owner_decision: "reject" });
    expect(await record(A, "a11", "reject", digest)).toMatchObject({ outcome: "already_recorded", previous_decision: "reject" });
    expect(await record(A, "a11", "approve", digest)).toMatchObject({ outcome: "recorded", previous_decision: "reject" });
  });

  it("hver knapps kropp er godtatt av `controlAction` og av det strenge skjemaet, og bærer HELE den gjeldende digesten fra endringsregisteret", async () => {
    const r = await centerFor(A, true);
    expect(r.actions.length).toBeGreaterThan(0);
    for (const a of r.actions) {
      expect(() => controlAction({ id: a.id, label: a.label, endpoint: a.endpoint, body: a.body, risk_class: a.risk_class, requires_step_up: a.requires_step_up, reversible: a.reversible, description_no: a.description_no })).not.toThrow();
      const p = a.body["parameters"] as { change_id: string; proposal_digest: string; decision: string };
      expect(p.proposal_digest).toBe(await lastHash(p.change_id));
      expect(p.proposal_digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("tenant-isolert visning: B ser kun sin egen avgjørelse (a2: godkjent) og ingen av A sine", async () => {
    const r = await centerFor(B, true);
    expect(item(r, "proposal:a2")?.facts).toMatchObject({ owner_decision: "approve" });
    expect(item(r, "proposal:a1")?.facts).toMatchObject({ owner_decision: "none" });
    expect(item(r, "proposal:a3")?.facts).toMatchObject({ owner_decision: "none" });
    expect(JSON.stringify(r)).not.toContain(OWNER_A);
  });

  it("uten `approval` (flagget AV) er senteret uendret: ingen avgjørelsesfakta, ingen knapper, selv om avgjørelser finnes i revisjonssporet", async () => {
    const r = await centerFor(A, false);
    expect(r.actions).toEqual([]);
    expect(item(r, "proposal:a1")?.facts).not.toHaveProperty("owner_decision");
  });

  it("senteret skriver ingenting: radtallene er uendret etter bygging (med og uten `approval`)", async () => {
    const before = await counts();
    await centerFor(A, true);
    await centerFor(A, false);
    expect(await counts()).toEqual(before);
  });
});
