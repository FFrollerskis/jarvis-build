import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommsStore, CommsWebhookService, START_TIE_MARGIN_MS, WEBHOOK_SECRET_REFS, optOutHash, parseCommsConfig, recipientHint, twilioSignatureBase, type WebhookRequest } from "../src/index.ts";
import { TENANT_A, TENANT_B } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c fiks-runde 1 (FIX-3, JARVIS-112 c): «STOP vinner ved samtidighet» holdt ikke ved millisekund-overlapp. En START fikk mottakssekvensen sin tidlig og uten lås (`receiveOptEvent`), mens en STOP fikk registreringssekvensen først
 * UNDER låsen midt i transaksjonen: den som allokerte sekvensen først vant, så en START som ble mottatt mens en STOP holdt låsen (ikke committet) kunne løfte den (mottaker FRI). Rettet med en tie-margin: en START løfter kun en STOP som ble
 * registrert MER enn `START_TIE_MARGIN_MS` (5 s, databasens klokke) før START-en ble mottatt; innenfor marginen vinner STOP, uansett sekvens og rekkefølge.
 *
 * Alle matrisene bruker en GAMMEL avmelding (en rad uten registreringstid, som fra før migrasjon 141: alltid løftbar av en START) som utgangspunkt, så en START alene VILLE løftet den (kontrollrunden), og kun den samtidige STOP-en beskytter.
 * Marginen 0 = ren sekvensmodell: orakelet (uavhengig gjenspilling i sekvensrekkefølge) skal stemme der, uforandret fra før marginen.
 *
 * Fiks-runde 2 (FIX-1): matrisene over beviser kun den NEGATIVE veien (en START løfter ikke innenfor marginen). Den POSITIVE veien (en START løfter en EKTE STOP, med registreringstid, som er eldre enn marginen) hadde ingen test: en mutant som aldri
 * lot en START løfte en STOP skrevet av ny kode overlevde hele suiten. Nå dekket av «positiv vei» under (raden gjøres gammel med `session_replication_role = replica`), og av registreringstidens opphav (`clock_timestamp()`, ikke transaksjonsstart).
 */
const BASE = "https://hooks.example.com";
const TWILIO_TOKEN = "fake-twilio-auth-token";
const SEED = Number(process.env["G1C_SEED"] ?? 20261126);
const ROUNDS = Number(process.env["G1C_ROUNDS"] ?? 60);
const MATRIX_ROUNDS = Number(process.env["G1C_MATRIX_ROUNDS"] ?? 60);
const GAPS_MS = [0, 1, 2, 3, 5, 8, 12] as const;
const LOCK_SEED = 7340464; // samme frø som `CommsStore.lockRecipient` (pinnet av `optout-concurrency.test.ts`)

function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(SEED);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const sleep = (ms: number): Promise<void> => (ms <= 0 ? new Promise((r) => setImmediate(r)) : new Promise((r) => setTimeout(r, ms)));
const DELAYS = [0, 0, 0, 1, 2, 3, 5, 8, 13] as const;

/** Injeksjon (kun aktiv for kall som kjører i en `als.run(script, ...)`): forsinkelser FØR/ETTER lås, sekvens og mottak, en port etter sekvensen, og kast etter sekvens/mottak (rollback og retry). */
interface Script { preLock: number; postLock: number; preSeq: number; postSeq: number; preRecv: number; postRecv: number; failAfterSeq: boolean; failAfterRecv: boolean; gate?: Promise<void>; seqs: number[]; failed?: boolean }
const als = new AsyncLocalStorage<Script>();
const newScript = (over: Partial<Script> = {}): Script => ({ preLock: 0, postLock: 0, preSeq: 0, postSeq: 0, preRecv: 0, postRecv: 0, failAfterSeq: false, failAfterRecv: false, seqs: [], ...over });
const randomScript = (kind: "stop" | "start"): Script => newScript({
  preLock: pick(DELAYS), postLock: pick(DELAYS), preSeq: pick(DELAYS), postSeq: pick(DELAYS), preRecv: pick(DELAYS), postRecv: pick(DELAYS),
  failAfterSeq: kind === "stop" && rnd() < 0.2, failAfterRecv: kind === "start" && rnd() < 0.2
});
const seqOf = (v: unknown): number => (typeof v === "number" ? v : (v as { seq: number }).seq);

type Hooked = { lockRecipient: (...a: unknown[]) => Promise<void>; nextSeq: (...a: unknown[]) => Promise<unknown>; receiveOptEvent: (...a: unknown[]) => Promise<unknown> };
const proto = CommsStore.prototype as unknown as Hooked;
const orig = { lock: proto.lockRecipient, seq: proto.nextSeq, recv: proto.receiveOptEvent };

let chain: Chain;
let svc: CommsWebhookService; // produksjonsmarginen (standard)
let svcZero: CommsWebhookService; // margin 0: ren sekvensmodell
let svcZeroB: CommsWebhookService; // samme, tenant B
let sid = 0;

const secrets = { get: async (ref: string) => (ref === WEBHOOK_SECRET_REFS.twilio ? TWILIO_TOKEN : null) };
const twilioReq = (fields: Record<string, string>): WebhookRequest => {
  const params = new Map(Object.entries(fields).map(([k, v]) => [k, [v]] as [string, string[]]));
  const sig = createHmac("sha1", TWILIO_TOKEN).update(twilioSignatureBase(`${BASE}/webhooks/comms/twilio`, params), "utf8").digest("base64");
  return { method: "POST", headers: { "x-twilio-signature": sig }, rawBody: Buffer.from(new URLSearchParams(fields).toString()), pathAndQuery: "/webhooks/comms/twilio", query: new URLSearchParams() };
};
const newSid = (): string => `SM${String(++sid).padStart(32, "0")}`;
const smsFrom = (from: string, text: string, messageSid: string = newSid()): WebhookRequest => twilioReq({ MessageSid: messageSid, From: from, To: "+4791000000", Body: text, AccountSid: "AC1234567890abcdef" });
const keyOf = (messageSid: string): string => `twilio:msg:${messageSid}`;
const hashOf = (tenant: string, num: string): string => optOutHash(tenant, "sms", num);
const opted = (tenant: string, num: string): Promise<boolean> => chain.store.isOptedOut(tenant, hashOf(tenant, num));
const receiptSeq = async (tenant: string, messageSid: string): Promise<number | null> => {
  const r = await chain.db.admin.query("SELECT recv_seq FROM comms_inbound_receipts WHERE tenant_id = $1 AND provider = 'twilio' AND event_key = $2", [tenant, keyOf(messageSid)]);
  return r.rowCount === 0 ? null : Number((r.rows[0] as { recv_seq: string }).recv_seq);
};

/** En gammel avmelding: stopp-ord-rad uten registreringssekvens/-tid (som en rad fra før migrasjon 141) - en START kan alltid løfte den. */
let legacyN = 0;
async function seedLegacyStop(tenant: string, num: string): Promise<void> {
  await chain.db.admin.query(
    `INSERT INTO comms_recipient_opt_outs (tenant_id, opt_out_id, memory_space_id, channel, account_ref, recipient_hash, recipient_hint, source, recorded_by)
     VALUES ($1, $2, 'business', 'sms', '*', $3, $4, 'inbound_stop_keyword', 'system')`,
    [tenant, `optout-legacy-${++legacyN}-${Math.random().toString(36).slice(2, 8)}`, hashOf(tenant, num), recipientHint("sms", num)]
  );
}

/** Gjør registreringstiden til mottakerens AKTIVE avmelding «gammel» (`seconds` sekunder siden). Kun superbruker kan omgå triggeren som ellers hindrer at registreringstiden går bakover (`session_replication_role = replica`). */
async function ageStop(tenant: string, num: string, seconds: number): Promise<void> {
  const admin = await chain.db.admin.connect();
  try {
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query(
      "UPDATE comms_recipient_opt_outs SET stop_db_at = clock_timestamp() - ($3::int * interval '1 second') WHERE tenant_id = $1 AND recipient_hash = $2 AND status = 'active'", [tenant, hashOf(tenant, num), seconds]
    );
    await admin.query("COMMIT");
  } finally { admin.release(); }
}
const optOutRows = async (tenant: string, num: string): Promise<Array<{ status: string; stop_db_at: Date | null; stop_seq: string | null }>> =>
  (await chain.db.admin.query("SELECT status, stop_db_at, stop_seq FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 ORDER BY created_at, opt_out_id", [tenant, hashOf(tenant, num)])).rows as Array<{ status: string; stop_db_at: Date | null; stop_seq: string | null }>;

beforeAll(async () => {
  chain = await startChain("g1c2o", { JARVIS_COMMS_WEBHOOKS: "twilio,meta", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: BASE });
  svc = new CommsWebhookService({ store: chain.store, graph: chain.graph, config: chain.config, secrets, clock: chain.now });
  const zero = new CommsStore(chain.db.app, chain.now, { startTieMarginMs: 0 });
  svcZero = new CommsWebhookService({ store: zero, graph: chain.graph, config: chain.config, secrets, clock: chain.now });
  const configB = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms,slack,phone,whatsapp", JARVIS_COMMS_WEBHOOKS: "twilio", JARVIS_COMMS_TENANT_ID: TENANT_B, JARVIS_COMMS_PUBLIC_BASE_URL: BASE });
  svcZeroB = new CommsWebhookService({ store: zero, graph: chain.graph, config: configB, secrets, clock: chain.now });
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"]]);
  await chain.db.admin.query(
    "INSERT INTO comms_authorized_accounts (tenant_id, account_id, memory_space_id, channel, account_ref, provider, status, source) VALUES ($1, 'acct-b-sms-0001', 'business', 'sms', '+4791000000', 'twilio', 'active', 'owner_route')", [TENANT_B]
  );
  proto.lockRecipient = async function (this: CommsStore, ...a: unknown[]) {
    const s = als.getStore();
    if (s) await sleep(s.preLock);
    await orig.lock.apply(this, a);
    if (s) await sleep(s.postLock);
  };
  proto.nextSeq = async function (this: CommsStore, ...a: unknown[]) {
    const s = als.getStore();
    if (s) await sleep(s.preSeq);
    const v = await orig.seq.apply(this, a);
    if (s) {
      s.seqs.push(seqOf(v));
      if (s.gate !== undefined) await s.gate;
      await sleep(s.postSeq);
      if (s.failAfterSeq && s.failed !== true) { s.failed = true; throw new Error("injected_after_seq"); }
    }
    return v;
  };
  proto.receiveOptEvent = async function (this: CommsStore, ...a: unknown[]) {
    const s = als.getStore();
    if (s) await sleep(s.preRecv);
    const v = await orig.recv.apply(this, a);
    if (s) {
      await sleep(s.postRecv);
      if (s.failAfterRecv && s.failed !== true) { s.failed = true; throw new Error("injected_after_recv"); }
    }
    return v;
  };
}, 240_000);
afterAll(async () => {
  proto.lockRecipient = orig.lock;
  proto.nextSeq = orig.seq;
  proto.receiveOptEvent = orig.recv;
  await chain?.stop();
}, 120_000);

describe("FIX-3: STOP vinner innenfor tie-marginen (millisekund-overlapp, samtidig oppstart, begge rekkefølger)", () => {
  it(`produksjonsmarginen er 5 sekunder`, () => {
    expect(START_TIE_MARGIN_MS).toBe(5000);
  });

  it("kontrollrunde: en START ALENE løfter den gamle avmeldingen (ellers beviser matrisene under ingenting)", async () => {
    const n = chain.phone();
    await seedLegacyStop(TENANT_A, n);
    expect(await opted(TENANT_A, n)).toBe(true);
    await svc.handle("twilio", smsFrom(n, "START"));
    expect(await opted(TENANT_A, n), "en gammel (> margin) avmelding løftes av en START").toBe(false);
  });

  it("deterministisk overlapp: STOP#2 har allokert sekvens og holder låsen (ikke committet) når START mottas, og START har HØYERE mottakssekvens - mottakeren forblir avmeldt", async () => {
    const n = chain.phone();
    await seedLegacyStop(TENANT_A, n);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const script = newScript({ gate });
    const stopSid = newSid();
    const stop2 = als.run(script, () => svc.handle("twilio", smsFrom(n, "STOP", stopSid)));
    for (let i = 0; i < 400 && script.seqs.length === 0; i++) await sleep(5);
    expect(script.seqs, "STOP#2 har allokert sekvens (og holder dermed låsen)").toHaveLength(1);
    const startSid = newSid();
    const start = svc.handle("twilio", smsFrom(n, "START", startSid));
    for (let i = 0; i < 400 && (await receiptSeq(TENANT_A, startSid)) === null; i++) await sleep(5);
    const recv = await receiptSeq(TENANT_A, startSid);
    expect(recv, "START er mottatt (kvittering persistert) mens STOP#2 holder låsen").not.toBeNull();
    expect(script.seqs[0] as number, "STOP#2 har LAVERE sekvens enn START-mottaket: ren sekvensorden ville latt START løfte").toBeLessThan(recv as number);
    const committed = ((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_inbound_events WHERE tenant_id = $1 AND event_key = $2", [TENANT_A, keyOf(stopSid)])).rows[0] as { n: number }).n;
    expect(committed, "STOP#2 er ikke committet ennå").toBe(0);
    open();
    await Promise.all([stop2, start]);
    expect(await opted(TENANT_A, n), "innenfor marginen vinner STOP").toBe(true);
  }, 60_000);

  it("en senere STOP som absorberes i en GAMMEL rad flytter registreringstiden fram (siste STOP teller): en START rett etter løfter ingenting", async () => {
    const n = chain.phone();
    expect((await svc.handle("twilio", smsFrom(n, "STOP"))).status).toBe(200);
    // raden gjøres «gammel» (registrert for 30 s siden)
    await ageStop(TENANT_A, n, 30);
    const old = ((await chain.db.admin.query("SELECT stop_db_at FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, hashOf(TENANT_A, n)])).rows[0] as { stop_db_at: Date }).stop_db_at;
    expect(Date.now() - old.getTime(), "kontroll: raden er gjort 30 s gammel").toBeGreaterThan(25_000);
    expect((await svc.handle("twilio", smsFrom(n, "STOP"))).body, "andre STOP absorberes i samme rad").toMatchObject({ events: { opt_outs: 1 } });
    const bumped = ((await chain.db.admin.query("SELECT stop_db_at FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, hashOf(TENANT_A, n)])).rows[0] as { stop_db_at: Date }).stop_db_at;
    expect(Date.now() - bumped.getTime(), "registreringstiden er flyttet fram til NÅ").toBeLessThan(10_000);
    await svc.handle("twilio", smsFrom(n, "START"));
    expect(await opted(TENANT_A, n), "START innenfor marginen etter den siste STOP-en løfter ingenting").toBe(true);
  });

  it("POSITIV vei (produksjonsmargin): en START LØFTER en ekte STOP (med registreringstid) som er eldre enn marginen, men ikke innenfor den; en NY STOP etter løftingen er igjen beskyttet mot en START rett etter", async () => {
    const n = chain.phone();
    expect((await svc.handle("twilio", smsFrom(n, "STOP"))).status).toBe(200);
    const fresh = await optOutRows(TENANT_A, n);
    expect(fresh, "én aktiv rad").toHaveLength(1);
    expect(fresh[0]!.stop_db_at, "en ekte STOP har registreringstid og -sekvens (ikke en gammel rad uten, som alltid kan løftes)").not.toBeNull();
    expect(fresh[0]!.stop_seq).not.toBeNull();
    await svc.handle("twilio", smsFrom(n, "START"));
    expect(await opted(TENANT_A, n), "kontroll: en START innenfor marginen løfter ikke").toBe(true);

    await ageStop(TENANT_A, n, 30);
    const aged = (await optOutRows(TENANT_A, n))[0]!.stop_db_at as Date;
    expect(Date.now() - aged.getTime(), "kontroll: registreringstiden er nå 30 s gammel").toBeGreaterThan(25_000);
    await svc.handle("twilio", smsFrom(n, "START"));
    expect(await opted(TENANT_A, n), "en START mer enn marginen etter en EKTE STOP løfter (ellers kan en mottaker som melder seg på igjen aldri bli fri)").toBe(false);
    expect((await optOutRows(TENANT_A, n)).map((r) => r.status)).toEqual(["lifted"]);

    // en NY STOP etter løftingen får en ny rad med fersk registreringstid: en START rett etter løfter ikke igjen
    expect((await svc.handle("twilio", smsFrom(n, "STOP"))).status).toBe(200);
    expect(await opted(TENANT_A, n)).toBe(true);
    await svc.handle("twilio", smsFrom(n, "START"));
    expect(await opted(TENANT_A, n), "ny STOP + START rett etter: beskyttet").toBe(true);
    expect((await optOutRows(TENANT_A, n)).map((r) => r.status).sort(), "den gamle raden er opphevet og den nye er aktiv (testklokken står stille, så radrekkefølgen er ikke meningsfull)").toEqual(["active", "lifted"]);
  }, 60_000);

  it("registreringstiden er tidspunktet STOP-en fikk låsen (`clock_timestamp()`), ikke transaksjonsstart (`now()`): en STOP som sto i lås-kø lenger enn marginen er likevel beskyttet mot en START rett etter", async () => {
    // Marginen settes til 1 s (kun denne testen); STOP-en holdes i lås-køen i 2,5 s. Med `now()` ville registreringstiden vært 2,5 s FØR den faktiske registreringen, og en START rett etter ville løftet.
    const store = new CommsStore(chain.db.app, chain.now, { startTieMarginMs: 1000 });
    const n = chain.phone();
    const hash = hashOf(TENANT_A, n);
    const holder = await chain.db.admin.connect();
    let stop: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`comms-optout|${TENANT_A}|${hash}`, LOCK_SEED]);
      stop = store.recordOptOut(TENANT_A, "business", { channel: "sms", recipient_hash: hash, recipient_hint: recipientHint("sms", n), source: "inbound_stop_keyword", recorded_by: "system" });
      let waiting = 0;
      for (let i = 0; i < 400 && waiting === 0; i++) {
        waiting = ((await chain.db.admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0] as { n: number }).n;
        if (waiting === 0) await sleep(10);
      }
      expect(waiting, "STOP-en står i lås-køen (transaksjonen er startet, låsen ikke tatt)").toBeGreaterThan(0);
      await sleep(2500);
      await holder.query("COMMIT");
    } finally { holder.release(); }
    await stop;
    expect(await store.liftByStartKeyword(TENANT_A, { channel: "sms", recipient_hash: hash }), "START rett etter registreringen: innenfor marginen regnet fra registreringen, ikke fra transaksjonsstart").toBe(0);
    expect(await store.isOptedOut(TENANT_A, hash)).toBe(true);
    // kontroll: om marginen er passert fra den FAKTISKE registreringen løfter START (bekrefter at målingen over ikke bare er en START som aldri løfter)
    await sleep(1200);
    expect(await store.liftByStartKeyword(TENANT_A, { channel: "sms", recipient_hash: hash })).toBe(1);
    expect(await store.isOptedOut(TENANT_A, hash)).toBe(false);
  }, 60_000);

  for (const order of ["start_first", "stop_first"] as const) {
    it(`matrise (${order}): gap ${GAPS_MS.join("/")} ms, ${MATRIX_ROUNDS} runder hver, ekte samtidige tilkoblinger: 0 frie mottakere`, async () => {
      const free: Record<string, number> = {};
      for (const gap of GAPS_MS) {
        let n0 = 0;
        for (let r = 0; r < MATRIX_ROUNDS; r++) {
          const n = chain.phone();
          await seedLegacyStop(TENANT_A, n);
          const start = (): Promise<unknown> => svc.handle("twilio", smsFrom(n, "START"));
          const stop = (): Promise<unknown> => svc.handle("twilio", smsFrom(n, "STOP"));
          await (order === "start_first" ? Promise.all([start(), sleep(gap).then(stop)]) : Promise.all([stop(), sleep(gap).then(start)]));
          if (!(await opted(TENANT_A, n))) n0++;
        }
        free[`${gap}ms`] = n0;
      }
      console.log(`G1C_OVERLAP_MATRIX ${order} ${JSON.stringify({ rounds: MATRIX_ROUNDS, free })}`);
      expect(free).toEqual(Object.fromEntries(GAPS_MS.map((g) => [`${g}ms`, 0])));
    }, 600_000);

    it(`samtidig oppstart (${order}, samme tick): ${MATRIX_ROUNDS} runder, 0 frie`, async () => {
      let free = 0;
      for (let r = 0; r < MATRIX_ROUNDS; r++) {
        const n = chain.phone();
        await seedLegacyStop(TENANT_A, n);
        const start = (): Promise<unknown> => svc.handle("twilio", smsFrom(n, "START"));
        const stop = (): Promise<unknown> => svc.handle("twilio", smsFrom(n, "STOP"));
        await (order === "start_first" ? Promise.all([start(), stop()]) : Promise.all([stop(), start()]));
        if (!(await opted(TENANT_A, n))) free++;
      }
      console.log(`G1C_OVERLAP_SIMULTANEOUS ${order} ${JSON.stringify({ rounds: MATRIX_ROUNDS, free })}`);
      expect(free).toBe(0);
    }, 300_000);
  }
});

interface Ev { seq: number; kind: "stop" | "start"; label: string }
interface Op { kind: "stop" | "start"; kw: string; sid: string; launch: number; script: Script; retry: boolean; ok: boolean; err?: string; stopSeq?: number; label: string }

async function runOp(service: CommsWebhookService, num: string, op: Op, script: Script): Promise<void> {
  try {
    const res = await als.run(script, () => service.handle("twilio", smsFrom(num, op.kw, op.sid)));
    op.ok = res.status === 200;
    if (!op.ok) op.err = `status_${res.status}`;
    const last = script.seqs[script.seqs.length - 1];
    if (op.ok && op.kind === "stop" && last !== undefined) op.stopSeq = last;
  } catch (e) {
    op.ok = false;
    op.err = e instanceof Error ? e.message : String(e);
  }
}

interface RoundResult { tenant: string; expected: boolean; actual: boolean; events: Ev[]; unexpected: string[]; stopAfterRecv: boolean; injected: number }

/**
 * Én runde for én tenant: en bestående avmelding (STOP#1), så et løp mellom 1-3 STOP og 1-2 START (med duplikat-levering), injiserte feil (rollback etter sekvens, kast etter mottak) og leverandørens retry. `mode` `sequence`: STOP#1 er en ekte,
 * sekvensert STOP og orakelet er en uavhengig gjenspilling i sekvensrekkefølge (marginen er 0). `margin`: STOP#1 er en gammel rad og produksjonsmarginen gjelder: alt i runden skjer innenfor marginen, så sluttilstanden er avmeldt så snart
 * én STOP#2 er anvendt (ellers løfter START den gamle raden).
 */
async function scenario(tenant: string, service: CommsWebhookService, num: string, mode: "sequence" | "margin"): Promise<RoundResult> {
  const unexpected: string[] = [];
  const events: Ev[] = [];
  if (mode === "sequence") {
    const first: Op = { kind: "stop", kw: "STOP", sid: newSid(), launch: 0, script: newScript(), retry: false, ok: false, label: "STOP#1" };
    await runOp(service, num, first, first.script);
    if (!first.ok || first.stopSeq === undefined) throw new Error(`STOP#1 feilet: ${first.err}`);
    events.push({ seq: first.stopSeq, kind: "stop", label: "STOP#1" });
  } else {
    await seedLegacyStop(tenant, num);
  }
  const nStops = pick([1, 1, 2, 3]);
  const nStarts = pick([1, 1, 2]);
  const ops: Op[] = [];
  for (let i = 0; i < nStops; i++) ops.push({ kind: "stop", kw: pick(["STOP", "STOPP", "stop", "Stop."]), sid: newSid(), launch: pick([0, 0, 1, 2, 4, 6]), script: randomScript("stop"), retry: rnd() < 0.7, ok: false, label: `stop${i + 2}` });
  for (let i = 0; i < nStarts; i++) ops.push({ kind: "start", kw: pick(["START", "start", "UNSTOP"]), sid: newSid(), launch: pick([0, 0, 1, 2, 4, 6]), script: randomScript("start"), retry: rnd() < 0.85, ok: false, label: `start${i + 1}` });
  // duplikat-levering av noen av hendelsene (leverandør-retry mens den første fortsatt kjører)
  const dups: Op[] = [];
  for (const o of ops) if (rnd() < 0.25) dups.push({ ...o, launch: o.launch + pick([0, 1, 3]), script: randomScript(o.kind), ok: false, label: `${o.label}-dup` });
  const injected = ops.filter((o) => o.script.failAfterSeq || o.script.failAfterRecv).length;

  await Promise.all([...ops, ...dups].map(async (o) => { await sleep(o.launch); await runOp(service, num, o, o.script); }));
  // leverandørens retry av det som feilet (samme hendelsesnøkkel)
  for (const o of ops) {
    if (!o.ok && o.retry) {
      await sleep(pick([0, 2, 5]));
      await runOp(service, num, o, newScript());
      if (!o.ok) unexpected.push(`retry feilet (${o.kind}): ${o.err}`);
    }
  }
  for (const o of ops) if (o.kind === "stop" && o.ok && o.stopSeq !== undefined) events.push({ seq: o.stopSeq, kind: "stop", label: o.label });
  // duplikat som lyktes mens originalen ikke gjorde det: dupliatets registrering gjelder
  for (const d of dups) {
    const original = ops.find((o) => o.sid === d.sid) as Op;
    if (d.kind === "stop" && d.ok && d.stopSeq !== undefined && !(original.ok && original.stopSeq !== undefined)) events.push({ seq: d.stopSeq, kind: "stop", label: d.label });
  }
  const startRecvs = new Map<string, number>();
  for (const o of ops) {
    if (o.kind !== "start") continue;
    const dup = dups.find((d) => d.sid === o.sid);
    const recv = await receiptSeq(tenant, o.sid);
    if (o.ok || (dup?.ok ?? false)) {
      if (recv === null) { unexpected.push(`START anvendt uten mottakskvittering (${o.sid})`); continue; }
      startRecvs.set(o.sid, recv);
      events.push({ seq: recv, kind: "start", label: o.label });
    }
  }
  const ordered = [...events].sort((x, y) => x.seq - y.seq);
  let expected = false;
  if (mode === "sequence") {
    for (const e of ordered) expected = e.kind === "stop";
  } else {
    const anyStop2 = ordered.some((e) => e.kind === "stop");
    const anyStart = ordered.some((e) => e.kind === "start");
    expected = anyStop2 ? true : !anyStart;
  }
  const actual = await opted(tenant, num);
  // invariant: en opphevet rad har registreringssekvens lavere enn største START-mottak; aldri to aktive rader i samme spor
  const rows = (await chain.db.admin.query("SELECT status, stop_seq FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [tenant, hashOf(tenant, num)])).rows as Array<{ status: string; stop_seq: string | null }>;
  const maxRecv = Math.max(-1, ...startRecvs.values());
  for (const r of rows) if (r.status === "lifted" && !(Number(r.stop_seq ?? 0) < maxRecv)) unexpected.push(`opphevet rad med stop_seq=${r.stop_seq} >= største START-mottak ${maxRecv}`);
  if (rows.filter((r) => r.status === "active").length > 1) unexpected.push("flere aktive rader i samme spor");
  const firstStart = ops.find((o) => o.kind === "start" && startRecvs.has(o.sid));
  const stopAfterRecv = firstStart !== undefined && events.filter((e) => e.kind === "stop" && e.label !== "STOP#1").some((e) => e.seq > (startRecvs.get(firstStart.sid) as number));
  return { tenant, expected, actual, events: ordered, unexpected, stopAfterRecv, injected };
}

describe("FIX-3: uavhengig sekvens-orakel under ekte samtidighet (varierende interleaving, rollback/gap, to tenants med samme nummer)", () => {
  it(`margin 0 (ren sekvensmodell), ${ROUNDS} runder x 2 tenants (seed ${SEED}): sluttilstanden = gjenspilling i sekvensrekkefølge; ingen uventede feil`, async () => {
    const mismatches: string[] = [];
    let stopAfter = 0, stopBefore = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const num = chain.phone();
      const [ra, rb] = await Promise.all([scenario(TENANT_A, svcZero, num, "sequence"), scenario(TENANT_B, svcZeroB, num, "sequence")]);
      for (const r of [ra, rb]) {
        if (r.stopAfterRecv) stopAfter++; else stopBefore++;
        if (r.unexpected.length > 0) mismatches.push(`runde ${round} ${r.tenant}: UVENTET ${r.unexpected.join(" | ")}`);
        if (r.actual !== r.expected) mismatches.push(`runde ${round} ${r.tenant}: forventet opted=${r.expected} faktisk=${r.actual} events=${JSON.stringify(r.events)}`);
      }
    }
    console.log(`G1C_ORACLE_SEQUENCE ${JSON.stringify({ rounds: ROUNDS, scenarios: ROUNDS * 2, stopRegisteredAfterStartReceipt: stopAfter, noStopAfterStartReceipt: stopBefore, mismatches: mismatches.length })}`);
    expect(mismatches).toEqual([]);
    expect(stopAfter, "runder der en STOP ble registrert ETTER START-mottaket (ellers dekker testen ikke overlappen)").toBeGreaterThan(0);
    expect(stopBefore).toBeGreaterThan(0);
  }, 900_000);

  it(`produksjonsmarginen, ${ROUNDS} runder (seed ${SEED}): ingen runde slipper mottakeren når en STOP#2 er anvendt, uansett interleaving, rollback og retry`, async () => {
    const mismatches: string[] = [];
    let applied = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const num = chain.phone();
      const r = await scenario(TENANT_A, svc, num, "margin");
      if (r.events.some((e) => e.kind === "stop")) applied++;
      if (r.unexpected.length > 0) mismatches.push(`runde ${round}: UVENTET ${r.unexpected.join(" | ")}`);
      if (r.actual !== r.expected) mismatches.push(`runde ${round}: forventet opted=${r.expected} faktisk=${r.actual} events=${JSON.stringify(r.events)}`);
    }
    console.log(`G1C_ORACLE_MARGIN ${JSON.stringify({ rounds: ROUNDS, roundsWithStop2Applied: applied, mismatches: mismatches.length })}`);
    expect(mismatches).toEqual([]);
    expect(applied).toBeGreaterThan(0);
  }, 900_000);
});
