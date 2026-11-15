import { scanForSecrets } from "@jarvis/core";
import type { TrustLevel } from "@jarvis/contracts";
import { isUnknown, type ActionSpec, type ConnectorManifest } from "../manifest.ts";
import { AbortedError, FakeClock } from "./clock.ts";
import type {
  AdapterError, AdapterEvidence, AdapterHealth, AdapterRequest, AdapterResult, ContractAdapter, ErrorCategory, Fault, HealthState, JsonValue
} from "./types.ts";

/**
 * WP-I (D-472): gjenbrukbar FAKE-ADAPTER-HARNESS. `createFakeConnector({ manifest })` bygger en fake som oppfører seg etter Jarvis' kjøre-kontrakt (ToolGateway + transport) slik MANIFESTET beskriver den:
 * parametervalidering FØR leverandøren, autoritet (tenant-binding, delegert), pause/tilbakekall, idempotens-ledger (samme nøkkel = én effekt; krav om nøkkel; ukjent utfall etter tidsavbrudd gjentas aldri),
 * klasse D-kjeden (ufullstendig kjede er utilgjengelig; varsling), før-/etter-evidens, tidsavbrudd/avbrudd på virtuell klokke, feilkategorier og helsetilstand, redigering av leverandørtekst og credential.
 *
 * Leverandørspesifikk oppførsel legges inn som `handlers` per handling (les-data, skrive-effekt, readback); uten handler brukes en generisk ressursmodell (en handling skriver/sletter en ressurs identifisert
 * av de påkrevde parametrene), som er nok til å bevise kontrakten. HARNESSEN ER EN MODELL: den beviser at manifestets deklarerte garantier er konsistente og at kittet fanger brudd - den beviser IKKE at en
 * ekte transport holder dem (det krever en bro mot en ekte transport bak en fake leverandørserver, DEFERRED, eller live smoke, BLOCKED_EXTERNAL).
 *
 * `defects` er KUN for kittets egne mutasjonstester: hver defekt gjør fakeen brutal mot nøyaktig én kontraktsegenskap, og kittet må da feile den egenskapen.
 */

export const FAKE_TENANT = "tenant-a";
export const FAKE_CREDENTIAL_CANARY = "fake-credential-canary-0001";

/** Alle defektene fakeen kan påføres (kun for kittets egne mutasjonstester; en test låser at hver av dem feller en kontraktsegenskap). */
export const FAKE_DEFECTS = [
  "no_dedupe", "required_key_not_enforced", "params_not_validated", "wrong_trust_label", "leaks_credential", "no_redaction",
  "health_never_degrades", "ignores_abort", "timeout_masks_as_ok", "no_evidence", "cross_tenant_allowed", "delegated_allowed",
  "pause_ignored", "revoke_ignored", "no_notification", "auth_reported_as_other", "unknown_outcome_replay_executes",
  "compensate_noop", "deferred_chain_executes", "key_reuse_executes", "provider_text_in_control_field"
] as const;
export type FakeDefect = (typeof FAKE_DEFECTS)[number];

export interface FakeHandlerContext {
  /** Tredjepartstekst leverandøren returnerer (rå). En handler som siterer den MÅ først sende den gjennom `redact` - kittet feller en handler som glemmer det. */
  providerText: string | null;
  /** Den sentrale hemmelighetsskanneren + credential-vask (samme vask som harnessen selv bruker). */
  redact: (text: string) => string;
}

export interface FakeActionHandler {
  /** Les-data (lese-handlinger). Standard: `{ items: [{ id, title: <tredjepartstekst> }] }`. */
  read?: (params: Record<string, JsonValue>, state: FakeState, ctx: FakeHandlerContext) => JsonValue;
  /** Leverandør-side endring (skrive-/utførende handlinger). Standard: generisk ressursmodell. */
  run?: (params: Record<string, JsonValue>, state: FakeState, n: number) => { data: JsonValue; external_id?: string };
  /** Tilstanden som leses for før-/etter-evidens. Standard: ressursen handlingen gjelder. */
  readback?: (params: Record<string, JsonValue>, state: FakeState) => JsonValue;
  sample?: Record<string, JsonValue>;
}

export interface FakeState {
  resources: Record<string, JsonValue>;
}

export interface FakeConnectorSpec {
  manifest: ConnectorManifest;
  handlers?: Readonly<Record<string, FakeActionHandler>>;
  defects?: readonly FakeDefect[];
  clock?: FakeClock;
  /** Tenanten credentialen er bundet til (standard `tenant-a`). */
  bound_tenant?: string;
}

interface LedgerRow {
  action: string;
  digest: string;
  status: "reserved" | "done" | "unknown";
  result?: Extract<AdapterResult, { ok: true }>;
  target?: string;
  before?: JsonValue | undefined;
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, val: unknown) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : val));

const HEALTH_OF: Readonly<Partial<Record<ErrorCategory, HealthState>>> = { auth: "auth_failed", rate_limit: "rate_limited", network: "unavailable", timeout: "unavailable" };
const RETRYABLE: Readonly<Record<ErrorCategory, boolean>> = { auth: false, rate_limit: true, timeout: true, network: true, not_found: false, invalid_input: false, authority: false, paused: false, conflict: false, policy: false, other: false };

export function createFakeConnector(spec: FakeConnectorSpec): ContractAdapter {
  const { manifest } = spec;
  const defects = new Set(spec.defects ?? []);
  const clock = spec.clock ?? new FakeClock();
  const bound = spec.bound_tenant ?? FAKE_TENANT;
  const handlers = spec.handlers ?? {};
  const byKey = new Map(manifest.actions.map((a) => [a.key, a]));
  const state: FakeState = { resources: {} };
  const ledger = new Map<string, LedgerRow>();
  const effects = new Map<string, number>();
  const observed = { logs: [] as string[], audit: [] as string[], notifications: [] as string[] };
  let providerCalls = 0;
  let fault: Fault | null = null;
  let paused = false;
  let revoked = false;
  let providerText: string | null = null;
  let healthNow: AdapterHealth | null = null;

  const requiredOf = (a: ActionSpec): string[] => (isUnknown(a.data.input_required) ? [] : a.data.input_required);
  const targetOf = (a: ActionSpec, params: Record<string, JsonValue>): string => `${a.key}:${canonical(requiredOf(a).map((r) => params[r] ?? null))}`;
  const sanitize = (text: string): string => (defects.has("no_redaction") || defects.has("leaks_credential") ? text : scanForSecrets(text.split(FAKE_CREDENTIAL_CANARY).join("[REDACTED:credential]")).text.replace(/\s+/g, " ").trim().slice(0, 300));
  const log = (line: string): void => { observed.logs.push(defects.has("leaks_credential") ? `${line} credential=${FAKE_CREDENTIAL_CANARY}` : line); };
  const audit = (a: ActionSpec | null, type: string, extra: Record<string, unknown> = {}): void => {
    observed.audit.push(JSON.stringify({ type, action: a?.key ?? null, at: clock.iso(), ...extra, ...(defects.has("leaks_credential") ? { credential: FAKE_CREDENTIAL_CANARY } : {}) }));
  };
  const setHealth = (state2: HealthState, detail?: string): void => {
    if (defects.has("health_never_degrades") && state2 !== "healthy") return;
    healthNow = { state: state2, at: clock.iso(), ...(detail !== undefined ? { detail } : {}) };
  };
  const fail = (a: ActionSpec | null, category: ErrorCategory, code: string, message: string, opts: { retryable?: boolean; health?: boolean } = {}): AdapterResult => {
    const cat: ErrorCategory = category === "auth" && defects.has("auth_reported_as_other") ? "other" : category;
    const error: AdapterError = { category: cat, code, message: sanitize(message), retryable: opts.retryable ?? RETRYABLE[category] };
    const h = opts.health === false ? undefined : HEALTH_OF[cat];
    if (h !== undefined) setHealth(h, code);
    audit(a, "tool.failed", { code, category: cat });
    log(`invoke ${a?.key ?? "?"} failed ${code}`);
    return { ok: false, error };
  };
  const trustOf = (a: ActionSpec): TrustLevel => (defects.has("wrong_trust_label") && a.trust.output === "untrusted" ? "trusted" : a.trust.output);
  const countEffect = (key: string): number => { const n = (effects.get(key) ?? 0) + 1; effects.set(key, n); return n; };

  const defaultRead = (a: ActionSpec, params: Record<string, JsonValue>): JsonValue => {
    const h = handlers[a.key]?.read;
    if (h) return h(params, state, { providerText, redact: sanitize });
    const text = providerText === null ? "sample item" : (defects.has("no_redaction") ? providerText : sanitize(providerText));
    return { items: [{ id: "item-1", title: text }], source: "fake" };
  };
  const readbackOf = (a: ActionSpec, params: Record<string, JsonValue>): JsonValue => handlers[a.key]?.readback?.(params, state) ?? state.resources[targetOf(a, params)] ?? null;
  const defaultRun = (a: ActionSpec, params: Record<string, JsonValue>): { data: JsonValue; external_id?: string } => {
    const n = countEffect(a.key);
    const custom = handlers[a.key]?.run;
    if (custom) return custom(params, state, n);
    const target = targetOf(a, params);
    if (a.effect === "delete") { delete state.resources[target]; return { data: { deleted: true, n }, external_id: `ext-${a.key}-${n}` }; }
    state.resources[target] = { applied: n, params };
    return { data: { applied: true, n }, external_id: `ext-${a.key}-${n}` };
  };

  const adapter: ContractAdapter = {
    connector_id: manifest.identity.id,
    actions: manifest.actions.map((a) => a.key),
    clock,
    identities: {
      owner: { tenant_id: bound, person_id: "person-owner" },
      foreign_tenant: { tenant_id: `${bound}-other`, person_id: "person-owner" },
      delegated: { tenant_id: bound, person_id: "person-agent", delegated: true },
      delegated_approved: { tenant_id: bound, person_id: "person-agent", delegated: true, approved: true }
    },
    observed,
    health: () => healthNow,
    injectFault: (f) => { fault = f; },
    effects: (key) => (key === undefined ? [...effects.values()].reduce((s, n) => s + n, 0) : (effects.get(key) ?? 0)),
    providerCalls: () => providerCalls,
    setPaused: (p) => { paused = p; },
    setCredentialRevoked: (r) => { revoked = r; },
    seedProviderText: (t) => { providerText = t; },
    credentialCanary: () => FAKE_CREDENTIAL_CANARY,
    snapshot: () => structuredClone(state) as unknown as JsonValue,
    sampleParameters: (key) => {
      const a = byKey.get(key);
      const base: Record<string, JsonValue> = {};
      if (a) for (const r of requiredOf(a)) base[r] = `sample-${r}`;
      return { ...base, ...(handlers[key]?.sample ?? {}) };
    },
    compensate: async (key, idempotencyKey) => {
      const a = byKey.get(key);
      const row = ledger.get(idempotencyKey);
      if (!a || !row || row.status !== "done" || row.target === undefined) return { restored: false, reason: "no_executed_row" };
      const method = a.reversibility.rollback_method;
      if (!a.reversibility.reversible || isUnknown(method) || method === "none" || method === "manual") return { restored: false, reason: "no_automatic_rollback" };
      if (defects.has("compensate_noop")) return { restored: true };
      if (row.before === undefined || row.before === null) delete state.resources[row.target];
      else state.resources[row.target] = row.before;
      return { restored: true };
    },
    invoke: async (req: AdapterRequest): Promise<AdapterResult> => {
      const a = byKey.get(req.action);
      if (a === undefined) return fail(null, "not_found", "unknown_action", `unknown action ${req.action}`, { health: false });
      if (paused && !defects.has("pause_ignored")) return fail(a, "paused", "connector_paused", "connector is paused by the owner", { health: false });
      if (revoked && !defects.has("revoke_ignored")) return fail(a, "authority", "credential_revoked", "credential is revoked", { health: false });

      // Autoritet: credentialen er bundet til eierens tenant; delegater følger manifestets delegerte modus (ukjent = fail-closed).
      if (req.identity.tenant_id !== bound && !defects.has("cross_tenant_allowed")) return fail(a, "authority", "credential_not_bound_to_identity", "credential is not bound to this identity", { health: false });
      if (req.identity.delegated === true && !defects.has("delegated_allowed")) {
        const mode = isUnknown(manifest.authority.delegated) ? "denied" : manifest.authority.delegated.mode;
        const needsApproval = a.authority.risk_class === "C" || a.authority.risk_class === "D";
        if (mode === "denied") return fail(a, "authority", "credential_not_bound_to_identity", "delegated identities may not use this connector", { health: false });
        if (mode === "approval_required" && needsApproval && req.identity.approved !== true) return fail(a, "authority", "approval_required", "a signed approval is required for this delegated call", { health: false });
      }

      // Klasse D-kjeden: ufullstendig kjede er utilgjengelig (fail-closed).
      const chain = a.reversibility.class_d_chain;
      if (a.authority.risk_class === "D" && chain?.status === "deferred" && !defects.has("deferred_chain_executes")) {
        return fail(a, "policy", "class_d_pipeline_incomplete", `class D pipeline incomplete: ${chain.missing.join(",")}`, { health: false });
      }

      // Deterministisk parametervalidering FØR leverandøren.
      if (!defects.has("params_not_validated")) {
        const missing = requiredOf(a).filter((r) => req.parameters[r] === undefined);
        if (missing.length > 0) return fail(a, "invalid_input", "missing_parameters", `missing required parameters: ${missing.join(",")}`, { health: false });
      }

      const isWrite = a.effect !== "read";
      const key = req.idempotency_key;
      if (isWrite && a.idempotency.requirement === "required" && key === undefined && !defects.has("required_key_not_enforced")) {
        return fail(a, "invalid_input", "idempotency_key_required", "an idempotency key is required for this action", { health: false });
      }

      // Idempotens-ledger (gatewayen dedupe-r klasse B/C/D med nøkkel; klasse A har ingen bivirkning å beskytte).
      const ledgerKey = isWrite && key !== undefined && a.authority.risk_class !== "A" && !defects.has("no_dedupe") ? key : undefined;
      const digest = canonical(req.parameters);
      if (ledgerKey !== undefined) {
        const row = ledger.get(ledgerKey);
        if (row !== undefined) {
          const same = row.action === a.key && row.digest === digest;
          if (!same && !defects.has("key_reuse_executes")) return fail(a, "conflict", "idempotency_key_reuse_mismatch", "the idempotency key was used for a different request", { health: false });
          if (same && row.status === "done" && row.result) { audit(a, "tool.executed", { deduplicated: true }); log(`invoke ${a.key} deduplicated`); return { ...row.result, deduplicated: true }; }
          if (same && (row.status === "unknown" || row.status === "reserved") && !defects.has("unknown_outcome_replay_executes")) {
            return fail(a, "conflict", "outcome_unknown", "an earlier attempt has an unknown outcome and must be reconciled before retrying", { retryable: false, health: false });
          }
        }
      }

      const timedOut = (): AdapterResult => {
        if (defects.has("timeout_masks_as_ok")) return { ok: true, data: null, deduplicated: false, output_trust: trustOf(a) };
        return fail(a, "timeout", "timeout", "the call was aborted at its deadline");
      };
      const sleep = (ms: number): Promise<void> => clock.sleep(ms, defects.has("ignores_abort") ? undefined : req.signal);

      // Tidsavbrudd FØR effekten: ingenting skjer.
      if (fault?.kind === "slow" && fault.effect === "before") {
        try { await sleep(fault.ms); } catch (e) { if (e instanceof AbortedError) return timedOut(); throw e; }
      }

      providerCalls += 1;
      const f = fault;
      if (f !== null && f.kind !== "slow") {
        const raw = `upstream ${f.kind} error${providerText !== null ? ` saying ${providerText}` : ""}${f.kind === "auth" ? ` for credential ${FAKE_CREDENTIAL_CANARY}` : ""}`;
        switch (f.kind) {
          case "auth": return fail(a, "auth", "provider_auth_rejected", raw);
          case "rate_limit": return fail(a, "rate_limit", "provider_rate_limited", raw);
          case "network": return fail(a, "network", "provider_unreachable", raw);
          case "server": return fail(a, "network", "provider_server_error", raw);
          case "not_found": return fail(a, "not_found", "provider_not_found", raw, { health: false });
          case "invalid": return fail(a, "invalid_input", "provider_rejected_input", raw, { health: false });
        }
      }

      let data: JsonValue;
      let external_id: string | undefined;
      let evidence: AdapterEvidence | undefined;
      if (!isWrite) {
        data = defaultRead(a, req.parameters);
      } else {
        const target = targetOf(a, req.parameters);
        const before = readbackOf(a, req.parameters);
        if (ledgerKey !== undefined) ledger.set(ledgerKey, { action: a.key, digest, status: "reserved", target, before });
        const ran = defaultRun(a, req.parameters);
        data = ran.data;
        if (ran.external_id !== undefined) external_id = ran.external_id;
        if (ledgerKey !== undefined) ledger.set(ledgerKey, { action: a.key, digest, status: "reserved", target, before });
        // Tidsavbrudd ETTER effekten: leverandøren har handlet, men svaret kommer sent - utfallet er UKJENT for kalleren.
        if (fault?.kind === "slow" && fault.effect === "after") {
          try { await sleep(fault.ms); } catch (e) {
            if (e instanceof AbortedError) {
              if (ledgerKey !== undefined) ledger.set(ledgerKey, { action: a.key, digest, status: "unknown", target, before });
              if (defects.has("timeout_masks_as_ok")) return timedOut();
              return fail(a, "timeout", "outcome_unknown", "the call timed out after the provider may have applied it; the outcome is unknown", { retryable: false });
            }
            throw e;
          }
        }
        const ev = a.reversibility.evidence;
        if ((ev.before_state || ev.postcondition === "readback") && !defects.has("no_evidence")) {
          evidence = { before: ev.before_state ? before : null, after: ev.postcondition === "readback" ? readbackOf(a, req.parameters) : null };
        }
        if (ledgerKey !== undefined) ledger.set(ledgerKey, { action: a.key, digest, status: "done", target, before });
      }

      setHealth("healthy");
      audit(a, "tool.executed", { ...(external_id !== undefined ? { external_id } : {}), deduplicated: false });
      log(`invoke ${a.key} ok`);
      const notified = a.authority.risk_class === "D" && chain?.status === "complete" ? !defects.has("no_notification") : undefined;
      if (notified === true) observed.notifications.push(`class_d ${a.key} ${external_id ?? "-"}`);
      const result: Extract<AdapterResult, { ok: true }> = {
        ok: true, data, deduplicated: false, output_trust: trustOf(a),
        ...(external_id !== undefined ? { external_id } : {}),
        ...(evidence !== undefined ? { evidence } : {}),
        ...(notified !== undefined ? { notified } : {})
      };
      if (defects.has("provider_text_in_control_field") && providerText !== null) (result as unknown as Record<string, unknown>)["instructions"] = providerText;
      if (ledgerKey !== undefined) { const row = ledger.get(ledgerKey); if (row) ledger.set(ledgerKey, { ...row, result }); }
      return result;
    }
  };
  return adapter;
}
