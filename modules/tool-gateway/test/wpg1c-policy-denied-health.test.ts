import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { PolicyDeniedError, ToolGateway, firstWaveTools, isPolicyDenied, type SecretProvider, type ToolTransport } from "../src/index.ts";

/**
 * WP-G1c (D-481, JARVIS-112 g4): et POLICY-AVSLAG kastet fra en transport (f.eks. `comms_policy_denied:recipient_opted_out`, et avslag Jarvis selv har gitt) ble klassifisert som en leverandørfeil i connector-helse:
 * teksten matchet `/401|403|auth/` (-> `auth_failed`; `comms_account_not_authorized` inneholder «auth») eller `/429|rate/` (-> `rate_limited`; `comms_policy_denied:rate_limit_account_hour` inneholder «rate») eller falt til `unavailable`. Et enkelt avslag
 * mot en avmeldt mottaker kunne altså få connectoren til å se syk ut (og utløse «Tilkobling svikter»). Nå har et policy-avslag sin EGEN klasse (`PolicyDeniedError`): helsetilstanden røres ikke, mens ALT annet er klassifisert NØYAKTIG som før
 * (paritetstestene under er låst mot den gamle regelen, ikke mot en ny tolkning). Resultatet til kalleren (`failed` + samme melding), ledger og audit er uendret.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-g1c-g4", memory_space_id: "personal",
  session_id: "sess-g1c-g4", device_id: "jarvis-voice-live", channel: "voice", auth_strength: "active"
};
const secrets: SecretProvider = { name: "test", async get() { return "secret"; } };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-g1c-g4-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_g1c_g4 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_g1c_g4");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-g1c-g4','G1C g4','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-g1c-g4');
  `);
  appPool = new pg.Pool({ ...base, user: "jarvis_g1c_g4", password: "pw2", max: 10 });
  appPool.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

function gatewayThrowing(thrown: () => unknown): ToolGateway {
  const transport: ToolTransport = { async invoke() { throw thrown(); } };
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch(),
    authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
  });
  const gateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of firstWaveTools({ calendar: transport })) gateway.register(tool);
  return gateway;
}
const params = (): Record<string, JsonValue> => ({ title: `Møte ${randomUUID().slice(0, 6)}`, start: new Date().toISOString(), end: new Date(Date.now() + 3_600_000).toISOString() });
const run = (gateway: ToolGateway) => gateway.execute({ identity, tool_id: "calendar", action: "create_event", parameters: params(), idempotency_key: `k-${randomUUID()}` });

describe("g4: policy-avslag teller ikke mot connector-helse", () => {
  it("PolicyDeniedError (alle tre formene fra comms): resultatet er `tool_failed:` med SAMME melding, og helsen røres ikke (ingen rad for et verktøy som aldri har feilet av leverandørgrunner)", async () => {
    for (const code of ["recipient_opted_out", "rate_limit_account_hour", "content_hash_key_unavailable"]) {
      const gateway = gatewayThrowing(() => new PolicyDeniedError(`comms_policy_denied:${code}`));
      const result = await run(gateway);
      // uendret fra før: samme `tool_failed:<melding>`-svar som for enhver transportfeil
      expect(result, code).toEqual({ ok: false, reason: `tool_failed:comms_policy_denied:${code}` });
      expect(gateway.health.get("calendar"), code).toBeUndefined();
    }
  });

  it("en tidligere SUND tilstand forblir sunn etter et policy-avslag (ikke degradert til unavailable/rate_limited/auth_failed)", async () => {
    let fail = false;
    const transport: ToolTransport = { async invoke() { if (fail) throw new PolicyDeniedError("comms_policy_denied:recipient_opted_out"); return { external_id: "evt-1" }; } };
    const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch(), authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] } });
    const gateway = new ToolGateway(appPool, policy, secrets);
    for (const tool of firstWaveTools({ calendar: transport })) gateway.register(tool);
    expect((await run(gateway)).ok).toBe(true);
    expect(gateway.health.get("calendar")?.state).toBe("healthy");
    fail = true;
    expect((await run(gateway)).ok).toBe(false);
    expect(gateway.health.get("calendar")?.state).toBe("healthy");
  });

  it("PARITET (flagg AV / øvrige verktøy): alle andre feil klassifiseres NØYAKTIG som før - 401/403/auth -> auth_failed, 429/rate -> rate_limited, resten -> unavailable, med samme detalj", async () => {
    const cases: Array<[string, string]> = [
      ["http_401", "auth_failed"], ["http_403_forbidden", "auth_failed"], ["authentication failed", "auth_failed"], ["comms_account_not_authorized", "auth_failed"],
      ["http_429", "rate_limited"], ["rate limit exceeded", "rate_limited"], ["comms_policy_denied:rate_limit_account_hour", "rate_limited"],
      ["boom", "unavailable"], ["comms_policy_denied:recipient_opted_out", "unavailable"]
    ];
    for (const [message, expected] of cases) {
      const gateway = gatewayThrowing(() => new Error(message));
      const result = await run(gateway);
      expect(result.ok, message).toBe(false);
      expect(gateway.health.get("calendar"), message).toMatchObject({ state: expected, detail: message.slice(0, 60) });
    }
  });

  it("en vanlig Error med en policy-lignende TEKST er IKKE unntatt (kun den typede feilen er det): ingen omklassifisering på tekst", async () => {
    const gateway = gatewayThrowing(() => new Error("comms_policy_denied:rate_limit_account_hour"));
    await run(gateway);
    expect(gateway.health.get("calendar")?.state).toBe("rate_limited");
  });

  it("isPolicyDenied: kun PolicyDeniedError (og det som bærer merket), aldri en vanlig feil eller en verdi som ikke er en feil", () => {
    expect(isPolicyDenied(new PolicyDeniedError("comms_policy_denied:x"))).toBe(true);
    expect(isPolicyDenied(new Error("comms_policy_denied:x"))).toBe(false);
    expect(isPolicyDenied("comms_policy_denied:x")).toBe(false);
    expect(isPolicyDenied(null)).toBe(false);
    expect(isPolicyDenied(undefined)).toBe(false);
    expect(new PolicyDeniedError("comms_policy_denied:recipient_opted_out").message).toBe("comms_policy_denied:recipient_opted_out");
    expect(new PolicyDeniedError("comms_policy_denied:recipient_opted_out")).toBeInstanceOf(Error);
    expect(new PolicyDeniedError("comms_policy_denied:recipient_opted_out").name).toBe("PolicyDeniedError");
  });
});
