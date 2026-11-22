import type { IdentityContext } from "@jarvis/contracts";
import { DavError, type AppleDavClient, type DavErrorCode, type DavSendGuard } from "@jarvis/tool-gateway";
import type { PersonalRouteContext } from "./personal-routes.ts";

/**
 * WP-G2 (D-464, UA-8 Personal Twin) P2e: ruter for Apple Kalender/Påminnelser/Kontakter via CalDAV/CardDAV (`AppleDavClient`, `modules/tool-gateway/src/personal/apple-dav.ts`). DORMANT: finnes KUN med `JARVIS_PERSONAL_APPLE_DAV=on`.
 * Live mot iCloud er `BLOCKED_EXTERNAL` (eieren lager det app-spesifikke passordet, D-108); alt er bevist mot en falsk server. Reglene:
 *  - EIER-KUN for alt (kalender, påminnelser og kontakter er eierens private data); identitet fra grantet, aldri kroppen. Lesing krever ikke step-up; HVER mutasjon krever enhetssignert økt (step-up).
 *  - ruter, ikke verktøy: samtalen/modellene kan ikke endre eierens Apple-data (`DEFERRED`: et samtaleverktøy bak en risikoklasse når eieren har besluttet det). Innhold fra iCloud er ubetrodd data og leveres merket.
 *  - sletting krever en typet bekreftelse (`confirm_uid` = uid, regel 8: ingen destruktive handlinger uten eksplisitt bekreftelse).
 *  - en hendelse/oppgave MED deltakere kan sende e-post til andre ved endring/sletting (iTIP, uverifisert mot iCloud): `allow_attendee_notification: true` kreves, ellers 409 `attendees_confirmation_required` og ingenting sendes.
 *  - REVISJON FØR mutasjon: en `requested`-rad skrives FØR noe sendes (feiler revisjonen, gjøres ingenting), og utfallet revideres etterpå (best effort). Revisjonen har samling, slag, UID og utfall - aldri innhold.
 *  - STOPP: et forsøk som stoppkontrollene stopper (kill switch, tilbakekalt credential, vakt utilgjengelig) gir NØYAKTIG ÉN DENY-rad (`tool.denied`: handling, samling og årsak - aldri innhold), også for lesing og uansett om stoppen oppdages før klienten
 *    eller midt i en operasjon (da kommer DENY-raden i stedet for `rejected:`-raden). Samme sporbarhet som Policy Gateway gir et avslått verktøykall, så eieren ser forsøket i sikkerhetssenteret. Raden er best effort: stoppen står uansett.
 *  - utfallet er alltid `SUCCESS` | `REPLAYED` | `MISMATCH` | `UNKNOWN` fra readback (aldri «ok» uten bevis); `UNKNOWN` skal føre til en lesing (`get`), aldri en ny blind kommando.
 */
export interface DavAuditEntry {
  action: string; collection: string; uid?: string; outcome: string;
  /** `DENY` = forsøket ble STOPPET av stoppkontrollene (se `StopReason`); utelatt = `ALLOW` (mutasjonssporet). */
  decision?: "ALLOW" | "DENY";
  /** Kun med `DENY`: hvorfor det ble stoppet. */
  reason?: StopReason;
}
export interface PersonalDavDeps {
  client: Pick<AppleDavClient, "listCollections" | "list" | "get" | "create" | "update" | "remove">;
  audit(identity: IdentityContext, entry: DavAuditEntry): Promise<void>;
  /**
   * Stoppvakten (kill switch + tilbakekalte credentials; fiks-runde review B MEDIUM-1): sjekkes her FØR klienten (ingen forsøk mens eieren har stanset systemet), OG av transporten FØR hver utsendelse (en operasjon sender flere forespørsler).
   * DAV-rutene går utenom ToolGateway, som ellers er det som hører kill switch og revokering. PÅKREVD (fiks-runde 2, delta-review B NY-4): en wiring som glemte den ville latt eieren miste stoppen uten at noe feilet; en kaller uten typesjekk
   * (cast/JS) uten vakt får `dav_guard_unavailable` (fail closed).
   */
  guard: DavSendGuard;
}

/** Hvorfor stoppkontrollene stopper et forsøk. `dav_guard_unavailable` = vakten selv feilet (fail closed). */
export type StopReason = "kill_switch_active" | "credential_revoked" | "dav_guard_unavailable";
/** Transportens stoppkoder (midt i en operasjon, mellom to forespørsler) -> samme årsaker som ruten sjekker før klienten. */
const STOP_CODE_REASON: Readonly<Partial<Record<DavErrorCode, StopReason>>> = { dav_kill_switch_active: "kill_switch_active", dav_credential_revoked: "credential_revoked", dav_guard_unavailable: "dav_guard_unavailable" };

export const DAV_ERROR_STATUS: Readonly<Record<DavErrorCode, number>> = {
  invalid_input: 400, invalid_text: 400, invalid_uid: 400, invalid_etag: 400,
  collection_not_allowed: 403, url_not_allowed: 403,
  not_found: 404,
  etag_mismatch: 409, unsupported_change: 409, attendees_confirmation_required: 409,
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

/**
 * `allow_attendee_notification` (kun update/delete): eierens eksplisitte bekreftelse på at endring/sletting av en hendelse/oppgave MED deltakere er ønsket selv om serveren kan sende e-post til dem (iTIP, uverifisert mot iCloud,
 * kan ikke trekkes tilbake). Utelatt = `false`; en ikke-boolsk verdi avvises (aldri «truthy»).
 */
const allowAttendees = (b: Body): { allowAttendeeNotification: boolean } => {
  const v = b["allow_attendee_notification"];
  if (v !== undefined && typeof v !== "boolean") throw new DavError("invalid_input", "allow_attendee_notification");
  return { allowAttendeeNotification: v === true };
};

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
    keys: ["collection", "uid", "expected_etag", "fields", "allow_attendee_notification"], mutation: true,
    run: async (d, _i, b, h) => ({ result: await d.client.update(h.str("collection"), h.str("uid"), h.str("expected_etag"), h.rec("fields"), allowAttendees(b)), ...UNTRUSTED })
  },
  "/personal/dav/delete": {
    keys: ["collection", "uid", "expected_etag", "confirm_uid", "allow_attendee_notification"], mutation: true,
    run: async (d, _i, b, h) => {
      if (h.str("confirm_uid") !== h.str("uid")) throw new DavError("invalid_input", "confirm_uid_must_equal_uid");
      return { result: await d.client.remove(h.str("collection"), h.str("uid"), h.str("expected_etag"), allowAttendees(b)), ...UNTRUSTED };
    }
  }
};

const uidOf = (b: Body): string | undefined => (typeof b["uid"] === "string" ? (b["uid"] as string).slice(0, 120) : undefined);

/** Hvorfor stoppkontrollene stopper (`null` = fortsett). En vakt som kaster (eller mangler, for en kaller uten typesjekk) er fail-closed `dav_guard_unavailable` - aldri «fortsett». */
async function stopReason(guard: DavSendGuard): Promise<StopReason | null> {
  try { return await guard(); } catch { return "dav_guard_unavailable"; }
}

/** ÉN DENY-rad uten innhold (handling, samling og årsak). Best effort: stoppen står uansett om raden ikke lar seg skrive (verken en avvist eller en synkront kastet revisjon slipper ut). */
async function auditDenied(deps: PersonalDavDeps, identity: IdentityContext, action: string, collection: string, reason: StopReason): Promise<void> {
  try { await deps.audit(identity, { action, collection, outcome: "blocked", decision: "DENY", reason }); } catch { return; }
}

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
  // Stoppvakten: kill switch / tilbakekalt credential = ingen klient og ingen `requested`-rad, men ÉN DENY-rad (samme sporbarhet som gatewayen gir et avslag). `collections` er lokal og sender ingenting.
  if (action !== "collections") {
    const blocked = await stopReason(deps.guard);
    if (blocked !== null) {
      await auditDenied(deps, identity, action, collection, blocked);
      return ctx.json(503, { error: "dav_blocked", reason: blocked, request_id: ctx.requestId() }), true;
    }
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
      const stopped = STOP_CODE_REASON[err.code];
      // Stoppet midt i operasjonen av transportens vakt: ÉN DENY-rad (også for lesing) i stedet for `rejected:`; alle andre avvisninger revideres kun for mutasjoner, som før.
      if (stopped !== undefined) await auditDenied(deps, identity, action, collection, stopped);
      else if (route.mutation) await deps.audit(identity, { action, collection, ...optional("uid", uidOf(body)), outcome: `rejected:${err.code}` }).catch(() => undefined);
      ctx.json(DAV_ERROR_STATUS[err.code], { error: "dav_rejected", reason: err.code, request_id: ctx.requestId() });
    } else ctx.domainFailure(500, "dav_failed", new Error(err instanceof Error ? err.name : "unknown")); // aldri feilteksten: den kan inneholde URL-er/hodeverdier
  }
  return true;
}
