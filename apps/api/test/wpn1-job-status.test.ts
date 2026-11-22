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
import { MeshToolExecutor, SURFACE_LIMITS, ToolGateway, allMeshTools, resolveModelToolSurface } from "@jarvis/tool-gateway";
import { ChatJobs, TasksDelegateTransport, WITHHELD_JOB_NOTE_NO, WITHHELD_JOB_TITLE, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { ConversationEngine } from "../src/conversation.ts";
import { toolOutputBearsRestrictedJob, withholdsRestrictedJobFromCloud } from "../src/restricted-context-guard.ts";

/**
 * WP-N1 (fiks-runde 2, F2-B1 / reviewer B NF-1): RESULTATET av en bakgrunnsjobb startet fra en LÅST tur nådde fortsatt skymodeller. Leveringsmeldingen ble merket (F-A2), men
 *  (a) `tasks.get_task_status` (ChatJobs.get/list -> `result_text`/`error`/`title`) ga teksten fra den lokale modellen til et sky-stemplet kall, også via ekte `MeshToolExecutor`, og
 *  (b) hurtigbanens `jobbstatus <id>` gjengav resultatet i et svar som ble lagret UMERKET (`task_status: false`) og fulgte med historikken til neste skytur.
 * Fiks: (a) med vakten PÅ holdes tittel/resultat/feil tilbake VED UTFØRELSE for sky/ukjent modell (`withheld: true` + kort norsk merknad; lokal modell og eierens ruter uendret) - samme mønster som
 * `withholdFinanceFromCloud`; (b) `jobbstatus` for en jobb med `restricted_origin` låser turen FØR svaret lagres (bruker- og assistentrad begrenset). Vakten AV: uendret view, uendret kallform, ingen oppslag.
 * Alt mot ekte Postgres (ekte kø, ekte kontraktsskjema, ekte MessageStore/ContextBuilder) og den ekte ToolGateway/MeshToolExecutor.
 *
 * Fiks-runde 3 (siste): R3-1 (reviewer B NF-3) - en LOKAL modell i en ULÅST verktøytur (dagstak/fallback) fikk det rå viewet, og svaret ble lagret umerket (seksjon E: den trusted booleanen `restricted` + lås i `trackedExecutor`),
 * R3-2 - `jobbstatus` er fail-closed når `jobOrigin` mangler med vakten på, og R3-3 (reviewer A K29/K30) - `jobbstatus` låser uavhengig av jobbens status (seksjon B).
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let queue: PgTaskQueue;
const T = "t-n1st";
const identity = (session: string): IdentityContext => ({ person_id: "p-1", tenant_id: T, memory_space_id: "personal", session_id: session, device_id: "d-1", channel: "web", auth_strength: "active" });
const SESSIONS = ["s-tool", "s-fast-lock", "s-fast-plain", "s-fast-off", "s-fast-err", "s-fast-next", "s-fast-states", "s-fast-omit", "s-fast-omit-off", "s-loc-get", "s-loc-list", "s-loc-plain", "s-loc-off", "s-loc-cloud", "s-loc-trunc", "s-loc-cloudtrunc", "s-loc-fail", "s-loc-spoof"];
const CLOUD = { provider: "anthropic", model: "claude-sonnet-5-5" };
const LOCAL = { provider: "gemma_local", model: "gemma3:4b" };
const LOCKED_RESULT = "N1ST-HEMMELIG-RESULTAT saldoen etter utbetalingen er 45 000";
const LOCKED_ERROR = "N1ST-HEMMELIG-FEIL kunne ikke lese kontoen til lønnen";
const LOCKED_TITLE = "N1ST-HEMMELIG-TITTEL lønn og saldo";

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
    parameters: { title: opts.title ?? LOCKED_TITLE, prompt: "Hent saldoen og lag en oppsummering av utbetalingen", use_tools: true } as never, idempotency_key: `k-${randomUUID()}`, servingModel: LOCAL,
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
      await complete(taskId, LOCKED_RESULT);
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
      await fail(failedId, LOCKED_ERROR);
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

  it("LOKAL modell får hele viewet pluss den trusted booleanen `restricted: true` (R3-1); eierens ruter (ingen servingModel) får NØYAKTIG det gamle viewet - lik viewet uten vakt - uten `restricted`; ingen av dem får `withheld`", async () => {
    const restore = silence();
    try {
      const guarded = chain(true);
      const plain = chain(false);
      const taskId = await start(guarded.gateway, guarded.submitted, { restricted: true });
      await complete(taskId, LOCKED_RESULT);
      const reference = jobOf(await status(plain.gateway, { task_id: taskId }, CLOUD)); // vakten AV: det rå viewet
      expect(reference).toMatchObject({ title: LOCKED_TITLE, result_text: LOCKED_RESULT });
      for (const model of [LOCAL, { provider: "ollama", model: "x" }, { provider: "local_llm", model: "x" }, { provider: "scripted", model: "x" }, undefined]) {
        const expected = model === undefined ? reference : { ...reference, restricted: true }; // R3-1: kun et modellvendt lokalt kall bærer den trusted booleanen
        const job = jobOf(await status(guarded.gateway, { task_id: taskId }, model));
        expect(job, String(model?.provider)).toEqual(expected);
        expect(Object.keys(job)).not.toContain("withheld");
        expect(Object.keys(job)).not.toContain("note_no");
        const listed = jobsOf(await status(guarded.gateway, {}, model)).find((j) => j["task_id"] === taskId)!;
        expect(listed, String(model?.provider)).toEqual(expected);
      }
    } finally { restore(); }
  });

  it("eierens egne ruter (`ChatJobs.list/get` uten valg, som `POST /chat/jobs`) får det gamle viewet - de åtte feltene, uten `restricted` og `withheld` - også for en LÅST jobb (R3-1: ingen nye felt der)", async () => {
    const restore = silence();
    try {
      const { gateway, submitted } = chain(true);
      const taskId = await start(gateway, submitted, { restricted: true });
      await complete(taskId, LOCKED_RESULT);
      const owner = new ChatJobs(app, { saveMessage: async () => undefined });
      const job = await owner.get(identity("s-tool"), taskId);
      expect(Object.keys(job!).sort()).toEqual(["created_at", "delivered", "error", "finished_at", "result_text", "status", "task_id", "title"]);
      expect(job).toMatchObject({ title: LOCKED_TITLE, result_text: LOCKED_RESULT });
      const listed = (await owner.list(identity("s-tool"), 10)).find((j) => j.task_id === taskId)!;
      expect(listed).toEqual(job);
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
      await complete(taskId, LOCKED_RESULT);
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
      await complete(taskId, LOCKED_RESULT);
      const job = jobOf(await status(gateway, { task_id: taskId }, CLOUD));
      expect(job).toMatchObject({ title: LOCKED_TITLE, result_text: LOCKED_RESULT });
      expect(Object.keys(job).sort()).toEqual(["created_at", "delivered", "error", "finished_at", "result_text", "status", "task_id", "title"]);
      await status(gateway, {}, CLOUD);
      expect(getSpy.mock.calls[0]!.length).toBe(2);
      expect(listSpy.mock.calls[0]!.length).toBe(2);
      expect(listSpy.mock.calls[0]![1]).toBe(8);
      // med vakten PÅ: eierens rute (ingen servingModel) kalles fortsatt uten tredje argument; en lokal modell får `markRestricted` (R3-1) og en skymodell `withholdRestricted` (F2-B1)
      const guarded = chain(true);
      const g = vi.spyOn(guarded.jobs, "get");
      const id2 = await start(guarded.gateway, guarded.submitted, { restricted: true });
      await status(guarded.gateway, { task_id: id2 }, LOCAL);
      await status(guarded.gateway, { task_id: id2 });
      await status(guarded.gateway, { task_id: id2 }, CLOUD);
      expect(g.mock.calls.map((c) => c.length)).toEqual([3, 2, 3]);
      expect(g.mock.calls[0]![2]).toEqual({ markRestricted: true });
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
  function engine(session: string, opts: { guard: boolean; origin?: "real" | "throws" | "omit"; calls?: Array<{ pref: string | undefined; messages: string[] }>; store?: MessageStore }) {
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
      ...(opts.guard ? { restrictedContextGuard: true, ...(opts.origin === "omit" ? {} : { jobOrigin: { isRestricted } }) } : {})
    } as never);
    return { e, isRestricted, id: identity(session) };
  }
  const rows = async (s: string) => (await admin.query("SELECT role, content, restricted FROM messages WHERE session_id = $1 ORDER BY created_at, message_id", [s])).rows as Array<{ role: string; content: string; restricted: boolean }>;
  const lockedJob = async (): Promise<string> => { const { gateway, submitted } = chain(true); const id = await start(gateway, submitted, { restricted: true }); await complete(id, LOCKED_RESULT); return id; };

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

  it("R3-3 (reviewer A C4, K29/K30): `jobbstatus` låser UAVHENGIG av jobbens status - en kjørende, feilet og avbrutt LÅST jobb gir rader [true,true] (ikke bare ferdige eller de med resultat); en ikke-låst jobb [false,false]", async () => {
    const restore = silence();
    try {
      const { gateway, submitted } = chain(true);
      const running = await start(gateway, submitted, { restricted: true });
      expect((await queue.claimNext("w-1", 30, ["executive"]))?.task_id).toBe(running); // kjørende: hentet av en worker, ikke ferdig
      const failed = await start(gateway, submitted, { restricted: true });
      await fail(failed, LOCKED_ERROR);
      const cancelled = await start(gateway, submitted, { restricted: true });
      expect(await queue.requestCancel(T, cancelled)).toBe("cancelled");
      const plain = await start(gateway, submitted, { restricted: false, title: "Vanlig jobb om PR-er" });
      const { e, id } = engine("s-fast-states", { guard: true });
      const states: Record<string, string> = {};
      for (const [label, taskId, expected] of [["running", running, [true, true]], ["failed", failed, [true, true]], ["cancelled", cancelled, [true, true]], ["plain", plain, [false, false]]] as const) {
        const before = (await rows("s-fast-states")).length;
        const reply = await e.handle(id, `jobbstatus ${taskId}`);
        const added = (await rows("s-fast-states")).slice(before);
        states[label] = reply.reply;
        expect(added.map((r) => r.restricted), label).toEqual(expected);
      }
      expect(states["running"]).toContain("running");
      expect(states["failed"]).toContain("failed");
      expect(states["cancelled"]).toContain("cancelled");
      expect(states["plain"]).toContain("created");
    } finally { restore(); }
  });

  it("R3-2: med vakten PÅ og UTEN `jobOrigin` (feilkoblet motor) låses `jobbstatus` fail-closed - også for en ikke-låst jobb; vakten AV (ingen markør, ingen oppslag): uendret", async () => {
    const restore = silence();
    try {
      const { gateway, submitted } = chain(true);
      const plain = await start(gateway, submitted, { restricted: false, title: "Vanlig jobb om PR-er" });
      const wired = engine("s-fast-omit", { guard: true, origin: "omit" });
      expect(wired.isRestricted).not.toHaveBeenCalled();
      await wired.e.handle(wired.id, `jobbstatus ${plain}`);
      expect((await rows("s-fast-omit")).map((r) => r.restricted)).toEqual([true, true]); // fail-closed: opprinnelsen kan ikke avgjøres
      expect(wired.isRestricted).not.toHaveBeenCalled(); // det finnes ikke noe oppslag å kalle
      const off = engine("s-fast-omit-off", { guard: false });
      await off.e.handle(off.id, `jobbstatus ${plain}`);
      expect((await rows("s-fast-omit-off")).map((r) => r.restricted)).toEqual([false, false]); // flagg AV = main
      expect(off.isRestricted).not.toHaveBeenCalled();
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

describe("E: R3-1 (reviewer B NF-3) - en LOKAL modell i en ULÅST verktøytur får det fulle jobbviewet; en restricted-origin-jobb bærer den trusted booleanen `restricted` og turen LÅSES", () => {
  const BENIGN = "N1R3-BENIGN rapporten er klar og har tolv sider"; // med vilje uten stikkord: merket finnes for det klassifisereren ikke fanger
  type Call = { pref: string | undefined; messages: string[] };
  const rowsOf = async (s: string) => (await admin.query("SELECT role, content, restricted FROM messages WHERE session_id = $1 ORDER BY created_at, message_id", [s])).rows as Array<{ role: string; content: string; restricted: boolean }>;
  const marks = async (s: string) => Number((await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE session_id = $1 AND type = 'message.restricted_marked'", [s])).rows[0].n);

  /**
   * Motor med EKTE ToolGateway/MeshToolExecutor (bygget av `chain(guard)`). `servedBy` = leverandøren adapteren stempler på verktøykallet; `dayCap` = dagstaket for sky er nådd (D-432), så verktøyturen går til den LOKALE modellen -
   * reviewer B sin probe. Den falske `completeWithTools` utfører ETT `tasks.get_task_status`-kall når teksten nevner «jobben», og svarer med resultatteksten modellen fikk (som en lokal modell ville gjort).
   */
  function toolEngine(session: string, o: { chain: ReturnType<typeof chain>; guard: boolean; servedBy: string; dayCap: boolean; args?: Record<string, unknown>; maxOutput?: number; store?: MessageStore; calls: Call[]; outputs?: unknown[] }) {
    const surface = resolveModelToolSurface(o.chain.gateway, { onlyRegistered: true, includeChatDelegateTier: true });
    const statusDef = surface.find((m) => m.tool_id === "tasks" && m.action === "get_task_status")!.def;
    const github = { name: "github__list_pull_requests", description: "x", input_schema: { type: "object", properties: {} } };
    const plain = async (input: CompleteInput) => {
      const pref = (input.providerPreference as string[] | undefined)?.[0];
      o.calls.push({ pref, messages: input.request.messages.map((m) => String(m.content)) });
      return { text: "ok uten stikkord", usage: { input_tokens: 1, output_tokens: 1 }, provider: pref ?? "gemma_local", model: "m" };
    };
    const gw = {
      complete: plain, stream: plain,
      completeWithTools: async (input: CompleteInput, run: { executor: ToolExecutor }) => {
        const pref = (input.providerPreference as string[] | undefined)?.[0];
        o.calls.push({ pref, messages: input.request.messages.map((m) => String(m.content)) });
        const last = String(input.request.messages.at(-1)?.content ?? "");
        if (!/jobben/i.test(last)) return { text: "ok uten stikkord", usage: { input_tokens: 1, output_tokens: 1 }, provider: pref ?? "gemma_local", model: "m" };
        const out = await run.executor.execute({ tool_call_id: "c1", tool_name: statusDef.name, arguments: o.args ?? {}, provider: o.servedBy, model: "m" } as never, { tenant_id: T, idempotency_key: `k-${randomUUID()}` });
        o.outputs?.push(out);
        const view = out.output as { job?: { result_text?: string | null }; jobs?: Array<{ result_text?: string | null }>; withheld?: boolean } | null;
        const first = view?.job ?? view?.jobs?.find((j) => typeof j.result_text === "string");
        return { text: `Jobben er ferdig: ${first?.result_text ?? "(ingen tekst)"}`, usage: { input_tokens: 1, output_tokens: 1 }, provider: o.servedBy, model: "m" };
      }
    };
    const e = new ConversationEngine({
      messages: o.store ?? new MessageStore(app), context: new ContextBuilder(app), gateway: gw as unknown as ModelGateway, tasks: {} as never, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
      toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" }, ...(o.dayCap ? { toolTurnDayCap: { cap_ore: 1, spentToday: async () => 1000 } } : {}),
      tools: {
        definitions: [statusDef, github] as never,
        executorFor: (i: IdentityContext, turn?: unknown) => new MeshToolExecutor(o.chain.gateway, i, o.maxOutput ?? 20_000, surface, turn as never) as unknown as ToolExecutor, catalog: () => "k",
        select: ({ surface: sf, text }: { surface: keyof typeof SURFACE_LIMITS; text: string }) => ({ definitions: (/\bjobben\b/i.test(text) ? [statusDef] : /\bPR\b/i.test(text) ? [github] : []) as never, limits: SURFACE_LIMITS[sf], tool_ids: ["tasks"] })
      },
      ...(o.guard ? { restrictedContextGuard: true } : {})
    } as never);
    return { e, id: identity(session) };
  }
  const ASK = "hvordan går det med jobben jeg ba om?";
  const startAndComplete = async (c: ReturnType<typeof chain>, opts: { restricted: boolean; title?: string; text?: string }) => {
    const taskId = await start(c.gateway, c.submitted, opts.title === undefined ? { restricted: opts.restricted } : { restricted: opts.restricted, title: opts.title });
    await complete(taskId, opts.text ?? BENIGN);
    return taskId;
  };

  it("NF-3 (id): dagstak nådd -> lokal modell kaller get_task_status for en LÅST jobb -> viewet bærer `restricted: true` -> turen låses: brukerrad og assistentrad lagres begrenset (revisjonsrad), og neste skytur sender IKKE resultatet", async () => {
    const restore = silence();
    try {
      const c = chain(true);
      const taskId = await startAndComplete(c, { restricted: true });
      const calls: Call[] = []; const outputs: unknown[] = [];
      const t = toolEngine("s-loc-get", { chain: c, guard: true, servedBy: "gemma_local", dayCap: true, args: { task_id: taskId }, calls, outputs });
      const reply = await t.e.handle(t.id, ASK);
      expect(calls.some((x) => x.pref !== "anthropic")).toBe(true); // en LOKAL modell serverte verktøyturen
      expect(reply.reply).toContain("N1R3-BENIGN"); // den lokale modellen fikk det fulle viewet (D-378 pkt 2)
      expect((outputs[0] as { output: { job: Record<string, unknown> } }).output.job["restricted"]).toBe(true);
      expect((await rowsOf("s-loc-get")).map((r) => r.restricted)).toEqual([true, true]); // NF-3: tidligere [false, false]
      expect(await marks("s-loc-get")).toBe(1);
      const next: Call[] = [];
      const cloud = toolEngine("s-loc-get", { chain: c, guard: true, servedBy: "anthropic", dayCap: false, calls: next });
      await cloud.e.handle(cloud.id, "list åpne PR-er på github");
      const sky = next.filter((x) => x.pref === "anthropic");
      expect(sky.length).toBeGreaterThan(0);
      expect(sky.some((x) => x.messages.some((m) => m.includes("N1R3-BENIGN") || m.includes(ASK)))).toBe(false); // verken resultatet eller spørsmålet (merket rad) nådde skyen
    } finally { restore(); }
  });

  it("NF-3 (liste): en liste med én låst og én vanlig jobb - kun den låste bærer `restricted: true`, og lokalt kall låser turen", async () => {
    const restore = silence();
    try {
      const c = chain(true);
      const lockedId = await startAndComplete(c, { restricted: true });
      const plainId = await startAndComplete(c, { restricted: false, title: "Vanlig jobb om PR-er", text: "Det er to åpne PR-er." });
      const calls: Call[] = []; const outputs: unknown[] = [];
      const t = toolEngine("s-loc-list", { chain: c, guard: true, servedBy: "gemma_local", dayCap: true, calls, outputs });
      await t.e.handle(t.id, ASK);
      const jobs = (outputs[0] as { output: { jobs: Array<Record<string, unknown>> } }).output.jobs;
      expect(jobs.find((j) => j["task_id"] === lockedId)!["restricted"]).toBe(true);
      expect(Object.keys(jobs.find((j) => j["task_id"] === plainId)!)).not.toContain("restricted");
      expect((await rowsOf("s-loc-list")).map((r) => r.restricted)).toEqual([true, true]);
    } finally { restore(); }
  });

  it("kontroll: en jobb fra en IKKE-låst tur gir et uendret view (ingen `restricted`), ingen lås, umerkede rader og tre-argument lagring", async () => {
    const restore = silence();
    try {
      const c = chain(true);
      const taskId = await startAndComplete(c, { restricted: false, title: "Vanlig jobb om PR-er", text: "Det er to åpne PR-er." });
      const saved: unknown[][] = [];
      const real = new MessageStore(app);
      const spy = Object.assign(Object.create(real), { save: (...a: unknown[]) => { saved.push(a); return (real.save as (...x: unknown[]) => Promise<string>)(...a); }, markRestricted: real.markRestricted.bind(real), history: real.history.bind(real) }) as MessageStore;
      const calls: Call[] = []; const outputs: unknown[] = [];
      const t = toolEngine("s-loc-plain", { chain: c, guard: true, servedBy: "gemma_local", dayCap: true, args: { task_id: taskId }, calls, outputs, store: spy });
      const reply = await t.e.handle(t.id, ASK);
      expect(reply.reply).toContain("Det er to åpne PR-er.");
      expect(Object.keys((outputs[0] as { output: { job: Record<string, unknown> } }).output.job).sort()).toEqual(["created_at", "delivered", "error", "finished_at", "result_text", "status", "task_id", "title"]);
      expect((await rowsOf("s-loc-plain")).map((r) => r.restricted)).toEqual([false, false]);
      expect(saved.map((a) => a.length)).toEqual([3, 3]);
      expect(await marks("s-loc-plain")).toBe(0);
    } finally { restore(); }
  });

  it("vakten AV: samme låste jobb og lokal verktøytur gir det rå viewet UTEN `restricted` og ingen lås (som main - lekkasjen er nettopp det flagget lukker)", async () => {
    const restore = silence();
    try {
      const c = chain(false);
      const taskId = await startAndComplete(c, { restricted: true });
      const calls: Call[] = []; const outputs: unknown[] = [];
      const t = toolEngine("s-loc-off", { chain: c, guard: false, servedBy: "gemma_local", dayCap: true, args: { task_id: taskId }, calls, outputs });
      const reply = await t.e.handle(t.id, ASK);
      expect(reply.reply).toContain("N1R3-BENIGN");
      expect(Object.keys((outputs[0] as { output: { job: Record<string, unknown> } }).output.job).sort()).toEqual(["created_at", "delivered", "error", "finished_at", "result_text", "status", "task_id", "title"]);
      expect((await rowsOf("s-loc-off")).map((r) => r.restricted)).toEqual([false, false]);
      expect(await marks("s-loc-off")).toBe(0);
    } finally { restore(); }
  });

  it("en SKYmodell får fortsatt `withheld` (R3-1 endrer ikke det): viewet har verken `restricted` eller resultat, og turen trenger ingen lås", async () => {
    const restore = silence();
    try {
      const c = chain(true);
      const taskId = await startAndComplete(c, { restricted: true });
      const calls: Call[] = []; const outputs: unknown[] = [];
      const t = toolEngine("s-loc-cloud", { chain: c, guard: true, servedBy: "anthropic", dayCap: false, args: { task_id: taskId }, calls, outputs });
      const reply = await t.e.handle(t.id, ASK);
      expect(calls.some((x) => x.pref === "anthropic")).toBe(true);
      const job = (outputs[0] as { output: { job: Record<string, unknown> } }).output.job;
      expect(job).toMatchObject({ withheld: true, title: WITHHELD_JOB_TITLE, result_text: null, error: null });
      expect(Object.keys(job)).not.toContain("restricted");
      expect(reply.reply).not.toContain("N1R3-BENIGN");
      expect((await rowsOf("s-loc-cloud")).map((r) => r.restricted)).toEqual([false, false]);
    } finally { restore(); }
  });

  it("utkuttet output (MeshToolExecutor.maxOutputChars) kan ikke avgjøres og låser fail-closed - den trusted booleanen kan ha ligget i den avkuttede halen", async () => {
    const restore = silence();
    try {
      const c = chain(true);
      const taskId = await startAndComplete(c, { restricted: true });
      const calls: Call[] = []; const outputs: unknown[] = [];
      const t = toolEngine("s-loc-trunc", { chain: c, guard: true, servedBy: "gemma_local", dayCap: true, args: { task_id: taskId }, maxOutput: 200, calls, outputs });
      await t.e.handle(t.id, ASK);
      expect((outputs[0] as { output: { truncated?: boolean } }).output.truncated).toBe(true);
      expect((await rowsOf("s-loc-trunc")).map((r) => r.restricted)).toEqual([true, true]);
    } finally { restore(); }
  });

  it("et SKYkall med utkuttet output låser ikke: det tilbakeholdte viewet inneholder ingenting begrenset, så det finnes ikke noe å låse for", async () => {
    const restore = silence();
    try {
      const c = chain(true);
      const taskId = await startAndComplete(c, { restricted: true });
      const calls: Call[] = []; const outputs: unknown[] = [];
      const t = toolEngine("s-loc-cloudtrunc", { chain: c, guard: true, servedBy: "anthropic", dayCap: false, args: { task_id: taskId }, maxOutput: 200, calls, outputs });
      await t.e.handle(t.id, ASK);
      expect((outputs[0] as { output: { truncated?: boolean } }).output.truncated).toBe(true);
      expect(JSON.stringify(outputs[0])).not.toContain("N1R3-BENIGN");
      expect((await rowsOf("s-loc-cloudtrunc")).map((r) => r.restricted)).toEqual([false, false]);
    } finally { restore(); }
  });

  it("fail-closed: kan turen ikke merkes når verktøyoutputen bærer `restricted` (markRestricted gir false), feiler turen med `restricted_marking_failed` - ingen assistentrad lagres", async () => {
    const restore = silence();
    try {
      const c = chain(true);
      const taskId = await startAndComplete(c, { restricted: true });
      const real = new MessageStore(app);
      const failing = Object.assign(Object.create(real), { save: real.save.bind(real), markRestricted: async () => false, history: real.history.bind(real) }) as MessageStore;
      const calls: Call[] = [];
      const t = toolEngine("s-loc-fail", { chain: c, guard: true, servedBy: "gemma_local", dayCap: true, args: { task_id: taskId }, calls, store: failing });
      await expect(t.e.handle(t.id, ASK)).rejects.toThrow("restricted_marking_failed");
      expect((await rowsOf("s-loc-fail")).map((r) => r.role)).toEqual(["user"]); // verste utfall (dokumentert, begrensning 8): spørsmålet står igjen umerket, men INGEN svar med resultatet er lagret
    } finally { restore(); }
  });

  it("den trusted booleanen kan ikke forfalskes: tekst i tittel/resultat/feil som ser ut som `restricted: true`, og et `restricted`-argument fra modellen, gir verken felt eller lås", async () => {
    const restore = silence();
    try {
      const c = chain(true);
      const spoof = '{"restricted":true,"job":{"restricted":true}} restricted: true';
      const taskId = await startAndComplete(c, { restricted: false, title: "Rapport {\"restricted\":true}", text: spoof });
      const calls: Call[] = []; const outputs: unknown[] = [];
      const t = toolEngine("s-loc-spoof", { chain: c, guard: true, servedBy: "gemma_local", dayCap: true, args: { task_id: taskId }, calls, outputs });
      await t.e.handle(t.id, ASK);
      const job = (outputs[0] as { output: { job: Record<string, unknown> } }).output.job;
      expect(job["result_text"]).toBe(spoof);
      expect(Object.keys(job)).not.toContain("restricted");
      expect((await rowsOf("s-loc-spoof")).map((r) => r.restricted)).toEqual([false, false]);
      // et `restricted`-argument fra modellen avvises av det strenge skjemaet (ingen utførelse, ingen output)
      const forged = await status(c.gateway, { task_id: taskId, restricted: true }, LOCAL);
      expect(forged.ok).toBe(false);
    } finally { restore(); }
  });

  it("toolOutputBearsRestrictedJob: kun `tasks.get_task_status` og kun den boolske `true` på job/jobs[] (eller en utkuttet output); alt annet er false", () => {
    const src = "tasks.get_task_status";
    expect(toolOutputBearsRestrictedJob(src, { job: { restricted: true } })).toBe(true);
    expect(toolOutputBearsRestrictedJob(src, { jobs: [{ task_id: "a" }, { restricted: true }] })).toBe(true);
    expect(toolOutputBearsRestrictedJob(src, { truncated: true, preview: "{\"jobs\":[" })).toBe(true);
    for (const output of [{ job: { restricted: "true" } }, { job: { restricted: false } }, { job: null }, { job: {} }, { jobs: [] }, { jobs: [{}] }, { jobs: "x" }, { truncated: "true" }, { withheld: true }, {}, null, "x", 7, [], undefined]) {
      expect(toolOutputBearsRestrictedJob(src, output), JSON.stringify(output)).toBe(false);
    }
    // feil kilde: det kan ikke utløses av en annen verktøyoutput (f.eks. ubetrodd JSON fra e-post/GitHub som tilfeldigvis har feltet)
    for (const source of [undefined, "", "email.read_inbox", "tasks.delegate_background_task", "tasks.get_task_status ", "TASKS.GET_TASK_STATUS", "github.list_issues"]) {
      expect(toolOutputBearsRestrictedJob(source, { job: { restricted: true } }), String(source)).toBe(false);
      expect(toolOutputBearsRestrictedJob(source, { truncated: true }), String(source)).toBe(false);
    }
  });
});

describe("D: kildevakt - oppkoblingen i main.ts (kun med vakten på)", () => {
  const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
  it("R3-1/R3-2: samtalemotoren låser i `trackedExecutor` (kun fra `tasks.get_task_status`, kun med markør, ikke for skykall) og `jobbstatus` er fail-closed uten `jobOrigin`", () => {
    const conversation = readFileSync(fileURLToPath(new URL("../src/conversation.ts", import.meta.url)), "utf8");
    expect(conversation).toContain('if (marker && !servedByCloudModel(call) && toolOutputBearsRestrictedJob(out.source, out.output)) await marker.lock(["tool_output:tasks.get_task_status"]);');
    expect(conversation).toContain("const restrictedJob = this.deps.jobOrigin ? await this.deps.jobOrigin.isRestricted(identity, intent.task_id).catch(() => true) : true;");
    expect(conversation.match(/toolOutputBearsRestrictedJob\(/g)).toHaveLength(1);
  });

  it("TasksDelegateTransport får predikatet KUN med vakten på (ellers nøyaktig to-argument-konstruksjonen fra før N1), og `jobOrigin` settes kun med vakten på", () => {
    expect(main).toContain("restrictedContextGuard.enabled ? new TasksDelegateTransport(taskService, chatJobs, withholdsRestrictedJobFromCloud) : new TasksDelegateTransport(taskService, chatJobs)");
    expect(main.match(/withholdsRestrictedJobFromCloud/g)).toHaveLength(2); // import + bruk
    expect(main).toContain("...(restrictedContextGuard.enabled ? { jobOrigin: { isRestricted: (identity: Parameters<ChatJobs[\"isRestrictedOrigin\"]>[0], taskId: string) => chatJobs.isRestrictedOrigin(identity, taskId) } } : {}),");
    expect(main.match(/jobOrigin/g)).toHaveLength(1);
  });
});
