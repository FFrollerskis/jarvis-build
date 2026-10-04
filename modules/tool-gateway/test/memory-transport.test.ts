import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import type { MemoryRetriever, RetrievedItem, SearchOptions } from "@jarvis/memory";
import { MemorySearchTransport, memoryToolDefinitions } from "../src/memory-transport.ts";
import { MeshToolExecutor, meshToolDefinitions } from "../src/mesh-bridge.ts";
import type { ToolGateway } from "../src/gateway.ts";

/**
 * "Charlie"-minne-verifisering (task #118): DB-uavhengige tester -
 * `MemorySearchTransport` gjør ETT direkte kall til `MemoryRetriever.search()`
 * (allerede parametrisert/RLS-skopet av `MemoryRetriever` selv), så en fake
 * retriever er nok til å bevise ruting/skoping/feilmodus uten embedded
 * Postgres.
 */

function identity(overrides: Partial<IdentityContext> = {}): IdentityContext {
  return {
    person_id: "person-mem-test", tenant_id: "tenant-mem-test", memory_space_id: "business",
    session_id: "sess-mem-test", device_id: "jarvis-core", channel: "api", auth_strength: "active",
    ...overrides
  };
}

function fakeRetriever(items: RetrievedItem[] = []): { retriever: MemoryRetriever; calls: Array<{ identity: IdentityContext; options: SearchOptions }> } {
  const calls: Array<{ identity: IdentityContext; options: SearchOptions }> = [];
  const retriever = {
    search: async (id: IdentityContext, options: SearchOptions) => {
      calls.push({ identity: id, options });
      return items;
    }
  } as unknown as MemoryRetriever;
  return { retriever, calls };
}

const sampleItem: RetrievedItem = {
  memory_item_id: "mem-1", subject: "Bilen", content: "Tobias kjører en Tesla Model 3", type: "fact",
  space: "personal", score: 0.9, valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
  has_conflict: false, kind: "item" as const, importance: 5, observed_at: "2026-01-01T00:00:00.000Z", keywords: [], source: { kind: "conversation", ref: "sess-1", trust_level: "internal" }
};

describe("A: MemorySearchTransport.invoke('search', ...) - skopes ALLTID til identity.memory_space_id, ALDRI cross-space", () => {
  it("videresender query til retriever.search() med spaces=[identity.memory_space_id]", async () => {
    const { retriever, calls } = fakeRetriever([sampleItem]);
    const transport = new MemorySearchTransport(retriever);
    const result = await transport.invoke("search", { query: "bilen min" }, "cred", { identity: identity({ memory_space_id: "personal" }) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ query: "bilen min", spaces: ["personal"] });
    expect(result.data).toEqual([sampleItem]);
  });

  it("valgfri limit videresendes naar oppgitt som tall, IKKE naar fravaerende", async () => {
    const { retriever, calls } = fakeRetriever();
    const transport = new MemorySearchTransport(retriever);
    await transport.invoke("search", { query: "x", limit: 3 }, "cred", { identity: identity() });
    expect(calls[0]!.options.limit).toBe(3);

    await transport.invoke("search", { query: "y" }, "cred", { identity: identity() });
    expect(calls[1]!.options.limit).toBeUndefined();
  });

  it("manglende/tom query kaster missing_parameter:query, INGEN kall til retriever", async () => {
    const { retriever, calls } = fakeRetriever();
    const transport = new MemorySearchTransport(retriever);
    await expect(transport.invoke("search", {}, "cred", { identity: identity() })).rejects.toThrow("missing_parameter:query");
    await expect(transport.invoke("search", { query: "" }, "cred", { identity: identity() })).rejects.toThrow("missing_parameter:query");
    expect(calls).toHaveLength(0);
  });

  it("manglende invocation-context feiler lukket", async () => {
    const transport = new MemorySearchTransport(fakeRetriever().retriever);
    await expect(transport.invoke("search", { query: "x" }, "cred")).rejects.toThrow("memory_missing_invocation_context");
  });

  it("ukjent action kaster unknown_memory_action:<action>", async () => {
    const transport = new MemorySearchTransport(fakeRetriever().retriever);
    await expect(transport.invoke("delete_everything", {}, "cred", { identity: identity() })).rejects.toThrow("unknown_memory_action:delete_everything");
  });
});

describe("B: memoryToolDefinitions() - klasse A (lesing), strict() skjema uten identitetsfelt", () => {
  it("registrert som tool_id='memory'/action='search', klasse A (+ D-367: propose/list/approve/reject_proposal)", () => {
    const tools = memoryToolDefinitions(new MemorySearchTransport(fakeRetriever().retriever));
    expect(tools.map((t) => t.action)).toEqual(["search", "propose", "list_proposals", "approve_proposal", "reject_proposal"]);
    expect(tools[0]!.tool_id).toBe("memory");
    expect(tools[0]!.action).toBe("search");
    expect(tools[0]!.capability_class).toBe("A");
    const byAction = new Map(tools.map((t) => [t.action, t]));
    expect(byAction.get("propose")!.capability_class).toBe("B");
    expect(byAction.get("propose")!.scopes).toEqual(["memory.propose"]);
    expect(byAction.get("approve_proposal")!.scopes).toEqual(["memory.approve"]);
  });

  it("D-367: propose uten konfigurert writer feiler lukket; propose-skjema avviser identitet/space-felt og lange verdier", async () => {
    const transport = new MemorySearchTransport(fakeRetriever().retriever);
    const ctx = { identity: { tenant_id: "t", person_id: "p", memory_space_id: "personal", session_id: "s", device_id: "d" } } as never;
    await expect(transport.invoke("propose", { subject: "a", content: "b" }, "x", ctx)).rejects.toThrow("memory_proposals_not_configured");
    const propose = memoryToolDefinitions(transport).find((t) => t.action === "propose")!;
    const schema = propose.input_schema as unknown as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ subject: "a", content: "b" }).success).toBe(true);
    expect(schema.safeParse({ subject: "a", content: "b", space: "health" }).success).toBe(false);
    expect(schema.safeParse({ subject: "a", content: "b", tenant_id: "x" }).success).toBe(false);
    expect(schema.safeParse({ subject: "a", content: "x".repeat(1001) }).success).toBe(false);
  });

  it("D-369: transporten svarer 'approved' når writeren auto-godkjente, og sender owner_stated KUN når parameteren er true", async () => {
    const seen: unknown[] = [];
    const writer = {
      propose: async (_i: unknown, input: unknown) => { seen.push(input); return { op: "ADD", memory_item_id: "mem-9", status: "quarantined", auto_approved: true }; },
      listProposals: async () => [], promoteFromQuarantine: async () => true, rejectFromQuarantine: async () => true
    };
    const transport = new MemorySearchTransport(fakeRetriever().retriever, writer as never);
    const identity = { tenant_id: "t", person_id: "p", memory_space_id: "personal", session_id: "s", device_id: "d" };
    const ok = await transport.invoke("propose", { subject: "a", content: "b", owner_stated: true }, "x", { identity } as never);
    expect((ok.data as { status: string }).status).toBe("approved");
    await transport.invoke("propose", { subject: "a", content: "b", owner_stated: "ja" as never }, "x", { identity } as never);
    expect(seen[0]).toMatchObject({ owner_stated: true });
    expect(seen[1]).not.toHaveProperty("owner_stated");
  });

  it("D-367: transporten kaller writer.propose med identiteten fra konteksten og svarer at forslaget er i karantene", async () => {
    const calls: unknown[] = [];
    const writer = {
      propose: async (identity: unknown, input: unknown) => { calls.push({ identity, input }); return { op: "ADD", memory_item_id: "mem-1", status: "quarantined" }; },
      listProposals: async () => [], promoteFromQuarantine: async () => true, rejectFromQuarantine: async () => true
    };
    const transport = new MemorySearchTransport(fakeRetriever().retriever, writer as never);
    const identity = { tenant_id: "t", person_id: "p", memory_space_id: "personal", session_id: "s", device_id: "d" };
    const out = await transport.invoke("propose", { subject: "tobias.familie", content: "Maria og Henrik", type: "relation" }, "x", { identity } as never);
    expect(calls).toEqual([{ identity, input: { subject: "tobias.familie", content: "Maria og Henrik", type: "relation" } }]);
    expect((out.data as { status: string }).status).toBe("quarantined");
    expect(out.external_id).toBe("mem-1");
  });

  it("input_schema avviser identitetsfelt (tenant_id) i parametre - kun query/limit er gyldige", () => {
    const tools = memoryToolDefinitions(new MemorySearchTransport(fakeRetriever().retriever));
    const schema = tools[0]!.input_schema as unknown as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ query: "x", tenant_id: "tenant-attacker" }).success).toBe(false);
    expect(schema.safeParse({ query: "x" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });
});

describe("C: mesh-bridge - search_my_memory ruter FAKTISK til tool_id='memory'/action='search' med modell-oppgitt query", () => {
  it("MeshToolExecutor.execute('search_my_memory', {query}) videresender query UENDRET til memory.search", async () => {
    const calls: Array<{ tool_id: string; action: string; parameters: unknown }> = [];
    const fakeToolGateway = {
      execute: async (req: { tool_id: string; action: string; parameters: unknown }) => {
        calls.push(req);
        return { ok: true, data: [] };
      }
    } as unknown as ToolGateway;
    const executor = new MeshToolExecutor(fakeToolGateway, identity());
    const result = await executor.execute(
      { tool_call_id: "call-1", tool_name: "search_my_memory", arguments: { query: "hva vet du om bilen min" }, provider: "test", model: "test" },
      { tenant_id: "tenant-mem-test", idempotency_key: "idem-1" }
    );
    expect(result.success).toBe(true);
    expect(calls).toMatchObject([{ tool_id: "memory", action: "search", parameters: { query: "hva vet du om bilen min" } }]);
  });

  it("meshToolDefinitions() inneholder search_my_memory med query som pakrevd streng-parameter", () => {
    const def = meshToolDefinitions().find((d) => d.name === "search_my_memory");
    expect(def).toBeDefined();
    expect(def!.input_schema).toMatchObject({ required: ["query"] });
  });
});
