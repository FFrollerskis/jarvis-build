import type { JsonValue } from "@jarvis/contracts";
import type { ToolInvocationContext, ToolTransport } from "./gateway.ts";
import { abortableSleep, composeSignals, currentCallSignal, throwIfAborted } from "./call-signal.ts";
import { guardedFetch, isRetrySafeStatus, VENDOR_FETCH_TIMEOUT_MS } from "./url-safety.ts";

/**
 * D-338 (Tobias direkte i chat: "ja bygg mcp zapier" - svarer på Q-40 (a) MED
 * ja, en generell MCP-klient-kapabilitet er ønsket). Q-40 (b) - godkjennings-
 * modellen for DYNAMISK OPPDAGEDE, tredjeparts-eide verktøy - var IKKE
 * avgjort i D-338, og bevisst ikke gjettet frem der: et MCP-verktøysett
 * (`tools/list`) kan endre seg NÅR SOM HELST utenfor Jarvis sin kontroll
 * (Zapier legger til/fjerner Zaps/actions fritt), noe INGEN eksisterende
 * `ToolGateway`-mekanisme (statiske `ToolDefinition`-lister, revidert PR for
 * PR) er bygget for å håndtere trygt for LIVE INVOKERING.
 *
 * D-350 (Tobias direkte i chat, 2026-09-30, spurt EKSPLISITT via
 * `AskUserQuestion` fremfor gjettet: "klasse D som standard" valgt av de tre
 * tilbudte alternativene) - løser Q-40 (b): `call_tool` er NÅ bygget, ALLTID
 * klasse D (fast, ALDRI variabel per dynamisk oppdaget verktøynavn - selve
 * poenget er at Jarvis IKKE kan vurdere risikoen til et verktøy den aldri
 * har sett kildekoden/dokumentasjonen til, så den anvender automatisk det
 * strengeste nivået for ALLE av dem, uansett hva verktøyet faktisk gjør).
 * Ingen ny godkjenningsmekanisme oppfunnet - `PolicyGateway`/
 * `ToolGateway.execute()` sin EKSISTERENDE, generiske klasse D-håndtering
 * (preflight/signert godkjenning, keyed på `capability_class` alene) dekker
 * dette automatisk, SAMME presedens som D-310 (Outlook `send_mail`) sin
 * kommentar beskriver. Den smale, eier-konfigurerte unntakslisten (opsjon 2
 * i spørsmålet) ble EKSPLISITT IKKE valgt - bevisst ikke bygget her.
 *
 * `list_tools` (klasse A, read-only, uendret fra D-338): kaller MCP sin
 * `tools/list` JSON-RPC-metode og returnerer den RÅ, ufiltrerte listen
 * tredjeparts-serveren oppgir. `output_trust: "untrusted"` (CLAUDE.md regel
 * 7 - ekstern, dynamisk oppdaget data er ALDRI instruksjoner, ALDRI direkte
 * til autoritativt minne - kun Ingestion Zone-data) - gjelder IDENTISK for
 * `call_tool` sitt returnerte innhold, av samme grunn.
 *
 * API-formen (MCP - Model Context Protocol, JSON-RPC 2.0 over "Streamable
 * HTTP", offisiell spesifikasjon https://modelcontextprotocol.io): klienten
 * POST-er en JSON-RPC-forespørsel med metode `tools/list`/`tools/call` til
 * serverens endepunkt-URL; serveren svarer enten med et rent JSON-RPC-svar
 * (`content-type: application/json`) eller en SSE-strøm
 * (`content-type: text/event-stream`) med ETT eller flere JSON-RPC-svar som
 * hendelser. `tools/call` sin dokumenterte params-form er
 * `{name: <verktøynavn>, arguments: <objekt>}`, og et VELLYKKET JSON-RPC-svar
 * kan likevel representere en FEILET verktøykjøring internt
 * (`result.isError === true`, dokumentert MCP-adferd) - denne skilles
 * eksplisitt fra en ekte suksess og kastes som en egen `McpProtocolError`,
 * ALDRI rapportert som `ok`. Zapier sin MCP-server (`https://mcp.zapier.com/
 * api/mcp/s/<per-bruker-token>/mcp`) krever en PERSONLIG, PER-BRUKER-
 * PROVISJONERT URL - selve URL-en (ikke en separat header-verdi) er derfor
 * hemmelighets-ekvivalent og lagres som `JARVIS_MCP_ZAPIER_SERVER_URL`
 * (aldri logget, aldri ekkoet i feilmeldinger - kun vertsnavnet er trygt å
 * inkludere ved feil).
 *
 * Fortsatt KUN det rene JSON-RPC-svaret (`application/json`) håndteres - en
 * SSE-strøm rapporteres eksplisitt som `mcp_streamable_sse_not_supported`
 * (ÆRLIG DEFERRED, ikke en stille feiltolkning) fremfor å gjette på en
 * SSE-parser uten en denne-økten-bekreftet, ekte Zapier-server-respons å
 * teste mot - uendret fra D-338, gjelder nå BEGGE handlinger.
 */
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

export class McpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpProtocolError";
  }
}


function safeHostFor(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "invalid_url";
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: JsonValue;
  result?: JsonValue;
  error?: { code?: number; message?: string };
}

/** MCP `tools/call` sin dokumenterte suksess-resultatform - `isError` skiller en FEILET verktøykjøring fra en ekte suksess, selv om selve JSON-RPC-kallet lyktes. */
interface McpToolCallResult {
  content?: JsonValue;
  isError?: boolean;
}

function validatedServerUrl(credential: string): void {
  if (!credential) {
    throw new Error("mcp_zapier_server_url_not_configured");
  }
  let serverUrl: URL;
  try {
    serverUrl = new URL(credential);
  } catch {
    throw new Error("mcp_zapier_server_url_invalid");
  }
  if (serverUrl.protocol !== "https:") {
    throw new Error("mcp_zapier_server_url_must_be_https");
  }
}

export class McpZapierTransport implements ToolTransport {
  /** Delt JSON-RPC POST/retry/SSE-deteksjon for BÅDE `tools/list` og `tools/call` - eneste forskjell mellom handlingene er selve `method`/`params` og hva kalleren gjør med `result`. */
  private async callJsonRpc(method: string, params: JsonValue, credential: string, callSignal: AbortSignal | undefined): Promise<JsonValue | undefined> {
    const host = safeHostFor(credential);
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // WP-K (D-471, JARVIS-018): etter et tidsavbrudd sendes ALDRI et nytt forsøk (en `tools/call` kan allerede være utført hos Zapier), og venting mellom forsøk avbrytes.
      throwIfAborted(callSignal);
      const response = await guardedFetch(credential, {
        method: "POST",
        // Eget 45 s-signal (eksplisitt signal velger bort det ambiente) - settes derfor sammen med gatewayens kallsignal her.
        signal: composeSignals(callSignal, AbortSignal.timeout(VENDOR_FETCH_TIMEOUT_MS))!,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });

      if (response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream")) {
          throw new McpProtocolError(`mcp_streamable_sse_not_supported:${host}`);
        }
        const body = (await response.json()) as JsonRpcResponse;
        if (body.error) {
          throw new McpProtocolError(`mcp_jsonrpc_error_${body.error.code ?? "unknown"}:${(body.error.message ?? "").slice(0, 200)}`);
        }
        return body.result;
      }

      // `tools/call` kan utføre en handling i en tredjepart (Zapier): kun 429 (avslag før behandling) gjentas; `tools/list` er ren lesing.
      const retryable = RETRYABLE_HTTP_STATUS.has(response.status) && isRetrySafeStatus(method === "tools/list" ? "GET" : "POST", response.status);
      lastError = new Error(`mcp_zapier_http_error_${response.status}:${host}`);
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await abortableSleep(BASE_BACKOFF_MS * 2 ** (attempt - 1), callSignal);
    }
    throw lastError!;
  }

  async invoke(
    action: string, parameters: Record<string, JsonValue>, credential: string, _context?: ToolInvocationContext, signal?: AbortSignal
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    validatedServerUrl(credential);
    const callSignal = signal ?? currentCallSignal();

    if (action === "list_tools") {
      const result = (await this.callJsonRpc("tools/list", {}, credential, callSignal)) as { tools?: JsonValue } | undefined;
      return { data: result?.tools ?? [] };
    }

    if (action === "call_tool") {
      const toolName = typeof parameters["tool_name"] === "string" ? parameters["tool_name"] : "";
      if (!toolName) {
        throw new Error("mcp_zapier_tool_name_required");
      }
      const toolArguments = (parameters["arguments"] as JsonValue | undefined) ?? {};
      const result = (await this.callJsonRpc("tools/call", { name: toolName, arguments: toolArguments }, credential, callSignal)) as McpToolCallResult | undefined;
      if (result?.isError) {
        // D-350: MCP sitt eget "kallet gikk gjennom, men verktøyet feilet internt"-signal -
        // vertsnavnet ALENE i feilteksten, ALDRI selve `content` (kan inneholde vilkårlig,
        // ubetrodd tredjeparts-Zap-utdata som ikke skal havne ekko-et i en feilmelding/logg).
        throw new McpProtocolError(`mcp_zapier_tool_execution_failed:${safeHostFor(credential)}`);
      }
      return { data: (result?.content ?? null) as JsonValue };
    }

    throw new Error(`mcp_zapier_action_not_implemented:${action}`);
  }
}
