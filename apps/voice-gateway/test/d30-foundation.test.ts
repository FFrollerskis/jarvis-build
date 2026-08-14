import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentenceChunker } from "../src/chunker.ts";
import { VoiceHealth } from "../src/health.ts";
import { summarizeLatency } from "../src/benchmark.ts";
import { HttpCoreClient } from "../src/server.ts";
import {
  UtteranceJournal,
  VoiceSession,
  type CoreClient,
  type CoreReply,
  type CoreStreamEvent,
  type SessionEvents,
  type TurnMetrics,
  type VoiceIdentity,
  type VoiceState
} from "../src/session.ts";
import type { SttAdapter, SttStream } from "../src/stt.ts";
import type { TtsAdapter, TtsPlayback } from "../src/tts.ts";

/**
 * BO-12 D-30 foundation (§45): state machine, chunking, barge-in med
 * generation-abort, stale-audio-vern, STT-/TTS-feil, tool-activity,
 * provider-override og personvern - alt deterministisk uten nettverk.
 */

const identity: VoiceIdentity = {
  person_id: "person-tobias",
  tenant_id: "tenant-personal",
  device_id: "dev-voice",
  memory_space: "personal",
  channel: "voice"
};

/** STT-fake: fast transkript, valgfri feil. */
function fixedStt(text: string, fail = false): SttAdapter {
  return {
    name: "fixed-stt",
    available: () => true,
    startStream(): SttStream {
      return {
        pushAudio: () => undefined,
        end: async () => {
          if (fail) {
            throw new Error("stt_provider_500");
          }
          return text;
        },
        onPartial: () => undefined
      };
    }
  };
}

/** TTS-fake som merker rammer per synthesize-kall - gjør stale audio målbart. */
function taggedTts(msPerFrame = 5, framesPerChunk = 4): { adapter: TtsAdapter; synthCalls: string[] } {
  const synthCalls: string[] = [];
  return {
    synthCalls,
    adapter: {
      name: "tagged-tts",
      available: () => true,
      synthesize(text: string): TtsPlayback {
        synthCalls.push(text);
        const tag = `S${synthCalls.length}`;
        let cancelled = false;
        async function* frames(): AsyncIterable<Buffer> {
          for (let i = 0; i < framesPerChunk; i++) {
            if (cancelled) {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, msPerFrame));
            if (cancelled) {
              return;
            }
            yield Buffer.from(`${tag}-f${i}`);
          }
        }
        return { frames: frames(), cancel: () => (cancelled = true) };
      }
    }
  };
}

function events(): {
  handlers: SessionEvents;
  states: VoiceState[];
  frames: string[];
  errors: string[];
  activities: string[];
  metrics: TurnMetrics[];
  replies: CoreReply[];
} {
  const states: VoiceState[] = [];
  const frames: string[] = [];
  const errors: string[] = [];
  const activities: string[] = [];
  const metrics: TurnMetrics[] = [];
  const replies: CoreReply[] = [];
  return {
    states,
    frames,
    errors,
    activities,
    metrics,
    replies,
    handlers: {
      onState: (s) => states.push(s),
      onPartial: () => undefined,
      onFinal: () => undefined,
      onReply: (r) => replies.push(r),
      onTtsFrame: (f) => frames.push(f.toString("utf8")),
      onTtsCancelled: () => undefined,
      onMetrics: (m) => metrics.push(m),
      onError: (e) => errors.push(e),
      onToolActivity: (a) => activities.push(a)
    }
  };
}

/** Lydrammer: tale (energi over terskel) og stillhet, med kontrollert klokke. */
function speech(): Buffer {
  const b = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) {
    b.writeInt16LE(9000, i * 2);
  }
  return b;
}
const silence = (): Buffer => Buffer.alloc(640);

async function waitUntil(predicate: () => boolean, timeoutMs = 4000, label = "condition"): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitUntil timeout: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(session: VoiceSession, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (session.currentState() !== "listening") {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`settle timeout in state ${session.currentState()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Kjører én komplett taletur via VAD-banen (kontrollert klokke). */
async function runVoiceTurn(session: VoiceSession): Promise<void> {
  let t = 1000;
  session.pushAudio(speech(), t);
  session.pushAudio(speech(), (t += 50));
  session.pushAudio(silence(), (t += 400)); // > hangover → end_of_turn
  await new Promise((resolve) => setTimeout(resolve, 20));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SentenceChunker (§13): trygg chunking av streamet tekst", () => {
  function collect(): { chunks: string[]; chunker: SentenceChunker } {
    const chunks: string[] = [];
    return { chunks, chunker: new SentenceChunker((c) => chunks.push(c), { minChars: 10, maxChars: 60 }) };
  }

  it("chunker på setningsgrense, aldri midt i et ord", () => {
    const { chunks, chunker } = collect();
    chunker.push("Du har tre møter i dag. Det første");
    chunker.push(" er klokka ni.");
    chunker.flush();
    expect(chunks).toEqual(["Du har tre møter i dag.", "Det første er klokka ni."]);
  });

  it("splitter ikke klokkeslett som '18.30'", () => {
    const { chunks, chunker } = collect();
    chunker.push("Møtet starter 18.30 i morgen tidlig. Neste sak.");
    chunker.flush();
    expect(chunks[0]).toBe("Møtet starter 18.30 i morgen tidlig.");
  });

  it("overlang tekst uten grense kuttes på ordgrense", () => {
    const { chunks, chunker } = collect();
    chunker.push("ord ".repeat(30).trim());
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.endsWith("or")).toBe(false); // aldri midt i "ord"
    }
  });

  it("flush sender resten; discard forkaster (§16)", () => {
    const { chunks, chunker } = collect();
    chunker.push("halvveis uten slutt");
    chunker.discard();
    chunker.flush();
    expect(chunks).toEqual([]);
  });
});

describe("Streaming voice-tur (§12-§13): tokens → chunker → TTS mens generering pågår", () => {
  it("TTS starter på første setning FØR genereringen er ferdig; tool_activity er kort norsk status (§26)", async () => {
    const ttsStartedAt: number[] = [];
    const tts = taggedTts();
    const origSynth = tts.adapter.synthesize.bind(tts.adapter);
    tts.adapter.synthesize = (text: string) => {
      ttsStartedAt.push(Date.now());
      return origSynth(text);
    };
    let generationDoneAt = 0;
    const core: CoreClient = {
      chat: async () => {
        throw new Error("skal ikke brukes");
      },
      chatStream: async (_id, _msg, onEvent) => {
        onEvent({ type: "tool", tool_name: "read_calendar_today" });
        onEvent({ type: "token", text: "Du har tre møter i dag. " });
        await new Promise((resolve) => setTimeout(resolve, 60));
        onEvent({ type: "token", text: "Det første er klokka ni." });
        generationDoneAt = Date.now();
        return { reply: "Du har tre møter i dag. Det første er klokka ni.", routed: "model", session_id: "s1" };
      }
    };
    const ev = events();
    const session = new VoiceSession(identity, core, fixedStt("hva skjer i dag"), tts.adapter, ev.handlers);
    await runVoiceTurn(session);
    await waitUntil(() => ev.metrics.length === 1, 4000, "tur ferdig");

    expect(ev.activities).toEqual(["Sjekker kalenderen din …"]);
    expect(tts.synthCalls[0]).toBe("Du har tre møter i dag.");
    // Første TTS-kall skjedde FØR genereringen var ferdig (lav opplevd latens):
    expect(ttsStartedAt[0]).toBeLessThan(generationDoneAt);
    // Metrics-kjeden (§19) er komplett:
    const m = ev.metrics[0] as TurnMetrics;
    expect(m.t_final_transcript).toBeGreaterThan(0);
    expect(m.t_model_first_token).toBeGreaterThan(0);
    expect(m.t_first_tts_request).toBeGreaterThan(0);
    expect(m.t_tts_first_frame).toBeGreaterThan(0);
    expect(m.end_of_speech_to_first_audio_ms).toBeGreaterThanOrEqual(0);
    expect(m.tts_chars).toBeGreaterThan(0);
  });
});

describe("Barge-in (§15-§17): stopp lyd, tøm kø, abort generering, aldri stale audio", () => {
  it("brukertale under avspilling aborterer modellgenereringen og ingen gammel lyd kommer etter ny tur", async () => {
    const tts = taggedTts(8, 40); // lang avspilling
    let firstTurnAborted = false;
    let call = 0;
    const core: CoreClient = {
      chat: async () => {
        throw new Error("skal ikke brukes");
      },
      chatStream: async (_id, _msg, onEvent, signal) => {
        call += 1;
        if (call === 1) {
          onEvent({ type: "token", text: "Dette er starten på et veldig langt svar. " });
          // Fortsett "generering" til abort:
          for (let i = 0; i < 200; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (signal?.aborted) {
              firstTurnAborted = true;
              const err = new Error("aborted");
              err.name = "AbortError";
              throw err;
            }
            onEvent({ type: "token", text: `del ${i} av svaret fortsetter her. ` });
          }
          return { reply: "langt svar", routed: "model", session_id: "s1" };
        }
        onEvent({ type: "token", text: "Nytt kort svar." });
        return { reply: "Nytt kort svar.", routed: "model", session_id: "s1" };
      }
    };
    const ev = events();
    const session = new VoiceSession(identity, core, fixedStt("fortell meg alt"), tts.adapter, ev.handlers);

    await runVoiceTurn(session);
    // Vent til første tur faktisk taler:
    const started = Date.now();
    while (ev.frames.length === 0 && Date.now() - started < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(session.currentState()).toBe("speaking");

    // BARGE-IN: brukeren begynner å snakke (ny VAD-tur) og fullfører ny tur:
    let t = 10_000;
    session.pushAudio(speech(), t);
    session.pushAudio(speech(), (t += 50));
    session.pushAudio(silence(), (t += 400));
    // Vent til NY tur er fullført (svar levert) - først da er alt observerbart:
    await waitUntil(() => ev.replies.some((r) => r.reply === "Nytt kort svar."), 6000, "ny tur ferdig");
    await settle(session, 5000);

    // §15.3: modellgenereringen ble abortert upstream:
    expect(firstTurnAborted).toBe(true);
    // §23: interrupted-state ble eksponert:
    expect(ev.states).toContain("interrupted");
    // §16: ingen stale audio - etter første ramme fra ny tur (S-kall etter barge-in)
    // kommer ALDRI rammer fra tidligere synthesize-kall:
    const firstNewIdx = ev.frames.findIndex((f) => f.startsWith(`S${tts.synthCalls.length}-`));
    expect(firstNewIdx).toBeGreaterThanOrEqual(0);
    const oldTags = new Set(tts.synthCalls.slice(0, -1).map((_, i) => `S${i + 1}`));
    for (const frame of ev.frames.slice(firstNewIdx)) {
      expect(oldTags.has(frame.split("-")[0] as string)).toBe(false);
    }
    // Avbrutt tur er markert cancelled i metrics (§19) og turen er journalført (§17):
    expect(ev.metrics.some((m) => m.cancelled)).toBe(true);
    // Ny tur ga svar:
    expect(ev.replies.at(-1)?.reply).toBe("Nytt kort svar.");
  });
});

describe("Feilbaner (§35-§36): STT-/TTS-feil er trygge og normaliserte", () => {
  it("STT-feil → normalisert 'stt_error', ALDRI modellkjøring (§35)", async () => {
    let coreCalled = false;
    const core: CoreClient = {
      chat: async () => {
        coreCalled = true;
        return { reply: "x", routed: "model", session_id: "s" };
      }
    };
    const ev = events();
    const health = new VoiceHealth();
    const session = new VoiceSession(
      identity, core, fixedStt("", true), taggedTts().adapter, ev.handlers,
      new UtteranceJournal(), undefined, undefined, undefined, undefined, health
    );
    await runVoiceTurn(session);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ev.errors).toContain("stt_error");
    expect(coreCalled).toBe(false);
    expect(health.state("stt", true)).toBe("DEGRADED");
  });

  it("tom transkript (støy/ingen tale) → ingen modellkjøring (§35)", async () => {
    let coreCalled = false;
    const core: CoreClient = {
      chat: async () => {
        coreCalled = true;
        return { reply: "x", routed: "model", session_id: "s" };
      }
    };
    const ev = events();
    const session = new VoiceSession(identity, core, fixedStt(""), taggedTts().adapter, ev.handlers);
    await runVoiceTurn(session);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(coreCalled).toBe(false);
    expect(ev.errors).toEqual([]);
  });

  it("kun støy under terskel → ingen tur i det hele tatt (§28-fixture: støy/ingen tale)", async () => {
    let coreCalled = false;
    const core: CoreClient = {
      chat: async () => {
        coreCalled = true;
        return { reply: "x", routed: "model", session_id: "s" };
      }
    };
    const ev = events();
    const session = new VoiceSession(identity, core, fixedStt("skal aldri brukes"), taggedTts().adapter, ev.handlers);
    let t = 1000;
    for (let i = 0; i < 20; i++) {
      session.pushAudio(silence(), (t += 20)); // stillhet/støy under terskel
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(coreCalled).toBe(false);
    expect(ev.metrics).toEqual([]);
  });

  it("pause midt i setning (< hangover) bryter IKKE turen (§28-fixture)", async () => {
    const seen: string[] = [];
    const stt: SttAdapter = {
      name: "recording-stt",
      available: () => true,
      startStream(): SttStream {
        return {
          pushAudio: () => {
            seen.push("frame");
          },
          end: async () => "hei jarvis hva skjer",
          onPartial: () => undefined
        };
      }
    };
    const core: CoreClient = {
      chat: async () => ({ reply: "Alt vel.", routed: "model", session_id: "s" })
    };
    const ev = events();
    const session = new VoiceSession(identity, core, stt, taggedTts().adapter, ev.handlers);
    let t = 1000;
    session.pushAudio(speech(), t);
    session.pushAudio(silence(), (t += 100)); // kort pause < hangover (300ms)
    session.pushAudio(speech(), (t += 100)); // fortsetter samme tur
    session.pushAudio(silence(), (t += 400)); // nå avsluttes turen
    await waitUntil(() => ev.replies.length === 1, 4000, "tur ferdig");
    await waitUntil(() => ev.metrics.length >= 1, 4000, "metrics levert");
    expect(ev.metrics).toHaveLength(1); // ÉN tur, ikke to
    expect(ev.replies).toHaveLength(1);
  });

  it("D-30 hardening §3C: provider/model-feil FØR output → normalisert 'core_error', ingen crash, neste tur fungerer, ingen secrets", async () => {
    let call = 0;
    const core: CoreClient = {
      chat: async () => {
        throw new Error("skal ikke brukes");
      },
      chatStream: async () => {
        call += 1;
        if (call === 1) {
          // Fault injection: provider dør FØR noe token er sendt (aldri live-fremprovosert).
          throw new Error("provider_unavailable secret-token-abc123-should-never-leak");
        }
        return { reply: "Fungerer igjen.", routed: "model", session_id: "s1" };
      }
    };
    const ev = events();
    const session = new VoiceSession(identity, core, fixedStt("hva skjer"), taggedTts().adapter, ev.handlers);
    await runVoiceTurn(session);
    await waitUntil(() => ev.errors.length > 0, 3000, "core_error mottatt");
    expect(ev.errors).toContain("core_error");
    // §27: rå feilmelding/secrets krysser ALDRI trust-grensen til klienten:
    expect(ev.errors.every((e) => !e.includes("secret-token"))).toBe(true);
    expect(session.currentState()).toBe("listening"); // ingen zombie - state kom seg videre til klar-for-ny-tur

    // Neste tur fungerer normalt (ingen crash av sesjonen):
    await runVoiceTurn(session);
    await waitUntil(() => ev.replies.some((r) => r.reply === "Fungerer igjen."), 3000, "neste tur ferdig");
    await settle(session);
    expect(ev.replies.at(-1)?.reply).toBe("Fungerer igjen.");
  });

  it("D-30 hardening §3D: klientdisconnect midt i tur aborterer upstream - ingen zombie-generering", async () => {
    let aborted = false;
    let coreReturned = false;
    const core: CoreClient = {
      chat: async () => {
        throw new Error("skal ikke brukes");
      },
      chatStream: async (_id, _msg, onEvent, signal) => {
        onEvent({ type: "token", text: "Begynner på svaret. " });
        for (let i = 0; i < 200; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (signal?.aborted) {
            aborted = true;
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
        }
        coreReturned = true;
        return { reply: "skal aldri nås", routed: "model", session_id: "s1" };
      }
    };
    const ev = events();
    const session = new VoiceSession(identity, core, fixedStt("fortell noe langt"), taggedTts(8, 40).adapter, ev.handlers);
    await runVoiceTurn(session);
    // Vent til turen faktisk er i gang (thinking/speaking) FØR frakobling:
    await waitUntil(() => session.currentState() !== "listening", 3000, "tur startet");

    session.disconnect(); // simulerer WS 'close' midt i turen
    await waitUntil(() => aborted, 3000, "upstream abortert");

    expect(aborted).toBe(true);
    expect(coreReturned).toBe(false); // aldri fullført - ingen zombie-svar produsert
    // Ny tur etter disconnect fungerer fortsatt (sesjonen er ikke ødelagt):
    let call2 = 0;
    const core2: CoreClient = {
      chat: async () => {
        throw new Error("skal ikke brukes");
      },
      chatStream: async (_id, _msg, onEvent) => {
        call2 += 1;
        onEvent({ type: "token", text: "Ny tur OK." });
        return { reply: "Ny tur OK.", routed: "model", session_id: "s1" };
      }
    };
    const session2 = new VoiceSession(identity, core2, fixedStt("hei igjen"), taggedTts().adapter, ev.handlers);
    await runVoiceTurn(session2);
    await waitUntil(() => call2 === 1, 3000, "ny sesjon fungerer");
    await settle(session2);
  });

  it("TTS-feil forkaster ALDRI svaret: reply leveres, 'tts_error' normalisert, helse DEGRADED (§36)", async () => {
    const failingTts: TtsAdapter = {
      name: "failing-tts",
      available: () => true,
      synthesize: () => {
        throw new Error("tts_provider_500 with secret-ish detail");
      }
    };
    const core: CoreClient = {
      chat: async () => ({ reply: "Svaret ditt i tekst.", routed: "model", session_id: "s" })
    };
    const ev = events();
    const health = new VoiceHealth();
    const session = new VoiceSession(
      identity, core, fixedStt("hei"), failingTts, ev.handlers,
      new UtteranceJournal(), undefined, undefined, undefined, undefined, health
    );
    await runVoiceTurn(session);
    await settle(session);
    expect(ev.replies[0]?.reply).toBe("Svaret ditt i tekst.");
    expect(ev.errors).toContain("tts_error");
    // §27: aldri rå feilmelding/detaljer ut til klienten:
    expect(ev.errors.every((e) => !e.includes("secret"))).toBe(true);
    expect(health.state("tts", true)).toBe("DEGRADED");
  });
});

describe("HttpCoreClient (§12/§24/§33): SSE-parsing, abort og provider-override", () => {
  function sseResponse(frames: string[]): Response {
    return new Response(new Blob([frames.join("")]).stream(), { status: 200 });
  }

  it("parser token/tool_call/done fra Core-SSE og sender provider-override i body", async () => {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string) as Record<string, unknown>;
        return sseResponse([
          `event: token\ndata: {"token":"Hei "}\n\n`,
          `event: tool_call\ndata: {"tool_call_id":"c1","tool_name":"read_calendar_today"}\n\n`,
          `event: token\ndata: {"token":"Tobias"}\n\n`,
          `event: done\ndata: {"reply":"Hei Tobias","routed":"model","session_id":"s9"}\n\n`
        ]);
      })
    );
    const client = new HttpCoreClient("http://core");
    const seen: CoreStreamEvent[] = [];
    const reply = await client.chatStream(
      { ...identity, provider: "anthropic" },
      "hei",
      (e) => seen.push(e)
    );
    expect(captured["provider"]).toBe("anthropic");
    expect(captured["channel"]).toBe("voice");
    expect(seen).toEqual([
      { type: "token", text: "Hei " },
      { type: "tool", tool_name: "read_calendar_today" },
      { type: "token", text: "Tobias" }
    ]);
    expect(reply).toMatchObject({ reply: "Hei Tobias", routed: "model", session_id: "s9" });
  });

  it("abort-signal propagerer til fetch (§15: barge-in → Core → provider-upstream)", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.signal).toBe(controller.signal);
        controller.abort();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      })
    );
    const client = new HttpCoreClient("http://core");
    const err = await client
      .chatStream(identity, "hei", () => undefined, controller.signal)
      .then(() => null)
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("Cross-provider (§33): voice-pipeline er lik uansett LLM-provider", () => {
  it("samme pipeline med provider-override 'openai' og 'anthropic' gir identisk voice-oppførsel", async () => {
    const runWith = async (provider: string) => {
      const seenProviders: Array<string | undefined> = [];
      const core: CoreClient = {
        chat: async () => {
          throw new Error("ubrukt");
        },
        chatStream: async (id, _msg, onEvent) => {
          seenProviders.push(id.provider);
          onEvent({ type: "token", text: `Svar fra ${provider}-modellen. ` });
          return { reply: `Svar fra ${provider}-modellen.`, routed: "model", session_id: "s" };
        }
      };
      const tts = taggedTts();
      const ev = events();
      const session = new VoiceSession(
        { ...identity, provider }, core, fixedStt("hei"), tts.adapter, ev.handlers
      );
      await runVoiceTurn(session);
      await settle(session);
      return { seenProviders, synthCalls: tts.synthCalls, states: ev.states };
    };
    const a = await runWith("openai");
    const b = await runWith("anthropic");
    expect(a.seenProviders).toEqual(["openai"]);
    expect(b.seenProviders).toEqual(["anthropic"]);
    // Identisk voice-flyt (samme states, samme antall TTS-kall):
    expect(a.states).toEqual(b.states);
    expect(a.synthCalls.length).toBe(b.synthCalls.length);
  });
});

describe("Latens-aggregering (§19/§38-§39)", () => {
  it("summarizeLatency gir P50 og holder P95 tilbake ved < 20 samples (aldri fake presisjon)", () => {
    const turns: TurnMetrics[] = Array.from({ length: 5 }, (_, i) => ({
      utterance_id: `u${i}`,
      t_speech_start: 0,
      t_end_of_turn: 100,
      t_model_first_token: 100 + 50 + i,
      t_first_tts_request: 200,
      t_tts_first_frame: 100 + 200 + i * 10,
      end_of_speech_to_first_audio_ms: 200 + i * 10
    }));
    const summary = summarizeLatency(turns);
    expect(summary.turns).toBe(5);
    expect(summary.end_of_speech_to_first_audio_p50_ms).toBeGreaterThanOrEqual(200);
    expect(summary.end_of_speech_to_first_audio_p95_ms).toBeUndefined();
    expect(summary.model_first_token_p50_ms).toBeGreaterThanOrEqual(50);
  });
});

describe("Personvern (§22): rå lyd persisteres aldri", () => {
  it("ingen filskriving i talekjedens runtime-moduler", async () => {
    // Strukturelt vern: selve lydkjeden (session/stt/tts/chunker/vad/audio/
    // server/health) skal aldri skrive til disk. Kun benchmark leser manifest.
    for (const file of ["session.ts", "stt.ts", "tts.ts", "chunker.ts", "vad.ts", "audio.ts", "server.ts", "health.ts"]) {
      const source = await readFile(join(__dirname, "..", "src", file), "utf8");
      expect(source.includes("writeFile"), file).toBe(false);
      expect(source.includes("createWriteStream"), file).toBe(false);
      expect(source.includes("appendFile"), file).toBe(false);
    }
  });
});
