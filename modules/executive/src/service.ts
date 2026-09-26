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

export class ExecutiveService {
  constructor(private readonly gateway: ToolGateway) {}

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
   */
  async getCapabilityStatus(): Promise<CapabilityStatus> {
    const byToolId = new Map<string, { actions: Set<string>; classes: Set<string>; refs: Set<string> }>();
    for (const definition of this.gateway.list()) {
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
      connector_health: [...this.gateway.health.entries()].map(([tool_id, h]) => ({ tool_id, ...h }))
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
