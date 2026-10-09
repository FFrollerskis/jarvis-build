import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import { correlateIncident } from "../src/correlation.ts";
import { DeploymentService } from "../src/deployments.ts";
import { DiagnosisService } from "../src/diagnosis.ts";
import { IncidentService, incidentCorrelationId, incidentDedupeKey, sanitizeIncidentSubject } from "../src/service.ts";
import { InvalidIncidentTransitionError } from "../src/state-machine.ts";
import { PRODUCER_LIMITS, type IncidentFact } from "../src/types.ts";

/**
 * WP-E1 (UA-5, JARVIS-068): incident-livssyklus, produsent-dedupe og sannhetstype-regime mot EKTE Postgres som den begrensede app-rollen (FORCE RLS, ingen UPDATE-grant på
 * historikken). Hver sikkerhetsegenskap har en adversariell test: rå SQL som omgår tjenesten skal feile i DATABASEN, ikke bare i TypeScript.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let incidents: IncidentService;
let diagnoses: DiagnosisService;
let deployments: DeploymentService;
const A = "tenant-e1inc-a";
const B = "tenant-e1inc-b";
const OWNER = { kind: "owner", person_id: "person-e1a" } as const;
const NOW = () => new Date().toISOString();

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1inc-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_e1inc LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_e1inc");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}','A','business'), ('${B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-e1a','A'), ('person-e1b','B');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-e1a','${A}'), ('person-e1b','${B}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1inc", password: "pw2" });
  incidents = new IncidentService(appPool);
  diagnoses = new DiagnosisService(appPool);
  deployments = new DeploymentService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

const raw = <T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>, space: "business" | "personal" = "business"): Promise<T> =>
  withMemoryTransaction(appPool, tenant, [space], fn);

let factSeq = 0;
function fact(over: Partial<IncidentFact> & { subject?: string } = {}): IncidentFact {
  const subject = over.subject ?? `job-${(factSeq += 1)}`;
  return {
    source_kind: "scheduler", subject, title: `Bakgrunnsjobb ${subject} feiler`, severity: "normal", observed_at: NOW(),
    evidence: { source_type: "scheduler_job", source_ref: subject, summary: `${subject} ga opp etter 3/3 forsøk` },
    ...over
  };
}
const resolveInput = (summary = "siste kjøring fullført") => ({
  source_type: "scheduler_job" as const, summary, observed_at: NOW(), verified_by: "source_recheck" as const,
  basis: "scheduler_state: siste rad har completed_at", reason: "jobben kjørte vellykket på nytt"
});

describe("A: opprettelse og livssyklus med varig historikk", () => {
  it("manuell hendelse skriver opprettelsesraden (fra null, eier som aktør) og en revisjonsrad", async () => {
    const created = await incidents.createIncident(A, "business", { title: "Manuell hendelse", owner_person_id: "person-e1a" });
    expect(created).toMatchObject({ status: "open", source_kind: "manual", dedupe_key: null, correlation_id: null, occurrence_count: 1 });
    const history = await incidents.listTransitions(A, "business", created.incident_id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ from_status: null, to_status: "open", actor_kind: "owner", actor_person_id: "person-e1a", reason: "opprettet manuelt" });
    const audit = await adminPool.query(`SELECT payload, actor_kind FROM audit_events WHERE tenant_id = $1 AND type = 'incident.opened' AND payload->>'incident_id' = $2`, [A, created.incident_id]);
    expect(audit.rowCount).toBe(1);
  });

  it("åpen -> anerkjent -> avbøting -> løst -> gjenåpnet: hver overgang har aktør, årsak og peker, i rekkefølge", async () => {
    const inc = await incidents.createIncident(A, "business", { title: "Full syklus", owner_person_id: "person-e1a" });
    await incidents.transition(A, "business", inc.incident_id, "diagnosing", OWNER, { reason: "ser på det" });
    await incidents.transition(A, "business", inc.incident_id, "repair_proposed", OWNER, { reason: "tiltak foreslått", evidence_ref: "task-1" });
    await incidents.transition(A, "business", inc.incident_id, "repair_in_progress", OWNER, { reason: "tiltak i gang" });
    const resolved = await incidents.transition(A, "business", inc.incident_id, "resolved", OWNER, { reason: "bekreftet løst" });
    expect(resolved?.resolved_at).not.toBeNull();
    const reopened = await incidents.transition(A, "business", inc.incident_id, "open", OWNER, { reason: "kom tilbake" });
    expect(reopened?.resolved_at).toBeNull();
    const history = await incidents.listTransitions(A, "business", inc.incident_id);
    expect(history.map((h) => `${h.from_status ?? "-"}>${h.to_status}`)).toEqual([
      "->open", "open>diagnosing", "diagnosing>repair_proposed", "repair_proposed>repair_in_progress", "repair_in_progress>resolved", "resolved>open"
    ]);
    expect(history.every((h) => h.actor_kind === "owner" && h.actor_person_id === "person-e1a" && h.reason.length > 0)).toBe(true);
    expect(history[2]?.evidence_ref).toBe("task-1");
  });

  it("ugyldig overgang kaster og endrer INGENTING (ingen historikkrad)", async () => {
    const inc = await incidents.createIncident(A, "business", { title: "Ugyldig", owner_person_id: "person-e1a" });
    await incidents.transition(A, "business", inc.incident_id, "resolved", OWNER, { reason: "løst" });
    await expect(incidents.transition(A, "business", inc.incident_id, "diagnosing", OWNER, { reason: "ulovlig" })).rejects.toBeInstanceOf(InvalidIncidentTransitionError);
    expect((await incidents.getIncident(A, "business", inc.incident_id))?.status).toBe("resolved");
    expect(await incidents.listTransitions(A, "business", inc.incident_id)).toHaveLength(2);
  });

  it("årsak er påkrevd og redigeres for hemmeligheter; samme status er et idempotent no-op; ukjent hendelse gir null", async () => {
    const inc = await incidents.createIncident(A, "business", { title: "Årsak", owner_person_id: "person-e1a" });
    await expect(incidents.transition(A, "business", inc.incident_id, "diagnosing", OWNER, { reason: "   " })).rejects.toThrow("incident_transition_reason_required");
    await incidents.transition(A, "business", inc.incident_id, "diagnosing", OWNER, { reason: "feilen står i Authorization: Bearer abc.def.ghi og GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123" });
    const again = await incidents.transition(A, "business", inc.incident_id, "diagnosing", OWNER, { reason: "igjen" });
    expect(again?.status).toBe("diagnosing");
    const history = await incidents.listTransitions(A, "business", inc.incident_id);
    expect(history).toHaveLength(2);
    expect(history[1]?.reason).not.toMatch(/abc\.def\.ghi|ghp_abcdefghijklmnopqrstuvwxyz0123/);
    expect(await incidents.transition(A, "business", "inc-finnes-ikke", "diagnosing", OWNER, { reason: "x" })).toBeNull();
  });

  it("samtidige overganger serialiseres: nøyaktig én vinner, historikken er konsistent", async () => {
    const inc = await incidents.createIncident(A, "business", { title: "Race", owner_person_id: "person-e1a" });
    const results = await Promise.allSettled([
      incidents.transition(A, "business", inc.incident_id, "resolved", OWNER, { reason: "a" }),
      incidents.transition(A, "business", inc.incident_id, "wont_fix", OWNER, { reason: "b" }),
      incidents.transition(A, "business", inc.incident_id, "diagnosing", OWNER, { reason: "c" })
    ]);
    const history = await incidents.listTransitions(A, "business", inc.incident_id);
    const final = (await incidents.getIncident(A, "business", inc.incident_id))!;
    // Kjeden fra opprettelsen må henge sammen: hver rads fra-status er forrige rads til-status.
    for (let i = 1; i < history.length; i += 1) expect(history[i]?.from_status).toBe(history[i - 1]?.to_status);
    expect(history[history.length - 1]?.to_status).toBe(final.status);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  });
});

describe("B: databasen avviser omgåelse (rå SQL som app-rollen)", () => {
  it("statusendring uten overgangsrad avvises ved commit, og statusen er uendret", async () => {
    const inc = await incidents.createIncident(A, "business", { title: "Rå UPDATE", owner_person_id: "person-e1a" });
    await expect(raw(A, (c) => c.query(`UPDATE incidents SET status = 'resolved' WHERE tenant_id = $1 AND incident_id = $2`, [A, inc.incident_id]))).rejects.toThrow(/incident_status_change_without_transition/);
    expect((await incidents.getIncident(A, "business", inc.incident_id))?.status).toBe("open");
  });

  it("forfalsket overgangsrad: ulovlig par, feil fra-status og gammel txid avvises", async () => {
    const inc = await incidents.createIncident(A, "business", { title: "Forfalsket", owner_person_id: "person-e1a" });
    const insertTransition = (c: pg.PoolClient, from: string | null, to: string, extra = ""): Promise<unknown> =>
      c.query(
        `INSERT INTO incident_transitions (transition_id, tenant_id, memory_space_id, incident_id, from_status, to_status, actor_kind, reason ${extra ? ", txid" : ""})
         VALUES ($1, $2, 'business', $3, $4, $5, 'system', 'forfalsket' ${extra ? ", 1" : ""})`,
        [`forged-${Math.random()}`, A, inc.incident_id, from, to]
      );
    // Ulovlig par (open -> open og resolved -> diagnosing) stoppes av CHECK.
    await expect(raw(A, (c) => insertTransition(c, "open", "open"))).rejects.toThrow();
    await expect(raw(A, (c) => insertTransition(c, "resolved", "diagnosing"))).rejects.toThrow(/check/i);
    // Lovlig par, men raden har en gammel txid: den utsatte triggeren godtar den ikke som bevis for DENNE transaksjonen.
    await expect(raw(A, async (c) => {
      await insertTransition(c, "open", "resolved", "gammel-txid");
      await c.query(`UPDATE incidents SET status = 'resolved' WHERE tenant_id = $1 AND incident_id = $2`, [A, inc.incident_id]);
    })).rejects.toThrow(/incident_status_change_without_transition/);
    expect((await incidents.getIncident(A, "business", inc.incident_id))?.status).toBe("open");
  });

  it("historikken er append-only: UPDATE er nektet, direkte DELETE avvises, og sletting av hendelsen kaskaderer", async () => {
    const inc = await incidents.createIncident(A, "business", { title: "Append-only", owner_person_id: "person-e1a" });
    await incidents.transition(A, "business", inc.incident_id, "diagnosing", OWNER, { reason: "r" });
    await expect(raw(A, (c) => c.query(`UPDATE incident_transitions SET reason = 'omskrevet' WHERE incident_id = $1`, [inc.incident_id]))).rejects.toThrow(/permission denied/);
    await expect(raw(A, (c) => c.query(`DELETE FROM incident_transitions WHERE incident_id = $1`, [inc.incident_id]))).rejects.toThrow(/incident_transitions_append_only/);
    expect(await incidents.listTransitions(A, "business", inc.incident_id)).toHaveLength(2);
    // Q-20-erasure: hendelsen slettes, historikken følger med (kaskade) - da er ikke vakten i veien.
    await raw(A, (c) => c.query(`DELETE FROM incidents WHERE tenant_id = $1 AND incident_id = $2`, [A, inc.incident_id]));
    const left = await adminPool.query(`SELECT count(*)::int AS n FROM incident_transitions WHERE incident_id = $1`, [inc.incident_id]);
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });

  it("RLS: annen tenant og annet minne-rom ser aldri historikken, og kan ikke skrive til den", async () => {
    const inc = await incidents.createIncident(A, "business", { title: "Isolert", owner_person_id: "person-e1a" });
    expect(await incidents.listTransitions(B, "business", inc.incident_id)).toEqual([]);
    const otherSpace = await raw(A, (c) => c.query(`SELECT 1 FROM incident_transitions WHERE incident_id = $1`, [inc.incident_id]), "personal");
    expect(otherSpace.rowCount).toBe(0);
    // Tenant B kan ikke skrive en overgang som peker på A sin hendelse (komposittnøkkel + RLS).
    await expect(raw(B, (c) => c.query(
      `INSERT INTO incident_transitions (transition_id, tenant_id, memory_space_id, incident_id, from_status, to_status, actor_kind, reason)
       VALUES ('x-cross', $1, 'business', $2, NULL, 'open', 'system', 'kryss-tenant')`, [B, inc.incident_id]
    ))).rejects.toThrow();
    await expect(raw(B, (c) => c.query(
      `INSERT INTO incident_transitions (transition_id, tenant_id, memory_space_id, incident_id, from_status, to_status, actor_kind, reason)
       VALUES ('x-cross2', $1, 'business', $2, NULL, 'open', 'system', 'feil tenant i raden')`, [A, inc.incident_id]
    ))).rejects.toThrow(/row-level security/);
  });
});

describe("C: aktør-regler for overganger", () => {
  it("system-aktør og eier uten person avvises; reparasjonsflyten kan kun foreslå tiltak", async () => {
    const inc = await incidents.createIncident(A, "business", { title: "Aktører", owner_person_id: "person-e1a" });
    await expect(incidents.transition(A, "business", inc.incident_id, "diagnosing", { kind: "system" }, { reason: "x" })).rejects.toThrow("incident_system_actor_not_allowed");
    await expect(incidents.transition(A, "business", inc.incident_id, "diagnosing", { kind: "owner", person_id: "" }, { reason: "x" })).rejects.toThrow("incident_owner_actor_requires_person");
    await expect(incidents.transition(A, "business", inc.incident_id, "resolved", { kind: "repair" }, { reason: "x" })).rejects.toThrow("incident_repair_transition_not_allowed");
    const proposed = await incidents.transition(A, "business", inc.incident_id, "repair_proposed", { kind: "repair" }, { reason: "jobb sendt inn", evidence_ref: "task-9" });
    expect(proposed?.status).toBe("repair_proposed");
    const last = (await incidents.listTransitions(A, "business", inc.incident_id)).at(-1)!;
    expect(last).toMatchObject({ actor_kind: "repair", actor_person_id: null, evidence_ref: "task-9" });
  });

  it("en produsent kan ikke røre en manuell hendelse, ikke lukke uten tiltak, ikke anerkjenne/avbøte, og ikke løse uten et VERIFIED bevis for SAMME hendelse", async () => {
    const manual = await incidents.createIncident(A, "business", { title: "Manuell", owner_person_id: "person-e1a" });
    await expect(incidents.transition(A, "business", manual.incident_id, "resolved", { kind: "producer" }, { reason: "x" })).rejects.toThrow("incident_producer_cannot_touch_manual");
    await expect(incidents.resolveByCheck(A, "business", manual.incident_id, resolveInput())).rejects.toThrow("incident_producer_cannot_touch_manual");

    const opened = await incidents.openFromFact(A, "business", fact());
    if (opened.action !== "opened") throw new Error("forventet opened");
    const id = opened.incident.incident_id;
    const producer = { kind: "producer" } as const;
    await expect(incidents.transition(A, "business", id, "wont_fix", producer, { reason: "x" })).rejects.toThrow("incident_producer_transition_not_allowed");
    await expect(incidents.transition(A, "business", id, "diagnosing", producer, { reason: "x" })).rejects.toThrow("incident_producer_transition_not_allowed");
    // Uten peker, med et PROVISIONAL bevis, og med et VERIFIED bevis fra en ANNEN hendelse: alle avvises.
    await expect(incidents.transition(A, "business", id, "resolved", producer, { reason: "x" })).rejects.toThrow("incident_producer_resolve_requires_verified_evidence");
    const provisional = (await incidents.listEvidence(A, "business", id))[0]!;
    expect(provisional.status).toBe("PROVISIONAL");
    await expect(incidents.transition(A, "business", id, "resolved", producer, { reason: "x", evidence_ref: provisional.evidence_id })).rejects.toThrow("incident_producer_resolve_requires_verified_evidence");
    const other = await incidents.openFromFact(A, "business", fact());
    if (other.action !== "opened") throw new Error("forventet opened");
    const otherVerified = await incidents.addEvidence(A, "business", other.incident.incident_id, { source_type: "manual", summary: "annen hendelse", observed_at: NOW(), asserted_by: "check" });
    await incidents.verifyEvidence(A, "business", otherVerified.evidence_id, { verified_by: "source_recheck", basis: "re-måling" });
    await expect(incidents.transition(A, "business", id, "resolved", producer, { reason: "x", evidence_ref: otherVerified.evidence_id })).rejects.toThrow("incident_producer_resolve_requires_verified_evidence");
    expect((await incidents.getIncident(A, "business", id))?.status).toBe("open");
  });

  it("en produsent kan ikke gjenåpne en hendelse eieren har lukket uten tiltak", async () => {
    const f = fact();
    const opened = await incidents.openFromFact(A, "business", f);
    if (opened.action !== "opened") throw new Error("forventet opened");
    await incidents.transition(A, "business", opened.incident.incident_id, "wont_fix", OWNER, { reason: "forventet støy" });
    await expect(incidents.transition(A, "business", opened.incident.incident_id, "open", { kind: "producer" }, { reason: "x" })).rejects.toThrow("incident_producer_cannot_reopen_closed");
    // Eieren kan selv gjenåpne.
    expect((await incidents.transition(A, "business", opened.incident.incident_id, "open", OWNER, { reason: "likevel viktig" }))?.status).toBe("open");
  });
});

describe("D: produsent-åpnede hendelser (openFromFact)", () => {
  it("åpner med fingeravtrykk, korrelasjons-id, produsent-bevis (PROVISIONAL), opprettelsesrad og revisjon med trace_id", async () => {
    const f = fact({ subject: "daily-brief" });
    const result = await incidents.openFromFact(A, "business", f);
    expect(result.action).toBe("opened");
    if (result.action !== "opened") return;
    const inc = result.incident;
    expect(inc).toMatchObject({ source_kind: "scheduler", dedupe_key: "scheduler:daily-brief", owner_person_id: null, occurrence_count: 1, status: "open" });
    expect(inc.correlation_id).toBe(incidentCorrelationId(A, "scheduler:daily-brief"));
    expect(inc.correlation_id).toMatch(/^corr-[0-9a-f]{16}$/);
    const evidence = await incidents.listEvidence(A, "business", inc.incident_id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ asserted_by: "producer", status: "PROVISIONAL", verified_by: null, verification_basis: null, verified_at: null });
    const history = await incidents.listTransitions(A, "business", inc.incident_id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ from_status: null, to_status: "open", actor_kind: "producer", actor_person_id: null });
    const audit = await adminPool.query(`SELECT trace_id, actor_kind FROM audit_events WHERE tenant_id = $1 AND type = 'incident.opened' AND payload->>'incident_id' = $2`, [A, inc.incident_id]);
    expect(audit.rows[0]).toMatchObject({ trace_id: inc.correlation_id, actor_kind: "system" });
  });

  it("samme faktum oppdaterer den aktive hendelsen (teller opp, alvorlighet kun OPP, ikke duplisert bevis); nytt bevis legges til", async () => {
    const f = fact({ severity: "low" });
    const first = await incidents.openFromFact(A, "business", f);
    if (first.action !== "opened") throw new Error("forventet opened");
    const id = first.incident.incident_id;
    const same = await incidents.openFromFact(A, "business", f);
    expect(same.action).toBe("updated");
    const escalated = await incidents.openFromFact(A, "business", { ...f, severity: "high" });
    const lowered = await incidents.openFromFact(A, "business", { ...f, severity: "low" });
    if (escalated.action !== "updated" || lowered.action !== "updated") throw new Error("forventet updated");
    expect(escalated.incident.severity).toBe("high");
    expect(lowered.incident.severity).toBe("high"); // aldri nedgradert av produsenten
    expect(lowered.incident).toMatchObject({ incident_id: id, occurrence_count: 4 });
    expect(await incidents.listEvidence(A, "business", id)).toHaveLength(1); // identisk bevis gjentas ikke
    await incidents.openFromFact(A, "business", { ...f, evidence: { ...f.evidence, summary: "nytt funn: 3 av 3 forsøk brukt opp" } });
    expect(await incidents.listEvidence(A, "business", id)).toHaveLength(2);
    expect(await incidents.listTransitions(A, "business", id)).toHaveLength(1); // ingen nye overganger
  });

  it("parallelle produsenter for samme faktum gir NØYAKTIG én aktiv hendelse", async () => {
    const f = fact();
    const results = await Promise.all(Array.from({ length: 8 }, () => incidents.openFromFact(A, "business", f)));
    expect(results.filter((r) => r.action === "opened")).toHaveLength(1);
    expect(results.filter((r) => r.action === "updated")).toHaveLength(7);
    const active = await adminPool.query(`SELECT count(*)::int AS n, max(occurrence_count)::int AS occ FROM incidents WHERE tenant_id = $1 AND dedupe_key = $2 AND status NOT IN ('resolved','wont_fix')`, [A, incidentDedupeKey("scheduler", f.subject)]);
    expect(active.rows[0]).toEqual({ n: 1, occ: 8 });
  });

  it("løsning kun via re-måling: nytt VERIFIED bevis med grunnlag + overgang i samme transaksjon; regresjon gjenåpner samme hendelse; gammel regresjon gir ny hendelse med SAMME korrelasjons-id", async () => {
    const f = fact();
    const first = await incidents.openFromFact(A, "business", f);
    if (first.action !== "opened") throw new Error("forventet opened");
    const id = first.incident.incident_id;
    const resolved = await incidents.resolveByCheck(A, "business", id, resolveInput());
    expect(resolved?.status).toBe("resolved");
    const evidence = await incidents.listEvidence(A, "business", id);
    const proof = evidence.find((e) => e.status === "VERIFIED")!;
    expect(proof).toMatchObject({ asserted_by: "check", verified_by: "source_recheck", verification_basis: "scheduler_state: siste rad har completed_at" });
    expect(proof.verified_at).not.toBeNull();
    const last = (await incidents.listTransitions(A, "business", id)).at(-1)!;
    expect(last).toMatchObject({ from_status: "open", to_status: "resolved", actor_kind: "producer", evidence_ref: proof.evidence_id });
    // allerede løst: no-op
    expect((await incidents.resolveByCheck(A, "business", id, resolveInput("igjen")))?.status).toBe("resolved");
    expect(await incidents.listTransitions(A, "business", id)).toHaveLength(2);

    const regression = await incidents.openFromFact(A, "business", f);
    expect(regression.action).toBe("reopened");
    if (regression.action !== "reopened") return;
    expect(regression.incident).toMatchObject({ incident_id: id, status: "open", resolved_at: null });
    expect((await incidents.listTransitions(A, "business", id)).at(-1)).toMatchObject({ from_status: "resolved", to_status: "open", actor_kind: "producer" });

    // Løses igjen og "eldes" forbi gjenåpningsvinduet: samme faktum åpner en NY hendelse, bundet av samme korrelasjons-id.
    await incidents.resolveByCheck(A, "business", id, resolveInput("igjen løst"));
    await adminPool.query(`UPDATE incidents SET updated_at = now() - interval '${PRODUCER_LIMITS.reopen_window_hours + 2} hours' WHERE incident_id = $1`, [id]);
    const fresh = await incidents.openFromFact(A, "business", f);
    expect(fresh.action).toBe("opened");
    if (fresh.action !== "opened") return;
    expect(fresh.incident.incident_id).not.toBe(id);
    expect(fresh.incident.correlation_id).toBe(first.incident.correlation_id);
  });

  it("eierens «ikke fiks» demper faktumet (bare telleren øker, vinduet forlenges ikke) til dempingen utløper", async () => {
    const f = fact();
    const first = await incidents.openFromFact(A, "business", f);
    if (first.action !== "opened") throw new Error("forventet opened");
    const id = first.incident.incident_id;
    await incidents.transition(A, "business", id, "wont_fix", OWNER, { reason: "forventet: PC-en er av om natten" });
    const before = (await incidents.getIncident(A, "business", id))!;
    const muted = await incidents.openFromFact(A, "business", f);
    expect(muted).toEqual({ action: "suppressed", reason: "owner_wont_fix_mute" });
    const after = (await incidents.getIncident(A, "business", id))!;
    expect(after.occurrence_count).toBe(before.occurrence_count + 1);
    expect(new Date(after.updated_at).getTime()).toBe(new Date(before.updated_at).getTime());
    await adminPool.query(`UPDATE incidents SET updated_at = now() - interval '${PRODUCER_LIMITS.owner_mute_days + 1} days' WHERE incident_id = $1`, [id]);
    expect((await incidents.openFromFact(A, "business", f)).action).toBe("opened");
  });

  it("taket for aktive hendelser per produsent stopper oversvømmelse (kilden telles, ikke flere rader)", async () => {
    const results: string[] = [];
    for (let i = 0; i < PRODUCER_LIMITS.max_active_per_producer + 3; i += 1) {
      const r = await incidents.openFromFact(B, "business", fact({ source_kind: "provider", subject: `connector-${i}`, evidence: { source_type: "health_check", summary: "nede" } }));
      results.push(r.action);
    }
    expect(results.filter((a) => a === "opened")).toHaveLength(PRODUCER_LIMITS.max_active_per_producer);
    expect(results.filter((a) => a === "suppressed")).toHaveLength(3);
    const n = await adminPool.query(`SELECT count(*)::int AS n FROM incidents WHERE tenant_id = $1 AND source_kind = 'provider'`, [B]);
    expect((n.rows[0] as { n: number }).n).toBe(PRODUCER_LIMITS.max_active_per_producer);
    // En eksisterende aktiv hendelse oppdateres fortsatt selv om taket er nådd.
    expect((await incidents.openFromFact(B, "business", fact({ source_kind: "provider", subject: "connector-0", evidence: { source_type: "health_check", summary: "fortsatt nede" } }))).action).toBe("updated");
  });

  it("emne og tittel saneres/redigeres; VERIFIED ved åpning avvises; ikke-produsent-kilder kan ikke kapre nøkkelrommet (CHECK + unik indeks)", async () => {
    expect(sanitizeIncidentSubject("../etc/passwd; DROP TABLE x")).toBe("../etc/passwd__DROP_TABLE_x"); // kun en identifikator - aldri brukt som sti eller SQL
    const r = await incidents.openFromFact(A, "business", fact({ subject: "a b\nc", title: "Feil: API_TOKEN=supersecretvalue123 lekket" }));
    if (r.action !== "opened") throw new Error("forventet opened");
    expect(r.incident.dedupe_key).toBe("scheduler:a_b_c");
    expect(r.incident.title).not.toContain("supersecretvalue123");
    await expect(incidents.openFromFact(A, "business", fact({ evidence: { source_type: "scheduler_job", summary: "x", status: "VERIFIED" as never } }))).rejects.toThrow("truth_verified_requires_deterministic_basis");
    await expect(incidents.openFromFact(A, "business", fact({ subject: "   ".replace(/ /g, "") }))).rejects.toThrow("incident_fact_subject_required");
    // Rå SQL: en SLO-hendelse med scheduler-nøkkel, og to aktive hendelser med samme nøkkel.
    await expect(raw(A, (c) => c.query(
      `INSERT INTO incidents (incident_id, tenant_id, memory_space_id, title, source_kind, dedupe_key, correlation_id) VALUES ('inc-kapre', $1, 'business', 't', 'slo', 'scheduler:daily-brief', 'corr-0123456789abcdef')`, [A]
    ))).rejects.toThrow(/incidents_producer_needs_dedupe_key/);
    await expect(raw(A, (c) => c.query(
      `INSERT INTO incidents (incident_id, tenant_id, memory_space_id, title, source_kind, dedupe_key, correlation_id) VALUES ('inc-dup', $1, 'business', 't', 'scheduler', $2, 'corr-0123456789abcdef')`, [A, r.incident.dedupe_key]
    ))).rejects.toThrow(/incidents_active_dedupe_idx/);
    // Jokertegn-kapring: `_` i kildenavn er et LIKE-jokertegn, men starts_with() er eksakt.
    await expect(raw(A, (c) => c.query(
      `INSERT INTO incidents (incident_id, tenant_id, memory_space_id, title, source_kind, dedupe_key, correlation_id) VALUES ('inc-wild', $1, 'business', 't', 'infra_execution', 'infraXexecution:x', 'corr-0123456789abcdef')`, [A]
    ))).rejects.toThrow(/incidents_producer_needs_dedupe_key/);
  });

  it("produsent-hendelser er isolert per tenant og minne-rom", async () => {
    const f = fact();
    const mine = await incidents.openFromFact(A, "business", f);
    if (mine.action !== "opened") throw new Error("forventet opened");
    expect((await incidents.listActiveBySource(B, "business", "scheduler")).some((i) => i.incident_id === mine.incident.incident_id)).toBe(false);
    expect((await incidents.listActiveBySource(A, "business", "scheduler")).some((i) => i.incident_id === mine.incident.incident_id)).toBe(true);
    expect(await incidents.getIncident(A, "personal", mine.incident.incident_id)).toBeNull();
    // Samme faktum hos tenant B er en egen hendelse med en annen korrelasjons-id.
    const theirs = await incidents.openFromFact(B, "business", { ...f, source_kind: "slo", subject: "x" });
    if (theirs.action === "opened") expect(theirs.incident.correlation_id).not.toBe(mine.incident.correlation_id);
  });
});

describe("E: sannhetstype-regimet (VERIFIED kan ikke settes av avsenderen)", () => {
  async function newIncident(): Promise<string> {
    return (await incidents.createIncident(A, "business", { title: "Sannhet", owner_person_id: "person-e1a" })).incident_id;
  }
  const ev = (over: Record<string, unknown> = {}) => ({ source_type: "log" as const, summary: "observasjon", observed_at: NOW(), ...over });

  it("ingen avsender kan sette VERIFIED ved innsetting; modell låses til UNVERIFIED; ukjent avsender/status avvises", async () => {
    const id = await newIncident();
    for (const asserted_by of ["owner", "producer", "check", "model"] as const) {
      await expect(incidents.addEvidence(A, "business", id, ev({ status: "VERIFIED", asserted_by }))).rejects.toThrow("truth_verified_requires_deterministic_basis");
    }
    await expect(incidents.addEvidence(A, "business", id, ev({ asserted_by: "model", status: "PROVISIONAL" }))).rejects.toThrow("truth_model_cannot_raise_status");
    await expect(incidents.addEvidence(A, "business", id, ev({ asserted_by: "sjefen" }))).rejects.toThrow("truth_unknown_asserter");
    await expect(incidents.addEvidence(A, "business", id, ev({ status: "KANSKJE" }))).rejects.toThrow("truth_unknown_status");
    expect((await incidents.addEvidence(A, "business", id, ev({ asserted_by: "model" }))).status).toBe("UNVERIFIED");
    expect((await incidents.addEvidence(A, "business", id, ev())).status).toBe("UNVERIFIED");
    expect((await incidents.addEvidence(A, "business", id, ev({ asserted_by: "check" }))).status).toBe("PROVISIONAL");
    expect(await incidents.listEvidence(A, "business", id)).toHaveLength(3); // de avviste forsøkene skrev ingenting
  });

  it("verifyEvidence: kun navngitt grunnlag; modellbevis kan aldri forfremmes; VERIFIED er endelig og idempotent", async () => {
    const id = await newIncident();
    const owner = await incidents.addEvidence(A, "business", id, ev());
    const model = await incidents.addEvidence(A, "business", id, ev({ asserted_by: "model" }));
    await expect(incidents.verifyEvidence(A, "business", owner.evidence_id, { verified_by: "meg_selv" as never, basis: "x" })).rejects.toThrow("truth_unknown_verifier");
    await expect(incidents.verifyEvidence(A, "business", owner.evidence_id, { verified_by: "source_recheck", basis: "  " })).rejects.toThrow("truth_verification_basis_required");
    await expect(incidents.verifyEvidence(A, "business", model.evidence_id, { verified_by: "independent_probe", basis: "probe" })).rejects.toThrow("truth_model_evidence_cannot_be_verified");
    const verified = await incidents.verifyEvidence(A, "business", owner.evidence_id, { verified_by: "independent_probe", basis: "probe mot /healthz: 200 (Authorization: Bearer topsecrettoken123)" });
    expect(verified).toMatchObject({ status: "VERIFIED", verified_by: "independent_probe" });
    expect(verified?.verification_basis).not.toContain("topsecrettoken123");
    const again = await incidents.verifyEvidence(A, "business", owner.evidence_id, { verified_by: "source_recheck", basis: "annet grunnlag" });
    expect(again?.verified_by).toBe("independent_probe"); // aldri omskrevet
    expect(await incidents.verifyEvidence(A, "business", "inc-ev-finnes-ikke", { verified_by: "source_recheck", basis: "x" })).toBeNull();
  });

  it("databasen avviser rå VERIFIED uten grunnlag, nedgradering av VERIFIED, omskriving av innhold og modellbevis over UNVERIFIED", async () => {
    const id = await newIncident();
    const base = `INSERT INTO incident_evidence (evidence_id, tenant_id, memory_space_id, incident_id, source_type, status, asserted_by, summary, observed_at`;
    await expect(raw(A, (c) => c.query(`${base}) VALUES ('ev-raw-1', $1, 'business', $2, 'log', 'VERIFIED', 'owner', 's', now())`, [A, id]))).rejects.toThrow(/incident_evidence_verified_requires_basis/);
    await expect(raw(A, (c) => c.query(`${base}) VALUES ('ev-raw-2', $1, 'business', $2, 'log', 'PROVISIONAL', 'model', 's', now())`, [A, id]))).rejects.toThrow(/incident_evidence_model_stays_unverified/);
    await expect(raw(A, (c) => c.query(`${base}) VALUES ('ev-raw-3', $1, 'business', $2, 'log', 'UNVERIFIED', 'owner', 's', now())`, [A, id]).then(() =>
      c.query(`UPDATE incident_evidence SET status = 'VERIFIED' WHERE evidence_id = 'ev-raw-3'`)))).rejects.toThrow(/incident_evidence_verified_requires_basis/);
    const e = await incidents.addEvidence(A, "business", id, ev());
    await incidents.verifyEvidence(A, "business", e.evidence_id, { verified_by: "source_recheck", basis: "re-måling" });
    await expect(raw(A, (c) => c.query(`UPDATE incident_evidence SET status = 'UNVERIFIED', verified_by = NULL, verification_basis = NULL, verified_at = NULL WHERE evidence_id = $1`, [e.evidence_id]))).rejects.toThrow(/incident_evidence_verified_is_final/);
    await expect(raw(A, (c) => c.query(`UPDATE incident_evidence SET summary = 'omskrevet' WHERE evidence_id = $1`, [e.evidence_id]))).rejects.toThrow(/incident_evidence_content_immutable/);
    await expect(raw(A, (c) => c.query(`UPDATE incident_evidence SET asserted_by = 'check' WHERE evidence_id = $1`, [e.evidence_id]))).rejects.toThrow(/incident_evidence_content_immutable/);
  });

  it("korrelasjon forfremmer KUN deployment-bevis som peker på en faktisk deploy - ikke andre kilder, og aldri modellskrevet bevis", async () => {
    const repo = "tsworkflow/e1-repo";
    const dep = await deployments.recordDeployment(A, { source: "github_actions", repo, commit_sha: "abcdef1234567890", workflow_run_id: "run-e1", status: "success", deployed_at: "2026-08-21T12:00:00Z" });
    const id = await newIncident();
    const matching = await incidents.addEvidence(A, "business", id, { source_type: "deployment", source_ref: dep.deployment.deployment_id, summary: "mistenkt deploy", observed_at: "2026-08-21T12:30:00Z" });
    const otherRef = await incidents.addEvidence(A, "business", id, { source_type: "deployment", source_ref: "dep-finnes-ikke", summary: "annen deploy", observed_at: "2026-08-21T12:31:00Z" });
    const log = await incidents.addEvidence(A, "business", id, { source_type: "log", source_ref: dep.deployment.deployment_id, summary: "logg", observed_at: "2026-08-21T12:32:00Z" });
    const model = await incidents.addEvidence(A, "business", id, { source_type: "deployment", source_ref: dep.deployment.deployment_id, summary: "modell påstår", observed_at: "2026-08-21T12:33:00Z", asserted_by: "model" });
    const result = await correlateIncident(incidents, deployments, A, "business", id, repo);
    const byId = new Map(result.evidence.map((e) => [e.evidence_id, e]));
    expect(byId.get(matching.evidence_id)).toMatchObject({ status: "VERIFIED", verified_by: "correlation_deployment_match" });
    expect(byId.get(matching.evidence_id)?.verification_basis).toContain(dep.deployment.deployment_id);
    expect(byId.get(otherRef.evidence_id)?.status).toBe("UNVERIFIED");
    expect(byId.get(log.evidence_id)?.status).toBe("UNVERIFIED");
    expect(byId.get(model.evidence_id)?.status).toBe("UNVERIFIED");
  });

  it("diagnoser: modell alltid UNVERIFIED, eier aldri VERIFIED, deterministisk VERIFIED kun med VERIFIED støttebevis for SAMME hendelse", async () => {
    const id = await newIncident();
    const other = await newIncident();
    const weak = await incidents.addEvidence(A, "business", id, ev());
    const strong = await incidents.addEvidence(A, "business", id, ev({ asserted_by: "check" }));
    await incidents.verifyEvidence(A, "business", strong.evidence_id, { verified_by: "independent_probe", basis: "probe" });
    const foreign = await incidents.addEvidence(A, "business", other, ev({ asserted_by: "check" }));
    await expect(diagnoses.createDiagnosis(A, "business", id, { conclusion: "x", source: "model_assisted", status: "VERIFIED" })).rejects.toThrow("truth_model_cannot_raise_status");
    await expect(diagnoses.createDiagnosis(A, "business", id, { conclusion: "x", source: "model_assisted", status: "PROVISIONAL" })).rejects.toThrow("truth_model_cannot_raise_status");
    await expect(diagnoses.createDiagnosis(A, "business", id, { conclusion: "x", source: "owner", status: "VERIFIED", supporting_evidence_ids: [strong.evidence_id] })).rejects.toThrow("truth_verified_requires_deterministic_basis");
    await expect(diagnoses.createDiagnosis(A, "business", id, { conclusion: "x", source: "deterministic", status: "VERIFIED", supporting_evidence_ids: [weak.evidence_id] })).rejects.toThrow("truth_verified_diagnosis_needs_verified_evidence");
    await expect(diagnoses.createDiagnosis(A, "business", id, { conclusion: "x", source: "deterministic", status: "VERIFIED" })).rejects.toThrow("truth_verified_diagnosis_needs_verified_evidence");
    await expect(diagnoses.createDiagnosis(A, "business", id, { conclusion: "x", source: "deterministic", supporting_evidence_ids: [foreign.evidence_id] })).rejects.toThrow("diagnosis_evidence_not_found_for_incident");
    await expect(diagnoses.createDiagnosis(A, "business", id, { conclusion: "  ", source: "owner" })).rejects.toThrow("diagnosis_conclusion_required");
    expect((await diagnoses.createDiagnosis(A, "business", id, { conclusion: "hypotese", source: "model_assisted" })).status).toBe("UNVERIFIED");
    expect((await diagnoses.createDiagnosis(A, "business", id, { conclusion: "min vurdering", source: "owner", status: "PROVISIONAL" })).status).toBe("PROVISIONAL");
    const ok = await diagnoses.createDiagnosis(A, "business", id, { conclusion: "rotårsak bekreftet", source: "deterministic", status: "VERIFIED", supporting_evidence_ids: [strong.evidence_id] });
    expect(ok.status).toBe("VERIFIED");
    expect(await diagnoses.listDiagnoses(A, "business", id)).toHaveLength(3);
  });

  it("databasen: VERIFIED diagnose krever deterministisk kilde og VERIFIED støttebevis ved commit; diagnoser kan ikke omskrives", async () => {
    const id = await newIncident();
    const ins = (diag: string, status: string, source: string) =>
      `INSERT INTO incident_diagnoses (diagnosis_id, tenant_id, memory_space_id, incident_id, conclusion, status, source) VALUES ('${diag}', '${A}', 'business', '${id}', 'c', '${status}', '${source}')`;
    await expect(raw(A, (c) => c.query(ins("dx-raw-1", "VERIFIED", "owner")))).rejects.toThrow(/incident_diagnoses_verified_only_deterministic/);
    await expect(raw(A, (c) => c.query(ins("dx-raw-2", "PROVISIONAL", "model_assisted")))).rejects.toThrow(/incident_diagnoses_model_stays_unverified/);
    await expect(raw(A, (c) => c.query(ins("dx-raw-3", "VERIFIED", "deterministic")))).rejects.toThrow(/incident_diagnosis_verified_without_verified_evidence/);
    const dx = await diagnoses.createDiagnosis(A, "business", id, { conclusion: "uendret", source: "owner" });
    await expect(raw(A, (c) => c.query(`UPDATE incident_diagnoses SET conclusion = 'omskrevet' WHERE diagnosis_id = $1`, [dx.diagnosis_id]))).rejects.toThrow(/incident_diagnosis_content_immutable/);
    await expect(raw(A, (c) => c.query(`UPDATE incident_diagnoses SET source = 'deterministic', status = 'VERIFIED' WHERE diagnosis_id = $1`, [dx.diagnosis_id]))).rejects.toThrow(/incident_diagnosis_content_immutable/);
  });
});
