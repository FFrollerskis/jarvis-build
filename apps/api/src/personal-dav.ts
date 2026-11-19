import type { IdentityContext } from "@jarvis/contracts";
import { DavError, type AppleDavClient, type DavErrorCode, type DavSendGuard } from "@jarvis/tool-gateway";
import type { PersonalRouteContext } from "./personal-routes.ts";

/**
 * WP-G2 (D-464, UA-8 Personal Twin) P2e: ruter for Apple Kalender/Påminnelser/Kontakter via CalDAV/CardDAV (`AppleDavClient`, `modules/tool-gateway/src/personal/apple-dav.ts`). DORMANT: finnes KUN med `JARVIS_PERSONAL_APPLE_DAV=on`.
 * Live mot iCloud er `BLOCKED_EXTERNAL` (eieren lager det app-spesifikke passordet, D-108); alt er bevist mot en falsk server. Reglene:
 *  - EIER-KUN for alt (kalender, påminnelser og kontakter er eierens private data); identitet fra grantet, aldri kroppen. Lesing krever ikke step-up; HVER mutasjon krever enhetssignert økt (step-up).
 *  - ruter, ikke verktøy: samtalen/modellene kan ikke endre eierens Apple-data (`DEFERRED`: et samtaleverktøy bak en risikoklasse når eieren har besluttet det). Innhold fra iCloud er ubetrodd data og leveres merket.
 *  - sletting krever en typet bekreftelse (`confirm_uid` = uid, regel 8: ingen destruktive handlinger uten eksplisitt bekreftelse).
 *  - REVISJON FØR mutasjon: en `requested`-rad skrives FØR noe sendes (feiler revisjonen, gjøres ingenting), og utfallet revideres etterpå (best effort). Revisjonen har samling, slag, UID og utfall - aldri innhold.
 *  - utfallet er alltid `SUCCESS` | `REPLAYED` | `MISMATCH` | `UNKNOWN` fra readback (aldri «ok» uten bevis); `UNKNOWN` skal føre til en lesing (`get`), aldri en ny blind kommando.
 */
export interface DavAuditEntry { action: string; collection: string; uid?: string; outcome: string }
export interface PersonalDavDeps {
  client: Pick<AppleDavClient, "listCollections" | "list" | "get" | "create" | "update" | "remove">;
  audit(identity: IdentityContext, entry: DavAuditEntry): Promise<void>;
  /**
   * Stoppvakten (kill switch + tilbakekalte credentials; fiks-runde review B MEDIUM-1): sjekkes her FØR revisjon og klient (ingen forsøk, ingen revisjonsrad mens eieren har stanset systemet), OG av transporten FØR hver utsendelse
   * (en operasjon sender flere forespørsler). DAV-rutene går utenom ToolGateway, som ellers er det som hører kill switch og revokering.
   */
  guard?: DavSendGuard;
}

export const DAV_ERROR_STATUS: Readonly<Record<DavErrorCode, number>> = {
  invalid_input: 400, invalid_text: 400, invalid_uid: 400, invalid_etag: 400,
  collection_not_allowed: 403, url_not_allowed: 403,
  not_found: 404,
  etag_mismatch: 409, unsupported_change: 409,
  dav_credentials_unavailable: 503, dav_kill_switch_active: 503, dav_credential_revoked: 503, dav_guard_unavailable: 503,
  dav_unreachable: 502, dav_redirect_refused: 502, dav_response_too_large: 502, dav_auth_rejected: 502, dav_malformed_response: 502, dav_rejected: 502
};

type Body = Record<string, unknown>;
interface DavRoute {
  keys: readonly string[];
  mutation: boolean;
  run(deps: PersonalDavDeps, identity: IdentityContext, b: Body, h: { str(k: string): string; optStr(k: string): string | undefined; optNum(k: string): number | undefined; rec(k: string): Record<string, unknown> }): Promise<Record<string, unknown>>;
}

const UNTRUSTED = { content_trust: "untrusted_external_content" } as const;
const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

export const DAV_ROUTES: Readonly<Record<string, DavRoute>> = {
  "/personal/dav/collections": { keys: [], mutation: false, run: async (d) => ({ collections: d.client.listCollections() }) },
  "/personal/dav/list": {
    keys: ["collection", "from", "to", "text", "limit"], mutation: false,
    run: async (d, _i, _b, h) => ({ items: await d.client.list(h.str("collection"), { ...optional("from", h.optStr("from")), ...optional("to", h.optStr("to")), ...optional("text", h.optStr("text")), ...optional("limit", h.optNum("limit")) }), ...UNTRUSTED })
  },
  "/personal/dav/get": { keys: ["collection", "uid"], mutation: false, run: async (d, _i, _b, h) => ({ item: await d.client.get(h.str("collection"), h.str("uid")), ...UNTRUSTED }) },
  "/personal/dav/create": {
    keys: ["collection", "idempotency_key", "fields"], mutation: true,
    run: async (d, _i, _b, h) => ({ result: await d.client.create(h.str("collection"), h.str("idempotency_key"), h.rec("fields")), ...UNTRUSTED })
  },
  "/personal/dav/update": {
    keys: ["collection", "uid", "expected_etag", "fields"], mutation: true,
    run: async (d, _i, _b, h) => ({ result: await d.client.update(h.str("collection"), h.str("uid"), h.str("expected_etag"), h.rec("fields")), ...UNTRUSTED })
  },
  "/personal/dav/delete": {
    keys: ["collection", "uid", "expected_etag", "confirm_uid"], mutation: true,
    run: async (d, _i, _b, h) => {
      if (h.str("confirm_uid") !== h.str("uid")) throw new DavError("invalid_input", "confirm_uid_must_equal_uid");
      return { result: await d.client.remove(h.str("collection"), h.str("uid"), h.str("expected_etag")), ...UNTRUSTED };
    }
  }
};

const uidOf = (b: Body): string | undefined => (typeof b["uid"] === "string" ? (b["uid"] as string).slice(0, 120) : undefined);

/** `true` = ruten er håndtert. Rekkefølge: grant -> EIER -> (mutasjon: step-up) -> revisjon `requested` -> utførelse -> revisjon av utfallet. */
export async function handleDavRoute(ctx: PersonalRouteContext, deps: PersonalDavDeps): Promise<boolean> {
  const route = DAV_ROUTES[ctx.url.pathname];
  if (route === undefined) return false;
  const authed = await ctx.authed(route.keys);
  if (!authed) return true;
  const { identity, body } = authed;
  if (!(await ctx.requireOwner(identity, { tool_id: "personal", action: `dav_${ctx.url.pathname.slice("/personal/dav/".length)}` }))) return true;
  if (route.mutation) {
    const stepUp = ctx.stepUpDenial(identity, `personal_dav_${ctx.url.pathname.slice("/personal/dav/".length)}`);
    if (stepUp) return ctx.json(403, { error: "step_up_required", reason: stepUp, request_id: ctx.requestId() }), true;
  }
  const action = ctx.url.pathname.slice("/personal/dav/".length);
  const collection = typeof body["collection"] === "string" ? (body["collection"] as string).slice(0, 40) : "";
  // Stoppvakten: kill switch / tilbakekalt credential = ingen forsøk, ingen revisjonsrad, ingen klient (samme avgrensning som gatewayen ville gitt). `collections` er lokal og sender ingenting.
  if (deps.guard !== undefined && action !== "collections") {
    let denial: Awaited<ReturnType<DavSendGuard>>;
    try { denial = await deps.guard(); } catch { return ctx.json(503, { error: "dav_blocked", reason: "dav_guard_unavailable", request_id: ctx.requestId() }), true; }
    if (denial !== null) return ctx.json(503, { error: "dav_blocked", reason: denial, request_id: ctx.requestId() }), true;
  }
  try {
    const helpers = {
      str: (k: string) => ctx.fieldString(body, k), optStr: (k: string) => ctx.fieldOptionalString(body, k), optNum: (k: string) => ctx.fieldOptionalNumber(body, k), rec: (k: string) => ctx.fieldRecord(body, k)
    };
    if (route.mutation) {
      // Revisjon FØR mutasjonen: feiler den, gjøres ingenting.
      try { await deps.audit(identity, { action, collection, ...optional("uid", uidOf(body)), outcome: "requested" }); }
      catch { return ctx.domainFailure(500, "dav_audit_unavailable", new Error("audit")), true; }
    }
    const out = await route.run(deps, identity, body, helpers);
    if (route.mutation) {
      const result = out["result"] as { outcome?: string; uid?: string } | undefined;
      await deps.audit(identity, { action, collection, ...optional("uid", result?.uid ?? uidOf(body)), outcome: result?.outcome ?? "UNKNOWN" }).catch(() => undefined);
    }
    ctx.json(200, out);
  } catch (err) {
    if (err instanceof DavError) {
      if (route.mutation) await deps.audit(identity, { action, collection, ...optional("uid", uidOf(body)), outcome: `rejected:${err.code}` }).catch(() => undefined);
      ctx.json(DAV_ERROR_STATUS[err.code], { error: "dav_rejected", reason: err.code, request_id: ctx.requestId() });
    } else ctx.domainFailure(500, "dav_failed", new Error(err instanceof Error ? err.name : "unknown")); // aldri feilteksten: den kan inneholde URL-er/hodeverdier
  }
  return true;
}
