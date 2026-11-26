import { createHash } from "node:crypto";
import { RequestDigestError, requestDigest, type JsonValue } from "@jarvis/contracts";

/**
 * WP-T1 K3/K4 (JARVIS-102, Q-65 pkt 1): modusen og hjelperne for ledgerens forespørselsavtrykk (`tool_executions.request_digest`) og nøkkelkravet per handling (`ToolDefinition.idempotency`).
 *
 * MODUS (`JARVIS_TOOL_REQUEST_DIGEST`, standard `off`):
 *  - `off`      = AKKURAT som før WP-T1: ingen digest beregnes, ingen ny kolonne leses eller skrives, ingen ekstra spørring, ingen revisjonsrad, nøkkelkravet er ikke i bruk.
 *  - `observe`  = digest beregnes og lagres på nye rader; en nøkkel som gjenbrukes med ANNEN digest (eller et manglende nøkkelkrav) kjører som før, men gir en revisjonsrad («ville avvist»). Brukes til å se
 *                 hvilke kallere som ville blitt avvist FØR `enforce`.
 *  - `enforce`  = en gjenbrukt nøkkel med ulik digest avvises (`idempotency_key_reuse_mismatch`), en handling merket `idempotency: "required"` uten nøkkel avvises (`idempotency_key_required`), og en
 *                 forespørsel som ikke kan få en digest (ikke ren JSON) avvises (`request_digest_invalid:<kode>`). Ingenting utføres.
 * Verdien leses ved HVERT kall (som `JARVIS_TOOL_CALL_ABORT`): kun eksakt `observe`/`enforce` (store/små bokstaver og omkringliggende mellomrom ignoreres) slår på; alt annet er `off`. En feilskrevet verdi i drift
 * fanges ved oppstart av `assertRequestDigestModeValid` (api og worker feiler lukket i stedet for å kjøre med en modus eieren ikke trodde).
 */
export type RequestDigestMode = "off" | "observe" | "enforce";

export const REQUEST_DIGEST_MODES: readonly RequestDigestMode[] = ["off", "observe", "enforce"];

/** Modusen for denne prosessen (ukjent/tom verdi = `off`). */
export function requestDigestMode(env: Record<string, string | undefined> = process.env): RequestDigestMode {
  const raw = (env["JARVIS_TOOL_REQUEST_DIGEST"] ?? "").trim().toLowerCase();
  return raw === "observe" || raw === "enforce" ? raw : "off";
}

/** Oppstartsvakt: en satt, men ukjent verdi (typo som `enforced`) er en konfigurasjonsfeil, ikke «off». Tom/usatt er `off`. */
export function assertRequestDigestModeValid(env: Record<string, string | undefined> = process.env): void {
  const raw = (env["JARVIS_TOOL_REQUEST_DIGEST"] ?? "").trim().toLowerCase();
  if (raw !== "" && !(REQUEST_DIGEST_MODES as readonly string[]).includes(raw)) {
    throw new Error(`jarvis_tool_request_digest_invalid:${raw.slice(0, 20)} (forventet off, observe eller enforce)`);
  }
}

/** Stabile årsakskoder (revisjonsrad og avslag). `idempotency_key_reuse_mismatch` og `idempotency_key_required` er de samme kodene connector-SDK-ets kontraktkitt bruker. */
export const IDEMPOTENCY_KEY_REUSE_MISMATCH = "idempotency_key_reuse_mismatch";
export const IDEMPOTENCY_KEY_REQUIRED = "idempotency_key_required";
export const REQUEST_DIGEST_INVALID_PREFIX = "request_digest_invalid";

export type DigestOutcome = { ok: true; digest: string } | { ok: false; code: string };

/**
 * Beregner forespørselens avtrykk. Aldri kast: en feil blir en kode (`RequestDigestError.code`, ellers `internal`) som kalleren omsetter til avslag (`enforce`) eller en observasjon (`observe`).
 * Parametrene er DE SAMME som transporten får (`request.parameters`), og aktøren/tenanten kommer fra den autentiserte identiteten - aldri fra parametrene.
 */
export function digestForRequest(input: {
  tool_id: string; action: string; parameters: Record<string, JsonValue>; tenant_id: string; person_id: string; exclude_parameters?: readonly string[] | undefined;
}): DigestOutcome {
  try {
    return {
      ok: true,
      digest: requestDigest({
        tool_id: input.tool_id, action: input.action, parameters: input.parameters, tenant_id: input.tenant_id, person_id: input.person_id,
        ...(input.exclude_parameters !== undefined ? { exclude_parameters: input.exclude_parameters } : {})
      })
    };
  } catch (err) {
    return { ok: false, code: err instanceof RequestDigestError ? err.code : "internal" };
  }
}

/** Kort merke (16 hex av SHA-256) av en nøkkel eller digest til revisjonsraden: nok til å koble rader, og lekker aldri selve nøkkelen (en nøkkel kan inneholde ticket-/hendelses-id-er). */
export function shortFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

export type ReuseVerdict = "match" | "mismatch" | "legacy";

/**
 * Dommen over en gjenbrukt nøkkel: lagret rad mot den innkommende forespørselen. Ren funksjon.
 *  - lagret digest finnes: lik = `match`, ulik = `mismatch`.
 *  - lagret digest er NULL (rad fra før K2, eller skrevet mens modusen var `off`): kan ikke sammenlignes på nyttelast. Er VERKTØY eller HANDLING en annen, er det SIKKERT en annen forespørsel (`mismatch`);
 *    ellers `legacy` (kjører som før, men loggføres).
 */
export function judgeKeyReuse(
  stored: { tool_id: string; action: string; request_digest: string | null },
  incoming: { tool_id: string; action: string; digest: string }
): ReuseVerdict {
  if (stored.request_digest === null) return stored.tool_id === incoming.tool_id && stored.action === incoming.action ? "legacy" : "mismatch";
  return stored.request_digest === incoming.digest ? "match" : "mismatch";
}
