import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessClassCAdaptersForTest } from "./support/class-c-adapter-keys.ts";
import { createClassCPipeline, defaultClassCAdapters, type ClassCAdapter, type ToolGatewayOptions } from "@jarvis/tool-gateway";
import { SCENARIOS, runScenarios, type Observation } from "./support/class-c-baseline-harness.ts";
import { startClassCTestDb, type ClassCTestDb } from "./support/class-c-test-db.ts";

/**
 * WP-AUTH2a (K7): FLAGG AV ER IDENTISK MED MAIN - differensialtest av `ToolGateway`.
 *
 * Hvert scenario (klasse A/B/C/D, avslag, replay, tidsavbrudd, produksjonsdefinisjoner for GitHub, Drive, Vercel, forretning og vekst) kjøres gjennom `ToolGateway.execute()` mot en ekte (embedded) Postgres, og ALT som kan
 * observeres utenfra sammenlignes med en BASELINE generert fra en REN `origin/main` (`baseline_sha`): resultatet av hvert kall, rekkefølgen av transportkall (handling + parametre), ledger-radene (`tool_executions`) og
 * revisjonsradene (`audit_events`: type, avgjørelse, årsak, klasse, payload). Tre varianter av «AV» må alle gi NØYAKTIG baseline: ingen option (slik api/worker kobler det med flagget AV), `classCPipeline: undefined`
 * og en pipeline konstruert i modus `off` MED alle adapterne.
 *
 * Fixturen (`fixtures/wpauth2a-main-gateway-baseline.json`) er generert slik (kun ved bevisst regenerering mot en ny main - scenariosettet i `support/class-c-baseline-harness.ts` er KILDEN):
 *   1. `git archive origin/main | tar -x -C <ny katalog>`; lenk rot-`node_modules` til dette treets og kopier hver pakkes `node_modules` med `cp -a` (relative lenker, så `@jarvis/*` peker på kopiens egne kilder),
 *   2. kopier `modules/tool-gateway/test/support/class-c-baseline-harness.ts` og `class-c-test-db.ts` UENDRET inn i kopien (de bruker kun API som finnes på main),
 *   3. kjør denne filen i kopien med `AUTH2A_WRITE_BASELINE=1 AUTH2A_BASE_SHA=<sha>` (genereringstesten under skriver fixturen; sammenligningstestene hoppes da over).
 * ALDRI generer fra et tre som inneholder klasse C-pipelinen: det ville kodet den nye atferden som «main». En LEGITIM atferdsendring i gatewayen fra en senere WP gjør testen rød til fixturen regenereres etter
 * punktene over - den skal aldri «oppdateres blindt»: diffen under viser nøyaktig hva som endret seg.
 */
interface Baseline { baseline: string; baseline_sha: string; scenarios: Observation[] }
const FIXTURE = new URL("./fixtures/wpauth2a-main-gateway-baseline.json", import.meta.url);
const WRITING = process.env["AUTH2A_WRITE_BASELINE"] === "1";
const baseline: Baseline = WRITING ? { baseline: "", baseline_sha: "", scenarios: [] } : (JSON.parse(readFileSync(fileURLToPath(FIXTURE), "utf8")) as Baseline);
const byId = new Map(baseline.scenarios.map((s) => [s.id, s]));

let db: ClassCTestDb;
beforeAll(async () => { db = await startClassCTestDb(); }, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

const allAdapters = (): ClassCAdapter[] => [...defaultClassCAdapters(), ...businessClassCAdaptersForTest()];

function firstDifference(got: Observation, want: Observation): string {
  for (const key of ["results", "calls", "ledger", "audit"] as const) {
    if (JSON.stringify(got[key]) !== JSON.stringify(want[key])) return `${key}: fikk ${JSON.stringify(got[key]).slice(0, 400)} - main ${JSON.stringify(want[key]).slice(0, 400)}`;
  }
  return "ukjent forskjell";
}

async function diffsFor(extra: (() => Partial<ToolGatewayOptions>) | undefined): Promise<{ compared: number; diffs: string[] }> {
  const got = await runScenarios(db, extra);
  const diffs: string[] = [];
  for (const observation of got) {
    const want = byId.get(observation.id);
    if (want === undefined) diffs.push(`${observation.id}: finnes ikke i baseline`);
    else if (JSON.stringify(observation) !== JSON.stringify(want)) diffs.push(`${observation.id}: ${firstDifference(observation, want)}`);
  }
  return { compared: got.length, diffs };
}

describe.skipIf(WRITING)("fixturen (generert fra en ren origin/main)", () => {
  it("peker på en eksakt main-commit, dekker ALLE scenariene i riktig rekkefølge og er stor nok til å bety noe", () => {
    expect(baseline.baseline).toBe("origin/main");
    expect(baseline.baseline_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.scenarios.map((s) => s.id)).toEqual(SCENARIOS.map((s) => s.id));
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(23);
  });

  it("baseline er ikke triviell: klasse A, B, C og D, avslag, replay, tidsavbrudd og de fem produksjonsdefinisjonene finnes med ekte ledger- og audit-rader", () => {
    const text = JSON.stringify(baseline.scenarios);
    for (const type of ["tool.executed", "tool.denied", "tool.failed", "tool.deduplicated", "tool.postcondition_unverified"]) expect(text, type).toContain(`"${type}"`);
    for (const reason of ["connector_frozen", "credential_revoked", "kill_switch_active", "invalid_parameters", "preflight_invalid:bad_state", "postcondition_mismatch", "tool_failed:tool_timeout"]) expect(text, reason).toContain(reason);
    for (const status of ["succeeded", "failed", "unverified"]) expect(text, status).toContain(`"status":"${status}"`);
    for (const id of ["prod.github.create_pr", "prod.drive.rename", "prod.drive.trash_fails", "prod.vercel.rollback_deployment", "prod.business.update_lead_status", "prod.growth.set_campaign_status"]) expect(byId.has(id), id).toBe(true);
    // main har ALDRI et class_c-objekt i revisjonen og aldri en pipeline-lesing: baseline beviser det
    expect(text).not.toContain("class_c");
  });
});

describe.skipIf(WRITING)("flagg AV er identisk med main (alle scenarier x tre varianter)", () => {
  for (const [name, extra] of [
    ["ingen option (slik api/worker kobler det med flagget AV)", undefined],
    ["classCPipeline: undefined", () => ({ classCPipeline: undefined }) as never],
    ["pipeline konstruert i modus off MED alle adapterne", () => ({ classCPipeline: createClassCPipeline({ mode: "off", adapters: allAdapters() }) })]
  ] as const) {
    it(`${name}: hvert scenario gir NØYAKTIG samme resultat, transportkall, ledger og audit som main`, async () => {
      const { compared, diffs } = await diffsFor(extra);
      expect(compared).toBe(SCENARIOS.length);
      expect(diffs).toEqual([]);
    });
  }
});

describe.skipIf(WRITING)("kontrolltest: sammenligningen er ikke tom (den oppdager en forskjell når den finnes)", () => {
  const ENGAGED = ["prod.github.create_pr", "prod.drive.rename", "prod.drive.trash_fails", "prod.business.update_lead_status", "prod.growth.set_campaign_status"];

  it.each(["observe", "enforce"] as const)("med modus %s avviker NØYAKTIG scenariene med en adapter (class_c i audit, ekstra lesinger); alt annet er fortsatt identisk med main", async (mode) => {
    const { diffs } = await diffsFor(() => ({ classCPipeline: createClassCPipeline({ mode, adapters: allAdapters() }) }));
    expect(diffs.map((d) => d.split(":")[0]).sort()).toEqual([...ENGAGED].sort());
    // og forskjellen er den vi venter: bevis i audit, ikke en tilfeldig endring
    expect(diffs.every((d) => d.includes("audit") || d.includes("calls") || d.includes("ledger") || d.includes("results"))).toBe(true);
  });

  it("vercel.rollback_deployment (utsatt, ingen adapter) er uendret i alle moduser - utsatte handlinger beholder dagens oppførsel", async () => {
    for (const mode of ["observe", "enforce"] as const) {
      const got = await runScenarios(db, () => ({ classCPipeline: createClassCPipeline({ mode, adapters: allAdapters() }) }), ["prod.vercel.rollback_deployment"]);
      expect(JSON.stringify(got[0]), mode).toBe(JSON.stringify(byId.get("prod.vercel.rollback_deployment")));
    }
  });
});

describe.skipIf(!WRITING)("generering av baseline (KUN fra en ren origin/main, se toppkommentaren)", () => {
  it("skriver fixturen", async () => {
    const scenarios = await runScenarios(db);
    expect(scenarios.length).toBe(SCENARIOS.length);
    await writeFile(fileURLToPath(FIXTURE), `${JSON.stringify({ baseline: "origin/main", baseline_sha: process.env["AUTH2A_BASE_SHA"] ?? "", scenarios }, null, 1)}\n`);
  });
});
