import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { FinanceService } from "../src/service.ts";
import { StripeTransport } from "../src/stripe-transport.ts";
import { VippsTransport } from "../src/vipps-transport.ts";
import { fikenAccessToken, resetFikenAccessTokenCache } from "../src/fiken-transport.ts";

/**
 * WP-SEC2 fiks-runde 1 (review B, M3 + L3): ATFERDSTEST av finans-stedene der leverandørtekst blir feilmelding, `failure_reason` eller logg. Leverandøren (en stubbet `fetch`) svarer med en feilkropp som bærer et SYNTETISK token
 * (bygget sammensatt ved kjøring). Både «token helt innenfor 200 tegn» (en mutant uten skanning lekker) og «token som krysser 200-tegnsgrensen» (kutt-før-skann lar et halvt token stå) sjekkes.
 */
const TOKEN = ["gh", "p_"].join("") + "Zx3Qk9Lm2Vb7Nc4Rt8Wy1Hd5Fs6Jg0Pa8TnX";
const LEAK_PARTS = [TOKEN, TOKEN.slice(0, 12), "Zx3Qk9Lm2Vb7"];
const MARK = "[REDACTED:github_token]";
const clean = (value: unknown, label: string): void => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const part of LEAK_PARTS) expect(text, `${label} lekker «${part}»`).not.toContain(part);
};
/** Token helt innenfor de første 200 tegnene / token som begynner på tegn 186 (kuttet ved 200 ville latt 14 token-tegn stå). */
const inside = (): string => `invalid credentials ${TOKEN} rejected`;
const straddle = (): string => `${"x".repeat(185)} ${TOKEN} slutt`;

function stubFetch(status: number, bodyText: string, contentType = "application/json"): void {
  vi.stubGlobal("fetch", async () => new Response(bodyText, { status, headers: { "content-type": contentType } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetFikenAccessTokenCache();
});

describe("F9 + Stripe `trimmed`: Stripe-feilkroppen er skannet før den kuttes", () => {
  const call = async (body: string): Promise<string> => {
    stubFetch(401, body);
    try { await new StripeTransport("sk_test_dummy").getBalance(); } catch (err) { return (err as Error).message; }
    throw new Error("forventet en feil");
  };
  it("JSON `error.message` med token (F9) og rå kropp med token innenfor/over 200 tegn (else-grenen) er redigert", async () => {
    const jsonMessage = await call(JSON.stringify({ error: { type: "invalid_request_error", message: inside() } }));
    clean(jsonMessage, "stripe json");
    expect(jsonMessage).toBe(`stripe_api_failed_401:invalid credentials ${MARK} rejected`);
    for (const raw of [inside(), straddle()]) clean(await call(raw), `stripe raw ${raw.length}`);
    expect(await call(inside())).toContain(MARK);
  });
});

describe("Vipps: detail/title/rå kropp er skannet før de kuttes (tidligere `.slice(0, 200)` uten skanning)", () => {
  const call = async (body: string): Promise<string> => {
    stubFetch(401, body);
    try { await new VippsTransport("id", "secret", "sub", "msn", "test").checkCredentials(); } catch (err) { return (err as Error).message; }
    throw new Error("forventet en feil");
  };
  it("detail, title og rå kropp (innenfor og over 200 tegn) er redigert", async () => {
    const withDetail = await call(JSON.stringify({ title: "Unauthorized", detail: inside() }));
    clean(withDetail, "vipps detail");
    expect(withDetail).toBe(`vipps_access_token_failed_401:invalid credentials ${MARK} rejected`);
    const withTitle = await call(JSON.stringify({ title: inside() }));
    clean(withTitle, "vipps title");
    expect(withTitle).toContain(MARK);
    for (const raw of [inside(), straddle(), JSON.stringify({ detail: straddle() })]) clean(await call(raw), `vipps raw ${raw.length}`);
  });
});

describe("Fiken: token-utvekslingens feilkropp er skannet før den kuttes", () => {
  it("rå kropp med token innenfor og over 200 tegn er redigert", async () => {
    vi.stubEnv("JARVIS_FIKEN_CLIENT_ID", "id");
    vi.stubEnv("JARVIS_FIKEN_CLIENT_SECRET", "secret");
    for (const raw of [inside(), straddle()]) {
      stubFetch(400, raw, "text/plain");
      let message = "";
      try { await fikenAccessToken(`refresh-${raw.length}`); } catch (err) { message = (err as Error).message; }
      expect(message.startsWith("fiken_auth_failed_400:"), message).toBe(true);
      clean(message, `fiken raw ${raw.length}`);
    }
  });
});

describe("F1 (white-box): frigivelse av en barne-reservasjon lagrer en redigert `failure_reason`", () => {
  it("`releaseChildReservation(not_executed)` skriver `clipRedacted(reason, 200)`, aldri rå tekst", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = { query: async (sql: string, params?: unknown[]) => { queries.push({ sql, params: params ?? [] }); return { rows: [], rowCount: 0 }; } } as unknown as pg.PoolClient;
    const service = new FinanceService({} as pg.Pool);
    await (service as unknown as { releaseChildReservation: (c: pg.PoolClient, table: string, tenant: string, id: string, cls: string, reason: string) => Promise<void> })
      .releaseChildReservation(client, "stripe_refunds", "tenant-x", "id-1", "not_executed", `provider said ${TOKEN}`);
    expect(queries).toHaveLength(1);
    clean(queries[0]?.params, "failure_reason");
    expect(queries[0]?.params[2]).toBe(`provider said ${MARK}`);
  });
});
