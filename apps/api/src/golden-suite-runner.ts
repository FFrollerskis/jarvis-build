// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { createHash } from "node:crypto";
import type { GoldenSuiteControl, GoldenSuiteRunResult } from "@jarvis/executive";
import type { MeshToolMapping } from "@jarvis/tool-gateway";
import { GOLDEN, goldenSuite, runGolden, GOLDEN_SUITE_DIGEST } from "./golden-suite.ts";

/**
 * WP-H2 (UA-11 Admin Control Center): golden-suite-knappen. Kjører den EKSISTERENDE deterministiske suiten (`golden-suite.ts`, WP-B/D-452) fra kontrollsenteret og gir et kompakt, innholdsfritt resultat med digester.
 *
 *  - LESENDE og DETERMINISTISK: ingen modellkall (suiten importerer ingen modellgateway; `model_calls` er alltid 0), ingen database, ingen nettverkskall, ingen skriving. Kjøringen endrer ingenting utenfor prosessens minne
 *    (siste resultat holdes i minnet så kontrollsenteret kan vise det; det nullstilles ved omstart).
 *  - ÉN KJØRING OM GANGEN: et kall mens en kjøring pågår får samme resultat (ingen stabling av CPU-arbeid).
 *  - DIGESTER: `suite_digest` er suitens definisjon (samme som `GOLDEN_SUITE_DIGEST`, låst av `golden-suite.test.ts`); `result_digest` er SHA-256 over resultatet uten tidspunkt/varighet, så to kjøringer av samme kode gir samme digest.
 *  - ÆRLIG: oppgaver som krever chat-flatens verktøyutvalg hoppes over (og står som «ikke kjørt») når flaten ikke er tilgjengelig - de teller aldri som bestått.
 */
export interface GoldenSuiteRunnerDeps {
  /** Produksjonens verktøyflate (`modelToolSurface`), eller null. */
  surface: () => ReadonlyArray<MeshToolMapping> | null;
  now?: () => Date;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function createGoldenSuiteRunner(deps: GoldenSuiteRunnerDeps): GoldenSuiteControl {
  const now = deps.now ?? (() => new Date());
  let last: GoldenSuiteRunResult | null = null;
  let inflight: Promise<GoldenSuiteRunResult> | null = null;

  async function execute(): Promise<GoldenSuiteRunResult> {
    const startedAt = now();
    const t0 = performance.now();
    const surface = deps.surface();
    const run = await runGolden({ surface });
    const suite = goldenSuite();
    const suiteDigest = GOLDEN_SUITE_DIGEST();
    const ran = run.metrics.tasks;
    const failed = [...run.failed].sort();
    const skipped = [...run.skipped].sort();
    const redTeam = run.red_team.map((r) => ({ category: String(r.category), attempts: r.attempts, breaches: r.breaches })).sort((a, b) => a.category.localeCompare(b.category));
    const uncovered = run.uncovered.map(String).sort();
    const result: GoldenSuiteRunResult = {
      ran_at: startedAt.toISOString(),
      duration_ms: Math.max(0, Math.round(performance.now() - t0)),
      suite_id: suite.suite_id,
      suite_version: suite.version,
      suite_digest: suiteDigest,
      result_digest: sha256(JSON.stringify({ suite_digest: suiteDigest, ran, passed: ran - failed.length, failed, skipped, red_team: redTeam, hard_stop: run.hard_stop, uncovered })),
      total: GOLDEN.length,
      ran,
      passed: ran - failed.length,
      failed,
      skipped,
      red_team: redTeam,
      hard_stop: run.hard_stop,
      uncovered,
      surface_available: surface !== null,
      model_calls: 0
    };
    last = result;
    return result;
  }

  return {
    last: () => last,
    run(): Promise<GoldenSuiteRunResult> {
      if (inflight !== null) return inflight;
      const started = execute().finally(() => { inflight = null; });
      inflight = started;
      return started;
    }
  };
}
