import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { correlationFields, scheduledRunCorrelation } from "@jarvis/contracts";
import { BusinessEventSyncService, runBusinessEventSyncForAllTenants } from "@jarvis/business";
import { ConversationGraphSyncService, runConversationGraphSyncForAllTenants } from "@jarvis/conversation-graph";
import { SupportEmailService, runSupportInboxSyncForAllTenants } from "@jarvis/support";
import type { ToolGateway } from "@jarvis/tool-gateway";

/**
 * WP-K (D-471, JARVIS-054): `person_id: "system"`-synkene (business/support/conversation-graph) bærer kjøringens oppgave-/spor-ID inn i `ToolGateway.execute()`, slik at revisjonsradene og
 * policy-avgjørelsene deres kan knyttes til jobben og forsøket som utløste dem. Ingen falsk prinsipal: identiteten er fortsatt `person_id: "system"`, og uten korrelasjon er kallet BYTE-IDENTISK med før
 * (ingen `task_id`/`trace_id`-nøkler). Pluss en kildevakt som hindrer at et nytt system-kall glemmer korrelasjonen.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const TENANTS = ["tenant-one", "tenant-two"];
const run = { job_name: "demo-sync", run_date: "2026-11-14", attempt: 2, instance_id: "sched-test", ...scheduledRunCorrelation("demo-sync", "2026-11-14", 2) };

interface Executed { identity: { person_id: string; tenant_id: string; session_id?: string }; tool_id: string; action: string; task_id?: string; trace_id?: string }

function capturingGateway(): { gateway: ToolGateway; calls: Executed[] } {
  const calls: Executed[] = [];
  const gateway = {
    execute: async (request: Executed) => {
      calls.push(request);
      return { ok: true, data: { messages: [], events: [] } };
    }
  } as unknown as ToolGateway;
  return { gateway, calls };
}

const pool = { query: async () => ({ rows: TENANTS.map((tenant_id) => ({ tenant_id })) }) } as unknown as pg.Pool;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("korrelasjons-ID-ene: format og trygghet", () => {
  it("task_id er stabil per jobb og dag, trace_id er unik per forsøk", () => {
    const first = scheduledRunCorrelation("business-events-sync", "2026-11-14", 1);
    const retry = scheduledRunCorrelation("business-events-sync", "2026-11-14", 2);
    const tomorrow = scheduledRunCorrelation("business-events-sync", "2026-11-15", 1);
    expect(first).toEqual({ task_id: "sched:business-events-sync:2026-11-14", trace_id: "sched-business-events-sync-2026-11-14-a1" });
    expect(retry.task_id).toBe(first.task_id);
    expect(retry.trace_id).not.toBe(first.trace_id);
    expect(tomorrow.task_id).not.toBe(first.task_id);
  });

  it("ID-ene er rene identifikatorer: kontrolltegn/mellomrom/rare tegn i jobbnavnet kan aldri ende i en ID, og en ugyldig forsøkstelling klemmes til 1", () => {
    const messy = scheduledRunCorrelation("Bad job\n; DROP TABLE x --", "2026-11-14", Number.NaN);
    expect(messy.task_id).toMatch(/^sched:[A-Za-z0-9._-]+:2026-11-14$/);
    expect(messy.trace_id).toMatch(/^sched-[A-Za-z0-9._-]+-2026-11-14-a1$/);
    expect(scheduledRunCorrelation("", "", 0).task_id).toBe("sched:unknown:unknown");
    expect(scheduledRunCorrelation("x".repeat(500), "2026-11-14", 1).task_id.length).toBeLessThan(100);
  });

  it("correlationFields plukker kun de to ID-ene (et ScheduledRun har flere felt), og utelater tomme/manglende", () => {
    expect(correlationFields(run)).toEqual({ task_id: run.task_id, trace_id: run.trace_id });
    expect(correlationFields(undefined)).toEqual({});
    expect(correlationFields({ task_id: "", trace_id: undefined })).toEqual({});
    expect(correlationFields({ trace_id: "t-1" })).toEqual({ trace_id: "t-1" });
  });
});

describe("hver `system`-synk sender kjøringens oppgave-/spor-ID videre til ToolGateway.execute()", () => {
  const openLoops = { runSweep: async () => ({ detected: 0, updated: 0, auto_resolved: 0 }) };

  it("business-events-sync: begge kallene (Gmail + Calendar) per tenant bærer samme task_id/trace_id, som `system`", async () => {
    const { gateway, calls } = capturingGateway();
    const service = new BusinessEventSyncService(gateway, {} as never, openLoops as never, "owner@example.test");
    await runBusinessEventSyncForAllTenants(pool, service, undefined, run);
    expect(calls.map((c) => `${c.identity.tenant_id}:${c.tool_id}.${c.action}`).sort()).toEqual([
      "tenant-one:calendar.list_events", "tenant-one:email.list_messages", "tenant-two:calendar.list_events", "tenant-two:email.list_messages"
    ]);
    for (const call of calls) {
      expect(call.identity.person_id).toBe("system"); // ingen falsk prinsipal
      expect(call.task_id).toBe("sched:demo-sync:2026-11-14");
      expect(call.trace_id).toBe("sched-demo-sync-2026-11-14-a2");
    }
  });

  it("conversation-graph-sync: kallet bærer task_id/trace_id", async () => {
    const { gateway, calls } = capturingGateway();
    const service = new ConversationGraphSyncService(gateway, {} as never, {} as never, "owner@example.test");
    await runConversationGraphSyncForAllTenants(pool, service, undefined, run);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.identity.person_id).toBe("system");
      expect(call).toMatchObject({ task_id: run.task_id, trace_id: run.trace_id, tool_id: "email", action: "list_messages" });
    }
  });

  it("support-inbox-sync: kallet bærer task_id/trace_id", async () => {
    const { gateway, calls } = capturingGateway();
    const service = new SupportEmailService(gateway, {} as never, {} as never, "owner@example.test", []);
    await runSupportInboxSyncForAllTenants(pool, service, undefined, run);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.identity.person_id).toBe("system");
      expect(call).toMatchObject({ task_id: run.task_id, trace_id: run.trace_id, tool_id: "email", action: "list_messages" });
    }
  });

  it("UTEN korrelasjon er kallene byte-identiske med før: ingen task_id/trace_id-nøkler i det hele tatt (standardoppførselen er uendret)", async () => {
    const business = capturingGateway();
    await runBusinessEventSyncForAllTenants(pool, new BusinessEventSyncService(business.gateway, {} as never, openLoops as never, "owner@example.test"));
    const graph = capturingGateway();
    await runConversationGraphSyncForAllTenants(pool, new ConversationGraphSyncService(graph.gateway, {} as never, {} as never, "owner@example.test"));
    const support = capturingGateway();
    await runSupportInboxSyncForAllTenants(pool, new SupportEmailService(support.gateway, {} as never, {} as never, "owner@example.test", []));
    const all = [...business.calls, ...graph.calls, ...support.calls];
    expect(all).toHaveLength(8);
    for (const call of all) {
      expect(Object.keys(call).sort()).toEqual(["action", "identity", "parameters", "tool_id"]);
    }
  });

  it("en tom/delvis korrelasjon (nøstet kall der det ytre kallet kun hadde ett av feltene) sender kun det som finnes", async () => {
    const { gateway, calls } = capturingGateway();
    const service = new BusinessEventSyncService(gateway, {} as never, openLoops as never, "owner@example.test");
    await service.syncTenant("tenant-one", "business", { person_id: "system", tenant_id: "tenant-one", memory_space_id: "business", session_id: "s", device_id: "jarvis-core", channel: "api", auth_strength: "active" }, { trace_id: "trace-only" });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.trace_id).toBe("trace-only");
      expect("task_id" in call).toBe(false);
    }
  });
});

describe("kildevakt: ingen system-kall uten korrelasjon, og planlagte jobber får kjøringen", () => {
  const MAIN = readFileSync(join(HERE, "..", "src", "main.ts"), "utf8");

  it("de tre system-jobbene i main.ts tar imot `run` fra DailyScheduler og sender den som siste argument", () => {
    for (const [job, fn] of [["business-events-sync", "runBusinessEventSyncForAllTenants"], ["conversation-graph-sync", "runConversationGraphSyncForAllTenants"], ["support-inbox-sync", "runSupportInboxSyncForAllTenants"]] as const) {
      expect(MAIN, job).toContain(`.start((run) => failOnSweepFailures("${job}", (failures) => ${fn}(pool,`);
      expect(MAIN, job).toMatch(new RegExp(`${fn}\\(pool, \\w+, failures, run\\)`));
    }
  });

  /** Kun kodelinjer: kommentarlinjer (`//`, `/*`, `*`) som BARE nevner mønsteret skal ikke utløse vakten. */
  const codeOnly = (text: string): string => text.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n");

  /** Alle kildefiler (ikke tester) under modules/<pakke>/src. */
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "test" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
    }
    return out;
  }

  it("i hver pakke som bygger en `person_id: \"system\"`-identitet bruker ALLE filer som kaller gateway.execute() correlationFields (ingen nye system-kall uten korrelasjon)", () => {
    const modulesDir = join(ROOT, "modules");
    const offenders: string[] = [];
    const systemPackages: string[] = [];
    for (const pkg of readdirSync(modulesDir)) {
      const src = join(modulesDir, pkg, "src");
      try { if (!statSync(src).isDirectory()) continue; } catch { continue; }
      const files = sourceFiles(src).map((file) => ({ file, text: readFileSync(file, "utf8") }));
      if (!files.some(({ text }) => /person_id:\s*"system"/.test(codeOnly(text)))) continue;
      systemPackages.push(pkg);
      for (const { file, text } of files) {
        if (/\.execute\(\{/.test(text) && !text.includes("correlationFields(")) offenders.push(relative(ROOT, file));
      }
    }
    // vakten kan ikke passere tomt: de tre kjente system-pakkene er med
    expect(systemPackages).toEqual(expect.arrayContaining(["business", "support", "conversation-graph"]));
    expect(offenders).toEqual([]);
  });
});
