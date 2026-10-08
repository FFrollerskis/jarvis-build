import { describe, expect, it } from "vitest";
import { deliverChunkedTextViaTelegram, deliverChunkedTextViaTelegramDetailed } from "../src/daily-brief.ts";

/**
 * D-442: en flerdelt Telegram-tekst kan feile på del 2+ etter at del 1 er sendt. Kallere som vurderer nytt forsøk (ukebriefen) må vite at noe allerede er levert,
 * fordi et nytt forsøk får en ny `generated_at` (= nye idempotensnøkler) og ville sendt del 1 på nytt.
 */
function fakeGateway(okPattern: boolean[]): { gateway: never; calls: Array<{ message: string; key: string }> } {
  const calls: Array<{ message: string; key: string }> = [];
  let i = 0;
  const gateway = {
    execute: async (req: { parameters: { message: string }; idempotency_key: string }) => {
      calls.push({ message: req.parameters.message, key: req.idempotency_key });
      const ok = okPattern[Math.min(i, okPattern.length - 1)] ?? true;
      i += 1;
      return ok ? { ok: true } : { ok: false, reason: "telegram_nede" };
    }
  } as never;
  return { gateway, calls };
}

const identity = { person_id: "p", tenant_id: "t" } as never;
const LONG = "x".repeat(3900 * 2 + 100); // 3 deler

describe("D-442: deliverChunkedTextViaTelegramDetailed", () => {
  it("alt levert: ok og antall deler", async () => {
    const { gateway, calls } = fakeGateway([true]);
    expect(await deliverChunkedTextViaTelegramDetailed(gateway, identity, LONG, "pfx")).toEqual({ ok: true, chunks_sent: 3 });
    expect(calls.map((c) => c.key)).toEqual(["pfx-0", "pfx-3900", "pfx-7800"]);
  });

  it("feiler på del 2: ikke ok, men 1 del ER sendt (kalleren må ikke anta at ingenting ble levert)", async () => {
    const { gateway, calls } = fakeGateway([true, false]);
    expect(await deliverChunkedTextViaTelegramDetailed(gateway, identity, LONG, "pfx")).toEqual({ ok: false, chunks_sent: 1 });
    expect(calls).toHaveLength(2); // del 3 forsøkes ikke
  });

  it("feiler på del 1: ikke ok og 0 deler sendt (nytt forsøk kan ikke duplisere noe)", async () => {
    const { gateway } = fakeGateway([false]);
    expect(await deliverChunkedTextViaTelegramDetailed(gateway, identity, LONG, "pfx")).toEqual({ ok: false, chunks_sent: 0 });
  });

  it("den boolske varianten er uendret (ok-flagget)", async () => {
    expect(await deliverChunkedTextViaTelegram(fakeGateway([true]).gateway, identity, LONG, "pfx")).toBe(true);
    expect(await deliverChunkedTextViaTelegram(fakeGateway([true, false]).gateway, identity, LONG, "pfx")).toBe(false);
  });

  it("tom tekst sender ingenting og er ok (som før)", async () => {
    const { gateway, calls } = fakeGateway([true]);
    expect(await deliverChunkedTextViaTelegramDetailed(gateway, identity, "", "pfx")).toEqual({ ok: true, chunks_sent: 0 });
    expect(calls).toHaveLength(0);
  });
});
