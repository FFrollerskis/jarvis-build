import type { JsonValue } from "@jarvis/contracts";
import { adoptCallSignal } from "../call-signal.ts";
import { afterAcceptedMutation } from "../after-accepted-mutation.ts";
import { OUTCOME_UNKNOWN_PREFIX, type ToolInvocationContext, type ToolTransport } from "../gateway.ts";
import { isIndeterminateTransportError, transportErrorKind } from "../transport-errors.ts";
import { encodePathSegment, guardedFetch } from "../url-safety.ts";
import { settleUntil, type Params } from "./critical-ops.ts";
import {
  HOME_CRITICAL_OPS, HOME_CRITICAL_READ_ACTION, HOME_WAIT_FOR_MATCH_ACTIONS, homeServiceCall, homeSettleMsFor, isHomeCriticalEntityId, normalizeHomeCriticalState, type HomeCriticalConfig
} from "./home-critical.ts";

/**
 * WP-G2 P1a (D-464): transporten for de KRITISKE hjemmehandlingene (`home-critical.ts`). Den bruker Home Assistant REST API (`GET /api/states/<entity_id>`, `POST /api/services/<domain>/<service>`, Bearer-token;
 * verifisert mot offisiell HA-dokumentasjon: tjenestekallet blokkerer til tjenesten er ferdig). Transporten TRANSPORTERER - mål-autorisasjon og step-up håndheves av `ToolGateway.execute()` før den nås.
 *
 * Rekkefølgen per mutasjon (samme som D3-fabrikken): les målet -> valider med SAMME validator som gatewayens preflight -> send kommandoen -> VENT på sluttilstand (lås/port/ventil/alarm er ikke øyeblikkelige)
 * -> returnér den faktisk leste tilstanden. Gatewayen leser så tilbake selv og avgjør etterbetingelsen (`postcondition_predicate`): en feil sluttilstand er aldri «ok».
 *
 * Utfall (D-392/WP-K): FØR sending feiler alt som en vanlig feil (retry tillatt). ETTER at kommandoen kan ha nådd HA er feil `outcome_unknown:<kode>` - 5xx, nullstilt/tidsavbrutt tilkobling, redirect, og enhver feil
 * i ventingen/lesingen - slik at en retry med samme nøkkel aldri sender en ny kommando og eieren får «UTFALL UKJENT». HA sitt 4xx-svar (avvist: ukjent tjeneste/ugyldig data/feil token) er en entydig avvisning.
 * Alarmkoden (PIN) leses via vault-referanse ved hvert kall, sendes kun til HA og ligger aldri i feilkoder, tilstand, journal eller varsel.
 */
export interface HomeCriticalTransportDeps {
  baseUrl: () => Promise<string | null>;
  /** Vault-oppslag for alarmpanelets kode (hvis panelet krever den). `null`/tom = ingen kode sendes. */
  alarmCode?: () => Promise<string | null>;
  /** Standard ventetid på sluttilstand; `settleMsByDomain` overstyrer per domene (alarm: utgangsforsinkelse). */
  settleMs: number;
  settleMsByDomain?: HomeCriticalConfig["settleMsByDomain"];
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const OPS = new Map(HOME_CRITICAL_OPS.map((op) => [op.action, op] as const));

/**
 * Klokkeskjevhet HA - Jarvis i ms (positivt = HA ligger FREM) fra HTTP-`Date` i HA-svaret, nøyaktig til ca. ett sekund (headeren har sekundoppløsning). `null` = ingen brukbar `Date` (mangler/uleselig). Brukes KUN av avstemmingen (WP-G2c fiks-runde 1, LOW-1) som
 * grunnlag for å nekte `failed` når klokkene avviker: `last_changed` er HAs egen klokke, og `requested_at` er Jarvis'. Kun et tall - aldri svarteksten. Begrensning: `Date` er klokken til nærmeste HTTP-ledd; en omvendt proxy på en annen maskin enn HA setter sin egen.
 */
function clockSkewMs(response: Pick<Response, "headers">, nowMs: number = Date.now()): number | null {
  const header = response.headers.get("date");
  if (header === null) return null;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.round(at - nowMs) : null;
}

export class HomeAssistantCriticalTransport implements ToolTransport {
  constructor(private readonly deps: HomeCriticalTransportDeps) {}

  async invoke(action: string, parameters: Params, credential: string, _context?: ToolInvocationContext, signal?: AbortSignal): Promise<{ external_id?: string; data?: JsonValue }> {
    return adoptCallSignal(signal, () => this.dispatch(action, parameters, credential));
  }

  private async root(): Promise<string> {
    const url = (await this.deps.baseUrl())?.trim();
    if (!url) throw new Error("home_assistant_base_url_not_configured");
    return url.replace(/\/+$/, "");
  }

  /** `null` = målet finnes ikke (404). Alt annet enn 2xx kaster (en lesing har ingen bivirkning). Svaret normaliseres: kun enumererte tilstandsord, tall og tidsstempler - aldri `friendly_name` eller andre fritekst-attributter. */
  private async readEntity(entityId: string, credential: string, measureClock = false): Promise<Params | null> {
    const response = await guardedFetch(`${await this.root()}/api/states/${encodePathSegment(entityId, "entity")}`, { headers: { authorization: `Bearer ${credential}`, accept: "application/json" } });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`home_assistant_error_${response.status}`);
    }
    const json = (await response.json()) as { entity_id?: unknown; state?: unknown; attributes?: unknown; last_changed?: unknown } | null;
    if (json === null || typeof json !== "object" || json.entity_id !== entityId || typeof json.state !== "string") throw new Error("home_assistant_state_malformed");
    const attributes = typeof json.attributes === "object" && json.attributes !== null && !Array.isArray(json.attributes) ? (json.attributes as Record<string, unknown>) : undefined;
    const normalized = normalizeHomeCriticalState({ entity_id: json.entity_id, state: json.state, attributes, last_changed: json.last_changed });
    // Kun lese-handlingen (som avstemmingen bruker) bærer målt klokkeskjevhet; lesingene inne i en mutasjon (før-tilstand, ventesløyfe) er uendret.
    return measureClock ? { ...normalized, clock_skew_ms: clockSkewMs(response) } : normalized;
  }

  /** Sender tjenestekallet. FØR sending: vanlig feil. Etter at forespørselen kan ha nådd HA: `outcome_unknown` (5xx, nullstilt/tidsavbrutt, redirect). 4xx = entydig avvist. */
  private async send(domain: string, service: string, data: Params, credential: string): Promise<void> {
    let response: Response;
    try {
      response = await guardedFetch(`${await this.root()}/api/services/${encodePathSegment(domain, "domain")}/${encodePathSegment(service, "service")}`, {
        method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(data)
      });
    } catch (err) {
      if (isIndeterminateTransportError(err)) throw new Error(`${OUTCOME_UNKNOWN_PREFIX}:home_service_transport_${transportErrorKind(err)}`);
      // Beviselig FØR sending (DNS, tilkobling nektet, TLS, utrygg URL): kun en fast kode - aldri nettverksfeilens tekst (kan sitere vert/port).
      throw new Error("home_assistant_unreachable");
    }
    // Svaret er en liste over endrede tilstander - det brukes ikke (vi leser den faktiske tilstanden selv). Forkast kroppen uten å lese den.
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return;
    if (response.status >= 500) throw new Error(`${OUTCOME_UNKNOWN_PREFIX}:home_service_http_${response.status}`);
    throw new Error(`home_assistant_rejected_${response.status}`);
  }

  private async dispatch(action: string, p: Params, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const entity = p["entity"];
    if (!isHomeCriticalEntityId(entity)) throw new Error("home_invalid_entity_id");
    if (action === HOME_CRITICAL_READ_ACTION) return { data: await this.readEntity(entity, credential, true) };
    const op = OPS.get(action);
    const call = homeServiceCall(action, p);
    if (!op || call === null) throw new Error(`home_critical_unsupported_action:${action.slice(0, 40).replace(/[^A-Za-z0-9_]/g, "_")}`);

    const before = await this.readEntity(entity, credential);
    if (before === null) throw new Error("home_target_not_found");
    // SAMME validator som gatewayens preflight (forsvar i dybden: transporten kan også nås uten gatewayen i et skript).
    const invalid = op.validate(before, p);
    if (invalid !== null) throw new Error(`home_precondition_failed:${invalid}`);

    const data: Params = { ...call.data };
    if (action === "critical_alarm") {
      const code = await this.deps.alarmCode?.();
      if (typeof code === "string" && code.length > 0) data["code"] = code;
    }
    await this.send(call.domain, call.service, data, credential);

    // ETTER akseptert kommando: enhver feil herfra er «utfall ukjent», aldri en vanlig, retry-bar feil.
    // VENT PÅ SLUTTILSTANDEN (review A, MEDIUM-1): til tilstanden matcher, ELLER den har ENDRET seg fra før-tilstanden og er settlet (en feil sluttilstand: jammed, feil modus - vises umiddelbart), ELLER fristen går ut.
    // Utstyr som aldri viser en overgangstilstand (MQTT/Zigbee) kan vise den GAMLE tilstanden noen lesinger etter kommandoen: «settlet» alene er ikke nok - uendret tilstand venter ut fristen (domenets ventetid; alarm med utgangsforsinkelse lengst).
    const waitForMatch = HOME_WAIT_FOR_MATCH_ACTIONS.has(action);
    const deadlineMs = homeSettleMsFor({ settleMs: this.deps.settleMs, ...(this.deps.settleMsByDomain ? { settleMsByDomain: this.deps.settleMsByDomain } : {}) }, call.domain);
    const settled = await afterAcceptedMutation("home_readback_failed", () => settleUntil({
      read: () => this.readEntity(entity, credential),
      isSettled: (state) => !waitForMatch && state["settled"] === true && state["state"] !== before["state"],
      matches: (state) => op.post(state, p),
      deadlineMs, pollMs: Math.max(this.deps.pollMs, Math.ceil(deadlineMs / 60)),
      ...(this.deps.now ? { now: this.deps.now } : {}), ...(this.deps.sleep ? { sleep: this.deps.sleep } : {})
    }));
    return { external_id: `${call.domain}.${call.service}:${entity}`, data: { settled: settled.settled, matched: settled.matched, polls: settled.polls, state: settled.state } };
  }
}
