import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway, type AuthorizationRequest, type PolicyAuditEvent } from "@jarvis/policy";

/**
 * WP-K (D-471, JARVIS-053/054): hver policy-avgjørelse har en unik ID (stemmer med revisjonsraden den førte til), bærer kalleren sin oppgave-/spor-ID, og en feilende/full/treg revisjons-sink
 * kan ALDRI endre avgjørelsen - den telles og vises i `auditStats()`.
 */
const identity = {
  person_id: "person-tobias", tenant_id: "tenant-personal", memory_space_id: "personal", session_id: "sess-1",
  device_id: "dev-pc-1", channel: "web", auth_strength: "active"
} as const;
const read = (extra: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  identity, toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: { q: "fake-secret-value-for-test" } }, ...extra
});

afterEach(() => vi.restoreAllMocks());

function gateway(options: Partial<ConstructorParameters<typeof PolicyGateway>[0]> = {}): { policy: PolicyGateway; killSwitch: KillSwitch } {
  const killSwitch = new KillSwitch();
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, ...options });
  return { policy, killSwitch };
}

describe("A: avgjørelses-ID og korrelasjon", () => {
  it("hver avgjørelse får en unik ID, i resultatet OG i hendelsen (samme verdi)", async () => {
    const { policy } = gateway();
    const a = await policy.authorize(read());
    const b = await policy.authorize(read());
    expect(a.decision_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.decision_id).not.toBe(a.decision_id);
    expect(policy.auditLog.map((e) => e.decision_id)).toEqual([a.decision_id, b.decision_id]);
  });

  it("avslag (kill switch, ugyldig identitet) får også ID, og avgjørelsens innhold er uendret av korrelasjonen", async () => {
    const { policy, killSwitch } = gateway();
    killSwitch.activate("test");
    const denied = await policy.authorize(read({ correlation: { task_id: "task-1", trace_id: "trace-1" } }));
    expect(denied).toMatchObject({ decision: "DENY", reason: "kill_switch_active" });
    expect(denied.decision_id).toBeDefined();
    const invalid = await policy.authorize({ ...read(), identity: { ...identity, person_id: "" } });
    expect(invalid).toMatchObject({ decision: "DENY", reason: "invalid_identity_context" });
    expect(invalid.decision_id).toBeDefined();
    expect(policy.auditLog.at(-1)).toMatchObject({ decision_id: invalid.decision_id, decision: "DENY", reason: "invalid_identity_context" });
  });

  it("task_id/trace_id fra kalleren havner i hendelsen; uten korrelasjon (eller med tomme strenger) er feltene fraværende", async () => {
    const { policy } = gateway();
    await policy.authorize(read({ correlation: { task_id: "sched:business-events-sync:2026-11-14", trace_id: "sched-business-events-sync-2026-11-14-a1" } }));
    await policy.authorize(read());
    await policy.authorize(read({ correlation: { task_id: "", trace_id: "" } }));
    const [withCorr, without, empty] = policy.auditLog as [PolicyAuditEvent, PolicyAuditEvent, PolicyAuditEvent];
    expect(withCorr.task_id).toBe("sched:business-events-sync:2026-11-14");
    expect(withCorr.trace_id).toBe("sched-business-events-sync-2026-11-14-a1");
    expect("task_id" in without).toBe(false);
    expect("trace_id" in without).toBe(false);
    expect("task_id" in empty).toBe(false);
  });

  it("korrelasjonen er IKKE autoritet: ingen avgjørelse leser den (samme resultat med og uten)", async () => {
    const { policy } = gateway();
    const plain = await policy.authorize(read());
    const corr = await policy.authorize(read({ correlation: { task_id: "task-eier", trace_id: "t" } }));
    expect({ decision: corr.decision, reason: corr.reason }).toEqual({ decision: plain.decision, reason: plain.reason });
  });

  it("hendelsen inneholder aldri parametre eller godkjenningsinnhold - kun metadata", async () => {
    const { policy } = gateway();
    await policy.authorize(read({ approval: { signature: "fake-signature-for-test" } }));
    const text = JSON.stringify(policy.auditLog);
    expect(text).not.toContain("fake-secret-value-for-test");
    expect(text).not.toContain("fake-signature-for-test");
    expect(Object.keys(policy.auditLog[0]!).sort()).toEqual(["action", "at", "capability_class", "decision", "decision_id", "person_id", "reason", "session_id", "tenant_id", "tool_id"]);
  });

  it("ID-fabrikken kan injiseres (deterministiske tester)", async () => {
    let n = 0;
    const { policy } = gateway({ newDecisionId: () => `d-${++n}` });
    expect((await policy.authorize(read())).decision_id).toBe("d-1");
    expect((await policy.authorize(read())).decision_id).toBe("d-2");
  });
});

describe("B: en revisjons-sink kan aldri endre en avgjørelse (JARVIS-053)", () => {
  it("en sink som KASTER: avgjørelsen er uendret (ALLOW og DENY), feilen telles og logges strupet - uten hendelsesinnhold og uten fri feiltekst", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { policy, killSwitch } = gateway({ auditSink: () => { throw new Error("password authentication failed for user x: fake-secret-value-for-test"); } });
    const allow = await policy.authorize(read());
    expect(allow).toMatchObject({ decision: "ALLOW", reason: "class_a_read" });
    killSwitch.activate("test");
    const deny = await policy.authorize(read());
    expect(deny).toMatchObject({ decision: "DENY", reason: "kill_switch_active" });
    const stats = policy.auditStats();
    expect(stats).toMatchObject({ sink: "external", sink_failures: 2, sink_rejected: 0, last_failure: "Error" });
    // høyst én loggline per minutt (en død sink fyller ikke loggen); fri feiltekst (kan sitere data) vises aldri
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0]![0]);
    expect(line).toContain("policy_audit_sink_failed");
    expect(line).not.toContain("fake-secret-value-for-test");
    expect(line).not.toContain("password");
  });

  it("en sink-feil med maskinkode (eller pg-SQLSTATE) vises som kode, aldri som fri tekst", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const coded = gateway({ auditSink: () => { throw new Error("policy_audit_queue_full"); } }).policy;
    await coded.authorize(read());
    expect(coded.auditStats().last_failure).toBe("policy_audit_queue_full");
    const pgLike = gateway({ auditSink: () => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }); } }).policy;
    await pgLike.authorize(read());
    expect(pgLike.auditStats().last_failure).toBe("Error:ECONNREFUSED");
  });

  it("en sink som returnerer et AVVIST løfte telles uten ubehandlet avvisning og uten å endre avgjørelsen", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { policy } = gateway({ auditSink: () => Promise.reject(new Error("kø full")) });
    const result = await policy.authorize(read());
    expect(result).toMatchObject({ decision: "ALLOW" });
    await vi.waitFor(() => expect(policy.auditStats().sink_failures).toBe(1));
  });

  it("en sink som svarer false (full kø = mottrykk) telles som avvist - avgjørelsen er uendret", async () => {
    const { policy } = gateway({ auditSink: () => false });
    const result = await policy.authorize(read());
    expect(result).toMatchObject({ decision: "ALLOW", reason: "class_a_read" });
    expect(policy.auditStats()).toMatchObject({ sink: "external", sink_rejected: 1, sink_failures: 0 });
    const asyncFalse = gateway({ auditSink: () => Promise.resolve(false) }).policy;
    await asyncFalse.authorize(read());
    await vi.waitFor(() => expect(asyncFalse.auditStats().sink_rejected).toBe(1));
  });

  it("en frisk sink: ingenting telles; uten sink er statistikken `memory` (ringbuffer)", async () => {
    const seen: PolicyAuditEvent[] = [];
    const { policy } = gateway({ auditSink: (e) => { seen.push(e); } });
    await policy.authorize(read());
    expect(seen).toHaveLength(1);
    expect(policy.auditStats()).toMatchObject({ sink: "external", sink_failures: 0, sink_rejected: 0, last_failure: null });
    const memory = gateway().policy;
    await memory.authorize(read());
    expect(memory.auditStats()).toMatchObject({ sink: "memory", in_memory: 1, dropped_in_memory: 0 });
  });
});

describe("B2: sink-feilhåndteringen kan selv ikke feile (review L1)", () => {
  /** Et feilobjekt der HVER lesing kaster: `describeSinkError` leser code/name/message. */
  const hostileError = (): unknown => new Proxy({}, { get() { throw new Error("fiendtlig getter"); } });

  it("en sink som kaster et fiendtlig feilobjekt: avgjørelsen er uendret (ALLOW og DENY), feilen telles, og last_failure er en fast etikett", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { policy, killSwitch } = gateway({ auditSink: () => { throw hostileError(); } });
    expect(await policy.authorize(read())).toMatchObject({ decision: "ALLOW", reason: "class_a_read" });
    killSwitch.activate("test");
    expect(await policy.authorize(read())).toMatchObject({ decision: "DENY", reason: "kill_switch_active" });
    expect(policy.auditStats()).toMatchObject({ sink_failures: 2, last_failure: "sink_failure_unreportable" });
    expect(errors).not.toHaveBeenCalled(); // loggingen ble aldri nådd: ingen halv logglinje med innhold
  });

  it("et AVVIST løfte med et fiendtlig feilobjekt gir ingen ubehandlet avvisning (ville ellers felt prosessen) og endrer ikke avgjørelsen", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", listener);
    try {
      const { policy } = gateway({ auditSink: () => Promise.reject(hostileError()) });
      expect(await policy.authorize(read())).toMatchObject({ decision: "ALLOW" });
      await vi.waitFor(() => expect(policy.auditStats().sink_failures).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 20)); // gi Node tid til å melde en ubehandlet avvisning
      expect(unhandled).toEqual([]);
      expect(policy.auditStats().last_failure).toBe("sink_failure_unreportable");
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("en vanlig feil beholder den strukturerte etiketten (regresjon: try/catch endrer ikke normalveien)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { policy } = gateway({ auditSink: () => { throw new Error("policy_audit_queue_full"); } });
    await policy.authorize(read());
    expect(policy.auditStats().last_failure).toBe("policy_audit_queue_full");
  });
});

describe("C: utsatt nonce-forbruk gir en NY avgjørelse (DENY) når commit() feiler", () => {
  it("commit() beholder returformatet, og den nye avgjørelsens ID gjøres tilgjengelig som commit_decision_id", async () => {
    const { signApproval } = await import("@jarvis/contracts");
    const { generateKeyPairSync } = await import("node:crypto");
    const keys = generateKeyPairSync("ed25519");
    const devices = new InMemoryDeviceRegistry();
    devices.register("watch-1", keys.publicKey, { tenant_id: "tenant-personal", person_id: "person-tobias" });
    const policy = new PolicyGateway({ devices, nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch() });
    const parameters = { to: "kunde@example.com" };
    const signed = signApproval(keys.privateKey, {
      tool_id: "email", action: "send", tenant_id: "tenant-personal", person_id: "person-tobias", approver_person_id: "person-tobias",
      parameters, nonce: "nonce-wpk-0123456789", approving_device_id: "watch-1"
    });
    const request: AuthorizationRequest = { identity, toolCall: { tool_id: "email", action: "send", capability_class: "D", parameters }, approval: signed, deferNonceConsumption: true };
    const first = await policy.authorize(request);
    const second = await policy.authorize(request);
    expect(first).toMatchObject({ decision: "ALLOW", reason: "class_d_valid_signed_approval_pending_commit" });
    expect(second).toMatchObject({ decision: "ALLOW", reason: "class_d_valid_signed_approval_pending_commit" });
    expect(await first.commit!()).toEqual({ ok: true });
    expect(first.commit_decision_id).toBeUndefined();
    expect(await second.commit!()).toEqual({ ok: false, reason: "class_d_nonce_already_used" });
    expect(second.commit_decision_id).toBeDefined();
    expect(second.commit_decision_id).not.toBe(second.decision_id);
    const denied = policy.auditLog.find((e) => e.decision_id === second.commit_decision_id);
    expect(denied).toMatchObject({ decision: "DENY", reason: "class_d_nonce_already_used" });
  });
});
