import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-198 (V4-revisjon): `main.ts`/`worker-main.ts` er top-level side-effekt-
 * skript (kobler til DB og starter en server/lytter idet de importeres) -
 * kan derfor IKKE trygt importeres direkte i en testfil, samme presedens som
 * `drive-runtime-wiring.test.ts`/`situation-sweep-infra-wiring.test.ts`.
 * Denne suiten verifiserer at den ukentlige business-brief-schedulerern
 * faktisk er wiret KORREKT - spesielt at den ALDRI kan bli en daglig push
 * (se `business-brief.ts` sin doc-kommentar for hvorfor det ville vært
 * duplikat-varsling av situations-broens allerede eksisterende
 * sanntidslevering).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const mainSource = readSource("../src/main.ts");
const workerSource = readSource("../src/worker-main.ts");

describe("A: main.ts sin business-weekly-brief-scheduler er wiret korrekt (D-198)", () => {
  it("DailyScheduler(pool, 'business-weekly-brief', ...) sin deliver-callback sjekker isWeeklyBriefDay() FØR runBusinessWeeklyBriefForAllTenants() kalles - aldri en ubetinget daglig levering", () => {
    const callIdx = mainSource.indexOf('"business-weekly-brief"');
    expect(callIdx).toBeGreaterThan(-1);
    const block = mainSource.slice(callIdx, mainSource.indexOf("\n  });", callIdx));
    expect(block).toMatch(/if\s*\(!isWeeklyBriefDay\(/);
    expect(block).toContain("runBusinessWeeklyBriefForAllTenants(pool, toolGateway,");
  });

  it("feil fra runBusinessWeeklyBriefForAllTenants() logges (console.error/business_weekly_brief_failed) - aldri stille svelget", () => {
    const callIdx = mainSource.indexOf('"business-weekly-brief"');
    const block = mainSource.slice(callIdx, mainSource.indexOf("\n  });", callIdx));
    expect(block).toMatch(/if\s*\(result\.errors\.length > 0\)/);
    expect(block).toContain("business_weekly_brief_failed");
  });

  it("importerer isWeeklyBriefDay og runBusinessWeeklyBriefForAllTenants fra @jarvis/business", () => {
    expect(mainSource).toMatch(/import\s*\{[^}]*isWeeklyBriefDay[^}]*\}\s*from\s*"@jarvis\/business"/s);
    expect(mainSource).toMatch(/import\s*\{[^}]*runBusinessWeeklyBriefForAllTenants[^}]*\}\s*from\s*"@jarvis\/business"/s);
  });
});

describe("B: worker-main.ts har (bevisst, uendret siden D-194/D-195) INGEN DailyScheduler-baserte jobber - business-weekly-brief bor KUN i main.ts", () => {
  it("worker-main.ts nevner verken runBusinessWeeklyBriefForAllTenants eller DailyScheduler", () => {
    expect(workerSource).not.toMatch(/runBusinessWeeklyBriefForAllTenants/);
    expect(workerSource).not.toMatch(/DailyScheduler/);
  });
});
