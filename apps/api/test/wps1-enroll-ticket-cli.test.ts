import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENROLLABLE_DEVICE_KINDS } from "@jarvis/contracts";
import { DeviceEnrollmentService, DeviceService, SessionGrantService } from "@jarvis/core";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-S1 K3: eierens billett-CLI (`apps/api/src/enroll-ticket-main.ts`, den ENESTE veien en eier utsteder en billett fra en terminal) krever `--kind` og har INGEN standard. Typen avgjør hvilke kanaler enheten kan få
 * en økt for; en stille standard (f.eks. `web_browser`) ville gitt hver billett step-up-evne uten at eieren valgte det. Testen kjører CLI-en som en egen prosess (samme som eieren): ugyldig/manglende `--kind`
 * stopper (kode 2) FØR noe kobles til databasen; en gyldig type passerer valideringen (og feiler først på databasen: porten under er bevisst lukket, så ingenting kan bli skrevet noe sted).
 */
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "src", "enroll-ticket-main.ts");

function runCli(args: readonly string[], dbEnv: Record<string, string> = {}): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ["--experimental-transform-types", script, ...args], {
    cwd: join(here, ".."),
    // Minimalt, kontrollert miljø: gyldig eier-konfig, og en LUKKET databaseport så ingen billett kan opprettes selv om validering skulle passere.
    env: {
      PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/tmp", JARVIS_TENANT_ID: "tenant-s1c", JARVIS_OWNER_PERSON_ID: "person-s1c", JARVIS_OWNER_NAME: "Test Owner",
      JARVIS_DB_HOST: "127.0.0.1", JARVIS_DB_PORT: "1",
      ...dbEnv
    },
    encoding: "utf8",
    timeout: 60_000
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

const KIND_ERROR = "mangler eller ugyldig --kind";

describe("WP-S1 K3: enroll-ticket-CLI krever --kind uten standard", () => {
  it("uten --kind: avslutter med kode 2 og forklarer, FØR databasen røres; ingen billett skrives ut", () => {
    const r = runCli([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(KIND_ERROR);
    expect(r.stderr).toContain("har ingen standard");
    expect(r.stdout).not.toContain("enr_");
  }, 90_000);

  for (const bad of ["legacy_unknown", "Iphone", "web", "", "phone", "iphone ", "watch,service"]) {
    it(`ugyldig --kind ${JSON.stringify(bad)}: kode 2 (legacy_unknown og skrivefeil er aldri en billettype)`, () => {
      const r = runCli(["--kind", bad]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(KIND_ERROR);
      expect(r.stdout).not.toContain("enr_");
    }, 90_000);
  }

  it("--kind som siste argument uten verdi: kode 2", () => {
    const r = runCli(["--device", "dev-x", "--kind"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(KIND_ERROR);
  }, 90_000);

  it("--kind=iphone (annen syntaks enn CLI-en støtter) regnes som manglende: ingen stille gjetning", () => {
    const r = runCli(["--kind=iphone"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(KIND_ERROR);
  }, 90_000);

  it("feilmeldingen lister NØYAKTIG de lukkede billettypene (aldri legacy_unknown)", () => {
    const r = runCli([]);
    expect(r.stderr).toContain(`(${ENROLLABLE_DEVICE_KINDS.join(" | ")})`);
    expect(r.stderr).not.toContain("legacy_unknown");
  }, 90_000);

  for (const good of ENROLLABLE_DEVICE_KINDS) {
    it(`--kind ${good}: passerer typevalideringen (feiler først mot den lukkede databaseporten, aldri med typefeilen)`, () => {
      const r = runCli(["--kind", good]);
      expect(r.stderr).not.toContain(KIND_ERROR);
      expect(r.status).not.toBe(2);
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("enr_");
    }, 90_000);
  }
});

describe("WP-S1 K3: CLI -> billett i databasen -> innrulling -> enhetstype (ende-til-ende mot ekte Postgres)", () => {
  let db: H0Db;
  let dbEnv: Record<string, string>;
  const TENANT = "tenant-s1c";
  const PERSON = "person-s1c";
  const pem = (k: { publicKey: { export(o: { type: "spki"; format: "pem" }): string | Buffer } }): string => k.publicKey.export({ type: "spki", format: "pem" }).toString();

  beforeAll(async () => {
    db = await startH0Db("wps1cli");
    const port = (db.adminPool as unknown as { options: { port: number } }).options.port;
    dbEnv = { JARVIS_DB_HOST: "127.0.0.1", JARVIS_DB_PORT: String(port), JARVIS_DB_NAME: "jarvis_test", JARVIS_DB_ADMIN_USER: "postgres", JARVIS_DB_ADMIN_PASSWORD: "pw" };
    await seedTenants(db.adminPool, [{ tenant_id: TENANT, person_id: PERSON }]);
  }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);

  const service = (): DeviceEnrollmentService => new DeviceEnrollmentService({ pool: db.appPool, devices: new DeviceService(db.appPool), grants: new SessionGrantService(db.appPool), channelBindingMode: "enforce" });
  const hash = (ticket: string): string => createHash("sha256").update(ticket, "utf8").digest("hex");

  for (const kind of ENROLLABLE_DEVICE_KINDS) {
    it(`--kind ${kind}: billetten i databasen bærer typen, CLI-en viser den, og innrullingen med billetten setter devices.device_kind (kilde enrollment_ticket)`, async () => {
      const deviceId = `dev-cli-${kind}`;
      const r = runCli(["--kind", kind, "--device", deviceId], dbEnv);
      expect(r.status, r.stderr).toBe(0);
      const ticket = /enr_[A-Za-z0-9_-]+/.exec(r.stdout)?.[0] as string;
      expect(ticket).toBeDefined();
      expect(r.stdout).toContain(`type:   ${kind} (`);
      const rows = (await db.adminPool.query("SELECT device_kind, device_id, consumed_at FROM device_enrollment_tickets WHERE ticket_id = $1", [hash(ticket)])).rows;
      expect(rows).toEqual([{ device_kind: kind, device_id: deviceId, consumed_at: null }]);
      const result = await service().enroll({
        tenant_id: TENANT, person_id: PERSON, device: { device_id: deviceId, public_key_pem: pem(generateKeyPairSync("ed25519")) }, enrollment: { kind: "enrollment_ticket", ticket }
      });
      expect(result).toMatchObject({ ok: true, device_id: deviceId });
      expect((await db.adminPool.query("SELECT device_kind, device_kind_source FROM devices WHERE device_id = $1", [deviceId])).rows[0]).toEqual({ device_kind: kind, device_kind_source: "enrollment_ticket" });
    }, 90_000);
  }

  it("uten --device gjelder billetten enhver enhet for personen, og typen følger billetten (ikke klienten)", async () => {
    const r = runCli(["--kind", "watch"], dbEnv);
    expect(r.status, r.stderr).toBe(0);
    const ticket = /enr_[A-Za-z0-9_-]+/.exec(r.stdout)?.[0] as string;
    expect((await db.adminPool.query("SELECT device_kind, device_id FROM device_enrollment_tickets WHERE ticket_id = $1", [hash(ticket)])).rows).toEqual([{ device_kind: "watch", device_id: null }]);
    const deviceId = "dev-cli-any-device";
    const result = await service().enroll({
      tenant_id: TENANT, person_id: PERSON, device: { device_id: deviceId, kind: "iphone", public_key_pem: pem(generateKeyPairSync("ed25519")) }, enrollment: { kind: "enrollment_ticket", ticket }
    });
    expect(result.ok).toBe(true);
    expect((await db.adminPool.query("SELECT device_kind FROM devices WHERE device_id = $1", [deviceId])).rows[0]).toEqual({ device_kind: "watch" });
  }, 90_000);
});
