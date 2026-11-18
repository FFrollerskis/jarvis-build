import type { IncomingMessage, ServerResponse } from "node:http";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type {
  ActionDomain, ActionStatus, ExecutePersonalActionInput, ExecutePersonalActionResult, Params, PersonalActionExecutorDeps
} from "@jarvis/tool-gateway";

/**
 * WP-G2 (D-464, UA-8 Personal Twin): HTTP-rutene under `/personal/*`. ALT er dormant: `deps.personal` finnes KUN når minst ett `JARVIS_PERSONAL_*`-flagg er på (se `personal-wiring.ts`), og hver rutefamilie finnes kun med sitt eget flagg
 * - uten dem er `/personal/*` en vanlig 404, identisk med main. Rutene omgår ingenting: eier-kun (`requireOwner`), enhetssignert økt for alt som endrer noe (`stepUpDenial`), og utførelsen går UTELUKKENDE via
 * `ToolGateway.execute()`/domenetjenestene (policy, mål-allowlist, step-up, klasse D-kjeden, journal). Identitet/tenant/memory space kommer fra det verifiserte grantet (`authed`), aldri fra kroppen.
 * Modulen kjenner ikke `server.ts`: hjelpefunksjonene gis inn (`PersonalRouteContext`), slik at server.ts bare trenger ÉN kroklinje.
 */
export interface PersonalActionDomainDeps {
  /** Verktøy-id og lese-handling (klasse A, eier-kun, bruker samme mål-allowlist) for domenet. */
  toolId: string;
  readAction: string;
}

export interface PersonalActionsDeps {
  executor: PersonalActionExecutorDeps;
  domains: ReadonlyMap<string, PersonalActionDomainDeps>;
  /** Utfører én handling (i drift `executePersonalAction(executor, identity, input)`; en egen søm slik at rutetester kan teste rekkefølgen uten database). */
  run: (identity: IdentityContext, input: ExecutePersonalActionInput) => Promise<ExecutePersonalActionResult>;
}

/** Rute-avhengigheter per familie. En familie som ikke er slått på er `undefined` (og rutene finnes ikke). */
export interface PersonalApiDeps {
  actions?: PersonalActionsDeps;
}

export interface PersonalRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  deps: PersonalApiDeps;
  /** Leser kroppen, avviser identitetsfelt og ukjente nøkler, og løser grantet. `null` = svaret er allerede sendt. */
  authed(allowedKeys: readonly string[]): Promise<{ identity: IdentityContext; body: Record<string, unknown> } | null>;
  requireOwner(identity: IdentityContext, subject: { tool_id: string; action: string }): Promise<boolean>;
  stepUpDenial(identity: IdentityContext, action: string): string | undefined;
  json(status: number, body: unknown): void;
  requestId(): string;
  fieldString(body: Record<string, unknown>, key: string): string;
  fieldOptionalString(body: Record<string, unknown>, key: string): string | undefined;
  fieldRecord(body: Record<string, unknown>, key: string): Record<string, unknown>;
  fieldOptionalNumber(body: Record<string, unknown>, key: string): number | undefined;
  domainFailure(status: number, code: string, err: unknown): void;
}

const DOMAIN = /^(home|car)$/;
const ACTION_STATUS: readonly string[] = ["requested", "applied", "failed", "outcome_unknown"];

/** Bindeverdiene (forutsetninger) som forhåndsvisningen gir tilbake: scene/skript krever sin markør, de øvrige tilstanden de så. */
export function bindFor(action: string, state: Params): Params {
  if (action === "critical_scene") return { expected_last_activated: (state["last_activated"] ?? null) as JsonValue };
  if (action === "critical_script") return { expected_last_triggered: (state["last_triggered"] ?? null) as JsonValue };
  return typeof state["state"] === "string" ? { expected_state: state["state"] } : {};
}

/** `true` = ruten er håndtert (svaret er sendt). `false` = ikke en `/personal/*`-rute vi eier (kalleren fortsetter til 404). */
export async function handlePersonalRoute(ctx: PersonalRouteContext): Promise<boolean> {
  const { req, url } = ctx;
  if (req.method !== "POST") return false;
  const actions = ctx.deps.actions;
  if (actions !== undefined && url.pathname.startsWith("/personal/actions/")) return handleActionRoute(ctx, actions);
  return false;
}

async function handleActionRoute(ctx: PersonalRouteContext, actions: PersonalActionsDeps): Promise<boolean> {
  const { url } = ctx;
  const domainOf = (body: Record<string, unknown>): { domain: ActionDomain; entry: PersonalActionDomainDeps } | null => {
    const domain = ctx.fieldString(body, "domain");
    const entry = DOMAIN.test(domain) ? actions.domains.get(domain) : undefined;
    if (entry === undefined) {
      ctx.json(400, { error: "personal_domain_unknown", request_id: ctx.requestId() });
      return null;
    }
    return { domain: domain as ActionDomain, entry };
  };

  if (url.pathname === "/personal/actions/mutate") {
    // Eier-initiert kritisk handling. Rekkefølge: grant -> KUN eieren (ingen delegat) -> step-up (enhetssignert økt, aldri tale/Telegram/system/klokke) -> eksekutoren (journal + ToolGateway: mål-allowlist, klasse D-kjede, varsling).
    const authed = await ctx.authed(["domain", "action", "parameters", "idempotency_key"]);
    if (!authed) return true;
    if (!(await ctx.requireOwner(authed.identity, { tool_id: "personal", action: "actions_mutate" }))) return true;
    const stepUp = ctx.stepUpDenial(authed.identity, "personal_actions_mutate");
    if (stepUp) return ctx.json(403, { error: "step_up_required", reason: stepUp, request_id: ctx.requestId() }), true;
    const target = domainOf(authed.body);
    if (!target) return true;
    try {
      const execution = await actions.run(authed.identity, {
        domain: target.domain, action: ctx.fieldString(authed.body, "action"), parameters: ctx.fieldRecord(authed.body, "parameters") as Params,
        idempotency_key: ctx.fieldString(authed.body, "idempotency_key"), source: "owner_route", session_id: authed.identity.session_id
      });
      ctx.json(200, { execution });
    } catch (err) {
      // Kun VÅRE egne, bevisste feilkoder vises til eieren; alt annet logges og blir generisk.
      const reason = err instanceof Error ? err.message : "";
      if (/^personal_action_[a-z_]+(?::|$)/.test(reason)) ctx.json(400, { error: "personal_action_rejected", reason: reason.slice(0, 80), request_id: ctx.requestId() });
      else ctx.domainFailure(400, "personal_action_rejected", err);
    }
    return true;
  }

  if (url.pathname === "/personal/actions/preview" || url.pathname === "/personal/actions/read") {
    // Lesing av NØYAKTIG ett måls tilstand (klasse A via gatewayen: eier-kun og mål-allowlist). `preview` kjører i tillegg handlingens validator mot den ferske tilstanden og gir tilbake bindeverdiene (forutsetningene)
    // som `mutate` skal sende med - ingenting endres. Utdata er normalisert tilstand (aldri fritekst fra utstyret) og merket ubetrodd.
    const preview = url.pathname.endsWith("/preview");
    const authed = await ctx.authed(preview ? ["domain", "action", "parameters"] : ["domain", "parameters"]);
    if (!authed) return true;
    if (!(await ctx.requireOwner(authed.identity, { tool_id: "personal", action: preview ? "actions_preview" : "actions_read" }))) return true;
    const target = domainOf(authed.body);
    if (!target) return true;
    const parameters = ctx.fieldRecord(authed.body, "parameters") as Params;
    const op = preview ? actions.executor.index.get(`${target.domain}.${ctx.fieldString(authed.body, "action")}`)?.op : undefined;
    if (preview && op === undefined) return ctx.json(400, { error: "personal_action_unknown_action", request_id: ctx.requestId() }), true;
    // `preview` leser KUN målet handlingen peker på (ingen andre parametre sendes videre); `read` sender parametrene til lese-handlingen, hvis strenge skjema og mål-allowlist avgjør.
    const readParameters = (op ? { [op.targetParam]: parameters[op.targetParam] ?? null } : parameters) as Record<string, JsonValue>;
    const read = await actions.executor.gateway.execute({
      identity: authed.identity, tool_id: target.entry.toolId, action: target.entry.readAction, parameters: readParameters
    });
    if (!read.ok) return ctx.json(200, { ok: false, reason: read.reason.slice(0, 120), request_id: ctx.requestId() }), true;
    const state = (read.data ?? null) as Params | null;
    if (!preview) return ctx.json(200, { ok: true, output_trust: read.output_trust, data: state }), true;
    if (state === null || typeof state !== "object") return ctx.json(200, { ok: false, reason: "preflight_target_not_found", request_id: ctx.requestId() }), true;
    const bind = bindFor(op!.action, state);
    const reason = op!.validate(state, { ...parameters, ...bind });
    ctx.json(200, { ok: true, output_trust: read.output_trust, domain: target.domain, action: op!.action, direction: op!.direction({ ...parameters, ...bind }), valid: reason === null, reason, bind, state });
    return true;
  }

  if (url.pathname === "/personal/actions/list") {
    const authed = await ctx.authed(["domain", "status", "target_ref", "limit"]);
    if (!authed) return true;
    if (!(await ctx.requireOwner(authed.identity, { tool_id: "personal", action: "actions_list" }))) return true;
    const target = domainOf(authed.body);
    if (!target) return true;
    const status = ctx.fieldOptionalString(authed.body, "status");
    if (status !== undefined && !ACTION_STATUS.includes(status)) return ctx.json(400, { error: "malformed_request", reason: "status", request_id: ctx.requestId() }), true;
    const targetRef = ctx.fieldOptionalString(authed.body, "target_ref");
    const limit = ctx.fieldOptionalNumber(authed.body, "limit");
    const rows = await actions.executor.journal.list(authed.identity.tenant_id, authed.identity.memory_space_id as never, {
      domain: target.domain, ...(status !== undefined ? { status: status as ActionStatus } : {}), ...(targetRef !== undefined ? { target_ref: targetRef } : {}), ...(limit !== undefined ? { limit } : {})
    });
    ctx.json(200, { actions: rows });
    return true;
  }
  return false;
}
