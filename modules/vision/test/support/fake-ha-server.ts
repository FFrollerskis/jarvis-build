import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { VisionHttpFetch } from "../../src/ha-source.ts";

/**
 * WP-G3 (D-465): falsk Home Assistant (ekte HTTP-server på 127.0.0.1 - ingen ekte HA/kamera, ingen eksterne kall) for testene. Under test/, ikke src/ (d396).
 * Registrerer ALLE forespørsler (metode, sti, autorisasjonsheader) slik at testene kan bevise hva kilden faktisk gjør - og aldri gjør.
 */
export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  accept: string | undefined;
}

export type FakeHaHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface FakeHaState {
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string | undefined;
}

/** HA formaterer tidspunkt med mikrosekunder og forskyvning: `2026-11-18T11:59:30.123456+00:00`. */
export function haTimestamp(date: Date): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, ".$1456+00:00");
}

export class FakeHaServer {
  /** Forespørsler siden siste `reset()`. */
  readonly requests: RecordedRequest[] = [];
  /** ALLE forespørsler i hele serverens levetid (for «kun lesing»-påstanden). */
  readonly allRequests: RecordedRequest[] = [];
  private readonly routes = new Map<string, FakeHaHandler>();
  private constructor(private readonly server: Server, readonly base: string) {}

  static async start(): Promise<FakeHaServer> {
    let self: FakeHaServer | undefined;
    const server = createServer((req, res) => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers["authorization"] as string | undefined,
        accept: req.headers["accept"] as string | undefined
      };
      self?.requests.push(recorded);
      self?.allRequests.push(recorded);
      const handler = self?.routes.get(req.url ?? "");
      if (handler === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Entity not found." }));
        return;
      }
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    self = new FakeHaServer(server, `http://127.0.0.1:${port}`);
    return self;
  }

  reset(): void {
    this.routes.clear();
    this.requests.length = 0;
  }

  route(path: string, handler: FakeHaHandler): void {
    this.routes.set(path, handler);
  }

  setState(entity: string, body: FakeHaState): void {
    this.route(`/api/states/${entity}`, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ entity_id: entity, state: body.state, attributes: body.attributes ?? {}, last_changed: body.last_changed, last_updated: body.last_changed, context: { id: "ctx", parent_id: null, user_id: null } }));
    });
  }

  setImage(cameraEntity: string, bytes: Uint8Array, contentType: string | null = "image/jpeg"): void {
    this.route(`/api/camera_proxy/${cameraEntity}`, (_req, res) => {
      res.writeHead(200, contentType === null ? {} : { "content-type": contentType });
      res.end(Buffer.from(bytes));
    });
  }

  requestsTo(prefix: string): RecordedRequest[] {
    return this.requests.filter((r) => r.url.startsWith(prefix));
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/**
 * Kontrakten `VisionHttpFetch` slik apps/api oppfyller den med `guardedFetch` (ingen redirects fulgt, 3xx = feil). Selve `guardedFetch` bevises mot denne serveren i apps/api-testen
 * (vision-modulen avhenger ikke av tool-gateway); her trengs kun et ekte HTTP-lag for å teste kildens oppførsel mot strømming, grenser og tidsavbrudd.
 */
export const contractFetch: VisionHttpFetch = async (url, init) => {
  const response = await fetch(url, { method: init.method, headers: init.headers, redirect: "manual", ...(init.signal === undefined ? {} : { signal: init.signal }) });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`unsafe_vendor_url:unexpected_redirect_http_${response.status}`);
  }
  return response;
};
