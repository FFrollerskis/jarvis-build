import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  CLASS_D_EXEMPT_ACTIONS,
  ToolGateway,
  assessClassDPipeline,
  firstWaveTools,
  homeAssistantTools,
  isClassDExempt,
  isNotFoundError,
  type ClassDNotification,
  type ClassDNotifier,
  type ToolDefinition,
  type ToolTransport
} from "@jarvis/tool-gateway";

/**
 * Del 3 (JARVIS-013/043): minimumspipeline for klasse D. Beviser (a) at den statiske vurderingen er pinnet mot de FAKTISKE
 * produksjonsdefinisjonene (en ny D-handling uten kjede blir synlig), og (b) at gatewayen håndhever kjeden i kode:
 * manglende nøkkel/varsler/kjede → avslag FØR noen mutasjon, varslingsfeil gjøres synlig, uverifisert utfall kan avstemmes.
 */

/** Eksplisitt DEFERRED-liste: klasse D-handlinger som IKKE har hele kjeden og derfor er utilgjengelige under håndhevelse. */
const EXPECTED_DEFERRED: ReadonlyArray<string> = [
  "finance.submit_payment_intent",
  "finance_stripe.submit_refund",
  "finance_vipps.submit_capture",
  "finance_vipps.submit_refund",
  "mcp_zapier.call_tool",
  "microsoft_outlook.send_mail"
];

function productionClassD(): ToolDefinition[] {
  return firstWaveTools({}, { homeAssistant: undefined } as never).filter((d) => d.capability_class === "D");
}

describe("A: statisk vurdering mot produksjonsdefinisjonene", () => {
  const classD = [...productionClassD(), ...homeAssistantTools({ invoke: async () => ({}) } as ToolTransport).filter((d) => d.capability_class === "D")];

  it("de utilgjengelige (DEFERRED) klasse D-handlingene er EKSAKT den pinnede listen - ingen stille utelatelse", () => {
    const incomplete = classD
      .filter((d) => !isClassDExempt(d) && !assessClassDPipeline(d).complete)
      .map((d) => `${d.tool_id}.${d.action}`)
      .sort();
    expect(incomplete).toEqual([...EXPECTED_DEFERRED].sort());
  });

  it("hver DEFERRED-handling oppgir presist hva som mangler (aldri tom årsak)", () => {
    for (const d of classD.filter((x) => !isClassDExempt(x))) {
      const a = assessClassDPipeline(d);
      if (!a.complete) expect(a.missing.length).toBeGreaterThan(0);
    }
  });

  it("alle klasse D med full kjede har ikke-tom recovery-plan", () => {
    for (const d of classD.filter((x) => assessClassDPipeline(x).complete)) {
      expect(d.rollback_procedure.trim().length, `${d.tool_id}.${d.action}`).toBeGreaterThan(0);
    }
  });

  it("kill-switch-handlinger er eksplisitt unntatt og listen er pinnet", () => {
    expect([...CLASS_D_EXEMPT_ACTIONS].sort()).toEqual([
      "executive:activate_kill_switch", "executive:deactivate_kill_switch", "executive:disable_finance_kill_switch",
      "executive:enable_finance_kill_switch", "finance:disable_kill_switch", "finance:enable_kill_switch",
      "owner_controls:activate_kill_switch", "owner_controls:deactivate_kill_switch"
    ]);
  });

  it("isNotFoundError gjenkjenner 404/not_found, ikke tilfeldige tall", () => {
    expect(isNotFoundError("github_api_error_404:Not Found")).toBe(true);
    expect(isNotFoundError("drive_not_found_abc")).toBe(true);
    expect(isNotFoundError("github_api_error_4040:x")).toBe(false);
    expect(isNotFoundError("rate_limited")).toBe(false);
  });

  it("produksjons-Gmail-send er outbound_message og slettinger har target_absent-postcondition", () => {
    const get = (id: string, a: string) => classD.find((d) => d.tool_id === id && d.action === a);
    expect(get("email", "send")?.class_d_profile).toBe("outbound_message");
    expect(get("github", "delete_branch")?.postcondition_target_absent).toBe(true);
    expect(get("drive", "delete_permanent")?.postcondition_target_absent).toBe(true);
    expect(typeof get("github", "merge_pr")?.postcondition_predicate).toBe("function");
  });
});

describe("B: postcondition-predikatene er korrekte", () => {
  const defs = productionClassD();
  const get = (id: string, a: string) => defs.find((d) => d.tool_id === id && d.action === a)!;
  it("docker start/stop/redeploy", () => {
    expect(get("docker", "start_container").postcondition_predicate!({ status: "running" }, {})).toBe(true);
    expect(get("docker", "start_container").postcondition_predicate!({ status: "exited" }, {})).toBe(false);
    expect(get("docker", "stop_container").postcondition_predicate!({ status: "exited" }, {})).toBe(true);
    expect(get("docker", "stop_container").postcondition_predicate!({ status: "running" }, {})).toBe(false);
    expect(get("docker", "redeploy_container").postcondition_predicate!({ status: "running", image: "a:1" }, { image: "a:1" })).toBe(true);
    expect(get("docker", "redeploy_container").postcondition_predicate!({ status: "running", image: "a:0" }, { image: "a:1" })).toBe(false);
  });
  it("github merge og drive-tillatelser", () => {
    expect(get("github", "merge_pr").postcondition_predicate!({ merged: true }, {})).toBe(true);
    expect(get("github", "merge_pr").postcondition_predicate!({ merged: false }, {})).toBe(false);
    const perms = { permissions: [{ id: "p1", role: "reader", type: "user", emailAddress: "a@b.no" }] };
    expect(get("drive", "update_permission").postcondition_predicate!(perms, { permission_id: "p1", role: "reader" })).toBe(true);
    expect(get("drive", "update_permission").postcondition_predicate!(perms, { permission_id: "p1", role: "writer" })).toBe(false);
    expect(get("drive", "delete_permission").postcondition_predicate!(perms, { permission_id: "p1" })).toBe(false);
    expect(get("drive", "delete_permission").postcondition_predicate!({ permissions: [] }, { permission_id: "p1" })).toBe(true);
    expect(get("drive", "create_permission").postcondition_predicate!(perms, { role: "reader", type: "user", email_address: "a@b.no" })).toBe(true);
    expect(get("drive", "create_permission").postcondition_predicate!(perms, { role: "writer", type: "user", email_address: "a@b.no" })).toBe(false);
  });
});

class Recorder implements ToolTransport {
  calls: string[] = [];
  private pre = 0;
  constructor(private readonly opts: { before?: JsonValue; after?: JsonValue | "throw-404"; externalId?: string | null } = {}) {}
  async invoke(action: string): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push(action);
    if (action === "preflight") {
      this.pre += 1;
      if (this.pre === 1) return { data: this.opts.before ?? { ok: true } };
      if (this.opts.after === "throw-404") throw new Error("github_api_error_404:Not Found");
      return { data: this.opts.after ?? { ok: true } };
    }
    return this.opts.externalId === null ? {} : { external_id: this.opts.externalId ?? "ext-1" };
  }
}

type Overrides = { [K in keyof ToolDefinition]?: ToolDefinition[K] | undefined };
function def(overrides: Overrides, transport: ToolTransport): ToolDefinition {
  const base: ToolDefinition = {
    tool_id: "gen-d", action: "mutate", description: "test",
    input_schema: { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"],
    capability_class: "D", scopes: [], reversible: true, rollback_procedure: "rull tilbake manuelt",
    idempotent_external: true, timeout_ms: 5_000, rate_limit_per_minute: 60, credential_ref: "GEN_D_TOKEN",
    output_trust: "internal", transport, preflight_action: "preflight", preflight_requires_target: true,
    postcondition_predicate: (after) => (after as { ok?: boolean }).ok === true
  };
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as ToolDefinition;
}

class FakeNotifier implements ClassDNotifier {
  sent: ClassDNotification[] = [];
  constructor(private readonly behaviour: { ready?: boolean; failNotify?: boolean } = {}) {}
  ready() { return this.behaviour.ready ?? true; }
  async notify(n: ClassDNotification) {
    if (this.behaviour.failNotify) throw new Error("telegram_down");
    this.sent.push(n);
  }
}

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "home",
  session_id: "sess-d", device_id: "dev-pc", channel: "api", auth_strength: "active"
};
const secrets = { name: "t", get: async () => "cred" };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-p3d-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_p3d LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_p3d");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_p3d", password: "pw2" });
  policy = new PolicyGateway({
    devices: { approverFor: async () => undefined },
    nonces: { consume: async () => true },
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-a"] }
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

function gw(notifier?: ClassDNotifier, enforce = true): ToolGateway {
  return new ToolGateway(appPool, policy, secrets, undefined, undefined, { enforce, ...(notifier ? { notifier } : {}) });
}

describe("C: gatewayen håndhever kjeden før noen mutasjon", () => {
  it("mangler varsler → class_d_notifier_missing, transporten kalles ALDRI", async () => {
    const t = new Recorder();
    const g = gw();
    g.register(def({}, t));
    const r = await g.execute({ identity, tool_id: "gen-d", action: "mutate", parameters: {}, idempotency_key: "k-c1" });
    expect(r).toEqual({ ok: false, reason: "class_d_notifier_missing" });
    expect(t.calls).toEqual([]);
  });

  it("varsler som ikke er klar → class_d_notifier_not_ready", async () => {
    const t = new Recorder();
    const g = gw(new FakeNotifier({ ready: false }));
    g.register(def({}, t));
    const r = await g.execute({ identity, tool_id: "gen-d", action: "mutate", parameters: {}, idempotency_key: "k-c2" });
    expect(r).toEqual({ ok: false, reason: "class_d_notifier_not_ready" });
    expect(t.calls).toEqual([]);
  });

  it("uten idempotensnøkkel → class_d_idempotency_key_required", async () => {
    const t = new Recorder();
    const g = gw(new FakeNotifier());
    g.register(def({}, t));
    const r = await g.execute({ identity, tool_id: "gen-d", action: "mutate", parameters: {} });
    expect(r).toEqual({ ok: false, reason: "class_d_idempotency_key_required" });
    expect(t.calls).toEqual([]);
  });

  it("manglende postcondition/preflight → class_d_pipeline_incomplete med årsaker", async () => {
    const t = new Recorder();
    const g = gw(new FakeNotifier());
    g.register(def({ postcondition_predicate: undefined, preflight_action: undefined }, t));
    const r = await g.execute({ identity, tool_id: "gen-d", action: "mutate", parameters: {}, idempotency_key: "k-c4" });
    expect(r).toEqual({ ok: false, reason: "class_d_pipeline_incomplete:fresh_state_read,postcondition" });
    expect(t.calls).toEqual([]);
  });

  it("full kjede → utført, varslet out-of-band med recovery og nøkkel", async () => {
    const t = new Recorder();
    const n = new FakeNotifier();
    const g = gw(n);
    g.register(def({}, t));
    const r = await g.execute({ identity, tool_id: "gen-d", action: "mutate", parameters: {}, idempotency_key: "k-c5" });
    expect(r.ok).toBe(true);
    expect((r as { notified?: boolean }).notified).toBe(true);
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toMatchObject({ tool_id: "gen-d", action: "mutate", outcome: "executed", idempotency_key: "k-c5", recovery: "rull tilbake manuelt", external_id: "ext-1" });
  });

  it("varslingsfeil etter utført handling gjøres synlig: notified=false + audit class_d_notification_failed", async () => {
    const t = new Recorder();
    const g = gw(new FakeNotifier({ failNotify: true }));
    g.register(def({}, t));
    const r = await g.execute({ identity, tool_id: "gen-d", action: "mutate", parameters: {}, idempotency_key: "k-c6" });
    expect(r.ok).toBe(true);
    expect((r as { notified?: boolean }).notified).toBe(false);
    const audit = await adminPool.query("SELECT 1 FROM audit_events WHERE type = 'tool.class_d_notification_failed' AND tool_id = 'gen-d'");
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it("uten enforce er oppførselen uendret (testhjelpere/legacy)", async () => {
    const t = new Recorder();
    const g = gw(undefined, false);
    g.register(def({}, t));
    const r = await g.execute({ identity, tool_id: "gen-d", action: "mutate", parameters: {} });
    expect(r.ok).toBe(true);
  });

  it("kill-switch-handling er unntatt: virker uten varsler og uten nøkkel", async () => {
    const t = new Recorder();
    const g = gw();
    g.register(def({ tool_id: "owner_controls", action: "activate_kill_switch", preflight_action: undefined, postcondition_predicate: undefined }, t));
    const r = await g.execute({ identity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: {} });
    expect(r.ok).toBe(true);
  });

  it("late binding av varsler via setClassDNotifier gjør handlingen tilgjengelig", async () => {
    const t = new Recorder();
    const g = gw();
    g.register(def({}, t));
    g.setClassDNotifier(new FakeNotifier());
    const r = await g.execute({ identity, tool_id: "gen-d", action: "mutate", parameters: {}, idempotency_key: "k-c9" });
    expect(r.ok).toBe(true);
  });
});

describe("D: etterbetingelser og avstemming", () => {
  it("outbound_message uten leverandør-ID → ok:false postcondition_unverified:no_provider_id, og uverifisert rad kan avstemmes", async () => {
    const t = new Recorder({ externalId: null });
    const n = new FakeNotifier();
    const g = gw(n);
    g.register(def({ tool_id: "gen-msg", class_d_profile: "outbound_message", preflight_action: undefined, postcondition_predicate: undefined }, t));
    const r = await g.execute({ identity, tool_id: "gen-msg", action: "mutate", parameters: {}, idempotency_key: "k-d1" });
    expect(r).toEqual({ ok: false, reason: "postcondition_unverified:no_provider_id" });
    expect(n.sent[0]?.outcome).toBe("unverified");
    const rec = await g.reconcile("tenant-a");
    const hit = rec.find((x) => x.idempotency_key === "k-d1");
    expect(hit).toMatchObject({ tool_id: "gen-msg", reason: "postcondition_unverified:no_provider_id", recovery: "rull tilbake manuelt" });
    // retry med SAMME nøkkel skal aldri gjenta handlingen
    const callsBefore = t.calls.length;
    const again = await g.execute({ identity, tool_id: "gen-msg", action: "mutate", parameters: {}, idempotency_key: "k-d1" });
    expect(again.ok).toBe(false);
    expect(t.calls.length).toBe(callsBefore);
  });

  it("outbound_message med leverandør-ID → ok", async () => {
    const t = new Recorder({ externalId: "msg-123" });
    const g = gw(new FakeNotifier());
    g.register(def({ tool_id: "gen-msg2", class_d_profile: "outbound_message", preflight_action: undefined, postcondition_predicate: undefined }, t));
    const r = await g.execute({ identity, tool_id: "gen-msg2", action: "mutate", parameters: {}, idempotency_key: "k-d2" });
    expect(r.ok).toBe(true);
    expect((r as { external_id?: string }).external_id).toBe("msg-123");
  });

  it("postcondition_target_absent: readback 404 = verifisert sletting; readback finner målet = mismatch", async () => {
    const gone = new Recorder({ after: "throw-404" });
    const g = gw(new FakeNotifier());
    g.register(def({ tool_id: "gen-del", postcondition_predicate: undefined, postcondition_target_absent: true }, gone));
    const ok = await g.execute({ identity, tool_id: "gen-del", action: "mutate", parameters: {}, idempotency_key: "k-d3" });
    expect(ok.ok).toBe(true);

    const still = new Recorder({ after: { name: "x" } });
    g.register(def({ tool_id: "gen-del2", postcondition_predicate: undefined, postcondition_target_absent: true }, still));
    const bad = await g.execute({ identity, tool_id: "gen-del2", action: "mutate", parameters: {}, idempotency_key: "k-d4" });
    expect(bad).toEqual({ ok: false, reason: "postcondition_mismatch" });
  });

  it("predikat som ikke holder → ok:false (uendret Q-34-oppførsel), og before_state ligger i avstemmingen", async () => {
    const t = new Recorder({ before: { ok: true, v: 1 }, after: { ok: false } });
    const g = gw(new FakeNotifier());
    g.register(def({ tool_id: "gen-pc" }, t));
    const r = await g.execute({ identity, tool_id: "gen-pc", action: "mutate", parameters: {}, idempotency_key: "k-d5" });
    expect(r).toEqual({ ok: false, reason: "postcondition_mismatch" });
    const rec = await g.reconcile("tenant-a");
    expect(rec.find((x) => x.idempotency_key === "k-d5")?.before_state).toEqual({ ok: true, v: 1 });
  });
});
