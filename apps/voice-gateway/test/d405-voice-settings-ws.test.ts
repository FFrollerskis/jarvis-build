import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";
import { createVoiceGateway } from "../src/server.ts";
import type { CoreClient } from "../src/session.ts";
import type { SttAdapter, SttStream } from "../src/stt.ts";
import type { TtsAdapter, TtsOptions, TtsPlayback } from "../src/tts.ts";

/** D-405: WebSocket-protokollen for stemmeinnstillinger (ubevist sti - ingen database nødvendig). */
const LOCAL: SpeechProcessorDeclaration = { processor_id: "fake", locality: "local", processor_row_declared: true, processor_terms_status: "NOT_APPLICABLE_LOCAL" };
const stt: SttAdapter = { name: "s", processor: LOCAL, available: () => true, startStream: (): SttStream => ({ pushAudio: () => undefined, end: async () => "", onPartial: () => undefined }) };
const core: CoreClient = { chat: async () => ({ reply: "x", routed: "model", session_id: "s" }) };
const identity = { person_id: "p", tenant_id: "t", device_id: "d", memory_space: "personal" };

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

function tts(calls: Array<{ text: string; options: TtsOptions | undefined }>, capabilities?: TtsAdapter["voiceCapabilities"]): TtsAdapter {
  return {
    name: "cap", processor: LOCAL, available: () => true, ...(capabilities ? { voiceCapabilities: capabilities } : {}),
    synthesize(text: string, options?: TtsOptions): TtsPlayback {
      calls.push({ text, options });
      async function* frames(): AsyncIterable<Buffer> { yield Buffer.from([1, 2, 3, 4]); }
      return { frames: frames(), cancel: () => undefined };
    }
  };
}

async function connect(adapter: TtsAdapter): Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>>; waitFor: (type: string) => Promise<Record<string, unknown>> }> {
  const server = createVoiceGateway({ core, stt, tts: adapter });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  closers.push(() => { ws.close(); server.close(); });
  const messages: Array<Record<string, unknown>> = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise<void>((r) => ws.once("open", () => r()));
  const waitFor = async (type: string): Promise<Record<string, unknown>> => {
    const t0 = Date.now();
    for (;;) {
      const found = messages.find((m) => m["type"] === type);
      if (found) return found;
      if (Date.now() - t0 > 3000) throw new Error(`timeout: ${type} (fikk ${messages.map((m) => m["type"]).join(",")})`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { ws, messages, waitFor };
}

describe("voice_settings over WebSocket", () => {
  it("innstillinger sendt FØR start gjelder fra første svar, og started oppgir hva motoren støtter", async () => {
    const calls: Array<{ text: string; options: TtsOptions | undefined }> = [];
    const { ws, waitFor } = await connect(tts(calls, { speed: true, expressiveness: true, pause: true }));
    ws.send(JSON.stringify({ type: "voice_settings", settings: { speed: 1.3, expressiveness: 0.6, pause_ms: 300 } }));
    ws.send(JSON.stringify({ type: "start", identity }));
    const started = await waitFor("started");
    expect(started["voice_capabilities"]).toEqual({ speed: true, expressiveness: true, pause: true });
    expect(started["voice_settings"]).toEqual({ speed: 1.3, expressiveness: 0.6, pause_ms: 300 });
    ws.send(JSON.stringify({ type: "voice_sample" }));
    await waitFor("tts_frame");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({ speed: 1.3, expressiveness: 0.6, pause_ms: 300 });
    // «Test stemmen» bruker en FAST tekst - klienten kan ikke få Jarvis til å lese opp vilkårlig innhold.
    expect(calls[0]!.text).toContain("stemmen min");
  });

  it("endring midt i sesjonen bekreftes og gjelder neste lyd; ugyldige verdier klemmes", async () => {
    const calls: Array<{ text: string; options: TtsOptions | undefined }> = [];
    const { ws, messages, waitFor } = await connect(tts(calls, { speed: true, expressiveness: false, pause: false }));
    ws.send(JSON.stringify({ type: "start", identity }));
    await waitFor("started");
    ws.send(JSON.stringify({ type: "voice_settings", settings: { speed: 50, expressiveness: "x" } }));
    const ack = await waitFor("voice_settings");
    expect(ack["applied"]).toEqual({ speed: 1.6, expressiveness: 1, pause_ms: 200 });
    expect(ack["capabilities"]).toEqual({ speed: true, expressiveness: false, pause: false });
    ws.send(JSON.stringify({ type: "voice_sample" }));
    await waitFor("tts_frame");
    expect(calls[0]!.options?.speed).toBe(1.6);
    expect(messages.some((m) => m["type"] === "error")).toBe(false);
  });

  it("motor uten støtte oppgir ingen innstillinger (UI-et skrur dem av), og voice_sample før start ignoreres", async () => {
    const calls: Array<{ text: string; options: TtsOptions | undefined }> = [];
    const { ws, messages, waitFor } = await connect(tts(calls));
    ws.send(JSON.stringify({ type: "voice_sample" }));
    ws.send(JSON.stringify({ type: "start", identity }));
    const started = await waitFor("started");
    expect(started["voice_capabilities"]).toEqual({ speed: false, expressiveness: false, pause: false });
    expect(calls).toHaveLength(0);
    expect(messages.filter((m) => m["type"] === "tts_frame")).toHaveLength(0);
  });
});

describe("voice.html (statisk vaktpost - CI har ingen nettleser; ekte nettleser-test kjørt manuelt i D-405)", () => {
  const html = readFileSync(fileURLToPath(new URL("../../web/voice.html", import.meta.url)), "utf8");
  it("sender voice_settings FØR start, slik at første svar bruker eierens innstillinger", () => {
    const settings = html.indexOf('type: "voice_settings", settings: voiceSettings }));\n        ws.send(JSON.stringify({\n          type: "start"');
    expect(settings).toBeGreaterThan(0);
  });
  it("har panelet og knappene, og skrur av innstillinger motoren ikke støtter", () => {
    for (const id of ["vs-speed", "vs-expr", "vs-pause", "vs-test", "vs-reset", "voice-settings-panel"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("applyVoiceCapabilities(msg.voice_capabilities)");
  });
});
