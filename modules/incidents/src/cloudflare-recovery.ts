import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { NormalizedDnsRecord, NormalizedRule, ToolGateway } from "@jarvis/tool-gateway";
import { dnsContentMatches } from "@jarvis/tool-gateway";
import type { InfraExecution, RecoveryStatus } from "./types.ts";

/**
 * WP-E1 (UA-5 kriterium 3 - «testet gjenopprettingsvei»): kompensasjon for Cloudflare-mutasjoner. Hver strategi:
 *   1. leser MÅLET fra den journalførte eksekusjonen (`infra_executions` - sone-id, post-/regel-id, før-/etter-tilstand), ALDRI fra kallerens parametre
 *      (TSK-033/JARVIS-068: en kaller kunne ellers gjenopprette mål X med mål Y sin før-tilstand),
 *   2. sjekker DRIFT: er objektet fortsatt slik mutasjonen etterlot det? Hvis noen har endret det siden, overskrives det ALDRI blindt (FAILED med
 *      `state_drifted_since_execution` og dagens tilstand i resultatet - eieren avgjør),
 *   3. er allerede gjenopprettet => idempotent SUCCESS uten skriving,
 *   4. utfører kompensasjonen UTELUKKENDE via `ToolGateway.execute()` (policy, InfraExecutionGate, frys, sone-autorisasjon, klasse D-kjede og varsling
 *      gjelder likt som for enhver annen mutasjon) med idempotens-nøkkel `recovery:<opprinnelig nøkkel>`,
 *   5. VERIFISERER ved ny lesing at sluttilstanden faktisk er den tiltenkte (et kall som lyktes men landet feil er `PARTIAL`, aldri fabrikkert `SUCCESS`).
 */
export interface CloudflareRecoveryContext {
  gateway: ToolGateway;
  identity: IdentityContext;
  idempotencyKey: string;
  execution: InfraExecution | null;
}

export interface CloudflareRecoveryOutcome {
  status: RecoveryStatus;
  result: Record<string, unknown>;
}

type Strategy = (ctx: CloudflareRecoveryContext) => Promise<CloudflareRecoveryOutcome>;
type Json = Record<string, JsonValue>;

const failed = (reason: string, extra: Record<string, unknown> = {}): CloudflareRecoveryOutcome => ({ status: "FAILED", result: { reason, ...extra } });
const unknown = (reason: string): CloudflareRecoveryOutcome => ({ status: "UNKNOWN", result: { reason } });
const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

async function read(ctx: CloudflareRecoveryContext, action: string, parameters: Json): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
  const r = await ctx.gateway.execute({ identity: ctx.identity, tool_id: "cloudflare", action, parameters });
  return r.ok ? { ok: true, data: r.data ?? null } : { ok: false, reason: r.reason };
}

async function write(ctx: CloudflareRecoveryContext, action: string, parameters: Json): Promise<{ ok: true; external_id?: string } | { ok: false; reason: string }> {
  const r = await ctx.gateway.execute({ identity: ctx.identity, tool_id: "cloudflare", action, parameters, idempotency_key: `recovery:${ctx.idempotencyKey}` });
  return r.ok ? { ok: true, ...(r.external_id !== undefined ? { external_id: r.external_id } : {}) } : { ok: false, reason: r.reason };
}

function journal(ctx: CloudflareRecoveryContext): { exec: InfraExecution; zone: string; requested: Record<string, unknown>; externalId: string | null } | null {
  const exec = ctx.execution;
  if (!exec) return null;
  const requested = asObj(exec.requested_state) ?? {};
  const zone = typeof requested["zone_id"] === "string" ? requested["zone_id"] : null;
  if (!zone) return null;
  const receipt = asObj(exec.provider_receipt);
  const externalId = typeof receipt?.["external_id"] === "string" ? (receipt["external_id"] as string) : null;
  return { exec, zone, requested, externalId };
}

/** Sammenligner to DNS-poster på feltene en mutasjon kan endre (innhold uavhengig av leverandørens normalisering; ttl ignoreres for proxiede poster). */
function sameDnsRecord(a: Partial<NormalizedDnsRecord>, b: Partial<NormalizedDnsRecord>): boolean {
  const content = a.content !== undefined && a.content !== null && b.content !== undefined && b.content !== null ? dnsContentMatches(a.type ?? b.type ?? "", a.content, b.content) : a.content === b.content;
  const ttl = a.proxied === true || b.proxied === true ? true : a.ttl === b.ttl;
  return content && ttl && (a.proxied ?? false) === (b.proxied ?? false) && (a.comment ?? "") === (b.comment ?? "") && (a.priority ?? null) === (b.priority ?? null);
}

const sameRule = (a: Partial<NormalizedRule>, b: Partial<NormalizedRule>): boolean =>
  a.action === b.action && a.expression === b.expression && (a.description ?? "") === (b.description ?? "") && (a.enabled ?? true) === (b.enabled ?? true)
  && JSON.stringify(a.ratelimit ?? null) === JSON.stringify(b.ratelimit ?? null);

const rulesOf = (state: unknown): NormalizedRule[] => ((asObj(state)?.["rules"] as NormalizedRule[] | undefined) ?? []);

// ------------------------------------------------------------------ DNS

const undoCreateDns: Strategy = async (ctx) => {
  const j = journal(ctx);
  if (!j) return unknown("execution_journal_missing");
  if (!j.externalId) return unknown("no_created_record_id_captured");
  const before = (asObj(j.exec.before_state)?.["records"] as Array<{ id?: string }> | undefined) ?? [];
  if (before.some((r) => r.id === j.externalId)) return { status: "SUCCESS", result: { noop: "record_existed_before_execution", record_id: j.externalId } };
  const current = await read(ctx, "get_dns_record", { zone_id: j.zone, record_id: j.externalId });
  if (!current.ok) return failed(current.reason);
  if (current.data === null) return { status: "SUCCESS", result: { noop: "record_already_absent", record_id: j.externalId } };
  const created = ((asObj(j.exec.after_state)?.["records"] as NormalizedDnsRecord[] | undefined) ?? []).find((r) => r.id === j.externalId);
  if (created && !sameDnsRecord(created, current.data as NormalizedDnsRecord)) return failed("state_drifted_since_execution", { current: current.data });
  const removed = await write(ctx, "delete_dns_record", { zone_id: j.zone, record_id: j.externalId });
  if (!removed.ok) return failed(removed.reason);
  const verify = await read(ctx, "get_dns_record", { zone_id: j.zone, record_id: j.externalId });
  if (!verify.ok) return unknown("post_recovery_verification_failed");
  return verify.data === null ? { status: "SUCCESS", result: { removed_record_id: j.externalId } } : { status: "PARTIAL", result: { still_present: verify.data } };
};

const undoUpdateDns: Strategy = async (ctx) => {
  const j = journal(ctx);
  if (!j) return unknown("execution_journal_missing");
  const recordId = typeof j.requested["record_id"] === "string" ? j.requested["record_id"] : null;
  const before = j.exec.before_state as unknown as NormalizedDnsRecord | null;
  if (!recordId || !before || typeof before.content !== "string") return unknown("no_before_state_captured");
  const current = await read(ctx, "get_dns_record", { zone_id: j.zone, record_id: recordId });
  if (!current.ok) return failed(current.reason);
  if (current.data === null) return failed("record_missing_since_execution");
  const now = current.data as NormalizedDnsRecord;
  if (sameDnsRecord(before, now)) return { status: "SUCCESS", result: { noop: "already_at_before_state", record_id: recordId } };
  const after = j.exec.after_state as unknown as NormalizedDnsRecord | null;
  if (after && !sameDnsRecord(after, now)) return failed("state_drifted_since_execution", { current: now });
  const params: Json = { zone_id: j.zone, record_id: recordId };
  if (!dnsContentMatches(before.type ?? "", before.content, now.content ?? "")) params["content"] = before.content;
  if (before.proxied !== true && before.ttl !== null && before.ttl !== now.ttl) params["ttl"] = before.ttl;
  if ((before.proxied ?? false) !== (now.proxied ?? false) && before.proxied !== null) params["proxied"] = before.proxied;
  if ((before.comment ?? "") !== (now.comment ?? "")) params["comment"] = before.comment ?? "";
  if (before.priority !== null && before.priority !== now.priority) params["priority"] = before.priority;
  const restored = await write(ctx, "update_dns_record", params);
  if (!restored.ok) return failed(restored.reason);
  const verify = await read(ctx, "get_dns_record", { zone_id: j.zone, record_id: recordId });
  if (!verify.ok || verify.data === null) return unknown("post_recovery_verification_failed");
  return sameDnsRecord(before, verify.data as NormalizedDnsRecord)
    ? { status: "SUCCESS", result: { verified_state: verify.data } }
    : { status: "PARTIAL", result: { verified_state: verify.data, expected: before } };
};

const undoDeleteDns: Strategy = async (ctx) => {
  const j = journal(ctx);
  if (!j) return unknown("execution_journal_missing");
  const before = j.exec.before_state as unknown as NormalizedDnsRecord | null;
  if (!before || typeof before.type !== "string" || typeof before.name !== "string" || typeof before.content !== "string") return unknown("no_before_state_captured");
  const existing = await read(ctx, "find_dns_records", { zone_id: j.zone, type: before.type, name: before.name });
  if (!existing.ok) return failed(existing.reason);
  const match = ((asObj(existing.data)?.["records"] as NormalizedDnsRecord[] | undefined) ?? []).find((r) => r.content !== null && dnsContentMatches(before.type as string, before.content as string, r.content));
  if (match) return { status: "SUCCESS", result: { noop: "record_already_restored", record_id: match.id } };
  const params: Json = { zone_id: j.zone, type: before.type, name: before.name, content: before.content };
  if (before.ttl !== null && (before.ttl === 1 || before.ttl >= 60)) params["ttl"] = before.ttl;
  if (before.proxied !== null && ["A", "AAAA", "CNAME"].includes(before.type)) params["proxied"] = before.proxied;
  if (before.comment) params["comment"] = before.comment;
  if (before.type === "MX" && before.priority !== null) params["priority"] = before.priority;
  const created = await write(ctx, "create_dns_record", params);
  if (!created.ok) return failed(created.reason);
  const verify = await read(ctx, "find_dns_records", { zone_id: j.zone, type: before.type, name: before.name });
  if (!verify.ok) return unknown("post_recovery_verification_failed");
  const restored = ((asObj(verify.data)?.["records"] as NormalizedDnsRecord[] | undefined) ?? []).find((r) => r.content !== null && dnsContentMatches(before.type as string, before.content as string, r.content));
  return restored
    ? { status: "SUCCESS", result: { restored_record_id: restored.id, note: "posten har fått ny id" } }
    : { status: "PARTIAL", result: { reason: "restored_record_not_found_on_readback" } };
};

// ------------------------------------------------------------------ WAF

const undoCreateRule: Strategy = async (ctx) => {
  const j = journal(ctx);
  if (!j) return unknown("execution_journal_missing");
  const phase = typeof j.requested["phase"] === "string" ? j.requested["phase"] : null;
  if (!phase) return unknown("no_phase_captured");
  if (!j.externalId) return unknown("no_created_rule_id_captured");
  if (rulesOf(j.exec.before_state).some((r) => r.id === j.externalId)) return { status: "SUCCESS", result: { noop: "rule_existed_before_execution", rule_id: j.externalId } };
  const current = await read(ctx, "get_ruleset", { zone_id: j.zone, phase });
  if (!current.ok) return failed(current.reason);
  const now = rulesOf(current.data).find((r) => r.id === j.externalId);
  if (!now) return { status: "SUCCESS", result: { noop: "rule_already_absent", rule_id: j.externalId } };
  const created = rulesOf(j.exec.after_state).find((r) => r.id === j.externalId);
  if (created && !sameRule(created, now)) return failed("state_drifted_since_execution", { current: now });
  const removed = await write(ctx, "delete_waf_rule", { zone_id: j.zone, phase, rule_id: j.externalId });
  if (!removed.ok) return failed(removed.reason);
  const verify = await read(ctx, "get_ruleset", { zone_id: j.zone, phase });
  if (!verify.ok) return unknown("post_recovery_verification_failed");
  return rulesOf(verify.data).some((r) => r.id === j.externalId) ? { status: "PARTIAL", result: { reason: "rule_still_present" } } : { status: "SUCCESS", result: { removed_rule_id: j.externalId } };
};

const undoUpdateRule: Strategy = async (ctx) => {
  const j = journal(ctx);
  if (!j) return unknown("execution_journal_missing");
  const phase = typeof j.requested["phase"] === "string" ? j.requested["phase"] : null;
  const ruleId = typeof j.requested["rule_id"] === "string" ? j.requested["rule_id"] : null;
  const beforeRule = ruleId ? rulesOf(j.exec.before_state).find((r) => r.id === ruleId) : undefined;
  if (!phase || !ruleId || !beforeRule || beforeRule.action === null || beforeRule.expression === null) return unknown("no_before_state_captured");
  const current = await read(ctx, "get_ruleset", { zone_id: j.zone, phase });
  if (!current.ok) return failed(current.reason);
  const now = rulesOf(current.data).find((r) => r.id === ruleId);
  if (!now) return failed("rule_missing_since_execution");
  if (sameRule(beforeRule, now)) return { status: "SUCCESS", result: { noop: "already_at_before_state", rule_id: ruleId } };
  const afterRule = rulesOf(j.exec.after_state).find((r) => r.id === ruleId);
  if (afterRule && !sameRule(afterRule, now)) return failed("state_drifted_since_execution", { current: now });
  const params: Json = { zone_id: j.zone, phase, rule_id: ruleId, action: beforeRule.action, expression: beforeRule.expression, description: beforeRule.description, enabled: beforeRule.enabled };
  if (beforeRule.ratelimit !== null) params["ratelimit"] = beforeRule.ratelimit;
  const restored = await write(ctx, "update_waf_rule", params);
  if (!restored.ok) return failed(restored.reason);
  const verify = await read(ctx, "get_ruleset", { zone_id: j.zone, phase });
  const after = verify.ok ? rulesOf(verify.data).find((r) => r.id === ruleId) : undefined;
  if (!after) return unknown("post_recovery_verification_failed");
  return sameRule(beforeRule, after) ? { status: "SUCCESS", result: { verified_rule: after } } : { status: "PARTIAL", result: { verified_rule: after, expected: beforeRule } };
};

const undoDeleteRule: Strategy = async (ctx) => {
  const j = journal(ctx);
  if (!j) return unknown("execution_journal_missing");
  const phase = typeof j.requested["phase"] === "string" ? j.requested["phase"] : null;
  const ruleId = typeof j.requested["rule_id"] === "string" ? j.requested["rule_id"] : null;
  const beforeRule = ruleId ? rulesOf(j.exec.before_state).find((r) => r.id === ruleId) : undefined;
  if (!phase || !beforeRule || beforeRule.action === null || beforeRule.expression === null) return unknown("no_before_state_captured");
  // Regler med skip/execute-parametere (action_parameters m.m.) kan ikke gjenskapes via den smale create-handlingen - ærlig PARTIAL med snapshotet, ikke en lavere versjon av regelen.
  if (Object.keys(beforeRule.extra ?? {}).length > 0) return { status: "PARTIAL", result: { reason: "rule_has_unmodelled_fields_manual_restore_required", snapshot: beforeRule } };
  const current = await read(ctx, "get_ruleset", { zone_id: j.zone, phase });
  if (!current.ok) return failed(current.reason);
  const match = rulesOf(current.data).find((r) => sameRule(beforeRule, r));
  if (match) return { status: "SUCCESS", result: { noop: "rule_already_restored", rule_id: match.id } };
  const params: Json = { zone_id: j.zone, phase, action: beforeRule.action, expression: beforeRule.expression, description: beforeRule.description, enabled: beforeRule.enabled };
  if (beforeRule.ratelimit !== null) params["ratelimit"] = beforeRule.ratelimit;
  const created = await write(ctx, "create_waf_rule", params);
  if (!created.ok) return failed(created.reason);
  const verify = await read(ctx, "get_ruleset", { zone_id: j.zone, phase });
  if (!verify.ok) return unknown("post_recovery_verification_failed");
  const restored = rulesOf(verify.data).find((r) => sameRule(beforeRule, r));
  return restored ? { status: "SUCCESS", result: { restored_rule_id: restored.id, note: "regelen har fått ny id" } } : { status: "PARTIAL", result: { reason: "restored_rule_not_found_on_readback" } };
};

// ------------------------------------------------------------------ innstillinger

const undoZoneSetting: Strategy = async (ctx) => {
  const j = journal(ctx);
  if (!j) return unknown("execution_journal_missing");
  const settingId = typeof j.requested["setting_id"] === "string" ? j.requested["setting_id"] : null;
  const before = asObj(j.exec.before_state);
  if (!settingId || !before || typeof before["value"] !== "string") return unknown("no_before_state_captured");
  const current = await read(ctx, "get_zone_setting", { zone_id: j.zone, setting_id: settingId });
  if (!current.ok) return failed(current.reason);
  const now = asObj(current.data);
  if (!now) return failed("setting_missing");
  if (now["value"] === before["value"]) return { status: "SUCCESS", result: { noop: "already_at_before_state", setting_id: settingId } };
  const after = asObj(j.exec.after_state);
  if (after && after["value"] !== now["value"]) return failed("state_drifted_since_execution", { current: now });
  const restored = await write(ctx, "update_zone_setting", { zone_id: j.zone, setting_id: settingId, value: before["value"] as string });
  if (!restored.ok) return failed(restored.reason);
  const verify = await read(ctx, "get_zone_setting", { zone_id: j.zone, setting_id: settingId });
  const value = verify.ok ? asObj(verify.data)?.["value"] : undefined;
  if (value === undefined) return unknown("post_recovery_verification_failed");
  return value === before["value"] ? { status: "SUCCESS", result: { verified_value: value } } : { status: "PARTIAL", result: { verified_value: value, expected: before["value"] } };
};

export const CLOUDFLARE_RECOVERY_STRATEGIES: Readonly<Record<string, Strategy>> = {
  "cloudflare:create_dns_record": undoCreateDns,
  "cloudflare:update_dns_record": undoUpdateDns,
  "cloudflare:delete_dns_record": undoDeleteDns,
  "cloudflare:create_waf_rule": undoCreateRule,
  "cloudflare:update_waf_rule": undoUpdateRule,
  "cloudflare:delete_waf_rule": undoDeleteRule,
  "cloudflare:update_zone_setting": undoZoneSetting
  // cloudflare:purge_cache har BEVISST ingen strategi: cachen kan ikke gjenopprettes (UNKNOWN/no_recovery_strategy_registered, aldri fabrikkert SUCCESS).
};
