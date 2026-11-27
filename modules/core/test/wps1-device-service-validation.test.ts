import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_KINDS, type DeviceKind } from "@jarvis/contracts";
import { DeviceService, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-S1 K1/K3 (mutantfunn): `DeviceService.registerDeviceOn` validerer den eksplisitte typen mot den lukkede listen I KODEN (ZodError, før databasen), og databasens CHECK er KUN andre forsvarslinje. Testen låser
 * at valideringen i koden er den som avviser (feilen er ingen databasefeil: ingen `code`), at ingenting skrives, og at kilde-invarianten (`legacy_unknown` <=> `unclassified`) normaliseres/avvises i koden.
 */
const TENANT = "tenant-s1v";
const PERSON = "person-s1v";
const SEED = { person_id: PERSON, tenant_id: TENANT, memory_space_id: "personal", session_id: "sess-seed-s1v", device_id: "seed-s1v", channel: "system", auth_strength: "active" } as const;

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let devices: DeviceService;
let counter = 0;
const pem = (k: { publicKey: KeyObject }): string => k.publicKey.export({ type: "spki", format: "pem" }).toString();
const pubKey = (): string => pem(generateKeyPairSync("ed25519"));
const fresh = (prefix: string): string => `${prefix}-${++counter}`;
const row = async (id: string): Promise<{ device_kind: string; device_kind_source: string } | undefined> =>
  (await adminPool.query("SELECT device_kind, device_kind_source FROM devices WHERE device_id = $1", [id])).rows[0];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-s1v-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_s1v LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_s1v");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'S1V', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'S1V Person');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON}', '${TENANT}');`);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_s1v", password: "pw2" });
  devices = new DeviceService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

describe("WP-S1: registerDeviceOn validerer typen og kilden i koden (databasens CHECK er bare andre forsvarslinje)", () => {
  it("en ugyldig eksplisitt type avvises av valideringen i koden (ZodError uten databasekode), og ingenting skrives", async () => {
    for (const bad of ["nope", "Iphone", "IPHONE", "iphone ", "", "web", "legacy-unknown", null, 1, {}] as const) {
      const id = fresh("dev-v-bad");
      const err = await devices.registerDeviceTrusted(SEED, { device_id: id, kind: "x", public_key_pem: pubKey(), device_kind: bad as unknown as DeviceKind }).then(() => undefined, (e: unknown) => e);
      expect(err, JSON.stringify(bad)).toBeInstanceOf(Error);
      expect((err as Error).name, JSON.stringify(bad)).toBe("ZodError");
      expect((err as { code?: string }).code, `ingen databasefeil for ${JSON.stringify(bad)}`).toBeUndefined();
      expect(await row(id)).toBeUndefined();
    }
  });

  it("alle lukkede typer godtas, og standardkilden er trusted_provisioning (legacy_unknown er alltid unclassified)", async () => {
    for (const kind of DEVICE_KINDS) {
      const id = fresh(`dev-v-ok-${kind}`);
      await devices.registerDeviceTrusted(SEED, { device_id: id, kind: "x", public_key_pem: pubKey(), device_kind: kind });
      expect(await row(id)).toEqual({ device_kind: kind, device_kind_source: kind === "legacy_unknown" ? "unclassified" : "trusted_provisioning" });
    }
  });

  it("legacy_unknown med en oppgitt kilde normaliseres til unclassified (aldri en inkonsistent rad)", async () => {
    for (const source of ["enrollment_ticket", "trusted_provisioning", "legacy_label", "unclassified"] as const) {
      const id = fresh("dev-v-legacy");
      await devices.registerDeviceTrusted(SEED, { device_id: id, kind: "x", public_key_pem: pubKey(), device_kind: "legacy_unknown", device_kind_source: source });
      expect(await row(id), source).toEqual({ device_kind: "legacy_unknown", device_kind_source: "unclassified" });
    }
  });

  it("en lukket type med kilden unclassified avvises i koden (device_kind_source_inconsistent, ingen databasefeil), og ingenting skrives", async () => {
    for (const kind of DEVICE_KINDS.filter((k) => k !== "legacy_unknown")) {
      const id = fresh("dev-v-inc");
      const err = await devices.registerDeviceTrusted(SEED, { device_id: id, kind: "x", public_key_pem: pubKey(), device_kind: kind, device_kind_source: "unclassified" }).then(() => undefined, (e: unknown) => e);
      expect(err, kind).toBeInstanceOf(Error);
      expect((err as Error).message, kind).toBe("device_kind_source_inconsistent");
      expect((err as { code?: string }).code, kind).toBeUndefined();
      expect(await row(id), kind).toBeUndefined();
    }
  });

  it("en eksplisitt kilde bevares for en lukket type (legacy_label/enrollment_ticket/trusted_provisioning)", async () => {
    for (const source of ["legacy_label", "enrollment_ticket", "trusted_provisioning"] as const) {
      const id = fresh("dev-v-src");
      await devices.registerDeviceTrusted(SEED, { device_id: id, kind: "x", public_key_pem: pubKey(), device_kind: "mac", device_kind_source: source });
      expect(await row(id), source).toEqual({ device_kind: "mac", device_kind_source: source });
    }
  });
});
