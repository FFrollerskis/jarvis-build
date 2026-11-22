import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { MemoryTraceSink, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { SURFACE_LIMITS } from "@jarvis/tool-gateway";
import { ConversationEngine } from "../src/conversation.ts";

/**
 * WP-N1 (K7b/K7c): samtalemotoren mot EKTE Postgres - ekte `MessageStore`, `ContextBuilder`, RLS og migrasjon 140 (de andre motortestene bruker en falsk lagring). Beviser at produksjonskoblingen virker ende til ende:
 * en låst tur (D-381-verktøyutvalg, tekst uten stikkord) lagrer brukermeldingen, merker den via `markRestricted` og lagrer svaret begrenset; neste skytur får historikken fra databasen UTEN de merkede radene; og med
 * flagget AV er radene umerkede (som på main) og lekkasjen finnes (kontrolltest).
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;

const identity = (session: string): IdentityContext => ({ person_id: "p-1", tenant_id: "t-n1", memory_space_id: "personal", session_id: session, device_id: "d-1", channel: "web", auth_strength: "active" });

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-n1db-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_n1db LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_n1db");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('t-n1','N1','person');
    INSERT INTO people (person_id, display_name) VALUES ('p-1','Én');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('p-1','t-n1');
    INSERT INTO sessions (session_id, tenant_id, person_id, status, last_channel, last_device_id) VALUES
      ('s-on','t-n1','p-1','closed','web','d-1'), ('s-off','t-n1','p-1','active','web','d-1');`);
  app = new pg.Pool({ ...base, user: "jarvis_n1db", password: "pw2" });
  app.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

function engine(guard: boolean, calls: CompleteInput[]): ConversationEngine {
  const def = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {} } });
  const finance = def("finance_neonomics__list_balances");
  const github = def("github__list_pull_requests");
  const gateway = {
    complete: async (input: CompleteInput) => { calls.push(JSON.parse(JSON.stringify(input)) as CompleteInput); return { text: "svar uten stikkord", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }; },
    stream: async (input: CompleteInput) => { calls.push(JSON.parse(JSON.stringify(input)) as CompleteInput); return { text: "svar uten stikkord", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }; },
    completeWithTools: async (input: CompleteInput) => {
      calls.push(JSON.parse(JSON.stringify(input)) as CompleteInput);
      const provider = (input.providerPreference as string[] | undefined)?.[0] ?? "gemma_local";
      return { text: "svar uten stikkord", usage: { input_tokens: 1, output_tokens: 1 }, provider, model: "m" };
    }
  } as unknown as ModelGateway;
  return new ConversationEngine({
    messages: new MessageStore(app), context: new ContextBuilder(app), gateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" },
    tools: {
      definitions: [finance, github] as never,
      executorFor: () => ({ execute: async () => { throw new Error("ikke brukt"); } }) as unknown as ToolExecutor,
      catalog: () => "katalog",
      select: ({ surface, text }) => {
        const locked = /konto/i.test(text);
        const pr = /\bPR\b/i.test(text);
        return { definitions: [...(locked ? [finance] : []), ...(pr ? [github] : [])] as never, limits: SURFACE_LIMITS[surface], tool_ids: [...(locked ? ["finance_neonomics"] : []), ...(pr ? ["github"] : [])], ...(locked ? { min_sensitivity: "SECRET_RESTRICTED" as const } : {}) };
      }
    },
    ...(guard ? { restrictedContextGuard: true } : {})
  });
}

const rows = async (session: string): Promise<Array<{ role: string; content: string; restricted: boolean }>> =>
  (await admin.query("SELECT role, content, restricted FROM messages WHERE session_id = $1 ORDER BY created_at, message_id", [session])).rows as never;
const silence = (): { restore: () => void } => {
  const a = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const b = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return { restore: () => { a.mockRestore(); b.mockRestore(); } };
};

describe("flagg PÅ mot ekte Postgres", () => {
  it("låst tur: brukermelding og svar ligger begrenset i databasen, én revisjonsrad for merkingen (uten innhold), og neste skytur får historikken UTEN de merkede radene", async () => {
    const calls: CompleteInput[] = [];
    const log = silence();
    try {
      const e = engine(true, calls);
      const first = await e.handle(identity("s-on"), "hvordan går det med kontoen min?");
      expect(first.routed).toBe("model");
      expect(calls[0]!.sensitivity).toBe("SECRET_RESTRICTED");
      expect(await rows("s-on")).toEqual([
        { role: "user", content: "hvordan går det med kontoen min?", restricted: true },
        { role: "assistant", content: expect.stringContaining("svar uten stikkord"), restricted: true }
      ]);
      const audit = (await admin.query("SELECT type, payload::text AS p FROM audit_events WHERE session_id = 's-on' AND type LIKE 'message.%' ORDER BY audit_id")).rows as Array<{ type: string; p: string }>;
      expect(audit.map((a) => a.type)).toEqual(["message.saved", "message.restricted_marked", "message.saved"]);
      expect(audit[2]!.p).toContain('"restricted": true');
      for (const a of audit) expect(a.p).not.toContain("kontoen");

      const second = await e.handle(identity("s-on"), "list åpne PR-er på github");
      expect(second.routed).toBe("model");
      expect(calls[1]!.providerPreference).toEqual(["anthropic"]);
      expect(calls[1]!.request.messages.map((m) => m.content)).toEqual(["list åpne PR-er på github"]);
      expect(calls[1]!.sensitivity).not.toBe("SECRET_RESTRICTED");
      expect(second.reply).toContain("uten 2 tidligere meldinger");
      // skyturen er trygg: ikke merket
      expect((await rows("s-on")).slice(2).every((r) => !r.restricted)).toBe(true);
    } finally {
      log.restore();
    }
  });
});

describe("flagg AV mot ekte Postgres (kontrolltest: feilen finnes uten vakten)", () => {
  it("de samme to turene: ingenting merkes (kolonnen settes aldri), og det lokale svaret følger med til skyen", async () => {
    const calls: CompleteInput[] = [];
    const log = silence();
    try {
      const e = engine(false, calls);
      await e.handle(identity("s-off"), "hvordan går det med kontoen min?");
      expect(calls[0]!.sensitivity).toBe("SECRET_RESTRICTED");
      expect((await rows("s-off")).every((r) => !r.restricted)).toBe(true);
      await e.handle(identity("s-off"), "list åpne PR-er på github");
      expect(calls[1]!.providerPreference).toEqual(["anthropic"]);
      expect(calls[1]!.request.messages.map((m) => m.content)).toContain("hvordan går det med kontoen min?");
      expect(calls[1]!.request.messages.map((m) => m.content)).toContain("svar uten stikkord"); // det lokale svaret ligger i skyhistorikken (JARVIS-101)
      const marks = (await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE session_id = 's-off' AND type = 'message.restricted_marked'")).rows[0].n as number;
      expect(marks).toBe(0);
    } finally {
      log.restore();
    }
  });
});
