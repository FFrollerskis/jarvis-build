import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { VoiceAuthorizationResult } from "@jarvis/contracts";
import { ConnectionTracker, type ConnectionTicket } from "../src/limits.ts";
import { IDENTITY, PROOF, ScriptedCore, TestClient, sleep, startGateway, trackUncaught, type RunningGateway } from "./wpv2-harness.ts";

/**
 * WP-V2 fiks-runde 2, FIX-2 (F11, F2-rest): CHURN kastet ut eierens VENTENDE tilkobling før `markProven`.
 *
 * Når peer-en er full (bak Docker-bridge/proxy kan alle klienter ha samme peer-adresse) kastes den ELDSTE ikke-beviste tilkoblingen ut for hver ny tilkobling. Eierens
 * tilkobling er ikke-bevist til Core har svart på autoriseringen - den ble kastet ut MIDT i håndtrykket (målt med 80 ms Core-svar fra en kollapset peer: 30/30 ved 25
 * tilkoblinger/s, 6/30 ved 50/s, 0/30 ved 100/s, `voice_evicted`). Nå har en tilkobling med pågående Core-autorisering tilstanden «authorizing» og kastes ikke ut før
 * vedtaket foreligger (høyst Core-fristen). Et avslag eller en feil gir tilbake «pending» (utkastbar), så en angriper kan ikke holde en plass med søppelbevis; en
 * bevist tilkobling forblir bevist.
 */
let gateway: RunningGateway | undefined;
let tracker = trackUncaught();
const extraSockets: WebSocket[] = [];

afterEach(async () => {
  tracker.stop();
  for (const ws of extraSockets.splice(0)) ws.terminate();
  await gateway?.close();
  gateway = undefined;
  tracker = trackUncaught();
  expect(tracker.errors).toEqual([]);
});

describe("ConnectionTracker: «authorizing» (FIX-2, F11)", () => {
  const noop = (): void => undefined;
  const admitOk = (t: ConnectionTracker, peer: string, evict: () => void = noop): ConnectionTicket => {
    const result = t.admit(peer, evict);
    if (!result.ok) throw new Error(`avvist: ${result.reason}`);
    return result.ticket;
  };

  it("en tilkobling med pågående autorisering kastes IKKE ut når peeren er full - den neste eldste tas i stedet", () => {
    const t = new ConnectionTracker(10, 3, 2);
    const evicted: string[] = [];
    const owner = admitOk(t, "p", () => evicted.push("owner")); // eldst
    admitOk(t, "p", () => evicted.push("b"));
    admitOk(t, "p", () => evicted.push("c"));
    expect(t.beginAuthorizing(owner)).toBe(true);
    admitOk(t, "p", () => evicted.push("d")); // peeren er full: b (eldste UTKASTBARE) kastes ut, ikke owner
    admitOk(t, "p", () => evicted.push("e")); // c
    expect(evicted).toEqual(["b", "c"]);
    expect(t.activeFor("p")).toBe(3);
  });

  it("globalt: en tilkobling med pågående autorisering er vernet også når den globale grensen er nådd; er alt vernet, avvises den nye", () => {
    const t = new ConnectionTracker(2, 10, 10);
    const evicted: string[] = [];
    const a = admitOk(t, "x", () => evicted.push("a"));
    const b = admitOk(t, "y", () => evicted.push("b"));
    t.beginAuthorizing(a);
    t.beginAuthorizing(b);
    expect(t.admit("z", noop)).toEqual({ ok: false, reason: "global_limit" });
    expect(t.admit("x", noop)).toEqual({ ok: false, reason: "global_limit" });
    expect(evicted).toEqual([]);
  });

  it("vedtaket avgjør: bevist = vernet for alltid; avslag/feil (endAuthorizing) = utkastbar igjen, og teller ikke som ubevist sesjon", () => {
    const t = new ConnectionTracker(10, 2, 1);
    const evicted: string[] = [];
    const denied = admitOk(t, "p", () => evicted.push("denied"));
    const proven = admitOk(t, "p", () => evicted.push("proven"));
    t.beginAuthorizing(denied);
    t.beginAuthorizing(proven);
    expect(t.unprovenFor("p")).toBe(0); // en autorisering er ikke en ubevist sesjon
    t.markProven(proven);
    t.endAuthorizing(denied); // Core avslo
    expect(t.unprovenFor("p")).toBe(0); // tilbake til «pending» (ingen sesjon), IKKE «unproven» (telles ikke mot ubevist-taket)
    admitOk(t, "p", () => evicted.push("new")); // full: den eneste utkastbare er `denied`
    expect(evicted).toEqual(["denied"]);
    t.endAuthorizing(proven); // et sent endAuthorizing rører ikke en bevist tilkobling
    admitOk(t, "p", () => evicted.push("newer")); // full igjen: den eneste utkastbare er `new` - aldri den bevisste
    expect(evicted).toEqual(["denied", "new"]);
  });

  it("en allerede bevist tilkobling (ny start på samme socket) forblir bevist under og etter en ny autorisering", () => {
    const t = new ConnectionTracker(10, 1, 1);
    const evicted: string[] = [];
    const owner = admitOk(t, "p", () => evicted.push("owner"));
    t.markProven(owner);
    expect(t.beginAuthorizing(owner)).toBe(true);
    expect(t.admit("p", noop)).toEqual({ ok: false, reason: "peer_limit" });
    t.endAuthorizing(owner);
    expect(t.admit("p", noop)).toEqual({ ok: false, reason: "peer_limit" });
    expect(evicted).toEqual([]);
  });

  it("en kastet ut eller frigjort tilkobling kan ikke begynne å autorisere (false), og endAuthorizing/markProven på den er no-ops", () => {
    const t = new ConnectionTracker(10, 1, 1);
    const first = admitOk(t, "p");
    admitOk(t, "p"); // kaster ut `first`
    expect(t.beginAuthorizing(first)).toBe(false);
    t.endAuthorizing(first);
    t.markProven(first);
    expect(t.active).toBe(1);
    const second = admitOk(t, "q");
    t.release(second);
    expect(t.beginAuthorizing(second)).toBe(false);
  });
});

/** Core der autorisering av `owner-dev` venter på en port (deterministisk: ingen tidsavhengighet), og andre enheter kan avvises/feile. */
class GatedCore extends ScriptedCore {
  waiting = 0;
  deny = false;
  fail = false;
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  releaseOwner(): void {
    this.open();
  }
  override async authorizeVoiceSession(evidence: unknown): Promise<VoiceAuthorizationResult> {
    const device = (evidence as { device_id?: string }).device_id;
    if (device === "owner-dev") {
      this.waiting += 1;
      await this.gate;
    }
    if (this.fail) throw new Error("core_utilgjengelig");
    if (this.deny) return { ok: false, reason: "device_proof_invalid" };
    return super.authorizeVoiceSession(evidence);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timeout i waitUntil");
    await sleep(5);
  }
}

describe("gjennom gatewayen: eierens ventende autorisering overlever churn fra samme (kollapsede) peer", () => {
  const ownerStart = { type: "start", identity: { ...IDENTITY, device_id: "owner-dev" }, device_proof: PROOF };

  it("eierens tilkobling er ELDST og Core-autoriseringen står (gate); seks nye tilkoblinger fra samme peer kaster ut ANGRIPERNE, ikke eieren - og eieren får `started` når Core svarer", async () => {
    const core = new GatedCore();
    gateway = await startGateway({ core, limits: { maxConnectionsPerPeer: 4, maxUnprovenPerPeer: 2 } });
    const owner = await new TestClient(gateway.url).connect();
    owner.send(ownerStart);
    await waitUntil(() => core.waiting === 1); // Core-autoriseringen pågår
    const attackers: TestClient[] = [];
    for (let i = 0; i < 6; i++) attackers.push(await new TestClient(gateway.url).connect()); // peeren er full etter 3: hver ny kaster ut den eldste utkastbare
    await sleep(100);
    expect(owner.closeEvent).toBeNull();
    expect(owner.errors()).not.toContain("voice_evicted");
    expect(attackers.slice(0, 3).every((a) => a.closeEvent?.code === 1013 && a.errors().includes("voice_evicted"))).toBe(true); // de eldste angriperne ble utkastet
    core.releaseOwner();
    await owner.waitFor((m) => m.type === "started");
    expect(owner.closeEvent).toBeNull();
    for (const c of [owner, ...attackers]) c.close();
  });

  it("AVSLÅTT bevis: tilkoblingen er utkastbar igjen (en angriper kan ikke holde en plass med søppelbevis) - og tilsvarende etter en Core-feil", async () => {
    for (const mode of ["deny", "fail"] as const) {
      const core = new GatedCore();
      core.releaseOwner(); // ingen venting: avslaget/feilen kommer straks
      core[mode] = true;
      gateway = await startGateway({ core, limits: { maxConnectionsPerPeer: 2, maxUnprovenPerPeer: 2 } });
      const a1 = await new TestClient(gateway.url).connect();
      a1.send(ownerStart);
      await a1.waitFor((m) => m.type === "error" && String(m["error"]).startsWith("voice_authority_"));
      const a2 = await new TestClient(gateway.url).connect();
      a2.send(ownerStart);
      await a2.waitFor((m) => m.type === "error" && String(m["error"]).startsWith("voice_authority_"));
      const newcomer = await new TestClient(gateway.url).connect(); // peeren er full (2): begge angriperne er utkastbare igjen - den eldste (a1) kastes ut
      await a1.waitClosed();
      expect(a1.closeEvent).toEqual({ code: 1013, reason: "evicted" });
      expect(a1.errors()).toContain("voice_evicted");
      expect(newcomer.closeEvent).toBeNull(); // IKKE voice_busy: den nye kom inn
      expect(newcomer.errors()).not.toContain("voice_busy");
      for (const c of [a2, newcomer]) c.close();
      await gateway.close();
      gateway = undefined;
    }
  });

  it("en BEVIST tilkobling forblir vernet (markProven) også når en ny start på samme socket avslås - den skilles fra en tilkobling med pågående autorisering først ved vedtaket", async () => {
    const core = new GatedCore();
    core.releaseOwner(); // ingen venting
    gateway = await startGateway({ core, limits: { maxConnectionsPerPeer: 2, maxUnprovenPerPeer: 2 } });
    const owner = await new TestClient(gateway.url).connect();
    owner.send(ownerStart);
    await owner.waitFor((m) => m.type === "started"); // bevist: markProven
    core.deny = true;
    owner.send(ownerStart); // nytt bevis på samme socket - Core avslår (sesjonen er revet, men tilkoblingen er fortsatt bevist, jf. «Gjenstår» i runbooken)
    await owner.waitFor((m) => m.type === "error" && String(m["error"]).startsWith("voice_authority_denied"));
    const other = await new TestClient(gateway.url).connect(); // peeren er full (2)
    const third = await new TestClient(gateway.url).connect(); // den eneste utkastbare er `other` - aldri den bevisste eieren (som er eldst)
    await other.waitClosed();
    expect(other.closeEvent).toEqual({ code: 1013, reason: "evicted" });
    expect(owner.closeEvent).toBeNull();
    for (const c of [owner, third]) c.close();
  });

  it("Core-autorisering som aldri kommer (Core-frist): ingen utkasting underveis, og når fristen går ut er tilkoblingen utkastbar igjen", async () => {
    // GatedCore med lukket gate = «Core henger». Fristen simuleres av at autoriseringen kaster etter en stund (som HttpCoreClient sin AbortSignal.timeout).
    class HangThenFail extends ScriptedCore {
      calls = 0;
      private failNow!: () => void;
      private readonly failure = new Promise<never>((_, reject) => {
        this.failNow = () => reject(new Error("timeout"));
      });
      timeout(): void {
        this.failNow();
      }
      override async authorizeVoiceSession(): Promise<VoiceAuthorizationResult> {
        this.calls += 1;
        return this.failure;
      }
    }
    const core = new HangThenFail();
    gateway = await startGateway({ core, limits: { maxConnectionsPerPeer: 2, maxUnprovenPerPeer: 2 } });
    const hanging = await new TestClient(gateway.url).connect();
    hanging.send(ownerStart);
    await waitUntil(() => core.calls === 1);
    const other = await new TestClient(gateway.url).connect();
    const third = await new TestClient(gateway.url).connect(); // full: `hanging` er vernet, så `other` kastes ut
    await other.waitClosed();
    expect(other.closeEvent?.code).toBe(1013);
    expect(hanging.closeEvent).toBeNull();
    core.timeout(); // fristen gikk ut
    await hanging.waitFor((m) => m.type === "error" && m["error"] === "voice_authority_unavailable");
    const fourth = await new TestClient(gateway.url).connect(); // full igjen (hanging + third): nå er `hanging` utkastbar (eldst)
    await hanging.waitClosed();
    expect(hanging.closeEvent).toEqual({ code: 1013, reason: "evicted" });
    expect(third.closeEvent).toBeNull();
    for (const c of [third, fourth]) c.close();
  });
});

// ---- Reviewerens churn-probe (d2), portet: eieren mot en kollapset peer med flom av nye tilkoblinger og 80 ms Core-autorisering ----
class SlowCore extends ScriptedCore {
  override async authorizeVoiceSession(evidence: unknown): Promise<VoiceAuthorizationResult> {
    await sleep(80);
    return super.authorizeVoiceSession(evidence);
  }
}

describe("churn-probe (d2): eierens bevisste enhet mot en flom av nye tilkoblinger fra samme peer", () => {
  it("100 nye tilkoblinger/s og 80 ms Core-autorisering: eieren kommer inn (målt FØR fiksen: 0 av 30 ved 100/s, 6 av 30 ved 50/s)", async () => {
    gateway = await startGateway({ core: new SlowCore() });
    const url = gateway.url;
    let stop = false;
    const flooder = (async () => {
      while (!stop) {
        const ws = new WebSocket(url);
        ws.on("error", () => undefined);
        extraSockets.push(ws);
        if (extraSockets.length > 64) for (const old of extraSockets.splice(0, 32)) old.terminate();
        await sleep(10);
      }
    })();
    let ok = 0;
    const attempts = 12;
    for (let i = 0; i < attempts; i++) {
      const owner = await new TestClient(url).connect();
      owner.send({ type: "start", identity: { ...IDENTITY, device_id: "owner-dev" }, device_proof: PROOF });
      const started = Date.now();
      while (Date.now() - started < 1500 && owner.closeEvent === null && !owner.messages.some((m) => m.type === "started")) await sleep(10);
      if (owner.messages.some((m) => m.type === "started")) ok += 1;
      owner.ws.terminate();
      await sleep(80);
    }
    stop = true;
    await flooder;
    expect(ok).toBeGreaterThanOrEqual(10); // uten fiksen ca. 0; med fiksen kun det korte vinduet FØR `start` er mottatt (loopback: ~1 ms)
  }, 60_000);
});
