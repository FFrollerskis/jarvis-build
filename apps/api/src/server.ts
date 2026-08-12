import { createServer, type Server } from "node:http";

/**
 * Fase 1: minimalt kjørbart API-fundament uten rammeverk.
 * Rammeverksvalg utsettes til fase 3 når webchat/streaming stiller faktiske krav
 * (leverandøruavhengighet: ingen avhengighet å bytte ut senere).
 *
 * Struktur for senere Core-moduler: hver modul får en route-registrering her;
 * Policy Gateway kobles foran alle verktøyruter fra fase 3.
 */
export interface HealthStatus {
  status: "ok";
  service: "jarvis-api";
  version: string;
  time: string;
}

export function healthStatus(): HealthStatus {
  return {
    status: "ok",
    service: "jarvis-api",
    version: "0.1.0",
    time: new Date().toISOString()
  };
}

export function createApiServer(): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(healthStatus()));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}
