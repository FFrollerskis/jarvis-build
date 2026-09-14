import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobContract } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ArtifactStore, PgTaskQueue } from "@jarvis/tasks";
import { LIVE_EVAL_INITDB_FLAGS } from "../src/coding-agent-eval.ts";

/**
 * D-100 §4/§5: den andre ekte Windows-vertskjøringen feilet strukturelt fordi
 * embedded-postgres uten eksplisitt `initdbFlags` avleder encoding fra vertens
 * OS-locale - WIN1252 på den affiserte Windows-verten, UTF8 på Linux/glibc -
 * og avviste dermed byte-sekvensene for `≥` (0xe2 0x89 0xa5) og `✓`
 * (0xe2 0x9c 0x93) som agenten selv produserte. Denne testen beviser
 * DETERMINISTISK, mot en EKTE embedded-Postgres-instans initialisert med
 * NØYAKTIG de samme `LIVE_EVAL_INITDB_FLAGS` som selve live-eval-scriptet nå
 * bruker, at Unicode overlever den EKTE `ArtifactStore`-persisteringsveien
 * (INSERT -> SELECT via ekte SQL, ikke bare JS-strenghåndtering i minnet).
 * Løser IKKE dette ved å strippe Unicode fra Claude-output - det ville
 * skjult et ekte portabilitetsproblem (§4, eksplisitt forbudt).
 */
describe("D-100: UTF8-persistering gjennom ekte embedded-Postgres (LIVE_EVAL_INITDB_FLAGS)", () => {
  let PORT = 0;
  let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
  let epg: InstanceType<typeof EmbeddedPostgres>;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-utf8persist-"));
    const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
      new EmbeddedPostgres({
      databaseDir, user: "postgres", password: "pw", port, persistent: false,
      initdbFlags: [...LIVE_EVAL_INITDB_FLAGS]
    })
    );
    epg = leasedPostgres.postgres;
    PORT = leasedPostgres.port;
    stopEmbeddedPostgres = leasedPostgres.stop;
    await epg.createDatabase("jarvis_test");
    adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
    adminPool.on("error", () => undefined);
    await runMigrations(adminPool);
    await adminPool.query("CREATE ROLE jarvis_utf8persist LOGIN PASSWORD 'pw2'");
    await adminPool.query("GRANT jarvis_app TO jarvis_utf8persist");
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
      INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
    `);
    appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_utf8persist", password: "pw2" });
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    await stopEmbeddedPostgres?.();
  }, 120_000);

  async function seedTask(): Promise<string> {
    const queue = new PgTaskQueue(appPool);
    const contract: JobContract = {
      task_id: `task-${randomUUID()}`, owner_person_id: "person-tobias", tenant_id: "tenant-a",
      goal: "utf8 persistence proof", acceptance_criteria: ["n/a"],
      input: { data: {}, trust_level: "internal", provenance: "test" },
      allowed_tools: [], allowed_memory_spaces: ["personal"], allowed_network_targets: [],
      agent_profile: "coding", model_budget_ore: 1000,
      retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 3
    };
    await queue.enqueue("tenant-a", contract);
    return contract.task_id;
  }

  it("A: bokstavelig ≥ (0xe2 0x89 0xa5) overlever ekte INSERT -> SELECT uendret", async () => {
    const taskId = await seedTask();
    const artifacts = new ArtifactStore(appPool);
    await artifacts.save("tenant-a", taskId, "test-log", "diagnostic.txt", "actual value 4 >= expected value 3: pass (≥)");
    const rows = await artifacts.list("tenant-a", taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("actual value 4 >= expected value 3: pass (≥)");
    expect(Buffer.from(rows[0]!.content, "utf8")).toEqual(Buffer.from("actual value 4 >= expected value 3: pass (≥)", "utf8"));
  });

  it("B: bokstavelig ✓ (0xe2 0x9c 0x93) overlever ekte INSERT -> SELECT uendret", async () => {
    const taskId = await seedTask();
    const artifacts = new ArtifactStore(appPool);
    await artifacts.save("tenant-a", taskId, "pr-proposal", "pr.json", JSON.stringify({ description: "All checks passed ✓" }));
    const rows = await artifacts.list("tenant-a", taskId);
    const parsed = JSON.parse(rows[0]!.content) as { description: string };
    expect(parsed.description).toBe("All checks passed ✓");
  });

  it("C: norske tegn æøå (store+små) overlever ekte INSERT -> SELECT uendret", async () => {
    const taskId = await seedTask();
    const artifacts = new ArtifactStore(appPool);
    const content = "Æøå æøå - fullført, ikke godkjent før bekreftet.";
    await artifacts.save("tenant-a", taskId, "patch", "change.txt", content);
    const rows = await artifacts.list("tenant-a", taskId);
    expect(rows[0]!.content).toBe(content);
  });

  it("D: generell Unicode (emoji utenfor BMP, kyrillisk, kinesisk) overlever ekte INSERT -> SELECT uendret", async () => {
    const taskId = await seedTask();
    const artifacts = new ArtifactStore(appPool);
    const content = "mixed: 🚀 Привет 你好 ≥✓æøå";
    await artifacts.save("tenant-a", taskId, "test-log", "mixed.txt", content);
    const rows = await artifacts.list("tenant-a", taskId);
    expect(rows[0]!.content).toBe(content);
  });

  it("E: databasens faktiske server_encoding er UTF8 (ikke bare klient-side antatt)", async () => {
    const result = await adminPool.query("SHOW server_encoding");
    expect(result.rows[0]?.server_encoding).toBe("UTF8");
  });

  it("F: flere artefakter med ulik Unicode på samme task bevarer hver sin egen streng uforvekslet", async () => {
    const taskId = await seedTask();
    const artifacts = new ArtifactStore(appPool);
    await artifacts.save("tenant-a", taskId, "test-log", "a.txt", "≥");
    await artifacts.save("tenant-a", taskId, "test-log", "b.txt", "✓");
    await artifacts.save("tenant-a", taskId, "test-log", "c.txt", "æøå");
    const rows = await artifacts.list("tenant-a", taskId);
    const byName = new Map(rows.map((r) => [r.name, r.content]));
    expect(byName.get("a.txt")).toBe("≥");
    expect(byName.get("b.txt")).toBe("✓");
    expect(byName.get("c.txt")).toBe("æøå");
  });
});
