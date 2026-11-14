import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { NoEligibleProviderError, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import { ProviderError, type ToolCallRequest, type ToolResultMessage } from "@jarvis/provider-adapters";
import type { ClaimedTask, JobContext } from "@jarvis/tasks";
import type { MeshToolMapping } from "@jarvis/tool-gateway";
import { TasksDelegateTransport, cloudToolTurnsAllowed, submittedContractHasReservedKey, type ChatJobs } from "../src/chat-jobs.ts";
import { executiveHandler } from "../src/executive.ts";
import { jobWithheldNote } from "../src/cloud-tool-screen.ts";
import { jobDayCapNote, resolveJobToolTurnRoute } from "../src/tool-turn-route.ts";
import { classifyContentSensitivity } from "@jarvis/model-gateway";
// @ts-expect-error - ren .mjs uten typer (genererer compose-blokkene)
import { SERVICE_ENV } from "../../../infra/local/service-env.mjs";

/**
 * D-449 (Q-50, eierens ja 2026-10-08): delegerte bakgrunnsjobber MED verktøy bruker chattens skyrute (D-431, standard Sonnet 5.5) under samme dagstak (D-432). NAS-test 4: jobben kjørte på
 * `llama3.1:8b` og endte med GitHub 404. Økonomi/helse/hemmeligheter forblir kun lokale (D-378), og en jobb som ikke er delegert fra chat har uendret ruting.
 */
const route = { provider: "anthropic", model: "claude-sonnet-5-5" };
const TOOLS: MeshToolMapping[] = [
  {
    def: { name: "read_github_prs", description: "Les PR-er", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
    tool_id: "github",
    action: "list_pull_requests"
  } as unknown as MeshToolMapping
];
const ctx: JobContext = { attempts: 1, checkpoint: null, saveCheckpoint: async () => undefined, assertNotCancelled: async () => undefined };
const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };

function makeTask(data: Record<string, unknown>, tenant = "tenant-personal", memorySpaces: string[] = ["personal"], goal = "list PR-er"): ClaimedTask {
  return {
    task_id: "task-d449-1",
    tenant_id: tenant,
    contract: {
      goal, owner_person_id: "person-tobias", tenant_id: tenant, allowed_memory_spaces: memorySpaces,
      input: { data, trust_level: "internal", provenance: "chat:s1" }, allowed_tools: ["github"]
    } as unknown as JobContract,
    attempts: 1,
    checkpoint: null
  };
}
/** Slik chatten bygger en delegert verktøyjobb (chat-jobs.ts), med eller uten skyflagget. */
const delegated = (extra: Record<string, unknown> = {}, flag = true): Record<string, unknown> => ({
  prompt: "list åpne PR-er i repoet", purpose: "BACKGROUND", sensitivity: "PRIVATE", paid_models_allowed: false, delegated_from_chat: true, tools: true,
  ...(flag ? { cloud_tool_turns_allowed: true } : {}), ...extra
});

type GatewayCall = { input: CompleteInput; tools: unknown[]; executor: ToolExecutor };
type Behaviour = (call: GatewayCall, index: number) => Promise<Record<string, unknown>>;
const okResult = (provider: string, model: string) => ({ text: "Det er én åpen PR (#301).", usage: { input_tokens: 10, output_tokens: 5 }, provider, model, metadata: { tool_rounds: 1 } });

function build(opts: {
  behaviours?: Behaviour[];
  dayCap?: { cap_ore: number; spentToday(t: string): Promise<number> } | null;
  route?: { provider: string; model?: string } | null;
  /** Overstyrer det trusted executoren svarer (f.eks. et minnesøk med sensitive treff). */
  executorResult?: (call: ToolCallRequest) => Partial<ToolResultMessage>;
}) {
  const calls: GatewayCall[] = [];
  const plain: CompleteInput[] = [];
  const executed: string[] = [];
  const executor: ToolExecutor = {
    async execute(call: ToolCallRequest, c): Promise<ToolResultMessage> {
      executed.push(c.idempotency_key);
      return {
        tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: c.idempotency_key, success: true, output: { prs: [] }, at: new Date().toISOString(),
        ...(opts.executorResult ? opts.executorResult(call) : {})
      };
    }
  };
  const executorFor = vi.fn(() => executor);
  const gateway = {
    completeWithTools: async (input: CompleteInput, o: { tools: unknown[]; executor: ToolExecutor }) => {
      const call = { input, tools: o.tools, executor: o.executor };
      calls.push(call);
      const behaviour = opts.behaviours?.[calls.length - 1];
      return behaviour ? behaviour(call, calls.length - 1) : okResult(call.input.providerPreference ? "anthropic" : "gemma_local", call.input.providerPreference ? "claude-sonnet-5-5" : "llama3.1:8b");
    },
    complete: async (input: CompleteInput) => { plain.push(input); return okResult("gemma_local", "llama3.1:8b"); }
  } as unknown as ModelGateway;
  const handler = executiveHandler({
    gateway,
    tools: { all: TOOLS, executorFor },
    ...(opts.route !== undefined ? { toolTurnRoute: opts.route } : { toolTurnRoute: route }),
    ...(opts.dayCap !== undefined ? { toolTurnDayCap: opts.dayCap } : {})
  });
  return { handler, calls, plain, executed, executorFor };
}

let logSpy: ReturnType<typeof vi.spyOn> | undefined;
let errSpy: ReturnType<typeof vi.spyOn> | undefined;
function captureLogs(): { logs: () => Array<Record<string, unknown>>; errors: () => Array<Record<string, unknown>> } {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const parse = (spy: ReturnType<typeof vi.spyOn>) => () =>
    spy.mock.calls.map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return {}; } });
  return { logs: parse(logSpy), errors: parse(errSpy) };
}
afterEach(() => { logSpy?.mockRestore(); errSpy?.mockRestore(); logSpy = undefined; errSpy = undefined; });

describe("D-449: skyrute for delegerte verktøyjobber (executive-handler)", () => {
  it("delegert + tillatt + rute → skyleverandør og modell som chatten, uten paid-nekt, sensitivitet bevart, og ruten står i resultatet og loggen", async () => {
    const { logs } = captureLogs();
    const h = build({});
    const result = await h.handler(makeTask(delegated()), ctx);
    expect(h.calls).toHaveLength(1);
    const input = h.calls[0]!.input;
    expect(input.providerPreference).toEqual(["anthropic"]);
    expect(input.request.model).toBe("claude-sonnet-5-5");
    expect("paid_models_allowed" in input).toBe(false);
    expect(input.sensitivity).toBe("PRIVATE");
    expect(input.purpose).toBe("BACKGROUND");
    expect(input.tenant_id).toBe("tenant-personal");
    expect(result["route"]).toBe("cloud");
    expect(result["provider"]).toBe("anthropic");
    expect(result["text"]).toBe("Det er én åpen PR (#301).");
    expect(logs().filter((l) => l["msg"] === "d449_job_tool_route")).toEqual([{ msg: "d449_job_tool_route", task_id: "task-d449-1", route: "cloud", provider: "anthropic", model: "claude-sonnet-5-5" }]);
    expect(h.executorFor).toHaveBeenCalledTimes(1);
  });

  it("uten kontraktens skyflagg (oppgaveteksten var følsom) → uendret lokal ruting: paid-nekt bevart, ingen preferanse, ingen route-felt", async () => {
    captureLogs();
    const h = build({});
    const result = await h.handler(makeTask(delegated({}, false)), ctx);
    const input = h.calls[0]!.input;
    expect(input.providerPreference).toBeUndefined();
    expect(input.request.model).toBeUndefined();
    expect(input.paid_models_allowed).toBe(false);
    expect("route" in result).toBe(false);
  });

  it("ikke delegert fra chat, skrudd av rute, ingen verktøy eller følsom/ukjent sensitivitet i kontrakten → alltid uendret (fail-closed)", async () => {
    captureLogs();
    const notDelegated = build({});
    await notDelegated.handler(makeTask(delegated({ delegated_from_chat: undefined })), ctx);
    expect(notDelegated.calls[0]!.input.providerPreference).toBeUndefined();

    const off = build({ route: null });
    await off.handler(makeTask(delegated()), ctx);
    expect(off.calls[0]!.input.providerPreference).toBeUndefined();

    const noTools = build({});
    await noTools.handler(makeTask(delegated({ tools: undefined })), ctx);
    expect(noTools.calls).toHaveLength(0);
    expect(noTools.plain[0]?.paid_models_allowed).toBe(false);
    expect(noTools.plain[0]?.providerPreference).toBeUndefined();

    for (const sensitivity of ["SECRET_RESTRICTED", undefined, "ukjent"]) {
      const h = build({});
      await h.handler(makeTask(delegated({ sensitivity })), ctx);
      expect(h.calls[0]!.input.providerPreference, String(sensitivity)).toBeUndefined();
    }
  });

  it("forsvar i dybden: en kontrakt med skyflagg og PRIVATE, men en økonomi-/helse-/hemmelighetsprompt, går likevel lokalt (workeren klassifiserer oppgaveteksten selv)", async () => {
    captureLogs();
    for (const prompt of ["sjekk saldoen min og list PR-er", "oppsummer legetime og diagnose", "bruk kontonummer 1234.56.78901 til å finne e-posten", "finn e-postene fra banken forrige måned", "gå gjennom abonnementene mine"]) {
      const h = build({});
      const result = await h.handler(makeTask(delegated({ prompt })), ctx);
      expect(h.calls[0]!.input.providerPreference, prompt).toBeUndefined();
      expect(h.calls[0]!.input.paid_models_allowed, prompt).toBe(false);
      expect("route" in result, prompt).toBe(false);
    }
  });

  it("forsvar i dybden: en sensitiv tittel (`goal`) med nøytral prompt går likevel lokalt (workeren klassifiserer tittelen også, som delegeringen gjør)", async () => {
    captureLogs();
    const h = build({});
    const result = await h.handler(makeTask(delegated(), "tenant-personal", ["personal"], "Sjekk saldoen min"), ctx);
    expect(h.calls[0]!.input.providerPreference).toBeUndefined();
    expect("route" in result).toBe(false);
    const ok = build({});
    expect((await ok.handler(makeTask(delegated(), "tenant-personal", ["personal"], "Åpne PR-er"), ctx))["route"]).toBe("cloud");
  });

  it("forsvar i dybden: kontrakten gir jobben tilgang til helse-minnet → lokalt selv med flagg og nøytral prompt (minnerommet klassifiseres også her)", async () => {
    captureLogs();
    for (const spaces of [["health"], ["personal", "health"]]) {
      const h = build({});
      const result = await h.handler(makeTask(delegated(), "tenant-personal", spaces), ctx);
      expect(h.calls[0]!.input.providerPreference, spaces.join(",")).toBeUndefined();
      expect(h.calls[0]!.input.paid_models_allowed, spaces.join(",")).toBe(false);
      expect("route" in result, spaces.join(",")).toBe(false);
    }
    // Kontroll: et vanlig personlig/forretningsrom blokkerer ikke skyruten.
    for (const spaces of [["personal"], ["business"]]) {
      const h = build({});
      expect((await h.handler(makeTask(delegated(), "tenant-personal", spaces), ctx))["route"], spaces.join(",")).toBe("cloud");
    }
  });

  it("merknaden foran svaret + svaret avkortes til 4000 tegn totalt (merknaden mistes aldri bak et langt svar)", async () => {
    captureLogs();
    const long = "x".repeat(6000);
    const h = build({
      dayCap: { cap_ore: 3000, spentToday: async () => 3000 },
      behaviours: [async () => ({ ...okResult("gemma_local", "llama3.1:8b"), text: long })]
    });
    const result = await h.handler(makeTask(delegated()), ctx);
    const text = String(result["text"]);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.startsWith("(Dagstaket for sky")).toBe(true);
    expect(text.slice(0, 1500)).toContain("Dagstaket for sky");
  });

  it("dagstak: under taket → sky og kostnaden leses for riktig tenant; nådd eller ulesbart tak → lokal med merknad i svaret, aldri ubegrenset sky", async () => {
    const { logs, errors } = captureLogs();
    const seen: string[] = [];
    const under = build({ dayCap: { cap_ore: 3000, spentToday: async (t) => { seen.push(t); return 1200; } } });
    expect((await under.handler(makeTask(delegated(), "tenant-x"), ctx))["route"]).toBe("cloud");
    expect(seen).toEqual(["tenant-x"]);

    const reached = build({ dayCap: { cap_ore: 3000, spentToday: async () => 3000 } });
    const r1 = await reached.handler(makeTask(delegated()), ctx);
    expect(reached.calls[0]!.input.providerPreference).toBeUndefined();
    expect(reached.calls[0]!.input.paid_models_allowed).toBe(false);
    expect(r1["route"]).toBe("local_cap");
    // Merknaden står FORAN svaret (leveringsvisningen avkorter svaret bakfra til 1500 tegn, så en merknad bakerst kunne forsvunnet).
    expect(String(r1["text"]).startsWith("(Dagstaket for sky på 30 kr er nådd i dag, så jobben kjørte på den lokale modellen.")).toBe(true);
    expect(String(r1["text"])).toContain("Det er én åpen PR (#301).");

    const unreadable = build({ dayCap: { cap_ore: 3000, spentToday: async () => { throw new Error("db nede"); } } });
    const r2 = await unreadable.handler(makeTask(delegated()), ctx);
    expect(r2["route"]).toBe("local_cap");
    expect(unreadable.calls[0]!.input.providerPreference).toBeUndefined();
    expect(errors().some((l) => l["msg"] === "d449_job_day_cap_spend_unreadable_local")).toBe(true);
    expect(logs().filter((l) => l["msg"] === "d449_job_tool_route").map((l) => l["route"])).toEqual(["cloud", "local_cap", "local_cap"]);

    const none = build({ dayCap: null });
    expect((await none.handler(makeTask(delegated()), ctx))["route"]).toBe("cloud");
  });

  it("dagstaket leses ikke for jobber som uansett kjører lokalt (uten flagg eller uten verktøy)", async () => {
    captureLogs();
    let reads = 0;
    const dayCap = { cap_ore: 1, spentToday: async () => { reads += 1; return 999_999; } };
    await build({ dayCap }).handler(makeTask(delegated({}, false)), ctx);
    await build({ dayCap }).handler(makeTask(delegated({ tools: undefined })), ctx);
    expect(reads).toBe(0);
  });

  it("skyen nede FØR noe verktøy er utført (tidsavbrudd, nett, kvote, ikke konfigurert, ubrukelig svar, ingen kvalifisert leverandør) → lokal fallback, logget, samme executor", async () => {
    const { errors } = captureLogs();
    const failures: Array<() => Error> = [
      ...(["timeout", "network", "server", "rate_limit", "not_configured", "invalid_response"] as const).map((kind) => () => new ProviderError("anthropic", kind, `${kind}!`)),
      () => new NoEligibleProviderError("provider_preference_exhausted: ingen av [anthropic] er konfigurert/kvalifisert")
    ];
    for (const failure of failures) {
      const h = build({ behaviours: [async () => { throw failure(); }] });
      const result = await h.handler(makeTask(delegated()), ctx);
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1]!.input.providerPreference).toBeUndefined();
      expect(h.calls[1]!.input.paid_models_allowed).toBe(false);
      expect(result["route"]).toBe("local_fallback");
      expect(result["provider"]).toBe("gemma_local");
      expect(h.executorFor).toHaveBeenCalledTimes(1);
    }
    expect(errors().filter((l) => l["msg"] === "d449_job_cloud_tools_failed_fallback_local")).toHaveLength(failures.length);
  });

  it("etter at et verktøy er utført gjentas aldri jobben: feilen går videre (ærlig feil), ingen lokal gjentakelse", async () => {
    captureLogs();
    const h = build({
      behaviours: [async (call) => {
        await call.executor.execute({ tool_call_id: "c1", tool_name: "read_github_prs", arguments: {}, provider: "anthropic", model: "m" } as ToolCallRequest,
          { idempotency_key: "k1" } as never);
        throw new ProviderError("anthropic", "timeout", "etter verktøyet");
      }]
    });
    await expect(h.handler(makeTask(delegated()), ctx)).rejects.toMatchObject({ kind: "timeout" });
    expect(h.calls).toHaveLength(1);
    expect(h.executed).toEqual(["k1"]);
  });

  it("andre feil enn «ruten er nede» (auth, bad_request, annen leverandør, ukjent feil) faller ikke tilbake - jobben feiler ærlig", async () => {
    captureLogs();
    const errs: Error[] = [
      new ProviderError("anthropic", "auth", "ugyldig nøkkel"),
      new ProviderError("anthropic", "bad_request", "ugyldig forespørsel"),
      new ProviderError("gemma_local", "timeout", "en ANNEN leverandør"),
      new Error("noe helt annet"),
      new NoEligibleProviderError("paid_models_disabled: noe annet")
    ];
    for (const err of errs) {
      const h = build({ behaviours: [async () => { throw err; }] });
      await expect(h.handler(makeTask(delegated()), ctx), err.message).rejects.toBe(err);
      expect(h.calls).toHaveLength(1);
    }
  });

  it("loggene inneholder aldri oppgaveteksten eller svartekst (kun id, rute, leverandør og modell)", async () => {
    const { logs, errors } = captureLogs();
    const h = build({ behaviours: [async () => { throw new ProviderError("anthropic", "timeout", "innhold: list åpne PR-er i repoet"); }] });
    await h.handler(makeTask(delegated()), ctx);
    const all = JSON.stringify([...logs(), ...errors()]);
    expect(all).not.toContain("list åpne PR-er");
    expect(all).not.toContain("Det er én åpen PR");
  });
});

describe("D-449: verktøyresultater til skymodellen skjermes (revisjonsfunn: minnesøk uten filter)", () => {
  const memoryCall = { tool_call_id: "m1", tool_name: "search_my_memory", arguments: { query: "meg" }, provider: "anthropic", model: "claude-sonnet-5-5" } as ToolCallRequest;
  const item = (id: string, extra: Record<string, unknown> = {}) => ({ memory_item_id: id, kind: "item", subject: "tobias.hobby", content: "Liker å gå på ski", type: "semantic", space: "personal", sensitivity: "normal", ...extra });
  const memoryOutput = [
    item("ok1"),
    item("sensitiv1", { sensitivity: "sensitive" }),
    item("spesial1", { sensitivity: "special", content: "Noe særlig følsomt" }),
    item("helse1", { space: "health", content: "Noe i helserommet" }),
    item("tekst1", { content: "Tobias har fått en ny diagnose" })
  ];
  const memoryResult = () => ({ source: "memory.search", output: memoryOutput });
  /** Gatewayen kaller executoren slik modellen ville gjort; vi returnerer det modellen (skyen) faktisk får se. */
  const askMemory: Behaviour = async (call) => {
    const seen = await call.executor.execute(memoryCall, { idempotency_key: "m-k1" } as never);
    seenByModel.push(seen);
    return okResult(call.input.providerPreference ? "anthropic" : "gemma_local", call.input.providerPreference ? "claude-sonnet-5-5" : "llama3.1:8b");
  };
  let seenByModel: ToolResultMessage[] = [];
  const idsOf = (out: unknown): string[] => ((out as { results?: Array<{ memory_item_id: string }> }).results ?? (out as Array<{ memory_item_id: string }>)).map((i) => i.memory_item_id);

  it("skyruten: treff merket special, i helse-rommet eller med helse-/økonomitekst holdes tilbake; vanlige og «sensitive» treff beholdes; modellen får beskjed om at noe ble holdt tilbake", async () => {
    const { logs } = captureLogs();
    seenByModel = [];
    const h = build({ behaviours: [askMemory], executorResult: memoryResult });
    const result = await h.handler(makeTask(delegated()), ctx);
    expect(result["route"]).toBe("cloud");
    expect(idsOf(seenByModel[0]!.output)).toEqual(["ok1", "sensitiv1"]);
    expect((seenByModel[0]!.output as { withheld_count: number }).withheld_count).toBe(3);
    expect(JSON.stringify(seenByModel[0]!.output)).not.toMatch(/Noe særlig følsomt|Noe i helserommet|ny diagnose/);
    // Eieren får en synlig merknad FORAN svaret (aldri en stille innskrenking).
    expect(String(result["text"]).startsWith(jobWithheldNote())).toBe(true);
    // Loggen har verktøy og antall, aldri innhold.
    const withheldLog = logs().filter((l) => l["msg"] === "d449_job_cloud_tool_output_withheld");
    expect(withheldLog).toEqual([{ msg: "d449_job_cloud_tool_output_withheld", task_id: "task-d449-1", tool: "memory.search", withheld: 3 }]);
    expect(JSON.stringify(logs())).not.toMatch(/Liker å gå på ski|diagnose/);
  });

  it("lokale ruter (dagstak, fallback, ingen skyflagg) ser ALT: lokal modell har lov til følsomt innhold (D-378), og ingen merknad legges til", async () => {
    captureLogs();
    // Dagstaket nådd → lokal rute med uskjermet executor.
    seenByModel = [];
    const capped = build({ behaviours: [askMemory], executorResult: memoryResult, dayCap: { cap_ore: 3000, spentToday: async () => 3000 } });
    const r1 = await capped.handler(makeTask(delegated()), ctx);
    expect(r1["route"]).toBe("local_cap");
    expect(idsOf(seenByModel[0]!.output)).toHaveLength(5);
    expect(String(r1["text"])).not.toContain(jobWithheldNote());

    // Uten skyflagg (følsom oppgavetekst) → ordinær lokal rute, uskjermet.
    seenByModel = [];
    const noFlag = build({ behaviours: [askMemory], executorResult: memoryResult });
    await noFlag.handler(makeTask(delegated({}, false)), ctx);
    expect(idsOf(seenByModel[0]!.output)).toHaveLength(5);

    // Skyen nede før noe er utført → lokal fallback med uskjermet executor (ingenting nådde skyen).
    seenByModel = [];
    const fallback = build({ behaviours: [async () => { throw new ProviderError("anthropic", "timeout", "nede"); }, askMemory], executorResult: memoryResult });
    const r3 = await fallback.handler(makeTask(delegated()), ctx);
    expect(r3["route"]).toBe("local_fallback");
    expect(idsOf(seenByModel[0]!.output)).toHaveLength(5);
  });

  it("andre verktøy (GitHub/e-post/kalender) passerer urørt også på skyruten - samme oppførsel som chattens verktøyturer (D-431), dokumentert avgrensning (Q-52)", async () => {
    captureLogs();
    seenByModel = [];
    const emailText = { emails: [{ subject: "Din legetime i morgen", snippet: "saldo" }] };
    const h = build({
      behaviours: [async (call) => {
        seenByModel.push(await call.executor.execute({ ...memoryCall, tool_name: "read_github_prs" } as ToolCallRequest, { idempotency_key: "g1" } as never));
        return okResult("anthropic", "claude-sonnet-5-5");
      }],
      executorResult: () => ({ source: "email.read_inbox", output: emailText })
    });
    const result = await h.handler(makeTask(delegated()), ctx);
    expect(result["route"]).toBe("cloud");
    expect(seenByModel[0]!.output).toEqual(emailText);
    expect(String(result["text"])).toBe("Det er én åpen PR (#301).");
  });
});

describe("D-449: delegeringens kontrakt (TasksDelegateTransport)", () => {
  function transport() {
    const submitted: Array<{ input: { data: Record<string, unknown> } } & Record<string, unknown>> = [];
    const tasks = { submit: async (_id: unknown, contract: { task_id: string }) => { submitted.push(contract as never); return { ok: true, value: { task_id: contract.task_id } }; } };
    const jobs = { activeCount: async () => 0 } as unknown as ChatJobs;
    return { submitted, t: new TasksDelegateTransport(tasks as never, jobs) };
  }
  type Trusted = { servingModel?: { provider: string; model: string }; contentOrigin?: "owner_direct"; identity?: IdentityContext };
  const invoke = (t: TasksDelegateTransport, params: Record<string, unknown>, trusted: Trusted = {}) =>
    t.invoke("delegate_background_task", params as never, "cred", { identity: trusted.identity ?? identity, ...(trusted.servingModel ? { servingModel: trusted.servingModel } : {}), ...(trusted.contentOrigin ? { contentOrigin: trusted.contentOrigin } : {}) });
  const sonnet = { provider: "anthropic", model: "claude-sonnet-5-5" };
  const ollama = { provider: "gemma_local", model: "llama3.1:8b" };
  const base = { title: "Åpne PR-er", prompt: "list åpne PR-er", memorySpaces: ["personal"] as const };

  it("verktøyjobb med nøytral oppgave fra en skybetjent tur får skyflagget, og basiskontrakten (lokal først) er uendret", async () => {
    const { submitted, t } = transport();
    await invoke(t, { title: "Åpne PR-er", prompt: "list åpne PR-er i repoet" }, { servingModel: sonnet });
    const data = submitted[0]!.input.data;
    expect(data).toMatchObject({ sensitivity: "PRIVATE", paid_models_allowed: false, delegated_from_chat: true, tools: true, cloud_tool_turns_allowed: true });
  });

  it("følsom oppgavetekst (økonomi/helse/hemmelighet) eller jobb uten verktøy → ingen skyflagg, uansett hvem som betjente turen", async () => {
    for (const prompt of ["sjekk saldoen min og lag en oppsummering", "oppsummer legetime og diagnose-notatene mine", "finn kontonummer 1234.56.78901 i e-postene"]) {
      const { submitted, t } = transport();
      await invoke(t, { title: "Oppsummering", prompt }, { servingModel: sonnet });
      expect(submitted[0]!.input.data["cloud_tool_turns_allowed"], prompt).toBeUndefined();
      expect(submitted[0]!.input.data["paid_models_allowed"]).toBe(false);
    }
    const { submitted, t } = transport();
    const noTools = await invoke(t, { title: "Uten verktøy", prompt: "skriv en kort hilsen til teamet", use_tools: false }, { servingModel: sonnet });
    expect(submitted[0]!.input.data["cloud_tool_turns_allowed"]).toBeUndefined();
    expect(submitted[0]!.input.data["tools"]).toBeUndefined();
    expect((noTools.data as Record<string, unknown>)["cloud_tool_turns"]).toBe(false);
  });

  it("opphav: skybetjent tur → tillatt; lokal eller ukjent modell → nei; hurtigbane (owner_direct) → tillatt; UTEN modell og UTEN eier-merke (f.eks. en eier-godkjent bekreftelse) → nei (fail-closed)", () => {
    expect(cloudToolTurnsAllowed({ ...base, servingModel: sonnet, contentOrigin: undefined })).toBe(true);
    expect(cloudToolTurnsAllowed({ ...base, servingModel: ollama, contentOrigin: undefined })).toBe(false);
    expect(cloudToolTurnsAllowed({ ...base, servingModel: { provider: "local_llm", model: "x" }, contentOrigin: undefined })).toBe(false);
    expect(cloudToolTurnsAllowed({ ...base, servingModel: { provider: "ukjent_leverandor", model: "x" }, contentOrigin: undefined })).toBe(false);
    expect(cloudToolTurnsAllowed({ ...base, servingModel: undefined, contentOrigin: "owner_direct" })).toBe(true);
    expect(cloudToolTurnsAllowed({ ...base, servingModel: undefined, contentOrigin: undefined })).toBe(false);
    // Modellen vinner: en lokalbetjent tur blir aldri «betrodd» av et eier-merke.
    expect(cloudToolTurnsAllowed({ ...base, servingModel: ollama, contentOrigin: "owner_direct" })).toBe(false);
  });

  it("innholdet slår opphavet: økonomi/helse i teksten eller helse-minnerommet → nei, også for en skybetjent tur og for hurtigbanen", () => {
    for (const origin of [{ servingModel: sonnet, contentOrigin: undefined }, { servingModel: undefined, contentOrigin: "owner_direct" as const }]) {
      expect(cloudToolTurnsAllowed({ ...base, ...origin, title: "Økonomi", prompt: "hva er saldoen min" })).toBe(false);
      expect(cloudToolTurnsAllowed({ ...base, ...origin, title: "Sjekk saldoen min", prompt: "list åpne PR-er" })).toBe(false); // sensitiv TITTEL, nøytral prompt
      // D-381-paritet (gjennomgang nr. 3): ord som får chatten til å velge et finansverktøy, men som klassifiseringen ikke kjenner, holder også jobben lokal - i tittel eller prompt.
      for (const text of ["Finn alle e-postene fra banken forrige måned", "Gå gjennom utgiftene og abonnementene mine", "Finn kvitteringene for bankkortet"]) {
        expect(classifyContentSensitivity({ texts: [text] }).sensitivity, text).not.toBe("SECRET_RESTRICTED");
        expect(cloudToolTurnsAllowed({ ...base, ...origin, title: "Oppsummering", prompt: text }), text).toBe(false);
        expect(cloudToolTurnsAllowed({ ...base, ...origin, title: text.slice(0, 60), prompt: "oppsummer det" }), text).toBe(false);
      }
      // Q-52 A (D-450): «kontoutskriften» er nå også kjent av klassifiseringen (var et kjent hull her); jobben er lokal uansett hvilken av de to portene som fanger den.
      const statement = "Sjekk kontoutskriften fra DNB";
      expect(classifyContentSensitivity({ texts: [statement] }).sensitivity).toBe("SECRET_RESTRICTED");
      expect(cloudToolTurnsAllowed({ ...base, ...origin, title: "Oppsummering", prompt: statement })).toBe(false);
      expect(cloudToolTurnsAllowed({ ...base, ...origin, title: statement, prompt: "oppsummer det" })).toBe(false);
      expect(cloudToolTurnsAllowed({ ...base, ...origin, prompt: "list PR-er" , memorySpaces: ["health"] })).toBe(false);
      expect(cloudToolTurnsAllowed({ ...base, ...origin, prompt: "list PR-er", memorySpaces: ["personal", "health"] })).toBe(false);
      expect(cloudToolTurnsAllowed({ ...base, ...origin, memorySpaces: ["personal"] })).toBe(true);
      expect(cloudToolTurnsAllowed({ ...base, ...origin, memorySpaces: ["business"] })).toBe(true);
    }
  });

  it("ende til ende gjennom transporten: lokalbetjent tur, bekreftelsesvei (hverken modell eller eier-merke) og helse-minnerom → ingen skyflagg; skybetjent tur og hurtigbane → flagg", async () => {
    const run = async (trusted: Trusted, params: Record<string, unknown> = { title: "Åpne PR-er", prompt: "list åpne PR-er i repoet" }) => {
      const { submitted, t } = transport();
      const result = await invoke(t, params, trusted);
      const flag = submitted[0]!.input.data["cloud_tool_turns_allowed"];
      // Gjennomgang nr. 4: transporten melder tilbake NØYAKTIG det den satte i kontrakten (`cloud_tool_turns`), så hurtigbanen kan si fra når jobben likevel kjører lokalt.
      expect((result.data as Record<string, unknown>)["cloud_tool_turns"], JSON.stringify(trusted)).toBe(flag === true);
      return flag;
    };
    expect(await run({ servingModel: ollama })).toBeUndefined();
    expect(await run({})).toBeUndefined(); // bekreftelsesveien i server.ts (/confirmations) kaller gatewayen uten modell og uten eier-merke
    expect(await run({ servingModel: sonnet })).toBe(true);
    expect(await run({ contentOrigin: "owner_direct" })).toBe(true);
    expect(await run({ contentOrigin: "owner_direct", identity: { ...identity, memory_space_id: "health" } })).toBeUndefined();
  });

  it("modellen kan ikke sette opphavet selv: eier-merket kommer aldri fra parametere (et `contentOrigin`-felt i parameterne er bare støy og ignoreres)", async () => {
    const { submitted, t } = transport();
    await invoke(t, { title: "Åpne PR-er", prompt: "list åpne PR-er i repoet", contentOrigin: "owner_direct", cloud_tool_turns_allowed: true }, {});
    expect(submitted[0]!.input.data["cloud_tool_turns_allowed"]).toBeUndefined();
  });
});

describe("D-449: forfalskning og merknader", () => {
  it("en innsendt kontrakt som bærer `cloud_tool_turns_allowed` kan oppdages (brukes av POST /tasks/submit); vanlige kontrakter og ugyldige former gir null", () => {
    const withFlag = (value: unknown) => ({ input: { data: { prompt: "x", cloud_tool_turns_allowed: value } } });
    for (const value of [true, false, "true", 1, null]) expect(submittedContractHasReservedKey(withFlag(value)), String(value)).toBe("cloud_tool_turns_allowed");
    expect(submittedContractHasReservedKey({ input: { data: { prompt: "x", delegated_from_chat: true } } })).toBeNull();
    for (const bad of [null, undefined, "x", 5, [], {}, { input: null }, { input: { data: null } }, { input: { data: "x" } }]) expect(submittedContractHasReservedKey(bad)).toBeNull();
  });

  it("merknadene som legges i jobbens svar (og dermed i samtalehistorikken) kan aldri selv låse samtalen til lokal modell", () => {
    for (const note of [jobWithheldNote(), jobDayCapNote(3000), jobDayCapNote(1)]) {
      expect(classifyContentSensitivity({ texts: [note] }).sensitivity, note).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    }
  });

  it("jobb-bryteren: tom = chattens rute; off = jobber lokalt (chatten urørt); egen modell = egen rute; ugyldig = av (aldri en tilfeldig modell)", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const chat = { provider: "anthropic", model: "claude-sonnet-5-5" };
    expect(resolveJobToolTurnRoute(undefined, chat)).toEqual(chat);
    expect(resolveJobToolTurnRoute("", chat)).toEqual(chat);
    expect(resolveJobToolTurnRoute("   ", chat)).toEqual(chat);
    expect(resolveJobToolTurnRoute("off", chat)).toBeNull();
    expect(resolveJobToolTurnRoute("local", chat)).toBeNull();
    expect(resolveJobToolTurnRoute("anthropic:claude-haiku-4-5-20251001", chat)).toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    expect(resolveJobToolTurnRoute("noe rart", chat)).toBeNull();
    // Chatten av betyr ikke at jobber er av hvis jobb-bryteren eksplisitt sier noe annet, og tom jobb-bryter følger en avskrudd chat.
    expect(resolveJobToolTurnRoute(undefined, null)).toBeNull();
    expect(resolveJobToolTurnRoute("anthropic:claude-sonnet-5-5", null)).toEqual(chat);
  });
});

describe("D-449: oppkobling (kildevakt)", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("worker-containeren og api sender jobbrute og dagstak til executive-handleren, og rute/tak er parset FØR handleren konstrueres", () => {
    const worker = read("../src/worker-main.ts");
    expect(worker).toMatch(/executiveHandler\(\{\s*gateway,\s*toolTurnRoute: jobToolTurnRoute,\s*toolTurnDayCap: jobToolTurnRoute !== null && jobToolTurnDailyCapOre > 0 \? \{ cap_ore: jobToolTurnDailyCapOre, spentToday: \(tenantId\) => dailySpentOre\(pool, tenantId\) \} : null,/);
    expect(worker.indexOf("const jobToolTurnRoute = resolveJobToolTurnRoute(")).toBeGreaterThan(-1);
    expect(worker.indexOf("const jobToolTurnRoute = resolveJobToolTurnRoute(")).toBeLessThan(worker.indexOf("executiveHandler({"));
    expect(worker).toContain('process.env["JARVIS_JOB_TOOL_TURN_MODEL"]');
    expect(worker).toContain('parseToolTurnRoute(process.env["JARVIS_TOOL_TURN_MODEL"])');
    expect(worker).toContain('parseDailyCapOre(process.env["JARVIS_TOOL_TURN_DAILY_CAP_ORE"])');

    const main = read("../src/main.ts");
    expect(main).toMatch(/executiveHandler\(\{\s*gateway,\s*toolTurnRoute: jobToolTurnRoute,\s*toolTurnDayCap: jobToolTurnRoute !== null && toolTurnDailyCapOre > 0 \? \{ cap_ore: toolTurnDailyCapOre, spentToday: \(tenantId\) => dailySpentOre\(pool, tenantId\) \} : null,/);
    expect(main.indexOf("const jobToolTurnRoute = resolveJobToolTurnRoute(")).toBeGreaterThan(-1);
    expect(main.indexOf("const jobToolTurnRoute = resolveJobToolTurnRoute(")).toBeLessThan(main.indexOf("executiveHandler({"));
    expect(main).toContain('process.env["JARVIS_JOB_TOOL_TURN_MODEL"]');
    expect(main.match(/const toolTurnRoute = parseToolTurnRoute\(/g)).toHaveLength(1);
    expect(main.match(/const toolTurnDailyCapOre = parseDailyCapOre\(/g)).toHaveLength(1);
  });

  it("worker-containeren får allerede Anthropic-nøkkelen, ruten og dagstaket (MODEL_ENV), og jobb-bryteren står i både api og worker - ingen ny hemmelighet er utvidet til workeren", () => {
    for (const service of ["worker", "api"] as const) {
      const env: string[] = SERVICE_ENV[service];
      for (const name of ["JARVIS_TOOL_TURN_MODEL", "JARVIS_TOOL_TURN_DAILY_CAP_ORE", "JARVIS_JOB_TOOL_TURN_MODEL"]) expect(env, `${service}:${name}`).toContain(name);
    }
    const workerEnv: string[] = SERVICE_ENV.worker;
    for (const name of ["ANTHROPIC_API_KEY", "JARVIS_BUDGET_APPROVED"]) expect(workerEnv, name).toContain(name);
  });

  it("eier-merket `contentOrigin: \"owner_direct\"` settes på nøyaktig TO steder i HELE produksjonskoden: hurtigbanen i main.ts (kun når samtalemotoren sa cloudAllowed) og dashbord-ruten POST /governance/mutate i server.ts (WP-H1: kun for den suverene eieren, etter løst grant); `/confirmations`, `/executive/*` og modellflaten setter det aldri", () => {
    // Kun kode: kommentarer og typedeklarasjoner (`contentOrigin: "owner_direct" | undefined`) er ikke et sted merket SETTES.
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const setters = (text: string) => code(text).match(/contentOrigin:\s*"owner_direct"(?!\s*\|)/g);
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.name === "node_modules" || e.name === "test" || e.name === "dist" ? [] : e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []
      );
    const sourceDirs = ["apps", "modules", "packages"].flatMap((top) => readdirSync(`${root}${top}`, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${root}${top}/${e.name}/src`));
    const files = sourceDirs.flatMap((dir) => { try { return walk(dir); } catch { return []; } });
    expect(files.length).toBeGreaterThan(100); // vakten skanner faktisk koden
    const hits = files.flatMap((file) => { const m = setters(readFileSync(file, "utf8")); return m ? [{ file: file.slice(root.length), n: m.length }] : []; });
    expect(hits).toEqual([{ file: "apps/api/src/main.ts", n: 1 }, { file: "apps/api/src/server.ts", n: 1 }]);
    // Gjennomgang nr. 3: en regex på den bokstavelige verdien fanger ikke en variabel, en beregnet nøkkel eller en spread. Derfor telles ALLE forekomster av identifikatoren i kode (ikke kommentarer) per fil,
    // og tallene er låst: gateway (deklarasjon i to typer + videreføring), chat-jobs (les + typer + sending til gate-funksjonen), main.ts (hurtigbane-setteren), server.ts (WP-H1: dashbord-ruten for styringsjournalen), modules/governance/src/transport.ts (WP-H1: journal-transporten LESER attesten, en gang). En ny bruk et annet sted feiler her og må vurderes.
    const tokens = Object.fromEntries(files.flatMap((file) => { const n = (code(readFileSync(file, "utf8")).match(/\bcontentOrigin\b/g) ?? []).length; return n > 0 ? [[file.slice(root.length), n]] : []; }));
    expect(tokens).toEqual({ "apps/api/src/chat-jobs.ts": 4, "apps/api/src/main.ts": 1, "apps/api/src/server.ts": 1, "modules/governance/src/transport.ts": 1, "modules/tool-gateway/src/gateway.ts": 5 });

    const main = read("../src/main.ts");
    // Gjennomgang nr. 4: hurtigbanen får vite om jobben FAKTISK fikk skyflagget (transportens egen kontroll av jobbteksten) - kun eksplisitt `true` fra transporten teller, aldri antatt.
    expect(main).toContain("cloud: data.cloud_tool_turns === true");
    expect(main).toContain("{ started: false, reply: data.message, cloud: false }");
    const deleg = main.indexOf("delegateBackground: {");
    const marker = main.indexOf('contentOrigin: "owner_direct"');
    expect(marker).toBeGreaterThan(deleg);
    expect(marker - deleg).toBeLessThan(1400); // inne i hurtigbanens run(), ikke et annet sted
    expect(main).toMatch(/\.\.\.\(options\?\.cloudAllowed === true \? \{ contentOrigin: "owner_direct" as const \} : \{\}\)/);
    // Modellens verktøykall går via mesh-bridge, som kun stempler `servingModel` fra adapteren.
    const mesh = readFileSync(fileURLToPath(new URL("../../../modules/tool-gateway/src/mesh-bridge.ts", import.meta.url)), "utf8");
    expect(mesh).not.toContain("contentOrigin");
    // WP-H1 (JARVIS-087 del 2): den andre setteren står i `/governance/mutate` (proveniens på styringsjournalen) - ETTER at grantet er løst, KUN bak eier-porten (suveren eier), og ikke i noen annen rute.
    // Verdien leses kun av journal-transporten (modules/governance), som bruker den til å skrive `prov_origin` - ingen rute åpnes av den.
    const serverSource = read("../src/server.ts");
    const govRoute = serverSource.indexOf('url.pathname === "/governance/mutate"');
    const setterAt = serverSource.indexOf('contentOrigin: "owner_direct"');
    const nextRoute = serverSource.indexOf('url.pathname === "/devices/register"', govRoute);
    expect(govRoute).toBeGreaterThan(-1);
    expect(setterAt).toBeGreaterThan(govRoute);
    expect(setterAt).toBeLessThan(nextRoute);
    expect(serverSource.indexOf("resolveFromGrant(deps", govRoute)).toBeLessThan(setterAt);
    expect(serverSource).toMatch(/\.\.\.\(deps\.ownerGate\?\.\(resolved\.identity\) === true \? \{ contentOrigin: "owner_direct" as const \} : \{\}\)/);
    // Leseren: journal-transporten bruker attesten kun til å skrive `prov_origin` - en modell i løkka (`servingModel`) vinner alltid, og uten attest er opphavet `unspecified`. Ingen rute eller kostnadsvei åpnes av den.
    const governanceTransport = readFileSync(fileURLToPath(new URL("../../../modules/governance/src/transport.ts", import.meta.url)), "utf8");
    expect(governanceTransport).toContain('origin: context.servingModel !== undefined ? "model" : context.contentOrigin === "owner_direct" ? "owner_direct" : "unspecified"');
    // /tasks/submit avviser det interne flagget før submit.
    const server = read("../src/server.ts");
    expect(server.indexOf("submittedContractHasReservedKey(authed.body[\"contract\"])")).toBeGreaterThan(-1);
    expect(server.indexOf("submittedContractHasReservedKey(authed.body[\"contract\"])")).toBeLessThan(server.indexOf("deps.tasks.submit(authed.identity, authed.body[\"contract\"])"));
  });
});
