import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ProducerRunStore } from "@jarvis/incidents";
import { composeSelfDiagnosis, buildLimitationRegistry, type Observation } from "@jarvis/executive";
import { MemoryAlertSink, Watchdog, type HealthCheck } from "@jarvis/watchdog";
import { createWatchdogIncidentBridge, INCIDENT_PRODUCER_INTERVAL_MS_DEFAULT } from "../src/incident-producers.ts";
import { buildSelfModelReaders, type SelfModelReaderDeps } from "../src/self-model-readers.ts";
import { watchdogRunSource, WATCHDOG_UNREADABLE_DETAIL } from "../src/watchdog-status.ts";

/**
 * WP-OPS2a K1 mot EKTE Postgres som app-rolle (RLS): raden skrives av den EKTE skriveveien (`runIncidentProducers` via `createWatchdogIncidentBridge`, slik worker-main.ts kobler den), og leseren leser det den skrev.
 * Ingen ny skrivevei: testen skriver aldri til `incident_producer_runs` selv (unntatt en fremmed tenant-rad for å bevise isolasjon).
 */
const T = "tenant-ops2a-wd";
const OTHER = "tenant-ops2a-other";
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-ops2a-wd-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_ops2a_wd LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_test_ops2a_wd");
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','W','business'), ('${OTHER}','O','business')`);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_ops2a_wd", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const readerDeps = (over: Partial<SelfModelReaderDeps> = {}): SelfModelReaderDeps => ({
  pool: app, tenantId: T, meshStatus: () => ({ providers: [] }),
  controlState: async () => ({ kill_switch: { active: false }, frozen_connectors: [], revoked_credentials: [] }), connectorStatus: async () => [],
  watchdogRuns: watchdogRunSource(new ProducerRunStore(app), T, INCIDENT_PRODUCER_INTERVAL_MS_DEFAULT), ...over
});
const observeWatchdog = async (over: Partial<SelfModelReaderDeps> = {}): Promise<Observation> => (await buildSelfModelReaders(readerDeps(over)).watchdog!()) as Observation;

describe("leseren leser det den EKTE skriveveien skrev (vakthund -> bro -> incident_producer_runs -> selvdiagnose)", () => {
  it("uten noen tikk (ingen rad): UKJENT, aldri OK", async () => {
    const o = await observeWatchdog();
    expect(o.status).toBe("UNKNOWN");
    expect(o.observed_at).toBeNull();
  });

  it("friskt tikk: OK; en feilende sjekk: DEGRADED med antallet (ikke meldingsteksten); sjekken frisk igjen: OK; en vakthund som står: DOWN", async () => {
    let healthy = true;
    const check: HealthCheck = { name: "stuck_tasks", runbook: "docs/runbooks/TIER1_RUNBOOKS.md#worker", async run() { return healthy ? { ok: true, severity: "info", message: "" } : { ok: false, severity: "warning", message: "2 jobber med utløpt lease" }; } };
    const bridge = createWatchdogIncidentBridge({ pool: app, tenantId: T, log: () => undefined });
    const watchdog = new Watchdog(new MemoryAlertSink(), {} as never, 5000);
    watchdog.register(check);
    let pending: Promise<void> = Promise.resolve();
    watchdog.setObserver((report) => { pending = bridge.observe(report); return pending; });

    await watchdog.tick();
    await pending;
    const ok = await observeWatchdog();
    expect(ok).toMatchObject({ status: "OK", data: { failing_checks: 0, consecutive_failures: 0 } });
    expect(ok.observed_at).not.toBeNull();
    expect(Date.now() - Date.parse(ok.observed_at!)).toBeLessThan(60_000);
    expect(ok.source).toContain("incident_producer_runs");

    healthy = false;
    await watchdog.tick();
    await pending;
    const degraded = await observeWatchdog();
    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.data).toMatchObject({ failing_checks: 1 });
    expect(degraded.detail).toContain("1 sjekk feiler");
    expect(JSON.stringify(degraded)).not.toContain("utløpt lease"); // sjekkens meldingstekst når aldri selvdiagnosen
    expect(JSON.stringify(degraded)).not.toContain("stuck_tasks");

    healthy = true;
    await watchdog.tick();
    await pending;
    expect((await observeWatchdog()).status).toBe("OK");

    // Vakthunden «står»: klokken flyttes 16 min frem uten et nytt tikk (3 x 300 s = 15 min).
    const later = () => new Date(Date.now() + 16 * 60_000);
    const down = await observeWatchdog({ now: later });
    expect(down.status).toBe("DOWN");
    expect(down.detail).toContain("har ikke tikket på 16 min");
    // 14 min frem er fortsatt innenfor grensen.
    expect((await observeWatchdog({ now: () => new Date(Date.now() + 14 * 60_000) })).status).toBe("OK");
  });

  it("selve selvdiagnosen: watchdog-området får målingen, og `unknown` inneholder det ikke når det er målt; begrensningen er den presise", async () => {
    const readers = buildSelfModelReaders(readerDeps());
    const diagnosis = await composeSelfDiagnosis({ readers: { watchdog: readers.watchdog }, limitations: buildLimitationRegistry({ forbiddenModelToolIds: [], connectors: [], modelProfiles: [], allModelCapabilities: [], watchdogStateReadable: true }) });
    expect(diagnosis.observations["watchdog"]?.status).toBe("OK");
    expect(diagnosis.unknown).not.toContain("watchdog");
    expect(diagnosis.limitations.find((l) => l.id === "no_cross_process_watchdog_state")?.statement).toContain("kun slik dens tikk er registrert varig");
  });

  it("tenant-isolasjon: en annen tenants vakthund-rad leses aldri (RLS), og uten egen rad er svaret UKJENT", async () => {
    await admin.query(`INSERT INTO incident_producer_runs (tenant_id, producer, last_started_at, last_finished_at, last_status, facts_seen) VALUES ('${OTHER}', 'watchdog', now(), now(), 'failed', 9)`);
    const other = await observeWatchdog({ tenantId: OTHER, watchdogRuns: watchdogRunSource(new ProducerRunStore(app), OTHER, INCIDENT_PRODUCER_INTERVAL_MS_DEFAULT) });
    expect(other.status).toBe("DEGRADED");
    expect(other.data).toMatchObject({ failing_checks: 9 });
    // T-leseren ser fortsatt KUN sin egen rad (facts_seen 0 fra forrige test), aldri OTHERs 9.
    expect((await observeWatchdog()).data).toMatchObject({ failing_checks: 0 });
    // En tenant uten rad: UKJENT.
    await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-ops2a-empty','E','business')`);
    const empty = await observeWatchdog({ tenantId: "tenant-ops2a-empty", watchdogRuns: watchdogRunSource(new ProducerRunStore(app), "tenant-ops2a-empty", INCIDENT_PRODUCER_INTERVAL_MS_DEFAULT) });
    expect(empty.status).toBe("UNKNOWN");
  });

  it("lesefeil mot databasen gir UKJENT med fast tekst (aldri OK)", async () => {
    const broken = { connect: async () => { throw new Error("connection terminated password=hunter2"); }, query: async () => { throw new Error("connection terminated password=hunter2"); } };
    const o = await observeWatchdog({ watchdogRuns: watchdogRunSource(new ProducerRunStore(broken as never), T, INCIDENT_PRODUCER_INTERVAL_MS_DEFAULT) });
    expect(o).toMatchObject({ status: "UNKNOWN", detail: WATCHDOG_UNREADABLE_DETAIL });
    expect(JSON.stringify(o)).not.toContain("hunter2");
  });

  it("leseren skriver ikke: raden er uendret etter lesing (også en lesing med klokken langt frem)", async () => {
    const before = (await admin.query(`SELECT last_started_at, last_status, facts_seen, consecutive_failures FROM incident_producer_runs WHERE tenant_id = '${T}' AND producer = 'watchdog'`)).rows;
    await observeWatchdog();
    await observeWatchdog({ now: () => new Date(Date.now() + 3_600_000) });
    const after = (await admin.query(`SELECT last_started_at, last_status, facts_seen, consecutive_failures FROM incident_producer_runs WHERE tenant_id = '${T}' AND producer = 'watchdog'`)).rows;
    expect(after).toEqual(before);
    expect(before).toHaveLength(1);
  });
});
