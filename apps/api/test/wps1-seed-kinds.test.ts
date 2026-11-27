import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedOwner } from "../src/seed.ts";
import { startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-S1 K1/K3: `seedOwner()` (den eneste server-side seedingen av enhetsrader utenom innrulling) gir hver rad en EKSPLISITT, lukket type med kilden `trusted_provisioning`, og ingen av dem har en nøkkel (en seedet enhet uten nøkkel kan
 * aldri bevise noe, så typen er identitetsdata, aldri en tillitsgrense). Mot ekte Postgres: typene og kildene leses tilbake fra tabellen.
 */
let db: H0Db;
const owner = { tenant_id: "tenant-s1s", owner_person_id: "person-s1s", owner_display_name: "S1S Owner" };
const VOICE_ID = "jarvis-voice-s1s";

async function seedWithEnv(env: { JARVIS_ENV?: string }): Promise<void> {
  const before = { env: process.env["JARVIS_ENV"], voice: process.env["JARVIS_VOICE_DEVICE_ID"] };
  if (env.JARVIS_ENV === undefined) delete process.env["JARVIS_ENV"]; else process.env["JARVIS_ENV"] = env.JARVIS_ENV;
  process.env["JARVIS_VOICE_DEVICE_ID"] = VOICE_ID;
  try {
    await seedOwner(db.adminPool, owner);
  } finally {
    if (before.env === undefined) delete process.env["JARVIS_ENV"]; else process.env["JARVIS_ENV"] = before.env;
    if (before.voice === undefined) delete process.env["JARVIS_VOICE_DEVICE_ID"]; else process.env["JARVIS_VOICE_DEVICE_ID"] = before.voice;
  }
}
const rows = async (): Promise<Array<{ device_id: string; kind: string; device_kind: string; device_kind_source: string; has_key: boolean }>> =>
  (await db.adminPool.query("SELECT device_id, kind, device_kind, device_kind_source, public_key_pem IS NOT NULL AS has_key FROM devices WHERE tenant_id = $1 ORDER BY device_id", [owner.tenant_id])).rows;

beforeAll(async () => { db = await startH0Db("wps1seed"); }, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

describe("WP-S1: seedOwner gir seed-enhetene en eksplisitt, lukket type og ingen nøkkel", () => {
  it("produksjon: jarvis-core = service og talegateway-enheten = voice_gateway (trusted_provisioning), dev-web seedes IKKE; deretter utenfor produksjon: dev-web = web_browser; en ny kjøring endrer ingenting", async () => {
    await seedWithEnv({ JARVIS_ENV: "production" });
    expect(await rows()).toEqual([
      { device_id: "jarvis-core", kind: "service", device_kind: "service", device_kind_source: "trusted_provisioning", has_key: false },
      { device_id: VOICE_ID, kind: "voice", device_kind: "voice_gateway", device_kind_source: "trusted_provisioning", has_key: false }
    ].sort((a, b) => a.device_id.localeCompare(b.device_id, "en")));

    await seedWithEnv({});
    const afterDev = await rows();
    expect(afterDev.map((r) => r.device_id)).toEqual(["dev-web", "jarvis-core", VOICE_ID]);
    expect(afterDev.find((r) => r.device_id === "dev-web")).toEqual({ device_id: "dev-web", kind: "web", device_kind: "web_browser", device_kind_source: "trusted_provisioning", has_key: false });
    expect(afterDev.every((r) => !r.has_key && r.device_kind_source === "trusted_provisioning")).toBe(true);

    await seedWithEnv({});
    expect(await rows()).toEqual(afterDev);
    // ingen av seed-radene har en nøkkel, så de kan ikke autorisere noe uansett type (seeden er identitetsdata, ikke en tillitsgrense)
    expect((await db.adminPool.query("SELECT count(*)::int AS n FROM devices WHERE tenant_id = $1 AND public_key_pem IS NOT NULL", [owner.tenant_id])).rows[0].n).toBe(0);
  });
});
