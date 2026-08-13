import { describe, expect, it } from "vitest";
import { fastRoute } from "@jarvis/core";

describe("Fast Router v1 (deterministisk, uten LLM)", () => {
  it("matcher kjente kommandoer", () => {
    expect(fastRoute("status")).toEqual({ kind: "system_status" });
    expect(fastRoute("  Systemstatus ")).toEqual({ kind: "system_status" });
    expect(fastRoute("jobbstatus task-123")).toEqual({ kind: "task_status", task_id: "task-123" });
    expect(fastRoute("opprett jobb: skriv rapport om NAS")).toEqual({
      kind: "create_task",
      goal: "skriv rapport om NAS"
    });
    expect(fastRoute("Opprett jobb rydd garasjen")).toEqual({ kind: "create_task", goal: "rydd garasjen" });
    expect(fastRoute("avbryt jobb task-9")).toEqual({ kind: "cancel_task", task_id: "task-9" });
    expect(fastRoute("hjelp")).toEqual({ kind: "help" });
  });

  it("sender alt annet til intelligent bane", () => {
    expect(fastRoute("hva bør jeg gjøre i dag?")).toBeNull();
    expect(fastRoute("fortell om statusen på livet")).toBeNull();
    expect(fastRoute("")).toBeNull();
  });
});
