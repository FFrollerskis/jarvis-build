import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Felles fake-server for adaptertester (ekte `fetch` mot en lokal node:http-server - ingen mocking av fetch, så HTTP-form, headere og SSE-strøm er reelle).
 * Svar: `json` (vanlig respons), `sse` (hver streng blir én `data:`-linje; ta med `"[DONE]"` selv), `raw` (rå tekst) eller `hang` (svarer aldri).
 */
export interface SeenRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  sse?: string[];
  raw?: string;
  hang?: boolean;
}

export interface FakeServer {
  url: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

export async function fakeServer(handler: (request: SeenRequest, index: number) => FakeReply): Promise<FakeServer> {
  const seen: SeenRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const request: SeenRequest = { url: req.url ?? "", headers: req.headers, body };
      seen.push(request);
      const reply = handler(request, seen.length - 1);
      if (reply.hang) return;
      const status = reply.status ?? 200;
      if (reply.sse) {
        res.writeHead(status, { "content-type": "text/event-stream" });
        for (const chunk of reply.sse) res.write(`data: ${chunk}\n\n`);
        res.end();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(reply.raw ?? JSON.stringify(reply.json ?? {}));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
}
