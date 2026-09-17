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
import { OwnerControlsService, OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { DomainPauseRegistry, SituationEngine, SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import { ExecutiveAccessDeniedError } from "../src/service.ts";
import { ExecutiveService } from "../src/service.ts";
import { ExecutiveTransport, executiveToolDefinitions } from "../src/transport.ts";
import type { AttentionItem, ControlSurfaceStatus } from "../src/types.ts";

/**
 * UA-11 Executive Mode (P0, D-162): ende-til-ende-bevis mot EKTE embedded
 * Postgres/RLS + EKTE `ToolGateway`/`PolicyGateway`/`SituationEngine`/
 * `DomainPauseRegistry` - SAMME mønster som
 * `modules/situations/test/activation.test.ts`. `ExecutiveService` seeder
 * ALDRI situasjoner selv - enhver situasjon i disse testene kommer fra
 * `SituationEngine.evaluateCandidate()` (den kanoniske inngangen `sweep.ts`
 * selv bruker) - beviser at Executive Mode KOMPONERER, aldri duplisererer.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
let killSwitch: KillSwitch;
let engine: SituationEngine;
let domainPauses: DomainPauseRegistry;
let gateway: ToolGateway;
let executiveService: ExecutiveService;

const TENANT_A = "tenant-exec-a";
const TENANT_B = "tenant-exec-b";
const OWNER = "person-tobias-executive";
const OTHER = "person-other-executive";

/** SAMME permissive test-provider-konvensjon som `activation.test.ts` - denne suiten beviser komposisjon/autoritet, ikke credential-oppløsning (den er dekket separat av situations-pakkens egen regresjonsvakt). */
const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };

function identityFor(tenantId: string, memorySpace: "business" | "personal", personId: string = OWNER): IdentityContext {
  return {
    person_id: personId, tenant_id: tenantId, memory_space_id: memorySpace,
    session_id: `sess-executive-${tenantId}-${memorySpace}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}
const ownerA = identityFor(TENANT_A, "business");
const ownerAPersonal = identityFor(TENANT_A, "personal");
const ownerB = identityFor(TENANT_B, "business");
const otherA: IdentityContext = { ...ownerA, person_id: OTHER, session_id: "sess-other" };

let loopSeq = 0;
async function seedSituation(
  tenantId: string,
  memorySpace: "business" | "personal",
  overrides: Partial<{ domain: string; priority: "low" | "normal" | "high"; confidence: number; reason: string }> = {}
) {
  loopSeq += 1;
  const v = { domain: "pipeline", priority: "normal" as const, confidence: undefined as number | undefined, reason: `Testgrunn ${loopSeq}`, ...overrides };
  const result = await engine.evaluateCandidate(tenantId, memorySpace, {
    domain: v.domain, detection_key: `exec-test:${loopSeq}`, priority: v.priority,
    ...(v.confidence !== undefined ? { confidence: v.confidence } : {}), reason: v.reason
  });
  return result.situation;
}

async function getQueueViaExecutive(identity: IdentityContext, domain?: string): Promise<AttentionItem[]> {
  const result = await gateway.execute({
    identity, tool_id: "executive", action: "get_attention_queue", parameters: domain ? { domain } : {}
  });
  if (!result.ok) throw new Error(`unexpected_denial:${result.reason}`);
  return result.data as unknown as AttentionItem[];
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-executive-"));
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
  await adminPool.query("CREATE ROLE jarvis_executive_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_executive_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Executive A','business'), ('${TENANT_B}','Executive B','business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias'), ('${OTHER}','Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT_A}'), ('${OWNER}','${TENANT_B}'), ('${OTHER}','${TENANT_A}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_executive_test", password: "pw2" });
  killSwitch = new KillSwitch();
  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(appPool),
    killSwitch,
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A, TENANT_B] }
  });
  domainPauses = new DomainPauseRegistry(appPool, { owner_person_id: OWNER });
  await domainPauses.restore();
  engine = new SituationEngine(appPool, domainPauses, { owner_person_id: OWNER });
}, 240_000);

beforeEach(async () => {
  gateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of situationsToolDefinitions(new SituationsTransport(engine, domainPauses))) gateway.register(tool);
  executiveService = new ExecutiveService(gateway);
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(executiveService))) gateway.register(tool);
  // K1 (D-164): egen, poolless owner_controls-instans PER TEST (isolert fra den
  // delte `killSwitch`/`policy` som G-blokken under IKKE skal forurense) -
  // beviser KUN at `executive.get_control_surface_status` komponerer korrekt,
  // ikke selve durabiliteten (dekket separat av @jarvis/policy sine egne
  // `*Durable()`-tester + K1 sin dedikerte A-J-suite).
  const controlKillSwitch = new KillSwitch();
  const controlOwnerControls = new OwnerControls(controlKillSwitch);
  for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(new OwnerControlsService(controlKillSwitch, controlOwnerControls)))) {
    gateway.register(tool);
  }
  await adminPool.query(`DELETE FROM situations WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  await adminPool.query(`DELETE FROM situation_autonomy_policies WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  await adminPool.query(`DELETE FROM situation_notification_policies WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`);
  await adminPool.query(`DELETE FROM situation_domain_pauses`);
  await domainPauses.restore();
});

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
});

describe("A: attention-queue komponerer situations.get_queue, ALDRI en egen kilde eller kopi", () => {
  it("en situasjon seedet DIREKTE via SituationEngine.evaluateCandidate() vises umiddelbart i executive.get_attention_queue - null egen ingestion/kopi", async () => {
    const s = await seedSituation(TENANT_A, "business", { domain: "spend", priority: "high", confidence: 0.9, reason: "Uvanlig utgift" });
    const items = await getQueueViaExecutive(ownerA);
    const found = items.find((i) => i.situation_id === s.situation_id);
    expect(found).toBeDefined();
    expect(found!.domain).toBe("spend");
    expect(found!.reason).toBe("Uvanlig utgift");
    expect(found!.action_kind).toBe("suggest"); // high+konfidens>=0.75 -> suggest (computeTargetStage)
  });
  it("domain-filteret videresendes til situations.get_queue - ingen egen filtreringslogikk som kan divergere", async () => {
    await seedSituation(TENANT_A, "business", { domain: "spend" });
    await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    const spendOnly = await getQueueViaExecutive(ownerA, "spend");
    expect(spendOnly.every((i) => i.domain === "spend")).toBe(true);
    expect(spendOnly.length).toBeGreaterThan(0);
  });
  it("REPLAY: to identiske kall i rad gir samme rangerte rekkefølge/score (ingen skjult, muterende tilstand i selve lesingen)", async () => {
    await seedSituation(TENANT_A, "business", { domain: "spend", priority: "high", confidence: 0.9 });
    await seedSituation(TENANT_A, "business", { domain: "pipeline", priority: "low" });
    const run1 = await getQueueViaExecutive(ownerA);
    const run2 = await getQueueViaExecutive(ownerA);
    expect(run1.map((i) => [i.situation_id, i.score, i.rank])).toEqual(run2.map((i) => [i.situation_id, i.score, i.rank]));
  });
});

describe("B: tenant- og memory-space-isolasjon (samme garantier som situations selv, ikke svakere)", () => {
  it("tenant-isolasjon: eieren i tenant A ser ALDRI tenant B sine situasjoner via executive", async () => {
    const sitA = await seedSituation(TENANT_A, "business", { domain: "spend" });
    const sitB = await seedSituation(TENANT_B, "business", { domain: "spend" });
    const itemsA = await getQueueViaExecutive(ownerA);
    const itemsB = await getQueueViaExecutive(ownerB);
    expect(itemsA.some((i) => i.situation_id === sitA.situation_id)).toBe(true);
    expect(itemsA.some((i) => i.situation_id === sitB.situation_id)).toBe(false);
    expect(itemsB.some((i) => i.situation_id === sitB.situation_id)).toBe(true);
    expect(itemsB.some((i) => i.situation_id === sitA.situation_id)).toBe(false);
  });
  it("memory-space-isolasjon: samme tenant, business vs personal - ingen kryssblanding", async () => {
    const sitBiz = await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    const sitPersonal = await seedSituation(TENANT_A, "personal", { domain: "home" });
    const bizItems = await getQueueViaExecutive(ownerA);
    const personalItems = await getQueueViaExecutive(ownerAPersonal);
    expect(bizItems.some((i) => i.situation_id === sitBiz.situation_id)).toBe(true);
    expect(bizItems.some((i) => i.situation_id === sitPersonal.situation_id)).toBe(false);
    expect(personalItems.some((i) => i.situation_id === sitPersonal.situation_id)).toBe(true);
    expect(personalItems.some((i) => i.situation_id === sitBiz.situation_id)).toBe(false);
  });
});

describe("C: eier-autoritet, forfalsket identitet, PolicyGateway/ToolGateway-bypass er strukturelt umulig", () => {
  it("en identitet for en tenant UTEN data får et gyldig, TOMT resultat (RLS - tenant-isolasjon, IKKE et policy-avslag) - dokumenterer den REELLE grensen: lesing er RLS-skopet, PolicyGateway gater mutasjoner", async () => {
    const noDataTenant = identityFor("tenant-without-any-data", "business");
    await expect(executiveService.getAttentionQueue(noDataTenant)).resolves.toEqual([]);
  });
  it("global KillSwitch nekter OGSÅ lesing gjennom executive - ExecutiveAccessDeniedError, aldri en stille tom kø som skjuler at gaten var aktiv", async () => {
    await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    killSwitch.activate("test");
    try {
      await expect(executiveService.getAttentionQueue(ownerA)).rejects.toBeInstanceOf(ExecutiveAccessDeniedError);
    } finally {
      killSwitch.deactivate();
    }
  });
  it("pause_domain via executive som en IKKE-eier nektes (motorens sovereign-autoritet, videreført transitivt)", async () => {
    await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    const result = await gateway.execute({
      identity: otherA, tool_id: "executive", action: "pause_domain", parameters: { domain: "pipeline", reason: "forsøk" }
    });
    expect(result.ok).toBe(false);
    expect(domainPauses.isPaused("pipeline")).toBe(false);
  });
  it("forfalskede identitetsfelt i PARAMETRE avvises av ToolGateway (strict skjema) FØR transporten nås - aldri brukt til autorisasjon", async () => {
    const result = await gateway.execute({
      identity: ownerA, tool_id: "executive", action: "pause_domain",
      parameters: { domain: "pipeline", reason: "test", tenant_id: TENANT_B, actor_person_id: OTHER } as never
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_parameters");
  });
  it("manglende invocation-context feiler lukket (transport kalt direkte uten context)", async () => {
    const transport = new ExecutiveTransport(executiveService);
    await expect(transport.invoke("get_attention_queue", {}, "cred")).rejects.toThrow("executive_missing_invocation_context");
  });
});

describe("D: pause/resume gjennom KANONISK situations.* - ingen parallell pauseregistrering", () => {
  it("executive.pause_domain muterer DEN SAMME situation_domain_pauses-tilstanden som situations.get_pause_state ser", async () => {
    const paused = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "pause_domain", parameters: { domain: "spend", reason: "eier pauset" } });
    expect(paused.ok).toBe(true);
    const direct = await gateway.execute({ identity: ownerA, tool_id: "situations", action: "get_pause_state", parameters: {} });
    if (!direct.ok) throw new Error("unexpected_denial");
    expect((direct.data as { paused: string[] }).paused).toContain("spend");
    expect(domainPauses.isPaused("spend")).toBe(true);
    const resumed = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "resume_domain", parameters: { domain: "spend" } });
    expect(resumed.ok).toBe(true);
    expect(domainPauses.isPaused("spend")).toBe(false);
  });
  it("gjentatt pause_domain via executive skaper INGEN duplikat-rad og utløser INGEN varsel-sideeffekt (kun ren tilstand)", async () => {
    await gateway.execute({ identity: ownerA, tool_id: "executive", action: "pause_domain", parameters: { domain: "spend", reason: "1" } });
    await gateway.execute({ identity: ownerA, tool_id: "executive", action: "pause_domain", parameters: { domain: "spend", reason: "2" } });
    const { rows } = await adminPool.query("SELECT count(*)::int AS n FROM situation_domain_pauses WHERE domain = 'spend'");
    expect((rows[0] as { n: number }).n).toBe(1);
    await gateway.execute({ identity: ownerA, tool_id: "executive", action: "resume_domain", parameters: { domain: "spend" } });
  });
  it("PAUSET domene gjenspeiles korrekt i attention-køen: authority_status.domain_paused=true og anbefalingen sier 'pauset'", async () => {
    const s = await seedSituation(TENANT_A, "business", { domain: "spend", priority: "high", confidence: 0.9 });
    await gateway.execute({ identity: ownerA, tool_id: "executive", action: "pause_domain", parameters: { domain: "spend", reason: "eier pauset" } });
    const items = await getQueueViaExecutive(ownerA);
    const item = items.find((i) => i.situation_id === s.situation_id)!;
    expect(item.authority_status.domain_paused).toBe(true);
    expect(item.recommended_next_action).toMatch(/pauset/);
    await gateway.execute({ identity: ownerA, tool_id: "executive", action: "resume_domain", parameters: { domain: "spend" } });
  });
});

describe("E: resolve/stale-håndtering - løste situasjoner forsvinner fra attention-køen (ingen degradert, misvisende rangering)", () => {
  it("situations.resolve (direkte) fjerner situasjonen fra en ETTERFØLGENDE executive.get_attention_queue", async () => {
    const s = await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    expect((await getQueueViaExecutive(ownerA)).some((i) => i.situation_id === s.situation_id)).toBe(true);
    const resolved = await gateway.execute({ identity: ownerA, tool_id: "situations", action: "resolve", parameters: { situation_id: s.situation_id } });
    expect(resolved.ok).toBe(true);
    expect((await getQueueViaExecutive(ownerA)).some((i) => i.situation_id === s.situation_id)).toBe(false);
  });
  it("executive.resolve_situation (gjennomslag) gir SAMME utfall som en direkte situations.resolve", async () => {
    const s = await seedSituation(TENANT_A, "business", { domain: "pipeline" });
    const result = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "resolve_situation", parameters: { situation_id: s.situation_id } });
    expect(result.ok).toBe(true);
    expect((await getQueueViaExecutive(ownerA)).some((i) => i.situation_id === s.situation_id)).toBe(false);
  });
  it("get_attention_item for et løst/ukjent situation_id gir null-lignende avslag (attention_item_not_found), aldri en stale kopi", async () => {
    const result = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "get_attention_item", parameters: { situation_id: "sit-does-not-exist" } });
    expect(result.ok).toBe(false);
  });
});

describe("F: get_attention_item viser full begrunnelse + underliggende situation - uten et separat oppslag", () => {
  it("inneholder explanation, recommended_next_action OG selve kilde-situation-raden", async () => {
    const s = await seedSituation(TENANT_A, "business", { domain: "spend", priority: "high", confidence: 0.9, reason: "Uvanlig utgift oppdaget" });
    const result = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "get_attention_item", parameters: { situation_id: s.situation_id } });
    if (!result.ok) throw new Error("unexpected_denial");
    const item = result.data as unknown as { explanation: string[]; recommended_next_action: string; situation: { situation_id: string; reason: string } };
    expect(item.explanation.length).toBeGreaterThan(0);
    expect(item.recommended_next_action.length).toBeGreaterThan(0);
    expect(item.situation.situation_id).toBe(s.situation_id);
    expect(item.situation.reason).toBe("Uvanlig utgift oppdaget");
  });
});

describe("G: get_control_surface_status (K1, D-164) - komponerer owner_controls.get_control_state OG situations.get_pause_state, ALDRI en egen tredje kilde", () => {
  async function getStatusViaExecutive(identity: IdentityContext): Promise<ControlSurfaceStatus> {
    const result = await gateway.execute({ identity, tool_id: "executive", action: "get_control_surface_status", parameters: {} });
    if (!result.ok) throw new Error(`unexpected_denial:${result.reason}`);
    return result.data as unknown as ControlSurfaceStatus;
  }

  it("baseline: kill switch inaktiv, ingen frys/tilbakekall, ingen pausede domener", async () => {
    const status = await getStatusViaExecutive(ownerA);
    expect(status.owner_control.kill_switch.active).toBe(false);
    expect(status.owner_control.frozen_connectors).toEqual([]);
    expect(status.owner_control.revoked_credentials).toEqual([]);
    expect(status.situation_domain_pauses.paused).toEqual([]);
  });

  it("aktivert kill switch (via owner_controls.activate_kill_switch) gjenspeiles i owner_control.kill_switch, med reason/actor", async () => {
    const activated = await gateway.execute({
      identity: ownerA, tool_id: "owner_controls", action: "activate_kill_switch", parameters: { reason: "test-k1-g" }
    });
    expect(activated.ok).toBe(true);
    const status = await getStatusViaExecutive(ownerA);
    expect(status.owner_control.kill_switch.active).toBe(true);
    expect(status.owner_control.kill_switch.reason).toBe("test-k1-g");
    // `actor_person_id` er KUN spor-bart via det VARIGE (pool-baserte) laget - denne poolless
    // test-instansen speiler bevisst KUN in-memory tilstand (se KillSwitch.currentStateDurable()
    // sitt filhode) - null her er FORVENTET, ikke en regresjon. Selve actor-sporingen for den
    // EKTE, durable instansen er dekket av @jarvis/policy sine egne kill-switch-tester.
    expect(status.owner_control.kill_switch.actor_person_id).toBeNull();
    const deactivated = await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "deactivate_kill_switch", parameters: {} });
    expect(deactivated.ok).toBe(true);
  });

  it("frosset connector OG tilbakekalt credential vises SAMTIDIG i owner_control, uavhengig av kill switch-tilstand", async () => {
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "github", reason: "g-test" } });
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "revoke_credential", parameters: { credential_ref: "cred-g-test", reason: "g-test" } });
    const status = await getStatusViaExecutive(ownerA);
    expect(status.owner_control.kill_switch.active).toBe(false);
    expect(status.owner_control.frozen_connectors.map((c) => c.connector_id)).toContain("github");
    expect(status.owner_control.revoked_credentials.map((c) => c.credential_ref)).toContain("cred-g-test");
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "github" } });
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "restore_credential", parameters: { credential_ref: "cred-g-test" } });
  });

  it("situations-domenepause (UA-10) OG global owner_control forblir DISTINKTE lag i samme, ETT samlede svar - ingen krysskorrupsjon", async () => {
    await gateway.execute({ identity: ownerA, tool_id: "situations", action: "pause_domain", parameters: { domain: "spend", reason: "g-test-pause" } });
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: "slack", reason: "g-test" } });
    const status = await getStatusViaExecutive(ownerA);
    expect(status.situation_domain_pauses.paused).toContain("spend");
    expect(status.owner_control.frozen_connectors.map((c) => c.connector_id)).toContain("slack");
    // domenepause og connector-frys er ALDRI samme tilstand - hver kan avsluttes uavhengig av den andre.
    await gateway.execute({ identity: ownerA, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: "slack" } });
    const afterUnfreeze = await getStatusViaExecutive(ownerA);
    expect(afterUnfreeze.situation_domain_pauses.paused).toContain("spend"); // pause overlever unrelatert unfreeze
    expect(afterUnfreeze.owner_control.frozen_connectors.map((c) => c.connector_id)).not.toContain("slack");
    await gateway.execute({ identity: ownerA, tool_id: "situations", action: "unpause_domain", parameters: { domain: "spend" } });
  });

  it("global KillSwitch (samme instans policy.authorize() sjekker) nekter OGSÅ get_control_surface_status - ingen stille tom status som skjuler at gaten var aktiv", async () => {
    killSwitch.activate("g-block-test");
    try {
      const result = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "get_control_surface_status", parameters: {} });
      expect(result.ok).toBe(false);
    } finally {
      killSwitch.deactivate();
    }
  });
});
