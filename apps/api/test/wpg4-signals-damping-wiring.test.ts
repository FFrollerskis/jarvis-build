import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FLAP_MAX_EPISODES, FLAP_WINDOW_MS } from "@jarvis/situations";

/**
 * WP-G4 (D-466) FIKS-RUNDE, A-LOW-8: flapp-dempingen er ALLTID på i drift. `SignalBusDeps.flapDamping` finnes kun som en testbryter (`false` slår den av for tester som seeder mange episoder for samme entitet på en time).
 * Ingen produksjonskode utenfor selve bussen får nevne den (og dermed aldri slå den av): wiringen bygger bussen uten feltet, så standarden (på, 3 per time) gjelder.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "test") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("A-LOW-8: flapp-dempingen kan ikke slås av i produksjonskode", () => {
  it("kun selve bussen (`signal-bus.ts`) nevner `flapDamping`; ingen wiring, rute eller annen modul gjør det", () => {
    const roots = [join(ROOT, "apps"), join(ROOT, "modules"), join(ROOT, "packages")];
    const files: string[] = [];
    for (const root of roots) {
      for (const pkg of readdirSync(root)) {
        const src = join(root, pkg, "src");
        try {
          if (statSync(src).isDirectory()) files.push(...sourceFiles(src));
        } catch {
          // pakken har ingen src-mappe
        }
      }
    }
    expect(files.length).toBeGreaterThan(100); // vakten ser faktisk på kildekoden
    const mentions = files.filter((f) => readFileSync(f, "utf8").includes("flapDamping")).map((f) => relative(ROOT, f));
    expect(mentions).toEqual(["modules/situations/src/signal-bus.ts"]);
  });

  it("standardgrensene som da gjelder i drift: 3 nye episoder per 60 minutter", () => {
    expect(FLAP_MAX_EPISODES).toBe(3);
    expect(FLAP_WINDOW_MS).toBe(3_600_000);
  });
});
