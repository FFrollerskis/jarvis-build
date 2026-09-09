import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChannelSessionAuthority, ContextBuilder, DeviceService, IdentityService, MessageStore, PgApprovalStore,
  SessionService, VoiceSessionAuthority, createPool, runMigrations
} from "@jarvis/core";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../../api/src/conversation.ts";
import { createApiServer } from "../../api/src/server.ts";
import { createVoiceGateway, HttpCoreClient } from "../src/server.ts";
import { MarkerStt } from "../src/stt.ts";
import { FakeTts } from "../src/tts.ts";
import { UtteranceJournal } from "../src/session.ts";

const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let apiServer: ReturnType<typeof createApiServer>;
let voiceServer: ReturnType<typeof createVoiceGateway>;
let coreUrl: string;
let voiceUrl: string;
const journal = new UtteranceJournal();
/**
 * D-130 arkitekt-review MERGE BLOCKER 1-fiks: `dev-web` sitt ekte Ed25519-
 * nøkkelpar (registrert med `public_key_pem` i seed-fasen under). `/chat`
 * krever nå et bevist `session_id` - denne testfilen kan derfor ikke lenger
 * nå Core via en selv-oppgitt identitet, og må faktisk bevise enheten via
 * `/devices/challenge` + `/session/authorize` (tekst) og
 * `/voice/session/authorize` (tale) FØR noen tur som forventer et ekte
 * Core-svar. Samme mønster som `modules/core/test/channel-session-authority.test.ts`.
 */
const deviceKeys = generateKeyPairSync("ed25519");
/** `DeviceService`-instansen delt med `apiServer` sine deps (samme delingsdisiplin som main.ts). */
let devices: DeviceService;

const identity = {
  person_id: "person-tobias",
  tenant_id: "tenant-personal",
  device_id: "dev-web",
  memory_space: "personal"
};

/** Et gyldig enhetsbevis for `identity.device_id`, signert med `deviceKeys`. */
function deviceProof(): { challenge: string; signature: string } {
  const challenge = devices.issueChallenge(identity.device_id);
  return { challenge, signature: sign(null, Buffer.from(challenge, "utf8"), deviceKeys.privateKey).toString("base64") };
}

/** Autoriserer en tekstkanal-sesjon (f.eks. "web") og returnerer sesjonens `session_id`. */
async function authorizeChannelSession(channel: string): Promise<string> {
  const res = await fetch(`${coreUrl}/session/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, ...identity, device_proof: deviceProof() })
  });
  const body = (await res.json()) as { ok: boolean; session_id?: string; reason?: string };
  if (!body.ok || !body.session_id) {
    throw new Error(`session_authorize_failed: ${JSON.stringify(body)}`);
  }
  return body.session_id;
}

type WsMessage = Record<string, unknown> & { type: string };

class VoiceClient {
  readonly messages: WsMessage[] = [];
  private ws!: WebSocket;

  async connect(): Promise<void> {
    this.ws = new WebSocket(voiceUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw) => this.messages.push(JSON.parse(String(raw)) as WsMessage));
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  async waitFor(predicate: (m: WsMessage) => boolean, timeoutMs = 8000): Promise<WsMessage> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) {
        return found;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timeout waiting for message; got: ${this.messages.map((m) => m.type).join(",")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    this.ws.close();
  }

  speechFrame(text?: string): string {
    const buffer = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) {
      buffer.writeInt16LE(9000, i * 2);
    }
    if (text) {
      buffer.write(`TXT:${text}\0`, 64, "utf8");
    }
    return buffer.toString("base64");
  }

  silenceFrame(): string {
    return Buffer.alloc(640).toString("base64");
  }

  /** Full taletur: talerammer med tekstmarkør → pause → stillhet (end-of-turn). */
  async utter(text: string): Promise<void> {
    this.send({ type: "audio", data: this.speechFrame(text) });
    this.send({ type: "audio", data: this.speechFrame() });
    await new Promise((resolve) => setTimeout(resolve, 340));
    this.send({ type: "audio", data: this.silenceFrame() });
  }
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg5-"));
  epg = new EmbeddedPostgres({
    databaseDir, user: "postgres", password: "test-superuser-pw", port: PORT, persistent: false
  });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({
    host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "test-superuser-pw"
  });
  // Teardown-race (embedded-PG): server-terminert klient skal aldri bli uncaught.
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'test-app-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-personal', 'Tobias', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias', 'Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias', 'tenant-personal');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('sp-personal', 'tenant-personal', 'personal');
  `);
  // D-130 arkitekt-review MERGE BLOCKER 1-fiks: enheten registreres med sin
  // EKTE offentlige nøkkel (samme mønster som channel-session-authority.test.ts)
  // - `/session/authorize`/`/voice/session/authorize` verifiserer ekte
  // Ed25519-signaturer, ikke en påstått identitet.
  await adminPool.query(
    `INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1, $2, $3, $4, $5)`,
    [identity.device_id, identity.tenant_id, identity.person_id, "web", deviceKeys.publicKey.export({ type: "spki", format: "pem" }).toString()]
  );
  appPool = createPool({
    host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "test-app-pw"
  });

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new PgApprovalStore(appPool),
    killSwitch: new KillSwitch()
  });
  const scripted = new ScriptedAdapter(
    () => "Dette er et bevisst ganske langt modellsvar som brukes til å teste ekte barge-in i talepiloten. ".repeat(3)
  );
  const queue = new PgTaskQueue(appPool);
  const worker = new InProcessWorker(queue);
  worker.register("executive", async (task) => ({ echo: task.contract.goal }));
  const identityService = new IdentityService(appPool);
  const sessionService = new SessionService(appPool);
  devices = new DeviceService(appPool);
  apiServer = createApiServer({
    identity: identityService,
    sessions: sessionService,
    devices,
    // D-130 arkitekt-review MERGE BLOCKER 1-fiks: SAMME delte instanser
    // (main.ts sin delingsdisiplin) - `DeviceService` holder utstedte
    // challenges in-memory, så en egen instans her ville aldri gjenkjent en
    // nonce utstedt av `/devices/challenge`/`/session/authorize`.
    channelAuthority: new ChannelSessionAuthority({ devices, sessions: sessionService, identity: identityService }),
    voiceAuthority: new VoiceSessionAuthority({ devices, sessions: sessionService, identity: identityService }),
    policy,
    worker,
    conversation: new ConversationEngine({
      messages: new MessageStore(appPool),
      context: new ContextBuilder(appPool),
      gateway: new ModelGateway({ pool: appPool, trace: new MemoryTraceSink(), providers: [scripted] }),
      tasks: new TaskService(appPool, queue, policy),
      worker,
      trace: new MemoryTraceSink()
    })
  });
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  coreUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

  voiceServer = createVoiceGateway({
    core: new HttpCoreClient(coreUrl),
    stt: new MarkerStt(),
    tts: new FakeTts(5),
    journal
  });
  await new Promise<void>((resolve) => voiceServer.listen(0, "127.0.0.1", resolve));
  voiceUrl = `ws://127.0.0.1:${(voiceServer.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => voiceServer?.close(() => resolve()));
  await new Promise<void>((resolve) => apiServer?.close(() => resolve()));
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("Sesjonskontinuitet: tekst ↔ tale bruker samme sesjon", () => {
  it("tekstsesjon gjenopptas av talekanalen med samme session_id", async () => {
    // D-130 arkitekt-review MERGE BLOCKER 1-fiks: `/chat` godtar ikke lenger
    // en klient-oppgitt identitet - tekstkanalen må først bevise enheten via
    // `/session/authorize` for å få et gyldig `session_id`.
    const textSessionId = await authorizeChannelSession("web");
    const textResponse = await fetch(`${coreUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: textSessionId, tenant_id: identity.tenant_id, memory_space: identity.memory_space,
        channel: "web", message: "status"
      })
    });
    const textSession = ((await textResponse.json()) as { session_id: string }).session_id;
    expect(textSession).toBe(textSessionId);

    const client = new VoiceClient();
    await client.connect();
    client.send({ type: "start", identity, device_proof: deviceProof() });
    await client.waitFor((m) => m.type === "started");
    await client.utter("status");
    const reply = await client.waitFor((m) => m.type === "reply");
    expect(reply["session_id"]).toBe(textSession);
    client.close();
  });
});

describe("Akseptanse 3: enkel talekommando uten stor LLM", () => {
  it("'status' via tale rutes deterministisk (routed=fast)", async () => {
    const client = new VoiceClient();
    await client.connect();
    client.send({ type: "start", identity, device_proof: deviceProof() });
    await client.waitFor((m) => m.type === "started");
    await client.utter("status");
    const reply = await client.waitFor((m) => m.type === "reply");
    expect(reply["routed"]).toBe("fast");
    const metrics = await client.waitFor((m) => m.type === "metrics");
    expect((metrics["metrics"] as { routed: string }).routed).toBe("fast");
    client.close();
  });
});

describe("Akseptanse 1: barge-in ≤ 250 ms", () => {
  it("tale under avspilling kansellerer TTS innen 250 ms og ny tur fullføres", async () => {
    const client = new VoiceClient();
    await client.connect();
    client.send({ type: "start", identity, device_proof: deviceProof() });
    await client.waitFor((m) => m.type === "started");

    // Modellrute => langt svar => lang avspilling
    await client.utter("fortell meg noe interessant om planene mine");
    await client.waitFor((m) => m.type === "state" && m["state"] === "speaking", 10_000);
    await client.waitFor((m) => m.type === "tts_frame", 10_000);

    // Barge-in: ren tale mens Jarvis snakker
    client.send({ type: "audio", data: client.speechFrame("status") });
    const cancelled = await client.waitFor((m) => m.type === "tts_cancelled", 5_000);
    expect(Number(cancelled["after_ms"])).toBeLessThanOrEqual(250);

    // Den avbrytende turen fullfører korrekt
    client.send({ type: "audio", data: client.speechFrame() });
    await new Promise((resolve) => setTimeout(resolve, 340));
    client.send({ type: "audio", data: client.silenceFrame() });
    const replies = client.messages.filter((m) => m.type === "reply").length;
    await client.waitFor((m) => m.type === "reply" && client.messages.filter((x) => x.type === "reply").length > replies, 10_000);
    client.close();
  });
});

describe("Akseptanse 2: latens målt per delstrekning (median/P95)", () => {
  it("8 turer: median total < 1500 ms med testadaptere; alle delmålinger finnes", async () => {
    const client = new VoiceClient();
    await client.connect();
    client.send({ type: "start", identity, device_proof: deviceProof() });
    await client.waitFor((m) => m.type === "started");

    const totals: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = client.messages.filter((m) => m.type === "metrics").length;
      await client.utter("status");
      await client.waitFor((m) => m.type === "metrics" && client.messages.filter((x) => x.type === "metrics").length > before, 10_000);
      const metricsMsg = client.messages.filter((m) => m.type === "metrics").at(-1)!;
      const metrics = metricsMsg["metrics"] as Record<string, number>;
      expect(metrics["t_first_partial"]).toBeGreaterThan(0);
      expect(metrics["t_end_of_turn"]).toBeGreaterThan(0);
      expect(metrics["t_core_reply"]).toBeGreaterThan(0);
      expect(metrics["t_tts_first_frame"]).toBeGreaterThan(0);
      totals.push(metrics["t_done"]! - metrics["t_speech_start"]!);
    }
    totals.sort((a, b) => a - b);
    const median = totals[Math.floor(totals.length / 2)]!;
    const p95 = totals[totals.length - 1]!;
    console.log(JSON.stringify({ voice_latency_ms: { median, p95, totals } }));
    expect(median).toBeLessThan(1500);
    client.close();
  }, 60_000);
});

describe("Akseptanse 4: failover uten doble verktøyhandlinger", () => {
  it("fullført utterance re-sendt etter 'restart' utføres ikke på nytt", async () => {
    const client = new VoiceClient();
    await client.connect();
    client.send({ type: "start", identity, device_proof: deviceProof() });
    await client.waitFor((m) => m.type === "started");
    client.send({ type: "replay_final", utterance_id: "utt-failover-1", text: "opprett jobb: failovertest" });
    const reply = await client.waitFor((m) => m.type === "reply");
    expect(String(reply["reply"])).toContain("Jobb opprettet");
    client.close();

    // "Gateway-restart": ny tilkobling/sesjon med samme (delte/persisterte) journal
    const restarted = new VoiceClient();
    await restarted.connect();
    restarted.send({ type: "start", identity, device_proof: deviceProof() });
    await restarted.waitFor((m) => m.type === "started");
    restarted.send({ type: "replay_final", utterance_id: "utt-failover-1", text: "opprett jobb: failovertest" });
    const error = await restarted.waitFor((m) => m.type === "error");
    expect(String(error["error"])).toContain("utterance_already_completed");
    restarted.close();

    const count = await adminPool.query("SELECT count(*)::int AS n FROM tasks WHERE goal = 'failovertest'");
    expect(count.rows[0].n).toBe(1);
  });

  it("lydrammer før start-melding avvises kontrollert", async () => {
    const client = new VoiceClient();
    await client.connect();
    client.send({ type: "audio", data: client.silenceFrame() });
    const error = await client.waitFor((m) => m.type === "error");
    expect(error["error"]).toBe("no_session");
    client.close();
  });
});
