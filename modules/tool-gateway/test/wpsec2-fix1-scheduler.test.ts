import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { DAILY_SCHEDULER_MAX_ATTEMPTS, DailyScheduler } from "../src/scheduler.ts";

/**
 * WP-SEC2 fiks-runde 1 (review B, M3): ATFERDSTEST av `DailyScheduler`-stedene der en feiltekst lagres (`scheduler_state.last_error`) eller logges. Ingen database: en fake pool fanger spørringsparametrene.
 * Feilteksten bærer et SYNTETISK token (bygget sammensatt ved kjøring).
 */
const TOKEN = ["gh", "p_"].join("") + "Zx3Qk9Lm2Vb7Nc4Rt8Wy1Hd5Fs6Jg0Pa8TnX";
const MARK = "[REDACTED:github_token]";
const clean = (value: unknown, label: string): void => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const part of [TOKEN, TOKEN.slice(0, 12), "Zx3Qk9Lm2Vb7"]) expect(text, `${label} lekker «${part}»`).not.toContain(part);
};

afterEach(() => vi.restoreAllMocks());

function fakePool(attempts: number): { pool: pg.Pool; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { query: async (sql: string, params?: unknown[]) => { queries.push({ sql: String(sql), params: params ?? [] }); return { rows: [{ attempts }], rowCount: 1 }; } } as unknown as pg.Pool;
  return { pool, queries };
}

describe("SCH1/SCH2: markFailed lagrer og logger en redigert feiltekst", () => {
  it("last_error (clipRedacted 300) er redigert, også når tokenet krysser 300-tegnsgrensen", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { pool, queries } = fakePool(1);
    const scheduler = new DailyScheduler(pool, "fix1-job", 7);
    await scheduler.markFailed(`brief feilet: upstream 401 ${TOKEN} avvist`);
    const stored = String(queries[0]?.params[3]);
    clean(stored, "last_error");
    expect(stored).toBe(`brief feilet: upstream 401 ${MARK} avvist`);
    await scheduler.markFailed(`${"x".repeat(285)} ${TOKEN}`);
    const stored2 = String(queries[1]?.params[3]);
    clean(stored2, "last_error (kryss)");
    expect(stored2.length).toBeLessThanOrEqual(300);
  });
  it("gir opp etter siste forsøk: loggen `daily_scheduler_gave_up` har en redigert feiltekst (SCH2)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { pool } = fakePool(DAILY_SCHEDULER_MAX_ATTEMPTS);
    await new DailyScheduler(pool, "fix1-job", 7).markFailed(`brief feilet: upstream 401 ${TOKEN} avvist`);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("daily_scheduler_gave_up");
    clean(logged, "console.error");
    expect(logged).toContain(MARK);
  });
  it("sikkerhetsnettet i start() (`daily_scheduler_tick_failed`) logger en redigert feiltekst", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = { query: async () => { throw new Error(`db: password authentication failed for ${TOKEN}`); } } as unknown as pg.Pool;
    const timer = new DailyScheduler(pool, "fix1-job", 0).start(async () => undefined, 5, 60_000); // time 0: claim forsøkes uansett klokkeslett
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled(), { timeout: 3000 });
    clearInterval(timer);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("daily_scheduler_tick_failed");
    clean(logged, "tick-failed");
    expect(logged).toContain(MARK);
  });
});
