import { describe, expect, it } from "vitest";
import { MeshToolExecutor, SURFACE_TOOL_GRANTS, assertChatDelegateTier, assertManifestInvariants, buildToolManifest, createTurnContext, MemorySearchTransport, memoryToolDefinitions, firstWaveTools, resolveModelToolSurface, selectSurfaceTools, ModelSurfaceViolationError, requiresConfirmationWhenTainted, type ConfirmationGate, type ToolDefinition, type ToolGateway } from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions, DELEGATED_JOB_BUDGET_ORE, renderDelivery } from "../src/chat-jobs.ts";

/** D-416: delegeringsnivået (chat og agenter er to løp) - låst i manifest, tildelt kun web_chat, bekreftelse kun i tainted tur. */
const submitted: unknown[] = [];
const fakeJobs = {
  activeCount: async () => 0,
  get: async () => null,
  list: async () => []
};
const transport = new TasksDelegateTransport(
  { submit: async (_id: unknown, c: unknown) => { submitted.push(c); return { ok: true as const, value: { task_id: (c as { task_id: string }).task_id } }; } } as never,
  fakeJobs as never
);
const defs: ToolDefinition[] = firstWaveTools({}, { additionalTools: [...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)), ...tasksDelegateToolDefinitions(transport)] });
const gw = { list: () => defs } as unknown as ToolGateway;
const identity = { tenant_id: "t1", person_id: "p1", memory_space_id: "personal", device_id: "d1", session_id: "s-chat" };

describe("manifest og flater", () => {
  it("delegeringsnivået er gyldig og manifestinvariantene holder; kun web_chat har det", () => {
    expect(() => assertChatDelegateTier(gw)).not.toThrow();
    expect(() => assertManifestInvariants(buildToolManifest(defs), { ignoreUnregisteredGrants: true })).not.toThrow();
    for (const s of ["voice", "telegram", "background", "coding"] as const) {
      expect(SURFACE_TOOL_GRANTS[s].some((g) => g.tool_id === "tasks"), s).toBe(false);
    }
    expect(SURFACE_TOOL_GRANTS.web_chat.filter((g) => g.tool_id === "tasks").map((g) => g.action).sort()).toEqual(["delegate_background_task", "get_task_status"]);
  });
  it("delegering som klasse C/D eller read, og statusoppslag som klasse B, stopper oppstarten lukket", () => {
    const mutate = (action: string, patch: Partial<ToolDefinition>) => ({ list: () => defs.map((d) => (d.tool_id === "tasks" && d.action === action ? { ...d, ...patch } : d)) }) as unknown as ToolGateway;
    expect(() => assertChatDelegateTier(mutate("delegate_background_task", { capability_class: "D" }))).toThrow(ModelSurfaceViolationError);
    expect(() => assertChatDelegateTier(mutate("get_task_status", { capability_class: "B" }))).toThrow(ModelSurfaceViolationError);
    expect(() => assertManifestInvariants(buildToolManifest(defs.map((d) => (d.action === "delegate_background_task" ? { ...d, capability_class: "C" as const } : d))), { ignoreUnregisteredGrants: true })).toThrow();
  });
  it("modellen ser delegeringsverktøyene (merket bakgrunnsjobb) og de velges på riktig intensjon", () => {
    const surface = resolveModelToolSurface(gw, { onlyRegistered: true, includeChatReadTier: true, includeChatActTier: true, includeChatDelegateTier: true });
    const sel = selectSurfaceTools("web_chat", "undersøk dette i bakgrunnen og gi meg en rapport", surface);
    const names = sel.selected.map((m) => m.def.name);
    expect(names).toContain("tasks__delegate_background_task");
    expect(sel.selected.find((m) => m.action === "delegate_background_task")?.def.description).toContain("BAKGRUNNSJOBB");
    expect(selectSurfaceTools("web_chat", "hei", surface).selected).toEqual([]);
  });
  it("i en tainted tur krever delegering bekreftelse (manifest), men statusoppslag ikke", () => {
    const manifest = buildToolManifest(defs);
    expect(requiresConfirmationWhenTainted(manifest.get("tasks.delegate_background_task")!)).toBe(true);
    expect(requiresConfirmationWhenTainted(manifest.get("tasks.get_task_status")!)).toBe(false);
  });
});

describe("executor: ingen bekreftelse i ren eier-tur, bekreftelse i tainted tur", () => {
  const surface = resolveModelToolSurface(gw, { onlyRegistered: true, includeChatReadTier: true, includeChatActTier: true, includeChatDelegateTier: true });
  const manifest = buildToolManifest(defs);
  const args = { title: "Prisoversikt", prompt: "Sammenstill priser fra e-postene mine siste uke.", use_tools: false };
  const call = { tool_call_id: "c1", tool_name: "tasks__delegate_background_task", arguments: args, provider: "p", model: "m" };
  const toolGateway = {
    execute: async (req: { tool_id: string; action: string; parameters: Record<string, never>; identity: typeof identity }) => {
      const out = await transport.invoke(req.action, req.parameters, "", { identity: req.identity as never });
      return { ok: true as const, data: out.data, output_trust: "internal" as const };
    }
  } as unknown as ToolGateway;

  it("ren eier-tur: starter jobben direkte, med kontrakt bygget i trusted kode", async () => {
    submitted.length = 0;
    const turn = createTurnContext("web_chat", "undersøk priser i bakgrunnen");
    const ex = new MeshToolExecutor(toolGateway, identity, 20_000, surface, turn, { manifest, confirmations: { checkAndConsume: async () => { throw new Error("skal ikke kalles"); } } as ConfirmationGate });
    const res = await ex.execute(call, { tenant_id: "t1", idempotency_key: "k1" });
    expect(res.success).toBe(true);
    expect(submitted).toHaveLength(1);
    const c = submitted[0] as { owner_person_id: string; tenant_id: string; agent_profile: string; model_budget_ore: number; allowed_tools: string[]; input: { provenance: string; trust_level: string; data: Record<string, unknown> } };
    expect(c).toMatchObject({ owner_person_id: "p1", tenant_id: "t1", agent_profile: "executive", model_budget_ore: DELEGATED_JOB_BUDGET_ORE });
    expect(c.input).toMatchObject({ provenance: "chat:s-chat", trust_level: "internal" });
    expect(c.input.data).toMatchObject({ purpose: "BACKGROUND", sensitivity: "PRIVATE", paid_models_allowed: false, delegated_from_chat: true });
    expect(c.input.data["tools"]).toBeUndefined();
    expect(c.allowed_tools).toEqual([]);
  });
  it("modellen kan aldri velge identitet, budsjett, profil eller verktøyliste via argumenter", async () => {
    submitted.length = 0;
    const turn = createTurnContext("web_chat", "undersøk");
    const ex = new MeshToolExecutor(toolGateway, identity, 20_000, surface, turn, { manifest });
    await ex.execute({ ...call, arguments: { ...args, use_tools: true, owner_person_id: "andre", model_budget_ore: 999999, agent_profile: "coding", allowed_tools: ["docker"] } }, { tenant_id: "t1", idempotency_key: "k2" });
    const c = submitted[0] as { owner_person_id: string; model_budget_ore: number; agent_profile: string; allowed_tools: string[] } | undefined;
    // Ukjente felt avvises av strict-skjemaet, eller ignoreres - uansett aldri brukt.
    if (c) {
      expect(c.owner_person_id).toBe("p1");
      expect(c.model_budget_ore).toBe(DELEGATED_JOB_BUDGET_ORE);
      expect(c.agent_profile).toBe("executive");
      expect(c.allowed_tools).not.toContain("docker");
    }
  });
  it("tainted tur: jobben startes IKKE før eierens bundne bekreftelse", async () => {
    submitted.length = 0;
    const turn = createTurnContext("web_chat", "les e-posten og undersøk");
    turn.taint.mark("untrusted_output:email.read_inbox");
    const gate: ConfirmationGate = { checkAndConsume: async () => ({ ok: false, reason: "confirmation_pending", confirmation_id: "conf-1" }) };
    const ex = new MeshToolExecutor(toolGateway, identity, 20_000, surface, turn, { manifest, confirmations: gate });
    const res = await ex.execute(call, { tenant_id: "t1", idempotency_key: "k3" });
    expect(res.success).toBe(false);
    expect(res.output).toMatchObject({ confirmation_required: true, confirmation_id: "conf-1" });
    expect(submitted).toHaveLength(0);
  });
});

describe("transport", () => {
  it("avviser manglende kontekst og tomme felt, og begrenser antall aktive jobber", async () => {
    await expect(transport.invoke("delegate_background_task", { title: "x", prompt: "y" }, "")).rejects.toThrow("tasks_missing_invocation_context");
    await expect(transport.invoke("delegate_background_task", { title: "", prompt: "" }, "", { identity: identity as never })).rejects.toThrow("missing_parameter");
    const busy = new TasksDelegateTransport({ submit: async () => { throw new Error("skal ikke kalles"); } } as never, { ...fakeJobs, activeCount: async () => 5 } as never);
    const out = await busy.invoke("delegate_background_task", { title: "Tittel her", prompt: "En lang nok prompt." }, "", { identity: identity as never });
    expect(out.data).toMatchObject({ started: false, reason: "too_many_active_jobs" });
  });
  it("use_tools gir lese-verktøyene i kontrakten (skjæres mot bakgrunnsflaten av executive-handleren), hemmeligheter fjernes fra prompt", async () => {
    submitted.length = 0;
    await transport.invoke("delegate_background_task", { title: "Med verktøy", prompt: "Se i kalenderen. sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", use_tools: true }, "", { identity: identity as never });
    const c = submitted[0] as { allowed_tools: string[]; input: { data: { prompt: string; tools: boolean } } };
    expect(c.allowed_tools).toEqual(["email", "calendar", "github", "memory", "executive.get_capability_status"]);
    expect(c.input.data.tools).toBe(true);
    expect(c.input.data.prompt).not.toContain("sk-ant-api03");
  });
  it("D-424: uten use_tools får jobben lese-verktøyene som standard; kun eksplisitt false gir ingen", async () => {
    submitted.length = 0;
    await transport.invoke("delegate_background_task", { title: "Standard", prompt: "Undersøk GitHub-sakene mine og rapporter." }, "", { identity: identity as never });
    await transport.invoke("delegate_background_task", { title: "Uten verktøy", prompt: "Skriv et dikt om høsten uten verktøy.", use_tools: false }, "", { identity: identity as never });
    const [withTools, without] = submitted as Array<{ allowed_tools: string[]; input: { data: { tools?: boolean } } }>;
    expect(withTools!.input.data.tools).toBe(true);
    expect(withTools!.allowed_tools).toEqual(["email", "calendar", "github", "memory", "executive.get_capability_status"]);
    expect(without!.input.data.tools).toBeUndefined();
    expect(without!.allowed_tools).toEqual([]);
  });
  it("renderDelivery rammer inn resultatet som data", () => {
    const base = { task_id: "t", title: "Rapport", result_text: "ferdig tekst", error: null, created_at: "", finished_at: "", delivered: false };
    expect(renderDelivery({ ...base, status: "completed" })).toContain("ikke instruksjon");
    expect(renderDelivery({ ...base, status: "failed", error: "modell nede" })).toContain("feilet: modell nede");
    expect(renderDelivery({ ...base, status: "cancelled" })).toContain("avbrutt");
  });
});

describe("executive-handler: delegerte jobber bærer sensitivitet og «ingen betalte modeller» inn i modellkallet", () => {
  it("sensitivity/paid_models_allowed fra kontrakten når gatewayen; vanlige jobber uendret", async () => {
    const { executiveHandler } = await import("../src/executive.ts");
    const seen: Array<Record<string, unknown>> = [];
    const gateway = { complete: async (input: Record<string, unknown>) => { seen.push(input); return { text: "ok", provider: "gemma_local", model: "m", usage: { input_tokens: 1, output_tokens: 1 } }; } } as never;
    const handler = executiveHandler({ gateway });
    const ctx = { assertNotCancelled: async () => undefined } as never;
    const task = (data: Record<string, unknown>) => ({ task_id: "t", tenant_id: "t1", attempts: 1, checkpoint: null, contract: { allowed_tools: [], input: { data, trust_level: "internal", provenance: "chat:s" } } }) as never;
    await handler(task({ prompt: "x", purpose: "BACKGROUND", sensitivity: "PRIVATE", paid_models_allowed: false, delegated_from_chat: true }), ctx);
    await handler(task({ prompt: "y" }), ctx);
    expect(seen[0]).toMatchObject({ purpose: "BACKGROUND", sensitivity: "PRIVATE", paid_models_allowed: false });
    expect(seen[1]).not.toHaveProperty("sensitivity");
    expect(seen[1]).not.toHaveProperty("paid_models_allowed");
  });
});
