import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-F1 (D-453, JARVIS-070): webhook-ruter og hendelsesstatus. `rejected` (autentisert, men permanent ugyldig innhold) og `unsupported`/`duplicate` er ferdige for leverandøren
 * og besvares 2xx - ingen evig retry. KUN `failed_retryable` er 502 (midlertidig feil: leverandøren skal prøve igjen). Alle fire ruter følger samme regel.
 */
let status = "processed";
let url = "";
let close: () => Promise<void>;
const result = () => ({ status, eventId: "ev-1" });
const deps = {
  finance: {
    service: {
      ingestStripeWebhookEvent: async () => result(),
      ingestVippsWebhookEvent: async () => result(),
      ingestNeonomicsWebhookEvent: async () => result()
    },
    cards: { ingestWallesterWebhookEvent: async () => result() }
  }
} as unknown as ApiDeps;

beforeAll(async () => {
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
});
afterAll(async () => { await close?.(); });

describe("webhook-ruter: statuskode per hendelsesstatus", () => {
  for (const path of ["/webhooks/stripe", "/webhooks/vipps", "/webhooks/neonomics", "/webhooks/wallester"]) {
    it(`${path}: processed/duplicate/unsupported/rejected = 200 (stopp gjentakelse); failed_retryable = 502 (prøv igjen)`, async () => {
      for (const s of ["processed", "duplicate", "unsupported", "rejected"]) {
        status = s;
        const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        expect(res.status, `${path} ${s}`).toBe(200);
        expect(await res.json()).toMatchObject({ received: true, status: s, event_id: "ev-1" });
      }
      status = "failed_retryable";
      const retry = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(retry.status).toBe(502);
    });
  }
});
