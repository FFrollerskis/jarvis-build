import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs uten typer (delt med ops/security)
import { SERVICE_ENV, NEVER_IN_RUNTIME } from "../../../infra/local/service-env.mjs";
import { PERSONAL_API_ENV_NAMES, PERSONAL_CONFIG_NAMES, PERSONAL_FLAG_NAMES, PERSONAL_SECRET_REFS, boundedInt, personalFlagOn } from "../src/index.ts";

/**
 * WP-G2 (D-464): vakt for at HVERT personlig-flagg og hver konfigurasjons-/vault-referanse faktisk når api-containeren (SERVICE_ENV.api + generert compose + .env.example), at ingen av dem når worker/voice/browser,
 * at ingen er satt som standard, og at kun den EKSAKTE verdien `on` slår et flagg på. (Uten dette ville et flagg i `.env` vært stille virkningsløst - compose sender bare det manifestet lister.)
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const compose = read("infra/local/docker-compose.yml");
const envExample = read(".env.example");

function composeBlock(service: string): string {
  const start = compose.indexOf(`# GENERERT fra infra/local/service-env.mjs (SERVICE_ENV.${service})`);
  expect(start).toBeGreaterThan(-1);
  const lines = compose.slice(start).split("\n");
  const out: string[] = [lines[0] as string];
  for (const line of lines.slice(1)) {
    if (!/^ {6}\S/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

describe("WP-G2: personlig-flaggene når api-containeren, og kun der", () => {
  const api: string[] = SERVICE_ENV.api;
  const apiBlock = composeBlock("api");

  it("hvert flagg, hver konfigurasjon og hver vault-referanse står i SERVICE_ENV.api, i den genererte compose-blokken (tom standard) og i .env.example", () => {
    expect(PERSONAL_API_ENV_NAMES.length).toBe(Object.keys(PERSONAL_FLAG_NAMES).length + Object.keys(PERSONAL_CONFIG_NAMES).length + Object.keys(PERSONAL_SECRET_REFS).length);
    expect(PERSONAL_API_ENV_NAMES.length).toBeGreaterThanOrEqual(15);
    for (const name of PERSONAL_API_ENV_NAMES) {
      expect(api, name).toContain(name);
      expect(apiBlock, name).toContain(`      ${name}: "\${${name}:-}"`); // tom standard = AV
      expect(envExample, name).toMatch(new RegExp(`^${name}=$`, "m")); // dokumentert, uten verdi
    }
    // Ingen duplikater i manifestet (en dobbel oppføring ville gitt en dobbel compose-linje).
    expect(new Set(api).size).toBe(api.length);
  });

  it("ingen av dem når worker/voice/browser/migrate (bakgrunnsflaten er read-only), og ingen står i NEVER_IN_RUNTIME", () => {
    for (const service of ["worker", "voice", "browser", "migrate"] as const) {
      const names: string[] = SERVICE_ENV[service];
      for (const name of PERSONAL_API_ENV_NAMES) expect(names, `${service}:${name}`).not.toContain(name);
    }
    for (const name of PERSONAL_API_ENV_NAMES) expect(NEVER_IN_RUNTIME, name).not.toContain(name);
  });

  it("alle flagg heter JARVIS_PERSONAL_* og er AV som standard: kun eksakt `on` slår på (ikke true/1/yes/ON/tom)", () => {
    for (const name of Object.values(PERSONAL_FLAG_NAMES)) {
      expect(name).toMatch(/^JARVIS_PERSONAL_[A-Z_]+$/);
      expect(personalFlagOn({}, name)).toBe(false);
      for (const value of ["", "true", "1", "yes", "ON", "On", " on", "on ", "enabled", "off"]) expect(personalFlagOn({ [name]: value }, name), `${name}=${JSON.stringify(value)}`).toBe(false);
      expect(personalFlagOn({ [name]: "on" }, name)).toBe(true);
    }
  });

  it("boundedInt: kun rene heltall innenfor intervallet; alt annet gir standarden (aldri en klemming til en farlig verdi)", () => {
    expect(boundedInt("5000", 3_000, 120_000, 20_000)).toBe(5_000);
    for (const bad of [undefined, "", "abc", "2999", "120001", "1.5", "-1", "1e4", "0x10", "99999999999"]) expect(boundedInt(bad, 3_000, 120_000, 20_000), String(bad)).toBe(20_000);
  });
});
