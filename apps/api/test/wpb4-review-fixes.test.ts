import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { ClaudeBudgetEnforcer, MemoryTraceSink, ModelGateway, claudeBudgetNoteNo, classifyContentSensitivity, type CompleteInput, type ToolExecutor } from "@jarvis/model-gateway";
import type { ModelProviderAdapter, ModelRequest, ModelResult, StreamHandler } from "@jarvis/provider-adapters";
import type { ClaimedTask, InProcessWorker, JobContext, TaskService } from "@jarvis/tasks";
import type { MeshToolMapping } from "@jarvis/tool-gateway";
import { RESERVED_SUBMIT_DATA_KEYS, TasksDelegateTransport, submittedContractHasReservedKey, type ChatJobs } from "../src/chat-jobs.ts";
import { ConversationEngine } from "../src/conversation.ts";
import { executiveHandler } from "../src/executive.ts";
import { claudeBudgetRouteNote } from "../src/tool-turn-route.ts";
import { BudgetPool, MID, OWNER_PERSON, SPENT, budgetConfig } from "./support/claude-budget-pool.ts";

/**
 * WP-B4 (D-476), fikser etter den uavhengige reviewen - API-laget (notater, VIKTIG-attestering, historikk-stripping, kobling). Gateway-nivå ligger i modules/model-gateway/test/wpb4-review-fixes.test.ts.
 */
const WINDOW_END = Date.UTC(2026, 11, 14, 23, 0, 0); // 15. des 2026 00:00 Oslo
const closed = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  claude_budget: { action: "deny", level: "exhausted", tier: "essential", reason: "exhausted_closed", constraint: "closed", window_end_ms: WINDOW_END, ...extra }
});

afterEach(() => vi.unstubAllEnvs());

describe("L1: merknaden er sann - «lokale modellen» står KUN når en lokal modell svarte", () => {
  const REASONS: Array<[string, string]> = [["deny", "exhausted_closed"], ["defer", "reserve_kept_for_essential"], ["defer", "tight_background_deferred"], ["defer", "spend_unreadable_background_deferred"], ["defer", "exhausted_hard_stop_off_background_deferred"]];

  it("en lokal modell svarte: samme tekst som før («kom fra den lokale modellen»)", () => {
    expect(claudeBudgetRouteNote(closed(), "svaret", { provider: "gemma_local" })).toBe("\n\n(Claude-kreditten: perioden er brukt opp, så dette svaret kom fra den lokale modellen. Kreditten fornyes 15. desember.)");
    expect(claudeBudgetRouteNote(closed(), "jobben", { provider: "local_llm" })).toBe("(Claude-kreditten: perioden er brukt opp, så jobben kom fra den lokale modellen. Kreditten fornyes 15. desember.)");
  });

  it("en ANNEN skymodell svarte (egen preferanseliste, f.eks. openai): teksten sier aldri «lokale» - den sier at svaret ikke kom fra Claude", () => {
    for (const [action, reason] of REASONS) {
      for (const provider of ["openai", "gemini", "gemma_hosted", "noe_ukjent"]) {
        const note = claudeBudgetRouteNote(closed({ action, reason }), "svaret", { provider });
        expect(note, `${reason}/${provider}`).not.toMatch(/lokale/i);
        expect(note, `${reason}/${provider}`).toContain("kom ikke fra Claude");
        expect(note, `${reason}/${provider}`).toMatch(/^\n\n\(Claude-kreditten: /);
      }
    }
    expect(claudeBudgetRouteNote(closed(), "jobben", { provider: "openai" })).toBe("(Claude-kreditten: perioden er brukt opp, så jobben kom ikke fra Claude. Kreditten fornyes 15. desember.)");
  });

  it("ukjent hvem som svarte (ingen leverandør oppgitt): ingenting misvisende - samme nøytrale tekst, aldri «lokale»", () => {
    for (const [action, reason] of REASONS) expect(claudeBudgetRouteNote(closed({ action, reason })), reason).not.toMatch(/lokale/i);
    expect(claudeBudgetRouteNote(closed())).toContain("kom ikke fra Claude");
  });

  it("motoren: standard er lokal (uendret ordlyd), «other» bytter kun kilde-frasen - og tekstene låser seg ikke til lokal modell ved sensitivitetsklassifisering", () => {
    expect(claudeBudgetNoteNo("deny", "exhausted_closed", WINDOW_END)).toContain("kom fra den lokale modellen");
    expect(claudeBudgetNoteNo("deny", "exhausted_closed", WINDOW_END, "svaret", "other")).toContain("kom ikke fra Claude");
    for (const [action, reason] of REASONS) {
      for (const by of ["local", "other"] as const) {
        const text = claudeBudgetNoteNo(action as "deny" | "defer", reason, WINDOW_END, "jobben", by);
        expect(classifyContentSensitivity({ texts: [text] }).sensitivity, text).toBe("PUBLIC_OR_LOW_SENSITIVITY");
        expect(text).not.toMatch(/[()]/); // ingen parenteser inni (stripSystemNotes)
      }
    }
  });
});

describe("M2: VIKTIG kan ikke forfalskes - `delegated_from_chat` er en reservert nøkkel, og opphavet kommer fra den ATTESTERTE `cloud_tool_turns_allowed`", () => {
  const usage = { input_tokens: 10, output_tokens: 5 };
  const route = { provider: "anthropic", model: "claude-sonnet-5-5" };
  const TOOLS: MeshToolMapping[] = [{
    def: { name: "read_github_prs", description: "Les PR-er", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }, tool_id: "github", action: "list_pull_requests"
  } as unknown as MeshToolMapping];
  const jobCtx: JobContext = { attempts: 1, checkpoint: null, saveCheckpoint: async () => undefined, assertNotCancelled: async () => undefined };
  const task = (data: Record<string, unknown>): ClaimedTask => ({
    task_id: "task-b4-m2", tenant_id: "tenant-personal", attempts: 1, checkpoint: null,
    contract: { goal: "list PR-er", owner_person_id: "person-tobias", tenant_id: "tenant-personal", allowed_memory_spaces: ["personal"], input: { data, trust_level: "internal", provenance: "chat:s1" }, allowed_tools: ["github"] } as unknown as JobContract
  });
  function handler() {
    const seen: CompleteInput[] = [];
    const answer = { text: "Det er én åpen PR.", usage, provider: "gemma_local", model: "m", metadata: { tool_rounds: 0 } };
    const gateway = {
      claudeBudgetActive: true,
      completeWithTools: async (input: CompleteInput) => { seen.push(input); return answer; },
      complete: async (input: CompleteInput) => { seen.push(input); return answer; }
    } as unknown as ModelGateway;
    const run = executiveHandler({ gateway, tools: { all: TOOLS, executorFor: () => ({ execute: async () => { throw new Error("ikke brukt"); } }) as unknown as ToolExecutor }, toolTurnRoute: route });
    return { run, seen };
  }
  const base = { prompt: "list åpne PR-er i repoet", purpose: "BACKGROUND", sensitivity: "PRIVATE", paid_models_allowed: false, tools: true };

  it("`delegated_from_chat` er reservert for innsendte kontrakter (POST /tasks/submit): true, false, tekst, tall og null avvises alle - sammen med `cloud_tool_turns_allowed`; vanlige kontrakter og ugyldige former gir null", () => {
    expect(RESERVED_SUBMIT_DATA_KEYS).toEqual(expect.arrayContaining(["cloud_tool_turns_allowed", "delegated_from_chat"]));
    const withKey = (key: string, value: unknown) => ({ goal: "x", input: { data: { prompt: "x", [key]: value } } });
    for (const value of [true, false, "true", 1, null]) {
      expect(submittedContractHasReservedKey(withKey("delegated_from_chat", value)), String(value)).toBe("delegated_from_chat");
      expect(submittedContractHasReservedKey(withKey("cloud_tool_turns_allowed", value)), String(value)).toBe("cloud_tool_turns_allowed");
    }
    expect(submittedContractHasReservedKey({ goal: "x", input: { data: { prompt: "x", purpose: "BACKGROUND", budget_origin: "owner_task" } } })).toBeNull();
    for (const bad of [null, undefined, "x", 5, [], {}, { input: null }, { input: { data: null } }, { input: { data: "x" } }]) expect(submittedContractHasReservedKey(bad)).toBeNull();
  });

  it("en forfalsket `delegated_from_chat: true` (uten den attesterte flagget) gir IKKE opphavs-hintet - kallet er bakgrunnsarbeid; samme for flagget alene og for et `budget_origin` i kontraktdata (leses aldri)", async () => {
    const { run, seen } = handler();
    await run(task({ ...base, delegated_from_chat: true }), jobCtx); // forfalsket marker, ingen attestering
    await run(task({ ...base, cloud_tool_turns_allowed: true }), jobCtx); // flagget alene (uten marker)
    await run(task({ ...base, delegated_from_chat: true, budget_origin: "owner_task" }), jobCtx); // forsøk på å skrive opphavet selv
    await run(task({ ...base, tools: false, delegated_from_chat: true }), jobCtx); // uten verktøy
    expect(seen).toHaveLength(4);
    for (const input of seen) expect("budget_origin" in input, JSON.stringify(Object.keys(input))).toBe(false);
  });

  it("marker + attestert flagg (satt av trusted kode) gir `owner_task` (VIKTIG) - på skyruten, og også når samme jobb kjører lokalt", async () => {
    const { run, seen } = handler();
    await run(task({ ...base, delegated_from_chat: true, cloud_tool_turns_allowed: true }), jobCtx);
    await run(task({ ...base, tools: false, delegated_from_chat: true, cloud_tool_turns_allowed: true }), jobCtx);
    expect(seen).toHaveLength(2);
    for (const input of seen) expect(input.budget_origin).toBe("owner_task");
  });

  describe("modellinitiert delegering (`tasks.delegate_background_task`): modellen skriver bare tittel og prompt - nøklene settes av trusted kode ut fra turens attesterte opphav", () => {
    const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
    function transport() {
      const submitted: Array<{ input: { data: Record<string, unknown> } }> = [];
      const tasks = { submit: async (_id: unknown, contract: { task_id: string }) => { submitted.push(contract as never); return { ok: true, value: { task_id: contract.task_id } }; } };
      return { submitted, t: new TasksDelegateTransport(tasks as never, { activeCount: async () => 0 } as unknown as ChatJobs) };
    }
    const forged = { title: "Åpne PR-er", prompt: "list åpne PR-er i repoet", delegated_from_chat: true, cloud_tool_turns_allowed: true, budget_origin: "owner_task", contentOrigin: "owner_direct" };
    const invoke = (t: TasksDelegateTransport, servingModel?: { provider: string; model: string }) =>
      t.invoke("delegate_background_task", forged as never, "cred", { identity, ...(servingModel ? { servingModel } : {}) });

    it("en LOKALT betjent tur (ingen attestering): modellens påstander kopieres ikke - kontrakten har markøren fra trusted kode, men ikke flagget; jobben får aldri VIKTIG", async () => {
      const { submitted, t } = transport();
      await invoke(t, { provider: "gemma_local", model: "llama3.1:8b" });
      const data = submitted[0]!.input.data;
      expect(data["cloud_tool_turns_allowed"]).toBeUndefined();
      expect(data["budget_origin"]).toBeUndefined();
      expect(data["paid_models_allowed"]).toBe(false);
      const { run, seen } = handler();
      await run(task(data), jobCtx);
      expect(seen).toHaveLength(1);
      expect("budget_origin" in seen[0]!).toBe(false);
    });

    it("en SKYBETJENT tur (attestert av adapteren): flagget settes av trusted kode, og jobben er en bestilt oppgave (VIKTIG)", async () => {
      const { submitted, t } = transport();
      await invoke(t, { provider: "anthropic", model: "claude-sonnet-5-5" });
      const data = submitted[0]!.input.data;
      expect(data["cloud_tool_turns_allowed"]).toBe(true);
      expect(data["budget_origin"]).toBeUndefined(); // opphavet utledes først av executive-handleren ut fra attesteringen
      const { run, seen } = handler();
      await run(task(data), jobCtx);
      expect(seen[0]!.budget_origin).toBe("owner_task");
    });
  });

  it("kildevakt: executive-handleren leser opphavet fra BEGGE attesterte nøkler, og `/tasks/submit` avviser dem før submit", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(read("../src/executive.ts")).toMatch(/input\.delegated_from_chat === true && input\.cloud_tool_turns_allowed === true \? \{ budget_origin: "owner_task" as const \}/);
    const server = read("../src/server.ts");
    expect(server.indexOf('submittedContractHasReservedKey(authed.body["contract"])')).toBeGreaterThan(-1);
    expect(server.indexOf('submittedContractHasReservedKey(authed.body["contract"])')).toBeLessThan(server.indexOf('deps.tasks.submit(authed.identity, authed.body["contract"])'));
  });
});

describe("INFO: `stripSystemNotes` fjerner «(Claude-kreditten: ...)» KUN når Claude-kreditten er på - flagg AV er identisk med main", () => {
  const creditNote = claudeBudgetRouteNote(closed(), "svaret", { provider: "gemma_local" });
  const OTHER_NOTE = "\n\n(Reservemodell brukt: anthropic var ikke tilgjengelig, så dette svaret kom fra gemma_local.)";

  it("uten flagget (tom/usatt/off): en avsluttende kredittmerknad i et lagret svar står urørt i historikken (som på main); de øvrige rutemerknadene fjernes som før", async () => {
    const { stripSystemNotes } = await import("../src/tool-turn-route.ts");
    for (const value of [undefined, "", "   ", "off", "OFF"]) {
      if (value === undefined) vi.stubEnv("JARVIS_CLAUDE_BUDGET_USD", ""); else vi.stubEnv("JARVIS_CLAUDE_BUDGET_USD", value);
      expect(stripSystemNotes(`Svar.${creditNote}`), String(value)).toBe(`Svar.${creditNote}`);
      expect(stripSystemNotes(`Svar.${OTHER_NOTE}`), String(value)).toBe("Svar.");
      expect(stripSystemNotes(`Svar.${OTHER_NOTE}${creditNote}`), String(value)).toBe(`Svar.${OTHER_NOTE}${creditNote}`);
    }
  });

  it("med flagget på: kredittmerknaden fjernes (alene, flere på rad og blandet med andre rutemerknader), og en ugyldig verdi regnes som på (oppstarten stopper den uansett)", async () => {
    const { stripSystemNotes } = await import("../src/tool-turn-route.ts");
    for (const value of ["100", "42.50", "abc"]) {
      vi.stubEnv("JARVIS_CLAUDE_BUDGET_USD", value);
      expect(stripSystemNotes(`Svar.${creditNote}`), value).toBe("Svar.");
      expect(stripSystemNotes(`Svar.${creditNote}${creditNote}`), value).toBe("Svar.");
      expect(stripSystemNotes(`Svar.${OTHER_NOTE}${creditNote}`), value).toBe("Svar.");
    }
  });
});

/**
 * N1 (re-review): kredittnotatet uteble for en flerrunde chat-verktøytur og for en delegert skyrute-jobb ved hard stopp. De eksisterende testene bruker en FAKE gateway og kunne ikke se det. Her er samtalemotoren og jobbhandleren
 * ekte, gatewayen og enforceren ekte - kun leverandørene (skriptede adaptere som husker hva de fikk) og databasen (`BudgetPool`) er fakes. Perioden er 15. nov → 15. des 2026 og klokka står midt i den (se støttefilen).
 */
describe("N1 (re-review): kredittnotatet står i svaret også for flerrunde chat-verktøytur og delegert skyrute-jobb - ekte motor/handler + ekte gateway + ekte enforcer", () => {
  const ANSWER = "Du har ingen avtaler i morgen.";
  const NEUTRAL_ASK = "hva er neste punkt i kalenderen min i morgen?";
  const CHAT_TOOL = "calendar__read_events";
  const JOB_TOOL = "read_github_prs";
  const LIMITS = { max_tools_per_round: 8, max_schema_tokens: 1500, max_rounds: 4, max_calls_per_round: 4, max_total_calls: 16 };
  const usage = { input_tokens: 10, output_tokens: 5 };
  const CREDIT_ANSWER = `\n\n(Claude-kreditten: perioden er brukt opp, så dette svaret kom fra den lokale modellen. Kreditten fornyes 15. desember.)`;
  const CREDIT_JOB = "(Claude-kreditten: perioden er brukt opp, så jobben kom fra den lokale modellen. Kreditten fornyes 15. desember.)";
  const RESERVE_NOTE = "(Reservemodell brukt: anthropic var ikke tilgjengelig";
  const okExecutor = {
    execute: async (c: { tool_call_id: string; tool_name: string }) => ({ tool_call_id: c.tool_call_id, tool_name: c.tool_name, execution_id: "e1", success: true, output: { events: [] }, at: "2026-11-30T12:00:00.000Z" })
  } as unknown as ToolExecutor;
  const fakePool = (): pg.Pool => ({ connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }) }) as unknown as pg.Pool;
  const chatIdentity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
  const def = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {}, additionalProperties: false } });

  /** Runde 1 ber om verktøyet `tool`, alle senere runder gir ferdig svar. `requests` = alt adapteren faktisk mottok (kun leverandørene er fakes). */
  function scripted(name: string, model: string, tool: string, available = true): ModelProviderAdapter & { requests: ModelRequest[] } {
    const requests: ModelRequest[] = [];
    const next = (req: ModelRequest): ModelResult => {
      requests.push(req);
      return requests.length === 1
        ? ({ text: "", provider: name, model, tool_calls: [{ tool_call_id: "c1", tool_name: tool, arguments: {}, provider: name, model }], finish_reason: "tool_use", usage, latency_ms: 1 } as ModelResult)
        : ({ text: ANSWER, provider: name, model, finish_reason: "stop", usage, latency_ms: 1 } as ModelResult);
    };
    return {
      name, model, requests, available: () => available,
      complete: async (req: ModelRequest) => next(req),
      stream: async (req: ModelRequest, onEvent: StreamHandler) => {
        const r = next(req);
        if (r.text.length > 0) onEvent({ type: "text_delta", text: r.text });
        onEvent({ type: "usage", usage: r.usage });
        onEvent({ type: "finish", finish_reason: r.finish_reason ?? "stop" });
        return r;
      }
    } as unknown as ModelProviderAdapter & { requests: ModelRequest[] };
  }

  /** `credit: false` = flagget AV (ingen enforcer). `cloudAvailable: false` = Anthropic er nede/ikke konfigurert (kreditten er ikke årsaken). */
  function world(o: { credit: boolean; spent: number; tenant: string; tool: string; cloudAvailable?: boolean }) {
    const pool = new BudgetPool();
    pool.spend.set(o.tenant, o.spent);
    const trace = new MemoryTraceSink();
    const cloud = scripted("anthropic", "claude-sonnet-5-5", o.tool, o.cloudAvailable ?? true);
    const local = scripted("gemma_local", "llama3.1:8b", o.tool);
    const enforcer = o.credit ? new ClaudeBudgetEnforcer({ config: budgetConfig(), pool: pool.pg(), trace, actor_person_id: OWNER_PERSON, now: () => MID }) : undefined;
    const gateway = new ModelGateway({ pool: pool.pg(), trace, providers: [cloud, local], ...(enforcer !== undefined ? { claudeBudget: enforcer } : {}) });
    return { pool, cloud, local, gateway };
  }

  const engineOver = (gateway: ModelGateway): ConversationEngine =>
    new ConversationEngine({
      messages: new MessageStore(fakePool()), context: new ContextBuilder(fakePool()), gateway,
      tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
      toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" },
      tools: { definitions: [def(CHAT_TOOL)], executorFor: () => okExecutor, select: () => ({ definitions: [def(CHAT_TOOL)], limits: LIMITS }) }
    });

  const JOB_TOOLS: MeshToolMapping[] = [{
    def: { name: JOB_TOOL, description: "Les PR-er", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }, tool_id: "github", action: "list_pull_requests"
  } as unknown as MeshToolMapping];
  const jobCtx: JobContext = { attempts: 1, checkpoint: null, saveCheckpoint: async () => undefined, assertNotCancelled: async () => undefined };
  const jobTask = (tenant: string): ClaimedTask => ({
    task_id: "task-b4-n1", tenant_id: tenant, attempts: 1, checkpoint: null,
    contract: {
      goal: "list PR-er", owner_person_id: "person-tobias", tenant_id: tenant, allowed_memory_spaces: ["personal"], allowed_tools: ["github"],
      input: {
        data: { prompt: "list åpne PR-er i repoet", purpose: "BACKGROUND", sensitivity: "PRIVATE", paid_models_allowed: false, delegated_from_chat: true, tools: true, cloud_tool_turns_allowed: true },
        trust_level: "internal", provenance: "chat:s1"
      }
    } as unknown as JobContract
  });
  const jobHandler = (gateway: ModelGateway) => executiveHandler({ gateway, tools: { all: JOB_TOOLS, executorFor: () => okExecutor }, toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" } });

  const quiet = (): void => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  };
  afterEach(() => vi.restoreAllMocks());

  describe("chatten (ConversationEngine) - to runder ved hard stopp", () => {
    for (const streamed of [false, true]) {
      it(`${streamed ? "strøm" : "JSON"}: runde 2 er låst lokalt uten egen beslutning, men svaret har kredittnotatet - ikke «Reservemodell brukt» - og Anthropic fikk ikke ett kall`, async () => {
        quiet();
        const w = world({ credit: true, spent: SPENT.exhausted, tenant: "t1", tool: CHAT_TOOL });
        const tokens: string[] = [];
        const result = await engineOver(w.gateway).handle(chatIdentity, NEUTRAL_ASK, streamed ? (t: string) => { tokens.push(t); } : undefined);
        expect(w.cloud.requests).toHaveLength(0);
        expect(w.local.requests).toHaveLength(2); // to runder, begge lokale
        expect(result.reply).toBe(`${ANSWER}${CREDIT_ANSWER}`);
        expect(result.reply).not.toContain("Reservemodell");
        expect((result.reply.match(/Claude-kreditten:/g) ?? []).length).toBe(1);
        if (streamed) expect(tokens.join("")).toContain("Claude-kreditten:");
        expect(w.pool.audit.map((a) => a.reason)).toEqual(["exhausted_closed"]); // håndhevelsen er uendret: ÉN revisjonsrad for turen
      });
    }

    it("tale: samme rute, men ingen merknad i det som leses opp", async () => {
      quiet();
      const w = world({ credit: true, spent: SPENT.exhausted, tenant: "t1", tool: CHAT_TOOL });
      const result = await engineOver(w.gateway).handle({ ...chatIdentity, channel: "voice" }, NEUTRAL_ASK);
      expect(result.reply).toBe(ANSWER);
      expect(w.cloud.requests).toHaveLength(0);
    });

    it("kreditten er IKKE årsaken (Anthropic er nede, kreditten er sunn): den vanlige reservemerknaden står, aldri en kredittmerknad - merknaden ville vært usann", async () => {
      quiet();
      const w = world({ credit: true, spent: SPENT.on_pace, tenant: "t1", tool: CHAT_TOOL, cloudAvailable: false });
      const result = await engineOver(w.gateway).handle(chatIdentity, NEUTRAL_ASK);
      expect(result.reply).toContain(RESERVE_NOTE);
      expect(result.reply).not.toContain("Claude-kreditten");
      expect(w.local.requests).toHaveLength(2);
    });

    it("flagg AV (ingen enforcer): svaret er som før - den vanlige reservemerknaden, ingen kredittmerknad og ingen kredittspørringer", async () => {
      quiet();
      const w = world({ credit: false, spent: SPENT.exhausted, tenant: "t1", tool: CHAT_TOOL, cloudAvailable: false });
      const result = await engineOver(w.gateway).handle(chatIdentity, NEUTRAL_ASK);
      expect(result.reply).toBe(`${ANSWER}\n\n(Reservemodell brukt: anthropic var ikke tilgjengelig, så svaret kom fra den lokale modellen gemma_local.)`);
      expect(w.pool.claudeQueries()).toHaveLength(0);
      expect(w.pool.audit).toHaveLength(0);
    });
  });

  describe("delegert skyrute-jobb (executiveHandler) - kreditten stengte skyen, jobben kjørte på lokal reserve", () => {
    it("jobbteksten har kredittnotatet FORAN svaret (ruten er `local_fallback`, leverandøren lokal, Anthropic fikk ikke ett kall)", async () => {
      quiet();
      const w = world({ credit: true, spent: SPENT.exhausted, tenant: "tenant-personal", tool: JOB_TOOL });
      const out = await jobHandler(w.gateway)(jobTask("tenant-personal"), jobCtx);
      expect(w.cloud.requests).toHaveLength(0);
      expect(w.local.requests).toHaveLength(2);
      expect(out["route"]).toBe("local_fallback");
      expect(out["provider"]).toBe("gemma_local");
      expect(out["text"]).toBe(`${CREDIT_JOB}\n\n${ANSWER}`);
      expect(w.pool.audit.map((a) => a.reason)).toEqual(["exhausted_closed"]);
    });

    it("kreditten er IKKE årsaken (Anthropic er nede, kreditten er sunn): jobbteksten har ingen kredittmerknad", async () => {
      quiet();
      const w = world({ credit: true, spent: SPENT.on_pace, tenant: "tenant-personal", tool: JOB_TOOL, cloudAvailable: false });
      const out = await jobHandler(w.gateway)(jobTask("tenant-personal"), jobCtx);
      expect(out["route"]).toBe("local_fallback");
      expect(out["text"]).toBe(ANSWER);
    });

    it("flagg AV (ingen enforcer): jobbteksten er som før - ingen merknad, ingen revisjonsrad", async () => {
      quiet();
      const w = world({ credit: false, spent: SPENT.exhausted, tenant: "tenant-personal", tool: JOB_TOOL, cloudAvailable: false });
      const out = await jobHandler(w.gateway)(jobTask("tenant-personal"), jobCtx);
      expect(out["route"]).toBe("local_fallback");
      expect(out["text"]).toBe(ANSWER);
      expect(w.pool.claudeQueries()).toHaveLength(0);
      expect(w.pool.audit).toHaveLength(0);
    });

    it("en lukking som ikke er fra gatewayen gjør ingenting: en rutefeil som bare HAR samme tekst (fake gateway) gir ingen kredittmerknad", async () => {
      quiet();
      const { NoEligibleProviderError } = await import("@jarvis/model-gateway");
      const seen: string[] = [];
      const gateway = {
        completeWithTools: async (input: CompleteInput) => {
          seen.push(input.providerPreference?.[0] ?? "lokal");
          if (input.providerPreference?.[0] === "anthropic") throw new NoEligibleProviderError("provider_preference_exhausted: ingen av [anthropic] er konfigurert/kvalifisert (anthropic:budget_blocked)");
          return { text: ANSWER, usage, provider: "gemma_local", model: "m", metadata: { tool_rounds: 1 } };
        }
      } as unknown as ModelGateway;
      const out = await jobHandler(gateway)(jobTask("tenant-personal"), jobCtx);
      expect(seen).toEqual(["anthropic", "lokal"]);
      expect(out["route"]).toBe("local_fallback");
      expect(out["text"]).toBe(ANSWER);
    });
  });
});
