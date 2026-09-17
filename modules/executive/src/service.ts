import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type {
  Situation,
  SituationAutonomyPolicy,
  SituationNotificationPolicy
} from "@jarvis/situations";
import type { ToolGateway, ToolResult } from "@jarvis/tool-gateway";
import { rankAttentionQueue } from "./ranking.ts";
import type { AttentionItem, AttentionItemDetail } from "./types.ts";

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
  action: string,
  parameters: Record<string, JsonValue> = {}
): Promise<T> {
  const result = await gateway.execute({ identity, tool_id: "situations", action, parameters });
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
      requireData<Situation[]>(this.gateway, identity, "get_queue", filter.domain ? { domain: filter.domain } : {}),
      requireData<{ paused: string[] }>(this.gateway, identity, "get_pause_state"),
      requireData<SituationAutonomyPolicy[]>(this.gateway, identity, "list_autonomy_policies"),
      requireData<SituationNotificationPolicy | null>(this.gateway, identity, "get_notification_policy")
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
}
