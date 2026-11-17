import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import type { ControlCenterReport, ControlSection } from "@jarvis/executive";
import { ChangeLedger, evaluateAllReadiness, type ReadinessFacts } from "@jarvis/self-modification";
import type { Ev0BootStatus } from "../src/ev0-boot.ts";
import { createEvolutionDecisionRecorder } from "../src/evolution-decisions.ts";
import { createEvolutionCenter, MAX_LISTED_PROPOSALS } from "../src/control-center/evolution.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-B3 (D-475) - GJENNOMGANG L5 mot EKTE Postgres som app-rollen (RLS) og det EKTE endringsregisteret: Evolusjon-senteret lister de NYESTE forslagene UTEN eierens registrerte avgjørelse.
 * Før fiksen listet senteret de 20 ELDSTE åpne forslagene, og en registrert avgjørelse lar ledgerraden stå `proposed` (ingen virkning) - så avgjorte forslag ble i listen, fylte den og skjulte nyere forslag.
 *  - 30 åpne forslag (`lst-01` eldst ... `lst-30` nyest; ledger-seq krysser 9, 19 og 29 - en tekstsortering ville gitt feil rekkefølge), eieren A har avgjort de 8 nyeste og de 2 eldste;
 *  - A ser de 20 uavgjorte NYEST FØRST, ingen avgjort rad tar en plass, og de 10 skjulte telles (alle avgjorte); B (en annen tenant, ingen avgjørelser) ser ALDRI A sine avgjørelser (RLS);
 *  - et NYTT forslag kommer øverst; et avgjort forslag som OMFORESLÅS (ny versjon) er uavgjort igjen og listes først; knappene bærer gjeldende digest og skriveren godtar dem.
 */
const TENANT_A = "tenant-b3l-a";
const TENANT_B = "tenant-b3l-b";
const OWNER_A = "person-b3l-a";
const OWNER_B = "person-b3l-b";
const DIGEST = "a".repeat(64);
const idFor = (person: string, tenant: string): IdentityContext => ({ person_id: person, tenant_id: tenant, memory_space_id: "personal", session_id: `s-${person}`, device_id: `dev-${person}`, channel: "web", auth_strength: "signed" });
const A = idFor(OWNER_A, TENANT_A);
const B = idFor(OWNER_B, TENANT_B);
const FACTS: ReadinessFacts = { constitution_verified: true, ledger_ok: true, change_freeze_off: true, proven_connectors: 0, job_runner_configured: false, declared_gates: new Set<string>() };
const BOOT: Ev0BootStatus = { constitution: { status: "verified", version: 1, digest: "a".repeat(64) }, ledger: { status: "ok", count: 40, head_hash: "b".repeat(64) } };
const nn = (n: number): string => `lst-${String(n).padStart(2, "0")}`;

let db: H0Db;
let ledger: ChangeLedger;
let recorder: ReturnType<typeof createEvolutionDecisionRecorder>;
const append = (change_id: string, decision: "proposed" | "rejected" | "blocked", cls: "E1" | "E3" = "E1"): Promise<unknown> =>
  ledger.append({ change_id, change_class: cls, decision, constitution_digest: DIGEST, subject: "fast-testtekst", paths: [], branch: "", head_sha: null, evidence: {}, recorded_by: "test" });
const hashOf = async (id: string): Promise<string> => String((await db.adminPool.query("SELECT entry_hash FROM evolution_change_ledger WHERE change_id = $1 ORDER BY evolution_change_ledger.seq DESC LIMIT 1", [id])).rows[0].entry_hash);
const decide = async (identity: IdentityContext, id: string, decision = "reject"): Promise<string> =>
  (await recorder.record(identity, { change_id: id, proposal_digest: await hashOf(id), decision: decision as never })).outcome;

async function centerFor(identity: IdentityContext): Promise<ControlCenterReport> {
  const registry = createControlCenterRegistry({ authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }, now: () => new Date() });
  registry.register(createEvolutionCenter({
    pool: db.appPool, env: {}, evolutionReport: async () => ({ as_of: new Date().toISOString(), sections: [] }), readiness: async () => evaluateAllReadiness(FACTS), ev0Status: () => BOOT,
    approval: { risk_class: () => "C" as const, requires_step_up: true }
  }));
  return (await registry.report("evolution", identity)) as ControlCenterReport;
}
const ledgerOf = (r: ControlCenterReport): ControlSection => r.sections.find((s) => s.id === "ledger") as ControlSection;
const listedOf = (r: ControlCenterReport): string[] => ledgerOf(r).items.filter((i) => i.id.startsWith("proposal:lst-")).map((i) => i.id.slice("proposal:".length));
const itemOf = (r: ControlCenterReport, id: string) => ledgerOf(r).items.find((i) => i.id === id);
const range = (from: number, to: number): string[] => (from <= to ? Array.from({ length: to - from + 1 }, (_, i) => nn(from + i)) : Array.from({ length: from - to + 1 }, (_, i) => nn(from - i)));

beforeAll(async () => {
  db = await startH0Db("b3l");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT_A, person_id: OWNER_A }, { tenant_id: TENANT_B, person_id: OWNER_B }]);
  ledger = new ChangeLedger(db.adminPool);
  recorder = createEvolutionDecisionRecorder(db.appPool);
  for (let i = 1; i <= 30; i += 1) await append(nn(i), "proposed"); // lst-01 eldst ... lst-30 nyest (seq 1-30)
  await append("lukket-1", "proposed"); await append("lukket-1", "rejected"); // lukket: aldri listet
  await append("lukket-2", "blocked");
  // A har avgjort de 8 NYESTE og de 2 ELDSTE (ingen virkning: ledgerraden står fortsatt `proposed`)
  for (const id of [...range(23, 30), nn(1), nn(2)]) expect(await decide(A, id, id === nn(30) ? "defer" : "reject")).toBe("recorded");
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("L5: A (10 av 30 avgjort) ser de 20 NYESTE uavgjorte - nyest først - og de skjulte telles", () => {
  it("lister lst-22 ... lst-03 i NUMERISK ledger-rekkefølge (nyest først; en tekstsortering ville satt lst-09 foran lst-30), ingen avgjort rad tar en plass, og ingen lukket forslag er med", async () => {
    const r = await centerFor(A);
    expect(listedOf(r)).toEqual(range(22, 3));
    expect(listedOf(r)).toHaveLength(MAX_LISTED_PROPOSALS);
    expect(ledgerOf(r).items.some((i) => i.id.includes("lukket"))).toBe(false);
    for (const decided of [...range(23, 30), nn(1), nn(2)]) expect(listedOf(r), decided).not.toContain(decided);
  });

  it("de 10 skjulte er alle avgjorte (ingen uavgjorte skjult), og tellingene stemmer: 30 åpne, 20 uten avgjørelse, 10 med", async () => {
    const r = await centerFor(A);
    expect(itemOf(r, "proposals_more")?.facts).toEqual({ not_listed: 10, undecided_not_listed: 0, decided_not_listed: 10, unchecked: 0 });
    expect(itemOf(r, "proposals")?.facts).toMatchObject({ waiting: 30, undecided: 20, decided: 10, unchecked: 0 });
    expect(itemOf(r, "proposals")?.detail_no).toContain("20 uten din registrerte avgjørelse, 10 med");
  });
});

describe("L5: tenant-isolasjon (RLS) - A sine avgjørelser er aldri synlige for B og skjuler ingenting for B", () => {
  it("B (ingen egne avgjørelser) ser de 20 NYESTE (lst-30 ... lst-11), og de 10 skjulte er alle UAVGJORTE for B", async () => {
    const r = await centerFor(B);
    expect(listedOf(r)).toEqual(range(30, 11));
    expect(itemOf(r, "proposals_more")?.facts).toEqual({ not_listed: 10, undecided_not_listed: 10, decided_not_listed: 0, unchecked: 0 });
    expect(itemOf(r, "proposals")?.facts).toMatchObject({ waiting: 30, undecided: 30, decided: 0 });
    for (const id of listedOf(r)) expect(itemOf(r, `proposal:${id}`)?.facts, id).toMatchObject({ owner_decision: "none" });
    expect(JSON.stringify(r)).not.toContain(OWNER_A);
  });
});

describe("L5: nye og omforeslåtte forslag kommer øverst", () => {
  it("et NYTT forslag (lst-31) står øverst for A; det eldste uavgjorte (lst-03) faller ut til «ikke vist» (1 uavgjort + 10 avgjorte skjult)", async () => {
    await append(nn(31), "proposed");
    const r = await centerFor(A);
    expect(listedOf(r)).toEqual([nn(31), ...range(22, 4)]);
    expect(listedOf(r)).not.toContain(nn(3));
    expect(itemOf(r, "proposals_more")?.facts).toEqual({ not_listed: 11, undecided_not_listed: 1, decided_not_listed: 10, unchecked: 0 });
    expect(itemOf(r, "proposals")?.facts).toMatchObject({ waiting: 31, undecided: 21, decided: 10 });
  });

  it("et AVGJORT forslag (lst-25: avvist) som OMFORESLÅS (avvist og så foreslått på nytt = ny versjon) er uavgjort igjen: listes FØRST (nyest) uten avgjørelse og med alle tre knapper", async () => {
    const decidedBefore = Number(itemOf(await centerFor(A), "proposals")?.facts?.["decided"]);
    await append(nn(25), "rejected");
    await append(nn(25), "proposed");
    const r = await centerFor(A);
    expect(listedOf(r)[0]).toBe(nn(25));
    expect(listedOf(r)).toEqual([nn(25), nn(31), ...range(22, 5)]);
    expect(itemOf(r, `proposal:${nn(25)}`)?.facts).toMatchObject({ owner_decision: "none", digest: (await hashOf(nn(25))).slice(0, 12) });
    expect(r.actions.filter((a) => a.item_id === `proposal:${nn(25)}`)).toHaveLength(3);
    expect(Number(itemOf(r, "proposals")?.facts?.["decided"])).toBe(decidedBefore - 1);
    // en avgjørelse om den gamle versjonen finnes fortsatt i revisjonssporet, men teller ikke for den nye: en ny registrering er `recorded` uten forrige avgjørelse
    const fresh = await recorder.record(A, { change_id: nn(25), proposal_digest: await hashOf(nn(25)), decision: "approve" });
    expect(fresh).toMatchObject({ outcome: "recorded", previous_decision: null });
  });
});

describe("L5: knappene følger de listede radene, bærer gjeldende digest, og skriveren godtar dem", () => {
  it("kun de 20 listede (uavgjorte) radene har knapper (3 hver), digesten er den numerisk siste raden i registeret, og skriveren godtar den (ikke `proposal_digest_mismatch`)", async () => {
    const r = await centerFor(A);
    const listed = listedOf(r);
    expect(listed).toEqual([nn(31), ...range(22, 4)]);
    expect(new Set(r.actions.map((a) => a.item_id))).toEqual(new Set(listed.map((id) => `proposal:${id}`)));
    expect(r.actions).toHaveLength(60);
    const before = Number((await db.adminPool.query("SELECT count(*) AS n FROM audit_events WHERE type = 'evolution.owner_decision'")).rows[0].n);
    for (const id of [nn(31), nn(4)]) {
      const button = r.actions.find((a) => a.item_id === `proposal:${id}` && (a.body["parameters"] as { decision: string }).decision === "defer");
      const p = button?.body["parameters"] as { change_id: string; proposal_digest: string; decision: string };
      expect(p.proposal_digest).toBe(await hashOf(id));
      expect((await recorder.record(A, p as never)).outcome).toBe("recorded");
    }
    expect(Number((await db.adminPool.query("SELECT count(*) AS n FROM audit_events WHERE type = 'evolution.owner_decision'")).rows[0].n)).toBe(before + 2);
  });
});
