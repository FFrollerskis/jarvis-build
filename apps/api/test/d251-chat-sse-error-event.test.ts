import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ChannelSessionAuthority, IdentityService, SessionGrantService, SessionService
} from "@jarvis/core";
import type { PolicyGateway } from "@jarvis/policy";
import type { InProcessWorker } from "@jarvis/tasks";
import type { ConversationEngine } from "../src/conversation.ts";
import { createApiServer } from "../src/server.ts";

/**
 * D-251 (live NAS-migreringsfunn, 2026-09-23, Tobias direkte i chat: "jarvis
 * responderer ikke"). Root cause: `/chat` sin SSE-gren sender `res.writeHead(200,
 * text/event-stream)` FØR `ConversationEngine.handle()` kalles - kaster den
 * ETTER det punktet, fanget kun den ytre feilhåndteringen i
 * `createApiServer()` (`res.end()` alene, INGEN logging, INGEN event til
 * klienten). Klienten så en stille, tom "svarer ikke" - ingen feilmelding,
 * ingen server-logglinje å feilsøke fra (nøyaktig symptomet fra NAS-
 * migreringsøkten). Ingen ekte databaseavhengighet trengs for å bevise dette -
 * `grants`/`identity` er bevisst minimale fakes, KUN `conversation.handle()`
 * sin feilbane er det som testes.
 */
describe("D-251: /chat SSE-feil etter headers-sendt logges OG sender et error-event, ikke en stille res.end()", () => {
  let server: ReturnType<typeof createApiServer>;
  let baseUrl: string;
  let loggedErrors: string[] = [];
  const originalConsoleError = console.error;

  beforeAll(async () => {
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args.map(String).join(" "));
    };

    const grants = {
      verify: async () => ({
        ok: true,
        grant: {
          tenant_id: "tenant-d251", person_id: "person-d251", device_id: "device-d251",
          session_id: "session-d251", memory_space: "personal", channel: "web",
          auth_strength: "signed", expires_at_ms: Date.now() + 60_000
        }
      })
    } as unknown as SessionGrantService;

    const identity = {
      resolveIdentity: async (input: { tenant_id: string; person_id: string; device_id: string; session_id: string; memory_space: string; channel: string; auth_strength: string }) => ({
        ok: true,
        identity: { ...input }
      })
    } as unknown as IdentityService;

    const conversation = {
      handle: async () => {
        throw new Error("simulated_model_gateway_failure");
      }
    } as unknown as ConversationEngine;

    server = createApiServer({
      identity,
      sessions: {} as unknown as SessionService,
      conversation,
      policy: {} as unknown as PolicyGateway,
      worker: {} as unknown as InProcessWorker,
      channelAuthority: {} as unknown as ChannelSessionAuthority,
      grants
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    console.error = originalConsoleError;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sender et 'error'-SSE-event med en meldingstekst FØR streamen avsluttes - klienten skal ALDRI se en stille, tom stream", async () => {
    loggedErrors = [];
    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ grant_token: "irrelevant-in-this-fake", message: "hei" })
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");
  });

  it("logger feilen server-side (console.error) - den ekte NAS-hendelsen hadde INGEN logglinje å feilsøke fra", async () => {
    loggedErrors = [];
    await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ grant_token: "irrelevant-in-this-fake", message: "hei" })
    });
    expect(loggedErrors.some((line) => line.includes("chat_stream_error"))).toBe(true);
    expect(loggedErrors.some((line) => line.includes("simulated_model_gateway_failure"))).toBe(true);
  });
});
