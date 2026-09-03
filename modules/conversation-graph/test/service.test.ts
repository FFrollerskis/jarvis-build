import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import type { ToolInvocationContext } from "@jarvis/tool-gateway";
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

/** D-119 FINAL AUTHORITY HARDENING: den ekte, tiltrodde konteksten `ToolGateway.execute()` ville bygget - ALDRI en kallerstyrt parameter. */
const contextFor = (tenantId: string): ToolInvocationContext => ({
  identity: {
    person_id: "system", tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-${tenantId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  } satisfies IdentityContext
});

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

describe("ConversationGraphService - kryss-tenant-pekervalidering (D-119 SECURITY HARDENING §11/§12)", () => {
  it("AA: avviser identity_id fra en ANNEN tenant (FK-eksistens beviser IKKE tenant-eierskap)", async () => {
    const identityInB = await graph.linkChannelIdentity(TENANT_B, "business", {
      channel: "email", channel_identifier: "cross-tenant-identity@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    await expect(
      graph.linkChannelIdentity(TENANT_A, "business", {
        identity_id: identityInB.identity_id, channel: "telegram", channel_identifier: "cross-tenant-attempt",
        confidence: 1.0, match_method: "manual"
      })
    ).rejects.toThrow("conversation_identity_not_found");
  });

  it("BB: avviser linked_business_contact_id som peker til en ANNEN tenants business_contacts-rad", async () => {
    const companyB = await business.createCompany(TENANT_B, "business", { name: "Tenant B AS" });
    const contactB = await business.createContact(TENANT_B, "business", { name: "B-kontakt", company_id: companyB.company_id, email: "b-contact@tenantb.no" });
    await expect(
      graph.linkChannelIdentity(TENANT_A, "business", {
        channel: "email", channel_identifier: "cross-tenant-contact@acme.no", confidence: 1.0, match_method: "exact_email",
        linked_business_contact_id: contactB.contact_id
      })
    ).rejects.toThrow("conversation_linked_contact_not_found");
  });

  it("CC: avviser linked_person_id for en person som IKKE er medlem av denne tenanten", async () => {
    await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-conv-not-in-a', 'Ikke i A') ON CONFLICT DO NOTHING`);
    await adminPool.query(
      `INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-conv-not-in-a', $1) ON CONFLICT DO NOTHING`,
      [TENANT_B]
    );
    await expect(
      graph.linkChannelIdentity(TENANT_A, "business", {
        channel: "email", channel_identifier: "cross-tenant-person@acme.no", confidence: 1.0, match_method: "exact_email",
        linked_person_id: "person-conv-not-in-a"
      })
    ).rejects.toThrow("conversation_linked_person_not_found");
  });

  it("DD: godtar linked_business_contact_id/linked_person_id som FAKTISK tilhoerer denne tenanten (ikke en falsk positiv)", async () => {
    const companyA = await business.createCompany(TENANT_A, "business", { name: "Tenant A Legit AS" });
    const contactA = await business.createContact(TENANT_A, "business", { name: "A-kontakt", company_id: companyA.company_id, email: "a-contact@tenanta.no" });
    await adminPool.query(
      `INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-conv-owner', $1) ON CONFLICT DO NOTHING`,
      [TENANT_A]
    );
    const link = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "legit-owned-pointers@acme.no", confidence: 1.0, match_method: "exact_email",
      linked_business_contact_id: contactA.contact_id, linked_person_id: "person-conv-owner"
    });
    expect(link.identity_id).toBeTruthy();
  });
});

describe("ConversationGraphService - multi-hop reversibilitet (D-119 SECURITY HARDENING §13/§14)", () => {
  it("EE: A->B, deretter B->C - split av A->B MENS B->C fortsatt er aktiv avvises (aldri stille overskriving av senere merge)", async () => {
    const identityA = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "chain-a@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const identityB = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "chain-b@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const identityC = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "chain-c@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const mergeAB = await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: identityA.identity_id, target_identity_id: identityB.identity_id,
      confidence: 0.9, reason: "A inn i B", performed_by: "owner"
    });
    await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: identityB.identity_id, target_identity_id: identityC.identity_id,
      confidence: 0.9, reason: "B inn i C", performed_by: "owner"
    });

    await expect(
      graph.splitMerge(TENANT_A, "business", { merge_id: mergeAB.merge_id, performed_by: "owner", reason: "forsoek paa aa reversere A->B foerst" })
    ).rejects.toThrow("conversation_split_blocked_by_later_merge");

    const bAfter = await graph.readIdentity(TENANT_A, "business", identityB.identity_id);
    expect(bAfter?.status).toBe("merged");
    expect(bAfter?.merged_into_identity_id).toBe(identityC.identity_id);
  });

  it("FF: A->B, deretter B->C - reversering i KORREKT rekkefolge (B->C foerst, saa A->B) gjenoppretter begge korrekt", async () => {
    const identityA = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "correct-order-a@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const identityB = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "correct-order-b@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const identityC = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "correct-order-c@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const mergeAB = await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: identityA.identity_id, target_identity_id: identityB.identity_id,
      confidence: 0.9, reason: "A inn i B", performed_by: "owner"
    });
    const mergeBC = await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: identityB.identity_id, target_identity_id: identityC.identity_id,
      confidence: 0.9, reason: "B inn i C", performed_by: "owner"
    });

    await graph.splitMerge(TENANT_A, "business", { merge_id: mergeBC.merge_id, performed_by: "owner", reason: "reverser B->C foerst" });
    const bAfterFirstSplit = await graph.readIdentity(TENANT_A, "business", identityB.identity_id);
    expect(bAfterFirstSplit?.status).toBe("active");

    await graph.splitMerge(TENANT_A, "business", { merge_id: mergeAB.merge_id, performed_by: "owner", reason: "reverser A->B naa" });
    const aAfterSecondSplit = await graph.readIdentity(TENANT_A, "business", identityA.identity_id);
    expect(aAfterSecondSplit?.status).toBe("active");
    expect(aAfterSecondSplit?.merged_into_identity_id).toBeNull();

    const resolvedA = await graph.resolveIdentityByChannel(TENANT_A, "business", "email", "correct-order-a@acme.no");
    expect(resolvedA?.identity_id).toBe(identityA.identity_id);
    const resolvedB = await graph.resolveIdentityByChannel(TENANT_A, "business", "email", "correct-order-b@acme.no");
    expect(resolvedB?.identity_id).toBe(identityB.identity_id);
  });

  it("GG: resolveEffectiveIdentity() foelger en A->B->C-kjede deterministisk til C, og til A etter full reversering", async () => {
    const identityA = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "effective-a@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const identityB = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "effective-b@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const identityC = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "effective-c@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const mergeAB = await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: identityA.identity_id, target_identity_id: identityB.identity_id,
      confidence: 0.9, reason: "A inn i B", performed_by: "owner"
    });
    const mergeBC = await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: identityB.identity_id, target_identity_id: identityC.identity_id,
      confidence: 0.9, reason: "B inn i C", performed_by: "owner"
    });

    const effectiveFromA = await graph.resolveEffectiveIdentity(TENANT_A, "business", identityA.identity_id);
    expect(effectiveFromA?.identity_id).toBe(identityC.identity_id);

    await graph.splitMerge(TENANT_A, "business", { merge_id: mergeBC.merge_id, performed_by: "owner", reason: "reverser B->C" });
    await graph.splitMerge(TENANT_A, "business", { merge_id: mergeAB.merge_id, performed_by: "owner", reason: "reverser A->B" });

    const effectiveAfterFullReversal = await graph.resolveEffectiveIdentity(TENANT_A, "business", identityA.identity_id);
    expect(effectiveAfterFullReversal?.identity_id).toBe(identityA.identity_id);
  });
});

describe("ConversationGraphService - samtidighet (D-119 SECURITY HARDENING §15/§16/§17, ekte parallelle Postgres-kall)", () => {
  it("HH: to SAMTIDIGE splitMerge()-kall paa SAMME merge gir noeyaktig EN vellykket reversering, den andre feiler deterministisk", async () => {
    const source = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "concurrent-split-src@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const target = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "concurrent-split-target@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const merge = await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: source.identity_id, target_identity_id: target.identity_id,
      confidence: 1.0, reason: "test samtidig split", performed_by: "owner"
    });

    const results = await Promise.allSettled([
      graph.splitMerge(TENANT_A, "business", { merge_id: merge.merge_id, performed_by: "owner", reason: "forsoek 1" }),
      graph.splitMerge(TENANT_A, "business", { merge_id: merge.merge_id, performed_by: "owner", reason: "forsoek 2" })
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain("conversation_merge_already_reversed");

    const { rows } = await adminPool.query(
      `SELECT count(*)::int AS n FROM conversation_identity_merges WHERE tenant_id = $1 AND reverses_merge_id = $2`,
      [TENANT_A, merge.merge_id]
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("II: to SAMTIDIGE foerste-lenke-forsoek for SAMME nye kanal-identifikator gir NOEYAKTIG EN kanonisk identitet (ingen fantom-rad)", async () => {
    const results = await Promise.all([
      graph.linkChannelIdentity(TENANT_A, "business", {
        channel: "email", channel_identifier: "concurrent-first-link@acme.no", confidence: 1.0, match_method: "exact_email"
      }),
      graph.linkChannelIdentity(TENANT_A, "business", {
        channel: "email", channel_identifier: "concurrent-first-link@acme.no", confidence: 1.0, match_method: "exact_email"
      })
    ]);
    expect(results[0].identity_id).toBe(results[1].identity_id);

    const { rows } = await adminPool.query(
      `SELECT count(DISTINCT identity_id)::int AS n FROM conversation_channel_links
       WHERE tenant_id = $1 AND channel = 'email' AND channel_identifier = 'concurrent-first-link@acme.no' AND status = 'active'`,
      [TENANT_A]
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("JJ: motsatte samtidige merge-forsoek (A->B og B->A) deadlocker ALDRI - noeyaktig ett lykkes deterministisk", async () => {
    const identityA = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "deadlock-a@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const identityB = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "deadlock-b@acme.no", confidence: 1.0, match_method: "exact_email"
    });

    const results = await Promise.allSettled([
      graph.mergeIdentities(TENANT_A, "business", {
        source_identity_id: identityA.identity_id, target_identity_id: identityB.identity_id,
        confidence: 1.0, reason: "A inn i B", performed_by: "owner"
      }),
      graph.mergeIdentities(TENANT_A, "business", {
        source_identity_id: identityB.identity_id, target_identity_id: identityA.identity_id,
        confidence: 1.0, reason: "B inn i A", performed_by: "owner"
      })
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/conversation_merge_source_not_active|conversation_merge_target_not_active/);
  }, 15_000);
});

describe("ToolGateway-registrering: firstWaveTools() eksponerer conversation_graph.* med korrekt capability_class", () => {
  it("U: registrerer 6 handlinger med forventet capability_class - merge_identities/split_merge/link_channel_identity ALLE FJERNET (D-119 FINAL AUTHORITY HARDENING - navnerommet er nå READ-ONLY)", () => {
    const tools = firstWaveTools({}).filter((t) => t.tool_id === "conversation_graph");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction).toEqual({
      resolve_identity: "A", read_identity: "A", resolve_effective_identity: "A", list_channel_links: "A",
      read_cross_channel_commitments: "A", read_identity_timeline: "A"
    });
    expect(byAction["merge_identities"]).toBeUndefined();
    expect(byAction["split_merge"]).toBeUndefined();
    expect(byAction["link_channel_identity"]).toBeUndefined();
  });

  it("V: alle 6 handlinger bruker den interne, ikke-hemmelige sentinel-credential_ref (JARVIS_CANONICAL, ingen ekstern leverandør)", () => {
    const tools = firstWaveTools({}).filter((t) => t.tool_id === "conversation_graph");
    expect(tools).toHaveLength(6);
    for (const t of tools) expect(t.credential_ref).toBe("JARVIS_BUSINESS_INTERNAL_TOKEN");
  });

  it("V2: INGEN av de 6 gjenværende input_schema-ene godtar tenant_id/memory_space (D-119 FINAL AUTHORITY HARDENING §4 - 'no parameter = no spoof surface')", () => {
    const tools = firstWaveTools({}).filter((t) => t.tool_id === "conversation_graph");
    for (const t of tools) {
      const parsedWithTenant = t.input_schema.safeParse({ tenant_id: TENANT_B, identity_id: "x", channel: "email", channel_identifier: "x" });
      expect(parsedWithTenant.success).toBe(false);
      const parsedWithSpace = t.input_schema.safeParse({ memory_space: "personal", identity_id: "x", channel: "email", channel_identifier: "x" });
      expect(parsedWithSpace.success).toBe(false);
    }
  });
});

describe("ConversationGraphTransport - direkte dispatch-feilbaner + tiltrodd konteksthenting (D-119 FINAL AUTHORITY HARDENING)", () => {
  const transport = () => new ConversationGraphTransport(graph);

  it("W: kaster for en ukjent handling", async () => {
    await expect(transport().invoke("does_not_exist", {}, "cred", contextFor(TENANT_A))).rejects.toThrow(
      "conversation_graph_action_not_implemented:does_not_exist"
    );
  });

  it("W2: merge_identities er IKKE lenger en dispatchbar handling (fjernet fra ToolGateway-overflaten)", async () => {
    await expect(
      transport().invoke("merge_identities", {
        source_identity_id: "conv-id-a", target_identity_id: "conv-id-b",
        confidence: 1.0, reason: "forsoek", performed_by: "owner"
      }, "cred", contextFor(TENANT_A))
    ).rejects.toThrow("conversation_graph_action_not_implemented:merge_identities");
  });

  it("W3: split_merge er IKKE lenger en dispatchbar handling (fjernet fra ToolGateway-overflaten)", async () => {
    await expect(
      transport().invoke("split_merge", { merge_id: "conv-merge-x", performed_by: "owner", reason: "forsoek" }, "cred", contextFor(TENANT_A))
    ).rejects.toThrow("conversation_graph_action_not_implemented:split_merge");
  });

  it("W4: link_channel_identity er IKKE lenger en dispatchbar handling (Blocker B - fjernet fra ToolGateway-overflaten, se transport.ts sitt filhode)", async () => {
    await expect(
      transport().invoke("link_channel_identity", { channel: "email", channel_identifier: "no-longer-dispatchable@acme.no" }, "cred", contextFor(TENANT_A))
    ).rejects.toThrow("conversation_graph_action_not_implemented:link_channel_identity");
  });

  it("X: kaster (fail-closed) naar ToolInvocationContext.identity mangler helt - ALDRI et stille fall til en parameter", async () => {
    await expect(
      transport().invoke("read_identity", { identity_id: "conv-id-x" }, "cred", {} as never)
    ).rejects.toThrow("conversation_graph_missing_invocation_context");
  });

  it("X2: kaster for manglende identity_id-parameter (selve handlingens egne parametre valideres fortsatt)", async () => {
    await expect(transport().invoke("read_identity", {}, "cred", contextFor(TENANT_A))).rejects.toThrow(
      "conversation_graph_missing_parameter:identity_id"
    );
  });

  it("Y: tenantId/memorySpace kommer UTELUKKENDE fra context.identity - en tenant_id/memory_space i parameters paavirker INGENTING (dispatch-nivaa, samme bevis som full ToolGateway-vei i security.test.ts)", async () => {
    const identityInA = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "context-derived@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    // Selv om parameters PAASTAAR tenant_id=B/memory_space=personal (feltene finnes
    // ikke lenger i input_schema, men transporten selv skal uansett IGNORERE dem
    // hvis en direkte dispatch-kaller likevel sender dem) - konteksten (A) skal vinne.
    const result = await transport().invoke(
      "read_identity",
      { identity_id: identityInA.identity_id, tenant_id: TENANT_B, memory_space: "personal" } as never,
      "cred", contextFor(TENANT_A)
    );
    expect(result.external_id).toBe(identityInA.identity_id);
  });

  it("Z: resolve_identity for en ukjent kanal-identifikator returnerer data=null uten external_id (Q-26)", async () => {
    const result = await transport().invoke(
      "resolve_identity", { channel: "email", channel_identifier: "never-dispatched@acme.no" }, "cred", contextFor(TENANT_A)
    );
    expect(result.external_id).toBeUndefined();
    expect(result.data).toBeNull();
  });
});
