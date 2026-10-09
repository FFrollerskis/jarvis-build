import { z } from "zod";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import type { ExecutiveService } from "./service.ts";
import { summarizeCapabilityStatusNo, summarizeConnectorStatusNo, summarizeSelfDiagnosisNo } from "./status-summary.ts";

/**
 * UA-11 Executive Mode (P0, D-162): eierens SAMLEDE kontrollflate, eksponert
 * som et vanlig ToolGateway-verktøy (`tool_id: "executive"`) - SAMME mønster
 * som `SituationsTransport` (D-160). IDENTITET KOMMER UTELUKKENDE FRA
 * `ToolInvocationContext` (D-68), ALDRI fra `parameters` - identisk
 * disiplin og identisk feilmodus (`executive_missing_invocation_context`)
 * som `SituationsTransport`. Skjemaene er `strict()` og inneholder INGEN
 * identitetsfelt.
 *
 * Denne transporten implementerer INGEN pause-/policy-/autoritetslogikk
 * selv - `ExecutiveService` videresender hvert muterende kall til
 * `situations.*` via `ToolGateway.execute()` (nøstet, med den SAMME
 * `context.identity`). Se `service.ts` sitt filhode.
 */
export class ExecutiveTransport implements ToolTransport {
  constructor(private readonly service: ExecutiveService) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential: string,
    context?: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const identity = context?.identity;
    if (!identity || typeof identity.tenant_id !== "string" || typeof identity.memory_space_id !== "string" || typeof identity.person_id !== "string") {
      throw new Error("executive_missing_invocation_context");
    }
    switch (action) {
      case "get_attention_queue": {
        const filter = parameters["domain"] !== undefined ? { domain: String(parameters["domain"]) } : {};
        const items = await this.service.getAttentionQueue(identity, filter);
        return { data: items as unknown as JsonValue };
      }
      case "get_attention_item": {
        const item = await this.service.getAttentionItem(identity, requireString(parameters, "situation_id"));
        if (!item) throw new Error("attention_item_not_found");
        return { external_id: item.situation_id, data: item as unknown as JsonValue };
      }
      case "get_pause_state": {
        const result = await this.service.getPauseState(identity);
        return toolResultToTransportResult(result);
      }
      case "pause_domain": {
        const result = await this.service.pauseDomain(identity, requireString(parameters, "domain"), requireString(parameters, "reason"));
        return toolResultToTransportResult(result);
      }
      case "resume_domain": {
        const result = await this.service.resumeDomain(identity, requireString(parameters, "domain"));
        return toolResultToTransportResult(result);
      }
      case "resolve_situation": {
        const result = await this.service.resolveSituation(identity, requireString(parameters, "situation_id"));
        return toolResultToTransportResult(result);
      }
      case "get_control_surface_status": {
        const status = await this.service.getControlSurfaceStatus(identity);
        return { data: status as unknown as JsonValue };
      }
      case "get_delegation_board": {
        const board = await this.service.getDelegationBoard(identity);
        return { data: board as unknown as JsonValue };
      }
      case "get_capability_status": {
        const status = await this.service.getCapabilityStatus(context?.servingModel);
        return { data: { ...status, summary_no: summarizeCapabilityStatusNo(status) } as unknown as JsonValue };
      }
      case "get_self_diagnosis": {
        const diagnosis = await this.service.getSelfDiagnosis();
        return { data: { ...diagnosis, summary_no: summarizeSelfDiagnosisNo(diagnosis) } as unknown as JsonValue };
      }
      case "get_slo_report": {
        const report = await this.service.getSloReport();
        return { data: report as unknown as JsonValue };
      }
      case "get_evolution_report": {
        const report = await this.service.getEvolutionReport();
        return { data: report as unknown as JsonValue };
      }
      case "get_value_report": {
        // WP-C4: tenanten kommer UTELUKKENDE fra den betrodde kontekst-identiteten (D-68), aldri fra parametre.
        const report = await this.service.getValueReport(identity.tenant_id);
        return { data: report as unknown as JsonValue };
      }
      case "get_infra_status": {
        // WP-E1: tenanten kommer UTELUKKENDE fra den betrodde kontekst-identiteten (D-68), aldri fra parametre.
        const report = await this.service.getInfraStatus(identity.tenant_id);
        return { data: report as unknown as JsonValue };
      }
      case "get_connector_status": {
        const status = await this.service.getConnectorStatus();
        return { data: { ...status, summary_no: summarizeConnectorStatusNo(status.connectors) } as unknown as JsonValue };
      }
      case "activate_kill_switch": {
        const result = await this.service.activateKillSwitch(identity, requireString(parameters, "reason"));
        return toolResultToTransportResult(result);
      }
      case "deactivate_kill_switch": {
        const result = await this.service.deactivateKillSwitch(identity);
        return toolResultToTransportResult(result);
      }
      case "freeze_connector": {
        const result = await this.service.freezeConnector(identity, requireString(parameters, "connector_id"), requireString(parameters, "reason"));
        return toolResultToTransportResult(result);
      }
      case "unfreeze_connector": {
        const result = await this.service.unfreezeConnector(identity, requireString(parameters, "connector_id"));
        return toolResultToTransportResult(result);
      }
      case "revoke_credential": {
        const result = await this.service.revokeCredential(identity, requireString(parameters, "credential_ref"), requireString(parameters, "reason"));
        return toolResultToTransportResult(result);
      }
      case "restore_credential": {
        const result = await this.service.restoreCredential(identity, requireString(parameters, "credential_ref"));
        return toolResultToTransportResult(result);
      }
      case "revoke_device": {
        const result = await this.service.revokeDevice(
          identity,
          requireString(parameters, "device_id"),
          requireString(parameters, "reason")
        );
        return toolResultToTransportResult(result);
      }
      case "enable_finance_kill_switch": {
        const result = await this.service.enableFinanceKillSwitch(identity, requireString(parameters, "reason"));
        return toolResultToTransportResult(result);
      }
      case "disable_finance_kill_switch": {
        const result = await this.service.disableFinanceKillSwitch(identity);
        return toolResultToTransportResult(result);
      }
      case "get_finance_kill_switch": {
        const result = await this.service.getFinanceKillSwitch(identity);
        return toolResultToTransportResult(result);
      }
      default:
        throw new Error(`unknown_executive_action:${action}`);
    }
  }
}

/**
 * `ExecutiveService`s passthrough-metoder returnerer den nøstede
 * `situations.*`-kallets EGEN `ToolResult` (inkl. `ok:false`-avslag fra
 * PolicyGateway/motoren). Denne transporten KASTER på avslag (i stedet for
 * å returnere `{data:{ok:false,...}}`) slik at det ytre `ToolGateway.execute
 * ("executive", ...)`-kallet selv blir `ok:false` med SAMME `reason` -
 * avslaget forplanter seg gjennomsiktig, det blir ALDRI en stille "ok:true"
 * på executive-laget for en handling situations-laget faktisk nektet.
 */
function toolResultToTransportResult(result: { ok: boolean; reason?: string; external_id?: string; data?: JsonValue }): {
  external_id?: string;
  data?: JsonValue;
} {
  if (!result.ok) throw new Error(result.reason ?? "situations_call_denied");
  return { ...(result.external_id !== undefined ? { external_id: result.external_id } : {}), ...(result.data !== undefined ? { data: result.data } : {}) };
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_parameter:${key}`);
  return value;
}

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

/**
 * ToolGateway-definisjonene for den samlede kontrollflaten. Lese-handlinger
 * er klasse A (samme som `situations.get_queue`/`get_pause_state` selv);
 * pause/resume/resolve er klasse C (samme klasse som de underliggende
 * `situations.*`-handlingene de videresender til - IKKE lavere, IKKE
 * høyere, ALDRI en egen risikoklassifisering for samme reelle mutasjon).
 * `credential_ref` er SAMME interne sentinel som `situations`/`business`/...
 * (se `situations/transport.ts` sitt HOST-FUNN-avsnitt for hele
 * begrunnelsen for hvorfor dette MÅ løses av produksjonens ekte kjede).
 *
 * D-174 (B2): SAMME "speil, aldri egen klassifisering"-disiplin gjelder de
 * nye `owner_controls.*`/`finance.*`-gjennomslagene under - klassen er
 * IDENTISK med målhandlingens egen (`activate_kill_switch`/
 * `deactivate_kill_switch`/`enable_finance_kill_switch`/
 * `disable_finance_kill_switch` er klasse D, SAMME alvorlighetsgrad som
 * `owner_controls`/`finance` sine egne definisjoner - `critical()` under;
 * `freeze_connector`/`unfreeze_connector`/`revoke_credential`/
 * `restore_credential`/`revoke_device` er klasse C, SAMME som
 * `owner_controls` sine egne - `control()` gjenbrukes uendret).
 */
export function executiveToolDefinitions(transport: ExecutiveTransport): ToolDefinition[] {
  const common = {
    credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF,
    output_trust: "internal" as const,
    transport,
    timeout_ms: 10_000,
    rate_limit_per_minute: 30
  };
  const read = (action: string, description: string, extra: z.ZodRawShape = {}): ToolDefinition => ({
    tool_id: "executive", action, description, input_schema: record(extra),
    capability_class: "A", scopes: ["executive.read"], reversible: true,
    rollback_procedure: "ingen (lesing)", idempotent_external: true, ...common
  });
  const control = (action: string, description: string, extra: z.ZodRawShape, rollback: string): ToolDefinition => ({
    tool_id: "executive", action, description, input_schema: record(extra),
    capability_class: "C", scopes: ["executive.control"], reversible: true,
    rollback_procedure: rollback, idempotent_external: true, ...common
  });
  /** D-174: klasse D - SAMME alvorlighetsgrad som `owner_controls.activate_kill_switch`/`finance.enable_kill_switch` selv (den mest alvorlige bryteren, se transport.ts sine egne filhoder). */
  const critical = (action: string, description: string, extra: z.ZodRawShape, rollback: string): ToolDefinition => ({
    tool_id: "executive", action, description, input_schema: record(extra),
    capability_class: "D", scopes: ["executive.control"], reversible: true,
    rollback_procedure: rollback, idempotent_external: true, ...common
  });
  return [
    read("get_attention_queue", "Les eierens rangerte attention-kø (åpne, attention-verdige situasjoner, forklart og prioritert)", { domain: z.string().optional() }),
    read("get_attention_item", "Les full detalj/begrunnelse for ETT attention-item, inkl. kilde-situasjonen", { situation_id: z.string() }),
    read("get_pause_state", "Les hvilke situasjonsdomener som er pauset akkurat nå (gjennomslag til situations.get_pause_state)"),
    read(
      "get_control_surface_status",
      "Les HELE eier-kontrolloverflaten samlet: global kill switch, frosne connectorer, tilbakekalte credentials (owner_controls.get_control_state) OG domene-avgrenset pausetilstand (situations.get_pause_state) - UA-11 sitt bidrag til UA-11 akseptansekriterium 3 (D-164)"
    ),
    read(
      "get_delegation_board",
      "Les delegation board: hvilke situasjonsdomener Jarvis har delegert autonom handlingsrett for (situations.list_autonomy_policies), frosne connectorer/tilbakekalte credentials (owner_controls.get_control_state) og finans-nødbryteren (finance.get_kill_switch) - K2, ren komposisjon, INGEN egen tabell (D-64)"
    ),
    read(
      "get_capability_status",
      "Sjekk EKTE, oppdatert selv-bevissthet: hvilke verktøy er faktisk tilgjengelige i DENNE samtalen (chat_accessible_tools, samme kilde chat-verktøykjeden selv bruker), hvilken modell/leverandør som FAKTISK genererer denne turen (serving_model, D-317) og siste kjente helsetilstand per tilkoblet system (connector_health) - bruk DETTE fremfor å gjette på egne evner eller hvilken modell du er (D-209/D-317)"
    ),
    read(
      "get_self_diagnosis",
      "Svar på «hva er galt med deg akkurat nå?» fra EKTE, kildebelagte målinger (database, modellleverandører, eier-kontroller, tilkoblinger, jobber, verktøyfeil siste time, prosess, konstitusjon, endringsregister, backup, watchdog, bygg) - hvert funn har kilde og tidspunkt; ukjent vises som UKJENT (aldri som frisk) - pluss en liste over det Jeg vet at jeg ikke kan. Bruk dette i stedet for å gjette."
    ),
    read(
      "get_slo_report",
      "Svar på «hvor bra yter du?»/«er du treg?»/«har noe blitt dårligere?» fra EKTE målinger (cost_events, verktøyutførelser, jobber): tjenestemål (SLO) for chat, bakgrunn, verktøy og jobber, gradvis forverring (siste døgn mot uken før) og dataskvalitet i minnet (motstridende, duplikate, utløpte, gamle forslag). For lite data vises som ukjent, aldri som bra. Tallene er forslag til mål, ikke eier-godkjente."
    ),
    read(
      "get_evolution_report",
      "Svar på «hvordan utvikler du deg?»/«hva kan du forbedre?»/«hva har du lært?»: evolusjonsportene (EV-0…EV-23) slik de står NÅ, fra EKTE målinger (endringsregister, kostnad, tilkoblinger, vedlikeholdsplan, modellvalg i skygge …). KUN observasjon - jeg endrer ingenting av meg selv (selvendring er frosset), og sovende deler sies å være sovende. Ukjent vises som ukjent, aldri som bra."
    ),
    read(
      "get_value_report",
      "Svar på «hva har du hjulpet meg med?»/«hvor mye bruker jeg deg?»/«hva er verdien?» fra EKTE tall (kun antall og tidspunkt - aldri innhold): bruk per verdiløkke (Daily Brief, oppfølging, jobber, samtaler, bekreftelser, kost) siste 7 og 30 døgn, pluss status for de sovende løkkene (Builder Loop-beredskap og driftsforslag). Det som ikke kan måles står som «ikke målbart», aldri som 0. Gjengi summary_no."
    ),
    read(
      "get_infra_status",
      "Svar på «hva er status på driften?»/«er noe nede?»/«har vi åpne hendelser?»/«hvordan går det med skyen?» fra EKTE data: åpne hendelser (fase åpen/anerkjent/avbøtende, alvorlighet, hvor mye som er bekreftet vs. observert vs. påstått, siste endring), de tilkoblede skymålene (Cloudflare, Vercel, Google Cloud, Docker, Langfuse, Infisical, Postgres) med helse og siste journalførte endring, og om hendelsesprodusentene selv kjører. Ingen hemmeligheter eller hendelsestekst. Sier ifra når automatisk oppdagelse er AV (da betyr «ingen hendelser» kun «ingen registrert manuelt»). Ukjent vises som ukjent. Gjengi summary_no."
    ),
    read(
      "get_connector_status",
      "Les eierens integrasjons-oversikt: hver kjente connector (GitHub/Kalender/Gmail/Drive/Telegram/Vercel/modell-leverandører/finans), er den konfigurert (credential-presence, ALDRI selve verdien) og siste kjente tilkoblingshelse - D-211"
    ),
    control("pause_domain", "Pause ETT situasjonsdomene umiddelbart (gjennomslag til situations.pause_domain)", { domain: z.string(), reason: z.string() }, "resume_domain"),
    control("resume_domain", "Opphev pause for ETT situasjonsdomene (gjennomslag til situations.unpause_domain)", { domain: z.string() }, "pause_domain"),
    {
      tool_id: "executive", action: "resolve_situation", description: "Løs et attention-item manuelt (gjennomslag til situations.resolve)",
      input_schema: record({ situation_id: z.string() }),
      capability_class: "B", scopes: ["executive.write"], reversible: true,
      rollback_procedure: "en ny deteksjon gjenåpner situasjonen automatisk", idempotent_external: true, ...common
    },
    critical("activate_kill_switch", "Stans HELE systemet umiddelbart (gjennomslag til owner_controls.activate_kill_switch)", { reason: z.string() }, "deactivate_kill_switch"),
    critical("deactivate_kill_switch", "Opphev kill switch og gjenoppta normal drift (gjennomslag til owner_controls.deactivate_kill_switch)", {}, "activate_kill_switch"),
    control("freeze_connector", "Frys ÉN navngitt connector/tool_id umiddelbart (gjennomslag til owner_controls.freeze_connector)", { connector_id: z.string(), reason: z.string() }, "unfreeze_connector"),
    control("unfreeze_connector", "Opphev frys for ÉN navngitt connector/tool_id (gjennomslag til owner_controls.unfreeze_connector)", { connector_id: z.string() }, "freeze_connector"),
    control("revoke_credential", "Tilbakekall ÉN navngitt credential_ref umiddelbart (gjennomslag til owner_controls.revoke_credential)", { credential_ref: z.string(), reason: z.string() }, "restore_credential"),
    control("restore_credential", "Gjenopprett ÉN navngitt, tidligere tilbakekalt credential_ref (gjennomslag til owner_controls.restore_credential)", { credential_ref: z.string() }, "revoke_credential"),
    control(
      "revoke_device",
      "Tilbakekall ALLE utestående session_grants for ÉN navngitt enhet i EGEN tenant umiddelbart (gjennomslag til owner_controls.revoke_device - tenanten er ALLTID identity.tenant_id, ALDRI et parameter, D-175)",
      { device_id: z.string(), reason: z.string() },
      "enheten må re-rulleres inn (enrollment) for ny tilgang - ingen restore_device"
    ),
    critical("enable_finance_kill_switch", "Stans ALLE spend-muliggjørende finans-/kort-handlinger for tenanten umiddelbart (gjennomslag til finance.enable_kill_switch)", { reason: z.string() }, "disable_finance_kill_switch"),
    critical("disable_finance_kill_switch", "Opphev finans-nødbryteren (gjennomslag til finance.disable_kill_switch)", {}, "enable_finance_kill_switch"),
    read("get_finance_kill_switch", "Les gjeldende finans-nødbryter-tilstand for tenanten (gjennomslag til finance.get_kill_switch)")
  ];
}
