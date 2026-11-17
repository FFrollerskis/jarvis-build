import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { BusinessService } from "@jarvis/business";
import { ConversationGraphService } from "../src/service.ts";
import { CONVERSATION_CHANNELS, PHONE_CHANNELS, normalizeChannelIdentifier, normalizeE164 } from "../src/index.ts";

/**
 * WP-G1 (D-463, P1a): Conversation Graph med alle UA-7-kanalene. Rene normaliseringstester (ingen DB) + ekte embedded Postgres/RLS for lenking, E.164-treff på tvers av telefonkanalene, reversibel
 * merge/split og tverr-kanal-forpliktelser for de nye kanalene (D-121 gjelder også dem).
 */
describe("A: normalizeE164 - eksakt, aldri et gjettet landnummer", () => {
  it("godtar +, 00-prefiks og vanlige skilletegn; avviser nasjonale numre uten landnummer", () => {
    expect(normalizeE164("+47 900 00 000")).toBe("+4790000000");
    expect(normalizeE164("0047 (900) 00-000")).toBe("+4790000000");
    expect(normalizeE164("+1.415.555.2671")).toBe("+14155552671");
    expect(normalizeE164("900 00 000")).toBeNull();
    expect(normalizeE164("+0123456789")).toBeNull();
    expect(normalizeE164("+47")).toBeNull();
    expect(normalizeE164("+" + "9".repeat(16))).toBeNull();
    expect(normalizeE164("")).toBeNull();
    expect(normalizeE164("tel:+4790000000")).toBeNull();
  });

  it("rene sifre godtas KUN når kalleren eksplisitt sier det (WhatsApp wa_id)", () => {
    expect(normalizeE164("4790000000")).toBeNull();
    expect(normalizeE164("4790000000", { allowBareInternationalDigits: true })).toBe("+4790000000");
    expect(normalizeE164("0790000000", { allowBareInternationalDigits: true })).toBeNull();
  });
});

describe("B: normalizeChannelIdentifier - hver kanal har SIN lukkede form", () => {
  it("telefonkanalene gir samme normaliserte E.164; whatsapp godtar wa_id, sms/phone gjør det ikke", () => {
    for (const channel of PHONE_CHANNELS) expect(normalizeChannelIdentifier(channel, "+47 900 00 000")).toBe("+4790000000");
    expect(normalizeChannelIdentifier("whatsapp", "4790000000")).toBe("+4790000000");
    expect(() => normalizeChannelIdentifier("sms", "4790000000")).toThrow("conversation_invalid_sms_channel_identifier");
    expect(() => normalizeChannelIdentifier("phone", "900 00 000")).toThrow("conversation_invalid_phone_channel_identifier");
  });

  it("Slack krever team:bruker (scopet), Discord snowflake, Teams GUID (lowercase), Messenger/Instagram side:scopet-id", () => {
    expect(normalizeChannelIdentifier("slack", " t012abcdef:u012abcdef ")).toBe("T012ABCDEF:U012ABCDEF");
    expect(() => normalizeChannelIdentifier("slack", "U012ABCDEF")).toThrow("conversation_invalid_slack_channel_identifier");
    expect(normalizeChannelIdentifier("discord", "123456789012345678")).toBe("123456789012345678");
    expect(() => normalizeChannelIdentifier("discord", "kari#1234")).toThrow("conversation_invalid_discord_channel_identifier");
    expect(normalizeChannelIdentifier("teams", "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(() => normalizeChannelIdentifier("teams", "kari@firma.no")).toThrow("conversation_invalid_teams_channel_identifier");
    expect(normalizeChannelIdentifier("messenger", "1234567890:9876543210")).toBe("1234567890:9876543210");
    expect(() => normalizeChannelIdentifier("messenger", "9876543210")).toThrow("conversation_invalid_messenger_channel_identifier");
    expect(normalizeChannelIdentifier("instagram", "1784140000000:17841400000001")).toBe("1784140000000:17841400000001");
  });

  it("feilmeldingene ekkoer aldri identifikatoren (kan være personopplysning)", () => {
    for (const channel of CONVERSATION_CHANNELS) {
      try {
        normalizeChannelIdentifier(channel, channel === "email" ? "ikke-en-adresse-hemmelig" : "hemmelig-verdi-123");
      } catch (err) {
        expect((err as Error).message).not.toContain("hemmelig");
      }
    }
  });

  it("e-post og telegram er uendret (bakoverkompatibelt)", () => {
    expect(normalizeChannelIdentifier("email", "  Kari@Acme.NO ")).toBe("kari@acme.no");
    expect(normalizeChannelIdentifier("telegram", " 12345 ")).toBe("12345");
    expect(() => normalizeChannelIdentifier("telegram", "  ")).toThrow("conversation_empty_channel_identifier");
  });
});

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let graph: ConversationGraphService;
let business: BusinessService;
const TENANT_A = "tenant-g1-a";
const TENANT_B = "tenant-g1-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-g1ch-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_g1ch_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_g1ch_test");
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'G1 A', 'business'), ('${TENANT_B}', 'G1 B', 'business')`);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_g1ch_test", password: "pw2" });
  graph = new ConversationGraphService(app);
  business = new BusinessService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("C: migrasjon 117 - databasens CHECK speiler CONVERSATION_CHANNELS nøyaktig", () => {
  it("channel- og match_method-CHECK-ene har nøyaktig de tillatte verdiene", async () => {
    const r = await admin.query(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'conversation_channel_links'::regclass AND c.contype = 'c' ORDER BY c.conname`
    );
    const defs = (r.rows as Array<{ def: string }>).map((x) => x.def);
    const channelDef = defs.find((d) => d.includes("channel = ANY"))!;
    const listed = [...channelDef.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]!).sort();
    expect(listed).toEqual([...CONVERSATION_CHANNELS].sort());
    const methodDef = defs.find((d) => d.includes("match_method"))!;
    expect([...methodDef.matchAll(/'([a-z_0-9]+)'::text/g)].map((m) => m[1]!).sort()).toEqual(
      ["contact_sync", "exact_email", "exact_handle", "exact_phone_e164", "manual", "owner_configured"]
    );
    // En ukjent kanal og en ukjent match-metode avvises av DATABASEN uavhengig av kallerlaget.
    await admin.query("SELECT set_config('jarvis.tenant_id', $1, false), set_config('jarvis.memory_spaces', 'business', false)", [TENANT_A]);
    const idRow = await admin.query(
      "INSERT INTO conversation_identities (identity_id, tenant_id, memory_space_id) VALUES ('id-chk-1', $1, 'business') RETURNING identity_id", [TENANT_A]
    );
    await expect(
      admin.query(
        `INSERT INTO conversation_channel_links (link_id, tenant_id, memory_space_id, identity_id, channel, channel_identifier, confidence, match_method)
         VALUES ('lnk-chk-1', $1, 'business', $2, 'signal', 'x', 1, 'manual')`, [TENANT_A, (idRow.rows[0] as { identity_id: string }).identity_id]
      )
    ).rejects.toThrow();
    await expect(
      admin.query(
        `INSERT INTO conversation_channel_links (link_id, tenant_id, memory_space_id, identity_id, channel, channel_identifier, confidence, match_method)
         VALUES ('lnk-chk-2', $1, 'business', 'id-chk-1', 'sms', '+4790000000', 1, 'fuzzy_phone')`, [TENANT_A]
      )
    ).rejects.toThrow();
  });
});

describe("D: lenking og oppslag for alle nye kanaler (tenant-isolert, eksakt)", () => {
  const cases: Array<[string, string, string]> = [
    ["slack", "T012ABCDEF:U012ABCDEF", "exact_handle"],
    ["discord", "123456789012345678", "exact_handle"],
    ["whatsapp", "4790011111", "exact_phone_e164"],
    ["sms", "+4790022222", "exact_phone_e164"],
    ["teams", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "exact_handle"],
    ["messenger", "1234567890:9876543210", "exact_handle"],
    ["instagram", "1784140000000:17841400000001", "exact_handle"],
    ["phone", "+4790033333", "exact_phone_e164"]
  ];
  for (const [channel, identifier, method] of cases) {
    it(`${channel}: lenker, finner igjen med annen skrivemåte, og tenant B ser den ikke`, async () => {
      const link = await graph.linkChannelIdentity(TENANT_A, "business", {
        channel: channel as never, channel_identifier: identifier, confidence: 1, match_method: method as never
      });
      const found = await graph.resolveIdentityByChannel(TENANT_A, "business", channel as never, identifier);
      expect(found?.identity_id).toBe(link.identity_id);
      expect(await graph.resolveIdentityByChannel(TENANT_B, "business", channel as never, identifier)).toBeNull();
    });
  }

  it("en ugyldig identifikator avvises FØR noe skrives (ingen halvlenke)", async () => {
    await expect(
      graph.linkChannelIdentity(TENANT_A, "business", { channel: "sms", channel_identifier: "900 00 000", confidence: 1, match_method: "exact_phone_e164" })
    ).rejects.toThrow("conversation_invalid_sms_channel_identifier");
    expect(await admin.query("SELECT 1 FROM conversation_channel_links WHERE channel_identifier = '900 00 000'")).toHaveProperty("rowCount", 0);
  });
});

describe("E: resolveIdentityByPhone - eksakt E.164 på tvers av telefonkanalene", () => {
  it("samme nummer på sms og whatsapp = samme identitet; ukjent nummer = null; nasjonalt nummer avvises", async () => {
    const sms = await graph.linkChannelIdentity(TENANT_A, "business", { channel: "sms", channel_identifier: "+47 900 44 444", confidence: 1, match_method: "exact_phone_e164" });
    await graph.linkChannelIdentity(TENANT_A, "business", {
      identity_id: sms.identity_id, channel: "whatsapp", channel_identifier: "4790044444", confidence: 0.9, match_method: "exact_phone_e164"
    });
    expect((await graph.resolveIdentityByPhone(TENANT_A, "business", "0047 900 44 444"))?.identity_id).toBe(sms.identity_id);
    expect(await graph.resolveIdentityByPhone(TENANT_A, "business", "+4790099999")).toBeNull();
    await expect(graph.resolveIdentityByPhone(TENANT_A, "business", "900 44 444")).rejects.toThrow("conversation_invalid_phone_channel_identifier");
    expect(await graph.resolveIdentityByPhone(TENANT_B, "business", "+4790044444")).toBeNull();
  });

  it("samme nummer på TO forskjellige identiteter er et konflikt-signal: null (aldri «den første»)", async () => {
    await graph.linkChannelIdentity(TENANT_A, "business", { channel: "sms", channel_identifier: "+4790055555", confidence: 1, match_method: "exact_phone_e164" });
    await graph.linkChannelIdentity(TENANT_A, "business", { channel: "phone", channel_identifier: "+4790055555", confidence: 1, match_method: "exact_phone_e164" });
    expect(await graph.resolveIdentityByPhone(TENANT_A, "business", "+4790055555")).toBeNull();
  });
});

describe("F: reversibel merge/split og uendret confidence med de nye kanalene", () => {
  it("merge flytter de nye lenkene, split gjenoppretter EKSAKT, og confidence er uendret", async () => {
    const a = await graph.linkChannelIdentity(TENANT_A, "business", { channel: "slack", channel_identifier: "T0AAAAAAAA:U0AAAAAAAA", confidence: 0.7, match_method: "exact_handle" });
    const b = await graph.linkChannelIdentity(TENANT_A, "business", { channel: "whatsapp", channel_identifier: "+4790066666", confidence: 0.9, match_method: "exact_phone_e164" });
    const merge = await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: a.identity_id, target_identity_id: b.identity_id, confidence: 0.8, reason: "samme person (eier bekreftet)", performed_by: "owner"
    });
    expect((await graph.resolveIdentityByChannel(TENANT_A, "business", "slack", "T0AAAAAAAA:U0AAAAAAAA"))?.identity_id).toBe(b.identity_id);
    await graph.splitMerge(TENANT_A, "business", { merge_id: merge.merge_id, performed_by: "owner", reason: "feil" });
    expect((await graph.resolveIdentityByChannel(TENANT_A, "business", "slack", "T0AAAAAAAA:U0AAAAAAAA"))?.identity_id).toBe(a.identity_id);
    const links = await graph.listChannelLinks(TENANT_A, "business", a.identity_id);
    expect(links.find((l) => l.channel === "slack")?.confidence).toBeCloseTo(0.7, 5);
  });
});

describe("G: D-121 tverr-kanal-forpliktelser gjelder også de nye kanalene", () => {
  it("en forpliktelse for en kontakt vises med ALLE kanalene (slack, whatsapp, teams) i rekkevidden", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "G1 Kanal AS" });
    const contact = await business.createContact(TENANT_A, "business", { name: "Kari Kanal", company_id: company.company_id, email: "kari@g1kanal.no" });
    await business.createFollowup(TENANT_A, "business", { title: "Svar Kari på tvers av kanaler", due_at: "2099-01-01T09:00:00Z", contact_id: contact.contact_id });
    const slack = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "slack", channel_identifier: "T0BBBBBBBB:U0BBBBBBBB", confidence: 1, match_method: "exact_handle", linked_business_contact_id: contact.contact_id
    });
    await graph.linkChannelIdentity(TENANT_A, "business", { identity_id: slack.identity_id, channel: "whatsapp", channel_identifier: "+4790077777", confidence: 1, match_method: "exact_phone_e164" });
    await graph.linkChannelIdentity(TENANT_A, "business", { identity_id: slack.identity_id, channel: "teams", channel_identifier: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", confidence: 0.8, match_method: "exact_handle" });
    const view = await graph.crossChannelCommitmentView(TENANT_A, "business", slack.identity_id);
    expect(view.resolution).toBe("resolved");
    expect(view.channels.map((c) => c.channel).sort()).toEqual(["slack", "teams", "whatsapp"]);
    expect(view.commitments.map((c) => c.title)).toContain("Svar Kari på tvers av kanaler");
    const attention = await graph.crossChannelAttention(TENANT_A, "business", Date.parse("2026-11-17T00:00:00Z"));
    const entry = attention.find((e) => e.contact_id === contact.contact_id);
    expect(entry?.channel_reachable).toBe(true);
    expect(entry?.channels.map((c) => c.channel).sort()).toEqual(["slack", "teams", "whatsapp"]);
  });
});
