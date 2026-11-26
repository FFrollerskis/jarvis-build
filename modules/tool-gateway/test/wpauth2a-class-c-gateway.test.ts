import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  ToolGateway,
  createClassCPipeline,
  type ClassCAdapter,
  type ClassCMode,
  type ToolDefinition,
  type ToolResult,
  type ToolTransport
} from "@jarvis/tool-gateway";
import { HARNESS_IDENTITY } from "./support/class-c-baseline-harness.ts";
import { startClassCTestDb, type ClassCTestDb } from "./support/class-c-test-db.ts";

/**
 * WP-AUTH2a (K1/K7): klasse C-pipelinen INNE i gatewayen, mot ekte (embedded) Postgres. Hele kjeden (modus, preflight, replay, live-recheck, readback, ledger, audit) bevises mot et syntetisk klasse C-verktøy med en
 * tilstandsfull falsk leverandør - ingen nettverk. Adaptere mot de ekte transportene (GitHub, Drive, vekst, forretning) står i `wpauth2a-class-c-adapters.test.ts`.
 */

let db: ClassCTestDb;
beforeAll(async () => { db = await startClassCTestDb(); }, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);
afterEach(() => { delete process.env["JARVIS_TOOL_CALL_ABORT"]; });

/** Tilstandsfull falsk leverandør: `read_state` leser, `mutate` endrer (kan konfigureres til å feile, henge eller ikke ha effekt). */
class StateStore implements ToolTransport {
  value = "v0";
  rev = 1;
  readonly calls: string[] = [];
  reads = 0;
  hooks: {
    onRead?: (n: number) => void;
    failRead?: (n: number) => string | undefined;
    hangRead?: (n: number) => boolean;
    noEffect?: boolean;
    mutateThrows?: string;
    hangMutate?: boolean;
  } = {};
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push(action);
    if (action === "read_state") {
      this.reads += 1;
      this.hooks.onRead?.(this.reads);
      if (this.hooks.hangRead?.(this.reads) === true) return new Promise<never>(() => undefined);
      const failure = this.hooks.failRead?.(this.reads);
      if (failure !== undefined) throw new Error(failure);
      return { data: { value: this.value, rev: this.rev } };
    }
    if (action === "mutate") {
      if (this.hooks.hangMutate === true) return new Promise<never>(() => undefined);
      if (this.hooks.mutateThrows !== undefined) throw new Error(this.hooks.mutateThrows);
      if (this.hooks.noEffect !== true) { this.value = String(parameters["value"]); this.rev += 1; }
      return { external_id: "ext-1", data: { value: this.value } };
    }
    throw new Error(`unsupported_${action}`);
  }
}

const store_of = (reads: Record<string, unknown>): { value: string; rev: number } => (reads["s"] as { data: { value: string; rev: number } }).data;

function stateAdapter(): ClassCAdapter {
  return {
    key: "gen-c.mutate",
    validate: (p) => (typeof p["target"] === "string" && p["target"] !== "" && typeof p["value"] === "string" && p["value"] !== "" ? null : "bad_params"),
    before: {
      reads: (p) => [{ id: "s", action: "read_state", parameters: { target: p["target"] ?? null } }],
      judge: (p, reads) => (store_of(reads).value === p["value"] ? { block: "no_change" } : { block: null }),
      snapshot: (_p, reads) => ({ state: { value: store_of(reads).value }, context: { rev: store_of(reads).rev } })
    },
    after: {
      reads: (p) => [{ id: "s", action: "read_state", parameters: { target: p["target"] ?? null } }],
      snapshot: (_p, _m, reads) => ({ state: { value: store_of(reads).value }, context: { rev: store_of(reads).rev } })
    },
    expect: (p) => [{ path: "value", op: "equals", value: p["value"] ?? null }],
    rollback: (p, _m, before) => ({
      kind: "compensating_action",
      steps: [{ tool_id: "gen-c", action: "mutate", parameters: { target: p["target"] ?? null, value: before.state["value"] ?? null } }],
      note: "Sett forrige verdi tilbake"
    })
  };
}

const strictParams = z.object({ target: z.string(), value: z.string() }).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

interface Rig {
  gw: ToolGateway;
  store: StateStore;
  controls: OwnerControls;
  killSwitch: KillSwitch;
  run(params?: Record<string, JsonValue>, key?: string | null, extra?: Record<string, unknown>): Promise<ToolResult>;
}

let keyCounter = 0;
function rig(mode: ClassCMode | "absent", options: { def?: Partial<ToolDefinition>; adapters?: ClassCAdapter[]; defClass?: "B" | "C" | "D" } = {}): Rig {
  const store = new StateStore();
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({
    devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch, authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-a"] }
  });
  const gw = new ToolGateway(db.appPool, policy, { name: "t", get: async () => "cred" }, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async () => undefined } },
    credentialBinding: { owner_person_id: "person-owner", owner_tenants: ["tenant-a"], internalRefs: new Set<string>() },
    ...(mode === "absent" ? {} : { classCPipeline: createClassCPipeline({ mode, adapters: options.adapters ?? [stateAdapter()] }) })
  } as never);
  gw.register({
    tool_id: "gen-c", action: "mutate", description: "syntetisk", input_schema: strictParams, capability_class: options.defClass ?? "C", scopes: ["gen:write"], reversible: true,
    rollback_procedure: "sett forrige verdi tilbake", idempotent_external: true, timeout_ms: 2_000, rate_limit_per_minute: 1_000, credential_ref: "GEN_C_TOKEN", output_trust: "internal",
    transport: store, ...(options.defClass === "D" ? { preflight_action: "read_state", preflight_requires_target: true, postcondition_predicate: () => true } : {}), ...options.def
  } as ToolDefinition);
  return {
    gw, store, controls, killSwitch,
    run: (params = { target: "t1", value: "v1" }, key, extra = {}) => {
      const idempotency_key = key === null ? undefined : (key ?? `auth2a-gw-${(keyCounter += 1)}`);
      return gw.execute({ identity: HARNESS_IDENTITY, tool_id: "gen-c", action: "mutate", parameters: params, ...(idempotency_key !== undefined ? { idempotency_key } : {}), ...extra } as never);
    }
  };
}

async function ledgerRow(key: string): Promise<{ status: string; external_id: string | null; before_state: unknown; after_state: unknown; postcondition_reason: string | null } | undefined> {
  const res = await db.adminPool.query("SELECT status, external_id, before_state, after_state, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key]);
  return res.rows[0] as never;
}
async function mark(): Promise<number> { return Number((await db.adminPool.query("SELECT COALESCE(MAX(audit_id), 0) AS m FROM audit_events")).rows[0].m); }
async function auditSince(watermark: number): Promise<Array<{ type: string; reason: string | null; payload: Record<string, unknown> }>> {
  return (await db.adminPool.query("SELECT type, reason, payload FROM audit_events WHERE audit_id > $1 AND tenant_id = 'tenant-a' ORDER BY audit_id", [watermark])).rows as never;
}
const classC = (row: { payload: Record<string, unknown> } | undefined): Record<string, any> => (row?.payload["class_c"] ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("A: modus AV (ingen pipeline-objekt, og pipeline i modus off): gatewayen oppfører seg som før", () => {
  for (const mode of ["absent", "off"] as const) {
    it(`${mode}: kun mutasjonen kalles (ingen ekstra lesinger), og audit/ledger har ingen class_c`, async () => {
      const r = rig(mode);
      const w = await mark();
      const key = `auth2a-a-${mode}`;
      const res = await r.run(undefined, key);
      expect(res).toEqual({ ok: true, external_id: "ext-1", data: { value: "v1" }, output_trust: "internal", deduplicated: false });
      expect(r.store.calls).toEqual(["mutate"]);
      expect((await auditSince(w)).map((a) => [a.type, "class_c" in a.payload])).toEqual([["tool.executed", false]]);
      expect(await ledgerRow(key)).toMatchObject({ status: "succeeded", before_state: null, after_state: null });
    });
  }
});

describe("B: observe - alt kjøres og registreres, men INGENTING blokkeres eller endres", () => {
  it("lykket kall: pre-lesing, mutasjon, readback; resultatet er uendret; snapshots i ledger; class_c i audit", async () => {
    const r = rig("observe");
    const w = await mark();
    const key = "auth2a-b-1";
    const res = await r.run(undefined, key);
    expect(res).toEqual({ ok: true, external_id: "ext-1", data: { value: "v1" }, output_trust: "internal", deduplicated: false });
    expect(r.store.calls).toEqual(["read_state", "mutate", "read_state"]);
    expect(await ledgerRow(key)).toMatchObject({
      status: "succeeded", before_state: { state: { value: "v0" }, context: { rev: 1 } }, after_state: { state: { value: "v1" }, context: { rev: 2 } }
    });
    const executed = (await auditSince(w)).find((a) => a.type === "tool.executed")!;
    expect(classC(executed)).toMatchObject({
      schema: 1, mode: "observe", adapter: "gen-c.mutate", verdict: "verified", request_digest: null, would_block: [],
      preflight: { outcome: "passed", reason: null }, diff: [{ path: "value", before: "v0", after: "v1" }], violations: [],
      rollback: { kind: "compensating_action", registered: [true], complete: true, steps: [{ tool_id: "gen-c", action: "mutate", parameters: { target: "t1", value: "v0" } }] }
    });
    expect(classC(executed)["rollback"]["ref"]).toMatch(/^crb-[0-9a-f]{16}$/);
  });

  it("preflight som VILLE blokkert: mutasjonen utføres likevel, og «ville blokkert» står i audit", async () => {
    const r = rig("observe");
    r.store.value = "v1"; // samme verdi som ønsket -> adapterens vurdering sier no_change
    const w = await mark();
    const res = await r.run();
    expect(res.ok).toBe(true);
    expect(r.store.calls).toEqual(["read_state", "mutate", "read_state"]);
    const executed = (await auditSince(w)).find((a) => a.type === "tool.executed")!;
    expect(classC(executed)["would_block"]).toEqual(["preflight:preflight_invalid:no_change"]);
  });

  it("ugyldig mål og preflight-lesing som feiler: mutasjonen utføres (som før), registrert som «ville blokkert»", async () => {
    const r = rig("observe");
    r.store.hooks.failRead = (n) => (n === 1 ? "vendor_500" : undefined);
    const w = await mark();
    expect((await r.run()).ok).toBe(true);
    const executed = (await auditSince(w)).find((a) => a.type === "tool.executed")!;
    expect(classC(executed)["would_block"][0]).toBe("preflight:preflight_failed:s:read_failed");
    const r2 = rig("observe");
    const w2 = await mark();
    expect((await r2.run({ target: "t1", value: "" })).ok).toBe(true); // schemaet tillater tom streng; adapteren ville avvist, men observe blokkerer aldri
    expect(r2.store.calls).toEqual(["mutate"]); // ingen lesing: målet var ugyldig, og uten før-tilstand finnes ingenting å lese tilbake mot
    expect(classC((await auditSince(w2)).find((a) => a.type === "tool.executed"))["would_block"]).toEqual([
      "preflight:target_invalid:bad_params", "verify:postcondition_unverified:class_c_no_baseline"
    ]);
  });

  it("mutasjon uten effekt: resultatet er fortsatt ok (observe endrer aldri status); verdikt mismatch og «ville gjort uverifisert» registreres", async () => {
    const r = rig("observe");
    r.store.hooks.noEffect = true;
    const w = await mark();
    const key = "auth2a-b-4";
    const res = await r.run(undefined, key);
    expect(res.ok).toBe(true);
    expect((await ledgerRow(key))?.status).toBe("succeeded");
    const executed = (await auditSince(w)).find((a) => a.type === "tool.executed")!;
    expect(classC(executed)).toMatchObject({ verdict: "mismatch", would_block: ["verify:postcondition_mismatch"] });
  });

  it("readback som feiler endrer ikke utfallet", async () => {
    const r = rig("observe");
    r.store.hooks.failRead = (n) => (n === 2 ? "vendor_500" : undefined);
    const key = "auth2a-b-5";
    expect((await r.run(undefined, key)).ok).toBe(true);
    expect((await ledgerRow(key))?.status).toBe("succeeded");
  });
});

describe("C: enforce - preflight-avslag FØR noe reserveres eller utføres", () => {
  it("vurderingen blokkerer: reason, ingen mutasjon, INGEN ledger-rad, audit tool.denied med class_c og policy_decision_id", async () => {
    const r = rig("enforce");
    r.store.value = "v1";
    const w = await mark();
    const key = "auth2a-c-1";
    expect(await r.run(undefined, key)).toEqual({ ok: false, reason: "class_c_preflight_invalid:no_change" });
    expect(r.store.calls).toEqual(["read_state"]);
    expect(await ledgerRow(key)).toBeUndefined();
    const denied = (await auditSince(w)).find((a) => a.type === "tool.denied")!;
    expect(denied.reason).toBe("class_c_preflight_invalid:no_change");
    expect(typeof denied.payload["policy_decision_id"]).toBe("string");
    expect(classC(denied)).toMatchObject({ mode: "enforce", verdict: "not_run", preflight: { outcome: "blocked", reason: "preflight_invalid:no_change" }, before: { state: { value: "v1" } } });
  });

  it("ugyldig mål blokkerer uten at noen lesing gjøres", async () => {
    const r = rig("enforce");
    expect(await r.run({ target: "t1", value: "" })).toEqual({ ok: false, reason: "class_c_target_invalid:bad_params" });
    expect(r.store.calls).toEqual([]);
  });

  it("preflight-lesing som feiler eller tidsavbrytes blokkerer (fail-lukket) - også med JARVIS_TOOL_CALL_ABORT=off", async () => {
    const failing = rig("enforce");
    failing.store.hooks.failRead = () => "vendor_500";
    expect(await failing.run()).toEqual({ ok: false, reason: "class_c_preflight_failed:s:read_failed" });
    expect(failing.store.calls).toEqual(["read_state"]);
    const missing = rig("enforce");
    missing.store.hooks.failRead = () => "github_api_error_404:Not Found";
    expect(await missing.run()).toEqual({ ok: false, reason: "class_c_target_not_found:s" });
    for (const abort of [undefined, "off"]) {
      if (abort !== undefined) process.env["JARVIS_TOOL_CALL_ABORT"] = abort;
      const hanging = rig("enforce", { def: { timeout_ms: 60 } });
      hanging.store.hooks.hangRead = () => true;
      expect(await hanging.run(), `abort=${abort}`).toEqual({ ok: false, reason: "class_c_preflight_failed:s:timeout" });
      expect(hanging.store.calls).toEqual(["read_state"]);
    }
  });

  it("lykket kall: som observe, men raden er `succeeded` etter en BEKREFTET etterkontroll", async () => {
    const r = rig("enforce");
    const key = "auth2a-c-4";
    expect((await r.run(undefined, key)).ok).toBe(true);
    expect(r.store.calls).toEqual(["read_state", "mutate", "read_state"]);
    expect(await ledgerRow(key)).toMatchObject({ status: "succeeded", postcondition_reason: null });
  });

  it("uten idempotensnøkkel virker pipelinen likevel (ingen ledger)", async () => {
    const r = rig("enforce");
    const w = await mark();
    expect((await r.run(undefined, null)).ok).toBe(true);
    expect(r.store.calls).toEqual(["read_state", "mutate", "read_state"]);
    expect(classC((await auditSince(w)).find((a) => a.type === "tool.executed"))["verdict"]).toBe("verified");
    const blocked = rig("enforce");
    blocked.store.value = "v1";
    expect(await blocked.run(undefined, null)).toEqual({ ok: false, reason: "class_c_preflight_invalid:no_change" });
  });
});

describe("D: enforce - etterkontrollen er sannhetsvakt (aldri suksess uten bevis), og utfallet er replay-bart", () => {
  it("mutasjon uten effekt: postcondition_mismatch, ledger `unverified`, audit tool.postcondition_unverified; samme nøkkel gir SAMME svar uten ny mutasjon", async () => {
    const r = rig("enforce");
    r.store.hooks.noEffect = true;
    const w = await mark();
    const key = "auth2a-d-1";
    expect(await r.run(undefined, key)).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect(await ledgerRow(key)).toMatchObject({ status: "unverified", postcondition_reason: "postcondition_mismatch", after_state: { state: { value: "v0" } } });
    const unverified = (await auditSince(w)).find((a) => a.type === "tool.postcondition_unverified")!;
    expect(classC(unverified)).toMatchObject({ verdict: "mismatch", violations: [{ path: "value", rule: "expected_equals", expected: "v1", actual: "v0" }] });
    expect(classC(unverified)["rollback"]["kind"]).toBe("compensating_action");
    const callsBefore = r.store.calls.length;
    expect(await r.run(undefined, key)).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect(r.store.calls.length).toBe(callsBefore); // ingen ny lesing og ingen ny mutasjon
    expect(r.store.calls.filter((c) => c === "mutate").length).toBe(1);
  });

  it("readback som feiler gir postcondition_unverified:readback_failed; en readback som ikke finnes gir target_missing", async () => {
    const failing = rig("enforce");
    failing.store.hooks.failRead = (n) => (n === 2 ? "vendor_500" : undefined);
    const k1 = "auth2a-d-2";
    expect(await failing.run(undefined, k1)).toEqual({ ok: false, reason: "postcondition_unverified:readback_failed" });
    expect((await ledgerRow(k1))?.status).toBe("unverified");
    const missing = rig("enforce");
    missing.store.hooks.failRead = (n) => (n === 2 ? "drive_not_found_x" : undefined);
    expect(await missing.run(undefined, "auth2a-d-3")).toEqual({ ok: false, reason: "postcondition_unverified:target_missing" });
  });

  it("replay etter bekreftet suksess: deduplicated, ingen nye lesinger (preflight hoppes over, ikke blokkert av at tilstanden har flyttet seg)", async () => {
    const r = rig("enforce");
    const key = "auth2a-d-4";
    expect((await r.run(undefined, key)).ok).toBe(true);
    const calls = [...r.store.calls];
    const again = await r.run(undefined, key);
    expect(again).toMatchObject({ ok: true, deduplicated: true });
    expect(r.store.calls).toEqual(calls);
  });

  it("feilet mutasjon (leverandørfeil): ledger `failed`, class_c i tool.failed (før-snapshot), og retry med samme nøkkel kjører preflight på nytt og lykkes", async () => {
    const r = rig("enforce");
    r.store.hooks.mutateThrows = "vendor_500";
    const w = await mark();
    const key = "auth2a-d-5";
    expect(await r.run(undefined, key)).toEqual({ ok: false, reason: "tool_failed:vendor_500" });
    expect((await ledgerRow(key))?.status).toBe("failed");
    const failed = (await auditSince(w)).find((a) => a.type === "tool.failed")!;
    expect(classC(failed)).toMatchObject({ mode: "enforce", verdict: "not_run", preflight: { outcome: "passed" }, before: { state: { value: "v0" } } });
    delete r.store.hooks.mutateThrows;
    expect((await r.run(undefined, key)).ok).toBe(true);
    expect(r.store.calls).toEqual(["read_state", "mutate", "read_state", "mutate", "read_state"]);
    expect((await ledgerRow(key))?.status).toBe("succeeded");
  });

  it("mutasjon som tidsavbrytes er fortsatt `unverified` (utfall ukjent), ikke feilet, og uten readback", async () => {
    const r = rig("enforce", { def: { timeout_ms: 60 } });
    r.store.hooks.hangMutate = true;
    const key = "auth2a-d-6";
    expect(await r.run(undefined, key)).toEqual({ ok: false, reason: "tool_failed:tool_timeout" });
    expect(await ledgerRow(key)).toMatchObject({ status: "unverified", postcondition_reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
    expect(r.store.calls).toEqual(["read_state", "mutate"]);
  });
});

describe("E: eier-overstyring respekteres også ETTER pipelinens lesinger (live-recheck rett før utførelsen)", () => {
  const cases: Array<[string, (r: Rig) => void, string]> = [
    ["frys", (r) => r.controls.freezeConnector("gen-c"), "connector_frozen"],
    ["tilbakekalt credential", (r) => r.controls.revokeCredential("GEN_C_TOKEN"), "credential_revoked"],
    ["global pause (kill switch)", (r) => r.killSwitch.activate("test"), "kill_switch_active"]
  ];
  for (const mode of ["observe", "enforce"] as const) {
    for (const [label, trigger, reason] of cases) {
      it(`${mode}: ${label} som slår inn under preflight-lesingen stopper mutasjonen og frigir reservasjonen`, async () => {
        const r = rig(mode);
        r.store.hooks.onRead = (n) => { if (n === 1) trigger(r); };
        const key = `auth2a-e-${mode}-${reason}`;
        expect(await r.run(undefined, key)).toEqual({ ok: false, reason });
        expect(r.store.calls).toEqual(["read_state"]);
        expect(await ledgerRow(key)).toMatchObject({ status: "failed", postcondition_reason: `recheck_${reason}` });
      });
    }
  }
  it("uten idempotensnøkkel stopper samme sjekk mutasjonen (ingen ledger å frigi)", async () => {
    const r = rig("enforce");
    r.store.hooks.onRead = (n) => { if (n === 1) r.controls.freezeConnector("gen-c"); };
    expect(await r.run(undefined, null)).toEqual({ ok: false, reason: "connector_frozen" });
    expect(r.store.calls).toEqual(["read_state"]);
  });
  it("er ingen overstyring slått inn, utføres mutasjonen (rechecken er ikke en ny barriere)", async () => {
    const r = rig("enforce");
    expect((await r.run()).ok).toBe(true);
  });
});

describe("F: avgrensning - pipelinen engasjeres kun for klasse C med adapter, og erstatter den gamle preflight-lesingen", () => {
  it("verktøy uten adapter: uendret oppførsel (ingen lesing) selv i enforce", async () => {
    const r = rig("enforce", { adapters: [{ ...stateAdapter(), key: "other.thing" }] });
    expect((await r.run()).ok).toBe(true);
    expect(r.store.calls).toEqual(["mutate"]);
  });

  it("klasse B og D engasjeres aldri, selv om en adapter har samme nøkkel", async () => {
    for (const defClass of ["B", "D"] as const) {
      const r = rig("enforce", { defClass });
      expect((await r.run()).ok, defClass).toBe(true);
      expect(r.store.calls, defClass).toEqual(defClass === "D" ? ["read_state", "mutate", "read_state"] : ["mutate"]);
    }
  });

  it("gammel preflight_action + adapter: ingen doble lesinger, og ledgerens før-snapshot er pipelinens (ikke den rå lesingen)", async () => {
    for (const mode of ["observe", "enforce"] as const) {
      const r = rig(mode, { def: { preflight_action: "read_state" } });
      const key = `auth2a-f-${mode}`;
      expect((await r.run(undefined, key)).ok).toBe(true);
      expect(r.store.calls, mode).toEqual(["read_state", "mutate", "read_state"]);
      expect(await ledgerRow(key)).toMatchObject({ before_state: { state: { value: "v0" } }, after_state: { state: { value: "v1" } } });
    }
  });

  it("flagg AV med gammel preflight_action: den gamle lesingen og rå før-/etter-tilstand er bevart (uendret)", async () => {
    const r = rig("off", { def: { preflight_action: "read_state" } });
    const key = "auth2a-f-off";
    expect((await r.run(undefined, key)).ok).toBe(true);
    expect(r.store.calls).toEqual(["read_state", "mutate", "read_state"]);
    expect(await ledgerRow(key)).toMatchObject({ before_state: { value: "v0", rev: 1 }, after_state: { value: "v1", rev: 2 } });
  });

  it("request_digest (WP-T1) tas inn via FELT på forespørselen: kun gyldig SHA-256 når audit", async () => {
    const digest = "cd".repeat(32);
    const r = rig("observe");
    const w = await mark();
    await r.run(undefined, "auth2a-f-digest-1", { request_digest: digest });
    await r.run(undefined, "auth2a-f-digest-2", { request_digest: "ikke-en-digest" });
    const rows = (await auditSince(w)).filter((a) => a.type === "tool.executed");
    expect(rows.map((a) => classC(a)["request_digest"])).toEqual([digest, null]);
  });

  it("rollback-trinn er merket utførbart bare for verktøy som finnes i registeret", async () => {
    const r = rig("observe", { adapters: [{ ...stateAdapter(), rollback: (p, _m, before) => ({ kind: "compensating_action", steps: [{ tool_id: "gen-c", action: "finnes_ikke", parameters: { target: p["target"] ?? null, value: before.state["value"] ?? null } }], note: "x" }) }] });
    const w = await mark();
    await r.run();
    const executed = (await auditSince(w)).find((a) => a.type === "tool.executed")!;
    expect(classC(executed)["rollback"]["registered"]).toEqual([false]);
  });

  it("pipelinen kaster aldri ut til kalleren: en adapter som feiler i alle faser gir en vanlig, fail-lukket avvisning (enforce) og et vanlig utført kall (observe)", async () => {
    const boom = (): never => { throw new Error("adapter_bug"); };
    const broken: ClassCAdapter = { ...stateAdapter(), before: { ...stateAdapter().before, judge: boom }, after: { ...stateAdapter().after, snapshot: boom } };
    const e = rig("enforce", { adapters: [broken] });
    expect((await e.run()).ok).toBe(false);
    expect(e.store.calls).toEqual(["read_state"]);
    const o = rig("observe", { adapters: [broken] });
    expect((await o.run()).ok).toBe(true);
  });
});
