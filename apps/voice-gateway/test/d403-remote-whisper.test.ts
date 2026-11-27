import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPrivateSttHost, RemoteWhisperStt, type SttAdapter } from "../src/stt.ts";
import { selectSpeechAdapters } from "../src/adapter-selection.ts";

/** D-403: egen Whisper-server med lokal fallback. Ingen ekte nettverk utover loopback; ekte server er IKKE testet her (kun protokollen mot en fake). */
const servers: Server[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.close()); vi.restoreAllMocks(); });

async function fake(handler: (req: IncomingMessage, body: Buffer) => { status: number; json?: unknown; headers?: Record<string, string> }): Promise<{ url: string; hits: Array<{ path: string; body: Buffer }> }> {
  const hits: Array<{ path: string; body: Buffer }> = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const body = Buffer.concat(parts);
      hits.push({ path: req.url ?? "", body });
      const r = handler(req, body);
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

function fallbackStt(text = "lokal tekst"): SttAdapter & { calls: number; pushed: number } {
  const f = {
    name: "fake-local", calls: 0, pushed: 0,
    processor: { processor_id: "fake-local", locality: "local" as const, processor_row_declared: true, processor_terms_status: "NOT_APPLICABLE_LOCAL" as const },
    available: () => true,
    startStream() {
      f.calls++;
      return { pushAudio: () => { f.pushed++; }, onPartial: () => undefined, end: async () => text };
    }
  };
  return f as never;
}

async function transcribe(stt: SttAdapter): Promise<string> {
  const s = stt.startStream();
  s.pushAudio(Buffer.alloc(3200, 1));
  s.pushAudio(Buffer.alloc(3200, 2));
  return s.end();
}

describe("isPrivateSttHost", () => {
  it.each(["127.0.0.1", "localhost", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.5", "100.101.102.103", "100.64.0.1", "100.127.255.255", "169.254.1.1", "nas", "[::1]", "fd00::1"])("%s er privat", (h) => {
    expect(isPrivateSttHost(h)).toBe(true);
  });
  it.each(["8.8.8.8", "100.128.0.1", "100.63.0.1", "172.32.0.1", "172.15.0.1", "192.169.0.1", "api.openai.com", "example.com", "999.1.1.1", "2606:4700::1"])("%s er IKKE privat", (h) => {
    expect(isPrivateSttHost(h)).toBe(false);
  });
});

describe("RemoteWhisperStt: konfigurasjon (fail-closed)", () => {
  it("offentlig/ugyldig/manglende adresse => utilgjengelig", () => {
    for (const url of [undefined, "", "   ", "https://api.openai.com", "http://8.8.8.8:8000", "ftp://127.0.0.1", "ikke-en-url"]) {
      expect(new RemoteWhisperStt(url).available()).toBe(false);
    }
    expect(() => new RemoteWhisperStt("https://example.com").startStream()).toThrow("remote_whisper_not_configured");
  });
  it("privat adresse => tilgjengelig og deklarert lokal", () => {
    const s = new RemoteWhisperStt("http://100.101.102.103:8000/");
    expect(s.available()).toBe(true);
    expect(s.processor.locality).toBe("local");
    expect(s.processor.processor_terms_status).toBe("NOT_APPLICABLE_LOCAL");
  });
});

describe("RemoteWhisperStt: protokoll", () => {
  it("sender wav + model/språk/prompt til /v1/audio/transcriptions og returnerer trimmet tekst", async () => {
    const f = await fake(() => ({ status: 200, json: { text: "  hei Charlie  " } }));
    const fb = fallbackStt();
    const stt = new RemoteWhisperStt(f.url, { model: "large-v3-turbo", language: "no", prompt: "Samtale på norsk", fallback: fb });
    expect(await transcribe(stt)).toBe("hei Charlie");
    expect(fb.calls).toBe(0);
    expect(f.hits).toHaveLength(1);
    expect(f.hits[0]!.path).toBe("/v1/audio/transcriptions");
    const body = f.hits[0]!.body.toString("utf8");
    expect(body).toContain('name="model"');
    expect(body).toContain("large-v3-turbo");
    expect(body).toContain('name="language"');
    expect(body).toContain("Samtale på norsk");
    expect(body).toContain("RIFF"); // WAV-header i filen
  });

  it("utelater model når den ikke er satt (serverens standardmodell)", async () => {
    const f = await fake(() => ({ status: 200, json: { text: "ok" } }));
    await transcribe(new RemoteWhisperStt(f.url, { fallback: fallbackStt() }));
    expect(f.hits[0]!.body.toString("utf8")).not.toContain('name="model"');
  });
});

describe("RemoteWhisperStt: fallback til lokal whisper", () => {
  it("HTTP-feil => samme lyd kjøres gjennom fallback, og serveren hoppes over i cooldown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = await fake(() => ({ status: 500 }));
    const fb = fallbackStt("fra nas");
    let t = 1_000;
    const stt = new RemoteWhisperStt(f.url, { fallback: fb, cooldownMs: 30_000, now: () => t });
    expect(await transcribe(stt)).toBe("fra nas");
    expect(fb.pushed).toBe(2); // begge lydrammene ble spilt av på nytt
    expect(f.hits).toHaveLength(1);
    t += 5_000;
    expect(await transcribe(stt)).toBe("fra nas");
    expect(f.hits).toHaveLength(1); // cooldown: ikke ventet på serveren igjen
    t += 30_000;
    expect(await transcribe(stt)).toBe("fra nas");
    expect(f.hits).toHaveLength(2); // cooldown utløpt: prøver serveren igjen
  });

  it("tidsavbrudd => fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const server = createServer(() => { /* svarer aldri */ });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const fb = fallbackStt("etter timeout");
    const stt = new RemoteWhisperStt(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { timeoutMs: 150, fallback: fb });
    expect(await transcribe(stt)).toBe("etter timeout");
  });

  it("ugyldig svar (mangler text) => fallback; server nede (tilkobling avvist) => fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = await fake(() => ({ status: 200, json: { noe: "annet" } }));
    expect(await transcribe(new RemoteWhisperStt(f.url, { fallback: fallbackStt("a") }))).toBe("a");
    expect(await transcribe(new RemoteWhisperStt("http://127.0.0.1:1", { fallback: fallbackStt("b") }))).toBe("b");
  });

  it("følger ALDRI redirect (kan ikke lures ut av det private nettet) => fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const target = await fake(() => ({ status: 200, json: { text: "skal aldri hentes" } }));
    const f = await fake(() => ({ status: 307, headers: { location: `${target.url}/v1/audio/transcriptions` } }));
    expect(await transcribe(new RemoteWhisperStt(f.url, { fallback: fallbackStt("trygg") }))).toBe("trygg");
    expect(target.hits).toHaveLength(0);
  });

  it("uten tilgjengelig fallback feiler det høylytt (aldri en stille tom transkripsjon)", async () => {
    await expect(transcribe(new RemoteWhisperStt("http://127.0.0.1:1"))).rejects.toThrow("remote_whisper_failed_no_fallback");
  });
});

describe("selectSpeechAdapters: prioritet", () => {
  const mk = (name: string, ok: boolean) => ({ name, available: () => ok, startStream: () => { throw new Error("x"); }, processor: {} }) as never;
  const tts = { name: "tts", available: () => true } as never;
  it("remote velges før OpenAI og lokal når den er tilgjengelig", () => {
    const { stt } = selectSpeechAdapters({ openAiStt: mk("openai", true), remoteWhisperStt: mk("remote", true), localWhisperStt: mk("local", true), openAiTts: tts, localPiperTts: tts }, {});
    expect(stt.name).toBe("remote");
  });
  it("utilgjengelig remote => uendret rekkefølge (OpenAI, så lokal)", () => {
    const a = selectSpeechAdapters({ openAiStt: mk("openai", true), remoteWhisperStt: mk("remote", false), localWhisperStt: mk("local", true), openAiTts: tts, localPiperTts: tts }, {});
    expect(a.stt.name).toBe("openai");
    const b = selectSpeechAdapters({ openAiStt: mk("openai", false), remoteWhisperStt: mk("remote", false), localWhisperStt: mk("local", true), openAiTts: tts, localPiperTts: tts }, {});
    expect(b.stt.name).toBe("local");
  });
});

describe("§22: rå lyd persisteres aldri", () => {
  it("stt.ts inneholder fortsatt ingen disk-skrive-API", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/stt.ts"), "utf8");
    expect(src).not.toMatch(/writeFile|appendFile|createWriteStream/);
  });
});
