import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeBudgetNoteNo, classifyContentSensitivity } from "@jarvis/model-gateway";
import { claudeBudgetRouteNote } from "../src/tool-turn-route.ts";

/**
 * WP-B4 (D-476), fikser etter den uavhengige reviewen - API-laget (notater, VIKTIG-attestering, historikk-stripping, kobling). Gateway-nivå ligger i modules/model-gateway/test/wpb4-review-fixes.test.ts.
 */
const WINDOW_END = Date.UTC(2026, 11, 14, 23, 0, 0); // 15. des 2026 00:00 Oslo
const closed = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  claude_budget: { action: "deny", level: "exhausted", tier: "essential", reason: "exhausted_closed", constraint: "closed", window_end_ms: WINDOW_END, ...extra }
});

afterEach(() => vi.unstubAllEnvs());

describe("L1: merknaden er sann - «lokale modellen» står KUN når en lokal modell svarte", () => {
  const REASONS: Array<[string, string]> = [["deny", "exhausted_closed"], ["defer", "reserve_kept_for_essential"], ["defer", "tight_background_deferred"], ["defer", "spend_unreadable_background_deferred"], ["defer", "exhausted_hard_stop_off_background_deferred"]];

  it("en lokal modell svarte: samme tekst som før («kom fra den lokale modellen»)", () => {
    expect(claudeBudgetRouteNote(closed(), "svaret", { provider: "gemma_local" })).toBe("\n\n(Claude-kreditten: perioden er brukt opp, så dette svaret kom fra den lokale modellen. Kreditten fornyes 15. desember.)");
    expect(claudeBudgetRouteNote(closed(), "jobben", { provider: "local_llm" })).toBe("(Claude-kreditten: perioden er brukt opp, så jobben kom fra den lokale modellen. Kreditten fornyes 15. desember.)");
  });

  it("en ANNEN skymodell svarte (egen preferanseliste, f.eks. openai): teksten sier aldri «lokale» - den sier at svaret ikke kom fra Claude", () => {
    for (const [action, reason] of REASONS) {
      for (const provider of ["openai", "gemini", "gemma_hosted", "noe_ukjent"]) {
        const note = claudeBudgetRouteNote(closed({ action, reason }), "svaret", { provider });
        expect(note, `${reason}/${provider}`).not.toMatch(/lokale/i);
        expect(note, `${reason}/${provider}`).toContain("kom ikke fra Claude");
        expect(note, `${reason}/${provider}`).toMatch(/^\n\n\(Claude-kreditten: /);
      }
    }
    expect(claudeBudgetRouteNote(closed(), "jobben", { provider: "openai" })).toBe("(Claude-kreditten: perioden er brukt opp, så jobben kom ikke fra Claude. Kreditten fornyes 15. desember.)");
  });

  it("ukjent hvem som svarte (ingen leverandør oppgitt): ingenting misvisende - samme nøytrale tekst, aldri «lokale»", () => {
    for (const [action, reason] of REASONS) expect(claudeBudgetRouteNote(closed({ action, reason })), reason).not.toMatch(/lokale/i);
    expect(claudeBudgetRouteNote(closed())).toContain("kom ikke fra Claude");
  });

  it("motoren: standard er lokal (uendret ordlyd), «other» bytter kun kilde-frasen - og tekstene låser seg ikke til lokal modell ved sensitivitetsklassifisering", () => {
    expect(claudeBudgetNoteNo("deny", "exhausted_closed", WINDOW_END)).toContain("kom fra den lokale modellen");
    expect(claudeBudgetNoteNo("deny", "exhausted_closed", WINDOW_END, "svaret", "other")).toContain("kom ikke fra Claude");
    for (const [action, reason] of REASONS) {
      for (const by of ["local", "other"] as const) {
        const text = claudeBudgetNoteNo(action as "deny" | "defer", reason, WINDOW_END, "jobben", by);
        expect(classifyContentSensitivity({ texts: [text] }).sensitivity, text).toBe("PUBLIC_OR_LOW_SENSITIVITY");
        expect(text).not.toMatch(/[()]/); // ingen parenteser inni (stripSystemNotes)
      }
    }
  });
});
