import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";

/**
 * WP-G1 (D-463, migrasjon 118/119): Q-20-sletting av en memory space med kommunikasjonsdata. Rekkefølgen i `plan.ts` er det som bevises mot ekte Postgres: deltakere (FK -> identiteter), innkommende hendelser (FK -> identiteter),
 * møter, journal, avmeldinger og kontoer slettes FØR `conversation_identities` - en FK-regresjon ville gitt status `failed`. Annen tenant og annen memory space berøres ikke.
 */
const TENANT = "tenant-g1-erase";
const OTHER = "tenant-g1-erase-other";
const OWNER = "person-g1-erase-owner";
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;

const identity: IdentityContext = { person_id: OWNER, tenant_id: TENANT, memory_space_id: "business", session_id: "sess-g1-erase", device_id: "dev-g1-erase", channel: "api", auth_strength: "active" };

async function seed(tenant: string, space: string, tag: string, i: number): Promise<void> {
  const hash = (c: string) => `${i}${c.repeat(64)}`.slice(0, 64);
  const account = `+479100000${i}`;
  await admin.query(`INSERT INTO conversation_identities (identity_id, tenant_id, memory_space_id, display_name) VALUES ($1, $2, $3, 'Test')`, [`conv-id-${tag}`, tenant, space]);
  await admin.query(`INSERT INTO comms_authorized_accounts (tenant_id, account_id, memory_space_id, channel, account_ref, provider, source) VALUES ($1, $2, $3, 'sms', $4, 'twilio', 'tool')`, [tenant, `acct-${tag}-0001`, space, account]);
  await admin.query(`INSERT INTO comms_recipient_opt_outs (tenant_id, opt_out_id, memory_space_id, channel, recipient_hash, source) VALUES ($1, $2, $3, 'sms', $4, 'owner_recorded')`, [tenant, `optout-${tag}-01`, space, hash("a")]);
  await admin.query(
    `INSERT INTO comms_outbound_log (tenant_id, log_id, memory_space_id, request_id, kind, channel, account_ref, provider, recipient_hash, purpose, status, rule_evaluation, recipient_proof, person_id, session_id, source, retention_until)
     VALUES ($1, $2, $3, $4, 'message', 'sms', $7, 'twilio', $5, 'transactional', 'sent', '[]', '{}', $6, 's', 'tool', now() + interval '1 day')`, [tenant, `clog-${tag}-0001`, space, `req-${tag}-0001`, hash("b"), OWNER, account]);
  await admin.query(
    `INSERT INTO comms_inbound_events (tenant_id, event_id, memory_space_id, provider, channel, event_key, kind, identity_id, signature_verified, retention_until, source, ingest_id)
     VALUES ($1, $2, $3, 'twilio', 'sms', $4, 'message', $5, true, now() + interval '1 day', 'webhook:twilio', $6)`, [tenant, `cevt-${tag}-0001`, space, `key-${tag}`, `conv-id-${tag}`, `ingest-${tag}-0001`]);
  await admin.query(
    `INSERT INTO comms_meetings (tenant_id, meeting_id, memory_space_id, source, content_sha256, segment_count, legal_basis_attested, person_id, session_id, retention_until)
     VALUES ($1, $2, $3, 'text_transcript', $4, 1, true, $5, 's', now() + interval '1 day')`, [tenant, `meet-${tag}-0001`, space, hash("c"), OWNER]);
  await admin.query(
    `INSERT INTO comms_meeting_participants (tenant_id, meeting_id, memory_space_id, participant_ref, display_name, identity_id, resolution) VALUES ($1, $2, $3, 'p1', 'Test', $4, 'exact')`, [tenant, `meet-${tag}-0001`, space, `conv-id-${tag}`]);
  await admin.query(
    `INSERT INTO comms_meeting_commitments (tenant_id, meeting_id, memory_space_id, commitment_id, commitment_text, rule, segment_index) VALUES ($1, $2, $3, $4, 'Jeg skal sende tilbudet', 'no_skal_maa', 0)`, [tenant, `meet-${tag}-0001`, space, `mcom-${tag}-0001`]);
}

const TABLES = ["comms_authorized_accounts", "comms_recipient_opt_outs", "comms_outbound_log", "comms_inbound_events", "comms_meetings", "comms_meeting_participants", "comms_meeting_commitments", "conversation_identities"];
const count = async (table: string, tenant: string, space: string) => ((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND memory_space_id = $2`, [tenant, space])).rows[0] as { n: number }).n;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-g1-erasure-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_g1_erasure LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_g1_erasure");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','G1 erase','business'), ('${OTHER}','G1 erase other','business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}'), ('${OWNER}','${OTHER}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-g1-erase-business','${TENANT}','business'), ('ms-g1-erase-project','${TENANT}','project'), ('ms-g1-erase-other','${OTHER}','business');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_g1_erasure", password: "pw2" });
  await seed(TENANT, "business", "a", 1);
  await seed(TENANT, "project", "b", 2);
  await seed(OTHER, "business", "c", 3);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("Q-20: sletting av en memory space tar ALLE kommunikasjonstabellene uten FK-brudd", () => {
  it("executeErasure (business) fullfører; alle comms-tabeller og identiteter i rommet er borte; annet rom og annen tenant er urørt", async () => {
    for (const t of TABLES) expect(await count(t, TENANT, "business"), t).toBeGreaterThan(0);
    const service = new ErasureService(app, new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [TENANT, OTHER] } }), new LocalHashEmbedding());
    const result = await service.executeErasure({ scope: { type: "memory_space", tenant_id: TENANT, memory_space_id: "business" }, requestId: "req-g1-erase-0001", identity });
    expect(result.status).toBe("completed");
    for (const t of TABLES) {
      expect(await count(t, TENANT, "business"), `${t}: slettet`).toBe(0);
      expect(await count(t, TENANT, "project"), `${t}: annet rom urørt`).toBeGreaterThan(0);
      expect(await count(t, OTHER, "business"), `${t}: annen tenant urørt`).toBeGreaterThan(0);
    }
  });
});
