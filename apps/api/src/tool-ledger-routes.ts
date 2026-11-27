import type { IncomingMessage } from "node:http";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { listLedgerQueue, resolveLedgerEntry, type ResolveLedgerFailure, type ResolveLedgerInput, type ToolGateway } from "@jarvis/tool-gateway";

/**
 * WP-T1 K5 (JARVIS-103, Q-63 pkt 7): `/tool-ledger/` - eierens kø over verktøy-ledger-rader som venter på en avgjørelse (utført men ikke bekreftet, eller utfall ukjent) og eierens avgjørelse etter en MANUELL sjekk hos leverandøren.
 * DORMANT: uten `deps.toolLedger` (satt av main.ts KUN når `JARVIS_TOOL_LEDGER_RECONCILE=on`) finnes ingen av rutene (404, identisk med main). Ingen av dem er et modellverktøy: avgjørelsen er en registrering i Jarvis' egen ledger
 * og kaller aldri en leverandør, en transport eller `ToolGateway.execute()` (se `modules/tool-gateway/src/ledger-reconcile.ts`).
 *
 * Begge rutene er `POST` med JSON-kropp og `grant_token` (som resten av kontrollrutene): identitet, tenant og person kommer UTELUKKENDE fra det verifiserte grantet - kroppen kan aldri bære dem (`authed` avviser identitetsfelt og
 * ukjente felt FØR grantet løses). Begge krever den suverene eieren (`deps.ownerGate`, fail-closed). `resolve` er KLASSE-BEVISST: step-up (enhetssignert økt fra en eier-kanal) kreves for klasse C/D og for et verktøy som ikke er
 * registrert i prosessen (fail-closed, som D); klasse A/B holder med eierporten. Eierens uttrykkelige bekreftelse (`provider_checked: true`) kreves alltid. Svarene bærer faste koder, aldri leverandørtekst.
 */
export interface ToolLedgerApiDeps {
  pool: pg.Pool;
  /** Registeret (kun oppslag): handlingens klasse og recovery-prosedyre for køen og step-up-kravet. */
  gateway: Pick<ToolGateway, "get">;
}

/**
 * Det rutefunksjonen får: avhengighetene over pluss eier-porten. Porten er `deps.ownerGate` i `server.ts` (DEN ENE eier-porten: `main.ts` bygger den én gang fra `ownerPredicate(ownerAuthority)`, låst av `e1-review-m3-owner-gate`);
 * serveren gir den videre her, så ledger-rutene aldri har en egen eier-sammenligning. Mangler den, nektes alle (`requireOwner` er fail-closed).
 */
export interface ToolLedgerRouteDeps extends ToolLedgerApiDeps {
  ownerGate: ((identity: IdentityContext) => boolean) | undefined;
}

export interface ToolLedgerRouteHelpers {
  /** Kropp -> forbudte identitetsfelt -> hvitelistede felt -> grant -> enhets-rate-limit (server.ts `authedRequest`). Sender selv svar og gir `null` ved avslag. */
  authed(allowedKeys: readonly string[], maxBytes?: number): Promise<{ identity: IdentityContext; body: Record<string, unknown> } | null>;
  /** Eier-porten; sender selv `403 owner_required` og gir `false` ved avslag. */
  requireOwner(identity: IdentityContext, subject: { tool_id: string; action: string }): Promise<boolean>;
  json(status: number, body: unknown): void;
  requestId(): string;
}

interface RouteSpec {
  action: string;
  keys: readonly string[];
}

const ROUTES: Readonly<Record<string, RouteSpec>> = {
  "/tool-ledger/queue": { action: "ledger_queue", keys: ["limit"] },
  "/tool-ledger/resolve": { action: "ledger_resolve", keys: ["idempotency_key", "resolution", "provider_checked", "note"] }
};

/** Stabile HTTP-statuser per feilkode fra avgjørelsen. `step_up_required:...` er alltid 403; en ukjent kode er 400. */
const RESOLVE_STATUS: Readonly<Record<string, number>> = {
  owner_required: 403,
  invalid_idempotency_key: 400,
  invalid_resolution: 400,
  provider_check_not_confirmed: 400,
  not_found: 404,
  not_resolvable: 409,
  resolve_too_early: 409,
  concurrent_change: 409
};

const MAX_NOTE_CHARS = 2_000;

/** Returnerer `true` når ruten er håndtert (svar sendt), `false` når stien/metoden ikke er en ledger-rute (serveren faller da til sin vanlige 404). */
export async function handleToolLedgerRoute(req: IncomingMessage, pathname: string, deps: ToolLedgerRouteDeps, h: ToolLedgerRouteHelpers): Promise<boolean> {
  const spec = Object.prototype.hasOwnProperty.call(ROUTES, pathname) ? ROUTES[pathname] : undefined;
  if (spec === undefined || req.method !== "POST") return false;
  const authed = await h.authed(spec.keys);
  if (authed === null) return true;
  const { identity, body } = authed;
  const requestId = h.requestId();
  if (!(await h.requireOwner(identity, { tool_id: "tool_ledger", action: spec.action }))) return true;
  const bad = (reason: string): true => {
    h.json(400, { error: "malformed_request", reason, request_id: requestId });
    return true;
  };

  if (pathname === "/tool-ledger/queue") {
    const limit = body["limit"];
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)) return bad("limit");
    const queue = await listLedgerQueue(deps.pool, identity.tenant_id, deps.gateway, limit === undefined ? {} : { limit: limit as number });
    h.json(200, { ok: true, data: queue });
    return true;
  }

  // /tool-ledger/resolve
  const key = body["idempotency_key"];
  const resolution = body["resolution"];
  const checked = body["provider_checked"];
  const note = body["note"];
  if (typeof key !== "string") return bad("idempotency_key");
  if (typeof resolution !== "string") return bad("resolution");
  if (typeof checked !== "boolean") return bad("provider_checked");
  if (note !== undefined && (typeof note !== "string" || note.length > MAX_NOTE_CHARS)) return bad("note");
  const input: ResolveLedgerInput = { idempotency_key: key, resolution: resolution as ResolveLedgerInput["resolution"], provider_checked: checked, ...(note !== undefined ? { note } : {}) };
  const result = await resolveLedgerEntry({ pool: deps.pool, gateway: deps.gateway, ownerGate: deps.ownerGate }, identity, input);
  if (result.ok) {
    h.json(200, {
      ok: true,
      data: {
        idempotency_key: result.idempotency_key, tool_id: result.tool_id, action: result.action, from_status: result.from_status, to_status: result.to_status,
        resolution: result.resolution, capability_class: result.capability_class
      }
    });
    return true;
  }
  const reason: ResolveLedgerFailure = result.reason;
  if (reason.startsWith("step_up_required:")) {
    h.json(403, { error: "step_up_required", reason, request_id: requestId });
    return true;
  }
  const status = RESOLVE_STATUS[reason] ?? 400;
  if (status === 400) return bad(reason);
  h.json(status, { error: reason === "owner_required" ? "owner_required" : reason === "not_found" ? "ledger_entry_not_found" : `ledger_${reason}`, ...(result.status !== undefined ? { ledger_status: result.status } : {}), request_id: requestId });
  return true;
}
