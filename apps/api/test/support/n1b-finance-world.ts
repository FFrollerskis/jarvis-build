import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import {
  BusinessService, BusinessTransport, OpenLoopService
} from "@jarvis/business";
import { PgApprovalStore } from "@jarvis/core";
import { ConversationGraphService, ConversationGraphTransport } from "@jarvis/conversation-graph";
import {
  ExecutiveService, ExecutiveTransport, VALUE_METRIC_CATALOG, composeSloReport, executiveToolDefinitions,
  type ControlCenterRegistry, type ExecutiveServiceOptions, type ObservationReader, type ValueMeasurement, type ValueRuntimeFacts
} from "@jarvis/executive";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, firstWaveTools, type FinanceExecutionLock, type ToolDefinition, type ToolGatewayOptions } from "@jarvis/tool-gateway";
import { z } from "zod";
import { createControlCenterRegistry, registerControlCenters } from "../../src/control-center/register.ts";
import { FINANCE_EXECUTION_LOCK, financeLockServedLocally } from "../../src/restricted-context-guard.ts";
import { RunRateService, RunRateTransport, runRateToolDefinitions } from "../../src/run-rate.ts";

/**
 * WP-N1b (K2/K4c): ÉN felles testverden for kartleggingen av avledet finansmetadata utenfor `finance*`-låsen. Ekte Postgres (app-rolle, RLS), ekte `ToolGateway` + `PolicyGateway`, ekte `BusinessTransport`/`OpenLoopService`,
 * ekte `ExecutiveService`/`ExecutiveTransport`, ekte `RunRateService` - kun de NØSTEDE kildene (`situations.*`, `owner_controls.get_control_state`) og de injiserte rapportkildene (SLO, AI Mesh, evolusjon, selvmodell, verdi)
 * er enkle leverandører som gir realistiske data med UNIKE MARKØRSTRENGER i finansdelen, slik at «holdt tilbake» kan bevises som at markørene ikke finnes i svaret til en skymodell (og finnes for lokal modell og eieren).
 */
export const TENANT = "tenant-n1b-table";
export const OWNER = "person-n1b-owner";
export const identity: IdentityContext = { person_id: OWNER, tenant_id: TENANT, memory_space_id: "business", session_id: "sess-n1b", device_id: "dev-n1b", channel: "web", auth_strength: "signed" };

export const CLOUD = { provider: "anthropic", model: "claude-sonnet-5-5" } as const;
export const UNKNOWN_MODEL = { provider: "ukjent-leverandor", model: "x" } as const;
export const BLANK_MODEL = { provider: "", model: "x" } as const;
export const LOCAL = { provider: "gemma_local", model: "gemma3:4b" } as const;
export type ModelArg = { provider: string; model: string } | undefined;

/** Markørstrenger: finansavledet innhold (skal IKKE nå en sky-/ukjent modell) og vanlig innhold (skal bli stående). */
export const FIN = {
  spendCategory: "N1B-KATEGORI-SPEND", spendId: "N1B-SPENDID-1", purpose: "N1B-FORMAL-LEIE", vendor: "N1B-LEVERANDOR-ALFA", amount: "98 765,00",
  bankConsent: "N1B-BANK-SAMTYKKE", campaign: "N1B-KAMPANJE-X", killReason: "N1B-KILLSWITCH-BEGRUNNELSE-KORT", frozenReason: "N1B-FRYS-BEGRUNNELSE-VIPPS",
  jobFailure: "N1B-STRIPE-JOBB-FEIL", costOre: "13579", driftCost: "N1B-KOSTNAD-PER-KALL", meshCost: "24680", evolutionCost: "N1B-EV16-KOSTMODELL", policyParam: "N1B-POLICY-PARAM"
} as const;
export const KEEP = { followup: "N1B-KUNDE-BETA", ticket: "N1B-SAK-7", github: "N1B-GITHUB-FRYS", reasonOk: "N1B-GITHUB-BEGRUNNELSE" } as const;

export const LOOP_IDS = { fin1: "loop-fin-1", fin2: "loop-fin-2", fin3: "loop-fin-3", fin4: "loop-fin-4", ok1: "loop-ok-1", ok2: "loop-ok-2" } as const;

/** Sår finans- og ikke-finans-løkker (åpne) i `business_open_loops` (admin-pool omgår RLS - kun til testdata). */
export async function seedOpenLoops(admin: pg.Pool): Promise<void> {
  const rows: Array<[string, string, string, string, string]> = [
    [LOOP_IDS.fin1, "finance_spend_unexpected", `Utgift på ${FIN.amount} NOK (${FIN.spendCategory}) skjedde etter at en tilknyttet forpliktelse ble satt på pause`, `Gjennomgå uventet utgift ${FIN.spendId}`, "high"],
    [LOOP_IDS.fin2, "payment_intent_anomaly", `Betalingsintensjon "${FIN.purpose}" (${FIN.amount} NOK til ${FIN.vendor}) har uløste avvik: MISSING_REF`, "Løs avvik før innsending", "normal"],
    [LOOP_IDS.fin3, "bank_consent_attention", `Banksamtykket ${FIN.bankConsent} utløper snart`, "Forny samtykket", "normal"],
    [LOOP_IDS.fin4, "marketing_spend_anomaly", `Kampanje "${FIN.campaign}" sin utgift (1 234,00 NOK) er vesentlig over snittet`, "Gjennomgå utgiftsavvik", "normal"],
    [LOOP_IDS.ok1, "overdue_followup", `Følg opp ${KEEP.followup} før fredag`, "Ring kunden", "normal"],
    [LOOP_IDS.ok2, "support_ticket_overdue", `Sak ${KEEP.ticket} mangler svar`, "Svar kunden", "high"]
  ];
  for (const [id, type, reason, next, priority] of rows) {
    await admin.query(
      `INSERT INTO business_open_loops (open_loop_id, tenant_id, memory_space_id, loop_type, detection_key, reason, next_action, priority, status, opened_at)
       VALUES ($1, $2, 'business', $3, $4, $5, $6, $7, 'open', now() - interval '2 days')`,
      [id, TENANT, type, `${type}:${id}`, reason, next, priority]
    );
  }
  // en LØST finanssløkke i uken som gikk (ukebriefens by_type/still_open skal ikke bære den for sky)
  await admin.query(
    `INSERT INTO business_open_loops (open_loop_id, tenant_id, memory_space_id, loop_type, detection_key, reason, next_action, priority, status, opened_at, resolved_at, resolution_outcome)
     VALUES ('loop-fin-resolved', $1, 'business', 'payment_intent_reconciliation_mismatch', 'payment_intent_reconciliation_mismatch:loop-fin-resolved', $2, NULL, 'high', 'resolved', now() - interval '3 days', now() - interval '1 day', 'acted')`,
    [TENANT, `Betaling til ${FIN.vendor} avstemt som IKKE samsvarende`]
  );
}

export const CONTACT_ID = "contact-n1b-1";
export const IDENTITY_ID = "ident-n1b-1";

/**
 * Samtalegrafen (R21): en kontakt med en aktiv identitet og en e-postkanal, og tre av de seede løkkene (to finans, en vanlig) knyttet til kontakten - slik at identitetsvisningen (`read_cross_channel_commitment_view`) og den
 * tenant-brede køen (`read_cross_channel_attention`) begge har finansavledede og vanlige forpliktelser å skille mellom. Kjøres ETTER `seedOpenLoops` (admin-pool omgår RLS - kun testdata).
 */
export async function seedConversationGraph(admin: pg.Pool): Promise<void> {
  await admin.query("INSERT INTO business_contacts (contact_id, tenant_id, memory_space_id, name, email) VALUES ($1, $2, 'business', 'Kari Kunde', 'kari@example.test')", [CONTACT_ID, TENANT]);
  await admin.query("INSERT INTO conversation_identities (identity_id, tenant_id, memory_space_id, display_name, linked_business_contact_id, status) VALUES ($1, $2, 'business', 'Kari Kunde', $3, 'active')", [IDENTITY_ID, TENANT, CONTACT_ID]);
  await admin.query("INSERT INTO conversation_channel_links (link_id, tenant_id, memory_space_id, identity_id, channel, channel_identifier, confidence, match_method, status) VALUES ('link-n1b-1', $1, 'business', $2, 'email', 'kari@example.test', 1, 'exact_email', 'active')", [TENANT, IDENTITY_ID]);
  await admin.query("UPDATE business_open_loops SET contact_id = $1 WHERE tenant_id = $2 AND open_loop_id = ANY($3::text[])", [CONTACT_ID, TENANT, [LOOP_IDS.fin1, LOOP_IDS.fin2, LOOP_IDS.ok1]]);
}

export function fakeDef(tool_id: string, action: string, data: unknown): ToolDefinition {
  return {
    tool_id, action, description: "fake", input_schema: z.record(z.any()) as never, capability_class: "A", scopes: [], reversible: true, rollback_procedure: "ingen", idempotent_external: true,
    timeout_ms: 8000, rate_limit_per_minute: 100000, credential_ref: "", output_trust: "trusted", transport: { async invoke() { return { data: data as never }; } }
  };
}

/** Realistiske `Situation`-rader (formen `situations.get_queue` leverer): to `spend` (finansavledet, begrunnelsen fra løkken) og to andre. */
export function situationRows(): unknown[] {
  const base = { tenant_id: TENANT, memory_space_id: "business", owner_person_id: null, stage: "inform", confidence: 0.9, status: "open", last_notified_at: null, act_tool_id: null, act_action: null, act_result: null, act_idempotency_key: null, act_claimed_at: null, act_operation_fingerprint: null, act_notify_message: null, inform_delivered_at: null, opened_at: "2026-11-20T10:00:00.000Z", resolved_at: null, created_at: "2026-11-20T10:00:00.000Z", updated_at: "2026-11-20T10:00:00.000Z" };
  return [
    { ...base, situation_id: "sit-spend-1", domain: "spend", source_open_loop_id: LOOP_IDS.fin1, detection_key: `open_loop:finance_spend_unexpected:${LOOP_IDS.fin1}`, priority: "high", reason: `Utgift på ${FIN.amount} NOK (${FIN.spendCategory}) skjedde etter at en tilknyttet forpliktelse ble satt på pause Anbefalt neste handling: Gjennomgå uventet utgift ${FIN.spendId}`, inform_message: `Uventet utgift ${FIN.vendor}` },
    { ...base, situation_id: "sit-spend-2", domain: "spend", source_open_loop_id: null, detection_key: "spend_anomaly:ai_cost:2026-11-24", priority: "normal", reason: `Kostnaden for AI-bruken 2026-11-24 var ca. 4,2 ganger høyere enn din vanlige dag ${FIN.driftCost}`, inform_message: null },
    { ...base, situation_id: "sit-pipe-1", domain: "pipeline", source_open_loop_id: LOOP_IDS.ok1, detection_key: `open_loop:overdue_followup:${LOOP_IDS.ok1}`, priority: "normal", reason: `Følg opp ${KEEP.followup} før fredag`, inform_message: null },
    { ...base, situation_id: "sit-sup-1", domain: "support", source_open_loop_id: LOOP_IDS.ok2, detection_key: `open_loop:support_ticket_overdue:${LOOP_IDS.ok2}`, priority: "high", reason: `Sak ${KEEP.ticket} mangler svar`, inform_message: null }
  ];
}

export const OWNER_CONTROL_STATE = {
  kill_switch: { active: true, reason: FIN.killReason, actor_person_id: OWNER, changed_at: "2026-11-21T08:00:00.000Z" },
  frozen_connectors: [
    { connector_id: "github", reason: KEEP.reasonOk, actor_person_id: OWNER, changed_at: "2026-11-21T08:10:00.000Z" },
    { connector_id: "stripe", reason: FIN.frozenReason, actor_person_id: OWNER, changed_at: "2026-11-21T08:20:00.000Z" },
    { connector_id: "finance_vipps", reason: FIN.frozenReason, actor_person_id: OWNER, changed_at: "2026-11-21T08:30:00.000Z" }
  ],
  revoked_credentials: [
    { credential_ref: "JARVIS_GITHUB_TOKEN", reason: KEEP.reasonOk, actor_person_id: OWNER, changed_at: "2026-11-21T09:00:00.000Z" },
    { credential_ref: "JARVIS_VIPPS_CLIENT_SECRET", reason: FIN.frozenReason, actor_person_id: OWNER, changed_at: "2026-11-21T09:10:00.000Z" }
  ]
};

export const AUTONOMY_POLICIES = [
  { domain: "pipeline", tool_id: "business", action: "create_followup", enabled: true, parameters: {}, memory_space_id: "business", actor_person_id: OWNER, updated_at: "2026-11-01T00:00:00.000Z" },
  { domain: "spend", tool_id: "finance_spend", action: "pause_recurring_commitment", enabled: true, parameters: { note: FIN.policyParam }, memory_space_id: "business", actor_person_id: OWNER, updated_at: "2026-11-01T00:00:00.000Z" }
];

const WINDOWS = { d7: { from: "2026-11-18T00:00:00.000Z", to: "2026-11-25T00:00:00.000Z" }, d30: { from: "2026-10-26T00:00:00.000Z", to: "2026-11-25T00:00:00.000Z" } };
const VALUE_FACTS: ValueRuntimeFacts = {
  v1_delivery_configured: true, v2_push: { enabled: false, channel_configured: true, max_per_day: 3, quiet_hours: "22-07" }, v5_proposals_enabled: false,
  ev0: { constitution_verified: true, ledger_ok: true }, kill_switch_active: false, declared_gates: []
};
const MEASURED: ValueMeasurement[] = VALUE_METRIC_CATALOG
  .filter((m) => m.never_measurable_reason_no === undefined && m.derive === undefined)
  .map((m) => (m.unit === "ore"
    ? ({ id: m.id, state: "measured", last_7d: Number(FIN.costOre), last_30d: Number(FIN.costOre) * 2 } as ValueMeasurement)
    : m.shape === "snapshot" ? ({ id: m.id, state: "measured", now: 2 } as ValueMeasurement) : ({ id: m.id, state: "measured", last_7d: 5, last_30d: 20 } as ValueMeasurement)));

const SLO_REPORT = () => composeSloReport({
  as_of: "2026-11-25T10:00:00.000Z",
  slos: [{ id: "chat_ttft", label: "Chat: første token", status: "OK", value: 900, target: 3000, metric: "ttft_p95_ms", samples: 40, window_hours: 24, source: "cost_events (CHAT)", observed_at: "2026-11-25T10:00:00.000Z", detail: "p95 900 ms (mål 3000 ms)" }] as never,
  drift: {
    window_recent_hours: 24, window_baseline_hours: 168, insufficient: [],
    findings: [
      { series: "chat", metric: "cost_per_call_ore", baseline: 3, recent: 6.7, change: 1.22, detail: `Kostnad per kall økte fra 3 til 6.7 øre (+122 %) ${FIN.driftCost}` },
      { series: "chat", metric: "p95_ms", baseline: 800, recent: 1500, change: 0.9, detail: "p95-latens økte fra 800 til 1500 ms" }
    ]
  } as never,
  data_quality: null
});

export interface World {
  gateway: ToolGateway;
  /** Antall kall til finance-transporten (nøstet). */
  financeCalls: () => number;
  service: ExecutiveService;
}

export interface WorldOptions {
  pool: pg.Pool;
  /** Begrenset-vakten (utførelseslås + central kontekst) PÅ. */
  guard: boolean;
  controlCenters?: ControlCenterRegistry;
  executiveOptions?: Partial<ExecutiveServiceOptions>;
  /** Registrer de EKTE sentrene Autoritet, Integrasjoner og AI (via `registerControlCenters`, som main.ts) mot samme gateway og pool. */
  realCenters?: boolean;
  /** Hvilke kontrollsentre som har lese-verktøy (som `controlCentersWithTools` i main.ts). */
  centerTools?: Array<"finance" | "memory" | "agent" | "operations" | "value" | "privacy" | "security" | "evolution">;
  /** Ekstra verktøy registrert i gatewayen (f.eks. conversation_graph). */
  extraTools?: ToolDefinition[];
}

/** Bygger en gateway SOM main.ts gjør det: lås + vakt fra SAMME flagg (`guard`). */
export function buildWorld(options: WorldOptions): World {
  const { pool, guard } = options;
  let financeCalls = 0;
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(pool), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT] }
  });
  const lock: FinanceExecutionLock = FINANCE_EXECUTION_LOCK;
  const gatewayOptions: ToolGatewayOptions = guard ? { financeExecutionLock: lock } : {};
  const gateway = new ToolGateway(pool, policy, { name: "test", async get() { return "secret"; } }, undefined, undefined, gatewayOptions);

  const openLoops = new OpenLoopService(pool);
  const businessTransport = new BusinessTransport(new BusinessService(pool), openLoops, pool, gateway);
  // `conversation_graph` (R21): den EKTE transporten mot den samme poolen (tverr-kanal-lesningene leser `business_open_loops`)
  for (const tool of firstWaveTools({ business: businessTransport, conversation_graph: new ConversationGraphTransport(new ConversationGraphService(pool)) })) gateway.register(tool);
  // finance.get_kill_switch er den NØSTEDE avlesningen executive gjør (ToolGateway-låsen/den sentrale lesningen skal holde den tilbake for sky)
  gateway.register({ ...fakeDef("finance", "get_kill_switch", null), transport: { async invoke() { financeCalls += 1; return { data: { tenant_id: TENANT, enabled: true, enabled_by_person_id: OWNER, reason: FIN.killReason, enabled_at: "2026-11-01T00:00:00Z", disabled_at: null, updated_at: "2026-11-01T00:00:00Z" } as never }; } } });
  gateway.register(fakeDef("owner_controls", "get_control_state", OWNER_CONTROL_STATE));
  gateway.register(fakeDef("situations", "get_pause_state", { paused: ["spend", "pipeline"] }));
  gateway.register(fakeDef("situations", "get_queue", situationRows()));
  gateway.register(fakeDef("situations", "list_autonomy_policies", AUTONOMY_POLICIES));
  gateway.register(fakeDef("situations", "get_notification_policy", null));
  for (const tool of runRateToolDefinitions(new RunRateTransport(new RunRateService(pool)))) gateway.register(tool);

  // De EKTE kontrollsentrene (Autoritet, Integrasjoner, AI) - SAMME fabrikk og registrering som main.ts - mot den samme gatewayen og poolen
  let controlCenters = options.controlCenters;
  if (options.realCenters === true) {
    const authority = { owner_person_id: OWNER, owner_tenants: [TENANT] };
    const killSwitch = new KillSwitch(pool, { owner_person_id: OWNER });
    const ownerControls = new OwnerControls(killSwitch, pool, { owner_person_id: OWNER });
    controlCenters = createControlCenterRegistry({ authority });
    registerControlCenters(controlCenters, {
      pool, env: {}, toolGateway: gateway, ownerControls, killSwitch, authority,
      modelGateway: { providerOverview: () => [], meshStatus: () => ({ router: "HEALTHY", fallback: "READY" }), routingAdvisorMode: "shadow" } as never,
      runRate: new RunRateService(pool)
    });
  }

  const readers: Record<string, ObservationReader> = {
    database: async () => ({ status: "OK", source: "db", observed_at: "2026-11-25T10:00:00.000Z", detail: "Databasen svarer" }),
    connectors: async () => ({ status: "DEGRADED", source: "connector-health", observed_at: "2026-11-25T10:00:00.000Z", detail: `Stripe er nede: ${FIN.jobFailure}` }),
    drift: async () => ({ status: "DEGRADED", source: "cost_events", observed_at: "2026-11-25T10:00:00.000Z", detail: `Gradvis forverring: chat: Kostnad per kall økte fra 3 til 6.7 øre ${FIN.driftCost}` })
  };
  const service = new ExecutiveService(gateway, {
    servedLocally: financeLockServedLocally,
    ...(guard ? { withholdFinanceFromCloud: true } : {}),
    selfModel: { readers, limitations: { forbiddenModelToolIds: [], connectors: [], modelProfiles: [], allModelCapabilities: [] } },
    slo: { report: async () => SLO_REPORT() },
    // AI Mesh og evolusjonsrapporten er enkle, realistiske rapportobjekter (transporten gir dem videre uendret); kun finansdelen (kostnad i øre) har markørstrenger
    aiMesh: { report: async () => ({ as_of: "2026-11-25T10:00:00.000Z", router: "UP", providers: [{ provider: "anthropic", model: "claude", state: "LIVE", healthy: true, usage_7d: { calls: 11, failed_calls: 0, cost_ore: Number(FIN.meshCost) } }], summary_no: `AI Mesh: Anthropic LIVE, 7 døgn: 11 kall, ${FIN.meshCost} øre` }) as never },
    evolution: { report: async () => ({ as_of: "2026-11-25T10:00:00.000Z", acts: false, sections: [{ ev: "EV-16", title_no: `Ressurs og kost ${FIN.evolutionCost}`, status: "OK", summary_no: `Månedsforbruk ${FIN.costOre} øre` }, { ev: "EV-5", title_no: "Utrulling", status: "OK", summary_no: "Ingen endringer" }], summary_no: `Evolusjon: ${FIN.evolutionCost}` }) as never },
    value: { source: { measure: async () => ({ windows: WINDOWS, measurements: MEASURED }) }, facts: () => VALUE_FACTS },
    ...(controlCenters ? { controlCenters } : {}),
    ...(options.executiveOptions ?? {})
  } as ExecutiveServiceOptions);
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(service), { controlCenters: options.centerTools ?? [] })) gateway.register(tool);
  for (const tool of options.extraTools ?? []) gateway.register(tool);
  return { gateway, financeCalls: () => financeCalls, service };
}

export const run = async (gateway: ToolGateway, tool_id: string, action: string, parameters: Record<string, unknown>, servingModel?: ModelArg): Promise<{ ok: boolean; reason?: string; data?: unknown }> => {
  const r = await gateway.execute({ identity, tool_id, action, parameters: parameters as never, ...(servingModel !== undefined ? { servingModel } : {}), idempotency_key: `k-${Math.random().toString(36).slice(2)}` });
  return r.ok ? { ok: true, data: (r as { data?: unknown }).data } : { ok: false, reason: r.reason };
};
