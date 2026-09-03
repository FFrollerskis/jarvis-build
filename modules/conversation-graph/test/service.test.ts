import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessService } from "@jarvis/business";
import { ConversationGraphService } from "../src/service.ts";
import { ConversationGraphTransport } from "../src/transport.ts";

/**
 * UA-7 Communications Hub - foerste slice (D-119): ekte Postgres/RLS-
 * integrasjonsbevis for Conversation Graph + confidence-basert, reversibel
 * identitetsopploesning. SAMME "ekte embedded Postgres, IKKE fakePool()"-
 * mønster som `finance/test/vendor-registry.test.ts`.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let graph: ConversationGraphService;
let business: BusinessService;

const TENANT_A = "tenant-conv-a";
const TENANT_B = "tenant-conv-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-conv-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_conv_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_conv_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Conv Tenant A', 'business'), ('${TENANT_B}', 'Conv Tenant B', 'business')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-conv-owner', 'Owner One')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_conv_test", password: "pw2" });
  graph = new ConversationGraphService(appPool);
  business = new BusinessService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("ConversationGraphService - linkChannelIdentity", () => {
  it("A: oppretter en ny identitet naar ingen identity_id oppgis og ingen aktiv lenke finnes", async () => {
    const link = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "kari@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    expect(link.identity_id).toBeTruthy();
    expect(link.channel_identifier).toBe("kari@acme.no");
    const identity = await graph.readIdentity(TENANT_A, "business", link.identity_id);
    expect(identity?.status).toBe("active");
  });

  it("B: er idempotent - samme kanal-identifikator gjenbruker eksisterende aktiv lenke, ALDRI en duplikat-rad", async () => {
    const first = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "idempotent@acme.no", confidence: 0.5, match_method: "manual"
    });
    const second = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "idempotent@acme.no", confidence: 0.5, match_method: "manual"
    });
    expect(second.link_id).toBe(first.link_id);
    const links = await graph.listChannelLinks(TENANT_A, "business", first.identity_id);
    expect(links.filter((l) => l.channel_identifier === "idempotent@acme.no")).toHaveLength(1);
  });

  it("C: bumper confidence ved en høyere verdi, men repointer ALDRI identity_id stille", async () => {
    const first = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "bump@acme.no", confidence: 0.3, match_method: "manual"
    });
    const otherIdentity = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "unrelated-other@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const conflicting = await graph.linkChannelIdentity(TENANT_A, "business", {
      identity_id: otherIdentity.identity_id, channel: "email", channel_identifier: "bump@acme.no",
      confidence: 0.9, match_method: "exact_email"
    });
    expect(conflicting.identity_id).toBe(first.identity_id);
    expect(conflicting.confidence).toBe(0.9);
    const lowerAttempt = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "bump@acme.no", confidence: 0.1, match_method: "manual"
    });
    expect(lowerAttempt.confidence).toBe(0.9);
  });

  it("D: normaliserer e-post (case/whitespace) til SAMME kanal-identitet", async () => {
    const lower = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "  Norm@Acme.NO  ", confidence: 1.0, match_method: "exact_email"
    });
    const identity = await graph.resolveIdentityByChannel(TENANT_A, "business", "email", "norm@acme.no");
    expect(identity?.identity_id).toBe(lower.identity_id);
  });

  it("E: kaster for en syntaktisk ugyldig e-post kanal-identifikator", async () => {
    await expect(
      graph.linkChannelIdentity(TENANT_A, "business", { channel: "email", channel_identifier: "not-an-email", confidence: 1.0, match_method: "manual" })
    ).rejects.toThrow("conversation_invalid_email_channel_identifier");
  });

  it("F: Telegram chat-id normaliseres KUN med trim - case bevares", async () => {
    const link = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "telegram", channel_identifier: "  ChatId-123  ", confidence: 1.0, match_method: "owner_configured"
    });
    expect(link.channel_identifier).toBe("ChatId-123");
  });
});

describe("ConversationGraphService - resolveIdentityByChannel", () => {
  it("G: returnerer null for en ukjent kanal-identifikator (Q-26: ukjent forblir ukjent)", async () => {
    const identity = await graph.resolveIdentityByChannel(TENANT_A, "business", "email", "never-seen@acme.no");
    expect(identity).toBeNull();
  });
});

describe("ConversationGraphService - mergeIdentities/splitMerge (reversibilitet + confidence)", () => {
  it("H: slaar sammen to identiteter - kilde tombstones, aktive lenker repointes, ledger fanger EKSAKT hvilke", async () => {
    const source = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "merge-src@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const secondSourceLink = await graph.linkChannelIdentity(TENANT_A, "business", {
      identity_id: source.identity_id, channel: "telegram", channel_identifier: "merge-src-chat", confidence: 1.0, match_method: "owner_configured"
    });
    const target = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "merge-target@acme.no", confidence: 1.0, match_method: "exact_email"
    });

    const merge = await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: source.identity_id, target_identity_id: target.identity_id,
      confidence: 0.95, reason: "samme person, bekreftet av eier", performed_by: "owner"
    });
    expect(merge.action).toBe("merge");
    expect(new Set(merge.affected_link_ids)).toEqual(new Set([source.link_id, secondSourceLink.link_id]));

    const sourceAfter = await graph.readIdentity(TENANT_A, "business", source.identity_id);
    expect(sourceAfter?.status).toBe("merged");
    expect(sourceAfter?.merged_into_identity_id).toBe(target.identity_id);

    const targetLinks = await graph.listChannelLinks(TENANT_A, "business", target.identity_id);
    expect(targetLinks.map((l) => l.link_id).sort()).toEqual(
      [target.link_id, source.link_id, secondSourceLink.link_id].sort()
    );

    const resolved = await graph.resolveIdentityByChannel(TENANT_A, "business", "email", "merge-src@acme.no");
    expect(resolved?.identity_id).toBe(target.identity_id);
  });

  it("I: reverserer EN spesifikk merge-hendelse presist (splitMerge)", async () => {
    const source = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "split-src@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const target = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "split-target@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const merge = await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: source.identity_id, target_identity_id: target.identity_id,
      confidence: 0.4, reason: "usikker deterministisk regel", performed_by: "deterministic_rule"
    });

    const split = await graph.splitMerge(TENANT_A, "business", {
      merge_id: merge.merge_id, performed_by: "owner", reason: "feil kobling, eier korrigerte"
    });
    expect(split.action).toBe("split");
    expect(split.reverses_merge_id).toBe(merge.merge_id);

    const sourceAfter = await graph.readIdentity(TENANT_A, "business", source.identity_id);
    expect(sourceAfter?.status).toBe("active");
    expect(sourceAfter?.merged_into_identity_id).toBeNull();

    const resolved = await graph.resolveIdentityByChannel(TENANT_A, "business", "email", "split-src@acme.no");
    expect(resolved?.identity_id).toBe(source.identity_id);
  });

  it("J: en allerede reversert merge kan ikke reverseres på nytt", async () => {
    const source = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "double-split-src@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const target = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "double-split-target@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const merge = await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: source.identity_id, target_identity_id: target.identity_id,
      confidence: 1.0, reason: "test", performed_by: "owner"
    });
    await graph.splitMerge(TENANT_A, "business", { merge_id: merge.merge_id, performed_by: "owner", reason: "angre" });
    await expect(
      graph.splitMerge(TENANT_A, "business", { merge_id: merge.merge_id, performed_by: "owner", reason: "angre igjen" })
    ).rejects.toThrow("conversation_merge_already_reversed");
  });

  it("K: avviser en merge der kilde og maal er samme identitet", async () => {
    const identity = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "self-merge@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    await expect(
      graph.mergeIdentities(TENANT_A, "business", {
        source_identity_id: identity.identity_id, target_identity_id: identity.identity_id,
        confidence: 1.0, reason: "test", performed_by: "owner"
      })
    ).rejects.toThrow("conversation_merge_source_equals_target");
  });

  it("L: avviser en merge der kilden allerede er sammenslaatt (ikke aktiv)", async () => {
    const source = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "already-merged-src@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const target = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "already-merged-target@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const thirdParty = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "third-party@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: source.identity_id, target_identity_id: target.identity_id,
      confidence: 1.0, reason: "test", performed_by: "owner"
    });
    await expect(
      graph.mergeIdentities(TENANT_A, "business", {
        source_identity_id: source.identity_id, target_identity_id: thirdParty.identity_id,
        confidence: 1.0, reason: "test", performed_by: "owner"
      })
    ).rejects.toThrow("conversation_merge_source_not_active");
  });

  it("M: avviser en merge mot en ukjent identitet", async () => {
    const source = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "unknown-target-src@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    await expect(
      graph.mergeIdentities(TENANT_A, "business", {
        source_identity_id: source.identity_id, target_identity_id: "conv-id-does-not-exist",
        confidence: 1.0, reason: "test", performed_by: "owner"
      })
    ).rejects.toThrow("conversation_merge_target_not_found");
  });

  it("N: avviser split av en ukjent merge_id", async () => {
    await expect(
      graph.splitMerge(TENANT_A, "business", { merge_id: "conv-merge-does-not-exist", performed_by: "owner", reason: "test" })
    ).rejects.toThrow("conversation_merge_not_found");
  });

  it("O: databasens CHECK-constraint avviser 'ai_assisted' som performed_by selv utenom TypeScript-laget (forsvar i dybden)", async () => {
    await adminPool.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', $2, true)", [TENANT_A, "business"]);
    await expect(
      adminPool.query(
        `INSERT INTO conversation_identity_merges (merge_id, tenant_id, memory_space_id, action, source_identity_id, target_identity_id, affected_link_ids, confidence, reason, performed_by)
         SELECT 'conv-merge-illegal', $1, 'business', 'merge', ci1.identity_id, ci2.identity_id, '[]'::jsonb, 1.0, 'test', 'ai_assisted'
         FROM conversation_identities ci1, conversation_identities ci2
         WHERE ci1.tenant_id = $1 AND ci2.tenant_id = $1 LIMIT 1`,
        [TENANT_A]
      )
    ).rejects.toThrow();
  });
});

describe("ConversationGraphService - cross-channel commitments/timeline (akseptansekriterium 1)", () => {
  it("P: leser aapne business_followups for identitetens lenkede kontakt", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "Cross-Channel AS" });
    const contact = await business.createContact(TENANT_A, "business", { name: "Per Hansen", company_id: company.company_id, email: "per@crosschannel.no" });
    await business.createFollowup(TENANT_A, "business", { title: "Følg opp Per", due_at: "2026-10-01T09:00:00Z", contact_id: contact.contact_id });

    const identity = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "per@crosschannel.no", confidence: 1.0, match_method: "exact_email",
      linked_business_contact_id: contact.contact_id
    });

    const commitments = await graph.crossChannelCommitments(TENANT_A, "business", identity.identity_id);
    expect(commitments.map((c) => c.title)).toContain("Følg opp Per");
  });

  it("Q: returnerer tom liste for en identitet UTEN lenket kontakt (ukjent forblir ukjent, aldri gjettet)", async () => {
    const identity = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "no-contact-link@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const commitments = await graph.crossChannelCommitments(TENANT_A, "business", identity.identity_id);
    expect(commitments).toEqual([]);
    const timeline = await graph.identityTimeline(TENANT_A, "business", identity.identity_id);
    expect(timeline).toEqual([]);
  });
});

describe("ConversationGraphService - tenant/space-isolasjon (RLS)", () => {
  it("R: en identitet/kanal-lenke opprettet under tenant A er usynlig for tenant B", async () => {
    const link = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "isolated@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const crossTenantRead = await graph.readIdentity(TENANT_B, "business", link.identity_id);
    expect(crossTenantRead).toBeNull();
    const crossTenantResolve = await graph.resolveIdentityByChannel(TENANT_B, "business", "email", "isolated@acme.no");
    expect(crossTenantResolve).toBeNull();
  });

  it("S: samme e-postadresse under to ulike tenants gir to UAVHENGIGE identiteter", async () => {
    const linkA = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "shared-address@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const linkB = await graph.linkChannelIdentity(TENANT_B, "business", {
      channel: "email", channel_identifier: "shared-address@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    expect(linkA.identity_id).not.toBe(linkB.identity_id);
  });

  it("T: en identitet opprettet i 'business'-space er usynlig fra 'personal'-space-kontekst", async () => {
    const link = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "space-isolated@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const crossSpaceRead = await graph.readIdentity(TENANT_A, "personal", link.identity_id);
    expect(crossSpaceRead).toBeNull();
  });
});

describe("ToolGateway-registrering: firstWaveTools() eksponerer conversation_graph.* med korrekt capability_class", () => {
  it("U: registrerer alle 8 handlinger med forventet capability_class", () => {
    const tools = firstWaveTools({}).filter((t) => t.tool_id === "conversation_graph");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction).toEqual({
      resolve_identity: "A", read_identity: "A", list_channel_links: "A",
      link_channel_identity: "B", merge_identities: "C", split_merge: "C",
      read_cross_channel_commitments: "A", read_identity_timeline: "A"
    });
  });

  it("V: alle 8 handlinger bruker den interne, ikke-hemmelige sentinel-credential_ref (JARVIS_CANONICAL, ingen ekstern leverandør)", () => {
    const tools = firstWaveTools({}).filter((t) => t.tool_id === "conversation_graph");
    expect(tools).toHaveLength(8);
    for (const t of tools) expect(t.credential_ref).toBe("JARVIS_BUSINESS_INTERNAL_TOKEN");
  });
});

describe("ConversationGraphTransport - direkte dispatch-feilbaner", () => {
  const transport = () => new ConversationGraphTransport(graph);

  it("W: kaster for en ukjent handling", async () => {
    await expect(transport().invoke("does_not_exist", { tenant_id: TENANT_A })).rejects.toThrow(
      "conversation_graph_action_not_implemented:does_not_exist"
    );
  });

  it("X: kaster for manglende tenant_id", async () => {
    await expect(transport().invoke("read_identity", { identity_id: "conv-id-x" })).rejects.toThrow(
      "conversation_graph_missing_parameter:tenant_id"
    );
  });

  it("Y: link_channel_identity dispatcher ruter korrekt til service og returnerer external_id", async () => {
    const result = await transport().invoke("link_channel_identity", {
      tenant_id: TENANT_A, memory_space: "business", channel: "email",
      channel_identifier: "transport-dispatch@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    expect(result.external_id).toBeTruthy();
  });

  it("Z: resolve_identity for en ukjent kanal-identifikator returnerer data=null uten external_id (Q-26)", async () => {
    const result = await transport().invoke("resolve_identity", {
      tenant_id: TENANT_A, memory_space: "business", channel: "email", channel_identifier: "never-dispatched@acme.no"
    });
    expect(result.external_id).toBeUndefined();
    expect(result.data).toBeNull();
  });
});
