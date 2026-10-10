import { afterEach, describe, expect, it, vi } from "vitest";
import { parseKnowledgeClaimWrites } from "../src/knowledge-flags.ts";

/**
 * WP-D1, gjennomgang av PR #325 (funn 8): `JARVIS_KNOWLEDGE_CLAIM_WRITES` slår på skrive-veiene i Q-26 og skal aktiveres av NØYAKTIG verdien `on` - ikke `ON`, ` On `, `on\n`, `true`, `1` eller `yes`
 * (kommentaren, .env.example og runbooken lover «kun on»; main.ts gjorde tidligere trim + toLowerCase).
 */
afterEach(() => vi.restoreAllMocks());

describe("parseKnowledgeClaimWrites", () => {
  it("kun den eksakte verdien «on» slår skriving på", () => {
    expect(parseKnowledgeClaimWrites("on")).toBe(true);
  });

  it.each(["ON", "On", " on", "on ", "on\n", " On ", "true", "1", "yes", "enabled", "onn", "o n"])("«%s» = AV (fail-closed) og en logglinje", (raw) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(parseKnowledgeClaimWrites(raw)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("knowledge_claim_writes_invalid");
  });

  it.each([undefined, "", "off"])("usatt/tom/off = AV uten støy", (raw) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(parseKnowledgeClaimWrites(raw)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});
