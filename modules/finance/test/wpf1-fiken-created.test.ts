import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FikenTransport, readCreatedJournalEntry, resetFikenAccessTokenCache } from "../src/index.ts";

/**
 * WP-F1 (D-462): svaret på `POST generalJournalEntries` er ikke verifisert mot Fikens primærdokumentasjon - kropp med `journalEntryId` ELLER kun `Location`. Tolkes konservativt;
 * uten sikker id er utfallet UKJENT (`outcome_unknown:`), aldri en gjettet id og aldri en ny postering. Ingen nettverk (stubbet `fetch`).
 */
const input = { description: "Husleie [J:abcdef123456]", date: "2026-10-09" };
const res = (text: string, location?: string) => ({ text: async () => text, headers: { get: (n: string) => (n.toLowerCase() === "location" && location !== undefined ? location : null) } });

describe("A: readCreatedJournalEntry - sikker id eller ukjent utfall", () => {
  it("JSON-kropp med journalEntryId (tall eller rent sifferstreng) gir id", async () => {
    expect(await readCreatedJournalEntry(res('{"journalEntryId": 4321}'), input)).toEqual({ journalEntryId: 4321, description: input.description, date: input.date });
    expect((await readCreatedJournalEntry(res('{"journalEntryId": "99"}'), input)).journalEntryId).toBe(99);
  });

  it("kun Location som ender på /journalEntries/<tall> eller /generalJournalEntries/<tall> gir id (query og avsluttende skråstrek tåles)", async () => {
    expect((await readCreatedJournalEntry(res("", "https://api.fiken.no/api/v2/companies/firma/journalEntries/777"), input)).journalEntryId).toBe(777);
    expect((await readCreatedJournalEntry(res("", "https://api.fiken.no/api/v2/companies/firma/generalJournalEntries/778/?x=1"), input)).journalEntryId).toBe(778);
  });

  it("ingen sikker id -> outcome_unknown (aldri en gjettet id fra en annen ressurs, aldri 0/negativ/flyttall/tekst)", async () => {
    for (const bad of [
      res(""), res("   "), res("{}"), res('{"journalEntryId": 0}'), res('{"journalEntryId": -5}'), res('{"journalEntryId": 1.5}'), res('{"journalEntryId": "abc"}'),
      res("ikke json"), res('{"journalEntryId": 1e400}'),
      res("", "https://api.fiken.no/api/v2/companies/firma/transactions/555"), // siste sti-del er en ANNEN ressurs
      res("", "https://api.fiken.no/api/v2/companies/firma/journalEntries/0"),
      res("", "https://api.fiken.no/api/v2/companies/firma/journalEntries/abc"),
      res("", "https://api.fiken.no/api/v2/companies/firma/journalEntries/12345678901234567890")
    ]) {
      await expect(readCreatedJournalEntry(bad, input)).rejects.toThrow(/^outcome_unknown:fiken_created_without_journal_entry_id/);
    }
    await expect(readCreatedJournalEntry({ text: async () => { throw new Error("stream"); } }, input)).rejects.toThrow(/^outcome_unknown:/);
  });
});

describe("B: transporten - 201 uten kropp + Location virker; 201 uten noe er ukjent utfall og sendes aldri to ganger", () => {
  beforeEach(() => {
    resetFikenAccessTokenCache();
    vi.stubEnv("JARVIS_FIKEN_CLIENT_ID", "client-fixture");
    vi.stubEnv("JARVIS_FIKEN_CLIENT_SECRET", "secret-fixture");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  const stub = (post: { status: number; body: string; location?: string }) => {
    const spy = vi.fn(async (url: string) => {
      if (!String(url).includes("generalJournalEntries")) return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }), text: async () => "" } as unknown as Response;
      return { ok: post.status >= 200 && post.status < 300, status: post.status, text: async () => post.body, headers: new Headers(post.location ? { location: post.location } : {}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  };
  const lines = [{ account: "6300", amount: 100 }, { account: "1920", amount: -100 }];

  it("201 med JSON-kropp og 201 med kun Location gir journalpost-id", async () => {
    stub({ status: 201, body: '{"journalEntryId": 31337}' });
    expect((await new FikenTransport("tok", "firma").createGeneralJournalEntry({ ...input, lines })).journalEntryId).toBe(31337);
    resetFikenAccessTokenCache();
    stub({ status: 201, body: "", location: "https://api.fiken.no/api/v2/companies/firma/journalEntries/4242" });
    expect((await new FikenTransport("tok", "firma").createGeneralJournalEntry({ ...input, lines })).journalEntryId).toBe(4242);
  });

  it("201 uten id: ukjent utfall (kaster outcome_unknown), og POST-en sendes nøyaktig ÉN gang", async () => {
    const spy = stub({ status: 201, body: "" });
    await expect(new FikenTransport("tok", "firma").createGeneralJournalEntry({ ...input, lines })).rejects.toThrow(/^outcome_unknown:/);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes("generalJournalEntries"))).toHaveLength(1);
  });

  it("GET-lesinger er uendret (JSON-kropp) - og en 204 gir undefined som før", async () => {
    resetFikenAccessTokenCache();
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("oauth")) return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }), text: async () => "" } as unknown as Response;
      return { ok: true, status: 200, json: async () => [{ journalEntryId: 1, description: "a", date: "2026-01-01" }], text: async () => "" } as unknown as Response;
    });
    expect(await new FikenTransport("tok", "firma").listJournalEntries()).toEqual([{ journalEntryId: 1, description: "a", date: "2026-01-01" }]);
  });
});
