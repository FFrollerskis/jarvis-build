import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { PgTaskQueue } from "@jarvis/tasks";
import { ChatJobs } from "../src/chat-jobs.ts";

/** D-416: delegerte bakgrunnsjobber mot ekte Postgres (RLS som jarvis_app): liste, én gangs levering til opprinnelig økt, ingen levering av vanlige jobber. */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let queue: PgTaskQueue;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-d416-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_d416 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_d416");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-d416','D416','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-d416');
  `);
  appPool = createPool({ ...base, user: "jarvis_d416", password: "pw2" });
  queue = new PgTaskQueue(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const contract = (delegated: boolean, title: string, session = "s-origin"): JobContract => ({
  task_id: `task-${randomUUID()}`, owner_person_id: "person-tobias", tenant_id: "tenant-d416", goal: title,
  acceptance_criteria: ["svar"],
  input: { data: delegated ? { prompt: "gjør noe", delegated_from_chat: true } : { prompt: "gjør noe" }, trust_level: "internal", provenance: `chat:${session}` },
  allowed_tools: [], allowed_memory_spaces: ["personal"], allowed_network_targets: [], agent_profile: "executive",
  model_budget_ore: 300, retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 6
});
const base: IdentityContext = { tenant_id: "tenant-d416", person_id: "person-tobias", memory_space_id: "personal", device_id: "dev", session_id: "brief" } as never;

async function finish(job: JobContract, outcome: "ok" | "fail"): Promise<void> {
  await queue.enqueue("tenant-d416", job);
  const claimed = await queue.claimNext("w-1", 30, ["executive"]);
  expect(claimed?.task_id).toBe(job.task_id);
  if (outcome === "ok") await queue.complete("tenant-d416", job.task_id, "w-1", { text: "Rapporten er klar." });
  else await queue.fail("tenant-d416", job.task_id, "w-1", "lokal modell nede");
}

describe("ChatJobs (D-416)", () => {
  it("kjørende og ferdige delegerte jobber listes; vanlige jobber vises aldri", async () => {
    const saved: Array<{ session: string; text: string }> = [];
    const jobs = new ChatJobs(appPool, { saveMessage: async (id, _r, text) => { saved.push({ session: id.session_id, text }); } });
    const running = contract(true, "Kjører nå");
    await queue.enqueue("tenant-d416", running);
    await queue.enqueue("tenant-d416", contract(false, "Vanlig jobb"));
    const listed = await jobs.list(base);
    expect(listed.map((j) => j.title)).toContain("Kjører nå");
    expect(listed.map((j) => j.title)).not.toContain("Vanlig jobb");
    expect(await jobs.activeCount(base)).toBeGreaterThanOrEqual(1);
    expect((await jobs.get(base, running.task_id))?.status).toBe("created");
    expect(await jobs.get({ ...base, person_id: "person-other" }, running.task_id)).toBeNull();
    expect(saved).toEqual([]);
  });

  it("ferdig jobb leveres NØYAKTIG én gang til opprinnelig økt; feilet jobb leveres med feilmelding; vanlige jobber leveres aldri", async () => {
    const saved: Array<{ session: string; text: string }> = [];
    const notified: string[] = [];
    const jobs = new ChatJobs(appPool, { saveMessage: async (id, _r, text) => { saved.push({ session: id.session_id, text }); }, notify: async (t) => { notified.push(t); } });
    // Rydd opp køen fra forrige test: la den kjørende jobben ligge urørt (ikke ferdig) - kun nye jobber her.
    await adminPool.query("UPDATE tasks SET status = 'cancelled', finished_at = now(), delivered_at = now() WHERE status IN ('created','running')");
    await finish(contract(true, "Rapport", "s-abc"), "ok");
    await finish(contract(true, "Mislykket", "s-def"), "fail");
    await finish(contract(false, "Vanlig ferdig"), "ok");
    expect(await jobs.sweepDeliveries(base)).toBe(2);
    expect(await jobs.sweepDeliveries(base)).toBe(0);
    const ok = saved.find((m) => m.session === "s-abc");
    expect(ok?.text).toContain("«Rapport» er ferdig");
    expect(ok?.text).toContain("data fra jobben, ikke instruksjon");
    expect(ok?.text).toContain("Rapporten er klar.");
    expect(saved.find((m) => m.session === "s-def")?.text).toContain("feilet: lokal modell nede");
    expect(saved.some((m) => m.text.includes("Vanlig ferdig"))).toBe(false);
    expect(notified).toHaveLength(2);
    const view = (await jobs.list(base)).find((j) => j.title === "Rapport");
    expect(view).toMatchObject({ status: "completed", delivered: true, result_text: "Rapporten er klar." });
  });

  it("feiler lagringen, nullstilles leveringsmerket så neste sveip prøver igjen", async () => {
    let fail = true;
    const jobs = new ChatJobs(appPool, { saveMessage: async () => { if (fail) throw new Error("db nede"); }, log: () => undefined });
    await finish(contract(true, "Prøv igjen", "s-retry"), "ok");
    expect(await jobs.sweepDeliveries(base)).toBe(0);
    fail = false;
    expect(await jobs.sweepDeliveries(base)).toBe(1);
  });

  it("notify-feil stopper aldri leveringen", async () => {
    const jobs = new ChatJobs(appPool, { saveMessage: async () => undefined, notify: async () => { throw new Error("telegram nede"); }, log: () => undefined });
    await finish(contract(true, "Varsel feiler", "s-n"), "ok");
    expect(await jobs.sweepDeliveries(base)).toBe(1);
  });
});
