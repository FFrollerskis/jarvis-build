import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramCommandPoller, type TelegramOffsetStore, type TelegramPollFailure } from "../src/live-transports.ts";

/** Del 3 (JARVIS-024): timeout, varsling ved feil, holdbar offset og avsender-/chat-type-binding. Ingen ekte nettverk. */
const OWNER = "987654321";
const TOKEN = "test-token-not-a-secret";

type Upd = { update_id: number; chat: number; type?: string; from?: number | null; text: string };
function response(updates: Upd[]): Response {
  return {
    ok: true,
    json: async () => ({
      result: updates.map((u) => ({
        update_id: u.update_id,
        message: {
          chat: { id: u.chat, type: u.type ?? "private" },
          ...(u.from === null ? {} : { from: { id: u.from ?? u.chat } }),
          text: u.text
        }
      }))
    })
  } as unknown as Response;
}

class MemoryOffsetStore implements TelegramOffsetStore {
  saved: number[] = [];
  constructor(public value = 0, private readonly failSave = false, private readonly failLoad = false) {}
  async load() {
    if (this.failLoad) throw new Error("db_down");
    return this.value;
  }
  async save(n: number) {
    if (this.failSave) throw new Error("db_down");
    this.value = n;
    this.saved.push(n);
  }
}

function make(opts: { store?: TelegramOffsetStore; failures?: TelegramPollFailure[]; chats?: string[]; sent?: string[] } = {}) {
  return new TelegramCommandPoller(
    TOKEN,
    OWNER,
    {
      brief: async () => "brief",
      status: async () => "status",
      chat: async ({ text }) => {
        opts.chats?.push(text);
        return "svar";
      }
    },
    async (t) => void opts.sent?.push(t),
    { ...(opts.store ? { offsetStore: opts.store } : {}), onFailure: (f) => void opts.failures?.push(f), fetchTimeoutMs: 50 }
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("feilhåndtering er aldri stille", () => {
  it("non-2xx fra getUpdates varsles (kind=http_status, status, consecutive teller) og nullstilles ved suksess", async () => {
    const failures: TelegramPollFailure[] = [];
    let call = 0;
    vi.stubGlobal("fetch", async () => (call++ < 2 ? ({ ok: false, status: 502 } as unknown as Response) : response([])));
    const p = make({ failures });
    await p.poll();
    await p.poll();
    await p.poll();
    expect(failures.map((f) => [f.kind, f.status, f.consecutive])).toEqual([["http_status", 502, 1], ["http_status", 502, 2]]);
  });

  it("en hengende fetch avbrytes av timeout og slipper poll-låsen (neste runde kjører)", async () => {
    const failures: TelegramPollFailure[] = [];
    let call = 0;
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      call++;
      if (call === 1) {
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      }
      return Promise.resolve(response([]));
    });
    const p = make({ failures });
    await p.poll();
    expect(failures[0]).toMatchObject({ kind: "timeout" });
    await p.poll(); // låsen er sluppet
    expect(call).toBe(2);
  });

  it("ugyldig JSON-kropp varsles og stopper runden", async () => {
    const failures: TelegramPollFailure[] = [];
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) as unknown as Response);
    await make({ failures }).poll();
    expect(failures[0]).toMatchObject({ kind: "invalid_body" });
  });
});

describe("holdbar offset", () => {
  it("offset leses ved første poll og brukes i getUpdates (restart spiller ikke av gamle meldinger)", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => (urls.push(url), response([])));
    await make({ store: new MemoryOffsetStore(500) }).poll();
    expect(urls[0]).toContain("offset=500");
  });

  it("offset lagres ETTER behandling, også for forkastede (fremmede) oppdateringer", async () => {
    const store = new MemoryOffsetStore(0);
    const chats: string[] = [];
    vi.stubGlobal("fetch", async () => response([{ update_id: 10, chat: 1, text: "fremmed" }, { update_id: 11, chat: Number(OWNER), text: "hei" }]));
    await make({ store, chats }).poll();
    expect(chats).toEqual(["hei"]);
    expect(store.saved).toEqual([11, 12]);
    expect(store.value).toBe(12);
  });

  it("lagringsfeil varsles (offset_save) men blokkerer ikke behandlingen", async () => {
    const failures: TelegramPollFailure[] = [];
    const chats: string[] = [];
    vi.stubGlobal("fetch", async () => response([{ update_id: 1, chat: Number(OWNER), text: "hei" }]));
    await make({ store: new MemoryOffsetStore(0, true), failures, chats }).poll();
    expect(chats).toEqual(["hei"]);
    expect(failures.some((f) => f.kind === "offset_save")).toBe(true);
  });

  it("kan ikke lese offset => ingen polling (heller stille enn avspilling), og varsel offset_load", async () => {
    const failures: TelegramPollFailure[] = [];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await make({ store: new MemoryOffsetStore(0, false, true), failures }).poll();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(failures[0]).toMatchObject({ kind: "offset_load" });
  });

  it("restart-scenario: ny poller med samme store henter fra lagret offset og behandler ikke samme melding to ganger", async () => {
    const store = new MemoryOffsetStore(0);
    const chats: string[] = [];
    let served = false;
    vi.stubGlobal("fetch", async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const all = [{ update_id: 5, chat: Number(OWNER), text: "en gang" }].filter((u) => u.update_id >= offset);
      served = true;
      return response(all);
    });
    await make({ store, chats }).poll();
    await make({ store, chats }).poll(); // «restart»
    expect(served).toBe(true);
    expect(chats).toEqual(["en gang"]);
  });
});

describe("avsender- og chat-type-binding (chat-id alene er ikke nok)", () => {
  const cases: Array<[string, Upd]> = [
    ["gruppe-chat med eierens chat-id", { update_id: 1, chat: Number(OWNER), type: "group", text: "x" }],
    ["supergruppe", { update_id: 2, chat: Number(OWNER), type: "supergroup", text: "x" }],
    ["manglende avsender (from)", { update_id: 3, chat: Number(OWNER), from: null, text: "x" }],
    ["annen avsender i eierens chat", { update_id: 4, chat: Number(OWNER), from: 4242, text: "x" }],
    ["manglende chat-type", { update_id: 5, chat: Number(OWNER), type: "", text: "x" }]
  ];
  for (const [name, update] of cases) {
    it(`avvises: ${name}`, async () => {
      const chats: string[] = [];
      const sent: string[] = [];
      vi.stubGlobal("fetch", async () => response([update]));
      await make({ chats, sent }).poll();
      expect(chats).toEqual([]);
      expect(sent).toEqual([]);
    });
  }
  it("godtas: privat chat, eierens from.id", async () => {
    const chats: string[] = [];
    vi.stubGlobal("fetch", async () => response([{ update_id: 9, chat: Number(OWNER), text: "hei" }]));
    await make({ chats }).poll();
    expect(chats).toEqual(["hei"]);
  });
});
