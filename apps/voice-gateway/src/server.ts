import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  MemorySpaceSchema,
  VoiceAuthorizationResultSchema,
  evaluateSpeechRouting,
  voiceAuthorityFromGrant,
  type MemorySpaceAuthority,
  type SpeechProcessorDeclaration,
  type SpeechRoutingOutcome,
  type VoiceAuthorizationResult,
  type VoiceSessionGrant
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

  /**
   * D-123 (Q-32 punkt 2): spør Core sin `VoiceSessionAuthority`.
   *
   * Svaret parses STRENGT med `VoiceAuthorizationResultSchema`. Det er ikke
   * pynt: `VoiceSessionGrantSchema` krever literal
   * `memory_space_authority: "SERVER_VERIFIED"`, så en grant som IKKE kommer
   * fra den betrodde stien - en forvansket respons, en proxy som fyller inn
   * felter, en fremtidig refaktorering som ved et uhell ekkoer klientdata -
   * feiler parsingen i stedet for å bli tolket som en gyldig autoritet.
   *
   * En ikke-2xx/403-respons er et NORMALT avslag (Core svarer 403 med en
   * `reason`), mens transport-/parsefeil KASTER. Kalleren skiller på de to:
   * et avslag er et revidert vedtak, en transportfeil er en utilgjengelig
   * autoritet - begge fail-closed, men de skal ikke rapporteres likt.
   */
  async authorizeVoiceSession(evidence: unknown): Promise<VoiceAuthorizationResult> {
    const response = await fetch(`${this.baseUrl}/voice/session/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(evidence),
      // En hengende autoritet skal ikke kunne holde en talesesjon i limbo -
      // og køen av lydrammer som venter på vedtaket er ikke ubegrenset.
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status !== 200 && response.status !== 403) {
      throw new Error(`voice_authority_${response.status}`);
    }
    return VoiceAuthorizationResultSchema.parse(await response.json());
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
 * D-123 (UA-7 slice 4, Q-32 punkt 2): tillitsnivået for en talesesjon UTLEDES
 * nå, det er ikke lenger en konstant.
 *
 * D-122 hardkodet `VOICE_MEMORY_SPACE_AUTHORITY = "CLIENT_ASSERTED"` fordi det
 * den gang var den ærlige sannheten: gatewayen hadde ingen autentisering i det
 * hele tatt. Den konstanten er FJERNET, ikke omdøpt - en «tillitsnivå»-konstant
 * som kan settes ett sted er nøyaktig den knappen som før eller siden skrus
 * feil vei. Verdien kommer nå KUN fra `voiceAuthorityFromGrant()`, som bare gir
 * `SERVER_VERIFIED` for en gyldig, uutløpt grant utstedt av Core.
 *
 * Nivået som gjelder når klienten IKKE har bevist noe. Uendret fra D-122, og
 * per D-122 sin regel 6 kan det kun NEKTE ekstern behandling, aldri kvalifisere
 * for den.
 */
const UNPROVEN_MEMORY_SPACE_AUTHORITY: MemorySpaceAuthority = "CLIENT_ASSERTED";

/**
 * D-122: rutingutfall per memory space for én konfigurert behandler. Ren
 * oppslagsfunksjon over den KANONISKE `evaluateSpeechRouting()` - aldri en
 * andre, nesten-lik regel (samme disiplin som D-121 sin delte
 * `classifyAttentionBucket()`).
 *
 * D-123: tar nå tillitsnivået som argument, fordi `/status` skal vise BEGGE
 * nivåene. En eier som bare ser «alt avvist» kan ellers ikke skille «ingen har
 * bevist seg» fra «behandleren er ikke kvalifisert» - og det er to helt
 * forskjellige tiltak (bevis enheten vs. verifiser databehandleravtalen).
 */
function speechRoutingBySpace(
  processor: SpeechProcessorDeclaration,
  authority: MemorySpaceAuthority
): Record<string, SpeechRoutingOutcome> {
  const bySpace: Record<string, SpeechRoutingOutcome> = {};
  for (const space of MemorySpaceSchema.options) {
    bySpace[space] = evaluateSpeechRouting(processor, space, authority).outcome;
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
            // D-123: BEGGE tillitsnivåene rapporteres, ikke ett valgt nivå.
            // `client_asserted` er hva en ubevist klient faktisk får;
            // `server_verified` er hva en enhet som HAR bevist seg får. Er de
            // like (som i dag, fordi OpenAI-radene står `IKKE VERIFISERT`),
            // ser eieren umiddelbart at enhetsbevis ikke er det som mangler.
            stt: {
              client_asserted: speechRoutingBySpace(options.stt.processor, "CLIENT_ASSERTED"),
              server_verified: speechRoutingBySpace(options.stt.processor, "SERVER_VERIFIED")
            },
            tts: {
              client_asserted: speechRoutingBySpace(options.tts.processor, "CLIENT_ASSERTED"),
              server_verified: speechRoutingBySpace(options.tts.processor, "SERVER_VERIFIED")
            }
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
    /**
     * D-123: grant-en som ga denne sesjonen sin autoritet. `null` = klienten
     * har ikke bevist noe (den eldre, uautentiserte stien). Holdes HER, i
     * transporten som eier forbindelsens levetid - ikke inne i `VoiceSession`,
     * som per D-122 med vilje låser rutingvedtaket sitt ved konstruksjon og
     * ikke skal kunne «forhandle» det underveis.
     */
    let grant: VoiceSessionGrant | null = null;
    const send = (message: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
      }
    };

    const startSession = (identity: VoiceIdentity, authority: MemorySpaceAuthority): void => {
      session = new VoiceSession(
        identity,
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
        health,
        authority
      );
      // Tillitsnivået er en del av svaret: en klient skal kunne SE at den kjører
      // ubevist, i stedet for å oppdage det som et uforklarlig `speech_routing_denied`.
      send({ type: "started", memory_space_authority: authority });
    };

    /**
     * D-123 (Q-32 punkt 2) - selve tillitsgrensen.
     *
     * §23: start-meldingen ER den eksplisitte mikrofonaktiveringen.
     *
     * `message["identity"]` er og forblir KLIENTENS PÅSTAND. Den brukes til
     * nøyaktig to ting: (a) å be Core om et vedtak, og (b) den eldre,
     * ubeviste stien. Den kan ALDRI selv løfte seg til `SERVER_VERIFIED` -
     * det nivået returneres kun av `voiceAuthorityFromGrant()`, og bare for en
     * grant gatewayen har hentet SELV over sin egen utgående Core-forbindelse.
     * Ingen felt fra websocket-meldingen leses noen gang som en grant.
     */
    const handleStart = async (message: Record<string, unknown>): Promise<void> => {
      const claimed = message["identity"] as VoiceIdentity | undefined;
      const proof = message["device_proof"];

      if (proof === undefined) {
        // Ubevist sti - IDENTISK oppførsel med D-122. Bevisst beholdt: en
        // lokal behandler er alltid tillatt (D-122 regel 1), så en ubevist
        // klient kan fortsatt bruke tale lokalt. Den kan bare aldri nå en
        // ekstern behandler. Å nekte forbindelsen helt ville vært en ny
        // begrensning denne sliceen ikke er bedt om, og ville brutt
        // eksisterende webchat-/testklienter uten sikkerhetsgevinst.
        if (!claimed) {
          send({ type: "error", error: "missing_identity" });
          return;
        }
        grant = null;
        // Eksplisitt hvitliste framfor spread: en `{...claimed}` ville båret
        // med seg hvilke som helst ekstra felter klienten fant på (f.eks. et
        // `memory_space_authority`) helt inn i Core-kallet. De kunne ikke
        // påvirke rutingen - tillitsnivået er et eget argument - men å
        // videresende dem i det hele tatt motsier prinsippet om at
        // klientfelter er bevismateriale og ikke tilstand.
        startSession(
          {
            person_id: claimed.person_id,
            tenant_id: claimed.tenant_id,
            device_id: claimed.device_id,
            memory_space: claimed.memory_space,
            channel: "voice",
            ...(claimed.provider !== undefined ? { provider: claimed.provider } : {})
          },
          UNPROVEN_MEMORY_SPACE_AUTHORITY
        );
        return;
      }

      if (!options.core.authorizeVoiceSession) {
        // Gatewayen er konfigurert mot en Core-klient som ikke kan autorisere.
        // Fail-closed og SYNLIG: vi starter ikke en sesjon som later som den
        // er bevist, og vi degraderer heller ikke stille til den ubeviste
        // stien - klienten forsøkte faktisk å bevise seg.
        send({ type: "error", error: "voice_authority_unavailable" });
        return;
      }

      let result: VoiceAuthorizationResult;
      try {
        result = await options.core.authorizeVoiceSession({
          // Kun de erklærte bevisfeltene sendes videre. `VoiceAuthorizationEvidenceSchema`
          // er `.strict()`, så et forsøk på å smugle med ekstra felter (f.eks.
          // en ferdigsnekret `grant`) blir en parse-feil i Core, ikke en
          // stille aksept.
          person_id: claimed?.person_id,
          tenant_id: claimed?.tenant_id,
          device_id: claimed?.device_id,
          memory_space: claimed?.memory_space,
          device_proof: proof
        });
      } catch (err) {
        console.error(
          JSON.stringify({ msg: "voice_authority_error", error: (err as Error).message.slice(0, 200) })
        );
        send({ type: "error", error: "voice_authority_unavailable" });
        return;
      }

      if (!result.ok) {
        // Et avvist bevis starter INGEN sesjon - heller ikke en nedgradert
        // `CLIENT_ASSERTED`-sesjon. En nedgradering hadde vært teknisk trygg
        // (D-122 gjør `CLIENT_ASSERTED` rent innstrammende), men den ville
        // skjult et faktisk mislykket autentiseringsforsøk bak en
        // tilsynelatende normal samtale. Fail closed OG synlig.
        send({ type: "error", error: `voice_authority_denied:${result.reason}` });
        return;
      }

      grant = result.grant;
      startSession(
        {
          // HVERT identitetsfelt kommer fra grant-en. Klientens påstand er nå
          // ferdig brukt: har den løyet om person, tenant, enhet eller space,
          // er løgnen enten avvist over, eller overskrevet her.
          person_id: grant.person_id,
          tenant_id: grant.tenant_id,
          device_id: grant.device_id,
          memory_space: grant.memory_space,
          channel: "voice",
          // §33: ren LLM-provider-preferanse, ikke et identitets-/autoritetsfelt.
          ...(claimed?.provider !== undefined ? { provider: claimed.provider } : {})
        },
        voiceAuthorityFromGrant(grant, Date.now())
      );
    };

    /**
     * D-123: grant-levetid håndheves ved HVER bruk, ikke bare ved start.
     * En utløpt grant river sesjonen ned i stedet for å degradere den stille:
     * `disconnect()` bumper epoch, tømmer TTS-køen og aborterer aktiv
     * generering (samme vern som barge-in), og `session` nulles slik at ingen
     * senere lydramme kan finne veien inn i en sesjon hvis autoritet er borte.
     */
    const activeSession = (): VoiceSession | null => {
      if (!session) {
        send({ type: "error", error: "no_session" });
        return null;
      }
      if (!grant) {
        return session; // ubevist sti - ingen grant å utløpe
      }
      if (voiceAuthorityFromGrant(grant, Date.now()) === "SERVER_VERIFIED") {
        return session;
      }
      session.disconnect();
      session = null;
      grant = null;
      send({ type: "error", error: "voice_authority_expired" });
      return null;
    };

    const handleMessage = async (message: Record<string, unknown>): Promise<void> => {
      switch (message["type"]) {
        case "start":
          return handleStart(message);
        case "audio": {
          // Autoriteten kontrolleres FØR lydrammen dekodes og mates videre -
          // ikke én ramme passerer en utløpt grant.
          activeSession()?.pushAudio(Buffer.from(String(message["data"]), "base64"));
          return;
        }
        case "replay_final": {
          activeSession()?.replayFinal(String(message["utterance_id"]), String(message["text"]));
          return;
        }
        default:
          send({ type: "error", error: "unknown_message_type" });
      }
    };

    /**
     * D-123: meldinger serialiseres gjennom én kjede. `start` er nå asynkron
     * (den venter på Core sitt vedtak), og uten denne kjeden ville lydrammer
     * sendt umiddelbart etter `start` blitt behandlet FØR autoriteten var
     * avgjort - enten forkastet som `no_session`, eller i verste fall matet
     * inn i feil sesjon. Kjeden bevarer også rekkefølgen mellom lydrammer,
     * som hele STT-kjeden avhenger av.
     */
    let queue: Promise<void> = Promise.resolve();
    ws.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        send({ type: "error", error: "invalid_json" });
        return;
      }
      queue = queue.then(() =>
        handleMessage(message).catch((err: Error) => {
          console.error(JSON.stringify({ msg: "voice_message_error", error: err.message.slice(0, 200) }));
          send({ type: "error", error: "internal_error" });
        })
      );
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
