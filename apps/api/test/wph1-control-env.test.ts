import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - ren .mjs uten typer (genererer compose-blokkene)
import { NEVER_IN_RUNTIME, SERVICE_ENV } from "../../../infra/local/service-env.mjs";
import { CONTROL_CENTER_FLAGS } from "../src/control-center/register.ts";

/**
 * WP-H1: FLAGGENE NÅR CONTAINEREN. Compose sender KUN de miljøvariablene manifestet (`infra/local/service-env.mjs`) lister - en verdi i `.env` som ikke står der når aldri api-containeren, og flagget ville vært
 * stille virkningsløst (env-drift-vakten ser bare bokstavelige `process.env[...]`-lesinger, ikke flagg som leses via `flagOn(env, CONTROL_CENTER_FLAGS.x)`). Denne vakten låser derfor flaggobjektene selv:
 * hvert flagg står i api sitt manifest (og kun der), og compose har nøyaktig én videresendingslinje for det.
 */
const COMPOSE = readFileSync(fileURLToPath(new URL("../../../infra/local/docker-compose.yml", import.meta.url)), "utf8");
const FLAGS: string[] = [...Object.values(CONTROL_CENTER_FLAGS), "JARVIS_GOVERNANCE_PROVENANCE"];

describe("kontrollsenter-flaggene og proveniens-flagget når api-containeren", () => {
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
