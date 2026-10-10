import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs uten typer (delt med ops/security)
import { SERVICE_ENV } from "../../../infra/local/service-env.mjs";

/**
 * WP-D2 (JARVIS-082): SLA-regelen `support_ticket_overdue` var et «spøkelse» - koblet til felt ingen skrev. Nå utleder den fristen fra faktiske kundemeldinger, og policyen
 * (`JARVIS_SUPPORT_SLA_HOURS`) må nå begge prosessene som kjører sveipene (api og worker) - ellers ville en konfigurasjon stille blitt ignorert i den ene. Kildevakt: policyen
 * parses fra miljøet i BEGGE inngangene (fail closed), sendes inn i OpenLoopService, og variabelen er videresendt til begge containerne og dokumentert.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("JARVIS_SUPPORT_SLA_HOURS når OpenLoopService i både api og worker", () => {
  it("api: parses ved oppstart (ugyldig verdi kaster og stopper oppstarten) og sendes inn i OpenLoopService", () => {
    const main = read("apps/api/src/main.ts");
    expect(main).toContain('parseSupportSlaHours(process.env["JARVIS_SUPPORT_SLA_HOURS"])');
    expect(main).toMatch(/new OpenLoopService\(pool, \{ supportSla: parseSupportSlaHours\(process\.env\["JARVIS_SUPPORT_SLA_HOURS"\]\) \}\)/);
    expect(main.match(/new OpenLoopService\(/g)).toHaveLength(1);
  });

  it("worker: samme policy, og ugyldig verdi stopper oppstarten via failStartup (aldri en stille standard)", () => {
    const worker = read("apps/api/src/worker-main.ts");
    expect(worker).toMatch(/try \{\s*supportSla = parseSupportSlaHours\(process\.env\["JARVIS_SUPPORT_SLA_HOURS"\]\);\s*\} catch \(err\) \{\s*failStartup\(err\);\s*\}/);
    expect(worker).toContain("new OpenLoopService(pool, { supportSla })");
    expect(worker.match(/new OpenLoopService\(/g)).toHaveLength(1);
  });

  it("variabelen er videresendt til api OG worker (compose), og dokumentert med trygg standard i .env.example", () => {
    expect(SERVICE_ENV.api).toContain("JARVIS_SUPPORT_SLA_HOURS");
    expect(SERVICE_ENV.worker).toContain("JARVIS_SUPPORT_SLA_HOURS");
    const example = read(".env.example");
    expect(example).toMatch(/^# JARVIS_SUPPORT_SLA_HOURS=urgent=4,high=8,normal=24,low=72$/m);
    expect(example).toContain("STOPPER oppstarten");
    const compose = read("infra/local/docker-compose.yml");
    expect(compose.match(/JARVIS_SUPPORT_SLA_HOURS: "\$\{JARVIS_SUPPORT_SLA_HOURS:-\}"/g)).toHaveLength(2);
  });
});
