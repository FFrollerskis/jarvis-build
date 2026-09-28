import { createServer, type Server } from "node:http";
import type { BrowserEngine } from "./browser-engine.ts";
import { assertNavigableUrl } from "./browser-engine.ts";

/**
 * D-339: den interne HTTP-kontrakten `BrowserGatewayTransport`
 * (`modules/tool-gateway/src/browser-transport.ts`) snakker mot - SAMME
 * "egen prosess, snakkes med via vanlig HTTP fetch()"-mønster som
 * voice-gateway sin `HttpCoreClient` bruker MOT `apps/api` (D-212), her
 * motsatt vei (ToolGateway snakker INN i denne prosessen). `POST /invoke`
 * er den ENESTE handlings-inngangen - `{action, parameters}` inn,
 * `{data}` ut, samme kontraktform som enhver annen `ToolTransport`.
 */
interface InvokeRequestBody {
  action?: unknown;
  parameters?: Record<string, unknown>;
}

const MAX_BODY_BYTES = 1_000_000;

function readJsonBody(req: import("node:http").IncomingMessage): Promise<InvokeRequestBody> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("browser_gateway_body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as InvokeRequestBody));
      } catch {
        reject(new Error("browser_gateway_invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

async function handleInvoke(engine: BrowserEngine, body: InvokeRequestBody): Promise<{ data: unknown }> {
  const action = body.action;
  const parameters = body.parameters ?? {};
  if (action === "navigate") {
    return { data: await engine.navigate(assertNavigableUrl(parameters["url"])) };
  }
  if (action === "extract_text") {
    return { data: { text: await engine.extractText() } };
  }
  if (action === "screenshot") {
    return { data: { image_base64: await engine.screenshot() } };
  }
  throw new Error(`browser_gateway_action_not_implemented:${String(action)}`);
}

export interface BrowserGatewayOptions {
  engine: BrowserEngine;
}

export function createBrowserGateway(options: BrowserGatewayOptions): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "jarvis-browser-gateway" }));
      return;
    }
    if (req.method === "POST" && req.url === "/invoke") {
      readJsonBody(req)
        .then((body) => handleInvoke(options.engine, body))
        .then((result) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        })
        .catch((error: Error) => {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "browser_gateway_not_found" }));
  });
}
