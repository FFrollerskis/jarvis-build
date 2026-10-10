import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs uten typer (delt med ops/security)
import { parseComposeServices } from "../../../ops/security/check-containment.mjs";
// @ts-expect-error - .mjs uten typer
import { SERVICE_ENV } from "../../../infra/local/service-env.mjs";

/**
 * L6 (gjennomgang av PR #313): B2 sendte `JARVIS_JOB_RUNNER/IMAGE/NETWORK/EGRESS_PROXY` også til api-containeren, bare for at aktiveringsberedskapen (EV-6) skulle kunne lese «er jobb-runneren konfigurert». API-et utfører
 * ingen kodejobber, og egress-proxy-adressen kan avsløre intern topologi (eller, hvis noen setter brukerinfo i den, legitimasjon - runneren nekter slik URL, men API-et ville likevel mottatt den). Prinsippet fra
 * remediering del 2 (per-tjeneste-hemmeligheter): en tjeneste får kun det den trenger. Nå går de KUN til worker; i API-et er «jobb-runner konfigurert» UKJENT til eieren erklærer det.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const compose = readFileSync(join(ROOT, "infra/local/docker-compose.yml"), "utf8");
const services = parseComposeServices(compose) as Record<string, string[]>;
const envKeys = (block: string[]): string[] => {
  const keys: string[] = [];
  let inEnv = false;
  for (const line of block) {
    if (/^ {4}environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (inEnv && /^ {4}\S/.test(line)) inEnv = false;
    const m = inEnv ? /^ {6}([A-Z0-9_]+):/.exec(line) : null;
    if (m) keys.push(m[1] as string);
  }
  return keys;
};
const RUNNER_VARS = ["JARVIS_JOB_RUNNER", "JARVIS_JOB_IMAGE", "JARVIS_JOB_NETWORK", "JARVIS_JOB_EGRESS_PROXY"];

describe("L6: jobb-runner-variablene går kun til worker", () => {
  it("manifestet: worker har alle fire, api har ingen av dem (JARVIS_JOB_TOOL_TURN_MODEL er en annen sak og er felles)", () => {
    for (const name of RUNNER_VARS) {
      expect(SERVICE_ENV.worker, `worker ${name}`).toContain(name);
      expect(SERVICE_ENV.api, `api ${name}`).not.toContain(name);
    }
    for (const service of Object.keys(SERVICE_ENV).filter((s) => s !== "worker")) {
      expect((SERVICE_ENV[service] as string[]).filter((n) => RUNNER_VARS.includes(n)), `${service} skal ikke få jobb-runner-variabler`).toEqual([]);
    }
    expect((SERVICE_ENV.api as string[]).filter((n) => n.startsWith("JARVIS_JOB_"))).toEqual(["JARVIS_JOB_TOOL_TURN_MODEL"]);
  });

  it("compose (generert): api-containeren setter ingen av dem; worker setter alle fire", () => {
    const api = envKeys(services["api"] ?? []);
    const worker = envKeys(services["worker"] ?? []);
    expect(api.length).toBeGreaterThan(50);
    for (const name of RUNNER_VARS) {
      expect(api, `api ${name}`).not.toContain(name);
      expect(worker, `worker ${name}`).toContain(name);
    }
    expect(compose).not.toMatch(/JARVIS_JOB_RUNNER:\s*"?container/);
  });

  it(".env.example forklarer at variablene kun går til worker og at eieren erklærer JOB_RUNNER_CONFIGURED", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(example).toContain("JOB_RUNNER_CONFIGURED");
    expect(example).toMatch(/KUN til worker-containeren/);
    expect(example).toMatch(/uten brukerinfo/);
  });
});
