import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
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
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
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
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
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
  await stopEmbeddedPostgres?.();
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
  it("U: registrerer 8 handlinger med forventet capability_class - merge_identities/split_merge/link_channel_identity ALLE FJERNET (D-119 FINAL AUTHORITY HARDENING - navnerommet er nå READ-ONLY; D-121 la til to NYE lese-handlinger, fortsatt klasse A)", () => {
    const tools = firstWaveTools({}).filter((t) => t.tool_id === "conversation_graph");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction).toEqual({
      resolve_identity: "A", read_identity: "A", resolve_effective_identity: "A", list_channel_links: "A",
      read_cross_channel_commitments: "A", read_identity_timeline: "A",
      read_cross_channel_commitment_view: "A", read_cross_channel_attention: "A"
    });
    expect(byAction["merge_identities"]).toBeUndefined();
    expect(byAction["split_merge"]).toBeUndefined();
    expect(byAction["link_channel_identity"]).toBeUndefined();
  });

  it("U2: D-121 introduserte INGEN mutasjonsflate - ALLE conversation_graph.*-handlinger er fortsatt klasse A, reversible og idempotente (READ-ONLY-invarianten holder)", () => {
    const tools = firstWaveTools({}).filter((t) => t.tool_id === "conversation_graph");
    for (const t of tools) {
      expect(t.capability_class).toBe("A");
      expect(t.reversible).toBe(true);
      expect(t.idempotent_external).toBe(true);
      expect(t.scopes).toEqual(["conversation_graph.read"]);
    }
  });

  it("V: alle 8 handlinger bruker den interne, ikke-hemmelige sentinel-credential_ref (JARVIS_CANONICAL, ingen ekstern leverandør)", () => {
    const tools = firstWaveTools({}).filter((t) => t.tool_id === "conversation_graph");
    expect(tools).toHaveLength(8);
    for (const t of tools) expect(t.credential_ref).toBe("JARVIS_BUSINESS_INTERNAL_TOKEN");
  });

  it("V2: INGEN av de 8 gjenværende input_schema-ene godtar tenant_id/memory_space (D-119 FINAL AUTHORITY HARDENING §4 - 'no parameter = no spoof surface')", () => {
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

/* =========================================================================
 * UA-7 slice 2 (D-121): tverr-kanal-forpliktelser + neste handlinger.
 * Akseptansekriterium 1 ordrett: "Open commitments AND NEXT ACTIONS visible
 * ACROSS CHANNELS".
 * ========================================================================= */

/** Faste tidspunkter - ALDRI Date.now() i assertions, slik at bucket-utfall er deterministiske. */
const NOW = Date.parse("2026-09-04T12:00:00Z");
const PAST = "2026-09-01T09:00:00Z";
const SOON = "2026-09-05T09:00:00Z"; // < 48t frem
const FAR = "2026-12-01T09:00:00Z";

/** Direkte, deterministisk open-loop-innsetting (ingen sveip-avhengighet) - samme RLS-vei som produksjonskoden. */
async function insertOpenLoop(
  tenantId: string,
  row: {
    open_loop_id: string; detection_key: string; loop_type: string; reason: string;
    contact_id?: string | null; next_action?: string | null; due_at?: string | null;
    priority?: string; detection_method?: string; canonical_uri?: string | null; status?: string;
  }
): Promise<void> {
  await adminPool.query(
    `INSERT INTO business_open_loops
       (open_loop_id, tenant_id, memory_space_id, contact_id, loop_type, detection_key, detection_method,
        reason, next_action, canonical_uri, priority, status, due_at)
     VALUES ($1, $2, 'business', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      row.open_loop_id, tenantId, row.contact_id ?? null, row.loop_type, row.detection_key,
      row.detection_method ?? "deterministic", row.reason, row.next_action ?? null,
      row.canonical_uri ?? null, row.priority ?? "normal", row.status ?? "open", row.due_at ?? null
    ]
  );
}

describe("D-121: crossChannelCommitmentView - forpliktelser OG neste handlinger, med kanal-naabarhet", () => {
  it("AA: unionerer business_followups OG business_open_loops for den lenkede kontakten, med korrekt kilde/proveniens", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "Union AS" });
    const contact = await business.createContact(TENANT_A, "business", { name: "Union Kontakt", company_id: company.company_id, email: "union@union.no" });
    await business.createFollowup(TENANT_A, "business", { title: "Eksplisitt oppfoelging", due_at: FAR, contact_id: contact.contact_id });
    await insertOpenLoop(TENANT_A, {
      open_loop_id: "ol-union-1", detection_key: "d121:union:1", loop_type: "stalled_opportunity",
      reason: "Ingen aktivitet paa 30 dager", next_action: "Ring kunden", contact_id: contact.contact_id,
      due_at: PAST, priority: "high", canonical_uri: "https://mail.google.com/mail/u/0/#all/msg-union"
    });

    const link = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "union@union.no", confidence: 1.0, match_method: "exact_email",
      linked_business_contact_id: contact.contact_id
    });

    const view = await graph.crossChannelCommitmentView(TENANT_A, "business", link.identity_id, NOW);
    expect(view.resolution).toBe("resolved");
    expect(view.effective_identity_id).toBe(link.identity_id);
    expect(view.linked_business_contact_id).toBe(contact.contact_id);

    const byKind = Object.fromEntries(view.commitments.map((c) => [c.source_kind, c]));
    expect(Object.keys(byKind).sort()).toEqual(["business_followup", "business_open_loop"]);
    expect(byKind["business_followup"]!.title).toBe("Eksplisitt oppfoelging");
    expect(byKind["business_followup"]!.provenance).toBe("explicit");
    expect(byKind["business_open_loop"]!.next_action).toBe("Ring kunden");
    expect(byKind["business_open_loop"]!.provenance).toBe("deterministic");
    expect(byKind["business_open_loop"]!.canonical_uri).toBe("https://mail.google.com/mail/u/0/#all/msg-union");

    // Deterministisk rekkefoelge: forfalt (PAST) foer fremtidig (FAR).
    expect(view.commitments[0]!.source_kind).toBe("business_open_loop");
    // Delt bucket-regel: high + forfalt = critical.
    expect(view.commitments[0]!.bucket).toBe("critical");
    expect(view.commitments[1]!.bucket).toBe("informational");
  });

  it("AB: 'across channels' er bokstavelig - unionen av ALLE aktive kanal-lenker (e-post + telegram) foelger med visningen", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "Multikanal AS" });
    const contact = await business.createContact(TENANT_A, "business", { name: "Multi Kontakt", company_id: company.company_id, email: "multi@multikanal.no" });
    await business.createFollowup(TENANT_A, "business", { title: "Multikanal-oppfoelging", due_at: SOON, contact_id: contact.contact_id });

    const emailLink = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "multi@multikanal.no", confidence: 1.0, match_method: "exact_email",
      linked_business_contact_id: contact.contact_id
    });
    await graph.linkChannelIdentity(TENANT_A, "business", {
      identity_id: emailLink.identity_id, channel: "telegram", channel_identifier: "555444333",
      confidence: 0.8, match_method: "owner_configured"
    });

    const view = await graph.crossChannelCommitmentView(TENANT_A, "business", emailLink.identity_id, NOW);
    expect(view.channels.map((c) => c.channel)).toEqual(["email", "telegram"]);
    expect(view.channels.find((c) => c.channel === "telegram")).toMatchObject({
      channel_identifier: "555444333", confidence: 0.8, match_method: "owner_configured"
    });
    expect(view.commitments.map((c) => c.title)).toContain("Multikanal-oppfoelging");
    expect(view.commitments[0]!.bucket).toBe("due_soon");
  });

  it("AC: en REVOKERT kanal-lenke er historikk, ALDRI rapportert som en kanal motparten kan naas paa naa", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "Revokert AS" });
    const contact = await business.createContact(TENANT_A, "business", { name: "Revokert Kontakt", company_id: company.company_id, email: "revokert@revokert.no" });
    const link = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "revokert@revokert.no", confidence: 1.0, match_method: "exact_email",
      linked_business_contact_id: contact.contact_id
    });
    await adminPool.query(
      `UPDATE conversation_channel_links SET status = 'revoked', revoked_at = now() WHERE tenant_id = $1 AND link_id = $2`,
      [TENANT_A, link.link_id]
    );
    const view = await graph.crossChannelCommitmentView(TENANT_A, "business", link.identity_id, NOW);
    expect(view.channels).toEqual([]);
  });

  it("AD: skiller EKSPLISITT mellom 'ingen lenket kontakt' og 'identitet ikke funnet' - en tom liste er aldri tvetydig", async () => {
    const orphan = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "d121-orphan@acme.no", confidence: 1.0, match_method: "exact_email"
    });
    const noContact = await graph.crossChannelCommitmentView(TENANT_A, "business", orphan.identity_id, NOW);
    expect(noContact.resolution).toBe("no_linked_contact");
    expect(noContact.commitments).toEqual([]);
    expect(noContact.channels).toHaveLength(1); // kanalen er kjent selv om kontakten ikke er det

    const missing = await graph.crossChannelCommitmentView(TENANT_A, "business", "conv-id-finnes-ikke", NOW);
    expect(missing.resolution).toBe("identity_not_found");
    expect(missing.effective_identity_id).toBeNull();
    expect(missing.channels).toEqual([]);
    expect(missing.commitments).toEqual([]);
  });

  it("AE: KORREKTHETSFIKS - et oppslag paa en SAMMENSLAATT (tombstonet) identitet returnerer maal-identitetens forpliktelser, ikke kildens foer-merge-bilde", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "Merge Commit AS" });
    const target = await business.createContact(TENANT_A, "business", { name: "Merge Maal", company_id: company.company_id, email: "merge-target@mc.no" });
    await business.createFollowup(TENANT_A, "business", { title: "Maalets forpliktelse", due_at: FAR, contact_id: target.contact_id });

    // Kilden har BEVISST ingen lenket kontakt - foer D-121 ga et oppslag paa
    // den (etter merge) en TOM liste, altsaa nettopp det tverr-kanal-bildet
    // merge-en fantes for aa skape.
    const sourceLink = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "telegram", channel_identifier: "d121-merge-source", confidence: 0.6, match_method: "owner_configured"
    });
    const targetLink = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "merge-target@mc.no", confidence: 1.0, match_method: "exact_email",
      linked_business_contact_id: target.contact_id
    });

    const merge = await graph.mergeIdentities(TENANT_A, "business", {
      source_identity_id: sourceLink.identity_id, target_identity_id: targetLink.identity_id,
      confidence: 0.95, reason: "Samme motpart, bekreftet av eier", performed_by: "owner"
    });

    const view = await graph.crossChannelCommitmentView(TENANT_A, "business", sourceLink.identity_id, NOW);
    expect(view.requested_identity_id).toBe(sourceLink.identity_id);
    expect(view.effective_identity_id).toBe(targetLink.identity_id);
    expect(view.resolution).toBe("resolved");
    expect(view.commitments.map((c) => c.title)).toContain("Maalets forpliktelse");
    // Unionen av begge kanalene, som er hele poenget med merge-en.
    expect(view.channels.map((c) => c.channel).sort()).toEqual(["email", "telegram"]);

    // SAMME fiks gjelder den smale, bakoverkompatible handlingen og tidslinjen.
    const narrow = await graph.crossChannelCommitments(TENANT_A, "business", sourceLink.identity_id);
    expect(narrow.map((c) => c.title)).toContain("Maalets forpliktelse");

    // Reversibilitet bevart: etter split gaar oppslaget tilbake til foer-merge-bildet.
    await graph.splitMerge(TENANT_A, "business", {
      merge_id: merge.merge_id, performed_by: "owner", reason: "Feilaktig sammenslaaing"
    });
    const afterSplit = await graph.crossChannelCommitmentView(TENANT_A, "business", sourceLink.identity_id, NOW);
    expect(afterSplit.effective_identity_id).toBe(sourceLink.identity_id);
    expect(afterSplit.resolution).toBe("no_linked_contact");
    expect(afterSplit.commitments).toEqual([]);
  });

  it("AF: gjengir ai_assisted-proveniens UENDRET - en modell-detektert neste handling blir ALDRI presentert som deterministisk bevist", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "Proveniens AS" });
    const contact = await business.createContact(TENANT_A, "business", { name: "Proveniens Kontakt", company_id: company.company_id, email: "prov@proveniens.no" });
    await insertOpenLoop(TENANT_A, {
      open_loop_id: "ol-prov-ai", detection_key: "d121:prov:ai", loop_type: "stalled_opportunity",
      reason: "Modell-foreslaatt", next_action: "Vurder oppfoelging", contact_id: contact.contact_id,
      due_at: FAR, detection_method: "ai_assisted"
    });
    const link = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "prov@proveniens.no", confidence: 1.0, match_method: "exact_email",
      linked_business_contact_id: contact.contact_id
    });
    const view = await graph.crossChannelCommitmentView(TENANT_A, "business", link.identity_id, NOW);
    const aiEntry = view.commitments.find((c) => c.source_id === "ol-prov-ai");
    expect(aiEntry?.provenance).toBe("ai_assisted");
  });

  it("AG: en LUKKET forpliktelse/loep vises ikke (kun status='open' i begge kilder)", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "Lukket AS" });
    const contact = await business.createContact(TENANT_A, "business", { name: "Lukket Kontakt", company_id: company.company_id, email: "lukket@lukket.no" });
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Blir fullfoert", due_at: FAR, contact_id: contact.contact_id });
    await business.completeFollowup(TENANT_A, "business", followup.followup_id);
    await insertOpenLoop(TENANT_A, {
      open_loop_id: "ol-lukket", detection_key: "d121:lukket", loop_type: "stalled_opportunity",
      reason: "Allerede loest", contact_id: contact.contact_id, status: "resolved", due_at: FAR
    });
    const link = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "lukket@lukket.no", confidence: 1.0, match_method: "exact_email",
      linked_business_contact_id: contact.contact_id
    });
    const view = await graph.crossChannelCommitmentView(TENANT_A, "business", link.identity_id, NOW);
    expect(view.resolution).toBe("resolved");
    expect(view.commitments).toEqual([]);
  });

  it("AH: rent lese-oppslag - to identiske kall gir identisk resultat og skriver INGEN rad noe sted (idempotent/ikke-muterende)", async () => {
    const before = await adminPool.query(
      `SELECT (SELECT count(*) FROM conversation_identities) AS i,
              (SELECT count(*) FROM conversation_channel_links) AS l,
              (SELECT count(*) FROM conversation_identity_merges) AS m,
              (SELECT count(*) FROM business_followups) AS f,
              (SELECT count(*) FROM business_open_loops) AS o`
    );
    const identity = await graph.resolveIdentityByChannel(TENANT_A, "business", "email", "union@union.no");
    const first = await graph.crossChannelCommitmentView(TENANT_A, "business", identity!.identity_id, NOW);
    const second = await graph.crossChannelCommitmentView(TENANT_A, "business", identity!.identity_id, NOW);
    expect(second).toEqual(first);
    await graph.crossChannelAttention(TENANT_A, "business", NOW);
    const after = await adminPool.query(
      `SELECT (SELECT count(*) FROM conversation_identities) AS i,
              (SELECT count(*) FROM conversation_channel_links) AS l,
              (SELECT count(*) FROM conversation_identity_merges) AS m,
              (SELECT count(*) FROM business_followups) AS f,
              (SELECT count(*) FROM business_open_loops) AS o`
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe("D-121: crossChannelAttention - tenant-bred tverr-kanal-visning", () => {
  it("AI: hver rad baerer sin kanal-naabarhet, og forpliktelser UTEN noen kommunikasjonsidentitet rapporteres EKSPLISITT som ikke-naabare", async () => {
    const entries = await graph.crossChannelAttention(TENANT_A, "business", NOW);

    const reachable = entries.find((e) => e.commitment.source_id === "ol-union-1");
    expect(reachable?.channel_reachable).toBe(true);
    expect(reachable?.channels.map((c) => c.channel)).toEqual(["email"]);
    expect(reachable?.identities.length).toBeGreaterThan(0);
    expect(reachable?.identities.every((i) => i.identity_id.length > 0)).toBe(true);

    // En kontaktloes finans-/kontrakt-loop er en helt reell aapen neste handling,
    // men INGEN kanal naar den - det maa staa eksplisitt, aldri stille utelates.
    await insertOpenLoop(TENANT_A, {
      open_loop_id: "ol-uten-motpart", detection_key: "d121:uten-motpart", loop_type: "finance_spend_unexpected",
      reason: "Ukjent utgift", next_action: "Undersoek utgiften", contact_id: null, due_at: PAST, priority: "high"
    });
    const withOrphan = await graph.crossChannelAttention(TENANT_A, "business", NOW);
    const orphan = withOrphan.find((e) => e.commitment.source_id === "ol-uten-motpart");
    expect(orphan).toBeDefined();
    expect(orphan!.channel_reachable).toBe(false);
    expect(orphan!.channels).toEqual([]);
    expect(orphan!.identities).toEqual([]);
    expect(orphan!.commitment.bucket).toBe("critical");
  });

  it("AJ: sortert deterministisk paa forfall - rader uten frist kommer sist, aldri en fabrikkert dato", async () => {
    await insertOpenLoop(TENANT_A, {
      open_loop_id: "ol-uten-frist", detection_key: "d121:uten-frist", loop_type: "stalled_opportunity",
      reason: "Ingen frist satt", contact_id: null, due_at: null
    });
    const entries = await graph.crossChannelAttention(TENANT_A, "business", NOW);
    const dueAts = entries.map((e) => e.commitment.due_at);
    const firstNullIndex = dueAts.indexOf(null);
    expect(firstNullIndex).toBeGreaterThan(-1);
    // Ingen ikke-null frist etter den foerste null-en.
    expect(dueAts.slice(firstNullIndex).every((d) => d === null)).toBe(true);
    // Stigende blant de med frist.
    const withDue = dueAts.slice(0, firstNullIndex) as string[];
    expect([...withDue].sort()).toEqual(withDue);
    expect(entries.find((e) => e.commitment.source_id === "ol-uten-frist")!.commitment.bucket).toBe("informational");
  });

  it("AK: en TOMBSTONET identitet dukker ALDRI opp som en egen rad - dens kanaler tilhoerer naa maal-identiteten", async () => {
    const entries = await graph.crossChannelAttention(TENANT_A, "business", NOW);
    const identityIds = entries.flatMap((e) => e.identities.map((i) => i.identity_id));
    const { rows } = await adminPool.query(
      `SELECT identity_id FROM conversation_identities WHERE tenant_id = $1 AND status = 'merged'`,
      [TENANT_A]
    );
    for (const row of rows as Array<{ identity_id: string }>) {
      expect(identityIds).not.toContain(row.identity_id);
    }
  });

  it("AL: tenant-isolasjon - tenant B ser ALDRI tenant A sine forpliktelser eller kanaler (RLS)", async () => {
    const companyB = await business.createCompany(TENANT_B, "business", { name: "B-selskap" });
    const contactB = await business.createContact(TENANT_B, "business", { name: "B-kontakt", company_id: companyB.company_id, email: "kun-b@b.no" });
    await business.createFollowup(TENANT_B, "business", { title: "Kun for B", due_at: FAR, contact_id: contactB.contact_id });

    const bEntries = await graph.crossChannelAttention(TENANT_B, "business", NOW);
    expect(bEntries.map((e) => e.commitment.title)).toContain("Kun for B");
    expect(bEntries.map((e) => e.commitment.source_id)).not.toContain("ol-union-1");

    const aEntries = await graph.crossChannelAttention(TENANT_A, "business", NOW);
    expect(aEntries.map((e) => e.commitment.title)).not.toContain("Kun for B");
  });

  /*
   * D-121 REVIEW-REGRESJON (AQ/AR): `046_conversation_graph.sql:94` har KUN en
   * IKKE-unik indeks paa (tenant_id, linked_business_contact_id) - FLERE
   * aktive identiteter kan derfor lovlig peke paa SAMME kontakt. Begge
   * testene under bygger den tilstanden gjennom det ORDINAERE offentlige
   * API-et (`linkChannelIdentity` uten `identity_id` for en NY
   * kanal-identifikator oppretter en ny identitet, service.ts:233-247) -
   * altsaa ingen hand-laget SQL-tilstand som ikke kan oppstaa i produksjon.
   *
   * `created_at` settes eksplisitt bakover for den foerste identiteten slik
   * at "eldst" er entydig og testen ikke kan vippe paa mikrosekund-likhet.
   */
  it("AQ: TO aktive identiteter mot SAMME kontakt - kanal-rekkevidden er UNIONEN over begge, aldri kun den eldste", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "Multi-identitet AS" });
    const contact = await business.createContact(TENANT_A, "business", {
      name: "Multi Kontakt", company_id: company.company_id, email: "multi@multi.no"
    });
    await insertOpenLoop(TENANT_A, {
      open_loop_id: "ol-multi-identitet", detection_key: "d121:multi:1", loop_type: "stalled_opportunity",
      reason: "To aktive identiteter", next_action: "Foelg opp", contact_id: contact.contact_id,
      due_at: SOON, priority: "high"
    });

    const first = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "multi@multi.no", confidence: 1.0, match_method: "exact_email",
      display_name: "Multi via e-post", linked_business_contact_id: contact.contact_id
    });
    await adminPool.query(
      `UPDATE conversation_identities SET created_at = '2026-01-01T00:00:00Z' WHERE tenant_id = $1 AND identity_id = $2`,
      [TENANT_A, first.identity_id]
    );
    const second = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "telegram", channel_identifier: "tg-multi-9001", confidence: 0.9, match_method: "owner_configured",
      display_name: "Multi via Telegram", linked_business_contact_id: contact.contact_id
    });

    // Forutsetningen testen hviler paa: to SEPARATE, BEGGE aktive identiteter mot samme kontakt.
    expect(second.identity_id).not.toBe(first.identity_id);
    const { rows: activeRows } = await adminPool.query(
      `SELECT identity_id FROM conversation_identities
       WHERE tenant_id = $1 AND status = 'active' AND linked_business_contact_id = $2`,
      [TENANT_A, contact.contact_id]
    );
    expect(activeRows).toHaveLength(2);

    const entry = (await graph.crossChannelAttention(TENANT_A, "business", NOW))
      .find((e) => e.commitment.source_id === "ol-multi-identitet");
    expect(entry).toBeDefined();

    // Unionen: BEGGE kanalene, deterministisk sortert - ingen stille utelatt.
    expect(entry!.channel_reachable).toBe(true);
    expect(entry!.channels.map((c) => `${c.channel}:${c.channel_identifier}`))
      .toEqual(["email:multi@multi.no", "telegram:tg-multi-9001"]);

    // Attribusjonen er EKSAKT: hver kanal ligger under identiteten som faktisk
    // eier lenken - aldri merket som om alt tilhoerte EN vilkaarlig identitet.
    expect(entry!.identities.map((i) => i.identity_id)).toEqual([first.identity_id, second.identity_id]);
    expect(entry!.identities[0]!.display_name).toBe("Multi via e-post");
    expect(entry!.identities[0]!.channels.map((c) => c.channel_identifier)).toEqual(["multi@multi.no"]);
    expect(entry!.identities[1]!.display_name).toBe("Multi via Telegram");
    expect(entry!.identities[1]!.channels.map((c) => c.channel_identifier)).toEqual(["tg-multi-9001"]);
    // Proveniensen per kanal er gjengitt UENDRET fra kilden, ikke slaatt sammen bort.
    expect(entry!.identities[1]!.channels[0]!.match_method).toBe("owner_configured");
    expect(entry!.identities[1]!.channels[0]!.confidence).toBeCloseTo(0.9, 5);
  });

  it("AR: eldste identitet har KUN en revokert lenke mens en SENERE identitet er naabar - forpliktelsen merkes ALDRI falskt som unaabar", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "Eldste-revokert AS" });
    const contact = await business.createContact(TENANT_A, "business", {
      name: "Eldste Revokert Kontakt", company_id: company.company_id, email: "eldste@eldste.no"
    });
    await business.createFollowup(TENANT_A, "business", {
      title: "Naabar via senere identitet", due_at: FAR, contact_id: contact.contact_id
    });

    const oldest = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "email", channel_identifier: "eldste@eldste.no", confidence: 1.0, match_method: "exact_email",
      display_name: "Eldste (revokert)", linked_business_contact_id: contact.contact_id
    });
    await adminPool.query(
      `UPDATE conversation_identities SET created_at = '2026-01-01T00:00:00Z' WHERE tenant_id = $1 AND identity_id = $2`,
      [TENANT_A, oldest.identity_id]
    );
    // Eldste identitet mister sin ENESTE kanal - identiteten forblir aktiv, men naas ikke.
    await adminPool.query(
      `UPDATE conversation_channel_links SET status = 'revoked', revoked_at = now() WHERE tenant_id = $1 AND link_id = $2`,
      [TENANT_A, oldest.link_id]
    );
    const later = await graph.linkChannelIdentity(TENANT_A, "business", {
      channel: "telegram", channel_identifier: "tg-senere-7002", confidence: 0.95, match_method: "owner_configured",
      display_name: "Senere (naabar)", linked_business_contact_id: contact.contact_id
    });
    expect(later.identity_id).not.toBe(oldest.identity_id);

    const entry = (await graph.crossChannelAttention(TENANT_A, "business", NOW))
      .find((e) => e.commitment.title === "Naabar via senere identitet");
    expect(entry).toBeDefined();

    // KJERNEN i regresjonen: den eldste identiteten ville foer fiksen blitt
    // valgt alene og gitt channel_reachable=false - et FALSKT "vi naar ikke
    // denne" for en motpart vi faktisk naar paa Telegram.
    expect(entry!.channel_reachable).toBe(true);
    expect(entry!.channels.map((c) => `${c.channel}:${c.channel_identifier}`)).toEqual(["telegram:tg-senere-7002"]);

    // Den eldste identiteten droppes ikke stille: den staar med TOM channels -
    // "identiteten finnes, men naas ikke" er selv et faktum, ikke stoey.
    expect(entry!.identities.map((i) => i.identity_id)).toEqual([oldest.identity_id, later.identity_id]);
    expect(entry!.identities[0]!.channels).toEqual([]);
    expect(entry!.identities[1]!.channels).toHaveLength(1);
    // En revokert lenke er historikk - den skal ALDRI dukke opp i unionen.
    expect(entry!.channels.some((c) => c.channel_identifier === "eldste@eldste.no")).toBe(false);
  });
});

describe("D-121: ConversationGraphTransport - de to nye lese-handlingene", () => {
  const transport = () => new ConversationGraphTransport(graph);

  it("AM: read_cross_channel_commitment_view henter tenant/space UTELUKKENDE fra context.identity - en forfalsket tenant_id i parameters paavirker INGENTING", async () => {
    const identityInA = await graph.resolveIdentityByChannel(TENANT_A, "business", "email", "union@union.no");
    const result = await transport().invoke(
      "read_cross_channel_commitment_view",
      { identity_id: identityInA!.identity_id, tenant_id: TENANT_B, memory_space: "personal" } as never,
      "cred", contextFor(TENANT_A)
    );
    expect(result.external_id).toBe(identityInA!.identity_id);
    const view = result.data as unknown as { resolution: string; commitments: unknown[] };
    expect(view.resolution).toBe("resolved");
    expect(view.commitments.length).toBeGreaterThan(0);

    // SAMME identity_id lest med tenant B sin kontekst finnes ikke der (RLS + kontekst-avledet tenant).
    const asB = await transport().invoke(
      "read_cross_channel_commitment_view", { identity_id: identityInA!.identity_id }, "cred", contextFor(TENANT_B)
    );
    expect((asB.data as unknown as { resolution: string }).resolution).toBe("identity_not_found");
  });

  it("AN: read_cross_channel_attention er tenant-scopet av konteksten alene og feiler lukket uten den", async () => {
    const asA = await transport().invoke("read_cross_channel_attention", {}, "cred", contextFor(TENANT_A));
    const rowsA = asA.data as unknown as Array<{ commitment: { title: string } }>;
    expect(rowsA.map((r) => r.commitment.title)).not.toContain("Kun for B");

    await expect(
      transport().invoke("read_cross_channel_attention", {}, "cred", {} as never)
    ).rejects.toThrow("conversation_graph_missing_invocation_context");
  });

  it("AO: read_cross_channel_commitment_view krever identity_id (egne parametre valideres fortsatt)", async () => {
    await expect(
      transport().invoke("read_cross_channel_commitment_view", {}, "cred", contextFor(TENANT_A))
    ).rejects.toThrow("conversation_graph_missing_parameter:identity_id");
  });

  it("AP: INGEN av de to nye input_schema-ene godtar 'now' - en kaller kan ikke styre hvilken prioritets-bucket noe havner i", () => {
    const tools = firstWaveTools({}).filter(
      (t: { tool_id: string; action: string }) =>
        t.tool_id === "conversation_graph" &&
        (t.action === "read_cross_channel_commitment_view" || t.action === "read_cross_channel_attention")
    );
    expect(tools).toHaveLength(2);
    for (const t of tools as Array<{ input_schema: { safeParse: (v: unknown) => { success: boolean } } }>) {
      expect(t.input_schema.safeParse({ identity_id: "x", now: 0 }).success).toBe(false);
    }
  });
});
