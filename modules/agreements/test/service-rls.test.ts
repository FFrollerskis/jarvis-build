import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { AgreementsService } from "../src/service.ts";
import { InvalidContractTransitionError, InvalidObligationTransitionError } from "../src/state-machine.ts";

/**
 * UA-3 Native Jarvis Contracts Core (D-71): ekte Postgres/RLS-
 * integrasjonsbevis for `AgreementsService` - lifecycle/versjonering/
 * forpliktelser/frister/motpartskobling/tenant-/memory-space-isolasjon mot
 * en EKTE NOSUPERUSER/NOBYPASSRLS-rolle (samme mønster som
 * support-service-rls.test.ts, IKKE en `fakePool()`-mock).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: AgreementsService;

const TENANT_A = "tenant-agr-svc-a";
const TENANT_B = "tenant-agr-svc-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-agreements-svc-"));
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

  await adminPool.query("CREATE ROLE jarvis_agr_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_agr_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Agreements Svc A', 'business'), ('${TENANT_B}', 'Agreements Svc B', 'business')`
  );
  await adminPool.query(`INSERT INTO business_companies (company_id, tenant_id, name) VALUES ('co-agr-a', '${TENANT_A}', 'Acme AS')`);
  await adminPool.query(
    `INSERT INTO business_contacts (contact_id, tenant_id, company_id, name, email) VALUES ('ct-agr-a', '${TENANT_A}', 'co-agr-a', 'Kari', 'kari@acme.no')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-agr-owner', 'Owner One')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_agr_svc_test", password: "pw2" });
  service = new AgreementsService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: opprett kontrakt", () => {
  it("createContract returnerer en gyldig kontrakt med default status/type", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Test A" });
    expect(contract.title).toBe("Test A");
    expect(contract.status).toBe("draft");
    expect(contract.contract_type).toBe("other");
    expect(contract.auto_renew).toBe(false);
  });
  it("oppretter et 'contract_created'-event automatisk", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Test A2" });
    const events = await service.listEvents(TENANT_A, "business", contract.contract_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("contract_created");
  });
});

describe("B: deterministisk kontraktnummer", () => {
  it("hver nye kontrakt faar et strengt stigende, unikt contract_number", async () => {
    const a = await service.createContract(TENANT_A, "business", { title: "Number A" });
    const b = await service.createContract(TENANT_A, "business", { title: "Number B" });
    expect(Number(b.contract_number)).toBeGreaterThan(Number(a.contract_number));
  });
});

describe("C: get/list/search", () => {
  it("getContract finner en opprettet kontrakt", async () => {
    const created = await service.createContract(TENANT_A, "business", { title: "Findable" });
    const found = await service.getContract(TENANT_A, "business", created.contract_id);
    expect(found?.contract_id).toBe(created.contract_id);
  });
  it("searchContracts filtrerer deterministisk paa title_contains", async () => {
    await service.createContract(TENANT_A, "business", { title: "Unique-Search-Marker-XYZ" });
    const rows = await service.searchContracts(TENANT_A, "business", { title_contains: "Unique-Search-Marker-XYZ" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.title.includes("Unique-Search-Marker-XYZ"))).toBe(true);
  });
});

describe("D: kontraktversjoner er eksplisitte og immutable", () => {
  it("addVersion oppretter versjon 1, deretter versjon 2 (strengt stigende)", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Versioned" });
    const v1 = await service.addVersion(TENANT_A, "business", contract.contract_id, { summary: "Foerste utkast" });
    expect(v1.version_number).toBe("1");
    const v2 = await service.addVersion(TENANT_A, "business", contract.contract_id, { summary: "Andre utkast" });
    expect(v2.version_number).toBe("2");
    expect(v2.version_id).not.toBe(v1.version_id);
  });
  it("versjoner er append-only - listVersions returnerer BEGGE, ingen overskriving", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Versioned list" });
    await service.addVersion(TENANT_A, "business", contract.contract_id, { summary: "V1" });
    await service.addVersion(TENANT_A, "business", contract.contract_id, { summary: "V2" });
    const versions = await service.listVersions(TENANT_A, "business", contract.contract_id);
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.summary).sort()).toEqual(["V1", "V2"]);
  });
  it("getCurrentVersion returnerer den med hoeyest version_number (ingen egen current_version_id-kolonne)", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Current version" });
    await service.addVersion(TENANT_A, "business", contract.contract_id, { summary: "Foerste" });
    const latest = await service.addVersion(TENANT_A, "business", contract.contract_id, { summary: "Siste" });
    const current = await service.getCurrentVersion(TENANT_A, "business", contract.contract_id);
    expect(current?.version_id).toBe(latest.version_id);
  });
  it("en versjon lagrer et sammendrag, ALDRI full dokumenttekst (pointer-not-payload)", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Pointer version" });
    const longBody = "x".repeat(10_000);
    const version = await service.addVersion(TENANT_A, "business", contract.contract_id, {
      summary: "Kort sammendrag", canonical_uri: "https://drive.google.com/file/d/abc123"
    });
    expect(version.summary.length).toBeLessThan(longBody.length);
    expect(version.canonical_uri).toBe("https://drive.google.com/file/d/abc123");
    expect(Object.keys(version)).not.toContain("body");
    expect(Object.keys(version)).not.toContain("document_content");
  });
  it("addVersion registrerer et 'version_added'-event i kontrakt-tidslinjen", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Version event" });
    await service.addVersion(TENANT_A, "business", contract.contract_id, { summary: "Ny versjon" });
    const events = await service.listEvents(TENANT_A, "business", contract.contract_id);
    expect(events.some((e) => e.event_type === "version_added")).toBe(true);
  });
});

describe("E: deterministisk lifecycle-overgang (state-machine haandheves i service-laget)", () => {
  it("gyldig kjede draft -> review -> approved -> active fungerer og logges", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Transition" });
    await service.setStatus(TENANT_A, "business", contract.contract_id, "review");
    await service.setStatus(TENANT_A, "business", contract.contract_id, "approved");
    const active = await service.setStatus(TENANT_A, "business", contract.contract_id, "active");
    expect(active?.status).toBe("active");
    const events = await service.listEvents(TENANT_A, "business", contract.contract_id);
    expect(events.filter((e) => e.event_type === "status_changed")).toHaveLength(3);
  });
  it("ugyldig overgang (draft -> active) kaster og endrer INGENTING", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Bad transition" });
    await expect(service.setStatus(TENANT_A, "business", contract.contract_id, "active")).rejects.toThrow(InvalidContractTransitionError);
    const unchanged = await service.getContract(TENANT_A, "business", contract.contract_id);
    expect(unchanged?.status).toBe("draft");
  });
  it("ingen LLM-avgjoerelse - kun det statiske transisjonskartet avgjoer gyldighet", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "No LLM" });
    await service.setStatus(TENANT_A, "business", contract.contract_id, "cancelled");
    await expect(service.setStatus(TENANT_A, "business", contract.contract_id, "active")).rejects.toThrow(InvalidContractTransitionError);
  });
});

describe("F: motpartskobling via eksisterende Business OS-entiteter", () => {
  it("linkCounterparty setter company_id/contact_id og logger 'counterparty_linked'", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Counterparty" });
    const updated = await service.linkCounterparty(TENANT_A, "business", contract.contract_id, "co-agr-a", "ct-agr-a");
    expect(updated?.company_id).toBe("co-agr-a");
    expect(updated?.contact_id).toBe("ct-agr-a");
    const events = await service.listEvents(TENANT_A, "business", contract.contract_id);
    expect(events.some((e) => e.event_type === "counterparty_linked")).toBe(true);
  });
  it("listByCompany finner kontrakter for et selskap (\"What does company X have active with us?\")", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Company scoped", company_id: "co-agr-a" });
    const rows = await service.listByCompany(TENANT_A, "business", "co-agr-a");
    expect(rows.some((r) => r.contract_id === contract.contract_id)).toBe(true);
  });
});

describe("G: forpliktelser (\"What must we do under this contract?\")", () => {
  it("addObligation oppretter en aapen forpliktelse med eier/frist", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Obligations" });
    const obligation = await service.addObligation(TENANT_A, "business", contract.contract_id, {
      description: "Lever kvartalsrapport", owner_person_id: "person-agr-owner", due_at: "2026-12-31T00:00:00Z"
    });
    expect(obligation.status).toBe("open");
    expect(obligation.owner_person_id).toBe("person-agr-owner");
  });
  it("completeObligation setter completed_at og status='completed', logger event", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Complete obligation" });
    const obligation = await service.addObligation(TENANT_A, "business", contract.contract_id, { description: "Fullfoer meg" });
    const completed = await service.completeObligation(TENANT_A, "business", obligation.obligation_id);
    expect(completed?.status).toBe("completed");
    expect(completed?.completed_at).not.toBeNull();
    const events = await service.listEvents(TENANT_A, "business", contract.contract_id);
    expect(events.some((e) => e.event_type === "obligation_completed")).toBe(true);
  });
  it("waiveObligation setter status='waived', reopenObligation setter tilbake til 'open'", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Waive obligation" });
    const obligation = await service.addObligation(TENANT_A, "business", contract.contract_id, { description: "Frafall meg" });
    const waived = await service.waiveObligation(TENANT_A, "business", obligation.obligation_id);
    expect(waived?.status).toBe("waived");
    const reopened = await service.reopenObligation(TENANT_A, "business", obligation.obligation_id);
    expect(reopened?.status).toBe("open");
    expect(reopened?.completed_at).toBeNull();
  });
  it("completed -> waived direkte er IKKE en gyldig forpliktelses-overgang", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Invalid obligation transition" });
    const obligation = await service.addObligation(TENANT_A, "business", contract.contract_id, { description: "Test" });
    await service.completeObligation(TENANT_A, "business", obligation.obligation_id);
    await expect(service.waiveObligation(TENANT_A, "business", obligation.obligation_id)).rejects.toThrow(InvalidObligationTransitionError);
  });
  it("listObligations filtrerer paa status", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "List obligations" });
    const open = await service.addObligation(TENANT_A, "business", contract.contract_id, { description: "Aapen" });
    const done = await service.addObligation(TENANT_A, "business", contract.contract_id, { description: "Ferdig" });
    await service.completeObligation(TENANT_A, "business", done.obligation_id);
    const openOnly = await service.listObligations(TENANT_A, "business", contract.contract_id, "open");
    expect(openOnly.some((o) => o.obligation_id === open.obligation_id)).toBe(true);
    expect(openOnly.some((o) => o.obligation_id === done.obligation_id)).toBe(false);
  });
});

describe("H: forfallsspørringer (\"What is due next?\", overdue detection)", () => {
  it("dueObligations returnerer aapne forpliktelser sortert paa frist", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Due" });
    await service.addObligation(TENANT_A, "business", contract.contract_id, { description: "Forfaller snart", due_at: new Date(Date.now() + 86_400_000).toISOString() });
    const due = await service.dueObligations(TENANT_A, "business", 30);
    expect(due.length).toBeGreaterThan(0);
  });
  it("overdueObligations finner KUN forpliktelser med frist i fortiden", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Overdue" });
    const overdueOb = await service.addObligation(TENANT_A, "business", contract.contract_id, {
      description: "Allerede forfalt", due_at: new Date(Date.now() - 86_400_000).toISOString()
    });
    const futureOb = await service.addObligation(TENANT_A, "business", contract.contract_id, {
      description: "Ikke forfalt enda", due_at: new Date(Date.now() + 86_400_000 * 30).toISOString()
    });
    const overdue = await service.overdueObligations(TENANT_A, "business");
    expect(overdue.some((o) => o.obligation_id === overdueOb.obligation_id)).toBe(true);
    expect(overdue.some((o) => o.obligation_id === futureOb.obligation_id)).toBe(false);
  });
});

describe("I: fornyelses-/oppsigelsesfrister (\"Which contracts renew soon?\", \"Which agreements are expiring?\")", () => {
  it("setRenewalDate setter dato og logger 'renewal_date_changed'", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Renewal" });
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await service.setRenewalDate(TENANT_A, "business", contract.contract_id, soon);
    await service.setStatus(TENANT_A, "business", contract.contract_id, "review");
    await service.setStatus(TENANT_A, "business", contract.contract_id, "approved");
    await service.setStatus(TENANT_A, "business", contract.contract_id, "active");
    const renewals = await service.upcomingRenewals(TENANT_A, "business", 30);
    expect(renewals.some((r) => r.contract_id === contract.contract_id)).toBe(true);
    const events = await service.listEvents(TENANT_A, "business", contract.contract_id);
    expect(events.some((e) => e.event_type === "renewal_date_changed")).toBe(true);
  });
  it("setTerminationDeadline setter frist og logger 'termination_deadline_changed'", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Termination" });
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await service.setTerminationDeadline(TENANT_A, "business", contract.contract_id, soon);
    await service.setStatus(TENANT_A, "business", contract.contract_id, "review");
    await service.setStatus(TENANT_A, "business", contract.contract_id, "approved");
    await service.setStatus(TENANT_A, "business", contract.contract_id, "active");
    const deadlines = await service.upcomingTerminationDeadlines(TENANT_A, "business", 30);
    expect(deadlines.some((d) => d.contract_id === contract.contract_id)).toBe(true);
    const events = await service.listEvents(TENANT_A, "business", contract.contract_id);
    expect(events.some((e) => e.event_type === "termination_deadline_changed")).toBe(true);
  });
  it("cancellableNow (\"Which contracts can we cancel now?\") ekskluderer kontrakter med passert oppsigelsesfrist", async () => {
    const stillCancellable = await service.createContract(TENANT_A, "business", { title: "Still cancellable" });
    await service.setStatus(TENANT_A, "business", stillCancellable.contract_id, "review");
    await service.setStatus(TENANT_A, "business", stillCancellable.contract_id, "approved");
    await service.setStatus(TENANT_A, "business", stillCancellable.contract_id, "active");
    const passedDeadline = await service.createContract(TENANT_A, "business", {
      title: "Passed deadline", termination_deadline: new Date(Date.now() - 86_400_000).toISOString()
    });
    await service.setStatus(TENANT_A, "business", passedDeadline.contract_id, "review");
    await service.setStatus(TENANT_A, "business", passedDeadline.contract_id, "approved");
    await service.setStatus(TENANT_A, "business", passedDeadline.contract_id, "active");
    const cancellable = await service.cancellableNow(TENANT_A, "business");
    expect(cancellable.some((c) => c.contract_id === stillCancellable.contract_id)).toBe(true);
    expect(cancellable.some((c) => c.contract_id === passedDeadline.contract_id)).toBe(false);
  });
});

describe("J: kontrakt-tidslinje er separat fra audit_events", () => {
  it("listEvents returnerer kontrakt-spesifikke hendelser, ALDRI system-audit-radformat", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Timeline" });
    await service.setOwner(TENANT_A, "business", contract.contract_id, "person-agr-owner");
    const events = await service.listEvents(TENANT_A, "business", contract.contract_id);
    expect(events.some((e) => e.event_type === "contract_created")).toBe(true);
    expect(events.some((e) => e.event_type === "owner_changed")).toBe(true);
    for (const e of events) expect(e.contract_id).toBe(contract.contract_id);
  });
});

describe("K/L: tenant-/memory-space-isolasjon (RLS)", () => {
  it("K: TENANT_B ser ALDRI TENANT_A sine kontrakter", async () => {
    const contractA = await service.createContract(TENANT_A, "business", { title: "Isolation A" });
    const foundFromB = await service.getContract(TENANT_B, "business", contractA.contract_id);
    expect(foundFromB).toBeNull();
    const listB = await service.listContracts(TENANT_B, "business", "all");
    expect(listB.some((c) => c.contract_id === contractA.contract_id)).toBe(false);
  });
  it("L: en kontrakt i memory_space 'business' er usynlig fra 'personal'-space-kontekst for samme tenant", async () => {
    const contract = await service.createContract(TENANT_A, "business", { title: "Space isolation" });
    const foundInPersonal = await service.getContract(TENANT_A, "personal", contract.contract_id);
    expect(foundInPersonal).toBeNull();
  });
});
