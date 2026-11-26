import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMemoryTransaction } from "@jarvis/memory";
import { CommsWebhookService, WEBHOOK_SECRET_REFS, optOutHash, recipientHint, twilioSignatureBase, type WebhookRequest } from "../src/index.ts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c K2 (JARVIS-112 c, Q-72/N-C i reviewer A) + K1 (kilde-regler i triggeren): samtidig eller forsinket STOP og START avgjøres av PLATTFORMENS mottaks-/registreringssekvens (`comms_event_seq`), aldri av prosesseringsrekkefølge eller leverandørens
 * tid (Twilio har ingen signert tidsstempel). Reviewer A fikk fri mottaker i 16 av 20 runder med STOP#2 samtidig med START mot en eksisterende STOP (STOP#2 ble «absorbert» i den eksisterende raden og START løftet den).
 * Regelen: en START løfter KUN rader hvis registreringssekvens er MINDRE enn START-ens mottakssekvens («STOP vinner» når registreringen skjedde etter at START-en ble mottatt, eller samtidig). Mottakssekvensen persisteres FØR behandlingen, så en
 * retry av en START som feilet midtveis beholder sin opprinnelige sekvens. Alt mot ekte Postgres (embedded, RLS som app-rolle) med ekte samtidighet.
 */
const BASE = "https://hooks.example.com";
const TWILIO_TOKEN = "fake-twilio-auth-token";
const META_SECRET = "fake-meta-app-secret";
const LOCK_SEED = 7340464;
let chain: Chain;
let webhooks: CommsWebhookService;
let sid = 0;

const twilioReq = (fields: Record<string, string>): WebhookRequest => {
  const params = new Map(Object.entries(fields).map(([k, v]) => [k, [v]] as [string, string[]]));
  const sig = createHmac("sha1", TWILIO_TOKEN).update(twilioSignatureBase(`${BASE}/webhooks/comms/twilio`, params), "utf8").digest("base64");
  return { method: "POST", headers: { "x-twilio-signature": sig }, rawBody: Buffer.from(new URLSearchParams(fields).toString()), pathAndQuery: "/webhooks/comms/twilio", query: new URLSearchParams() };
};
const newSid = (): string => `SM${String(++sid).padStart(32, "0")}`;
const smsFrom = (from: string, text: string, messageSid = newSid()): WebhookRequest => twilioReq({ MessageSid: messageSid, From: from, To: "+4791000000", Body: text, AccountSid: "AC1234567890abcdef" });
const keyOf = (messageSid: string): string => `twilio:msg:${messageSid}`;
void META_SECRET;

const hashOf = (num: string) => optOutHash(TENANT_A, "sms", num);
type Row = { channel: string; source: string; status: string; stop_seq: string | null; lifted_by: string | null };
const rows = async (num: string): Promise<Row[]> => (await chain.db.admin.query(
  "SELECT channel, source, status, stop_seq, lifted_by FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 ORDER BY created_at, opt_out_id", [TENANT_A, hashOf(num)]
)).rows as Row[];
const receiptSeq = async (messageSid: string): Promise<number | null> => {
  const r = await chain.db.admin.query("SELECT recv_seq FROM comms_inbound_receipts WHERE tenant_id = $1 AND provider = 'twilio' AND event_key = $2", [TENANT_A, keyOf(messageSid)]);
  return r.rowCount === 0 ? null : Number((r.rows[0] as { recv_seq: string }).recv_seq);
};
const opted = (num: string): Promise<boolean> => chain.store.isOptedOut(TENANT_A, hashOf(num));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Holder recipient-låsen (samme nøkkel som koden) i en egen transaksjon: alle STOP/START for mottakeren blir stående i køen til `release()`. */
async function holdRecipientLock(num: string): Promise<{ release: () => Promise<void> }> {
  const client = await chain.db.admin.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`comms-optout|${TENANT_A}|${hashOf(num)}`, LOCK_SEED]);
  return { release: async () => { await client.query("COMMIT"); client.release(); } };
}
async function waitFor(what: string, predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`timeout: ${what}`);
}
const waiters = async (): Promise<number> => ((await chain.db.admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0] as { n: number }).n;

beforeAll(async () => {
  // Marginen 0 = ren sekvensmodell: disse testene legger inn en STOP og straks en START og forventer at START løfter (sekvensregelen alene). Tie-marginen (STOP vinner innenfor 5 s) er bevist i `stop-start-overlap.test.ts`.
  chain = await startChain("g1c2", { JARVIS_COMMS_WEBHOOKS: "twilio,meta", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: BASE }, { startTieMarginMs: 0 });
  webhooks = new CommsWebhookService({
    store: chain.store, graph: chain.graph, config: chain.config,
    secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.twilio ? TWILIO_TOKEN : ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : null) }, clock: chain.now
  });
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("K2: rekkefølgen er sekvensbasert (sekvensielle tilfeller er uendret)", () => {
  it("STOP, så START (mottatt etterpå): mottakeren er fri; START, så STOP: mottakeren er avmeldt; to STOP i samme spor og så START: raden løftes", async () => {
    const a = chain.phone();
    await webhooks.handle("twilio", smsFrom(a, "STOP"));
    expect(await opted(a)).toBe(true);
    await webhooks.handle("twilio", smsFrom(a, "START"));
    expect(await opted(a)).toBe(false);
    expect((await rows(a)).map((r) => r.status)).toEqual(["lifted"]);

    const b = chain.phone();
    await webhooks.handle("twilio", smsFrom(b, "START")); // ingenting å løfte
    expect(await opted(b)).toBe(false);
    await webhooks.handle("twilio", smsFrom(b, "STOPP"));
    expect(await opted(b)).toBe(true);

    const c = chain.phone();
    await webhooks.handle("twilio", smsFrom(c, "STOP"));
    await webhooks.handle("twilio", smsFrom(c, "stop")); // absorberes i samme rad, men registreringssekvensen økes
    const before = await rows(c);
    expect(before).toHaveLength(1);
    await webhooks.handle("twilio", smsFrom(c, "START"));
    expect(await opted(c)).toBe(false);
  });

  it("en STOP som absorberes i en eksisterende rad HEVER registreringssekvensen (stop_seq vokser) - den mistes ikke", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", smsFrom(n, "STOP"));
    const first = Number((await rows(n))[0]!.stop_seq);
    await webhooks.handle("twilio", smsFrom(n, "STOP"));
    const second = Number((await rows(n))[0]!.stop_seq);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(await rows(n)).toHaveLength(1);
  });
});

describe("K2: «STOP vinner» ved samtidighet - DETERMINISTISK (låsen holdes til begge hendelsene er mottatt), 20 runder", () => {
  for (const order of ["START først i køen", "STOP#2 først i køen"] as const) {
    it(`eksisterende STOP + samtidig STOP#2 og START (${order}): mottakeren er avmeldt i ALLE 20 runder, uansett hvem som får låsen først`, async () => {
      for (let round = 0; round < 20; round++) {
        const n = chain.phone();
        await webhooks.handle("twilio", smsFrom(n, "STOP")); // STOP#1: aktiv rad
        expect(await opted(n)).toBe(true);
        const startSid = newSid();
        const stopSid = newSid();
        const lock = await holdRecipientLock(n);
        let startP: Promise<unknown>;
        let stop2P: Promise<unknown>;
        const base = await waiters();
        if (order === "START først i køen") {
          startP = webhooks.handle("twilio", smsFrom(n, "START", startSid));
          await waitFor("START mottatt og i lås-køen", async () => (await receiptSeq(startSid)) !== null && (await waiters()) >= base + 1);
          stop2P = webhooks.handle("twilio", smsFrom(n, "STOP", stopSid));
        } else {
          stop2P = webhooks.handle("twilio", smsFrom(n, "STOP", stopSid));
          await waitFor("STOP#2 i lås-køen", async () => (await waiters()) >= base + 1);
          startP = webhooks.handle("twilio", smsFrom(n, "START", startSid));
        }
        await waitFor("begge i lås-køen og START mottatt", async () => (await receiptSeq(startSid)) !== null && (await waiters()) >= base + 2);
        await lock.release();
        const results = (await Promise.all([startP, stop2P])) as Array<{ status: number }>;
        expect(results.map((r) => r.status), `runde ${round}`).toEqual([200, 200]);
        expect(await opted(n), `runde ${round} (${order}): mottakeren slapp fri`).toBe(true);
        const active = (await rows(n)).filter((r) => r.status === "active");
        expect(active.length, `runde ${round}`).toBeGreaterThanOrEqual(1);
        // invariant: ingen opphevet rad har registreringssekvens >= START-ens mottakssekvens; hver aktiv rad ble registrert etter at START-en ble mottatt eller før den fikk lov å løfte den
        const startRecv = (await receiptSeq(startSid)) as number;
        for (const r of await rows(n)) if (r.status === "lifted") expect(Number(r.stop_seq), `runde ${round}`).toBeLessThan(startRecv);
        expect(active.some((r) => Number(r.stop_seq) > startRecv), `runde ${round}: STOP#2 ble registrert etter START-mottaket`).toBe(true);
      }
    }, 120_000);
  }
});

describe("K2: fri samtidighet (ingen barriere), 24 runder - invarianten holder i HVER interleaving", () => {
  it("STOP#1 aktiv, så STOP#2/START/STOP#3 samtidig med tilfeldig jitter: en rad er aldri opphevet av en START som ble mottatt FØR raden ble registrert, og en aktiv rad = avmeldt", async () => {
    for (let round = 0; round < 24; round++) {
      const n = chain.phone();
      await webhooks.handle("twilio", smsFrom(n, "STOP"));
      const startSid = newSid();
      const jitter = () => sleep(Math.floor(Math.random() * 6));
      await Promise.all([
        jitter().then(() => webhooks.handle("twilio", smsFrom(n, "STOP"))),
        jitter().then(() => webhooks.handle("twilio", smsFrom(n, "START", startSid))),
        jitter().then(() => webhooks.handle("twilio", smsFrom(n, "STOPP")))
      ]);
      const startRecv = (await receiptSeq(startSid)) as number;
      const all = await rows(n);
      for (const r of all) {
        if (r.status === "lifted") expect(Number(r.stop_seq), `runde ${round}: opphevet av en START mottatt FØR registreringen`).toBeLessThan(startRecv);
      }
      const anyAfter = all.some((r) => Number(r.stop_seq) > startRecv);
      if (anyAfter) expect(await opted(n), `runde ${round}: en STOP registrert etter START-mottaket, men mottakeren er fri`).toBe(true);
      expect(await opted(n), `runde ${round}: aktiv rad = avmeldt`).toBe(all.some((r) => r.status === "active"));
    }
  }, 120_000);
});

describe("K2: forsinket (retry) START kan ikke løfte en nyere STOP", () => {
  it("første levering av START feiler MIDTVEIS (etter at mottaket er persistert), STOP#3 registreres, retry av SAMME hendelse løfter IKKE STOP#3 - en NY START etterpå gjør det", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", smsFrom(n, "STOP")); // STOP#1
    await chain.db.admin.query(`
      CREATE OR REPLACE FUNCTION g1c_fail_lift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'g1c_injected_failure'; END $$;
      CREATE TRIGGER g1c_fail_lift BEFORE UPDATE ON comms_recipient_opt_outs FOR EACH ROW WHEN (NEW.status = 'lifted') EXECUTE FUNCTION g1c_fail_lift();`);
    const startSid = newSid();
    try {
      await expect(webhooks.handle("twilio", smsFrom(n, "START", startSid))).rejects.toThrow(/g1c_injected_failure/);
    } finally {
      await chain.db.admin.query("DROP TRIGGER g1c_fail_lift ON comms_recipient_opt_outs");
    }
    const original = await receiptSeq(startSid);
    expect(original, "mottaket er persistert selv om behandlingen feilet").not.toBeNull();
    expect((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_inbound_events WHERE tenant_id = $1 AND event_key = $2", [TENANT_A, keyOf(startSid)])).rows[0]).toEqual({ n: 0 });
    expect(await opted(n)).toBe(true);

    await webhooks.handle("twilio", smsFrom(n, "STOP")); // STOP#3 - registrert ETTER at START ble mottatt første gang
    const retry = await webhooks.handle("twilio", smsFrom(n, "START", startSid)); // leverandørens retry
    expect(retry.body).toMatchObject({ events: { inserted: 1, opt_ins: 1 } });
    expect(await receiptSeq(startSid), "retry gjenbruker den OPPRINNELIGE sekvensen").toBe(original);
    expect(await opted(n), "en forsinket START løftet en nyere STOP").toBe(true);

    await webhooks.handle("twilio", smsFrom(n, "START")); // en NY START (mottatt etter STOP#3) løfter
    expect(await opted(n)).toBe(false);
  });

  it("receiveOptEvent er idempotent per hendelse (samme nøkkel = samme sekvens) og gir økende sekvenser for ulike hendelser", async () => {
    const input = { provider: "twilio", event_key: "twilio:msg:SMfixed00000000000000000000000001", kind: "opt_in", ingest_id: "ingest-g1c2-fixed" } as const;
    const a = await chain.store.receiveOptEvent(TENANT_A, "business", input, 30);
    const b = await chain.store.receiveOptEvent(TENANT_A, "business", input, 30);
    const c = await chain.store.receiveOptEvent(TENANT_A, "business", { ...input, event_key: "twilio:msg:SMfixed00000000000000000000000002" }, 30);
    expect(b, "samme hendelse = samme sekvens OG samme databasetid (retry beholder det opprinnelige mottaket)").toEqual(a);
    expect(c.seq).toBeGreaterThan(a.seq);
    expect(Math.abs(c.at.getTime() - Date.now()), "mottakstiden er databasens `clock_timestamp()` (nå), ikke den injiserte klokken (2026-11-17)").toBeLessThan(60_000);
  });
});

/** Rå SQL som app-rolle under tenant-/rom-kontekst (RLS gjelder) - viser at DATABASEN, ikke bare app-koden, håndhever reglene. */
const asApp = <T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> => withMemoryTransaction(chain.db.app, TENANT_A, ["business", "personal", "project", "shared"], fn);
const liftSql = (by: string, extra = ""): string => `UPDATE comms_recipient_opt_outs SET status = 'lifted', lifted_at = now(), lifted_by = '${by}'${extra} WHERE tenant_id = $1 AND opt_out_id = $2`;
async function seedRow(source: "inbound_stop_keyword" | "provider_error" | "owner_recorded" | "recipient_request"): Promise<{ id: string; num: string }> {
  const num = chain.phone();
  const r = await chain.store.recordOptOut(TENANT_A, "business", { channel: "sms", recipient_hash: hashOf(num), recipient_hint: recipientHint("sms", num), source, recorded_by: "person-g1-owner" });
  return { id: r.opt_out_id, num };
}

describe("K1: databasetriggeren håndhever HVEM som kan løfte HVA (som app-rolle, ikke bare i app-SQL)", () => {
  const startErr = (source: string) => ({ code: "23514", message: expect.stringContaining(`comms_opt_out_lift_forbidden:start_cannot_lift_${source}`) });

  it("mottakerens START kan løfte stopp-ord og leverandørfeil - men ALDRI en eierregistrert eller mottakerbedt avmelding", async () => {
    for (const source of ["inbound_stop_keyword", "provider_error"] as const) {
      const { id } = await seedRow(source);
      await expect(asApp((c) => c.query(liftSql("inbound_start_keyword"), [TENANT_A, id])), source).resolves.toBeDefined();
    }
    for (const source of ["owner_recorded", "recipient_request"] as const) {
      const { id, num } = await seedRow(source);
      await expect(asApp((c) => c.query(liftSql("inbound_start_keyword"), [TENANT_A, id])), source).rejects.toMatchObject(startErr(source));
      expect(await opted(num), `${source} er fortsatt aktiv`).toBe(true);
    }
  });

  it("eierens angre (owner_undo) kan KUN løfte en eierregistrert rad - aldri recipient_request, stopp-ord eller leverandørfeil - og krever begrunnelse, person og sesjon (CHECK)", async () => {
    const detail = ", lift_reason = 'Feilregistrert nummer', lifted_by_person_id = 'person-g1-owner', lift_session_id = 'sess-g1c2'";
    for (const source of ["recipient_request", "inbound_stop_keyword", "provider_error"] as const) {
      const { id } = await seedRow(source);
      await expect(asApp((c) => c.query(liftSql("owner_undo", detail), [TENANT_A, id])), source).rejects.toMatchObject({ code: "23514", message: expect.stringContaining(`comms_opt_out_lift_forbidden:owner_cannot_lift_${source}`) });
    }
    const owner = await seedRow("owner_recorded");
    // uten begrunnelse/person/sesjon: CHECK feiler selv for en lovlig kilde
    await expect(asApp((c) => c.query(liftSql("owner_undo"), [TENANT_A, owner.id]))).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("comms_recipient_opt_outs_owner_undo_complete") });
    await expect(asApp((c) => c.query(liftSql("owner_undo", ", lift_reason = 'ab', lifted_by_person_id = 'person-g1-owner', lift_session_id = 's'"), [TENANT_A, owner.id]))).rejects.toMatchObject({ code: "23514" });
    expect(await opted(owner.num)).toBe(true);
    await expect(asApp((c) => c.query(liftSql("owner_undo", detail), [TENANT_A, owner.id]))).resolves.toBeDefined();
    expect(await opted(owner.num)).toBe(false);
  });

  it("ingen annen opphever finnes (ukjent `lifted_by` avvises), begrunnelse-feltene hører kun til owner_undo, og en opphevet rad kan ikke endres igjen", async () => {
    const { id } = await seedRow("owner_recorded");
    await expect(asApp((c) => c.query(liftSql("someone_else"), [TENANT_A, id]))).rejects.toMatchObject({ code: "23514" });
    await expect(asApp((c) => c.query(liftSql("inbound_start_keyword", ", lift_reason = 'x skal ikke være her'"), [TENANT_A, id]))).rejects.toMatchObject({ code: "23514" });
    const kw = await seedRow("inbound_stop_keyword");
    await asApp((c) => c.query(liftSql("inbound_start_keyword"), [TENANT_A, kw.id]));
    await expect(asApp((c) => c.query("UPDATE comms_recipient_opt_outs SET recipient_hint = 'x' WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, kw.id]))).rejects.toThrow(/opphevet avmelding kan ikke endres/);
  });

  it("registreringssekvensen kan kun økes (en nedsettelse eller NULL ville latt en eldre START løfte en nyere STOP)", async () => {
    const { id } = await seedRow("inbound_stop_keyword");
    const cur = Number(((await chain.db.admin.query("SELECT stop_seq FROM comms_recipient_opt_outs WHERE opt_out_id = $1", [id])).rows[0] as { stop_seq: string }).stop_seq);
    await expect(asApp((c) => c.query("UPDATE comms_recipient_opt_outs SET stop_seq = $3 WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id, cur - 1]))).rejects.toThrow(/stop_seq kan kun øke/);
    await expect(asApp((c) => c.query("UPDATE comms_recipient_opt_outs SET stop_seq = NULL WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id]))).rejects.toThrow(/stop_seq kan kun øke/);
    await expect(asApp((c) => c.query("UPDATE comms_recipient_opt_outs SET stop_seq = $3 WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id, cur + 5]))).resolves.toBeDefined();
  });

  it("en gammel rad uten registreringssekvens (NULL, fra før migrasjon 141) regnes som eldre enn enhver START og løftes som før", async () => {
    const n = chain.phone();
    await chain.db.admin.query(
      "INSERT INTO comms_recipient_opt_outs (tenant_id, opt_out_id, memory_space_id, channel, account_ref, recipient_hash, recipient_hint, source) VALUES ($1, $2, 'business', 'sms', '*', $3, 'x', 'inbound_stop_keyword')",
      [TENANT_A, `optout-legacy-${sid++}`, hashOf(n)]
    );
    expect(await opted(n)).toBe(true);
    await webhooks.handle("twilio", smsFrom(n, "START"));
    expect(await opted(n)).toBe(false);
  });
});

describe("K1: DELETE-vern (avmeldinger og første-mottak kan bare slettes av erasure eller retensjon)", () => {
  it("appen kan IKKE slette en avmelding (23514), heller ikke uten rader å treffe feilmelding: kun en erasure-transaksjon (`jarvis.erasure_in_progress = 'true'`) slipper gjennom - og flagget lekker ikke til neste transaksjon", async () => {
    const { id, num } = await seedRow("owner_recorded");
    const del = (c: import("pg").PoolClient) => c.query("DELETE FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = $2", [TENANT_A, id]);
    await expect(asApp(del)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("comms_row_delete_forbidden:comms_recipient_opt_outs") });
    // bare nøyaktig verdien 'true' teller
    await expect(asApp(async (c) => { await c.query("SELECT set_config('jarvis.erasure_in_progress', 'on', true)"); return del(c); })).rejects.toMatchObject({ code: "23514" });
    expect(await opted(num)).toBe(true);
    // erasure-stien: lovlig (transaksjonslokal GUC, som ErasureService setter etter policy-autorisering) - rullet tilbake her så raden består for neste assertion
    const erasure = withMemoryTransaction(chain.db.app, TENANT_A, ["business"], async (c) => {
      await c.query("SELECT set_config('jarvis.erasure_in_progress', 'true', true)");
      const r = await del(c);
      expect(r.rowCount).toBe(1);
      throw new Error("rollback-markør");
    });
    await expect(erasure).rejects.toThrow("rollback-markør");
    expect(await opted(num), "raden består (transaksjonen ble rullet tilbake)").toBe(true);
    await expect(asApp(del), "GUC-en lekket ikke til en senere transaksjon").rejects.toMatchObject({ code: "23514" });
  });

  it("også en spørring som treffer MANGE avmeldinger (WHERE tenant) feiler - appen kan ikke tømme registeret", async () => {
    await seedRow("owner_recorded");
    await expect(asApp((c) => c.query("DELETE FROM comms_recipient_opt_outs WHERE tenant_id = $1", [TENANT_A]))).rejects.toMatchObject({ code: "23514" });
    expect(((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1", [TENANT_A])).rows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it("første-mottak (comms_inbound_receipts): en fersk rad kan ikke slettes, en utløpt kan (retensjon, databasens klokke), og erasure sletter alt - `purgeExpired` hopper over rader databasen ikke ville tillatt", async () => {
    const mk = (key: string) => chain.store.receiveOptEvent(TENANT_A, "business", { provider: "twilio", event_key: key, kind: "opt_in", ingest_id: "ingest-g1c2-receipts" }, 30);
    await mk("twilio:msg:SMreceipt0000000000000000000000001");
    await mk("twilio:msg:SMreceipt0000000000000000000000002");
    const del = (key: string) => (c: import("pg").PoolClient) => c.query("DELETE FROM comms_inbound_receipts WHERE tenant_id = $1 AND event_key = $2", [TENANT_A, key]);
    await expect(asApp(del("twilio:msg:SMreceipt0000000000000000000000001"))).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("comms_row_delete_forbidden:comms_inbound_receipts") });
    // sveipet med en injisert fremtidig klokke fjerner IKKE en rad som ikke er utløpt på databasens klokke - og feiler ikke
    chain.setNow(new Date("2031-01-01T00:00:00Z"));
    try {
      const swept = await chain.store.purgeExpired(TENANT_A, "business");
      expect(swept.receipts).toBe(0);
    } finally {
      chain.setNow(new Date("2026-11-17T11:00:00Z"));
    }
    await chain.db.admin.query("UPDATE comms_inbound_receipts SET retention_until = now() - interval '1 day' WHERE tenant_id = $1 AND event_key = $2", [TENANT_A, "twilio:msg:SMreceipt0000000000000000000000002"]);
    await expect(asApp(del("twilio:msg:SMreceipt0000000000000000000000002"))).resolves.toBeDefined();
  });
});
