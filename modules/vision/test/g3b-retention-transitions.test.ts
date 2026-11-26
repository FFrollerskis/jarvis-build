import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMemoryTransaction } from "@jarvis/memory";
import { VisionRetentionConfirmationRequiredError, VisionService } from "../src/service.ts";
import { seedTenant, startVisionDb, type VisionDb } from "./support/harness.ts";

/**
 * WP-G3b (D-485), K1: UAVHENGIG FORKORTINGSORAKEL over ALLE overganger (28 forhåndstilstander x 27 nye = 756) mot ekte Postgres (app-rolle, RLS).
 *
 * Sannheten er ikke `retentionShortening` (det som testes), men det SKRIVEREN faktisk bruker for nye rader: `retentionDaysInTransaction` og `snapshotRetentionDaysInTransaction`. En forespørsel uten bekreftelse skal
 *  - ALDRI gi et kortere effektivt vindu (0 forkortinger uten bekreftelse), og
 *  - ALDRI kreve bekreftelse når ingen effektive vinduer blir kortere (0 unødvendige bekreftelser), og
 *  - ikke skrive noe når den avvises.
 * Regelen for AVLEDEDE data (G4-signalsituasjoner) kommer i tillegg og er bevist mot det ekte sveipet i apps/api/test/wpg3b-vision-retention-g4-chain.test.ts.
 */
type State = { r: number; s: number | null } | null;

let db: VisionDb;
let T: Awaited<ReturnType<typeof seedTenant>>;
let vision: VisionService;

beforeAll(async () => {
  db = await startVisionDb("g3btr");
  T = await seedTenant(db, "g3btr-t1");
  vision = new VisionService(db.app);
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

/** Det SKRIVEREN bruker for nye rader i `home` akkurat nå. */
async function writerView(): Promise<{ events: number; snapshots: number }> {
  return withMemoryTransaction(db.app, T.tenant, ["home"], async (client) => ({
    events: await vision.retentionDaysInTransaction(client, T.tenant, "home"),
    snapshots: await vision.snapshotRetentionDaysInTransaction(client, T.tenant, "home")
  }));
}

describe("forkortingsorakel: alle overganger, skriverens egne hjelpere som sannhet", () => {
  const states: State[] = [null];
  for (const r of [1, 7, 8, 30, 31, 365]) for (const s of [null, 1, 7, 8, 30, 31, 90]) if (s === null || s <= r) states.push({ r, s });

  it("28 forhåndstilstander x 27 nye = 756 overganger: ingen forkorting uten bekreftelse, ingen unødvendig bekreftelse, ingen skriving ved avvisning", async () => {
    expect(states).toHaveLength(28);
    let combos = 0, confirmedOk = 0, passedOk = 0;
    const understreng: string[] = [];
    const overstreng: string[] = [];
    for (const prev of states) {
      for (const next of states) {
        if (next === null) continue;
        combos += 1;
        await db.admin.query(`DELETE FROM vision_retention_policies WHERE tenant_id = $1`, [T.tenant]);
        if (prev !== null) await vision.setRetentionPolicy(T.tenant, "home", { retention_days: prev.r, ...(prev.s === null ? {} : { snapshot_retention_days: prev.s }) });
        const before = await writerView();
        let refused = false;
        let result: Awaited<ReturnType<VisionService["applyRetentionPolicy"]>> | undefined;
        try {
          result = await vision.applyRetentionPolicy(T.tenant, "home", { retention_days: next.r, snapshot_retention_days: next.s }, { actor_person_id: T.owner, confirm_shortening: false });
        } catch (err) {
          if (!(err instanceof VisionRetentionConfirmationRequiredError)) throw err;
          refused = true;
        }
        const after = await writerView();
        // hva en SKRIVING ville gitt, regnet direkte fra reglene for nye rader (uavhengig av `retentionShortening`)
        const wouldShorten = next.r < before.events || Math.min(next.s ?? 7, next.r) < before.snapshots;
        const label = JSON.stringify({ prev, next, before });
        if (refused) {
          expect(after, `ingen skriving ved avvisning ${label}`).toEqual(before);
          if (wouldShorten) confirmedOk += 1; else overstreng.push(label);
        } else {
          expect(result?.current.retention_days, label).toBe(next.r);
          if (wouldShorten) understreng.push(JSON.stringify({ prev, next, before, after })); else passedOk += 1;
        }
      }
    }
    expect(combos).toBe(756);
    expect(understreng, "forkorting skrevet UTEN bekreftelse").toEqual([]);
    expect(overstreng, "bekreftelse krevd uten at noe vindu ble kortere").toEqual([]);
    expect(confirmedOk + passedOk).toBe(756);
    expect(confirmedOk).toBeGreaterThan(0);
    expect(passedOk).toBeGreaterThan(0);
  }, 600_000);
});
