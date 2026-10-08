import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { NoEligibleProviderError, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import { ProviderError, type ToolCallRequest, type ToolResultMessage } from "@jarvis/provider-adapters";
import type { ClaimedTask, JobContext } from "@jarvis/tasks";
import type { MeshToolMapping } from "@jarvis/tool-gateway";
import { TasksDelegateTransport, cloudToolTurnsAllowed, type ChatJobs } from "../src/chat-jobs.ts";
import { executiveHandler } from "../src/executive.ts";
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

function makeTask(data: Record<string, unknown>, tenant = "tenant-personal"): ClaimedTask {
  return {
    task_id: "task-d449-1",
    tenant_id: tenant,
    contract: {
      goal: "list PR-er", owner_person_id: "person-tobias", tenant_id: tenant, allowed_memory_spaces: ["personal"],
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

function build(opts: { behaviours?: Behaviour[]; dayCap?: { cap_ore: number; spentToday(t: string): Promise<number> } | null; route?: { provider: string; model?: string } | null }) {
  const calls: GatewayCall[] = [];
  const plain: CompleteInput[] = [];
  const executed: string[] = [];
  const executor: ToolExecutor = {
    async execute(call: ToolCallRequest, c): Promise<ToolResultMessage> {
      executed.push(c.idempotency_key);
      return { tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: c.idempotency_key, success: true, output: { prs: [] }, at: new Date().toISOString() };
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
    expect(String(r1["text"])).toContain("Dagstaket for sky på 30 kr er nådd i dag, så jobben kjørte på den lokale modellen.");

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

describe("D-449: delegeringens kontrakt (TasksDelegateTransport)", () => {
  function transport() {
    const submitted: Array<{ input: { data: Record<string, unknown> } } & Record<string, unknown>> = [];
    const tasks = { submit: async (_id: unknown, contract: { task_id: string }) => { submitted.push(contract as never); return { ok: true, value: { task_id: contract.task_id } }; } };
    const jobs = { activeCount: async () => 0 } as unknown as ChatJobs;
    return { submitted, t: new TasksDelegateTransport(tasks as never, jobs) };
  }
  const invoke = (t: TasksDelegateTransport, params: Record<string, unknown>, servingModel?: { provider: string; model: string }) =>
    t.invoke("delegate_background_task", params as never, "cred", { identity, ...(servingModel ? { servingModel } : {}) });

  it("verktøyjobb med nøytral oppgave får skyflagget, og basiskontrakten (lokal først) er uendret", async () => {
    const { submitted, t } = transport();
    await invoke(t, { title: "Åpne PR-er", prompt: "list åpne PR-er i repoet" });
    const data = submitted[0]!.input.data;
    expect(data).toMatchObject({ sensitivity: "PRIVATE", paid_models_allowed: false, delegated_from_chat: true, tools: true, cloud_tool_turns_allowed: true });
  });

  it("følsom oppgavetekst (økonomi/helse/hemmelighet) eller jobb uten verktøy → ingen skyflagg", async () => {
    for (const prompt of ["sjekk saldoen min og lag en oppsummering", "oppsummer legetime og diagnose-notatene mine", "finn kontonummer 1234.56.78901 i e-postene"]) {
      const { submitted, t } = transport();
      await invoke(t, { title: "Oppsummering", prompt });
      expect(submitted[0]!.input.data["cloud_tool_turns_allowed"], prompt).toBeUndefined();
      expect(submitted[0]!.input.data["paid_models_allowed"]).toBe(false);
    }
    const { submitted, t } = transport();
    await invoke(t, { title: "Uten verktøy", prompt: "skriv en kort hilsen til teamet", use_tools: false });
    expect(submitted[0]!.input.data["cloud_tool_turns_allowed"]).toBeUndefined();
    expect(submitted[0]!.input.data["tools"]).toBeUndefined();
  });

  it("turen som delegerte: betjent av en skymodell → tillatt; av lokal eller ukjent modell → ikke (turen var selv låst lokalt); uten modell (hurtigbane) → kun oppgaveteksten avgjør", () => {
    expect(cloudToolTurnsAllowed("Åpne PR-er", "list åpne PR-er", { provider: "anthropic", model: "claude-sonnet-5-5" })).toBe(true);
    expect(cloudToolTurnsAllowed("Åpne PR-er", "list åpne PR-er", { provider: "gemma_local", model: "llama3.1:8b" })).toBe(false);
    expect(cloudToolTurnsAllowed("Åpne PR-er", "list åpne PR-er", { provider: "local_llm", model: "x" })).toBe(false);
    expect(cloudToolTurnsAllowed("Åpne PR-er", "list åpne PR-er", { provider: "ukjent_leverandor", model: "x" })).toBe(false);
    expect(cloudToolTurnsAllowed("Åpne PR-er", "list åpne PR-er", undefined)).toBe(true);
    expect(cloudToolTurnsAllowed("Økonomi", "hva er saldoen min", { provider: "anthropic", model: "m" })).toBe(false);
    expect(cloudToolTurnsAllowed("Økonomi", "hva er saldoen min", undefined)).toBe(false);
  });

  it("kontrakten fra en lokalbetjent tur får ikke skyflagget (ende til ende gjennom transporten)", async () => {
    const { submitted, t } = transport();
    await invoke(t, { title: "Åpne PR-er", prompt: "list åpne PR-er i repoet" }, { provider: "gemma_local", model: "llama3.1:8b" });
    expect(submitted[0]!.input.data["cloud_tool_turns_allowed"]).toBeUndefined();
    const cloud = transport();
    await invoke(cloud.t, { title: "Åpne PR-er", prompt: "list åpne PR-er i repoet" }, { provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(cloud.submitted[0]!.input.data["cloud_tool_turns_allowed"]).toBe(true);
  });
});

describe("D-449: oppkobling (kildevakt)", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("worker-containeren og api sender rute og dagstak til executive-handleren, og rute/tak er parset FØR handleren konstrueres", () => {
    const worker = read("../src/worker-main.ts");
    expect(worker).toMatch(/executiveHandler\(\{\s*gateway,\s*toolTurnRoute: jobToolTurnRoute,\s*toolTurnDayCap: jobToolTurnRoute !== null && jobToolTurnDailyCapOre > 0 \? \{ cap_ore: jobToolTurnDailyCapOre, spentToday: \(tenantId\) => dailySpentOre\(pool, tenantId\) \} : null,/);
    expect(worker.indexOf("const jobToolTurnRoute = parseToolTurnRoute(")).toBeGreaterThan(-1);
    expect(worker.indexOf("const jobToolTurnRoute = parseToolTurnRoute(")).toBeLessThan(worker.indexOf("executiveHandler({"));
    expect(worker).toContain('parseToolTurnRoute(process.env["JARVIS_TOOL_TURN_MODEL"])');
    expect(worker).toContain('parseDailyCapOre(process.env["JARVIS_TOOL_TURN_DAILY_CAP_ORE"])');

    const main = read("../src/main.ts");
    expect(main).toMatch(/executiveHandler\(\{\s*gateway,\s*toolTurnRoute,\s*toolTurnDayCap: toolTurnRoute !== null && toolTurnDailyCapOre > 0 \? \{ cap_ore: toolTurnDailyCapOre, spentToday: \(tenantId\) => dailySpentOre\(pool, tenantId\) \} : null,/);
    expect(main.indexOf("const toolTurnRoute = parseToolTurnRoute(")).toBeLessThan(main.indexOf("executiveHandler({"));
    expect(main.match(/const toolTurnRoute = parseToolTurnRoute\(/g)).toHaveLength(1);
    expect(main.match(/const toolTurnDailyCapOre = parseDailyCapOre\(/g)).toHaveLength(1);
  });

  it("worker-containeren får allerede Anthropic-nøkkelen, ruten og dagstaket (MODEL_ENV) - ingen ny hemmelighet er utvidet til workeren", () => {
    const workerEnv: string[] = SERVICE_ENV.worker;
    for (const name of ["ANTHROPIC_API_KEY", "JARVIS_TOOL_TURN_MODEL", "JARVIS_TOOL_TURN_DAILY_CAP_ORE", "JARVIS_BUDGET_APPROVED"]) expect(workerEnv, name).toContain(name);
  });
});
