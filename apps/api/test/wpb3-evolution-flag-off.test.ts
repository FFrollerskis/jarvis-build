import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { evaluateAllReadiness, type ReadinessFacts } from "@jarvis/self-modification";
import { CONTROL_CENTER_FLAGS, CONTROL_FEATURE_FLAGS, createControlCenterRegistry, registerControlCenters, type ControlCenterWiring } from "../src/control-center/register.ts";
import { controlCentersWithTools } from "../src/control-center/shared.ts";
import { ScriptedPool } from "./support/scripted-pool.ts";

/**
 * WP-B3 (D-475) gjennomgang L4 - FLAGG AV ER IDENTISK MED MAIN, bevist på REGISTERFABRIKKEN (`registerControlCenters`, linjen som registrerer Evolusjon-senteret) med den KOMPLETTE evolusjonskoblingen til stede (rapport, beredskap,
 * oppstartssjekk, run-rate, eierens tenant - slik `main.ts` kobler den) og flagget AV: registeret, oversikten, verktøylisten (`controlCentersWithTools`) og rapportoppslaget er NØYAKTIG som UTEN koblingen, og ingen kilde leses.
 * Før denne filen gjorde en bevisst flagg-AV-registrering av senteret nøyaktig ÉN test rød (selve flaggtesten); nå feller den hver av disse (kontroll: med flagget PÅ er senteret registrert, så testene er ikke tomme).
 */
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const authority = { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] };
const NOW = new Date("2026-11-15T10:00:00.000Z");
const FLAG = CONTROL_CENTER_FLAGS.evolution;
const FACTS: ReadinessFacts = { constitution_verified: true, ledger_ok: true, change_freeze_off: true, proven_connectors: 0, job_runner_configured: false, declared_gates: new Set<string>() };
/** To andre sentre på (kun pool/env trengs), så registeret og oversikten har ekte innhold å sammenligne - Evolusjon-flagget varierer. */
const OTHERS = { [CONTROL_CENTER_FLAGS.memory]: "on", [CONTROL_CENTER_FLAGS.privacy]: "on" };
const JUNK = ["true", "1", "ON", "On", "yes", " on", "on ", "", "off", "false", "enabled"];

interface Spies { report: number; readiness: number; ev0: number; runRate: number; pool: ScriptedPool }
function build(env: Record<string, string | undefined>, withEvolution: boolean): { registry: ReturnType<typeof createControlCenterRegistry>; spies: Spies } {
  const spies: Spies = { report: 0, readiness: 0, ev0: 0, runRate: 0, pool: new ScriptedPool([]) };
  const wiring: ControlCenterWiring = {
    pool: spies.pool.asPool(), env,
    ...(withEvolution ? {
      evolutionReport: async () => { spies.report += 1; return { as_of: NOW.toISOString(), sections: [] }; },
      evolutionReadiness: async () => { spies.readiness += 1; return evaluateAllReadiness(FACTS); },
      ev0Status: () => { spies.ev0 += 1; return null; },
      runRate: { report: async () => { spies.runRate += 1; throw new Error("skal ikke leses"); } },
      evolutionTenantId: "tenant-owner"
    } : {})
  };
  const registry = createControlCenterRegistry({ authority, now: () => NOW });
  registerControlCenters(registry, wiring);
  return { registry, spies };
}
const ids = (r: ReturnType<typeof createControlCenterRegistry>): string[] => r.list().map((c) => c.id);

describe("flagg AV: registerControlCenters med full evolusjonskobling er NØYAKTIG som uten den", () => {
  it("registeret (id-er, titler, beskrivelser) er likt med og uten koblingen - for ingen flagg og for hver ugyldig flaggverdi (kun eksakt «on» teller)", () => {
    for (const value of [undefined, ...JUNK]) {
      const env = { ...OTHERS, ...(value === undefined ? {} : { [FLAG]: value }) };
      const withDeps = build(env, true).registry;
      const without = build(env, false).registry;
      expect(withDeps.list(), JSON.stringify(value)).toEqual(without.list());
      expect(ids(withDeps), JSON.stringify(value)).toEqual(["memory", "privacy"]);
      expect(withDeps.has("evolution"), JSON.stringify(value)).toBe(false);
    }
  });

  it("rapportoppslaget for `evolution` er `null` (ikke koblet inn), også for eieren - og INGEN evolusjonskilde (rapport, beredskap, oppstartssjekk, run-rate) eller database leses", async () => {
    const { registry, spies } = build(OTHERS, true);
    expect(await registry.report("evolution", owner)).toBeNull();
    expect(await registry.explain("evolution", owner)).toBeNull();
    expect({ report: spies.report, readiness: spies.readiness, ev0: spies.ev0, runRate: spies.runRate }).toEqual({ report: 0, readiness: 0, ev0: 0, runRate: 0 });
    expect(spies.pool.queries).toEqual([]);
  });

  it("oversikten er tegn for tegn lik uten koblingen: ingen «tilleggssenter», ingen Evolusjon, ikke i `unregistered` - og ingen evolusjonskilde leses av å bygge den", async () => {
    const withDeps = build(OTHERS, true);
    const without = build(OTHERS, false);
    const a = await withDeps.registry.overview(owner);
    const b = await without.registry.overview(owner);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.summary_no).not.toMatch(/tilleggssenter|tilleggssentre|Evolusjon/);
    expect(a.unregistered).not.toContain("evolution");
    expect(a.centers.some((c) => c.center === "evolution")).toBe(false);
    expect({ report: withDeps.spies.report, readiness: withDeps.spies.readiness, ev0: withDeps.spies.ev0, runRate: withDeps.spies.runRate }).toEqual({ report: 0, readiness: 0, ev0: 0, runRate: 0 });
  });

  it("verktøylisten er den samme: `controlCentersWithTools` gir ikke `evolution` (og ellers akkurat det samme) med og uten koblingen", () => {
    for (const value of [undefined, ...JUNK]) {
      const env = { ...OTHERS, ...(value === undefined ? {} : { [FLAG]: value }) };
      const withDeps = controlCentersWithTools(env, build(env, true).registry);
      expect(withDeps, JSON.stringify(value)).toEqual(controlCentersWithTools(env, build(env, false).registry));
      expect(withDeps, JSON.stringify(value)).not.toContain("evolution");
    }
  });

  it("avgjørelsesflagget alene (JARVIS_CONTROL_EVOLUTION_APPROVAL=on uten senter-flagget) registrerer heller ingenting - og gir ingen knapper noe sted", async () => {
    const env = { ...OTHERS, [CONTROL_FEATURE_FLAGS.evolutionApproval]: "on" };
    const { registry } = build(env, true);
    expect(ids(registry)).toEqual(["memory", "privacy"]);
    expect(await registry.report("evolution", owner)).toBeNull();
    for (const id of ids(registry)) expect(((await registry.report(id as never, owner)) as { actions: unknown[] }).actions.every((a) => !JSON.stringify(a).includes("record_evolution_decision")), id).toBe(true);
  });
});

describe("kontroll: med flagget PÅ er senteret registrert (så testene over ikke er tomme)", () => {
  it("eksakt «on»: senteret finnes, står SIST (tilleggssenter etter de ti), har verktøy, og oversikten teller det som tilleggssenter", async () => {
    const env = { ...OTHERS, [FLAG]: "on" };
    const { registry } = build(env, true);
    expect(ids(registry)).toEqual(["memory", "privacy", "evolution"]);
    expect(controlCentersWithTools(env, registry)).toContain("evolution");
    expect(registry.has("evolution")).toBe(true);
    expect((await registry.overview(owner)).summary_no).toMatch(/tilleggssenter/);
  });

  it("flagget på, men uten evolusjonsrapporten: ikke registrert (ærlig «ikke koblet inn»)", () => {
    expect(ids(build({ ...OTHERS, [FLAG]: "on" }, false).registry)).toEqual(["memory", "privacy"]);
  });
});
