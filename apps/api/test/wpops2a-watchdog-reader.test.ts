import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { proposeOpsActions, type Observation } from "@jarvis/executive";
import { buildSelfModelReaders, type SelfModelReaderDeps } from "../src/self-model-readers.ts";
import {
  WATCHDOG_PRODUCERS_OFF_DETAIL, WATCHDOG_STALE_FACTOR, WATCHDOG_UNREADABLE_DETAIL, observeWatchdogRun, watchdogRunSource, type WatchdogRunRow
} from "../src/watchdog-status.ts";

/**
 * WP-OPS2a K1 (EV-1/H2, JARVIS-041-resten): vakthunden i selvdiagnosen. Leseren er en REN funksjon over raden `incident_producer_runs` for `watchdog` (den ENESTE varige sporet av at vakthunden tikker, skrevet av den eksisterende broen -
 * ingen ny skrivevei). Grensene: max(3 x VAKTHUND-intervallet, 2 min) (fiks-runde 1, B-L1: raden skrives per vakthund-tikk), alder under -2 s er klokkeavvik (UKJENT), og sjekkenes meldingstekst er aldri en del av svaret.
 * Rader mot ekte Postgres: `wpops2a-watchdog-reader-db.test.ts`. Fiks-rundens nye tester: `wpops2a-fix1-k1-reader.test.ts`.
 */
const INTERVAL = 300_000; // vakthund-intervall 5 min (JARVIS_WATCHDOG_INTERVAL_MS=300000) -> grensen er 15 min
const LIMIT_MS = WATCHDOG_STALE_FACTOR * INTERVAL;
const NOW = new Date("2026-11-26T12:00:00.000Z");
const agoMs = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const mmss = (m: number, s: number): number => (m * 60 + s) * 1000;
const row = (over: Partial<WatchdogRunRow> = {}): WatchdogRunRow => ({ last_started_at: agoMs(mmss(1, 0)), last_status: "ok", facts_seen: 0, consecutive_failures: 0, ...over });

describe("grensene: 3 x vakthund-intervallet (14:59 / 15:00 / 15:01 ved 5 min)", () => {
  it("konstantene er 3 x 300 s = 15 min", () => {
    expect(WATCHDOG_STALE_FACTOR).toBe(3);
    expect(LIMIT_MS).toBe(15 * 60_000);
  });

  it("14:59 er OK, nøyaktig 15:00 er fortsatt OK (strengt over), 15:01 er DOWN med «har ikke tikket på N min»", () => {
    expect(observeWatchdogRun(row({ last_started_at: agoMs(mmss(14, 59)) }), NOW, INTERVAL).status).toBe("OK");
    expect(observeWatchdogRun(row({ last_started_at: agoMs(mmss(15, 0)) }), NOW, INTERVAL).status).toBe("OK");
    const down = observeWatchdogRun(row({ last_started_at: agoMs(mmss(15, 1)) }), NOW, INTERVAL);
    expect(down.status).toBe("DOWN");
    expect(down.detail).toContain("har ikke tikket på 15 min");
    expect(down.data).toEqual({ age_s: 901, failing_checks: 0, consecutive_failures: 0 });
  });

  it("grensen følger det INJISERTE intervallet (ikke en fast 15 min): 60 s gir 3 min, 600 s gir 30 min", () => {
    expect(observeWatchdogRun(row({ last_started_at: agoMs(mmss(2, 59)) }), NOW, 60_000).status).toBe("OK");
    expect(observeWatchdogRun(row({ last_started_at: agoMs(mmss(3, 1)) }), NOW, 60_000).status).toBe("DOWN");
    expect(observeWatchdogRun(row({ last_started_at: agoMs(mmss(29, 59)) }), NOW, 600_000).status).toBe("OK");
    expect(observeWatchdogRun(row({ last_started_at: agoMs(mmss(30, 1)) }), NOW, 600_000).status).toBe("DOWN");
  });

  it("alder 0 (tikket akkurat nå) er OK; negativ alder over 2 s (klokkeavvik) er UKJENT - aldri OK, aldri DOWN (fiks-runde 1, B-L2: under 2 s regnes som 0, se wpops2a-fix1-k1-reader.test.ts)", () => {
    expect(observeWatchdogRun(row({ last_started_at: NOW.toISOString() }), NOW, INTERVAL).status).toBe("OK");
    for (const aheadMs of [2001, 60_000, 3_600_000]) {
      const o = observeWatchdogRun(row({ last_started_at: new Date(NOW.getTime() + aheadMs).toISOString() }), NOW, INTERVAL);
      expect(o.status, `${aheadMs} ms frem`).toBe("UNKNOWN");
      expect(o.detail).toContain("klokkeavvik");
      expect(o.observed_at).toBeNull();
    }
  });

  it("DOWN (står) går foran DEGRADED (feilende sjekker) - en vakthund som står kan ikke vite hva som feiler nå", () => {
    const o = observeWatchdogRun(row({ last_started_at: agoMs(mmss(20, 0)), last_status: "failed", facts_seen: 3, consecutive_failures: 4 }), NOW, INTERVAL);
    expect(o.status).toBe("DOWN");
    expect(o.data).toEqual({ age_s: 1200, failing_checks: 3, consecutive_failures: 4 });
  });
});

describe("statuskombinasjoner (ferskt tikk)", () => {
  it("ingen rad -> UKJENT (aldri OK), uten tidspunkt og uten data", () => {
    const o = observeWatchdogRun(null, NOW, INTERVAL);
    expect(o).toMatchObject({ status: "UNKNOWN", observed_at: null });
    expect(o.detail).toContain("Ingen vakthund-tikk er registrert");
    expect(o.data).toBeUndefined();
  });

  it("ok / running uten feilende sjekker -> OK med målt alder og observed_at = last_started_at", () => {
    for (const last_status of ["ok", "running"]) {
      const started = agoMs(mmss(2, 30));
      const o = observeWatchdogRun(row({ last_started_at: started, last_status }), NOW, INTERVAL);
      expect(o.status, last_status).toBe("OK");
      expect(o.observed_at).toBe(started);
      expect(o.data).toEqual({ age_s: 150, failing_checks: 0, consecutive_failures: 0 });
      expect(o.source).toContain("incident_producer_runs");
    }
  });

  it("failed og skipped -> DEGRADED (selv uten feilende sjekker), og sier hva som er galt med REGISTRERINGEN", () => {
    const failed = observeWatchdogRun(row({ last_status: "failed", consecutive_failures: 2 }), NOW, INTERVAL);
    expect(failed.status).toBe("DEGRADED");
    expect(failed.detail).toContain("feilet");
    expect(failed.detail).toContain("2 på rad");
    expect(failed.data).toMatchObject({ failing_checks: 0, consecutive_failures: 2 });
    const skipped = observeWatchdogRun(row({ last_status: "skipped" }), NOW, INTERVAL);
    expect(skipped.status).toBe("DEGRADED");
    expect(skipped.detail).toContain("hoppet over");
  });

  it("facts_seen over 0 -> DEGRADED med «N sjekker feiler» (entall for 1); 0 er OK", () => {
    expect(observeWatchdogRun(row({ facts_seen: 0 }), NOW, INTERVAL).status).toBe("OK");
    const one = observeWatchdogRun(row({ facts_seen: 1 }), NOW, INTERVAL);
    expect(one.status).toBe("DEGRADED");
    expect(one.detail).toContain("1 sjekk feiler");
    expect(one.data).toMatchObject({ failing_checks: 1 });
    const many = observeWatchdogRun(row({ facts_seen: 3 }), NOW, INTERVAL);
    expect(many.status).toBe("DEGRADED");
    expect(many.detail).toContain("3 sjekker feiler");
  });

  it("failed OG feilende sjekker: begge årsakene står i teksten, status er DEGRADED (ikke DOWN)", () => {
    const o = observeWatchdogRun(row({ last_status: "failed", facts_seen: 2, consecutive_failures: 1 }), NOW, INTERVAL);
    expect(o.status).toBe("DEGRADED");
    expect(o.detail).toContain("2 sjekker feiler");
    expect(o.detail).toContain("feilet");
  });

  it("ukjent/ugyldig data er UKJENT, aldri OK: ukjent last_status, ugyldig tidspunkt, negativ/ikke-heltall/NaN-telling, ugyldig intervall", () => {
    for (const bad of [
      row({ last_status: "weird" }), row({ last_status: "" }), row({ last_started_at: "ikke-en-dato" }), row({ last_started_at: new Date(Number.NaN) }),
      row({ facts_seen: -1 }), row({ facts_seen: 1.5 }), row({ facts_seen: Number.NaN }), row({ consecutive_failures: -1 }), row({ consecutive_failures: Number.NaN })
    ]) {
      expect(observeWatchdogRun(bad, NOW, INTERVAL).status, JSON.stringify(bad)).toBe("UNKNOWN");
    }
    for (const badInterval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(observeWatchdogRun(row(), NOW, badInterval).status, String(badInterval)).toBe("UNKNOWN");
  });

  it("tidspunktet kan komme som Date (slik pg leverer timestamptz) eller ISO-streng - samme svar", () => {
    const iso = agoMs(mmss(4, 0));
    expect(observeWatchdogRun(row({ last_started_at: new Date(iso) }), NOW, INTERVAL)).toEqual(observeWatchdogRun(row({ last_started_at: iso }), NOW, INTERVAL));
  });
});

describe("sjekkenes meldingstekst og feilbeskrivelser er aldri en del av svaret (regel 7: ubetrodd innhold)", () => {
  it("en rad med ekstra felt (last_error med en Bearer-streng, en sjekkmelding) lekker verken i detail, source eller data", () => {
    const poisoned = { ...row({ last_status: "failed", facts_seen: 2, consecutive_failures: 3 }), last_error: "Authorization: Bearer sk-hemmelig-123", message: "2 jobber med utløpt lease", check: "stuck_tasks" } as WatchdogRunRow;
    for (const at of [NOW, new Date(NOW.getTime() + 20 * 60_000)]) {
      const o = observeWatchdogRun(poisoned, at, INTERVAL);
      const blob = JSON.stringify(o);
      expect(blob).not.toContain("sk-hemmelig");
      expect(blob).not.toContain("Bearer");
      expect(blob).not.toContain("utløpt lease");
      expect(blob).not.toContain("stuck_tasks");
    }
  });
});

describe("leseren i buildSelfModelReaders", () => {
  const baseDeps = (over: Partial<SelfModelReaderDeps> = {}): SelfModelReaderDeps => ({
    pool: { query: async () => ({ rows: [] }) } as never, tenantId: "t", now: () => NOW, meshStatus: () => ({ providers: [] }),
    controlState: async () => ({ kill_switch: { active: false }, frozen_connectors: [], revoked_credentials: [] }), connectorStatus: async () => [], ...over
  });

  it("uten injisert kilde (incident-produsentene er AV): leseren finnes og svarer UKJENT med den presise årsaken - aldri OK", async () => {
    const reader = buildSelfModelReaders(baseDeps()).watchdog;
    expect(reader).toBeDefined();
    const o = (await reader!()) as Observation;
    expect(o).toMatchObject({ status: "UNKNOWN", observed_at: null, detail: WATCHDOG_PRODUCERS_OFF_DETAIL });
    expect(WATCHDOG_PRODUCERS_OFF_DETAIL).toBe("incident-produsentene er AV: vakthundens tikk registreres ikke varig");
  });

  it("med kilde: raden tolkes med injisert klokke og intervall", async () => {
    let reads = 0;
    const readers = buildSelfModelReaders(baseDeps({ watchdogRuns: { intervalMs: INTERVAL, read: async () => { reads += 1; return row({ last_started_at: agoMs(mmss(16, 0)) }); } } }));
    const o = (await readers.watchdog!()) as Observation;
    expect(o.status).toBe("DOWN");
    expect(reads).toBe(1);
    const fresh = buildSelfModelReaders(baseDeps({ watchdogRuns: { intervalMs: INTERVAL, read: async () => row() } }));
    expect(((await fresh.watchdog!()) as Observation).status).toBe("OK");
    const none = buildSelfModelReaders(baseDeps({ watchdogRuns: { intervalMs: INTERVAL, read: async () => null } }));
    expect(((await none.watchdog!()) as Observation).status).toBe("UNKNOWN");
  });

  it("lesefeil (databasen nede, tidsavbrudd) gir UKJENT med fast tekst - aldri OK, og feilteksten (kan bære hemmeligheter) siteres ikke", async () => {
    const readers = buildSelfModelReaders(baseDeps({ watchdogRuns: { intervalMs: INTERVAL, read: async () => { throw new Error("connect ECONNREFUSED password=hunter2"); } } }));
    const o = (await readers.watchdog!()) as Observation;
    expect(o).toMatchObject({ status: "UNKNOWN", observed_at: null, detail: WATCHDOG_UNREADABLE_DETAIL });
    expect(JSON.stringify(o)).not.toContain("hunter2");
    expect(JSON.stringify(o)).not.toContain("ECONNREFUSED");
  });

  it("watchdogRunSource: velger `watchdog`-raden for riktig tenant og gir null når den mangler (andre produsenter er ikke vakthunden)", async () => {
    const listed: string[] = [];
    const store = {
      list: async (tenantId: string) => {
        listed.push(tenantId);
        return [
          { producer: "scheduler", last_started_at: agoMs(1000), last_finished_at: null, last_status: "ok", last_error: null, facts_seen: 0, opened: 0, updated: 0, resolved: 0, suppressed: 0, consecutive_failures: 0 },
          { producer: "watchdog", last_started_at: agoMs(2000), last_finished_at: null, last_status: "ok", last_error: null, facts_seen: 2, opened: 0, updated: 0, resolved: 0, suppressed: 0, consecutive_failures: 0 }
        ];
      }
    };
    const source = watchdogRunSource(store as never, "tenant-x", INTERVAL);
    expect(source.intervalMs).toBe(INTERVAL);
    expect(await source.read()).toMatchObject({ last_status: "ok", facts_seen: 2 });
    expect(listed).toEqual(["tenant-x"]);
    const empty = watchdogRunSource({ list: async () => [{ producer: "scheduler", last_started_at: agoMs(1), last_status: "ok", facts_seen: 0, consecutive_failures: 0 }] } as never, "tenant-x", INTERVAL);
    expect(await empty.read()).toBeNull();
  });
});

describe("ops-proposals (kildefilen er urørt): leserens svar mates til forslagene", () => {
  const signals = (watchdog: Observation) => ({ enabled: true, slo: [], observations: { watchdog }, connectors: [], tasks_waiting_over_15m: 0 });

  it("DOWN gir omstart-av-worker-forslag (klasse D, step-up, utfører ingenting)", () => {
    const down = observeWatchdogRun(row({ last_started_at: agoMs(mmss(20, 0)) }), NOW, INTERVAL);
    const r = proposeOpsActions(signals(down));
    expect(r.proposals.map((p) => p.id)).toEqual(["restart_service:worker"]);
    expect(r.proposals[0]).toMatchObject({ risk_class: "D", requires: "step_up", executes: false, proposed_calls: [] });
    expect(r.proposals[0]?.rationale_no).toContain("watchdog melder nede");
  });

  it("UKJENT gir «ikke målt» og INGEN forslag (ukjent er ikke galt) - for både ingen rad, klokkeavvik og produsenter AV", () => {
    const unknowns = [observeWatchdogRun(null, NOW, INTERVAL), observeWatchdogRun(row({ last_started_at: new Date(NOW.getTime() + 60_000).toISOString() }), NOW, INTERVAL)];
    for (const u of unknowns) {
      const r = proposeOpsActions(signals(u));
      expect(r.proposals).toEqual([]);
      expect(r.skipped_no).toContain("watchdog er ikke målt (selvdiagnosen svarer UKJENT)");
      expect(r.skipped_no.filter((x) => x.startsWith("watchdog")).join(" ")).not.toContain("ingen leser"); // fiks-runde 1: det finnes en leser; «ingen leser» er kun riktig når området mangler helt (se wpc4-ops-proposals.test.ts)
    }
  });

  it("OK gir ingen forslag", () => {
    expect(proposeOpsActions(signals(observeWatchdogRun(row(), NOW, INTERVAL))).proposals).toEqual([]);
  });

  it("DEGRADED (en sjekk feiler, f.eks. cost_warning over varselgrensen) gir INGEN omstartforslag (fiks-runde 1, B-M3: omstart hjelper ikke mot en feilende sjekk, og vakthunden lever); kun DOWN foreslår omstart", () => {
    for (const degradedRow of [row({ facts_seen: 1 }), row({ facts_seen: 4 }), row({ last_status: "failed", consecutive_failures: 3 }), row({ last_status: "skipped" })]) {
      const degraded = observeWatchdogRun(degradedRow, NOW, INTERVAL);
      expect(degraded.status).toBe("DEGRADED");
      const r = proposeOpsActions(signals(degraded));
      expect(r.proposals, JSON.stringify(degradedRow)).toEqual([]);
      expect(JSON.stringify(r)).not.toContain("svekket");
    }
  });
});

describe("kildevakter: wiringen i main.ts kan ikke fjernes eller gjøres ubetinget", () => {
  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const main = readFileSync(join(ROOT, "apps/api/src/main.ts"), "utf8");

  it("kilden sendes KUN når incident-produsentene er på (ellers UKJENT), og begrensningen er betinget av samme bryter", () => {
    expect(main).toContain("watchdogRuns: incidentProducerConfig.enabled ? watchdogRunSource(new ProducerRunStore(pool), owner.tenant_id, watchdogIntervalMsFromEnv(process.env)) : undefined");
    expect(main).toContain("watchdogStateReadable: incidentProducerConfig.enabled");
    expect(main.match(/watchdogRunSource\(/g)).toHaveLength(1);
    expect(main.match(/new ProducerRunStore\(/g)).toHaveLength(1);
  });

  it("selve leseren skriver aldri: watchdog-status.ts har ingen INSERT/UPDATE/DELETE og ingen nettverksbruk", () => {
    const src = readFileSync(join(ROOT, "apps/api/src/watchdog-status.ts"), "utf8");
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(src).not.toMatch(/fetch\(|guardedFetch|node:http|node:net/);
  });
});
