// D-180/D-181 (W1 + BLOCKER B1 fix) WATCHDOG PRODUCTION WIRING + DURABLE
// EMERGENCY SHUTDOWN + EMERGENCY ALERT DELIVERY - HOST LIVE ACCEPTANCE
//
// Kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose) på Windows-hosten.
// Beviser LIVE det D182 fant som REAL_INTERNAL_GAP (D183 rettet) OG det en
// uavhengig arkitekt-review av PR #96 fant som BLOCKER B1 (D184 rettet):
// `costExplosionCheck` sin nødstopp MÅ være synlig for en UAVHENGIG, FERSK
// `pg.Pool`/`KillSwitch`-instans (kryss-prosess-simulering), overleve en
// prosess-"restart" (helt ny instans fra bunnen), håndheves av
// `PolicyGateway.isActiveDurable()`, ALDRI produsere en usikker
// dobbelt-mutasjon - OG watchdog-en må FAKTISK KUNNE VARSLE Tobias etter at
// den globale kill switchen er aktiv, MENS en ordinær `telegram.notify`
// gjennom `ToolGateway.execute()` FORBLIR nektet med `kill_switch_active`
// (BLOCKER B1: D-180 sin opprinnelige `GatewayAlertSink` rutet varselet
// gjennom akkurat DEN stien, og ble derfor selv nektet av sin egen
// nødavstenging). SAMME `section()`-/admin-pool-for-scaffold-/
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
// i `d174-executive-control-surface-live.ts`. SAMME fake-instans brukes BÅDE
// som den ordinære `telegram`-verktøytransporten (registrert i `gateway`) OG
// som `WatchdogEmergencyAlertSink` sin transport - identisk med hvordan
// produksjons-wiringen (`worker-main.ts`) injiserer DEN SAMME
// `TelegramTransport`-instansen begge steder. `WatchdogEmergencyAlertSink`
// sin egen kode (den faktiske produksjonsstien, som BEVISST hopper over
// `ToolGateway.execute()`) kjøres UENDRET - kun selve HTTP-kallet til
// Telegram er erstattet.

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, PgApprovalStore } from "@jarvis/core";
import { EnvSecretProvider, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import type { ToolTransport } from "@jarvis/tool-gateway";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { WatchdogEmergencyAlertSink, Watchdog, costExplosionCheck } from "../src/watchdog.ts";
import { OwnerControlsService } from "../../owner-controls/src/service.ts";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "../../owner-controls/src/transport.ts";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  w1_cost_threshold_triggered_with_test_data: "FAIL",
  w1_durable_kill_switch_active: "FAIL",
  // D-181 (BLOCKER B1): de to må bevises SAMTIDIG, under SAMME aktive
  // kill-switch-tilstand - se seksjon 2b.
  w1_ordinary_telegram_notify_remains_blocked_under_kill_switch: "FAIL",
  w1_alert_path_attempted: "FAIL",
  // D-184: `w1_alert_path_attempted` over bevises av et DIREKTE
  // `alertSink.send()`-kall i seksjon 2b (den kontrollerte samtidigheten mot
  // det nektede gateway-kallet). Denne markøren beviser det STERKERE punktet:
  // at watchdog-ens EGEN `tick()` - hele produksjonskjeden
  // costExplosionCheck -> activateDurable -> alerts.send -> transport -
  // FAKTISK leverte varselet, og at den durable kill switchen ALLEREDE var
  // aktiv i det leveringen skjedde (observert rekkefølge, ikke lest ut av kode).
  w1_emergency_alert_delivered_by_watchdog_tick: "FAIL",
  w1_durable_shutdown_observed_before_alert: "FAIL",
  w1_fresh_pool_observes_active_state: "FAIL",
  w1_policy_enforcement_observes_active_state: "FAIL",
  w1_restart_style_reconstruction_sees_active_state: "FAIL",
  w1_owner_recovery_via_canonical_path: "FAIL",
  w1_alert_failure_does_not_prevent_shutdown: "FAIL",
  w1_no_duplicate_activation_on_repeated_tick: "FAIL",
  w1_cleanup_state_unchanged: "FAIL",
  w1_audit_evidence_no_secret_leakage: "FAIL"
};
const diagnostics: Record<string, string> = {};
/** D-184: alt `console.error` faktisk skrev paa varslings-feilstien (seksjon 8) - skannes for secret-lekkasje i seksjon 10. */
const capturedErrorLogs: string[] = [];

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

/** D-184: én observasjon av den DURABLE tilstanden på SELVE leveringstidspunktet, tatt inne i watchdog-ens egen tick()-kjede. */
interface AlertOrderObservation {
  durableActiveAtSendTime: boolean;
  sentCountAtSendTime: number;
}

function buildStack(sidePool: pg.Pool): {
  killSwitch: KillSwitch; gateway: ToolGateway; watchdog: Watchdog;
  alertSink: WatchdogEmergencyAlertSink; alertOrder: AlertOrderObservation[];
} {
  const killSwitch = new KillSwitch(sidePool, authority);
  const ownerControls = new OwnerControls(killSwitch, sidePool, authority);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(sidePool), killSwitch, controls: ownerControls, authority
  });
  const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new EnvSecretProvider());
  const gateway = new ToolGateway(sidePool, policy, secrets, ownerControls);
  const ownerControlsService = new OwnerControlsService(killSwitch, ownerControls);
  for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(ownerControlsService))) gateway.register(tool);
  // Den ORDINÆRE `telegram.notify`-verktøydefinisjonen - går gjennom
  // `ToolGateway.execute()`/`PolicyGateway.authorize()` som normalt, og skal
  // derfor korrekt NEKTES med `kill_switch_active` når kill switchen er
  // aktiv (se seksjon 2b). SAMME `scriptedTelegram`-instans som
  // nødvarsel-sinken under - beviser at BEGGE veiene faktisk deler samme
  // underliggende transport/credential-konfigurasjon, ikke to divergerende.
  for (const tool of firstWaveTools({ telegram: scriptedTelegram })) gateway.register(tool);

  // D-181 (BLOCKER B1): `WatchdogEmergencyAlertSink` hopper BEVISST over
  // `gateway`/`policy` (se watchdog.ts sin egen begrunnelse) - injiserer
  // DEN SAMME `scriptedTelegram`/`secrets`-instansen som den ordinære
  // registreringen over, SAMME `credential_ref` (default-parameteren i
  // sinken selv).
  const alertSink = new WatchdogEmergencyAlertSink(scriptedTelegram, secrets);

  // D-184: watchdog-en får en TYNN observatør rundt den EKTE sinken - den
  // endrer ingenting, den noterer KUN hva den durable tilstanden var i det
  // leveringen startet. Uten dette kunne live-kjøringen bare si at begge
  // deler hadde skjedd, ikke i hvilken rekkefølge (arkitektkrav 1 og 2).
  // `alertSink` selv eksponeres UENDRET til seksjon 2b.
  const alertOrder: AlertOrderObservation[] = [];
  const observingSink = {
    send: async (alert: Parameters<WatchdogEmergencyAlertSink["send"]>[0]) => {
      alertOrder.push({
        durableActiveAtSendTime: await killSwitch.isActiveDurable(),
        sentCountAtSendTime: scriptedTelegram.sent.length
      });
      await alertSink.send(alert);
    }
  };
  const watchdog = new Watchdog(observingSink, killSwitch);
  watchdog.register(costExplosionCheck(sidePool, killSwitch, OWNER_PERSON, HARD_LIMIT_ORE));
  return { killSwitch, gateway, watchdog, alertSink, alertOrder };
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

  // D-184: nødvarselet kan ikke leveres uten den KANONISKE Telegram-
  // credentialen (samme `credential_ref` som ordinær `telegram.notify`).
  // Mangler den, feiler leveringsbevisene av en KONFIGURASJONSgrunn, ikke en
  // kodegrunn - si det rett ut i stedet for å la det se ut som en B1-regresjon.
  // Kun tilstedeværelse logges, ALDRI verdien.
  diagnostics["telegram_credential_configured"] = String(Boolean(process.env["JARVIS_TELEGRAM_TOKEN"]));
  log(`telegram_credential_configured=${diagnostics["telegram_credential_configured"]} (ref=JARVIS_TELEGRAM_TOKEN, verdi aldri logget)`);

  const snapshotBefore = await snapshotOwnerControlState();
  diagnostics["owner_control_state_before"] = JSON.stringify(snapshotBefore);
  log(`owner_control_state_before=${diagnostics["owner_control_state_before"]}`);

  try {
    const primary = buildStack(pool);

    await section("1) syntetisk kostnadseksplosjon (kjøre-unik kind, over hardgrensen)", async () => {
      // D-190 (BLOCKER B3): synteseoppsettet er test-scaffolding, ikke atferden som
      // testes - INSERT går derfor via `adminPool`, ALDRI via den samme `pool` som
      // `costExplosionCheck` bruker. `jarvis_runtime` (RLS) skal IKKE ha en bredere
      // INSERT-rettighet på `cost_events` bare for at harnesset skal kunne kjøre.
      await adminPool.query(
        "INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,$2,$3)",
        [OWNER_TENANT, `model:${SYNTHETIC_COST_KIND}`, HARD_LIMIT_ORE + 1]
      );
      // Denne SELECT-en kjører BEVISST via den ordinære runtime-`pool`-en (uendret) -
      // den beviser at `jarvis_runtime` FAKTISK kan LESE den syntetiske raden gjennom
      // den ekte produksjonsspørringsveien (SAMME spørring som `costExplosionCheck`
      // selv kjører), selv om den ikke kan skrive/slette den (D-190 §"REQUIRED FIX").
      const { rows } = await pool.query("SELECT coalesce(sum(amount_ore),0)::int AS spent FROM cost_events WHERE at >= date_trunc('month', now())");
      const spent = rows[0]?.spent ?? 0;
      results.w1_cost_threshold_triggered_with_test_data = spent >= HARD_LIMIT_ORE ? "PASS" : "FAIL";
      diagnostics["month_spent_ore_before_tick"] = String(spent);
      log(`month_spent_ore=${spent} hard_limit_ore=${HARD_LIMIT_ORE} -> ${results.w1_cost_threshold_triggered_with_test_data}`);
    });

    await section("2) watchdog.tick() -> costExplosionCheck aktiverer DEN EKTE, delte killSwitch DURABELT, OG leverer nødvarselet i SAMME tick (D-184)", async () => {
      const sentBeforeTick = scriptedTelegram.sent.length;
      await primary.watchdog.tick();
      const active = await primary.killSwitch.isActiveDurable();
      results.w1_durable_kill_switch_active = active ? "PASS" : "FAIL";
      log(`durable_active=${active} -> ${results.w1_durable_kill_switch_active}`);

      // D-184: HELE produksjonskjeden i ÉN tick - ikke et manuelt sink-kall.
      const deliveredByTick = scriptedTelegram.sent.length > sentBeforeTick;
      results.w1_emergency_alert_delivered_by_watchdog_tick = deliveredByTick ? "PASS" : "FAIL";
      diagnostics["alert_order_observations"] = JSON.stringify(primary.alertOrder);
      log(`emergency_alert_delivered_by_tick=${deliveredByTick} sent_count=${scriptedTelegram.sent.length} -> ${results.w1_emergency_alert_delivered_by_watchdog_tick}`);

      // OBSERVERT rekkefølge: nødstoppen var allerede durabelt skrevet DA
      // varslingen startet, og ingenting var sendt før den tid.
      const first = primary.alertOrder[0];
      const orderOk = first !== undefined && first.durableActiveAtSendTime && first.sentCountAtSendTime === sentBeforeTick;
      results.w1_durable_shutdown_observed_before_alert = orderOk ? "PASS" : "FAIL";
      log(`durable_active_at_send_time=${first?.durableActiveAtSendTime ?? "-"} sent_count_at_send_time=${first?.sentCountAtSendTime ?? "-"} -> ${results.w1_durable_shutdown_observed_before_alert}`);
    });

    await section(
      "2b) BLOKKER B1 (D184): BEGGE SAMTIDIG, under SAMME aktive kill-switch-tilstand - ordinær telegram.notify FORBLIR nektet, MENS watchdog-ens EGEN nødvarsel-sti FAKTISK leveres",
      async () => {
        const sentBefore = scriptedTelegram.sent.length;
        // (a) ordinær vei: ToolGateway.execute() -> PolicyGateway.authorize() -> NEKTET.
        const ordinary = await primary.gateway.execute({
          identity: ownerIdentity, tool_id: "telegram", action: "notify", parameters: { message: "ordinary-call-should-be-denied" }
        });
        const ordinaryBlocked = !ordinary.ok && (ordinary as { reason?: string }).reason === "kill_switch_active";
        results.w1_ordinary_telegram_notify_remains_blocked_under_kill_switch = ordinaryBlocked ? "PASS" : "FAIL";
        log(`ordinary_telegram_notify_ok=${ordinary.ok} reason=${(ordinary as { reason?: string }).reason ?? "-"} -> ${results.w1_ordinary_telegram_notify_remains_blocked_under_kill_switch}`);

        // (b) watchdog sin EGEN, dedikerte sti: hopper bevisst over gateway/policy - MÅ fortsatt lykkes.
        await primary.alertSink.send({ check: "cost_explosion", severity: "critical", message: "B1-proof", runbook: "docs/runbooks/TIER1_RUNBOOKS.md#kostnad", at: new Date().toISOString() });
        const delivered = scriptedTelegram.sent.length > sentBefore;
        results.w1_alert_path_attempted = delivered ? "PASS" : "FAIL";
        log(`emergency_alert_delivered=${delivered} sent_count=${scriptedTelegram.sent.length} -> ${results.w1_alert_path_attempted}`);
      }
    );

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

    await section("8) simulert varslingsfeil FORHINDRER IKKE at den durable nødstoppen forblir aktiv", async () => {
      // D-190 (BLOCKER B3): scaffold-DELETE/INSERT via `adminPool`, SAMME
      // begrunnelse som seksjon 1 - test-fixture-håndtering, ikke atferden
      // som testes. `deactivateDurable` (canonical recovery-vei) og
      // `watchdog.tick()` (den ekte kjeden, inkl. `costExplosionCheck`s egen
      // SELECT) fortsetter UENDRET på runtime-`pool`.
      await adminPool.query("DELETE FROM cost_events WHERE kind = $1", [`model:${SYNTHETIC_COST_KIND}`]);
      await primary.killSwitch.deactivateDurable(OWNER_PERSON);
      scriptedTelegram.shouldFail = true;
      await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,$2,$3)", [OWNER_TENANT, `model:${SYNTHETIC_COST_KIND}`, HARD_LIMIT_ORE + 1]);
      // D-184: FEILSTIEN er den eneste stien der en credential i det hele tatt
      // KAN nå en logg (`watchdog_alert_delivery_failed` logger feilmeldingen).
      // Fang derfor det som FAKTISK skrives, og la seksjon 10 skanne det.
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        capturedErrorLogs.push(args.map(String).join(" "));
        originalConsoleError(...args);
      };
      try {
        await primary.watchdog.tick(); // alert.send() kaster internt - Watchdog.tick() logger og svelger, kaster ALDRI videre.
      } finally {
        console.error = originalConsoleError;
      }
      const active = await primary.killSwitch.isActiveDurable();
      results.w1_alert_failure_does_not_prevent_shutdown = active ? "PASS" : "FAIL";
      log(`durable_active_despite_alert_failure=${active} captured_error_logs=${capturedErrorLogs.length} -> ${results.w1_alert_failure_does_not_prevent_shutdown}`);
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
      // D-184: haystacken inkluderer nå ogsaa DET SOM FAKTISK BLE LOGGET paa
      // varslings-FEILSTIEN (seksjon 8) - ikke bare diagnostikk og sendte
      // meldinger. Det er der en credential realistisk kunne havnet.
      const haystack = JSON.stringify(diagnostics) + JSON.stringify(scriptedTelegram.sent) + JSON.stringify(capturedErrorLogs);
      const leaked = /bot\d+:[A-Za-z0-9_-]{20,}/.test(haystack) || haystack.includes(process.env["JARVIS_TELEGRAM_TOKEN"] ?? "\u0000no-token-configured\u0000");
      results.w1_audit_evidence_no_secret_leakage = leaked ? "FAIL" : "PASS";
      log(`secret_pattern_found=${leaked} scanned_error_logs=${capturedErrorLogs.length} -> ${results.w1_audit_evidence_no_secret_leakage}`);
    });

    // D-190 (BLOCKER B3): scaffold-cleanup via `adminPool` - se seksjon 1/8.
    await adminPool.query("DELETE FROM cost_events WHERE kind = $1", [`model:${SYNTHETIC_COST_KIND}`]);
  } finally {
    // Alltid: deaktiver en evt. gjenværende aktiv kill switch OG fjern enhver
    // gjenværende synthetic cost_events-rad, uansett hvor et FEIL over stoppet.
    // D-190 (BLOCKER B3): kill switch-objektet under forblir BEVISST på
    // runtime-`pool` (samme kanoniske skrivevei som produksjonen selv bruker -
    // IKKE del av B3-funnet, som var isolert til cost_events-fixture-
    // operasjoner). Fixture-DELETE-en under bruker derimot `adminPool` - den
    // skal ALDRI igjen kunne feile med "permission denied for table
    // cost_events", uavhengig av hvor try-blokken over stoppet.
    const cleanupKillSwitch = new KillSwitch(pool, authority);
    if (await cleanupKillSwitch.isActiveDurable()) {
      await cleanupKillSwitch.deactivateDurable(OWNER_PERSON);
    }
    await adminPool.query("DELETE FROM cost_events WHERE kind = $1", [`model:${SYNTHETIC_COST_KIND}`]);

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
