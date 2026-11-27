import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeviceKind, DeviceKindSource, EnrollableDeviceKind } from "@jarvis/contracts";
import { DeviceEnrollmentService, DeviceService, SessionGrantService, createEnrollmentTicket, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-S1 fiks-runde 1 (innrulling): A-M1 (DoS: en lang `device.kind` kan ikke lenger koste tid), A-L2 (regel R-B er smalere enn trusselen: en enhet uten step-up-kanal kan kun re-nøkle seg selv eller opprette nye
 * enheter; å vitne for et step-up-mål krever en eier-verifisert kilde) og A-L2c/C6/C7/C8 fra reviewer A. Ekte embedded Postgres, ekte RLS (app-rolle), ekte Ed25519-bevis.
 */
const TENANT = "tenant-s1f";
const PERSON = "person-s1f";

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let devices: DeviceService;
let grants: SessionGrantService;
let enforce: DeviceEnrollmentService;
let observe: DeviceEnrollmentService;
const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
let counter = 0;

const pem = (k: { publicKey: KeyObject }): string => k.publicKey.export({ type: "spki", format: "pem" }).toString();
const fresh = (prefix: string): string => `${prefix}-${++counter}`;

/** Legger en enhet rett i databasen (admin) med eksplisitt type og kilde; `keyless` = nøkkelløs rad som seed-radene (`jarvis-core`, talegateway). */
async function addDevice(deviceId: string, kind: DeviceKind, source?: DeviceKindSource, keyless = false): Promise<ReturnType<typeof generateKeyPairSync>> {
  const k = generateKeyPairSync("ed25519");
  keys.set(deviceId, k);
  const effective: DeviceKindSource = source ?? (kind === "legacy_unknown" ? "unclassified" : "trusted_provisioning");
  await adminPool.query(
    `INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem, device_kind, device_kind_source) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [deviceId, TENANT, PERSON, `label-${kind}`, keyless ? null : pem(k), kind, effective]
  );
  return k;
}

const row = async (deviceId: string): Promise<{ kind: string; device_kind: string; device_kind_source: string; public_key_pem: string | null } | undefined> =>
  (await adminPool.query("SELECT kind, device_kind, device_kind_source, public_key_pem FROM devices WHERE device_id = $1", [deviceId])).rows[0];
const audits = async (deviceId: string, type: string): Promise<Array<{ decision: string | null; reason: string | null; payload: Record<string, unknown> }>> =>
  (await adminPool.query("SELECT decision, reason, payload FROM audit_events WHERE device_id = $1 AND type = $2 ORDER BY audit_id", [deviceId, type])).rows;

function proofFrom(authorizingId: string): { kind: "device_proof"; authorizing_device_id: string; challenge: string; signature: string } {
  const challenge = devices.issueChallenge(authorizingId);
  const k = keys.get(authorizingId) as ReturnType<typeof generateKeyPairSync>;
  return { kind: "device_proof", authorizing_device_id: authorizingId, challenge, signature: sign(null, Buffer.from(challenge, "utf8"), k.privateKey).toString("base64") };
}

async function ticketFor(kind: EnrollableDeviceKind | undefined, deviceId?: string): Promise<{ kind: "enrollment_ticket"; ticket: string }> {
  const t = await createEnrollmentTicket(adminPool, { tenant_id: TENANT, person_id: PERSON, ...(deviceId !== undefined ? { device_id: deviceId } : {}), ...(kind !== undefined ? { device_kind: kind } : {}) });
  return { kind: "enrollment_ticket", ticket: t.ticket };
}

const request = (deviceId: string, key: ReturnType<typeof generateKeyPairSync>, enrollment: unknown, claim?: string): unknown => ({
  tenant_id: TENANT, person_id: PERSON,
  device: { device_id: deviceId, ...(claim !== undefined ? { kind: claim } : {}), public_key_pem: pem(key) },
  enrollment
});

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-s1f-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw", max: 8 });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_s1f LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_s1f");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'S1F', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'S1F Person');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON}', '${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-s1f', '${TENANT}', 'personal');`);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_s1f", password: "pw2" });
  devices = new DeviceService(appPool);
  grants = new SessionGrantService(appPool);
  enforce = new DeviceEnrollmentService({ pool: appPool, devices, grants, channelBindingMode: "enforce" });
  observe = new DeviceEnrollmentService({ pool: appPool, devices, grants, channelBindingMode: "observe" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

describe("A-M1: en lang `device.kind` koster ingenting - hele innrullingsstien, med radlåser og transaksjon", () => {
  /** Måler den lengste pausen i event-loopen mens `run` kjører (en blokkerende regex viser seg som ett stort gap). */
  async function withLoopGap<T>(run: () => Promise<T>): Promise<{ value: T; elapsedMs: number; worstGapMs: number }> {
    let worstGap = 0;
    let last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 10);
    const started = process.hrtime.bigint();
    try {
      const value = await run();
      return { value, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, worstGapMs: Math.max(worstGap, Date.now() - last) };
    } finally {
      clearInterval(timer);
    }
  }

  it("80 000 mellomrom i device.kind (device_proof, egen re-nøkling av en enrollert Watch): avvist som malformed_request, under 50 ms, ingen event-loop-gap over 100 ms, ingenting skrevet", async () => {
    const watch = fresh("dev-m1-watch");
    const k = await addDevice(watch, "watch");
    const before = (await row(watch))?.public_key_pem;
    const hostile = "x" + " ".repeat(80_000) + "y";
    const newKey = generateKeyPairSync("ed25519");
    const result = await withLoopGap(() => enforce.enroll(request(watch, newKey, proofFrom(watch), hostile)));
    expect(result.value).toEqual({ ok: false, reason: "malformed_request" });
    expect(result.elapsedMs).toBeLessThan(50);
    expect(result.worstGapMs).toBeLessThan(100);
    expect((await row(watch))?.public_key_pem).toBe(before); // nøkkelen er uendret
    void k;
  });

  it("samme for en billettinnrulling (observe og enforce): avvist før billetten røres, så billetten kan fortsatt brukes med en gyldig forespørsel", async () => {
    const id = fresh("dev-m1-ticket");
    const t = await ticketFor("iphone");
    const key = generateKeyPairSync("ed25519");
    for (const service of [observe, enforce]) {
      const result = await withLoopGap(() => service.enroll(request(id, key, t, " ".repeat(80_000) + "web" + " ".repeat(80_000) + "x")));
      expect(result.value).toEqual({ ok: false, reason: "malformed_request" });
      expect(result.elapsedMs).toBeLessThan(50);
      expect(result.worstGapMs).toBeLessThan(100);
    }
    expect((await enforce.enroll(request(id, key, t))).ok).toBe(true); // billetten er ubrukt
    expect(await row(id)).toMatchObject({ device_kind: "iphone" });
  });

  it("den lengste tillatte etiketten (256 tegn) innrulles normalt, uten event-loop-gap, og revideres avkortet", async () => {
    const id = fresh("dev-m1-max");
    const label = "x" + " ".repeat(254) + "y"; // nøyaktig 256 tegn
    expect(label).toHaveLength(256);
    const result = await withLoopGap(async () => enforce.enroll(request(id, generateKeyPairSync("ed25519"), await ticketFor("watch"), label)));
    expect(result.value.ok).toBe(true);
    expect(result.worstGapMs).toBeLessThan(100);
    const claimed = (await audits(id, "device.enrolled"))[0]?.payload["claimed_kind"] as string;
    expect(claimed.length).toBeLessThanOrEqual(40);
  });

  it("STRUKTUR: den påståtte etiketten sammenlignes (claimedMatches) FØRST ETTER regel R-B, så et avslått forsøk aldri koster arbeid over den", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/services/device-enrollment-service.ts", import.meta.url)), "utf8");
    const denial = source.indexOf('throw new EnrollmentDenial("authorizing_device_kind_not_allowed"');
    const compare = source.indexOf("deviceKindFromLegacyLabel(claimed)");
    expect(denial).toBeGreaterThan(0);
    expect(compare).toBeGreaterThan(denial);
    expect(source.split("deviceKindFromLegacyLabel(claimed)").length - 1).toBe(1); // nøyaktig ett sted, aldri en tidligere kopi
  });
});
