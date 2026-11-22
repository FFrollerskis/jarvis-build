import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JobContractSchema, type IdentityContext, type JobContract } from "@jarvis/contracts";
import { ContextBuilder, MessageStore, PgApprovalStore, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { MemoryTraceSink, classifyContentSensitivity, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { PgTaskQueue, type InProcessWorker, type TaskService } from "@jarvis/tasks";
import { MeshToolExecutor, SURFACE_LIMITS, ToolGateway, allMeshTools } from "@jarvis/tool-gateway";
import { ChatJobs, TasksDelegateTransport, WITHHELD_JOB_NOTE_NO, WITHHELD_JOB_TITLE, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { ConversationEngine } from "../src/conversation.ts";
import { withholdsRestrictedJobFromCloud } from "../src/restricted-context-guard.ts";

/**
 * WP-N1 (fiks-runde 2, F2-B1 / reviewer B NF-1): RESULTATET av en bakgrunnsjobb startet fra en LÅST tur nådde fortsatt skymodeller. Leveringsmeldingen ble merket (F-A2), men
 *  (a) `tasks.get_task_status` (ChatJobs.get/list -> `result_text`/`error`/`title`) ga teksten fra den lokale modellen til et sky-stemplet kall, også via ekte `MeshToolExecutor`, og
 *  (b) hurtigbanens `jobbstatus <id>` gjengav resultatet i et svar som ble lagret UMERKET (`task_status: false`) og fulgte med historikken til neste skytur.
 * Fiks: (a) med vakten PÅ holdes tittel/resultat/feil tilbake VED UTFØRELSE for sky/ukjent modell (`withheld: true` + kort norsk merknad; lokal modell og eierens ruter uendret) - samme mønster som
 * `withholdFinanceFromCloud`; (b) `jobbstatus` for en jobb med `restricted_origin` låser turen FØR svaret lagres (bruker- og assistentrad begrenset). Vakten AV: uendret view, uendret kallform, ingen oppslag.
 * Alt mot ekte Postgres (ekte kø, ekte kontraktsskjema, ekte MessageStore/ContextBuilder) og den ekte ToolGateway/MeshToolExecutor.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let queue: PgTaskQueue;
const T = "t-n1st";
const identity = (session: string): IdentityContext => ({ person_id: "p-1", tenant_id: T, memory_space_id: "personal", session_id: session, device_id: "d-1", channel: "web", auth_strength: "active" });
const SESSIONS = ["s-tool", "s-fast-lock", "s-fast-plain", "s-fast-off", "s-fast-err", "s-fast-next"];
const CLOUD = { provider: "anthropic", model: "claude-sonnet-5-5" };
const LOCAL = { provider: "gemma_local", model: "gemma3:4b" };
const SECRET_TEXT = "N1ST-HEMMELIG-RESULTAT saldoen etter utbetalingen er 45 000";
const SECRET_ERROR = "N1ST-HEMMELIG-FEIL kunne ikke lese kontoen til lønnen";
const SECRET_TITLE = "N1ST-HEMMELIG-TITTEL lønn og saldo";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-n1st-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_n1st LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_n1st");
  const sessions = SESSIONS.map((s, i) => `('${s}','${T}','p-1','${i === 0 ? "active" : "closed"}','web','d-1')`).join(",");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','N1ST','person');
    INSERT INTO people (person_id, display_name) VALUES ('p-1','Én');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('p-1','${T}');
    INSERT INTO sessions (session_id, tenant_id, person_id, status, last_channel, last_device_id) VALUES ${sessions};`);
  app = createPool({ ...base, user: "jarvis_n1st", password: "pw2" });
  queue = new PgTaskQueue(app);
}, 240_000);
afterAll(async () => { await app?.end(); await admin?.end(); await stop?.(); }, 120_000);
/** Hver test starter med en tom kø: jobber fra tidligere tester (aldri hentet/fullført) ville ellers stjele `claimNext` og telle mot taket på aktive jobber (MAX_ACTIVE_JOBS). */
beforeEach(async () => { for (;;) { const t = await queue.claimNext("w-drain", 30, ["executive"]); if (!t) break; await queue.complete(T, t.task_id, "w-drain", { text: "tømt" }); } });

const silence = () => { const a = vi.spyOn(console, "log").mockImplementation(() => undefined); const b = vi.spyOn(console, "error").mockImplementation(() => undefined); return () => { a.mockRestore(); b.mockRestore(); }; };

/** Ekte kjede bortsett fra `TaskService.submit` (policy/revisjon er ikke tema): kontrakten valideres av det ekte zod-skjemaet og legges i den ekte køen. `guard` = vakten (transporten får predikatet kun da). */
function chain(guard: boolean) {
  const submitted: JobContract[] = [];
  const tasks = { submit: async (_i: IdentityContext, contract: unknown) => { const parsed = JobContractSchema.parse(contract); await queue.enqueue(T, parsed); submitted.push(parsed); return { ok: true as const, value: { task_id: parsed.task_id } }; } };
  const jobs = new ChatJobs(app, { saveMessage: async () => undefined });
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(app), killSwitch: new KillSwitch(), authority: { owner_person_id: "p-1", owner_tenants: [T] } });
  const gateway = new ToolGateway(app, policy, { name: "test", async get() { return "secret"; } });
  const transport = guard
    ? new TasksDelegateTransport(tasks as unknown as Pick<TaskService, "submit">, jobs, withholdsRestrictedJobFromCloud)
    : new TasksDelegateTransport(tasks as unknown as Pick<TaskService, "submit">, jobs);
  for (const tool of tasksDelegateToolDefinitions(transport)) gateway.register(tool);
  return { gateway, submitted, jobs };
}

const start = async (gateway: ToolGateway, submitted: JobContract[], opts: { restricted: boolean; title?: string }): Promise<string> => {
  const r = await gateway.execute({
    identity: identity("s-tool"), tool_id: "tasks", action: "delegate_background_task",
    parameters: { title: opts.title ?? SECRET_TITLE, prompt: "Hent saldoen og lag en oppsummering av utbetalingen", use_tools: true } as never, idempotency_key: `k-${randomUUID()}`, servingModel: LOCAL,
    ...(opts.restricted ? { restrictedOrigin: true as const } : {})
  });
  expect(r.ok).toBe(true);
  expect((r as unknown as { data: { started: boolean } }).data.started).toBe(true);
  return submitted.at(-1)!.task_id;
};
const complete = async (taskId: string, text: string) => { expect((await queue.claimNext("w-1", 30, ["executive"]))?.task_id).toBe(taskId); await queue.complete(T, taskId, "w-1", { text }); };
const fail = async (taskId: string, error: string) => { expect((await queue.claimNext("w-1", 30, ["executive"]))?.task_id).toBe(taskId); expect(await queue.fail(T, taskId, "w-1", error)).toBe("failed"); };
const status = (gateway: ToolGateway, parameters: Record<string, unknown>, servingModel?: { provider: string; model: string }) =>
  gateway.execute({ identity: identity("s-tool"), tool_id: "tasks", action: "get_task_status", parameters: parameters as never, idempotency_key: `k-${randomUUID()}`, ...(servingModel ? { servingModel } : {}) });
type View = Record<string, unknown>;
const jobOf = (r: unknown): View => ((r as { data: { job: View } }).data.job);
const jobsOf = (r: unknown): View[] => ((r as { data: { jobs: View[] } }).data.jobs);

describe("A: tasks.get_task_status holder tittel/resultat/feil fra en LÅST jobb tilbake fra skymodeller (vakt PÅ)", () => {
  it("fullført låst jobb: sky/ukjent/tom/STORE BOKSTAVER/annen sky får `withheld`, nøytral tittel og ingen tekst - både med id og i listen", async () => {
    const restore = silence();
    try {
      const { gateway, submitted } = chain(true);
      const taskId = await start(gateway, submitted, { restricted: true });
      expect((submitted.at(-1)!.input.data as Record<string, unknown>)["restricted_origin"]).toBe(true);
      await complete(taskId, SECRET_TEXT);
      for (const model of [CLOUD, { provider: "openai", model: "x" }, { provider: "ukjent", model: "x" }, { provider: "", model: "x" }, { provider: "  ", model: "x" }, { provider: "GEMMA_LOCAL", model: "x" }, { provider: "gemma_local ", model: "x" }, { provider: 7, model: "x" } as never]) {
        const byId = await status(gateway, { task_id: taskId }, model);
        const job = jobOf(byId);
        expect(job, JSON.stringify(model)).toMatchObject({ task_id: taskId, title: WITHHELD_JOB_TITLE, status: "completed", result_text: null, error: null, withheld: true, note_no: WITHHELD_JOB_NOTE_NO });
        const list = jobsOf(await status(gateway, {}, model)).find((j) => j["task_id"] === taskId)!;
        expect(list, JSON.stringify(model)).toEqual(job);
        for (const text of [JSON.stringify(byId), JSON.stringify(list)]) {
          expect(text).not.toContain("N1ST-HEMMELIG");
          expect(text).not.toContain("45 000");
          expect(text).not.toContain("saldo");
        }
      }
    } finally { restore(); }
  });

  it("feilet og kjørende låst jobb: feilteksten og tittelen holdes tilbake (tittelen er de første tegnene av forespørselen), status og tidspunkter vises", async () => {
    const restore = silence();
    try {
      const { gateway, submitted } = chain(true);
      const failedId = await start(gateway, submitted, { restricted: true });
      await fail(failedId, SECRET_ERROR);
      const runningId = await start(gateway, submitted, { restricted: true });
      const failed = jobOf(await status(gateway, { task_id: failedId }, CLOUD));
      expect(failed).toMatchObject({ status: "failed", error: null, result_text: null, title: WITHHELD_JOB_TITLE, withheld: true });
      expect(typeof failed["created_at"]).toBe("string");
      expect(failed["finished_at"]).not.toBeNull();
      const running = jobOf(await status(gateway, { task_id: runningId }, CLOUD));
      expect(running).toMatchObject({ status: "created", title: WITHHELD_JOB_TITLE, withheld: true, finished_at: null });
      expect(JSON.stringify([failed, running])).not.toContain("N1ST-HEMMELIG");
    } finally { restore(); }
  });

  it("LOKAL modell og eierens ruter (ingen servingModel) får hele viewet uendret - lik viewet uten vakt - og aldri `withheld`", async () => {
    const restore = silence();
    try {
      const guarded = chain(true);
      const plain = chain(false);
      const taskId = await start(guarded.gateway, guarded.submitted, { restricted: true });
      await complete(taskId, SECRET_TEXT);
      const reference = jobOf(await status(plain.gateway, { task_id: taskId }, CLOUD)); // vakten AV: det rå viewet
      expect(reference).toMatchObject({ title: SECRET_TITLE, result_text: SECRET_TEXT });
      for (const model of [LOCAL, { provider: "ollama", model: "x" }, { provider: "local_llm", model: "x" }, { provider: "scripted", model: "x" }, undefined]) {
        const job = jobOf(await status(guarded.gateway, { task_id: taskId }, model));
        expect(job, String(model?.provider)).toEqual(reference);
        expect(Object.keys(job)).not.toContain("withheld");
        expect(Object.keys(job)).not.toContain("note_no");
        const listed = jobsOf(await status(guarded.gateway, {}, model)).find((j) => j["task_id"] === taskId)!;
        expect(listed, String(model?.provider)).toEqual(reference);
      }
    } finally { restore(); }
  });

  it("en jobb startet fra en IKKE-låst tur er uendret også for en skymodell (kun restricted_origin holdes tilbake)", async () => {
    const restore = silence();
    try {
      const { gateway, submitted } = chain(true);
      const taskId = await start(gateway, submitted, { restricted: false, title: "Vanlig jobb om PR-er" });
      await complete(taskId, "Det er to åpne PR-er.");
      expect(Object.keys((submitted.at(-1)!.input.data as Record<string, unknown>))).not.toContain("restricted_origin");
      const job = jobOf(await status(gateway, { task_id: taskId }, CLOUD));
      expect(job).toMatchObject({ title: "Vanlig jobb om PR-er", result_text: "Det er to åpne PR-er.", error: null });
      expect(Object.keys(job)).not.toContain("withheld");
    } finally { restore(); }
  });

  it("gjennom den EKTE MeshToolExecutor (adapter-stemplet leverandør): anthropic ser kun merknaden, gemma_local ser alt", async () => {
    const restore = silence();
    try {
      const { gateway, submitted } = chain(true);
      const taskId = await start(gateway, submitted, { restricted: true });
      await complete(taskId, SECRET_TEXT);
      const executor = new MeshToolExecutor(gateway, identity("s-tool"), 20_000, allMeshTools(gateway));
      const call = (provider: string, model: string) => ({ tool_call_id: `c-${randomUUID()}`, tool_name: "tasks__get_task_status", arguments: { task_id: taskId }, provider, model });
      const cloud = await executor.execute(call("anthropic", "claude-sonnet-5-5"), { tenant_id: T, idempotency_key: `k-${randomUUID()}` });
      expect(cloud.success).toBe(true);
      expect(JSON.stringify(cloud.output)).toContain("withheld");
      expect(JSON.stringify(cloud.output)).not.toContain("N1ST-HEMMELIG");
      const local = await executor.execute(call("gemma_local", "gemma3:4b"), { tenant_id: T, idempotency_key: `k-${randomUUID()}` });
      expect(JSON.stringify(local.output)).toContain("N1ST-HEMMELIG-RESULTAT");
    } finally { restore(); }
  });

  it("vakten AV (transporten uten predikat) er identisk med main: en skymodell får det rå viewet, og ChatJobs kalles med NØYAKTIG (identity, id) / (identity, 8) - ingen tredje argument", async () => {
    const restore = silence();
    try {
      const { gateway, submitted, jobs } = chain(false);
      const getSpy = vi.spyOn(jobs, "get");
      const listSpy = vi.spyOn(jobs, "list");
      const taskId = await start(gateway, submitted, { restricted: true });
      await complete(taskId, SECRET_TEXT);
      const job = jobOf(await status(gateway, { task_id: taskId }, CLOUD));
      expect(job).toMatchObject({ title: SECRET_TITLE, result_text: SECRET_TEXT });
      expect(Object.keys(job).sort()).toEqual(["created_at", "delivered", "error", "finished_at", "result_text", "status", "task_id", "title"]);
      await status(gateway, {}, CLOUD);
      expect(getSpy.mock.calls[0]!.length).toBe(2);
      expect(listSpy.mock.calls[0]!.length).toBe(2);
      expect(listSpy.mock.calls[0]![1]).toBe(8);
      // også med vakten PÅ kalles ChatJobs uten tredje argument når kallet ikke skal holdes tilbake (lokal og eier-rute)
      const guarded = chain(true);
      const g = vi.spyOn(guarded.jobs, "get");
      const id2 = await start(guarded.gateway, guarded.submitted, { restricted: true });
      await status(guarded.gateway, { task_id: id2 }, LOCAL);
      await status(guarded.gateway, { task_id: id2 });
      await status(guarded.gateway, { task_id: id2 }, CLOUD);
      expect(g.mock.calls.map((c) => c.length)).toEqual([2, 2, 3]);
      expect(g.mock.calls[2]![2]).toEqual({ withholdRestricted: true });
    } finally { restore(); }
  });

  it("merknaden: norsk og kort, uten sifre, id-er, tellinger eller leverandørnavn, og ingen ord klassifisereren reagerer på", () => {
    expect(/\d/.test(WITHHELD_JOB_NOTE_NO)).toBe(false);
    expect(/\d/.test(WITHHELD_JOB_TITLE)).toBe(false);
    for (const text of [WITHHELD_JOB_NOTE_NO, WITHHELD_JOB_TITLE]) {
      expect(text).not.toMatch(/anthropic|openai|claude|gemini|gemma|ollama|gpt|kimi|hermes|neonomics|stripe|vipps|wallester|task-/i);
      expect(classifyContentSensitivity({ texts: [text] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    }
    expect(WITHHELD_JOB_NOTE_NO.length).toBeLessThan(400);
  });
});

describe("B: hurtigbanens `jobbstatus <id>` for en LÅST jobb merker begge radene og holdes utenfor skyvarianten", () => {
  function engine(session: string, opts: { guard: boolean; origin?: "real" | "throws"; calls?: Array<{ pref: string | undefined; messages: string[] }>; store?: MessageStore }) {
    const jobs = new ChatJobs(app, { saveMessage: async () => undefined });
    const isRestricted = vi.fn((i: IdentityContext, id: string) => (opts.origin === "throws" ? Promise.reject(new Error("db nede")) : jobs.isRestrictedOrigin(i, id)));
    const def = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {} } });
    const github = def("github__list_pull_requests");
    const serve = async (input: CompleteInput) => {
      opts.calls?.push({ pref: (input.providerPreference as string[] | undefined)?.[0], messages: input.request.messages.map((m) => String(m.content)) });
      return { text: "ok uten stikkord", usage: { input_tokens: 1, output_tokens: 1 }, provider: (input.providerPreference as string[] | undefined)?.[0] ?? "gemma_local", model: "m" };
    };
    const e = new ConversationEngine({
      messages: opts.store ?? new MessageStore(app), context: new ContextBuilder(app), gateway: { complete: serve, stream: serve, completeWithTools: serve } as unknown as ModelGateway,
      tasks: { get: async (_i: unknown, taskId: string) => { const t = await queue.get(T, taskId); return t ? { ok: true, value: t } : { ok: false, reason: "task_not_found" }; } } as unknown as TaskService,
      worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(), toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" },
      tools: {
        definitions: [github] as never, executorFor: () => ({ execute: async () => { throw new Error("x"); } }) as unknown as ToolExecutor, catalog: () => "k",
        select: ({ surface, text }: { surface: keyof typeof SURFACE_LIMITS; text: string }) => ({ definitions: (/\bPR\b/i.test(text) ? [github] : []) as never, limits: SURFACE_LIMITS[surface], tool_ids: /\bPR\b/i.test(text) ? ["github"] : [] })
      },
      ...(opts.guard ? { restrictedContextGuard: true, jobOrigin: { isRestricted } } : {})
    } as never);
    return { e, isRestricted, id: identity(session) };
  }
  const rows = async (s: string) => (await admin.query("SELECT role, content, restricted FROM messages WHERE session_id = $1 ORDER BY created_at, message_id", [s])).rows as Array<{ role: string; content: string; restricted: boolean }>;
  const lockedJob = async (): Promise<string> => { const { gateway, submitted } = chain(true); const id = await start(gateway, submitted, { restricted: true }); await complete(id, SECRET_TEXT); return id; };

  it("låst jobb: svaret gjengir resultatet til eieren, bruker- og assistentraden lagres begrenset (D4 snudd), en revisjonsrad for merkingen - og to skyturer senere sendes IKKE statusraden til Anthropic", async () => {
    const restore = silence();
    try {
      const taskId = await lockedJob();
      const calls: Array<{ pref: string | undefined; messages: string[] }> = [];
      const { e, id, isRestricted } = engine("s-fast-lock", { guard: true, calls });
      const reply = await e.handle(id, `jobbstatus ${taskId}`);
      expect(reply.routed).toBe("fast");
      expect(reply.reply).toContain("N1ST-HEMMELIG-RESULTAT"); // eieren (lokal visning) får resultatet
      expect(isRestricted).toHaveBeenCalledTimes(1);
      expect((await rows("s-fast-lock")).map((r) => r.restricted)).toEqual([true, true]);
      const marks = Number((await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE session_id = 's-fast-lock' AND type = 'message.restricted_marked'")).rows[0].n);
      expect(marks).toBe(1);
      // statusraden er nå begrenset: den skyver ikke merkene ut av vinduet og holdes utenfor skyvarianten
      await e.handle(id, "list åpne PR-er på github");
      const cloud = calls.find((c) => c.pref === "anthropic");
      expect(cloud).toBeDefined();
      expect(cloud!.messages.some((m) => m.includes("N1ST-HEMMELIG"))).toBe(false);
      expect(cloud!.messages.some((m) => m.includes("jobbstatus"))).toBe(false);
    } finally { restore(); }
  });

  it("kontroll: en ikke-låst jobb gir uendret oppførsel (umerkede rader, tre-argument lagring) og samme svartekst", async () => {
    const restore = silence();
    try {
      const { gateway, submitted } = chain(true);
      const taskId = await start(gateway, submitted, { restricted: false, title: "Vanlig jobb om PR-er" });
      await complete(taskId, "Det er to åpne PR-er.");
      const saved: unknown[][] = [];
      const real = new MessageStore(app);
      const spy = Object.assign(Object.create(real), { save: (...a: unknown[]) => { saved.push(a); return (real.save as (...x: unknown[]) => Promise<string>)(...a); }, markRestricted: real.markRestricted.bind(real), history: real.history.bind(real) }) as MessageStore;
      const { e, id } = engine("s-fast-plain", { guard: true, store: spy });
      const reply = await e.handle(id, `jobbstatus ${taskId}`);
      expect(reply.reply).toContain("Det er to åpne PR-er.");
      expect((await rows("s-fast-plain")).map((r) => r.restricted)).toEqual([false, false]);
      expect(saved.map((a) => a.length)).toEqual([3, 3]);
    } finally { restore(); }
  });

  it("vakten AV: motoren har verken markør eller `jobOrigin` - ingen oppslag, raden lagres umerket som på main (selv for en jobb med restricted_origin)", async () => {
    const restore = silence();
    try {
      const taskId = await lockedJob();
      const { e, id, isRestricted } = engine("s-fast-off", { guard: false });
      const reply = await e.handle(id, `jobbstatus ${taskId}`);
      expect(reply.reply).toContain("N1ST-HEMMELIG-RESULTAT");
      expect(isRestricted).not.toHaveBeenCalled();
      expect((await rows("s-fast-off")).map((r) => r.restricted)).toEqual([false, false]);
    } finally { restore(); }
  });

  it("fail-closed: kan opprinnelsen ikke avgjøres (oppslaget feiler), regnes jobben som begrenset og turen låses; og en ukjent jobb gir «Fant ikke jobben» uten lås eller oppslag", async () => {
    const restore = silence();
    try {
      const taskId = await lockedJob();
      const { e, id } = engine("s-fast-err", { guard: true, origin: "throws" });
      await e.handle(id, `jobbstatus ${taskId}`);
      expect((await rows("s-fast-err")).map((r) => r.restricted)).toEqual([true, true]);
      const missing = engine("s-fast-next", { guard: true });
      const reply = await missing.e.handle(missing.id, "jobbstatus task-finnes-ikke");
      expect(reply.reply).toContain("Fant ikke jobben");
      expect(missing.isRestricted).not.toHaveBeenCalled();
      expect((await rows("s-fast-next")).map((r) => r.restricted)).toEqual([false, false]);
    } finally { restore(); }
  });
});

describe("C: ChatJobs.isRestrictedOrigin (oppslaget hurtigbanen bruker)", () => {
  it("kun den bokstavelige true i kontraktens restricted_origin teller; ukjent jobb og jobb uten nøkkel gir false; en innsendt (ikke-delegert) jobb med nøkkelen kan bare gjøre svaret MER begrenset", async () => {
    const restore = silence();
    try {
      const jobs = new ChatJobs(app, { saveMessage: async () => undefined });
      const locked = chain(true);
      const lockedId = await start(locked.gateway, locked.submitted, { restricted: true });
      const plainId = await start(locked.gateway, locked.submitted, { restricted: false });
      expect(await jobs.isRestrictedOrigin(identity("s-tool"), lockedId)).toBe(true);
      expect(await jobs.isRestrictedOrigin(identity("s-tool"), plainId)).toBe(false);
      expect(await jobs.isRestrictedOrigin(identity("s-tool"), "task-finnes-ikke")).toBe(false);
      const submitRaw = async (value: unknown): Promise<string> => {
        const contract = JobContractSchema.parse({
          task_id: `task-${randomUUID()}`, owner_person_id: "p-1", tenant_id: T, goal: "innsendt", acceptance_criteria: ["x"],
          input: { data: { prompt: "p", restricted_origin: value }, trust_level: "internal", provenance: "chat:s-tool" }, allowed_tools: [], allowed_memory_spaces: ["personal"], allowed_network_targets: [],
          agent_profile: "executive", model_budget_ore: 0, retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 1
        });
        await queue.enqueue(T, contract);
        return contract.task_id;
      };
      expect(await jobs.isRestrictedOrigin(identity("s-tool"), await submitRaw(true))).toBe(true);
      expect(await jobs.isRestrictedOrigin(identity("s-tool"), await submitRaw("true"))).toBe(true); // samme tekstform som `sweepDeliveries` leser (`->>` gir 'true' for begge)
      for (const value of [false, "false", 1, 0, null, "yes", "TRUE", {}, []]) {
        expect(await jobs.isRestrictedOrigin(identity("s-tool"), await submitRaw(value)), JSON.stringify(value)).toBe(false);
      }
    } finally { restore(); }
  });
});

describe("D: kildevakt - oppkoblingen i main.ts (kun med vakten på)", () => {
  const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
  it("TasksDelegateTransport får predikatet KUN med vakten på (ellers nøyaktig to-argument-konstruksjonen fra før N1), og `jobOrigin` settes kun med vakten på", () => {
    expect(main).toContain("restrictedContextGuard.enabled ? new TasksDelegateTransport(taskService, chatJobs, withholdsRestrictedJobFromCloud) : new TasksDelegateTransport(taskService, chatJobs)");
    expect(main.match(/withholdsRestrictedJobFromCloud/g)).toHaveLength(2); // import + bruk
    expect(main).toContain("...(restrictedContextGuard.enabled ? { jobOrigin: { isRestricted: (identity: Parameters<ChatJobs[\"isRestrictedOrigin\"]>[0], taskId: string) => chatJobs.isRestrictedOrigin(identity, taskId) } } : {}),");
    expect(main.match(/jobOrigin/g)).toHaveLength(1);
  });
});
