import { describe, expect, it } from "vitest";
import { ConcurrencyGate, LlmExtractionAdapter } from "../src/extraction.ts";
import type { IdentityContext } from "@jarvis/contracts";

const identity = { tenant_id: "t", person_id: "p", session_id: "s", memory_space_id: "personal" } as unknown as IdentityContext;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("D-402: ConcurrencyGate", () => {
  it("slipper aldri gjennom mer enn max samtidig, og holder rekkefølgen", async () => {
    const gate = new ConcurrencyGate(1);
    let active = 0, peak = 0;
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => gate.run(async () => {
      active++; peak = Math.max(peak, active);
      await sleep(5);
      order.push(n); active--;
    })));
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("frigjør plassen også når et kall feiler", async () => {
    const gate = new ConcurrencyGate(1);
    await expect(gate.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await gate.run(async () => "ok")).toBe("ok");
  });
});

describe("D-402: LlmExtractionAdapter", () => {
  it("serialiserer uttrekk mot modellen og setter eget tidsavbrudd (180 s)", async () => {
    let active = 0, peak = 0;
    const seen: Array<number | undefined> = [];
    const completer = {
      async complete(input: { timeoutMs?: number }) {
        seen.push(input.timeoutMs);
        active++; peak = Math.max(peak, active);
        await sleep(5);
        active--;
        return { text: "{}", structured_output: { candidates: [] } };
      }
    };
    const adapter = new LlmExtractionAdapter(completer as never);
    await Promise.all([1, 2, 3].map(() => adapter.extract("Jeg liker kaffe", identity, "OWNER_DIRECT" as never)));
    expect(peak).toBe(1);
    expect(seen).toEqual([180_000, 180_000, 180_000]);
  });
});
