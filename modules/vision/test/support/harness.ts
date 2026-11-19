import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import type { CapturedImage, VisionSource, VisionSourceCamera, VisionSourceEvent } from "../../src/source.ts";
import type { VisionModelCall, VisionModelGateway, VisionModelResultLike } from "../../src/classifier.ts";

/**
 * WP-G3 (D-465): felles testoppsett for UA-9-integrasjonstestene (ekte embedded Postgres, NOSUPERUSER/NOBYPASSRLS-rolle som runtime). Testdoblene ligger BEVISST her
 * (under test/), ikke i src/: d396-fake-export-guard feller eksporterte Fake*-klasser i produksjonsflaten.
 */
export interface VisionDb {
  admin: pg.Pool;
  app: pg.Pool;
  port: number;
  stop: () => Promise<void>;
}

export async function startVisionDb(prefix: string): Promise<VisionDb> {
  const dir = await mkdtemp(join(tmpdir(), `jarvis-pg-${prefix}-`));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  await leased.postgres.createDatabase("jarvis_test");
  const admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  const role = `jarvis_${prefix.replace(/[^a-z0-9]/g, "_")}_app`;
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT jarvis_app TO ${role}`);
  const app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: role, password: "pw2" });
  return {
    admin,
    app,
    port: leased.port,
    stop: async () => {
      await app.end();
      await admin.end();
      await leased.stop();
    }
  };
}

export interface SeedIds {
  tenant: string;
  owner: string;
  other: string;
  room: string;
}

/** Tenant + eier + en annen person (samme tenant) + `personal`/`home`-rom i memory_spaces. Rom opprettes via SQL (som admin) for å holde seed uavhengig av tjenestene som testes. */
export async function seedTenant(db: VisionDb, tenant: string): Promise<Omit<SeedIds, "room">> {
  const owner = `${tenant}-owner`;
  const other = `${tenant}-other`;
  await db.admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, $1, 'person')`, [tenant]);
  await db.admin.query(`INSERT INTO people (person_id, display_name) VALUES ($1, 'Eier'), ($2, 'Annen')`, [owner, other]);
  await db.admin.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1, $3), ($2, $3)`, [owner, other, tenant]);
  await db.admin.query(`INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1, $2, 'personal'), ($3, $2, 'home')`, [`ms-${tenant}-personal`, tenant, `ms-${tenant}-home`]);
  return { tenant, owner, other };
}

/** Unike, gyldige JPEG-bytes (magic bytes + tilfeldig innhold) - hver kall gir en ny sha256. */
export function makeJpeg(size = 512): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...randomBytes(size)]);
}

export const NOT_AN_IMAGE = new TextEncoder().encode("<html><script>alert(1)</script></html>");

/** Scriptet kilde: leverer de gitte hendelsene og et fast bilde; teller kall. */
export class ScriptedSource implements VisionSource {
  readonly source_type: string;
  polls = 0;
  snapshotFetches = 0;
  events: VisionSourceEvent[] = [];
  image: () => CapturedImage = () => ({ bytes: makeJpeg(), declared_type: "image/jpeg" });
  failPoll: Error | null = null;
  failSnapshot: Error | null = null;

  constructor(source_type = "home_assistant") {
    this.source_type = source_type;
  }

  async pollEvents(_cameras: readonly VisionSourceCamera[], _now: Date): Promise<VisionSourceEvent[]> {
    this.polls += 1;
    if (this.failPoll) throw this.failPoll;
    return [...this.events];
  }

  async fetchSnapshot(_camera: VisionSourceCamera, _maxBytes: number): Promise<CapturedImage> {
    this.snapshotFetches += 1;
    if (this.failSnapshot) throw this.failSnapshot;
    return this.image();
  }
}

/** Scriptet lokal modellgateway: svarer med gitt tekst fra gitt leverandør, eller kaster. Registrerer alle kall (aldri bildeinnhold i asserts utover det som testes). */
export class ScriptedGateway implements VisionModelGateway {
  calls: VisionModelCall[] = [];
  text = JSON.stringify({ detections: [] });
  provider = "local_vision";
  model = "vl-test";
  failWith: Error | null = null;

  async complete(call: VisionModelCall): Promise<VisionModelResultLike> {
    this.calls.push(call);
    if (this.failWith) throw this.failWith;
    return { text: this.text, provider: this.provider, model: this.model };
  }
}

export const detectionsJson = (detections: unknown[]): string => JSON.stringify({ detections });
