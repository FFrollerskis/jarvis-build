import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  LocalHashEmbedding,
  MemoryRetriever,
  MemoryWriter,
  RuleBasedExtractor,
  SummaryService,
  runMemoryRetentionSweepForAllTenants,
  withMemoryTransaction,
  type SourceRef
} from "../src/index.ts";

/**
 * D-286 (Tobias direkte i chat, "alle"): beviser at
 * `runMemoryRetentionSweepForAllTenants()` FAKTISK konsoliderer gamle
 * EPISODISKE samtale-minner (myk `invalidate()`, ALDRI hard DELETE), OG at
 * VARIGE typer (relation/preference/decision) ALDRI røres uansett alder.
 * Bruker EKTE embedded Postgres, SAMME mønster som
 * `modules/vision/test/service-rls.test.ts` sin seksjon I - `listTenantMemorySpaces()`
 * (multi-space fan-out) bruker en transaksjonell `pool.connect()`-vei som
 * IKKE lar seg mocke trygt med en enkel `fakePool()`, se den filens egen
 * begrunnelse ("IKKE en fakePool()-mock").
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let writer: MemoryWriter;
let retriever: MemoryRetriever;
let summaries: SummaryService;
let policy: PolicyGateway;

const TENANT = "tenant-retention-sweep";
const PERSON = "person-retention-sweep";
const CONVERSATION: SourceRef = { kind: "conversation", ref: "sess-old", trust: "trusted" };

function identity(space: MemorySpace): IdentityContext {
  return {
    person_id: PERSON,
    tenant_id: TENANT,
    memory_space_id: space,
    session_id: "sess-retention-test",
    device_id: "dev-pc",
    channel: "web",
    auth_strength: "active"
  };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-mem-ret-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({
      databaseDir, user: "postgres", password: "test-superuser-pw", port, persistent: false
    }),
    { identity: { user: "postgres", password: "test-superuser-pw", database: "postgres" } }
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({
    host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "test-superuser-pw"
  });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_ret LOGIN PASSWORD 'test-app-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_ret");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'Retention-sweep-test', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'Retention Test');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON}', '${TENANT}');
    INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ('dev-pc', '${TENANT}', '${PERSON}', 'pc');
    INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id)
      VALUES ('sess-retention-test', '${TENANT}', '${PERSON}', 'web', 'dev-pc');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space)
      VALUES ('ms-retention-personal', '${TENANT}', 'personal');
  `);
  appPool = createPool({
    host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_ret", password: "test-app-pw"
  });
  const embeddings = new LocalHashEmbedding();
  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch()
  });
  writer = new MemoryWriter(appPool, embeddings, new RuleBasedExtractor(), policy);
  retriever = new MemoryRetriever(appPool, embeddings);
  summaries = new SummaryService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("D-286: runMemoryRetentionSweepForAllTenants konsoliderer gamle episodiske samtale-minner", () => {
  it("A: en gammel episodic samtale-minne over terskelen blir konsolidert - invalidert (MYKT, ikke slettet) + fanget i et dagssammendrag", async () => {
    const id = identity("personal");
    const oldDay = isoDaysAgo(90);
    const add = await writer.apply(id, CONVERSATION, {
      space: "personal", type: "episodic", subject: "test.gammel.hendelse.a",
      content: "Jeg dro til Oslo for veldig lenge siden.", confidence: 0.6, observed_at: oldDay
    });
    expect(add.op).toBe("ADD");

    const result = await runMemoryRetentionSweepForAllTenants(appPool, writer, summaries, 60);
    expect(result.failed).toEqual([]);
    expect(result.consolidatedByTenant[`${TENANT}:personal`]).toBeGreaterThan(0);

    // Myk sletting: forsvinner fra vanlig søk...
    const searchResults = await retriever.search(id, { spaces: ["personal"], query: "Oslo" });
    expect(searchResults.find((r) => r.memory_item_id === add.memory_item_id)).toBeUndefined();
    // ...men raden selv OG versjonshistorikken forblir intakt (ALDRI en hard DELETE).
    const versionRows = await withMemoryTransaction(appPool, TENANT, ["personal"], (c) =>
      c.query("SELECT status FROM memory_items WHERE memory_item_id = $1", [add.memory_item_id])
    );
    expect(versionRows.rows[0]).toEqual({ status: "invalidated" });
    const changeKindRows = await withMemoryTransaction(appPool, TENANT, ["personal"], (c) =>
      c.query("SELECT change_kind FROM memory_versions WHERE memory_item_id = $1", [add.memory_item_id])
    );
    expect(changeKindRows.rows.map((r) => (r as { change_kind: string }).change_kind)).toContain("invalidated");

    // Dagssammendraget for DEN dagen faktisk finnes nå.
    const day = new Date(oldDay).toISOString().slice(0, 10);
    const summaryRows = await withMemoryTransaction(appPool, TENANT, ["personal"], (c) =>
      c.query("SELECT content FROM summaries WHERE tenant_id = $1 AND space = 'personal' AND scope_key = $2", [
        TENANT, day
      ])
    );
    expect(summaryRows.rows).toHaveLength(1);
    expect((summaryRows.rows[0] as { content: string }).content).toContain("Oslo");
  });

  it("B: en NYLIG episodic samtale-minne (innenfor terskelen) røres IKKE", async () => {
    const id = identity("personal");
    const add = await writer.apply(id, CONVERSATION, {
      space: "personal", type: "episodic", subject: "test.nylig.hendelse.b",
      content: "Jeg dro til Bergen i går.", confidence: 0.6, observed_at: isoDaysAgo(1)
    });
    await runMemoryRetentionSweepForAllTenants(appPool, writer, summaries, 60);
    const searchResults = await retriever.search(id, { spaces: ["personal"], query: "Bergen" });
    expect(searchResults.find((r) => r.memory_item_id === add.memory_item_id)).toBeDefined();
  });

  it("C: VARIGE typer (relation/preference/decision) røres ALDRI, uansett alder - kun 'episodic' er kandidat", async () => {
    const id = identity("personal");
    const relationAdd = await writer.apply(id, CONVERSATION, {
      space: "personal", type: "relation", subject: "test.pappa.heter.henrik",
      content: "Pappa heter Henrik.", confidence: 0.6, observed_at: isoDaysAgo(200)
    });
    const preferenceAdd = await writer.apply(id, CONVERSATION, {
      space: "personal", type: "preference", subject: "test.liker.sjokolade",
      content: "Jeg liker sjokolade.", confidence: 0.6, observed_at: isoDaysAgo(200)
    });
    const decisionAdd = await writer.apply(id, CONVERSATION, {
      space: "personal", type: "decision", subject: "test.besluttet.flytte",
      content: "Jeg besluttet å flytte.", confidence: 0.6, observed_at: isoDaysAgo(200)
    });

    await runMemoryRetentionSweepForAllTenants(appPool, writer, summaries, 60);

    const results = await retriever.search(id, { spaces: ["personal"], query: "Henrik sjokolade flytte" });
    const ids = results.map((r) => r.memory_item_id);
    expect(ids).toContain(relationAdd.memory_item_id);
    expect(ids).toContain(preferenceAdd.memory_item_id);
    expect(ids).toContain(decisionAdd.memory_item_id);
  });

  it("D: en gammel episodic MEN fra en IKKE-samtale-kilde ('manual') røres IKKE - kun source.kind='conversation' er kandidat", async () => {
    const id = identity("personal");
    const manualAdd = await writer.apply(
      id,
      { kind: "manual", ref: "seed-test", trust: "internal" },
      {
        space: "personal", type: "episodic", subject: "test.manuell.hendelse.d",
        content: "Manuelt lagt inn gammel hendelse.", confidence: 0.6, observed_at: isoDaysAgo(200)
      }
    );
    await runMemoryRetentionSweepForAllTenants(appPool, writer, summaries, 60);
    const results = await retriever.search(id, { spaces: ["personal"], query: "Manuelt" });
    expect(results.find((r) => r.memory_item_id === manualAdd.memory_item_id)).toBeDefined();
  });

  it("E: idempotent - et andre sveip like etter det første finner ingen nye kandidater å konsolidere for samme tenant/space", async () => {
    const result = await runMemoryRetentionSweepForAllTenants(appPool, writer, summaries, 60);
    expect(result.failed).toEqual([]);
    expect(result.consolidatedByTenant[`${TENANT}:personal`]).toBe(0);
  });
});
