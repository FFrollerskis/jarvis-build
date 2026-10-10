import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/** D-382: POST /confirmations decision=approve UTFØRER det lagrede kallet gjennom ToolGateway med eierens grant-identitet, én gang. */
const executed: Array<{ tool_id: string; action: string; parameters: unknown; person: string; idempotency_key: string }> = [];
const taken: string[] = [];
const recorded: Array<{ id: string; result: unknown }> = [];
let url = "";
let close: () => Promise<void>;

const fakeDeps = {
  grants: { verify: async (token: string) => (token === "good-grant"
    ? { ok: true, grant: { person_id: "p1", tenant_id: "t1", memory_space: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "signed" } }
    : { ok: false, reason: "grant_invalid" }) },
  identity: { resolveIdentity: async (i: Record<string, string>) => ({ ok: true, identity: { ...i, memory_space_id: i["memory_space"] } }) },
  executive: {
    gateway: {
      // WP-F1: ruten slår opp definisjonen for å avgjøre om godkjenning krever step-up (pengehandlinger) - ingen av disse testverktøyene gjør det.
      get: () => undefined,
      execute: async (call: { identity: { person_id: string }; tool_id: string; action: string; parameters: unknown; idempotency_key: string }) => {
        executed.push({ tool_id: call.tool_id, action: call.action, parameters: call.parameters, person: call.identity.person_id, idempotency_key: call.idempotency_key });
        return call.action === "fails" ? { ok: false, reason: "policy_denied" } : { ok: true, data: { id: "t1" }, external_id: "ext-1" };
      }
    }
  },
  confirmations: {
    peekPending: async () => null,
    listPending: async () => [],
    approveAndTake: async (_who: unknown, id: string) => {
      if (taken.includes(id) || id === "conf-gone") return null;
      taken.push(id);
      return { confirmation_id: id, tool_id: "todoist", action: id === "conf-fail" ? "fails" : "create_task", parameters: { content: "kjøp melk", tenant_id: "t1" } };
    },
    recordResult: async (_who: unknown, id: string, result: unknown) => { recorded.push({ id, result }); },
    decide: async (_who: unknown, id: string) => id !== "conf-gone"
  }
} as unknown as ApiDeps;

beforeAll(async () => {
  const server = createApiServer(fakeDeps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
});
afterAll(async () => { await close?.(); });

const post = (body: unknown) => fetch(`${url}/confirmations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("D-382: POST /confirmations approve utfører", () => {
  it("godkjenning kjører det lagrede kallet med grant-identiteten og bekreftelses-id som idempotensnøkkel; resultatet lagres og returneres", async () => {
    const res = await post({ grant_token: "good-grant", action: "decide", parameters: { confirmation_id: "conf-1", decision: "approve" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { executed: boolean; tool: string; result: { ok: boolean; external_id: string } } };
    expect(body.data).toMatchObject({ executed: true, tool: "todoist.create_task", result: { ok: true, external_id: "ext-1" } });
    expect(executed).toEqual([{ tool_id: "todoist", action: "create_task", parameters: { content: "kjøp melk", tenant_id: "t1" }, person: "p1", idempotency_key: "confirmation:conf-1" }]);
    expect(recorded).toEqual([{ id: "conf-1", result: { ok: true, data: { id: "t1" }, external_id: "ext-1" } }]);
  });

  it("samme godkjenning igjen -> 404 og ingen ny utførelse (engangs)", async () => {
    const before = executed.length;
    const res = await post({ grant_token: "good-grant", action: "decide", parameters: { confirmation_id: "conf-1", decision: "approve" } });
    expect(res.status).toBe(404);
    expect(executed.length).toBe(before);
  });

  it("gateway-avslag (policy) gir 409 med årsak - og lagres", async () => {
    const res = await post({ grant_token: "good-grant", action: "decide", parameters: { confirmation_id: "conf-fail", decision: "approve" } });
    expect(res.status).toBe(409);
    expect((await res.json() as { data: { result: { reason: string } } }).data.result.reason).toBe("policy_denied");
    expect(recorded.at(-1)).toEqual({ id: "conf-fail", result: { ok: false, reason: "policy_denied" } });
  });

  it("avvisning utfører aldri; uten grant -> 401", async () => {
    const before = executed.length;
    expect((await post({ grant_token: "good-grant", action: "decide", parameters: { confirmation_id: "conf-9", decision: "reject" } })).status).toBe(200);
    expect(executed.length).toBe(before);
    expect((await post({ action: "decide", parameters: { confirmation_id: "conf-1", decision: "approve" } })).status).toBe(401);
  });
});
