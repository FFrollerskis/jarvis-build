import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramCommandPoller } from "../src/live-transports.ts";

/**
 * Task #121 (D-214): transportgrensen for `/godkjenn`/`/avvis` - den raske
 * "one-tap" eier-godkjenningen for `requires_approval`-klassifiserte
 * selvendringsforespørsler. SAMME testmønster/stubbing som
 * `d125-telegram-inbound-poller.test.ts` (fetch stubbet, ingen ekte
 * Telegram-kontakt).
 */
const OWNER = "987654321";
const FOREIGN = "111111111";
const TOKEN = "test-token-not-a-secret";

interface Recorded {
  approve: string[];
  reject: string[];
  chat: number;
  sent: string[];
}

let recorded: Recorded;

function updatesResponse(updates: Array<{ update_id: number; chat: string; text: string }>): Response {
  return {
    ok: true,
    json: async () => ({
      result: updates.map((u) => ({
        update_id: u.update_id,
        message: { chat: { id: Number(u.chat) }, text: u.text }
      }))
    })
  } as unknown as Response;
}

function stubUpdates(batches: Array<Array<{ update_id: number; chat: string; text: string }>>): void {
  let call = 0;
  vi.stubGlobal("fetch", async () => {
    const batch = batches[call++] ?? [];
    return updatesResponse(batch);
  });
}

type PollerHandlers = ConstructorParameters<typeof TelegramCommandPoller>[2];

function poller(overrides: Partial<PollerHandlers> = {}): TelegramCommandPoller {
  const handlers: PollerHandlers = {
    brief: async () => "BRIEF",
    status: async () => "STATUS",
    approveSelfMod: async (id) => { recorded.approve.push(id); return `Godkjent: ${id}`; },
    rejectSelfMod: async (id) => { recorded.reject.push(id); return `Avvist: ${id}`; },
    chat: async () => { recorded.chat++; return undefined; },
    ...overrides
  };
  return new TelegramCommandPoller(TOKEN, OWNER, handlers, async (text: string) => {
    recorded.sent.push(text);
  });
}

beforeEach(() => {
  recorded = { approve: [], reject: [], chat: 0, sent: [] };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("D-214 A: /godkjenn og /avvis ruter til de nye handlerne, ikke til chat", () => {
  it("A1: '/godkjenn selfmod-123' kaller approveSelfMod med eksakt id-en, sender svaret", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "/godkjenn selfmod-123" }]]);
    await poller().poll();
    expect(recorded.approve).toEqual(["selfmod-123"]);
    expect(recorded.chat).toBe(0);
    expect(recorded.sent).toEqual(["Godkjent: selfmod-123"]);
  });

  it("A2: '/avvis selfmod-456' kaller rejectSelfMod med eksakt id-en", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "/avvis selfmod-456" }]]);
    await poller().poll();
    expect(recorded.reject).toEqual(["selfmod-456"]);
    expect(recorded.sent).toEqual(["Avvist: selfmod-456"]);
  });

  it("A3: ekstra whitespace/tekst etter id-en ignoreres (kun første token brukes som id)", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "/godkjenn   selfmod-789   fordi jeg vil det" }]]);
    await poller().poll();
    expect(recorded.approve).toEqual(["selfmod-789"]);
  });
});

describe("D-214 B: manglende id svarer med bruksmelding, kaller ALDRI handleren med en tom streng", () => {
  it("B1: '/godkjenn' uten argument", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "/godkjenn" }]]);
    await poller().poll();
    expect(recorded.approve).toEqual([]);
    expect(recorded.sent).toEqual(["Bruk: /godkjenn <request_id>"]);
  });

  it("B2: '/avvis' etterfulgt av kun whitespace", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "/avvis    " }]]);
    await poller().poll();
    expect(recorded.reject).toEqual([]);
    expect(recorded.sent).toEqual(["Bruk: /avvis <request_id>"]);
  });
});

describe("D-214 C: fail-closed uendret - fremmede chat-ID-er utløser fortsatt ingenting", () => {
  it("C1: en fremmed chat sin /godkjenn kaller ALDRI handleren", async () => {
    stubUpdates([[{ update_id: 1, chat: FOREIGN, text: "/godkjenn selfmod-999" }]]);
    await poller().poll();
    expect(recorded.approve).toEqual([]);
    expect(recorded.sent).toEqual([]);
  });
});

describe("D-214 D: udefinerte handlere - polleren oppfører seg som før D-214", () => {
  it("D1: uten approveSelfMod/rejectSelfMod konfigurert faller '/godkjenn'-tekst gjennom til chat", async () => {
    stubUpdates([[{ update_id: 1, chat: OWNER, text: "/godkjenn selfmod-1" }]]);
    // Kommandoprefikset '/' betyr at teksten uansett IKKE når `chat`
    // (samme presedens som en ukjent /kommando i D-125 C3) - verifiser at
    // det heller ikke krasjer og ikke kaller noen selvmod-handler.
    // Bygger handlers-objektet direkte (ikke via poller()s override-sammenslåing)
    // fordi `exactOptionalPropertyTypes` gjør `{ approveSelfMod: undefined }`
    // til en typefeil - et valgfritt felt betyr "kan mangle", ikke "kan være undefined".
    const p = new TelegramCommandPoller(TOKEN, OWNER, {
      brief: async () => "BRIEF",
      status: async () => "STATUS",
      chat: async () => { recorded.chat++; return undefined; }
    }, async (text: string) => { recorded.sent.push(text); });
    await p.poll();
    expect(recorded.chat).toBe(0);
    expect(recorded.sent).toEqual([]);
  });
});
