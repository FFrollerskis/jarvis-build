import type { IdentityContext } from "@jarvis/contracts";
import { DavError, type AppleDavClient, type DavErrorCode, type DavSendGuard } from "@jarvis/tool-gateway";
import { RateLimiter } from "./http-guard.ts";
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
 *  - GRENSE PER PRINSIPAL (WP-G2c, D-483, JARVIS-113 e/6): i tillegg til den globale grensen per IP og per enhet har DAV en EGEN grense per enhet og per person, og en strengere for mutasjoner (se `createDavRateLimit`): bak ruten står ÉN
 *    iCloud-konto med ETT app-passord, og en enhet/person som flommer kan ellers få kontoen sperret hos Apple. Over grensen: 429 `rate_limited` FØR stoppvakten, revisjon og klient (ingenting sendes, ingen rad skrives: en avvisning per
 *    forsøk ville latt en flom fylle revisjonssporet).
 *  - REVISJONENS `decision` følger utfallet (se `davAuditDecision`): ALLOW kun for `requested`/`SUCCESS`/`REPLAYED`; avvist, uavklart og avvikende readback er ALDRI ALLOW.
 */
export interface DavAuditEntry {
  action: string; collection: string; uid?: string; outcome: string;
  /** `DENY` = forsøket ble STOPPET av stoppkontrollene (se `StopReason`); utelatt = `ALLOW` (mutasjonssporet). */
  decision?: "ALLOW" | "DENY";
  /** Kun med `DENY`: hvorfor det ble stoppet. */
  reason?: StopReason;
}
/**
 * `audit_events.decision` for et DAV-spor (WP-G2c, D-483, JARVIS-113 e/7). Før var den ALLTID `ALLOW` (unntatt stopp = `DENY`), også for en avvist mutasjon (`rejected:*`), et uavklart utfall (`UNKNOWN`) og en readback som ikke samsvarte
 * (`MISMATCH`): sporet påsto at alt gikk bra. Nå betyr `ALLOW` kun «forsøket ble tillatt og (for utfallsraden) bekreftet utført»:
 *   `requested` | `SUCCESS` | `REPLAYED` -> ALLOW · stoppet av stoppkontrollene (`decision: "DENY"`) -> DENY · `rejected:<kode>` -> REJECTED · `MISMATCH` -> MISMATCH · `UNKNOWN` -> UNKNOWN
 * og alt annet (en uventet eller fremtidig utfallsstreng, annen skrivemåte) -> UNKNOWN: aldri ALLOW som standard (fail closed). En eksplisitt `decision: "ALLOW"` fra kalleren kan aldri løfte et utfall som ikke er bekreftet.
 */
export type DavAuditDecision = "ALLOW" | "DENY" | "REJECTED" | "MISMATCH" | "UNKNOWN";
export function davAuditDecision(entry: Pick<DavAuditEntry, "outcome" | "decision">): DavAuditDecision {
  if (entry.decision === "DENY") return "DENY";
  const outcome = typeof entry.outcome === "string" ? entry.outcome : "";
  if (outcome === "requested" || outcome === "SUCCESS" || outcome === "REPLAYED") return "ALLOW";
  if (outcome === "MISMATCH") return "MISMATCH";
  if (outcome.startsWith("rejected:")) return "REJECTED";
  return "UNKNOWN";
}

/**
 * Per-prinsipal-grenser for DAV-rutene (per minutt; faste vinduer som `RateLimiter`). `perDevicePerMinute`: én enhet (tenant + enhet). `perPersonPerMinute`: alle enheter til én person i tenanten (en person med mange enheter kan ikke
 * gange grensen). `mutationsPerPersonPerMinute`: opprett/endre/slett, i tillegg til de to første (en mutasjon kan sende e-post til andre via iTIP og kan ikke trekkes tilbake, så den har en strengere grense). Lesing og mutasjon teller begge i de to første.
 * `collections` er lokal (sender ingenting) og er unntatt.
 */
export interface DavRateLimits { perDevicePerMinute: number; perPersonPerMinute: number; mutationsPerPersonPerMinute: number }
export const DEFAULT_DAV_RATE_LIMITS: Readonly<DavRateLimits> = Object.freeze({ perDevicePerMinute: 30, perPersonPerMinute: 60, mutationsPerPersonPerMinute: 10 });

export type DavRateLimitScope = "device" | "person" | "mutation";
export type DavRateLimitDecision = { ok: true } | { ok: false; scope: DavRateLimitScope; retry_after_seconds: number };
export interface DavRateLimit {
  /** `ok: false` = avvis med 429. En avvisning teller ALDRI mot en grense som ikke var nådd (en flommende enhet tømmer ikke personens budsjett for de andre enhetene). */
  check(identity: Pick<IdentityContext, "tenant_id" | "person_id" | "device_id">, mutation: boolean): DavRateLimitDecision;
}

/** Begrensere per prinsipal. Nøklene er JSON (aldri en tekstsammenslåing): en id med skilletegn kan ikke kollidere med en annen prinsipals nøkkel. Ugyldige grenser (ikke et positivt heltall) faller tilbake til standarden - aldri «ingen grense». */
export function createDavRateLimit(limits: Partial<DavRateLimits> = {}, now: () => number = Date.now): DavRateLimit {
  const pick = (value: number | undefined, fallback: number): number => (typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback);
  const minute = 60_000;
  const device = new RateLimiter(pick(limits.perDevicePerMinute, DEFAULT_DAV_RATE_LIMITS.perDevicePerMinute), minute, now);
  const person = new RateLimiter(pick(limits.perPersonPerMinute, DEFAULT_DAV_RATE_LIMITS.perPersonPerMinute), minute, now);
  const mutation = new RateLimiter(pick(limits.mutationsPerPersonPerMinute, DEFAULT_DAV_RATE_LIMITS.mutationsPerPersonPerMinute), minute, now);
  return {
    check(identity, isMutation) {
      const deviceKey = JSON.stringify([identity.tenant_id, identity.device_id]);
      const personKey = JSON.stringify([identity.tenant_id, identity.person_id]);
      if (!device.take(deviceKey)) return { ok: false, scope: "device", retry_after_seconds: device.retryAfterSeconds(deviceKey) };
      if (!person.take(personKey)) return { ok: false, scope: "person", retry_after_seconds: person.retryAfterSeconds(personKey) };
      if (isMutation && !mutation.take(personKey)) return { ok: false, scope: "mutation", retry_after_seconds: mutation.retryAfterSeconds(personKey) };
      return { ok: true };
    }
  };
}

export interface PersonalDavDeps {
  client: Pick<AppleDavClient, "listCollections" | "list" | "get" | "create" | "update" | "remove">;
  audit(identity: IdentityContext, entry: DavAuditEntry): Promise<void>;
  /**
   * Grense per prinsipal (WP-G2c, JARVIS-113 e/6), sjekket etter eier-kontrollen og FØR step-up, stoppvakt, revisjon og klient. PÅKREVD som vakten: en wiring som glemte den ville latt en enhet flomme iCloud-kontoen uten at noe feilet;
   * en kaller uten typesjekk (cast/JS) uten grense får fail-closed 503 `dav_guard_unavailable` i stedet for ubegrenset trafikk.
   */
  rateLimit: DavRateLimit;
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
  // Grense per prinsipal (JARVIS-113 e/6): `collections` er lokal og unntatt. Ingen revisjonsrad per avvisning (en flom ville fylt sporet); begrenseren som mangler (cast/JS) eller kaster er fail closed.
  if (ctx.url.pathname !== "/personal/dav/collections") {
    let verdict: DavRateLimitDecision | null = null;
    try {
      const checked = deps.rateLimit.check(identity, route.mutation);
      verdict = typeof checked === "object" && checked !== null && typeof checked.ok === "boolean" ? checked : null; // et svar vi ikke forstår er ikke «tillatt»
    } catch { verdict = null; }
    if (verdict === null) {
      await auditDenied(deps, identity, ctx.url.pathname.slice("/personal/dav/".length), typeof body["collection"] === "string" ? (body["collection"] as string).slice(0, 40) : "", "dav_guard_unavailable");
      return ctx.json(503, { error: "dav_blocked", reason: "dav_guard_unavailable", request_id: ctx.requestId() }), true;
    }
    if (!verdict.ok) {
      if (typeof ctx.res.setHeader === "function") ctx.res.setHeader("retry-after", String(verdict.retry_after_seconds));
      return ctx.json(429, { error: "rate_limited", scope: verdict.scope, retry_after_seconds: verdict.retry_after_seconds, request_id: ctx.requestId() }), true;
    }
  }
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
