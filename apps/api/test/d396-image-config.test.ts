import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildStatusSource } from "@jarvis/tool-gateway";

/**
 * D-396 (JARVIS-057): runtime-imaget må inneholde det koden leser, og «ukjent» skal aldri presenteres som «ingen».
 *  - `config/charlie-personality.json` leses av api/src/personality-config.ts - uten COPY config ble standardverdiene brukt i containeren,
 *  - `docs/` er i .dockerignore - buildStatusSource skal da si «utilgjengelig», ikke «0 åpne runtime-porter».
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("api-imaget inneholder konfigfilene koden leser", () => {
  const dockerfile = readFileSync(join(ROOT, "infra/local/api.Dockerfile"), "utf8");
  const dockerignore = readFileSync(join(ROOT, ".dockerignore"), "utf8");

  it("api.Dockerfile kopierer config/ inn i imaget", () => {
    expect(dockerfile).toMatch(/^COPY config \.\/config$/m);
  });

  it(".dockerignore ekskluderer ikke config/ (og ikke personality-filen)", () => {
    const rules = dockerignore.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    expect(rules).not.toContain("config");
    expect(rules).not.toContain("config/");
    expect(rules.some((r) => /charlie-personality/.test(r))).toBe(false);
  });

  it("personality-config.ts leser faktisk filen to nivåer opp fra apps/api/src (=> /app/config i imaget)", () => {
    const src = readFileSync(join(ROOT, "apps/api/src/personality-config.ts"), "utf8");
    expect(src).toContain('"../../../config/charlie-personality.json"');
  });
});

describe("buildStatusSource er ærlig når statusfilen mangler", () => {
  it("manglende fil => «Byggestatus utilgjengelig» (aldri «0 åpne runtime-porter»)", async () => {
    const items = await buildStatusSource(null, join(ROOT, "finnes-ikke", "PROJECT_STATUS.md")).collect({} as never);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Byggestatus utilgjengelig");
    expect(items[0]?.detail).toContain("UKJENT");
    expect(items[0]?.title).not.toMatch(/^0 åpne/);
  });
});
