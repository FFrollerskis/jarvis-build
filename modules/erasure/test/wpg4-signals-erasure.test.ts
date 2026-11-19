import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalHashEmbedding } from "@jarvis/memory";
import { ErasureService } from "../src/erasure-service.ts";
// Relativ import av testoppsettet (samme presedens som `situations-erasure.test.ts`: ingen ny pakkeavhengighet kun for en testfil).
import { identity, OTHER, OWNER, startG4Db, TENANT_A, TENANT_B, type G4Db } from "../../situations/test/support/wpg4-db.ts";

/**
 * WP-G4 (D-466) delta-runde (delta-review B, INFO-9): erasure av de fem G4-tabellene mot en EKTE Postgres via den EKTE `ErasureService`.
 *  - memory_space-scope: alle seks tabeller (signallogg, tilbakemelding, vurderinger, abonnementer, regeltuning, situasjoner) i rommet slettes med ærlige tellinger, også med en beslutning som refererer en situasjon (ingen FK-brudd), uten å røre andre rom eller tenants.
 *  - person-scope (NYTT): personens signallogg, vurderinger, tilbakemeldinger og abonnementer slettes i ALLE rom (også `health`, som har egen RLS-gruppe), uten å røre andre personer, andre tenants, regeltuning (rommets konfigurasjon) eller situasjonene
 *    (rommets avledede kø, uten person-kolonne; ryddes av G4-retensjonen og forsvinner med rom-/tenant-scope).
 */
let db: G4Db;
let service: ErasureService;
const PAIRS = [[TENANT_A, "home"], [TENANT_A, "health"], [TENANT_B, "home"]] as const;
const PERSONS: Record<string, readonly string[]> = { [TENANT_A]: [OWNER, OTHER], [TENANT_B]: [OWNER] };
const TABLES = ["situation_signal_log", "situation_assessments", "situation_feedback", "situation_subscriptions"] as const;

beforeAll(async () => {
  db = await startG4Db("g4erase");
  service = new ErasureService(db.appPool, db.policy, new LocalHashEmbedding());
  await db.adminPool.query(`INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-a-home','${TENANT_A}','home'), ('ms-a-health','${TENANT_A}','health'), ('ms-b-home','${TENANT_B}','home')`);
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

/** To personer i tenant A (eier + en annen), eieren alene i tenant B; ÉN rad per tabell og person i hvert rom, ÉN situasjon per rom, og regeltuning «sist endret av» den andre personen i A/home. */
async function seed(): Promise<void> {
  await db.reset();
  for (const [tenant, space] of PAIRS) {
    const sid = `sit-${tenant}-${space}`;
    await db.adminPool.query(
      `INSERT INTO situations (situation_id, tenant_id, memory_space_id, domain, detection_key, stage, priority, reason) VALUES ($1, $2, $3, $4, $5, 'inform', 'normal', 'r')`,
      [sid, tenant, space, space === "health" ? "health" : "home", `${space === "health" ? "health" : "home"}:key:${tenant}-${space}`]
    );
    for (const person of PERSONS[tenant]!) {
      const tag = `${tenant}-${space}-${person}`;
      await db.adminPool.query(
        `INSERT INTO situation_subscriptions (subscription_id, tenant_id, memory_space_id, source, event_type, domain, filter, filter_digest, created_by_person_id) VALUES ($1, $2, $3, 'incident', 'incident_active', 'infra', '{}', $4, $5)`,
        [`sub-${tag}`, tenant, space, createHash("sha256").update(tag).digest("hex"), person]
      );
      await db.adminPool.query(
        `INSERT INTO situation_signal_log (signal_id, tenant_id, memory_space_id, source, event_type, domain, source_ref, detection_key, situation_id, occurred_at, outcome, stage_after, priority, notified, facts, person_id)
         VALUES ($1, $2, $3, 'incident', 'incident_active', 'infra', $4, $5, $6, now(), 'created', 'inform', 'normal', true, '{}', $7)`,
        [`sig-${tag}`, tenant, space, `ref-${tag}`, `key-${tag}`, sid, person]
      );
      await db.adminPool.query(
        `INSERT INTO situation_feedback (feedback_id, tenant_id, memory_space_id, situation_id, rule_key, verdict, actor_person_id) VALUES ($1, $2, $3, $4, 'incident:incident_active', 'noise', $5)`,
        [`fb-${tag}`, tenant, space, sid, person]
      );
      await db.adminPool.query(
        `INSERT INTO situation_assessments (assessment_id, tenant_id, memory_space_id, situation_id, input_digest, status, person_id) VALUES ($1, $2, $3, $4, $5, 'rejected', $6)`,
        [`asm-${tag}`, tenant, space, sid, createHash("sha256").update(`asm-${tag}`).digest("hex"), person]
      );
    }
    await db.adminPool.query(
      `INSERT INTO situation_rule_tuning (tenant_id, memory_space_id, rule_key, threshold, reason, updated_by_person_id) VALUES ($1, $2, 'vision:motion_detected', 20, 'x', $3)`,
      [tenant, space, tenant === TENANT_A && space === "home" ? OTHER : OWNER]
    );
  }
}
beforeEach(seed);

const personColumn: Record<string, string> = { situation_signal_log: "person_id", situation_assessments: "person_id", situation_feedback: "actor_person_id", situation_subscriptions: "created_by_person_id" };
const count = async (table: string, tenant: string, space?: string, person?: string): Promise<number> => {
  const where = ["tenant_id = $1"];
  const values: string[] = [tenant];
  if (space !== undefined) { values.push(space); where.push(`memory_space_id = $${values.length}`); }
  if (person !== undefined) { values.push(person); where.push(`${personColumn[table] ?? "updated_by_person_id"} = $${values.length}`); }
  return (await db.adminPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where.join(" AND ")}`, values)).rows[0].n as number;
};
const erase = (scope: Parameters<ErasureService["executeErasure"]>[0]["scope"]) => service.executeErasure({ scope, requestId: `req-g4-${randomUUID()}`, identity: identity(TENANT_A, "personal") });

describe("memory_space-scope: alle seks G4-tabeller i rommet slettes (også med en beslutning som refererer en situasjon), andre rom og tenants er urørt", () => {
  it("home i tenant A: ærlige tellinger per tabell, ingen FK-brudd, `health` i A og `home` i B består", async () => {
    await db.adminPool.query(`INSERT INTO decision_log (decision_id, tenant_id, memory_space_id, title, rationale, decision_maker, related_situation_id) VALUES ('dec-1', $1, 'home', 'Ignorer døralarm', 'ok', 'owner', $2)`, [TENANT_A, `sit-${TENANT_A}-home`]);
    const result = await erase({ type: "memory_space", tenant_id: TENANT_A, memory_space_id: "home" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.record_counts).toMatchObject({ situation_signal_log: 2, situation_assessments: 2, situation_feedback: 2, situation_subscriptions: 2, situation_rule_tuning: 1, situations: 1, decision_log: 1 });
    for (const table of [...TABLES, "situation_rule_tuning", "situations", "decision_log"]) {
      expect(await count(table, TENANT_A, "home"), `${table} A/home`).toBe(0);
    }
    for (const table of [...TABLES, "situation_rule_tuning", "situations"]) {
      expect(await count(table, TENANT_A, "health"), `${table} A/health`).toBeGreaterThan(0);
      expect(await count(table, TENANT_B, "home"), `${table} B/home`).toBeGreaterThan(0);
    }
  });
});

describe("person-scope: personens signallogg, vurderinger, tilbakemeldinger og abonnementer slettes i alle rom - ingenting annet", () => {
  it("forhåndsvisningen teller kun de fire person-merkede tabellene; sletting av den andre personen i A fjerner hennes rader i home OG health, og lar eieren, regeltuning, situasjoner og tenant B stå", async () => {
    const preview = await service.previewErasure({ type: "person", tenant_id: TENANT_A, person_id: OTHER });
    expect(preview.affected).toMatchObject({ situation_signal_log: 2, situation_assessments: 2, situation_feedback: 2, situation_subscriptions: 2 });
    expect(preview.affected["situations"]).toBeUndefined(); // ingen person-kolonne: ikke i person-planen
    expect(preview.affected["situation_rule_tuning"]).toBeUndefined(); // rommets konfigurasjon, ikke personens data
    expect(preview.blockers).toEqual([]);

    const result = await erase({ type: "person", tenant_id: TENANT_A, person_id: OTHER });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.record_counts).toMatchObject({ situation_signal_log: 2, situation_assessments: 2, situation_feedback: 2, situation_subscriptions: 2 });
    for (const table of TABLES) {
      expect(await count(table, TENANT_A, "home", OTHER), `${table} OTHER/home`).toBe(0);
      expect(await count(table, TENANT_A, "health", OTHER), `${table} OTHER/health`).toBe(0); // også `health` (egen RLS-gruppe)
      expect(await count(table, TENANT_A, "home", OWNER), `${table} OWNER/home`).toBe(1); // en annen person i samme tenant er urørt
      expect(await count(table, TENANT_A, "health", OWNER), `${table} OWNER/health`).toBe(1);
      expect(await count(table, TENANT_B, "home", OWNER), `${table} B`).toBe(1); // en annen tenant er urørt
    }
    expect(await count("situation_rule_tuning", TENANT_A, "home", OTHER)).toBe(1); // regeltuning er rommets konfigurasjon (sist endret av henne), ikke hennes data
    expect(await count("situations", TENANT_A)).toBe(2); // situasjonene (ingen person-kolonne) er urørt
    expect(await count("situations", TENANT_B)).toBe(1);
  });

  it("eieren i tenant A: hennes rader i A slettes, men eierens rader i tenant B og den andre personens rader i A består (tenant-isolasjon)", async () => {
    const result = await erase({ type: "person", tenant_id: TENANT_A, person_id: OWNER });
    expect(result.status).toBe("completed");
    for (const table of TABLES) {
      expect(await count(table, TENANT_A, undefined, OWNER), `${table} OWNER/A`).toBe(0);
      expect(await count(table, TENANT_B, undefined, OWNER), `${table} OWNER/B`).toBe(1);
      expect(await count(table, TENANT_A, undefined, OTHER), `${table} OTHER/A`).toBe(2);
    }
  });

  it("tenant B: forhåndsvisningen teller kun eierens rader der, og en idempotent gjentakelse av samme forespørsel gir samme resultat uten ny sletting", async () => {
    const preview = await service.previewErasure({ type: "person", tenant_id: TENANT_B, person_id: OWNER });
    expect(preview.affected).toMatchObject({ situation_signal_log: 1, situation_assessments: 1, situation_feedback: 1, situation_subscriptions: 1 });
    const requestId = `req-g4-idem-${randomUUID()}`;
    const scope = { type: "person", tenant_id: TENANT_A, person_id: OTHER } as const;
    const first = await service.executeErasure({ scope, requestId, identity: identity(TENANT_A, "personal") });
    const second = await service.executeErasure({ scope, requestId, identity: identity(TENANT_A, "personal") });
    expect(second.idempotent_replay).toBe(true);
    expect(second.record_counts).toEqual(first.record_counts);
  });
});
