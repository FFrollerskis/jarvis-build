import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";

/**
 * D-339: bro INN i `apps/browser-gateway` sin egen prosess (SAMME "egen
 * prosess, snakkes med via vanlig HTTP fetch()"-mønster som voice-gateway
 * sin `HttpCoreClient`, D-212 - her motsatt retning). `credential_ref`
 * (`JARVIS_BROWSER_GATEWAY_BASE_URL`) er selve BASE-URL-en til prosessen -
 * INGEN ekte ekstern hemmelighet finnes (Jarvis sin egen sideprosess, ikke
 * en tredjeparts-API), SAMME "credential_ref peker på en konfig-verdi, ikke
 * nødvendigvis et hemmelig token"-mønster som Docker sin
 * `JARVIS_DOCKER_BIN`.
 *
 * KUN de tre read-only handlingene finnes (`navigate`/`extract_text`/
 * `screenshot`) - `click`/`fill_form`/`submit` er BEVISST IKKE bygget denne
 * sliceen, se `browser-engine.ts` sitt filhode for full begrunnelse.
 */
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(["navigate", "extract_text", "screenshot"]);

export class BrowserGatewayTransport implements ToolTransport {
  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    if (!credential) {
      throw new Error("browser_gateway_base_url_not_configured");
    }
    if (!KNOWN_ACTIONS.has(action)) {
      throw new Error(`browser_gateway_action_not_implemented:${action}`);
    }
    const response = await fetch(`${credential}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, parameters })
    });
    const body = (await response.json().catch(() => ({}))) as { data?: JsonValue; error?: string };
    if (!response.ok) {
      throw new Error(`browser_gateway_error_${response.status}:${body.error ?? "unknown"}`);
    }
    return { data: body.data ?? null };
  }
}
