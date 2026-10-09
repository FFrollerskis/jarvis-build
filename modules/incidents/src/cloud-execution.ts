import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { ToolGateway, ToolResult } from "@jarvis/tool-gateway";
import { computeStateDiff } from "./diff.ts";
import { findExecutionByKey, readToolExecutionState } from "./infra-execution.ts";
import type { InfraExecution, InfraOperationalOutcome, InfraRiskClass } from "./types.ts";

/**
 * WP-E1 (UA-5 kriterium 3: «kritiske infra-handlinger gir full før/etter-revisjon og testet gjenopprettingsvei»): generalisering av
 * `executeInfraMutation()` (som er Docker-spesifikk) til de øvrige kontrollerte skymålene. SAMME sammenhengende, append-only
 * `infra_executions`-journal (aktør/enhet/risikoklasse/mål/idempotens/før/etter/diff/utfall/recovery-plan), SAMME prinsipper:
 *   - selve mutasjonen går UTELUKKENDE via `ToolGateway.execute()` (policy, InfraExecutionGate, frys, mål-autorisasjon, klasse D-kjeden og varsling gjelder
 *     uniformt - denne funksjonen dupliserer INGEN sjekk og har INGEN direkte transport-vei),
 *   - før-/etter-tilstand leses fra den EKSISTERENDE `tool_executions`-raden (gatewayens preflight/readback), aldri en egen lagringsmekanisme,
 *   - «HTTP 200 er ikke suksess»: et kall som lyktes men der etterbetingelsen ikke holdt er `PARTIAL`, et tidsavbrudd er `UNKNOWN`, aldri en fabrikkert `SUCCESS`,
 *   - idempotent: samme nøkkel + samme handling/mål gir den eksisterende raden; samme nøkkel brukt for noe annet er en eksplisitt konflikt.
 * Leverandør-spesifikke deler (mål-streng og kompensasjonsplan) ligger i en liten adapter per leverandør (`CloudMutationProvider`) - Cloudflare nå,
 * Postgres-drift i `postgres-ops-execution.ts`.
 */
type Params = Record<string, JsonValue>;

export interface CloudMutationProvider {
  provider: string;
  tool_id: string;
  actions: ReadonlySet<string>;
  /** Stabil, lesbar mål-streng for journalen (id-er, aldri hemmeligheter). */
  target(action: string, parameters: Params): string;
  /** Kompensasjonsplan som tekst + om den kan utføres automatisk med den fangede før-tilstanden. */
  recovery(action: string, before: JsonValue | null, parameters: Params, externalId: string | undefined): { plan: string; available: boolean };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "?");
const obj = (v: JsonValue | null): Record<string, JsonValue> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, JsonValue>) : null);

export const CLOUDFLARE_PROVIDER: CloudMutationProvider = {
  provider: "cloudflare",
  tool_id: "cloudflare",
  actions: new Set(["create_dns_record", "update_dns_record", "delete_dns_record", "create_waf_rule", "update_waf_rule", "delete_waf_rule", "update_zone_setting", "purge_cache"]),
  target(action, p) {
    const zone = str(p["zone_id"]);
    switch (action) {
      case "create_dns_record": return `cloudflare:${zone}:dns:${str(p["type"]).toUpperCase()}:${str(p["name"]).toLowerCase()}`;
      case "update_dns_record":
      case "delete_dns_record": return `cloudflare:${zone}:dns:${str(p["record_id"])}`;
      case "create_waf_rule": return `cloudflare:${zone}:waf:${str(p["phase"])}`;
      case "update_waf_rule":
      case "delete_waf_rule": return `cloudflare:${zone}:waf:${str(p["phase"])}:${str(p["rule_id"])}`;
      case "update_zone_setting": return `cloudflare:${zone}:setting:${str(p["setting_id"])}`;
      default: return `cloudflare:${zone}:cache`;
    }
  },
  recovery(action, before, p, externalId) {
    const zone = str(p["zone_id"]);
    const b = obj(before);
    switch (action) {
      case "create_dns_record":
        return externalId
          ? { plan: `cloudflare.delete_dns_record(zone_id=${zone}, record_id=${externalId}) - kun hvis posten ikke fantes før mutasjonen (før-tilstand: ingen identisk post)`, available: true }
          : { plan: "ingen opprettet post-id fanget - recovery ikke mulig, dokumentert begrensning", available: false };
      case "update_dns_record":
        return b ? { plan: `cloudflare.update_dns_record(zone_id=${zone}, record_id=${str(p["record_id"])}, innhold/ttl/proxied/kommentar fra før-tilstand: content=${str(b["content"])})`, available: true }
          : { plan: "ingen tidligere tilstand fanget - recovery ikke mulig, dokumentert begrensning", available: false };
      case "delete_dns_record":
        return b ? { plan: `cloudflare.create_dns_record(zone_id=${zone}, type=${str(b["type"])}, name=${str(b["name"])}, content=${str(b["content"])}) - posten får ny id`, available: true }
          : { plan: "ingen tidligere tilstand fanget - recovery ikke mulig, dokumentert begrensning", available: false };
      case "create_waf_rule":
        return externalId
          ? { plan: `cloudflare.delete_waf_rule(zone_id=${zone}, phase=${str(p["phase"])}, rule_id=${externalId}) - kun hvis regelen ikke fantes før mutasjonen`, available: true }
          : { plan: "ingen opprettet regel-id fanget - recovery ikke mulig, dokumentert begrensning", available: false };
      case "update_waf_rule":
        return b ? { plan: `cloudflare.update_waf_rule(zone_id=${zone}, phase=${str(p["phase"])}, rule_id=${str(p["rule_id"])}) med regelens felt fra før-tilstand`, available: true }
          : { plan: "ingen tidligere tilstand fanget - recovery ikke mulig, dokumentert begrensning", available: false };
      case "delete_waf_rule":
        return b ? { plan: `cloudflare.create_waf_rule(zone_id=${zone}, phase=${str(p["phase"])}) med regelens felt fra før-tilstand - regelen får ny id; regler med skip/execute-parametere må gjenopprettes manuelt`, available: true }
          : { plan: "ingen tidligere tilstand fanget - recovery ikke mulig, dokumentert begrensning", available: false };
      case "update_zone_setting":
        return b ? { plan: `cloudflare.update_zone_setting(zone_id=${zone}, setting_id=${str(p["setting_id"])}, value=${str(b["value"])})`, available: true }
          : { plan: "ingen tidligere tilstand fanget - recovery ikke mulig, dokumentert begrensning", available: false };
      default:
        return { plan: "ingen teknisk reversering - cachen fylles på igjen fra opprinnelsen ved neste forespørsel", available: false };
    }
  }
};

const scalar = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "?");

/**
 * Postgres-drift (terminate/cancel/VACUUM) mot Jarvis' EGEN database. BEVISST ærlig om gjenoppretting: en terminert økt kan ikke gjenopprettes og en avbrutt
 * spørring kan ikke gjenopptas (`recovery_available=false`, aldri en fabrikkert reversering) - men før-tilstanden (økt, rolle, applikasjon, normalisert spørring,
 * varighet) er journalført, og gateway-kjeden (preflight av akkurat den økten, readback, varsling) er den samme som for alle andre klasse D-handlinger.
 */
export const POSTGRES_OPS_PROVIDER: CloudMutationProvider = {
  provider: "postgres_ops",
  tool_id: "postgres_ops",
  actions: new Set(["terminate_backend", "cancel_query", "vacuum_analyze"]),
  target(action, p) {
    const database = scalar(p["database"]);
    return action === "vacuum_analyze"
      ? `postgres:${database}:table:${scalar(p["schema"])}.${scalar(p["table"])}`
      : `postgres:${database}:backend:${scalar(p["pid"])}@${scalar(p["backend_start"])}`;
  },
  recovery(action) {
    switch (action) {
      case "terminate_backend":
        return { plan: "ingen teknisk reversering - en terminert økt kan ikke gjenopprettes; applikasjonen kobler til på nytt (før-tilstand er journalført)", available: false };
      case "cancel_query":
        return { plan: "ingen teknisk reversering - en avbrutt spørring kan ikke gjenopptas; klienten kan kjøre den på nytt (før-tilstand er journalført)", available: false };
      default:
        return { plan: "ingen reversering nødvendig - VACUUM/ANALYZE endrer ikke data og er idempotent (før-statistikk er journalført)", available: false };
    }
  }
};

/**
 * Infisical-rotasjon (klasse D, «secrets er klasse D»). Før-tilstanden er rotasjonens STATUS/TIDSPUNKT - aldri verdier. Ærlig «ingen teknisk reversering»:
 * den forrige verdien ligger i Infisicals egen versjonshistorikk og må gjenopprettes manuelt der.
 */
export const INFISICAL_PROVIDER: CloudMutationProvider = {
  provider: "infisical",
  tool_id: "infisical",
  actions: new Set(["rotate_secrets"]),
  target(_action, p) {
    return `infisical:rotation:${scalar(p["rotation_id"]).toLowerCase()}`;
  },
  recovery() {
    return {
      plan: "ingen teknisk reversering - den forrige verdien ligger i Infisicals versjonshistorikk og må gjenopprettes manuelt der; avhengige tjenester må hente ny verdi (før-tilstand er journalført, aldri verdier)",
      available: false
    };
  }
};

export const CLOUD_MUTATION_PROVIDERS: Readonly<Record<string, CloudMutationProvider>> = {
  cloudflare: CLOUDFLARE_PROVIDER, postgres_ops: POSTGRES_OPS_PROVIDER, infisical: INFISICAL_PROVIDER
};

export interface ExecuteCloudMutationInput {
  tenant_id: string;
  person_id?: string;
  device_id?: string;
  incident_id?: string;
  provider: string;
  action: string;
  parameters: Params;
  idempotency_key: string;
}

/**
 * Utfallet av en gateway-utførelse: `ok` = verifisert; `postcondition_*` = mutasjonen LYKTES men etterbetingelsen holdt ikke (PARTIAL); et tidsavbrudd
 * kan ha endret noe uten at vi vet det (UNKNOWN); alt annet (nektelse, ugyldig inndata, leverandørfeil) = FAILED (ingenting er verifisert endret).
 */
export function classifyGatewayOutcome(result: ToolResult): InfraOperationalOutcome {
  if (result.ok) return "SUCCESS";
  if (result.reason.startsWith("postcondition_unverified:tool_timeout") || result.reason.startsWith("postcondition_unverified:ledger_finalize_failed")) return "UNKNOWN";
  if (result.reason.startsWith("postcondition_")) return "PARTIAL";
  return "FAILED";
}

export async function executeCloudMutation(
  deps: { pool: pg.Pool; gateway: ToolGateway },
  identity: IdentityContext,
  input: ExecuteCloudMutationInput
): Promise<InfraExecution> {
  const adapter = CLOUD_MUTATION_PROVIDERS[input.provider];
  if (!adapter) throw new Error(`cloud_mutation_unknown_provider:${input.provider.slice(0, 40)}`);
  if (!adapter.actions.has(input.action)) throw new Error(`cloud_mutation_unknown_action:${input.action.slice(0, 60)}`);
  const definition = deps.gateway.get(adapter.tool_id, input.action);
  if (!definition) throw new Error("cloud_mutation_tool_not_registered");
  const target = adapter.target(input.action, input.parameters);

  // Idempotent retry (D-398-mønsteret): samme nøkkel + samme handling/mål => den EKSISTERENDE journalraden; samme nøkkel for noe annet => eksplisitt konflikt.
  const prior = await findExecutionByKey(deps.pool, input.tenant_id, input.idempotency_key);
  if (prior) {
    if (prior.action === input.action && prior.tool_id === adapter.tool_id && prior.target === target) return prior;
    throw new Error("infra_idempotency_key_conflict");
  }

  const result = await deps.gateway.execute({
    identity, tool_id: adapter.tool_id, action: input.action, parameters: input.parameters, idempotency_key: input.idempotency_key
  });
  const verification_outcome = classifyGatewayOutcome(result);
  const { before, after, key_collision, external_id: ledgerExternalId } = await readToolExecutionState(deps.pool, input.tenant_id, input.idempotency_key, { tool_id: adapter.tool_id, action: input.action });
  // Ved PARTIAL/UNKNOWN (mutasjonen skjedde, verifiseringen feilet) er den eksterne id-en bare i ledgeren - den trengs for kompensasjon av opprettelser.
  const externalId = (result.ok ? result.external_id : undefined) ?? ledgerExternalId ?? undefined;
  const state_diff = computeStateDiff(before, after);
  const recovery = adapter.recovery(input.action, before, input.parameters, externalId);
  const provider_receipt: JsonValue = result.ok
    ? ({ external_id: externalId ?? null, ...(key_collision ? { key_collision: true } : {}) } as unknown as JsonValue)
    : ({ reason: result.reason.slice(0, 200), ...(externalId ? { external_id: externalId } : {}) } as unknown as JsonValue);
  const risk_class: InfraRiskClass = definition.capability_class;

  return withTenantTransaction(deps.pool, input.tenant_id, async (client) => {
    const execution_id = `inf-exec-${randomUUID()}`;
    const { rows } = await client.query(
      `INSERT INTO infra_executions
         (execution_id, tenant_id, person_id, device_id, target, provider, tool_id, action, risk_class, authority_mode,
          incident_id, idempotency_key, requested_operation, requested_state, before_state, recovery_plan,
          provider_receipt, after_state, state_diff, verification_outcome, recovery_available)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        execution_id, input.tenant_id, input.person_id ?? null, input.device_id ?? null, target, adapter.provider, adapter.tool_id, input.action, risk_class,
        input.incident_id ?? null, input.idempotency_key, `${adapter.tool_id}.${input.action}:${target}`, JSON.stringify(input.parameters),
        before === null ? null : JSON.stringify(before), recovery.plan, JSON.stringify(provider_receipt), after === null ? null : JSON.stringify(after),
        state_diff === null ? null : JSON.stringify(state_diff), verification_outcome, recovery.available && verification_outcome !== "FAILED"
      ]
    );
    if (rows[0]) return rows[0] as InfraExecution;
    // Samtidig kall med samme nøkkel vant racet (UNIQUE) - returner vinnerens journalrad.
    return (await client.query(`SELECT * FROM infra_executions WHERE tenant_id = $1 AND idempotency_key = $2`, [input.tenant_id, input.idempotency_key])).rows[0] as InfraExecution;
  });
}
