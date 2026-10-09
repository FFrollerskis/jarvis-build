import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChannelSessionAuthority, DeviceService, IdentityService, SessionGrantService, SessionService, createPool, runMigrations
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  ExecutiveService, ExecutiveTransport, controlAction, controlItem, controlSection, executiveToolDefinitions
} from "@jarvis/executive";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { createApiServer } from "../src/server.ts";
import { generateDeviceKey, mintGrant, type TestDeviceKey } from "./support/grant-client.ts";

/**
 * WP-H0 (UA-11 Admin Control Center) - ATFERD over ekte HTTP + ekte Postgres + ekte ToolGateway/PolicyGateway for skjelettet:
 *  - `POST /control/centers` (oversikt) og `POST /control/center` (ett senter) er LESE-KUN, grant-autentiserte, og følger /executive/query sin avslagsrekkefølge og kroppsdisiplin;
 *  - rapportene leveres KUN til den suverene eieren (en annen person i samme tenant og eier-lignende identitet i en annen tenant nektes av verktøydefinisjonens port, med revisjonsrad);
 *  - et senter som ikke er koblet inn gir 404 (aldri en tom «OK»), og et senter som feiler gir UNKNOWN;
 *  - ingenting skrives i eier-kontrolltilstanden og ingen jobb opprettes (rutene har ingen skriveevne).
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;
let serverWithoutOwner: ReturnType<typeof createApiServer>;
let baseUrlWithoutOwner: string;
let gateway: ToolGateway;
let killSwitch: KillSwitch;

const TENANT_A = "tenant-h0-a";
const TENANT_B = "tenant-h0-b";
const OWNER = "person-h0-owner";
const OTHER = "person-h0-other";
const STRANGER = "person-h0-b";
const keys: Record<string, TestDeviceKey> = { "h0-dev-owner": generateDeviceKey(), "h0-dev-other": generateDeviceKey(), "h0-dev-b": generateDeviceKey() };
const SUBJECTS = {
  owner: { device_id: "h0-dev-owner", person_id: OWNER, tenant_id: TENANT_A, memory_space: "personal" },
  other: { device_id: "h0-dev-other", person_id: OTHER, tenant_id: TENANT_A, memory_space: "personal" },
  stranger: { device_id: "h0-dev-b", person_id: STRANGER, tenant_id: TENANT_B, memory_space: "personal" }
} as const;
const grants: Record<keyof typeof SUBJECTS, string> = { owner: "", other: "", stranger: "" };

async function post(path: string, body: unknown, base = baseUrl): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { parsed = { __raw: text }; }
  return { status: res.status, body: parsed, headers: res.headers };
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-wph0-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_h0 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_h0");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','H0 A','business'), ('${TENANT_B}','H0 B','business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Eier'), ('${OTHER}','Annen'), ('${STRANGER}','Fremmed');
    INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ('${OWNER}','${TENANT_A}','owner'), ('${OTHER}','${TENANT_A}','member'), ('${STRANGER}','${TENANT_B}','owner');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-h0-a','${TENANT_A}','personal'), ('sp-h0-b','${TENANT_B}','personal');`);
  for (const [id, subject] of [["h0-dev-owner", SUBJECTS.owner], ["h0-dev-other", SUBJECTS.other], ["h0-dev-b", SUBJECTS.stranger]] as const) {
    await adminPool.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,'api',$4)", [id, subject.tenant_id, subject.person_id, keys[id]!.publicKeyPem]);
  }
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_h0", password: "pw2" });

  const authority = { owner_person_id: OWNER, owner_tenants: [TENANT_A] };
  killSwitch = new KillSwitch();
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, authority });
  const secrets: SecretProvider = { name: "fake", get: async () => "fake" };
  gateway = new ToolGateway(appPool, policy, secrets);

  // Gjennomgang av PR #316 (M-2): samme fabrikk og SAMME AuthorityConfig som PolicyGateway over - akkurat som main.ts.
  const registry = createControlCenterRegistry({ authority });
  registry.register({
    id: "ai", title_no: "AI", description_no: "Leverandører og ruting",
    build: async () => ({
      sections: [controlSection({ id: "providers", title_no: "Leverandører", source: "modellmeshen", summary_no: "1 leverandør", items: [controlItem({ id: "ollama", label: "Ollama", status: "OK" })] })],
      actions: [controlAction({
        id: "ai.pause:ollama", label: "Pause Ollama", endpoint: "/executive/mutate", body: { action: "freeze_connector", parameters: { connector_id: "model:ollama", reason: "test" } },
        risk_class: "C", requires_step_up: false, reversible: true, description_no: "Pauser Ollama", rollback_no: "Opphev frys", section_id: "providers", item_id: "ollama"
      })]
    })
  });
  registry.register({ id: "integration", title_no: "Integrasjoner", description_no: "Connectorer", build: async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:5432"); } });
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(gateway, { controlCenters: registry })))) gateway.register(tool);

  const identityService = new IdentityService(appPool);
  const sessionService = new SessionService(appPool);
  const deviceService = new DeviceService(appPool);
  const grantService = new SessionGrantService(appPool);
  const deps = {
    identity: identityService, sessions: sessionService, devices: deviceService, grants: grantService,
    channelAuthority: new ChannelSessionAuthority({ pool: appPool, devices: deviceService, sessions: sessionService, identity: identityService, grants: grantService }),
    policy: {} as never, worker: {} as never, conversation: {} as never, executive: { gateway },
    rateLimits: { perIpPerMinute: 100_000, authPerIpPerMinute: 100_000, perDevicePerMinute: 100_000 }
  };
  server = createApiServer({ ...deps, owner: { tenant_id: TENANT_A, person_id: OWNER } });
  serverWithoutOwner = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => serverWithoutOwner.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseUrlWithoutOwner = `http://127.0.0.1:${(serverWithoutOwner.address() as AddressInfo).port}`;
  grants.owner = await mintGrant(baseUrl, SUBJECTS.owner, keys["h0-dev-owner"]!);
  grants.other = await mintGrant(baseUrl, SUBJECTS.other, keys["h0-dev-other"]!);
  grants.stranger = await mintGrant(baseUrl, SUBJECTS.stranger, keys["h0-dev-b"]!);
}, 240_000);

afterAll(async () => {
  for (const s of [server, serverWithoutOwner]) await new Promise<void>((resolve) => { s?.closeAllConnections(); s?.close(() => resolve()); });
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: avslag i samme rekkefølge som /executive/query (kropp → grant → port)", () => {
  it("uten grant → 401 grant_required, på begge rutene", async () => {
    for (const path of ["/control/centers", "/control/center"]) {
      const r = await post(path, path === "/control/center" ? { center: "ai" } : {});
      expect(r.status, path).toBe(401);
      expect(r.body["error"]).toBe("grant_required");
    }
  });

  it("bogus grant → 403 identity_denied", async () => {
    for (const path of ["/control/centers", "/control/center"]) {
      const r = await post(path, { grant_token: "bogus", ...(path === "/control/center" ? { center: "ai" } : {}) });
      expect(r.status, path).toBe(403);
      expect(r.body["error"]).toBe("identity_denied");
    }
  });

  it("identitetsfelt i kroppen → 400 identity_field_forbidden (ikke stille ignorert)", async () => {
    for (const field of ["tenant_id", "person_id", "device_id", "session_id", "memory_space", "channel", "auth_strength"]) {
      const r = await post("/control/centers", { grant_token: grants.owner, [field]: "x" });
      expect(r.status, field).toBe(400);
      expect(r.body["error"]).toBe("identity_field_forbidden");
    }
  });

  it("ukjente felt avvises: ingen handling/parametre kan sendes (ruten er lese-kun), og `center` hører bare til enkeltruten", async () => {
    for (const extra of [{ action: "freeze_connector" }, { parameters: { connector_id: "x" } }, { center: "ai" }, { foo: 1 }]) {
      const r = await post("/control/centers", { grant_token: grants.owner, ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(r.body["reason"]).toBe("unknown_field");
    }
    const r = await post("/control/center", { grant_token: grants.owner, center: "ai", action: "activate_kill_switch" });
    expect(r.status).toBe(400);
    expect(r.body["reason"]).toBe("unknown_field");
  });

  it("senter mangler/har feil type/er ukjent → 400 FØR grantet løses; gyldig id som ikke er koblet inn → 404 (aldri tom OK)", async () => {
    expect((await post("/control/center", { grant_token: grants.owner })).body["reason"]).toBe("center_required");
    expect((await post("/control/center", { grant_token: grants.owner, center: 5 })).body["reason"]).toBe("center_required");
    for (const bad of ["billing", "AI", "", "ai ", "../ai", "ai/../finance", "__proto__"]) {
      const r = await post("/control/center", { grant_token: grants.owner, center: bad });
      expect(r.status, bad).toBe(400);
      expect(r.body["reason"], bad).toBe("unknown_center");
    }
    // Ugyldig senter avvises før grantet: også med bogus grant er det 400, ikke 403.
    expect((await post("/control/center", { grant_token: "bogus", center: "billing" })).status).toBe(400);
    const missing = await post("/control/center", { grant_token: grants.owner, center: "finance" });
    expect(missing.status).toBe(404);
    expect(missing.body["error"]).toBe("center_not_registered");
  });

  it("kun POST: GET mot rutene gir 404", async () => {
    for (const path of ["/control/centers", "/control/center"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, path).toBe(404);
    }
  });
});

describe("B: eieren får rapportene - kildeforankret, ærlig om det som ikke er koblet inn eller feiler", () => {
  it("oversikt: registrerte sentre med seksjonsstatus, de ikke-koblede listet, samlet UNKNOWN fordi ett senter feiler; ingen feilmelding lekker", async () => {
    const r = await post("/control/centers", { grant_token: grants.owner });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const data = r.body["data"] as { status: string; sensitivity: string; centers: Array<{ center: string; status: string; sections: Array<{ summary_no: string }>; action_count: number }>; unregistered: string[]; summary_no: string };
    expect(data.sensitivity).toBe("PRIVATE");
    expect(data.status).toBe("UNKNOWN");
    expect(data.centers.map((c) => c.center)).toEqual(["integration", "ai"]);
    expect(data.centers.find((c) => c.center === "ai")).toMatchObject({ status: "OK", action_count: 1 });
    expect(data.centers.find((c) => c.center === "integration")?.status).toBe("UNKNOWN");
    expect(data.unregistered).toContain("finance");
    expect(data.unregistered).not.toContain("ai");
    expect(JSON.stringify(r.body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(r.body)).not.toContain("10.1.2.3");
  });

  it("ett senter: full rapport med handling som peker på eksisterende rute + norsk forklaring først i svaret", async () => {
    const r = await post("/control/center", { grant_token: grants.owner, center: "ai" });
    expect(r.status).toBe(200);
    const data = r.body["data"] as { found: boolean; summary_no: string; explanation_no: string; report: { center: string; status: string; actions: Array<{ endpoint: string; requires_step_up: boolean; item_id: string }> } };
    expect(Object.keys(data)[0]).toBe("found");
    expect(data.found).toBe(true);
    expect(data.report).toMatchObject({ center: "ai", status: "OK" });
    expect(data.report.actions[0]).toMatchObject({ endpoint: "/executive/mutate", requires_step_up: false, item_id: "ollama" });
    expect(data.explanation_no).toContain("AI er i orden");
  });

  it("et senter som feiler gir UNKNOWN med feilkategori - aldri 500 og aldri OK", async () => {
    const r = await post("/control/center", { grant_token: grants.owner, center: "integration" });
    expect(r.status).toBe(200);
    const report = (r.body["data"] as { report: { status: string; sections: Array<{ measured: boolean; summary_no: string }> } }).report;
    expect(report.status).toBe("UNKNOWN");
    expect(report.sections[0]).toMatchObject({ measured: false });
    expect(report.sections[0]?.summary_no).toContain("målingen feilet (Error)");
  });
});

describe("C: kun den suverene eieren", () => {
  it("en annen person i samme tenant nektes av verktøyets port (tool_denied) - og avslaget revideres", async () => {
    for (const path of ["/control/centers", "/control/center"]) {
      const r = await post(path, { grant_token: grants.other, ...(path === "/control/center" ? { center: "ai" } : {}) });
      expect(r.status, path).toBe(403);
      expect(r.body["error"]).toBe("tool_denied");
      expect(r.body["reason"]).toBe("control_center_owner_only");
    }
    const audit = await adminPool.query(`SELECT reason, person_id FROM audit_events WHERE type = 'tool.denied' AND tool_id = 'executive' AND action = 'get_control_center' ORDER BY audit_id`);
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
    expect(audit.rows.every((row) => row.reason === "control_center_owner_only")).toBe(true);
    expect(audit.rows.some((row) => row.person_id === OTHER)).toBe(true);
  });

  it("eier i en ANNEN tenant får heller ingenting (eier-kun gjelder eierens tenant)", async () => {
    const r = await post("/control/centers", { grant_token: grants.stranger });
    expect(r.status).toBe(403);
    expect(r.body["reason"]).toBe("control_center_owner_only");
  });

  it("direkte mot verktøyet: ukjent senter-id avvises av skjemaet, og en fremmed identitet av porten - før noe bygges", async () => {
    const identity = { person_id: OTHER, tenant_id: TENANT_A, memory_space_id: "personal" as const, session_id: "s", device_id: "h0-dev-other", channel: "api" as const, auth_strength: "active" as const };
    expect(await gateway.execute({ identity, tool_id: "executive", action: "get_control_center", parameters: { center: "ai" } })).toEqual({ ok: false, reason: "control_center_owner_only" });
    const owner = { ...identity, person_id: OWNER, device_id: "h0-dev-owner" };
    expect(await gateway.execute({ identity: owner, tool_id: "executive", action: "get_control_center", parameters: { center: "billing" } })).toEqual({ ok: false, reason: "invalid_parameters" });
    expect(await gateway.execute({ identity: owner, tool_id: "executive", action: "get_control_center", parameters: { center: "ai", extra: 1 } })).toEqual({ ok: false, reason: "invalid_parameters" });
    const ok = await gateway.execute({ identity: owner, tool_id: "executive", action: "get_control_center", parameters: {} });
    expect(ok.ok).toBe(true);
  });

  it("et avslag eller en ukjent senter-id setter IKKE executive-verktøyet i helse «unavailable»", async () => {
    const before = gateway.health.get("executive");
    await post("/control/center", { grant_token: grants.owner, center: "finance" });
    await post("/control/center", { grant_token: grants.other, center: "ai" });
    expect(gateway.health.get("executive")?.state).not.toBe("unavailable");
    expect(gateway.health.get("executive")?.state).not.toBe("auth_failed");
    void before;
  });
});

describe("D: lese-kun - kontrollsenterets ruter skriver ingenting i eier-kontrolltilstanden", () => {
  it("etter alle kallene over finnes ingen rad i owner_control_state og ingen jobb", async () => {
    await post("/control/centers", { grant_token: grants.owner });
    await post("/control/center", { grant_token: grants.owner, center: "ai" });
    expect(Number((await adminPool.query("SELECT count(*) AS n FROM owner_control_state")).rows[0].n)).toBe(0);
    expect(Number((await adminPool.query("SELECT count(*) AS n FROM tasks")).rows[0].n)).toBe(0);
  });
});

describe("E: siden /control serveres som de øvrige statiske sidene", () => {
  it("med eier-konfig: 200 html med nonce-CSP og eier-meta; uten: 503 owner_not_configured", async () => {
    const res = await fetch(`${baseUrl}/control`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(csp).not.toContain("unsafe-inline");
    const html = await res.text();
    expect(html).toContain('<meta name="jarvis-owner"');
    expect(html).not.toContain("<!--JARVIS_OWNER_META-->");
    expect(html).not.toMatch(/<script>|<style>/);
    const without = await fetch(`${baseUrlWithoutOwner}/control`);
    expect(without.status).toBe(503);
    expect(((await without.json()) as { error: string }).error).toBe("owner_not_configured");
  });
});

describe("F: kill switch aktiv - kontrollsentrene nektes (de står bevisst ikke på policyens gjenopprettingsliste), og siden bygger gjenopprettingsvisningen på nettopp denne årsaken", () => {
  it("begge lese-rutene gir 403 tool_denied/kill_switch_active med revisjonsrad; etter oppheving virker de igjen", async () => {
    const deniedBefore = Number((await adminPool.query("SELECT count(*) AS n FROM audit_events WHERE type = 'tool.denied' AND tool_id = 'executive' AND action = 'get_control_center' AND reason = 'kill_switch_active'")).rows[0].n);
    killSwitch.activate("wph0-test");
    try {
      const overviewRes = await post("/control/centers", { grant_token: grants.owner });
      expect(overviewRes.status).toBe(403);
      expect(overviewRes.body).toMatchObject({ error: "tool_denied", reason: "kill_switch_active" });
      const centerRes = await post("/control/center", { grant_token: grants.owner, center: "ai" });
      expect(centerRes.status).toBe(403);
      expect(centerRes.body).toMatchObject({ error: "tool_denied", reason: "kill_switch_active" });
    } finally {
      killSwitch.deactivate();
    }
    const deniedAfter = Number((await adminPool.query("SELECT count(*) AS n FROM audit_events WHERE type = 'tool.denied' AND tool_id = 'executive' AND action = 'get_control_center' AND reason = 'kill_switch_active'")).rows[0].n);
    expect(deniedAfter - deniedBefore).toBe(2);
    expect((await post("/control/centers", { grant_token: grants.owner })).status).toBe(200);
    expect((await post("/control/center", { grant_token: grants.owner, center: "ai" })).status).toBe(200);
  });
});
