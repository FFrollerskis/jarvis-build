import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ConfirmationStore, ContextBuilder, MessageStore, PgApprovalStore, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { MemoryTraceSink, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { PgTaskQueue, TaskService, type InProcessWorker } from "@jarvis/tasks";
import { MeshToolExecutor, RESTRICTED_TURN_REASON, SURFACE_LIMITS, ToolGateway, buildToolManifest, createTurnContext, resolveModelToolSurface } from "@jarvis/tool-gateway";
import { ChatJobs, TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { ConversationEngine } from "../src/conversation.ts";
import { RestrictedTurnMarker, confirmationRestrictsOrigin, createDeliverySaver, withholdsRestrictedJobFromCloud } from "../src/restricted-context-guard.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-N1 (fiks-runde 2, F2-A1 / reviewer A N1): BEKREFTELSESBANEN mistet `restricted_origin`. En delegering fra en LÅST og TAINTED web_chat-tur krever eierens bundne bekreftelse (D-416); utførelsen flytter da fra executoren til
 * `/confirmations` (server.ts `approveAndTake` -> `gateway.execute`), og begge kallene mistet merket - kontrakten fikk ingen `restricted_origin`, leveringen ble lagret umerket og neste skytur bar den. Fiks i tre ledd:
 * (1) `MeshToolExecutor` legger `restricted_turn` i kortets grunner når turbildet er låst, (2) `approveAndTake` returnerer kortets `taint_reasons`, (3) `/confirmations` utfører `tasks.delegate_background_task` med `restrictedOrigin` når kortet bærer grunnen.
 *  A. ekte kjede og EKTE HTTP-rute: ekte TaskService.submit (ekte PolicyGateway, jobbkø, kontraktsskjema), ekte ToolGateway, ekte MeshToolExecutor MED guards (manifest + ConfirmationStore), ekte `createApiServer` `/confirmations`.
 *  B. rutens kallform mot en gateway som tar opp kallene: kun delegeringen, kun med grunnen; ellers ingen `restrictedOrigin`-nøkkel.
 *  C. flagg AV / ikke-låst tur: kortets grunner er nøyaktig som før N1.
 *  D. kildevakt: server.ts er det tredje stedet som setter `restrictedOrigin`.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let queue: PgTaskQueue;
const T = "t-n1cf";
const identity = (session: string): IdentityContext => ({ person_id: "p-1", tenant_id: T, memory_space_id: "personal", session_id: session, device_id: "d-1", channel: "web", auth_strength: "active" });
const SESSIONS = ["s-http", "s-plain", "s-off", "s-act", "s-other"];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-n1cf-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_n1cf LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_n1cf");
  const sessions = SESSIONS.map((s, i) => `('${s}','${T}','p-1','${i === 0 ? "active" : "closed"}','web','d-1')`).join(",");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','N1CF','person');
    INSERT INTO people (person_id, display_name) VALUES ('p-1','Én');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('p-1','${T}');
    INSERT INTO sessions (session_id, tenant_id, person_id, status, last_channel, last_device_id) VALUES ${sessions};`);
  app = createPool({ ...base, user: "jarvis_n1cf", password: "pw2" });
  queue = new PgTaskQueue(app);
}, 240_000);
afterAll(async () => { await app?.end(); await admin?.end(); await stop?.(); }, 120_000);
/** Hver test starter med en tom kø (jobber fra tidligere tester ville ellers stjele `claimNext` og telle mot taket på aktive jobber). */
beforeEach(async () => { for (;;) { const t = await queue.claimNext("w-drain", 30, ["executive"]); if (!t) break; await queue.complete(T, t.task_id, "w-drain", { text: "tømt" }); } });

const silence = () => { const a = vi.spyOn(console, "log").mockImplementation(() => undefined); const b = vi.spyOn(console, "error").mockImplementation(() => undefined); return () => { a.mockRestore(); b.mockRestore(); }; };

/** Ekte kjede (ekte `TaskService.submit` med ekte PolicyGateway, kø og kontraktsskjema), med lagringsspor for leveringene. `guardEnabled` = om main.ts kobler predikatet og leveringsfabrikken med vakten på. */
function realChain(guardEnabled: boolean) {
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(app), killSwitch: new KillSwitch(), authority: { owner_person_id: "p-1", owner_tenants: [T] } });
  const taskService = new TaskService(app, queue, policy, {});
  const saved: Array<{ argc: number; opts: unknown }> = [];
  const store = new MessageStore(app);
  const spy = { save: (...args: Parameters<MessageStore["save"]>) => { saved.push({ argc: args.length, opts: args[3] }); return store.save(...args); } } as Pick<MessageStore, "save">;
  const jobs = new ChatJobs(app, { saveMessage: createDeliverySaver(spy, guardEnabled) });
  const gateway = new ToolGateway(app, policy, { name: "test", async get() { return "secret"; } });
  for (const tool of tasksDelegateToolDefinitions(guardEnabled ? new TasksDelegateTransport(taskService, jobs, withholdsRestrictedJobFromCloud) : new TasksDelegateTransport(taskService, jobs))) gateway.register(tool);
  return { gateway, jobs, saved };
}

const contractRows = async (session: string) => (await admin.query("SELECT task_id, contract FROM tasks WHERE contract->'input'->>'provenance' = $1 ORDER BY created_at", [`chat:${session}`])).rows as Array<{ task_id: string; contract: { input: { data: Record<string, unknown> } } }>;
const rows = async (s: string) => (await admin.query("SELECT role, content, restricted FROM messages WHERE session_id = $1 ORDER BY created_at, message_id", [s])).rows as Array<{ role: string; content: string; restricted: boolean }>;
const card = async (confirmationId: string) => (await admin.query("SELECT status, taint_reasons, summary FROM action_confirmations WHERE confirmation_id = $1", [confirmationId])).rows[0] as { status: string; taint_reasons: string[]; summary: { taint_reasons: string[] } };

/** Kortets fingeravtrykk er (verktøy, handling, parametere, tenant, person, enhet) - IKKE økten: hver test bruker egne parametere, så et kort fra en annen test aldri gjenbrukes. */
const request = (tag: string) => ({ title: `Ukesoppsummering ${tag}`, prompt: `Oppsummer det jeg har skrevet om lønnen min den siste uken (${tag})` });
const REQUEST = request("route");

/** Et turbilde bygget som motoren gjør det: `RestrictedTurnMarker.attachTurn` + `lock` setter `restricted` på turbildet (kun med vakten på). `tainted` = lokal modell leste ubetrodd innhold i turen (e-post/GitHub/jobbstatus). */
async function turnFor(session: string, opts: { locked: boolean; tainted: boolean }) {
  const turn = createTurnContext("web_chat", "x");
  if (opts.locked) {
    const marker = new RestrictedTurnMarker({ markRestricted: async () => true }, identity(session), "m-1");
    marker.attachTurn(turn);
    await marker.lock(["text:finance"]);
    expect(turn.restricted).toBe(true);
  } else {
    expect(turn.restricted).toBeUndefined();
  }
  if (opts.tainted) turn.taint.mark("untrusted_output:tasks.get_task_status");
  return turn;
}

/** Modellens delegeringskall gjennom den EKTE `MeshToolExecutor` med guards: tainted tur gir `confirmation_required` og et kort (utførelsen skjer først ved eierens godkjenning). */
async function proposeDelegation(gateway: ToolGateway, session: string, turn: ReturnType<typeof createTurnContext>, tag: string) {
  const tools = resolveModelToolSurface(gateway, { onlyRegistered: true, includeChatDelegateTier: true });
  const manifest = buildToolManifest(gateway.list());
  const confirmations = new ConfirmationStore(app);
  const name = tools.find((m) => m.tool_id === "tasks" && m.action === "delegate_background_task")!.def.name;
  const executor = new MeshToolExecutor(gateway, identity(session), 20_000, tools, turn, { manifest, confirmations });
  const result = await executor.execute({ tool_call_id: `c-${randomUUID()}`, tool_name: name, arguments: request(tag), provider: "gemma_local", model: "gemma3:4b" } as never, { tenant_id: T, idempotency_key: `k-${randomUUID()}` });
  return { result, confirmations, output: result.output as { confirmation_required?: boolean; confirmation_id?: string | null; status?: string } };
}

/** `createApiServer` med ekte gateway og ekte ConfirmationStore; grant-/identitetsløsingen er den samme enkle som i `part3-confirmations-execute-route`. Returnerer en `post` mot den EKTE `/confirmations`-ruten. */
async function withRoute<R>(deps: { gateway: unknown; confirmations: unknown; session?: string }, run: (post: (confirmationId: string, decision?: "approve" | "reject") => Promise<Response>) => Promise<R>): Promise<R> {
  const fake = {
    grants: { verify: async (token: string) => (token === "good-grant"
      ? { ok: true, grant: { person_id: "p-1", tenant_id: T, memory_space: "personal", session_id: deps.session ?? "s-http", device_id: "d-1", channel: "web", auth_strength: "signed" } }
      : { ok: false, reason: "grant_invalid" }) },
    identity: { resolveIdentity: async (i: Record<string, string>) => ({ ok: true, identity: { person_id: i["person_id"], tenant_id: i["tenant_id"], memory_space_id: i["memory_space"], session_id: i["session_id"], device_id: i["device_id"], channel: i["channel"], auth_strength: i["auth_strength"] } }) },
    executive: { gateway: deps.gateway },
    confirmations: deps.confirmations
  } as unknown as ApiDeps;
  const server = createApiServer(fake);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await run((confirmationId, decision = "approve") => fetch(`${url}/confirmations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_token: "good-grant", action: "decide", parameters: { confirmation_id: confirmationId, decision } }) }));
  } finally { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); }
}

type Call = { pref: string | undefined; messages: string[] };
function cloudEngine(calls: Call[]): ConversationEngine {
  const def = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {} } });
  const github = def("github__list_pull_requests");
  const serve = async (input: CompleteInput) => {
    calls.push({ pref: (input.providerPreference as string[] | undefined)?.[0], messages: input.request.messages.map((m) => String(m.content)) });
    return { text: "ok uten stikkord", usage: { input_tokens: 1, output_tokens: 1 }, provider: (input.providerPreference as string[] | undefined)?.[0] ?? "gemma_local", model: "m" };
  };
  return new ConversationEngine({
    messages: new MessageStore(app), context: new ContextBuilder(app), gateway: { complete: serve, stream: serve, completeWithTools: serve } as unknown as ModelGateway,
    tasks: {} as never, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(), toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" },
    tools: {
      definitions: [github] as never, executorFor: () => ({ execute: async () => { throw new Error("x"); } }) as unknown as ToolExecutor, catalog: () => "k",
      select: ({ surface, text }: { surface: keyof typeof SURFACE_LIMITS; text: string }) => ({ definitions: (/\bPR\b/i.test(text) ? [github] : []) as never, limits: SURFACE_LIMITS[surface], tool_ids: /\bPR\b/i.test(text) ? ["github"] : [] })
    },
    restrictedContextGuard: true
  } as never);
}

async function completeJob(taskId: string) {
  expect((await queue.claimNext("w-1", 30, ["executive"]))?.task_id).toBe(taskId);
  await queue.complete(T, taskId, "w-1", { text: "Det som gjenstår etter utbetalingen er 45 000." });
}

describe("A: ekte kjede + EKTE `/confirmations`-rute - en delegering fra en LÅST og TAINTED tur beholder `restricted_origin` etter godkjenning (reviewer A sin C1, nå lukket)", () => {
  it("kortet bærer `restricted_turn`; godkjenning via HTTP gir kontrakt med restricted_origin=true, levering lagret restricted=true (4 argumenter), og neste skytur sender IKKE leveringen", async () => {
    const restore = silence();
    try {
      const { gateway, jobs, saved } = realChain(true);
      const turn = await turnFor("s-http", { locked: true, tainted: true });
      const { result, confirmations, output } = await proposeDelegation(gateway, "s-http", turn, "a1");
      expect(result.success).toBe(false);
      expect(output.confirmation_required).toBe(true);
      expect(await contractRows("s-http")).toHaveLength(0); // ingenting kjørte før godkjenningen
      const id = output.confirmation_id!;
      const pending = await card(id);
      expect(pending.status).toBe("pending");
      expect(pending.taint_reasons).toEqual(["untrusted_output:tasks.get_task_status", RESTRICTED_TURN_REASON]);
      expect(pending.summary.taint_reasons).toEqual(pending.taint_reasons);

      const response = await withRoute({ gateway, confirmations, session: "s-http" }, (post) => post(id));
      expect(response.status).toBe(200);
      const body = await response.json() as { ok: boolean; data: { executed: boolean; tool: string; result: { ok: boolean } } };
      expect(body.data).toMatchObject({ executed: true, tool: "tasks.delegate_background_task", result: { ok: true } });

      const contracts = await contractRows("s-http");
      expect(contracts).toHaveLength(1);
      expect(contracts[0]!.contract.input.data["restricted_origin"]).toBe(true); // F2-A1: tidligere manglet nøkkelen
      expect(contracts[0]!.contract.input.data["delegated_from_chat"]).toBe(true);

      await completeJob(contracts[0]!.task_id);
      expect(await jobs.sweepDeliveries(identity("s-http"))).toBe(1);
      expect(saved).toEqual([{ argc: 4, opts: { restricted: true } }]);
      const delivery = (await rows("s-http")).find((r) => r.content.includes("45 000"))!;
      expect(delivery.role).toBe("assistant");
      expect(delivery.restricted).toBe(true);

      const calls: Call[] = [];
      await cloudEngine(calls).handle(identity("s-http"), "list åpne PR-er på github");
      const cloud = calls.find((c) => c.pref === "anthropic");
      expect(cloud).toBeDefined();
      expect(cloud!.messages.some((m) => m.includes("45 000"))).toBe(false); // leveringen holdes utenfor skyvarianten
    } finally { restore(); }
  });

  it("kontroll: en TAINTED men IKKE låst tur gir et kort uten `restricted_turn`; etter godkjenning har kontrakten ingen restricted_origin og leveringen lagres som før (tre argumenter, umerket)", async () => {
    const restore = silence();
    try {
      const { gateway, jobs, saved } = realChain(true);
      const turn = await turnFor("s-plain", { locked: false, tainted: true });
      const { output, confirmations } = await proposeDelegation(gateway, "s-plain", turn, "a2");
      expect(output.confirmation_required).toBe(true);
      expect((await card(output.confirmation_id!)).taint_reasons).toEqual(["untrusted_output:tasks.get_task_status"]);
      const response = await withRoute({ gateway, confirmations, session: "s-plain" }, (post) => post(output.confirmation_id!));
      expect(response.status).toBe(200);
      const contracts = await contractRows("s-plain");
      expect(contracts).toHaveLength(1);
      expect(Object.keys(contracts[0]!.contract.input.data)).not.toContain("restricted_origin");
      await completeJob(contracts[0]!.task_id);
      expect(await jobs.sweepDeliveries(identity("s-plain"))).toBe(1);
      expect(saved).toEqual([{ argc: 3, opts: undefined }]);
      expect((await rows("s-plain")).find((r) => r.content.includes("45 000"))!.restricted).toBe(false);
    } finally { restore(); }
  });

  it("avvisning utfører aldri noe og lager ingen kontrakt, også for et kort med `restricted_turn`", async () => {
    const restore = silence();
    try {
      const { gateway } = realChain(true);
      const turn = await turnFor("s-other", { locked: true, tainted: true });
      const { output, confirmations } = await proposeDelegation(gateway, "s-other", turn, "a3");
      const response = await withRoute({ gateway, confirmations, session: "s-other" }, (post) => post(output.confirmation_id!, "reject"));
      expect(response.status).toBe(200);
      expect(await contractRows("s-other")).toHaveLength(0);
      expect((await card(output.confirmation_id!)).status).toBe("rejected");
    } finally { restore(); }
  });
});

describe("B: `/confirmations` sin kallform mot gatewayen - `restrictedOrigin` KUN for delegeringen og KUN når kortet bærer grunnen", () => {
  type Taken = { confirmation_id: string; tool_id: string; action: string; parameters: Record<string, unknown>; taint_reasons?: string[] };
  async function approve(taken: Taken | null) {
    const executed: Array<Record<string, unknown>> = [];
    const gateway = { get: () => undefined, execute: async (call: Record<string, unknown>) => { executed.push(call); return { ok: true, data: { started: true }, external_id: "ext-1" }; } };
    const confirmations = { peekPending: async () => null, approveAndTake: async () => taken, recordResult: async () => undefined, decide: async () => true, listPending: async () => [] };
    const response = await withRoute({ gateway, confirmations }, (post) => post("conf-x"));
    return { executed, status: response.status };
  }
  const delegate = (taint_reasons: string[] | undefined): Taken => ({ confirmation_id: "conf-x", tool_id: "tasks", action: "delegate_background_task", parameters: REQUEST, ...(taint_reasons ? { taint_reasons } : {}) });

  it("delegering med `restricted_turn` i kortet (alene eller sammen med andre grunner) -> `restrictedOrigin: true` er med; øvrige felter som før", async () => {
    for (const reasons of [[RESTRICTED_TURN_REASON], ["untrusted_output:email.read_inbox", RESTRICTED_TURN_REASON], [RESTRICTED_TURN_REASON, "owner_action_tier"]]) {
      const { executed, status } = await approve(delegate(reasons));
      expect(status, JSON.stringify(reasons)).toBe(200);
      expect(executed, JSON.stringify(reasons)).toHaveLength(1);
      expect(executed[0]!["restrictedOrigin"], JSON.stringify(reasons)).toBe(true);
      expect(Object.keys(executed[0]!).sort()).toEqual(["action", "idempotency_key", "identity", "parameters", "restrictedOrigin", "tool_id"]);
      expect(executed[0]).toMatchObject({ tool_id: "tasks", action: "delegate_background_task", parameters: REQUEST, idempotency_key: "confirmation:conf-x" });
    }
  });

  it("delegering UTEN grunnen (andre grunner, tom liste, manglende felt, nesten-lik tekst) -> INGEN `restrictedOrigin`-nøkkel: kallet er identisk med før N1", async () => {
    for (const reasons of [[], ["owner_action_tier"], ["untrusted_output:email.read_inbox"], undefined, ["RESTRICTED_TURN"], ["restricted_turn "], ["restricted"], ["restricted_turns"]]) {
      const { executed } = await approve(delegate(reasons));
      expect(executed, JSON.stringify(reasons)).toHaveLength(1);
      expect(Object.keys(executed[0]!).sort(), JSON.stringify(reasons)).toEqual(["action", "idempotency_key", "identity", "parameters", "tool_id"]);
    }
  });

  it("grunnen på et ANNET verktøy (eller en annen handling) gir ingen `restrictedOrigin` - kun delegeringen har noe å merke", async () => {
    for (const [tool_id, action] of [["todoist", "create_task"], ["email", "send"], ["tasks", "cancel_task"], ["tasks", "get_task_status"], ["task", "delegate_background_task"], ["tasks", "Delegate_Background_Task"]] as const) {
      const { executed } = await approve({ confirmation_id: "conf-x", tool_id, action, parameters: { x: 1 }, taint_reasons: [RESTRICTED_TURN_REASON, "owner_action_tier"] });
      expect(executed, `${tool_id}.${action}`).toHaveLength(1);
      expect(Object.keys(executed[0]!), `${tool_id}.${action}`).not.toContain("restrictedOrigin");
    }
  });

  it("en parameter eller et felt som ser ut som grunnen påvirker ingenting (kun kortets `taint_reasons` fra trusted lag teller)", async () => {
    const forged: Taken = { ...delegate(["owner_action_tier"]), parameters: { ...REQUEST, taint_reasons: [RESTRICTED_TURN_REASON], restricted_turn: true, restrictedOrigin: true } };
    const { executed } = await approve(forged);
    expect(Object.keys(executed[0]!)).not.toContain("restrictedOrigin");
  });

  it("ingen godkjenning (ukjent/utløpt kort) utfører ikke noe og sender ingenting", async () => {
    const { executed, status } = await approve(null);
    expect(status).toBe(404);
    expect(executed).toEqual([]);
  });

  it("avgjørelsen er en ren funksjon over kortet: `confirmationRestrictsOrigin`", () => {
    expect(confirmationRestrictsOrigin({ tool_id: "tasks", action: "delegate_background_task", taint_reasons: [RESTRICTED_TURN_REASON] })).toBe(true);
    expect(confirmationRestrictsOrigin({ tool_id: "tasks", action: "delegate_background_task", taint_reasons: ["a", RESTRICTED_TURN_REASON, "b"] })).toBe(true);
    expect(confirmationRestrictsOrigin({ tool_id: "tasks", action: "delegate_background_task", taint_reasons: [] })).toBe(false);
    expect(confirmationRestrictsOrigin({ tool_id: "tasks", action: "delegate_background_task" })).toBe(false);
    expect(confirmationRestrictsOrigin({ tool_id: "tasks", action: "get_task_status", taint_reasons: [RESTRICTED_TURN_REASON] })).toBe(false);
    expect(confirmationRestrictsOrigin({ tool_id: "email", action: "delegate_background_task", taint_reasons: [RESTRICTED_TURN_REASON] })).toBe(false);
  });
});

describe("C: grunnen er en nøytral intern kode, og uten låst tur (flagg AV: `turn.restricted` settes aldri) er kortets grunner NØYAKTIG som før N1", () => {
  it("`restricted_turn` er en kort, nøytral kode (ingen tall, ingen leverandørnavn, ingen innhold)", () => {
    expect(RESTRICTED_TURN_REASON).toBe("restricted_turn");
    expect(/\d/.test(RESTRICTED_TURN_REASON)).toBe(false);
    expect(RESTRICTED_TURN_REASON).toMatch(/^[a-z_]+$/);
  });

  it("flagg AV (turbildet har aldri `restricted`): kortet har kun de eksisterende grunnene; et identisk kall fra en senere LÅST tur gjenbruker det ventende kortet uten å endre grunnene (fingeravtrykket inkluderer ikke grunnene)", async () => {
    const restore = silence();
    try {
      const { gateway } = realChain(false);
      const off = await turnFor("s-off", { locked: false, tainted: true });
      const first = await proposeDelegation(gateway, "s-off", off, "c2");
      const before = await card(first.output.confirmation_id!);
      expect(before.taint_reasons).toEqual(["untrusted_output:tasks.get_task_status"]);
      expect(before.summary.taint_reasons).toEqual(["untrusted_output:tasks.get_task_status"]);
      // identisk kall fra en LÅST tur gjenbruker det ventende kortet (fingeravtrykket inkluderer ikke grunnene): bindingen og grunnene er uendret
      const locked = await turnFor("s-off", { locked: true, tainted: true });
      const again = await proposeDelegation(gateway, "s-off", locked, "c2");
      expect(again.output.confirmation_id).toBe(first.output.confirmation_id);
      expect(again.output.status).toBe("confirmation_pending");
      expect((await card(first.output.confirmation_id!)).taint_reasons).toEqual(["untrusted_output:tasks.get_task_status"]);
    } finally { restore(); }
  });

  it("`approveAndTake` gir grunnene tilbake i opprettelsesrekkefølge og tom liste for et kort uten (kortet fra før N1 / uten grunner er ikke et brudd)", async () => {
    const restore = silence();
    try {
      const confirmations = new ConfirmationStore(app);
      const call = { tool_id: "tasks", action: "delegate_background_task", parameters: { title: "Annet", prompt: "Noe helt annet enn forrige gang" } };
      const who = { tenant_id: T, person_id: "p-1", device_id: "d-1", session_id: "s-act" };
      const created = await confirmations.checkAndConsume(call, who, ["owner_action_tier", RESTRICTED_TURN_REASON]);
      expect(created.ok).toBe(false);
      const taken = await confirmations.approveAndTake(who, (created as { confirmation_id: string }).confirmation_id);
      expect(taken).toMatchObject({ tool_id: "tasks", action: "delegate_background_task", taint_reasons: ["owner_action_tier", RESTRICTED_TURN_REASON] });
      const none = await confirmations.checkAndConsume({ ...call, parameters: { title: "Tredje", prompt: "Enda en jobb uten noen grunner" } }, who, []);
      const takenNone = await confirmations.approveAndTake(who, (none as { confirmation_id: string }).confirmation_id);
      expect(takenNone?.taint_reasons).toEqual([]);
    } finally { restore(); }
  });
});

describe("D: kildevakt - server.ts er det TREDJE stedet som setter `restrictedOrigin` (kun fra kortets grunner)", () => {
  const server = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
  it("godkjenningsruten sender `restrictedOrigin` kun via `confirmationRestrictsOrigin(taken)` (betinget spredning), og kortgrunnen settes av MeshToolExecutor fra turbildet", () => {
    expect(server).toContain("...(confirmationRestrictsOrigin(taken) ? { restrictedOrigin: true as const } : {})");
    expect(server).toContain('import { confirmationRestrictsOrigin } from "./restricted-context-guard.ts";');
    const mesh = readFileSync(fileURLToPath(new URL("../../../modules/tool-gateway/src/mesh-bridge.ts", import.meta.url)), "utf8");
    expect(mesh).toContain("...(turn?.restricted === true ? [RESTRICTED_TURN_REASON] : [])");
    expect(mesh).toContain('export const RESTRICTED_TURN_REASON = "restricted_turn";');
    const store = readFileSync(fileURLToPath(new URL("../../../modules/core/src/services/confirmation-store.ts", import.meta.url)), "utf8");
    expect(store).toContain("taint_reasons: Array.isArray(row.taint_reasons) ? row.taint_reasons : []");
    expect(store).toMatch(/SELECT confirmation_id, tool_id, action, parameters, call_fingerprint, binding_hash, nonce, expires_at, device_id, taint_reasons\s+FROM action_confirmations/);
  });
});
