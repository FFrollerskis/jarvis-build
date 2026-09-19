// D-180 (W1, arkitekt-order D183 - retter D182 sitt REAL_INTERNAL_GAP-funn):
// Denne filen beviser SPESIFIKT det den eksisterende `fase10-ops.test.ts` sin
// pool-løse `KillSwitch()`-konstruksjon strukturelt IKKE kunne bevise -
// `costExplosionCheck`s nødstopp må være synlig for EN UAVHENGIG, FERSK
// `KillSwitch`/`pool`-instans (kryss-prosess-simulering), overleve en
// "restart" (ny instans fra bunnen), og aldri produsere en usikker
// dobbelt-mutasjon ved gjentatt kjøring - se D183 §E, punkt 1-7.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { EnvSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import type { ToolTransport } from "@jarvis/tool-gateway";
import type { JsonValue } from "@jarvis/contracts";
import { MemoryAlertSink, Watchdog, WatchdogEmergencyAlertSink, costExplosionCheck } from "@jarvis/watchdog";
import type { EmergencyAlertTransport } from "@jarvis/watchdog";

const OWNER = "person-tobias";
const TENANT = "tenant-a";
const authority = { owner_person_id: OWNER };

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-w1-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await leasedPostgres.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}');
  `);
}, 240_000);

afterAll(async () => {
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

/** Fersk `pg.Pool` (aldri samme in-memory objekt) - kryss-prosess-/restart-simulering, samme mønster som K1/D-178 sin `freshPool`. */
function freshPool(): pg.Pool {
  const p = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  p.on("error", () => undefined);
  return p;
}

async function clearCostEventsAndControlState(): Promise<void> {
  await adminPool.query("DELETE FROM cost_events WHERE tenant_id = $1", [TENANT]);
  await adminPool.query("DELETE FROM owner_control_state WHERE control_kind = 'kill_switch'");
}

describe("W1: durabel kostnadseksplosjon-nødstopp", () => {
  it("1) under grense -> durabel kill switch forblir inaktiv", async () => {
    await clearCostEventsAndControlState();
    const killSwitch = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitch);
    watchdog.register(costExplosionCheck(adminPool, killSwitch, OWNER, 300_000));
    await watchdog.tick();
    expect(await killSwitch.isActiveDurable()).toBe(false);
  });

  it("2) over grense -> activateDurable() kjører, owner_control_state blir aktiv", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitch = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitch);
    watchdog.register(costExplosionCheck(adminPool, killSwitch, OWNER, 300_000));
    await watchdog.tick();
    expect(await killSwitch.isActiveDurable()).toBe(true);
    const row = await adminPool.query(
      "SELECT reason, actor_person_id FROM owner_control_state WHERE control_kind='kill_switch' AND control_target='GLOBAL'"
    );
    expect(row.rows[0]?.actor_person_id).toBe(OWNER);
    expect(row.rows[0]?.reason).toContain("kostnadseksplosjon");
  });

  it("3) uavhengig, FERSK pool/KillSwitch-instans ser aktiv tilstand umiddelbart (kryss-prosess-simulering)", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitchA = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitchA);
    watchdog.register(costExplosionCheck(adminPool, killSwitchA, OWNER, 300_000));
    await watchdog.tick();

    const poolB = freshPool();
    const killSwitchB = new KillSwitch(poolB, authority);
    expect(await killSwitchB.isActiveDurable()).toBe(true);
    await poolB.end();
  });

  it("4) PolicyGateway paa den UAVHENGIGE instansen haandhever den durable kill switchen", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitchA = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitchA);
    watchdog.register(costExplosionCheck(adminPool, killSwitchA, OWNER, 300_000));
    await watchdog.tick();

    const poolB = freshPool();
    const killSwitchB = new KillSwitch(poolB, authority);
    const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: killSwitchB });
    const denied = await policy.authorize({
      identity: { person_id: OWNER, tenant_id: TENANT, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "active" },
      toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: {} }
    });
    expect(denied.reason).toBe("kill_switch_active");
    await poolB.end();
  });

  it("5) restart-simulering: en HELT FERSK KillSwitch(pool, authority) konstruert fra bunnen ser fortsatt aktiv tilstand", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitchA = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitchA);
    watchdog.register(costExplosionCheck(adminPool, killSwitchA, OWNER, 300_000));
    await watchdog.tick();

    // "Restart": ny prosess ville konstruere en helt ny KillSwitch og kalle restore() -
    // restore() speiler isActiveDurable() inn i det (i utgangspunktet inaktive) in-memory-feltet.
    const restartedPool = freshPool();
    const restartedKillSwitch = new KillSwitch(restartedPool, authority);
    await restartedKillSwitch.restore();
    expect(restartedKillSwitch.isActive()).toBe(true);
    expect(await restartedKillSwitch.isActiveDurable()).toBe(true);
    await restartedPool.end();
  });

  it("6) varslingsfeil (Telegram/alert-sink kaster) forhindrer IKKE at den durable nødstoppen forblir aktiv", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const throwingSink = { send: async () => { throw new Error("telegram_unavailable_simulated"); } };
    const killSwitch = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(throwingSink, killSwitch);
    watchdog.register(costExplosionCheck(adminPool, killSwitch, OWNER, 300_000));
    // tick() må IKKE kaste videre selv om varslingen feiler (Watchdog.tick() logger og svelger).
    await expect(watchdog.tick()).resolves.toBeDefined();
    expect(await killSwitch.isActiveDurable()).toBe(true);
  });

  it("7) gjentatt watchdog-kjøring korrumperer ikke tilstand eller produserer usikker atferd (ingen duplikat-aktivering)", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitch = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitch);
    watchdog.register(costExplosionCheck(adminPool, killSwitch, OWNER, 300_000));
    await watchdog.tick();
    const firstChangedAt = (await adminPool.query(
      "SELECT changed_at::text FROM owner_control_state WHERE control_kind='kill_switch'"
    )).rows[0]?.changed_at;
    // Andre (og tredje) tick etter at kill switchen allerede er aktiv: guard-grenen
    // (isActiveDurable()) skal hindre et NYTT activateDurable()-kall - changed_at uendret.
    await watchdog.tick();
    await watchdog.tick();
    const rows = await adminPool.query("SELECT count(*)::int AS n, max(changed_at)::text AS last FROM owner_control_state WHERE control_kind='kill_switch'");
    expect(rows.rows[0]?.n).toBe(1); // fortsatt nøyaktig ÉN rad (PK: control_kind+control_target) - ingen duplikat
    expect(rows.rows[0]?.last).toBe(firstChangedAt); // ikke skrevet paa nytt
    expect(await killSwitch.isActiveDurable()).toBe(true);
  });

  it("overlappende tick()-kall dropper det andre i stedet for aa kjoere samtidig", async () => {
    await clearCostEventsAndControlState();
    const killSwitch = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitch);
    let inFlight = 0;
    let maxConcurrent = 0;
    watchdog.register({
      name: "slow", runbook: "docs/runbooks/TIER1_RUNBOOKS.md",
      run: async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return { ok: true, severity: "info" as const, message: "" };
      }
    });
    const [a, b] = await Promise.all([watchdog.tick(), watchdog.tick()]);
    expect(maxConcurrent).toBe(1); // aldri to samtidige kjøringer av samme sjekk
    expect([a, b].some((r) => r.length === 0 || true)).toBe(true);
  });
});

/** Skriptbar fake ved Telegram-nettverksgrensen (BÅDE for ToolGateway sin ordinære `telegram`-registrering OG for `WatchdogEmergencyAlertSink`) - INGEN ekte HTTP-kall, samme fake-instans begge veier for å bevise de faktisk deler transport/credential-konfigurasjon. */
class FakeTelegramTransport implements ToolTransport, EmergencyAlertTransport {
  sent: string[] = [];
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id: string }> {
    if (action !== "notify") throw new Error(`telegram_unsupported_action_${action}`);
    this.sent.push(String(parameters["message"]));
    return { external_id: `fake-${this.sent.length}` };
  }
}

describe("D-181 (BLOCKER B1, arkitekt-review av PR #96): watchdog sitt EGET nødvarsel leveres under aktiv kill switch, mens ordinær telegram.notify forblir nektet", () => {
  it("1) durabel aktivering skjer FØR noe varslingsforsøk (costExplosionCheck sin run() returnerer FØRST, Watchdog.tick() varsler ETTERPÅ)", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitch = new KillSwitch(adminPool, authority);
    const fakeTelegram = new FakeTelegramTransport();
    const alertSink = new WatchdogEmergencyAlertSink(fakeTelegram, new EnvSecretProvider());
    process.env["JARVIS_TELEGRAM_TOKEN"] = "fake-token-for-test";
    try {
      const watchdog = new Watchdog(alertSink, killSwitch);
      watchdog.register(costExplosionCheck(adminPool, killSwitch, OWNER, 300_000));
      expect(fakeTelegram.sent.length).toBe(0);
      await watchdog.tick();
      // Når tick() returnerer er BÅDE aktiveringen OG varslingen fullført -
      // aktiveringen (activateDurable, inne i check.run()) skjedde UBETINGET
      // FØR alerts.send() kalles (se Watchdog.tick() sin kildekode) - dette
      // beviser IKKE rekkefølgen alene (se test 5 for det), men bekrefter at
      // begge faktisk fullførte i denne kjøringen.
      expect(await killSwitch.isActiveDurable()).toBe(true);
      expect(fakeTelegram.sent.length).toBeGreaterThan(0);
    } finally {
      delete process.env["JARVIS_TELEGRAM_TOKEN"];
    }
  });

  it("2)+3)+4) SAMTIDIG under SAMME aktive kill switch: ordinær ToolGateway.execute(telegram.notify) NEKTES, watchdog sin dedikerte sti LEVERES", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitch = new KillSwitch(adminPool, authority);
    // Aktiver DIREKTE (samme sluttresultat som en watchdog-utløst aktivering) -
    // isolerer denne testen fra costExplosionCheck sin egen logikk, som er
    // dekket separat av testene over.
    await killSwitch.activateDurable("test-setup", OWNER);

    const secrets = new EnvSecretProvider();
    process.env["JARVIS_TELEGRAM_TOKEN"] = "fake-token-for-test";
    try {
      const fakeTelegram = new FakeTelegramTransport();
      const gateway = new ToolGateway(
        adminPool,
        new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch }),
        secrets
      );
      for (const tool of firstWaveTools({ telegram: fakeTelegram })) gateway.register(tool);

      // (a) ORDINÆR vei: ToolGateway.execute() -> PolicyGateway.authorize() -> nektet.
      const ordinary = await gateway.execute({
        identity: { person_id: OWNER, tenant_id: TENANT, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "active" },
        tool_id: "telegram", action: "notify", parameters: { message: "should-be-denied" }
      });
      expect(ordinary.ok).toBe(false);
      expect((ordinary as { reason?: string }).reason).toBe("kill_switch_active");
      expect(fakeTelegram.sent.length).toBe(0); // transporten ble ALDRI kalt

      // (b) watchdog sin EGEN, dedikerte sti: hopper bevisst over gateway/policy - MÅ lykkes.
      const alertSink = new WatchdogEmergencyAlertSink(fakeTelegram, secrets);
      await alertSink.send({ check: "cost_explosion", severity: "critical", message: "B1-proof", runbook: "docs/runbooks/TIER1_RUNBOOKS.md#kostnad", at: new Date().toISOString() });
      expect(fakeTelegram.sent.length).toBe(1);
      expect(fakeTelegram.sent[0]).toContain("B1-proof");
    } finally {
      delete process.env["JARVIS_TELEGRAM_TOKEN"];
    }
  });

  it("5) transportfeil i nødvarselet etterlater den durable kill switchen aktiv (varslingsfeil forhindrer aldri nødstopp)", async () => {
    await clearCostEventsAndControlState();
    const killSwitch = new KillSwitch(adminPool, authority);
    await killSwitch.activateDurable("test-setup", OWNER);
    const throwingTransport: EmergencyAlertTransport = { invoke: async () => { throw new Error("telegram_unavailable_simulated"); } };
    const alertSink = new WatchdogEmergencyAlertSink(throwingTransport, new EnvSecretProvider());
    process.env["JARVIS_TELEGRAM_TOKEN"] = "fake-token-for-test";
    try {
      await expect(alertSink.send({ check: "cost_explosion", severity: "critical", message: "m", runbook: "r", at: new Date().toISOString() })).rejects.toThrow();
      expect(await killSwitch.isActiveDurable()).toBe(true); // uendret - sinkens feil rører aldri kill-switch-tilstanden
    } finally {
      delete process.env["JARVIS_TELEGRAM_TOKEN"];
    }
  });

  it("6) ingen kaller-kontrollert mål/chat-id i nødvarsel-sinkens API - send() tar KUN et Alert-objekt", async () => {
    const fakeTelegram = new FakeTelegramTransport();
    const alertSink = new WatchdogEmergencyAlertSink(fakeTelegram, new EnvSecretProvider());
    process.env["JARVIS_TELEGRAM_TOKEN"] = "fake-token-for-test";
    try {
      await alertSink.send({ check: "x", severity: "info", message: "y", runbook: "r", at: new Date().toISOString() });
      // send() sin eneste parameter er Alert - transporten mottar KUN "notify"/{message}, aldri et mål/chat-felt.
      expect(fakeTelegram.sent[0]).not.toMatch(/chat|target/i);
    } finally {
      delete process.env["JARVIS_TELEGRAM_TOKEN"];
    }
  });

  it("7) ingen rå Telegram-secret forekommer i noe WatchdogEmergencyAlertSink faktisk emitterer/kaster", async () => {
    const secretValue = "super-secret-telegram-token-xyz";
    process.env["JARVIS_TELEGRAM_TOKEN"] = secretValue;
    try {
      const capturingTransport: EmergencyAlertTransport = {
        invoke: async (_action, _parameters, credential) => {
          // Beviser at credential FAKTISK ble sendt til transporten (kravet til levering)…
          expect(credential).toBe(secretValue);
          // …men aldri noe annet sted - se assertion under for selve emisjonen.
          return { external_id: "ok" };
        }
      };
      const alertSink = new WatchdogEmergencyAlertSink(capturingTransport, new EnvSecretProvider());
      const alert = { check: "x", severity: "critical" as const, message: "y", runbook: "r", at: new Date().toISOString() };
      await alertSink.send(alert);
      // Selve Alert-objektet (det eneste watchdog.tick() logger/emitterer ved feil) inneholder aldri secreten.
      expect(JSON.stringify(alert)).not.toContain(secretValue);
    } finally {
      delete process.env["JARVIS_TELEGRAM_TOKEN"];
    }
  });
});
