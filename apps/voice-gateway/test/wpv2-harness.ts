import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import WebSocket from "ws";
import { VOICE_GRANT_TTL_MS, type SpeechProcessorDeclaration, type VoiceAuthorizationResult, type VoiceSessionGrant } from "@jarvis/contracts";
import { createVoiceGateway, type VoiceGatewayOptions } from "../src/server.ts";
import type { CoreClient, CoreReply, CoreStreamEvent, VoiceIdentity } from "../src/session.ts";
import { MarkerStt } from "../src/stt.ts";
import { FakeTts, type TtsAdapter } from "../src/tts.ts";

/**
 * WP-V2: felles testoppsett for gateway-tester (ekte `createVoiceGateway` bak ekte WebSocket, ingen database, ingen nettverk
 * utover loopback). Fikstur-tokens bygges SAMMENSATT ved kjøring (aldri en literal som ligner en ekte nøkkel).
 */
export const LOCAL: SpeechProcessorDeclaration = {
  processor_id: "wpv2-test-local",
  locality: "local",
  processor_row_declared: true,
  processor_terms_status: "NOT_APPLICABLE_LOCAL"
};

export const EXTERNAL_VERIFIED: SpeechProcessorDeclaration = {
  processor_id: "wpv2-test-external",
  locality: "external",
  processor_row_declared: true,
  processor_terms_status: "VERIFIED"
};

let tokenCounter = 0;
export function fixtureToken(tag: string): string {
  tokenCounter += 1;
  return ["grt", "wpv2", tag, String(tokenCounter)].join("-");
}

export const IDENTITY = {
  person_id: "person-wpv2",
  tenant_id: "tenant-wpv2",
  device_id: "dev-wpv2-a",
  memory_space: "personal"
};

export function grantFor(evidence: Record<string, unknown>, overrides: Partial<VoiceSessionGrant> = {}): VoiceSessionGrant {
  return {
    person_id: String(evidence["person_id"]),
    tenant_id: String(evidence["tenant_id"]),
    device_id: String(evidence["device_id"]),
    session_id: `sess-${String(evidence["device_id"])}`,
    memory_space: evidence["memory_space"] as VoiceSessionGrant["memory_space"],
    memory_space_authority: "SERVER_VERIFIED",
    auth_strength: "signed",
    grant_token: fixtureToken("grant"),
    expires_at_ms: Date.now() + VOICE_GRANT_TTL_MS,
    ...overrides
  };
}

export const PROOF = { challenge: "c-wpv2", signature: "s-wpv2" };

/** Core-fake: teller kall, kan forsinkes, og autoriserer enhver enhet (grant speiler beviset). */
export class ScriptedCore implements CoreClient {
  readonly chatCalls: Array<{ identity: VoiceIdentity; message: string }> = [];
  readonly authorizeCalls: unknown[] = [];
  chatDelayMs = 0;
  chatError: Error | null = null;
  grantOverrides: Partial<VoiceSessionGrant> = {};
  chatStream?: NonNullable<CoreClient["chatStream"]>;

  async authorizeVoiceSession(evidence: unknown): Promise<VoiceAuthorizationResult> {
    this.authorizeCalls.push(evidence);
    return { ok: true, grant: grantFor(evidence as Record<string, unknown>, this.grantOverrides) };
  }

  async chat(identity: VoiceIdentity, message: string): Promise<CoreReply> {
    this.chatCalls.push({ identity, message });
    if (this.chatDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.chatDelayMs));
    }
    if (this.chatError) {
      throw this.chatError;
    }
    return { reply: `svar:${message}`, routed: "fast", session_id: "sess-wpv2" };
  }
}

export type { CoreStreamEvent };

export interface RunningGateway {
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startGateway(options: Partial<VoiceGatewayOptions> & { core?: CoreClient; tts?: TtsAdapter } = {}): Promise<RunningGateway> {
  const server = createVoiceGateway({
    core: options.core ?? new ScriptedCore(),
    stt: options.stt ?? new MarkerStt(),
    tts: options.tts ?? new FakeTts(5),
    ...options
  } as VoiceGatewayOptions);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of openClients) ws.terminate();
        openClients.clear();
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

export type WsMessage = Record<string, unknown> & { type: string };

/** Alle klienter som er åpnet i denne testprosessen - `RunningGateway.close()` terminerer dem (upgradede sockets lukkes ikke av `closeAllConnections`). */
const openClients = new Set<WebSocket>();

export class TestClient {
  readonly messages: WsMessage[] = [];
  closeEvent: { code: number; reason: string } | null = null;
  ws!: WebSocket;
  private readonly wsOptions: WebSocket.ClientOptions;

  constructor(private readonly url: string, wsOptions: WebSocket.ClientOptions = {}) {
    this.wsOptions = wsOptions;
  }

  async connect(): Promise<this> {
    this.ws = new WebSocket(this.url, this.wsOptions);
    openClients.add(this.ws);
    this.ws.on("close", () => openClients.delete(this.ws));
    this.ws.on("message", (raw) => this.messages.push(JSON.parse(String(raw)) as WsMessage));
    this.ws.on("close", (code, reason) => {
      this.closeEvent = { code, reason: reason.toString("utf8") };
    });
    // En server som lukker/avviser kan gi `error` - det er en gyldig observasjon i flere tester, ikke en testfeil.
    this.ws.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
      this.ws.once("close", () => resolve());
    });
    return this;
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  /** Skriver en håndlaget, maskert WebSocket-ramme direkte på TCP-socketen (for protokollbrudd `ws`-klienten selv aldri sender). */
  sendRawFrame(opcode: number, payload: Buffer): void {
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] as number)));
    const header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    (this.ws as unknown as { _socket: { write(b: Buffer): void } })._socket.write(Buffer.concat([header, mask, masked]));
  }

  resetTcp(): void {
    (this.ws as unknown as { _socket: { resetAndDestroy(): void } })._socket.resetAndDestroy();
  }

  pauseReading(): void {
    (this.ws as unknown as { _socket: { pause(): void } })._socket.pause();
  }

  async waitFor(predicate: (m: WsMessage) => boolean, timeoutMs = 4000): Promise<WsMessage> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) {
        return found;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timeout; fikk: ${this.messages.map((m) => m.type + (m["error"] ? `(${String(m["error"])})` : "")).join(",")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async waitClosed(timeoutMs = 4000): Promise<{ code: number; reason: string }> {
    const started = Date.now();
    while (this.closeEvent === null) {
      if (Date.now() - started > timeoutMs) {
        throw new Error("timeout waiting for close");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.closeEvent;
  }

  errors(): string[] {
    return this.messages.filter((m) => m.type === "error").map((m) => String(m["error"]));
  }

  /** Start en BEVIST sesjon (Core-faken autoriserer). */
  async startProven(identity: Record<string, unknown> = IDENTITY): Promise<void> {
    this.send({ type: "start", identity, device_proof: PROOF });
    await this.waitFor((m) => m.type === "started");
  }

  /** Start en UBEVIST sesjon (kun lokal tale; Core `/chat` er utilgjengelig). */
  async startUnproven(identity: Record<string, unknown> = IDENTITY): Promise<void> {
    this.send({ type: "start", identity });
    await this.waitFor((m) => m.type === "started");
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // allerede lukket
    }
  }
}

/** 20 ms @16 kHz PCM16 base64; `text` legges inn som MarkerStt-markør. */
export function speechFrame(text?: string): string {
  const buffer = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) {
    buffer.writeInt16LE(9000, i * 2);
  }
  if (text) {
    buffer.write(`TXT:${text}\0`, 64, "utf8");
  }
  return buffer.toString("base64");
}

export function silenceFrame(): string {
  return Buffer.alloc(640).toString("base64");
}

/** Samler uncaughtException/unhandledRejection i en test - brukt til å bevise at prosessen IKKE krasjer. */
export function trackUncaught(): { errors: string[]; stop(): void } {
  const errors: string[] = [];
  const onUncaught = (err: Error): void => {
    errors.push(`uncaught:${(err as NodeJS.ErrnoException).code ?? err.message}`);
  };
  const onRejection = (reason: unknown): void => {
    errors.push(`rejection:${reason instanceof Error ? reason.message : String(reason)}`);
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  return {
    errors,
    stop: () => {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onRejection);
    }
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
