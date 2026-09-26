import { describe, expect, it } from "vitest";
import { EnergyVad } from "../src/vad.ts";
import { wordErrorRate } from "../src/benchmark.ts";
import { rmsEnergy } from "../src/audio.ts";

function frame(amplitude: number): Buffer {
  const buffer = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) {
    buffer.writeInt16LE(amplitude, i * 2);
  }
  return buffer;
}

describe("EnergyVad", () => {
  it("detekterer tale, fortsettelse og end-of-turn etter hangover", () => {
    const vad = new EnergyVad(0.05, 300);
    expect(vad.push(frame(0), 0)).toBe("silence");
    expect(vad.push(frame(8000), 20)).toBe("speech_start");
    expect(vad.push(frame(8000), 40)).toBe("speech");
    expect(vad.push(frame(0), 100)).toBe("silence"); // innenfor hangover
    expect(vad.push(frame(0), 360)).toBe("end_of_turn");
    expect(vad.push(frame(0), 400)).toBe("silence");
    expect(vad.push(frame(8000), 420)).toBe("speech_start");
  });

  it("rmsEnergy skiller stillhet fra tale", () => {
    expect(rmsEnergy(frame(0))).toBe(0);
    expect(rmsEnergy(frame(8000))).toBeGreaterThan(0.2);
  });

  it("D-275 (live NAS-funn: en 4-5 sekunders sammenhengende norsk setning ble splittet i mange spredte speech_start/end_of_turn-fragmenter under den GAMLE 300ms-hangoveren, fordi ~256ms-rammer ga under 1,2 rammes margin mot en helt normal mellomords-pause): default hangover (700ms) overlever en kort, naturlig pause MIDT i en ytring uten å avslutte turen for tidlig, men avslutter fortsatt etter reell stillhet", () => {
    const vad = new EnergyVad(); // default threshold/hangover - EKSAKT det VoiceSession faktisk bruker
    expect(vad.push(frame(8000), 0)).toBe("speech_start");
    expect(vad.push(frame(0), 256)).toBe("silence"); // ~256ms rammepause - ville avsluttet turen under den gamle 300ms-hangoveren
    expect(vad.push(frame(0), 512)).toBe("silence"); // ~512ms - fortsatt innenfor 700ms hangover
    expect(vad.push(frame(8000), 600)).toBe("speech"); // talen fortsetter - turen ble ALDRI avsluttet
    expect(vad.push(frame(0), 1300)).toBe("end_of_turn"); // 700ms reell stillhet etter siste tale - avslutter korrekt
  });
});

describe("WER (benchmark-harnessets målefunksjon)", () => {
  it("beregner standard ordfeilrate", () => {
    expect(wordErrorRate("klokka er tre", "klokka er tre")).toBe(0);
    expect(wordErrorRate("klokka er tre", "klokka er fire")).toBeCloseTo(1 / 3);
    expect(wordErrorRate("slå på lyset i stua", "slå på lyset")).toBeCloseTo(2 / 5);
    expect(wordErrorRate("hei", "")).toBe(1);
    expect(wordErrorRate("Tobias!", "tobias")).toBe(0); // normalisering
  });
});
