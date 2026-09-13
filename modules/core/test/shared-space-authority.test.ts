import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityService, createPool, runMigrations } from "@jarvis/core";
import { allocateEmbeddedPostgresPort } from "../src/testing/embedded-postgres-port.ts";

/**
 * Familie-/delt-space-audit (masterplan-ordre for UA-8): "Ikke oppfinn en ny
 * authorization-model bare for UA-8. Shared authority skal aldri gi Tobias
 * mer tilgang enn den tilkoblede tjenesten faktisk gir."
 *
 * Denne filen bygger INGEN ny modell - den beviser hva den EKSISTERENDE
 * `IdentityService.resolveIdentity()` faktisk gjør med `memory_spaces.space =
 * 'shared'`, mot ekte embedded Postgres/RLS. `modules/core/src/services/
 * voice-session-authority.ts` sin dokkommentar er autoritativ her: en finere
 * PER-PERSON space-hviteliste ble bevisst vurdert og forkastet - den
 * kanoniske modellen er tenant+space (`memory_spaces (tenant_id, space)
 * UNIQUE` - IKKE person+space), nådd via person_tenants-medlemskap OG en
 * enhet REGISTRERT PÅ personen i den tenanten (`devices (device_id, tenant_id,
 * person_id, ...)`).
 *
 * Konsekvens som testes eksplisitt: 'shared' er IKKE en per-person-grantet
 * verdi. To personer i SAMME tenant med samme medlemskap kan ikke gis ulik
 * tilgang til 'shared' via person_tenants/memory_spaces alene - den eneste
 * reelle differensieringen den kanoniske modellen tilbyr er ENHETSBINDINGEN
 * (person B har ingen registrert enhet i tenanten). Det er PRESIST det denne
 * testen beviser: person B, som HAR person_tenants-medlemskap i samme tenant
 * som person A og der 'shared' FAKTISK finnes, blir likevel korrekt avvist
 * fordi B aldri har bevist en enhet der - mens A (medlemskap + registrert
 * enhet) resolves normalt. Dette er IKKE en tilfeldig bakdør: B får aldri mer
 * tilgang enn det B faktisk har (en person_tenants-rad uten noen bevist
 * enhet gir INGEN identitetsoppløsning i det hele tatt, uansett space).
 */

const PORT = allocateEmbeddedPostgresPort();

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let identity: IdentityService;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pgshared-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");

  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-fam','Familien','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-a','Person A'), ('person-b','Person B');
    -- Begge er medlemmer av SAMME tenant:
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-a','tenant-fam'), ('person-b','tenant-fam');
    -- 'shared' finnes faktisk i denne tenanten:
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-fam-shared','tenant-fam','shared');
    -- Person A har en registrert enhet i tenanten. Person B har det BEVISST IKKE -
    -- det er den eneste reelle differensieringen den kanoniske modellen tilbyr.
    INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem)
      VALUES ('dev-a','tenant-fam','person-a','phone', NULL);
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "pw2" });
  identity = new IdentityService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("'shared' er tenant-scoped, ikke en per-person bakdør", () => {
  it("Person A (medlemskap + registrert enhet i tenanten) resolves 'shared' normalt", async () => {
    const result = await identity.resolveIdentity({
      person_id: "person-a",
      tenant_id: "tenant-fam",
      memory_space: "shared",
      session_id: "sess-a",
      device_id: "dev-a",
      channel: "api",
      auth_strength: "active"
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.memory_space_id).toBe("shared");
      expect(result.identity.person_id).toBe("person-a");
    }
  });

  it("Person B (SAMME tenant, ekte person_tenants-medlemskap, MEN ingen registrert enhet der) blir korrekt avvist for 'shared'", async () => {
    const result = await identity.resolveIdentity({
      person_id: "person-b",
      tenant_id: "tenant-fam",
      memory_space: "shared",
      session_id: "sess-b",
      device_id: "dev-b-finnes-ikke",
      channel: "api",
      auth_strength: "active"
    });
    // B har ekte medlemskap i tenanten - avslaget er IKKE fordi B mangler
    // person_tenants-rad, men fordi den påberopte enheten aldri er registrert
    // på B i denne tenanten. 'shared' ga altså B INGEN ekstra tilgang utover
    // det B faktisk har bevist.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown_device");
    }
  });

  it("FUNN (dokumentert, ikke skjult): gis B EN registrert enhet i samme tenant, resolves 'shared' likevel - dette er tenant-scoped design (voice-session-authority.ts), ikke en person-spesifikk grant", async () => {
    await adminPool.query(
      `INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem)
         VALUES ('dev-b','tenant-fam','person-b','phone', NULL)`
    );
    const result = await identity.resolveIdentity({
      person_id: "person-b",
      tenant_id: "tenant-fam",
      memory_space: "shared",
      session_id: "sess-b2",
      device_id: "dev-b",
      channel: "api",
      auth_strength: "active"
    });
    // Dette er FORVENTET og BEVISST, dokumentert i voice-session-authority.ts:
    // 'shared' (som enhver space) er tilgjengelig for ENHVER person med ekte
    // medlemskap + bevist enhet i tenanten - det finnes INGEN finere per-person
    // space-hviteliste i dag. Det er ikke en lekkasje: det ER hele den
    // kanoniske modellens definisjon av "tilgang".
    expect(result.ok).toBe(true);
  });
});
