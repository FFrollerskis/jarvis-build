import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createVoiceGateway } from "../src/server.ts";
import { VoiceHealth } from "../src/health.ts";

/** D-393 (JARVIS-026): voice `/health` er ikke lenger en konstant «ok». */
const servers: Array<ReturnType<typeof createVoiceGateway>> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

const processor = { processor_id: "t", locality: "local", processor_row_declared: true, processor_terms_status: "NOT_APPLICABLE_LOCAL" } as const;
const stt = (configured: boolean) => ({ name: "stt", processor, available: () => configured, startStream: () => { throw new Error("unused"); } });
const tts = (configured: boolean) => ({ name: "tts", processor, available: () => configured, synthesize: () => { throw new Error("unused"); } });

async function health(sttOk: boolean, ttsOk: boolean, voiceHealth = new VoiceHealth()): Promise<{ status: number; body: { checks: Record<string, string> } }> {
  const server = createVoiceGateway({ core: {} as never, stt: stt(sttOk) as never, tts: tts(ttsOk) as never, health: voiceHealth });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
  return { status: res.status, body: (await res.json()) as { checks: Record<string, string> } };
}

describe("JARVIS-026: voice /health", () => {
  it("STT og TTS konfigurert → 200", async () => {
    const r = await health(true, true);
    expect(r.status).toBe(200);
    expect(r.body.checks).toEqual({ stt: "CONFIGURED", tts: "CONFIGURED" });
  });
  it("STT ikke konfigurert → 503", async () => {
    const r = await health(false, true);
    expect(r.status).toBe(503);
    expect(r.body.checks["stt"]).toBe("NOT_CONFIGURED");
  });
  it("TTS UNAVAILABLE etter 3 sammenhengende feil → 503", async () => {
    const vh = new VoiceHealth();
    for (let i = 0; i < 3; i += 1) vh.recordFailure("tts", "piper_down");
    const r = await health(true, true, vh);
    expect(r.status).toBe(503);
    expect(r.body.checks["tts"]).toBe("UNAVAILABLE");
  });
});
