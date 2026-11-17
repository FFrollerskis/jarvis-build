import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { claudeBudgetNoteNo, classifyContentSensitivity, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import type { ClaimedTask, JobContext } from "@jarvis/tasks";
import type { MeshToolMapping } from "@jarvis/tool-gateway";
import { RESERVED_SUBMIT_DATA_KEYS, TasksDelegateTransport, submittedContractHasReservedKey, type ChatJobs } from "../src/chat-jobs.ts";
import { executiveHandler } from "../src/executive.ts";
import { claudeBudgetRouteNote } from "../src/tool-turn-route.ts";

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
