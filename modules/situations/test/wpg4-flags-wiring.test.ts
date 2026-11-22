import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs uten typer (delt med ops/security)
import { SERVICE_ENV, NEVER_IN_RUNTIME } from "../../../infra/local/service-env.mjs";
import { SITUATION_API_ENV_NAMES, SITUATION_CONFIG_NAMES, SITUATION_FLAG_NAMES, boundedInt, situationFlagOn, situationFlagsFromEnv } from "../src/flags.ts";

/**
 * WP-G4 (D-466): vakt for at HVERT hendelsesabonnement-flagg og hver tallkonfigurasjon faktisk når api-containeren (SERVICE_ENV.api + generert compose + .env.example), at ingen av dem når worker/voice/browser/migrate, at ingen er satt
 * som standard, at kun den EKSAKTE verdien `on` slår et flagg på, og at underflaggene kun gjelder under hovedbryteren. (Uten dette ville et flagg i `.env` vært stille virkningsløst - compose sender bare det manifestet lister.)
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

describe("A: flaggene når api-containeren, og kun der", () => {
  const api: string[] = SERVICE_ENV.api;
  const apiBlock = composeBlock("api");

  it("hvert navn står i SERVICE_ENV.api, i den genererte compose-blokken (tom standard) og i .env.example (uten verdi); ingen duplikater", () => {
    expect(SITUATION_API_ENV_NAMES.length).toBe(Object.keys(SITUATION_FLAG_NAMES).length + Object.keys(SITUATION_CONFIG_NAMES).length);
    expect(SITUATION_API_ENV_NAMES.length).toBe(9);
    for (const name of SITUATION_API_ENV_NAMES) {
      expect(api, name).toContain(name);
      expect(apiBlock, name).toContain(`      ${name}: "\${${name}:-}"`);
      expect(envExample, name).toMatch(new RegExp(`^${name}=$`, "m"));
    }
    expect(new Set(api).size).toBe(api.length);
  });

  it("ingen av dem når worker/voice/browser/migrate, og ingen står i NEVER_IN_RUNTIME", () => {
    for (const service of ["worker", "voice", "browser", "migrate"] as const) {
      const names: string[] = SERVICE_ENV[service];
      for (const name of SITUATION_API_ENV_NAMES) expect(names, `${service}:${name}`).not.toContain(name);
    }
    for (const name of SITUATION_API_ENV_NAMES) expect(NEVER_IN_RUNTIME, name).not.toContain(name);
  });
});

describe("B: kun eksakt `on` slår på, og underflaggene gjelder kun under hovedbryteren", () => {
  it("alle flagg heter JARVIS_SITUATION_* og er AV uten verdi og for enhver verdi som ikke er eksakt `on`", () => {
    for (const name of Object.values(SITUATION_FLAG_NAMES)) {
      expect(name).toMatch(/^JARVIS_SITUATION_[A-Z_]+$/);
      expect(situationFlagOn({}, name)).toBe(false);
      for (const value of ["", "true", "1", "yes", "ON", "On", " on", "on ", "enabled", "off"]) expect(situationFlagOn({ [name]: value }, name), `${name}=${JSON.stringify(value)}`).toBe(false);
      expect(situationFlagOn({ [name]: "on" }, name)).toBe(true);
    }
    expect(situationFlagsFromEnv({})).toEqual({ signals: false, home: false, vision: false, health: false, incidents: false, modelAssist: false, feedback: false });
  });

  it("underflagg uten hovedbryter = alt av (å slå på helse alene leser ingenting); hovedbryter alene = ingen kilde på", () => {
    const subs = Object.fromEntries(Object.values(SITUATION_FLAG_NAMES).filter((n) => n !== SITUATION_FLAG_NAMES.signals).map((n) => [n, "on"]));
    expect(situationFlagsFromEnv(subs)).toEqual({ signals: false, home: false, vision: false, health: false, incidents: false, modelAssist: false, feedback: false });
    expect(situationFlagsFromEnv({ [SITUATION_FLAG_NAMES.signals]: "on" })).toEqual({ signals: true, home: false, vision: false, health: false, incidents: false, modelAssist: false, feedback: false });
    expect(situationFlagsFromEnv({ ...subs, [SITUATION_FLAG_NAMES.signals]: "on" })).toEqual({ signals: true, home: true, vision: true, health: true, incidents: true, modelAssist: true, feedback: true });
  });

  it("boundedInt: ugyldig/utenfor intervall gir standard (aldri en stille klemming)", () => {
    expect(boundedInt(undefined, 15, 3600, 60)).toBe(60);
    expect(boundedInt("", 15, 3600, 60)).toBe(60);
    expect(boundedInt("30", 15, 3600, 60)).toBe(30);
    expect(boundedInt("14", 15, 3600, 60)).toBe(60);
    expect(boundedInt("3601", 15, 3600, 60)).toBe(60);
    expect(boundedInt("abc", 15, 3600, 60)).toBe(60);
    expect(boundedInt("-5", 15, 3600, 60)).toBe(60);
    expect(boundedInt("1e3", 15, 3600, 60)).toBe(60);
  });
});
