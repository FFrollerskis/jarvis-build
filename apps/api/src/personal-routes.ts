import type { IncomingMessage, ServerResponse } from "node:http";
import { FamilyError, type FamilyActor, type FamilyDelegationScope, type FamilyErrorCode, type FamilyService, type FamilyShareCategory, type InvitableRole } from "@jarvis/context";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { HealthIntakeError, HealthRetentionPolicyRequiredError, type HealthIntakeService } from "@jarvis/health";
import type {
  ActionDomain, ActionStatus, ExecutePersonalActionInput, ExecutePersonalActionResult, Params, PersonalActionExecutorDeps
} from "@jarvis/tool-gateway";
import { handleDavRoute, type PersonalDavDeps } from "./personal-dav.ts";
import { handleFinanceRead, type PersonalFinanceDeps } from "./personal-finance-read.ts";

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

export interface PersonalFamilyDeps {
  service: FamilyService;
  /** Den suverene eierens person-id (fra eierkonfigurasjonen - aldri fra en kropp). Kun den kan opprette sirkelen (`bootstrap`) og se topologien. */
  ownerPersonId: string;
}

export interface PersonalHealthDeps {
  intake: Pick<HealthIntakeService, "ingestBatch">;
}

/** Rute-avhengigheter per familie. En familie som ikke er slått på er `undefined` (og rutene finnes ikke). */
export interface PersonalApiDeps {
  actions?: PersonalActionsDeps;
  family?: PersonalFamilyDeps;
  health?: PersonalHealthDeps;
  finance?: PersonalFinanceDeps;
  dav?: PersonalDavDeps;
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
  const family = ctx.deps.family;
  if (family !== undefined && url.pathname.startsWith("/personal/family/")) return handleFamilyRoute(ctx, family);
  const health = ctx.deps.health;
  if (health !== undefined && url.pathname === "/personal/health/ingest") return handleHealthIngest(ctx, health);
  const finance = ctx.deps.finance;
  if (finance !== undefined && url.pathname === "/personal/finance/read") return handleFinanceRead(ctx, finance);
  const dav = ctx.deps.dav;
  if (dav !== undefined && url.pathname.startsWith("/personal/dav/")) return handleDavRoute(ctx, dav);
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Helse-inntak (P1d): `POST /personal/health/ingest`. Finnes KUN med `JARVIS_PERSONAL_HEALTH_INGEST=on`. Enhetssignert: et verifisert grant med `auth_strength: signed` fra kanalen `mobile`/`watch`, scopet til `health`-rommet;
// dataene tilhører grantets person (aldri en kropp). Helsedata er begrenset (SECRET_RESTRICTED): ingenting herfra går til en modell, en prompt eller en logg - feil logges kun som klassenavn, aldri melding (en databasefeil kan
// sitere rader), og svaret inneholder antall og årsakskoder per prøve, aldri verdier.
// ---------------------------------------------------------------------------------------------------------------------
export const HEALTH_INTAKE_CHANNELS: ReadonlySet<string> = new Set(["mobile", "watch"]);

/** `undefined` = oppfylt, ellers en stabil årsakskode. Ren og deterministisk. */
export function healthIntakeDenial(identity: Pick<IdentityContext, "auth_strength" | "channel" | "memory_space_id">): string | undefined {
  if (identity.auth_strength !== "signed") return "signed_device_session_required";
  if (!HEALTH_INTAKE_CHANNELS.has(identity.channel)) return "channel_not_allowed";
  if (identity.memory_space_id !== "health") return "health_space_required";
  return undefined;
}

const HEALTH_INTAKE_STATUS: Readonly<Record<string, number>> = { empty_batch: 400, invalid_request: 400, batch_too_large: 413 };

async function handleHealthIngest(ctx: PersonalRouteContext, health: PersonalHealthDeps): Promise<boolean> {
  const authed = await ctx.authed(["samples", "deleted_external_sample_ids"]);
  if (!authed) return true;
  const denial = healthIntakeDenial(authed.identity);
  if (denial !== undefined) return ctx.json(403, { error: "health_intake_denied", reason: denial, request_id: ctx.requestId() }), true;
  try {
    const result = await health.intake.ingestBatch(authed.identity, { samples: authed.body["samples"], deleted_external_sample_ids: authed.body["deleted_external_sample_ids"] });
    ctx.json(200, { source: "apple_health", ...result });
  } catch (err) {
    if (err instanceof HealthIntakeError) ctx.json(HEALTH_INTAKE_STATUS[err.code] ?? 400, { error: "health_intake_rejected", reason: err.code, request_id: ctx.requestId() });
    else if (err instanceof HealthRetentionPolicyRequiredError) ctx.json(409, { error: "health_retention_policy_required", request_id: ctx.requestId() });
    else ctx.domainFailure(500, "health_intake_failed", new Error(err instanceof Error ? err.name : "unknown")); // aldri feilmeldingen: den kan sitere helseverdier
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Familie-/delt-rom (P1c): `/personal/family/*`. Identitet/tenant/rom kommer fra det verifiserte grantet (aldri fra kroppen); ROLLER og delinger avgjøres av `FamilyService` (og databasen), ikke av ruten. Ruten legger til:
//  - `signed`: enhetssignert økt (step-up) for alt som endrer autoritet (medlemskap, deling, delegasjon) og for å LESE en annens delte data; aldri tale/Telegram/system/klokke.
//  - «på vegne av» krever i tillegg signert økt (agenten handler i en annens navn).
//  - feil vises som `family_rejected` med KUN den bevisste koden (`reason`); `share_required` er alltid samme svar (ingen informasjon om hvorfor). Annet blir generisk (`family_failed`) og logges.
// ---------------------------------------------------------------------------------------------------------------------
export const FAMILY_STATUS: Readonly<Record<FamilyErrorCode, number>> = {
  invalid_input: 400, self_target: 400,
  shared_space_required: 403, not_a_member: 403, owner_required: 403, role_not_allowed: 403, not_the_invitee: 403, share_required: 403, share_not_allowed: 403, delegation_required: 403, delegation_not_allowed: 403,
  not_found: 404,
  already_member: 409, invitation_pending: 409, invitation_not_pending: 409, invitation_expired: 409, owner_cannot_leave: 409, cannot_remove_owner: 409, circle_not_dedicated: 409, circle_space_missing: 409,
  invitee_not_enrolled: 409, data_tenant_not_member: 409,
  reader_unavailable: 503
};

interface FamilyRouteHelpers {
  str(key: string): string;
  optStr(key: string): string | undefined;
  optNum(key: string): number | undefined;
  /** Valgfri boolsk; feil type er `invalid_input`. */
  optBool(key: string): boolean | undefined;
  /** Rå verdi (tjenesten validerer typen og avviser alt annet enn en boolsk). */
  raw(key: string): unknown;
}
export interface FamilyRoute {
  keys: readonly string[];
  /** `always`: signert økt kreves alltid. `never`: kun verifisert identitet. `on_behalf_of`: signert økt kreves når `on_behalf_of` er satt. */
  stepUp: "always" | "never" | "on_behalf_of";
  /** Kun den suverene eieren (konfigurasjonens person-id). */
  ownerOnly?: true;
  run(family: PersonalFamilyDeps, actor: FamilyActor, h: FamilyRouteHelpers): Promise<Record<string, unknown>>;
}

/** Ubetrodd, menneske-skrevet tekst (listetekst, tittel) leveres alltid merket - en konsument skal aldri behandle den som instruks (regel 7). */
const UNTRUSTED = { content_trust: "untrusted_user_content" } as const;

export const FAMILY_ROUTES: Readonly<Record<string, FamilyRoute>> = {
  "/personal/family/bootstrap": { keys: ["data_tenant_id"], stepUp: "always", ownerOnly: true, run: async (f, a, h) => ({ member: await f.service.bootstrapOwner(a, f.ownerPersonId, optional("data_tenant_id", h.optStr("data_tenant_id"))) }) },
  "/personal/family/topology": { keys: [], stepUp: "never", ownerOnly: true, run: async (f, a) => ({ topology: await f.service.topology(a) }) },
  "/personal/family/circle": { keys: [], stepUp: "never", run: async (f, a) => ({ circle: await f.service.getCircle(a) }) },
  "/personal/family/invite": {
    keys: ["invitee_person_id", "role", "ttl_hours"], stepUp: "always",
    run: async (f, a, h) => ({ invitation: await f.service.invite(a, { invitee_person_id: h.str("invitee_person_id"), role: h.str("role") as InvitableRole, ...optional("ttl_hours", h.optNum("ttl_hours")) }) })
  },
  "/personal/family/invitations": { keys: [], stepUp: "never", run: async (f, a) => ({ invitations: await f.service.listInvitations(a) }) },
  "/personal/family/invitation/revoke": { keys: ["invitation_id"], stepUp: "always", run: async (f, a, h) => ({ invitation: await f.service.revokeInvitation(a, h.str("invitation_id")) }) },
  "/personal/family/invitation/accept": {
    keys: ["invitation_id", "data_tenant_id"], stepUp: "always", run: async (f, a, h) => ({ member: await f.service.acceptInvitation(a, h.str("invitation_id"), optional("data_tenant_id", h.optStr("data_tenant_id"))) })
  },
  "/personal/family/invitation/decline": { keys: ["invitation_id"], stepUp: "always", run: async (f, a, h) => ({ invitation: await f.service.declineInvitation(a, h.str("invitation_id")) }) },
  // (`person_id`/`delegation_id` er forbudte identitetsnøkler i `authedRequest`; målets person får derfor et eget navn.)
  "/personal/family/member/remove": { keys: ["member_person_id"], stepUp: "always", run: async (f, a, h) => (await f.service.removeMember(a, h.str("member_person_id")), { removed: true }) },
  "/personal/family/leave": { keys: [], stepUp: "always", run: async (f, a) => (await f.service.leave(a), { left: true }) },
  "/personal/family/data-tenant": { keys: ["data_tenant_id"], stepUp: "always", run: async (f, a, h) => ({ member: await f.service.setDataTenant(a, h.str("data_tenant_id")) }) },
  "/personal/family/share/grant": {
    keys: ["viewer_person_id", "category", "ttl_days"], stepUp: "always",
    run: async (f, a, h) => ({ share: await f.service.grantShare(a, { viewer_person_id: h.str("viewer_person_id"), category: h.str("category") as FamilyShareCategory, ...optional("ttl_days", h.optNum("ttl_days")) }) })
  },
  "/personal/family/share/revoke": { keys: ["share_id"], stepUp: "always", run: async (f, a, h) => ({ share: await f.service.revokeShare(a, h.str("share_id")) }) },
  "/personal/family/shares": { keys: [], stepUp: "never", run: async (f, a) => ({ shares: await f.service.listShares(a) }) },
  "/personal/family/shared/read": {
    keys: ["subject_person_id", "category"], stepUp: "always",
    run: async (f, a, h) => ({ view: await f.service.readShared(a, h.str("subject_person_id"), h.str("category") as FamilyShareCategory), output_trust: "derived_personal_data" })
  },
  "/personal/family/delegation/grant": {
    keys: ["agent_person_id", "scope", "ttl_days"], stepUp: "always",
    run: async (f, a, h) => ({ delegation: await f.service.grantDelegation(a, { agent_person_id: h.str("agent_person_id"), scope: h.str("scope") as FamilyDelegationScope, ...optional("ttl_days", h.optNum("ttl_days")) }) })
  },
  "/personal/family/delegation/revoke": { keys: ["family_delegation_id"], stepUp: "always", run: async (f, a, h) => ({ delegation: await f.service.revokeDelegation(a, h.str("family_delegation_id")) }) },
  "/personal/family/delegations": { keys: [], stepUp: "never", run: async (f, a) => ({ delegations: await f.service.listDelegations(a) }) },
  "/personal/family/list/create": {
    keys: ["name", "on_behalf_of"], stepUp: "on_behalf_of", run: async (f, a, h) => ({ list: await f.service.createList(a, { name: h.str("name"), ...optional("on_behalf_of", h.optStr("on_behalf_of")) }), ...UNTRUSTED })
  },
  "/personal/family/lists": { keys: [], stepUp: "never", run: async (f, a) => ({ lists: await f.service.listLists(a), ...UNTRUSTED }) },
  "/personal/family/list/items": { keys: ["list_id"], stepUp: "never", run: async (f, a, h) => ({ items: await f.service.listItems(a, h.str("list_id")), ...UNTRUSTED }) },
  "/personal/family/list/item/add": {
    keys: ["list_id", "body", "on_behalf_of"], stepUp: "on_behalf_of",
    run: async (f, a, h) => ({ item: await f.service.addListItem(a, h.str("list_id"), { body: h.str("body"), ...optional("on_behalf_of", h.optStr("on_behalf_of")) }), ...UNTRUSTED })
  },
  "/personal/family/list/item/done": { keys: ["item_id", "done"], stepUp: "never", run: async (f, a, h) => ({ item: await f.service.setItemDone(a, h.str("item_id"), h.raw("done") as boolean), ...UNTRUSTED }) },
  "/personal/family/event/create": {
    keys: ["title", "starts_at", "ends_at", "all_day", "on_behalf_of"], stepUp: "on_behalf_of",
    run: async (f, a, h) => ({
      event: await f.service.createEvent(a, { title: h.str("title"), starts_at: h.str("starts_at"), ends_at: h.str("ends_at"), ...optional("all_day", h.optBool("all_day")), ...optional("on_behalf_of", h.optStr("on_behalf_of")) }), ...UNTRUSTED
    })
  },
  "/personal/family/events": { keys: ["from", "to"], stepUp: "never", run: async (f, a, h) => ({ events: await f.service.listEvents(a, { from: h.str("from"), to: h.str("to") }), ...UNTRUSTED }) },
  "/personal/family/event/cancel": { keys: ["event_id"], stepUp: "always", run: async (f, a, h) => ({ event: await f.service.cancelEvent(a, h.str("event_id")), ...UNTRUSTED }) }
};

/** `{ [key]: value }` kun når verdien er satt (exactOptionalPropertyTypes: aldri `key: undefined`). Brukes både som objekt-spredning og, for ett enkelt valgfritt argument, som `{ key: value }`-objekt. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function pickActor(identity: IdentityContext): FamilyActor {
  const { tenant_id, person_id, memory_space_id, session_id, device_id, channel, auth_strength } = identity;
  return { tenant_id, person_id, memory_space_id, session_id, device_id, channel, auth_strength };
}

async function handleFamilyRoute(ctx: PersonalRouteContext, family: PersonalFamilyDeps): Promise<boolean> {
  const route = FAMILY_ROUTES[ctx.url.pathname];
  if (route === undefined) return false;
  const authed = await ctx.authed(route.keys);
  if (!authed) return true;
  const { identity, body } = authed;
  if (route.ownerOnly && identity.person_id !== family.ownerPersonId) return ctx.json(403, { error: "family_rejected", reason: "owner_required", request_id: ctx.requestId() }), true;
  const needsSignedSession = route.stepUp === "always" || (route.stepUp === "on_behalf_of" && body["on_behalf_of"] !== undefined);
  if (needsSignedSession) {
    const stepUp = ctx.stepUpDenial(identity, `personal_family_${ctx.url.pathname.slice("/personal/family/".length).replaceAll("/", "_")}`);
    if (stepUp) return ctx.json(403, { error: "step_up_required", reason: stepUp, request_id: ctx.requestId() }), true;
  }
  const helpers: FamilyRouteHelpers = {
    str: (key) => ctx.fieldString(body, key),
    optStr: (key) => ctx.fieldOptionalString(body, key),
    optNum: (key) => ctx.fieldOptionalNumber(body, key),
    optBool: (key) => {
      const value = body[key];
      if (value === undefined) return undefined;
      if (typeof value !== "boolean") throw new FamilyError("invalid_input", key);
      return value;
    },
    raw: (key) => body[key]
  };
  try {
    ctx.json(200, await route.run(family, pickActor(identity), helpers));
  } catch (err) {
    if (err instanceof FamilyError) ctx.json(FAMILY_STATUS[err.code], { error: "family_rejected", reason: err.code, request_id: ctx.requestId() });
    else ctx.domainFailure(500, "family_failed", err);
  }
  return true;
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
      // `personal_action_target_busy` = en annen handling mot SAMME mål kjører (advisory-lås): 409, forsøk igjen når den er ferdig.
      if (/^personal_action_[a-z_]+(?::|$)/.test(reason)) ctx.json(reason === "personal_action_target_busy" ? 409 : 400, { error: "personal_action_rejected", reason: reason.slice(0, 80), request_id: ctx.requestId() });
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
