import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { DomainPauseRegistry } from "../src/domain-pause.ts";
import { buildInformMessage, buildNotifyMessage, MAX_INFORM_DELIVERIES_PER_SWEEP, MAX_TELEGRAM_MESSAGE_CHARS, SituationEngine } from "../src/service.ts";

/**
 * D-396 (JARVIS-085) - situasjonsmotorens semantikk: (1) en for lang/ubetrodd `reason` ga en melding Telegram avviser (ventende for alltid, daglig «feilet» sveip),
 * (2) en delvis policy-oppdatering nullstilte stille-timene, (3) leveringen hadde ingen grense per sveip, (4) pause stoppet kun ACT - ikke varsler.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let engine: SituationEngine;
const TENANT = "tenant-sit-d396";
const identity: IdentityContext = { person_id: "p", tenant_id: TENANT, memory_space_id: "business", session_id: "s", device_id: "jarvis-core", channel: "api", auth_strength: "active" };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-sit-d396-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_sit_d396 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sit_d396");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'D396', 'business')`);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_sit_d396", password: "pw2" });
  engine = new SituationEngine(appPool, new DomainPauseRegistry());
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("meldingstekst: ubetrodd reason kuttes og renses", () => {
  it("kort tekst er UENDRET (fingeravtrykk/eksisterende varsler påvirkes ikke)", () => {
    expect(buildInformMessage("spend", "high", "suggest", "Kampanje 3x over")).toBe("Jarvis foreslår handling [spend, high]: Kampanje 3x over");
    expect(buildNotifyMessage("Reduserte budsjett", "growth", "reduce")).toBe("Jarvis utførte en handling: Reduserte budsjett (growth.reduce)");
  });

  it("10 000 tegn kuttes innenfor Telegram-grensen med «…», og kontrolltegn fjernes (linjeskift beholdes)", () => {
    const long = `emne\u0000med\u0007kontroll\nlinje2 ${"x".repeat(10_000)}`;
    const m = buildInformMessage("support", "normal", "inform", long);
    expect(m.length).toBeLessThanOrEqual(MAX_TELEGRAM_MESSAGE_CHARS);
    expect(m.endsWith("…")).toBe(true);
    expect(m).not.toMatch(/[\u0000\u0007]/);
    expect(m).toContain("kontroll\nlinje2");
    const n = buildNotifyMessage(long, "tool", "act");
    expect(n.length).toBeLessThanOrEqual(MAX_TELEGRAM_MESSAGE_CHARS);
    expect(n.endsWith("(tool.act)")).toBe(true);
  });
});

describe("setNotificationPolicy: delvis oppdatering beholder øvrige felt", () => {
  it("oppdatering av kun resuppress_hours beholder stille-timene; eksplisitt null nullstiller dem", async () => {
    await engine.setNotificationPolicy(TENANT, "business", { quiet_hours_start_utc: 22, quiet_hours_end_utc: 6, resuppress_hours: 6 });
    const merged = await engine.setNotificationPolicy(TENANT, "business", { resuppress_hours: 12 });
    expect(merged).toMatchObject({ quiet_hours_start_utc: 22, quiet_hours_end_utc: 6, resuppress_hours: 12 });
    const cleared = await engine.setNotificationPolicy(TENANT, "business", { quiet_hours_start_utc: null, quiet_hours_end_utc: null });
    expect(cleared).toMatchObject({ quiet_hours_start_utc: null, quiet_hours_end_utc: null, resuppress_hours: 12 });
  });
});

describe("deliverPendingInformNotifications: tak per sveip og pause", () => {
  async function seed(n: number, domain: string): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await engine.evaluateCandidate(TENANT, "business", { domain, detection_key: `${domain}:${i}`, priority: "normal", reason: `Hendelse ${domain} ${i}` });
    }
  }
  const okGateway = (calls: string[]): ToolGateway => ({ execute: async (req: { parameters: { message: string } }) => { calls.push(req.parameters.message); return { ok: true }; } }) as unknown as ToolGateway;

  it("maks MAX_INFORM_DELIVERIES_PER_SWEEP leveres per kall; resten er UTSATT (deferred) og tas neste sveip", async () => {
    await seed(MAX_INFORM_DELIVERIES_PER_SWEEP + 5, "cap");
    const calls: string[] = [];
    const first = await engine.deliverPendingInformNotifications(TENANT, "business", okGateway(calls), identity);
    expect(first.delivered).toBe(MAX_INFORM_DELIVERIES_PER_SWEEP);
    expect(first.deferred).toBe(5);
    expect(first.pending).toBe(0);
    const second = await engine.deliverPendingInformNotifications(TENANT, "business", okGateway(calls), identity);
    expect(second.delivered).toBe(5);
    expect(second.deferred).toBe(0);
    expect(calls).toHaveLength(MAX_INFORM_DELIVERIES_PER_SWEEP + 5);
  });

  it("pause på ett domene hopper over KUN det domenet; `*` (pause_all) hopper over alt - ingenting sendes", async () => {
    await seed(2, "paused-dom");
    await seed(2, "free-dom");
    await adminPool.query("INSERT INTO situation_domain_pauses (domain, reason) VALUES ('paused-dom', 'test')");
    const calls: string[] = [];
    const some = await engine.deliverPendingInformNotifications(TENANT, "business", okGateway(calls), identity);
    expect(some.paused).toBe(2);
    expect(some.delivered).toBe(2);
    expect(calls.every((m) => m.includes("free-dom"))).toBe(true);

    await adminPool.query("INSERT INTO situation_domain_pauses (domain, reason) VALUES ('*', 'alt på pause')");
    await seed(1, "after-all");
    const none = await engine.deliverPendingInformNotifications(TENANT, "business", okGateway(calls), identity);
    expect(none.delivered).toBe(0);
    expect(none.paused).toBeGreaterThanOrEqual(3);
    expect(calls).toHaveLength(2);
    await adminPool.query("DELETE FROM situation_domain_pauses");
  });
});
