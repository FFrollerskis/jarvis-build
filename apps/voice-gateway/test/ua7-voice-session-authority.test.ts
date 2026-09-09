import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VOICE_GRANT_TTL_MS,
  VoiceAuthorizationEvidenceSchema,
  VoiceSessionGrantSchema,
  evaluateSpeechRouting,
  voiceAuthorityFromGrant,
  type SpeechProcessorDeclaration,
  type VoiceAuthorizationResult,
  type VoiceSessionGrant
} from "@jarvis/contracts";
import { createVoiceGateway } from "../src/server.ts";
import type { CoreClient, CoreReply, VoiceIdentity } from "../src/session.ts";
import { OpenAiStt, type SttAdapter, type SttStream } from "../src/stt.ts";
import { OpenAiTts, type TtsAdapter, type TtsPlayback } from "../src/tts.ts";

/**
 * D-123 (UA-7, FJERDE slice) - Q-32 punkt (2): betrodd server-side sesjons-/
 * memory-space-autoritet i voice-transporten.
 *
 * Denne suiten beviser TILLITSGRENSEN i den faktiske transporten: en ekte
 * `createVoiceGateway()` bak en ekte WebSocket, med en Core-klient vi
 * kontrollerer. Ingen database - det er med vilje: her testes GATEWAYENS
 * oppførsel («kan noe klienten sender noensinne bli `SERVER_VERIFIED`?»), mens
 * selve autoritetsvedtaket mot ekte `DeviceService`/`SessionService`/
 * `resolveIdentity()` og ekte RLS bevises separat i
 * `modules/core/test/d123-voice-session-authority.test.ts`.
 *
 * Adversarielt utgangspunkt: klienten er FIENDTLIG. Den lyver om person,
 * tenant, enhet og space, den prøver å oppgi sitt eget tillitsnivå, og den
 * prøver å smugle inn en ferdigsnekret grant.
 */

const CLAIMED: VoiceIdentity = {
  person_id: "person-angriper",
  tenant_id: "tenant-annen",
  device_id: "dev-ukjent",
  memory_space: "personal",
  channel: "voice"
};

/** Det serveren faktisk fant. Bevisst ULIKT alt klienten påsto. */
const GRANTED_IDENTITY = {
  person_id: "person-tobias",
  tenant_id: "tenant-personal",
  device_id: "dev-watch",
  session_id: "sess-server-eid",
  memory_space: "business"
} as const;

function grantFor(overrides: Partial<VoiceSessionGrant> = {}): VoiceSessionGrant {
  return {
    ...GRANTED_IDENTITY,
    memory_space_authority: "SERVER_VERIFIED",
    auth_strength: "signed",
    expires_at_ms: Date.now() + VOICE_GRANT_TTL_MS,
    ...overrides
  };
}

/** Ekstern behandler der ALLE matrise-regel-3-feltene er verifisert. Finnes IKKE i dag. */
const EXTERNAL_VERIFIED: SpeechProcessorDeclaration = {
  processor_id: "test-external-verified",
  locality: "external",
  processor_row_declared: true,
  processor_terms_status: "VERIFIED"
};

/** STT-spion: teller HVER ramme som faktisk nådde adapteren. */
function spyStt(processor: SpeechProcessorDeclaration): { adapter: SttAdapter; frames: () => number } {
  let frames = 0;
  return {
    frames: () => frames,
    adapter: {
      name: "spy-stt",
      processor,
      available: () => true,
      startStream(): SttStream {
        return {
          pushAudio: () => {
            frames++;
          },
          end: async () => "hei jarvis",
          onPartial: () => undefined
        };
      }
    }
  };
}

/** TTS-spion: teller HVER tekstbit som faktisk nådde adapteren. */
function spyTts(processor: SpeechProcessorDeclaration): { adapter: TtsAdapter; synthesized: () => string[] } {
  const synthesized: string[] = [];
  return {
    synthesized: () => synthesized,
    adapter: {
      name: "spy-tts",
      processor,
      available: () => true,
      synthesize(text: string): TtsPlayback {
        synthesized.push(text);
        return {
          frames: (async function* () {
            yield Buffer.from("pcm");
          })(),
          cancel: () => undefined
        };
      }
    }
  };
}

/**
 * Core-klient vi styrer fullt. `seenIdentity` fanger NØYAKTIG den identiteten
 * gatewayen faktisk brukte mot Core - det er slik vi beviser at klientens
 * påstand ble kastet og grant-en brukt.
 */
class FakeCore implements CoreClient {
  readonly seenIdentity: VoiceIdentity[] = [];
  readonly seenEvidence: unknown[] = [];
  /**
   * Uten et `authorize`-argument forblir denne UTILDELT - altså en Core-klient
   * som rett og slett ikke kan autorisere. Det er en ekte konfigurasjon (eldre
   * fakes/tester), og gatewayen må håndtere den fail-closed.
   */
  authorizeVoiceSession?: (evidence: unknown) => Promise<VoiceAuthorizationResult>;

  constructor(authorize?: (evidence: unknown) => Promise<VoiceAuthorizationResult>) {
    if (authorize) {
      this.authorizeVoiceSession = async (evidence: unknown) => {
        this.seenEvidence.push(evidence);
        return authorize(evidence);
      };
    }
  }

  async chat(identity: VoiceIdentity, _message: string): Promise<CoreReply> {
    this.seenIdentity.push(identity);
    return { reply: "ok", routed: "test", session_id: "sess-core" };
  }
}

/** Tale-ramme med nok energi til at `EnergyVad` registrerer speech_start. */
function loudFrame(): string {
  const frame = Buffer.alloc(640);
  for (let i = 0; i < frame.length; i += 2) {
    frame.writeInt16LE(12000, i);
  }
  return frame.toString("base64");
}

/** Stillhet - etter `hangoverMs` (300 ms) utløser den `end_of_turn`. */
function silentFrame(): string {
  return Buffer.alloc(640).toString("base64");
}

class Client {
  readonly messages: Array<Record<string, unknown> & { type: string }> = [];
  private ws!: WebSocket;

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw) =>
      this.messages.push(JSON.parse(String(raw)) as Record<string, unknown> & { type: string })
    );
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  async waitFor(type: string, timeoutMs = 4000): Promise<Record<string, unknown> & { type: string }> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.find((m) => m.type === type);
      if (found) return found;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timeout ventet på "${type}"; fikk: ${this.messages.map((m) => m.type).join(",")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Lar meldingskøen i gatewayen tømme seg før vi hevder «ingenting skjedde». */
  async settle(ms = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Én komplett tur over transporten: tale, så stillhet lenge nok til at
   * `EnergyVad` sin hangover (300 ms) faktisk løper ut. Over websocket bruker
   * `pushAudio()` sanntid, så ventingen må være ekte - den kan ikke simuleres
   * med `atMs` slik de direkte `VoiceSession`-testene gjør.
   */
  async speakOneTurn(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      this.send({ type: "audio", data: loudFrame() });
    }
    await this.settle(350);
    this.send({ type: "audio", data: silentFrame() });
  }

  close(): void {
    this.ws.close();
  }
}

describe("D-123 / Q-32 punkt 2: server-side memory-space-autoritet i voice-transporten", () => {
  let servers: Array<ReturnType<typeof createVoiceGateway>> = [];
  let clients: Client[] = [];

  const start = async (
    core: CoreClient,
    stt: SttAdapter,
    tts: TtsAdapter
  ): Promise<{ client: Client }> => {
    const server = createVoiceGateway({ core, stt, tts });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const client = new Client();
    clients.push(client);
    await client.connect(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return { client };
  };

  beforeEach(() => {
    servers = [];
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // --- A: ubevist klient kan ALDRI oppnå SERVER_VERIFIED -------------------

  it("A1: start uten enhetsbevis gir CLIENT_ASSERTED, aldri SERVER_VERIFIED", async () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    const { client } = await start(new FakeCore(), stt.adapter, tts.adapter);

    client.send({ type: "start", identity: CLAIMED });
    const started = await client.waitFor("started");

    expect(started["memory_space_authority"]).toBe("CLIENT_ASSERTED");
  });

  it("A2: klienten kan ikke oppgi sitt EGET tillitsnivå i start-meldingen", async () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    const { client } = await start(new FakeCore(), stt.adapter, tts.adapter);

    // Alle tenkelige smugleforsøk i én melding.
    client.send({
      type: "start",
      identity: { ...CLAIMED, memory_space_authority: "SERVER_VERIFIED" },
      memory_space_authority: "SERVER_VERIFIED",
      grant: grantFor(),
      authority: "SERVER_VERIFIED"
    });
    const started = await client.waitFor("started");
    expect(started["memory_space_authority"]).toBe("CLIENT_ASSERTED");

    // ...og en ekstern behandler forblir utilgjengelig, som er hele poenget.
    client.send({ type: "audio", data: loudFrame() });
    const error = await client.waitFor("error");
    expect(String(error["error"])).toContain("DENIED_MEMORY_SPACE_NOT_SERVER_VERIFIED");
    expect(stt.frames()).toBe(0);
  });

  it("A3: en klient-smuglet grant blir ALDRI lest av transporten", async () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    // Core sier NEI. Klienten sender likevel en perfekt formet grant selv.
    const core = new FakeCore(async () => ({ ok: false, reason: "device_proof_invalid" }));
    const { client } = await start(core, stt.adapter, tts.adapter);

    client.send({
      type: "start",
      identity: CLAIMED,
      device_proof: { challenge: "chal-forfalsket", signature: "AAAA" },
      grant: grantFor()
    });
    const error = await client.waitFor("error");

    expect(error["error"]).toBe("voice_authority_denied:device_proof_invalid");
    // Ingen sesjon i det hele tatt - ikke engang en nedgradert.
    client.send({ type: "audio", data: loudFrame() });
    await client.settle();
    expect(client.messages.filter((m) => m.type === "no_session" || m.error === "no_session").length).toBe(1);
    expect(stt.frames()).toBe(0);
  });

  // --- B: avslag og utilgjengelig autoritet er fail-closed -----------------

  it.each([
    "unknown_membership" as const,
    "unknown_device" as const,
    "unknown_memory_space" as const,
    "malformed_evidence" as const
  ])("B1: avslagsgrunn %s starter ingen sesjon og slipper ingen lydramme", async (reason) => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    const core = new FakeCore(async () => ({ ok: false, reason }));
    const { client } = await start(core, stt.adapter, tts.adapter);

    client.send({
      type: "start",
      identity: CLAIMED,
      device_proof: { challenge: "chal-1", signature: "AAAA" }
    });
    const error = await client.waitFor("error");
    expect(error["error"]).toBe(`voice_authority_denied:${reason}`);

    client.send({ type: "audio", data: loudFrame() });
    await client.settle();
    expect(stt.frames()).toBe(0);
    expect(client.messages.some((m) => m.type === "started")).toBe(false);
  });

  it("B2: utilgjengelig autoritet degraderer ikke stille - den nekter", async () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    const core = new FakeCore(async () => {
      throw new Error("econnrefused");
    });
    const { client } = await start(core, stt.adapter, tts.adapter);

    client.send({
      type: "start",
      identity: CLAIMED,
      device_proof: { challenge: "chal-1", signature: "AAAA" }
    });
    const error = await client.waitFor("error");

    expect(error["error"]).toBe("voice_authority_unavailable");
    expect(client.messages.some((m) => m.type === "started")).toBe(false);
    expect(stt.frames()).toBe(0);
  });

  it("B3: Core-klient uten autorisasjonsevne nekter et bevisforsøk", async () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    const { client } = await start(new FakeCore(), stt.adapter, tts.adapter);

    client.send({
      type: "start",
      identity: CLAIMED,
      device_proof: { challenge: "chal-1", signature: "AAAA" }
    });
    const error = await client.waitFor("error");

    expect(error["error"]).toBe("voice_authority_unavailable");
    expect(client.messages.some((m) => m.type === "started")).toBe(false);
  });

  // --- C: en gyldig grant er ENESTE vei til SERVER_VERIFIED ----------------

  it("C1: gyldig grant gir SERVER_VERIFIED, og identiteten kommer fra grant-en - ikke fra påstanden", async () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    const core = new FakeCore(async () => ({ ok: true, grant: grantFor() }));
    const { client } = await start(core, stt.adapter, tts.adapter);

    client.send({
      type: "start",
      identity: { ...CLAIMED, provider: "anthropic" },
      device_proof: { challenge: "chal-1", signature: "AAAA" }
    });
    const started = await client.waitFor("started");
    expect(started["memory_space_authority"]).toBe("SERVER_VERIFIED");

    // Kjør en hel tur og se hvilken identitet Core faktisk fikk.
    await client.speakOneTurn();
    await client.waitFor("reply");

    // D-130 arkitekt-review MERGE BLOCKER 1-fiks: `session_id` er nå med -
    // grant-en ER selve beviset for at en gyldig `/chat`-sesjon finnes, og
    // `server.ts` setter den nå på identiteten den bygger fra grant-en.
    expect(core.seenIdentity[0]).toEqual({
      person_id: GRANTED_IDENTITY.person_id,
      tenant_id: GRANTED_IDENTITY.tenant_id,
      device_id: GRANTED_IDENTITY.device_id,
      memory_space: GRANTED_IDENTITY.memory_space,
      channel: "voice",
      provider: "anthropic",
      session_id: GRANTED_IDENTITY.session_id
    });
    // Ingen av angriperens påstander overlevde.
    expect(core.seenIdentity[0]?.person_id).not.toBe(CLAIMED.person_id);
    expect(core.seenIdentity[0]?.tenant_id).not.toBe(CLAIMED.tenant_id);
    expect(core.seenIdentity[0]?.device_id).not.toBe(CLAIMED.device_id);
    expect(core.seenIdentity[0]?.memory_space).not.toBe(CLAIMED.memory_space);
  });

  it("C2: gatewayen videresender KUN de erklærte bevisfeltene til Core", async () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    const core = new FakeCore(async () => ({ ok: true, grant: grantFor() }));
    const { client } = await start(core, stt.adapter, tts.adapter);

    client.send({
      type: "start",
      identity: { ...CLAIMED, memory_space_authority: "SERVER_VERIFIED", auth_strength: "signed" },
      device_proof: { challenge: "chal-1", signature: "AAAA" },
      grant: grantFor()
    });
    await client.waitFor("started");

    // Bevismaterialet Core fikk skal validere som EVIDENCE og ikke inneholde
    // ett eneste smuglet autoritetsfelt.
    const evidence = core.seenEvidence[0];
    expect(VoiceAuthorizationEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(Object.keys(evidence as object).sort()).toEqual(
      ["device_id", "device_proof", "memory_space", "person_id", "tenant_id"].sort()
    );
  });

  it("C3: utløpt grant river sesjonen ned - ingen ramme passerer", async () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    // Grant som allerede er utløpt idet den utstedes.
    const core = new FakeCore(async () => ({
      ok: true,
      grant: grantFor({ expires_at_ms: Date.now() - 1 })
    }));
    const { client } = await start(core, stt.adapter, tts.adapter);

    client.send({
      type: "start",
      identity: CLAIMED,
      device_proof: { challenge: "chal-1", signature: "AAAA" }
    });
    const started = await client.waitFor("started");
    // Nedgraderingen er umiddelbar og innstrammende.
    expect(started["memory_space_authority"]).toBe("CLIENT_ASSERTED");

    client.send({ type: "audio", data: loudFrame() });
    const error = await client.waitFor("error");
    expect(error["error"]).toBe("voice_authority_expired");
    expect(stt.frames()).toBe(0);

    // Sesjonen er borte, ikke bare degradert.
    client.send({ type: "audio", data: loudFrame() });
    await client.settle();
    expect(client.messages.some((m) => m.error === "no_session")).toBe(true);
    expect(stt.frames()).toBe(0);
  });

  // --- D: D-122 er UENDRET og overordnet ----------------------------------

  it("D1: SERVER_VERIFIED åpner IKKE dagens OpenAI STT/TTS - vilkårene er fortsatt NOT_VERIFIED", async () => {
    const stt = spyStt(new OpenAiStt().processor);
    const tts = spyTts(new OpenAiTts().processor);
    const core = new FakeCore(async () => ({ ok: true, grant: grantFor() }));
    const { client } = await start(core, stt.adapter, tts.adapter);

    client.send({
      type: "start",
      identity: CLAIMED,
      device_proof: { challenge: "chal-1", signature: "AAAA" }
    });
    const started = await client.waitFor("started");
    expect(started["memory_space_authority"]).toBe("SERVER_VERIFIED");

    client.send({ type: "audio", data: loudFrame() });
    const error = await client.waitFor("error");

    expect(error["error"]).toBe("speech_routing_denied_stt:DENIED_PROCESSOR_TERMS_NOT_VERIFIED");
    expect(stt.frames()).toBe(0);
    expect(tts.synthesized()).toEqual([]);
  });

  it("D2: SERVER_VERIFIED åpner IKKE health mot en ekstern behandler (D-23)", async () => {
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    const core = new FakeCore(async () => ({
      ok: true,
      grant: grantFor({ memory_space: "health" })
    }));
    const { client } = await start(core, stt.adapter, tts.adapter);

    client.send({
      type: "start",
      identity: CLAIMED,
      device_proof: { challenge: "chal-1", signature: "AAAA" }
    });
    await client.waitFor("started");

    client.send({ type: "audio", data: loudFrame() });
    const error = await client.waitFor("error");

    expect(error["error"]).toBe("speech_routing_denied_stt:DENIED_SENSITIVE_SPACE_REQUIRES_LOCAL_PROCESSOR");
    expect(stt.frames()).toBe(0);
  });

  it("D3: SERVER_VERIFIED + verifisert ekstern behandler + ikke-sensitiv space slipper faktisk gjennom", async () => {
    // Beviser at porten ikke bare er «nekt alltid» - den nye autoriteten er
    // reelt virksom. Denne konfigurasjonen finnes IKKE i produksjon i dag.
    const stt = spyStt(EXTERNAL_VERIFIED);
    const tts = spyTts(EXTERNAL_VERIFIED);
    const core = new FakeCore(async () => ({ ok: true, grant: grantFor() }));
    const { client } = await start(core, stt.adapter, tts.adapter);

    client.send({
      type: "start",
      identity: CLAIMED,
      device_proof: { challenge: "chal-1", signature: "AAAA" }
    });
    await client.waitFor("started");

    await client.speakOneTurn();
    await client.waitFor("reply");

    expect(stt.frames()).toBeGreaterThan(0);
    expect(tts.synthesized()).toEqual(["ok"]);
  });

  // --- E: kontraktnivå - grant-en kan ikke degraderes eller forfalskes ----

  it("E1: en grant med CLIENT_ASSERTED kan ikke EKSISTERE", () => {
    const degraded = { ...grantFor(), memory_space_authority: "CLIENT_ASSERTED" };
    expect(VoiceSessionGrantSchema.safeParse(degraded).success).toBe(false);
  });

  it("E2: voiceAuthorityFromGrant gir CLIENT_ASSERTED for alt som ikke er en gyldig, uutløpt grant", () => {
    const now = 1_000_000;
    expect(voiceAuthorityFromGrant(null, now)).toBe("CLIENT_ASSERTED");
    expect(voiceAuthorityFromGrant(undefined, now)).toBe("CLIENT_ASSERTED");
    expect(voiceAuthorityFromGrant({} as VoiceSessionGrant, now)).toBe("CLIENT_ASSERTED");
    // Nøyaktig utløpt teller som utløpt (`<=`), ikke som gyldig.
    expect(voiceAuthorityFromGrant(grantFor({ expires_at_ms: now }), now)).toBe("CLIENT_ASSERTED");
    expect(voiceAuthorityFromGrant(grantFor({ expires_at_ms: now - 1 }), now)).toBe("CLIENT_ASSERTED");
    expect(voiceAuthorityFromGrant(grantFor({ expires_at_ms: now + 1 }), now)).toBe("SERVER_VERIFIED");
    // Et ukjent ekstrafelt gjør grant-en ugyldig (skjemaet er `.strict()`).
    expect(
      voiceAuthorityFromGrant({ ...grantFor(), smuggled: true } as unknown as VoiceSessionGrant, now)
    ).toBe("CLIENT_ASSERTED");
  });

  it("E3: bevismaterialet er `.strict()` - et smuglet autoritetsfelt gir parse-feil", () => {
    const base = {
      person_id: "p",
      tenant_id: "t",
      device_id: "d",
      memory_space: "personal" as const,
      device_proof: { challenge: "c", signature: "s" }
    };
    expect(VoiceAuthorizationEvidenceSchema.safeParse(base).success).toBe(true);
    expect(
      VoiceAuthorizationEvidenceSchema.safeParse({ ...base, memory_space_authority: "SERVER_VERIFIED" }).success
    ).toBe(false);
    expect(VoiceAuthorizationEvidenceSchema.safeParse({ ...base, grant: grantFor() }).success).toBe(false);
    expect(VoiceAuthorizationEvidenceSchema.safeParse({ ...base, session_id: "sess-valgt-selv" }).success).toBe(
      false
    );
    // Ukjent space avvises av det kanoniske `MemorySpaceSchema`, ikke av en egen liste.
    expect(VoiceAuthorizationEvidenceSchema.safeParse({ ...base, memory_space: "hemmelig" }).success).toBe(false);
  });

  it("E4: SERVER_VERIFIED er nødvendig OG utilstrekkelig for ekstern behandling", () => {
    // Nødvendig: samme behandler, samme space, kun tillitsnivået varierer.
    expect(evaluateSpeechRouting(EXTERNAL_VERIFIED, "personal", "CLIENT_ASSERTED").allowed).toBe(false);
    expect(evaluateSpeechRouting(EXTERNAL_VERIFIED, "personal", "SERVER_VERIFIED").allowed).toBe(true);
    // Utilstrekkelig: D-122 sine behandlerregler går foran tillitsnivået.
    expect(evaluateSpeechRouting(new OpenAiStt().processor, "personal", "SERVER_VERIFIED").outcome).toBe(
      "DENIED_PROCESSOR_TERMS_NOT_VERIFIED"
    );
    expect(evaluateSpeechRouting(EXTERNAL_VERIFIED, "health", "SERVER_VERIFIED").outcome).toBe(
      "DENIED_SENSITIVE_SPACE_REQUIRES_LOCAL_PROCESSOR"
    );
  });
});
