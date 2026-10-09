import type { SloReport } from "./slo/index.ts";
import { composeSloReport, SLO_CATALOG } from "./slo/index.ts";
import { composeEvolutionReport, type EvolutionReport } from "./evolution/index.ts";
import { composeControlCenterOverview, explainControlCenterNo, type ControlCenterOverview, type ControlCenterRegistry, type ControlCenterReport } from "./control-center/index.ts";
import { buildLimitationRegistry, composeSelfDiagnosis, type LimitationInput, type ObservationReader, type SelfDiagnosis } from "./self-model/index.ts";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { FinanceKillSwitch } from "@jarvis/finance";
import type { OwnerControlState } from "@jarvis/owner-controls";
import type {
  Situation,
  SituationAutonomyPolicy,
  SituationNotificationPolicy
} from "@jarvis/situations";
import { listConnectorStatus, type ToolGateway, type ToolResult } from "@jarvis/tool-gateway";
import { rankAttentionQueue } from "./ranking.ts";
import type {
  AttentionItem, AttentionItemDetail, CapabilityStatus, ConnectorStatusReport, ControlSurfaceStatus, DelegationBoard
} from "./types.ts";

/**
 * UA-11 Executive Mode (P0, D-162): motoren bak den samlede kontrollflaten.
 *
 * BEVISST arkitekturvalg: konstruktøren tar KUN `ToolGateway` - ALDRI
 * `SituationEngine`/`DomainPauseRegistry` direkte. Enhver lesing/mutasjon
 * går derfor gjennom `gateway.execute({ tool_id: "situations", ... })`
 * (SAMME nøstede kall-mønster som `MeshToolExecutor`/`docker`-recovery sine
 * eksisterende `situations.*`/`github.*`-kall via toolGateway) - dette gjør
 * det STRUKTURELT umulig for denne pakken å omgå `PolicyGateway.authorize()`
 * eller å duplisere `DomainPauseRegistry`/autonomi-policy-logikken. Se
 * `docs/UA11_EXECUTIVE_MODE_DESIGN.md` §2 for hele resonnementet.
 *
 * `identity` sendes ALLTID videre UENDRET fra kalleren (D-68-disiplinen -
 * "SECURITY FIX #2" i `@jarvis/tool-gateway`) - denne tjenesten fabrikkerer
 * eller eskalerer ALDRI en identitet selv.
 */
export class ExecutiveAccessDeniedError extends Error {
  constructor(
    public readonly action: string,
    public readonly reason: string
  ) {
    super(`executive_denied:${action}:${reason}`);
    this.name = "ExecutiveAccessDeniedError";
  }
}

/** SAMME default som `@jarvis/situations` sin egen `DEFAULT_RESUPPRESS_HOURS` (brukt når eieren ikke har satt en egen varslingspolicy) - IKKE en ny, oppfunnet konstant. */
const FALLBACK_COOLDOWN_HOURS = 24;

/**
 * `ToolResult.data` er typet `JsonValue | undefined` på gateway-grensen -
 * `situations`-transporten selv caster den RIKERE `Situation[]`/policy-
 * formen til `JsonValue` idet den svarer (samme grensekryssing som ENHVER
 * annen ToolTransport). Denne hjelperen gjør den SYMMETRISKE, motsatte
 * castingen tilbake til den kjente formen på VÅR side av grensen - `data`
 * er allerede en verdi produsert av `@jarvis/situations` sin egen
 * `situationsToolDefinitions()`-kontrakt, ALDRI brukerinput.
 */
async function requireData<T>(
  gateway: ToolGateway,
  identity: IdentityContext,
  toolId: string,
  action: string,
  parameters: Record<string, JsonValue> = {}
): Promise<T> {
  const result = await gateway.execute({ identity, tool_id: toolId, action, parameters });
  if (!result.ok) throw new ExecutiveAccessDeniedError(action, result.reason);
  return result.data as unknown as T;
}

export interface AttentionQueueFilter {
  domain?: string;
}

export interface ExecutiveServiceOptions {
  /**
   * Remediering del 1: når satt, er DETTE (og ingenting annet) det modellen
   * faktisk kan kalle. `getCapabilityStatus()` rapporterer da kun disse parene
   * som `chat_accessible_tools` - aldri hele registeret (en falsk påstand om
   * tilgjengelighet er selv en konfabulasjonskilde, jf. D-209).
   */
  modelSurface?: ReadonlyArray<{ readonly tool_id: string; readonly action: string }>;
  /** D-437: forbehold som skal følge `getCapabilityStatus()` når prosessen har snevret miljø (se `CapabilityStatus.evaluation_caveat`). */
  evaluationCaveat?: string;
  /**
   * EV-1 (D-412): selvmodell. Smale, injiserte lesere (komponert i `apps/api`) + registerkildene begrensningene avledes fra. Uten dette gir
   * `getSelfDiagnosis()` kun UNKNOWN for alle områder (aldri en gjetning om «frisk»).
   */
  selfModel?: {
    readers: Readonly<Record<string, ObservationReader | undefined>>;
    limitations: LimitationInput;
  };
  /** EV-2 (D-417): SLO-/drift-/dataskvalitetsrapport (injisert fra `apps/api`; kun lesing av eksisterende observerbarhet). */
  slo?: { report(): Promise<SloReport> };
  /** WP-B (D-452): evolusjonsporter i observasjonsmodus (injisert fra `apps/api`; kun lesing - utfører aldri en endring). */
  evolution?: { report(): Promise<EvolutionReport> };
  /**
   * WP-H0 (UA-11 Admin Control Center): registeret over de ti kontrollsentrene (injisert fra `apps/api`; kun lesing - sentrene skriver ingenting, handlingene deres peker på eksisterende ruter).
   * Uten registeret: oversikten sier ærlig at ingen sentre er koblet inn (aldri en gjetning om at alt er i orden).
   */
  controlCenters?: ControlCenterRegistry;
  /**
   * WP-H0 (JARVIS-087): avbryt en bakgrunnsjobb/agent fra kontrollsenteret. Den EKSISTERENDE kanselleringsveien (`TaskService.cancel`: klasse B-policy, `requestCancel`, revisjon `task.cancelled`) injiseres fra
   * `apps/api`; executive-laget har ingen egen kanselleringslogikk. Uten denne avvises handlingen (`executive_tasks_not_configured`).
   */
  tasks?: {
    cancel(identity: IdentityContext, taskId: string): Promise<{ ok: true; value: { cancelled: boolean; outcome: "cancelled" | "requested" | "not_cancellable" } } | { ok: false; reason: string }>;
  };
}

export class ExecutiveService {
  constructor(
    private readonly gateway: ToolGateway,
    private readonly options: ExecutiveServiceOptions = {}
  ) {}

  /**
   * Henter (via `situations.get_queue`, ALDRI en egen spørring) + pause-/
   * autonomi-/varslingspolicy (samme veier), rangerer (ren
   * `rankAttentionQueue()`) og returnerer BÅDE de rangerte postene og
   * kilde-`Situation`-radene DE ble avledet av - ÉN nøstet gateway-runde,
   * gjenbrukt av både `getAttentionQueue()` og `getAttentionItem()` under.
   * `include_resolved` er ALLTID false - løste situasjoner skal forsvinne
   * fra attention-køen (se `situations.get_queue` sin egen
   * `statusOpenOnly`-default), aldri degraderes med en misvisende rangering.
   */
  private async rankedQueueWithSource(
    identity: IdentityContext,
    filter: AttentionQueueFilter = {}
  ): Promise<{ items: AttentionItem[]; situationsById: Map<string, Situation> }> {
    const [situations, pauseState, autonomyPolicies, notificationPolicy] = await Promise.all([
      requireData<Situation[]>(this.gateway, identity, "situations", "get_queue", filter.domain ? { domain: filter.domain } : {}),
      requireData<{ paused: string[] }>(this.gateway, identity, "situations", "get_pause_state"),
      requireData<SituationAutonomyPolicy[]>(this.gateway, identity, "situations", "list_autonomy_policies"),
      requireData<SituationNotificationPolicy | null>(this.gateway, identity, "situations", "get_notification_policy")
    ]);
    const pausedDomains = new Set(pauseState.paused);
    const autonomyBoundDomains = new Set(autonomyPolicies.map((p) => p.domain));
    const autonomyEnabledDomains = new Set(autonomyPolicies.filter((p) => p.enabled).map((p) => p.domain));
    const items = rankAttentionQueue(situations, {
      now: new Date(),
      cooldownHours: notificationPolicy?.resuppress_hours ?? FALLBACK_COOLDOWN_HOURS,
      pausedDomains,
      autonomyBoundDomains,
      autonomyEnabledDomains
    });
    return { items, situationsById: new Map(situations.map((s) => [s.situation_id, s])) };
  }

  async getAttentionQueue(identity: IdentityContext, filter: AttentionQueueFilter = {}): Promise<AttentionItem[]> {
    return (await this.rankedQueueWithSource(identity, filter)).items;
  }

  /**
   * "Se detalj/begrunnelse" + "se underliggende situation" i ETT kall - den
   * rangerte posten er allerede fullt forklart (`explanation`/
   * `recommended_next_action`), pluss selve kilde-`Situation`-raden.
   */
  async getAttentionItem(identity: IdentityContext, situationId: string): Promise<AttentionItemDetail | null> {
    const { items, situationsById } = await this.rankedQueueWithSource(identity);
    const item = items.find((i) => i.situation_id === situationId);
    const situation = situationsById.get(situationId);
    if (!item || !situation) return null;
    return { ...item, situation };
  }

  /** Rent gjennomslag til `situations.pause_domain` - INGEN egen pauselogikk (se filhode). */
  async pauseDomain(identity: IdentityContext, domain: string, reason: string): Promise<ToolResult> {
    return this.gateway.execute({ identity, tool_id: "situations", action: "pause_domain", parameters: { domain, reason } });
  }

  /** Rent gjennomslag til `situations.unpause_domain`. */
  async resumeDomain(identity: IdentityContext, domain: string): Promise<ToolResult> {
    return this.gateway.execute({ identity, tool_id: "situations", action: "unpause_domain", parameters: { domain } });
  }

  /** Rent gjennomslag til `situations.get_pause_state`. */
  async getPauseState(identity: IdentityContext): Promise<ToolResult> {
    return this.gateway.execute({ identity, tool_id: "situations", action: "get_pause_state", parameters: {} });
  }

  /** Rent gjennomslag til `situations.resolve` - lar eieren dismisse et attention-item direkte fra DENNE overflaten uten å bytte verktøy-namespace. */
  async resolveSituation(identity: IdentityContext, situationId: string): Promise<ToolResult> {
    return this.gateway.execute({ identity, tool_id: "situations", action: "resolve", parameters: { situation_id: situationId } });
  }

  // === D-174 (B2): eierens SAMLEDE mutasjonsflate for owner_controls.* ====
  // SAMME komposisjons-disiplin som pause/resume/resolve over - INGEN egen
  // kill-switch-/frys-/tilbakekalls-logikk her, KUN videresending til den
  // kanoniske `owner_controls.*`-flaten (K1, D-164) via ETT nøstet
  // `ToolGateway.execute()`-kall. `deactivate_kill_switch`/`restore_credential`
  // sin B1-selvgjenopprettingsevne under en samtidig aktiv kill switch/
  // tilbakekalt delt credential bevares av `gateway.ts`/`policy-gateway.ts`
  // sitt eksplisitte "executive"-unntak (D-174, se der) - IKKE av noe her.

  /** Rent gjennomslag til `owner_controls.activate_kill_switch`. */
  async activateKillSwitch(identity: IdentityContext, reason: string): Promise<ToolResult> {
    return this.gateway.execute({ identity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason } });
  }

  /** Rent gjennomslag til `owner_controls.deactivate_kill_switch`. */
  async deactivateKillSwitch(identity: IdentityContext): Promise<ToolResult> {
    return this.gateway.execute({ identity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
  }

  /** Rent gjennomslag til `owner_controls.freeze_connector`. */
  async freezeConnector(identity: IdentityContext, connectorId: string, reason: string): Promise<ToolResult> {
    return this.gateway.execute({ identity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: connectorId, reason } });
  }

  /** Rent gjennomslag til `owner_controls.unfreeze_connector`. */
  async unfreezeConnector(identity: IdentityContext, connectorId: string): Promise<ToolResult> {
    return this.gateway.execute({ identity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: connectorId } });
  }

  /** Rent gjennomslag til `owner_controls.revoke_credential`. */
  async revokeCredential(identity: IdentityContext, credentialRef: string, reason: string): Promise<ToolResult> {
    return this.gateway.execute({ identity, tool_id: "owner_controls", action: "revoke_credential", parameters: { credential_ref: credentialRef, reason } });
  }

  /** Rent gjennomslag til `owner_controls.restore_credential`. */
  async restoreCredential(identity: IdentityContext, credentialRef: string): Promise<ToolResult> {
    return this.gateway.execute({ identity, tool_id: "owner_controls", action: "restore_credential", parameters: { credential_ref: credentialRef } });
  }

  /**
   * Rent gjennomslag til `owner_controls.revoke_device`. `deviceId` er ET
   * EKSPLISITT, navngitt MÅL-parameter (SAMME mønster som `connectorId`/
   * `credentialRef` over) - MÅL-TENANTEN er derimot ALDRI et parameter
   * (D-175, arkitekt-review 5250409538, BLOKKER B4 - RETTER D-174): den
   * nøstede `gateway.execute()`-kallet videresender `identity` UENDRET, og
   * `owner_controls.revoke_device` sin transport binder tenanten til DEN
   * SAMME `identity.tenant_id` - eieren kan tilbakekalle EN ANNEN persons
   * enhet (en delegat sin telefon) i SIN EGEN tenant, men kan IKKE velge en
   * annen tenant enn den han/hun faktisk er autentisert i. Se
   * `OwnerControlsService.revokeDevice()` for full begrunnelse.
   */
  async revokeDevice(identity: IdentityContext, deviceId: string, reason: string): Promise<ToolResult> {
    return this.gateway.execute({
      identity, tool_id: "owner_controls", action: "revoke_device",
      parameters: { device_id: deviceId, reason }
    });
  }

  // === D-174 (B2): finans-nødbryteren via executive ========================
  // `finance.*` sin EKSISTERENDE transport-konvensjon (UA-6) krever
  // `tenant_id`/`actor_person_id` som EKSPLISITTE parametre (ikke fra
  // `ToolInvocationContext` som resten av denne pakken) - se
  // `modules/finance/src/transport.ts`. Denne tjenesten videresender ALLTID
  // `identity.tenant_id`/`identity.person_id` (D-68: identitet kommer
  // UTELUKKENDE fra den betrodde konteksten), ALDRI en verdi kalleren selv
  // oppga - trygt FORDI kalleren av DENNE metoden allerede er identitets-
  // kontekst-bundet (executive selv), ikke et rått, ubetrodd parameter.

  /** Rent gjennomslag til `finance.enable_kill_switch`. */
  async enableFinanceKillSwitch(identity: IdentityContext, reason: string): Promise<ToolResult> {
    return this.gateway.execute({
      identity, tool_id: "finance", action: "enable_kill_switch",
      parameters: { tenant_id: identity.tenant_id, actor_person_id: identity.person_id, reason }
    });
  }

  /** Rent gjennomslag til `finance.disable_kill_switch`. */
  async disableFinanceKillSwitch(identity: IdentityContext): Promise<ToolResult> {
    return this.gateway.execute({
      identity, tool_id: "finance", action: "disable_kill_switch",
      parameters: { tenant_id: identity.tenant_id, actor_person_id: identity.person_id }
    });
  }

  /** Rent gjennomslag til `finance.get_kill_switch`. */
  async getFinanceKillSwitch(identity: IdentityContext): Promise<ToolResult> {
    return this.gateway.execute({ identity, tool_id: "finance", action: "get_kill_switch", parameters: { tenant_id: identity.tenant_id } });
  }

  /**
   * WP-H0 (JARVIS-087): gjennomslag til den EKSISTERENDE kanselleringsveien for en bakgrunnsjobb/agent. Eier-kun håndheves av verktøydefinisjonen (`parameterAuthorizer`) FØR dette kalles; policy (klasse B),
   * tenant-RLS og revisjon (`task.cancelled`) skjer i `TaskService.cancel`. Et avslag fra policy kastes (blir et `ok:false` på det ytre kallet), aldri en stille «ok».
   */
  async cancelTask(identity: IdentityContext, taskId: string): Promise<{ task_id: string; cancelled: boolean; outcome: "cancelled" | "requested" | "not_cancellable" }> {
    const tasks = this.options.tasks;
    if (!tasks) throw new Error("executive_tasks_not_configured");
    const result = await tasks.cancel(identity, taskId);
    if (!result.ok) throw new ExecutiveAccessDeniedError("cancel_task", result.reason);
    return { task_id: taskId, cancelled: result.value.cancelled, outcome: result.value.outcome };
  }

  /**
   * K1 (Sovereign graduation, D-164): ÉN samlet lesing av HELE eier-
   * kontrolloverflaten - komponerer `owner_controls.get_control_state`
   * (global kill switch + navngitte frosne connectorer/tilbakekalte
   * credentials, D-164) OG `situations.get_pause_state` (domene-avgrenset
   * pausetilstand, UA-10) via TO nøstede `ToolGateway.execute()`-kall - SAMME
   * disiplin som `rankedQueueWithSource()` over: denne tjenesten rører
   * ALDRI `KillSwitch`/`OwnerControls`/`DomainPauseRegistry` direkte, og
   * fabrikkerer/eskalerer ALDRI identiteten den fikk fra kalleren.
   */
  async getControlSurfaceStatus(identity: IdentityContext): Promise<ControlSurfaceStatus> {
    const [ownerControl, pauseState, financeKillSwitch] = await Promise.all([
      requireData<OwnerControlState>(this.gateway, identity, "owner_controls", "get_control_state"),
      requireData<{ paused: string[] }>(this.gateway, identity, "situations", "get_pause_state"),
      requireData<FinanceKillSwitch | null>(this.gateway, identity, "finance", "get_kill_switch", { tenant_id: identity.tenant_id })
    ]);
    return { owner_control: ownerControl, situation_domain_pauses: pauseState, finance_kill_switch: financeKillSwitch };
  }

  /**
   * UA-11 "K2" (D-64): "delegation board" - se `types.ts` sitt `DelegationBoard`-
   * dokumentasjonskommentar for hele begrunnelsen. TRE nøstede
   * `gateway.execute()`-kall, SAMME disiplin som `getControlSurfaceStatus()`
   * over - INGEN egen tilstand, INGEN direkte `SituationEngine`/
   * `OwnerControls`-tilgang fra denne pakken.
   */
  async getDelegationBoard(identity: IdentityContext): Promise<DelegationBoard> {
    const [autonomyDomains, ownerControl, financeKillSwitch] = await Promise.all([
      requireData<SituationAutonomyPolicy[]>(this.gateway, identity, "situations", "list_autonomy_policies"),
      requireData<OwnerControlState>(this.gateway, identity, "owner_controls", "get_control_state"),
      requireData<FinanceKillSwitch | null>(this.gateway, identity, "finance", "get_kill_switch", { tenant_id: identity.tenant_id })
    ]);
    return {
      autonomy_domains: autonomyDomains,
      frozen_connectors: ownerControl.frozen_connectors,
      revoked_credentials: ownerControl.revoked_credentials,
      finance_kill_switch: financeKillSwitch
    };
  }

  /**
   * "Charlie"-selv-bevissthet (D-209): se `types.ts` sitt `CapabilityStatus`-
   * dokumentasjonskommentar for hele begrunnelsen. BEVISST INGEN nøstet
   * `gateway.execute()`-kall her (i motsetning til metodene over) - dette
   * leser KUN `ToolGateway` sin EGEN bokføring (`meshToolBindings()`/
   * `gateway.health`, samme direkte-tilgang-mønster som `apps/api/src/
   * main.ts`/`server.ts` sin eksisterende `/infra/status`-rute allerede
   * bruker) - INGEN identitet trengs, INGEN policy-runde utover den YTRE
   * `executive.get_capability_status`-kallet selv allerede krever.
   *
   * D-237: `configured` per verktøy kommer fra `gateway.hasSecret()` -
   * SAMME presence-only-metode `hasSecret()` sin egen kontrakt allerede
   * garanterer (verdien går ALDRI hit) - `gateway.get(tool_id, action)`
   * slår kun opp den REGISTRERTE `ToolDefinition` for å finne
   * `credential_ref`, aldri et nytt, parallelt oppslag.
   */
  /**
   * EV-1 (D-412): «Hva er galt med deg akkurat nå?» - kildebelagt selvdiagnose + begrensninger. RENT lesende; hver observasjon bærer kilde og
   * tidspunkt; ukjent er UNKNOWN (aldri «frisk»). INGEN nøstede `gateway.execute()`-kall: lesere er injisert og leser sine egne kilder.
   */
  async getSelfDiagnosis(): Promise<SelfDiagnosis> {
    const sm = this.options.selfModel;
    return composeSelfDiagnosis({
      readers: sm?.readers ?? {},
      limitations: buildLimitationRegistry(sm?.limitations ?? { forbiddenModelToolIds: [], connectors: [], modelProfiles: [], allModelCapabilities: [] })
    });
  }

  /**
   * D-289 (Tobias direkte i chat: "vil ha alt at han har full kontroll" -
   * retningsvalg på D-288): samtaleflaten kaller nå `allMeshTools(gateway)`
   * (ALLE registrerte `tool_id:action`-par), ikke lenger kun de 5 kuraterte
   * `MESH_TOOLS`. Én rad PER HANDLING (~150+) ville både sprengt
   * `MeshToolExecutor` sin `maxOutputChars`-trimming (4000 tegn, se
   * `mesh-bridge.ts`) OG vært et ubrukelig svar å relayere muntlig/i chat -
   * gruppert PER `tool_id` er både kompakt nok OG mer nyttig for Charlie å
   * faktisk formidle ("GitHub: 23 handlinger, klasse A-D, tilkoblet").
   * `configured` er `true` KUN når ALLE distinkte `credential_ref`-er under
   * den `tool_id`-en er satt - samme presence-only-disiplin (ALDRI verdien)
   * som `hasSecret()` sin egen kontrakt. Fortsatt RENT avledet av
   * `ToolGateway.list()` - ALDRI en egen, potensielt avvikende opptelling
   * (samme D-209/D-237-disiplin som FØR denne posten, nå på et større
   * register).
   *
   * D-317 (Tobias direkte i chat: "bygg modell-selvbevissthet inn i
   * check_my_capabilities"): valgfri `servingModel` - hvilken leverandør/
   * modell som FAKTISK genererer DENNE samtaleturen. Kommer UTELUKKENDE fra
   * `ToolInvocationContext.servingModel` (via `ExecutiveTransport`), ALDRI
   * fra en modell-oppgitt parameter - se `gateway.ts` sitt filhode for
   * `ToolInvocationContext`. `null` når ukjent (f.eks. kalt utenfor en
   * modellgenerert samtaletur, som i disse enhetstestene) - ALDRI gjettet
   * til en fast verdi.
   */
  /**
   * EV-2 (D-417): tjenestemål, forverring og dataskvalitet. RENT lesende. Uten kilde: alle SLO-er UNKNOWN (aldri en gjetning om «innfridd»).
   */
  async getSloReport(): Promise<SloReport> {
    const provider = this.options.slo;
    if (provider) return provider.report();
    const now = new Date().toISOString();
    return composeSloReport({
      as_of: now,
      slos: SLO_CATALOG.map((d) => ({ id: d.id, label: d.label, status: "UNKNOWN" as const, value: null, target: d.target, metric: d.metric, samples: 0, window_hours: d.window_hours, source: "ingen kilde koblet inn", observed_at: now, detail: "Ingen måling tilgjengelig (kilde ikke koblet inn)." })),
      drift: null,
      data_quality: null
    });
  }

  /**
   * WP-B (D-452): evolusjonsportene (EV-0…EV-23) slik de står nå - kun observasjon, `acts: false`. Uten kilde: én ærlig «ikke koblet inn»-seksjon (aldri en gjetning om at noe er i orden).
   */
  async getEvolutionReport(): Promise<EvolutionReport> {
    const provider = this.options.evolution;
    if (provider) return provider.report();
    const now = new Date().toISOString();
    return composeEvolutionReport({
      as_of: now,
      sections: [{ ev: "EV-0…EV-23", title_no: "Evolusjonsporter", mode: "observe", status: "UNKNOWN", summary_no: "Ingen kilde er koblet inn, så ingenting kan vurderes.", findings: [], source: "ingen kilde koblet inn", observed_at: null }]
    });
  }

  /**
   * WP-H0: eier-kun-sjekken for `executive.get_control_center` (brukes av verktøydefinisjonens `parameterAuthorizer`, slik at et avslag blir en vanlig `tool.denied`-revisjonsrad FØR noe bygges).
   * Uten registeret er det ingenting å lekke, så sjekken slipper gjennom.
   */
  authorizeControlCenter(identity: IdentityContext): { allowed: boolean; reason: string } {
    return this.options.controlCenters ? this.options.controlCenters.authorize(identity) : { allowed: true, reason: "no_control_centers" };
  }

  /**
   * WP-H0 (JARVIS-087): eier-kun-porten for kontrollsenterets MUTASJONER (`cancel_task`). I motsetning til lesingen over er den FAIL-CLOSED også uten register: en skrivehandling slippes aldri gjennom fordi
   * «det ikke er noe å lekke». Samme eier-predikat (`isOwner`, i drift `resolveAuthorityMode(...) === "SOVEREIGN"`) som kontrollsentrene bruker.
   */
  authorizeOwnerControl(identity: IdentityContext): { allowed: boolean; reason: string } {
    const registry = this.options.controlCenters;
    if (!registry) return { allowed: false, reason: "control_center_owner_check_not_configured" };
    return registry.authorize(identity);
  }

  /** WP-H0: oversikt over de ti kontrollsentrene (registrerte bygges, øvrige listes som ikke koblet inn). RENT lesende. */
  async getControlCenterOverview(identity: IdentityContext): Promise<ControlCenterOverview> {
    const registry = this.options.controlCenters;
    if (registry) return registry.overview(identity);
    return composeControlCenterOverview([], new Date());
  }

  /** WP-H0: full rapport for ETT senter + deterministisk forklaring, eller `null` når senteret ikke er koblet inn. RENT lesende. */
  async getControlCenterReport(identity: IdentityContext, center: string): Promise<{ report: ControlCenterReport; explanation_no: string } | null> {
    const registry = this.options.controlCenters;
    if (!registry) return null;
    const report = await registry.report(center, identity);
    return report === null ? null : { report, explanation_no: explainControlCenterNo(report) };
  }

  async getCapabilityStatus(servingModel?: { provider: string; model: string }): Promise<CapabilityStatus> {
    const byToolId = new Map<string, { actions: Set<string>; classes: Set<string>; refs: Set<string> }>();
    const surface = this.options.modelSurface;
    const registered = this.gateway.list();
    const allowed = surface ? new Set(surface.map((s) => `${s.tool_id}:${s.action}`)) : undefined;
    for (const definition of registered) {
      if (allowed && !allowed.has(`${definition.tool_id}:${definition.action}`)) continue;
      const entry = byToolId.get(definition.tool_id) ?? { actions: new Set(), classes: new Set(), refs: new Set() };
      entry.actions.add(definition.action);
      entry.classes.add(definition.capability_class);
      entry.refs.add(definition.credential_ref);
      byToolId.set(definition.tool_id, entry);
    }
    const refConfigured = new Map<string, boolean>();
    const chatAccessibleTools = await Promise.all(
      [...byToolId.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(async ([tool_id, entry]) => {
          const refs = [...entry.refs];
          const configuredPerRef = await Promise.all(
            refs.map(async (ref) => {
              const cached = refConfigured.get(ref);
              if (cached !== undefined) return cached;
              const value = await this.gateway.hasSecret(ref);
              refConfigured.set(ref, value);
              return value;
            })
          );
          return {
            tool_id,
            actions: [...entry.actions].sort(),
            capability_classes: [...entry.classes].sort(),
            configured: configuredPerRef.every(Boolean)
          };
        })
    );
    return {
      chat_accessible_tools: chatAccessibleTools,
      connector_health: [...this.gateway.health.entries()].map(([tool_id, h]) => ({ tool_id, ...h })),
      serving_model: servingModel ?? null,
      ...(this.options.evaluationCaveat ? { evaluation_caveat: this.options.evaluationCaveat } : {}),
      ...(allowed
        ? {
            model_surface: {
              restricted: true,
              registered_actions: registered.length,
              model_accessible_actions: registered.filter((d) => allowed.has(`${d.tool_id}:${d.action}`)).length
            }
          }
        : {})
    };
  }

  /**
   * Task #119 (integrasjons-dashboard, D-211): SAMME direkte-tilgang-til-
   * egen-bokføring-mønster som `getCapabilityStatus()` over - BEVISST INGEN
   * nøstet `gateway.execute()`-kall. `listConnectorStatus()` selv (se
   * `@jarvis/tool-gateway`) kaller KUN `gateway.hasSecret()` (presence,
   * aldri verdi) og leser `gateway.health` direkte.
   */
  async getConnectorStatus(): Promise<ConnectorStatusReport> {
    return { connectors: await listConnectorStatus(this.gateway) };
  }
}
