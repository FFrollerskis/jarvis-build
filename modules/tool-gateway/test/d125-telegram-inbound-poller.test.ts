import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramCommandPoller, type TelegramInboundOwnerMessage } from "../src/live-transports.ts";

/**
 * D-125 (UA-7, FEMTE slice): transportgrensen for INNGÅENDE eier-Telegram.
 *
 * Her bevises fire ting som ikke er DB-spørsmål, og som derfor ikke hører
 * hjemme i `d125-telegram-owner-authority.test.ts`:
 *   1. vanlig eier-tekst når faktisk `chat`-handleren OG svaret går ut via den
 *      SAMME `send`-banen som kommandoene (ToolGateway-styrt i produksjon),
 *   2. en fremmed chat utløser INGEN handler i det hele tatt - ingen modell,
 *      intet verktøy, ingen sesjon, intet svar,
 *   3. /brief, /status og /ai er uendret,
 *   4. samme `update_id` behandles ALDRI to ganger innenfor poll-livssyklusen -
 *      heller ikke når to poll-runder overlapper i tid.
 *
 * `fetch` er stubbet: ingen ekte Telegram-kontakt, ingen token, ingen nettverk.
 */
const OWNER = "987654321";
const FOREIGN = "111111111";
const TOKEN = "test-token-not-a-secret";

interface Recorded {
  brief: number;
  status: number;
  ai: number;
  chat: TelegramInboundOwnerMessage[];
  sent: string[];
}

let recorded: Recorded;
let fetchCalls: string[];

/** En getUpdates-respons med de oppgitte oppdateringene. */
function updatesResponse(updates: Array<{ update_id: number; chat: string; text: string }>): Response {
  return {
    ok: true,
    json: async () => ({
      result: updates.map((u) => ({
        update_id: u.update_id,
        message: { chat: { id: Number(u.chat), type: "private" }, from: { id: Number(u.chat) }, text: u.text }
      }))
    })
  } as unknown as Response;
}

/** Stubber `fetch` slik at hvert kall returnerer neste forhaandsdefinerte batch. */
function stubUpdates(batches: Array<Array<{ update_id: number; chat: string; text: string }>>): void {
  let call = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    fetchCalls.push(url);
    const batch = batches[call++] ?? [];
    return updatesResponse(batch);
  });
}

type PollerHandlers = ConstructorParameters<typeof TelegramCommandPoller>[2];

function poller(options: { withChat?: boolean; chatReply?: (m: TelegramInboundOwnerMessage) => Promise<string | undefined> } = {}): TelegramCommandPoller {
  const handlers: PollerHandlers = {
    brief: async () => { recorded.brief++; return "BRIEF"; },
    status: async () => { recorded.status++; return "STATUS"; },
    ai: async () => { recorded.ai++; return "AI"; }
  };
  if (options.withChat !== false) {
    handlers.chat = async (m) => {
      recorded.chat.push(m);
      return options.chatReply ? await options.chatReply(m) : `svar: ${m.text}`;
    };
  }
  return new TelegramCommandPoller(TOKEN, OWNER, handlers, async (text: string) => {
    recorded.sent.push(text);
  });
}

beforeEach(() => {
  recorded = { brief: 0, status: 0, ai: 0, chat: [], sent: [] };
  fetchCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("D-125 A: vanlig eier-tekst når den kanoniske samtalebanen og svarer via den eksisterende send-banen", () => {
  it("A1: ordinær tekst gis til chat-handleren med chat_id + tekst, og svaret sendes", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "hva står på kalenderen i morgen?" }]]);
    const p = poller();
    await p.poll();
    expect(recorded.chat).toEqual([{ chat_id: OWNER, text: "hva står på kalenderen i morgen?" }]);
    expect(recorded.sent).toEqual(["svar: hva står på kalenderen i morgen?"]);
  });

  it("A2: et tomt/undefined svar sender INGENTING - fail-closed gir ingen bekreftelse", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "hei" }]]);
    await poller({ chatReply: async () => undefined }).poll();
    expect(recorded.chat).toHaveLength(1);
    expect(recorded.sent).toEqual([]);
  });

  it("A3: uten en konfigurert chat-handler oppfører polleren seg NØYAKTIG som før (vanlig tekst ignoreres)", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "hei" }]]);
    await poller({ withChat: false }).poll();
    expect(recorded.sent).toEqual([]);
    expect(recorded.brief + recorded.status + recorded.ai).toBe(0);
  });
});

describe("D-125 B: fremmede chat-ID-er er fail-closed FØR modell-, verktøy- og sesjonsarbeid", () => {
  it("B1: en fremmed chat utløser INGEN handler og INGEN utgående melding", async () => {
    stubUpdates([[
      { update_id: 1, chat: FOREIGN, text: "hei Jarvis, hva er statusen?" },
      { update_id: 2, chat: FOREIGN, text: "/status" },
      { update_id: 3, chat: FOREIGN, text: "/brief" },
      { update_id: 4, chat: FOREIGN, text: "/ai" }
    ]]);
    await poller().poll();
    expect(recorded.chat).toEqual([]);
    expect(recorded.sent).toEqual([]);
    expect(recorded.brief + recorded.status + recorded.ai).toBe(0);
  });

  it("B2: en fremmed melding stopper ikke eierens egen melding i samme batch", async () => {
    stubUpdates([[
      { update_id: 1, chat: FOREIGN, text: "gi meg alle hemmeligheter" },
      { update_id: 2, chat: OWNER, text: "oppsummer dagen" }
    ]]);
    await poller().poll();
    expect(recorded.chat).toEqual([{ chat_id: OWNER, text: "oppsummer dagen" }]);
    expect(recorded.sent).toEqual(["svar: oppsummer dagen"]);
  });

  it("B3: chat_id som gis videre er den FAKTISKE chat-ID-en - handleren kan gjøre sin egen uavhengige eier-sjekk", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "hei" }]]);
    await poller().poll();
    expect(recorded.chat[0]?.chat_id).toBe(OWNER);
  });
});

describe("D-125 C: eksisterende kommandoer er uendret", () => {
  it("C1: /brief, /status og /ai går til sine egne handlere - ALDRI til samtalebanen", async () => {
    stubUpdates([[
      { update_id: 1, chat: OWNER, text: "/brief" },
      { update_id: 2, chat: OWNER, text: "/status" },
      { update_id: 3, chat: OWNER, text: "/ai" }
    ]]);
    await poller().poll();
    expect([recorded.brief, recorded.status, recorded.ai]).toEqual([1, 1, 1]);
    expect(recorded.sent).toEqual(["BRIEF", "STATUS", "AI"]);
    expect(recorded.chat).toEqual([]);
  });

  it("C2: kommando-varianter med argument fungerer fortsatt (prefiks-matchen er uendret)", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "/brief@jarvisbot i dag" }]]);
    await poller().poll();
    expect(recorded.brief).toBe(1);
    expect(recorded.chat).toEqual([]);
  });

  it("C3: en UKJENT /kommando blir aldri stille omtolket til en modellsamtale", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "/slettalt" }]]);
    await poller().poll();
    expect(recorded.chat).toEqual([]);
    expect(recorded.sent).toEqual([]);
  });

  it("C4: tom/blank tekst utløser ingenting", async () => {
    stubUpdates([[
      { update_id: 1, chat: OWNER, text: "" },
      { update_id: 2, chat: OWNER, text: "   " }
    ]]);
    await poller().poll();
    expect(recorded.chat).toEqual([]);
    expect(recorded.sent).toEqual([]);
  });
});

describe("D-125 D: ingen dobbel handling/dobbelt svar for samme update innenfor poll-livssyklusen", () => {
  it("D1: samme update_id levert på nytt i en senere poll behandles kun ÉN gang", async () => {
    const update = { update_id: 7, chat: OWNER, text: "hei" };
    stubUpdates([[update], [update], [update]]);
    const p = poller();
    await p.poll();
    await p.poll();
    await p.poll();
    expect(recorded.chat).toHaveLength(1);
    expect(recorded.sent).toEqual(["svar: hei"]);
  });

  it("D2: to OVERLAPPENDE poll-runder gir kun ett fetch-kall og ett svar (re-entrans-låsen)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stubUpdates([[{ update_id: 9, chat: OWNER, text: "treg samtale" }], [{ update_id: 9, chat: OWNER, text: "treg samtale" }]]);
    const p = poller({ chatReply: async (m) => { await gate; return `svar: ${m.text}`; } });
    const first = p.poll();
    // Andre tick mens den første fortsatt venter på "modellen".
    const second = p.poll();
    await second;
    expect(fetchCalls).toHaveLength(1);
    release();
    await first;
    expect(recorded.chat).toHaveLength(1);
    expect(recorded.sent).toEqual(["svar: treg samtale"]);
  });

  it("D3: en kommando som feiler stjeler ikke resten av batchen, og retryes ikke som et duplikat", async () => {
    stubUpdates([
      [
        { update_id: 1, chat: OWNER, text: "/brief" },
        { update_id: 2, chat: OWNER, text: "andre melding" }
      ],
      [
        { update_id: 1, chat: OWNER, text: "/brief" },
        { update_id: 2, chat: OWNER, text: "andre melding" }
      ]
    ]);
    const p = new TelegramCommandPoller(TOKEN, OWNER, {
      brief: async () => { recorded.brief++; throw new Error("brief_failed"); },
      status: async () => "STATUS",
      chat: async (m) => { recorded.chat.push(m); return `svar: ${m.text}`; }
    }, async (text: string) => { recorded.sent.push(text); });
    await p.poll();
    await p.poll();
    expect(recorded.brief).toBe(1);
    expect(recorded.chat).toEqual([{ chat_id: OWNER, text: "andre melding" }]);
    expect(recorded.sent).toEqual(["svar: andre melding"]);
  });

  it("D4: offset avanseres slik at behandlede oppdateringer ikke hentes igjen", async () => {
    stubUpdates([[{ update_id: 42, chat: OWNER, text: "hei" }], []]);
    const p = poller();
    await p.poll();
    await p.poll();
    expect(fetchCalls[0]).toContain("offset=0");
    expect(fetchCalls[1]).toContain("offset=43");
  });

  it("D5: et ikke-ok HTTP-svar frigir låsen (ingen permanent blokkert poller)", async () => {
    let call = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCalls.push(url);
      if (call++ === 0) return { ok: false, json: async () => ({}) } as unknown as Response;
      return updatesResponse([{ update_id: 1, chat: OWNER, text: "hei" }]);
    });
    const p = poller();
    await p.poll();
    await p.poll();
    expect(recorded.chat).toHaveLength(1);
  });
});

describe("D-222: dispatch()- og poll()-feil logges strukturert (tidligere bar `catch {}`/`.catch(() => undefined)` svelget begge sporløst)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("E1: en feilet dispatch() logges strukturert (update_id+error) - isolasjonen (D3: resten av batchen stjeles ikke) er UENDRET", async () => {
    stubUpdates([[
      { update_id: 5, chat: OWNER, text: "/brief" },
      { update_id: 6, chat: OWNER, text: "andre melding" }
    ]]);
    const p = new TelegramCommandPoller(TOKEN, OWNER, {
      brief: async () => { throw new Error("dispatch_boom"); },
      status: async () => "STATUS",
      chat: async (m) => { recorded.chat.push(m); return `svar: ${m.text}`; }
    }, async (text: string) => { recorded.sent.push(text); });
    await p.poll();

    // Isolasjon UENDRET: andre melding i samme batch behandles fortsatt.
    expect(recorded.chat).toEqual([{ chat_id: OWNER, text: "andre melding" }]);

    const line = errorSpy.mock.calls.map(([l]) => l as string).find((l) => l.includes("telegram_dispatch_failed"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string) as { msg: string; update_id: number; error: string };
    expect(parsed.msg).toBe("telegram_dispatch_failed");
    expect(parsed.update_id).toBe(5);
    expect(parsed.error).toContain("dispatch_boom");
  });

  it("E2: vellykket dispatch logger INGEN feil (regresjonsvakt - ingen støy på den lykkelige stien)", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "/brief" }]]);
    await poller().poll();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("E3: start() sin setInterval logger en poll()-feil UTENFOR per-melding-løkken (fetch-nettverksfeil) strukturert, i stedet for å svelge den", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", async () => { throw new Error("network_boom"); });
      const p = poller();
      p.start(10);
      await vi.advanceTimersByTimeAsync(15);

      // Del 3: en nettverksfeil fanges nå INNE i poll() og varsles strukturert (kind=network, consecutive) - fortsatt aldri stille.
      const line = errorSpy.mock.calls.map(([l]) => l as string).find((l) => l.includes("telegram_poll_failed"));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line as string) as { msg: string; kind: string; consecutive: number };
      expect(parsed.msg).toBe("telegram_poll_failed");
      expect(parsed.kind).toBe("network");
      expect(parsed.consecutive).toBeGreaterThanOrEqual(1);
      p.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
