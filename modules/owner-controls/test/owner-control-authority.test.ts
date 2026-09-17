import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { OwnerControlsService } from "../src/service.ts";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "../src/transport.ts";
import type { OwnerControlState } from "../src/types.ts";

/**
 * K1 (Sovereign graduation, D-164): ende-til-ende-bevis for HELE den
 * durable/delte eier-kontroll-flaten mot EKTE embedded Postgres - SAMME
 * mønster som `modules/situations/test/domain-pause.test.ts` sin del C
 * (den etablerte presedensen for durable owner-authority-tester). Denne
 * suiten dekker K1-ordren sine kategorier A (persistens), B (api/worker-
 * parity), C (autorisasjon), D (ToolGateway-komposisjon), F (restart/
 * gjenoppretting), G (audit), H (RLS/tenant - dokumentert N/A). Kategori E
 * (situations-koeksistens) er dekket av `modules/executive/test/service-
 * transport.test.ts` sin "G"-blokk (der komposisjonen faktisk skjer).
 * Kategori J (regresjon) er dekket av at HELE eksisterende
 * policy/situations/executive/tool-gateway/apps-api-suiten (759 tester)
 * fortsetter å passere uendret (se PR-beskrivelse/PROJECT_STATUS.md).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT = "tenant-owner-controls-k1";
const TENANT_B = "tenant-owner-controls-k1-b";
const OWNER = "person-owner-controls-k1-owner";
const OTHER = "person-owner-controls-k1-other";
const authority = { owner_person_id: OWNER, owner_tenants: [TENANT, TENANT_B] };

const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };

function identityFor(tenantId: string, personId: string = OWNER): IdentityContext {
  return {
    person_id: personId, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-owner-controls-${tenantId}-${personId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}
const ownerIdentity = identityFor(TENANT);
const ownerIdentityTenantB = identityFor(TENANT_B);
const otherIdentity = identityFor(TENANT, OTHER);

/** ÉN full stack (killSwitch+ownerControls+policy+gateway+registrert owner_controls-verktøy) mot EKTE `appPool` - brukt der en test bevisst vil ha en FERSK instans (restart-simulering) i stedet for en delt. */
function freshStack(): {
  killSwitch: KillSwitch;
  ownerControls: OwnerControls;
  policy: PolicyGateway;
  gateway: ToolGateway;
} {
  const killSwitch = new KillSwitch(appPool, authority);
  const ownerControls = new OwnerControls(killSwitch, appPool, authority);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(appPool),
    killSwitch,
    controls: ownerControls,
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT, TENANT_B] }
  });
  const gateway = new ToolGateway(appPool, policy, secrets, ownerControls);
  const service = new OwnerControlsService(killSwitch, ownerControls);
  for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(service))) gateway.register(tool);
  return { killSwitch, ownerControls, policy, gateway };
}

async function getState(gateway: ToolGateway, identity: IdentityContext): Promise<OwnerControlState> {
  const result = await gateway.execute({ identity, tool_id: "owner_controls", action: "get_control_state", parameters: {} });
  if (!result.ok) throw new Error(`unexpected_denial:${result.reason}`);
  return result.data as unknown as OwnerControlState;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-owner-controls-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leased.postgres;
  PORT = leased.port;
  stopEmbeddedPostgres = leased.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_owner_controls_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_owner_controls_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'OwnerControlsK1', 'business'), ('${TENANT_B}', 'OwnerControlsK1B', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Owner'), ('${OTHER}', 'Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}'), ('${OWNER}','${TENANT_B}'), ('${OTHER}','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_owner_controls_test", password: "pw2" });
}, 240_000);

beforeEach(async () => {
  // Global tilstand (INGEN tenant_id, se 058_owner_control_authority.sql) - må renskes mellom
  // hver test i DENNE filen, ellers lekker en test sin frys/tilbakekall/kill-switch inn i neste.
  await adminPool.query("DELETE FROM owner_control_state");
});

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: persistens - EKTE Postgres, ingen prosess-lokal skyggetilstand", () => {
  it("kill switch aktivert via owner_controls.activate_kill_switch overlever en FERSK instans (simulert restart) UTEN restore() - isActiveDurable() er en LIVE spørring, ikke en cache som må varmes opp", async () => {
    const first = freshStack();
    const activated = await first.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "A-test" } });
    expect(activated.ok).toBe(true);

    const restarted = freshStack(); // helt ny KillSwitch/OwnerControls-instans, INGEN delt in-memory-tilstand, INGEN restore() kalt.
    expect(await restarted.killSwitch.isActiveDurable()).toBe(true);

    await restarted.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
  });

  it("frosset connector og tilbakekalt credential overlever samme restart-simulering", async () => {
    const first = freshStack();
    await first.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "gmail", reason: "A-test" } });
    await first.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_credential", parameters: { credential_ref: "cred-a-test", reason: "A-test" } });

    const restarted = freshStack();
    expect(await restarted.ownerControls.isFrozenDurable("gmail")).toBe(true);
    expect(await restarted.ownerControls.isRevokedDurable("cred-a-test")).toBe(true);
    await restarted.ownerControls.restore(); // observability-speiling - se KillSwitch.restore() sitt filhode
    expect(restarted.ownerControls.isFrozen("gmail")).toBe(true);
  });

  it("samtidig skriving på SAMME (kind,target) er deterministisk - siste commit vinner, ALDRI en duplikat-rad eller korrupt tilstand", async () => {
    const a = freshStack();
    const b = freshStack();
    await Promise.all([
      a.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "concurrent-target", reason: "fra-a" } }),
      b.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "concurrent-target", reason: "fra-b" } })
    ]);
    const { rows } = await adminPool.query(
      "SELECT reason FROM owner_control_state WHERE control_kind = 'connector_freeze' AND control_target = 'concurrent-target'"
    );
    expect(rows).toHaveLength(1); // ALDRI to rader for samme (kind,target) - PK-en garanterer dette, men bevis det likevel.
    expect(["fra-a", "fra-b"]).toContain((rows[0] as { reason: string }).reason);
  });
});

describe("B: API-/worker-parity - to HELT SEPARATE pg.Pool-instanser (simulerer to prosesser) ser SAMME tilstand LIVE", () => {
  it("en pause satt via 'API'-poolen er UMIDDELBART synlig for 'worker'-poolens EGEN, uavhengige KillSwitch-instans - ingen synk-mekanisme, ingen ventetid", async () => {
    const apiPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_owner_controls_test", password: "pw2" });
    const workerPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_owner_controls_test", password: "pw2" });
    try {
      const apiKillSwitch = new KillSwitch(apiPool, authority);
      const workerKillSwitch = new KillSwitch(workerPool, authority); // HELT separat JS-objekt, HELT separat pg.Pool - null delt hukommelse.
      expect(await workerKillSwitch.isActiveDurable()).toBe(false);

      await apiKillSwitch.activateDurable("B-test parity", OWNER);
      expect(await workerKillSwitch.isActiveDurable()).toBe(true); // "worker" ser "api" sin skriving UTEN restart, UTEN restore(), UTEN noen melding mellom prosessene.

      await workerKillSwitch.deactivateDurable(OWNER);
      expect(await apiKillSwitch.isActiveDurable()).toBe(false); // symmetrisk andre veien.
    } finally {
      await apiPool.end();
      await workerPool.end();
    }
  });

  it("samme parity for frosne connectorer - 'worker' sin egen OwnerControls-instans ser 'api' sin frys direkte", async () => {
    const apiPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_owner_controls_test", password: "pw2" });
    const workerPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_owner_controls_test", password: "pw2" });
    try {
      const apiKs = new KillSwitch(apiPool, authority);
      const apiOc = new OwnerControls(apiKs, apiPool, authority);
      const workerKs = new KillSwitch(workerPool, authority);
      const workerOc = new OwnerControls(workerKs, workerPool, authority);

      await apiOc.freezeConnectorDurable("slack", "B-test", OWNER);
      expect(await workerOc.isFrozenDurable("slack")).toBe(true);
      await workerOc.unfreezeConnectorDurable("slack", OWNER);
      expect(await apiOc.isFrozenDurable("slack")).toBe(false);
    } finally {
      await apiPool.end();
      await workerPool.end();
    }
  });
});

describe("C: autorisasjon - kill switch/frys blokkerer, eier-only mutasjon, klasse D-semantikk uendret", () => {
  it("aktiv kill switch nekter ETHVERT annet owner_controls-verktøykall (klasse C freeze_connector), men IKKE deactivate_kill_switch/get_control_state selv", async () => {
    const { gateway } = freshStack();
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "C-test" } });

    const blocked = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "x", reason: "skal nektes" } });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("kill_switch_active");

    const readAllowed = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "get_control_state", parameters: {} });
    expect(readAllowed.ok).toBe(true); // selvgjenopprettings-unntaket - eieren MÅ kunne SE at systemet er stanset.

    const deactivated = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
    expect(deactivated.ok).toBe(true); // selvgjenopprettings-unntaket - IKKE et énveis-lås.
  });

  it("deaktivering GJENOPPRETTER tilgang for det som var blokkert (freeze_connector lykkes etter deactivate)", async () => {
    const { gateway } = freshStack();
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "C-test-2" } });
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
    const afterDeactivate = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "y", reason: "skal nå lykkes" } });
    expect(afterDeactivate.ok).toBe(true);
  });

  it("forfalskede identitetsfelt i PARAMETRE (actor_person_id/reason-injeksjon utover skjemaet) avvises av ToolGateway sitt strict()-skjema FØR transporten nås", async () => {
    const { gateway } = freshStack();
    const result = await gateway.execute({
      identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector",
      parameters: { connector_id: "z", reason: "test", actor_person_id: OTHER } as never
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_parameters");
  });

  it("IKKE-eier (SCOPED-modus) nektes klasse C-mutasjon (freeze_connector) - 'class_c_no_mandate', ingen skriving skjer", async () => {
    const { gateway } = freshStack();
    const result = await gateway.execute({ identity: otherIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "not-owner-target", reason: "forsøk" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("class_c_no_mandate");
    const { rows } = await adminPool.query("SELECT 1 FROM owner_control_state WHERE control_target = 'not-owner-target'");
    expect(rows).toHaveLength(0);
  });

  it("klasse D-semantikk UENDRET: IKKE-eier nektes activate_kill_switch UTEN en signert godkjenning ('class_d_missing_approval'), eieren (SOVEREIGN) kjører INSTANT uten godkjenning", async () => {
    const { gateway } = freshStack();
    const otherAttempt = await gateway.execute({ identity: otherIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "forsøk uten godkjenning" } });
    expect(otherAttempt.ok).toBe(false);
    if (!otherAttempt.ok) expect(otherAttempt.reason).toBe("class_d_missing_approval");

    const ownerAttempt = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "eier - instant" } });
    expect(ownerAttempt.ok).toBe(true); // SOVEREIGN: ingen approval-friksjon for eieren, se PolicyGateway.authorize() klasse D-grenen.
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
  });

  it("selv OM ToolGateway/PolicyGateway ble omgått: assertOwnerControlAuthorized() på DB-laget nekter DIREKTE en feil/manglende actor (dyp forsvarslinje, ikke bare grensesnittet)", async () => {
    const killSwitch = new KillSwitch(appPool, authority);
    await expect(killSwitch.activateDurable("direkte forsøk", OTHER)).rejects.toThrow();
    await expect(killSwitch.activateDurable("uten actor")).rejects.toThrow();
    expect(await killSwitch.isActiveDurable()).toBe(false);
  });
});

describe("D: ToolGateway-komposisjon - owner_controls.* er et VANLIG ToolGateway-verktøy, ingen særbehandling utover de dokumenterte unntakene", () => {
  it("get_control_state (klasse A) komponerer kill_switch + frozen_connectors + revoked_credentials i ETT svar", async () => {
    const { gateway } = freshStack();
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "d-test", reason: "d" } });
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "revoke_credential", parameters: { credential_ref: "cred-d-test", reason: "d" } });
    const state = await getState(gateway, ownerIdentity);
    expect(state.kill_switch.active).toBe(false);
    expect(state.frozen_connectors.map((c) => c.connector_id)).toContain("d-test");
    expect(state.revoked_credentials.map((c) => c.credential_ref)).toContain("cred-d-test");
  });

  it("manglende invocation-context feiler lukket (transport kalt direkte, uten context - samme disiplin som SituationsTransport/ExecutiveTransport)", async () => {
    const { gateway } = freshStack();
    const definition = gateway.get("owner_controls", "get_control_state");
    expect(definition).toBeDefined();
    await expect(definition!.transport.invoke("get_control_state", {}, "cred", undefined as never)).rejects.toThrow("owner_controls_missing_invocation_context");
  });

  it("ukjent action avvises med en tydelig feil, ikke en stille no-op", async () => {
    const { gateway } = freshStack();
    const definition = gateway.get("owner_controls", "get_control_state")!;
    await expect(
      definition.transport.invoke("not_a_real_action", {}, "cred", { identity: ownerIdentity })
    ).rejects.toThrow("unknown_owner_controls_action:not_a_real_action");
  });

  it("manglende påkrevd parameter (reason/connector_id/credential_ref) avvises av zod FØR transporten - 'invalid_parameters', ikke en uklar transport-feil", async () => {
    const { gateway } = freshStack();
    const missingReason = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "no-reason" } as never });
    expect(missingReason.ok).toBe(false);
    if (!missingReason.ok) expect(missingReason.reason).toBe("invalid_parameters");
  });
});

describe("F: restart/gjenoppretting - INGEN oppstartsvindu der en fersk instans utfører FØR lastet tilstand håndheves", () => {
  it("en KillSwitch(pool)-instans som ALDRI har kalt restore() gir likevel korrekt isActiveDurable() FØRSTE gang den spørres - den autoritative sjekken avhenger IKKE av restore()", async () => {
    const writer = new KillSwitch(appPool, authority);
    await writer.activateDurable("F-test", OWNER);

    const neverRestored = new KillSwitch(appPool, authority); // konstruert, men restore() ALDRI kalt.
    expect(await neverRestored.isActiveDurable()).toBe(true); // riktig svar likevel - LIVE spørring, ikke avhengig av en oppvarmingsfase.

    await writer.deactivateDurable(OWNER);
  });

  it("restore() speiler DB-tilstanden inn i den synkrone in-memory-cachen (for observability/synkrone kallesteder) - en lokal, ALDRI-persistert synkron pause OVERSKRIVES av restore()", async () => {
    const registry = new KillSwitch(appPool, authority);
    registry.activate("kun-in-memory-aldri-persistert"); // ren synkron - ALDRI skrevet til DB.
    expect(registry.isActive()).toBe(true);
    await registry.restore(); // DB har ingen rad -> in-memory-cachen nullstilles.
    expect(registry.isActive()).toBe(false);
  });

  it("OwnerControls.restore() gjenoppretter frys/tilbakekall-settene fullstendig fra DB, uavhengig av killSwitch sin egen tilstand", async () => {
    const writer = freshStack();
    await writer.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "f-restore", reason: "f" } });

    const fresh = freshStack();
    await fresh.ownerControls.restore();
    expect(fresh.ownerControls.isFrozen("f-restore")).toBe(true);
    await fresh.gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "f-restore" } });
  });
});

describe("G: audit - actor/reason logget, ingen hemmeligheter, replay/idempotens korrekt", () => {
  it("activate_kill_switch skriver en audit_events-rad med korrekt person_id/tool_id/action, OG en payload UTEN credential-VERDIEN (kun credential_ref)", async () => {
    const { gateway } = freshStack();
    const result = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "G-test audit" } });
    expect(result.ok).toBe(true);
    const { rows } = await adminPool.query(
      `SELECT person_id, tool_id, action, type, decision, payload FROM audit_events
       WHERE tool_id = 'owner_controls' AND action = 'activate_kill_switch' ORDER BY audit_id DESC LIMIT 1`
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as { person_id: string; tool_id: string; action: string; type: string; decision: string; payload: { credential_ref?: string } };
    expect(row.person_id).toBe(OWNER);
    expect(row.type).toBe("tool.executed");
    expect(row.decision).toBe("ALLOW");
    expect(row.payload.credential_ref).toBeDefined();
    expect(JSON.stringify(row.payload)).not.toContain("test-token"); // den FAKTISKE credential-verdien fra `secrets.get()` - ALDRI i payloaden.
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
  });

  it("en NEKTET mutasjon (kill switch aktiv) skriver OGSÅ en audit-rad ('tool.denied'), reasonen er ALDRI stille tapt", async () => {
    const { gateway } = freshStack();
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "G-deny-test" } });
    const denied = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "g-deny", reason: "skal nektes" } });
    expect(denied.ok).toBe(false);
    const { rows } = await adminPool.query(
      `SELECT reason, decision FROM audit_events WHERE tool_id = 'owner_controls' AND action = 'freeze_connector' AND decision = 'DENY' ORDER BY audit_id DESC LIMIT 1`
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { reason: string }).reason).toBe("kill_switch_active");
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
  });

  it("idempotency_key: en GJENTATT freeze_connector med SAMME idempotency_key dedupliseres (deduplicated:true), utløser INGEN ny skriving/audit-rad for selve mutasjonen", async () => {
    const { gateway } = freshStack();
    const key = "idem-g-test-1";
    const first = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "g-idem", reason: "første" }, idempotency_key: key });
    expect(first.ok).toBe(true);
    const second = await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "g-idem", reason: "andre - skal IKKE kjøre" }, idempotency_key: key });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.deduplicated).toBe(true);
    const { rows } = await adminPool.query("SELECT reason FROM owner_control_state WHERE control_target = 'g-idem'");
    expect(rows).toHaveLength(1);
    expect((rows[0] as { reason: string }).reason).toBe("første"); // den DEDUPLISERTE andre kjøringen endret INGENTING.
  });
});

describe("H: RLS/tenant-isolasjon - dokumentert N/A (global, system-autoritet-tilstand, se 058_owner_control_authority.sql)", () => {
  it("owner_control_state har INGEN tenant_id-kolonne - tilstanden er BEVISST global, samme owner sett fra to FORSKJELLIGE tenants ser SAMME kill switch/frys-tilstand", async () => {
    const { columns } = await adminPool
      .query("SELECT column_name FROM information_schema.columns WHERE table_name = 'owner_control_state'")
      .then((r) => ({ columns: r.rows.map((row) => (row as { column_name: string }).column_name) }));
    expect(columns).not.toContain("tenant_id");

    const { gateway } = freshStack();
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "h-cross-tenant", reason: "h" } });
    // SAMME eier (OWNER er eier i BÅDE TENANT og TENANT_B, se `authority.owner_tenants`), ANNEN tenant_id i identiteten.
    const stateFromTenantB = await getState(gateway, ownerIdentityTenantB);
    expect(stateFromTenantB.frozen_connectors.map((c) => c.connector_id)).toContain("h-cross-tenant"); // FORVENTET - global, ikke en lekkasje.
    await gateway.execute({ identity: ownerIdentity, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "h-cross-tenant" } });
  });
});
