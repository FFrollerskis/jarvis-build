// D-180 (W1) WATCHDOG PRODUCTION WIRING + DURABLE EMERGENCY SHUTDOWN - HOST LIVE ACCEPTANCE
//
// Kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose) på Windows-hosten.
// Beviser LIVE det D182 fant som REAL_INTERNAL_GAP og D183 rettet:
// `costExplosionCheck` sin nødstopp MÅ være synlig for en UAVHENGIG, FERSK
// `pg.Pool`/`KillSwitch`-instans (kryss-prosess-simulering), overleve en
// prosess-"restart" (helt ny instans fra bunnen), håndheves av
// `PolicyGateway.isActiveDurable()`, og ALDRI produsere en usikker
// dobbelt-mutasjon. SAMME `section()`-/admin-pool-for-scaffold-/
// selvopprydding-mønster som `k1-owner-control-authority-live.ts` (K1/B1)
// og `d174-executive-control-surface-live.ts` (B2+B3) - ingen ny
// akseptanse-mekanisme.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/watchdog/scripts/w1-watchdog-durability-live.ts
// (normalt via modules/watchdog/scripts/w1-watchdog-durability-host-run.ts,
// som bootstrapper workspacet/Docker/migrasjoner FØRST)
//
// VIKTIG: denne akseptansen aktiverer KORTVARIG (noen få sekunder) den EKTE,
// GLOBALE kill switchen midt i kjøringen - SAMME disiplin som K1/B1 og
// B2+B3 sine egne kill-switch-akseptanser. Kjør derfor IKKE dette samtidig
// med annen aktiv bruk av Jarvis. `finally` garanterer alltid deaktivering +
// fjerning av den synthetiske `cost_events`-raden, og scriptet verifiserer
// til slutt at `owner_control_state` er UENDRET fra før kjøringen.
//
// INGEN ekte Telegram-API-kall: varslings-transporten er en INJISERT,
// SKRIPTBAR fake ved nettverksgrensen (`ScriptedTelegramTransport` under) -
// SAMME "fake KUN ved nettverksgrensen"-disiplin som `ScriptedWallesterGateway`
// i `d174-executive-control-surface-live.ts`. `GatewayAlertSink` sin egen
// kode (den faktiske produksjonsstien via `ToolGateway.execute()`) kjøres
// UENDRET - kun selve HTTP-kallet til Telegram er erstattet, ingen bot-
// token/chat trengs for denne akseptansen.

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, PgApprovalStore } from "@jarvis/core";
import { EnvSecretProvider, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import type { ToolTransport } from "@jarvis/tool-gateway";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { GatewayAlertSink, Watchdog, costExplosionCheck } from "../src/watchdog.ts";
import { OwnerControlsService } from "../../owner-controls/src/service.ts";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "../../owner-controls/src/transport.ts";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  w1_cost_threshold_triggered_with_test_data: "FAIL",
  w1_durable_kill_switch_active: "FAIL",
  w1_fresh_pool_observes_active_state: "FAIL",
  w1_policy_enforcement_observes_active_state: "FAIL",
  w1_restart_style_reconstruction_sees_active_state: "FAIL",
  w1_owner_recovery_via_canonical_path: "FAIL",
  w1_alert_path_attempted: "FAIL",
  w1_alert_failure_does_not_prevent_shutdown: "FAIL",
  w1_no_duplicate_activation_on_repeated_tick: "FAIL",
  w1_cleanup_state_unchanged: "FAIL",
  w1_audit_evidence_no_secret_leakage: "FAIL"
};
const diagnostics: Record<string, string> = {};

function log(msg: string): void {
  console.log(msg);
}

async function section<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  log(`\n== ${name} ==`);
  try {
    return await fn();
  } catch (err) {
    log(`${name}: UVENTET FEIL - ${(err as Error).message.slice(0, 200)}`);
    return undefined;
  }
}

const runId = randomUUID().slice(0, 8);
log(`W1 WATCHDOG DURABILITY LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const OWNER_PERSON = process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias";
const OWNER_TENANT = process.env["JARVIS_TENANT_ID"] ?? "tenant-personal";
const ownerIdentity: IdentityContext = {
  person_id: OWNER_PERSON, tenant_id: OWNER_TENANT, memory_space_id: "personal",
  session_id: `sess-w1-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
};
const watchdogIdentity: IdentityContext = { ...ownerIdentity, session_id: `sess-w1-watchdog-${runId}` };
const authority = { owner_person_id: OWNER_PERSON, owner_tenants: [OWNER_TENANT] };
const HARD_LIMIT_ORE = 300_000;
const SYNTHETIC_COST_KIND = `w1_acceptance_${runId}`;

/** Skriptbar Telegram-fake ved nettverksgrensen (se filhode) - INGEN ekte Telegram-API-kall. */
class ScriptedTelegramTransport implements ToolTransport {
  shouldFail = false;
  sent: string[] = [];
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id: string }> {
    if (action !== "notify") throw new Error(`telegram_unsupported_action_${action}`);
    if (this.shouldFail) throw new Error("telegram_unavailable_simulated");
    this.sent.push(String(parameters["message"]));
    return { external_id: `sim-${this.sent.length}` };
  }
}
const scriptedTelegram = new ScriptedTelegramTransport();

async function snapshotOwnerControlState(): Promise<Array<{ control_kind: string; control_target: string; reason: string }>> {
  const { rows } = await adminPool.query("SELECT control_kind, control_target, reason FROM owner_control_state ORDER BY control_kind, control_target");
  return rows as Array<{ control_kind: string; control_target: string; reason: string }>;
}

function buildStack(sidePool: pg.Pool): { killSwitch: KillSwitch; gateway: ToolGateway; watchdog: Watchdog } {
  const killSwitch = new KillSwitch(sidePool, authority);
  const ownerControls = new OwnerControls(killSwitch, sidePool, authority);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(sidePool), killSwitch, controls: ownerControls, authority
  });
  const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new EnvSecretProvider());
  const gateway = new ToolGateway(sidePool, policy, secrets, ownerControls);
  const ownerControlsService = new OwnerControlsService(killSwitch, ownerControls);
  for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(ownerControlsService))) gateway.register(tool);
  for (const tool of firstWaveTools({ telegram: scriptedTelegram })) gateway.register(tool);

  const alertSink = new GatewayAlertSink(gateway, watchdogIdentity);
  const watchdog = new Watchdog(alertSink, killSwitch);
  watchdog.register(costExplosionCheck(sidePool, killSwitch, OWNER_PERSON, HARD_LIMIT_ORE));
  return { killSwitch, gateway, watchdog };
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    log("\nW1 KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return;
  }

  const snapshotBefore = await snapshotOwnerControlState();
  diagnostics["owner_control_state_before"] = JSON.stringify(snapshotBefore);
  log(`owner_control_state_before=${diagnostics["owner_control_state_before"]}`);

  try {
    const primary = buildStack(pool);

    await section("1) syntetisk kostnadseksplosjon (kjøre-unik kind, over hardgrensen)", async () => {
      await pool.query(
        "INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,$2,$3)",
        [OWNER_TENANT, `model:${SYNTHETIC_COST_KIND}`, HARD_LIMIT_ORE + 1]
      );
      const { rows } = await pool.query("SELECT coalesce(sum(amount_ore),0)::int AS spent FROM cost_events WHERE at >= date_trunc('month', now())");
      const spent = rows[0]?.spent ?? 0;
      results.w1_cost_threshold_triggered_with_test_data = spent >= HARD_LIMIT_ORE ? "PASS" : "FAIL";
      diagnostics["month_spent_ore_before_tick"] = String(spent);
      log(`month_spent_ore=${spent} hard_limit_ore=${HARD_LIMIT_ORE} -> ${results.w1_cost_threshold_triggered_with_test_data}`);
    });

    await section("2) watchdog.tick() -> costExplosionCheck aktiverer DEN EKTE, delte killSwitch DURABELT", async () => {
      await primary.watchdog.tick();
      const active = await primary.killSwitch.isActiveDurable();
      results.w1_durable_kill_switch_active = active ? "PASS" : "FAIL";
      log(`durable_active=${active} -> ${results.w1_durable_kill_switch_active}`);
    });

    await section("3) UAVHENGIG, FERSK pool/KillSwitch-instans ser aktiv tilstand umiddelbart (kryss-prosess-simulering)", async () => {
      const freshPool = createPool(configFromEnv());
      try {
        const freshKillSwitch = new KillSwitch(freshPool, authority);
        const active = await freshKillSwitch.isActiveDurable();
        results.w1_fresh_pool_observes_active_state = active ? "PASS" : "FAIL";
        log(`fresh_pool_sees_active=${active} -> ${results.w1_fresh_pool_observes_active_state}`);
      } finally {
        await freshPool.end();
      }
    });

    await section("4) PolicyGateway PÅ DEN UAVHENGIGE instansen håndhever den durable kill switchen", async () => {
      const freshPool = createPool(configFromEnv());
      try {
        const freshKillSwitch = new KillSwitch(freshPool, authority);
        const freshPolicy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(freshPool), killSwitch: freshKillSwitch });
        const denied = await freshPolicy.authorize({
          identity: ownerIdentity,
          toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: {} }
        });
        const ok = denied.decision === "DENY" && denied.reason === "kill_switch_active";
        results.w1_policy_enforcement_observes_active_state = ok ? "PASS" : "FAIL";
        log(`policy_decision=${denied.decision} policy_denied_reason=${denied.reason} -> ${results.w1_policy_enforcement_observes_active_state}`);
      } finally {
        await freshPool.end();
      }
    });

    await section("5) restart-simulering: en HELT FERSK KillSwitch(pool, authority).restore() ser fortsatt aktiv tilstand", async () => {
      const freshPool = createPool(configFromEnv());
      try {
        const restarted = new KillSwitch(freshPool, authority);
        await restarted.restore();
        const ok = restarted.isActive() && (await restarted.isActiveDurable());
        results.w1_restart_style_reconstruction_sees_active_state = ok ? "PASS" : "FAIL";
        log(`restarted_in_memory=${restarted.isActive()} restarted_durable=${await restarted.isActiveDurable()} -> ${results.w1_restart_style_reconstruction_sees_active_state}`);
      } finally {
        await freshPool.end();
      }
    });

    await section("6) gjentatt tick() mens allerede aktiv -> INGEN duplikat activateDurable()-skriving", async () => {
      const before = await adminPool.query("SELECT changed_at::text FROM owner_control_state WHERE control_kind='kill_switch'");
      await primary.watchdog.tick();
      await primary.watchdog.tick();
      const after = await adminPool.query("SELECT count(*)::int AS n, max(changed_at)::text AS last FROM owner_control_state WHERE control_kind='kill_switch'");
      const ok = after.rows[0]?.n === 1 && after.rows[0]?.last === before.rows[0]?.changed_at;
      results.w1_no_duplicate_activation_on_repeated_tick = ok ? "PASS" : "FAIL";
      log(`rows=${after.rows[0]?.n} changed_at_unchanged=${after.rows[0]?.last === before.rows[0]?.changed_at} -> ${results.w1_no_duplicate_activation_on_repeated_tick}`);
    });

    await section("7) varslingsforsøk skjedde (alert path attempted)", async () => {
      const ok = scriptedTelegram.sent.length > 0;
      results.w1_alert_path_attempted = ok ? "PASS" : "FAIL";
      log(`telegram_sent_count=${scriptedTelegram.sent.length} -> ${results.w1_alert_path_attempted}`);
    });

    await section("8) simulert varslingsfeil FORHINDRER IKKE at den durable nødstoppen forblir aktiv", async () => {
      // Fjern raden + deaktiver, sett opp en NY eksplosjon med varsling satt til å feile.
      await pool.query("DELETE FROM cost_events WHERE kind = $1", [`model:${SYNTHETIC_COST_KIND}`]);
      await primary.killSwitch.deactivateDurable(OWNER_PERSON);
      scriptedTelegram.shouldFail = true;
      await pool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,$2,$3)", [OWNER_TENANT, `model:${SYNTHETIC_COST_KIND}`, HARD_LIMIT_ORE + 1]);
      await primary.watchdog.tick(); // alert.send() kaster internt - Watchdog.tick() logger og svelger, kaster ALDRI videre.
      const active = await primary.killSwitch.isActiveDurable();
      results.w1_alert_failure_does_not_prevent_shutdown = active ? "PASS" : "FAIL";
      log(`durable_active_despite_alert_failure=${active} -> ${results.w1_alert_failure_does_not_prevent_shutdown}`);
      scriptedTelegram.shouldFail = false;
    });

    await section("9) eier-gjenoppretting via KANONISK vei (owner_controls.deactivate_kill_switch, SAMME som K1/B1)", async () => {
      const deactivated = await primary.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
      const nowAllowed = await primary.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "get_control_state", parameters: {} });
      const stillInactive = !(await primary.killSwitch.isActiveDurable());
      const ok = deactivated.ok && nowAllowed.ok && stillInactive;
      results.w1_owner_recovery_via_canonical_path = ok ? "PASS" : "FAIL";
      log(`deactivate_ok=${deactivated.ok} read_ok=${nowAllowed.ok} now_inactive=${stillInactive} -> ${results.w1_owner_recovery_via_canonical_path}`);
    });

    await section("10) audit-bevis: ingen secret-/token-lekkasje i det som er logget/diagnostisert", async () => {
      const haystack = JSON.stringify(diagnostics) + JSON.stringify(scriptedTelegram.sent);
      const leaked = /bot\d+:[A-Za-z0-9_-]{20,}/.test(haystack) || haystack.includes(process.env["JARVIS_TELEGRAM_TOKEN"] ?? "\u0000no-token-configured\u0000");
      results.w1_audit_evidence_no_secret_leakage = leaked ? "FAIL" : "PASS";
      log(`secret_pattern_found=${leaked} -> ${results.w1_audit_evidence_no_secret_leakage}`);
    });

    await pool.query("DELETE FROM cost_events WHERE kind = $1", [`model:${SYNTHETIC_COST_KIND}`]);
  } finally {
    // Alltid: deaktiver en evt. gjenværende aktiv kill switch OG fjern enhver
    // gjenværende synthetic cost_events-rad, uansett hvor et FEIL over stoppet.
    const cleanupKillSwitch = new KillSwitch(pool, authority);
    if (await cleanupKillSwitch.isActiveDurable()) {
      await cleanupKillSwitch.deactivateDurable(OWNER_PERSON);
    }
    await pool.query("DELETE FROM cost_events WHERE kind = $1", [`model:${SYNTHETIC_COST_KIND}`]);

    await section("CLEANUP: owner_control_state UENDRET fra før kjøringen", async () => {
      const snapshotAfter = await snapshotOwnerControlState();
      diagnostics["owner_control_state_after"] = JSON.stringify(snapshotAfter);
      const ok = diagnostics["owner_control_state_after"] === diagnostics["owner_control_state_before"];
      results.w1_cleanup_state_unchanged = ok ? "PASS" : "FAIL";
      log(`owner_control_state_after=${diagnostics["owner_control_state_after"]} -> ${results.w1_cleanup_state_unchanged}`);
    });
  }
}

function finish(): void {
  log("\n== W1 WATCHDOG DURABILITY LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);
  const hardFail = Object.values(results).some((v) => v === "FAIL" || v === "BLOCKED_BY_RUNTIME_ROLE");
  log(`\nrun_id=${runId} hard_fail=${hardFail}`);
}

try {
  await main();
  finish();
} finally {
  await pool.end();
  await adminPool.end();
}
