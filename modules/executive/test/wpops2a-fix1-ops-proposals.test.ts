import { describe, expect, it } from "vitest";
import { proposeOpsActions, type OpsSignals } from "../src/index.ts";

/**
 * WP-OPS2a fiks-runde 1 (review B-M3): `watchdog` DEGRADED (en sjekk feiler: kostnadsvarselet står over grensen hele måneden, en lease-sjekk, databasen) skal IKKE gi et omstartforslag for worker (klasse D, step-up) - vakthunden lever, og
 * en omstart hjelper ikke mot en feilende sjekk. KUN DOWN (har ikke tikket) foreslår omstart. Uendret for de andre områdene.
 */
const CALM: OpsSignals = {
  enabled: true,
  slo: [],
  observations: { backup: { status: "OK" }, watchdog: { status: "OK" }, scheduled_jobs: { status: "OK" }, tasks: { status: "OK", data: { stuck: 0 } }, process: { status: "OK", data: { disk_free_gb: 120 } } },
  connectors: [],
  tasks_waiting_over_15m: 0
};
const withWatchdog = (watchdog: { status: string; data?: Record<string, number> } | undefined): OpsSignals => {
  const { watchdog: _drop, ...rest } = CALM.observations!;
  void _drop;
  return { ...CALM, observations: watchdog === undefined ? rest : { ...rest, watchdog } };
};

describe("watchdog-forslag: kun DOWN", () => {
  it("DEGRADED gir ingen forslag - uansett hvor mange sjekker som feiler eller hvor mange feil på rad", () => {
    for (const data of [undefined, { failing_checks: 1, consecutive_failures: 0 }, { failing_checks: 4, consecutive_failures: 12 }]) {
      const r = proposeOpsActions(withWatchdog({ status: "DEGRADED", ...(data ? { data } : {}) }));
      expect(r.proposals, JSON.stringify(data)).toEqual([]);
      expect(r.skipped_no.join(" ")).not.toContain("watchdog");
      expect(JSON.stringify(r)).not.toContain("svekket");
    }
  });

  it("DOWN gir nøyaktig ett omstartforslag for worker (klasse D, step-up, utfører ingenting) med trigger DOWN og begrunnelsen «watchdog melder nede»", () => {
    const r = proposeOpsActions(withWatchdog({ status: "DOWN" }));
    expect(r.proposals.map((p) => p.id)).toEqual(["restart_service:worker"]);
    expect(r.proposals[0]).toMatchObject({ risk_class: "D", requires: "step_up", executes: false, proposed_calls: [], trigger: { area: "watchdog", status: "DOWN" } });
    expect(r.proposals[0]?.rationale_no).toContain("watchdog melder nede");
  });

  it("OK gir ingen forslag og ingen merknad", () => {
    const r = proposeOpsActions(withWatchdog({ status: "OK" }));
    expect(r.proposals).toEqual([]);
    expect(r.skipped_no).toEqual([]);
  });

  it("UKJENT og manglende område gir ingen forslag, men står i skipped_no med riktig tekst: «ingen leser» kun når området mangler helt (en leser finnes når svaret er UKJENT)", () => {
    const unknown = proposeOpsActions(withWatchdog({ status: "UNKNOWN" }));
    expect(unknown.proposals).toEqual([]);
    expect(unknown.skipped_no).toContain("watchdog er ikke målt (selvdiagnosen svarer UKJENT)");
    expect(unknown.skipped_no.filter((x) => x.startsWith("watchdog")).join(" ")).not.toContain("ingen leser");
    const missing = proposeOpsActions(withWatchdog(undefined));
    expect(missing.proposals).toEqual([]);
    expect(missing.skipped_no).toContain("watchdog er ikke målt (ingen leser)");
  });

  it("DOWN og en fastlåst jobb gir ÉTT omstartforslag for worker med begge triggerne; DEGRADED watchdog bidrar ikke til det", () => {
    const obs = { ...CALM.observations!, tasks: { status: "DEGRADED", data: { stuck: 3 } } };
    const both = proposeOpsActions({ ...CALM, observations: { ...obs, watchdog: { status: "DOWN" } } });
    expect(both.proposals.map((p) => p.id)).toEqual(["restart_service:worker"]);
    expect(both.proposals[0]?.rationale_no).toContain("watchdog melder nede");
    expect(both.proposals[0]?.rationale_no).toContain("3 jobber har utløpt lease");
    const onlyTasks = proposeOpsActions({ ...CALM, observations: { ...obs, watchdog: { status: "DEGRADED" } } });
    expect(onlyTasks.proposals.map((p) => p.id)).toEqual(["restart_service:worker"]);
    expect(onlyTasks.proposals[0]?.rationale_no).toBe("3 jobber har utløpt lease. Omstart er ett steg å prøve, ikke en garanti for at feilen forsvinner.");
  });

  it("andre områder er uendret: backup DEGRADED foreslår fortsatt backup, tasks DEGRADED med stuck foreslår worker (kun watchdog er innsnevret)", () => {
    const backup = proposeOpsActions({ ...CALM, observations: { ...CALM.observations!, backup: { status: "DEGRADED" } } });
    expect(backup.proposals.map((p) => p.id)).toEqual(["run_backup:nas"]);
    const tasks = proposeOpsActions({ ...CALM, observations: { ...CALM.observations!, tasks: { status: "DEGRADED", data: { stuck: 2 } } } });
    expect(tasks.proposals.map((p) => p.id)).toEqual(["restart_service:worker"]);
  });

  it("av som standard er uendret: enabled=false gir ingen forslag selv med watchdog DOWN", () => {
    const r = proposeOpsActions({ ...withWatchdog({ status: "DOWN" }), enabled: false });
    expect(r.proposals).toEqual([]);
    expect(r.enabled).toBe(false);
  });
});
