import { mkdir, mkdtemp, utimes, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { KnowledgeEntityIndexer } from "../src/entity-indexer.ts";
import { KnowledgeSourceRegistry } from "../src/registry.ts";
import { parseKnowledgeSources, verifyFilesystemRoot, type ConfiguredKnowledgeSource } from "../src/source-config.ts";
import { KnowledgeSyncRunner, type KnowledgeSyncRunnerDeps } from "../src/sync-runner.ts";
import type { KnowledgeSource } from "../src/source.ts";

/**
 * WP-D1 (UA-2, JARVIS-032): den konfigurerte synk-løperen hele veien - konfigurasjon (JSON) -> register -> kilde -> synk -> dokumenter/entiteter i EKTE Postgres som app-rolle. Beviser dvale
 * uten kilder, at rom/tenant kommer fra den konfigurerte kilden, at preflight hindrer synk (og dermed tombstoning), at en feil i én kilde ikke stopper de andre, planlegging uten overlapp,
 * oppbevaringsfrist og at loggene aldri bærer filnavn eller innhold.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const embedding = new LocalHashEmbedding();
let base: string;

const TENANT = "tenant-wpd1-runner";
const OTHER_TENANT = "tenant-wpd1-runner-annen";
const identityFor = (source: ConfiguredKnowledgeSource): IdentityContext => ({
  person_id: "person-runner", tenant_id: TENANT, memory_space_id: source.memory_space, session_id: `sess-runner-${source.id}`, device_id: "dev-runner", channel: "api", auth_strength: "active"
});

async function configure(entries: unknown[]): Promise<ConfiguredKnowledgeSource[]> {
  return parseKnowledgeSources(JSON.stringify(entries), { tenant_id: TENANT, fs_roots: [base], google_account: "post@tsworkflow.com", github_repo: "tsworkflow/jarvisbuild", github_unlocked: false });
}

function makeRunner(sources: ConfiguredKnowledgeSource[], overrides: Partial<KnowledgeSyncRunnerDeps> = {}): { runner: KnowledgeSyncRunner; logs: Array<Record<string, unknown>>; clock: { now: Date } } {
  const registry = new KnowledgeSourceRegistry(sources.map((s) => s.config));
  const logs: Array<Record<string, unknown>> = [];
  const clock = { now: new Date("2026-10-09T12:00:00Z") };
  const runner = new KnowledgeSyncRunner({
    pool: appPool, embeddings: embedding, sources,
    buildSource: (source, identity) => registry.build(source.config.tenant_id, source.memory_space, source.id, { identity }),
    identityFor,
    preflight: async (source) => (source.kind === "drive" || source.kind === "github" || source.kind === "email_attachment" ? null : verifyFilesystemRoot((source.config as { root_path?: string; vault_root?: string }).root_path ?? (source.config as { vault_root: string }).vault_root, [base])),
    entityIndexer: new KnowledgeEntityIndexer(),
    now: () => clock.now,
    log: (entry) => logs.push(entry),
    tickMs: 1_000, firstRunDelayMs: 0, staggerMs: 0,
    ...overrides
  });
  return { runner, logs, clock };
}

async function docs(sourceId: string, space: string, tenant = TENANT): Promise<Array<{ external_id: string; deleted: boolean; sensitivity: string; trust_level: string; title: string }>> {
  const { rows } = await adminPool.query(
    "SELECT external_id, deleted, sensitivity, trust_level, title FROM knowledge_documents WHERE tenant_id = $1 AND memory_space_id = $2 AND source_instance_id = $3 ORDER BY external_id",
    [tenant, space, sourceId]
  );
  return rows as Array<{ external_id: string; deleted: boolean; sensitivity: string; trust_level: string; title: string }>;
}
async function count(sql: string, values: unknown[] = []): Promise<number> {
  const { rows } = await adminPool.query(sql, values);
  return (rows[0] as { n: number }).n;
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "jarvis-wpd1-runner-"));
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd1-runner-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpd1_runner LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpd1_runner");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','R','person'), ('${OTHER_TENANT}','R2','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-runner','R');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-runner','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd1_runner", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
}, 120_000);

describe("A: dvale uten kilder", () => {
  it("ingen konfigurerte kilder: start() setter ingen timer, tick() gjør ingenting, status er tom og ingenting logges", async () => {
    const { runner, logs } = makeRunner([]);
    runner.start();
    await runner.tick();
    await runner.idle();
    expect(runner.sourceCount).toBe(0);
    expect(runner.status()).toEqual([]);
    expect(logs).toEqual([]);
    expect(await runner.runNow("finnes-ikke")).toEqual({ status: "skipped", reason: "unknown_source" });
    runner.stop();
  });
});

describe("B: konfigurasjon -> kilde -> synk -> dokumenter", () => {
  it("en filsystemkilde indekseres i det KONFIGURERTE rommet og tenanten, med kildens policy, tillit og deterministisk entitetsgraf; andre rom/tenanter ser ingenting", async () => {
    const root = join(base, "notater-b");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "prosjekt.md"), "Prosjektet JARVIS-060 handler om kunnskapslaget. Se www.eksempel-firma.no for detaljer.");
    await writeFile(join(root, "mote.md"), "Vi møttes og snakket om hytta og fremdriften.");
    await writeFile(join(root, "lege.md"), "Tobias har fått en ny diagnose og skal til legen.");
    const sources = await configure([{ id: "notater-b", kind: "filesystem", memory_space: "project", path: root, trust: "internal", default_sensitivity: "sensitive", max_sensitivity: "sensitive" }]);
    const { runner, logs } = makeRunner(sources);
    const outcome = await runner.runNow("notater-b");
    expect(outcome.status).toBe("synced");
    const rows = await docs("notater-b", "project");
    // lege.md er `special` (helse) og over kildens tak: aldri indeksert.
    expect(rows.map((r) => r.external_id)).toEqual(["mote.md", "prosjekt.md"]);
    expect(rows.every((r) => r.sensitivity === "sensitive" && r.trust_level === "internal" && !r.deleted)).toBe(true);
    expect(outcome.status === "synced" && outcome.report).toMatchObject({ scanned: 3, created: 2, excluded: 1 });
    // Entitetsgrafen (deterministisk): prosjektnøkkel og domene fra teksten.
    const linked = await count(
      "SELECT count(*)::int AS n FROM knowledge_links l JOIN knowledge_entities e ON e.entity_id = l.entity_id AND e.tenant_id = l.tenant_id WHERE l.tenant_id = $1 AND l.memory_space_id = 'project'",
      [TENANT]
    );
    expect(linked).toBeGreaterThanOrEqual(2);
    expect(await docs("notater-b", "personal")).toEqual([]);
    expect(await docs("notater-b", "project", OTHER_TENANT)).toEqual([]);
    // Loggene bærer kun kilde-id/type/rom og tall - aldri filnavn eller innhold.
    const text = JSON.stringify(logs);
    expect(text).toContain("knowledge_source_synced");
    for (const forbidden of ["prosjekt.md", "mote.md", "lege.md", "diagnose", "JARVIS-060", base]) expect(text).not.toContain(forbidden);
  });

  it("andre kjøring uten endringer er en no-op, og en fjernet fil tombstones (kun etter en vellykket listing)", async () => {
    const root = join(base, "notater-b2");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.md"), "første notat om budsjettet");
    await writeFile(join(root, "b.md"), "andre notat om budsjettet");
    const sources = await configure([{ id: "notater-b2", kind: "filesystem", memory_space: "personal", path: root }]);
    const { runner } = makeRunner(sources);
    await runner.runNow("notater-b2");
    const second = await runner.runNow("notater-b2");
    expect(second.status === "synced" && second.report).toMatchObject({ created: 0, updated: 0, unchanged: 2, tombstoned: 0 });
    await rm(join(root, "b.md"));
    const third = await runner.runNow("notater-b2");
    expect(third.status === "synced" && third.report).toMatchObject({ tombstoned: 1 });
    expect((await docs("notater-b2", "personal")).map((r) => `${r.external_id}:${r.deleted}`)).toEqual(["a.md:false", "b.md:true"]);
  });
});

describe("C: preflight og feilisolasjon - en kilde som ikke kan kjøres synkes ikke (og tombstoner derfor aldri noe)", () => {
  it("en rot som er blitt en symlink UT av allowlisten hoppes over: ingen synk, ingen tombstoning av det som allerede er indeksert", async () => {
    const root = join(base, "notater-c");
    const outside = await mkdtemp(join(tmpdir(), "jarvis-wpd1-runner-out-"));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.md"), "notat som er indeksert");
    await writeFile(join(outside, "hemmelig.md"), "utenfor allowlisten");
    const sources = await configure([{ id: "notater-c", kind: "filesystem", memory_space: "personal", path: root }]);
    const { runner, logs } = makeRunner(sources);
    expect((await runner.runNow("notater-c")).status).toBe("synced");
    await rm(root, { recursive: true });
    try {
      await symlink(outside, root);
    } catch {
      return; // ingen symlink-rettigheter i dette miljøet
    }
    expect(await runner.runNow("notater-c")).toEqual({ status: "skipped", reason: "root_outside_allowlist" });
    expect((await docs("notater-c", "personal")).map((r) => `${r.external_id}:${r.deleted}`)).toEqual(["a.md:false"]);
    expect(logs.some((l) => l["msg"] === "knowledge_source_skipped" && l["reason"] === "root_outside_allowlist")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("hemmelig");
  });

  it("en manglende rot (NAS nede) gir total svikt uten tombstoning, og en feil i bygging av én kilde stopper ikke de andre", async () => {
    const good = join(base, "notater-c2");
    await mkdir(good, { recursive: true });
    await writeFile(join(good, "a.md"), "et notat");
    const sources = await configure([
      { id: "nede", kind: "filesystem", memory_space: "personal", path: join(base, "finnes-ikke") },
      { id: "god", kind: "filesystem", memory_space: "personal", path: good },
      { id: "repo", kind: "github", memory_space: "project", repo: "tsworkflow/jarvisbuild" }
    ]);
    const { runner, logs } = makeRunner(sources, {
      // GitHub-kilden trenger ToolGateway som ikke finnes her: byggingen kaster, og kun DEN kilden feiler (ingen preflight: den manglende roten skal ramle inn i selve vandringen).
      preflight: async () => null
    });
    const down = await runner.runNow("nede");
    expect(down.status === "synced" && down.report).toMatchObject({ failed: 1, error_class: "SOURCE_UNAVAILABLE", created: 0, tombstoned: 0 });
    const broken = await runner.runNow("repo");
    expect(broken.status).toBe("failed");
    expect((await runner.runNow("god")).status).toBe("synced");
    expect((await docs("god", "personal")).map((r) => r.external_id)).toEqual(["a.md"]);
    expect(logs.some((l) => l["msg"] === "knowledge_source_failed" && l["source_id"] === "repo")).toBe(true);
    expect(logs.some((l) => l["msg"] === "knowledge_source_sync_degraded" && l["source_id"] === "nede")).toBe(true);
  });
});

describe("D: planlegging - ingen overlapp, samtidighetsgrense, forfall etter intervall, forsinket retry ved feil", () => {
  type FakeSource = ConfiguredKnowledgeSource & { gate?: Promise<void> };
  const fakeSource = (id: string, gate?: Promise<void>): FakeSource => ({
    id, kind: "filesystem", memory_space: "personal", policy: {}, retention_days: undefined, sync_interval_minutes: 60,
    config: { source_type: "filesystem", tenant_id: TENANT, memory_space_id: "personal", source_instance_id: id, root_path: `/fake/${id}` },
    ...(gate ? { gate } : {})
  });

  function runnerWith(sourceDefs: FakeSource[], extra: Partial<KnowledgeSyncRunnerDeps> = {}) {
    const logs: Array<Record<string, unknown>> = [];
    const clock = { now: new Date("2026-10-09T12:00:00Z") };
    const listed: string[] = [];
    const runner = new KnowledgeSyncRunner({
      pool: appPool, embeddings: embedding, sources: sourceDefs, identityFor,
      buildSource: (source): KnowledgeSource => ({
        source_type: "filesystem", source_instance_id: source.id,
        list: async () => {
          listed.push(source.id);
          const def = sourceDefs.find((d) => d.id === source.id);
          await def?.gate;
          return { records: [], skipped: [] };
        }
      }),
      now: () => clock.now, log: (entry) => logs.push(entry), tickMs: 1_000, firstRunDelayMs: 0, staggerMs: 0, ...extra
    });
    return { runner, listed, logs, clock };
  }

  it("en kilde som fortsatt synkes startes ikke på nytt, og høyst maxConcurrent kilder går samtidig", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const defs = ["s1", "s2", "s3"].map((id) => fakeSource(id, gate));
    const { runner, listed } = runnerWith(defs, { maxConcurrent: 2 });
    runner.start();
    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listed).toEqual(["s1", "s2"]); // s3 venter: samtidighetsgrensen er 2
    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listed).toEqual(["s1", "s2"]); // ingen overlapp
    release();
    await runner.idle();
    await runner.tick();
    await runner.idle();
    expect(listed).toEqual(["s1", "s2", "s3"]);
    runner.stop();
  });

  it("neste synk er først forfalt etter intervallet; en feilet kilde prøves igjen etter høyst 30 minutter", async () => {
    const ok = fakeSource("ok");
    const bad = fakeSource("bad");
    const listedRef: string[] = [];
    const { runner, clock } = runnerWith([ok, bad], {
      buildSource: (source) => {
        if (source.id === "bad") throw new Error("kunne_ikke_bygge_kilden");
        return { source_type: "filesystem", source_instance_id: source.id, list: async () => { listedRef.push(source.id); return { records: [], skipped: [] }; } };
      }
    });
    runner.start();
    await runner.tick();
    await runner.idle();
    expect(listedRef).toEqual(["ok"]);
    const status = runner.status();
    expect(status.find((s) => s.id === "ok")).toMatchObject({ last_outcome: "synced", next_due_at: "2026-10-09T13:00:00.000Z" });
    expect(status.find((s) => s.id === "bad")).toMatchObject({ last_outcome: "failed", next_due_at: "2026-10-09T12:30:00.000Z" });
    clock.now = new Date("2026-10-09T12:29:00Z");
    await runner.tick();
    await runner.idle();
    expect(listedRef).toEqual(["ok"]); // ingen av dem er forfalt ennå
    clock.now = new Date("2026-10-09T12:31:00Z");
    await runner.tick();
    await runner.idle();
    expect(runner.status().find((s) => s.id === "bad")?.last_run_at).toBe("2026-10-09T12:31:00.000Z");
    expect(listedRef).toEqual(["ok"]); // bad prøvde igjen (og feilet igjen), ok er ikke forfalt
    clock.now = new Date("2026-10-09T13:01:00Z");
    await runner.tick();
    await runner.idle();
    expect(listedRef).toEqual(["ok", "ok"]);
    runner.stop();
  });

  it("start() er idempotent, stop() stopper løkka, og runNow() deler en pågående kjøring i stedet for å starte en ny", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runner, listed } = runnerWith([fakeSource("r1", gate)]);
    runner.start();
    runner.start();
    const first = runner.runNow("r1");
    const second = runner.runNow("r1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listed).toEqual(["r1"]);
    release();
    expect(await first).toBe(await second);
    runner.stop();
    runner.stop();
  });
});

describe("E: oppbevaringsfrist og modellpasset", () => {
  it("retention_days på kilden: for gammelt innhold (filens mtime) indekseres ikke; fysisk fjerning av utløpt innhold dekkes av KnowledgeRetentionService-testene", async () => {
    const root = join(base, "moter-e");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "ny.txt"), "Ola: Vi skal snakke om budsjettet.\nKari: Greit.");
    await writeFile(join(root, "gammel.txt"), "Ola: Dette er et gammelt møte om noe annet.\nKari: Ja.");
    const old = new Date("2026-04-01T00:00:00Z");
    await utimes(join(root, "gammel.txt"), old, old);
    const sources = await configure([{ id: "moter-e", kind: "meeting_transcript", memory_space: "business", path: root, retention_days: 30 }]);
    const { runner } = makeRunner(sources);
    const outcome = await runner.runNow("moter-e");
    expect(outcome.status === "synced" && outcome.report).toMatchObject({ created: 1, expired: 1 });
    expect((await docs("moter-e", "business")).map((r) => r.external_id)).toEqual(["ny.txt"]);
  });

  it("det modellassisterte passet er AV som standard (ikke kalt), kjøres per kilde når det er satt på, og en feil i det feller ikke synken", async () => {
    const root = join(base, "notater-e2");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.md"), "notat om Acme AS og Ola Nordmann");
    const sources = await configure([{ id: "notater-e2", kind: "filesystem", memory_space: "personal", path: root }]);
    const calls: Array<{ space: string; options: unknown }> = [];
    const off = makeRunner(sources);
    expect((await off.runner.runNow("notater-e2")).status).toBe("synced");
    expect(calls).toEqual([]);
    const on = makeRunner(sources, { llmPass: { run: async (_id, space, options) => { calls.push({ space, options }); return { considered: 1, indexed: 1, failed: 0, stale: 0 }; } } });
    const done = await on.runner.runNow("notater-e2");
    expect(done.status === "synced" && done.llm).toEqual({ considered: 1, indexed: 1, failed: 0, stale: 0 });
    expect(calls).toEqual([{ space: "personal", options: { source: { source_type: "filesystem", source_instance_id: "notater-e2" }, limit: 5 } }]);
    const failing = makeRunner(sources, { llmPass: { run: async () => { throw new Error("modell nede"); } } });
    const survived = await failing.runner.runNow("notater-e2");
    expect(survived.status).toBe("synced");
    expect(failing.logs.some((l) => l["msg"] === "knowledge_source_entity_llm_failed")).toBe(true);
  });
});

describe("F: omstart - en kilde som nylig ble synket skannes ikke på nytt (API-kvoten), men runNow kjører alltid", () => {
  it("den PLANLAGTE første synken etter en omstart utsettes til siste synk + intervall; en kilde uten dokumenter kjører som planlagt", async () => {
    const root = join(base, "notater-f");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.md"), "et notat om kvoter og omstart");
    const sources = await configure([
      { id: "notater-f", kind: "filesystem", memory_space: "personal", path: root, sync_interval_minutes: 60 },
      { id: "tom-f", kind: "filesystem", memory_space: "personal", path: join(base, "tom-f"), sync_interval_minutes: 60 }
    ]);
    await mkdir(join(base, "tom-f"), { recursive: true });
    const before = makeRunner(sources);
    expect((await before.runner.runNow("notater-f")).status).toBe("synced");
    const last = (await adminPool.query("SELECT max(last_synced_at) AS at FROM knowledge_documents WHERE tenant_id = $1 AND source_instance_id = 'notater-f'", [TENANT])).rows[0] as { at: Date };

    // «Omstart»: en ny løper (ingen minnetilstand), klokken er 10 minutter etter siste synk.
    const after = makeRunner(sources);
    after.clock.now = new Date(last.at.getTime() + 10 * 60_000);
    after.runner.start();
    await after.runner.tick();
    await after.runner.idle();
    const syncedIds = () => after.logs.filter((l) => l["msg"] === "knowledge_source_synced").map((l) => l["source_id"]);
    expect(syncedIds()).toEqual(["tom-f"]); // notater-f ble synket nylig; tom-f har aldri lagret et dokument
    expect(after.runner.status().find((s) => s.id === "notater-f")?.next_due_at).toBe(new Date(last.at.getTime() + 60 * 60_000).toISOString());

    // Intervallet er gått: nå kjører den.
    after.clock.now = new Date(last.at.getTime() + 61 * 60_000);
    await after.runner.tick();
    await after.runner.idle();
    expect(syncedIds()).toEqual(["tom-f", "notater-f"]);
    after.runner.stop();
  });

  it("runNow ignorerer utsettelsen (eieren ber eksplisitt om en synk)", async () => {
    const root = join(base, "notater-f2");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.md"), "et notat");
    const sources = await configure([{ id: "notater-f2", kind: "filesystem", memory_space: "personal", path: root, sync_interval_minutes: 60 }]);
    const { runner, logs } = makeRunner(sources);
    await runner.runNow("notater-f2");
    await runner.runNow("notater-f2");
    expect(logs.filter((l) => l["msg"] === "knowledge_source_synced")).toHaveLength(2);
  });
});
