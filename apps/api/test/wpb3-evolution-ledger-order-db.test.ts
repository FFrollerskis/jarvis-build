import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { EVOLUTION_DECISIONS, type ControlCenterReport } from "@jarvis/executive";
import { ChangeLedger, evaluateAllReadiness, type ReadinessFacts } from "@jarvis/self-modification";
import type { Ev0BootStatus } from "../src/ev0-boot.ts";
import { createEvolutionDecisionRecorder } from "../src/evolution-decisions.ts";
import { createEvolutionCenter } from "../src/control-center/evolution.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-B3 (D-475, EV-23) - GJENNOMGANG H1: «siste» rad i endringsregisteret MÅ sorteres NUMERISK på `seq` (bigint), aldri leksikografisk.
 * Skriveren valgte `SELECT seq::text AS seq ... ORDER BY seq DESC` - et bart `ORDER BY seq` peker på utdatakolonnen (tekst-aliaset), så «9» ble «større enn» «10» og «99» «større enn» «100». Byggerens tester krysset aldri et siffergrense
 * (ledger-seq <= 12), så feilen var usynlig. DENNE filen krysser 9 -> 10 og 99 -> 100 mot EKTE Postgres som app-rollen (`jarvis_app`, RLS) og det EKTE endringsregisteret (hash-kjede, migrasjon 075):
 *  1. Repro 1 (seq 9 `proposed`, seq 10 `rejected`): enhver avgjørelse med den GAMLE digesten MÅ gi `proposal_not_open` (gammel kode: `recorded` - en avgjørelse på et lukket forslag);
 *  2. Repro 2 (seq 99 `proposed` E2, seq 100 `proposed` E3): gammel digest MÅ gi `proposal_digest_mismatch` (versjonsbindingen), den AKTUELLE (E3) kan aldri godkjennes (`proposal_class_forbidden`) men kan avvises/utsettes
 *     (gammel kode: gammel digest ble `recorded` - omgikk BÅDE versjonsbindingen og «E3 aldri godkjent»; den aktuelle ga `proposal_digest_mismatch`, så eieren kunne ikke registrere noe);
 *  3. en fullstendig SVEIP: for HVER endring i et register på over 100 rader (alle seq-grenser) er utfallet for hver (avgjørelse x digest) lik det en numerisk orakel-spørring (`ORDER BY evolution_change_ledger.seq`) gir;
 *  4. Evolusjon-senteret og skriveren er ENIGE over siffergrensen: digesten senteret viser/knappene bærer (siste rad numerisk) er den skriveren godtar.
 */
const TENANT = "tenant-b3-order";
const OWNER = "person-b3-order";
const DIGEST = "d".repeat(64);
const owner: IdentityContext = { person_id: OWNER, tenant_id: TENANT, memory_space_id: "personal", session_id: `s-${OWNER}`, device_id: `dev-${OWNER}`, channel: "web", auth_strength: "signed" };

type Cls = "E0" | "E1" | "E2" | "E3";
type Dec = "proposed" | "approved" | "rejected" | "blocked";
interface Row { seq: number; change_id: string; cls: Cls; decision: Dec; hash: string }

let db: H0Db;
let ledger: ChangeLedger;
let recorder: ReturnType<typeof createEvolutionDecisionRecorder>;
const rows: Row[] = [];

async function add(change_id: string, cls: Cls, decision: Dec): Promise<Row> {
  const r = await ledger.append({ change_id, change_class: cls, decision, constitution_digest: DIGEST, subject: "fast-testtekst", paths: [], branch: "", head_sha: null, evidence: {}, recorded_by: "test" });
  const row: Row = { seq: Number(r.seq), change_id, cls, decision, hash: r.entry_hash };
  rows.push(row);
  return row;
}
/** Legger fyllrader (egne, LUKKEDE endringer: én `blocked`-rad hver) til neste ledger-`seq` er `target` - lukket, så få forslag står åpne og senteret viser dem alle. */
async function fillTo(target: number): Promise<void> {
  while ((rows.at(-1)?.seq ?? 0) + 1 < target) await add(`fyll-${String((rows.at(-1)?.seq ?? 0) + 1).padStart(3, "0")}`, "E1", "blocked");
}
async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (err) { return (err as Error).message; }
  return "ingen feil";
}
const decide = (change_id: string, decision: string, digest: string) => recorder.record(owner, { change_id, proposal_digest: digest, decision: decision as never });
const outcome = async (change_id: string, decision: string, digest: string): Promise<string> => {
  try { return (await decide(change_id, decision, digest)).outcome; } catch (err) { return (err as Error).message; }
};
async function auditCount(): Promise<number> {
  return Number((await db.adminPool.query("SELECT count(*) AS n FROM audit_events WHERE type = 'evolution.owner_decision'")).rows[0].n);
}

// Navn som brukes både i oppbyggingen og i testene.
const X9 = "x-ni-ti"; // seq 9 `proposed`, seq 10 `rejected`
const Y = "y-omforeslatt"; // seq 11 proposed, 12 rejected, 13 proposed (omforeslått)
const Z99 = "z-nittini-hundre"; // seq 99 proposed E2, seq 100 proposed E3

beforeAll(async () => {
  db = await startH0Db("b3ord");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT, person_id: OWNER }]);
  ledger = new ChangeLedger(db.adminPool);
  recorder = createEvolutionDecisionRecorder(db.appPool);
  await fillTo(9); // seq 1-8
  await add(X9, "E1", "proposed"); // seq 9
  await add(X9, "E1", "rejected"); // seq 10
  await add(Y, "E2", "proposed"); // seq 11
  await add(Y, "E2", "rejected"); // seq 12
  await add(Y, "E2", "proposed"); // seq 13 (omforeslått: ny versjon, nytt digest)
  await fillTo(99); // seq 14-98
  await add(Z99, "E2", "proposed"); // seq 99
  await add(Z99, "E3", "proposed"); // seq 100 (samme forslag, nå klassifisert E3)
  await add("w-lukket-101", "E1", "proposed"); // seq 101
  await add("w-lukket-101", "E1", "approved"); // seq 102
  await add("v-blokkert-103", "E2", "proposed"); // seq 103
  await add("v-blokkert-103", "E2", "blocked"); // seq 104
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

const rowsOf = (id: string): Row[] => rows.filter((r) => r.change_id === id);

describe("0. forutsetning: oppbyggingen krysser begge siffergrensene (ellers beviser testene ingenting)", () => {
  it("registeret har rader med seq 9, 10, 99, 100 og over 100 rader, og `seq` er et ekte heltall i databasen (bigint)", async () => {
    const seqs = rows.map((r) => r.seq);
    expect(seqs.slice(0, 13)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(seqs).toContain(99);
    expect(seqs).toContain(100);
    expect(rows.length).toBeGreaterThan(100);
    expect(rowsOf(X9).map((r) => [r.seq, r.decision])).toEqual([[9, "proposed"], [10, "rejected"]]);
    expect(rowsOf(Z99).map((r) => [r.seq, r.cls])).toEqual([[99, "E2"], [100, "E3"]]);
    const type = (await db.adminPool.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'evolution_change_ledger' AND column_name = 'seq'")).rows[0].data_type;
    expect(type).toBe("bigint");
  });
});

describe("1. Repro 1: seq 9 `proposed`, seq 10 `rejected` - forslaget er LUKKET, uansett hvilken digest eieren sender", () => {
  it("avgjørelse (godkjenn, avvis, utsett) med den GAMLE digesten (rad 9) gir `proposal_not_open` - aldri `recorded`", async () => {
    const [open9, closed10] = rowsOf(X9) as [Row, Row];
    for (const decision of EVOLUTION_DECISIONS) expect(await outcome(X9, decision, open9.hash), decision).toBe("proposal_not_open");
    for (const decision of EVOLUTION_DECISIONS) expect(await outcome(X9, decision, closed10.hash), decision).toBe("proposal_not_open");
    expect(await auditCount()).toBe(0);
  });

  it("samme for forslaget som ble omforeslått over grensen (12 rejected -> 13 proposed): den eldste versjonen (11) og den avviste (12) er utdatert, kun den aktuelle (13) godtas", async () => {
    const [v1, closed, v2] = rowsOf(Y) as [Row, Row, Row];
    expect(await outcome(Y, "approve", v1.hash)).toBe("proposal_digest_mismatch");
    expect(await outcome(Y, "reject", closed.hash)).toBe("proposal_digest_mismatch");
    expect(await auditCount()).toBe(0);
    expect(await outcome(Y, "approve", v2.hash)).toBe("recorded");
  });
});

describe("2. Repro 2: seq 99 `proposed` E2, seq 100 `proposed` E3 - siste rad er 100, ikke 99", () => {
  it("den GAMLE (E2) digesten gir `proposal_digest_mismatch` for alle avgjørelser - versjonsbindingen kan ikke omgås", async () => {
    const [old99] = rowsOf(Z99) as [Row, Row];
    const before = await auditCount();
    for (const decision of EVOLUTION_DECISIONS) expect(await outcome(Z99, decision, old99.hash), decision).toBe("proposal_digest_mismatch");
    expect(await auditCount()).toBe(before);
  });

  it("den AKTUELLE digesten (E3): godkjenning nektes (`proposal_class_forbidden`: E3 kan aldri godkjennes), avvisning og utsettelse registreres - eieren er ikke utestengt", async () => {
    const [, current] = rowsOf(Z99) as [Row, Row];
    expect(await outcome(Z99, "approve", current.hash)).toBe("proposal_class_forbidden");
    const reject = await decide(Z99, "reject", current.hash);
    expect(reject).toMatchObject({ outcome: "recorded", decision: "reject", previous_decision: null, change_id: Z99, proposal_digest: current.hash });
    expect(await decide(Z99, "defer", current.hash)).toMatchObject({ outcome: "recorded", previous_decision: "reject" });
    expect(await decide(Z99, "defer", current.hash)).toMatchObject({ outcome: "already_recorded" });
    // revisjonsraden binder den aktuelle (E3-)versjonen og klassen, og ledger-seq er den numerisk siste raden (100), ikke 99
    const audit = (await db.adminPool.query("SELECT payload FROM audit_events WHERE type = 'evolution.owner_decision' AND payload->>'change_id' = $1 ORDER BY audit_events.audit_id", [Z99])).rows.map((r: { payload: Record<string, unknown> }) => r.payload);
    expect(audit.map((p) => p["decision"])).toEqual(["reject", "defer"]);
    for (const p of audit) {
      expect(p["proposal_digest"]).toBe(current.hash);
      expect(p["change_class"]).toBe("E3");
      expect((p["ledger"] as { seq: string }).seq).toBe("100");
    }
  });

  it("lukkede forslag over 100 (godkjent, blokkert) er `proposal_not_open` selv om en eldre rad er `proposed`", async () => {
    for (const id of ["w-lukket-101", "v-blokkert-103"]) {
      for (const row of rowsOf(id)) for (const decision of EVOLUTION_DECISIONS) expect(await outcome(id, decision, row.hash), `${id}/${decision}`).toBe("proposal_not_open");
    }
  });
});

describe("3. sveip over HELE registeret: utfallet følger en numerisk orakel-spørring for hver endring, avgjørelse og digest", () => {
  it("for hver endring (alle seq-grenser) er utfallet lik oraklet - gamle digester, lukkede forslag, aktuell digest og E3", async () => {
    const oracleLatest = async (id: string): Promise<{ decision: string; change_class: string; entry_hash: string }> => (await db.adminPool.query(
      // Orakel: kvalifisert `ORDER BY` (numerisk bigint) - aldri det bare aliaset.
      "SELECT decision, change_class, entry_hash FROM evolution_change_ledger WHERE change_id = $1 ORDER BY evolution_change_ledger.seq DESC LIMIT 1", [id]
    )).rows[0];
    const ids = [...new Set(rows.map((r) => r.change_id))];
    expect(ids.length).toBeGreaterThan(90);
    let checked = 0;
    for (const id of ids) {
      const latest = await oracleLatest(id);
      const all = rowsOf(id);
      expect(all.at(-1)?.hash, `${id}: testens egen siste rad er den numerisk siste`).toBe(latest.entry_hash);
      for (const old of all.filter((r) => r.hash !== latest.entry_hash)) {
        for (const decision of EVOLUTION_DECISIONS) {
          const expected = latest.decision !== "proposed" ? "proposal_not_open" : "proposal_digest_mismatch";
          expect(await outcome(id, decision, old.hash), `${id} seq ${old.seq} ${decision} (gammel digest)`).toBe(expected);
          checked += 1;
        }
      }
      if (latest.decision !== "proposed") {
        for (const decision of EVOLUTION_DECISIONS) { expect(await outcome(id, decision, latest.entry_hash), `${id} ${decision} (lukket)`).toBe("proposal_not_open"); checked += 1; }
        continue;
      }
      // åpent forslag: kun den aktuelle digesten godtas; E3 kan aldri godkjennes. (Z99/Y er allerede avgjort i testene over: `recorded`/`already_recorded` er begge «godtatt».)
      const accepted = async (decision: string): Promise<boolean> => ["recorded", "already_recorded"].includes(await outcome(id, decision, latest.entry_hash));
      expect(await accepted("defer"), `${id} defer (aktuell)`).toBe(true);
      if (latest.change_class === "E3") expect(await outcome(id, "approve", latest.entry_hash), `${id} approve (E3)`).toBe("proposal_class_forbidden");
      else expect(await accepted("approve"), `${id} approve (aktuell)`).toBe(true);
      checked += 2;
    }
    expect(checked).toBeGreaterThan(250);
  });

  it("registeret er URØRT av alle disse kallene: samme antall rader og intakt hash-kjede (ingen skriving til endringsregisteret)", async () => {
    expect(Number((await db.adminPool.query("SELECT count(*) AS n FROM evolution_change_ledger")).rows[0].n)).toBe(rows.length);
    expect((await ledger.verify()).ok).toBe(true);
  });
});

describe("4. Evolusjon-senteret og skriveren er ENIGE over siffergrensen", () => {
  const FACTS: ReadinessFacts = { constitution_verified: true, ledger_ok: true, change_freeze_off: true, proven_connectors: 0, job_runner_configured: false, declared_gates: new Set<string>() };
  const BOOT: Ev0BootStatus = { constitution: { status: "verified", version: 1, digest: "a".repeat(64) }, ledger: { status: "ok", count: 104, head_hash: "b".repeat(64) } };

  it("digesten senteret viser (12 tegn) og knappene bærer (hele) er den numerisk siste raden - og skriveren godtar akkurat den (Z99 = seq 100, Y = seq 13)", async () => {
    const registry = createControlCenterRegistry({ authority: { owner_person_id: OWNER, owner_tenants: [TENANT] }, now: () => new Date() });
    registry.register(createEvolutionCenter({
      pool: db.appPool, env: {}, evolutionReport: async () => ({ as_of: new Date().toISOString(), sections: [] }), readiness: async () => evaluateAllReadiness(FACTS), ev0Status: () => BOOT,
      approval: { risk_class: () => "C" as const, requires_step_up: true }
    }));
    const report = (await registry.report("evolution", owner)) as ControlCenterReport;
    const items = report.sections.find((s) => s.id === "ledger")?.items ?? [];
    const z = items.find((i) => i.id === `proposal:${Z99}`);
    const y = items.find((i) => i.id === `proposal:${Y}`);
    const [, z100] = rowsOf(Z99) as [Row, Row];
    const [, , y13] = rowsOf(Y) as [Row, Row, Row];
    expect(z?.facts).toMatchObject({ change_class: "E3", digest: z100.hash.slice(0, 12) });
    expect(y?.facts).toMatchObject({ change_class: "E2", digest: y13.hash.slice(0, 12) });
    const buttons = report.actions.filter((a) => a.item_id === `proposal:${Z99}` || a.item_id === `proposal:${Y}`);
    expect(buttons.length).toBeGreaterThan(0);
    for (const a of buttons) {
      const p = a.body["parameters"] as { change_id: string; proposal_digest: string; decision: string };
      expect(p.proposal_digest, a.id).toBe(p.change_id === Z99 ? z100.hash : y13.hash);
      // skriveren godtar knappens digest (ikke `proposal_digest_mismatch`): enten ny registrering eller en tidligere registrert (`already_recorded`)
      expect(["recorded", "already_recorded"], a.id).toContain(await outcome(p.change_id, p.decision, p.proposal_digest));
    }
    // E3 har aldri en godkjenn-knapp
    expect(buttons.filter((a) => a.item_id === `proposal:${Z99}`).map((a) => (a.body["parameters"] as { decision: string }).decision)).not.toContain("approve");
  });
});
