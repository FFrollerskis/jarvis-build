import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-180 (W1, arkitekt-order D183, §E punkt 8 "production wiring structural
 * test"): beviser STRUKTURELT (ingen Docker/DB nødvendig - det er selve
 * `w1-watchdog-durability-live.ts` sin jobb, se den egne host-run-wiring-
 * suiten for DEN) at (a) `@jarvis/watchdog` faktisk konsumeres av
 * `apps/api/src/worker-main.ts`, (b) alle tre kanoniske sjekkene
 * registreres, (c) INGEN legacy `killSwitch.activate(` (den ikke-durable
 * no-op-en D182 fant) gjenstår noe sted i produksjonskilden. Samme mønster
 * som `d174-executive-control-surface-host-run-wiring.test.ts` sin
 * kildetekst-lesing.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const workerMainSource = readSource("../../../apps/api/src/worker-main.ts");
const mainSource = readSource("../../../apps/api/src/main.ts");
const watchdogSource = readSource("../src/watchdog.ts");
const apiPackageJson = readSource("../../../apps/api/package.json");
const ownerControlStoreSource = readSource("../../policy/src/owner-control-store.ts");

describe("W1: @jarvis/watchdog er faktisk konsumert av worker-main.ts (WATCHDOG_PRODUCTION_WIRED)", () => {
  it("apps/api/package.json lister @jarvis/watchdog som dependency", () => {
    expect(apiPackageJson).toMatch(/"@jarvis\/watchdog":\s*"workspace:\*"/);
  });

  it("worker-main.ts importerer Watchdog/databaseCheck/stuckTasksCheck/costExplosionCheck/WatchdogEmergencyAlertSink fra @jarvis/watchdog", () => {
    expect(workerMainSource).toMatch(
      /import\s*\{[^}]*WatchdogEmergencyAlertSink[^}]*Watchdog[^}]*costExplosionCheck[^}]*databaseCheck[^}]*stuckTasksCheck[^}]*\}\s*from\s*"@jarvis\/watchdog"/s
    );
  });

  it("worker-main.ts konstruerer ÉN Watchdog-instans og registrerer alle tre kanoniske sjekker", () => {
    expect(workerMainSource).toContain("new Watchdog(watchdogAlertSink, killSwitch)");
    expect(workerMainSource).toContain("watchdog.register(databaseCheck(pool))");
    expect(workerMainSource).toContain("watchdog.register(stuckTasksCheck(pool))");
    expect(workerMainSource).toMatch(/watchdog\.register\(\s*costExplosionCheck\(/);
    // Nøyaktig ÉN konstruksjon - ingen duplikat watchdog-instans i samme fil.
    expect(workerMainSource.match(/new Watchdog\(/g)?.length).toBe(1);
  });

  it("watchdogen startes ETTER assertRuntimeRoleSafe/killSwitch.restore()/ownerControls.restore(), FØR intervall-drenerings-loopen", () => {
    const roleSafeIdx = workerMainSource.indexOf("assertRuntimeRoleSafe(pool)");
    const killSwitchRestoreIdx = workerMainSource.indexOf("await killSwitch.restore()");
    const ownerControlsRestoreIdx = workerMainSource.indexOf("await ownerControls.restore()");
    const watchdogConstructIdx = workerMainSource.indexOf("new Watchdog(watchdogAlertSink, killSwitch)");
    const drainLoopIdx = workerMainSource.indexOf("void worker\n      .drain()");
    expect(roleSafeIdx).toBeGreaterThan(-1);
    expect(killSwitchRestoreIdx).toBeGreaterThan(-1);
    expect(ownerControlsRestoreIdx).toBeGreaterThan(-1);
    expect(watchdogConstructIdx).toBeGreaterThan(-1);
    expect(drainLoopIdx).toBeGreaterThan(-1);
    expect(watchdogConstructIdx).toBeGreaterThan(roleSafeIdx);
    expect(watchdogConstructIdx).toBeGreaterThan(killSwitchRestoreIdx);
    expect(watchdogConstructIdx).toBeGreaterThan(ownerControlsRestoreIdx);
    expect(watchdogConstructIdx).toBeLessThan(drainLoopIdx);
  });

  it("watchdog.tick() kjøres på et intervall og feil logges (aldri en ufanget promise-rejection)", () => {
    expect(workerMainSource).toMatch(/setInterval\(\s*\(\)\s*=>\s*\n?\s*void watchdog\s*\n?\s*\.tick\(\)/);
    expect(workerMainSource).toContain("watchdog_tick_error");
  });

  it("costExplosionCheck kalles med ownerControlAuthority.owner_person_id - ALDRI en oppdiktet/udefinert aktør", () => {
    expect(workerMainSource).toMatch(/costExplosionCheck\(pool,\s*killSwitch,\s*ownerControlAuthority\.owner_person_id,/);
  });

  it("apps/api/src/main.ts registrerer IKKE en egen watchdog-instans (unngå duplikat, D183 §A)", () => {
    expect(mainSource).not.toContain("new Watchdog(");
    expect(mainSource).not.toMatch(/from\s*"@jarvis\/watchdog"/);
  });
});

describe("W1: ingen legacy ikke-durabel killSwitch.activate()-kall gjenstår i watchdog.ts (WATCHDOG_KILL_SWITCH_DURABLE)", () => {
  it("costExplosionCheck bruker activateDurable(), ALDRI den bare .activate()-formen", () => {
    expect(watchdogSource).toContain("await killSwitch.activateDurable(");
    expect(watchdogSource).not.toMatch(/killSwitch\.activate\(`kostnadseksplosjon/);
  });

  it("costExplosionCheck guard-sjekker mot isActiveDurable() (aldri kun den synkrone isActive()) FØR den (evt.) aktiverer på nytt", () => {
    const fnStart = watchdogSource.indexOf("export function costExplosionCheck(");
    const fnBody = watchdogSource.slice(fnStart, fnStart + 2500);
    expect(fnBody).toContain("await killSwitch.isActiveDurable()");
  });

  it("costExplosionCheck krever et eksplisitt ownerPersonId-parameter (ingen default/undefined-fallback)", () => {
    expect(watchdogSource).toMatch(/export function costExplosionCheck\(\s*pool: pg\.Pool,\s*killSwitch: KillSwitch,\s*ownerPersonId: string,/);
  });
});

describe("W1: WatchdogEmergencyAlertSink erstatter den kastende TelegramAlertSink-stubben (WATCHDOG_ALERT_DELIVERY_STATUS)", () => {
  it("den gamle, ubetinget-kastende TelegramAlertSink-klassen finnes ikke lenger", () => {
    expect(watchdogSource).not.toContain('throw new Error("telegram_alert_unverified');
  });

  it("Watchdog.tick() logger (aldri svelger stille) en varslingsfeil, og fortsetter uansett", () => {
    expect(watchdogSource).toContain("watchdog_alert_delivery_failed");
  });
});

describe("D-181 (BLOCKER B1, arkitekt-review av PR #96): nødvarselet hopper BEVISST over ToolGateway/PolicyGateway, i stedet for en generell isSelfRecoveryAction()-utvidelse", () => {
  it("D-180 sin GatewayAlertSink (som rutet varselet gjennom ToolGateway.execute, og dermed ble nektet av sin egen kill-switch-aktivering) finnes ikke lenger", () => {
    expect(watchdogSource).not.toContain("export class GatewayAlertSink");
    expect(watchdogSource).not.toMatch(/gateway\.execute\(\{\s*\n?\s*identity:\s*this\.identity,\s*\n?\s*tool_id:\s*"telegram"/);
  });

  it("WatchdogEmergencyAlertSink kaller transport.invoke() DIREKTE - INGEN ToolGateway/PolicyGateway i kallkjeden", () => {
    const classIdx = watchdogSource.indexOf("export class WatchdogEmergencyAlertSink");
    expect(classIdx).toBeGreaterThan(-1);
    const classBody = watchdogSource.slice(classIdx, classIdx + 1200);
    expect(classBody).toContain("this.transport.invoke(");
    expect(classBody).not.toContain("ToolGateway");
    expect(classBody).not.toContain(".execute(");
  });

  it("watchdog.ts har INGEN import fra @jarvis/tool-gateway eller @jarvis/contracts (mindre avhengighetsgraf enn D-180, ikke større)", () => {
    expect(watchdogSource).not.toMatch(/from\s*"@jarvis\/tool-gateway"/);
    expect(watchdogSource).not.toMatch(/from\s*"@jarvis\/contracts"/);
  });

  it("nødvarsel-sinkens send()-metode tar KUN et Alert-objekt - ingen kaller-kontrollert mål/chat-parameter i grensesnittet", () => {
    const classIdx = watchdogSource.indexOf("export class WatchdogEmergencyAlertSink");
    const classBody = watchdogSource.slice(classIdx, classIdx + 1200);
    expect(classBody).toMatch(/async send\(alert: Alert\): Promise<void>/);
    expect(classBody).not.toMatch(/send\([^)]*chat/i);
    expect(classBody).not.toMatch(/send\([^)]*target/i);
  });

  it("isSelfRecoveryAction() i modules/policy er IKKE utvidet med telegram - den globale kill-switch-semantikken for ORDINÆR telegram.notify er uendret", () => {
    expect(ownerControlStoreSource).not.toMatch(/toolId === "telegram"/);
    expect(ownerControlStoreSource).not.toMatch(/TELEGRAM_SELF_RECOVERY_ACTIONS/);
  });

  it("worker-main.ts injiserer DEN SAMME telegramTransport/toolSecretProvider-instansen i BÅDE den ordinære telegram-registreringen OG WatchdogEmergencyAlertSink (ingen parallell credential-mekanisme)", () => {
    expect(workerMainSource).toContain("const telegramTransport = new TelegramTransport();");
    expect(workerMainSource).toMatch(/telegram:\s*telegramTransport/);
    expect(workerMainSource).toContain("new WatchdogEmergencyAlertSink(telegramTransport, toolSecretProvider)");
    // Ingen ANDRE `new TelegramTransport(` - nøyaktig én instans i hele filen.
    expect(workerMainSource.match(/new TelegramTransport\(/g)?.length).toBe(1);
  });
});

describe("W1: overlappende tick()-kjøringer forhindres (D183 §D)", () => {
  it("Watchdog har en ticking-vakt som dropper (og logger) en overlappende tick() i stedet for å kjøre samtidig", () => {
    expect(watchdogSource).toContain("private ticking = false;");
    expect(watchdogSource).toContain("watchdog_tick_skipped_overlap");
  });
});
