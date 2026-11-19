import type { IncomingMessage } from "node:http";
import type { IdentityContext } from "@jarvis/contracts";
import { ownerStepUpDenial } from "@jarvis/tool-gateway";
import {
  FeedbackUnauthorizedError, FeedbackValidationError, SituationAutonomyUnauthorizedError, SubscriptionNotFoundError, SubscriptionUnauthorizedError, SubscriptionValidationError, isSignalSource,
  type FeedbackService, type SignalLogService, type SimulationService, type SituationEngine, type SituationSignalRunner, type SubscriptionRegistry
} from "@jarvis/situations";

/**
 * WP-G4 fiks-runde (B-MEDIUM-5, D-41): `/situations/signals/*` - eierens EGEN flate for det samlede hendelsesabonnementet. Uten den kunne verken `situations.subscribe` eller de andre kontrollhandlingene nås i drift
 * (executive-allowlisten og modellflaten kjenner dem ikke; verktøyene er eier-eksklusive uten modellflate), så eieren hadde ikke kapabiliteten. DORMANT: uten `deps.situationSignals` (satt av main.ts KUN med
 * `JARVIS_SITUATION_SIGNALS=on`) finnes ingen av rutene (404, identisk med main). Aldri et modellverktøy.
 *
 * Alle ruter er `POST` med JSON-kropp og `grant_token` (som `/vision/*` og `/personal/*`): identitet, tenant, person og space kommer UTELUKKENDE fra det verifiserte grantet - kroppen kan aldri bære dem (`authed` avviser
 * identitetsfelt og ukjente felt FØR grantet løses). To klasser:
 *   - eier-LES: grant + eier-port (`deps.ownerGate`).
 *   - eier-SKRIV: grant + eier-port + STEP-UP (enhetssignert økt fra en eier-kanal, samme regel som øvrige kontrollhandlinger). `subscriptions/remove` krever i tillegg TYPET bekreftelse (`confirm: true` +
 *     `confirm_subscription_id`; ingen destruktiv handling uten eksplisitt bekreftelse, CLAUDE.md regel 8).
 * Registeret og motoren har i tillegg sin EGEN sovereign-eier-sjekk (uavhengig andre port), og revisjonsraden skrives i SAMME transaksjon som endringen (registeret/motoren, ikke ruten). Svar er avledede og minimerte
 * (abonnementsrader, loggfakta, tellere); modellens vurderingstekst er UBETRODD og merkes `untrusted: true`.
 */
export interface SituationSignalApiDeps {
  registry: SubscriptionRegistry;
  engine: SituationEngine;
  logs: SignalLogService;
  runner: Pick<SituationSignalRunner, "status">;
  simulation: SimulationService;
  /** Tilbakemelding/tuning (`JARVIS_SITUATION_FEEDBACK`). Utelatt = de tilhørende rutene finnes ikke (404). */
  feedback?: FeedbackService;
}

export interface SituationSignalRouteHelpers {
  /** Kropp -> forbudte identitetsfelt -> hvitelistede felt -> grant -> enhets-rate-limit (server.ts `authedRequest`). Sender selv svar og gir `null` ved avslag. */
  authed(allowedKeys: readonly string[], maxBytes?: number): Promise<{ identity: IdentityContext; body: Record<string, unknown> } | null>;
  /** Eier-porten; sender selv `403 owner_required` og gir `false` ved avslag. */
  requireOwner(identity: IdentityContext, subject: { tool_id: string; action: string }): Promise<boolean>;
  json(status: number, body: unknown): void;
  requestId(): string;
}

interface RouteSpec {
  access: "owner_read" | "owner_write";
  action: string;
  keys: readonly string[];
  /** Finnes kun når tilbakemelding/tuning er slått på. */
  feedback?: true;
}

const ROUTES: Readonly<Record<string, RouteSpec>> = {
  "/situations/signals/subscriptions/list": { access: "owner_read", action: "list_subscriptions", keys: [] },
  "/situations/signals/status": { access: "owner_read", action: "get_signal_status", keys: [] },
  "/situations/signals/log": { access: "owner_read", action: "list_signals", keys: ["situation_id", "source", "limit"] },
  "/situations/signals/assessments": { access: "owner_read", action: "list_assessments", keys: ["situation_id"] },
  "/situations/signals/simulate": { access: "owner_read", action: "get_situation_simulation", keys: ["situation_id"] },
  "/situations/signals/rule-tuning": { access: "owner_read", action: "get_rule_tuning", keys: [], feedback: true },
  "/situations/signals/subscriptions/subscribe": { access: "owner_write", action: "subscribe", keys: ["source", "event_type", "filter", "enabled"] },
  "/situations/signals/subscriptions/set-enabled": { access: "owner_write", action: "set_subscription_enabled", keys: ["subscription_id", "enabled"] },
  "/situations/signals/subscriptions/remove": { access: "owner_write", action: "remove_subscription", keys: ["subscription_id", "confirm", "confirm_subscription_id"] },
  "/situations/signals/quiet-bypass": { access: "owner_write", action: "set_critical_quiet_bypass", keys: ["enabled"] },
  "/situations/signals/feedback": { access: "owner_write", action: "record_feedback", keys: ["situation_id", "verdict"], feedback: true },
  "/situations/signals/rule-tuning/reset": { access: "owner_write", action: "reset_rule_tuning", keys: ["rule_key"], feedback: true }
};

function str(body: Record<string, unknown>, key: string, max: number): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/** Returnerer `true` når ruten er håndtert (svar sendt), `false` når stien/metoden ikke er en signalrute (serveren faller da til sin vanlige 404). */
export async function handleSituationSignalRoute(req: IncomingMessage, pathname: string, deps: SituationSignalApiDeps, h: SituationSignalRouteHelpers): Promise<boolean> {
  const spec = ROUTES[pathname];
  if (spec === undefined || req.method !== "POST") return false;
  if (spec.feedback === true && deps.feedback === undefined) return false; // flagg AV for tilbakemelding: ruten finnes ikke
  const authed = await h.authed(spec.keys);
  if (authed === null) return true;
  const { identity, body } = authed;
  const requestId = h.requestId();
  if (!(await h.requireOwner(identity, { tool_id: "situations", action: spec.action }))) return true;
  if (spec.access === "owner_write") {
    const denial = ownerStepUpDenial(identity);
    if (denial !== undefined) {
      h.json(403, { error: "step_up_required", reason: denial, request_id: requestId });
      return true;
    }
  }
  const tenant = identity.tenant_id;
  const space = identity.memory_space_id;
  const actor = { person_id: identity.person_id, session_id: identity.session_id };
  const bad = (reason: string): true => {
    h.json(400, { error: "malformed_request", reason, request_id: requestId });
    return true;
  };

  try {
    switch (pathname) {
      case "/situations/signals/subscriptions/list":
        h.json(200, { ok: true, data: { subscriptions: await deps.registry.list(tenant, space) } });
        return true;
      case "/situations/signals/status": {
        const status = deps.runner.status();
        h.json(200, { ok: true, data: { enabled: true, running: status.running, tick: status.tick, last: status.last } });
        return true;
      }
      case "/situations/signals/log": {
        const source = body["source"];
        if (source !== undefined && !isSignalSource(source)) return bad("source");
        const limit = body["limit"];
        if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)) return bad("limit");
        const situationId = body["situation_id"];
        if (situationId !== undefined && (typeof situationId !== "string" || situationId.length === 0 || situationId.length > 200)) return bad("situation_id");
        h.json(200, { ok: true, data: { signals: await deps.logs.list(tenant, space, { ...(situationId !== undefined ? { situation_id: situationId as string } : {}), ...(source !== undefined ? { source } : {}), ...(limit !== undefined ? { limit: limit as number } : {}) }) } });
        return true;
      }
      case "/situations/signals/assessments": {
        const situationId = str(body, "situation_id", 200);
        if (situationId === null) return bad("situation_id");
        // Modellens forklaring er UBETRODD tekst: merket, så en klient viser den som sitert data og aldri tolker den som instruks.
        h.json(200, { ok: true, untrusted: true, data: { assessments: await deps.logs.assessments(tenant, space, situationId) } });
        return true;
      }
      case "/situations/signals/simulate": {
        const situationId = str(body, "situation_id", 200);
        if (situationId === null) return bad("situation_id");
        h.json(200, { ok: true, data: await deps.simulation.simulate(tenant, space, situationId) });
        return true;
      }
      case "/situations/signals/rule-tuning":
        h.json(200, { ok: true, data: { rules: await (deps.feedback as FeedbackService).listTuning(tenant, space) } });
        return true;
      case "/situations/signals/subscriptions/subscribe": {
        const source = str(body, "source", 40);
        const eventType = str(body, "event_type", 60);
        if (source === null) return bad("source");
        if (eventType === null) return bad("event_type");
        const filter = body["filter"];
        if (filter !== undefined && (filter === null || typeof filter !== "object" || Array.isArray(filter))) return bad("filter");
        const enabled = body["enabled"];
        if (enabled !== undefined && typeof enabled !== "boolean") return bad("enabled");
        const row = await deps.registry.subscribe(tenant, space, { source, event_type: eventType, filter: filter ?? {}, ...(enabled !== undefined ? { enabled } : {}) }, actor);
        h.json(200, { ok: true, data: row });
        return true;
      }
      case "/situations/signals/subscriptions/set-enabled": {
        const subscriptionId = str(body, "subscription_id", 200);
        if (subscriptionId === null) return bad("subscription_id");
        if (typeof body["enabled"] !== "boolean") return bad("enabled");
        h.json(200, { ok: true, data: await deps.registry.setEnabled(tenant, space, subscriptionId, body["enabled"], actor) });
        return true;
      }
      case "/situations/signals/subscriptions/remove": {
        const subscriptionId = str(body, "subscription_id", 200);
        if (subscriptionId === null) return bad("subscription_id");
        // TYPET bekreftelse (som `/vision/cameras/remove`): `confirm: true` OG `confirm_subscription_id` lik abonnementets id - ingen sletting uten at begge er gitt.
        if (body["confirm"] !== true || body["confirm_subscription_id"] !== subscriptionId) {
          h.json(409, { error: "confirmation_required", reason: "confirm_true_and_confirm_subscription_id_required", confirm_subscription_id_required: subscriptionId, request_id: requestId });
          return true;
        }
        const removed = await deps.registry.remove(tenant, space, subscriptionId, actor);
        if (!removed) {
          h.json(404, { error: "subscription_not_found", request_id: requestId });
          return true;
        }
        h.json(200, { ok: true, data: { removed: true, subscription_id: subscriptionId } });
        return true;
      }
      case "/situations/signals/quiet-bypass": {
        if (typeof body["enabled"] !== "boolean") return bad("enabled");
        h.json(200, { ok: true, data: await deps.engine.setCriticalQuietBypass(tenant, space, body["enabled"], identity.person_id) });
        return true;
      }
      case "/situations/signals/feedback": {
        const situationId = str(body, "situation_id", 200);
        if (situationId === null) return bad("situation_id");
        const verdict = body["verdict"];
        if (verdict !== "useful" && verdict !== "noise") return bad("verdict");
        h.json(200, { ok: true, data: await (deps.feedback as FeedbackService).submit(tenant, space, situationId, verdict, actor) });
        return true;
      }
      case "/situations/signals/rule-tuning/reset": {
        const ruleKey = str(body, "rule_key", 100);
        if (ruleKey === null) return bad("rule_key");
        h.json(200, { ok: true, data: { reset: await (deps.feedback as FeedbackService).resetTuning(tenant, space, ruleKey, actor) } });
        return true;
      }
      default:
        return false;
    }
  } catch (err) {
    if (err instanceof SubscriptionValidationError) {
      h.json(400, { error: "subscription_invalid", code: err.code, request_id: requestId });
      return true;
    }
    if (err instanceof FeedbackValidationError) {
      h.json(400, { error: "feedback_invalid", code: err.code, request_id: requestId });
      return true;
    }
    if (err instanceof SubscriptionNotFoundError) {
      h.json(404, { error: "subscription_not_found", request_id: requestId });
      return true;
    }
    if (err instanceof SubscriptionUnauthorizedError || err instanceof FeedbackUnauthorizedError || err instanceof SituationAutonomyUnauthorizedError) {
      h.json(403, { error: "owner_required", request_id: requestId });
      return true;
    }
    throw err;
  }
}
