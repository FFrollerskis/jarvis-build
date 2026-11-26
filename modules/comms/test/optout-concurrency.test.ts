import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommsStore, optOutHash, recipientHint } from "../src/index.ts";
import { OWNER, startCommsDb, TENANT_A, type CommsDb } from "./support/harness.ts";

/**
 * WP-G1c fiks-runde 1 (FIX-6 b og f): to hull i mutasjonsbatteriet.
 *  - K03: `recordOptOut` (eierens `record_opt_out` og leverandørfeil 21610) uten mottakerlås ga `duplicate key ... comms_recipient_opt_outs_active_uq` ved samtidige kall. Nå er skrivingen i tillegg IDEMPOTENT (ON CONFLICT DO NOTHING + ny lesing),
 *    og begge lagene er bevist hver for seg: låsen finnes (en annen transaksjon som holder den, stenger ute), og skrivingen tåler samtidighet selv uten den.
 *  - M05: rekkefølgen mellom STOP og START avgjøres av DATABASENS sekvens (`comms_event_seq`), aldri av en klokke: å bytte `nextval(..)` mot `clock_timestamp()` overlevde alle comms-testene.
 */
const LOCK_SEED = 7340464;
const FROZEN = new Date("2026-11-17T11:00:00Z");
let db: CommsDb;
let store: CommsStore;
let n = 0;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const phone = (): string => `+4790${String(810000 + ++n).padStart(6, "0").slice(-6)}`;
const hashOf = (num: string): string => optOutHash(TENANT_A, "sms", num);
const record = (num: string, source: "owner_recorded" | "provider_error" = "owner_recorded") =>
  store.recordOptOut(TENANT_A, "business", { channel: "sms", recipient_hash: hashOf(num), recipient_hint: recipientHint("sms", num), source, recorded_by: OWNER });
const activeRows = async (num: string): Promise<number> =>
  ((await db.admin.query("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 AND status = 'active'", [TENANT_A, hashOf(num)])).rows[0] as { n: number }).n;
/** Neste verdi `nextval('comms_event_seq')` vil gi (leser sekvensens tilstand; ingen allokering). */
const nextExpected = async (): Promise<number> => {
  const r = (await db.admin.query("SELECT last_value::text AS v, is_called AS called FROM comms_event_seq")).rows[0] as { v: string; called: boolean };
  return r.called ? Number(r.v) + 1 : Number(r.v);
};

beforeAll(async () => {
  db = await startCommsDb("g1cc");
  store = new CommsStore(db.app, () => FROZEN);
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

type Hooked = { lockRecipient: (...a: unknown[]) => Promise<void> };

describe("K03: samtidige direkte recordOptOut for samme mottaker og spor", () => {
  const eightAtOnce = async (num: string, source: "owner_recorded" | "provider_error" = "owner_recorded") => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => record(num, source)));
    return {
      rejected: results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason?.message ?? r).slice(0, 120)),
      created: results.filter((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<{ created: boolean }>).value.created).length,
      ids: new Set(results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ opt_out_id: string }>).value.opt_out_id))
    };
  };

  it("8 samtidige kall x 5 runder: ingen feil, nøyaktig én aktiv rad, nøyaktig ÉN created:true, alle får samme opt_out_id", async () => {
    for (let round = 0; round < 5; round++) {
      const num = phone();
      const out = await eightAtOnce(num);
      expect(out.rejected, `runde ${round}`).toEqual([]);
      expect(out.created, `runde ${round}`).toBe(1);
      expect(out.ids.size, `runde ${round}`).toBe(1);
      expect(await activeRows(num), `runde ${round}`).toBe(1);
    }
  }, 120_000);

  it("det samme for leverandørfeil-sporet (21610) - en annen kilde, samme atferd", async () => {
    const num = phone();
    const out = await eightAtOnce(num, "provider_error");
    expect(out.rejected).toEqual([]);
    expect(out.created).toBe(1);
    expect(await activeRows(num)).toBe(1);
  }, 60_000);

  it("LÅSEN finnes: mens en annen transaksjon holder mottakerlåsen, VENTER recordOptOut; når låsen slippes, fullføres den", async () => {
    const num = phone();
    const holder = await db.admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`comms-optout|${TENANT_A}|${hashOf(num)}`, LOCK_SEED]);
      let done = false;
      const pending = record(num).then((r) => { done = true; return r; });
      const waiting = async (): Promise<number> => ((await db.admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0] as { n: number }).n;
      const until = Date.now() + 3_000;
      while (Date.now() < until && (await waiting()) === 0 && !done) await sleep(10);
      expect(done, "recordOptOut skal ikke gå forbi låsen").toBe(false);
      expect(await waiting(), "recordOptOut skal stå i kø på mottakerlåsen").toBeGreaterThanOrEqual(1);
      await sleep(300);
      expect(done, "recordOptOut skal fortsatt vente").toBe(false);
      expect(await activeRows(num)).toBe(0);
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({ created: true });
      expect(await activeRows(num)).toBe(1);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }, 60_000);

  it("SKRIVINGEN er idempotent UTEN låsen: med mottakerlåsen slått av (kun testen) gir 8 samtidige kall fortsatt ingen `duplicate key`, én rad og én created:true", async () => {
    const proto = CommsStore.prototype as unknown as Hooked;
    const original = proto.lockRecipient;
    proto.lockRecipient = async () => undefined;
    try {
      for (let round = 0; round < 6; round++) {
        const num = phone();
        const out = await eightAtOnce(num);
        expect(out.rejected, `runde ${round}`).toEqual([]);
        expect(out.created, `runde ${round}`).toBe(1);
        expect(await activeRows(num), `runde ${round}`).toBe(1);
        expect(out.ids.size, `runde ${round}`).toBe(1);
      }
    } finally {
      proto.lockRecipient = original;
    }
  }, 120_000);
});

describe("M05: rekkefølgen kommer fra DATABASENS sekvens, ikke fra en klokke", () => {
  it("tre mottak med FROSSEN appklokke og samme millisekund får strengt stigende, SAMMENHENGENDE verdier fra `comms_event_seq` (nextval), og sekvensen står på siste verdi etterpå", async () => {
    const before = await nextExpected();
    const mk = (key: string) => store.receiveOptEvent(TENANT_A, "business", { provider: "twilio", event_key: `twilio:msg:${key}`, kind: "opt_in", ingest_id: "ingest-seq-0001" }, 30);
    const a = await mk("SMseq00000000000000000000000000001");
    const b = await mk("SMseq00000000000000000000000000002");
    const c = await mk("SMseq00000000000000000000000000003");
    expect([a.seq, b.seq, c.seq], "verdiene ER sekvensens (ikke en tidsverdi som er mange størrelsesordener større)").toEqual([before, before + 1, before + 2]);
    expect(await nextExpected(), "sekvensen er brukt opp til og med siste mottak").toBe(before + 3);
    // samme hendelse en gang til: samme sekvens, ingen ny allokering fra DB-sekvensen til kvitteringen
    const again = await mk("SMseq00000000000000000000000000002");
    expect(again.seq).toBe(b.seq);
  });

  it("registreringssekvensen til en STOP (`stop_seq`) er også en `nextval`, og en senere STOP i samme spor øker den med nøyaktig én allokering", async () => {
    const num = phone();
    const first = await nextExpected();
    await record(num);
    expect(((await db.admin.query("SELECT stop_seq::text AS s FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, hashOf(num)])).rows[0] as { s: string }).s).toBe(String(first));
    await record(num);
    expect(((await db.admin.query("SELECT stop_seq::text AS s FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, hashOf(num)])).rows[0] as { s: string }).s).toBe(String(first + 1));
    expect(await nextExpected()).toBe(first + 2);
  });
});
