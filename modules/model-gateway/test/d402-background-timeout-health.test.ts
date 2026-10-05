import { describe, expect, it } from "vitest";
import { isBackgroundTimeout } from "../src/model-gateway.ts";

describe("D-402: bakgrunnstidsavbrudd straffer ikke leverandørhelsen", () => {
  it("timeout i EXTRACT/SUMMARIZE/QUICK_CLASSIFICATION teller ikke", () => {
    for (const p of ["EXTRACT", "SUMMARIZE", "QUICK_CLASSIFICATION"]) expect(isBackgroundTimeout(p, "timeout")).toBe(true);
  });
  it("timeout i CHAT (eller uten formål) teller fortsatt", () => {
    expect(isBackgroundTimeout("CHAT", "timeout")).toBe(false);
    expect(isBackgroundTimeout(undefined, "timeout")).toBe(false);
  });
  it("nettverks-/server-feil i bakgrunnsformål teller fortsatt (ekte nedetid)", () => {
    expect(isBackgroundTimeout("EXTRACT", "network")).toBe(false);
    expect(isBackgroundTimeout("EXTRACT", "server")).toBe(false);
  });
});
