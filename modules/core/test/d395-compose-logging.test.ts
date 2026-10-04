import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs uten typer (delt med ops/security)
import { parseComposeServices } from "../../../ops/security/check-containment.mjs";

/**
 * D-395 (JARVIS-074): Docker json-file-logger har ingen standardgrense og fylte disken. HVER tjeneste må rotere (felles anker `default-logging`).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const compose = readFileSync(join(ROOT, "infra/local/docker-compose.yml"), "utf8");
const services = parseComposeServices(compose) as Record<string, string[]>;

describe("compose: logg-rotasjon på alle tjenester", () => {
  it("definerer ett felles anker med json-file, max-size og max-file", () => {
    expect(compose).toMatch(/^x-logging: &default-logging\n {2}driver: json-file\n {2}options:\n {4}max-size: "\d+m"\n {4}max-file: "\d+"/m);
  });

  it("alle tjenester bruker ankeret", () => {
    const names = Object.keys(services);
    expect(names.length).toBeGreaterThanOrEqual(10);
    const missing = names.filter((n) => !(services[n] ?? []).some((l) => l.trim() === "logging: *default-logging"));
    expect(missing).toEqual([]);
  });
});
