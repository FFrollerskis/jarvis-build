import { describe, expect, it } from "vitest";
import { baseIdentity as base, buildEngine as build } from "./support/fast-path-harness.ts";

/**
 * WP-D4 (gjennomgang av PR #315, M1) mot samtalemotoren og PRODUKSJONENS verktøyflate (`support/fast-path-harness.ts`): ordinær prat som nevner «Kimi», «Hermes», «fallback» eller «hvilke modeller» skal IKKE ende på skyruten (Sonnet,
 * D-431) fordi utvalget tilfeldig valgte `executive.*`. Legitime AI Mesh-spørsmål skal fortsatt få verktøyet - og dermed skyruten, som før. Rutingen for alt annet er uendret (d431/d449/d450-testene).
 */
const LOCAL = ["gemma_local", "gemma_hosted"];
const MEMORY_ONLY = new Set(["search_my_memory", "suggest_memory"]);

describe("M1: ordinær prat med AI-lignende ord forblir lokal", () => {
  const ORDINARY = [
    "Jeg møtte Kimi i går og vi spiste middag",
    "Hermes er en fin lommebok-merkevare",
    "Hva er en fallback i JavaScript?",
    "hvilke modeller av bil bør jeg kjøpe",
    "hva er en fallback-plan for ferien",
    "Kimi har bursdag på lørdag, hva kan jeg gi henne?",
    "Hermes-vesken til mamma er av skinn",
    "Hva betyr fallback på norsk?",
    "hvilken modell er best til å bygge modellfly?",
    "Kjenner du Hermes, den greske guden?",
    "Fallback-planen for turen er at vi tar bussen hvis det regner",
    "Kimi og jeg gikk en lang tur i skogen",
    "Er Hermes en gud eller en helt?",
    "Har du møtt Kimi før?"
  ];

  it.each(ORDINARY)("«%s» → lokal modell, kun minne-reserven som verktøy, ingen skymodell", async (text) => {
    const t = build({});
    await t.engine.handle(base, text);
    const call = t.captured[0]!;
    expect(call.providerPreference, text).toEqual(LOCAL);
    expect(call.request.model, text).toBeUndefined();
    expect(t.toolNamesSeen[0]?.every((name) => MEMORY_ONLY.has(name)), JSON.stringify(t.toolNamesSeen[0])).toBe(true);
    expect(t.toolNamesSeen[0]?.some((name) => name.startsWith("executive__")), text).toBe(false);
  });
});

describe("M1: legitime AI Mesh-spørsmål får verktøyet og skyruten som før", () => {
  const LEGIT = ["hvordan står AI-mesh-en?", "er Kimi oppe?", "hvilke leverandører er konfigurert?", "hvilken modell er reserve?", "hva er fallback-kjeden?", "Er Hermes nede?"];

  it.each(LEGIT)("«%s» → executive.get_ai_mesh_status er med, og turen går til verktøyruten", async (text) => {
    const t = build({});
    await t.engine.handle(base, text);
    expect(t.toolNamesSeen[0], text).toContain("executive__get_ai_mesh_status");
    expect(t.captured[0]?.providerPreference, text).toEqual(["anthropic"]);
    expect(t.captured[0]?.request.model, text).toBe("claude-sonnet-5-5");
  });
});
