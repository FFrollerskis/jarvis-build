import { describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { DavError } from "@jarvis/tool-gateway";
import {
  DEFAULT_DAV_RATE_LIMITS, createDavRateLimit, davAuditDecision, type DavAuditEntry, type DavRateLimit, type PersonalDavDeps
} from "../src/personal-dav.ts";
import { handlePersonalRoute, type PersonalRouteContext } from "../src/personal-routes.ts";
import { createPersonalWiring } from "../src/personal-wiring.ts";

/**
 * WP-G2c (D-483, JARVIS-113 e/6-7): DAV-rutene får (6) en EGEN grense per prinsipal (enhet, person og mutasjon) i tillegg til den globale, og (7) en revisjons-`decision` som følger UTFALLET (ALLOW kun for bekreftet
 * `requested`/`SUCCESS`/`REPLAYED`). Funksjonelle bevis med spioner og en falsk pool (ingen nettverk, ingen database).
 */
const owner: IdentityContext = { person_id: "p-owner", tenant_id: "t-owner", memory_space_id: "personal", session_id: "s", device_id: "d-1", channel: "web", auth_strength: "signed" };
const CAL = "https://caldav.example.com/u1/cal/";

describe("A: davAuditDecision - ALLOW bare for bekreftede utfall (JARVIS-113 e/7)", () => {
  it("tabell: requested/SUCCESS/REPLAYED = ALLOW; DENY = DENY; rejected:* = REJECTED; MISMATCH og UNKNOWN beholdes; alt annet er UNKNOWN (fail closed)", () => {
    const table: Array<[string, "ALLOW" | "DENY" | undefined, string]> = [
      ["requested", undefined, "ALLOW"], ["SUCCESS", undefined, "ALLOW"], ["REPLAYED", undefined, "ALLOW"],
      ["MISMATCH", undefined, "MISMATCH"], ["UNKNOWN", undefined, "UNKNOWN"],
      ["rejected:etag_mismatch", undefined, "REJECTED"], ["rejected:invalid_input", undefined, "REJECTED"], ["rejected:", undefined, "REJECTED"],
      ["blocked", "DENY", "DENY"], ["requested", "DENY", "DENY"], ["SUCCESS", "DENY", "DENY"]
    ];
    for (const [outcome, decision, expected] of table) expect(davAuditDecision({ outcome, ...(decision !== undefined ? { decision } : {}) }), `${outcome}/${decision}`).toBe(expected);
  });

  it("uventede og fiendtlige utfallsstrenger er ALDRI ALLOW (skrivemåte, mellomrom, tomt, annen kode), og en eksplisitt ALLOW fra kalleren kan ikke løfte et ubekreftet utfall", () => {
    for (const outcome of ["success", "Success", "SUCCESS ", " SUCCESS", "SUCCESS\n", "ok", "OK", "ALLOW", "", "requested ", "REQUESTED", "replayed", "rejected", "Rejected:x", "xrejected:x", "mismatch", "unknown", "null", "undefined", "SUCCESS;DROP"]) {
      expect(davAuditDecision({ outcome }), JSON.stringify(outcome)).not.toBe("ALLOW");
      expect(davAuditDecision({ outcome, decision: "ALLOW" }), `ALLOW + ${JSON.stringify(outcome)}`).not.toBe("ALLOW");
    }
    expect(davAuditDecision({ outcome: "MISMATCH", decision: "ALLOW" })).toBe("MISMATCH");
    expect(davAuditDecision({ outcome: "UNKNOWN", decision: "ALLOW" })).toBe("UNKNOWN");
    expect(davAuditDecision({ outcome: "rejected:etag_mismatch", decision: "ALLOW" })).toBe("REJECTED");
    expect(davAuditDecision({ outcome: undefined as never })).toBe("UNKNOWN");
    expect(davAuditDecision({ outcome: 42 as never })).toBe("UNKNOWN");
  });
});

describe("B: createDavRateLimit - grense per prinsipal (JARVIS-113 e/6)", () => {
  const who = (device: string, person = "p-owner", tenant = "t-owner") => ({ tenant_id: tenant, person_id: person, device_id: device });
  const clockAt = (t0 = 1_000_000) => { let t = t0; return { now: () => t, advance: (ms: number) => { t += ms; } }; };
  const fill = (rl: DavRateLimit, identity: ReturnType<typeof who>, n: number, mutation = false) => Array.from({ length: n }, () => rl.check(identity, mutation));

  it("standardgrensene er 30/enhet, 60/person og 10 mutasjoner/person per minutt", () => {
    expect(DEFAULT_DAV_RATE_LIMITS).toEqual({ perDevicePerMinute: 30, perPersonPerMinute: 60, mutationsPerPersonPerMinute: 10 });
    expect(Object.isFrozen(DEFAULT_DAV_RATE_LIMITS)).toBe(true);
  });

  it("enhet: de første 30 går gjennom, den 31. avvises med scope `device` og en ventetid på 1-60 s; etter vinduet er det åpent igjen", () => {
    const c = clockAt();
    const rl = createDavRateLimit({}, c.now);
    expect(fill(rl, who("d-1"), 30).every((r) => r.ok)).toBe(true);
    const denied = rl.check(who("d-1"), false);
    expect(denied).toMatchObject({ ok: false, scope: "device" });
    expect((denied as { retry_after_seconds: number }).retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect((denied as { retry_after_seconds: number }).retry_after_seconds).toBeLessThanOrEqual(60);
    c.advance(30_000);
    expect(rl.check(who("d-1"), false)).toMatchObject({ ok: false, scope: "device", retry_after_seconds: 30 }); // ventetiden teller ned med vinduet
    c.advance(29_000);
    expect(rl.check(who("d-1"), false)).toMatchObject({ ok: false, retry_after_seconds: 1 });
    c.advance(1_000);
    expect(rl.check(who("d-1"), false).ok).toBe(true);
  });

  it("person: flere enheter deler ÉN personbudsjett (60), så en person med mange enheter kan ikke gange grensen", () => {
    const rl = createDavRateLimit({}, clockAt().now);
    expect(fill(rl, who("d-1"), 30).every((r) => r.ok)).toBe(true);
    expect(fill(rl, who("d-2"), 30).every((r) => r.ok)).toBe(true);
    expect(rl.check(who("d-3"), false)).toMatchObject({ ok: false, scope: "person" }); // en fersk enhet, men personens 60 er brukt
    expect(rl.check(who("d-3", "p-annen"), false).ok).toBe(true); // en annen person i samme tenant er upåvirket
  });

  it("mutasjon: 10 per person per minutt, i tillegg til enhets-/personbudsjettet; lesing er upåvirket av at mutasjonsbudsjettet er brukt", () => {
    const rl = createDavRateLimit({}, clockAt().now);
    expect(fill(rl, who("d-1"), 10, true).every((r) => r.ok)).toBe(true);
    expect(rl.check(who("d-1"), true)).toMatchObject({ ok: false, scope: "mutation" });
    expect(rl.check(who("d-2"), true)).toMatchObject({ ok: false, scope: "mutation" }); // på tvers av enheter (per person)
    expect(rl.check(who("d-1"), false).ok).toBe(true); // lesing går fortsatt
    // mutasjoner teller også i enhetsbudsjettet: 10 mutasjoner + 20 lesinger = 30 på d-1 (alle tillatt), den 31. avvises
    const rl2 = createDavRateLimit({}, clockAt().now);
    fill(rl2, who("d-1"), 10, true);
    expect(fill(rl2, who("d-1"), 20).every((r) => r.ok)).toBe(true);
    expect(rl2.check(who("d-1"), false)).toMatchObject({ ok: false, scope: "device" });
  });

  it("en avvisning teller IKKE mot en grense som ikke var nådd: en enhet som flommer tømmer ikke personens budsjett for de andre enhetene", () => {
    const rl = createDavRateLimit({}, clockAt().now);
    const flood = fill(rl, who("d-flood"), 500);
    expect(flood.filter((r) => r.ok)).toHaveLength(30);
    expect(fill(rl, who("d-2"), 30).every((r) => r.ok)).toBe(true); // personen har brukt 30 + 30 = 60, ikke 530
    // og mutasjonsbudsjettet røres ikke av avviste lesinger: 10 mutasjoner går fortsatt (på en annen enhet; personen har 60 - 60 = 0 igjen, så scope er person, ikke mutation)
    expect(rl.check(who("d-3"), true)).toMatchObject({ ok: false, scope: "person" });
  });

  it("fiks-runde 1 (LOW-3): en avvisning bruker ALDRI budsjett, uansett hvilken grense som avviste - person-avvist bruker ikke enhetsbudsjettet, enhets-avvist bruker ikke person-/mutasjonsbudsjettet", () => {
    const rl = createDavRateLimit({ perDevicePerMinute: 3, perPersonPerMinute: 2, mutationsPerPersonPerMinute: 5 }, clockAt().now);
    expect(fill(rl, who("d-1", "p-1"), 2).every((r) => r.ok)).toBe(true); // enhet d-1: 2/3, person p-1: 2/2
    expect(rl.check(who("d-1", "p-1"), false)).toMatchObject({ ok: false, scope: "person" });
    expect(rl.check(who("d-1", "p-2"), false).ok, "avvisningen over brukte IKKE enhetens tredje plass").toBe(true);
    expect(rl.check(who("d-1", "p-2"), false)).toMatchObject({ ok: false, scope: "device" }); // enhet d-1: 3/3
    expect(rl.check(who("d-9", "p-2"), false).ok, "enhets-avvisningen over brukte IKKE p-2 sitt personbudsjett (1 av 2 brukt)").toBe(true);
    expect(rl.check(who("d-9", "p-2"), false)).toMatchObject({ ok: false, scope: "person" });
    // mutasjons-avvist (grensen 5) bruker verken enhet eller person
    const m = createDavRateLimit({ perDevicePerMinute: 100, perPersonPerMinute: 100, mutationsPerPersonPerMinute: 2 }, clockAt().now);
    expect(fill(m, who("d-1"), 2, true).every((r) => r.ok)).toBe(true);
    for (let i = 0; i < 500; i += 1) expect(m.check(who("d-1"), true)).toMatchObject({ ok: false, scope: "mutation" });
    expect(fill(m, who("d-1"), 98).every((r) => r.ok), "enheten har brukt 2 av 100, ikke 502").toBe(true);
    expect(m.check(who("d-1"), false)).toMatchObject({ ok: false, scope: "device" });
  });

  it("fiks-runde 1 (LOW-3, A K3d): 10 tillatte + 50 avviste mutasjoner bruker 10 av enhets- og personbudsjettet (ikke 60) - lesingene etterpå får hele resten (20 på enheten, 50 på personen)", () => {
    const rl = createDavRateLimit({}, clockAt().now);
    expect(fill(rl, who("d-1"), 10, true).every((r) => r.ok)).toBe(true);
    expect(fill(rl, who("d-1"), 50, true).every((r) => !r.ok && r.scope === "mutation")).toBe(true);
    expect(fill(rl, who("d-1"), 20).every((r) => r.ok)).toBe(true); // 10 + 20 = 30 på enheten
    expect(rl.check(who("d-1"), false)).toMatchObject({ ok: false, scope: "device" });
    expect(fill(rl, who("d-2"), 30).every((r) => r.ok)).toBe(true); // personen: 30 + 30 = 60
    expect(rl.check(who("d-3"), false)).toMatchObject({ ok: false, scope: "person" }); // en fersk enhet: kun personbudsjettet er brukt opp
  });

  it("fiks-runde 1: GLIDENDE vindu - aldri mer enn grensen innenfor noe intervall på 60 s (et fast vindu ga 2 x grensen rundt vindusskiftet); ventetiden er tiden til den eldste tillatte forespørselen forlater vinduet", () => {
    const c = clockAt();
    const rl = createDavRateLimit({}, c.now);
    expect(rl.check(who("d-1"), false).ok).toBe(true); // t0
    c.advance(59_000);
    expect(fill(rl, who("d-1"), 29).every((r) => r.ok)).toBe(true); // 30 i vinduet
    expect(rl.check(who("d-1"), false)).toMatchObject({ ok: false, scope: "device", retry_after_seconds: 1 }); // t0 forlater vinduet om 1 s
    c.advance(1_000); // 60 s etter t0: KUN den ene plassen er ledig (fast vindu: 30 nye)
    expect(rl.check(who("d-1"), false).ok).toBe(true);
    expect(rl.check(who("d-1"), false)).toMatchObject({ ok: false, scope: "device", retry_after_seconds: 59 }); // neste å forlate vinduet er de 29 fra t0+59 s
    c.advance(59_000);
    expect(fill(rl, who("d-1"), 29).every((r) => r.ok)).toBe(true);
    expect(rl.check(who("d-1"), false).ok).toBe(false);
    // og et tomt vindu er åpent igjen: etter 60 s uten forespørsler er hele budsjettet fullt
    c.advance(60_000);
    expect(fill(rl, who("d-1"), 30).every((r) => r.ok)).toBe(true);
  });

  it("fiks-runde 1: ventetiden er den LENGSTE av de blokkerte grensene (klienten skal ikke få en ventetid som bare fører til en ny 429)", () => {
    const c = clockAt();
    const rl = createDavRateLimit({ perDevicePerMinute: 2, perPersonPerMinute: 2, mutationsPerPersonPerMinute: 5 }, c.now);
    expect(rl.check(who("d-1", "p-2"), false).ok).toBe(true); // t0: d-1 (1/2), p-2
    c.advance(5_000);
    expect(rl.check(who("d-1", "p-1"), false).ok).toBe(true); // t0+5: d-1 (2/2: eldste t0), p-1 (1/2)
    c.advance(25_000);
    expect(rl.check(who("d-2", "p-1"), false).ok).toBe(true); // t0+30: p-1 (2/2: eldste t0+5)
    c.advance(10_000); // t0+40
    // d-1 er full (eldste t0 -> ledig om 20 s) og p-1 er full (eldste t0+5 -> ledig om 25 s): ventetiden er 25 s, scope person
    expect(rl.check(who("d-1", "p-1"), false)).toEqual({ ok: false, scope: "person", retry_after_seconds: 25 });
    c.advance(25_000);
    expect(rl.check(who("d-1", "p-1"), false).ok).toBe(true);
  });

  it("fiks-runde 1: samme person- og enhets-id i to tenanter har hvert sitt budsjett (personnøkkel og mutasjonsnøkkel inneholder tenanten)", () => {
    const rl = createDavRateLimit({ perPersonPerMinute: 2, perDevicePerMinute: 100, mutationsPerPersonPerMinute: 1 }, clockAt().now);
    const a = { tenant_id: "t-a", person_id: "p", device_id: "d" };
    const b = { tenant_id: "t-b", person_id: "p", device_id: "d" };
    expect(fill(rl, a, 1, true).every((r) => r.ok)).toBe(true);
    expect(rl.check(a, true)).toMatchObject({ ok: false, scope: "mutation" });
    expect(rl.check(b, true).ok, "tenant B sin mutasjonsgrense er uberørt").toBe(true);
    expect(rl.check(a, false).ok).toBe(true); // person t-a: 2/2
    expect(rl.check(a, false)).toMatchObject({ ok: false, scope: "person" });
    expect(rl.check(b, false).ok, "tenant B sin persongrense er uberørt (2 av 2 brukt av mutasjonen og denne)").toBe(true);
    expect(rl.check(b, false)).toMatchObject({ ok: false, scope: "person" });
  });

  it("fiks-runde 1: nøkkeltaket - 10 001 forskjellige enheter fyller begrenseren, den neste NYE enheten avvises (fail closed, `device`) til vinduet har gått; kjente enheter berøres ikke", () => {
    const c = clockAt();
    const rl = createDavRateLimit({ perDevicePerMinute: 5, perPersonPerMinute: 1_000_000 }, c.now);
    let allowed = 0;
    for (let i = 0; i < 10_001; i += 1) if (rl.check(who(`d-${i}`), false).ok) allowed += 1;
    expect(allowed).toBe(10_000);
    expect(rl.check(who("d-new"), false)).toMatchObject({ ok: false, scope: "device", retry_after_seconds: 60 });
    expect(rl.check(who("d-0"), false).ok, "en kjent enhet er upåvirket").toBe(true);
    c.advance(60_001);
    expect(rl.check(who("d-new"), false).ok).toBe(true);
  });

  it("fiks-runde 1: mot et uavhengig orakel (naiv glidende logg med atomisk avgjørelse) gir 4 000 tilfeldige forespørsler over flere enheter, personer og tenanter nøyaktig samme tillatt/avvist", () => {
    let seed = 0x9e3779b9;
    const rnd = (): number => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const limits = { perDevicePerMinute: 4, perPersonPerMinute: 6, mutationsPerPersonPerMinute: 2 };
    const c = clockAt();
    const rl = createDavRateLimit(limits, c.now);
    const log: Record<"device" | "person" | "mutation", Map<string, number[]>> = { device: new Map(), person: new Map(), mutation: new Map() };
    const recent = (scope: keyof typeof log, key: string): number[] => (log[scope].get(key) ?? []).filter((t) => t > c.now() - 60_000);
    let allowedCount = 0;
    let rejectedCount = 0;
    for (let step = 0; step < 4_000; step += 1) {
      c.advance(Math.floor(rnd() * 9_000));
      const tenant = rnd() < 0.8 ? "t-1" : "t-2";
      const person = `p-${Math.floor(rnd() * 2)}`;
      const device = `d-${Math.floor(rnd() * 3)}`;
      const isMutation = rnd() < 0.3;
      const dk = JSON.stringify([tenant, device]);
      const pk = JSON.stringify([tenant, person]);
      const blocked: string[] = [];
      if (recent("device", dk).length >= limits.perDevicePerMinute) blocked.push("device");
      if (recent("person", pk).length >= limits.perPersonPerMinute) blocked.push("person");
      if (isMutation && recent("mutation", pk).length >= limits.mutationsPerPersonPerMinute) blocked.push("mutation");
      const got = rl.check({ tenant_id: tenant, person_id: person, device_id: device }, isMutation);
      expect(got.ok, `steg ${step}`).toBe(blocked.length === 0);
      if (!got.ok) { expect(blocked, `steg ${step}`).toContain(got.scope); rejectedCount += 1; continue; }
      allowedCount += 1;
      for (const [scope, key] of [["device", dk], ["person", pk], ...(isMutation ? [["mutation", pk] as const] : [])] as const) log[scope].set(key, [...recent(scope, key), c.now()]);
    }
    expect(allowedCount).toBeGreaterThan(300);
    expect(rejectedCount).toBeGreaterThan(300); // sanity: begge utfall forekommer ofte
  });

  it("tenant og prinsipal er adskilt, og nøklene kan ikke kollidere via skilletegn i id-er", () => {
    const rl = createDavRateLimit({ perDevicePerMinute: 2, perPersonPerMinute: 1000 }, clockAt().now);
    fill(rl, { tenant_id: "a|b", person_id: "p", device_id: "c" }, 2);
    expect(rl.check({ tenant_id: "a|b", person_id: "p", device_id: "c" }, false).ok).toBe(false);
    expect(rl.check({ tenant_id: "a", person_id: "p", device_id: "b|c" }, false).ok).toBe(true); // ville kollidert med en naiv `a|b|c`-nøkkel
    expect(rl.check({ tenant_id: "a|b", person_id: "p", device_id: "c2" }, false).ok).toBe(true);
    expect(rl.check({ tenant_id: "t-annen", person_id: "p", device_id: "c" }, false).ok).toBe(true); // samme enhets-id i en annen tenant
    const rl2 = createDavRateLimit({ perPersonPerMinute: 2, perDevicePerMinute: 1000 }, clockAt().now);
    fill(rl2, { tenant_id: "a|b", person_id: "c", device_id: "d1" }, 2);
    expect(rl2.check({ tenant_id: "a", person_id: "b|c", device_id: "d2" }, false).ok).toBe(true);
  });

  it("konfigurerbar; ugyldige verdier (0, negative, brøker, NaN, Infinity, tekst) faller tilbake til standarden - aldri «ingen grense» og aldri «alt avvist»", () => {
    const rl = createDavRateLimit({ perDevicePerMinute: 2 }, clockAt().now);
    expect(fill(rl, who("d-1"), 2).every((r) => r.ok)).toBe(true);
    expect(rl.check(who("d-1"), false).ok).toBe(false);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10" as never, null as never]) {
      const r = createDavRateLimit({ perDevicePerMinute: bad, perPersonPerMinute: bad, mutationsPerPersonPerMinute: bad }, clockAt().now);
      expect(fill(r, who("d-1"), 30).every((x) => x.ok), String(bad)).toBe(true);
      expect(r.check(who("d-1"), false).ok, String(bad)).toBe(false);
    }
  });
});

interface Ctx { ctx: PersonalRouteContext; calls: string[]; responses: Array<{ status: number; body: Record<string, unknown> }>; headers: Array<[string, string]> }

/** Rute-kontekst rundt gitte DAV-avhengigheter (grant -> eier -> ...); `identity` kan overstyres per kall (flere enheter). */
function routeCtx(dav: PersonalDavDeps, path: string, body: Record<string, unknown> = {}, opts: { identity?: IdentityContext; owner?: boolean; stepUp?: string } = {}): Ctx {
  const calls: string[] = [];
  const responses: Ctx["responses"] = [];
  const headers: Ctx["headers"] = [];
  const ctx: PersonalRouteContext = {
    req: { method: "POST" } as never, res: { setHeader: (k: string, v: string) => { headers.push([k, v]); } } as never, url: new URL(path, "http://localhost"), deps: { dav },
    authed: async () => { calls.push("authed"); return { identity: opts.identity ?? owner, body }; },
    requireOwner: async () => { calls.push("requireOwner"); if (opts.owner === false) { responses.push({ status: 403, body: { error: "owner_required" } }); return false; } return true; },
    stepUpDenial: () => { calls.push("stepUp"); return opts.stepUp; },
    json: (status, b) => { responses.push({ status, body: b as Record<string, unknown> }); }, requestId: () => "req-1",
    fieldString: (b, k) => { const v = b[k]; if (typeof v !== "string" || v.length === 0) throw new DavError("invalid_input", k); return v; },
    fieldOptionalString: (b, k) => (typeof b[k] === "string" ? (b[k] as string) : undefined),
    fieldRecord: (b, k) => { const v = b[k]; if (typeof v !== "object" || v === null || Array.isArray(v)) throw new DavError("invalid_input", k); return v as Record<string, unknown>; },
    fieldOptionalNumber: (b, k) => (typeof b[k] === "number" ? (b[k] as number) : undefined),
    domainFailure: (status, code) => { responses.push({ status, body: { error: code, generic: true } }); }
  };
  return { ctx, calls, responses, headers };
}

function davDeps(over: { rateLimit?: DavRateLimit; guard?: PersonalDavDeps["guard"]; outcome?: string; fail?: unknown } = {}): { dav: PersonalDavDeps; clientCalls: string[]; audits: DavAuditEntry[]; guardCalls: number[] } {
  const clientCalls: string[] = [];
  const audits: DavAuditEntry[] = [];
  const guardCalls: number[] = [];
  const op = (name: string) => vi.fn(async () => { clientCalls.push(name); if (over.fail !== undefined) throw over.fail; return name === "list" ? [] : name === "get" ? null : { outcome: over.outcome ?? "SUCCESS", uid: "jarvis-1", etag: '"e"' }; });
  const dav: PersonalDavDeps = {
    client: { listCollections: () => [{ name: "privat", kind: "calendar" }], list: op("list"), get: op("get"), create: op("create"), update: op("update"), remove: op("remove") } as unknown as PersonalDavDeps["client"],
    audit: async (_i, entry) => { audits.push(entry); },
    guard: over.guard ?? (async () => { guardCalls.push(1); return null; }),
    rateLimit: over.rateLimit ?? createDavRateLimit()
  };
  return { dav, clientCalls, audits, guardCalls };
}

const LIST = { collection: "privat" };
const CREATE = { collection: "privat", idempotency_key: "idem-key-0001", fields: { summary: "x" } };

describe("C: ruten - step-up (mutasjoner), så 429 FØR stoppvakt, revisjon og klient (JARVIS-113 e/6, fiks-runde 1)", () => {
  it("over grensen: 429 `rate_limited` med scope og ventetid (også som `retry-after`), klienten nås ikke, ingen revisjonsrad, stoppvakten kalles ikke; før grensen er svaret som før", async () => {
    let t = 5_000_000;
    const d = davDeps({ rateLimit: createDavRateLimit({ perDevicePerMinute: 2 }, () => t) });
    for (let i = 0; i < 2; i++) {
      const ok = routeCtx(d.dav, "/personal/dav/list", LIST);
      await handlePersonalRoute(ok.ctx);
      expect(ok.responses[0]).toMatchObject({ status: 200, body: { items: [], content_trust: "untrusted_external_content" } });
    }
    expect(d.clientCalls).toEqual(["list", "list"]);
    expect(d.guardCalls).toHaveLength(2);
    const over = routeCtx(d.dav, "/personal/dav/list", LIST);
    expect(await handlePersonalRoute(over.ctx)).toBe(true);
    expect(over.responses).toEqual([{ status: 429, body: { error: "rate_limited", scope: "device", retry_after_seconds: 60, request_id: "req-1" } }]);
    expect(over.headers).toEqual([["retry-after", "60"]]);
    expect(d.clientCalls).toHaveLength(2); // klienten (og dermed iCloud) ble ikke nådd
    expect(d.guardCalls).toHaveLength(2); // stoppvakten heller ikke
    expect(d.audits).toEqual([]); // ingen rad per avvisning
    t += 61_000;
    const again = routeCtx(d.dav, "/personal/dav/list", LIST);
    await handlePersonalRoute(again.ctx);
    expect(again.responses[0]?.status).toBe(200);
  });

  it("rekkefølge: grant -> eier -> (mutasjon: step-up) -> grense -> ...; en ikke-eier og et step-up-avslag bruker ALDRI budsjett, og step-up-avslaget vinner over grensen (fiks-runde 1, LOW-3)", async () => {
    const calls: string[] = [];
    const rateLimit: DavRateLimit = { check: (_i, mutation) => { calls.push(`rateLimit:${mutation ? "mutation" : "read"}`); return { ok: true }; } };
    const d = davDeps({ rateLimit });
    const notOwner = routeCtx(d.dav, "/personal/dav/list", LIST, { owner: false });
    await handlePersonalRoute(notOwner.ctx);
    expect(notOwner.responses[0]?.status).toBe(403);
    expect(calls).toEqual([]); // grensen er ikke rørt
    const weak = routeCtx(d.dav, "/personal/dav/create", CREATE, { stepUp: "step_up_missing" });
    await handlePersonalRoute(weak.ctx);
    expect(weak.calls).toEqual(["authed", "requireOwner", "stepUp"]);
    expect(weak.responses[0]).toMatchObject({ status: 403, body: { error: "step_up_required" } });
    expect(calls, "step-up-avslaget nådde aldri grensen").toEqual([]);
    const signed = routeCtx(d.dav, "/personal/dav/create", CREATE);
    await handlePersonalRoute(signed.ctx);
    expect(signed.calls).toEqual(["authed", "requireOwner", "stepUp"]);
    expect(calls).toEqual(["rateLimit:mutation"]);
    const read = routeCtx(d.dav, "/personal/dav/list", LIST);
    await handlePersonalRoute(read.ctx);
    expect(read.calls, "lesing har ingen step-up").toEqual(["authed", "requireOwner"]);
    expect(calls).toEqual(["rateLimit:mutation", "rateLimit:read"]);
    // et step-up-avslag vinner over en grense som er nådd (avslaget er ikke en forespørsel som skulle telt)
    const blocked = davDeps({ rateLimit: { check: () => ({ ok: false, scope: "mutation", retry_after_seconds: 7 }) } });
    const weakOver = routeCtx(blocked.dav, "/personal/dav/create", CREATE, { stepUp: "step_up_missing" });
    await handlePersonalRoute(weakOver.ctx);
    expect(weakOver.responses[0]).toMatchObject({ status: 403, body: { error: "step_up_required" } });
    const signedOver = routeCtx(blocked.dav, "/personal/dav/create", CREATE);
    await handlePersonalRoute(signedOver.ctx);
    expect(signedOver.responses[0]).toMatchObject({ status: 429, body: { error: "rate_limited", scope: "mutation", retry_after_seconds: 7 } });
  });

  it("fiks-runde 1 (LOW-3, B DV3): 10 mutasjoner fra en SVAK økt (step-up avslått, 403) bruker ikke mutasjonsbudsjettet - eierens signerte opprettelse etterpå går gjennom; og 50 avviste mutasjoner tømmer ikke personbudsjettet for lesing", async () => {
    const d = davDeps({ rateLimit: createDavRateLimit({}, () => 1) });
    for (let i = 0; i < 60; i += 1) {
      const weak = routeCtx(d.dav, "/personal/dav/create", CREATE, { stepUp: "step_up_missing" });
      await handlePersonalRoute(weak.ctx);
      expect(weak.responses[0]?.status).toBe(403);
    }
    const signed = routeCtx(d.dav, "/personal/dav/create", CREATE);
    await handlePersonalRoute(signed.ctx);
    expect(signed.responses[0]?.status, "den signerte opprettelsen er ikke sultet av de svake").toBe(200);
    expect(d.clientCalls).toEqual(["create"]);
    // og 10 godkjente + 50 avviste (429 mutation) tømmer ikke lese-budsjettet
    for (let i = 0; i < 9; i += 1) await handlePersonalRoute(routeCtx(d.dav, "/personal/dav/create", CREATE).ctx);
    for (let i = 0; i < 50; i += 1) {
      const over = routeCtx(d.dav, "/personal/dav/create", CREATE);
      await handlePersonalRoute(over.ctx);
      expect(over.responses[0]).toMatchObject({ status: 429, body: { scope: "mutation" } });
    }
    for (let i = 0; i < 20; i += 1) {
      const read = routeCtx(d.dav, "/personal/dav/list", LIST);
      await handlePersonalRoute(read.ctx);
      expect(read.responses[0]?.status, `lesing ${i + 1}`).toBe(200);
    }
  });

  it("`collections` er lokal og unntatt: 200 kall går gjennom uten å røre grensen", async () => {
    const rateLimit = { check: vi.fn(() => ({ ok: false, scope: "device", retry_after_seconds: 1 }) as const) };
    const d = davDeps({ rateLimit });
    for (let i = 0; i < 200; i++) {
      const h = routeCtx(d.dav, "/personal/dav/collections");
      await handlePersonalRoute(h.ctx);
      expect(h.responses[0]?.status).toBe(200);
    }
    expect(rateLimit.check).not.toHaveBeenCalled();
  });

  it("mutasjonsgrensen: den andre opprettelsen avvises (scope `mutation`) uten `requested`-rad og uten klientkall, mens lesing fortsatt går", async () => {
    const d = davDeps({ rateLimit: createDavRateLimit({ mutationsPerPersonPerMinute: 1 }, () => 1) });
    const first = routeCtx(d.dav, "/personal/dav/create", CREATE);
    await handlePersonalRoute(first.ctx);
    expect(first.responses[0]?.status).toBe(200);
    expect(d.audits.map((a) => a.outcome)).toEqual(["requested", "SUCCESS"]);
    const second = routeCtx(d.dav, "/personal/dav/create", CREATE);
    await handlePersonalRoute(second.ctx);
    expect(second.responses[0]).toMatchObject({ status: 429, body: { error: "rate_limited", scope: "mutation" } });
    expect(d.clientCalls).toEqual(["create"]);
    expect(d.audits.map((a) => a.outcome)).toEqual(["requested", "SUCCESS"]); // ingen ny rad
    const read = routeCtx(d.dav, "/personal/dav/list", LIST);
    await handlePersonalRoute(read.ctx);
    expect(read.responses[0]?.status).toBe(200);
  });

  it("flere enheter hos samme person deler personbudsjettet på rutenivå, og 429-svaret avslører ingen id-er eller nøkler", async () => {
    const d = davDeps({ rateLimit: createDavRateLimit({ perPersonPerMinute: 2, perDevicePerMinute: 10 }, () => 1) });
    const devices = ["d-a", "d-b", "d-c"];
    const out: number[] = [];
    let last: Ctx | undefined;
    for (const device of devices) {
      last = routeCtx(d.dav, "/personal/dav/list", LIST, { identity: { ...owner, device_id: device } });
      await handlePersonalRoute(last.ctx);
      out.push(last.responses[0]?.status ?? 0);
    }
    expect(out).toEqual([200, 200, 429]);
    const text = JSON.stringify(last?.responses[0]);
    for (const secret of [owner.tenant_id, owner.person_id, "d-c", "d-a"]) expect(text).not.toContain(secret);
  });

  it("50 avviste mutasjoner skriver ingen revisjonsrader (en flom kan ikke fylle sporet) og når aldri klienten", async () => {
    const d = davDeps({ rateLimit: createDavRateLimit({ mutationsPerPersonPerMinute: 1 }, () => 1) });
    for (let i = 0; i < 51; i++) await handlePersonalRoute(routeCtx(d.dav, "/personal/dav/create", CREATE).ctx);
    expect(d.clientCalls).toEqual(["create"]);
    expect(d.audits.map((a) => a.outcome)).toEqual(["requested", "SUCCESS"]); // kun den ene tillatte mutasjonen er revidert
  });

  it("en grense som mangler (kaller uten typesjekk) eller kaster er fail closed: 503 `dav_guard_unavailable` + ÉN DENY-rad, aldri en klient uten grense", async () => {
    for (const make of [() => undefined, () => ({ check: () => { throw new Error("intern feil"); } }), () => ({ check: () => undefined })] as Array<() => unknown>) {
      const d = davDeps();
      (d.dav as unknown as { rateLimit: unknown }).rateLimit = make();
      const h = routeCtx(d.dav, "/personal/dav/delete", { collection: "privat", uid: "abcdef-1", expected_etag: '"e1"', confirm_uid: "abcdef-1" });
      await handlePersonalRoute(h.ctx);
      expect(h.responses).toEqual([{ status: 503, body: { error: "dav_blocked", reason: "dav_guard_unavailable", request_id: "req-1" } }]);
      expect(d.clientCalls).toEqual([]);
      expect(d.audits).toEqual([{ action: "delete", collection: "privat", outcome: "blocked", decision: "DENY", reason: "dav_guard_unavailable" }]);
    }
  });

  it("grensen er PÅKREVD i typen: `@ts-expect-error` feiler typesjekken hvis den blir valgfri igjen", () => {
    // @ts-expect-error `rateLimit` er påkrevd i PersonalDavDeps: en wiring som glemmer den kompilerer ikke
    const forgotten: PersonalDavDeps = { client: {} as never, audit: async () => undefined, guard: async () => null };
    expect(forgotten.rateLimit).toBeUndefined();
  });
});

describe("D: wiring - standardgrenser og `decision` per utfall skrevet til revisjonen (JARVIS-113 e/6-7)", () => {
  const env = { JARVIS_PERSONAL_APPLE_DAV: "on", JARVIS_PERSONAL_APPLE_DAV_ACCOUNTS: `calendar:privat=${CAL}` };
  const openControls = { killSwitch: { isActiveDurable: async () => false }, ownerControls: { isRevokedDurable: async () => false } };

  function wired(extra: { davRateLimits?: Parameters<typeof createPersonalWiring>[0]["davRateLimits"] } = {}) {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = { query: vi.fn(async (text: string, values: unknown[] = []) => { queries.push({ text, values }); return { rows: [], rowCount: 0 }; }), release: vi.fn() };
    const w = createPersonalWiring({ pool: { connect: async () => client } as never, gateway: {} as never, controls: openControls, readSecret: async () => "fake-secret", env, ...(extra.davRateLimits !== undefined ? { davRateLimits: extra.davRateLimits } : {}) });
    const inserts = () => queries.filter((q) => q.text.includes("INSERT INTO audit_events"));
    const payloadOf = (q: { values: unknown[] }) => JSON.parse(q.values.find((v) => typeof v === "string" && v.startsWith("{")) as string) as Record<string, unknown>;
    return { w, dav: w.deps!.dav!, inserts, payloadOf };
  }

  it("wiringen gir DAV en grense med standardverdiene (31. lesing fra samme enhet avvises) og `davRateLimits` overstyrer; ugyldig overstyring faller tilbake", () => {
    const a = wired().dav.rateLimit;
    const ids = { tenant_id: "t", person_id: "p", device_id: "d" };
    expect(Array.from({ length: 30 }, () => a.check(ids, false)).every((r) => r.ok)).toBe(true);
    expect(a.check(ids, false)).toMatchObject({ ok: false, scope: "device" });
    const b = wired({ davRateLimits: { perDevicePerMinute: 1 } }).dav.rateLimit;
    expect(b.check(ids, false).ok).toBe(true);
    expect(b.check(ids, false).ok).toBe(false);
    const c = wired({ davRateLimits: { perDevicePerMinute: 0 } }).dav.rateLimit;
    expect(Array.from({ length: 30 }, () => c.check(ids, false)).every((r) => r.ok)).toBe(true);
  });

  it("revisjonens `decision` per utfall: requested/SUCCESS/REPLAYED = ALLOW; MISMATCH, UNKNOWN og rejected:* er IKKE ALLOW; DENY = `tool.denied`; typen, årsaken og innholdet (kun samling/UID/utfall/kanal) er som før", async () => {
    const { dav, inserts, payloadOf } = wired();
    const rows: Array<{ entry: DavAuditEntry; type: string; decision: string }> = [
      { entry: { action: "create", collection: "privat", outcome: "requested" }, type: "dav.mutation", decision: "ALLOW" },
      { entry: { action: "create", collection: "privat", uid: "jarvis-1", outcome: "SUCCESS" }, type: "dav.mutation", decision: "ALLOW" },
      { entry: { action: "create", collection: "privat", uid: "jarvis-1", outcome: "REPLAYED" }, type: "dav.mutation", decision: "ALLOW" },
      { entry: { action: "update", collection: "privat", uid: "jarvis-1", outcome: "MISMATCH" }, type: "dav.mutation", decision: "MISMATCH" },
      { entry: { action: "update", collection: "privat", uid: "jarvis-1", outcome: "UNKNOWN" }, type: "dav.mutation", decision: "UNKNOWN" },
      { entry: { action: "delete", collection: "privat", uid: "jarvis-1", outcome: "rejected:etag_mismatch" }, type: "dav.mutation", decision: "REJECTED" },
      { entry: { action: "delete", collection: "privat", uid: "jarvis-1", outcome: "ok" }, type: "dav.mutation", decision: "UNKNOWN" },
      { entry: { action: "update", collection: "privat", outcome: "blocked", decision: "DENY", reason: "kill_switch_active" }, type: "tool.denied", decision: "DENY" }
    ];
    for (const { entry } of rows) await dav.audit(owner, entry);
    const written = inserts();
    expect(written).toHaveLength(rows.length);
    rows.forEach(({ entry, type, decision }, i) => {
      const values = written[i]!.values;
      expect(values, entry.outcome).toEqual(expect.arrayContaining(["t-owner", "p-owner", type, decision, "apple_dav", entry.action]));
      expect(values, entry.outcome).not.toContain(decision === "ALLOW" ? "DENY" : "ALLOW"); // aldri ALLOW for et utfall som ikke er bekreftet
      expect(payloadOf(written[i]!), entry.outcome).toEqual({ collection: "privat", ...(entry.uid !== undefined ? { uid: entry.uid } : {}), outcome: entry.outcome, channel: "web" });
    });
    expect(written[7]!.values).toContain("kill_switch_active");
  });

  it("ende-til-ende: rute + wiring - en mutasjon med avvikende readback, et uavklart utfall og en avvisning gir `requested`=ALLOW og deretter MISMATCH/UNKNOWN/REJECTED i revisjonen", async () => {
    for (const [outcomeOrError, expected] of [[{ outcome: "MISMATCH" }, "MISMATCH"], [{ outcome: "UNKNOWN" }, "UNKNOWN"], [{ outcome: "SUCCESS" }, "ALLOW"], [new DavError("etag_mismatch"), "REJECTED"]] as const) {
      const { dav, inserts } = wired();
      const stub = vi.fn(async () => { if (outcomeOrError instanceof Error) throw outcomeOrError; return { ...outcomeOrError, uid: "abcdef-1", etag: '"e"' }; });
      const live: PersonalDavDeps = { ...dav, client: { ...dav.client, update: stub } as unknown as PersonalDavDeps["client"] };
      const h = routeCtx(live, "/personal/dav/update", { collection: "privat", uid: "abcdef-1", expected_etag: '"e1"', fields: { summary: "y" } });
      await handlePersonalRoute(h.ctx);
      const decisions = inserts().map((q) => q.values.find((v) => ["ALLOW", "DENY", "MISMATCH", "UNKNOWN", "REJECTED"].includes(v as string)));
      expect(decisions, JSON.stringify(outcomeOrError)).toEqual(["ALLOW", expected]);
    }
  });
});
