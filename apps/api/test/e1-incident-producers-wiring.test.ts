import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { IncidentService, providerProducer, type ProducerContext } from "@jarvis/incidents";
import { MemoryAlertSink, Watchdog, type HealthCheck } from "@jarvis/watchdog";
import {
  NOT_A_CONNECTION_TOOL_IDS, connectorStatusesFromGateway, createIncidentProducerLoop, createWatchdogIncidentBridge, parseIncidentProducerConfig,
  INCIDENT_PRODUCER_INTERVAL_MS_DEFAULT, INCIDENT_PRODUCER_MEMORY_SPACE
} from "../src/incident-producers.ts";

/**
 * WP-E1 (JARVIS-068): koblingen av incident-produsentene til kjøretiden. AV som standard (kun eksakt «true»), fail-closed på ugyldig konfig, ingen overlappende runder, og vakthund -> hendelse
 * ende-til-ende mot ekte Postgres (worker-siden). Kildetekst-vaktene sørger for at wiringen i main.ts/worker-main.ts ikke kan fjernes eller gjøres ubetinget uten at en test feiler.
 */
const SRC = (name: string) => readFile(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

describe("konfig: AV som standard og fail-closed", () => {
  it("kun eksakt «true» slår på; alt annet (også TRUE/1/yes/mellomrom) er av og leser ingenting annet", () => {
    for (const raw of [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true ", "on"]) {
      expect(parseIncidentProducerConfig({ JARVIS_INCIDENT_PRODUCERS_ENABLED: raw, JARVIS_INCIDENT_PRODUCERS_INTERVAL_MS: "ikke-et-tall" }).enabled, String(raw)).toBe(false);
    }
    expect(parseIncidentProducerConfig({ JARVIS_INCIDENT_PRODUCERS_ENABLED: "true" })).toEqual({ enabled: true, intervalMs: INCIDENT_PRODUCER_INTERVAL_MS_DEFAULT, deployRefs: ["main"], deployRepos: [] });
  });

  it("påslått: gyldige verdier parses; ugyldig intervall/gren/repo KASTER (aldri en stille NaN-timer eller en liste som betyr noe annet)", () => {
    const on = { JARVIS_INCIDENT_PRODUCERS_ENABLED: "true" };
    expect(parseIncidentProducerConfig({ ...on, JARVIS_INCIDENT_PRODUCERS_INTERVAL_MS: "120000", JARVIS_INCIDENT_DEPLOY_REFS: "main, release/1.x", JARVIS_INCIDENT_DEPLOY_REPOS: "tsworkflow/jarvisbuild,acme/web" }))
      .toEqual({ enabled: true, intervalMs: 120_000, deployRefs: ["main", "release/1.x"], deployRepos: ["tsworkflow/jarvisbuild", "acme/web"] });
    for (const interval of ["abc", "59999", "3600001", "-1", "1.5", "1e9", "Infinity"]) {
      expect(() => parseIncidentProducerConfig({ ...on, JARVIS_INCIDENT_PRODUCERS_INTERVAL_MS: interval }), interval).toThrow(/INTERVAL_MS ugyldig/);
    }
    for (const ref of ["a b", "../etc", "main;rm", "x".repeat(101), "main,..evil"]) {
      expect(() => parseIncidentProducerConfig({ ...on, JARVIS_INCIDENT_DEPLOY_REFS: ref }), ref).toThrow(/DEPLOY_REFS ugyldig/);
    }
    for (const repo of ["jarvisbuild", "a/b/c", "https://github.com/a/b", "a/b;c", "-rf/x y"]) {
      expect(() => parseIncidentProducerConfig({ ...on, JARVIS_INCIDENT_DEPLOY_REPOS: repo }), repo).toThrow(/DEPLOY_REPOS ugyldig/);
    }
  });

  it("variablene er videresendt til riktig container: bryteren til api OG worker, resten kun til api", async () => {
    // @ts-expect-error - .mjs uten typer
    const { SERVICE_ENV } = await import("../../../infra/local/service-env.mjs");
    expect(SERVICE_ENV.api).toContain("JARVIS_INCIDENT_PRODUCERS_ENABLED");
    expect(SERVICE_ENV.worker).toContain("JARVIS_INCIDENT_PRODUCERS_ENABLED");
    for (const n of ["JARVIS_INCIDENT_PRODUCERS_INTERVAL_MS", "JARVIS_INCIDENT_DEPLOY_REFS", "JARVIS_INCIDENT_DEPLOY_REPOS"]) {
      expect(SERVICE_ENV.api, n).toContain(n);
      expect(SERVICE_ENV.worker, n).not.toContain(n);
    }
  });
});

describe("tilkoblingshelse og kjøre-løkken", () => {
  it("helse hentes fra ToolGateway.health uten hvelv-oppslag; navn fra registeret, ukjente id-er beholdes", () => {
    const health = new Map([
      ["cloudflare", { state: "unavailable", at: "2026-10-09T10:00:00Z", detail: "cloudflare_error_503" }],
      ["postgres_ops", { state: "healthy", at: "2026-10-09T10:01:00Z" }]
    ]);
    const statuses = connectorStatusesFromGateway({ health });
    expect(statuses.find((s) => s.id === "cloudflare")).toMatchObject({ display_name: "Cloudflare", configured: true, health: { state: "unavailable" } });
    expect(statuses.find((s) => s.id === "postgres_ops")?.display_name).toBe("postgres_ops");
  });

  describe("L1 (WP-B3-gjennomgang + re-review NYTT 1): Jarvis' EGEN kontrollflate (`executive`) er ikke en tilkobling - et avslag åpner ALDRI en hendelse, men en allerede åpen hendelse kan fortsatt lukkes automatisk", () => {
    const FAILED_AT = "2026-10-09T10:00:00.000Z";
    const HEALED_AT = "2026-10-09T10:05:00.000Z";
    const ctx: ProducerContext = { tenantId: "t1", memorySpace: "business", now: new Date("2026-10-09T10:10:00.000Z") };
    const gatewayOf = (executive: { state: string; at: string; detail?: string }) => ({
      health: new Map([
        ["executive", executive], ["github", { state: "unavailable", at: FAILED_AT, detail: "github_error_503" }], ["growth_googleads", { state: "auth_failed", at: FAILED_AT }]
      ])
    });
    /** Den ekte produsenten over de ekte statusene fra `connectorStatusesFromGateway` - akkurat slik `buildApiIncidentProducers` kobler den. */
    const observe = (executive: { state: string; at: string; detail?: string }, active: Array<{ incident_id: string; dedupe_key: string | null; last_seen_at: string | null; opened_at: string }> = []) =>
      providerProducer({ readStatus: async () => connectorStatusesFromGateway(gatewayOf(executive)) }).observe(ctx, active as never);

    it("raden SENDES (aldri droppet), men som `configured: false`; ekte tilkoblinger er konfigurerte - og kun `executive` er unntatt", () => {
      const rows = connectorStatusesFromGateway(gatewayOf({ state: "unavailable", at: FAILED_AT, detail: "proposal_digest_mismatch" }));
      expect(rows.map((r) => [r.id, r.configured])).toEqual([["executive", false], ["github", true], ["growth_googleads", true]]);
      expect(rows[0]?.health).toMatchObject({ state: "unavailable" }); // helsen er uendret - kun «tilkobling» er falsk
      expect([...NOT_A_CONNECTION_TOOL_IDS]).toEqual(["executive"]);
    });

    it("(a) en executive som svikter gir INGEN ny hendelse - mens ekte tilkoblinger som svikter fortsatt gjør det (produsenten er ikke tom)", async () => {
      const o = await observe({ state: "unavailable", at: FAILED_AT, detail: "proposal_digest_mismatch" });
      expect(o.present.map((f) => f.subject).sort()).toEqual(["github", "growth_googleads"]);
      expect(o.present.some((f) => /executive/i.test(f.title) || f.subject === "executive")).toBe(false);
      expect(o.cleared).toEqual([]);
      // heller ikke auth_failed-formen (verre alvorlighet) åpner noe for executive
      const auth = await observe({ state: "auth_failed", at: FAILED_AT, detail: "owner_control_unauthorized" });
      expect(auth.present.some((f) => f.subject === "executive")).toBe(false);
    });

    it("(b) en allerede ÅPEN executive-hendelse (åpnet av en eldre versjon) auto-lukkes når raden er frisk igjen og nyere enn siste observerte svikt (`cleared: [\"executive\"]`)", async () => {
      const active = [{ incident_id: "inc-executive", dedupe_key: "provider:executive", last_seen_at: FAILED_AT, opened_at: FAILED_AT }];
      const o = await observe({ state: "healthy", at: HEALED_AT }, active);
      expect(o.cleared.map((c) => c.subject)).toEqual(["executive"]);
      expect(o.cleared[0]?.check).toMatchObject({ verified_by: "source_recheck", observed_at: HEALED_AT });
      expect(o.present.some((f) => f.subject === "executive")).toBe(false);
    });

    it("(b2) men aldri på tvil: er raden fortsatt utilgjengelig, eller ikke nyere enn siste observerte svikt, lukkes ingenting - og det åpnes heller ingenting", async () => {
      const active = [{ incident_id: "inc-executive", dedupe_key: "provider:executive", last_seen_at: FAILED_AT, opened_at: FAILED_AT }];
      const stillDown = await observe({ state: "unavailable", at: HEALED_AT }, active);
      expect(stillDown.cleared).toEqual([]);
      expect(stillDown.present.some((f) => f.subject === "executive")).toBe(false);
      const notNewer = await observe({ state: "healthy", at: FAILED_AT }, active);
      expect(notNewer.cleared).toEqual([]);
    });
  });

  it("en ny runde mens forrige pågår hoppes over, og en feil i en runde kastes aldri ut av løkken", async () => {
    const lines: Array<Record<string, unknown>> = [];
    let release: () => void = () => undefined;
    let calls = 0;
    const loop = createIncidentProducerLoop({
      intervalMs: 60_000, log: (l) => lines.push(l),
      run: () => { calls += 1; return new Promise((resolve) => { release = () => resolve([{ producer: "slo", status: "ok", facts_seen: 0, opened: 0, updated: 0, resolved: 0, suppressed: 0 }]); }); }
    });
    const first = loop.tick();
    expect(await loop.tick()).toBeNull();
    expect(lines.some((l) => l["msg"] === "incident_producers_skipped_overlap")).toBe(true);
    release();
    expect(await first).toHaveLength(1);
    expect(calls).toBe(1);
    const failing = createIncidentProducerLoop({ intervalMs: 60_000, log: (l) => lines.push(l), run: async () => { throw new Error("db nede Authorization: Bearer abc"); } });
    expect(await failing.tick()).toEqual([]);
    expect(lines.some((l) => l["msg"] === "incident_producers_error")).toBe(true);
    expect(await failing.tick()).toEqual([]); // løkken er ikke "låst" etter en feil
  });
});

describe("kildetekst-vakter (wiring kan ikke fjernes eller gjøres ubetinget)", () => {
  it("main.ts starter produsentene KUN bak config.enabled og gjenbruker den ene IncidentService-instansen", async () => {
    const main = await SRC("main.ts");
    expect(main).toContain("parseIncidentProducerConfig(process.env)");
    const gate = main.indexOf("if (incidentProducerConfig.enabled)");
    const start = main.indexOf("startApiIncidentProducers(");
    expect(gate).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(gate);
    expect(start - gate).toBeLessThan(200);
    expect(main).toContain("incidents: incidentService");
    expect([...main.matchAll(/new IncidentService\(/g)]).toHaveLength(1);
    expect(main).toContain('msg: "incident_producers_disabled"');
  });

  it("worker-main.ts kobler vakthunden til produsenten KUN bak config.enabled", async () => {
    const worker = await SRC("worker-main.ts");
    const gate = worker.indexOf("if (parseIncidentProducerConfig(process.env).enabled)");
    expect(gate).toBeGreaterThan(0);
    const block = worker.slice(gate, gate + 400);
    expect(block).toContain("createWatchdogIncidentBridge({ pool, tenantId: owner.tenant_id })");
    expect(block).toContain("watchdog.setObserver(");
    // Observatøren settes FØR intervallet starter (ellers ville første tikk gå tapt).
    expect(worker.indexOf("watchdog.setObserver(")).toBeLessThan(worker.indexOf("WATCHDOG_INTERVAL_MS = parseWatchdogIntervalMs"));
  });

  it("produsent-modulen skriver aldri mot eksterne systemer: ingen mutasjons-handlinger i api-wiringen", async () => {
    const src = await SRC("incident-producers.ts");
    expect(src).not.toMatch(/execute_?mutation|executeCloudMutation|executeInfraMutation|attemptRecovery|update_issue|merge_pr|delete_/);
  });
});

describe("vakthund -> hendelse ende-til-ende (worker-siden, ekte Postgres)", () => {
  let stop: (() => Promise<void>) | undefined;
  let admin: pg.Pool;
  let app: pg.Pool;
  const T = "tenant-e1wd";

  beforeAll(async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1wd-"));
    const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
    stop = leased.stop;
    await leased.postgres.createDatabase("jarvis_test");
    admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
    admin.on("error", () => undefined);
    await runMigrations(admin);
    await admin.query("CREATE ROLE jarvis_test_e1wd LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
    await admin.query("GRANT jarvis_app TO jarvis_test_e1wd");
    await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','W','business')`);
    app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1wd", password: "pw2" });
  }, 240_000);

  afterAll(async () => {
    await app?.end();
    await admin?.end();
    await stop?.();
  }, 120_000);

  it("en feilende sjekk åpner en hendelse (watchdog:<sjekk>), en senere vellykket kjøring av SAMME sjekk løser den, og observatøren kan ikke velte vakthunden", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const bridge = createWatchdogIncidentBridge({ pool: app, tenantId: T, log: (l) => lines.push(l) });
    let healthy = false;
    const check: HealthCheck = { name: "stuck_tasks", runbook: "docs/runbooks/TIER1_RUNBOOKS.md#worker", async run() { return healthy ? { ok: true, severity: "info", message: "" } : { ok: false, severity: "warning", message: "2 jobber med utløpt lease" }; } };
    const sink = new MemoryAlertSink();
    const watchdog = new Watchdog(sink, {} as never, 5000);
    watchdog.register(check);
    let pending: Promise<void> = Promise.resolve();
    watchdog.setObserver((report) => { pending = bridge.observe(report); return pending; });
    await watchdog.tick();
    await pending;
    const incidents = new IncidentService(app);
    const [opened] = await incidents.listActiveBySource(T, INCIDENT_PRODUCER_MEMORY_SPACE, "watchdog");
    expect(opened).toMatchObject({ dedupe_key: "watchdog:stuck_tasks", severity: "normal", status: "open" });
    expect(sink.alerts).toHaveLength(1); // varslingen er uendret
    await watchdog.tick();
    await pending;
    expect((await incidents.listActiveBySource(T, INCIDENT_PRODUCER_MEMORY_SPACE, "watchdog"))[0]).toMatchObject({ incident_id: opened!.incident_id, occurrence_count: 2 });
    healthy = true;
    await watchdog.tick();
    await pending;
    expect(await incidents.listActiveBySource(T, INCIDENT_PRODUCER_MEMORY_SPACE, "watchdog")).toEqual([]);
    expect((await incidents.getIncident(T, INCIDENT_PRODUCER_MEMORY_SPACE, opened!.incident_id))?.status).toBe("resolved");
    // Rolige runder (ingen endring) fyller ikke loggen; åpning og løsning logges.
    expect(lines.filter((l) => l["msg"] === "incident_producers_run")).toHaveLength(2);
  });
});
