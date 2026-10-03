import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * D-367 - eierens godkjenning av modellens minneforslag: HTTP-atferd for `/memory/proposals` (grant-beskyttet, eget allowlist,
 * går KUN til `memory`-verktøyet) + wiring-sjekker i main.ts. Selve karantene-semantikken er testet mot ekte Postgres i
 * `modules/memory/test/memory.test.ts`.
 */
const executed: Array<{ tool_id: string; action: string; parameters: unknown; person: string }> = [];
let url = "";
let close: () => Promise<void>;

const fakeDeps = {
  grants: { verify: async (token: string) => (token === "good-grant"
    ? { ok: true, grant: { person_id: "p1", tenant_id: "t1", memory_space: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "signed" } }
    : { ok: false, reason: "grant_invalid" }) },
  identity: { resolveIdentity: async (i: Record<string, string>) => ({ ok: true, identity: { ...i, memory_space_id: i["memory_space"] } }) },
  executive: {
    gateway: {
      execute: async (call: { identity: { person_id: string }; tool_id: string; action: string; parameters: unknown }) => {
        executed.push({ tool_id: call.tool_id, action: call.action, parameters: call.parameters, person: call.identity.person_id });
        return { ok: true, data: { done: true } };
      }
    }
  }
} as unknown as ApiDeps;

beforeAll(async () => {
  const server = createApiServer(fakeDeps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
});
afterAll(async () => { await close?.(); });

const post = (body: unknown) => fetch(`${url}/memory/proposals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("D-367: POST /memory/proposals", () => {
  it("uten grant -> 401; identitetsfelt i body -> 400; ukjent felt -> 400", async () => {
    expect((await post({ action: "list_proposals" })).status).toBe(401);
    const idField = await post({ grant_token: "good-grant", action: "list_proposals", person_id: "evil" });
    expect(idField.status).toBe(400);
    expect((await idField.json() as { error: string }).error).toBe("identity_field_forbidden");
    expect((await post({ grant_token: "good-grant", action: "list_proposals", surprise: 1 })).status).toBe(400);
  });

  it("handling utenfor allowlisten (inkl. propose/search/vilkårlig) -> 400 FØR grant og verktøy røres", async () => {
    executed.length = 0;
    for (const action of ["propose", "search", "invalidate", "approve_all", "approve_proposal; DROP"]) {
      const res = await post({ grant_token: "good-grant", action });
      expect(res.status, action).toBe(400);
      expect((await res.json() as { reason: string }).reason).toBe("action_not_allowed");
    }
    expect(executed).toEqual([]);
  });

  it("ugyldig/ukjent grant -> 403 identity_denied og verktøyet kalles ikke", async () => {
    executed.length = 0;
    const res = await post({ grant_token: "bogus", action: "approve_proposal", parameters: { memory_item_id: "m1" } });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("identity_denied");
    expect(executed).toEqual([]);
  });

  it("gyldig grant: identiteten kommer fra grantet, og kallet går KUN til tool_id 'memory' med den tillatte handlingen", async () => {
    executed.length = 0;
    for (const action of ["list_proposals", "approve_proposal", "reject_proposal"]) {
      const res = await post({ grant_token: "good-grant", action, parameters: { memory_item_id: "mem-1" } });
      expect(res.status, action).toBe(200);
    }
    expect(executed.map((e) => `${e.tool_id}:${e.action}`)).toEqual(["memory:list_proposals", "memory:approve_proposal", "memory:reject_proposal"]);
    expect(executed.every((e) => e.person === "p1")).toBe(true);
  });
});

describe("D-367: wiring", () => {
  const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
  const dashboard = readFileSync(fileURLToPath(new URL("../../web/dashboard.html", import.meta.url)), "utf8");
  it("main.ts gir MemorySearchTransport en MemoryWriter, og kapabilitetsstatusen inkluderer karantene-flaten", () => {
    expect(main).toMatch(/new MemorySearchTransport\(memoryRetriever, memoryWriter\)/);
    expect(main).toMatch(/modelSurface: \[\.\.\.MODEL_SURFACE_ALLOWLIST, \.\.\.MODEL_SURFACE_QUARANTINE_WRITES(, \.\.\.CHAT_READ_TIER, \.\.\.CHAT_ACT_TIER)?\]/);
  });
  it("D-369: samtalemotoren gir executoren eierens rå melding, main.ts har av-bryteren, og `owner_stated` kan ikke komme fra modell-args", () => {
    const conversation = readFileSync(fileURLToPath(new URL("../src/conversation.ts", import.meta.url)), "utf8");
    expect(conversation).toContain("createTurnContext(surface, text)");
    expect(conversation).toContain("executorFor(identity, turn)");
    expect(main).toMatch(/JARVIS_MEMORY_AUTO_APPROVE"\] === "false" \? \{ \.\.\.turn, user_message: "" \} : turn/);
    const mesh = readFileSync(fileURLToPath(new URL("../../../modules/tool-gateway/src/mesh-bridge.ts", import.meta.url)), "utf8");
    // mappingen for suggest_memory kopierer kun subject/content/type - aldri et owner_stated-felt fra modellen
    const mapping = mesh.slice(mesh.indexOf('name: "suggest_memory"'), mesh.indexOf('action: "propose"') + 400);
    expect(mapping).not.toMatch(/modelArgs\["owner_stated"\]/);
  });
  it("dashbordet godkjenner via grant-ruten og bruker aldri chat/modell til godkjenning", () => {
    expect(dashboard).toContain('fetch("/memory/proposals"');
    expect(dashboard).toContain("data-memory-approve");
    expect(dashboard).toContain("data-memory-reject");
    expect(dashboard).not.toMatch(/fetch\("\/chat"[^)]*approve_proposal/);
  });
});
