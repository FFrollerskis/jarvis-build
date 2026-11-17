import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ChannelSessionAuthority, DeviceService, IdentityService, SessionGrantService, SessionService } from "@jarvis/core";
import { EVOLUTION_DECISION_AUDIT_TYPE, ExecutiveService, ExecutiveTransport, executiveToolDefinitions, type ControlCenterReport } from "@jarvis/executive";
import { providerProducer } from "@jarvis/incidents";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ChangeLedger, evaluateAllReadiness, type ReadinessFacts } from "@jarvis/self-modification";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import type { Ev0BootStatus } from "../src/ev0-boot.ts";
import { createEvolutionDecisionRecorder } from "../src/evolution-decisions.ts";
import { connectorStatusesFromGateway } from "../src/incident-producers.ts";
import { CONTROL_CENTER_FLAGS, CONTROL_FEATURE_FLAGS, createControlCenterRegistry, registerControlCenters } from "../src/control-center/register.ts";
import { controlCentersWithTools, flagOn } from "../src/control-center/shared.ts";
import { createApiServer } from "../src/server.ts";
import { generateDeviceKey, mintGrant, type TestDeviceKey } from "./support/grant-client.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-B3 (D-475, EV-23) - ATFERD over ekte HTTP + ekte Postgres (app-rolle, RLS) + ekte ToolGateway/PolicyGateway + ekte enhetssignerte grants: `executive.record_evolution_decision` via `/executive/mutate`.
 *  - FLAGG AV (både «ingen av dem» og «senteret på, avgjørelser av»): navnet er et ukjent navn for ruten - NØYAKTIG samme svar som et hvilket som helst annet ukjent navn (400 `action_not_allowed` FØR grantet løses), ingen revisjonsrad;
 *  - AVSLAGSREKKEFØLGE: handling → grant → step-up (signert enhet fra en eier-kanal) → verktøyets port (eier + signert økt) → strengt skjema → skriveren; avslag skriver aldri en avgjørelse;
 *  - EIEREN: 200, nøyaktig én avgjørelsesrad (+ gatewayens egen utførelsesrad), idempotent, ombestemmelse med før-bilde; knappene fra senteret er KROPPER ruten godtar;
 *  - skriveren avviser utdatert versjon, lukket/ukjent forslag og E3-godkjenning med FASTE koder; kill switch stanser;
 *  - endringsregisteret er urørt og ingenting aktiveres.
 */
let db: H0Db;
let on: Stack;
let centerOnly: Stack;
let off: Stack;
let killSwitch: KillSwitch;
let policy: PolicyGateway;
let ownerControls: OwnerControls;
const closers: Array<() => Promise<void>> = [];

const TENANT_A = "tenant-b3r-a";
const TENANT_B = "tenant-b3r-b";
const OWNER = "person-b3r-owner";
const MEMBER = "person-b3r-member";
const STRANGER = "person-b3r-b";
const authority = { owner_person_id: OWNER, owner_tenants: [TENANT_A] };
const keys: Record<string, TestDeviceKey> = { "b3r-dev-owner": generateDeviceKey(), "b3r-dev-member": generateDeviceKey(), "b3r-dev-b": generateDeviceKey(), "b3r-dev-owner-tg": generateDeviceKey() };
const SUBJECTS = {
  owner: { device_id: "b3r-dev-owner", person_id: OWNER, tenant_id: TENANT_A, memory_space: "personal" },
  member: { device_id: "b3r-dev-member", person_id: MEMBER, tenant_id: TENANT_A, memory_space: "personal" },
  stranger: { device_id: "b3r-dev-b", person_id: STRANGER, tenant_id: TENANT_B, memory_space: "personal" }
} as const;
const grants: Record<keyof typeof SUBJECTS, string> = { owner: "", member: "", stranger: "" };
let weakGrant: string | undefined;
const secrets: SecretProvider = { name: "fake", get: async () => "fake" };
const FACTS: ReadinessFacts = { constitution_verified: true, ledger_ok: true, change_freeze_off: true, proven_connectors: 0, job_runner_configured: false, declared_gates: new Set<string>() };
const BOOT: Ev0BootStatus = { constitution: { status: "verified", version: 1, digest: "a".repeat(64) }, ledger: { status: "ok", count: 3, head_hash: "b".repeat(64) } };
const DIGEST = "c".repeat(64);
const ENV_ON: Record<string, string> = { [CONTROL_CENTER_FLAGS.evolution]: "on", [CONTROL_FEATURE_FLAGS.evolutionApproval]: "on" };
const ENV_CENTER_ONLY: Record<string, string> = { [CONTROL_CENTER_FLAGS.evolution]: "on" };
const hashes = new Map<string, string>();

interface Stack { baseUrl: string; gateway: ToolGateway }
interface Resp { status: number; body: Record<string, unknown> }

async function startStack(env: Record<string, string>): Promise<Stack> {
  const gateway = new ToolGateway(db.appPool, policy, secrets);
  const registry = createControlCenterRegistry({ authority });
  registerControlCenters(registry, {
    pool: db.appPool, env, toolGateway: gateway, ownerControls, killSwitch, authority,
    evolutionReport: async () => ({ as_of: new Date().toISOString(), sections: [] }), evolutionReadiness: async () => evaluateAllReadiness(FACTS), ev0Status: () => BOOT, evolutionTenantId: TENANT_A
  });
  // SAMME kobling som main.ts: skriveren og verktøyet finnes KUN med flagget på OG et registrert Evolusjon-senter.
  const approvalOn = flagOn(env, CONTROL_FEATURE_FLAGS.evolutionApproval) && registry.has("evolution");
  const service = new ExecutiveService(gateway, { controlCenters: registry, ...(approvalOn ? { evolutionDecisions: createEvolutionDecisionRecorder(db.appPool) } : {}) });
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(service), { controlCenters: controlCentersWithTools(env, registry), evolutionApproval: approvalOn })) gateway.register(tool);

  const identityService = new IdentityService(db.appPool);
  const sessionService = new SessionService(db.appPool);
  const deviceService = new DeviceService(db.appPool);
  const grantService = new SessionGrantService(db.appPool);
  const server = createApiServer({
    identity: identityService, sessions: sessionService, devices: deviceService, grants: grantService,
    channelAuthority: new ChannelSessionAuthority({ pool: db.appPool, devices: deviceService, sessions: sessionService, identity: identityService, grants: grantService }),
    policy: {} as never, worker: {} as never, conversation: {} as never, executive: { gateway },
    rateLimits: { perIpPerMinute: 100_000, authPerIpPerMinute: 100_000, perDevicePerMinute: 100_000 },
    owner: { tenant_id: TENANT_A, person_id: OWNER }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, gateway };
}

async function post(stack: Stack, path: string, body: unknown): Promise<Resp> {
  const res = await fetch(`${stack.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { parsed = { __raw: text }; }
  return { status: res.status, body: parsed };
}
const mutate = (stack: Stack, grant: string, action: string, parameters: Record<string, unknown> = {}): Promise<Resp> => post(stack, "/executive/mutate", { grant_token: grant, action, parameters });
const decide = (stack: Stack, grant: string, change_id: string, decision: string, digest?: string): Promise<Resp> =>
  mutate(stack, grant, "record_evolution_decision", { change_id, proposal_digest: digest ?? hashes.get(change_id) ?? DIGEST, decision });
const center = async (stack: Stack, grant: string): Promise<{ status: number; report?: ControlCenterReport | undefined; raw: Resp }> => {
  const r = await post(stack, "/control/center", { grant_token: grant, center: "evolution" });
  return { status: r.status, report: (r.body["data"] as { report?: ControlCenterReport } | undefined)?.report, raw: r };
};

const decisionRows = async (changeId?: string): Promise<Array<{ person_id: string; tenant_id: string; payload: Record<string, unknown> }>> => {
  const rows = (await db.adminPool.query("SELECT person_id, tenant_id, payload FROM audit_events WHERE type = $1 ORDER BY audit_events.audit_id", [EVOLUTION_DECISION_AUDIT_TYPE])).rows as Array<{ person_id: string; tenant_id: string; payload: Record<string, unknown> }>;
  return rows.filter((r) => changeId === undefined || r.payload["change_id"] === changeId);
};
const auditRows = async (type: string, action: string): Promise<Array<{ reason: string | null; person_id: string }>> =>
  (await db.adminPool.query("SELECT reason, person_id FROM audit_events WHERE type = $1 AND tool_id = 'executive' AND action = $2 ORDER BY audit_events.audit_id", [type, action])).rows as Array<{ reason: string | null; person_id: string }>;
const ledgerCount = async (): Promise<number> => Number((await db.adminPool.query("SELECT count(*) AS n FROM evolution_change_ledger")).rows[0].n);
const latestLedger = async (changeId: string): Promise<string> => String((await db.adminPool.query("SELECT decision FROM evolution_change_ledger WHERE change_id = $1 ORDER BY seq DESC LIMIT 1", [changeId])).rows[0].decision);

beforeAll(async () => {
  db = await startH0Db("b3r");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: OWNER }, { tenant_id: TENANT_B, person_id: STRANGER }]);
  await admin.query("INSERT INTO people (person_id, display_name) VALUES ($1, $1)", [MEMBER]);
  await admin.query("INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ($1, $2, 'member')", [MEMBER, TENANT_A]);
  await admin.query(`INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-b3r-a-p','${TENANT_A}','personal'), ('sp-b3r-b-p','${TENANT_B}','personal')`);
  for (const [id, subject] of [["b3r-dev-owner", SUBJECTS.owner], ["b3r-dev-member", SUBJECTS.member], ["b3r-dev-b", SUBJECTS.stranger], ["b3r-dev-owner-tg", SUBJECTS.owner]] as const) {
    await admin.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,'api',$4)", [id, subject.tenant_id, subject.person_id, keys[id]!.publicKeyPem]);
  }
  killSwitch = new KillSwitch(db.appPool, { owner_person_id: OWNER });
  await killSwitch.restore();
  ownerControls = new OwnerControls(killSwitch, db.appPool, { owner_person_id: OWNER });
  await ownerControls.restore();
  policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, authority });

  const ledger = new ChangeLedger(admin);
  const row = (change_id: string, change_class: "E0" | "E1" | "E2" | "E3", decision: "proposed" | "rejected") =>
    ledger.append({ change_id, change_class, decision, constitution_digest: DIGEST, subject: "HEMMELIG FORSLAGSTEKST", paths: ["config/hemmelig.json"], branch: "", head_sha: null, evidence: {}, recorded_by: "test" });
  for (const [id, cls] of [["r1", "E1"], ["r2", "E3"], ["r4", "E2"], ["r5", "E2"], ["r6", "E1"]] as const) {
    await row(id, cls, "proposed");
    hashes.set(id, String((await admin.query("SELECT entry_hash FROM evolution_change_ledger WHERE change_id = $1 ORDER BY seq DESC LIMIT 1", [id])).rows[0].entry_hash));
  }
  await row("r3", "E2", "proposed"); await row("r3", "E2", "rejected");
  hashes.set("r3", String((await admin.query("SELECT entry_hash FROM evolution_change_ledger WHERE change_id = 'r3' ORDER BY seq DESC LIMIT 1")).rows[0].entry_hash));

  on = await startStack(ENV_ON);
  centerOnly = await startStack(ENV_CENTER_ONLY);
  off = await startStack({});
  grants.owner = await mintGrant(on.baseUrl, SUBJECTS.owner, keys["b3r-dev-owner"]!);
  grants.member = await mintGrant(on.baseUrl, SUBJECTS.member, keys["b3r-dev-member"]!);
  grants.stranger = await mintGrant(on.baseUrl, SUBJECTS.stranger, keys["b3r-dev-b"]!);
  try { weakGrant = await mintGrant(on.baseUrl, { ...SUBJECTS.owner, device_id: "b3r-dev-owner-tg", channel: "telegram" }, keys["b3r-dev-owner-tg"]!); } catch { weakGrant = undefined; }
}, 240_000);

afterAll(async () => {
  for (const close of closers) await close();
  await db?.stop();
}, 120_000);

describe("A: flagg AV = ukjent navn for ruten (nøyaktig som main), ingen rad", () => {
  it("uten noen av flaggene OG med bare senter-flagget: 400 `action_not_allowed` - SAMME svar som et hvilket som helst ukjent navn - selv med eierens gyldige grant", async () => {
    const unknown = await mutate(off, grants.owner, "totally_unknown_action", {});
    expect(unknown).toMatchObject({ status: 400, body: { error: "malformed_request", reason: "action_not_allowed" } });
    for (const stack of [off, centerOnly]) {
      const r = await decide(stack, grants.owner, "r1", "approve");
      expect(r.status).toBe(unknown.status);
      expect(r.body).toEqual(unknown.body);
    }
    expect(await decisionRows()).toHaveLength(0);
    expect(await auditRows("tool.denied", "record_evolution_decision")).toHaveLength(0);
    expect(await auditRows("tool.executed", "record_evolution_decision")).toHaveLength(0);
  });

  it("verktøyet finnes ikke i gatewayen med flagget AV; med flagget PÅ finnes det", () => {
    expect(off.gateway.get("executive", "record_evolution_decision")).toBeUndefined();
    expect(centerOnly.gateway.get("executive", "record_evolution_decision")).toBeUndefined();
    expect(on.gateway.get("executive", "record_evolution_decision")).toMatchObject({ capability_class: "C", step_up_required: true });
  });

  it("og senteret uten avgjørelser har ingen knapper (flagget AV): `/control/center` gir samme senter som EV-22", async () => {
    const c = await center(centerOnly, grants.owner);
    expect(c.status).toBe(200);
    expect(c.report?.actions).toEqual([]);
  });
});

describe("B: avslagsrekkefølge (handling → grant → step-up → verktøyets port → strengt skjema)", () => {
  it("navnet er kjent (flagg PÅ), men en bogus grant avvises som identity_denied, og et manglende grant som 401 - FØR noe annet", async () => {
    const bogus = await decide(on, "bogus", "r1", "approve");
    expect(bogus.status).toBe(403);
    expect(bogus.body["error"]).toBe("identity_denied");
    expect((await post(on, "/executive/mutate", { action: "record_evolution_decision" })).status).toBe(401);
  });

  it("step-up: en svakere kanal (Telegram) nektes FØR verktøyet nås - ingen avgjørelse, ingen `tool.denied`-rad fra verktøyet", async () => {
    expect(weakGrant, "grant fra en Telegram-kanal kunne ikke utstedes - da ville step-up-testen vært hul").toBeDefined();
    const deniedBefore = (await auditRows("tool.denied", "record_evolution_decision")).length;
    const r = await decide(on, weakGrant as string, "r1", "approve");
    expect(r.status).toBe(403);
    expect(r.body["error"]).toBe("step_up_required");
    expect(await decisionRows()).toHaveLength(0);
    expect((await auditRows("tool.denied", "record_evolution_decision")).length).toBe(deniedBefore);
  });

  it("ikke-eiere nektes av verktøyets port: et medlem i samme tenant og en annen tenants eier - `tool.denied` med årsak, ingen avgjørelse", async () => {
    const deniedBefore = (await auditRows("tool.denied", "record_evolution_decision")).length;
    for (const grant of [grants.member, grants.stranger]) {
      const r = await decide(on, grant, "r1", "approve");
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: "tool_denied" });
    }
    expect(await decisionRows()).toHaveLength(0);
    const denied = await auditRows("tool.denied", "record_evolution_decision");
    expect(denied.length).toBe(deniedBefore + 2);
    expect(denied.slice(-2).map((d) => d.person_id).sort()).toEqual([MEMBER, STRANGER].sort());
  });

  it("strengt skjema: manglende/ekstra felt, identitetsfelt, ugyldig avgjørelse og ugyldig versjon gir invalid_parameters - ingen avgjørelse", async () => {
    const good = { change_id: "r1", proposal_digest: hashes.get("r1"), decision: "approve" };
    const bads: Array<Record<string, unknown>> = [
      {}, { change_id: "r1" }, { ...good, tenant_id: TENANT_B }, { ...good, person_id: STRANGER }, { ...good, memory_space: "business" }, { ...good, decision: "execute" }, { ...good, decision: "merge" },
      { ...good, proposal_digest: "abc" }, { ...good, proposal_digest: String(hashes.get("r1")).toUpperCase() }, { ...good, change_id: "x".repeat(61) }, { ...good, activate: true }, { ...good, effect: "execute" }
    ];
    for (const parameters of bads) {
      const r = await mutate(on, grants.owner, "record_evolution_decision", parameters);
      expect(r.status, JSON.stringify(parameters)).toBe(403);
      expect(r.body, JSON.stringify(parameters)).toMatchObject({ error: "tool_denied", reason: "invalid_parameters" });
    }
    expect(await decisionRows()).toHaveLength(0);
  });
});

describe("C: eieren fra en signert enhet - nøyaktig én rad, idempotent, ombestemmelse med før-bilde", () => {
  it("godkjenn r1: 200, svaret har fast norsk tekst først og sier ingen virkning; revisjonssporet har EN avgjørelsesrad (+ gatewayens utførelsesrad); endringsregisteret er urørt", async () => {
    const ledgerBefore = await ledgerCount();
    const r = await decide(on, grants.owner, "r1", "approve");
    expect(r.status).toBe(200);
    expect(r.body["ok"]).toBe(true);
    const data = r.body["data"] as Record<string, unknown>;
    expect(Object.keys(data)[0]).toBe("summary_no");
    expect(String(data["summary_no"])).toContain("INGEN virkning");
    expect(data).toMatchObject({ outcome: "recorded", decision: "approve", change_id: "r1", previous_decision: null, effect: "none", activation_decision: false });
    const rows = await decisionRows("r1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ person_id: OWNER, tenant_id: TENANT_A });
    expect(rows[0]?.payload).toMatchObject({ decision: "approve", proposal_digest: hashes.get("r1"), before: { decision: null }, effect: "none", activation_decision: false, auth_strength: "signed" });
    expect((await auditRows("tool.executed", "record_evolution_decision")).length).toBeGreaterThanOrEqual(1);
    expect(await ledgerCount()).toBe(ledgerBefore);
    expect(await latestLedger("r1")).toBe("proposed");
  });

  it("samme klikk igjen: 200 `already_recorded` og fortsatt kun én avgjørelsesrad; en ny avgjørelse overstyrer med før-bilde", async () => {
    const again = await decide(on, grants.owner, "r1", "approve");
    expect(again.status).toBe(200);
    expect(again.body["data"]).toMatchObject({ outcome: "already_recorded", previous_decision: "approve" });
    expect(await decisionRows("r1")).toHaveLength(1);
    const changed = await decide(on, grants.owner, "r1", "defer");
    expect(changed.body["data"]).toMatchObject({ outcome: "recorded", decision: "defer", previous_decision: "approve" });
    const rows = await decisionRows("r1");
    expect(rows.map((x) => x.payload["decision"])).toEqual(["approve", "defer"]);
    expect((rows[1]?.payload["before"] as { decision: string }).decision).toBe("approve");
  });

  it("senteret over HTTP viser avgjørelsen, skjuler knappen for den gjeldende, og HVER knapp-kropp er en kropp ruten godtar (knapp → rute)", async () => {
    const c = await center(on, grants.owner);
    expect(c.status).toBe(200);
    const row = c.report?.sections.find((s) => s.id === "ledger")?.items.find((i) => i.id === "proposal:r1");
    expect(row?.facts).toMatchObject({ owner_decision: "defer" });
    const forR1 = (c.report?.actions ?? []).filter((a) => a.item_id === "proposal:r1");
    expect(forR1.map((a) => (a.body["parameters"] as { decision: string }).decision)).toEqual(["approve", "reject"]);
    expect(forR1.every((a) => a.risk_class === "C" && a.requires_step_up && a.endpoint === "/executive/mutate")).toBe(true);
    // r2 er E3: aldri en godkjenn-knapp
    expect((c.report?.actions ?? []).filter((a) => a.item_id === "proposal:r2").map((a) => (a.body["parameters"] as { decision: string }).decision)).toEqual(["reject", "defer"]);
    // trykk på en knapp = post nøyaktig kroppen fra rapporten
    const press = forR1[0]!;
    const r = await mutate(on, grants.owner, String(press.body["action"]), press.body["parameters"] as Record<string, unknown>);
    expect(r.status).toBe(200);
    expect(r.body["data"]).toMatchObject({ outcome: "recorded", decision: "approve", previous_decision: "defer" });
  });
});

describe("D: skriveren avviser med FASTE koder - aldri en avgjørelse", () => {
  // Skriverens avslag KASTES (samme mønster som `revoke_autonomy_binding`): gatewayen svarer `tool_failed:<fast kode>` og skriver `tool.failed` med den samme faste koden - aldri tekst fra data.
  // Kjent begrensning: et kastet avslag merker verktøyets helse (`executive`) som utilgjengelig til neste vellykkede kall (kun informasjon i statusrapportene; helse styrer aldri utførelse).
  const expectRefusal = async (r: Resp, code: string): Promise<void> => {
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "tool_denied", reason: `tool_failed:${code}` });
  };

  it("utdatert versjon (feil digest), lukket forslag (avvist), ukjent forslag og E3-godkjenning", async () => {
    const before = (await decisionRows()).length;
    await expectRefusal(await decide(on, grants.owner, "r4", "approve", "d".repeat(64)), "proposal_digest_mismatch");
    await expectRefusal(await decide(on, grants.owner, "r3", "approve"), "proposal_not_open");
    await expectRefusal(await decide(on, grants.owner, "finnes-ikke", "approve", DIGEST), "proposal_not_found");
    await expectRefusal(await decide(on, grants.owner, "r2", "approve"), "proposal_class_forbidden");
    expect((await decisionRows()).length).toBe(before);
    expect(await auditRows("tool.failed", "record_evolution_decision")).not.toHaveLength(0);
  });

  it("id med uvanlig form (injeksjonsforsøk) avvises uten at databasen får noe: fast kode og ingen rad", async () => {
    const before = (await decisionRows()).length;
    await expectRefusal(await decide(on, grants.owner, "x'; DROP TABLE audit_events; --", "approve", DIGEST), "invalid_evolution_decision_input");
    expect((await decisionRows()).length).toBe(before);
    expect(Number((await db.adminPool.query("SELECT count(*) AS n FROM audit_events")).rows[0].n)).toBeGreaterThan(0);
  });
});

describe("E: kill switch stanser avgjørelsen - og ingenting aktiveres uansett", () => {
  it("med kill switch aktiv nektes avgjørelsen av policyen (ingen rad); etter opphevelse virker den igjen", async () => {
    const before = (await decisionRows("r5")).length;
    await killSwitch.activateDurable("wpb3-approval", OWNER);
    try {
      const r = await decide(on, grants.owner, "r5", "approve");
      expect(r.status).toBe(403);
      expect(r.body["error"]).toBe("tool_denied");
      expect((await decisionRows("r5")).length).toBe(before);
    } finally {
      await killSwitch.deactivateDurable(OWNER);
    }
    expect((await decide(on, grants.owner, "r5", "approve")).status).toBe(200);
    expect((await decisionRows("r5")).length).toBe(before + 1);
  });

  it("ingen avgjørelse har endret endringsregisteret: ingen forslag er godkjent/merget/deployet, og hash-kjeden er intakt", async () => {
    expect(Number((await db.adminPool.query("SELECT count(*) AS n FROM evolution_change_ledger WHERE decision IN ('approved', 'merged', 'deployed')")).rows[0].n)).toBe(0);
    expect((await new ChangeLedger(db.adminPool).verify()).ok).toBe(true);
    for (const id of ["r1", "r2", "r4", "r5"]) expect(await latestLedger(id), id).toBe("proposed");
  });
});

describe("F: gjennomgang L1/L2 - en modell kan ikke registrere avgjørelsen, og et avslag blir aldri en «Tilkobling svikter: executive»-hendelse", () => {
  // EGEN stabel: verktøyets grense på 10 kall/min er brukt opp av de andre seksjonene, og gatewayens helsekart skal starte tomt (L1).
  let fresh: Stack;
  beforeAll(async () => { fresh = await startStack(ENV_ON); }, 60_000);
  const ownerIdentity: IdentityContext = { person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s-b3r-f", device_id: "b3r-dev-owner", channel: "web", auth_strength: "signed" };
  const exec = (servingModel?: { provider: string; model: string }, digest: string = hashes.get("r6") as string, decision = "defer") =>
    fresh.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "record_evolution_decision", parameters: { change_id: "r6", proposal_digest: digest, decision }, ...(servingModel ? { servingModel } : {}) });
  const observe = (readStatus: () => Promise<Array<{ id: string; display_name: string; configured: boolean; health: { state: string; at: string; detail?: string } | null }>>) =>
    providerProducer({ readStatus }).observe({ tenantId: TENANT_A, memorySpace: "business", now: new Date() }, []);

  it("L2: samme eier og samme gyldige kall - med en modell i løkka (sky ELLER lokal) avvises det med en fast kode og INGEN rad; uten modell (siden) registreres det", async () => {
    const before = (await decisionRows("r6")).length;
    for (const model of [{ provider: "anthropic", model: "claude-test" }, { provider: "gemma_local", model: "gemma-local" }]) {
      const r = await exec(model);
      expect(r.ok, model.provider).toBe(false);
      expect(String((r as { reason?: string }).reason), model.provider).toContain("evolution_decision_model_origin_denied");
    }
    expect((await decisionRows("r6")).length).toBe(before);
    expect((await exec()).ok).toBe(true);
    expect((await decisionRows("r6")).length).toBe(before + 1);
  });

  it("L1: et avslag KASTES og merker `executive` «utilgjengelig» i gatewayen (kjent: helse styrer aldri utførelse) - men det blir ALDRI en hendelse: incident-produsentens statuser har ingen executive-rad", async () => {
    const r = await exec(undefined, "0".repeat(64)); // utdatert versjon: `proposal_digest_mismatch` (kastet av skriveren)
    expect(r.ok).toBe(false);
    expect(String((r as { reason?: string }).reason)).toContain("proposal_digest_mismatch");
    expect(fresh.gateway.health.get("executive")?.state).toBe("unavailable");
    expect(connectorStatusesFromGateway(fresh.gateway).map((s) => s.id)).not.toContain("executive");
    const observation = await observe(async () => connectorStatusesFromGateway(fresh.gateway));
    expect(observation.present.map((f) => f.subject)).not.toContain("executive");
    expect(observation.present.some((f) => /executive/i.test(f.title))).toBe(false);
    // kontroll av selve testen: med den RÅE gateway-helsen (uten filteret) åpner den samme produsenten «Tilkobling svikter: executive»
    const raw = await observe(async () => [...fresh.gateway.health].map(([id, health]) => ({ id, display_name: id, configured: true, health })));
    expect(raw.present.some((f) => f.subject === "executive" && f.title.includes("Tilkobling svikter"))).toBe(true);
  });

  it("raden leges av neste vellykkede executive-kall (siden oppfrisker hvert minutt), og er da ikke lenger noe produsenten kunne sett", async () => {
    expect((await fresh.gateway.execute({ identity: ownerIdentity, tool_id: "executive", action: "get_evolution_center", parameters: {} })).ok).toBe(true);
    expect(fresh.gateway.health.get("executive")?.state).toBe("healthy");
    expect((await observe(async () => [...fresh.gateway.health].map(([id, health]) => ({ id, display_name: id, configured: true, health })))).present.some((f) => f.subject === "executive")).toBe(false);
  });
});
