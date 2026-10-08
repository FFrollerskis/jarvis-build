import { describe, expect, it } from "vitest";
import { EXPECTED_AREAS, composeSelfDiagnosis, renderSelfDiagnosisNo } from "@jarvis/executive";
import { buildSelfModelReaders } from "../src/self-model-readers.ts";

/**
 * D-443: selvdiagnosen («Hva er galt med deg?») skal si fra når en daglig bakgrunnsjobb har feilet eller gitt opp - det var hele poenget med D-442
 * (tenant-feil når scheduler_state), men uten en leser måtte eieren lese containerloggen. SQL-en og klassifiseringen testes mot ekte Postgres i
 * `modules/tool-gateway/test/scheduler-health.test.ts`; her testes leseren og at området er koblet inn i selvdiagnosen.
 */

const NOW = new Date("2026-10-08T05:00:00.000Z");

interface FakeRow {
  job_name: string; run_date: string; attempts: number; completed_at: Date | null; retry_after: Date | null;
  last_error: string | null; past_day: boolean; claim_stale: boolean;
}
const rowOf = (o: Partial<FakeRow> & { job_name: string }): FakeRow => ({
  run_date: "2026-10-08", attempts: 1, completed_at: null, retry_after: null, last_error: null, past_day: false, claim_stale: false, ...o
});

function readersFor(rows: FakeRow[] | Error) {
  const pool = { query: async () => { if (rows instanceof Error) throw rows; return { rows }; } };
  return buildSelfModelReaders({
    pool: pool as never,
    tenantId: "t",
    meshStatus: () => ({ providers: [] }),
    controlState: async () => ({ kill_switch: { active: false }, frozen_connectors: [], revoked_credentials: [] }),
    connectorStatus: async () => [],
    now: () => NOW
  });
}

describe("D-443: scheduled_jobs-leseren", () => {
  it("området er registrert i selvmodellen (ikke-kritisk) - ellers ville leseren aldri blitt kalt", () => {
    expect(EXPECTED_AREAS.find((a) => a.id === "scheduled_jobs")).toEqual({ id: "scheduled_jobs", critical: false, label: "Daglige bakgrunnsjobber" });
  });

  it("ingen rader: UNKNOWN (ukjent er aldri «frisk»)", async () => {
    const obs = await readersFor([]).scheduled_jobs!();
    expect(obs).toMatchObject({ status: "UNKNOWN", source: "scheduler_state" });
  });

  it("alle fullført: OK med antall", async () => {
    const done = new Date("2026-10-08T03:00:00Z");
    const obs = await readersFor([rowOf({ job_name: "a", completed_at: done }), rowOf({ job_name: "b", completed_at: done })]).scheduled_jobs!();
    expect(obs).toMatchObject({ status: "OK", observed_at: NOW.toISOString(), data: { jobs_seen: 2, completed: 2, gave_up: 0 } });
    expect((obs as { detail: string }).detail).toBe("2 av 2 daglige jobber er fullført, ingen feil.");
  });

  it("kun forbigående retry: DEGRADED (nytt forsøk er planlagt)", async () => {
    const obs = await readersFor([rowOf({ job_name: "support-inbox-sync", attempts: 2, retry_after: new Date(NOW.getTime() + 300_000), last_error: "Gmail nede" })]).scheduled_jobs!();
    expect(obs).toMatchObject({ status: "DEGRADED", data: { retry_pending: 1, gave_up: 0 } });
    expect((obs as { detail: string }).detail).toContain("support-inbox-sync feilet (forsøk 2/4), nytt forsøk er planlagt: Gmail nede");
  });

  it("gave_up eller tapt i går: DOWN, med jobbnavn og siste feil i klartekst", async () => {
    const obs = await readersFor([
      rowOf({ job_name: "stripe-payment-sync", attempts: 4, retry_after: NOW, last_error: "stripe 503" }),
      rowOf({ job_name: "memory-profile-sweep", run_date: "2026-10-07", past_day: true, attempts: 1, retry_after: NOW, last_error: "db" })
    ]).scheduled_jobs!();
    expect(obs).toMatchObject({ status: "DOWN", data: { gave_up: 1, lost_previous_day: 1 } });
    const detail = (obs as { detail: string }).detail;
    expect(detail).toContain("2 daglige jobber har problemer");
    expect(detail).toContain("stripe-payment-sync ga opp etter 4/4 forsøk: stripe 503");
    expect(detail).toContain("memory-profile-sweep ble ikke fullført 2026-10-07");
  });

  it("D-445: kun jobber som avhenger av eierens PC (best effort) har gitt opp -> DEGRADED, ikke DOWN, med forklaring - PC-en er av noen netter", async () => {
    const obs = await readersFor([
      rowOf({ job_name: "memory-reembed-sweep", attempts: 4, retry_after: NOW, last_error: "ollama: fetch failed" }),
      rowOf({ job_name: "memory-retention-sweep", run_date: "2026-10-07", past_day: true, attempts: 2, retry_after: NOW, last_error: "llm nede" })
    ]).scheduled_jobs!();
    expect(obs).toMatchObject({ status: "DEGRADED", data: { gave_up: 1, lost_previous_day: 1, best_effort: 2 } });
    expect((obs as { detail: string }).detail).toContain("memory-reembed-sweep ga opp etter 4/4 forsøk: ollama: fetch failed (avhenger av PC-en; tas igjen neste kjøring)");
  });

  it("D-445: en kritisk jobb som ga opp gir fortsatt DOWN, også når en PC-avhengig jobb ligger blant problemene", async () => {
    const obs = await readersFor([
      rowOf({ job_name: "memory-reembed-sweep", attempts: 4, retry_after: NOW, last_error: "ollama: fetch failed" }),
      rowOf({ job_name: "stripe-payment-sync", attempts: 4, retry_after: NOW, last_error: "stripe 503" })
    ]).scheduled_jobs!();
    expect(obs).toMatchObject({ status: "DOWN" });
  });

  it("mer enn fire problemer: de fire første vises og resten telles", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => rowOf({ job_name: `job-${i}`, attempts: 4, retry_after: NOW, last_error: "x" }));
    const detail = ((await readersFor(rows).scheduled_jobs!()) as { detail: string }).detail;
    expect(detail).toContain("6 daglige jobber har problemer");
    expect(detail).toContain("(+2 til)");
  });

  it("databasefeil kaster (composeSelfDiagnosis gjør det til UNKNOWN - aldri en antatt frisk status)", async () => {
    await expect(readersFor(new Error("db nede")).scheduled_jobs!()).rejects.toThrow("db nede");
  });

  it("i selvdiagnosen: jobb som ga opp gir et funn for området og vises i klartekst til eieren", async () => {
    const readers = readersFor([rowOf({ job_name: "growth-action-recommendation-sweep", attempts: 4, retry_after: NOW, last_error: "tenant-x: boom" })]);
    const diagnosis = await composeSelfDiagnosis({ readers: { scheduled_jobs: readers.scheduled_jobs }, limitations: [], now: () => NOW });
    const finding = diagnosis.findings.find((f) => f.area === "scheduled_jobs");
    expect(finding?.severity).toBe("critical");
    expect(finding?.message).toContain("growth-action-recommendation-sweep ga opp etter 4/4 forsøk: tenant-x: boom");
    expect(renderSelfDiagnosisNo(diagnosis, { maxFindings: 20 })).toContain("growth-action-recommendation-sweep");

    const broken = await composeSelfDiagnosis({ readers: { scheduled_jobs: readersFor(new Error("db nede")).scheduled_jobs }, limitations: [], now: () => NOW });
    expect(broken.observations["scheduled_jobs"]).toMatchObject({ status: "UNKNOWN" });
  });
});
