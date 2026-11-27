import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-V2 K7 (JARVIS-098): `apps/web/voice.html` - teknisk logg som ringbuffer (maks 200 linjer), `tts_frame` kun som teller, DOM-oppdatering
 * throttlet, teardown som lukker AudioContext, kontrollert forkasting av oddetall-/ugyldige rammer, og ingen avspilling etter `tts_cancelled`
 * før en ny `speaking`-tilstand. Siden er én stor klassisk <script>; de relevante funksjonene hentes ut via `// @wpv2-begin/end`-markører
 * og KJØRES i `node:vm` mot enkle stubber (ekte atferd, ikke bare tekstsjekk).
 */
const html = readFileSync(fileURLToPath(new URL("../../web/voice.html", import.meta.url)), "utf8");

function region(name: string): string {
  const match = new RegExp(`// @wpv2-begin ${name}\\n([\\s\\S]*?)// @wpv2-end ${name}`).exec(html);
  if (!match) throw new Error(`mangler markør-region ${name} i voice.html`);
  return match[1] as string;
}

interface Sandbox {
  api: Record<string, (...args: never[]) => unknown>;
  timers: Array<() => void>;
  runTimers(): void;
  el: { textContent: string; writes: number };
  calls: string[];
  contexts: FakeAudioContext[];
  buffersCreated: () => number;
  get(name: string): unknown;
}

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  closed = false;
  buffers = 0;
  constructor(readonly options: { sampleRate?: number } | undefined, private readonly registry: FakeAudioContext[]) {
    registry.push(this);
  }
  createBuffer(_channels: number, length: number, rate: number): { duration: number; copyToChannel(): void } {
    this.buffers += 1;
    return { duration: length / rate, copyToChannel: () => undefined };
  }
  createBufferSource(): { buffer: unknown; connect(): void; start(): void; stop(): void; onended: unknown } {
    return { buffer: null, connect: () => undefined, start: () => undefined, stop: () => undefined, onended: null };
  }
  createGain(): { gain: { setValueAtTime(): void; linearRampToValueAtTime(): void }; connect(): void } {
    return { gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined }, connect: () => undefined };
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** Kjører de utpekte regionene i ÉN vm-script (delt leksikalsk scope, som i siden), med stubber for alt annet. */
function load(regions: string[], exportNames: string[]): Sandbox {
  const timers: Array<() => void> = [];
  const calls: string[] = [];
  const contexts: FakeAudioContext[] = [];
  const el = { writes: 0, value: "" } as { writes: number; value: string; textContent: string };
  Object.defineProperty(el, "textContent", {
    get: () => el.value,
    set: (v: string) => {
      el.value = v;
      el.writes += 1;
    }
  });
  const context = vm.createContext({
    techLogEl: el,
    calls,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    document: { body: { dataset: {} } },
    Date,
    String,
    Math,
    Number,
    JSON,
    Uint8Array,
    Int16Array,
    Float32Array,
    atob: (s: string) => globalThis.atob(s),
    AudioContext: function (options?: { sampleRate?: number }) {
      return new FakeAudioContext(options, contexts);
    }
  });
  const prelude = `
    let playbackCtx = null; let nextPlaybackTime = 0; const pendingPlaybackSources = []; let ttsLevel = 0; let ttsSampleRate = 24000;
    let ws = { close() { calls.push("ws.close"); } };
    const setState = (s) => calls.push("state:" + s);
    const liveEl = { textContent: "" }; const statusEl = { textContent: "" }; const enrollPanel = { style: {} };
    const appendTurn = () => undefined; const showMetrics = () => undefined; const showBlockPanel = () => undefined;
    const VOICE_AUTHORITY_DENIAL_TEXT = {}; const applyVoiceCapabilities = () => undefined;
    const vsEls = { test: {} }; const trustPill = { style: {}, className: "", textContent: "" }; const muteBtn = {};
    const startMicCapture = () => calls.push("startMicCapture"); const stopMicCapture = () => calls.push("stopMicCapture");
    const setConnected = () => undefined; const statePill = {}; const tellShell = () => undefined;
    const stopConversationStub = () => calls.push("stopConversation");
  `;
  const exportCode = `globalThis.api = { ${exportNames.join(", ")}, __get: (n) => ({ playbackCtx, ttsSampleRate, ttsGateOpen: typeof ttsGateOpen === "undefined" ? undefined : ttsGateOpen, ttsFramesDropped: typeof ttsFramesDropped === "undefined" ? undefined : ttsFramesDropped, techLines: typeof techLines === "undefined" ? undefined : techLines })[n] };`;
  vm.runInContext([prelude, ...regions, exportCode].join("\n"), context);
  const api = (context as { api: Sandbox["api"] }).api;
  return {
    api,
    timers,
    runTimers: () => {
      const pending = timers.splice(0);
      for (const fn of pending) fn();
    },
    el,
    calls,
    contexts,
    buffersCreated: () => contexts.reduce((n, c) => n + c.buffers, 0),
    get: (name: string) => (api["__get"] as unknown as (n: string) => unknown)(name)
  };
}

const VALID_FRAME = Buffer.alloc(640, 1).toString("base64");
const ODD_FRAME = Buffer.alloc(641, 1).toString("base64");

describe("teknisk logg: ringbuffer, throttlet, aldri lyd-payload", () => {
  const boot = (): Sandbox => load([region("tech-log")], ["techLog", "techLogTtsFrame"]);

  it("maks 200 linjer (eldste forkastes), nyeste øverst; linjer kappes til 400 tegn", () => {
    const sb = boot();
    for (let i = 0; i < 1000; i++) (sb.api["techLog"] as (l: string) => void)(`linje-${i}`);
    sb.runTimers();
    const lines = sb.el.textContent.split("\n");
    expect(lines).toHaveLength(200);
    expect(lines[0]).toContain("linje-999");
    expect(lines[199]).toContain("linje-800");
    expect(sb.el.textContent).not.toContain("linje-799");
    (sb.api["techLog"] as (l: string) => void)("x".repeat(5000));
    sb.runTimers();
    expect((sb.el.textContent.split("\n")[0] as string).length).toBeLessThan(450);
  });

  it("DOM-en skrives høyst én gang per throttle-vindu (1000 linjer = 1 skriving, ikke 1000)", () => {
    const sb = boot();
    for (let i = 0; i < 1000; i++) (sb.api["techLog"] as (l: string) => void)(`l${i}`);
    expect(sb.timers).toHaveLength(1); // ÉN ventende oppdatering
    expect(sb.el.writes).toBe(0);
    sb.runTimers();
    expect(sb.el.writes).toBe(1);
    (sb.api["techLog"] as (l: string) => void)("mer");
    expect(sb.timers).toHaveLength(1); // neste vindu planlegges først ved ny logging
    sb.runTimers();
    expect(sb.el.writes).toBe(2);
  });

  it("tts_frame logges kun som sammenslått teller - én linje for 500 rammer, aldri payload", () => {
    const sb = boot();
    (sb.api["techLog"] as (l: string) => void)("før");
    for (let i = 0; i < 500; i++) (sb.api["techLogTtsFrame"] as (b: number) => void)(960);
    sb.runTimers();
    const lines = sb.el.textContent.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("tts_frame ×500");
    (sb.api["techLog"] as (l: string) => void)("etter");
    for (let i = 0; i < 3; i++) (sb.api["techLogTtsFrame"] as (b: number) => void)(960);
    sb.runTimers();
    expect(sb.el.textContent.split("\n")).toHaveLength(4); // ny serie = ny linje
  });

  it("gammel adferd er borte: ingen `slice(0, 20000)`-omskriving av hele loggen", () => {
    expect(html).not.toContain("techLogEl.textContent.slice(0, 20000)");
  });
});

describe("handleServerMessage + avspilling (kjørt i vm)", () => {
  const boot = (): Sandbox =>
    load(
      [region("tech-log"), region("tts-guard"), region("playback"), region("handle-server-message")],
      ["handleServerMessage", "playTtsFrame", "stopPlayback", "closePlaybackCtx", "decodeTtsFrame"]
    );
  const handle = (sb: Sandbox, msg: Record<string, unknown>): void => (sb.api["handleServerMessage"] as (m: unknown) => void)(msg);

  it("tts_frame: 300 rammer gir ÉN loggelinje (teller), ingen base64 i loggen, og lyden spilles", () => {
    const sb = boot();
    handle(sb, { type: "started", memory_space_authority: "SERVER_VERIFIED", tts_sample_rate: 24000 });
    for (let i = 0; i < 300; i++) handle(sb, { type: "tts_frame", data: VALID_FRAME });
    sb.runTimers();
    expect(sb.el.textContent).not.toContain(VALID_FRAME.slice(0, 40));
    expect(sb.el.textContent).toContain("tts_frame ×300");
    expect(sb.buffersCreated()).toBe(300);
  });

  it("oddetall bytes og ugyldig base64 forkastes kontrollert (teller) - ingen unntak, og neste gyldige ramme spilles", () => {
    const sb = boot();
    handle(sb, { type: "started", memory_space_authority: "SERVER_VERIFIED", tts_sample_rate: 24000 });
    expect(() => handle(sb, { type: "tts_frame", data: ODD_FRAME })).not.toThrow();
    expect(() => handle(sb, { type: "tts_frame", data: "***ikke-base64***" })).not.toThrow();
    expect(() => handle(sb, { type: "tts_frame", data: 42 })).not.toThrow();
    expect(() => handle(sb, { type: "tts_frame" })).not.toThrow();
    expect(sb.buffersCreated()).toBe(0);
    expect(sb.get("ttsFramesDropped")).toBe(4);
    handle(sb, { type: "tts_frame", data: VALID_FRAME });
    expect(sb.buffersCreated()).toBe(1);
  });

  it("ingen frames spilles etter tts_cancelled før en ny speaking-tilstand", () => {
    const sb = boot();
    handle(sb, { type: "started", memory_space_authority: "SERVER_VERIFIED", tts_sample_rate: 24000 });
    handle(sb, { type: "state", state: "speaking" });
    handle(sb, { type: "tts_frame", data: VALID_FRAME });
    expect(sb.buffersCreated()).toBe(1);
    handle(sb, { type: "tts_cancelled", after_ms: 120 });
    handle(sb, { type: "tts_frame", data: VALID_FRAME }); // sen/gammel ramme etter avbruddet
    handle(sb, { type: "tts_frame", data: VALID_FRAME });
    expect(sb.buffersCreated()).toBe(1);
    expect(sb.get("ttsGateOpen")).toBe(false);
    handle(sb, { type: "state", state: "listening" }); // andre tilstander åpner ikke
    handle(sb, { type: "tts_frame", data: VALID_FRAME });
    expect(sb.buffersCreated()).toBe(1);
    handle(sb, { type: "state", state: "speaking" }); // ny tale
    handle(sb, { type: "tts_frame", data: VALID_FRAME });
    expect(sb.buffersCreated()).toBe(2);
  });

  it("en ny `started` åpner avspillingen igjen, og endret samplerate lukker den gamle AudioContext", () => {
    const sb = boot();
    handle(sb, { type: "started", memory_space_authority: "SERVER_VERIFIED", tts_sample_rate: 24000 });
    handle(sb, { type: "tts_frame", data: VALID_FRAME });
    const first = sb.contexts[0] as FakeAudioContext;
    handle(sb, { type: "tts_cancelled" });
    handle(sb, { type: "started", memory_space_authority: "SERVER_VERIFIED", tts_sample_rate: 22050 });
    expect(first.closed).toBe(true);
    handle(sb, { type: "tts_frame", data: VALID_FRAME });
    expect(sb.contexts).toHaveLength(2);
    expect(sb.contexts[1]?.options?.sampleRate).toBe(22050);
  });
});

describe("stopConversation: teardown lukker AudioContext", () => {
  const boot = (): Sandbox =>
    load(
      [region("tech-log"), region("tts-guard"), region("playback"), region("stop-conversation")],
      ["stopConversation", "playTtsFrame"]
    );

  it("etter avspilling lukkes AudioContext og playbackCtx nullstilles; ws lukkes; en andre stopp er ufarlig", () => {
    const sb = boot();
    (sb.api["playTtsFrame"] as (d: string) => void)(VALID_FRAME);
    const ctx = sb.contexts[0] as FakeAudioContext;
    expect(ctx.closed).toBe(false);
    (sb.api["stopConversation"] as () => void)();
    expect(ctx.closed).toBe(true);
    expect(sb.get("playbackCtx")).toBeNull();
    expect(sb.calls).toContain("ws.close");
    expect(() => (sb.api["stopConversation"] as () => void)()).not.toThrow();
  });

  it("gjenåpner avspillingsporten for neste samtale (ingen låst gate etter et avbrudd)", () => {
    const sb = load(
      [region("tech-log"), region("tts-guard"), region("playback"), region("stop-conversation")],
      ["stopConversation", "ttsGateCancelled"]
    );
    (sb.api["ttsGateCancelled"] as () => void)();
    expect(sb.get("ttsGateOpen")).toBe(false);
    (sb.api["stopConversation"] as () => void)();
    expect(sb.get("ttsGateOpen")).toBe(true);
  });
});
