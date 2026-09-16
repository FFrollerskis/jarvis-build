import { describe, expect, it } from "vitest";
import { computeTargetStage, isWithinQuietHours } from "../src/service.ts";

/**
 * Rene funksjoner (INGEN I/O, `now` injisert - samme "deterministisk,
 * testbar" disiplin som `classifyAttentionBucket()` i
 * `@jarvis/business`). Rent enhets-nivå-bevis, ingen embedded Postgres.
 */
describe("A: isWithinQuietHours - vanlig vindu (start < slutt)", () => {
  it("innenfor vinduet [22,23) UTC returnerer true", () => {
    const ms = Date.UTC(2026, 0, 1, 22, 30);
    expect(isWithinQuietHours(ms, 22, 23)).toBe(true);
  });
  it("utenfor vinduet returnerer false", () => {
    const ms = Date.UTC(2026, 0, 1, 12, 0);
    expect(isWithinQuietHours(ms, 22, 23)).toBe(false);
  });
  it("nøyaktig start-timen er innenfor (inklusiv nedre grense)", () => {
    expect(isWithinQuietHours(Date.UTC(2026, 0, 1, 22, 0), 22, 23)).toBe(true);
  });
  it("nøyaktig slutt-timen er UTENFOR (eksklusiv øvre grense)", () => {
    expect(isWithinQuietHours(Date.UTC(2026, 0, 1, 23, 0), 22, 23)).toBe(false);
  });
});

describe("B: isWithinQuietHours - vindu som krysser midnatt (start > slutt)", () => {
  it("22:00 -> 06:00: kl 23 er innenfor", () => {
    expect(isWithinQuietHours(Date.UTC(2026, 0, 1, 23, 0), 22, 6)).toBe(true);
  });
  it("22:00 -> 06:00: kl 03 (etter midnatt) er innenfor", () => {
    expect(isWithinQuietHours(Date.UTC(2026, 0, 2, 3, 0), 22, 6)).toBe(true);
  });
  it("22:00 -> 06:00: kl 12 (midt på dagen) er UTENFOR", () => {
    expect(isWithinQuietHours(Date.UTC(2026, 0, 1, 12, 0), 22, 6)).toBe(false);
  });
});

describe("C: isWithinQuietHours - eksplisitt deaktivert (aldri 'stille hele døgnet' ved et uhell)", () => {
  it("begge NULL: alltid false", () => {
    expect(isWithinQuietHours(Date.now(), null, null)).toBe(false);
  });
  it("start === slutt (nullbredde-vindu): tolkes som DEAKTIVERT, ikke 'stille hele døgnet'", () => {
    expect(isWithinQuietHours(Date.UTC(2026, 0, 1, 22, 0), 22, 22)).toBe(false);
  });
});

describe("D: computeTargetStage - stille timer holder ALLTID på remember, uansett prioritet/konfidens", () => {
  it("high priority + høy konfidens under stille timer -> remember, IKKE suggest", () => {
    expect(computeTargetStage("high", 0.99, true)).toBe("remember");
  });
});

describe("E: computeTargetStage - deterministiske regler utenfor stille timer", () => {
  it("low priority -> alltid remember", () => {
    expect(computeTargetStage("low", 0.99, false)).toBe("remember");
  });
  it("normal priority -> inform", () => {
    expect(computeTargetStage("normal", 0.9, false)).toBe("inform");
  });
  it("high priority UTEN konfidens -> inform (ikke suggest - konfidens-terskel ikke bevist nådd)", () => {
    expect(computeTargetStage("high", undefined, false)).toBe("inform");
  });
  it("high priority MED konfidens under terskelen (0.75) -> inform", () => {
    expect(computeTargetStage("high", 0.5, false)).toBe("inform");
  });
  it("high priority MED konfidens PÅ terskelen (0.75) -> suggest", () => {
    expect(computeTargetStage("high", 0.75, false)).toBe("suggest");
  });
  it("high priority MED konfidens over terskelen -> suggest", () => {
    expect(computeTargetStage("high", 0.9, false)).toBe("suggest");
  });
  it("ALDRI returnerer act/act_notify/escalate/ignore - kun evaluateCandidate()'s tre mulige verdier", () => {
    for (const priority of ["low", "normal", "high"] as const) {
      for (const confidence of [undefined, 0, 0.5, 0.75, 1]) {
        for (const quiet of [true, false]) {
          const stage = computeTargetStage(priority, confidence, quiet);
          expect(["remember", "inform", "suggest"]).toContain(stage);
        }
      }
    }
  });
});
