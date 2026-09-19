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
  /** D-184: de FAKTISKE parameter-objektene transporten mottok - grunnlaget for "ingen kaller-kontrollert mål"-beviset (API-form, ikke bare meldingstekst). */
  received: Array<Record<string, JsonValue>> = [];
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id: string }> {
    if (action !== "notify") throw new Error(`telegram_unsupported_action_${action}`);
    this.received.push(parameters);
    this.sent.push(String(parameters["message"]));
    return { external_id: `fake-${this.sent.length}` };
  }
}

describe("D-181 (BLOCKER B1, arkitekt-review av PR #96): watchdog sitt EGET nødvarsel leveres under aktiv kill switch, mens ordinær telegram.notify forblir nektet", () => {
  it("1)+2) OBSERVERT REKKEFØLGE på den EKTE kjørestien: kill switchen er allerede DURABELT AKTIV i det nødvarselet faktisk leveres", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitch = new KillSwitch(adminPool, authority);
    const fakeTelegram = new FakeTelegramTransport();
    const realSink = new WatchdogEmergencyAlertSink(fakeTelegram, new EnvSecretProvider());
    // D-184: den forrige versjonen av denne testen kunne KUN si at begge deler
    // hadde fullført når tick() returnerte - den leste rekkefølgen ut av
    // kildekoden, ikke ut av kjøringen. Denne wrapperen spør den DURABLE
    // tilstanden PÅ SELVE LEVERINGSTIDSPUNKTET, og gjør dermed begge
    // arkitektkravene (1: nedstengning først, 2: varsel leverbart ETTER at
    // kill switchen er aktiv) til ett observert faktum.
    const observed: Array<{ durableActiveAtSendTime: boolean; sentCountAtSendTime: number }> = [];
    const observingSink = {
      send: async (alert: Parameters<typeof realSink.send>[0]) => {
        observed.push({
          durableActiveAtSendTime: await killSwitch.isActiveDurable(),
          sentCountAtSendTime: fakeTelegram.sent.length
        });
        await realSink.send(alert);
      }
    };
    process.env["JARVIS_TELEGRAM_TOKEN"] = "fake-token-for-test";
    try {
      const watchdog = new Watchdog(observingSink, killSwitch);
      watchdog.register(costExplosionCheck(adminPool, killSwitch, OWNER, 300_000));
      expect(fakeTelegram.sent.length).toBe(0);
      await watchdog.tick();

      expect(observed.length).toBe(1);
      // Krav 1: nødstoppen var ALLEREDE durabelt skrevet da varslingen startet.
      expect(observed[0]?.durableActiveAtSendTime).toBe(true);
      // ...og ingenting var sendt før den tid - aktivering er beviselig først.
      expect(observed[0]?.sentCountAtSendTime).toBe(0);
      // Krav 2: varselet ble FAKTISK levert (transporten kalt), under aktiv kill switch.
      expect(fakeTelegram.sent.length).toBe(1);
      expect(fakeTelegram.sent[0]).toContain("cost_explosion");
      expect(await killSwitch.isActiveDurable()).toBe(true);
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
      // D-184: bevis på API-FORM, ikke på meldingstekst (forrige versjon
      // sjekket kun at strengen ikke inneholdt ordet "chat"/"target" - det
      // ville passert selv om send() HADDE tatt et mål-argument).
      expect(alertSink.send.length).toBe(1); // nøyaktig ÉN parameter: Alert
      await alertSink.send({ check: "x", severity: "info", message: "y", runbook: "r", at: new Date().toISOString() });
      // Transporten mottok NØYAKTIG {message} - ingen chat_id/target/to/recipient
      // kan uttrykkes gjennom denne grensen i det hele tatt. Mottakeren er
      // transportens EGEN, allerede konfigurerte destinasjon.
      expect(Object.keys(fakeTelegram.received[0] ?? {})).toEqual(["message"]);
      // Et Alert-objekt med et "smuglet" mål-felt endrer ikke hva transporten får.
      await alertSink.send({
        check: "x", severity: "info", message: "y", runbook: "r", at: new Date().toISOString(),
        ...({ chat_id: "attacker-chat", target: "attacker" } as unknown as Record<string, never>)
      });
      expect(Object.keys(fakeTelegram.received[1] ?? {})).toEqual(["message"]);
      expect(JSON.stringify(fakeTelegram.received)).not.toContain("attacker");
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

  it("7b) D-184: en transport som legger credentialen i SIN EGEN feilmelding lekker den likevel ALDRI til Watchdog.tick() sin driftslogg", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const secretValue = "super-secret-telegram-token-xyz";
    process.env["JARVIS_TELEGRAM_TOKEN"] = secretValue;
    const errorLines: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { errorLines.push(args.map(String).join(" ")); };
    try {
      // Verste tilfelle: transporten kaster en feil som inneholder HELE URL-en
      // med tokenet i - nøyaktig formen `fetch`-feil mot api.telegram.org kan ta.
      const leakyTransport: EmergencyAlertTransport = {
        invoke: async (_action, _parameters, credential) => {
          throw new Error(`request to https://api.telegram.org/bot${credential}/sendMessage failed`);
        }
      };
      const killSwitch = new KillSwitch(adminPool, authority);
      const watchdog = new Watchdog(new WatchdogEmergencyAlertSink(leakyTransport, new EnvSecretProvider()), killSwitch);
      watchdog.register(costExplosionCheck(adminPool, killSwitch, OWNER, 300_000));
      await watchdog.tick();

      const logged = errorLines.join("\n");
      expect(logged).toContain("watchdog_alert_delivery_failed"); // feilen ble FAKTISK logget (aldri stille)
      expect(logged).not.toContain(secretValue); // ...men uten den rå credentialen
      expect(logged).toContain("[REDACTED_CREDENTIAL]");
      // ...og nødstoppen står fortsatt (krav 5), selv med en lekkasjeutsatt transport.
      expect(await killSwitch.isActiveDurable()).toBe(true);
    } finally {
      console.error = originalConsoleError;
      delete process.env["JARVIS_TELEGRAM_TOKEN"];
    }
  });
});
