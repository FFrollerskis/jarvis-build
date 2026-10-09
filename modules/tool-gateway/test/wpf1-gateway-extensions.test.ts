import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  OUTCOME_UNKNOWN_PREFIX,
  OWNER_STEP_UP_CHANNELS,
  ToolGateway,
  assessClassDPipeline,
  isOutcomeUnknownMessage,
  ownerStepUpDenial,
  type ClassDNotification,
  type ClassDNotifier,
  type ToolDefinition,
  type ToolTransport
} from "@jarvis/tool-gateway";

/**
 * WP-F1 (D-453): de GENERISKE utvidelsene i ToolGateway som klasse D-kjeden for penger bygger på:
 *   A. `preflight_validator` - målvalidering med spesifikk årsak, replay-vakt mot ledgeren.
 *   B. `credential_ref_resolver` - credential bestemt per kall (JARVIS-072), fail-closed, samme eier-binding.
 *   C. `outcome_unknown:` - en transport som vet at utfallet er ukjent gir `unverified` (aldri retry-bar) og varsler eieren.
 *   D. `notification_summary` og utvidet `reconcile()`.
 * Ekte embedded Postgres; ingen nettverk.
 */

class ScriptTransport implements ToolTransport {
  calls: string[] = [];
  state: JsonValue = { phase: "before" };
  mutateThrows: (() => Error) | null = null;
  async invoke(action: string): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push(action);
    if (action === "read") return { data: this.state };
    if (action === "read_null") return { data: null };
    if (action === "mutate") {
      if (this.mutateThrows) throw this.mutateThrows();
      this.state = { phase: "after" };
      return { external_id: "ext-1" };
    }
    throw new Error(`unknown_action:${action}`);
  }
  get mutations(): number {
    return this.calls.filter((c) => c === "mutate").length;
  }
}

type Overrides = { [K in keyof ToolDefinition]?: ToolDefinition[K] | undefined };
function def(overrides: Overrides, transport: ToolTransport): ToolDefinition {
  const base: ToolDefinition = {
    tool_id: "wpf1-gen", action: "mutate", description: "test",
    input_schema: { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"],
    capability_class: "D", scopes: [], reversible: false, rollback_procedure: "manuell rutine",
    idempotent_external: true, timeout_ms: 5_000, rate_limit_per_minute: 600, credential_ref: "WPF1_STATIC_REF",
    output_trust: "internal", transport, preflight_action: "read", preflight_requires_target: true,
    postcondition_predicate: (after) => (after as { phase?: string }).phase === "after"
  };
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as ToolDefinition;
}

class FakeNotifier implements ClassDNotifier {
  sent: ClassDNotification[] = [];
  ready() { return true; }
  async notify(n: ClassDNotification) { this.sent.push(n); }
}

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
let counter = 0;
const nextKey = (prefix: string) => `${prefix}-${Date.now()}-${(counter += 1)}`;
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "home",
  session_id: "sess-wpf1", device_id: "dev-pc", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpf1-gw-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpf1 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpf1");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias'), ('person-guest','Gjest');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a'), ('person-guest','tenant-a');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpf1", password: "pw2" });
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

const secrets = { name: "t", get: async () => "cred" };
function gw(notifier: ClassDNotifier, extra: { secrets?: { name: string; get(ref: string): Promise<string | null> }; controls?: OwnerControls } = {}): ToolGateway {
  return new ToolGateway(appPool, policy, extra.secrets ?? secrets, extra.controls, undefined, { classDPipeline: { enforce: true, notifier } });
}
const exec = (g: ToolGateway, key: string | undefined, parameters: Record<string, JsonValue> = {}, who: IdentityContext = identity) =>
  g.execute({ identity: who, tool_id: "wpf1-gen", action: "mutate", parameters, ...(key !== undefined ? { idempotency_key: key } : {}) });

describe("A: preflight_validator - målvalidering med spesifikk årsak", () => {
  it("static vurdering: en validator alene teller som målvalidering (men kjeden mangler fortsatt fersk lesing/etterbetingelse uten dem)", () => {
    const t = new ScriptTransport();
    expect(assessClassDPipeline(def({ preflight_requires_target: undefined, preflight_validator: () => null }, t))).toEqual({ complete: true, missing: [] });
    expect(assessClassDPipeline(def({ preflight_requires_target: undefined }, t)).missing).toEqual(["target_validation"]);
    expect(assessClassDPipeline(def({ preflight_validator: () => null, preflight_action: undefined }, t)).missing).toEqual(["fresh_state_read"]);
  });

  it("validator gir årsak -> avslag preflight_invalid:<årsak>, mutasjonen kalles ALDRI og ingen ledger-rad reserveres", async () => {
    const t = new ScriptTransport();
    const g = gw(new FakeNotifier());
    g.register(def({ preflight_validator: () => "currency_mismatch" }, t));
    const key = nextKey("a1");
    const r = await exec(g, key);
    expect(r).toEqual({ ok: false, reason: "preflight_invalid:currency_mismatch" });
    expect(t.mutations).toBe(0);
    const rows = await adminPool.query("SELECT 1 FROM tool_executions WHERE idempotency_key = $1", [key]);
    expect(rows.rowCount).toBe(0);
  });

  it("validator får fersk tilstand + parametre og null slipper gjennom (positiv kontroll)", async () => {
    const t = new ScriptTransport();
    const seen: Array<{ data: JsonValue; parameters: Record<string, JsonValue> }> = [];
    const g = gw(new FakeNotifier());
    g.register(def({ preflight_validator: (data, parameters) => { seen.push({ data, parameters }); return null; } }, t));
    const r = await exec(g, nextKey("a2"), { payment_intent_id: "pi-1" });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ data: { phase: "before" }, parameters: { payment_intent_id: "pi-1" } }]);
    expect(t.calls).toEqual(["read", "mutate", "read"]);
  });

  it("kastet validator er fail-closed: preflight_invalid:validator_error", async () => {
    const t = new ScriptTransport();
    const g = gw(new FakeNotifier());
    g.register(def({ preflight_validator: () => { throw new Error("boom"); } }, t));
    const r = await exec(g, nextKey("a3"));
    expect(r).toEqual({ ok: false, reason: "preflight_invalid:validator_error" });
    expect(t.mutations).toBe(0);
  });

  it("manglende tilstand (null) med validator satt -> preflight_target_not_found, validatoren kalles ikke", async () => {
    const t = new ScriptTransport();
    let called = 0;
    const g = gw(new FakeNotifier());
    g.register(def({ preflight_action: "read_null", preflight_requires_target: false, allows_missing_preflight_target: true, preflight_validator: () => { called += 1; return null; } }, t));
    const r = await exec(g, nextKey("a4"));
    expect(r).toEqual({ ok: false, reason: "preflight_target_not_found" });
    expect(called).toBe(0);
    expect(t.mutations).toBe(0);
  });

  it("årsakskoden saneres (tegnsett og lengde) før den havner i avslag/audit", async () => {
    const t = new ScriptTransport();
    const g = gw(new FakeNotifier());
    g.register(def({ preflight_validator: () => `slik <skal> ikke se ut\n${"x".repeat(200)}` }, t));
    const r = await exec(g, nextKey("a5"));
    expect(r.ok).toBe(false);
    const reason = (r as { reason: string }).reason;
    expect(reason.startsWith("preflight_invalid:slik__skal__ikke_se_ut_")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual("preflight_invalid:".length + 80);
    expect(reason).toMatch(/^[A-Za-z0-9_:.-]+$/);
  });

  it("replay: samme nøkkel etter gjennomført handling returnerer lagret utfall (deduplicated) selv om validatoren nå ville avvist - ny nøkkel avvises", async () => {
    const t = new ScriptTransport();
    const g = gw(new FakeNotifier());
    g.register(def({ preflight_validator: (data) => ((data as { phase: string }).phase === "before" ? null : "already_done") }, t));
    const key = nextKey("a6");
    const first = await exec(g, key);
    expect(first.ok).toBe(true);
    expect(t.mutations).toBe(1);
    const replay = await exec(g, key);
    expect(replay.ok).toBe(true);
    expect((replay as { deduplicated: boolean }).deduplicated).toBe(true);
    expect(t.mutations).toBe(1);
    const other = await exec(g, nextKey("a6b"));
    expect(other).toEqual({ ok: false, reason: "preflight_invalid:already_done" });
    expect(t.mutations).toBe(1);
  });

  it("replay etter `failed` (leverandøren avviste, ingen bivirkning) validerer på nytt og kan gjennomføres med samme nøkkel", async () => {
    const t = new ScriptTransport();
    t.mutateThrows = () => new Error("provider_rejected_400");
    const g = gw(new FakeNotifier());
    g.register(def({ preflight_validator: (data) => ((data as { phase: string }).phase === "before" ? null : "already_done") }, t));
    const key = nextKey("a7");
    const first = await exec(g, key);
    expect(first).toEqual({ ok: false, reason: "tool_failed:provider_rejected_400" });
    t.mutateThrows = null;
    const second = await exec(g, key);
    expect(second.ok).toBe(true);
    expect(t.mutations).toBe(2);
  });
});

describe("B: credential_ref_resolver - credential per kall (JARVIS-072)", () => {
  const asked: string[] = [];
  const picky = {
    name: "picky",
    get: async (ref: string) => {
      asked.push(ref);
      return ref === "REF_STRIPE" || ref === "WPF1_STATIC_REF" ? "cred" : null;
    }
  };

  it("den løste refen brukes (ikke den statiske): en provider uten sin egen credential avvises, en med går gjennom - uten at den statiske trengs", async () => {
    const t = new ScriptTransport();
    const g = gw(new FakeNotifier(), { secrets: { name: "picky", get: async (ref) => (ref === "REF_STRIPE" ? "cred" : null) } });
    g.register(def({ credential_ref_resolver: async (p) => (p["provider"] === "stripe" ? "REF_STRIPE" : "REF_FIKEN") }, t));
    const noCred = await exec(g, nextKey("b1"), { provider: "fiken" });
    expect(noCred).toEqual({ ok: false, reason: "credential_unavailable" });
    expect(t.mutations).toBe(0);
    const ok = await exec(g, nextKey("b1b"), { provider: "stripe" });
    expect(ok.ok).toBe(true);
    expect(t.mutations).toBe(1);
  });

  it("resolveren får ikke kjøre FØR autorisasjon: et avslag fra policy/parameter-portene når den aldri", async () => {
    asked.length = 0;
    const t = new ScriptTransport();
    let resolverCalls = 0;
    const g = gw(new FakeNotifier(), { secrets: picky });
    g.register(def({
      credential_ref_resolver: async () => { resolverCalls += 1; return "REF_STRIPE"; },
      parameterAuthorizer: () => ({ allowed: false, reason: "target_not_allowed" })
    }, t));
    const r = await exec(g, nextKey("b2"));
    expect(r).toEqual({ ok: false, reason: "target_not_allowed" });
    expect(resolverCalls).toBe(0);
    expect(asked).toEqual([]);
  });

  it("null / tom streng / kastet feil fra resolveren er fail-closed: credential_ref_unresolved, ingen mutasjon", async () => {
    for (const resolver of [async () => null, async () => "", async () => { throw new Error("db_down"); }]) {
      const t = new ScriptTransport();
      const g = gw(new FakeNotifier());
      g.register(def({ credential_ref_resolver: resolver }, t));
      const r = await exec(g, nextKey("b3"));
      expect(r).toEqual({ ok: false, reason: "credential_ref_unresolved" });
      expect(t.calls).toEqual([]);
    }
  });

  it("tilbakekalt (revoked) løst ref avvises med credential_revoked", async () => {
    const controls = new OwnerControls(new KillSwitch());
    controls.revokeCredential("REF_STRIPE");
    const t = new ScriptTransport();
    const g = gw(new FakeNotifier(), { controls });
    g.register(def({ credential_ref_resolver: async () => "REF_STRIPE" }, t));
    const r = await exec(g, nextKey("b4"));
    expect(r).toEqual({ ok: false, reason: "credential_revoked" });
    expect(t.calls).toEqual([]);
  });

  it("revokering av den STATISKE refen påvirker ikke en kall som løser til en annen ref (credential-kravet er per kall)", async () => {
    const controls = new OwnerControls(new KillSwitch());
    controls.revokeCredential("WPF1_STATIC_REF");
    const t = new ScriptTransport();
    const g = gw(new FakeNotifier(), { controls });
    g.register(def({ credential_ref_resolver: async () => "REF_STRIPE" }, t));
    const r = await exec(g, nextKey("b5"));
    expect(r.ok).toBe(true);
  });

  it("eier-binding gjelder også den løste refen: en ikke-eier får credential_not_bound_to_identity selv om den statiske refen er intern", async () => {
    const t = new ScriptTransport();
    const bound = new ToolGateway(appPool, policy, secrets, undefined, undefined, {
      classDPipeline: { enforce: false },
      credentialBinding: { owner_person_id: "person-tobias", owner_tenants: ["tenant-a"], internalRefs: new Set(["WPF1_STATIC_REF"]) }
    });
    bound.register(def({ capability_class: "B", preflight_action: undefined, preflight_requires_target: undefined, postcondition_predicate: undefined, credential_ref_resolver: async () => "REF_EXTERNAL" }, t));
    const guest: IdentityContext = { ...identity, person_id: "person-guest", session_id: "sess-guest" };
    const denied = await bound.execute({ identity: guest, tool_id: "wpf1-gen", action: "mutate", parameters: {} });
    expect(denied).toEqual({ ok: false, reason: "credential_not_bound_to_identity" });
    expect(t.calls).toEqual([]);
    const owner = await bound.execute({ identity, tool_id: "wpf1-gen", action: "mutate", parameters: {} });
    expect(owner.ok).toBe(true);
  });
});

describe("C: outcome_unknown - ukjent utfall er aldri retry-bart og varsler eieren", () => {
  it("isOutcomeUnknownMessage: gateway-tidsavbrudd og outcome_unknown:-prefiks, ellers ikke", () => {
    expect(OUTCOME_UNKNOWN_PREFIX).toBe("outcome_unknown");
    expect(isOutcomeUnknownMessage("tool_timeout")).toBe(true);
    expect(isOutcomeUnknownMessage("outcome_unknown:stripe timeout")).toBe(true);
    expect(isOutcomeUnknownMessage("provider_rejected_400")).toBe(false);
    expect(isOutcomeUnknownMessage("an outcome_unknown mention in the middle")).toBe(false);
  });

  it("transporten kaster outcome_unknown: -> ledger `unverified`, varsel `unknown`, samme nøkkel kan ALDRI gjentas, og reconcile() lister raden", async () => {
    const t = new ScriptTransport();
    t.mutateThrows = () => new Error("outcome_unknown:leverandør svarte ikke");
    const n = new FakeNotifier();
    const g = gw(n);
    g.register(def({}, t));
    const key = nextKey("c1");
    const first = await exec(g, key);
    expect(first).toEqual({ ok: false, reason: "tool_failed:outcome_unknown:leverandør svarte ikke" });
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]).toMatchObject({ outcome: "unknown", external_id: null, idempotency_key: key, tool_id: "wpf1-gen", recovery: "manuell rutine" });
    const row = (await adminPool.query("SELECT status, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0];
    expect(row).toEqual({ status: "unverified", postcondition_reason: "postcondition_unverified:tool_timeout_outcome_unknown" });

    t.mutateThrows = null;
    const retry = await exec(g, key);
    expect(retry).toEqual({ ok: false, reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
    expect(t.mutations).toBe(1);

    const rec = await g.reconcile("tenant-a");
    const hit = rec.find((x) => x.idempotency_key === key);
    expect(hit).toMatchObject({ tool_id: "wpf1-gen", status: "unverified", reason: "postcondition_unverified:tool_timeout_outcome_unknown", recovery: "manuell rutine" });
    expect(typeof hit?.executed_at).toBe("string");
  });

  it("en vanlig leverandørfeil er `failed`: ingen varsel, retry med samme nøkkel er tillatt", async () => {
    const t = new ScriptTransport();
    t.mutateThrows = () => new Error("provider_rejected_400");
    const n = new FakeNotifier();
    const g = gw(n);
    g.register(def({}, t));
    const key = nextKey("c2");
    expect((await exec(g, key)).ok).toBe(false);
    expect(n.sent).toHaveLength(0);
    t.mutateThrows = null;
    expect((await exec(g, key)).ok).toBe(true);
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]?.outcome).toBe("executed");
  });

  it("gateway-tidsavbrudd (tool_timeout) varsler nå også med outcome=unknown", async () => {
    class Slow extends ScriptTransport {
      override async invoke(action: string): Promise<{ external_id?: string; data?: JsonValue }> {
        if (action === "mutate") { this.calls.push(action); return new Promise(() => undefined); }
        return super.invoke(action);
      }
    }
    const t = new Slow();
    const n = new FakeNotifier();
    const g = gw(n);
    g.register(def({ timeout_ms: 150 }, t));
    const key = nextKey("c3");
    const r = await exec(g, key);
    expect(r).toEqual({ ok: false, reason: "tool_failed:tool_timeout" });
    expect(n.sent.map((x) => x.outcome)).toEqual(["unknown"]);
  });
});

describe("D: notification_summary", () => {
  it("sammendraget følger varselet (avkortet), og et kastet sammendrag fjerner aldri selve varselet", async () => {
    const t = new ScriptTransport();
    const n = new FakeNotifier();
    const g = gw(n);
    g.register(def({ notification_summary: (state, params) => `fase=${(state as { phase: string }).phase} intent=${String(params["payment_intent_id"])} ${"y".repeat(500)}` }, t));
    const r = await exec(g, nextKey("d1"), { payment_intent_id: "pi-9" });
    expect(r.ok).toBe(true);
    expect(n.sent[0]?.summary?.startsWith("fase=before intent=pi-9")).toBe(true);
    expect(n.sent[0]?.summary?.length).toBeLessThanOrEqual(300);

    const t2 = new ScriptTransport();
    const n2 = new FakeNotifier();
    const g2 = gw(n2);
    g2.register(def({ tool_id: "wpf1-gen2", notification_summary: () => { throw new Error("x"); } }, t2));
    const r2 = await g2.execute({ identity, tool_id: "wpf1-gen2", action: "mutate", parameters: {}, idempotency_key: nextKey("d1b") });
    expect(r2.ok).toBe(true);
    expect(n2.sent).toHaveLength(1);
    expect(n2.sent[0]?.summary).toBeUndefined();
  });
});

describe("E: step_up_required - pengehandlinger krever eierens step-up i gatewayen selv", () => {
  const signed = (channel: IdentityContext["channel"]): IdentityContext => ({ ...identity, channel, auth_strength: "signed" });

  it("ownerStepUpDenial: kun signert enhetsøkt fra web/desktop/api/mobile (samme regel som API-rutene)", () => {
    expect([...OWNER_STEP_UP_CHANNELS].sort()).toEqual(["api", "desktop", "mobile", "web"]);
    for (const channel of ["web", "desktop", "api", "mobile"] as const) expect(ownerStepUpDenial({ auth_strength: "signed", channel })).toBeUndefined();
    for (const strength of ["active", "passive"] as const) {
      for (const channel of ["web", "desktop", "api", "mobile", "voice", "telegram"] as const) {
        expect(ownerStepUpDenial({ auth_strength: strength, channel }), `${strength}/${channel}`).toBe("step_up_required:signed_device_session");
      }
    }
    for (const channel of ["voice", "telegram", "slack", "discord", "twilio", "system", "watch"] as const) {
      expect(ownerStepUpDenial({ auth_strength: "signed", channel }), channel).toBe(`step_up_required:channel_${channel}_not_allowed`);
    }
  });

  it("uten signert enhetsøkt avvises kallet FØR noe leses eller reserveres (ingen tilstandslesing, ingen ledger-rad, ingen varsel)", async () => {
    const t = new ScriptTransport();
    const n = new FakeNotifier();
    const g = gw(n);
    g.register(def({ step_up_required: true }, t));
    const key = nextKey("e1");
    const r = await exec(g, key, {}, identity); // active + api
    expect(r).toEqual({ ok: false, reason: "step_up_required:signed_device_session" });
    expect(t.calls).toEqual([]);
    expect(n.sent).toEqual([]);
    expect((await adminPool.query("SELECT 1 FROM tool_executions WHERE idempotency_key = $1", [key])).rowCount).toBe(0);
    const audit = (await adminPool.query("SELECT reason FROM audit_events WHERE type = 'tool.denied' AND tool_id = 'wpf1-gen' ORDER BY audit_id DESC LIMIT 1")).rows[0] as { reason: string };
    expect(audit.reason).toBe("step_up_required:signed_device_session");
  });

  it("signert, men fra tale/Telegram/system/klokke/meldingsplattform: avvist; fra web/desktop/api/mobile: gjennomført", async () => {
    const t = new ScriptTransport();
    const g = gw(new FakeNotifier());
    g.register(def({ step_up_required: true }, t));
    for (const channel of ["voice", "telegram", "system", "watch", "slack", "discord", "twilio"] as const) {
      const r = await exec(g, nextKey("e2"), {}, signed(channel));
      expect(r, channel).toEqual({ ok: false, reason: `step_up_required:channel_${channel}_not_allowed` });
    }
    expect(t.mutations).toBe(0);
    for (const channel of ["web", "desktop", "api", "mobile"] as const) {
      const r = await exec(g, nextKey("e2b"), {}, signed(channel));
      expect(r.ok, channel).toBe(true);
    }
    expect(t.mutations).toBe(4);
  });

  it("flagget har INGEN effekt uten påslått klasse D-pipeline (host-akseptansescript/testhjelpere uendret) og er av som standard", async () => {
    const t = new ScriptTransport();
    const lax = new ToolGateway(appPool, policy, secrets); // ingen classDPipeline
    lax.register(def({ step_up_required: true }, t));
    expect((await exec(lax, nextKey("e3"))).ok).toBe(true);

    const t2 = new ScriptTransport();
    const g = gw(new FakeNotifier());
    g.register(def({ tool_id: "wpf1-gen-noflag" }, t2));
    expect((await g.execute({ identity, tool_id: "wpf1-gen-noflag", action: "mutate", parameters: {}, idempotency_key: nextKey("e3b") })).ok).toBe(true);
  });

  it("rekkefølge: policy-avslag kommer FØR step-up (en ikke-eier får policy-årsaken, ikke en hint om step-up)", async () => {
    const t = new ScriptTransport();
    const g = gw(new FakeNotifier());
    g.register(def({ step_up_required: true }, t));
    const guest: IdentityContext = { ...identity, person_id: "person-guest", channel: "telegram", auth_strength: "passive" };
    const r = await exec(g, nextKey("e4"), {}, guest);
    expect(r).toEqual({ ok: false, reason: "class_d_missing_approval" });
    expect(t.calls).toEqual([]);
  });
});
