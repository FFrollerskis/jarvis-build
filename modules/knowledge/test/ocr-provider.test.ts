import { describe, expect, it } from "vitest";
import { ModelGatewayVisionExtractor, type ImageInput, type VisionCompleter } from "../src/ocr-provider.ts";
import type { CompleteInput } from "@jarvis/model-gateway";

/**
 * UA-2 P1B-A (D-43 §1/§3): beviser at `ModelGatewayVisionExtractor` (a) ALDRI
 * kaller en leverandør direkte - kun `VisionCompleter.complete()` (den
 * minimale formen av `ModelGateway.complete()`), (b) ALLTID setter
 * `purpose: "VISION"` - routeren, ikke denne modulen, avgjør hvilken
 * provider som faktisk brukes, (c) OCR-"ingen tekst funnet"-markøren
 * normaliseres til en tom streng (IKKE en feil), og (d) `tenant_id`/`task_id`
 * sendes videre slik at eksisterende budsjett-/kostkontroll (D-43 §6) gjelder
 * automatisk for BEGGE tiers (OCR og vision-beskrivelse).
 */
class FakeVisionCompleter implements VisionCompleter {
  calls: CompleteInput[] = [];
  constructor(private readonly reply: (input: CompleteInput) => string) {}
  async complete(input: CompleteInput): Promise<{ text: string }> {
    this.calls.push(input);
    return { text: this.reply(input) };
  }
}

const IMAGE: ImageInput = { media_type: "image/png", data: "aGVsbG8=" };

describe("ModelGatewayVisionExtractor.transcribeText", () => {
  it("A: sender purpose:VISION og BÅDE tekst-prompt og bilde-del i samme melding", async () => {
    const fake = new FakeVisionCompleter(() => "Fakturanummer: 4711");
    const extractor = new ModelGatewayVisionExtractor(fake, "tenant-x", "task-1");
    const text = await extractor.transcribeText(IMAGE);
    expect(text).toBe("Fakturanummer: 4711");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.purpose).toBe("VISION");
    expect(fake.calls[0]?.tenant_id).toBe("tenant-x");
    expect(fake.calls[0]?.task_id).toBe("task-1");
    const content = fake.calls[0]?.request.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "image"]);
  });

  it("B: 'ingen tekst funnet'-markøren normaliseres til TOM STRENG, ikke returnert ordrett", async () => {
    const fake = new FakeVisionCompleter(() => "(ingen tekst funnet)");
    const extractor = new ModelGatewayVisionExtractor(fake, "tenant-x");
    expect(await extractor.transcribeText(IMAGE)).toBe("");
  });

  it("C: task_id er valgfri - utelates fra input når ikke oppgitt (ingen 'task_id: undefined' sendt)", async () => {
    const fake = new FakeVisionCompleter(() => "tekst");
    const extractor = new ModelGatewayVisionExtractor(fake, "tenant-x");
    await extractor.transcribeText(IMAGE);
    expect("task_id" in (fake.calls[0] as object)).toBe(false);
  });

  it("D: svaret trimmes (leverandøren kan legge til whitespace)", async () => {
    const fake = new FakeVisionCompleter(() => "  tekst med mellomrom rundt  \n");
    const extractor = new ModelGatewayVisionExtractor(fake, "tenant-x");
    expect(await extractor.transcribeText(IMAGE)).toBe("tekst med mellomrom rundt");
  });
});

describe("ModelGatewayVisionExtractor.describeImage", () => {
  it("E: bruker en ANNEN prompt enn transcribeText (bevist ved at samme fake kan skille dem på prompt-tekst)", async () => {
    const prompts: string[] = [];
    const fake = new FakeVisionCompleter((input) => {
      const parts = input.request.messages[0]?.content as Array<{ type: string; text?: string }>;
      prompts.push(parts.find((p) => p.type === "text")?.text ?? "");
      return "beskrivelse";
    });
    const extractor = new ModelGatewayVisionExtractor(fake, "tenant-x");
    await extractor.transcribeText(IMAGE);
    await extractor.describeImage(IMAGE);
    expect(prompts[0]).not.toBe(prompts[1]);
    expect(prompts[1]?.toLowerCase()).toContain("beskriv");
  });

  it("F: describeImage returnerer IKKE '(ingen tekst funnet)'-normalisering (den gjelder kun OCR-tier)", async () => {
    const fake = new FakeVisionCompleter(() => "(ingen tekst funnet)");
    const extractor = new ModelGatewayVisionExtractor(fake, "tenant-x");
    expect(await extractor.describeImage(IMAGE)).toBe("(ingen tekst funnet)");
  });
});
