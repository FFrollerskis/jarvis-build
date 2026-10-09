import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolTransport } from "./gateway.ts";
import {
  CLOUDFLARE_DNS_WRITE_TYPES,
  CLOUDFLARE_READABLE_PHASES,
  CLOUDFLARE_WAF_ACTIONS,
  CLOUDFLARE_WAF_PHASES,
  CLOUDFLARE_ZONE_SETTING_IDS,
  CLOUDFLARE_PURGE_MODES,
  authorizeCloudflareTarget,
  dnsContentMatches,
  type CloudflareMutationAction
} from "./cloudflare-target-policy.ts";

/**
 * WP-E1 (UA-5, D-41 maksimal kapabilitet, regel 11): `ToolDefinition`-ene for Cloudflare. Lesing = klasse A (ubetrodd utdata - DNS-innhold er data fra
 * utsiden). DNS-poster, WAF-/rate-limit-regler og sone-innstillinger = klasse D (masterplanen: DNS/IAM/WAF/secrets er klasse D, autonome i Sovereign
 * Mode med mål-re-lesing, snapshot og umiddelbar varsling): HELE klasse D-kjeden (`assessClassDPipeline`) er oppfylt per handling:
 *   1. fersk tilstandslesing (`preflight_action`) med målvalidering (`preflight_requires_target` / `preflight_target_check`),
 *   2. snapshot av eksisterende tilstand = `before_state` i `tool_executions`/audit (+ `infra_executions` via `executeCloudMutation`),
 *   3. idempotens-nøkkel PÅKREVD (gatewayen avviser uten),
 *   4. etterbetingelse (readback): predikat mot den leste etter-tilstanden, eller `postcondition_target_absent` for sletting,
 *   5. umiddelbar out-of-band-varsling (`ClassDNotifier` - uten klar varsler er handlingen utilgjengelig),
 *   6. kompensasjon (`rollback_procedure` + `RECOVERY_STRATEGIES` i `modules/incidents/src/recovery.ts`, testet mot before_state).
 * `purge_cache` er klasse C: den flytter produksjonslast mot opprinnelsen og kan ikke angres teknisk (cachen fylles på igjen), men har ingen lesbar
 * før-/etter-tilstand å journalføre - derfor C (ikke D) med dokumentert, ærlig «ingen reversering».
 *
 * Mål-autorisasjon (sonen står i `JARVIS_CLOUDFLARE_MUTATION_ZONES`) håndheves av `parameterAuthorizer` i selve gateway-pipelinen. Eier- og delegert
 * oppførsel: kun den autentiserte eieren kan bruke connectoren (credential-binding, D-377); en delegert identitet får `credential_not_bound_to_identity`.
 * Credential uten verdi => `credential_unavailable` for ALLE handlinger (connectoren er sovende til eieren har satt `JARVIS_CLOUDFLARE_API_TOKEN`).
 * Verktøy-id `cloudflare` står i `infraToolIds` (PAUSED stanser B/C/D, DEGRADED stanser D, lesing er aldri stanset) og er et eier-eksklusivt navnerom
 * som aldri kan stå på en modellflate (`FORBIDDEN_MODEL_TOOL_IDS`/`OWNER_ONLY_NAMESPACES`).
 */
export const CLOUDFLARE_CREDENTIAL_REF = "JARVIS_CLOUDFLARE_API_TOKEN";

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;
const cfId = z.string().regex(/^[0-9a-f]{32}$/);
const dnsType = z.enum(CLOUDFLARE_DNS_WRITE_TYPES);
const wafPhase = z.enum(CLOUDFLARE_WAF_PHASES);
const settingId = z.enum(CLOUDFLARE_ZONE_SETTING_IDS as [string, ...string[]]);

type Params = Record<string, JsonValue>;
interface DnsRecordView { id?: string; type: string | null; name: string | null; content: string | null; ttl: number | null; proxied: boolean | null; comment: string | null; priority: number | null }
interface RuleView { id: string; action: string | null; expression: string | null; description: string; enabled: boolean }

const asRecords = (after: JsonValue): DnsRecordView[] => ((after as { records?: DnsRecordView[] } | null)?.records ?? []);
const asRules = (state: JsonValue): RuleView[] => ((state as { rules?: RuleView[] } | null)?.rules ?? []);

export function cloudflareToolDefinitions(transport: ToolTransport, config: { mutationZones?: ReadonlySet<string> } = {}): ToolDefinition[] {
  const zones = config.mutationZones ?? new Set<string>();
  const authorizer = (action: CloudflareMutationAction) => (parameters: Params) => authorizeCloudflareTarget(action, parameters["zone_id"], zones);

  const read = (action: string, description: string, shape: z.ZodRawShape = {}, scopes = ["cloudflare:read"]): ToolDefinition => ({
    tool_id: "cloudflare", action, description, input_schema: record(shape), capability_class: "A", scopes,
    reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true, timeout_ms: 25_000, rate_limit_per_minute: 30,
    credential_ref: CLOUDFLARE_CREDENTIAL_REF, output_trust: "untrusted", transport
  });
  const write = (
    action: CloudflareMutationAction,
    description: string,
    shape: z.ZodRawShape,
    extra: Pick<ToolDefinition, "rollback_procedure" | "preflight_action"> & Partial<ToolDefinition>
  ): ToolDefinition => ({
    tool_id: "cloudflare", action, description, input_schema: record(shape), capability_class: "D", scopes: ["cloudflare:write"],
    reversible: true, idempotent_external: false, timeout_ms: 45_000, rate_limit_per_minute: 10,
    credential_ref: CLOUDFLARE_CREDENTIAL_REF, output_trust: "internal", transport,
    parameterAuthorizer: authorizer(action),
    ...extra
  });

  return [
    read("check_token", "Verifiser Cloudflare API-tokenet (status active/disabled/expired + utløp) - selve tokenet returneres aldri"),
    read("list_zones", "List Cloudflare-soner i den konfigurerte kontoen (id, navn, status, navnetjenere)"),
    read("get_zone", "Les én sone (null hvis den ikke finnes; avvises hvis den tilhører en annen konto)", { zone_id: cfId }),
    read("list_dns_records", "List DNS-poster i en sone (valgfritt eksakt type/navn; maks 1000 poster, avkorting meldes)", { zone_id: cfId, type: z.string().max(12).optional(), name: z.string().max(253).optional() }),
    read("find_dns_records", "Finn DNS-poster med eksakt type+navn (alltid et objekt, også uten treff) - preflight/readback for opprettelse", { zone_id: cfId, type: z.string().max(12).optional(), name: z.string().max(253).optional() }),
    read("get_dns_record", "Les én DNS-post (null hvis den ikke finnes) - preflight/readback for endring og sletting", { zone_id: cfId, record_id: cfId }),
    read("get_ruleset", "Les WAF-/rate-limit-entrypoint-rulesettet for en fase (exists:false hvis det ikke er opprettet ennå)", { zone_id: cfId, phase: z.enum(CLOUDFLARE_READABLE_PHASES) }),
    read("get_zone_setting", "Les én sone-innstilling (ssl, min_tls_version, always_use_https, development_mode, security_level, tls_1_3)", { zone_id: cfId, setting_id: settingId }),
    read("list_zone_settings", "Les alle støttede sone-innstillinger (per-innstilling-endepunktet; det deprecated batch-endepunktet brukes ikke)", { zone_id: cfId }),
    read("list_account_members", "List kontomedlemmer (tilgangsstyring, kun lesing; e-post maskeres)", {}, ["cloudflare:access_read"]),
    read("list_account_roles", "List kontoroller (tilgangsstyring, kun lesing)", {}, ["cloudflare:access_read"]),
    read("list_api_tokens", "List API-token-metadata for kontoen (navn, status, utløp - aldri verdier)", {}, ["cloudflare:access_read"]),
    read("list_audit_logs", "Les Cloudflares audit-logg (konto, v2): hva ble endret når - uten aktørens e-post/IP", { since: z.string().max(40).optional(), before: z.string().max(40).optional(), limit: z.number().int().min(1).max(100).optional() }, ["cloudflare:access_read"]),

    write("create_dns_record", "Opprett en DNS-post (A/AAAA/CNAME/TXT/MX/NS) - identisk post gir ingen ny opprettelse; kun soner i JARVIS_CLOUDFLARE_MUTATION_ZONES",
      { zone_id: cfId, type: dnsType, name: z.string().min(1).max(253), content: z.string().min(1).max(2048), ttl: z.number().int().optional(), proxied: z.boolean().optional(), comment: z.string().max(100).optional(), priority: z.number().int().optional() },
      {
        rollback_procedure: "cloudflare.delete_dns_record på posten som ble opprettet (external_id = post-id); recovery verifiserer at den er borte",
        preflight_action: "find_dns_records", preflight_requires_target: true,
        postcondition_predicate: (after, p) => asRecords(after).some((r) =>
          r.type === p["type"] && r.name === String(p["name"]).toLowerCase() && dnsContentMatches(String(p["type"]), String(p["content"]), r.content ?? "") &&
          (p["proxied"] === undefined || r.proxied === p["proxied"]))
      }),
    write("update_dns_record", "Endre en eksisterende DNS-post (innhold/ttl/proxied/kommentar/prioritet) - type og navn kan ikke endres; snapshot av posten tas før endringen",
      { zone_id: cfId, record_id: cfId, content: z.string().min(1).max(2048).optional(), ttl: z.number().int().optional(), proxied: z.boolean().optional(), comment: z.string().max(100).optional(), priority: z.number().int().optional() },
      {
        rollback_procedure: "cloudflare.update_dns_record med feltene fra before_state (innhold/ttl/proxied/kommentar), verifisert ved ny lesing",
        idempotent_external: true,
        preflight_action: "get_dns_record", preflight_requires_target: true,
        postcondition_predicate: (after, p) => {
          const r = after as DnsRecordView | null;
          if (!r) return false;
          if (p["content"] !== undefined && !dnsContentMatches(r.type ?? "", String(p["content"]), r.content ?? "")) return false;
          // En proxiet post har alltid automatisk TTL (1) hos Cloudflare, uansett ønsket verdi.
          if (p["ttl"] !== undefined && r.proxied !== true && r.ttl !== p["ttl"]) return false;
          if (p["proxied"] !== undefined && r.proxied !== p["proxied"]) return false;
          if (p["comment"] !== undefined && (r.comment ?? "") !== p["comment"]) return false;
          if (p["priority"] !== undefined && r.priority !== p["priority"]) return false;
          return true;
        }
      }),
    write("delete_dns_record", "Slett en DNS-post PERMANENT - snapshot av posten tas først og brukes til gjenoppretting (ny post-id)",
      { zone_id: cfId, record_id: cfId },
      {
        rollback_procedure: "cloudflare.create_dns_record med type/navn/innhold/ttl/proxied/kommentar fra before_state (posten får ny id); recovery verifiserer ved ny lesing",
        idempotent_external: true,
        preflight_action: "get_dns_record", preflight_requires_target: true,
        postcondition_target_absent: true
      }),
    write("create_waf_rule", "Opprett en WAF custom rule (http_request_firewall_custom) eller rate limiting-regel (http_ratelimit) via Rulesets API - identisk regel gir ingen ny opprettelse",
      { zone_id: cfId, phase: wafPhase, action: z.enum(CLOUDFLARE_WAF_ACTIONS), expression: z.string().min(1).max(4096), description: z.string().max(500).optional(), enabled: z.boolean().optional(),
        ratelimit: z.object({ characteristics: z.array(z.string().max(120)).min(1).max(10), period: z.number().int(), requests_per_period: z.number().int(), mitigation_timeout: z.number().int().optional() }).strict().optional() },
      {
        rollback_procedure: "cloudflare.delete_waf_rule på regelen som ble opprettet (external_id = regel-id); recovery verifiserer at den er borte",
        preflight_action: "get_ruleset", preflight_requires_target: true,
        postcondition_predicate: (after, p) => asRules(after).some((r) =>
          r.action === p["action"] && r.expression === p["expression"] && r.description === String(p["description"] ?? "") && r.enabled === (p["enabled"] ?? true))
      }),
    write("update_waf_rule", "Endre en eksisterende WAF-/rate-limit-regel (handling/uttrykk/beskrivelse/aktiv) - hele regelen (inkl. ukjente felt) sendes slik at ingenting mistes",
      { zone_id: cfId, phase: wafPhase, rule_id: cfId, action: z.enum(CLOUDFLARE_WAF_ACTIONS).optional(), expression: z.string().min(1).max(4096).optional(), description: z.string().max(500).optional(), enabled: z.boolean().optional(),
        ratelimit: z.object({ characteristics: z.array(z.string().max(120)).min(1).max(10), period: z.number().int(), requests_per_period: z.number().int(), mitigation_timeout: z.number().int().optional() }).strict().optional() },
      {
        rollback_procedure: "cloudflare.update_waf_rule med regelens felt fra before_state, verifisert ved ny lesing av entrypoint-rulesettet",
        idempotent_external: true,
        preflight_action: "get_ruleset", preflight_requires_target: true,
        preflight_target_check: (state, p) => asRules(state).some((r) => r.id === p["rule_id"]),
        postcondition_predicate: (after, p) => {
          const r = asRules(after).find((x) => x.id === p["rule_id"]);
          if (!r) return false;
          return (p["action"] === undefined || r.action === p["action"]) && (p["expression"] === undefined || r.expression === p["expression"])
            && (p["description"] === undefined || r.description === p["description"]) && (p["enabled"] === undefined || r.enabled === p["enabled"]);
        }
      }),
    write("delete_waf_rule", "Slett en WAF-/rate-limit-regel PERMANENT - snapshot av regelen tas først og brukes til gjenoppretting (ny regel-id)",
      { zone_id: cfId, phase: wafPhase, rule_id: cfId },
      {
        rollback_procedure: "cloudflare.create_waf_rule med regelens felt fra before_state (regelen får ny id); recovery verifiserer ved ny lesing",
        idempotent_external: true,
        preflight_action: "get_ruleset", preflight_requires_target: true,
        preflight_target_check: (state, p) => asRules(state).some((r) => r.id === p["rule_id"]),
        postcondition_predicate: (after, p) => !asRules(after).some((r) => r.id === p["rule_id"])
      }),
    write("update_zone_setting", "Endre én sone-innstilling (ssl, min_tls_version, always_use_https, development_mode, security_level, tls_1_3) til en verdi fra den lukkede mengden",
      { zone_id: cfId, setting_id: settingId, value: z.string().min(1).max(32) },
      {
        rollback_procedure: "cloudflare.update_zone_setting med verdien fra before_state, verifisert ved ny lesing",
        idempotent_external: true,
        preflight_action: "get_zone_setting", preflight_requires_target: true,
        postcondition_predicate: (after, p) => (after as { value?: unknown } | null)?.value === p["value"]
      }),
    {
      tool_id: "cloudflare", action: "purge_cache",
      description: "Tøm Cloudflare-cachen for en sone (everything/files/hosts/prefixes/tags) - flytter produksjonslast mot opprinnelsen, kan ikke angres teknisk",
      input_schema: record({ zone_id: cfId, mode: z.enum(CLOUDFLARE_PURGE_MODES as unknown as [string, ...string[]]), items: z.array(z.string().max(2048)).max(30).optional() }),
      capability_class: "C", scopes: ["cloudflare:cache"], reversible: false,
      rollback_procedure: "ingen teknisk reversering - cachen fylles på igjen fra opprinnelsen ved neste forespørsel; ved belastningsproblemer: send mindre purge eller aktiver development_mode",
      idempotent_external: true, timeout_ms: 45_000, rate_limit_per_minute: 5, credential_ref: CLOUDFLARE_CREDENTIAL_REF,
      output_trust: "internal", transport, parameterAuthorizer: authorizer("purge_cache")
    }
  ];
}
