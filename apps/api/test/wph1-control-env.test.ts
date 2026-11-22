import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - ren .mjs uten typer (genererer compose-blokkene)
import { NEVER_IN_RUNTIME, SERVICE_ENV } from "../../../infra/local/service-env.mjs";
import { CONTROL_CENTER_FLAGS, CONTROL_FEATURE_FLAGS } from "../src/control-center/register.ts";

/**
 * WP-H1: FLAGGENE NÅR CONTAINEREN. Compose sender KUN de miljøvariablene manifestet (`infra/local/service-env.mjs`) lister - en verdi i `.env` som ikke står der når aldri api-containeren, og flagget ville vært
 * stille virkningsløst (env-drift-vakten ser bare bokstavelige `process.env[...]`-lesinger, ikke flagg som leses via `flagOn(env, CONTROL_CENTER_FLAGS.x)`). Denne vakten låser derfor flaggobjektene selv:
 * hvert flagg står i api sitt manifest (og kun der), og compose har nøyaktig én videresendingslinje for det.
 */
const COMPOSE = readFileSync(fileURLToPath(new URL("../../../infra/local/docker-compose.yml", import.meta.url)), "utf8");
// WP-H2 la til fire senterflagg (i CONTROL_CENTER_FLAGS) og to enkeltfunksjoner (CONTROL_FEATURE_FLAGS: golden-suite og tilbakekall av autonomi-binding) - alle må nå containeren.
// WP-B3 (D-475) la til tilleggssenterflagget JARVIS_CONTROL_CENTER_EVOLUTION (i CONTROL_CENTER_FLAGS) og enkeltfunksjonsflagget JARVIS_CONTROL_EVOLUTION_APPROVAL (i CONTROL_FEATURE_FLAGS) - begge må nå containeren.
const FLAGS: string[] = [...Object.values(CONTROL_CENTER_FLAGS), ...Object.values(CONTROL_FEATURE_FLAGS), "JARVIS_GOVERNANCE_PROVENANCE"];

describe("kontrollsenter-flaggene og proveniens-flagget når api-containeren", () => {
  it("alle tolv flagg (åtte senterflagg inkl. tilleggssenteret Evolusjon + tre enkeltfunksjoner inkl. eierens avgjørelse om forslag + proveniens) er med - ingen er glemt", () => {
    expect(FLAGS).toHaveLength(12);
    expect(new Set(FLAGS).size).toBe(12);
  });

  it("hvert flagg står i SERVICE_ENV.api - og ikke i worker, voice, browser eller migrate (kun api leser dem)", () => {
    for (const name of FLAGS) {
      expect(SERVICE_ENV.api, name).toContain(name);
      for (const service of ["worker", "voice", "browser", "migrate"] as const) expect(SERVICE_ENV[service], `${service}:${name}`).not.toContain(name);
    }
  });

  it("compose har nøyaktig én videresendingslinje per flagg (tom standard = AV), generert fra manifestet", () => {
    for (const name of FLAGS) {
      const lines = COMPOSE.split("\n").filter((l) => l.trim().startsWith(`${name}:`));
      expect(lines, name).toHaveLength(1);
      expect(lines[0]!.trim(), name).toBe(`${name}: "\${${name}:-}"`);
    }
  });

  it("flaggene er ikke en hemmelighet: ingen av dem står i listen over det som aldri skal inn i en runtime-tjeneste", () => {
    for (const name of FLAGS) expect(NEVER_IN_RUNTIME, name).not.toContain(name);
  });
});
