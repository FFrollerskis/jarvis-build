import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JobContractSchema, type IdentityContext, type JobContract } from "@jarvis/contracts";
import { ContextBuilder, MessageStore, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { MemoryTraceSink, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { PgApprovalStore } from "@jarvis/core";
import { PgTaskQueue, type InProcessWorker, type TaskService } from "@jarvis/tasks";
import { MeshToolExecutor, SURFACE_LIMITS, ToolGateway, allMeshTools } from "@jarvis/tool-gateway";
import { ChatJobs, TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { ConversationEngine } from "../src/conversation.ts";
import { createDeliverySaver } from "../src/restricted-context-guard.ts";

/**
 * WP-N1 (fiks-runde 1, F-A2): bakgrunnsjobb-leveringen fra en LÅST tur lagres BEGRENSET. Reviewer A reproduserte på ekte Postgres: en låst jobbstart ble merket, to skyturer skjøv merkene ut av vinduet av de fire siste, og `sweepDeliveries`
 * lagret leveringen UMERKET (`main.ts` saveMessage) - neste Anthropic-kall bar jobbresultatet (lokalt, uten stikkord). Samme lekkasjeklasse som JARVIS-101. Fiks: motoren sender `restricted` til `delegateBackground.run` (hurtigbanen) og
 * `restricted: true` på turbildet til executoren (modelldrevet delegering) -> `ToolInvocationContext.restrictedOrigin` -> `restricted_origin` i jobbkontrakten -> `sweepDeliveries` lagrer leveringen begrenset (kun med vakten på).
 *  A. ekte Postgres: hele kjeden (motor -> ekte ToolGateway -> ekte `TasksDelegateTransport` -> ekte jobbkø/kontraktsskjema -> ekte sveip -> ekte `MessageStore`), låst start vs. kontroll vs. flagg AV.
 *  B. modelldrevet delegering gjennom den EKTE `MeshToolExecutor` (turbilde med `restricted`).
 *  C. flagg AV: kontrakten og lagringskallet er identiske med main (TRE argumenter).
 *  D. kildevakt: hvem som setter `restrictedOrigin` (nøyaktig to steder).
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let queue: PgTaskQueue;
const T = "t-n1job";
const id = (session: string): IdentityContext => ({ person_id: "p-1", tenant_id: T, memory_space_id: "personal", session_id: session, device_id: "d-1", channel: "web", auth_strength: "active" });
const SESSIONS = ["s-lock", "s-ctrl", "s-off", "s-model", "s-unit", "s-fail", "s-cancel", "s-failctl"];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-n1job-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_n1job LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_n1job");
  const sessions = SESSIONS.map((s, i) => `('${s}','${T}','p-1','${i === 0 ? "active" : "closed"}','web','d-1')`).join(",");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','N1JOB','person');
    INSERT INTO people (person_id, display_name) VALUES ('p-1','Én');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('p-1','${T}');
    INSERT INTO sessions (session_id, tenant_id, person_id, status, last_channel, last_device_id) VALUES ${sessions};`);
  app = createPool({ ...base, user: "jarvis_n1job", password: "pw2" });
  queue = new PgTaskQueue(app);
}, 240_000);
afterAll(async () => { await app?.end(); await admin?.end(); await stop?.(); }, 120_000);

const silence = () => { const a = vi.spyOn(console, "log").mockImplementation(() => undefined); const b = vi.spyOn(console, "error").mockImplementation(() => undefined); return () => { a.mockRestore(); b.mockRestore(); }; };

/** Den EKTE kjeden bortsett fra jobbkøens `TaskService.submit` (policy/revisjon er ikke tema her): kontrakten valideres av det ekte zod-skjemaet og legges i den ekte køen. */
function buildChain() {
  const submitted: JobContract[] = [];
  const tasks = {
    submit: async (_identity: IdentityContext, contract: unknown) => {
      const parsed = JobContractSchema.parse(contract); // beviser at skjemaet verken avviser eller fjerner `restricted_origin`
      await queue.enqueue(T, parsed);
      submitted.push(parsed);
      return { ok: true as const, value: { task_id: parsed.task_id } };
    }
  };
  const jobs = new ChatJobs(app, { saveMessage: async () => undefined });
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(app), killSwitch: new KillSwitch(), authority: { owner_person_id: "p-1", owner_tenants: [T] } });
  const gateway = new ToolGateway(app, policy, { name: "test", async get() { return "secret"; } });
  for (const tool of tasksDelegateToolDefinitions(new TasksDelegateTransport(tasks as unknown as Pick<TaskService, "submit">, jobs))) gateway.register(tool);
  return { gateway, submitted };
}

/** NØYAKTIG det `main.ts` sin `delegateBackground.run` gjør (kildevakt D under låser at main.ts har de samme linjene). */
function delegateRun(gateway: ToolGateway) {
  return async (identity: IdentityContext, prompt: string, options?: { cloudAllowed: boolean; restricted?: true }) => {
    const title = (prompt.split("\n")[0] ?? prompt).replace(/\s+/g, " ").trim().slice(0, 70).padEnd(3, ".");
    const result = await gateway.execute({
      identity, tool_id: "tasks", action: "delegate_background_task", parameters: { title, prompt: prompt.slice(0, 2000), use_tools: true },
      idempotency_key: `fast-delegate:${identity.session_id}:${randomUUID()}`,
      ...(options?.cloudAllowed === true ? { contentOrigin: "owner_direct" as const } : {}),
      ...(options?.restricted === true ? { restrictedOrigin: true as const } : {})
    });
    if (!result.ok) return null;
    const data = result.data as { started?: unknown; message?: unknown; cloud_tool_turns?: unknown } | undefined;
    return data?.started === true
      ? { started: true, reply: `Jobben «${title}» er startet i bakgrunnen.`, cloud: data.cloud_tool_turns === true }
      : typeof data?.message === "string" ? { started: false, reply: data.message, cloud: false } : null;
  };
}

type Call = { pref: string | undefined; sens: string | undefined; messages: string[] };
function engine(calls: Call[], run: ReturnType<typeof delegateRun>, guard: boolean): ConversationEngine {
  const def = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {} } });
  const github = def("github__list_pull_requests");
  const serve = async (input: CompleteInput) => {
    calls.push({ pref: (input.providerPreference as string[] | undefined)?.[0], sens: input.sensitivity, messages: input.request.messages.map((m) => String(m.content)) });
    return { text: "ok uten stikkord", usage: { input_tokens: 1, output_tokens: 1 }, provider: (input.providerPreference as string[] | undefined)?.[0] ?? "gemma_local", model: "m" };
  };
  return new ConversationEngine({
    messages: new MessageStore(app), context: new ContextBuilder(app), gateway: { complete: serve, stream: serve, completeWithTools: serve } as unknown as ModelGateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(), toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" },
    tools: {
      definitions: [github] as never, executorFor: () => ({ execute: async () => { throw new Error("x"); } }) as unknown as ToolExecutor, catalog: () => "k",
      select: ({ surface, text }: { surface: keyof typeof SURFACE_LIMITS; text: string }) => ({ definitions: (/\bPR\b/i.test(text) ? [github] : []) as never, limits: SURFACE_LIMITS[surface], tool_ids: /\bPR\b/i.test(text) ? ["github"] : [] })
    },
    delegateBackground: { run },
    ...(guard ? { restrictedContextGuard: true } : {})
  } as never);
}

const rows = async (s: string) => (await admin.query("SELECT role, content, restricted FROM messages WHERE session_id = $1 ORDER BY created_at, message_id", [s])).rows as Array<{ role: string; content: string; restricted: boolean }>;
const contractOf = async (taskId: string) => (await admin.query("SELECT contract FROM tasks WHERE task_id = $1", [taskId])).rows[0]!.contract as JobContract;
const data = (c: JobContract) => c.input.data as Record<string, unknown>;

/** Leverer jobben med ET lagringsspor som tar opp argumentene (som `main.ts` sin lambda, via produksjonsfabrikken). */
async function completeAndSweep(taskId: string, session: string, guardEnabled: boolean) {
  const claimed = await queue.claimNext("w-1", 30, ["executive"]);
  expect(claimed?.task_id).toBe(taskId);
  await queue.complete(T, taskId, "w-1", { text: "Det som gjenstår etter utbetalingen er 45 000." });
  const saved: Array<{ argc: number; opts: unknown }> = [];
  const store = new MessageStore(app);
  const spy = { save: (...args: Parameters<MessageStore["save"]>) => { saved.push({ argc: args.length, opts: args[3] }); return store.save(...args); } } as Pick<MessageStore, "save">;
  const jobs = new ChatJobs(app, { saveMessage: createDeliverySaver(spy, guardEnabled) });
  expect(await jobs.sweepDeliveries(id(session))).toBe(1);
  return saved;
}

/** F2-B2: som `completeAndSweep`, men jobben starter fra en tur via motoren og ender som `failed` (feilet i køen) eller `cancelled` (avbrutt før start) i stedet for `completed`. */
async function startTerminateAndSweep(session: string, request: string, how: "failed" | "cancelled") {
  const { gateway, submitted } = buildChain();
  const e = engine([], delegateRun(gateway), true);
  await e.handle(id(session), request);
  expect(submitted).toHaveLength(1);
  const taskId = submitted[0]!.task_id;
  if (how === "failed") {
    expect((await queue.claimNext("w-1", 30, ["executive"]))?.task_id).toBe(taskId);
    expect(await queue.fail(T, taskId, "w-1", "FEILTEKST kunne ikke lese saldoen til lønnen")).toBe("failed");
  } else {
    expect(await queue.requestCancel(T, taskId)).toBe("cancelled");
  }
  const saved: Array<{ argc: number; opts: unknown }> = [];
  const store = new MessageStore(app);
  const spy = { save: (...args: Parameters<MessageStore["save"]>) => { saved.push({ argc: args.length, opts: args[3] }); return store.save(...args); } } as Pick<MessageStore, "save">;
  const jobs = new ChatJobs(app, { saveMessage: createDeliverySaver(spy, true) });
  expect(await jobs.sweepDeliveries(id(session))).toBe(1);
  return saved;
}

describe("A: ekte Postgres - leveringen fra en LÅST jobbstart lagres begrenset og holdes utenfor skyvarianten", () => {
  const LOCKED_REQUEST = "Lag en grundig oppsummering av alt vi har snakket om den siste uken, uten småprat, og ta med hva som skjedde med lønnen min i bakgrunnen";

  it("reviewer A sin reproduksjon (nå lukket): låst start (finansord etter tegn 70) -> to skyturer skyver merkene ut av vinduet -> levering lagres restricted=true -> neste skytur sender IKKE leveringen til Anthropic", async () => {
    const restore = silence();
    try {
      const { gateway, submitted } = buildChain();
      const calls: Call[] = [];
      const e = engine(calls, delegateRun(gateway), true);
      await e.handle(id("s-lock"), LOCKED_REQUEST);
      expect((await rows("s-lock")).map((r) => r.restricted)).toEqual([true, true]); // jobbstarten (bruker + svar) er merket
      expect(submitted).toHaveLength(1);
      const contract = await contractOf(submitted[0]!.task_id);
      expect(data(contract)["restricted_origin"]).toBe(true); // overlevde zod, køen og databasen
      expect(data(contract)["delegated_from_chat"]).toBe(true);
      // to vanlige skyturer: merkene glir ut av de fire siste radene
      await e.handle(id("s-lock"), "list åpne PR-er på github");
      await e.handle(id("s-lock"), "list åpne PR-er på tsworkflow/jarvisbuild");
      const saved = await completeAndSweep(submitted[0]!.task_id, "s-lock", true);
      expect(saved).toEqual([{ argc: 4, opts: { restricted: true } }]);
      const delivery = (await rows("s-lock")).find((r) => r.content.includes("45 000"))!;
      expect(delivery.role).toBe("assistant");
      expect(delivery.restricted).toBe(true); // F-A2: tidligere false
      calls.length = 0;
      await e.handle(id("s-lock"), "list åpne PR-er på github igjen");
      const cloud = calls.find((c) => c.pref === "anthropic")!;
      expect(cloud).toBeDefined();
      expect(cloud.messages.some((m) => m.includes("45 000"))).toBe(false); // leveringen holdes utenfor skyvarianten
    } finally { restore(); }
  });

  it("kontroll: en IKKE-låst jobbstart gir en kontrakt uten restricted_origin og en umerket levering - lagringskallet har TRE argumenter (som main)", async () => {
    const restore = silence();
    try {
      const { gateway, submitted } = buildChain();
      const e = engine([], delegateRun(gateway), true);
      await e.handle(id("s-ctrl"), "list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen");
      expect((await rows("s-ctrl")).map((r) => r.restricted)).toEqual([false, false]);
      expect(Object.keys(data(await contractOf(submitted[0]!.task_id)))).not.toContain("restricted_origin");
      const saved = await completeAndSweep(submitted[0]!.task_id, "s-ctrl", true);
      expect(saved).toEqual([{ argc: 3, opts: undefined }]);
      expect((await rows("s-ctrl")).find((r) => r.content.includes("45 000"))!.restricted).toBe(false);
    } finally { restore(); }
  });

  it("F2-B2 (reviewer B NF-2): FEILEDE og AVBRUTTE jobber fra en LÅST start leveres også begrenset (feilteksten og tittelen kan gjengi oppgaven) - ikke bare fullførte; en IKKE-låst start gir tre argumenter", async () => {
    const restore = silence();
    try {
      const failed = await startTerminateAndSweep("s-fail", LOCKED_REQUEST, "failed");
      expect(failed).toEqual([{ argc: 4, opts: { restricted: true } }]);
      const cancelled = await startTerminateAndSweep("s-cancel", LOCKED_REQUEST, "cancelled");
      expect(cancelled).toEqual([{ argc: 4, opts: { restricted: true } }]);
      const control = await startTerminateAndSweep("s-failctl", "list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen", "failed");
      expect(control).toEqual([{ argc: 3, opts: undefined }]);
      // radene: bruker + jobbstart-svar + levering. Låst start: alle tre begrenset; kontroll: ingen.
      const failedRows = await rows("s-fail");
      expect(failedRows.map((r) => r.restricted)).toEqual([true, true, true]);
      expect(failedRows.at(-1)!.content).toContain("feilet: FEILTEKST");
      const cancelledRows = await rows("s-cancel");
      expect(cancelledRows.map((r) => r.restricted)).toEqual([true, true, true]);
      expect(cancelledRows.at(-1)!.content).toContain("ble avbrutt");
      expect((await rows("s-failctl")).map((r) => r.restricted)).toEqual([false, false, false]);
    } finally { restore(); }
  });
});

describe("C: flagg AV - kontrakten og lagringskallet er identiske med main", () => {
  it("uten vakten (motoren uten restrictedContextGuard): samme låste forespørsel gir INGEN restricted_origin i kontrakten, ingen merking, og leveringen lagres med tre argumenter", async () => {
    const restore = silence();
    try {
      const { gateway, submitted } = buildChain();
      const e = engine([], delegateRun(gateway), false);
      await e.handle(id("s-off"), "Lag en grundig oppsummering av alt vi har snakket om den siste uken, uten småprat, og ta med hva som skjedde med lønnen min i bakgrunnen");
      expect((await rows("s-off")).map((r) => r.restricted)).toEqual([false, false]);
      const contract = await contractOf(submitted[0]!.task_id);
      expect(Object.keys(data(contract)).sort()).toEqual(["delegated_from_chat", "paid_models_allowed", "prompt", "purpose", "sensitivity", "tools"]);
      const saved = await completeAndSweep(submitted[0]!.task_id, "s-off", false);
      expect(saved).toEqual([{ argc: 3, opts: undefined }]);
      expect((await rows("s-off")).find((r) => r.content.includes("45 000"))!.restricted).toBe(false);
    } finally { restore(); }
  });

  it("selv om en kontrakt fra en tidligere PÅ-periode bærer restricted_origin, lagrer fabrikken med vakten AV leveringen med tre argumenter (kolonnen settes aldri)", async () => {
    const saved: unknown[][] = [];
    const store = { save: async (...args: unknown[]) => { saved.push(args); return "m"; } } as unknown as Pick<MessageStore, "save">;
    await createDeliverySaver(store, false)(id("s-unit"), "assistant", "levering", { restricted: true });
    await createDeliverySaver(store, true)(id("s-unit"), "assistant", "levering", { restricted: true });
    await createDeliverySaver(store, true)(id("s-unit"), "assistant", "levering");
    await createDeliverySaver(store, true)(id("s-unit"), "assistant", "levering", {} as never);
    expect(saved.map((a) => a.length)).toEqual([3, 4, 3, 3]);
    expect(saved[1]![3]).toEqual({ restricted: true });
  });
});

describe("B: modelldrevet delegering (tasks.delegate_background_task via den EKTE MeshToolExecutor)", () => {
  const call = (name: string) => ({ tool_call_id: `c-${randomUUID()}`, tool_name: name, arguments: { title: "Ukesoppsummering", prompt: "Oppsummer det jeg har skrevet den siste uken" }, provider: "gemma_local", model: "gemma3:4b" });
  const ctx = () => ({ tenant_id: T, idempotency_key: `k-${randomUUID()}` });

  it("et turbilde med restricted: true (låst tur) gir restricted_origin i kontrakten; et vanlig turbilde og et utelatt turbilde gir ingen nøkkel", async () => {
    const { gateway, submitted } = buildChain();
    const mesh = allMeshTools(gateway);
    const name = mesh.map((m) => m.def.name).find((n) => n === "tasks__delegate_background_task")!;
    expect(name).toBeDefined();
    const locked = new MeshToolExecutor(gateway, id("s-model"), 20_000, mesh, { user_message: "x", restricted: true });
    const plain = new MeshToolExecutor(gateway, id("s-model"), 20_000, mesh, { user_message: "x" });
    const none = new MeshToolExecutor(gateway, id("s-model"), 20_000, mesh);
    for (const executor of [locked, plain, none]) expect((await executor.execute(call(name), ctx())).success).toBe(true);
    expect(submitted.map((c) => data(c)["restricted_origin"])).toEqual([true, undefined, undefined]);
    expect(submitted.map((c) => Object.keys(data(c)).includes("restricted_origin"))).toEqual([true, false, false]);
  });

  it("modellen kan ikke sette merket selv: `restricted_origin`/`restrictedOrigin` i argumentene avvises (strengt skjema) og havner aldri i kontrakten", async () => {
    const { gateway, submitted } = buildChain();
    const mesh = allMeshTools(gateway);
    const executor = new MeshToolExecutor(gateway, id("s-model"), 20_000, mesh, { user_message: "x" });
    for (const forged of [{ restricted_origin: true }, { restrictedOrigin: true }]) {
      const out = await executor.execute({ ...call("tasks__delegate_background_task"), arguments: { title: "Ukesoppsummering", prompt: "Oppsummer det jeg har skrevet den siste uken", ...forged } }, ctx());
      expect(out.success).toBe(false);
    }
    expect(submitted).toEqual([]);
  });
});

describe("D: kildevakt - hvem setter `restrictedOrigin` (kun trusted kode)", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === "test" || e.name === "dist" ? [] : e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []));
  const files = ["apps", "modules", "packages"].flatMap((top) => readdirSync(`${root}${top}`, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => { try { return walk(`${root}${top}/${e.name}/src`); } catch { return []; } }));

  it("`restrictedOrigin: true` SETTES på nøyaktig to steder: hurtigbanen i main.ts og MeshToolExecutor (videreformidler turbildet); gatewayen deklarerer/videreformidler; chat-jobs leser det", () => {
    expect(files.length).toBeGreaterThan(100);
    const setters = Object.fromEntries(files.flatMap((f) => { const n = (code(readFileSync(f, "utf8")).match(/restrictedOrigin:\s*true/g) ?? []).length; return n > 0 ? [[f.slice(root.length), n]] : []; }));
    expect(setters).toEqual({ "apps/api/src/main.ts": 1, "modules/tool-gateway/src/gateway.ts": 1, "modules/tool-gateway/src/mesh-bridge.ts": 1 }); // gateway.ts: videreformidlingen `request.restrictedOrigin === true ? { restrictedOrigin: true }`
    const tokens = Object.fromEntries(files.flatMap((f) => { const n = (code(readFileSync(f, "utf8")).match(/\brestrictedOrigin\b/g) ?? []).length; return n > 0 ? [[f.slice(root.length), n]] : []; }));
    // gateway.ts: to deklarasjoner (kontekst + kall) og videreformidlingen (les + sett); chat-jobs.ts leser konteksten (én); main.ts og mesh-bridge.ts setter (én hver). Et nytt sted bryter tallene og må vurderes.
    expect(tokens).toEqual({ "apps/api/src/chat-jobs.ts": 1, "apps/api/src/main.ts": 1, "modules/tool-gateway/src/gateway.ts": 4, "modules/tool-gateway/src/mesh-bridge.ts": 1 });
    const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
    expect(main).toMatch(/\.\.\.\(options\?\.restricted === true \? \{ restrictedOrigin: true as const \} : \{\}\)/);
    const mesh = readFileSync(`${root}modules/tool-gateway/src/mesh-bridge.ts`, "utf8");
    expect(mesh).toMatch(/\.\.\.\(this\.turn\?\.restricted === true \? \{ restrictedOrigin: true as const \} : \{\}\)/);
  });

  it("`restricted_origin` skrives kun av TasksDelegateTransport (fra konteksten, aldri fra parametere) og leses kun i ChatJobs (sveipet, tilbakehold i list/get, isRestrictedOrigin) med eksakt true", () => {
    const chatJobs = code(readFileSync(fileURLToPath(new URL("../src/chat-jobs.ts", import.meta.url)), "utf8"));
    expect(chatJobs).toContain("...(context?.restrictedOrigin === true ? { restricted_origin: true } : {})");
    expect(chatJobs).toContain('row.restricted_origin === "true"');
    // F2-B1: nøkkelen leses nå også av `ChatJobs.list/get` (tilbakehold ved utførelse) og `isRestrictedOrigin` (hurtigbanen), så antallet pinnes per rolle i stedet for som ett sumtall: ÉN skriving, TO eksakt-«true»-lesinger (`present` og sveipet)
    // og FIRE SQL-uttrekk (list, get, isRestrictedOrigin, sveipet). En ny skriving eller en ny lesing bryter tallene og må vurderes.
    expect(chatJobs.match(/restricted_origin:\s*true/g)).toHaveLength(1);
    expect(chatJobs.match(/restricted_origin === "true"/g)).toHaveLength(2);
    expect(chatJobs.match(/->>'restricted_origin'/g)).toHaveLength(4);
    const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
    expect(main).toContain("saveMessage: createDeliverySaver(new MessageStore(pool), restrictedContextGuard.enabled)");
    expect(main).not.toMatch(/saveMessage: \(identity, role, content\) =>/);
  });
});
