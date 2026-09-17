// K1 (Sovereign graduation, D-164) OWNER CONTROL AUTHORITY - HOST LIVE ACCEPTANCE
// Kjøres AV TOBIAS mot ekte lokal Postgres + EKTE api/worker-containere
// (docker-compose) på Windows-hosten. Gjenbruker KUN eksisterende arkitektur
// (@jarvis/owner-controls, @jarvis/policy, @jarvis/tool-gateway, @jarvis/core)
// - ingen alternativ testimplementasjon. Samme admin-pool-for-scaffold/
// runtime-pool-for-operasjoner-separasjon, `section()`-markører og
// selvopprydding som `ua10-p1-situation-sweep-live.ts`.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/owner-controls/scripts/k1-owner-control-authority-live.ts --compose-args '[...]'
// (normalt via modules/owner-controls/scripts/k1-owner-control-authority-host-run.ts,
// som bootstrapper workspacet/Docker/migrasjoner (inkl. 058) FØRST og gir
// compose-argumentene videre hit)
//
// AVVIK FRA DE ØVRIGE LIVE-SCRIPTENE (bevisst, dokumentert): dette scriptet
// utfører en EKTE `docker compose restart api worker` MIDT i kjøringen - det
// er selve K1-beviset ("durabilitet OVER en ekte prosess-restart", ikke bare
// over en simulert JS-instans). De øvrige *-live.ts-scriptene restarter
// ALDRI midt i seg selv (host-run.ts restarter alltid FØR). Kill switchen
// er GLOBAL og ÉN, ikke tenant-scopet syntetisk data - derfor brukes den
// EKTE, konfigurerte eier-identiteten (JARVIS_OWNER_PERSON_ID/JARVIS_TENANT_ID),
// ALDRI en syntetisk eier (sovereign-autoritet kan strukturelt ikke simuleres
// for en annen person_id). Alt annet (connector-mål som fryses/gjenopprettes)
// er et SYNTETISK, kjøre-unikt navn - aldri en ekte, i bruk værende connector.
//
// HVA SOM BEVISES (markørene under, alle initialisert til FAIL):
//   A. runtime/DB     - Q-21 runtime-rolle, migrasjon 058 anvendt, owner_control_state finnes
//   B. aktivering     - owner_controls.activate_kill_switch (EKTE eier-identitet) lykkes
//   C. api-blokkering - "api"-siden (egen pg.Pool + KillSwitch/OwnerControls/PolicyGateway/
//                       ToolGateway-instans) nekter en klasse C-mutasjon mens kill switch er aktiv
//   D. worker-blokkering - en HELT SEPARAT "worker"-side (egen pg.Pool, egne instanser)
//                       ser SAMME nektelse - INGEN prosess-lokal divergens
//   E. restart        - EKTE `docker compose restart api worker`, deretter FERSKE
//                       instanser (INGEN restore() kalt eksplisitt FØR sjekken - beviser
//                       at isActiveDurable() ikke avhenger av en oppvarmingsfase) ser
//                       kill switchen FORTSATT aktiv
//   F. gjenopptak     - deactivate_kill_switch (fra "worker"-siden - beviser symmetri)
//                       gjenoppretter tilgang, sett fra BÅDE api- og worker-siden
//   G. audit          - audit_events har rader for aktivering/nektelse/deaktivering med
//                       korrekt actor/reason, INGEN credential-verdi i payload
//   H. opprydding     - owner_control_state er IDENTISK med snapshotet FØR kjøringen
//                       (ingen ekte frys/tilbakekall/kill-switch-tilstand endret varig)
//
// INGEN ekte connector fryses. INGEN kunde-/forretningsdata røres. Kill
// switchen er aktiv i BARE de få sekundene mellom B og F her under - scriptet
// deaktiverer den ALLTID igjen i `finally`, også ved feil.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, PgApprovalStore
} from "@jarvis/core";
import { BUSINESS_INTERNAL_CREDENTIAL_REF, BusinessInternalSecretProvider } from "@jarvis/business";
import { EnvSecretProvider, FallbackSecretProvider, ToolGateway } from "@jarvis/tool-gateway";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { OwnerControlsService } from "../src/service.ts";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "../src/transport.ts";
import type { OwnerControlState } from "../src/types.ts";
import type { IdentityContext } from "@jarvis/contracts";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  k1_migration_058_applied: "FAIL",
  k1_activation: "FAIL",
  k1_api_side_blocked: "FAIL",
  k1_worker_side_blocked: "FAIL",
  k1_restart_state_survives: "FAIL",
  k1_no_startup_window: "FAIL",
  k1_resume_restores_both_sides: "FAIL",
  k1_audit_evidence: "FAIL",
  k1_cleanup_state_unchanged: "FAIL"
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

const argvComposeIdx = process.argv.indexOf("--compose-args");
const composeArgs: string[] = argvComposeIdx >= 0 ? (JSON.parse(process.argv[argvComposeIdx + 1]!) as string[]) : [];

function dockerRestartApiWorker(): void {
  if (composeArgs.length === 0) {
    throw new Error("k1_missing_compose_args: kjør via k1-owner-control-authority-host-run.ts, ikke direkte, hvis --compose-args mangler");
  }
  log(`$ docker ${[...composeArgs, "restart", "api", "worker"].join(" ")}`);
  execFileSync("docker", [...composeArgs, "restart", "api", "worker"], { stdio: "inherit", cwd: process.cwd() });
}

const runId = randomUUID().slice(0, 8);
log(`K1 OWNER CONTROL AUTHORITY LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

// EKTE, konfigurert eier - se filhodet for hvorfor dette IKKE kan være en syntetisk identitet.
const OWNER_PERSON = process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias";
const OWNER_TENANT = process.env["JARVIS_TENANT_ID"] ?? "tenant-personal";
const ownerIdentity: IdentityContext = {
  person_id: OWNER_PERSON, tenant_id: OWNER_TENANT, memory_space_id: "business",
  session_id: `sess-k1-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
};
const SYNTHETIC_CONNECTOR = `k1_acceptance_connector_${runId}`;
const authority = { owner_person_id: OWNER_PERSON, owner_tenants: [OWNER_TENANT] };

function buildStack(sidePool: pg.Pool): { killSwitch: KillSwitch; ownerControls: OwnerControls; gateway: ToolGateway } {
  const killSwitch = new KillSwitch(sidePool, authority);
  const ownerControls = new OwnerControls(killSwitch, sidePool, authority);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(sidePool),
    killSwitch,
    controls: ownerControls,
    authority
  });
  const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
  const gateway = new ToolGateway(sidePool, policy, secrets, ownerControls);
  const service = new OwnerControlsService(killSwitch, ownerControls);
  for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(service))) gateway.register(tool);
  return { killSwitch, ownerControls, gateway };
}

async function getState(gateway: ToolGateway): Promise<OwnerControlState> {
  const result = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "get_control_state", parameters: {} });
  if (!result.ok) throw new Error(`k1_unexpected_denial:${result.reason}`);
  return result.data as unknown as OwnerControlState;
}

async function snapshotOwnerControlState(): Promise<Array<{ control_kind: string; control_target: string; reason: string }>> {
  const { rows } = await adminPool.query("SELECT control_kind, control_target, reason FROM owner_control_state ORDER BY control_kind, control_target");
  return rows as Array<{ control_kind: string; control_target: string; reason: string }>;
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
    log("\nK1 KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  await section("MIGRASJON 058 ANVENDT (schema_migrations + owner_control_state)", async () => {
    const { rows } = await adminPool.query(`SELECT 1 FROM schema_migrations WHERE name = '058_owner_control_authority.sql'`);
    const { rows: table } = await adminPool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'owner_control_state'`
    );
    const columns = (table as Array<{ column_name: string }>).map((r) => r.column_name);
    const ok = rows.length === 1 &&
      ["control_kind", "control_target", "reason", "actor_person_id", "changed_at"].every((c) => columns.includes(c));
    results.k1_migration_058_applied = ok ? "PASS" : "FAIL";
    diagnostics["owner_control_state_columns"] = columns.join(",");
    log(`migration_058_row=${rows.length === 1} columns=${columns.join(",")} -> k1_migration_058_applied: ${results.k1_migration_058_applied}`);
  });
  if (results.k1_migration_058_applied !== "PASS") return finish();

  const snapshotBefore = await snapshotOwnerControlState();
  diagnostics["owner_control_state_before"] = JSON.stringify(snapshotBefore);
  log(`owner_control_state_before=${diagnostics["owner_control_state_before"]}`);

  // "api"-siden og "worker"-siden er HELT SEPARATE pg.Pool-instanser (ekte separate
  // TCP-forbindelser til samme database) - matcher NØYAKTIG hvordan apps/api/src/main.ts
  // og apps/api/src/worker-main.ts hver konstruerer sin EGEN KillSwitch/OwnerControls/
  // PolicyGateway/ToolGateway, med samme `pool`+`authority`-mønster, men ALDRI samme JS-objekt.
  let apiPool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  let cleanupSucceeded = false;
  try {
    apiPool = createPool(configFromEnv());
    workerPool = createPool(configFromEnv());
    let apiStack = buildStack(apiPool);
    let workerStack = buildStack(workerPool);

    await section("AKTIVERING (owner_controls.activate_kill_switch via EKTE eier-identitet, 'api'-siden)", async () => {
      const activated = await apiStack.gateway.execute({
        identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch",
        parameters: { reason: `K1 host-akseptanse ${runId} - kortvarig, deaktiveres automatisk` }
      });
      results.k1_activation = activated.ok ? "PASS" : "FAIL";
      log(`activate_ok=${activated.ok}${activated.ok ? "" : ` reason=${(activated as { reason?: string }).reason}`} -> k1_activation: ${results.k1_activation}`);
      const state = await getState(apiStack.gateway);
      diagnostics["control_state_after_activation"] = JSON.stringify(state.kill_switch);
      log(`control_state_after_activation=${diagnostics["control_state_after_activation"]}`);
    });

    await section("API-SIDEN BLOKKERES (klasse C freeze_connector nektes mens kill switch er aktiv)", async () => {
      const blocked = await apiStack.gateway.execute({
        identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector",
        parameters: { connector_id: SYNTHETIC_CONNECTOR, reason: "k1-should-be-blocked" }
      });
      const ok = !blocked.ok && (blocked as { reason?: string }).reason === "kill_switch_active";
      results.k1_api_side_blocked = ok ? "PASS" : "FAIL";
      log(`api_blocked_ok=${blocked.ok} reason=${(blocked as { reason?: string }).reason ?? "-"} -> k1_api_side_blocked: ${results.k1_api_side_blocked}`);
    });

    await section("WORKER-SIDEN SER SAMME BLOKKERING (helt separat pg.Pool + instanser, INGEN synk-melding sendt)", async () => {
      const blocked = await workerStack.gateway.execute({
        identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector",
        parameters: { connector_id: SYNTHETIC_CONNECTOR, reason: "k1-should-be-blocked-worker" }
      });
      const ok = !blocked.ok && (blocked as { reason?: string }).reason === "kill_switch_active";
      results.k1_worker_side_blocked = ok ? "PASS" : "FAIL";
      log(`worker_blocked_ok=${blocked.ok} reason=${(blocked as { reason?: string }).reason ?? "-"} -> k1_worker_side_blocked: ${results.k1_worker_side_blocked}`);
    });

    await section("EKTE CONTAINER-RESTART (docker compose restart api worker)", async () => {
      dockerRestartApiWorker();
      log("docker_restart=PASS (api/worker-containerne er restartet)");
    });

    await section("INGEN OPPSTARTSVINDU: FERSKE instanser (INGEN restore() kalt) ser kill switchen FORTSATT aktiv umiddelbart", async () => {
      // Nye pg.Pool + HELT NYE KillSwitch/OwnerControls-objekter - `restore()` bevisst
      // IKKE kalt her, for å bevise at selve `isActiveDurable()`-sjekken (LIVE DB-spørring)
      // er korrekt FØR noen oppvarmingsfase, ikke bare etter en eksplisitt restore().
      apiPool = createPool(configFromEnv());
      workerPool = createPool(configFromEnv());
      apiStack = buildStack(apiPool);
      workerStack = buildStack(workerPool);
      const apiStillActive = await apiStack.killSwitch.isActiveDurable();
      const workerStillActive = await workerStack.killSwitch.isActiveDurable();
      results.k1_restart_state_survives = apiStillActive ? "PASS" : "FAIL";
      results.k1_no_startup_window = apiStillActive && workerStillActive ? "PASS" : "FAIL";
      log(`api_still_active_after_restart=${apiStillActive} worker_still_active_after_restart=${workerStillActive} -> k1_restart_state_survives: ${results.k1_restart_state_survives} k1_no_startup_window: ${results.k1_no_startup_window}`);
    });

    await section("GJENOPPTAK (deactivate_kill_switch fra 'worker'-siden - symmetri) - BÅDE api OG worker gjenopprettes", async () => {
      const deactivated = await workerStack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
      const apiAllowedNow = await apiStack.gateway.execute({
        identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR, reason: "k1-verify-resumed" }
      });
      const workerSeesFreeze = await workerStack.ownerControls.isFrozenDurable(SYNTHETIC_CONNECTOR);
      const unfrozen = await apiStack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR } });
      const ok = deactivated.ok && apiAllowedNow.ok && workerSeesFreeze && unfrozen.ok;
      results.k1_resume_restores_both_sides = ok ? "PASS" : "FAIL";
      log(`deactivate_ok=${deactivated.ok} api_freeze_after_resume_ok=${apiAllowedNow.ok} worker_saw_freeze=${workerSeesFreeze} unfreeze_ok=${unfrozen.ok} -> k1_resume_restores_both_sides: ${results.k1_resume_restores_both_sides}`);
    });

    await section("AUDIT-BEVIS (activate/deny/deactivate har audit_events-rader med korrekt actor, INGEN credential-verdi)", async () => {
      const { rows } = await adminPool.query(
        `SELECT type, decision, reason, action, payload FROM audit_events
         WHERE tool_id = 'owner_controls' AND person_id = $1 AND action IN ('activate_kill_switch','freeze_connector','deactivate_kill_switch','unfreeze_connector')
         ORDER BY audit_id DESC LIMIT 10`,
        [OWNER_PERSON]
      );
      const events = rows as Array<{ type: string; decision: string; reason: string | null; action: string; payload: Record<string, unknown> }>;
      const hasActivate = events.some((e) => e.action === "activate_kill_switch" && e.type === "tool.executed");
      const hasDenied = events.some((e) => e.action === "freeze_connector" && e.decision === "DENY" && e.reason === "kill_switch_active");
      const hasDeactivate = events.some((e) => e.action === "deactivate_kill_switch" && e.type === "tool.executed");
      // Den FAKTISKE, oppløste credential-verdien (aldri kun credential_ref) skal ALDRI
      // forekomme i audit-payloaden - løs den ekte produksjonskjeden og søk etter den.
      const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
      const resolvedCredential = await secrets.get(BUSINESS_INTERNAL_CREDENTIAL_REF);
      const serialized = JSON.stringify(events);
      const noSecretLeak = !resolvedCredential || !serialized.includes(resolvedCredential);
      const ok = hasActivate && hasDenied && hasDeactivate && noSecretLeak;
      results.k1_audit_evidence = ok ? "PASS" : "FAIL";
      log(`audit_rows=${events.length} has_activate=${hasActivate} has_denied=${hasDenied} has_deactivate=${hasDeactivate} -> k1_audit_evidence: ${results.k1_audit_evidence}`);
    });

    cleanupSucceeded = true;
  } finally {
    await section("CLEANUP (kill switch garantert deaktivert, synthetic frys fjernet, tilstand IDENTISK med før kjøringen)", async () => {
      const cleanupPool = createPool(configFromEnv());
      try {
        const cleanupStack = buildStack(cleanupPool);
        // Idempotent sikkerhetsnett: uansett hvor langt over feilet, garanter at INGENTING
        // fra denne kjøringen står igjen - deaktiver kill switch (no-op hvis allerede inaktiv)
        // og fjern SYNTHETIC_CONNECTOR-frysen (no-op hvis allerede fjernet).
        await cleanupStack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} }).catch(() => undefined);
        await cleanupStack.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: SYNTHETIC_CONNECTOR } }).catch(() => undefined);
        const snapshotAfter = await snapshotOwnerControlState();
        diagnostics["owner_control_state_after"] = JSON.stringify(snapshotAfter);
        const unchanged = JSON.stringify(snapshotAfter) === JSON.stringify(snapshotBefore);
        results.k1_cleanup_state_unchanged = unchanged ? "PASS" : "FAIL";
        log(`owner_control_state_after=${diagnostics["owner_control_state_after"]} unchanged=${unchanged} main_sequence_completed=${cleanupSucceeded} -> k1_cleanup_state_unchanged: ${results.k1_cleanup_state_unchanged}`);
      } finally {
        await cleanupPool.end();
      }
    });
    await apiPool?.end();
    await workerPool?.end();
  }

  return finish();
}

function finish(): void {
  log("\n== K1 OWNER CONTROL AUTHORITY LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);
  const hardFail = Object.values(results).some((v) => v === "FAIL" || v === "BLOCKED_BY_RUNTIME_ROLE");
  log(`\nrun_id=${runId} hard_fail=${hardFail}`);
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}
