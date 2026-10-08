import { describe, expect, it } from "vitest";
import { classifyContentSensitivity } from "@jarvis/model-gateway";
import type { ToolCallRequest, ToolResultMessage } from "@jarvis/provider-adapters";
import { SURFACE_TOOL_GRANTS } from "@jarvis/tool-gateway";
import {
  CLOUD_SCREEN_COVERAGE,
  cloudScreenedExecutor,
  isReviewedBackgroundTool,
  jobWithheldNote,
  screenToolResultForCloud
} from "../src/cloud-tool-screen.ts";

/**
 * D-449 (Q-50, revisjonsfunn): verktøyresultater som sendes videre til skymodellen i en delegert jobb skjermes. `memory.search` returnerer alle aktive treff i minnerommet uten filter (også `special` og
 * helse-rommet); chattens omgivende minne klassifiseres før turen, men et eksplisitt søk midt i en runde ble aldri klassifisert på nytt. Strukturerte merker (rom, sensitivitet) er det eneste
 * pålitelige signalet; e-post/kalender/GitHub har ingen slike merker og er bevisst som chattens verktøyturer (se Q-52).
 */
const at = "2026-10-08T12:00:00.000Z";
const item = (id: string, extra: Record<string, unknown> = {}) => ({
  memory_item_id: id, kind: "item", subject: "tobias.hobby", content: "Liker å gå på ski", type: "semantic", space: "personal", ...extra
});
const memory = (output: unknown, extra: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
  tool_call_id: "c1", tool_name: "search_my_memory", execution_id: "e1", success: true, output, at, source: "memory.search", ...extra
});
const idsOf = (out: unknown): string[] =>
  ((out as { results?: Array<{ memory_item_id: string }> }).results ?? (out as Array<{ memory_item_id: string }>)).map((i) => i.memory_item_id);

describe("D-449: screenToolResultForCloud (minnesøk)", () => {
  it("special-merket treff og treff i helse-rommet holdes tilbake; normal og «sensitive» beholdes", () => {
    const out = screenToolResultForCloud(memory([
      item("a"), item("b", { sensitivity: "sensitive" }), item("c", { sensitivity: "special" }), item("d", { space: "health" }), item("e", { sensitivity: "normal" })
    ]));
    expect(idsOf(out.result.output)).toEqual(["a", "b", "e"]);
    expect(out.withheld).toBe(2);
    expect(out.result.output).toMatchObject({ withheld_count: 2 });
    expect(JSON.stringify(out.result.output)).toContain("holdt tilbake");
  });

  it("treff hvis EGEN tekst er helse/økonomi/hemmelighet holdes tilbake selv om de er merket normal (andre linje)", () => {
    const out = screenToolResultForCloud(memory([
      item("ok"),
      item("helse", { content: "Tobias har fått en ny diagnose" }),
      item("penger", { subject: "tobias.økonomi", content: "Tobias har et lån i banken" }),
      // Bygget ved kjøring (ikke som bokstavelig verdi): gitleaks leser en bokstavelig token-lignende streng som en ekte hemmelighet selv i en testfixtur.
      item("nokkel", { content: `bruk ${["gh", "p_"].join("")}${"a".repeat(36)} mot GitHub` })
    ]));
    expect(idsOf(out.result.output)).toEqual(["ok"]);
    expect(out.withheld).toBe(3);
  });

  it("ukjent form er ikke trygt: manglende/tomt rom, ikke-objekt og en ikke-liste (avkortet forhåndsvisning) holdes tilbake - fail-closed", () => {
    const missingSpace = screenToolResultForCloud(memory([item("a"), { memory_item_id: "b", content: "x" }, item("c", { space: "" }), "tekst", null, 5]));
    expect(idsOf(missingSpace.result.output)).toEqual(["a"]);
    expect(missingSpace.withheld).toBe(5);

    for (const preview of [{ truncated: true, preview: "[{\"memory_item_id\":\"a\",\"sensitivity\":\"spec" }, "en streng", { results: [item("a")] }]) {
      const whole = screenToolResultForCloud(memory(preview));
      expect(whole.withheld, JSON.stringify(preview)).toBe(1);
      expect(JSON.stringify(whole.result.output)).not.toContain("memory_item_id");
      expect(JSON.stringify(whole.result.output)).toContain("holdt tilbake");
    }
  });

  it("ingenting å holde tilbake → samme objekt urørt (ingen omforming av vanlige svar); tom liste, null og feilresultater passerer", () => {
    const clean = memory([item("a"), item("b", { sensitivity: "sensitive" })]);
    const same = screenToolResultForCloud(clean);
    expect(same.result).toBe(clean);
    expect(same.withheld).toBe(0);
    for (const passthrough of [memory([]), memory(null), memory(undefined), memory(null, { success: false, error_category: "TOOL_NOT_FOUND" }), memory([item("c", { sensitivity: "special" })], { success: false })]) {
      const r = screenToolResultForCloud(passthrough);
      expect(r.result).toBe(passthrough);
      expect(r.withheld).toBe(0);
    }
  });

  it("andre verktøy passerer urørt (samme som chattens verktøyturer): e-post, kalender og GitHub med ord som «legetime» og «saldo» - dokumentert avgrensning, se Q-52", () => {
    for (const source of ["email.read_inbox", "calendar.read_events", "github.list_pull_requests", "executive.get_capability_status"]) {
      const result: ToolResultMessage = { ...memory({ items: [{ subject: "Din legetime og saldo", branch: "claude/q49-gjeld-bic" }] }), source, tool_name: "x" };
      const r = screenToolResultForCloud(result, "x");
      expect(r.result, source).toBe(result);
      expect(r.withheld).toBe(0);
    }
  });

  it("mangler executoren `source`, gjenkjennes minnesøket på modellens verktøynavn (search_my_memory), ellers ikke", () => {
    const { source: omittedSource, ...noSource } = memory([item("a", { sensitivity: "special" })]);
    void omittedSource;
    expect(screenToolResultForCloud(noSource, "search_my_memory").withheld).toBe(1);
    expect(screenToolResultForCloud(noSource, "annet_verktoy").withheld).toBe(0);
  });
});

describe("D-449: cloudScreenedExecutor", () => {
  const call = { tool_call_id: "c1", tool_name: "search_my_memory", arguments: { query: "meg" }, provider: "anthropic", model: "m" } as ToolCallRequest;

  it("skjermer hvert resultat, melder kun verktøy og antall (aldri innhold), og gir innerste executor samme kall", async () => {
    const seen: unknown[] = [];
    const inner = { execute: async (c: ToolCallRequest, ctx: unknown) => { seen.push([c, ctx]); return memory([item("a"), item("b", { sensitivity: "special", content: "HEMMELIG-INNHOLD" })]); } };
    const reports: Array<{ tool: string; withheld: number }> = [];
    const wrapped = cloudScreenedExecutor(inner as never, (r) => reports.push(r));
    const ctx = { tenant_id: "t", idempotency_key: "k" };
    const out = await wrapped.execute(call, ctx);
    expect(idsOf(out.output)).toEqual(["a"]);
    expect(seen).toEqual([[call, ctx]]);
    expect(reports).toEqual([{ tool: "memory.search", withheld: 1 }]);
    expect(JSON.stringify(reports)).not.toContain("HEMMELIG");
  });

  it("ingen rapport når intet holdes tilbake; en feilende innerste executor kaster videre uendret", async () => {
    const reports: unknown[] = [];
    const ok = cloudScreenedExecutor({ execute: async () => memory([item("a")]) } as never, (r) => reports.push(r));
    await ok.execute(call, { tenant_id: "t", idempotency_key: "k" });
    expect(reports).toEqual([]);
    const boom = new Error("verktøyet kræsjet");
    await expect(cloudScreenedExecutor({ execute: async () => { throw boom; } } as never).execute(call, { tenant_id: "t", idempotency_key: "k" })).rejects.toBe(boom);
  });
});

describe("D-449: dekning - hvert bakgrunnsverktøy er vurdert for skyruten", () => {
  it("alle verktøy på bakgrunnsflaten er enten skjermet eller bevisst vurdert som chattens verktøyturer; et nytt bakgrunnsverktøy MÅ klassifiseres her først", () => {
    const unreviewed = SURFACE_TOOL_GRANTS.background.filter((g) => !isReviewedBackgroundTool(g.tool_id, g.action)).map((g) => `${g.tool_id}.${g.action}`);
    expect(unreviewed, `nye bakgrunnsverktøy uten vurdering for skyruten: ${unreviewed.join(", ")} - legg dem i CLOUD_SCREEN_COVERAGE (eller skjerm dem) og dokumenter valget i D-449`).toEqual([]);
    // Bare ett verktøy har strukturerte sensitivitetsmerker i dag, og det er skjermet.
    expect(Object.entries(CLOUD_SCREEN_COVERAGE).filter(([, v]) => v === "screened").map(([k]) => k)).toEqual(["memory.search"]);
  });

  it("forfatterkrav: hvert oppført verktøy finnes faktisk på bakgrunnsflaten (ingen døde oppføringer som skjuler en feil)", () => {
    const granted = new Set(SURFACE_TOOL_GRANTS.background.map((g) => `${g.tool_id}.${g.action}`));
    for (const key of Object.keys(CLOUD_SCREEN_COVERAGE)) expect(granted.has(key), key).toBe(true);
  });
});

describe("D-449: merknaden", () => {
  it("jobWithheldNote klassifiseres som uskyldig (leveres som data i samtalen og må aldri låse den lokalt)", () => {
    expect(classifyContentSensitivity({ texts: [jobWithheldNote()] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
  });
});
