import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  AmbiguousProviderResponseError,
  CardService,
  FinanceKillSwitchActiveError,
  FinanceService,
  ProviderOutcomeUnknownError,
  SubmitInFlightError,
  WallesterApiError,
  WallesterCredentialsUnavailableError,
  type CreateWallesterCardInput,
  type WallesterCardObject,
  type WallesterCredentials,
  type WallesterGateway
} from "../src/index.ts";
import { Gate, timeoutError } from "./wpf1-fakes.ts";

/**
 * WP-FIN2 K8 (D-486): `CardService.submitCard` er reserve-then-execute. Før: den låste raden, committet og kalte `createCard` UTEN reservasjon, så to samtidige kall (eller en
 * retry etter tidsavbrudd) kunne opprette to kort hos Wallester. Nå: markøren (`submitted_at` på kortet, tilstand `draft`, ingen `provider_card_id`) committes FØR leverandørkallet;
 *   - to samtidige kall = ETT leverandørkall (det andre får `submit_in_flight`),
 *   - ukjent utfall (tidsavbrudd/5xx/uklassifisert) = flagg `CARD_SUBMIT_OUTCOME_UNKNOWN` + `outcome_unknown:` og ny innsending blokkeres `submit_outcome_unknown_reconcile_required`,
 *   - entydig avvisning (4xx) rydder markøren: kortet er et rent `draft` uten flagg og en korrigert retry er trygg.
 * Ingen oppslag mot leverandøren (Wallester-oppførsel er `unverified`). Mot ekte Postgres; leverandøren er en testdobler.
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-fin2-card";
const creds: WallesterCredentials = { baseUrl: "https://wallester.invalid", apiKey: "fixture-key", sign: () => "sig", accountId: "wacc-fin2", environment: "sandbox" };

class CardGateway implements WallesterGateway {
  createCalls: CreateWallesterCardInput[] = [];
  gate: Gate | null = null;
  onCreate: () => Promise<WallesterCardObject> = async () => ({ id: `wcard-${randomUUID()}`, status: "active", maskedCardNumber: "…4321", accountId: "wacc-fin2", tokenizationStatus: null });
  async createCard(input: CreateWallesterCardInput): Promise<WallesterCardObject> {
    this.createCalls.push(input);
    if (this.gate) await this.gate.promise;
    return this.onCreate();
  }
  getCard = async (): Promise<never> => { throw new Error("unexpected"); };
  activateCard = async (): Promise<never> => { throw new Error("unexpected"); };
  blockCard = async (): Promise<never> => { throw new Error("unexpected"); };
  unblockCard = async (): Promise<never> => { throw new Error("unexpected"); };
  closeCard = async (): Promise<never> => { throw new Error("unexpected"); };
  updateCardLimits = async (): Promise<never> => { throw new Error("unexpected"); };
  listAuthorizations = async (): Promise<never> => { throw new Error("unexpected"); };
  listTransactions = async (): Promise<never> => { throw new Error("unexpected"); };
  getAccountBalance = async (): Promise<never> => { throw new Error("unexpected"); };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-card-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_fin2_card LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_fin2_card");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'FIN2 card', 'business')`);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ('person-fin2-owner', 'Owner FIN2') ON CONFLICT DO NOTHING");
  appPool = createPool({ ...base, user: "jarvis_fin2_card", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

function cardService(gateway: CardGateway, opts: { leaseMs?: number; credentials?: boolean } = {}): CardService {
  return new CardService(
    appPool, { getCredentials: async () => (opts.credentials === false ? null : creds) }, () => gateway, () => null, () => TENANT,
    opts.leaseMs !== undefined ? { submitLeaseMs: opts.leaseMs } : {}
  );
}
async function draft(cards: CardService, cardType: "virtual" | "physical" = "virtual") {
  return cards.createCard(TENANT, "business", { idempotency_key: `card-idem-${randomUUID()}`, name: "FIN2-kort", purpose: "Test", card_type: cardType, currency: "EUR" });
}
const cardRow = async (id: string) => (await adminPool.query("SELECT state, provider_card_id, submitted_at, anomaly_flags FROM provider_cards WHERE card_id = $1", [id])).rows[0] as {
  state: string; provider_card_id: string | null; submitted_at: Date | null; anomaly_flags: string[];
};
const cardEvents = async (id: string) => ((await adminPool.query("SELECT event_type, detail FROM card_events WHERE card_id = $1 ORDER BY created_at", [id])).rows as Array<{ event_type: string; detail: Record<string, unknown> }>);
const waitFor = async (cond: () => boolean, ms = 5_000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("waitFor_timeout"); await new Promise((r) => setTimeout(r, 10)); } };

describe("K8: to samtidige submitCard = ETT leverandørkall", () => {
  it("mens første kall henger hos leverandøren avvises det andre som `submit_in_flight` - ingen duplikatkort", async () => {
    const gw = new CardGateway();
    gw.gate = new Gate();
    const cards = cardService(gw);
    const card = await draft(cards);
    const first = cards.submitCard(TENANT, "business", card.card_id);
    await waitFor(() => gw.createCalls.length === 1);
    const second = await cards.submitCard(TENANT, "business", card.card_id).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(SubmitInFlightError);
    expect(gw.createCalls).toHaveLength(1);
    gw.gate.open();
    const done = await first;
    expect(done.provider_card_id).not.toBeNull();
    expect(done.state).toBe("active");
    expect(gw.createCalls).toHaveLength(1);
  });

  it("20 runder med fire samtidige kall: aldri mer enn ett leverandørkall per kort, og alle ferdige svar peker på samme provider-kort", async () => {
    for (let round = 0; round < 20; round++) {
      const gw = new CardGateway();
      const cards = cardService(gw);
      const card = await draft(cards);
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => cards.submitCard(TENANT, "business", card.card_id)));
      expect(gw.createCalls.length, `runde ${round}`).toBe(1);
      const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<CardService["submitCard"]>>> => r.status === "fulfilled");
      expect(fulfilled.length, `runde ${round}`).toBeGreaterThanOrEqual(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason, `runde ${round}`).toBeInstanceOf(SubmitInFlightError);
      expect(new Set(fulfilled.map((r) => r.value.provider_card_id)).size, `runde ${round}`).toBe(1);
      expect((await cardRow(card.card_id)).provider_card_id).not.toBeNull();
    }
  }, 120_000);

  it("en retry etter fullført innsending er et idempotent no-op (ingen nytt leverandørkall)", async () => {
    const gw = new CardGateway();
    const cards = cardService(gw);
    const card = await draft(cards);
    const first = await cards.submitCard(TENANT, "business", card.card_id);
    const again = await cards.submitCard(TENANT, "business", card.card_id);
    expect(again.provider_card_id).toBe(first.provider_card_id);
    expect(gw.createCalls).toHaveLength(1);
  });
});

describe("K8: ukjent utfall = flagg + blokkert retry; entydig avvisning = rent draft", () => {
  for (const [label, makeError] of [
    ["tidsavbrudd", () => timeoutError()],
    ["avbrutt av kallsignalet", () => Object.assign(new Error("tool_timeout"), { name: "Error" })],
    ["5xx fra leverandøren", () => new WallesterApiError("wallester_api_failed_503:boom", 503, false)],
    ["nettverksfeil etter sending (socket nullstilt)", () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })],
    ["uklassifiserbar feil", () => new Error("something_unexpected")]
  ] as const) {
    it(`${label}: ProviderOutcomeUnknownError + CARD_SUBMIT_OUTCOME_UNKNOWN, kortet står som draft uten provider-id, og NY innsending blokkeres uten leverandørkall`, async () => {
      const gw = new CardGateway();
      gw.onCreate = async () => { throw makeError(); };
      const cards = cardService(gw);
      const card = await draft(cards);
      const first = await cards.submitCard(TENANT, "business", card.card_id).catch((e: unknown) => e);
      expect(first).toBeInstanceOf(ProviderOutcomeUnknownError);
      expect((first as Error).message).toMatch(/^outcome_unknown:/);
      const row = await cardRow(card.card_id);
      expect(row.state).toBe("draft");
      expect(row.provider_card_id).toBeNull();
      expect(row.anomaly_flags).toContain("CARD_SUBMIT_OUTCOME_UNKNOWN");
      const events = await cardEvents(card.card_id);
      expect(events.find((e) => e.event_type === "provider_error")?.detail).toMatchObject({ phase: "submit", outcome: "unknown" });
      expect(JSON.stringify(events)).not.toContain("boom"); // aldri leverandørtekst i hendelsen

      const retry = await cards.submitCard(TENANT, "business", card.card_id).catch((e: unknown) => e);
      expect(retry).toBeInstanceOf(AmbiguousProviderResponseError);
      expect((retry as AmbiguousProviderResponseError).detail).toBe("submit_outcome_unknown_reconcile_required");
      expect(gw.createCalls).toHaveLength(1); // ingen ny leverandørhandling
    });
  }

  it("4xx (entydig avvist): rå feil videre, kortet er et rent draft UTEN flagg og UTEN markør, og en korrigert retry går gjennom", async () => {
    const gw = new CardGateway();
    gw.onCreate = async () => { throw new WallesterApiError("wallester_api_failed_422:ugyldig", 422, false); };
    const cards = cardService(gw);
    const card = await draft(cards);
    await expect(cards.submitCard(TENANT, "business", card.card_id)).rejects.toThrow(WallesterApiError);
    const row = await cardRow(card.card_id);
    expect(row.state).toBe("draft");
    expect(row.anomaly_flags).not.toContain("CARD_SUBMIT_OUTCOME_UNKNOWN");
    expect(row.submitted_at).toBeNull();
    gw.onCreate = async () => ({ id: `wcard-${randomUUID()}`, status: "active", maskedCardNumber: "…4321", accountId: "wacc-fin2", tokenizationStatus: null });
    const retried = await cards.submitCard(TENANT, "business", card.card_id);
    expect(retried.state).toBe("active");
    expect(gw.createCalls).toHaveLength(2);
  });

  it("429 regnes som avvist FØR behandling (rydder), 409/408 som ukjent", async () => {
    for (const [status, expected] of [[429, "clean"], [408, "unknown"], [409, "unknown"]] as const) {
      const gw = new CardGateway();
      gw.onCreate = async () => { throw new WallesterApiError(`wallester_api_failed_${status}:x`, status, false); };
      const cards = cardService(gw);
      const card = await draft(cards);
      await cards.submitCard(TENANT, "business", card.card_id).catch(() => undefined);
      const flags = (await cardRow(card.card_id)).anomaly_flags;
      expect(flags.includes("CARD_SUBMIT_OUTCOME_UNKNOWN"), String(status)).toBe(expected === "unknown");
    }
  });

  it("fysisk kort (transporten kaster FØR noe sendes): entydig ikke utført - ingen flagg, ingen markør", async () => {
    const gw = new CardGateway();
    gw.onCreate = async () => { throw new WallesterApiError("wallester_physical_card_delivery_fields_unavailable", 0, false); };
    const cards = cardService(gw);
    const card = await draft(cards, "physical");
    await expect(cards.submitCard(TENANT, "business", card.card_id)).rejects.toThrow("wallester_physical_card_delivery_fields_unavailable");
    const row = await cardRow(card.card_id);
    expect(row.anomaly_flags).toEqual([]);
    expect(row.submitted_at).toBeNull();
  });

  it("manglende credential: kastes som før og reservasjonen frigis (ingen markør står igjen)", async () => {
    const gw = new CardGateway();
    const noCreds = cardService(gw, { credentials: false });
    const card = await draft(noCreds);
    await expect(noCreds.submitCard(TENANT, "business", card.card_id)).rejects.toThrow(WallesterCredentialsUnavailableError);
    const row = await cardRow(card.card_id);
    expect(row.submitted_at).toBeNull();
    expect(row.anomaly_flags).toEqual([]);
    expect(gw.createCalls).toHaveLength(0);
    // credential kommer tilbake: retry går gjennom
    const withCreds = cardService(gw);
    expect((await withCreds.submitCard(TENANT, "business", card.card_id)).state).toBe("active");
  });

  it("nødbryteren blokkerer FØR reservasjon (ingen markør, ingen kall)", async () => {
    const gw = new CardGateway();
    const cards = cardService(gw);
    const finance = new FinanceService(appPool);
    const card = await draft(cards);
    await finance.enableKillSwitch(TENANT, "person-fin2-owner", "fin2 test");
    try {
      await expect(cards.submitCard(TENANT, "business", card.card_id)).rejects.toThrow(FinanceKillSwitchActiveError);
    } finally {
      await finance.disableKillSwitch(TENANT, "person-fin2-owner");
    }
    expect((await cardRow(card.card_id)).submitted_at).toBeNull();
    expect(gw.createCalls).toHaveLength(0);
  });
});

describe("K8: reservasjonens levetid og lagringsfeil etter leverandørsvar", () => {
  it("en reservasjon uten svar etter at leasen er utløpt (prosess døde) krever avstemming - aldri automatisk ny innsending (Wallester-idempotens er uverifisert)", async () => {
    const gw = new CardGateway();
    const cards = cardService(gw, { leaseMs: 50 });
    const card = await draft(cards);
    await adminPool.query("UPDATE provider_cards SET submitted_at = now() - interval '1 minute' WHERE card_id = $1", [card.card_id]);
    const err = await cards.submitCard(TENANT, "business", card.card_id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousProviderResponseError);
    expect(gw.createCalls).toHaveLength(0);
  });

  it("en ny reservasjon (innenfor leasen) regnes som pågående", async () => {
    const gw = new CardGateway();
    const cards = cardService(gw);
    const card = await draft(cards);
    await adminPool.query("UPDATE provider_cards SET submitted_at = now() WHERE card_id = $1", [card.card_id]);
    await expect(cards.submitCard(TENANT, "business", card.card_id)).rejects.toBeInstanceOf(SubmitInFlightError);
    expect(gw.createCalls).toHaveLength(0);
  });

  it("leverandøren OPPRETTET kortet men lagringen feilet (utløser): ukjent utfall + flagg, retry blokkert (kortet finnes hos Wallester)", async () => {
    const gw = new CardGateway();
    const cards = cardService(gw);
    const card = await draft(cards);
    await adminPool.query(`
      CREATE OR REPLACE FUNCTION fin2_fail_card_submitted() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.provider_card_id IS NOT NULL AND OLD.provider_card_id IS NULL THEN RAISE EXCEPTION 'fin2_forced_card_store_failure'; END IF; RETURN NEW; END $f$`);
    await adminPool.query("CREATE TRIGGER fin2_fail_card_store BEFORE UPDATE ON provider_cards FOR EACH ROW EXECUTE FUNCTION fin2_fail_card_submitted()");
    try {
      const err = await cards.submitCard(TENANT, "business", card.card_id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderOutcomeUnknownError);
      expect((err as Error).message).toMatch(/^outcome_unknown:provider_call_completed_local_write_failed/);
    } finally {
      await adminPool.query("DROP TRIGGER fin2_fail_card_store ON provider_cards");
    }
    const row = await cardRow(card.card_id);
    expect(row.provider_card_id).toBeNull();
    expect(row.anomaly_flags).toContain("CARD_SUBMIT_OUTCOME_UNKNOWN");
    await expect(cards.submitCard(TENANT, "business", card.card_id)).rejects.toBeInstanceOf(AmbiguousProviderResponseError);
    expect(gw.createCalls).toHaveLength(1);
  });

  it("kontroll: normal innsending lagrer provider-id, rydder markør og flagg og skriver `submitted`-hendelsen", async () => {
    const gw = new CardGateway();
    const cards = cardService(gw);
    const card = await draft(cards);
    await cards.submitCard(TENANT, "business", card.card_id);
    const row = await cardRow(card.card_id);
    expect(row.provider_card_id).not.toBeNull();
    expect(row.anomaly_flags).not.toContain("CARD_SUBMIT_OUTCOME_UNKNOWN");
    expect((await cardEvents(card.card_id)).map((e) => e.event_type)).toContain("submitted");
  });
});
