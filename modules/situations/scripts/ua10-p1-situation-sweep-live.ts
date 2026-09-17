// UA-10 P1 SITUATION ENGINE AKTIVERING (D-160) - HOST LIVE ACCEPTANCE
// Kjøres AV TOBIAS mot ekte lokal Postgres (docker-compose) på Windows-hosten.
// Gjenbruker KUN eksisterende arkitektur (@jarvis/situations, @jarvis/business,
// @jarvis/core, @jarvis/policy, @jarvis/tool-gateway) - ingen alternativ
// testimplementasjon. Speiler NØYAKTIG samme admin-pool-for-scaffold/runtime-
// pool-for-operasjoner-separasjon, `section()`-markører, kjøre-unik tenant-
// suffiks og selvopprydding som `ua4-growth-core-live.ts`.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/situations/scripts/ua10-p1-situation-sweep-live.ts
// (normalt via modules/situations/scripts/ua10-p1-situation-sweep-host-run.ts,
// som bootstrapper workspacet/Docker/migrasjoner (inkl. 057) først)
//
// HVA SOM BEVISES (markørene under, alle initialisert til FAIL):
//   A. runtime/DB   - Q-21 runtime-rolle, migrasjon 057 anvendt etter 055/056,
//                     DomainPauseRegistry.restore() + SituationEngine initialisert
//   B. live-sti     - EKTE business_followups -> EKTE OpenLoopService.
//                     detectOverdueFollowups() -> bro -> situasjon -> sveip
//                     healthy (assertSituationSweepHealthy kaster ikke)
//   C. leveranse    - INFORM via EKTE ToolGateway/PolicyGateway med den
//                     KANONISKE `telegram.notify`-definisjonen (firstWaveTools);
//                     wrapperen videresender ALLE transport-argumenter (D-160 I);
//                     evidens-først + idempotent replay. Med JARVIS_TELEGRAM_TOKEN
//                     + JARVIS_TELEGRAM_CHAT_ID i .env går varselet til den EKTE
//                     Telegram-transporten (ett syntetisk varsel til eierens chat);
//                     uten: en lokal opptaker-transport, og markøren
//                     `ua10_notification_live_transport` settes BLOCKED_EXTERNAL
//                     (ALDRI en fake PASS).
//   D. suverenitet  - eier-autoritet, forfalsket identitet avvist, domene-pause
//                     stopper/gjenoppretter auto-ACT, policy uten eier feiler
//                     lukket, nøyaktig ÉN ACT + ÉN varsling ved replay, feil
//                     tenant/space feiler lukket, release-stuck-claim-sti
//   E. feilatferd   - evidensmismatch => EKTE DailyScheduler bokfører IKKE
//                     jobben (completed_at forblir NULL), sunn kjøring bokføres
//   F. opprydding   - all syntetisk scaffolding fjernes (inkl. scheduler_state
//                     for de kjøre-unike jobbnavnene og situation_autonomy_policies,
//                     som Q-20-erasure bevisst utelater)
//
// Auto-ACT bruker en AKSEPTANSE-LOKAL aktuator (`ua10_acceptance_actuator`,
// klasse D med preflight/readback gjennom HELE ToolGateway-pipelinen) - INGEN
// ekte ekstern mutasjon. Produksjonens `situation-sweep`-jobb (job_name
// "situation-sweep") røres ALDRI: scheduler-beviset bruker kjøre-unike jobbnavn.
//
// Bruker UTELUKKENDE syntetiske tenants (tenant-ua10-sit-live-<run_id>-a/-b)
// - RØRER ALDRI ekte kunde-/forretningsdata. INGEN credential/token logges.

import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, PgApprovalStore } from "@jarvis/core";
import { BUSINESS_INTERNAL_CREDENTIAL_REF, BusinessInternalSecretProvider, BusinessService, OpenLoopService } from "@jarvis/business";
import {
  DailyScheduler, EnvSecretProvider, FallbackSecretProvider, TelegramTransport, ToolGateway, firstWaveTools,
  type ToolDefinition, type ToolTransport
} from "@jarvis/tool-gateway";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "../../policy/src/index.ts";
import { DomainPauseRegistry, DomainPauseUnauthorizedError } from "../src/domain-pause.ts";
import { mapOpenLoopToCandidate } from "../src/open-loop-bridge.ts";
import {
  computeInformNotifyKey,
  SituationActClaimNotReleasableError,
  SituationActScopeMismatchError,
  SituationAutonomyUnauthorizedError,
  SituationEngine,
  SituationRecoveryUnauthorizedError
} from "../src/service.ts";
import { assertSituationSweepHealthy, runSituationSweep, SituationSweepFailedError, type SituationSweepResult } from "../src/sweep.ts";
import { SituationsTransport, situationsToolDefinitions } from "../src/transport.ts";
import { evaluateMigrationEvidence } from "./lib/migration-evidence.ts";
import type { Situation } from "../src/types.ts";

type Verdict = "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE" | "BLOCKED_EXTERNAL";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "FAIL",
  ua10_migration_057_applied: "FAIL",
  ua10_runtime_init: "FAIL",
  ua10_control_surface_credential: "FAIL",
  ua10_open_loop_bridge_live: "FAIL",
  ua10_sweep_healthy_path: "FAIL",
  ua10_delivery_evidence_first: "FAIL",
  ua10_notification_live_transport: "FAIL",
  ua10_idempotency_replay: "FAIL",
  ua10_owner_authority: "FAIL",
  ua10_identity_forgery_rejected: "FAIL",
  ua10_domain_pause: "FAIL",
  ua10_auto_act_exactly_once: "FAIL",
  ua10_tenant_space_isolation: "FAIL",
  ua10_fail_closed_scheduler: "FAIL",
  ua10_recovery_release_path: "FAIL",
  ua10_existing_global_pauses_preserved: "FAIL",
  ua10_cleanup: "FAIL"
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
log(`UA-10 P1 SITUATION ENGINE LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-ua10-sit-live-${runId}-a`;
const TENANT_B = `tenant-ua10-sit-live-${runId}-b`; // tenant-isolasjon: annen tenant, skal forbli urørt
const OWNER_PERSON = `person-ua10-sit-live-${runId}`;
const OTHER_PERSON = `person-ua10-sit-other-${runId}`; // samme tenant, IKKE eier
const ACTUATOR_TOOL = "ua10_acceptance_actuator";
const SCHEDULER_JOB_PREFIX = `situation-sweep-acceptance-${runId}`;
/**
 * Arkitekt-review runde 1 på PR #88 (5234145170): `situation_domain_pauses` er
 * GLOBAL (ikke tenant-scoped). Akseptansen pauser/opphever derfor ALDRI et ekte
 * domene (`spend`/`pipeline`/.../`*`) - en host-kjøring kunne ellers overskrive
 * og deretter FJERNE en reell eierpause (fail-open av en sikkerhetsbarriere).
 * Pause-/auto-ACT-beviset kjører i et KJØRE-UNIKT akseptansedomene; broen
 * open-loop -> `spend` bevises separat uten å røre global pausetilstand.
 */
const ACCEPTANCE_DOMAIN = `ua10_acceptance_${runId}`;

function ownerIdentityFor(tenantId: string, memorySpace: "business" | "personal" = "business"): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: memorySpace,
    session_id: `sess-ua10-sit-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

function assertSafeIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`ua10_cleanup_unsafe_identifier: "${name}"`);
  }
}

interface TenantFkBlocker {
  table: string;
  constraint: string;
  rows: number;
}

/** Schema-drevet (ikke hardkodet) sjekk FØR `DELETE FROM tenants` - samme mønster som ua4-growth-core-live.ts. */
async function findBlockingTenantDependencies(tenantId: string): Promise<TenantFkBlocker[]> {
  const { rows: fkRows } = await adminPool.query(`
    SELECT tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'tenants' AND kcu.column_name = 'tenant_id'
  `);
  const blockers: TenantFkBlocker[] = [];
  for (const row of fkRows as Array<{ table_name: string; constraint_name: string }>) {
    assertSafeIdentifier(row.table_name);
    const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM "${row.table_name}" WHERE tenant_id = $1`, [tenantId]);
    const n = (rows[0] as { n: number }).n;
    if (n > 0) blockers.push({ table: row.table_name, constraint: row.constraint_name, rows: n });
  }
  return blockers;
}

/**
 * FK-rekkefølge (barn FØR forelder): situasjoner (FK -> business_open_loops
 * via source_open_loop_id) FØR open loops FØR followups; eier-policyene
 * (`situation_autonomy_policies`, bevisst UTENFOR Q-20-erasure - se
 * modules/erasure/src/plan.ts) må ryddes EKSPLISITT her. `tool_executions`/
 * `erasure_*` er audit-spor uten DELETE-grant for jarvis_app - admin-pool.
 */
async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM situations WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM situation_autonomy_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM situation_notification_policies WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_followups WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM approvals WHERE tenant_id = $1", [tenantId]).catch(() => undefined);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);

  const blockers = await findBlockingTenantDependencies(tenantId);
  if (blockers.length > 0) {
    for (const b of blockers) log(`blocking_fk_table=${b.table} blocking_fk_name=${b.constraint} rows_for_test_tenant=${b.rows}`);
    throw new Error(`ua10_cleanup_blocked: ${blockers.length} uventet(e) FK-refererende tabell(er) har fortsatt rader for ${tenantId}`);
  }
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

type GlobalPauseRow = { domain: string; reason: string; paused_by: string | null; paused_at: string };
/** Full rad-snapshot av den GLOBALE pausetilstanden (admin-pool, kun SELECT). */
async function snapshotGlobalPauses(): Promise<GlobalPauseRow[]> {
  const rows = (await adminPool.query(
    "SELECT domain, reason, paused_by, paused_at::text AS paused_at FROM situation_domain_pauses ORDER BY domain"
  )).rows as GlobalPauseRow[];
  return rows;
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-ua10-sit-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM scheduler_state WHERE job_name LIKE 'situation-sweep-acceptance-%'").catch(() => undefined);
    // KUN akseptansedomener - aldri et ekte domene (global tabell).
    await adminPool.query("DELETE FROM situation_domain_pauses WHERE domain LIKE 'ua10_acceptance_%'").catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-ua10-sit-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

/**
 * Teller og delegerer - SAMME wrapper for ekte Telegram og lokal opptaker, så "nøyaktig ett kall" måles likt i begge moduser.
 *
 * HOST-FUNN run_id `2105bb7d` (D-160 I): den opprinnelige wrapperen kalte
 * `inner.invoke(action, parameters)` og DROPPET `credential` (+ invocation-
 * context). `TelegramTransport.invoke(action, parameters, credential)` bygger
 * URL-en av credential => `https://api.telegram.org/botundefined/sendMessage`
 * => HTTP 404 => kastet `telegram_error_404` => ToolGateway skrev `tool.failed`
 * i audit_events (ingen tool_executions-rad) => motoren bokførte `pending`
 * uten grunn => 7 markører FAIL i kaskade, mens `telegram_calls=0` fordi
 * wrapperen bare telte ETTER et vellykket inner-kall. Opptakeren ignorerte
 * argumentene, så container-kjøringene skjulte feilen. Nå: ALLE argumenter
 * videresendes uendret (`...args`), og forsøk telles VED INNGANG (attempts),
 * suksesser separat (calls).
 */
class CountingTransport implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  attempts = 0;
  constructor(private readonly inner: ToolTransport) {}
  async invoke(...args: Parameters<ToolTransport["invoke"]>): ReturnType<ToolTransport["invoke"]> {
    this.attempts += 1;
    const out = await this.inner.invoke(...args);
    this.calls.push({ action: args[0], parameters: args[1] });
    return out;
  }
}

/**
 * Diagnostisk gateway-observatør (D-160 I): registrerer KUN utfall/grunn/
 * idempotensnøkkel per kall - ALDRI parametre, ALDRI credentials. Samme
 * ToolGateway-pipeline (arver alt), null endring i policy/secret/transport.
 */
class ObservingGateway extends ToolGateway {
  observed: Array<{ tool_id: string; action: string; ok: boolean; reason: string | null; idempotency_key: string | null }> = [];
  override async execute(request: Parameters<ToolGateway["execute"]>[0]): ReturnType<ToolGateway["execute"]> {
    const result = await super.execute(request);
    this.observed.push({
      tool_id: request.tool_id, action: request.action, ok: result.ok,
      reason: result.ok ? null : result.reason, idempotency_key: request.idempotency_key ?? null
    });
    return result;
  }
}

/** Lokal opptaker når Telegram IKKE er konfigurert - returnerer en syntetisk external_id, sender ingenting. */
class RecorderTransport implements ToolTransport {
  private seq = 0;
  async invoke(): Promise<{ external_id?: string; data?: JsonValue }> {
    this.seq += 1;
    return { external_id: `recorder-${runId}-${this.seq}` };
  }
}

/** Akseptanse-lokal aktuator: `read_state` (preflight/readback) + `assign` (mutasjon) - INGEN ekstern effekt. */
class AcceptanceActuatorTransport implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  private done = false;
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });
    if (action === "read_state") return { data: { done: this.done } };
    if (action === "assign") {
      this.done = true;
      return { external_id: `acceptance-assign-${runId}`, data: { done: true } };
    }
    throw new Error(`unknown_action:${action}`);
  }
}

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

async function seedSyntheticLoop(
  tenantId: string,
  v: { loop_type: string; priority: string; confidence: number | null; reason: string; detection_key: string }
): Promise<string> {
  const id = `ol-ua10-${runId}-${randomUUID().slice(0, 6)}`;
  await adminPool.query(
    `INSERT INTO business_open_loops (open_loop_id, tenant_id, memory_space_id, loop_type, detection_key, reason, priority, confidence, status)
     VALUES ($1, $2, 'business', $3, $4, $5, $6, $7, 'open')`,
    [id, tenantId, v.loop_type, v.detection_key, v.reason, v.priority, v.confidence]
  );
  return id;
}

async function runSchedulerOnce(jobName: string, deliver: () => Promise<void>): Promise<{ claimed: boolean; completed_at: string | null }> {
  // Kjøre-unikt jobbnavn + time 0 => claimer umiddelbart; produksjonens "situation-sweep"-rad røres aldri.
  const scheduler = new DailyScheduler(pool, jobName, 0);
  const timer = scheduler.start(deliver, 20);
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await adminPool.query(`SELECT completed_at FROM scheduler_state WHERE job_name = $1`, [jobName]);
      if (rows[0]) {
        await new Promise((r) => setTimeout(r, 400));
        const { rows: again } = await adminPool.query(`SELECT completed_at FROM scheduler_state WHERE job_name = $1`, [jobName]);
        const completed = (again[0] as { completed_at: string | Date | null } | undefined)?.completed_at ?? null;
        return { claimed: true, completed_at: completed ? new Date(completed).toISOString() : null };
      }
      if (Date.now() > deadline) return { claimed: false, completed_at: null };
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    clearInterval(timer);
  }
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    diagnostics["runtime_current_user"] = status.role;
    diagnostics["runtime_role_superuser"] = String(status.superuser);
    diagnostics["runtime_role_bypassrls"] = String(status.bypassrls);
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    log("\nUA-10 P1 KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen skriving forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  await section("MIGRASJON 057 ANVENDT ETTER 055/056 (schema_migrations + skjema)", async () => {
    // HOST-FUNN run_id `2105bb7d` (D-160 I): den gamle påstanden "ingen prefiks i HELE
    // schema_migrations har count > 1" var for bred - migratoren nøkler på eksakt
    // filnavn og ignorerer historiske rader (f.eks. `014_pgvector_embeddings.sql`,
    // `023_zendesk_support.sql`). Vurderingen er nå den rene, enhetstestede
    // `evaluateMigrationEvidence()`: 055/056/057 finnes nøyaktig én gang, i rekkefølge,
    // ingen fremmed rad med prefiks 055-057, og repoets mappe har unike prefikser.
    // Historiske duplikater/orphans RAPPORTERES eksplisitt (observabilitet), skjules aldri.
    const { rows } = await adminPool.query(`SELECT name, applied_at FROM schema_migrations ORDER BY name`);
    const repoFiles = readdirSync(fileURLToPath(new URL("../../core/src/db/migrations/", import.meta.url))).filter((f) => /^\d{3}_.*\.sql$/.test(f));
    const evidence = evaluateMigrationEvidence(rows as Array<{ name: string; applied_at: Date }>, repoFiles);
    const names = evidence.required_present;
    const ordered = evidence.applied_in_order;
    const { rows: cols } = await adminPool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'situations' AND column_name IN ('inform_message','inform_delivered_at')`
    );
    const { rows: policyTable } = await adminPool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'situation_autonomy_policies'`
    );
    diagnostics["migrations_055_056_057"] = names.join(",");
    diagnostics["migration_required_prefix_collisions"] = evidence.required_prefix_collisions.join(",") || "(ingen)";
    diagnostics["migration_repo_prefix_collisions"] = evidence.repo_prefix_collisions.join(";") || "(ingen)";
    diagnostics["migration_historical_prefix_duplicates"] = evidence.historical_prefix_duplicates.join(";") || "(ingen)";
    diagnostics["migration_orphan_rows"] = evidence.orphan_rows.join(",") || "(ingen)";
    results.ua10_migration_057_applied = evidence.ok && cols.length === 2 && policyTable.length === 1 ? "PASS" : "FAIL";
    log(`migrations=${names.join(",")} missing=${evidence.required_missing.join(",") || "(ingen)"} applied_in_order=${ordered} required_prefix_collisions=${diagnostics["migration_required_prefix_collisions"]} repo_prefix_collisions=${diagnostics["migration_repo_prefix_collisions"]} inform_columns=${cols.length}/2 autonomy_table=${policyTable.length === 1} -> ua10_migration_057_applied: ${results.ua10_migration_057_applied}`);
    log(`  historical_prefix_duplicates(LEGITIMT, migrator nøkler på filnavn)=${diagnostics["migration_historical_prefix_duplicates"]} orphan_rows=${diagnostics["migration_orphan_rows"]}`);
  });

  await selfHeal();
  // Snapshot av den GLOBALE pausetilstanden FØR noe skrives - sammenlignes etter cleanup.
  const globalPausesBefore = await snapshotGlobalPauses();
  diagnostics["global_pauses_before"] = globalPausesBefore.map((r) => r.domain).join(",") || "(ingen)";
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `UA-10 Sit Live A ${runId}`, TENANT_B, `UA-10 Sit Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2), ($3,$4)", [OWNER_PERSON, "UA-10 Live Owner", OTHER_PERSON, "UA-10 Live Other"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3), ($4,$2)", [OWNER_PERSON, TENANT_A, TENANT_B, OTHER_PERSON]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'personal'), ($5,$6,'business')",
    [`ms-ua10-a-business-${runId}`, TENANT_A, `ms-ua10-a-personal-${runId}`, TENANT_A, `ms-ua10-b-business-${runId}`, TENANT_B]
  );

  // SAMME komposisjon som apps/api/src/main.ts: durable pause med fail-closed
  // restore() FØR motoren, sovereign-eier-autoritet, PolicyGateway sovereign
  // owner, ToolGateway med PRODUKSJONENS secret-kjede (Env -> BusinessInternal).
  let domainPauses!: DomainPauseRegistry;
  let engine!: SituationEngine;
  let policy!: PolicyGateway;
  await section("RUNTIME INIT (DomainPauseRegistry.restore + SituationEngine, samme komposisjon som main.ts)", async () => {
    domainPauses = new DomainPauseRegistry(pool, { owner_person_id: OWNER_PERSON });
    await domainPauses.restore();
    engine = new SituationEngine(pool, domainPauses, { owner_person_id: OWNER_PERSON });
    policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(),
      nonces: new PgApprovalStore(pool),
      killSwitch: new KillSwitch(),
      authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A, TENANT_B] }
    });
    diagnostics["domain_pauses_after_restore"] = domainPauses.pausedDomains().join(",") || "(ingen)";
    results.ua10_runtime_init = "PASS";
    log(`restore_ok=true paused_domains=${diagnostics["domain_pauses_after_restore"]} -> ua10_runtime_init: PASS`);
  });
  if (results.ua10_runtime_init !== "PASS") return finish();

  const telegramConfigured = Boolean(process.env["JARVIS_TELEGRAM_TOKEN"] && process.env["JARVIS_TELEGRAM_CHAT_ID"]);
  if (!telegramConfigured) {
    // Uten ekte Telegram: en lokal opptaker under den KANONISKE definisjonen.
    // EnvSecretProvider trenger en verdi for `JARVIS_TELEGRAM_TOKEN` for at
    // pipelinen skal nå transporten - en eksplisitt, prosess-lokal sentinel
    // (ALDRI persistert, ALDRI en ekte credential). Logges åpent.
    process.env["JARVIS_TELEGRAM_TOKEN"] = `acceptance-recorder-${runId}`;
  }
  diagnostics["telegram_mode"] = telegramConfigured ? "LIVE_TRANSPORT" : "RECORDER_NO_CREDENTIAL";
  const telegram = new CountingTransport(telegramConfigured ? new TelegramTransport() : new RecorderTransport());
  const actuator = new AcceptanceActuatorTransport();
  const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
  const gateway = new ObservingGateway(pool, policy, secrets);
  // Den KANONISKE `telegram.notify`-definisjonen (samme som main.ts registrerer) - ingen parallell kopi.
  const telegramNotify = firstWaveTools({ telegram }).filter((t) => t.tool_id === "telegram" && t.action === "notify");
  for (const tool of telegramNotify) gateway.register(tool);
  const telegramDef = telegramNotify[0]!;
  /** Redigerer bort en evt. ekte token-verdi fra en diagnostisk streng (belte og bukseseler - grunnene inneholder aldri credential). */
  const redact = (text: string): string => {
    const token = process.env["JARVIS_TELEGRAM_TOKEN"];
    return token && token.length > 0 ? text.split(token).join("[REDACTED]") : text;
  };
  /**
   * D-160 I: diagnostikk for `telegram.notify`-kjeden - FØRSTE avvikspunkt uten secrets:
   * schema-validering, credential-oppløsning (kun boolean/ref-navn), gateway-utfall/grunn,
   * transport-inngang (forsøk) vs suksess, audit_events-grunner, tool_executions-status.
   */
  async function telegramDiagnostics(label: string, message: string | null): Promise<void> {
    const schema = message === null ? "n/a" : String(telegramDef.input_schema.safeParse({ message }).success);
    const credentialResolved = (await secrets.get(telegramDef.credential_ref)) !== null;
    const observed = gateway.observed.filter((o) => o.tool_id === "telegram" && o.action === "notify");
    const last = observed.at(-1);
    const { rows: audit } = await adminPool.query(
      `SELECT type, decision, reason, count(*)::int AS n FROM audit_events WHERE tenant_id = ANY($1) AND tool_id = 'telegram' GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
      [[TENANT_A, TENANT_B]]
    );
    const { rows: execs } = await adminPool.query(
      `SELECT status, count(*)::int AS n FROM tool_executions WHERE tenant_id = ANY($1) AND tool_id = 'telegram' GROUP BY 1 ORDER BY 1`,
      [[TENANT_A, TENANT_B]]
    );
    log(
      `diag[${label}] schema_valid=${schema} message_chars=${message?.length ?? 0} credential_ref=${telegramDef.credential_ref} credential_resolved=${credentialResolved} ` +
        `chat_id_configured=${Boolean(process.env["JARVIS_TELEGRAM_CHAT_ID"])} gateway_calls=${observed.length} last_ok=${last?.ok ?? "-"} last_reason=${redact(last?.reason ?? "-")} ` +
        `last_idempotency_key=${last?.idempotency_key ?? "-"} transport_attempts=${telegram.attempts} transport_successes=${telegram.calls.length} ` +
        `audit=${(audit as Array<{ type: string; decision: string | null; reason: string | null; n: number }>).map((r) => `${r.type}/${r.decision ?? "-"}/${redact(r.reason ?? "-")}x${r.n}`).join(";") || "(ingen)"} ` +
        `tool_executions=${(execs as Array<{ status: string; n: number }>).map((r) => `${r.status}x${r.n}`).join(";") || "(ingen)"}`
    );
  }
  const actuatorTool: ToolDefinition = {
    tool_id: ACTUATOR_TOOL, action: "assign", description: "UA-10 akseptanse-lokal aktuator (ingen ekstern effekt)",
    input_schema: record({ open_loop_id: z.string(), assignee: z.string() }),
    capability_class: "D", scopes: [], reversible: true, rollback_procedure: "unassign (akseptanse-lokal)",
    idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 100,
    credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, output_trust: "internal", transport: actuator,
    preflight_action: "read_state",
    postcondition_predicate: (after) => (after as { done: boolean } | null)?.done === true
  };
  gateway.register(actuatorTool);
  const situationsTools = situationsToolDefinitions(new SituationsTransport(engine, domainPauses));
  for (const tool of situationsTools) gateway.register(tool);

  const business = new BusinessService(pool);
  const openLoops = new OpenLoopService(pool);
  const ownerA = ownerIdentityFor(TENANT_A);
  const ownerB = ownerIdentityFor(TENANT_B);
  const otherA: IdentityContext = { ...ownerA, person_id: OTHER_PERSON, session_id: `sess-ua10-other-${runId}` };
  const sweep = (tenantId = TENANT_A, identity = ownerA): Promise<SituationSweepResult> =>
    runSituationSweep(tenantId, "business", { openLoops, engine, gateway, identity });
  const situationsOf = (tenantId: string): Promise<Situation[]> => engine.getQueue(tenantId, "business", { statusOpenOnly: false });

  await section("KONTROLLFLATENS CREDENTIAL LØSES AV PRODUKSJONENS SECRET-KJEDE (ikke en test-provider)", async () => {
    // Ærlig produksjonssjekk: samme FallbackSecretProvider(Env, BusinessInternal)
    // som main.ts - hvis `situations.*` sin credential_ref ikke løses her, er
    // hele eier-kontrollflaten `credential_unavailable` i drift.
    const res = await gateway.execute({ identity: ownerA, tool_id: "situations", action: "get_pause_state", parameters: {} });
    const refs = [...new Set(situationsTools.map((t) => t.credential_ref))];
    diagnostics["situations_credential_ref"] = refs.join(",");
    results.ua10_control_surface_credential = res.ok ? "PASS" : "FAIL";
    log(`get_pause_state_ok=${res.ok}${res.ok ? "" : ` reason=${(res as { reason: string }).reason}`} credential_ref=${refs.join(",")} -> ua10_control_surface_credential: ${results.ua10_control_surface_credential}`);
  });

  let followupLoopId = "";
  await section("OPEN-LOOP -> SITUASJON LIVE (ekte followup -> ekte OpenLoopService-deteksjon -> bro)", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", {
      title: `UA-10 akseptanse-oppfølging ${runId}`, due_at: "2020-01-01T00:00:00Z", next_action: "Ring kunden (syntetisk)"
    });
    const detected = await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.followup_id === followup.followup_id);
    followupLoopId = loop?.open_loop_id ?? "";
    const r = await sweep();
    const rows = await situationsOf(TENANT_A);
    const sit = rows.find((s) => s.source_open_loop_id === followupLoopId);
    const ok = Boolean(loop) && r.ingested >= 1 && r.errors.length === 0 && Boolean(sit) && sit!.domain === "pipeline" && sit!.detection_key.startsWith("open_loop:") && sit!.stage === "inform";
    results.ua10_open_loop_bridge_live = ok ? "PASS" : "FAIL";
    log(`detected=${detected.detected} open_loop_id=${followupLoopId || "MANGLER"} ingested=${r.ingested} situation_stage=${sit?.stage ?? "MANGLER"} domain=${sit?.domain ?? "-"} detection_key=${sit?.detection_key ?? "-"} -> ua10_open_loop_bridge_live: ${results.ua10_open_loop_bridge_live}`);
    diagnostics["first_sweep"] = JSON.stringify({ ingested: r.ingested, identity_conflicts: r.identity_conflicts, resolved_from_source: r.resolved_from_source, delivery: r.delivery, auto_act: r.auto_act, errors: r.errors });
    log(`first_sweep=${diagnostics["first_sweep"]}`);
    await telegramDiagnostics("inform-after-first-sweep", sit?.inform_message ?? null);
  });

  await section("SVEIP HEALTHY + LEVERANSE EVIDENS-FØRST (assertSituationSweepHealthy kaster ikke; bevis under nøkkelen)", async () => {
    // Første sveip (over) leverte INFORM-varselet - verifiser bokføring + bevis.
    const sit = (await situationsOf(TENANT_A)).find((s) => s.source_open_loop_id === followupLoopId)!;
    const delivered = sit.inform_delivered_at !== null && sit.last_notified_at !== null &&
      new Date(sit.inform_delivered_at).toISOString() === new Date(sit.last_notified_at).toISOString();
    const key = computeInformNotifyKey(sit.situation_id, new Date(sit.last_notified_at!).toISOString(), sit.inform_message!);
    const { rows } = await adminPool.query(`SELECT tool_id, action, status, external_id FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`, [TENANT_A, key]);
    const evidence = rows[0] as { tool_id: string; action: string; status: string; external_id: string | null } | undefined;
    const evidenceOk = evidence?.tool_id === "telegram" && evidence.action === "notify" && evidence.status === "succeeded";
    let healthy = false;
    try {
      const again = await sweep();
      assertSituationSweepHealthy({ [TENANT_A]: again });
      healthy = again.errors.length === 0 && again.delivery.pending === 0 && again.delivery.evidence_mismatch === 0;
    } catch (err) {
      healthy = false;
      log(`healthy_sweep_threw=${(err as Error).message.slice(0, 120)}`);
    }
    results.ua10_sweep_healthy_path = healthy ? "PASS" : "FAIL";
    results.ua10_delivery_evidence_first = delivered && evidenceOk && telegram.calls.length === 1 ? "PASS" : "FAIL";
    results.ua10_notification_live_transport = telegramConfigured
      ? (evidenceOk && Boolean(evidence?.external_id) ? "PASS" : "FAIL")
      : "BLOCKED_EXTERNAL";
    diagnostics["inform_evidence_external_id_present"] = String(Boolean(evidence?.external_id));
    log(`inform_delivered=${delivered} evidence=${evidence ? `${evidence.tool_id}.${evidence.action}/${evidence.status}` : "MANGLER"} telegram_calls=${telegram.calls.length} telegram_attempts=${telegram.attempts} healthy=${healthy} telegram_mode=${diagnostics["telegram_mode"]} -> ua10_sweep_healthy_path: ${results.ua10_sweep_healthy_path} ua10_delivery_evidence_first: ${results.ua10_delivery_evidence_first} ua10_notification_live_transport: ${results.ua10_notification_live_transport}`);
  });

  await section("IDEMPOTENS/REPLAY (re-sveip => null nye varsler; krasj etter bekreftet sending => rekonsiliert fra bevis uten nytt kall)", async () => {
    const callsBefore = telegram.calls.length;
    const r1 = await sweep();
    await adminPool.query(`UPDATE situations SET inform_delivered_at = NULL WHERE tenant_id = $1 AND source_open_loop_id = $2`, [TENANT_A, followupLoopId]);
    const r2 = await sweep();
    const sit = (await situationsOf(TENANT_A)).find((s) => s.source_open_loop_id === followupLoopId)!;
    const ok = r1.delivery.delivered === 0 && r2.delivery.reconciled_from_evidence === 1 && r2.delivery.delivered === 0 &&
      telegram.calls.length === callsBefore && sit.inform_delivered_at !== null;
    results.ua10_idempotency_replay = ok ? "PASS" : "FAIL";
    log(`resweep_delivered=${r1.delivery.delivered} after_crash_reconciled=${r2.delivery.reconciled_from_evidence} new_transport_calls=${telegram.calls.length - callsBefore} -> ua10_idempotency_replay: ${results.ua10_idempotency_replay}`);
  });

  await section("EIER-AUTORITET (policy uten eier feiler lukket - direkte OG via gateway)", async () => {
    const input = { domain: ACCEPTANCE_DOMAIN, tool_id: ACTUATOR_TOOL, action: "assign", parameters: { open_loop_id: "{{source_open_loop_id}}", assignee: OWNER_PERSON } };
    let directDenied = false;
    try { await engine.setAutonomyPolicy(TENANT_A, "business", input, OTHER_PERSON); } catch (err) { directDenied = err instanceof SituationAutonomyUnauthorizedError; }
    let noAuthorityDenied = false;
    try { await engine.setAutonomyPolicy(TENANT_A, "business", input, undefined); } catch (err) { noAuthorityDenied = err instanceof SituationAutonomyUnauthorizedError; }
    const viaGatewayOther = await gateway.execute({
      identity: otherA, tool_id: "situations", action: "set_autonomy_policy", parameters: input as unknown as Record<string, JsonValue>, idempotency_key: `ua10-policy-other-${runId}`
    });
    const policiesAfterDenials = await engine.listAutonomyPolicies(TENANT_A, "business");
    const viaGatewayOwner = await gateway.execute({
      identity: ownerA, tool_id: "situations", action: "set_autonomy_policy", parameters: input as unknown as Record<string, JsonValue>, idempotency_key: `ua10-policy-owner-${runId}`
    });
    const policies = await engine.listAutonomyPolicies(TENANT_A, "business");
    const ok = directDenied && noAuthorityDenied && !viaGatewayOther.ok && policiesAfterDenials.length === 0 && viaGatewayOwner.ok && policies.length === 1 && policies[0]!.actor_person_id === OWNER_PERSON;
    results.ua10_owner_authority = ok ? "PASS" : "FAIL";
    log(`direct_other_denied=${directDenied} no_authority_denied=${noAuthorityDenied} gateway_other_ok=${viaGatewayOther.ok} gateway_owner_ok=${viaGatewayOwner.ok} policies=${policies.length} actor=${policies[0]?.actor_person_id ?? "-"} -> ua10_owner_authority: ${results.ua10_owner_authority}`);
  });

  await section("IDENTITETSFORFALSKNING AVVIST (identitet i parametre => invalid_parameters; direkte transport bruker kun context)", async () => {
    const forged = await gateway.execute({
      identity: otherA, tool_id: "situations", action: "pause_domain",
      parameters: { domain: ACCEPTANCE_DOMAIN, reason: "forfalsket", actor_person_id: OWNER_PERSON }, idempotency_key: `ua10-forge-${runId}`
    });
    const transport = new SituationsTransport(engine, domainPauses);
    let directDenied = false;
    try {
      await transport.invoke("pause_domain", { domain: ACCEPTANCE_DOMAIN, reason: "forfalsket", actor_person_id: OWNER_PERSON }, "cred", { identity: otherA });
    } catch (err) { directDenied = err instanceof DomainPauseUnauthorizedError; }
    let missingContextDenied = false;
    try { await transport.invoke("get_queue", {}, "cred"); } catch (err) { missingContextDenied = /situations_missing_invocation_context/.test((err as Error).message); }
    const ok = !forged.ok && /invalid_parameters/.test((forged as { reason?: string }).reason ?? "") && directDenied && missingContextDenied && !domainPauses.isPaused(ACCEPTANCE_DOMAIN);
    results.ua10_identity_forgery_rejected = ok ? "PASS" : "FAIL";
    log(`forged_via_gateway_ok=${forged.ok} reason=${(forged as { reason?: string }).reason ?? "-"} direct_other_denied=${directDenied} missing_context_denied=${missingContextDenied} acceptance_domain_paused=${domainPauses.isPaused(ACCEPTANCE_DOMAIN)} -> ua10_identity_forgery_rejected: ${results.ua10_identity_forgery_rejected}`);
  });

  await section("DOMENE-PAUSE STOPPER AUTO-ACT; OPPHEVING GJENOPPRETTER; NØYAKTIG ÉN ACT + ÉN ACT-VARSLING VED REPLAY (KJØRE-UNIKT akseptansedomene - aldri et ekte domene)", async () => {
    // Kildeloop (lav prioritet => broen lager en `remember`-situasjon i `spend`
    // som ALDRI varsles/ACT-es - beviser open-loop -> spend-broen UTEN global pause).
    const sourceLoopId = await seedSyntheticLoop(TENANT_A, {
      loop_type: "finance_spend_unexpected", priority: "low", confidence: 0.2,
      reason: `Uventet utgift (syntetisk kilde, ${runId})`, detection_key: `ua10:spend-source:${runId}`
    });
    await sweep();
    const bridgedSpend = (await situationsOf(TENANT_A)).find((s) => s.source_open_loop_id === sourceLoopId);
    // Kontrollert ACT-kandidat i `suggest` DIREKTE i akseptansedomenet (høy prioritet, konfidens >= 0,75), med samme kilde for plassholderen.
    await engine.evaluateCandidate(TENANT_A, "business", {
      domain: ACCEPTANCE_DOMAIN, detection_key: `ua10:acceptance:${runId}`, priority: "high", confidence: 0.95,
      reason: `Akseptanse-kandidat (syntetisk, ${runId})`, source_open_loop_id: sourceLoopId
    });
    const paused = await gateway.execute({
      identity: ownerA, tool_id: "situations", action: "pause_domain", parameters: { domain: ACCEPTANCE_DOMAIN, reason: "eier pauset (akseptanse)" }, idempotency_key: `ua10-pause-${runId}`
    });
    const rPaused = await sweep(); // leverer kandidatens INFORM, hopper over ACT (pauset)
    const actuatorCallsWhilePaused = actuator.calls.length;
    const sitWhilePaused = (await situationsOf(TENANT_A)).find((s) => s.domain === ACCEPTANCE_DOMAIN);
    // Pausen overlever en "omstart": et NYTT register ser den etter restore().
    const fresh = new DomainPauseRegistry(pool, { owner_person_id: OWNER_PERSON });
    await fresh.restore();
    const durable = fresh.isPaused(ACCEPTANCE_DOMAIN);
    // Ekte domener skal ha NØYAKTIG samme pausetilstand som FØR kjøringen (en pre-eksisterende
    // produksjonspause på f.eks. `spend` skal fortsatt stå - aldri kreves upauset, aldri fjernes).
    const realDomainsUntouched = ["spend", "pipeline"].every(
      (d) => fresh.isPaused(d) === globalPausesBefore.some((r) => r.domain === d)
    );
    const unpaused = await gateway.execute({
      identity: ownerA, tool_id: "situations", action: "unpause_domain", parameters: { domain: ACCEPTANCE_DOMAIN }, idempotency_key: `ua10-unpause-${runId}`
    });
    const telegramBefore = telegram.calls.length;
    const rResumed = await sweep();
    const sit = (await situationsOf(TENANT_A)).find((s) => s.domain === ACCEPTANCE_DOMAIN);
    const actSequence = actuator.calls.map((c) => c.action).join(",");
    const rendered = actuator.calls.find((c) => c.action === "assign")?.parameters;
    const rReplay = await sweep();
    const pauseOk = paused.ok && rPaused.auto_act.skipped === 1 && rPaused.auto_act.attempted === 0 && actuatorCallsWhilePaused === 0 &&
      sitWhilePaused?.stage === "suggest" && durable && realDomainsUntouched && unpaused.ok && !domainPauses.isPaused(ACCEPTANCE_DOMAIN);
    results.ua10_domain_pause = pauseOk ? "PASS" : "FAIL";
    const actOk = bridgedSpend?.domain === "spend" && bridgedSpend.stage === "remember" &&
      rResumed.auto_act.attempted === 1 && rResumed.auto_act.succeeded === 1 && actSequence === "read_state,assign,read_state" &&
      rendered?.["open_loop_id"] === sourceLoopId && sit?.stage === "act_notify" && sit.act_result === "succeeded" &&
      telegram.calls.length === telegramBefore + 1 && rReplay.auto_act.attempted === 0 && actuator.calls.length === 3 && telegram.calls.length === telegramBefore + 1;
    results.ua10_auto_act_exactly_once = actOk ? "PASS" : "FAIL";
    log(`acceptance_domain=${ACCEPTANCE_DOMAIN} pause_ok=${paused.ok} paused_sweep=${JSON.stringify(rPaused.auto_act)} stage_while_paused=${sitWhilePaused?.stage ?? "-"} durable_after_restore=${durable} real_domains_untouched=${realDomainsUntouched} unpause_ok=${unpaused.ok} -> ua10_domain_pause: ${results.ua10_domain_pause}`);
    log(`bridged_spend_domain=${bridgedSpend?.domain ?? "-"} bridged_spend_stage=${bridgedSpend?.stage ?? "-"} resumed_sweep=${JSON.stringify(rResumed.auto_act)} actuator_sequence=${actSequence} rendered_open_loop_id_match=${rendered?.["open_loop_id"] === sourceLoopId} stage=${sit?.stage ?? "-"} act_result=${sit?.act_result ?? "-"} act_notify_calls=${telegram.calls.length - telegramBefore} replay=${JSON.stringify(rReplay.auto_act)} -> ua10_auto_act_exactly_once: ${results.ua10_auto_act_exactly_once}`);
    await telegramDiagnostics("act-notify-after-resumed-sweep", sit?.act_notify_message ?? null);
  });

  await section("TENANT/SPACE-ISOLASJON (feil tenant/space feiler lukket eller ser ingenting)", async () => {
    const queueB = await gateway.execute({ identity: ownerB, tool_id: "situations", action: "get_queue", parameters: {} });
    const policiesB = await engine.listAutonomyPolicies(TENANT_B, "business");
    await seedSyntheticLoop(TENANT_B, { loop_type: "finance_spend_unexpected", priority: "high", confidence: 0.95, reason: "B (syntetisk)", detection_key: `ua10:spend-b:${runId}` });
    const actuatorBefore = actuator.calls.length;
    const rB = await sweep(TENANT_B, ownerB);
    const sitsB = await situationsOf(TENANT_B);
    const personalQueue = await engine.getQueue(TENANT_A, "personal", { statusOpenOnly: false });
    let wrongScopeDenied = false;
    try {
      await engine.releaseStuckActClaim(TENANT_A, "business", sitsB[0]?.situation_id ?? "sit-none", ownerB);
    } catch (err) { wrongScopeDenied = err instanceof SituationActScopeMismatchError; }
    const ok = queueB.ok && Array.isArray((queueB as { data?: unknown }).data) && ((queueB as { data?: unknown[] }).data!.length === 0) &&
      policiesB.length === 0 && rB.auto_act.attempted === 0 && actuator.calls.length === actuatorBefore &&
      sitsB.length === 1 && sitsB[0]!.tenant_id === TENANT_B && personalQueue.length === 0 && wrongScopeDenied;
    results.ua10_tenant_space_isolation = ok ? "PASS" : "FAIL";
    log(`queue_b_before=${(queueB as { data?: unknown[] }).data?.length ?? "ERR"} policies_b=${policiesB.length} sweep_b_auto_act=${JSON.stringify(rB.auto_act)} sits_b=${sitsB.length} personal_space_queue=${personalQueue.length} wrong_scope_denied=${wrongScopeDenied} -> ua10_tenant_space_isolation: ${results.ua10_tenant_space_isolation}`);
  });

  await section("FAIL-CLOSED SCHEDULER (EKTE DailyScheduler: sunn => completed_at satt; evidensmismatch => completed_at NULL)", async () => {
    // 1) Sunn kjøring gjennom EKTE DailyScheduler-grensen (samme .then(assertSituationSweepHealthy) som main.ts).
    const healthy = await runSchedulerOnce(`${SCHEDULER_JOB_PREFIX}-healthy`, async () => {
      assertSituationSweepHealthy({ [TENANT_A]: await sweep(), [TENANT_B]: await sweep(TENANT_B, ownerB) });
    });
    // 2) Evidensmismatch: fremmed bevis (email.send) under INFORM-nøkkelen til en NY situasjon.
    const mismatchLoopId = await seedSyntheticLoop(TENANT_A, {
      loop_type: "support_ticket_overdue", priority: "normal", confidence: null, reason: `Mismatch-kandidat (syntetisk, ${runId})`, detection_key: `ua10:mismatch:${runId}`
    });
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const { situation } = await engine.evaluateCandidate(TENANT_A, "business", mapOpenLoopToCandidate(loops.find((l) => l.open_loop_id === mismatchLoopId)!));
    const key = computeInformNotifyKey(situation.situation_id, new Date(situation.last_notified_at!).toISOString(), situation.inform_message!);
    await adminPool.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status) VALUES ($1, $2, 'email', 'send', 'succeeded')`,
      [TENANT_A, key]
    );
    const telegramBefore = telegram.calls.length;
    let thrown: unknown;
    let mismatchResult: SituationSweepResult | undefined;
    const failed = await runSchedulerOnce(`${SCHEDULER_JOB_PREFIX}-mismatch`, async () => {
      mismatchResult = await sweep();
      try {
        assertSituationSweepHealthy({ [TENANT_A]: mismatchResult });
      } catch (err) {
        thrown = err;
        throw err;
      }
    });
    const ok = healthy.claimed && healthy.completed_at !== null && failed.claimed && failed.completed_at === null &&
      mismatchResult?.delivery.evidence_mismatch === 1 && thrown instanceof SituationSweepFailedError && telegram.calls.length === telegramBefore;
    results.ua10_fail_closed_scheduler = ok ? "PASS" : "FAIL";
    diagnostics["scheduler_healthy_completed_at"] = healthy.completed_at ?? "NULL";
    diagnostics["scheduler_mismatch_completed_at"] = failed.completed_at ?? "NULL";
    log(`healthy_claimed=${healthy.claimed} healthy_completed_at=${healthy.completed_at ?? "NULL"} mismatch_claimed=${failed.claimed} mismatch_completed_at=${failed.completed_at ?? "NULL"} evidence_mismatch=${mismatchResult?.delivery.evidence_mismatch ?? "-"} threw=${thrown instanceof SituationSweepFailedError} calls_during_mismatch=${telegram.calls.length - telegramBefore} -> ua10_fail_closed_scheduler: ${results.ua10_fail_closed_scheduler}`);
    // Fjern det fremmede beviset igjen (kun vår egen syntetiske rad) slik at opprydding/gjenoppretting under ser en ren tilstand.
    await adminPool.query(`DELETE FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`, [TENANT_A, key]);
  });

  await section("GJENOPPRETTING (release_stuck_act_claim: ikke-eier avvist, bevis => ikke frigjørbar, eier frigjør)", async () => {
    const sit = (await situationsOf(TENANT_A)).find((s) => s.source_open_loop_id === followupLoopId)!;
    const claimKey = `situation:${sit.situation_id}:act:acceptance-${runId}`;
    // Simulert fastlåst claim (hele claim-tuppelet, som DB-CHECK-en krever) - rå admin-skriving på VÅR syntetiske rad.
    await adminPool.query(
      `UPDATE situations SET act_claimed_at = now(), act_idempotency_key = $3, act_operation_fingerprint = 'acceptance', act_notify_message = 'acceptance' WHERE tenant_id = $1 AND situation_id = $2`,
      [TENANT_A, sit.situation_id, claimKey]
    );
    let otherDenied = false;
    try { await engine.releaseStuckActClaim(TENANT_A, "business", sit.situation_id, otherA); } catch (err) { otherDenied = err instanceof SituationRecoveryUnauthorizedError; }
    // Med bevis under nøkkelen er claimen IKKE fastlåst - frigjøring nektes (fail-closed).
    await adminPool.query(`INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status) VALUES ($1, $2, $3, 'assign', 'succeeded')`, [TENANT_A, claimKey, ACTUATOR_TOOL]);
    let notReleasable = false;
    try { await engine.releaseStuckActClaim(TENANT_A, "business", sit.situation_id, ownerA); } catch (err) { notReleasable = err instanceof SituationActClaimNotReleasableError; }
    await adminPool.query(`DELETE FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`, [TENANT_A, claimKey]);
    // Uten bevis: eieren frigjør gjennom kontrollflaten (gateway, identitet fra context).
    const released = await gateway.execute({
      identity: ownerA, tool_id: "situations", action: "release_stuck_act_claim", parameters: { situation_id: sit.situation_id }, idempotency_key: `ua10-release-${runId}`
    });
    const { rows } = await adminPool.query(`SELECT act_claimed_at, act_idempotency_key FROM situations WHERE tenant_id = $1 AND situation_id = $2`, [TENANT_A, sit.situation_id]);
    const after = rows[0] as { act_claimed_at: string | null; act_idempotency_key: string | null };
    const ok = otherDenied && notReleasable && released.ok && after.act_claimed_at === null && after.act_idempotency_key === null;
    results.ua10_recovery_release_path = ok ? "PASS" : "FAIL";
    log(`other_denied=${otherDenied} with_evidence_not_releasable=${notReleasable} owner_release_ok=${released.ok} claim_cleared=${after.act_claimed_at === null} -> ua10_recovery_release_path: ${results.ua10_recovery_release_path}`);
  });

  await section("CLEANUP", async () => {
    let cleanupOk = true;
    // Sikkerhetsnett: aldri la akseptanse-pausen stå igjen - og KUN den (aldri et ekte domene).
    if (domainPauses.isPaused(ACCEPTANCE_DOMAIN)) await domainPauses.unpauseDurable(ACCEPTANCE_DOMAIN, OWNER_PERSON).catch(() => { cleanupOk = false; });
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM scheduler_state WHERE job_name LIKE $1", [`${SCHEDULER_JOB_PREFIX}-%`]).catch((err: unknown) => {
      cleanupOk = false; log(`cleanup scheduler_state feilet: ${(err as Error).message}`);
    });
    await adminPool.query("DELETE FROM people WHERE person_id = ANY($1)", [[OWNER_PERSON, OTHER_PERSON]]).catch((err: unknown) => {
      cleanupOk = false; log(`cleanup people feilet: ${(err as Error).message}`);
    });
    const leftover = async (sql: string, params: unknown[]): Promise<number> => ((await adminPool.query(sql, params)).rows[0] as { n: number }).n;
    const leftoverSituations = await leftover("SELECT count(*)::int AS n FROM situations WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverPolicies = await leftover("SELECT count(*)::int AS n FROM situation_autonomy_policies WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverTenants = await leftover("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverJobs = await leftover("SELECT count(*)::int AS n FROM scheduler_state WHERE job_name LIKE $1", [`${SCHEDULER_JOB_PREFIX}-%`]);
    const productionJobUntouched = await leftover("SELECT count(*)::int AS n FROM scheduler_state WHERE job_name = 'situation-sweep' AND claimed_by LIKE '%acceptance%'", []);
    const leftoverAcceptancePauses = await leftover("SELECT count(*)::int AS n FROM situation_domain_pauses WHERE domain LIKE 'ua10_acceptance_%'", []);
    const globalPausesAfter = await snapshotGlobalPauses();
    diagnostics["global_pauses_after"] = globalPausesAfter.map((r) => r.domain).join(",") || "(ingen)";
    // Byte-/semantisk identitet: HELE raden (domain, reason, paused_by, paused_at) for hver
    // global pause som fantes FØR kjøringen skal være uendret ETTER - ikke bare domenenavnet.
    results.ua10_existing_global_pauses_preserved = JSON.stringify(globalPausesAfter) === JSON.stringify(globalPausesBefore) ? "PASS" : "FAIL";
    results.ua10_cleanup = cleanupOk && leftoverSituations === 0 && leftoverPolicies === 0 && leftoverTenants === 0 && leftoverJobs === 0 && productionJobUntouched === 0 && leftoverAcceptancePauses === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_situations=${leftoverSituations} leftover_policies=${leftoverPolicies} leftover_tenants=${leftoverTenants} leftover_scheduler_jobs=${leftoverJobs} production_situation_sweep_untouched=${productionJobUntouched === 0} leftover_acceptance_pauses=${leftoverAcceptancePauses} global_pauses_before=${diagnostics["global_pauses_before"]} global_pauses_after=${diagnostics["global_pauses_after"]} -> ua10_cleanup: ${results.ua10_cleanup} ua10_existing_global_pauses_preserved: ${results.ua10_existing_global_pauses_preserved}`);
  });

  return finish();
}

function finish(): void {
  log("\n== UA-10 P1 SITUATION ENGINE LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);
  const hardFail = Object.values(results).some((v) => v === "FAIL" || v === "BLOCKED_BY_RUNTIME_ROLE");
  const blockedExternal = Object.values(results).filter((v) => v === "BLOCKED_EXTERNAL").length;
  log(`\nrun_id=${runId} hard_fail=${hardFail} blocked_external=${blockedExternal}`);
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}
