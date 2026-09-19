import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-180 (W1, arkitekt-order D183 §F): `modules/watchdog/scripts/
 * w1-watchdog-durability-host-run.ts` er den ENE host-kommandoen Tobias
 * trenger for å bevise W1 LIVE. Speiler NØYAKTIG samme struktur som
 * `d174-executive-control-surface-host-run-wiring.test.ts` (se dens egen
 * filhode) - denne suiten beviser den strukturelt, uten å faktisk kjøre
 * Docker/pnpm/embedded Postgres (det er selve host-akseptansens jobb).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const hostRunSource = readSource("../scripts/w1-watchdog-durability-host-run.ts");
const liveScriptSource = readSource("../scripts/w1-watchdog-durability-live.ts");

describe("workspace bootstrap - gjenbruker EKSISTERENDE Windows-sikker pnpm-resolusjon, ingen ny mekanisme", () => {
  it("importerer buildSpawnInvocation/readPinnedPackageManager/resolvePackageManager fra DEN DELTE lib-en (ikke en duplisert kopi)", () => {
    expect(hostRunSource).toMatch(
      /import\s*\{[^}]*buildSpawnInvocation[^}]*readPinnedPackageManager[^}]*resolvePackageManager[^}]*\}\s*from\s*"\.\.\/\.\.\/core\/scripts\/lib\/package-manager-resolve\.ts"/s
    );
  });
  it("kjører install --frozen-lockfile FØR docker build", () => {
    const installIdx = hostRunSource.indexOf('"install", "--frozen-lockfile"');
    const dockerIdx = hostRunSource.indexOf("ensurePostgresAndFreshImages(");
    expect(installIdx).toBeGreaterThan(-1);
    expect(dockerIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(dockerIdx);
    expect(hostRunSource).not.toMatch(/--no-frozen-lockfile/);
  });
  it("bruker ALDRI shell:true i faktisk kjørbar kode (DEP0190-trygt)", () => {
    for (const source of [hostRunSource, liveScriptSource]) {
      const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
      expect(codeOnly).not.toMatch(/shell:\s*true/);
    }
    expect(hostRunSource).toContain('execFileSync(command, args, { stdio: "inherit", cwd });');
  });
  it("kjører migrate FØR api/worker restartes med --force-recreate", () => {
    const migrateIdx = hostRunSource.indexOf('"run", "--rm", "migrate"');
    const restartIdx = hostRunSource.indexOf('"--force-recreate", "api", "worker"');
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(-1);
    expect(migrateIdx).toBeLessThan(restartIdx);
  });
  it("kjører selve w1-watchdog-durability-live.ts akseptansen til slutt, med .env og type-stripping", () => {
    expect(hostRunSource).toContain('"--env-file=.env", "--experimental-transform-types",');
    expect(hostRunSource).toContain('"modules/watchdog/scripts/w1-watchdog-durability-live.ts"');
  });
});

describe("live-scriptet: ingen ekte Telegram-API-kall, ingen ekte kredensial-mekanisme", () => {
  it("bruker en skriptbar ScriptedTelegramTransport-fake ved nettverksgrensen, aldri en rå fetch mot api.telegram.org", () => {
    expect(liveScriptSource).toContain("class ScriptedTelegramTransport implements ToolTransport");
    expect(liveScriptSource).not.toContain("api.telegram.org");
  });
  it("WatchdogEmergencyAlertSink sin egen produksjonskode kjøres UENDRET (kun transporten under er fake) - D-181/BLOCKER B1", () => {
    expect(liveScriptSource).toContain("new WatchdogEmergencyAlertSink(scriptedTelegram, secrets)");
  });
  it("SAMME scriptedTelegram-instans brukes BÅDE for den ordinære telegram-verktøyregistreringen OG nødvarsel-sinken", () => {
    expect(liveScriptSource).toMatch(/firstWaveTools\(\{\s*telegram:\s*scriptedTelegram\s*\}\)/);
    expect(liveScriptSource.match(/new ScriptedTelegramTransport\(\)/g)?.length).toBe(1);
  });
});

describe("D-181 (BLOCKER B1): live-scriptet beviser BEGGE samtidig - ordinær telegram.notify nektet, watchdog sin egen sti levert", () => {
  it("seksjon 2b kjører BÅDE et ordinært gateway.execute(telegram.notify)-kall OG primary.alertSink.send() under SAMME aktive tilstand", () => {
    const idx = liveScriptSource.indexOf("BLOKKER B1");
    expect(idx).toBeGreaterThan(-1);
    const sectionBody = liveScriptSource.slice(idx, idx + 1800);
    expect(sectionBody).toContain('tool_id: "telegram", action: "notify"');
    expect(sectionBody).toContain('"kill_switch_active"');
    expect(sectionBody).toContain("primary.alertSink.send(");
  });
  it("seksjon 2b kommer FØR seksjon 3 (fersk-pool), altså mens primary sin kill switch fortsatt er aktiv fra seksjon 2", () => {
    const s2Idx = liveScriptSource.indexOf('"2) watchdog.tick()');
    const s2bIdx = liveScriptSource.indexOf("BLOKKER B1");
    const s3Idx = liveScriptSource.indexOf('"3) UAVHENGIG, FERSK pool');
    expect(s2Idx).toBeGreaterThan(-1);
    expect(s2bIdx).toBeGreaterThan(s2Idx);
    expect(s3Idx).toBeGreaterThan(s2bIdx);
  });
});

describe("live-scriptet: kill switch-aktivering er alltid kortvarig og garantert opprettet i finally", () => {
  it("har en finally-blokk (rundt HELE main()-forsøket) som deaktiverer killSwitch og fjerner den synthetiske cost_events-raden uansett feil", () => {
    const cleanupIdx = liveScriptSource.indexOf("cleanupKillSwitch");
    expect(cleanupIdx).toBeGreaterThan(-1);
    const cleanupBody = liveScriptSource.slice(cleanupIdx, cleanupIdx + 500);
    expect(cleanupBody).toContain("deactivateDurable(OWNER_PERSON)");
    expect(cleanupBody).toContain("DELETE FROM cost_events WHERE kind = $1");
  });
  it("verifiserer at owner_control_state er UENDRET fra før kjøringen (CLEANUP-seksjonen)", () => {
    expect(liveScriptSource).toContain("owner_control_state_after");
    expect(liveScriptSource).toContain("w1_cleanup_state_unchanged");
  });
});

describe("live-scriptet: proof-punktene fra D183 §F er alle representert", () => {
  const expectedResultKeys = [
    "q21_runtime_role_safe",
    "w1_cost_threshold_triggered_with_test_data",
    "w1_durable_kill_switch_active",
    "w1_ordinary_telegram_notify_remains_blocked_under_kill_switch",
    "w1_alert_path_attempted",
    "w1_fresh_pool_observes_active_state",
    "w1_policy_enforcement_observes_active_state",
    "w1_restart_style_reconstruction_sees_active_state",
    "w1_owner_recovery_via_canonical_path",
    "w1_alert_failure_does_not_prevent_shutdown",
    "w1_no_duplicate_activation_on_repeated_tick",
    "w1_cleanup_state_unchanged",
    "w1_audit_evidence_no_secret_leakage"
  ];
  it.each(expectedResultKeys)("results-objektet inneholder nøkkelen %s", (key) => {
    expect(liveScriptSource).toContain(`${key}:`);
  });
});
