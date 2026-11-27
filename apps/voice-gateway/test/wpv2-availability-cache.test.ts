import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessSlots } from "../src/limits.ts";
import { AVAILABILITY_CACHE_MS, AvailabilityCache } from "../src/local-binary.ts";
import { LocalWhisperStt } from "../src/stt.ts";
import { LocalPiperTts } from "../src/tts.ts";

/**
 * WP-V2 FIX-7 (F7): `available()` gjorde synkron `statSync`/`accessSync` ved HVERT kall (`/health` og hver TTS-chunk via `usableReserve`). Mot en hengende
 * nettmontering (NAS) kan det fryse hele event-loopen. Nå caches svaret i `AVAILABILITY_CACHE_MS` (5 s) per adapter, med injiserbar klokke.
 */
async function fixture(): Promise<{ bin: string; model: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wpv2-avail-"));
  const bin = join(dir, "engine");
  const model = join(dir, "model.bin");
  await writeFile(bin, "#!/bin/sh\nexit 0\n");
  await chmod(bin, 0o755);
  await writeFile(model, "x");
  return { bin, model };
}

describe("AvailabilityCache", () => {
  it("probes ÉN gang per TTL (>= TTL = på nytt), og når klokken går bakover", () => {
    let probes = 0;
    let t = 10_000;
    const cache = new AvailabilityCache(() => {
      probes += 1;
      return probes === 1 ? undefined : "binary_not_executable";
    }, 5_000, () => t);
    expect(cache.get()).toBeUndefined();
    for (let i = 0; i < 100; i++) expect(cache.get()).toBeUndefined();
    expect(probes).toBe(1); // hundre kall = én probe
    t += 4_999;
    expect(cache.get()).toBeUndefined();
    expect(probes).toBe(1);
    t += 1; // nøyaktig TTL
    expect(cache.get()).toBe("binary_not_executable");
    expect(probes).toBe(2);
    t -= 60_000; // klokken hoppet bakover: aldri et evig cachet svar
    cache.get();
    expect(probes).toBe(3);
  });

  it("standard-TTL er 5 s", () => {
    expect(AVAILABILITY_CACHE_MS).toBe(5_000);
  });
});

describe("FIX-7: lokale adaptere cacher tilgjengelighetssjekken (synkron stat/access ved hvert kall frøs event-loopen ved hengende montering)", () => {
  it("piper: en endring i filsystemet synes først etter TTL - både tap og gjenoppretting (negativt svar caches også)", async () => {
    const { bin, model } = await fixture();
    let t = 1_000_000;
    const tts = new LocalPiperTts(bin, model, undefined, new ProcessSlots(2, 500), 60_000, () => t);
    expect(tts.available()).toBe(true);
    await chmod(bin, 0o644); // binæren mister kjørerett
    expect(tts.available()).toBe(true); // cachet
    expect(tts.status?.()["unavailable_reason"]).toBeUndefined(); // status går gjennom samme cache
    t += 4_999;
    expect(tts.available()).toBe(true);
    t += 2; // 5 s er gått
    expect(tts.available()).toBe(false);
    expect(tts.status?.()["unavailable_reason"]).toBe("binary_not_executable");
    await chmod(bin, 0o755);
    expect(tts.available()).toBe(false); // det negative svaret er cachet i ≤ 5 s
    t += 5_001;
    expect(tts.available()).toBe(true);
  });

  it("whisper: samme regel", async () => {
    const { bin, model } = await fixture();
    let t = 5_000_000;
    const stt = new LocalWhisperStt(bin, model, 16000, "no", 1, undefined, new ProcessSlots(2, 500), 60_000, () => t);
    expect(stt.available()).toBe(true);
    await chmod(bin, 0o644);
    expect(stt.available()).toBe(true);
    t += 5_000;
    expect(stt.available()).toBe(false);
    expect(stt.status?.()["unavailable_reason"]).toBe("binary_not_executable");
    await chmod(bin, 0o755);
    t += 5_000;
    expect(stt.available()).toBe(true);
  });

  it("uten injisert klokke brukes systemklokken (en fersk adapter ser filsystemet som det er nå)", async () => {
    const { bin, model } = await fixture();
    await chmod(bin, 0o644);
    expect(new LocalPiperTts(bin, model).available()).toBe(false);
    await chmod(bin, 0o755);
    expect(new LocalPiperTts(bin, model).available()).toBe(true);
  });
});
