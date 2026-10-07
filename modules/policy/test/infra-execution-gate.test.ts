import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, PolicyGateway } from "../src/index.ts";

/**
 * D-104 (UA-5 Production Operations Control Plane v1): `InfraExecutionGate`
 * er en NY, SNEVRERE bryter enn `KillSwitch` (uendret, forblir strengest -
 * blokkerer ALT). Testene under beviser (1) den rene gate-logikken isolert,
 * OG (2) at gaten FAKTISK håndheves gjennom `PolicyGateway.authorize()` -
 * IKKE bare at klassen finnes, men at et reelt policy-kall faktisk blokkeres/
 * slipper gjennom identisk med `check()`s kontrakt. §9/§13 i byggeordren:
 * "no silent bypass through direct adapter invocation" - siden ALLE
 * ToolGateway-kall MÅ gjennom `policy.authorize()` (ingen unntak i
 * gateway.ts), er DENNE testen beviset for at det ikke finnes en vei rundt.
 */

const identity: IdentityContext = {
  person_id: "person-x", tenant_id: "tenant-x", memory_space_id: "business",
  session_id: "sess-1", device_id: "dev-1", channel: "api", auth_strength: "active"
};

function githubToolCall(capability_class: "A" | "B" | "C" | "D") {
  return { tool_id: "github", action: "whatever", capability_class, parameters: {} };
}

describe("D-104: InfraExecutionGate - ren logikk", () => {
  it("A: NORMAL (default) blokkerer ingenting", () => {
    const gate = new InfraExecutionGate();
    expect(gate.current().mode).toBe("NORMAL");
    for (const c of ["A", "B", "C", "D"] as const) expect(gate.check(c)).toBeNull();
  });

  it("B: PAUSED blokkerer B/C/D, ALDRI A (diagnostikk/lesing forblir alltid tilgjengelig)", () => {
    const gate = new InfraExecutionGate();
    gate.pause("owner_requested");
    expect(gate.check("A")).toBeNull();
    expect(gate.check("B")).toBe("infra_paused");
    expect(gate.check("C")).toBe("infra_paused");
    expect(gate.check("D")).toBe("infra_paused");
  });

  it("C: DEGRADED blokkerer KUN klasse D - B/C fortsetter, A uendret", () => {
    const gate = new InfraExecutionGate();
    gate.degrade("partial_outage");
    expect(gate.check("A")).toBeNull();
    expect(gate.check("B")).toBeNull();
    expect(gate.check("C")).toBeNull();
    expect(gate.check("D")).toBe("infra_degraded_blocks_class_d");
  });

  it("D: resume() går tilbake til NORMAL fra BÅDE PAUSED og DEGRADED", () => {
    const gate = new InfraExecutionGate();
    gate.pause("x");
    gate.resume();
    expect(gate.current().mode).toBe("NORMAL");
    gate.degrade("y");
    gate.resume();
    expect(gate.current().mode).toBe("NORMAL");
  });

  it("E: current() eksponerer reason/at for pause/degrade, ikke for resume", () => {
    const gate = new InfraExecutionGate();
    gate.pause("planned maintenance");
    expect(gate.current().reason).toBe("planned maintenance");
    expect(gate.current().at).toBeTruthy();
    gate.resume();
    expect(gate.current().reason).toBeUndefined();
  });
});

describe("D-104: InfraExecutionGate faktisk håndhevet i PolicyGateway.authorize()", () => {
  function buildPolicy(infraGate?: InfraExecutionGate, infraToolIds?: ReadonlySet<string>) {
    return new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      ...(infraGate !== undefined ? { infraGate } : {}), ...(infraToolIds !== undefined ? { infraToolIds } : {})
    });
  }

  it("F: uten infraGate/infraToolIds konfigurert er oppførselen 100% uendret (bakoverkompatibelt)", async () => {
    const policy = buildPolicy();
    const decision = await policy.authorize({ identity, toolCall: githubToolCall("B") });
    expect(decision.decision).toBe("ALLOW");
  });

  it("G: PAUSED blokkerer et EKTE class-B github-kall gjennom policy.authorize()", async () => {
    const gate = new InfraExecutionGate();
    gate.pause("incident response");
    const policy = buildPolicy(gate, new Set(["github"]));
    const decision = await policy.authorize({ identity, toolCall: githubToolCall("B") });
    expect(decision.decision).toBe("DENY");
    expect(decision.reason).toBe("infra_paused");
  });

  it("H: PAUSED tillater FORTSATT et class-A github-kall (diagnostikk aldri stanset)", async () => {
    const gate = new InfraExecutionGate();
    gate.pause("incident response");
    const policy = buildPolicy(gate, new Set(["github"]));
    const decision = await policy.authorize({ identity, toolCall: githubToolCall("A") });
    expect(decision.decision).toBe("ALLOW");
  });

  it("I: PAUSED påvirker IKKE et tool_id UTENFOR infraToolIds (kun registrerte infra-verktøy gates)", async () => {
    const gate = new InfraExecutionGate();
    gate.pause("incident response");
    const policy = buildPolicy(gate, new Set(["github"]));
    const decision = await policy.authorize({
      identity, toolCall: { tool_id: "email", action: "send", capability_class: "B", parameters: {} }
    });
    expect(decision.decision).toBe("ALLOW");
  });

  it("J: DEGRADED blokkerer KUN et class-D github-kall gjennom policy.authorize(), class-B slipper gjennom", async () => {
    const gate = new InfraExecutionGate();
    gate.degrade("partial_outage");
    const policy = buildPolicy(gate, new Set(["github"]));
    const b = await policy.authorize({ identity, toolCall: githubToolCall("B") });
    expect(b.decision).toBe("ALLOW");
    const d = await policy.authorize({ identity, toolCall: githubToolCall("D") });
    expect(d.decision).toBe("DENY");
    expect(d.reason).toBe("infra_degraded_blocks_class_d");
  });

  it("K: KillSwitch forblir STRENGERE enn InfraExecutionGate - aktiv kill switch blokkerer selv når infraGate er NORMAL, OG blokkerer klasse A (i motsetning til infraGate)", async () => {
    const killSwitch = new KillSwitch();
    const gate = new InfraExecutionGate(); // NORMAL - ville IKKE blokkert alene
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, infraGate: gate, infraToolIds: new Set(["github"])
    });
    killSwitch.activate("emergency");
    const decision = await policy.authorize({ identity, toolCall: githubToolCall("A") });
    expect(decision.decision).toBe("DENY");
    expect(decision.reason).toBe("kill_switch_active");
  });

  it("L: ingen bypass via et ANNET registrert infra-tool_id (f.eks. et fremtidig 'vercel') - PAUSED gjelder ALLE infraToolIds-medlemmer identisk", async () => {
    const gate = new InfraExecutionGate();
    gate.pause("x");
    const policy = buildPolicy(gate, new Set(["github", "vercel"]));
    const decision = await policy.authorize({
      identity, toolCall: { tool_id: "vercel", action: "deploy", capability_class: "C", parameters: {} }
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.reason).toBe("infra_paused");
  });

  it("M: direkte gate.check()-kall og et EKTE policy.authorize()-kall gir IDENTISK resultat for samme (mode, capability_class) - ingen skjult avvik mellom de to lagene (SOVEREIGN-identitet brukt slik at KUN infraGate avgjør class C/D-utfallet, aldri mandat-/approval-logikken)", async () => {
    const gate = new InfraExecutionGate();
    gate.degrade("x");
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      infraGate: gate, infraToolIds: new Set(["github"]),
      authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
    });
    for (const c of ["A", "B", "C", "D"] as const) {
      const direct = gate.check(c);
      const viaPolicy = await policy.authorize({ identity, toolCall: githubToolCall(c) });
      if (direct === null) expect(viaPolicy.decision).toBe("ALLOW");
      else {
        expect(viaPolicy.decision).toBe("DENY");
        expect(viaPolicy.reason).toBe(direct);
      }
    }
  });
});

describe("D-438: delt modus, live-lesing (uten DB - fake lagring)", () => {
  type Stored = { mode: "PAUSED" | "DEGRADED"; reason?: string; at: string };
  function fakeStore() {
    let row: Stored | null = null;
    const flags = { failWrite: false, failRead: false, reads: 0 };
    return {
      flags,
      get row() { return row; },
      set row(v: Stored | null) { row = v; },
      store: {
        async read() { flags.reads++; if (flags.failRead) throw new Error("db_down"); return row; },
        async write(state: Stored) { if (flags.failWrite) throw new Error("db_down"); row = state; },
        async clear() { if (flags.failWrite) throw new Error("db_down"); row = null; }
      }
    };
  }
  const OWNER = { owner_person_id: "owner-1" };

  it("en pause i prosess A gjelder UMIDDELBART i prosess B (ingen synk/cache), og resume likeså", async () => {
    const f = fakeStore();
    const a = new InfraExecutionGate(undefined, f.store, OWNER);
    const b = new InfraExecutionGate(undefined, f.store, OWNER);
    expect(await b.checkDurable("B")).toBeNull();
    await a.pauseDurable("vedlikehold", "owner-1");
    expect(await b.checkDurable("B")).toBe("infra_paused");
    expect(await b.checkDurable("A")).toBeNull();
    await a.degradeDurable("treg", "owner-1");
    expect(await b.checkDurable("B")).toBeNull();
    expect(await b.checkDurable("D")).toBe("infra_degraded_blocks_class_d");
    await a.resumeDurable("owner-1");
    expect(await b.checkDurable("B")).toBeNull();
  });

  it("klasse A leser ikke databasen i det hele tatt (diagnostikk er aldri avhengig av den)", async () => {
    const f = fakeStore();
    const gate = new InfraExecutionGate(undefined, f.store, OWNER);
    f.flags.failRead = true;
    expect(await gate.checkDurable("A")).toBeNull();
    expect(f.flags.reads).toBe(0);
  });

  it("lesefeil avslår mutasjon (fail-closed: infra_mode_unavailable), aldri en antatt NORMAL", async () => {
    const f = fakeStore();
    const gate = new InfraExecutionGate(undefined, f.store, OWNER);
    f.flags.failRead = true;
    for (const c of ["B", "C", "D"] as const) expect(await gate.checkDurable(c), c).toBe("infra_mode_unavailable");
    const status = await gate.statusDurable();
    expect(status.shared_readable).toBe(false);
    f.flags.failRead = false;
    expect(await gate.checkDurable("B")).toBeNull();
  });

  it("en pause som IKKE fikk lagret er likevel i kraft i denne prosessen (strengeste-av), og et senere 'ingen rad' løser den aldri", async () => {
    const f = fakeStore();
    const api = new InfraExecutionGate(undefined, f.store, OWNER);
    const worker = new InfraExecutionGate(undefined, f.store, OWNER);
    f.flags.failWrite = true;
    await expect(api.pauseDurable("x", "owner-1")).rejects.toThrow("db_down");
    f.flags.failWrite = false;
    expect(f.row).toBeNull(); // den delte modusen er IKKE endret - kalleren fikk feilen
    expect(await api.checkDurable("B")).toBe("infra_paused"); // ... men API-prosessen er stanset
    expect(await worker.checkDurable("B")).toBeNull(); // workeren er ikke det (ærlig: skrivefeilen ble rapportert)
    expect((await api.statusDurable()).state.mode).toBe("PAUSED");
  });

  it("resume: feiler tømmingen, forblir modusen innstrammet (lokalt og delt)", async () => {
    const f = fakeStore();
    const gate = new InfraExecutionGate(undefined, f.store, OWNER);
    await gate.pauseDurable("x", "owner-1");
    f.flags.failWrite = true;
    await expect(gate.resumeDurable("owner-1")).rejects.toThrow("db_down");
    f.flags.failWrite = false;
    expect(await gate.checkDurable("B")).toBe("infra_paused");
    await gate.resumeDurable("owner-1");
    expect(await gate.checkDurable("B")).toBeNull();
  });

  it("strengeste-av: delt PAUSED vinner over lokal NORMAL, og delt DEGRADED slår ikke ned en lokal PAUSED", async () => {
    const f = fakeStore();
    const gate = new InfraExecutionGate(undefined, f.store, OWNER);
    f.row = { mode: "PAUSED", reason: "annen prosess", at: "2026-10-07T00:00:00Z" };
    expect(await gate.checkDurable("B")).toBe("infra_paused");
    f.row = { mode: "DEGRADED", at: "2026-10-07T00:00:00Z" };
    gate.pause("lokal");
    expect(await gate.checkDurable("B")).toBe("infra_paused");
  });

  it("varige overganger krever eieren når lagring er aktiv (samme fail-closed-regel som KillSwitch); uten lagring er det ikke nødvendig", async () => {
    const f = fakeStore();
    const gate = new InfraExecutionGate(undefined, f.store, OWNER);
    await expect(gate.pauseDurable("x", "andre")).rejects.toThrow(/owner_control_unauthorized/);
    await expect(gate.degradeDurable("x")).rejects.toThrow(/owner_control_unauthorized/);
    await expect(gate.resumeDurable("andre")).rejects.toThrow(/owner_control_unauthorized/);
    expect(f.row).toBeNull();
    expect(gate.current().mode).toBe("NORMAL");
    const noAuthority = new InfraExecutionGate(undefined, f.store);
    await expect(noAuthority.pauseDurable("x", "owner-1")).rejects.toThrow(/owner_control_unauthorized/);
    const local = new InfraExecutionGate();
    await local.pauseDurable("x");
    expect(local.check("B")).toBe("infra_paused");
  });

  it("degrade FRA pause er en løsning: lagres FØRST, og feiler lagringen forblir modusen PAUSED (ingen løsning ledsaget av en feilmelding)", async () => {
    const f = fakeStore();
    const gate = new InfraExecutionGate(undefined, f.store, OWNER);
    await gate.pauseDurable("x", "owner-1");
    f.flags.failWrite = true;
    await expect(gate.degradeDurable("y", "owner-1")).rejects.toThrow("db_down");
    expect(gate.current().mode).toBe("PAUSED");
    expect(await gate.checkDurable("B")).toBe("infra_paused");
    f.flags.failWrite = false;
    await gate.degradeDurable("y", "owner-1");
    expect(gate.current().mode).toBe("DEGRADED");
    expect(f.row?.mode).toBe("DEGRADED");
  });

  it("degrade når den DELTE modusen er PAUSED (satt av en annen prosess) er også en løsning; og når den delte modusen ikke kan leses antas det verste", async () => {
    const f = fakeStore();
    const gate = new InfraExecutionGate(undefined, f.store, OWNER);
    f.row = { mode: "PAUSED", at: "2026-10-07T00:00:00Z" };
    f.flags.failWrite = true;
    await expect(gate.degradeDurable("y", "owner-1")).rejects.toThrow("db_down");
    expect(gate.current().mode).toBe("NORMAL"); // lokalt ikke endret; delt PAUSED gjelder fortsatt
    expect(await gate.checkDurable("B")).toBe("infra_paused");
    f.flags.failWrite = false;
    f.row = null;
    f.flags.failRead = true;
    f.flags.failWrite = true;
    await expect(gate.degradeDurable("z", "owner-1")).rejects.toThrow("db_down");
    expect(gate.current().mode).toBe("NORMAL"); // kunne ikke se delt tilstand -> lagre først -> feilet -> uendret
  });

  it("degrade fra NORMAL er en innstramming: settes lokalt først og består selv om lagringen feiler", async () => {
    const f = fakeStore();
    const gate = new InfraExecutionGate(undefined, f.store, OWNER);
    f.flags.failWrite = true;
    await expect(gate.degradeDurable("y", "owner-1")).rejects.toThrow("db_down");
    expect(gate.current().mode).toBe("DEGRADED");
    expect(await gate.checkDurable("D")).toBe("infra_degraded_blocks_class_d");
  });

  it("statusDurable skiller lokal og delt modus: en pause som aldri nådde delt lagring er IKKE 'in_sync' (workeren er ikke stanset)", async () => {
    const f = fakeStore();
    const api = new InfraExecutionGate(undefined, f.store, OWNER);
    f.flags.failWrite = true;
    await expect(api.pauseDurable("x", "owner-1")).rejects.toThrow("db_down");
    f.flags.failWrite = false;
    const s = await api.statusDurable();
    expect(s).toMatchObject({ state: { mode: "PAUSED" }, local: { mode: "PAUSED" }, shared: null, shared_readable: true, in_sync: false });
    await api.pauseDurable("x", "owner-1");
    expect(await api.statusDurable()).toMatchObject({ shared: { mode: "PAUSED" }, in_sync: true });
    f.flags.failRead = true;
    expect(await api.statusDurable()).toMatchObject({ shared_readable: false, in_sync: false });
  });

  it("PolicyGateway håndhever den delte modusen LIVE (ikke en cache): en pause i en annen prosess avslår neste kall", async () => {
    const f = fakeStore();
    const gate = new InfraExecutionGate(undefined, f.store, OWNER);
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), infraGate: gate, infraToolIds: new Set(["github"])
    });
    const call = () => policy.authorize({ identity, toolCall: githubToolCall("B") });
    expect((await call()).decision).toBe("ALLOW");
    f.row = { mode: "PAUSED", reason: "satt av API-prosessen", at: "2026-10-07T00:00:00Z" };
    const denied = await call();
    expect(denied.decision).toBe("DENY");
    expect(denied.reason).toBe("infra_paused");
    f.flags.failRead = true;
    expect((await call()).reason).toBe("infra_mode_unavailable");
  });
});
