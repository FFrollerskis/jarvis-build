import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding, MemoryRetriever, MemoryWriter, RuleBasedExtractor, type SourceRef } from "@jarvis/memory";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import type { ToolResultMessage } from "@jarvis/provider-adapters";
import { MemorySearchTransport } from "@jarvis/tool-gateway";
import { KNOWN_MEMORY_ITEM_FIELDS, screenToolResultForCloud } from "../src/cloud-tool-screen.ts";

/**
 * D-449 (Q-50, gjennomgang nr. 2): skjermen mot SKYMODELLEN testes mot EKTE retriever/writer på embedded Postgres, ikke mot oppfunne treff. Funnet: (a) relasjons-/lenketreff kom tilbake UTEN `sensitivity`
 * (SELECT-en manglet kolonnen) og passerte derfor skjermen selv om elementet var `special`; (b) `versions` (tidligere versjoner ved motstrid) bærer tekst som ikke er regnet om - en oppdatering
 * regner ikke om sensitiviteten, så en gammel versjon kan ha helsetekst selv om elementet står som `normal`.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let writer: MemoryWriter;
let retriever: MemoryRetriever;
let transport: MemorySearchTransport;

const TRUSTED: SourceRef = { kind: "manual", ref: "seed", trust: "internal" };
const id: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal" satisfies MemorySpace, session_id: "sess-d449", device_id: "dev-pc", channel: "web", auth_strength: "active"
};
const candidate = (subject: string, content: string, extra: Record<string, unknown> = {}) => ({ space: "personal" as const, type: "semantic" as const, subject, content, confidence: 0.9, ...extra });

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-d449mem-"));
  const leased = await startLeasedEmbeddedPostgres(
    (port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "test-superuser-pw", port, persistent: false }),
    { identity: { user: "postgres", password: "test-superuser-pw", database: "postgres" } }
  );
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "test-superuser-pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'test-app-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a', 'Tobias personlig', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias', 'Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias', 'tenant-a');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-personal', 'tenant-a', 'personal'), ('ms-health', 'tenant-a', 'health');
    INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ('dev-pc', 'tenant-a', 'person-tobias', 'pc');
    INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id, status) VALUES ('sess-d449', 'tenant-a', 'person-tobias', 'web', 'dev-pc', 'active');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test", password: "test-app-pw" });
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch() });
  const embeddings = new LocalHashEmbedding();
  writer = new MemoryWriter(appPool, embeddings, new RuleBasedExtractor(), policy);
  retriever = new MemoryRetriever(appPool, embeddings);
  transport = new MemorySearchTransport(retriever);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

/** Det modellen ville fått fra `memory.search` (transportens ekte utdata) pakket som executor-resultatet, deretter skjermet slik skyruten gjør. */
async function searchAsCloudModel(query: string) {
  const { data } = await transport.invoke("search", { query }, "cred", { identity: id });
  const raw = data as unknown as Array<Record<string, unknown>>;
  const result: ToolResultMessage = { tool_call_id: "c1", tool_name: "search_my_memory", execution_id: "e1", success: true, output: raw, at: new Date().toISOString(), source: "memory.search" };
  const screened = screenToolResultForCloud(result, "search_my_memory");
  const seen = (screened.result.output as { results?: Array<{ memory_item_id: string }> }).results ?? (screened.result.output as Array<{ memory_item_id: string }>);
  return { raw, screened, seenIds: seen.map((i) => i.memory_item_id) };
}

describe("D-449: skjerming mot ekte minneutdata", () => {
  it("(a) et `special`-merket treff som kommer inn via relasjon (delt entitet) har sensitivity i retrieveren OG holdes tilbake fra skymodellen - også uten ord i teksten som avslører det", async () => {
    const ski = await writer.apply(id, TRUSTED, candidate("tobias.hobby", "Tobias liker å gå på ski i Nordmarka zeta4411.", { entities: [{ kind: "person", name: "Tobias" }] }));
    const other = await writer.apply(id, TRUSTED, candidate("tobias.legemiddel", "Tobias bruker Concerta om morgenen.", { entities: [{ kind: "person", name: "Tobias" }] }));
    // Merket settes av uttrekket/eieren; teksten har ingen stikkord (slik som i gjennomgangens eksempel etter en oppdatering).
    await adminPool.query("UPDATE memory_items SET sensitivity = 'special' WHERE memory_item_id = $1", [(other as { memory_item_id: string }).memory_item_id]);

    const { raw, screened, seenIds } = await searchAsCloudModel("zeta4411");
    const related = raw.find((r) => r["memory_item_id"] === (other as { memory_item_id: string }).memory_item_id);
    expect(related, "relasjonstreffet må finnes i rå utdata for at testen skal bevise noe").toBeDefined();
    expect(related!["via"]).toBe("relation");
    expect(related!["sensitivity"], "retrieveren må nå sende sensitivity også for relasjons-/lenketreff").toBe("special");
    expect(seenIds).toContain((ski as { memory_item_id: string }).memory_item_id);
    expect(seenIds).not.toContain((other as { memory_item_id: string }).memory_item_id);
    expect(screened.withheld).toBe(1);
    expect(JSON.stringify(screened.result.output)).not.toContain("Concerta");
  });

  it("(b) tidligere versjoner (`versions`) med helsetekst holdes tilbake selv om elementet står som `normal` og nåværende tekst er harmløs", async () => {
    const v1 = await writer.apply(id, TRUSTED, candidate("tobias.fredag", "Tobias skal på kino fredag omega11."));
    expect(v1.op).toBe("ADD");
    await writer.apply(id, TRUSTED, candidate("tobias.fredag", "Tobias har legetime fredag omega11."));
    await writer.apply(id, TRUSTED, candidate("tobias.fredag", "Tobias skal på kino fredag omega11."));
    // Skriveren regner nå om sensitivity ved oppdatering (strengeste av gammel og ny), så elementet er `special` i dag. Rader skrevet FØR den rettelsen står derimot som `normal` med helsetekst i versjonene -
    // det gjenskapes her, siden eksisterende data ikke endres av en kodeendring.
    expect((await adminPool.query("SELECT sensitivity FROM memory_items WHERE memory_item_id = $1", [(v1 as { memory_item_id: string }).memory_item_id])).rows[0].sensitivity).toBe("special");
    await adminPool.query("UPDATE memory_items SET sensitivity = 'normal' WHERE memory_item_id = $1", [(v1 as { memory_item_id: string }).memory_item_id]);
    const { raw, screened, seenIds } = await searchAsCloudModel("omega11");
    const hit = raw.find((r) => r["memory_item_id"] === (v1 as { memory_item_id: string }).memory_item_id);
    expect(hit, "treffet må finnes").toBeDefined();
    const versions = (hit!["versions"] as Array<{ content: string }> | undefined) ?? [];
    expect(versions.map((v) => v.content).join(" | ")).toMatch(/legetime/);
    expect(String(hit!["content"])).not.toMatch(/legetime/);
    expect(seenIds).not.toContain((v1 as { memory_item_id: string }).memory_item_id);
    expect(screened.withheld).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(screened.result.output)).not.toContain("legetime");
  });

  it("kontroll: et vanlig treff uten merker og uten helse-/økonomitekst går uberørt gjennom skjermen (samme objekt - ingen omforming)", async () => {
    const plain = await writer.apply(id, TRUSTED, candidate("tobias.bil", "Tobias kjører en rød Volvo sigma7788."));
    const { screened, seenIds } = await searchAsCloudModel("sigma7788");
    expect(seenIds).toEqual([(plain as { memory_item_id: string }).memory_item_id]);
    expect(screened.withheld).toBe(0);
  });

  it("retrieverens ekte felt er alle kjent for skjermen: får `RetrievedItem` et nytt felt, feiler denne FØR et ukjent felt kan bære uklassifisert tekst til skymodellen (skjermen holder treff med ukjente felt tilbake)", async () => {
    await writer.apply(id, TRUSTED, candidate("tobias.sport", "Tobias løper på tirsdager kappa5599.", { entities: [{ kind: "person", name: "Tobias" }] }));
    for (const query of ["kappa5599", "zeta4411", "omega11", "sigma7788"]) {
      const { raw } = await searchAsCloudModel(query);
      expect(raw.length, query).toBeGreaterThan(0);
      for (const item of raw) {
        const unknown = Object.keys(item).filter((key) => !KNOWN_MEMORY_ITEM_FIELDS.has(key));
        expect(unknown, `${query}: ukjente retriever-felt ${unknown.join(", ")} - klassifiser dem i cloud-tool-screen.ts før de kan nå skyen`).toEqual([]);
        for (const version of (item["versions"] as Array<Record<string, unknown>> | undefined) ?? []) expect(Object.keys(version).sort()).toEqual(["content", "valid_from", "valid_to", "version"]);
        expect(Object.keys((item["source"] as Record<string, unknown>)).sort()).toEqual(["kind", "ref", "trust_level"]);
      }
    }
  });

  it("et direkte `special`-treff (diagnose lagret som special ved skriving) har sensitivity i retrieveren og holdes tilbake", async () => {
    const direct = await writer.apply(id, TRUSTED, candidate("tobias.diagnose", "Tobias har diabetes type 2 rho6677."));
    const { raw, seenIds } = await searchAsCloudModel("rho6677");
    expect(raw.map((r) => r["memory_item_id"])).toContain((direct as { memory_item_id: string }).memory_item_id);
    expect(raw.find((r) => r["memory_item_id"] === (direct as { memory_item_id: string }).memory_item_id)!["sensitivity"]).toBe("special");
    expect(seenIds).not.toContain((direct as { memory_item_id: string }).memory_item_id);
  });
});
