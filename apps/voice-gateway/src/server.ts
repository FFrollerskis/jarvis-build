import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { UtteranceJournal, VoiceSession, type CoreClient, type VoiceIdentity } from "./session.ts";
import type { SttAdapter } from "./stt.ts";
import type { TtsAdapter } from "./tts.ts";

/**
 * Voice Gateway-prosessen: WebSocket-transport i piloten (D-29). Protokoll:
 * klient→ {type:"start", identity} | {type:"audio", data:base64} | {type:"replay_final", utterance_id, text}
 * server→ {type:"state"|"partial"|"final"|"reply"|"tts_frame"|"tts_cancelled"|"metrics"|"error", ...}
 * Gatewayen eier transport og lydkjede; Core eier samtale, minne og policy.
 */
export class HttpCoreClient implements CoreClient {
  constructor(private readonly baseUrl: string) {}

  async chat(identity: VoiceIdentity, message: string) {
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...identity, message })
    });
    if (!response.ok) {
      throw new Error(`core_${response.status}`);
    }
    return (await response.json()) as { reply: string; routed: string; session_id: string; task_id?: string };
  }
}

export interface VoiceGatewayOptions {
  core: CoreClient;
  stt: SttAdapter;
  tts: TtsAdapter;
  /** Delt journal (failover-gjenopptak i test/prod). */
  journal?: UtteranceJournal;
}

export function createVoiceGateway(options: VoiceGatewayOptions): Server {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "jarvis-voice-gateway", version: "0.1.0" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

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
              onTtsFrame: (frame) => send({ type: "tts_frame", data: frame.toString("base64") }),
              onTtsCancelled: (afterMs) => send({ type: "tts_cancelled", after_ms: afterMs }),
              onMetrics: (metrics) => send({ type: "metrics", metrics }),
              onError: (error) => send({ type: "error", error })
            },
            options.journal ?? new UtteranceJournal()
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
  });

  return server;
}
