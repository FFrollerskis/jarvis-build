import { z } from "zod";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import type { JsonValue } from "@jarvis/contracts";
import { financeWithheldMarker, withholdFinanceFromCurrentModel, type ToolDefinition, type ToolInvocationContext, type ToolTransport } from "@jarvis/tool-gateway";
import type { ExecutiveService } from "./service.ts";
import { summarizeCapabilityStatusNo, summarizeConnectorStatusNo, summarizeSelfDiagnosisNo } from "./status-summary.ts";
import { shapeCapabilityStatusForCloud, shapeConnectorsForCloud, shapeSloReportForCloud } from "./finance-withheld.ts";
import { CLOUD_WITHHELD_CENTERS, CONTROL_CENTER_IDS, CONTROL_CENTER_READ_TOOLS, CONTROL_CENTER_TITLES_NO, EXTENSION_CONTROL_CENTER_IDS, GUARDED_CLOUD_WITHHELD_CENTERS, controlCenterForReadAction, isCloudWithheldCenter, isGuardedCloudWithheldCenter, withheldCenterData, type ControlCenterId } from "./control-center/index.ts";
import { EVOLUTION_DECISIONS, isEvolutionDecision, summarizeEvolutionDecisionNo } from "./evolution/index.ts";

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

  /** WP-H0: eier-kun-porten for `get_control_center` (kobles på verktøydefinisjonen som `parameterAuthorizer`). */
  authorizeControlCenter(identity: Parameters<ExecutiveService["authorizeControlCenter"]>[0]): { allowed: boolean; reason: string } {
    return this.service.authorizeControlCenter(identity);
  }

  /** WP-H1/H2: eier + signert økt-porten for de per-senter verktøyene (`get_<senter>_center`) - fail-closed også uten register. */
  authorizeControlCenterRead(identity: Parameters<ExecutiveService["authorizeControlCenterRead"]>[0]): { allowed: boolean; reason: string } {
    return this.service.authorizeControlCenterRead(identity);
  }

  /**
   * WP-H0/H1: ÉN rapport-respons for `get_control_center` (med `center`) og de per-senter verktøyene. Et ikke-koblet senter (registeret har det ikke, f.eks. avhengighetene mangler) er et ærlig, strukturert svar
   * (`found: false`) - IKKE et kastet unntak, som ToolGateway ellers ville tolket som at hele executive-verktøyet er utilgjengelig (helse).
   * Gjennomgang M2: ber en SKYmodell om et senter som ikke skal til sky (`CLOUD_WITHHELD_CENTERS`, finans: D-378), bygges det ikke engang - svaret er en kort «holdt tilbake»-merknad. Lokale modeller og siden (ingen modell
   * i løkka) får hele rapporten. Håndhevingen skjer HER, ved utførelse, uavhengig av hvilke verktøy utvalget valgte for turen.
   */
  private async centerResponse(identity: Parameters<ExecutiveService["getControlCenterReport"]>[0], center: string, servingModel: ToolInvocationContext["servingModel"]): Promise<{ data: JsonValue }> {
    // WP-N1b (K2): med begrenset-vakten på (sentral lesning) holdes i tillegg Autoritet, Integrasjoner og AI tilbake HELT fra sky/ukjent (`GUARDED_CLOUD_WITHHELD_CENTERS`); den sentrale avgjørelsen kan bare STRAMME inn (`cloud` er sky om en av dem sier det).
    const guarded = withholdFinanceFromCurrentModel();
    const cloud = this.service.isCloudServed(servingModel) || guarded;
    if ((isCloudWithheldCenter(center) || (guarded && isGuardedCloudWithheldCenter(center))) && cloud && this.service.hasControlCenter(center)) {
      return { data: withheldCenterData(center as ControlCenterId, CONTROL_CENTER_TITLES_NO[center as ControlCenterId]) as unknown as JsonValue };
    }
    // M2 (H2): for en SKYmodell bygges de øvrige sentrene uten finansavledet tilstand (`restrictFinance`, f.eks. finans-nødbryteren i Sikkerhet og finansjobbene i Drift); lokal modell og siden får alt.
    const result = await this.service.getControlCenterReport(identity, center, cloud ? { restrictFinance: true } : {});
    if (result === null) {
      return { data: { found: false, center, summary_no: "Dette kontrollsenteret er ikke koblet inn ennå, så ingenting kan vurderes." } as unknown as JsonValue };
    }
    // `summary_no` og `explanation_no` først: chat-executoren kutter lange svar bakfra, og det er disse modellen skal relayere.
    // WP-N1b (FIX-1): med vakten PÅ og en sky-/ukjent modell bærer et senter bygget uten finansavledet tilstand (`restrictFinance`) alltid det nøytrale merket (også når ingenting ble fjernet) - skyen kan ikke utlede om noe fantes.
    return { data: { found: true, summary_no: result.report.summary_no, explanation_no: result.explanation_no, report: result.report, ...(cloud && guarded ? financeWithheldMarker() : {}) } as unknown as JsonValue };
  }

  /** Gjennomgang av PR #324 (M3/L4): eier + signert økt-porten for `get_infra_status` - fail-closed også uten register. */
  authorizeInfraStatus(identity: Parameters<ExecutiveService["authorizeInfraStatus"]>[0]): { allowed: boolean; reason: string } {
    return this.service.authorizeInfraStatus(identity);
  }

  /** WP-H0 (JARVIS-087): eier-kun-porten for kontrollsenterets mutasjoner (`cancel_task`) - fail-closed også uten register. */
  authorizeOwnerControl(identity: Parameters<ExecutiveService["authorizeOwnerControl"]>[0]): { allowed: boolean; reason: string } {
    return this.service.authorizeOwnerControl(identity);
  }

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
      // WP-N1b (JARVIS-116 a, K2): situasjoner i det finansavledede `spend`-domenet bærer løkkens begrunnelse (beløp, leverandør, AI-kost) og holdes tilbake fra en sky-/ukjent modell ved utførelse (sentral lesning;
      // lokal modell og eierens ruter får alt, flagg AV er uendret). Svaret til en slik modell har ALLTID det nøytrale merket, så en tom kø aldri leses som «ingen økonomivarsler».
      case "get_attention_queue": {
        const filter = parameters["domain"] !== undefined ? { domain: String(parameters["domain"]) } : {};
        if (withholdFinanceFromCurrentModel()) {
          const items = await this.service.getAttentionQueue(identity, filter, { withholdFinance: true });
          return { data: { items, ...financeWithheldMarker() } as unknown as JsonValue };
        }
        const items = await this.service.getAttentionQueue(identity, filter);
        return { data: items as unknown as JsonValue };
      }
      case "get_attention_item": {
        const situationId = requireString(parameters, "situation_id");
        const item = withholdFinanceFromCurrentModel() ? await this.service.getAttentionItem(identity, situationId, { withholdFinance: true }) : await this.service.getAttentionItem(identity, situationId);
        if (!item) throw new Error("attention_item_not_found");
        if ("finance_withheld" in item) return { data: item as unknown as JsonValue }; // KUN merket: ingen `external_id`, ingen felt
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
        // WP-N1 (review B, F-B1): det NØSTEDE `finance.get_kill_switch`-kallet har ingen `servingModel` (ToolGateway-låsen ser det ikke), så en skymodell får finans-nødbryteren her. Holdes tilbake for sky når begrenset-vakten er på;
        // ellers (vakten AV, lokal modell, eier-rute uten modell) er kallet NØYAKTIG som før N1 (ingen ekstra argument).
        const status = this.service.withholdsFinanceFromCloud(context?.servingModel)
          ? await this.service.getControlSurfaceStatus(identity, { withholdFinance: true })
          : await this.service.getControlSurfaceStatus(identity);
        return { data: status as unknown as JsonValue };
      }
      case "get_delegation_board": {
        const board = this.service.withholdsFinanceFromCloud(context?.servingModel)
          ? await this.service.getDelegationBoard(identity, { withholdFinance: true })
          : await this.service.getDelegationBoard(identity);
        return { data: board as unknown as JsonValue };
      }
      case "get_capability_status": {
        const status = await this.service.getCapabilityStatus(context?.servingModel);
        // WP-N1b (K2): finansverktøy og finanstilkoblingenes helse (navn, tilstand, feildetaljer) er finansavledet metadata: ut for sky/ukjent, og oppsummeringen bygges på det som er igjen
        if (withholdFinanceFromCurrentModel()) {
          const shaped = shapeCapabilityStatusForCloud(status);
          return { data: { ...shaped, summary_no: summarizeCapabilityStatusNo(shaped) } as unknown as JsonValue };
        }
        return { data: { ...status, summary_no: summarizeCapabilityStatusNo(status) } as unknown as JsonValue };
      }
      case "get_self_diagnosis": {
        // WP-N1b (K2, strengeste regel): observasjonenes fritekst (tilkoblinger, daglige jobber, verktøyfeil, kostnadsdrift) kan navngi finansleverandører, -jobber og -verktøy og bære AI-kost i øre, og kan ikke renses
        // strukturelt (fritekst fra lesere i apps/api) - hele selvdiagnosen holdes derfor tilbake fra sky/ukjent. Eieren/lokal modell får den; hurtigbanen («hva er galt med deg») svarer uten modell og låser turen.
        if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } as unknown as JsonValue };
        const diagnosis = await this.service.getSelfDiagnosis();
        return { data: { ...diagnosis, summary_no: summarizeSelfDiagnosisNo(diagnosis) } as unknown as JsonValue };
      }
      case "get_slo_report": {
        const report = await this.service.getSloReport();
        // WP-N1b (K2): kostnadsdriften («Kostnad per kall økte fra 3 til 6.7 øre») er AI-kost i øre: ut for sky/ukjent, rapporten komponeres på nytt fra resten (tjenestemålene har ingen kostnad)
        return { data: (withholdFinanceFromCurrentModel() ? shapeSloReportForCloud(report) : report) as unknown as JsonValue };
      }
      case "get_evolution_report": {
        // WP-N1b (K2, strengeste regel): rapporten inneholder kostnadsporten (EV-16: månedsforbruk og grenser i øre) og Evolusjon-senteret holdes allerede tilbake HELT fra skyen - hele rapporten holdes tilbake her
        if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } as unknown as JsonValue };
        const report = await this.service.getEvolutionReport();
        return { data: report as unknown as JsonValue };
      }
      case "get_ai_mesh_status": {
        // WP-N1b (K2, strengeste regel): kostnad per leverandør siste 7 døgn (`usage_7d.cost_ore`) er AI-kost i øre (Q-64 pkt 1) - hele rapporten holdes tilbake fra sky/ukjent
        if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } as unknown as JsonValue };
        const report = await this.service.getAiMeshStatus();
        return { data: report as unknown as JsonValue };
      }
      case "get_control_center": {
        // WP-H0: uten `center` = oversikt over alle ti sentre (kompakt); med `center` = full rapport + forklaring. Et ikke-koblet senter er et ærlig, strukturert svar (`found: false`) -
        // IKKE et kastet unntak, som ToolGateway ellers ville tolket som at hele executive-verktøyet er utilgjengelig (helse).
        const center = parameters["center"];
        if (center === undefined) {
          // WP-N1b (K2): med vakten på og en sky-/ukjent modell holdes også de vakt-styrte sentrene tilbake (oversikten sier rett ut at de er holdt tilbake, uten tall)
          const guarded = withholdFinanceFromCurrentModel();
          const overview = await this.service.getControlCenterOverview(identity, this.service.isCloudServed(context?.servingModel) || guarded
            ? { withhold: guarded ? [...CLOUD_WITHHELD_CENTERS, ...GUARDED_CLOUD_WITHHELD_CENTERS] : CLOUD_WITHHELD_CENTERS, restrictFinance: true }
            : {});
          const { summary_no, ...rest } = overview;
          return { data: { summary_no, ...rest, ...(guarded ? financeWithheldMarker() : {}) } as unknown as JsonValue }; // `summary_no` først (se under)
        }
        return this.centerResponse(identity, String(center), context?.servingModel);
      }
      case "get_finance_center":
      case "get_memory_center":
      case "get_agent_center":
      case "get_operations_center":
      case "get_value_center":
      case "get_privacy_center":
      case "get_security_center":
      case "get_evolution_center": {
        // WP-H1/H2: samme respons og samme register som `get_control_center {center}` - kun et smalere verktøynavn for chatten (egen port: eier + signert økt, fail-closed).
        const center = controlCenterForReadAction(action) as ControlCenterId;
        return this.centerResponse(identity, center, context?.servingModel);
      }
      case "run_golden_suite": {
        // WP-H2: golden-suite-knappen. Lesende og deterministisk (ingen modell, ingen database, ingen skriving); eier + signert enhetsøkt håndheves FØR dette kalles (`parameterAuthorizer`).
        const result = await this.service.runGoldenSuite();
        return { data: { summary_no: `Golden-suite: ${result.passed} av ${result.ran} kjørte oppgaver bestått${result.failed.length > 0 ? `, ${result.failed.length} IKKE bestått` : ""}${result.skipped.length > 0 ? `, ${result.skipped.length} hoppet over (ikke målt)` : ""}. Ingen modellkall.`, result } as unknown as JsonValue };
      }
      case "revoke_autonomy_binding": {
        // WP-H2: tilbakekall av eierens autonomi-binding for ÉTT domene (gjennomslag til situations.clear_autonomy_policy i kallerens eget minnerom). Eier-kun FØR dette kalles (`parameterAuthorizer`).
        const domain = requireString(parameters, "domain");
        const result = await this.service.revokeAutonomyBinding(identity, domain);
        if (!result.ok) throw new Error(result.reason ?? "situations_call_denied");
        const removed = (result.data as { removed?: unknown } | undefined)?.removed === true;
        // WP-G4b fiks-runde 1 (FIX-2): domenebredt tilbakekall - motoren oppgir nøyaktig hvilke skopnøkler (`*`, `rule:…`, `category:…`) som ble fjernet; videreføres additivt (aldri innhold).
        const removedScopes = (result.data as { removed_scopes?: unknown } | undefined)?.removed_scopes;
        return {
          external_id: `${identity.tenant_id}:${identity.memory_space_id}:${domain}`,
          data: { removed, domain, memory_space: identity.memory_space_id, ...(Array.isArray(removedScopes) ? { removed_scopes: removedScopes.filter((x): x is string => typeof x === "string") } : {}) } as unknown as JsonValue
        };
      }
      case "record_evolution_decision": {
        // WP-B3 (D-475, EV-23): REGISTRER eierens avgjørelse om ett endringsforslag i revisjonssporet - uten virkning (selvendring er frosset, D-397). Eier + signert enhetsøkt + step-up håndheves FØR dette kalles
        // (`parameterAuthorizer` + `step_up_required`). Identiteten kommer UTELUKKENDE fra konteksten (D-68). Svarets `summary_no` er en fast norsk tekst som alltid sier at ingenting utføres.
        // GJENNOMGANG L2 (dybdeforsvar): INGEN modell kan registrere eierens avgjørelse. Verktøyet står på ingen modellflate (manifestet: effekt `control`), men er `servingModel` satt - en modellbetjent tur, SKY ELLER LOKAL -
        // avvises kallet her med en fast kode, FØR noe annet leses. Kun siden (ingen modell i løkka) og eierens egen knapp kommer gjennom.
        if (context?.servingModel !== undefined) throw new Error("evolution_decision_model_origin_denied");
        const decision = parameters["decision"];
        if (!isEvolutionDecision(decision)) throw new Error("invalid_evolution_decision_input");
        const result = await this.service.recordEvolutionDecision(identity, { change_id: requireString(parameters, "change_id"), proposal_digest: requireString(parameters, "proposal_digest"), decision });
        return { external_id: `${result.change_id}:${result.proposal_digest.slice(0, 12)}`, data: { summary_no: summarizeEvolutionDecisionNo(result), ...result } as unknown as JsonValue };
      }
      case "get_value_report": {
        // WP-N1b (K2, strengeste regel til Q-64 pkt 1 er besvart): verdimålingene inkluderer modellkost i øre (`tasks.cost_ore`, `cost.model_total_ore`), og Verdi-senteret holdes allerede tilbake HELT fra skyen (H2/M2) -
        // samme regel her: hele rapporten holdes tilbake fra sky/ukjent (lokal modell og eierens ruter får den). Tenanten kommer UTELUKKENDE fra den betrodde kontekst-identiteten (D-68), aldri fra parametre.
        if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } as unknown as JsonValue };
        const report = await this.service.getValueReport(identity.tenant_id);
        return { data: report as unknown as JsonValue };
      }
      case "get_infra_status": {
        // WP-N1b fiks-runde 1 (FIX-2, strengeste regel): hendelsestitlene (`providerProducer`: «Tilkobling svikter: <tilkobling>», `schedulerProducer`: «Bakgrunnsjobben <jobb> ga opp»), repo/gren og produsentenes feiltekster kan navngi
        // finanskoblinger og finansjobber og kan ikke renses strukturelt - hele driftsbildet holdes tilbake fra sky/ukjent VED UTFØRELSE, FØR kilden leses (lokal modell og eier får det; Drift-senteret viser kun tall).
        if (withholdFinanceFromCurrentModel()) return { data: { ...financeWithheldMarker() } as unknown as JsonValue };
        // WP-E1: tenanten kommer UTELUKKENDE fra den betrodde kontekst-identiteten (D-68), aldri fra parametre.
        const report = await this.service.getInfraStatus(identity.tenant_id);
        return { data: report as unknown as JsonValue };
      }
      case "get_connector_status": {
        const status = await this.service.getConnectorStatus();
        // WP-N1b (K2): finanskoblingene (navn, konfigurert, credential-refs, helse) er finansavledet metadata: ut for sky/ukjent, og oppsummeringen bygges på det som er igjen
        if (withholdFinanceFromCurrentModel()) {
          const connectors = shapeConnectorsForCloud(status.connectors);
          return { data: { ...status, connectors, summary_no: summarizeConnectorStatusNo(connectors), ...financeWithheldMarker() } as unknown as JsonValue };
        }
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
      case "cancel_task": {
        // WP-H0 (JARVIS-087): kontrollsenterets avbryt-handling - gjennomslag til den eksisterende kanselleringsveien (TaskService.cancel). Eier-kun håndheves FØR dette kalles (`parameterAuthorizer`).
        const taskId = requireString(parameters, "task_id");
        return { external_id: taskId, data: (await this.service.cancelTask(identity, taskId)) as unknown as JsonValue };
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

export interface ExecutiveToolOptions {
  /**
   * WP-H1/H2 (gjennomgang M1): sentrene hvis per-senter lese-verktøy (`get_<senter>_center`) registreres - KUN de hvis flagg er PÅ og som er registrert (`controlCentersWithTools(env, registry)` i apps/api). Utelatt/tom = ingen av dem finnes
   * (identisk med main): verktøyet kan da hverken velges av utvalget, kalles av en modell eller listes som tilgjengelig. Rate-grensen på `get_control_center` heves først når minst ett senter er på.
   */
  controlCenters?: ReadonlyArray<ControlCenterId>;
  /** WP-H2: registrer `run_golden_suite` (golden-suite-knappen). AV som standard - uten flagget finnes verktøyet ikke. */
  goldenSuite?: boolean;
  /** WP-H2: registrer `revoke_autonomy_binding` (tilbakekall av eierens autonomi-binding fra kontrollsenteret). AV som standard - uten flagget finnes verktøyet ikke. */
  autonomyRevoke?: boolean;
  /** WP-B3 (D-475, EV-23): registrer `record_evolution_decision` (eierens avgjørelse om et endringsforslag, KUN registrert i revisjonssporet - ingen virkning). AV som standard - uten flagget finnes verktøyet ikke. */
  evolutionApproval?: boolean;
}

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
export function executiveToolDefinitions(transport: ExecutiveTransport, options: ExecutiveToolOptions = {}): ToolDefinition[] {
  const enabledCenters = new Set<ControlCenterId>(options.controlCenters ?? []);
  // D-475: tilleggssentrene (Evolusjon) hvis lese-verktøy er registrert - de er da også gyldige `center`-verdier for `get_control_center`. Tom liste (flagget AV) = skjema og beskrivelse som på main.
  const enabledExtensions = EXTENSION_CONTROL_CENTER_IDS.filter((id) => enabledCenters.has(id));
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
    {
      ...read(
        "get_control_center",
        "Les eierens kontrollsentre (UA-11 Admin Control Center): uten `center` en oversikt over alle ti sentre med status per seksjon (integrasjoner, autoritet, AI, finans, minne, agenter, drift, verdi, personvern, sikkerhet); med `center` full rapport for ett senter med hvert tall kildeforankret (tabell/kilde og når det ble målt), en norsk forklaring av hvorfor noe er advarsel/feil, og hvilke eksisterende kontrollhandlinger eieren kan ta (pause/tilbakekall). KUN lesing - jeg utfører ingenting herfra. Ukjent vises som ukjent, aldri som i orden. Kun eieren får svar, og kun fra en signert enhetsøkt (nettleser/app) - aldri over tale eller Telegram."
        // D-475: tilleggssentre (Evolusjon) nevnes og er gyldige `center`-verdier KUN når senterets flagg er på - med flagget AV er beskrivelsen og skjemaet uendret fra main.
        + (enabledExtensions.length > 0 ? ` Tilleggssenter (kun når slått på): ${enabledExtensions.map((id) => CONTROL_CENTER_TITLES_NO[id].toLowerCase()).join(", ")}.` : ""),
        { center: z.enum([...CONTROL_CENTER_IDS, ...enabledExtensions] as [string, ...string[]]).optional() }
      ),
      // WP-H1: siden gjør 1 + (antall sentre) kall per oppdatering (oversikt + ett per senter); med flere sentre på er 30/min for lavt (to oppdateringer på rad ga 429). 120/min er fortsatt lavt: kun eieren
      // fra en signert enhetsøkt når verktøyet, og bygginger av samme senter for samme identitet deles (single-flight i registeret). Gjennomgang M1: heves KUN når minst ett senter er slått på - ellers er grensen som på main (30).
      ...(enabledCenters.size > 0 ? { rate_limit_per_minute: 120 } : {}),
      // WP-H0: eier-kun FØR noe bygges (avslaget er en vanlig `tool.denied`-revisjonsrad). Rapportene er konfigurasjonsmetadata og handlingene peker på eier-ruter.
      parameterAuthorizer: (_parameters, identity) => transport.authorizeControlCenter(identity)
    },
    // WP-H1/H2: per-senter lese-verktøy (`get_finance_center` m.fl.) - ingen parametre, samme register, EGEN fail-closed port (eier + signert enhetsøkt). Tabellen er `CONTROL_CENTER_READ_TOOLS`.
    // Gjennomgang M1: registreres KUN for sentre med flagget på - ellers finnes verktøyet ikke (flagg AV er identisk med main).
    ...CONTROL_CENTER_READ_TOOLS.filter((tool) => enabledCenters.has(tool.center)).map((tool): ToolDefinition => ({
      ...read(tool.action, tool.description),
      parameterAuthorizer: (_parameters, identity) => transport.authorizeControlCenterRead(identity)
    })),
    read(
      "get_ai_mesh_status",
      "Svar på «hvilke modeller har du?»/«fungerer Kimi/Hermes/Gemma?»/«hva koster modellene?»/«er fallback i orden?»: AI Mesh slik det står NÅ - per leverandør konfigurert (kun presence), frisk, siste feil, kostnad og p50-latens siste 7 døgn, parallell-delegerings-overhead - og om akseptansen «≥3 live providers med fallback» er oppfylt. KUN lesing: jeg gjør ikke et testkall (eierens røyktest er mesh-live-smoke.ts). Ukjent vises som ukjent, konfigurert er aldri det samme som bevist."
    ),
    read(
      "get_value_report",
      "Svar på «hva har du hjulpet meg med?»/«hvor mye bruker jeg deg?»/«hva er verdien?» fra EKTE tall (kun antall og tidspunkt - aldri innhold): bruk per verdiløkke (Daily Brief, oppfølging, jobber, samtaler, bekreftelser, kost) siste 7 og 30 døgn, pluss status for de sovende løkkene (Builder Loop-beredskap og driftsforslag). Det som ikke kan måles står som «ikke målbart», aldri som 0. Gjengi summary_no."
    ),
    {
      ...read(
        "get_infra_status",
        "Svar på «hva er status på driften?»/«er noe nede?»/«har vi åpne hendelser?»/«hvordan går det med skyen?» fra EKTE data: åpne hendelser (fase åpen/anerkjent/avbøtende, alvorlighet, hvor mye som er bekreftet vs. observert vs. påstått, siste endring), de tilkoblede skymålene (Cloudflare, Vercel, Google Cloud, Docker, Langfuse, Infisical, Postgres) med helse og siste journalførte endring, og om hendelsesprodusentene selv kjører. Ingen hemmeligheter eller hendelsestekst. Sier ifra når automatisk oppdagelse er AV (da betyr «ingen hendelser» kun «ingen registrert manuelt»). Ukjent vises som ukjent. Gjengi summary_no. Kun eieren får svar, og kun fra en signert enhetsøkt (nettleser/app) - aldri over tale eller Telegram."
      ),
      // Gjennomgang av PR #324 (M3/L4): eier OG signert økt FØR noe leses (samme port som kontrollsentrene) - avslaget er en vanlig `tool.denied`-revisjonsrad. Gjelder alle veier (`/infra/overview`, chat).
      parameterAuthorizer: (_parameters, identity) => transport.authorizeInfraStatus(identity)
    },
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
    {
      // WP-H0 (JARVIS-087): avbryt ÉN bakgrunnsjobb/agent fra kontrollsenteret. Klasse B (samme som `tasks.cancel_task` selv). Stopp-handling: krever ikke step-up (se STEP_UP_EXEMPT_ACTIONS), men er EIER-KUN
      // (samme port som kontrollsentrene) og står aldri på en modellflate. Det er ingen angrefunksjon: en avbrutt jobb kan ikke gjenopptas.
      tool_id: "executive", action: "cancel_task",
      description: "Avbryt ÉN bakgrunnsjobb/agent (gjennomslag til den eksisterende kanselleringsveien tasks.cancel): en jobb som ikke er startet avbrytes umiddelbart, en kjørende stopper ved neste trygge punkt. Sideeffekter som allerede er utført rulles ikke tilbake.",
      input_schema: record({ task_id: z.string().min(1).max(100) }),
      capability_class: "B", scopes: ["executive.write"], reversible: false,
      rollback_procedure: "en avbrutt jobb kan ikke gjenopptas - send den inn på nytt", idempotent_external: true, ...common,
      parameterAuthorizer: (_parameters, identity) => transport.authorizeOwnerControl(identity)
    },
    // WP-H2: golden-suite-knappen. Klasse A / lesing (deterministisk selvtest: ingen modell, ingen database, ingen skriving) - men BARE for eieren fra en signert enhetsøkt (samme port som kontrollsentrene), og
    // aldri på en modellflate. Registreres kun med JARVIS_CONTROL_GOLDEN_SUITE=on. Maks 6 kjøringer i minuttet (én kjøring om gangen i kjøreren).
    ...(options.goldenSuite === true
      ? [{
        ...read("run_golden_suite", "Kjør den deterministiske golden-suiten (regresjonsvern for Jarvis' egne regler) og returner antall bestått, ikke-bestått og digester. Ingen modell kalles, ingenting skrives. Kun eieren fra en signert enhetsøkt - kun fra kontrollsenteret."),
        rate_limit_per_minute: 6,
        parameterAuthorizer: (_parameters: Record<string, JsonValue>, identity: Parameters<ExecutiveTransport["authorizeControlCenterRead"]>[0]) => transport.authorizeControlCenterRead(identity)
      } satisfies ToolDefinition]
      : []),
    // WP-H2: tilbakekall av eierens autonomi-binding (`situation_autonomy_policies`, D-160) for ÉTT domene i kallerens eget minnerom: gjennomslag til `situations.clear_autonomy_policy` (samme verktøy, samme sovereign-eier-port,
    // samme revisjon). Fravær av binding = ingen auto-ACT (fail-closed), så domenet går tilbake til det strengeste nivået. Klasse C; eier-kun FØR noe kalles; ruten krever step-up (signert enhet). Kan ikke angres automatisk:
    // parametrene til den slettede bindingen lagres i revisjonsraden `autonomy_binding.revoke_requested` (før-bildet, skrevet og committet FØR slettingen; se `ExecutiveService.revokeAutonomyBinding`). Registreres kun med JARVIS_CONTROL_AUTONOMY_REVOKE=on.
    ...(options.autonomyRevoke === true
      ? [{
        ...control("revoke_autonomy_binding", "Tilbakekall eierens autonomi-binding(er) (auto-ACT) for ÉTT situasjonsdomene i kallerens eget minnerom (gjennomslag til situations.clear_autonomy_policy): fjerner ALLE bindinger i domenet (den domenebrede og alle regel-/kategoribindinger); domenet går tilbake til ingen auto-ACT", { domain: z.string().min(1).max(100) }, "set_autonomy_policy med verdiene i før-bildet i revisjonsraden `autonomy_binding.revoke_requested` (`before` = den domenebrede; `before_scoped` = regel-/kategoribindingene med `scope_key`; domene, tool_id, action, enabled, parameters)"),
        reversible: false,
        // Gjennomgang L1: uopprettelig sletting = step-up på GATEWAY-nivå (signert enhetsøkt fra en eier-kanal, WP-F1-mekanismen), ikke bare i ruten - hver vei til verktøyet krever den (avslag: `step_up_required:<årsak>`).
        step_up_required: true,
        parameterAuthorizer: (_parameters: Record<string, JsonValue>, identity: Parameters<ExecutiveTransport["authorizeOwnerControl"]>[0]) => transport.authorizeOwnerControl(identity)
      } satisfies ToolDefinition]
      : []),
    // WP-B3 (D-475, EV-23): eierens AVGJØRELSE om ett endringsforslag (godkjenn/avvis/utsett), registrert i revisjonssporet - og KUN det: ingenting utføres, godkjennes i endringsregisteret eller aktiveres (selvendring er
    // frosset, D-397; `activation_decision` er alltid false). Klasse C; eier OG signert enhetsøkt FØR noe kalles (`authorizeControlCenterRead`), og step-up (signert enhet fra en eier-kanal) også på GATEWAY-nivå, så hver
    // vei til verktøyet krever den. Bundet til forslagets versjon (`proposal_digest` = entry_hash til forslagets siste rad i endringsregisteret) og idempotent (samme avgjørelse for samme versjon skrives ikke på nytt).
    // «Angre» = registrer en ny avgjørelse (den nyeste gjelder; alle står i revisjonssporet). Står på INGEN modellflate (effekt «control»: manifestet forbyr det) - kun kontrollsenterets knapp via /executive/mutate.
    // Registreres kun med JARVIS_CONTROL_EVOLUTION_APPROVAL=on (og Evolusjon-senteret koblet inn).
    ...(options.evolutionApproval === true
      ? [{
        ...control(
          "record_evolution_decision",
          "Registrer EIERENS avgjørelse (godkjenn, avvis eller utsett) om ÉTT endringsforslag fra Evolusjon-senteret, bundet til forslagets versjon (proposal_digest). KUN en registrering i revisjonssporet: ingenting utføres, godkjennes i endringsregisteret eller aktiveres (selvendring er frosset, D-397). Kun eieren fra en signert enhetsøkt - kun kontrollsenterets knapp.",
          { change_id: z.string().min(1).max(60), proposal_digest: z.string().regex(/^[0-9a-f]{64}$/), decision: z.enum(EVOLUTION_DECISIONS) },
          "registrer en ny avgjørelse for samme forslag (den nyeste gjelder); alle avgjørelser står i revisjonssporet `evolution.owner_decision` - registreringen har ingen virkning å angre"
        ),
        rate_limit_per_minute: 10,
        step_up_required: true,
        parameterAuthorizer: (_parameters: Record<string, JsonValue>, identity: Parameters<ExecutiveTransport["authorizeControlCenterRead"]>[0]) => transport.authorizeControlCenterRead(identity)
      } satisfies ToolDefinition]
      : []),
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
