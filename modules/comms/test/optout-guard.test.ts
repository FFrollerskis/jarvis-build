import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { optOutHash, recipientHint } from "../src/index.ts";
import { OWNER, TENANT_A, TENANT_B } from "./support/harness.ts";
import { startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c K1/K2 (rest, funnet av mutasjonsbatteriet): to forhold som ellers hadde manglet en test.
 *  (1) Triggeren på `comms_recipient_opt_outs` avviser endring av kjernekolonnene (kilde, rom, kanal, kontospor, mottaker-hash, tidspunkt, id, tenant). Uten det kunne en rad «oppgraderes»: en `inbound_stop_keyword`-rad som endrer
 *      `source` til `owner_recorded` (eller omvendt) endrer hvem som kan løfte den. (Mutanten uten `source`-sjekken og uten `memory_space_id`-sjekken overlevde før denne testen.)
 *  (2) Eierens angre (`liftOwnerOptOut`) tar samme mottakerlås som STOP/START: mens låsen holdes, venter angrevei og får ikke gå forbi en STOP/START som er midt i behandling.
 */
let chain: Chain;
const LOCK_SEED = 7340464;
const hashOf = (num: string) => optOutHash(TENANT_A, "sms", num);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function seedOwnerRecorded(): Promise<{ num: string; id: string }> {
  const num = chain.phone();
  await chain.store.recordOptOut(TENANT_A, "business", { channel: "sms", recipient_hash: hashOf(num), recipient_hint: recipientHint("sms", num), source: "owner_recorded", recorded_by: OWNER });
  const id = ((await chain.db.admin.query("SELECT opt_out_id FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, hashOf(num)])).rows[0] as { opt_out_id: string }).opt_out_id;
  return { num, id };
}

beforeAll(async () => {
  chain = await startChain("g1cog", {}, { lenientToolLimits: true });
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("K1: triggeren avviser endring av kjernekolonnene på en avmelding (som tabelleier, ikke bare som app-rolle)", () => {
  const CHANGES: Array<[string, string]> = [
    ["source", "source = 'inbound_stop_keyword'"],
    ["memory_space_id", "memory_space_id = 'project'"],
    ["channel", "channel = 'whatsapp'"],
    ["account_ref", "account_ref = '*request'"],
    ["recipient_hash", `recipient_hash = repeat('b', 64)`],
    ["created_at", "created_at = created_at - interval '1 day'"],
    ["opt_out_id", "opt_out_id = opt_out_id || '-x'"],
    ["tenant_id", `tenant_id = '${TENANT_B}'`]
  ];
  for (const [column, assignment] of CHANGES) {
    it(`${column} kan ikke endres etter innsetting`, async () => {
      const { id } = await seedOwnerRecorded();
      const before = (await chain.db.admin.query("SELECT * FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id])).rows[0] as Record<string, unknown>;
      await expect(chain.db.admin.query(`UPDATE comms_recipient_opt_outs SET ${assignment} WHERE tenant_id = $1 AND opt_out_id = $2`, [TENANT_A, id])).rejects.toThrow(/kjernekolonnene er uforanderlige/);
      const after = (await chain.db.admin.query("SELECT * FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id])).rows[0] as Record<string, unknown>;
      expect(after).toEqual(before);
    });
  }

  it("en opphevelse uten løfter (lifted_by NULL) avvises av TRIGGEREN med en egen kode (ikke først av CHECK-en): `unknown_lifter`", async () => {
    const { id } = await seedOwnerRecorded();
    await expect(chain.db.admin.query("UPDATE comms_recipient_opt_outs SET status = 'lifted', lifted_at = now() WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id])).rejects.toThrow(/comms_opt_out_lift_forbidden:unknown_lifter/);
    expect(((await chain.db.admin.query("SELECT status FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id])).rows[0] as { status: string }).status).toBe("active");
  });

  it("kontroll: en ikke-kjernekolonne (evidence_ref) KAN endres (triggeren er ikke en generell skrivesperre)", async () => {
    const { id } = await seedOwnerRecorded();
    await chain.db.admin.query("UPDATE comms_recipient_opt_outs SET evidence_ref = 'ref-1' WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id]);
    expect(((await chain.db.admin.query("SELECT evidence_ref FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id])).rows[0] as { evidence_ref: string }).evidence_ref).toBe("ref-1");
  });
});

describe("K2: eierens angre serialiseres med STOP/START (samme mottakerlås)", () => {
  it("mens en annen transaksjon holder mottakerlåsen, VENTER angre-stien; når låsen slippes, fullføres den (og raden er løftet først da)", async () => {
    const { num, id } = await seedOwnerRecorded();
    const holder = await chain.db.admin.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`comms-optout|${TENANT_A}|${hashOf(num)}`, LOCK_SEED]);
    let done = false;
    const pending = chain.store.liftOwnerOptOut(TENANT_A, { opt_out_id: id, reason: "Feilregistrert av meg selv" }, { person_id: OWNER, session_id: "sess-lock-test" }).then((r) => { done = true; return r; });
    const waiting = async (): Promise<number> => ((await chain.db.admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0] as { n: number }).n;
    const until = Date.now() + 10_000;
    while (Date.now() < until && (await waiting()) === 0) await sleep(10);
    expect(await waiting(), "angre-stien skal stå i kø på mottakerlåsen").toBeGreaterThanOrEqual(1);
    await sleep(300);
    expect(done, "angre-stien skal ikke ha gått forbi låsen").toBe(false);
    expect(((await chain.db.admin.query("SELECT status FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id])).rows[0] as { status: string }).status).toBe("active");
    await holder.query("COMMIT");
    holder.release();
    const result = await pending;
    expect(result).toMatchObject({ lifted: true, still_opted_out: false });
    expect(((await chain.db.admin.query("SELECT status, lifted_by FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id])).rows[0] as { status: string; lifted_by: string }).lifted_by).toBe("owner_undo");
  });
});
