import { z } from "zod";
import type pg from "pg";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  ToolGateway,
  firstWaveTools,
  type ClassDNotification,
  type ClassDNotifier,
  type SecretProvider,
  type ToolDefinition,
  type ToolGatewayOptions,
  type ToolResult,
  type ToolTransport
} from "@jarvis/tool-gateway";

/**
 * WP-AUTH2a (K7): harness for «flagg AV er identisk med main». Kjører en fast liste scenarier gjennom `ToolGateway.execute()` mot en ekte (embedded) Postgres og observerer ALT som kan sees utenfra:
 * resultatet av hvert kall, rekkefølgen av transportkall (handling + parametre), radene i `tool_executions` (ledgeren) og radene i `audit_events` (type, avgjørelse, årsak, klasse, payload).
 *
 * Harnessen bruker KUN API som finnes på main (ingen import av klasse C-pipelinen), slik at ÉN og samme kode både genererer baseline fra en ren main og sammenligner den endrede gatewayen mot den.
 * Volatile verdier (policy-avgjørelsens ID) normaliseres; alt annet sammenlignes eksakt. Scenariosettet er KILDEN - nye scenarier legges til her og baseline regenereres (se `wpauth2a-flag-off-differential.test.ts`).
 */

export interface Observation {
  id: string;
  results: unknown[];
  calls: Array<{ transport: string; action: string; parameters: JsonValue }>;
  ledger: unknown[];
  audit: unknown[];
}

export interface HarnessDeps {
  adminPool: pg.Pool;
  appPool: pg.Pool;
}

export const HARNESS_IDENTITY: IdentityContext = {
  person_id: "person-owner", tenant_id: "tenant-a", memory_space_id: "home",
  session_id: "sess-baseline", device_id: "dev-baseline", channel: "api", auth_strength: "active"
};

/** Skriptet transport: loggfører hvert kall og svarer fra et skript per handling (liste av svar, siste gjentas). `hang` = svarer aldri (tidsavbrudd). */
type Reply = { external_id?: string; data?: JsonValue } | { throw: string } | "hang";
export class ScriptedTransport implements ToolTransport {
  readonly calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  private readonly counters = new Map<string, number>();
  constructor(readonly name: string, private readonly script: Record<string, Reply[]>) {}
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });
    const list = this.script[action] ?? [{ external_id: "ext-default" }];
    const index = this.counters.get(action) ?? 0;
    this.counters.set(action, index + 1);
    const reply = list[Math.min(index, list.length - 1)]!;
    if (reply === "hang") return new Promise<never>(() => undefined);
    if ("throw" in reply) throw new Error(reply.throw);
    return reply;
  }
}

class FakeNotifier implements ClassDNotifier {
  sent: ClassDNotification[] = [];
  ready() { return true; }
  async notify(n: ClassDNotification) { this.sent.push(n); }
}

const strictTarget = z.object({ target: z.string() }).strict() as unknown as z.ZodType<Record<string, JsonValue>>;
const looseRecord = z.object({}).passthrough() as unknown as z.ZodType<Record<string, JsonValue>>;

function syntheticDef(over: Partial<ToolDefinition> & Pick<ToolDefinition, "capability_class" | "transport">): ToolDefinition {
  return {
    tool_id: "gen-c", action: "mutate", description: "syntetisk", input_schema: looseRecord, scopes: ["gen:write"], reversible: true,
    rollback_procedure: "rull tilbake manuelt", idempotent_external: false, timeout_ms: 2_000, rate_limit_per_minute: 1_000,
    credential_ref: "GEN_C_TOKEN", output_trust: "internal", ...over
  };
}

interface Env {
  /** Bygger en gateway med produksjonslignende options pluss scenariospesifikke (frys, hemmelighet, kill switch). */
  make(opts?: { frozen?: string; revoke?: string; killSwitch?: boolean; noCredential?: boolean }): ToolGateway;
  transports: ScriptedTransport[];
  results: unknown[];
  run(gw: ToolGateway, request: { tool_id: string; action: string; parameters: Record<string, JsonValue>; idempotency_key?: string }): Promise<ToolResult>;
}

interface Scenario { id: string; run(env: Env): Promise<void> }

const KEY = (id: string, n = 1) => `${id}#k${n}`;

export const SCENARIOS: Scenario[] = [
  {
    id: "c.create.ok",
    async run(env) {
      const t = env.transports[0]!;
      const gw = env.make();
      gw.register(syntheticDef({ capability_class: "C", transport: t }));
      const key = KEY("c.create.ok");
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: key });
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: key });
    }
  },
  {
    id: "c.nokey.ok",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({ capability_class: "C", transport: env.transports[0]! }));
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" } });
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" } });
    }
  },
  {
    id: "c.preflight.ok",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({ capability_class: "C", transport: env.transports[0]!, preflight_action: "read_state" }));
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: KEY("c.preflight.ok") });
    }
  },
  {
    id: "c.preflight.throws",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({ capability_class: "C", transport: env.transports[0]!, preflight_action: "read_state" }));
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: KEY("c.preflight.throws") });
    }
  },
  {
    id: "c.preflight.null",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({ capability_class: "C", transport: env.transports[0]!, preflight_action: "read_state" }));
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: KEY("c.preflight.null") });
    }
  },
  {
    id: "c.mutation.fails_then_retry",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({ capability_class: "C", transport: env.transports[0]! }));
      const key = KEY("c.mutation.fails_then_retry");
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: key });
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: key });
    }
  },
  {
    id: "c.mutation.timeout_then_replay",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({ capability_class: "C", transport: env.transports[0]!, timeout_ms: 40 }));
      const key = KEY("c.mutation.timeout_then_replay");
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: key });
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: key });
    }
  },
  {
    id: "c.invalid_params",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({ capability_class: "C", transport: env.transports[0]!, input_schema: strictTarget }));
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { wrong: 1 }, idempotency_key: KEY("c.invalid_params") });
    }
  },
  {
    id: "c.credential_missing",
    async run(env) {
      const gw = env.make({ noCredential: true });
      gw.register(syntheticDef({ capability_class: "C", transport: env.transports[0]! }));
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: KEY("c.credential_missing") });
    }
  },
  {
    id: "c.frozen",
    async run(env) {
      const gw = env.make({ frozen: "gen-c" });
      gw.register(syntheticDef({ capability_class: "C", transport: env.transports[0]! }));
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: KEY("c.frozen") });
    }
  },
  {
    id: "c.revoked",
    async run(env) {
      const gw = env.make({ revoke: "GEN_C_TOKEN" });
      gw.register(syntheticDef({ capability_class: "C", transport: env.transports[0]! }));
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: KEY("c.revoked") });
    }
  },
  {
    id: "c.kill_switch",
    async run(env) {
      const gw = env.make({ killSwitch: true });
      gw.register(syntheticDef({ capability_class: "C", transport: env.transports[0]! }));
      await env.run(gw, { tool_id: "gen-c", action: "mutate", parameters: { target: "a" }, idempotency_key: KEY("c.kill_switch") });
    }
  },
  {
    id: "d.chain.ok",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({
        tool_id: "gen-d", capability_class: "D", transport: env.transports[0]!, preflight_action: "read_state", preflight_requires_target: true,
        postcondition_predicate: (after) => (after as { v?: number } | null)?.v === 2
      }));
      await env.run(gw, { tool_id: "gen-d", action: "mutate", parameters: { target: "a" }, idempotency_key: KEY("d.chain.ok") });
    }
  },
  {
    id: "d.validator.invalid",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({
        tool_id: "gen-d", capability_class: "D", transport: env.transports[0]!, preflight_action: "read_state", preflight_requires_target: true,
        preflight_validator: () => "bad_state", postcondition_predicate: () => true
      }));
      await env.run(gw, { tool_id: "gen-d", action: "mutate", parameters: { target: "a" }, idempotency_key: KEY("d.validator.invalid") });
    }
  },
  {
    id: "d.postcondition.mismatch",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({
        tool_id: "gen-d", capability_class: "D", transport: env.transports[0]!, preflight_action: "read_state", preflight_requires_target: true,
        postcondition_predicate: () => false
      }));
      await env.run(gw, { tool_id: "gen-d", action: "mutate", parameters: { target: "a" }, idempotency_key: KEY("d.postcondition.mismatch") });
    }
  },
  {
    id: "a.read.ok",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({ tool_id: "gen-a", action: "read", capability_class: "A", transport: env.transports[0]!, reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true }));
      await env.run(gw, { tool_id: "gen-a", action: "read", parameters: { target: "a" } });
    }
  },
  {
    id: "b.write.ok",
    async run(env) {
      const gw = env.make();
      gw.register(syntheticDef({ tool_id: "gen-b", capability_class: "B", transport: env.transports[0]! }));
      await env.run(gw, { tool_id: "gen-b", action: "mutate", parameters: { target: "a" }, idempotency_key: KEY("b.write.ok") });
    }
  },
  {
    id: "prod.github.create_pr",
    async run(env) {
      const gw = env.make();
      const def = firstWaveTools({ github: env.transports[0]! }).find((d) => d.tool_id === "github" && d.action === "create_pr")!;
      gw.register(def);
      await env.run(gw, { tool_id: "github", action: "create_pr", parameters: { repo: "owner/repo", branch: "feature/x", title: "Endring", base: "main" }, idempotency_key: KEY("prod.github.create_pr") });
    }
  },
  {
    id: "prod.drive.rename",
    async run(env) {
      const gw = env.make();
      const def = firstWaveTools({ drive: env.transports[0]! }).find((d) => d.tool_id === "drive" && d.action === "rename")!;
      gw.register(def);
      await env.run(gw, { tool_id: "drive", action: "rename", parameters: { file_id: "f1", new_name: "nytt" }, idempotency_key: KEY("prod.drive.rename") });
    }
  },
  {
    id: "prod.drive.trash_fails",
    async run(env) {
      const gw = env.make();
      const def = firstWaveTools({ drive: env.transports[0]! }).find((d) => d.tool_id === "drive" && d.action === "trash")!;
      gw.register(def);
      await env.run(gw, { tool_id: "drive", action: "trash", parameters: { file_id: "f1" }, idempotency_key: KEY("prod.drive.trash_fails") });
    }
  },
  {
    id: "prod.vercel.rollback_deployment",
    async run(env) {
      const gw = env.make();
      const def = firstWaveTools({ vercel: env.transports[0]! }).find((d) => d.tool_id === "vercel" && d.action === "rollback_deployment")!;
      gw.register(def);
      await env.run(gw, { tool_id: "vercel", action: "rollback_deployment", parameters: { project: "p1", deployment_id: "dpl_1" }, idempotency_key: KEY("prod.vercel.rollback_deployment") });
    }
  },
  {
    id: "prod.business.update_lead_status",
    async run(env) {
      const gw = env.make();
      const def = firstWaveTools({ business: env.transports[0]! }).find((d) => d.tool_id === "business" && d.action === "update_lead_status")!;
      gw.register(def);
      await env.run(gw, { tool_id: "business", action: "update_lead_status", parameters: { tenant_id: "tenant-a", lead_id: "lead-1", status: "qualified" }, idempotency_key: KEY("prod.business.update_lead_status") });
    }
  },
  {
    id: "prod.growth.set_campaign_status",
    async run(env) {
      const gw = env.make();
      const def = firstWaveTools({ growth: env.transports[0]! }).find((d) => d.tool_id === "growth" && d.action === "set_campaign_status")!;
      gw.register(def);
      await env.run(gw, { tool_id: "growth", action: "set_campaign_status", parameters: { tenant_id: "tenant-a", campaign_id: "camp-1", status: "paused" }, idempotency_key: KEY("prod.growth.set_campaign_status") });
    }
  }
];

/** Transportskript per scenario (indeks 0 = hovedtransporten). */
const SCRIPTS: Record<string, Record<string, Reply[]>> = {
  "c.create.ok": { mutate: [{ external_id: "ext-1", data: { n: 1 } }] },
  "c.nokey.ok": { mutate: [{ external_id: "ext-1" }, { external_id: "ext-2" }] },
  "c.preflight.ok": { read_state: [{ data: { v: 1 } }, { data: { v: 2 } }], mutate: [{ external_id: "ext-1", data: { changed: true } }] },
  "c.preflight.throws": { read_state: [{ throw: "read_failed" }], mutate: [{ external_id: "ext-1" }] },
  "c.preflight.null": { read_state: [{}], mutate: [{ external_id: "ext-1" }] },
  "c.mutation.fails_then_retry": { mutate: [{ throw: "vendor_500" }, { external_id: "ext-9" }] },
  "c.mutation.timeout_then_replay": { mutate: ["hang"] },
  "c.invalid_params": { mutate: [{ external_id: "never" }] },
  "c.credential_missing": { mutate: [{ external_id: "never" }] },
  "c.frozen": { mutate: [{ external_id: "never" }] },
  "c.revoked": { mutate: [{ external_id: "never" }] },
  "c.kill_switch": { mutate: [{ external_id: "never" }] },
  "d.chain.ok": { read_state: [{ data: { v: 1 } }, { data: { v: 2 } }], mutate: [{ external_id: "ext-d" }] },
  "d.validator.invalid": { read_state: [{ data: { v: 1 } }], mutate: [{ external_id: "never" }] },
  "d.postcondition.mismatch": { read_state: [{ data: { v: 1 } }, { data: { v: 1 } }], mutate: [{ external_id: "ext-d" }] },
  "a.read.ok": { read: [{ data: { rows: [1, 2] } }] },
  "b.write.ok": { mutate: [{ external_id: "ext-b" }] },
  "prod.github.create_pr": { create_pr: [{ external_id: "7", data: { number: "7", html_url: "https://example.invalid/pr/7", created: true } }] },
  "prod.drive.rename": {
    get_metadata: [
      { data: { id: "f1", name: "gammelt", mimeType: "text/plain", trashed: false, parents: ["p1"], headRevisionId: "r1", modifiedTime: "2026-01-01T00:00:00.000Z" } },
      { data: { id: "f1", name: "nytt", mimeType: "text/plain", trashed: false, parents: ["p1"], headRevisionId: "r1", modifiedTime: "2026-01-01T00:00:01.000Z" } }
    ],
    rename: [{ external_id: "f1", data: { id: "f1", name: "nytt" } }]
  },
  "prod.drive.trash_fails": {
    get_metadata: [{ data: { id: "f1", name: "a", mimeType: "text/plain", trashed: false, parents: [], headRevisionId: null, modifiedTime: null } }],
    trash: [{ throw: "drive_not_found_f1" }]
  },
  "prod.vercel.rollback_deployment": { rollback_deployment: [{ external_id: "rollback:dpl_1" }] },
  "prod.business.update_lead_status": {
    inspect_lead: [{ data: { lead_id: "lead-1", status: "new" } }, { data: { lead_id: "lead-1", status: "qualified" } }],
    update_lead_status: [{ external_id: "lead-1", data: { lead_id: "lead-1", status: "qualified" } }]
  },
  "prod.growth.set_campaign_status": { set_campaign_status: [{ external_id: "camp-1", data: { campaign_id: "camp-1", status: "paused" } }] }
};

const VOLATILE_KEYS = new Set(["policy_decision_id"]);
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, VOLATILE_KEYS.has(k) && typeof v === "string" ? "<id>" : normalise(v)]));
  }
  return value;
}

/** `extraOptions` lar differensialtesten legge til varianter (f.eks. en gateway med pipelinen konstruert i modus «off»); baseline genereres UTEN (kun main-API). */
export async function runScenarios(deps: HarnessDeps, extraOptions: (() => Partial<ToolGatewayOptions>) | undefined = undefined, only: readonly string[] | undefined = undefined): Promise<Observation[]> {
  const out: Observation[] = [];
  // Samme DB kan kjøre flere varianter etter hverandre: ledgeren tømmes først, ellers ville en senere variant se `deduplicated` fra en tidligere (nøklene er stabile per scenario). Audit-loggen er append-only og avgrenses med vannmerke.
  await deps.adminPool.query("DELETE FROM tool_executions");
  for (const scenario of SCENARIOS) {
    if (only !== undefined && !only.includes(scenario.id)) continue;
    const transports = [new ScriptedTransport(scenario.id, SCRIPTS[scenario.id] ?? {})];
    const results: unknown[] = [];
    const notifier = new FakeNotifier();
    const env: Env = {
      transports, results,
      make(opts = {}) {
        const killSwitch = new KillSwitch();
        if (opts.killSwitch === true) killSwitch.activate("baseline");
        const controls = new OwnerControls(killSwitch);
        if (opts.frozen !== undefined) controls.freezeConnector(opts.frozen);
        if (opts.revoke !== undefined) controls.revokeCredential(opts.revoke);
        const policy = new PolicyGateway({
          devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch, authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-a"] }
        });
        const secrets: SecretProvider = { name: "baseline", get: async () => (opts.noCredential === true ? null : "cred") };
        return new ToolGateway(deps.appPool, policy, secrets, controls, undefined, {
          classDPipeline: { enforce: true, notifier },
          credentialBinding: { owner_person_id: "person-owner", owner_tenants: ["tenant-a"], internalRefs: new Set(["JARVIS_BUSINESS_INTERNAL_TOKEN"]) },
          ...(extraOptions ? extraOptions() : {})
        });
      },
      async run(gw, request) {
        const result = await gw.execute({ identity: HARNESS_IDENTITY, ...request });
        results.push(normalise(result));
        return result;
      }
    };
    const watermark = Number((await deps.adminPool.query("SELECT COALESCE(MAX(audit_id), 0) AS m FROM audit_events")).rows[0].m);
    await scenario.run(env);
    const prefix = `${scenario.id}#`;
    const ledger = (await deps.adminPool.query(
      `SELECT idempotency_key, tool_id, action, external_id, status, before_state, after_state, postcondition_reason
         FROM tool_executions WHERE idempotency_key LIKE $1 ORDER BY idempotency_key`, [`${prefix.replace(/[%_]/g, "\\$&")}%`]
    )).rows;
    const audit = (await deps.adminPool.query(
      `SELECT type, decision, reason, tool_id, action, capability_class, payload FROM audit_events WHERE audit_id > $1 AND tenant_id = 'tenant-a' ORDER BY audit_id`, [watermark]
    )).rows;
    out.push({
      id: scenario.id,
      results,
      calls: transports.flatMap((t) => t.calls.map((c) => ({ transport: t.name, action: c.action, parameters: c.parameters as JsonValue }))),
      ledger: ledger.map((r) => normalise(r)) as unknown[],
      audit: audit.map((r) => normalise(r)) as unknown[]
    });
  }
  return out;
}
