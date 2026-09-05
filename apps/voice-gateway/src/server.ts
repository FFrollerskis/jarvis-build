import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  MemorySpaceSchema,
  evaluateSpeechRouting,
  type SpeechProcessorDeclaration,
  type SpeechRoutingOutcome
} from "@jarvis/contracts";
import { VoiceHealth } from "./health.ts";
import {
  UtteranceJournal,
  VoiceSession,
  type CoreClient,
  type CoreReply,
  type CoreStreamEvent,
  type VoiceIdentity
} from "./session.ts";
import type { SttAdapter } from "./stt.ts";
import type { TtsAdapter } from "./tts.ts";

/**
 * Voice Gateway-prosessen: WebSocket-transport (D-29/BO-12 §24 - bidireksjonal
 * audio/events; SSE alene passer ikke mikrofon-opplasting). Protokoll:
 * klient→ {type:"start", identity} | {type:"audio", data:base64} | {type:"replay_final", utterance_id, text}
 * server→ {type:"state"|"partial"|"final"|"reply"|"tool_activity"|"tts_frame"|"tts_cancelled"|"metrics"|"error", ...}
 * Gatewayen eier transport og lydkjede; Core eier samtale, minne og policy.
 */
export class HttpCoreClient implements CoreClient {
  constructor(private readonly baseUrl: string) {}

  private body(identity: VoiceIdentity, message: string): string {
    return JSON.stringify({ ...identity, message });
  }

  async chat(identity: VoiceIdentity, message: string): Promise<CoreReply> {
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: this.body(identity, message)
    });
    if (!response.ok) {
      throw new Error(`core_${response.status}`);
    }
    return (await response.json()) as CoreReply;
  }

  /**
   * BO-12 §12-§13: streaming via Core sin eksisterende SSE-/chat (P1A).
   * Tokens driver TTS-chunking; tool-events gir kort brukerstatus; signal
   * aborterer via fetch → Core sin res-close-kjede → provider-upstream (§15).
   */
  async chatStream(
    identity: VoiceIdentity,
    message: string,
    onEvent: (event: CoreStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<CoreReply> {
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: this.body(identity, message),
      ...(signal ? { signal } : {})
    });
    if (!response.ok || !response.body) {
      throw new Error(`core_${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "";
    let done: CoreReply | null = null;
    try {
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (eventName === "token" && typeof payload["token"] === "string") {
              onEvent({ type: "token", text: payload["token"] });
            } else if (eventName === "tool_call" && typeof payload["tool_name"] === "string") {
              onEvent({ type: "tool", tool_name: payload["tool_name"] });
            } else if (eventName === "done") {
              done = payload as unknown as CoreReply;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!done) {
      throw new Error("core_stream_no_done");
    }
    return done;
  }
}

export interface VoiceGatewayOptions {
  core: CoreClient;
  stt: SttAdapter;
  tts: TtsAdapter;
  /** Delt journal (failover-gjenopptak i test/prod). */
  journal?: UtteranceJournal;
  health?: VoiceHealth;
}

/**
 * D-122: rutingutfall per memory space for én konfigurert behandler. Ren
 * oppslagsfunksjon over den KANONISKE `evaluateSpeechRouting()` - aldri en
 * andre, nesten-lik regel (samme disiplin som D-121 sin delte
 * `classifyAttentionBucket()`).
 */
function speechRoutingBySpace(
  processor: SpeechProcessorDeclaration
): Record<string, SpeechRoutingOutcome> {
  const bySpace: Record<string, SpeechRoutingOutcome> = {};
  for (const space of MemorySpaceSchema.options) {
    bySpace[space] = evaluateSpeechRouting(processor, space).outcome;
  }
  return bySpace;
}

export function createVoiceGateway(options: VoiceGatewayOptions): Server {
  const health = options.health ?? new VoiceHealth();
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "jarvis-voice-gateway", version: "0.2.0" }));
      return;
    }
    if (req.method === "GET" && req.url === "/status") {
      // BO-12 §37: faktisk runtime-basert voice-helse. Ingen secrets.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          service: "jarvis-voice-gateway",
          transport: "websocket",
          stt: { name: options.stt.name, ...healthOf("stt"), processor: options.stt.processor },
          tts: { name: options.tts.name, ...healthOf("tts"), processor: options.tts.processor },
          barge_in: health.bargeInSeen ? "VERIFIED" : "READY",
          audio_persistence: "none", // §22: rå lyd lagres aldri permanent
          // D-122: hvilke memory spaces de KONFIGURERTE behandlerne faktisk kan
          // betjene. Gjør porten observerbar UTEN en sesjon - en eier skal kunne
          // se «health-tale er ikke mulig med denne konfigurasjonen» direkte.
          speech_routing: {
            stt: speechRoutingBySpace(options.stt.processor),
            tts: speechRoutingBySpace(options.tts.processor)
          }
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const healthOf = (component: "stt" | "tts") =>
    health.snapshot({ stt: options.stt.available(), tts: options.tts.available() })[component];

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws: WebSocket) => {
    let session: VoiceSession | null = null;
    const send = (message: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
      }
    };

    ws.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        send({ type: "error", error: "invalid_json" });
        return;
      }
      switch (message["type"]) {
        case "start": {
          // §23: start-meldingen ER den eksplisitte mikrofonaktiveringen.
          const identity = message["identity"] as VoiceIdentity;
          session = new VoiceSession(
            { ...identity, channel: "voice" },
            options.core,
            options.stt,
            options.tts,
            {
              onState: (state) => send({ type: "state", state }),
              onPartial: (text) => send({ type: "partial", text }),
              onFinal: (text) => send({ type: "final", text }),
              onReply: (reply) => send({ type: "reply", ...reply }),
              onToolActivity: (activity) => send({ type: "tool_activity", activity }),
              onTtsFrame: (frame) => send({ type: "tts_frame", data: frame.toString("base64") }),
              onTtsCancelled: (afterMs) => send({ type: "tts_cancelled", after_ms: afterMs }),
              onMetrics: (metrics) => send({ type: "metrics", metrics }),
              onError: (error) => send({ type: "error", error })
            },
            options.journal ?? new UtteranceJournal(),
            undefined,
            undefined,
            undefined,
            undefined,
            health
          );
          send({ type: "started" });
          break;
        }
        case "audio": {
          if (!session) {
            send({ type: "error", error: "no_session" });
            return;
          }
          session.pushAudio(Buffer.from(String(message["data"]), "base64"));
          break;
        }
        case "replay_final": {
          if (!session) {
            send({ type: "error", error: "no_session" });
            return;
          }
          session.replayFinal(String(message["utterance_id"]), String(message["text"]));
          break;
        }
        default:
          send({ type: "error", error: "unknown_message_type" });
      }
    });

    // D-30 hardening §3D: klientfrakobling midt i en tur skal aldri gi zombie-
    // generering. Aborterer upstream modellgenerering og tømmer TTS-kø - ingen
    // lyd/tekst er igjen produsert for en socket som ikke lenger lytter.
    ws.on("close", () => {
      session?.disconnect();
    });
  });

  return server;
}
