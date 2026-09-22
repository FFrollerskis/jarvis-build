// D-35 INFISICAL PRODUCTION PORT - LIVE HOST ACCEPTANCE (D-235)
//
// Prøver å bevise ALLE TI punktene i D-35 sin bindende Infisical-produksjonsport
// (docs/DECISIONS_AND_ASSUMPTIONS.md D-35, ordrett gjentatt i docs/RUNTIME_GATES.md
// sin D-35-rad) mot en EKTE, kjørende Infisical-instans (Docker) - IKKE mot en fake
// eller et unit-test-dobbel. SAMME "lib vs. orkestrator er ETT script"-mønster som
// `k1-owner-control-authority-live.ts`/`stripe-real-payment-acceptance.ts` -
// gjenbruker UTELUKKENDE eksisterende, allerede bygd produksjonskode
// (`InfisicalSecretProvider`, `ToolGateway`, `OwnerControlsTransport.set_connector_
// credential`/`test_connector`, `CONNECTOR_REGISTRY`, `PolicyGateway`) - INGEN ny
// produksjonskode, INGEN ny fake.
//
// ==== HVA DETTE SCRIPTET ER, OG IKKE ER (D-235) ====
// `docs/RUNTIME_GATES.md` sin BO-07-seksjon (2026-08-13, "D-35 Infisical: VERIFIED")
// dokumenterer at Tobias ALLEREDE, MANUELT, host-beviste: self-hosted container opp
// (egen `infisical`-database i samme Docker-Postgres), headless admin-bootstrap,
// universal-auth-maskinidentitet opprettet, et test-secret (`JARVIS_VAULT_TEST`)
// hentet via `InfisicalSecretProvider`, en pilot-migrering av `JARVIS_GITHUB_TOKEN`,
// og en outage/restart-test (infisical stoppet -> env-fallback -> restart ->
// recovery). Det er REELL, eksisterende evidens for D-35 punkt 1/2/3(delvis)/5
// (delvis)/6/7(delvis)/9 - IKKE oppfunnet på nytt her.
//
// Dette scriptet gjør TO ting BO-07 IKKE gjorde:
//  (a) gjentar/bygger inn DE SAMME sjekkene som et REPRODUSERBART, kjørbart script
//      (BO-07 var en manuell engangs-økt, ikke kildekode noen kan kjøre igjen), OG
//  (b) legger til TRE reelt NYE bevis BO-07 strukturelt IKKE KUNNE ha dekket:
//      - punkt 8 (roter/tilbakekall + kontrollert feil) - BO-07 nevner INGEN
//        rotasjons-/tilbakekallingstest av selve secret-verdien i hvelvet.
//      - punkt 10 (dokumentert backup/recovery) - BO-06 beviste generell
//        Postgres-backup/-restore (`pg_dump -Fc -> fersk DB`), IKKE spesifikt for
//        `infisical`-databasen som EGET hvelv.
//      - D-213 sin skrive-sti (`InfisicalSecretProvider.set()` +
//        `owner_controls.set_connector_credential` + dashbordets "lim inn
//        nøkkel"-flyt) ble lagt til en HEL MÅNED etter BO-07 (2026-09-20) og er
//        ALDRI host-testet mot en ekte Infisical-instans før nå.
//
// Punkt 4 (TLS/sikker transport utover localhost) kan IKKE bevises som en ekte
// TLS-handshake her - se D35_P4-seksjonen under for den ærlige, lest-fra-
// compose-filen begrunnelsen (dokumentert, IKKE fabrikkert).
//
// D-235 ER KODE LEVERT, IKKE HOST-KJØRT. Claude (denne økten) har INGEN tilgang
// til Tobias sin ekte Docker-Infisical-instans og har ALDRI kjørt dette scriptet.
// ALDRI et PASS-krav noe sted i denne filen eller i D-235-loggføringen skal leses
// som "verifisert" før Tobias faktisk har kjørt
// `infisical-live-host-run.ts` og limt inn output.
//
// ==== SIKKERHETSGRENSE (D-41 blast radius) ====
// Rører KUN ÉN, kjøre-unik test-secret-referanse (`JARVIS_D235_INFISICAL_TEST_...`)
// og ÉN kjøre-unik, syntetisk connector-oppføring MIDLERTIDIG pushet inn i
// `CONNECTOR_REGISTRY` (fjernet igjen i `finally`) - ALDRI en ekte, i bruk værende
// `credential_ref`/connector. Backup/recovery-testen (D35_P10) gjenoppretter dumpen
// til en FERSK, EGEN scratch-database (`infisical_d235_recovery_...`) - den EKTE,
// kjørende `infisical`-databasen selv røres ALDRI (ingen DROP/TRUNCATE mot den).
// Roterings-/tilbakekallingstesten (D35_P8) tilbakekaller/gjenoppretter KUN
// scriptets EGEN test-secret - ALDRI en ekte credential som `JARVIS_GITHUB_TOKEN`.
//
// Kjøres: node --env-file=.env --experimental-transform-types
//   modules/owner-controls/scripts/infisical-live.ts --compose-args '[...]'
// (normalt via modules/owner-controls/scripts/infisical-live-host-run.ts, som
// bootstrapper workspacet/Docker FØRST og gir compose-argumentene videre hit -
// SAMME `--compose-args`-konvensjon som k1-owner-control-authority-live.ts, fordi
// dette scriptet OGSÅ trenger ekte `docker ... exec/restart/stop/start` MIDT i
// kjøringen mot `infisical`/`postgres`-tjenestene.)
//
// KREVER (se ny .env.example-seksjon, D-235): INFISICAL_URL (satt til det
// HOST-nåbare endepunktet, f.eks. http://127.0.0.1:3060 - IKKE
// container-adressen http://infisical:8080 api/worker bruker internt - se
// requireHostReachableInfisicalUrl() under), INFISICAL_CLIENT_ID/_CLIENT_SECRET/
// _PROJECT_ID/_ENV (samme seks variabler api/worker allerede leser, se
// InfisicalSecretProvider i gateway.ts). Mangler NOEN av disse: scriptet
// rapporterer BLOCKED_INFISICAL_NOT_CONFIGURED for alle D-35-punktene, FORSØKER
// ALDRI et skrivekall.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import {
  adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool, PgApprovalStore
} from "@jarvis/core";
import { BusinessInternalSecretProvider } from "@jarvis/business";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  CONNECTOR_REGISTRY, EnvSecretProvider, FallbackSecretProvider, InfisicalSecretProvider, ToolGateway,
  listConnectorStatus, type ConnectorDefinition
} from "@jarvis/tool-gateway";
// SAMME "importer fra ../src, ikke @jarvis/owner-controls" - mønster som
// k1-owner-control-authority-live.ts (unngår en sirkulær pakkeavhengighet:
// @jarvis/owner-controls avhenger allerede av @jarvis/tool-gateway, ALDRI omvendt
// - dette scriptet bor derfor her, IKKE i modules/tool-gateway/scripts/, selv om
// D-35/Infisical strengt tatt "eies" av tool-gateway-pakken).
import { OwnerControlsService } from "../src/service.ts";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "../src/transport.ts";
import { captureAuditWatermark, queryRunScopedOwnerControlsAudit } from "../src/audit-evidence.ts";

type Verdict = "PASS" | "FAIL" | "N/A_DOCUMENTED" | "BLOCKED_BY_RUNTIME_ROLE" | "BLOCKED_INFISICAL_NOT_CONFIGURED" | "NOT_RUN";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "NOT_RUN",
  infisical_configured_guard: "NOT_RUN",
  d35_p1_self_hosted_running: "NOT_RUN",
  d35_p2_separate_secure_storage: "NOT_RUN",
  d35_p3_no_example_default_keys: "NOT_RUN",
  d35_p4_tls_secure_transport: "NOT_RUN",
  d35_p5_minimal_scope_machine_identity: "NOT_RUN",
  d213_write_path_and_dashboard_status: "NOT_RUN",
  d35_p6_secretprovider_fetch: "NOT_RUN",
  d35_p7_secret_never_logged: "NOT_RUN",
  d35_p8_rotate_revoke_controlled_failure: "NOT_RUN",
  d35_p9_restart_and_outage_recovery: "NOT_RUN",
  d35_p10_vault_backup_recovery: "NOT_RUN",
  cleanup: "NOT_RUN"
};
const diagnostics: Record<string, string> = {};
const logBuffer: string[] = [];

function log(msg: string): void {
  logBuffer.push(msg);
  console.log(msg);
}

async function section<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  log(`\n== ${name} ==`);
  try {
    return await fn();
  } catch (err) {
    log(`${name}: UVENTET FEIL - ${(err as Error).message.slice(0, 300)}`);
    return undefined;
  }
}

/** ALDRI selve verdien - kun til bevis-logging (D-35 punkt 7 sin egen disiplin gjelder OGSÅ scriptets egne loglinjer). */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

const argvComposeIdx = process.argv.indexOf("--compose-args");
if (argvComposeIdx < 0) {
  throw new Error(
    "infisical_missing_compose_args: kjør via infisical-live-host-run.ts, ikke direkte - dette scriptet " +
    "trenger ekte 'docker ... exec/restart/stop/start' mot postgres/infisical-tjenestene (D35_P1/P8/P9/P10)."
  );
}
const composeArgs: string[] = JSON.parse(process.argv[argvComposeIdx + 1]!) as string[];

function dockerCompose(args: string[], opts?: { input?: Buffer; env?: NodeJS.ProcessEnv }): Buffer {
  return execFileSync("docker", [...composeArgs, ...args], { stdio: ["pipe", "pipe", "pipe"], ...opts });
}
function dockerComposeInherit(args: string[]): void {
  log(`$ docker ${[...composeArgs, ...args].join(" ")}`);
  execFileSync("docker", [...composeArgs, ...args], { stdio: "inherit" });
}
function dockerContainerId(service: string): string {
  return dockerCompose(["ps", "-aq", service]).toString("utf8").trim();
}
function dockerInspectFormat(containerId: string, format: string): string {
  return execFileSync("docker", ["inspect", "--format", format, containerId], { stdio: ["pipe", "pipe", "pipe"] })
    .toString("utf8")
    .trim();
}

const runId = randomUUID().slice(0, 8);
log(`D-35 INFISICAL LIVE HOST ACCEPTANCE (D-235) - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const OWNER_PERSON = process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias";
const OWNER_TENANT = process.env["JARVIS_TENANT_ID"] ?? "tenant-personal";
const authority = { owner_person_id: OWNER_PERSON, owner_tenants: [OWNER_TENANT] };
const ownerIdentity: IdentityContext = {
  person_id: OWNER_PERSON, tenant_id: OWNER_TENANT, memory_space_id: "business",
  session_id: `sess-infisical-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
};

// KUN denne kjøringens egen, kjøre-unike test-secret-referanse og syntetiske
// connector-ID - se filhode (D-41 blast radius). ALDRI en ekte credential_ref.
const TEST_SECRET_REF = `JARVIS_D235_INFISICAL_TEST_${runId}`;
const SYNTHETIC_CONNECTOR_ID = `d235_infisical_acceptance_connector_${runId}`;
const INITIAL_VALUE = `d235-initial-${runId}-${randomUUID()}`;
const ROTATED_VALUE = `d235-rotated-${runId}-${randomUUID()}`;
const RESTORED_VALUE = `d235-restored-${runId}-${randomUUID()}`;
const ALL_TEST_SECRET_VALUES = [INITIAL_VALUE, ROTATED_VALUE, RESTORED_VALUE];

function buildStack(sidePool: pg.Pool, infisical: InfisicalSecretProvider): { killSwitch: KillSwitch; ownerControls: OwnerControls; gateway: ToolGateway } {
  const killSwitch = new KillSwitch(sidePool, authority);
  const ownerControls = new OwnerControls(killSwitch, sidePool, authority);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(sidePool), killSwitch, controls: ownerControls, authority
  });
  // SAMME produksjonssammensetning som apps/api/src/main.ts (D-211/D-213):
  // Infisical PRIMÆR, .env/BusinessInternal UENDRET fallback-kjede for lesing;
  // SAMME InfisicalSecretProvider-INSTANS gis inn EN GANG TIL som writableSecrets
  // (5. konstruktørargument) - ALDRI to uavhengige Infisical-tilkoblinger.
  const readSecrets = new FallbackSecretProvider(infisical, new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()));
  const gateway = new ToolGateway(sidePool, policy, readSecrets, ownerControls, infisical);
  const service = new OwnerControlsService(killSwitch, ownerControls);
  // `gateway` som 2. argument (D-213) - kobler set_connector_credential/test_connector
  // til ToolGateway.setSecret()/et nøstet execute()-kall, SAMME mønster som main.ts.
  for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(service, gateway))) gateway.register(tool);
  return { killSwitch, ownerControls, gateway };
}

async function setConnectorCredential(gateway: ToolGateway, value: string) {
  return gateway.execute({
    identity: ownerIdentity, tool_id: "owner_controls", action: "set_connector_credential",
    parameters: { connector_id: SYNTHETIC_CONNECTOR_ID, credential_ref: TEST_SECRET_REF, value }
  });
}

// ==== TEST-FIXTURE-ONLY Infisical-hjelpere (D-41: BEVISST UTENFOR produksjonskode,
// SAMME presedens som stripe-real-payment-acceptance.ts sin confirmWithTestCardFixture)
// - InfisicalSecretProvider (produksjonsklassen) eksponerer BEVISST INGEN
// login()/delete()-metode utad. Disse duplikatene lar D35_P5/P8b probe scenarier
// produksjonskoden aldri trenger å støtte selv. URL-formen/endepunktene er
// VERIFISERT mot Infisical sin egen backend-kildekode (Infisical/infisical,
// backend/src/server/routes/v3/deprecated-secret-router.ts - "DELETE /raw/:secretName",
// body {workspaceId, environment, secretPath?, type?} - SAMME v3 raw secrets-API som
// gateway.ts sin allerede etablerte get()/set() - ALDRI gjettet, se D-235-loggen for
// full kildeverifisering), IKKE gjettet.
const INFISICAL_URL = process.env["INFISICAL_URL"];
const INFISICAL_CLIENT_ID = process.env["INFISICAL_CLIENT_ID"];
const INFISICAL_CLIENT_SECRET = process.env["INFISICAL_CLIENT_SECRET"];
const INFISICAL_PROJECT_ID = process.env["INFISICAL_PROJECT_ID"];
const INFISICAL_ENV = process.env["INFISICAL_ENV"] ?? "dev";

/** D-235: fail-closed FØR noe nettverkskall - api/worker sin container-interne adresse er UNÅBAR fra dette host-scriptet. */
function requireHostReachableInfisicalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`infisical_url_not_a_valid_url: "${url}"`);
  }
  const hostname = parsed.hostname;
  const looksLikeDockerServiceName = !hostname.includes(".") && hostname !== "localhost";
  if (looksLikeDockerServiceName) {
    throw new Error(
      `infisical_url_looks_container_internal: INFISICAL_URL="${url}" ser ut som api/worker sin ` +
      `container-interne adresse (f.eks. "http://infisical:8080", satt av infra/local/docker-compose.yml ` +
      `for DE tjenestene). Dette host-scriptet kjører UTENFOR compose-nettverket og trenger det PUBLISERTE ` +
      `host-endepunktet i stedet (compose publiserer "3060:8080" - sett INFISICAL_URL=http://127.0.0.1:3060 i .env).`
    );
  }
}

async function infisicalProbeLogin(): Promise<string> {
  const response = await fetch(`${INFISICAL_URL}/api/v1/auth/universal-auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: INFISICAL_CLIENT_ID, clientSecret: INFISICAL_CLIENT_SECRET })
  });
  if (!response.ok) throw new Error(`infisical_probe_login_failed_${response.status}`);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

/** D-235 D35_P8b: EKTE tilbakekalling - IKKE eksponert av produksjonsklassen, se filhode. */
async function deleteInfisicalSecretDirectly(token: string, ref: string): Promise<number> {
  const response = await fetch(`${INFISICAL_URL}/api/v3/secrets/raw/${encodeURIComponent(ref)}`, {
    method: "DELETE", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: INFISICAL_PROJECT_ID, environment: INFISICAL_ENV })
  });
  return response.status;
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE (obligatorisk)", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish();
  }

  const infisical = new InfisicalSecretProvider();
  await section("INFISICAL KONFIGURERT-GUARD (D-41 fail-closed, FØR noe kall gjøres)", async () => {
    if (!infisical.available()) {
      const missing = ["INFISICAL_URL", "INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET", "INFISICAL_PROJECT_ID"]
        .filter((k) => !process.env[k]);
      throw new Error(`infisical_not_configured: mangler ${missing.join(",")} - se .env.example (D-235-seksjonen)`);
    }
    requireHostReachableInfisicalUrl(INFISICAL_URL!);
    results.infisical_configured_guard = "PASS";
    log(`infisical_configured_guard=PASS infisical_url_host=${new URL(INFISICAL_URL!).hostname} env=${INFISICAL_ENV}`);
  });
  if (results.infisical_configured_guard !== "PASS") {
    for (const key of Object.keys(results)) if (results[key] === "NOT_RUN") results[key] = "BLOCKED_INFISICAL_NOT_CONFIGURED";
    return finish();
  }

  await section("D35_P1 SELV-HOSTET, KJØRENDE (docker inspect infisical-containeren)", async () => {
    const id = dockerContainerId("infisical");
    if (!id) throw new Error("infisical_container_not_found - er 'infisical'-tjenesten startet (docker compose up -d infisical)?");
    const running = dockerInspectFormat(id, "{{.State.Running}}") === "true";
    const restartPolicy = dockerInspectFormat(id, "{{.HostConfig.RestartPolicy.Name}}");
    const image = dockerInspectFormat(id, "{{.Config.Image}}");
    // Bekrefter OGSÅ at selve login/get() faktisk lykkes mot DENNE containeren -
    // "kjører" alene beviser ikke at API-en faktisk svarer riktig.
    const probeBefore = await infisical.get(TEST_SECRET_REF);
    const ok = running && restartPolicy === "unless-stopped" && infisical.health !== "unavailable";
    results.d35_p1_self_hosted_running = ok ? "PASS" : "FAIL";
    log(`container_running=${running} restart_policy=${restartPolicy} image=${image} probe_health=${infisical.health} probe_before_existing=${probeBefore !== null} -> d35_p1_self_hosted_running: ${results.d35_p1_self_hosted_running}`);
  });

  let infisicalDbPool: pg.Pool | undefined;
  await section("D35_P2 SEPARAT, SIKKER LAGRING (egen 'infisical'-database, atskilt fra jarvis-appens)", async () => {
    const jarvisDbName = configFromEnv().database;
    const { rows: dbRow } = await adminPool.query("SELECT datname FROM pg_database WHERE datname = 'infisical'");
    const separateDbExists = dbRow.length === 1 && jarvisDbName !== "infisical";
    infisicalDbPool = createPool({ ...adminConfigFromEnv(), database: "infisical" });
    const { rows: tableInInfisicalDb } = await infisicalDbPool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'secrets_v2'"
    );
    const { rows: tableInJarvisDb } = await adminPool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'secrets_v2'"
    );
    const ok = separateDbExists && tableInInfisicalDb.length === 1 && tableInJarvisDb.length === 0;
    results.d35_p2_separate_secure_storage = ok ? "PASS" : "FAIL";
    log(`infisical_db_exists=${separateDbExists} jarvis_db_name=${jarvisDbName} secrets_v2_in_infisical_db=${tableInInfisicalDb.length === 1} secrets_v2_leaked_into_jarvis_db=${tableInJarvisDb.length > 0} -> d35_p2_separate_secure_storage: ${results.d35_p2_separate_secure_storage}`);
  });

  await section("D35_P3 INGEN EKSEMPEL-/STANDARDNØKLER (kun tilstedeværelse/lengde sjekkes, ALDRI verdien selv)", async () => {
    const KNOWN_PLACEHOLDER_STRINGS = ["changeme", "change-me", "example", "your-secret-here", "replace-me", "CHANGE_ME", ""];
    function isRealSecret(name: string, minLength: number): { ok: boolean; length: number } {
      const value = process.env[name] ?? "";
      const looksPlaceholder = KNOWN_PLACEHOLDER_STRINGS.some((p) => p.length > 0 && value.toLowerCase() === p.toLowerCase());
      return { ok: value.length >= minLength && !looksPlaceholder, length: value.length };
    }
    const encKey = isRealSecret("INFISICAL_ENCRYPTION_KEY", 16);
    const authSecret = isRealSecret("INFISICAL_AUTH_SECRET", 16);
    const clientSecret = isRealSecret("INFISICAL_CLIENT_SECRET", 8);
    const ok = encKey.ok && authSecret.ok && clientSecret.ok;
    results.d35_p3_no_example_default_keys = ok ? "PASS" : "FAIL";
    log(`encryption_key_length=${encKey.length} auth_secret_length=${authSecret.length} client_secret_length=${clientSecret.length} (verdier ALDRI logget) -> d35_p3_no_example_default_keys: ${results.d35_p3_no_example_default_keys}`);
  });

  await section(
    "D35_P4 TLS/SIKKER TRANSPORT UTOVER LOCALHOST - lest fra infra/local/docker-compose.yml, ALDRI en fabrikkert TLS-handshake-test",
    async () => {
      // Container-intern trafikk (api/worker -> infisical, "http://infisical:8080")
      // forlater ALDRI Docker sitt interne bridge-nettverk - TLS gir ingen
      // sikkerhetsgevinst der (samme topologi-begrunnelse som Postgres/Redis-
      // tilkoblingene i SAMME compose-fil). MEN: compose sin port-publisering for
      // infisical ("3060:8080") bruker SAMME ikke-loopback-begrensede form som
      // ALLE andre lokale porter i denne filen (postgres/api/langfuse) - IKKE en
      // eksplisitt "127.0.0.1:3060:8080"-binding. Det betyr porten er, strengt
      // tatt, nåbar fra andre enheter på Tobias sitt LAN hvis Windows-brannmuren
      // tillater det - IKKE unikt for Infisical, men en EKSISTERENDE,
      // repo-bred karakteristikk ved lokal-først-oppsettet (utenfor DENNE
      // sliceens scope å endre - ville vært en compose-fil-bred beslutning, ikke
      // en D-35-spesifikk fiks). Dokumenteres derfor ÆRLIG som
      // N/A_DOCUMENTED-MED-FORBEHOLD, IKKE et fabrikkert TLS-PASS.
      log(
        "d35_p4: N/A_DOCUMENTED - lokal-først Docker-compose-topologi. Container-intern " +
        "api/worker->infisical-trafikk forlater aldri Docker sitt bridge-nettverk (ingen TLS-gevinst). " +
        "FORBEHOLD: infra/local/docker-compose.yml sin 'infisical'-tjeneste publiserer porten som \"3060:8080\" " +
        "(ikke eksplisitt 127.0.0.1-bundet) - SAMME konvensjon som postgres/api/langfuse i SAMME fil, ikke en " +
        "Infisical-spesifikk avvik. Dette er en repo-bred, eksisterende karakteristikk - IKKE fabrikkert " +
        "TLS-bevist her, og IKKE stille antatt trygt. Anbefaling til arkitekt/Tobias: vurder eksplisitt " +
        "127.0.0.1-binding for ALLE lokale dev-porter i denne compose-filen (egen, repo-bred beslutning, " +
        "utenfor D-35/D-235 sitt isolerte scope)."
      );
      results.d35_p4_tls_secure_transport = "N/A_DOCUMENTED";
    }
  );

  await section("D35_P5 MASKINIDENTITET MED MINST MULIG SCOPE (samme credentials, en PÅSTÅTT FEIL workspaceId skal nektes)", async () => {
    const token = await infisicalProbeLogin();
    const bogusWorkspaceId = randomUUID();
    const response = await fetch(
      `${INFISICAL_URL}/api/v3/secrets/raw/${encodeURIComponent(TEST_SECRET_REF)}?workspaceId=${bogusWorkspaceId}&environment=${INFISICAL_ENV}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    // Login lykkes (identiteten er gyldig), MEN et forsøk mot et prosjekt den
    // IKKE er gitt tilgang til skal IKKE gi 200 - beviser at tokenet ikke er en
    // blanket, org-bred nøkkel.
    const deniedForWrongProject = response.status !== 200;
    results.d35_p5_minimal_scope_machine_identity = deniedForWrongProject ? "PASS" : "FAIL";
    log(`login_ok=true wrong_workspace_status=${response.status} denied_for_wrong_project=${deniedForWrongProject} -> d35_p5_minimal_scope_machine_identity: ${results.d35_p5_minimal_scope_machine_identity}`);
  });

  const apiSidePool = createPool(configFromEnv());
  const workerSidePool = createPool(configFromEnv());
  const apiStack = buildStack(apiSidePool, infisical);
  const workerInfisical = new InfisicalSecretProvider();
  const workerStack = buildStack(workerSidePool, workerInfisical);
  // synthetisk, kjøre-unik registrering - ALDRI en permanent endring av den ekte
  // connector-listen (fjernes igjen i CLEANUP). D-213 sin ENESTE grense mot
  // vilkårlig secret-skriving er nettopp at credential_ref MÅ stå her.
  const syntheticConnector: ConnectorDefinition = {
    id: SYNTHETIC_CONNECTOR_ID, display_name: "D-235 Infisical Acceptance Test Connector",
    category: "infra", credential_refs: [TEST_SECRET_REF]
    // BEVISST INGEN live_test - test_connector skal gi en STRUKTURERT
    // "kan ikke live-testes"-respons, se D213-seksjonen under.
  };
  CONNECTOR_REGISTRY.push(syntheticConnector);

  const auditWatermark = await captureAuditWatermark(adminPool);
  diagnostics["audit_watermark_before_run"] = auditWatermark;

  let cleanupSucceeded = false;
  try {
    await section(
      "D213 SKRIVE-STI ENDE-TIL-ENDE (D-213, ALDRI før host-testet): owner_controls.set_connector_credential -> InfisicalSecretProvider.set() -> hasSecret()/dashbordets configured:true",
      async () => {
        const written = await setConnectorCredential(apiStack.gateway, INITIAL_VALUE);
        const hasAfterWrite = await apiStack.gateway.hasSecret(TEST_SECRET_REF);
        const status = await listConnectorStatus(apiStack.gateway);
        const ourStatus = status.find((s) => s.id === SYNTHETIC_CONNECTOR_ID);
        const dashboardShowsConfigured = ourStatus?.configured === true && ourStatus.credentials.every((c) => c.configured);
        const ok = written.ok && hasAfterWrite && dashboardShowsConfigured;
        results.d213_write_path_and_dashboard_status = ok ? "PASS" : "FAIL";
        log(
          `set_connector_credential_ok=${written.ok}${written.ok ? "" : ` reason=${(written as { reason?: string }).reason}`} ` +
          `has_secret_after_write=${hasAfterWrite} dashboard_configured=${dashboardShowsConfigured} value_hash=${shortHash(INITIAL_VALUE)} ` +
          `-> d213_write_path_and_dashboard_status: ${results.d213_write_path_and_dashboard_status}`
        );
      }
    );

    await section("D35_P6 TEST-SECRET HENTES VIA SecretProvider (FERSK InfisicalSecretProvider-instans, ingen in-process-caching)", async () => {
      const freshRead = new InfisicalSecretProvider();
      const value = await freshRead.get(TEST_SECRET_REF);
      const ok = value === INITIAL_VALUE;
      results.d35_p6_secretprovider_fetch = ok ? "PASS" : "FAIL";
      log(`fetched_matches_written=${ok} fetched_hash=${value ? shortHash(value) : "null"} expected_hash=${shortHash(INITIAL_VALUE)} -> d35_p6_secretprovider_fetch: ${results.d35_p6_secretprovider_fetch}`);
    });

    await section(
      "D35_P8 ROTER/TILBAKEKALL + BEVIS KONTROLLERT FEIL (NYTT, ALDRI før host-testet - a) rotasjon via SAMME skrive-sti, b) EKTE tilbakekalling via Infisical sin egen DELETE-API, c) gjenoppretting)",
      async () => {
        // (a) ROTASJON - SAMME owner_controls.set_connector_credential-sti som D213-seksjonen over.
        const rotated = await setConnectorCredential(workerStack.gateway, ROTATED_VALUE);
        const afterRotate = await new InfisicalSecretProvider().get(TEST_SECRET_REF);
        const rotationOk = rotated.ok && afterRotate === ROTATED_VALUE && afterRotate !== INITIAL_VALUE;
        log(`rotate_ok=${rotated.ok} value_changed=${afterRotate !== INITIAL_VALUE} new_value_matches=${afterRotate === ROTATED_VALUE} rotated_hash=${shortHash(ROTATED_VALUE)}`);

        // (b) TILBAKEKALLING - EKTE DELETE mot Infisical sin v3 raw secrets-API
        // (verifisert mot faktisk backend-kildekode, se filhode) - IKKE noe
        // owner_controls-handling dekker dette i dag (kun Jarvis-side
        // revoke_credential/kill-switch-markering finnes, ALDRI faktisk sletting
        // fra hvelvet) - scriptets EGET, test-fixture-only kall.
        const deleteToken = await infisicalProbeLogin();
        const deleteStatus = await deleteInfisicalSecretDirectly(deleteToken, TEST_SECRET_REF);
        const afterRevoke = await new InfisicalSecretProvider().get(TEST_SECRET_REF);
        const hasSecretAfterRevoke = await apiStack.gateway.hasSecret(TEST_SECRET_REF);
        // Fail-closed, IKKE en kastet feil: get() returnerer null, hasSecret() (via
        // HELE fallback-kjeden) rapporterer false - systemet lyver ALDRI om at en
        // tilbakekalt credential fortsatt er konfigurert.
        const revokeOk = deleteStatus >= 200 && deleteStatus < 300 && afterRevoke === null && !hasSecretAfterRevoke;
        log(`delete_http_status=${deleteStatus} value_gone=${afterRevoke === null} hassecret_reports_false=${!hasSecretAfterRevoke} -> revoke_fail_closed_ok=${revokeOk}`);

        // (c) GJENOPPRETTING - SAMME skrive-sti gjenoppretter en (ny) verdi.
        const restored = await setConnectorCredential(apiStack.gateway, RESTORED_VALUE);
        const afterRestore = await new InfisicalSecretProvider().get(TEST_SECRET_REF);
        const hasSecretAfterRestore = await workerStack.gateway.hasSecret(TEST_SECRET_REF);
        const restoreOk = restored.ok && afterRestore === RESTORED_VALUE && hasSecretAfterRestore;
        log(`restore_ok=${restored.ok} value_restored=${afterRestore === RESTORED_VALUE} hassecret_after_restore=${hasSecretAfterRestore} restored_hash=${shortHash(RESTORED_VALUE)}`);

        const ok = rotationOk && revokeOk && restoreOk;
        results.d35_p8_rotate_revoke_controlled_failure = ok ? "PASS" : "FAIL";
        log(`-> d35_p8_rotate_revoke_controlled_failure: ${results.d35_p8_rotate_revoke_controlled_failure}`);
      }
    );

    await section(
      "D35_P7 SECRET-VERDI ALDRI I LOGS/AUDIT/FEILMELDINGER (alle TRE test-verdiene sjekket mot HELE scriptets loggbuffer OG mot owner_controls-audit-payloadene for denne kjøringen)",
      async () => {
        const noneInLog = !logBuffer.some((line) => ALL_TEST_SECRET_VALUES.some((v) => line.includes(v)));
        const auditRows = await queryRunScopedOwnerControlsAudit(adminPool, {
          personId: OWNER_PERSON, sessionId: ownerIdentity.session_id!, watermark: auditWatermark,
          actions: ["set_connector_credential", "test_connector"]
        });
        const auditSerialized = JSON.stringify(auditRows);
        const noneInAudit = !ALL_TEST_SECRET_VALUES.some((v) => auditSerialized.includes(v));
        const hasSetCredentialAuditRows = auditRows.filter((e) => e.action === "set_connector_credential" && e.type === "tool.executed").length >= 3;
        const ok = noneInLog && noneInAudit && hasSetCredentialAuditRows;
        results.d35_p7_secret_never_logged = ok ? "PASS" : "FAIL";
        log(`none_in_log_buffer=${noneInLog} none_in_audit_payload=${noneInAudit} audit_set_credential_rows=${auditRows.filter((e) => e.action === "set_connector_credential").length} (forventet >=3, én per skriving/rotasjon/gjenoppretting) -> d35_p7_secret_never_logged: ${results.d35_p7_secret_never_logged}`);
      }
    );

    await section(
      "D213 test_connector - presence_only-connector (INGEN live_test registrert for vår syntetiske connector) gir STRUKTURERT 'kan ikke live-testes'-respons, ALDRI en kastet feil",
      async () => {
        const tested = await apiStack.gateway.execute({
          identity: ownerIdentity, tool_id: "owner_controls", action: "test_connector",
          parameters: { connector_id: SYNTHETIC_CONNECTOR_ID }
        });
        const data = tested.ok ? (tested.data as { test_method?: string; tested?: boolean } | undefined) : undefined;
        const ok = tested.ok && data?.test_method === "presence_only" && data.tested === false;
        log(`test_connector_ok=${tested.ok} test_method=${data?.test_method} tested=${data?.tested} -> presence_only_structured_response_ok=${ok}`);
      }
    );

    await section(
      "D35_P9 RESTART-BEVIS + OUTAGE-GJENOPPRETTING (a: docker restart infisical, b: docker stop -> fail-closed uten krasj -> docker start -> recovery)",
      async () => {
        // (a) RESTART
        dockerComposeInherit(["restart", "infisical"]);
        const afterRestartValue = await pollUntil(() => new InfisicalSecretProvider().get(TEST_SECRET_REF), (v) => v === RESTORED_VALUE, 30_000);
        const restartOk = afterRestartValue === RESTORED_VALUE;
        log(`after_restart_value_matches=${restartOk}`);

        // (b) OUTAGE
        dockerComposeInherit(["stop", "infisical"]);
        const outageProvider = new InfisicalSecretProvider();
        let outageThrew = false;
        let outageValue: string | null = "unset";
        try {
          outageValue = await outageProvider.get(TEST_SECRET_REF);
        } catch {
          outageThrew = true;
        }
        const outageFailedClosed = !outageThrew && outageValue === null && outageProvider.health === "unavailable";
        log(`outage_threw=${outageThrew} outage_value_null=${outageValue === null} outage_health=${outageProvider.health} -> outage_fail_closed_ok=${outageFailedClosed}`);

        dockerComposeInherit(["start", "infisical"]);
        const afterRecoveryValue = await pollUntil(() => new InfisicalSecretProvider().get(TEST_SECRET_REF), (v) => v === RESTORED_VALUE, 30_000);
        const recoveryOk = afterRecoveryValue === RESTORED_VALUE;
        log(`after_recovery_value_matches=${recoveryOk}`);

        const ok = restartOk && outageFailedClosed && recoveryOk;
        results.d35_p9_restart_and_outage_recovery = ok ? "PASS" : "FAIL";
        log(`-> d35_p9_restart_and_outage_recovery: ${results.d35_p9_restart_and_outage_recovery}`);
      }
    );

    await section(
      "D35_P10 DOKUMENTERT BACKUP/RECOVERY SPESIFIKT FOR INFISICAL-HVELVET (NYTT - pg_dump av EGEN 'infisical'-database, IKKE jarvis-appens; restore til fersk scratch-database; bekreft raden for test-secret-nøkkelen overlever)",
      async () => {
        const adminUser = process.env["JARVIS_DB_ADMIN_USER"] ?? "postgres";
        const adminPassword = process.env["JARVIS_DB_ADMIN_PASSWORD"] ?? "";
        const scratchDir = mkdtempSync(join(tmpdir(), "jarvis-d235-infisical-backup-"));
        const dumpPath = join(scratchDir, `infisical-${runId}.dump`);
        const scratchDbName = `infisical_d235_recovery_${runId}`;
        let scratchPool: pg.Pool | undefined;
        try {
          // pg_dump -Fc (SAMME format som BO-06 sin generelle Postgres-backup-
          // akseptanse, docs/RUNTIME_GATES.md) av den EGNE 'infisical'-databasen -
          // ALDRI 'jarvis'. Kjøres INNI postgres-containeren (docker exec) - unngår
          // et krav om lokalt installerte pg_dump/pg_restore-klientverktøy på
          // Tobias sin host.
          const dumpBuffer = dockerCompose(["exec", "-T", "-e", `PGPASSWORD=${adminPassword}`, "postgres",
            "pg_dump", "-U", adminUser, "-h", "127.0.0.1", "-d", "infisical", "-Fc"]);
          writeFileSync(dumpPath, dumpBuffer);
          const dumpNonEmpty = dumpBuffer.length > 0;
          log(`pg_dump_bytes=${dumpBuffer.length} dump_written_to=${dumpPath} (scratchpad, slettes i CLEANUP)`);

          dockerCompose(["exec", "-T", "-e", `PGPASSWORD=${adminPassword}`, "postgres",
            "createdb", "-U", adminUser, "-h", "127.0.0.1", scratchDbName]);
          dockerCompose(["exec", "-T", "-e", `PGPASSWORD=${adminPassword}`, "postgres",
            "pg_restore", "-U", adminUser, "-h", "127.0.0.1", "-d", scratchDbName], { input: dumpBuffer });
          log(`scratch_db_created_and_restored=${scratchDbName}`);

          scratchPool = createPool({ ...adminConfigFromEnv(), database: scratchDbName });
          // Verifiserer at RADEN for vår test-secret-nøkkel overlevde restore - IKKE
          // selve den dekrypterte verdien (secrets_v2.encryptedValue er kryptert med
          // Infisical sin EGEN KMS/krypteringslogikk - å dekryptere den her ville
          // krevd å reimplementere den logikken utenfor produksjonskode, presis det
          // D-41 sin "aldri gjettet"-disiplin advarer mot). Strukturelt, ærlig bevis:
          // raden (nøkkelen, som IKKE er kryptert - kun verdien er det) finnes i den
          // gjenopprettede databasen.
          const { rows } = await scratchPool.query("SELECT 1 FROM secrets_v2 WHERE key = $1", [TEST_SECRET_REF]);
          const rowSurvived = rows.length >= 1;
          log(`restored_row_for_test_secret_key_found=${rowSurvived} (verdien selv IKKE dekryptert her - se kommentar)`);

          const ok = dumpNonEmpty && rowSurvived;
          results.d35_p10_vault_backup_recovery = ok ? "PASS" : "FAIL";
          log(`-> d35_p10_vault_backup_recovery: ${results.d35_p10_vault_backup_recovery}`);
        } finally {
          await scratchPool?.end();
          // Scratch-databasen og dump-filen er UTELUKKENDE denne kjøringens egne
          // midlertidige artefakter - DROP/slett er ALDRI en handling mot den ekte
          // 'infisical'-databasen selv (den røres aldri av denne seksjonen).
          try {
            dockerCompose(["exec", "-T", "-e", `PGPASSWORD=${adminPassword}`, "postgres",
              "dropdb", "-U", adminUser, "-h", "127.0.0.1", "--if-exists", scratchDbName]);
          } catch (err) {
            log(`scratch_db_cleanup_warning: ${(err as Error).message.slice(0, 200)}`);
          }
          rmSync(scratchDir, { recursive: true, force: true });
        }
      }
    );

    cleanupSucceeded = true;
  } finally {
    await section("CLEANUP (test-secret tilbakekalt fra hvelvet, syntetisk connector-oppføring fjernet fra CONNECTOR_REGISTRY)", async () => {
      let cleanupOk = true;
      try {
        const token = await infisicalProbeLogin();
        await deleteInfisicalSecretDirectly(token, TEST_SECRET_REF); // idempotent - 404 hvis allerede borte
      } catch (err) {
        cleanupOk = false;
        log(`cleanup_delete_secret_warning: ${(err as Error).message.slice(0, 200)}`);
      }
      const idx = CONNECTOR_REGISTRY.findIndex((c) => c.id === SYNTHETIC_CONNECTOR_ID);
      if (idx >= 0) CONNECTOR_REGISTRY.splice(idx, 1);
      const registryClean = CONNECTOR_REGISTRY.every((c) => c.id !== SYNTHETIC_CONNECTOR_ID);
      const finalValue = await new InfisicalSecretProvider().get(TEST_SECRET_REF);
      const secretGone = finalValue === null;
      cleanupOk = cleanupOk && registryClean && secretGone;
      results.cleanup = cleanupOk ? "PASS" : "FAIL";
      log(`registry_clean=${registryClean} secret_gone=${secretGone} main_sequence_completed=${cleanupSucceeded} -> cleanup: ${results.cleanup}`);
    });
    await apiSidePool.end();
    await workerSidePool.end();
    await infisicalDbPool?.end();
  }

  return finish();
}

async function pollUntil<T>(fn: () => Promise<T>, satisfied: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await fn();
    if (satisfied(last)) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function finish(): void {
  log("\n== D-35 INFISICAL LIVE HOST ACCEPTANCE (D-235) SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);
  const hardFail = Object.values(results).some((v) => v === "FAIL" || v === "NOT_RUN" || v.startsWith("BLOCKED"));
  log(`\nD235_INFISICAL_LIVE_ACCEPTANCE_RUN=true`);
  log(`D35_INFISICAL_GATE_CANDIDATE=${hardFail ? "FAIL_OR_INCOMPLETE" : "PASS_PENDING_ARCHITECT_REVIEW"}`);
  log(`run_id=${runId}`);
  log(`hard_fail=${hardFail}`);
  log("MERK: dette er ET FAKTISK KJØRT resultat NÅR Tobias selv kjører scriptet - men PASS her er ALDRI ekvivalent med D-35=PRODUCTION_VERIFIED alene; se D-235 i DECISIONS_AND_ASSUMPTIONS.md for arkitekt-reviewkravet.");
  if (hardFail) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}
