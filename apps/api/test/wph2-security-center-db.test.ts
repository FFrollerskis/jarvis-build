import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import { KillSwitch, OwnerControls } from "@jarvis/policy";
import { createGoldenSuiteRunner } from "../src/golden-suite-runner.ts";
import { createSecurityCenter, readAuditTrigger, readSecurityAggregates } from "../src/control-center/security.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";
import { PRODUCTION_SURFACE } from "./support/fast-path-harness.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";

/**
 * WP-H2 Security Center - SQL mot EKTE Postgres som EKTE app-rolle (jarvis_app, RLS gjelder), med de EKTE `KillSwitch`/`OwnerControls` og den EKTE golden-suite-kjøreren. Beviser at:
 *  - alle aggregatene (revisjon, avslagsårsaker, kontrollhandlinger, avviste innlogginger, bekreftelser utløst av ubetrodd innhold, minnevern, gjenopprettinger) kjører med rollens faktiske GRANT-er og kolonner;
 *  - tenant-isolasjon: A ser kun egne revisjonsrader og bekreftelser - aldri B sine;
 *  - append-only-triggeren på `audit_events` er intakt, og et senter som ser at den er DEAKTIVERT sier FEIL (manipulasjonsbevis mot den ekte tabellen);
 *  - de varige eierbryterne (kill switch, frys, tilbakekall, pauser) leses fra den ekte tilstanden;
 *  - innholdsvern: `payload`, bekreftelsessammendrag og avslagstekst vises aldri; senteret skriver ingenting.
 */
let db: H0Db;
const TENANT_A = "tenant-sc-a";
const TENANT_B = "tenant-sc-b";
const NOW = new Date();
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const idA: IdentityContext = { person_id: "person-sc-a", tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const idB: IdentityContext = { ...idA, person_id: "person-sc-b", tenant_id: TENANT_B };
const defs = productionToolDefinitions({ goldenSuite: true });
const toolGateway = { get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a) } as never;
const HIDDEN_PAYLOAD = "Hemmelig-revisjonspayload-kontonr-12345678901";
const HIDDEN_SUMMARY = "hemmelig-mottaker@example.com";
let killSwitch: KillSwitch;
let ownerControls: OwnerControls;

const counts = async (): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of ["audit_events", "action_confirmations", "owner_control_state", "situation_domain_pauses"]) out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return out;
};

beforeAll(async () => {
  db = await startH0Db("sc");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: idA.person_id }, { tenant_id: TENANT_B, person_id: idB.person_id }]);
  const audit = (tenant: string, person: string, type: string, extra: { tool?: string; action?: string; reason?: string; at?: Date } = {}): Promise<unknown> =>
    admin.query("INSERT INTO audit_events (tenant_id, person_id, type, decision, reason, tool_id, action, at, payload) VALUES ($1,$2,$3,'X',$4,$5,$6,$7,$8::jsonb)",
      [tenant, person, type, extra.reason ?? null, extra.tool ?? null, extra.action ?? null, extra.at ?? ago(H), JSON.stringify({ hemmelig: HIDDEN_PAYLOAD })]);
  // A: avslag (3 siste 7 d, 1 eldre), utført/feilet/ukjent utfall, kontrollhandlinger, avviste innlogginger, minnevern, gjenopprettinger
  await audit(TENANT_A, idA.person_id, "tool.denied", { tool: "executive", action: "get_security_center", reason: "control_center_owner_only", at: ago(2 * H) });
  await audit(TENANT_A, idA.person_id, "tool.denied", { tool: "executive", action: "get_security_center", reason: "control_center_owner_only", at: ago(3 * D) });
  await audit(TENANT_A, idA.person_id, "tool.denied", { tool: "executive", action: "revoke_credential", reason: "step_up_required:signed_device_session", at: ago(4 * D) });
  await audit(TENANT_A, idA.person_id, "tool.denied", { tool: "email", action: "send", reason: "fri tekst med mellomrom og kontonummer 12345678901", at: ago(20 * D) });
  await audit(TENANT_A, idA.person_id, "tool.executed", { tool: "owner_controls", action: "revoke_credential", at: ago(5 * D) });
  await audit(TENANT_A, idA.person_id, "tool.executed", { tool: "executive", action: "restore_credential", at: ago(4 * D) });
  await audit(TENANT_A, idA.person_id, "tool.executed", { tool: "executive", action: "restore_credential", at: ago(3 * D) });
  await audit(TENANT_A, idA.person_id, "tool.executed", { tool: "executive", action: "resume_domain", at: ago(2 * D) });
  await audit(TENANT_A, idA.person_id, "tool.failed", { tool: "github", action: "list_pull_requests", reason: "tool_failed:timeout", at: ago(D) });
  await audit(TENANT_A, idA.person_id, "tool.postcondition_unverified", { tool: "twilio", action: "notify", at: ago(D) });
  await audit(TENANT_A, idA.person_id, "tool.executed", { tool: "github", action: "list_pull_requests", at: ago(H) });
  await audit(TENANT_A, idA.person_id, "device.enrollment_denied", { at: ago(2 * D) });
  await audit(TENANT_A, idA.person_id, "identity.denied", { at: ago(D) });
  await audit(TENANT_A, idA.person_id, "memory.rejected", { at: ago(6 * D) });
  await audit(TENANT_A, idA.person_id, "memory.quarantined_conflict", { at: ago(7 * D) });
  // B: mange egne hendelser som A aldri skal se
  for (let i = 0; i < 6; i += 1) await audit(TENANT_B, idB.person_id, "tool.denied", { tool: "executive", action: "get_security_center", reason: "b_sin_avslagsårsak", at: ago(H) });
  await audit(TENANT_B, idB.person_id, "device.enrollment_denied", { at: ago(H) });
  const confirmation = (id: string, tenant: string, person: string, status: string, taint: string[]): Promise<unknown> =>
    admin.query("INSERT INTO action_confirmations (confirmation_id, tenant_id, person_id, tool_id, action, call_fingerprint, binding_hash, nonce, summary, taint_reasons, status, expires_at, created_at) VALUES ($1,$2,$3,'email','send','fp','bh',$1,$4::jsonb,$5,$6,$7,$8)",
      [id, tenant, person, JSON.stringify({ to: HIDDEN_SUMMARY }), taint, status, new Date(NOW.getTime() + 3 * H), ago(2 * D)]);
  await confirmation("c-a-pending", TENANT_A, idA.person_id, "pending", ["untrusted_output:email.read_inbox"]);
  await confirmation("c-a-rejected", TENANT_A, idA.person_id, "rejected", ["untrusted_output:web"]);
  await confirmation("c-a-clean", TENANT_A, idA.person_id, "approved", []); // ikke utløst av ubetrodd innhold
  await confirmation("c-b-pending-1", TENANT_B, idB.person_id, "pending", ["untrusted_output:email.read_inbox"]);
  await confirmation("c-b-pending-2", TENANT_B, idB.person_id, "pending", ["untrusted_output:email.read_inbox"]);
  // varige eierbrytere (globale): frosset connector, tilbakekalt credential, pauset domene
  await admin.query("INSERT INTO owner_control_state (control_kind, control_target, reason, actor_person_id, changed_at) VALUES ('connector_freeze','github','privat begrunnelse',$1,$2), ('credential_revocation','ANTHROPIC_API_KEY','privat begrunnelse',$1,$2)", [idA.person_id, ago(H)]);
  await admin.query("INSERT INTO situation_domain_pauses (domain, reason, paused_by, paused_at) VALUES ('sales','privat begrunnelse',$1,$2)", [idA.person_id, ago(H)]);
  const authority = { owner_person_id: idA.person_id };
  killSwitch = new KillSwitch(db.appPool, authority);
  await killSwitch.restore();
  ownerControls = new OwnerControls(killSwitch, db.appPool, authority);
  await ownerControls.restore();
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("lesere som app-rolle", () => {
  it("aggregatene for A: kun A sine rader (7 d-vinduet for avslag og feil, 30 d for kontrollhandlinger), avslagsårsaker som kategorier", async () => {
    const a = await readSecurityAggregates(db.appPool, TENANT_A, NOW.getTime());
    expect(a.audit).toMatchObject({ denied_7d: 3, denied_24h: 1, failed_7d: 1, outcome_unknown_7d: 1 });
    expect(a.audit.events_7d).toBeGreaterThan(8);
    expect(a.deny_reasons).toEqual([{ reason: "control_center_owner_only", n: 2 }, { reason: "step_up_required:signed_device_session", n: 1 }]);
    expect(a.credential_events.find((e) => e.action === "revoke_credential")).toMatchObject({ executed: 1, denied: 1 });
    expect(a.credential_events.find((e) => e.action === "restore_credential")).toMatchObject({ executed: 2 });
    expect(a.access_denials.map((d) => [d.type, d.n])).toEqual([["device.enrollment_denied", 1], ["identity.denied", 1]]);
    expect(a.tainted_confirmations.map((c) => [c.status, c.n]).sort()).toEqual([["pending", 1], ["rejected", 1]]);
    expect(a.memory_guard.map((m) => [m.type, m.n])).toEqual([["memory.quarantined_conflict", 1], ["memory.rejected", 1]]);
    expect(a.recovery_events.map((r) => [r.action, r.n])).toEqual([["restore_credential", 2], ["resume_domain", 1]]);
  });

  it("tenant-isolasjon: B sine avslag, bekreftelser og avviste innrulleringer er B sine alene", async () => {
    const b = await readSecurityAggregates(db.appPool, TENANT_B, NOW.getTime());
    expect(b.audit).toMatchObject({ denied_7d: 6, denied_24h: 6 });
    expect(b.deny_reasons).toEqual([{ reason: "annet", n: 6 }]); // «b_sin_avslagsårsak» har en å - ikke et trygt kategorinavn
    expect(b.tainted_confirmations).toEqual([{ status: "pending", n: 2, last_at: expect.any(String) }]);
    expect(b.access_denials.map((d) => d.type)).toEqual(["device.enrollment_denied"]);
    expect(b.credential_events).toEqual([]);
  });

  it("append-only-triggeren på audit_events er aktiv i den ekte databasen", async () => {
    expect(await readAuditTrigger(db.appPool)).toBe("enabled");
  });
});

describe("senteret over den ekte databasen", () => {
  const goldenRunner = createGoldenSuiteRunner({ surface: () => PRODUCTION_SURFACE, now: () => NOW });
  const build = async (identity: IdentityContext, withGolden = true): Promise<ControlCenterReport> => {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createSecurityCenter({ pool: db.appPool, toolGateway, ownerControls, killSwitch, ...(withGolden ? { goldenSuite: goldenRunner } : {}) }));
    return (await registry.report("security", identity)) as ControlCenterReport;
  };
  const item = (r: ControlCenterReport, s: string, i: string) => r.sections.find((x) => x.id === s)!.items.find((x) => x.id === i)!;

  it("alle fem seksjonene er målt; tilbakekalt credential og frosset connector vises med navn (aldri verdier) og pausen teller", async () => {
    const r = await build(idA);
    expect(r.sections.map((s) => s.id)).toEqual(["audit", "credentials", "suspicious", "recovery", "golden_suite"]);
    expect(r.sections.every((s) => s.measured)).toBe(true);
    expect(item(r, "credentials", "revoked_now").detail_no).toContain("ANTHROPIC_API_KEY");
    expect(item(r, "credentials", "frozen_now").detail_no).toContain("github");
    expect(item(r, "recovery", "paused_domains").facts).toMatchObject({ paused: 1 });
    expect(item(r, "recovery", "kill_switch").status).toBe("OK");
    expect(item(r, "audit", "append_only").status).toBe("OK");
    expect(item(r, "audit", "outcome_unknown").status).toBe("WARN");
    expect(item(r, "credentials", "action:revoke_credential").status).toBe("WARN"); // ett nektet forsøk
    expect(item(r, "suspicious", "taint:pending").status).toBe("WARN");
  });

  it("golden-suite: ikke kjørt = UKJENT med knappen; etter en kjøring står resultatet med digester og null modellkall - og kjøringen ga ingen skriving", async () => {
    const before = await counts();
    const first = await build(idA);
    expect(item(first, "golden_suite", "golden_state")).toMatchObject({ status: "UNKNOWN", facts: { ran: false } });
    expect(first.actions.map((a) => a.id)).toEqual(["security.golden_suite.run"]);
    expect(first.actions[0]).toMatchObject({ risk_class: "A", requires_step_up: true, endpoint: "/executive/mutate" });
    const ran = await goldenRunner.run();
    const second = await build(idA);
    expect(item(second, "golden_suite", "golden_state")).toMatchObject({ status: "OK", facts: { failed: 0, skipped: 0, model_calls: 0 } });
    expect(item(second, "golden_suite", "golden_digests").facts).toMatchObject({ suite_digest: ran.suite_digest, result_digest: ran.result_digest });
    expect(await counts()).toEqual(before);
  });

  it("uten golden-suite-kjører: ingen knapp og en ærlig UKJENT-seksjon", async () => {
    const r = await build(idA, false);
    expect(r.actions).toEqual([]);
    expect(item(r, "golden_suite", "golden_state")).toMatchObject({ status: "UNKNOWN", facts: { enabled: false } });
  });

  it("tenant-isolasjon i sluttrapporten: B ser 6 avslag og 2 bekreftelser utløst av ubetrodd innhold - ikke A sine", async () => {
    const r = await build(idB);
    expect(item(r, "audit", "denied").facts).toMatchObject({ denied_7d: 6 });
    expect(item(r, "suspicious", "taint:pending").facts).toMatchObject({ count: 2 });
    expect(r.sections.find((s) => s.id === "credentials")?.items.find((i) => i.id === "action:restore_credential")).toBeUndefined();
  });

  it("innholdsvern: revisjonens payload, bekreftelsenes sammendrag (mottaker), avslagets fri tekst og begrunnelsene vises aldri; senteret skriver ingenting", async () => {
    const before = await counts();
    const text = JSON.stringify(await build(idA)) + JSON.stringify(await build(idB));
    for (const secret of ["Hemmelig-revisjonspayload", "12345678901", "hemmelig-mottaker", "privat begrunnelse", "b_sin_avslagsårsak"]) expect(text, secret).not.toContain(secret);
    expect(await counts()).toEqual(before);
  });

  it("MANIPULASJONSBEVIS: deaktiveres append-only-triggeren (ALTER TABLE ... DISABLE TRIGGER), sier senteret FEIL - og er friskt igjen når den slås på", async () => {
    await db.adminPool.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
    try {
      expect(await readAuditTrigger(db.appPool)).toBe("disabled");
      const r = await build(idA);
      expect(item(r, "audit", "append_only")).toMatchObject({ status: "FAIL", facts: { trigger: "disabled" } });
      expect(r.status).toBe("FAIL");
    } finally {
      await db.adminPool.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only");
    }
    expect(await readAuditTrigger(db.appPool)).toBe("enabled");
    expect(item(await build(idA), "audit", "append_only").status).toBe("OK");
  });

  it("kill switch: senteret leser den VARIGE tilstanden (owner_control_state), ikke minnespeilingen - aktivert via den ekte bryteren står som FEIL, og friskt igjen etter at den er opphevet", async () => {
    // Kun minnespeilingen (`activate`) endrer IKKE den varige tilstanden: senteret må ikke la seg lure av en prosesslokal cache.
    killSwitch.activate("kun-minne");
    try {
      expect(item(await build(idA), "recovery", "kill_switch")).toMatchObject({ status: "OK", facts: { active: false } });
    } finally {
      killSwitch.deactivate();
    }
    await killSwitch.activateDurable("wph2-test", idA.person_id);
    try {
      const r = await build(idA);
      expect(item(r, "recovery", "kill_switch")).toMatchObject({ status: "FAIL", facts: { active: true } });
      expect(r.status).toBe("FAIL");
    } finally {
      await killSwitch.deactivateDurable(idA.person_id);
    }
    expect(item(await build(idA), "recovery", "kill_switch").status).toBe("OK");
  });
});
