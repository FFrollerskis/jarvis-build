import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";

/**
 * D-338 (Tobias direkte i chat: "ja bygg mcp zapier" - svarer på Q-40 (a) MED
 * ja, en generell MCP-klient-kapabilitet er ønsket). Q-40 (b) - godkjennings-
 * modellen for DYNAMISK OPPDAGEDE, tredjeparts-eide verktøy - er IKKE
 * avgjort denne sliceen, og bevisst ikke gjettet frem: et MCP-verktøysett
 * (`tools/list`) kan endre seg NÅR SOM HELST utenfor Jarvis sin kontroll
 * (Zapier legger til/fjerner Zaps/actions fritt), noe INGEN eksisterende
 * `ToolGateway`-mekanisme (statiske `ToolDefinition`-lister, revidert PR for
 * PR) er bygget for å håndtere trygt for LIVE INVOKERING.
 *
 * Denne sliceen bygger derfor BEVISST kun den konservative FØRSTE halvparten:
 * - `list_tools` (klasse A, read-only): kaller MCP sin `tools/list`
 *   JSON-RPC-metode og returnerer den RÅ, ufiltrerte listen tredjeparts-
 *   serveren oppgir. `output_trust: "untrusted"` (CLAUDE.md regel 7 -
 *   ekstern, dynamisk oppdaget data er ALDRI instruksjoner, ALDRI direkte
 *   til autoritativt minne - kun Ingestion Zone-data).
 * - INGEN `call_tool`/invoker-handling finnes i det hele tatt i denne
 *   sliceen - bevisst FRAVÆRENDE, ikke en stubbet-og-avvist handling. Live
 *   invokering av et dynamisk oppdaget, tredjeparts-eid verktøy er en EGEN
 *   D-64/D-41-vurdering (godkjenningsmodell, klasse D som default med en
 *   evt. smal eier-konfigurert allowlist-unntaksvei) som krever sin egen
 *   D-beslutning FØR den bygges - se Q-40 (b), fortsatt åpen.
 *
 * API-formen (MCP - Model Context Protocol, JSON-RPC 2.0 over "Streamable
 * HTTP", offisiell spesifikasjon https://modelcontextprotocol.io): klienten
 * POST-er en JSON-RPC-forespørsel med metode `tools/list` til serverens
 * endepunkt-URL; serveren svarer enten med et rent JSON-RPC-svar
 * (`content-type: application/json`) eller en SSE-strøm
 * (`content-type: text/event-stream`) med ETT eller flere JSON-RPC-svar som
 * hendelser. Zapier sin MCP-server (`https://mcp.zapier.com/api/mcp/s/
 * <per-bruker-token>/mcp`) krever en PERSONLIG, PER-BRUKER-PROVISJONERT
 * URL - selve URL-en (ikke en separat header-verdi) er derfor
 * hemmelighets-ekvivalent og lagres som `JARVIS_MCP_ZAPIER_SERVER_URL`
 * (aldri logget, aldri ekkoet i feilmeldinger - kun vertsnavnet er trygt å
 * inkludere ved feil).
 *
 * Denne FØRSTE sliceen håndterer KUN det rene JSON-RPC-svaret
 * (`application/json`) - en SSE-strøm rapporteres eksplisitt som
 * `mcp_streamable_sse_not_supported` (ÆRLIG DEFERRED, ikke en stille
 * feiltolkning) fremfor å gjette på en SSE-parser uten en denne-økten-
 * bekreftet, ekte Zapier-server-respons å teste mot.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeHostFor(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "invalid_url";
  }
}

interface JsonRpcToolsListResponse {
  jsonrpc?: string;
  id?: JsonValue;
  result?: { tools?: JsonValue };
  error?: { code?: number; message?: string };
}

export class McpZapierTransport implements ToolTransport {
  async invoke(action: string, _parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    if (action !== "list_tools") {
      throw new Error(`mcp_zapier_action_not_implemented:${action}`);
    }
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

    const host = safeHostFor(credential);
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(credential, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      });

      if (response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream")) {
          throw new McpProtocolError(`mcp_streamable_sse_not_supported:${host}`);
        }
        const body = (await response.json()) as JsonRpcToolsListResponse;
        if (body.error) {
          throw new McpProtocolError(`mcp_jsonrpc_error_${body.error.code ?? "unknown"}:${(body.error.message ?? "").slice(0, 200)}`);
        }
        return { data: body.result?.tools ?? [] };
      }

      const retryable = RETRYABLE_HTTP_STATUS.has(response.status);
      lastError = new Error(`mcp_zapier_http_error_${response.status}:${host}`);
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw lastError!;
  }
}
