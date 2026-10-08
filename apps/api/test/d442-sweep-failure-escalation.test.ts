import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { SweepFailureCollector } from "@jarvis/contracts";
import { runBusinessEventSyncForAllTenants, runOpenLoopSweepForAllTenants, runScoringSweepForAllTenants } from "@jarvis/business";
import { runConversationGraphSyncForAllTenants } from "@jarvis/conversation-graph";
import {
  runFinanceSpendIntegritySweepForAllTenants,
  runNeonomicsSweepForAllTenants,
  runStripePaymentSyncForAllTenants,
  runVippsPaymentSyncForAllTenants,
  runWallesterSweepForAllTenants
} from "@jarvis/finance";
import { runActionRecommendationSweepForAllTenants } from "@jarvis/growth";
import { runSupportInboxSyncForAllTenants } from "@jarvis/support";

/**
 * D-442 (JARVIS-027): 13 av 19 daglige jobber kastet per-tenant-feilene (resultatkartet ble forkastet i `main.ts`), så `DailyScheduler` bokførte
 * dagen som fullført selv om en tenant ikke ble behandlet. Hver av sveipene under tar nå en valgfri `SweepFailureCollector`. Kontrakten som testes:
 *  1. en tenant som feiler registreres (riktig tenant og delmengde) i samleren,
 *  2. isolasjonen er UENDRET - de andre tenantene behandles og får sitt ekte resultat,
 *  3. uten samler (eksisterende kallere) oppfører sveipet seg som før - ingen kast.
 */

const TENANTS = ["good", "bad"];

function fakePool(tenants: string[] = TENANTS): pg.Pool {
  return { query: async () => ({ rows: tenants.map((tenant_id) => ({ tenant_id })) }) } as unknown as pg.Pool;
}

const boom = (tenant: string): void => { if (tenant === "bad") throw new Error(`${tenant} feilet`); };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

/** Kjører sveipet med samler og uten, og returnerer samlerens registrerte feil. */
async function failuresOf<R>(run: (failures?: SweepFailureCollector) => Promise<Record<string, R>>): Promise<{ failures: SweepFailureCollector["failures"]; results: Record<string, R> }> {
  const collector = new SweepFailureCollector();
  const results = await run(collector);
  expect(Object.keys(results).sort()).toEqual(["bad", "good"]); // isolasjon: begge tenants har en oppføring
  await expect(run(undefined)).resolves.toBeDefined(); // bakoverkompatibelt: ingen samler = som før
  return { failures: collector.failures, results };
}

describe("D-442: per-tenant-sveip registrerer tenant-feil uten å velte de andre", () => {
  it("scoring-recalc", async () => {
    const scoring = { recalculateTenant: async (t: string) => { boom(t); return { leads: 2, opportunities: 1 }; } };
    const { failures, results } = await failuresOf((f) => runScoringSweepForAllTenants(fakePool(), scoring as never, f));
    expect(failures).toEqual([{ tenant_id: "bad", error: "bad feilet" }]);
    expect(results["good"]).toEqual({ leads: 2, opportunities: 1 });
    expect(results["bad"]).toEqual({ leads: 0, opportunities: 0 });
  });

  it("business-open-loop-sweep", async () => {
    const openLoops = { runSweep: async (t: string) => { boom(t); return { detected: 3, updated: 1, auto_resolved: 0 }; } };
    const { failures, results } = await failuresOf((f) => runOpenLoopSweepForAllTenants(fakePool(), openLoops as never, f));
    expect(failures).toEqual([{ tenant_id: "bad", error: "bad feilet" }]);
    expect(results["good"]).toEqual({ detected: 3, updated: 1, auto_resolved: 0 });
  });

  it("growth-action-recommendation-sweep", async () => {
    const growth = { detectAndRecommendSpendAnomalies: async (t: string) => { boom(t); return { detected: 1, updated: 0, superseded: 0 }; } };
    const { failures, results } = await failuresOf((f) => runActionRecommendationSweepForAllTenants(fakePool(), growth as never, f));
    expect(failures).toEqual([{ tenant_id: "bad", error: "bad feilet" }]);
    expect(results["good"]).toEqual({ detected: 1, updated: 0, superseded: 0 });
  });

  it("conversation-graph-sync (hadde ingen logglinje før - nå både logg og registrering)", async () => {
    const graph = { syncGmailIdentities: async (t: string) => { boom(t); return { scanned: 5, linked: 2 }; } };
    const { failures, results } = await failuresOf((f) => runConversationGraphSyncForAllTenants(fakePool(), graph as never, f));
    expect(failures).toEqual([{ tenant_id: "bad", error: "bad feilet" }]);
    expect(results["good"]).toEqual({ scanned: 5, linked: 2 });
    expect(results["bad"]).toMatchObject({ scanned: 0, linked: 0, error: "bad feilet" });
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("conversation_graph_sync_tenant_failed"))).toBe(true);
  });

  it("support-inbox-sync (hadde ingen logglinje før - nå både logg og registrering)", async () => {
    const support = { ingestFromGmail: async (t: string) => { boom(t); return { scanned: 4, ingested: 1, ignored_not_support: 3, unmatched: 0, ambiguous: 0 }; } };
    const { failures, results } = await failuresOf((f) => runSupportInboxSyncForAllTenants(fakePool(), support as never, f));
    expect(failures).toEqual([{ tenant_id: "bad", error: "bad feilet" }]);
    expect(results["good"]).toMatchObject({ scanned: 4, ingested: 1 });
    expect(results["bad"]).toMatchObject({ scanned: 0, ingested: 0, error: "bad feilet" });
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("support_inbox_sync_tenant_failed"))).toBe(true);
  });

  it("finance-spend-integrity-sweep", async () => {
    const empty = { scanned: 0, inserted: 0, updated: 0, corrected: 0, correction_conflicts: 0 };
    const full = { marketing: empty, model_cost: empty, reconciliation: { matched: 7, advanced_schedules: 0 }, anomalies: { spend_record_flags_added: 0, commitment_flags_added: 0, flags_cleared: 0 } };
    const spend = { runFullSweep: async (t: string) => { boom(t); return full; } };
    const { failures, results } = await failuresOf((f) => runFinanceSpendIntegritySweepForAllTenants(fakePool(), spend as never, f));
    expect(failures).toEqual([{ tenant_id: "bad", error: "bad feilet" }]);
    expect(results["good"]?.reconciliation.matched).toBe(7);
  });

  it("stripe-payment-sync", async () => {
    const finance = {
      syncPendingStripePayments: async (t: string) => { boom(t); return { synced: 2, failed: 0 }; },
      runProviderAnomalyDetection: async () => ({ payment_intent_flags_added: 0, refund_flags_added: 0, flags_cleared: 0 })
    };
    const { failures, results } = await failuresOf((f) => runStripePaymentSyncForAllTenants(fakePool(), finance as never, f));
    expect(failures).toEqual([{ tenant_id: "bad", error: "bad feilet" }]);
    expect(results["good"]?.sync).toEqual({ synced: 2, failed: 0 });
  });

  it("vipps-payment-sync", async () => {
    const finance = {
      syncPendingVippsPayments: async (t: string) => { boom(t); return { synced: 1, failed: 0 }; },
      runVippsProviderAnomalyDetection: async () => ({ payment_intent_flags_added: 0, capture_flags_added: 0, refund_flags_added: 0, flags_cleared: 0 })
    };
    const { failures, results } = await failuresOf((f) => runVippsPaymentSyncForAllTenants(fakePool(), finance as never, f));
    expect(failures).toEqual([{ tenant_id: "bad", error: "bad feilet" }]);
    expect(results["good"]?.sync).toEqual({ synced: 1, failed: 0 });
  });
});

describe("D-442: business-events-sync - provider-feil som syncTenant() returnerer (ikke kaster) regnes også som feil", () => {
  const stats = { scanned: 3, recorded: 2, unmatched: 1, ambiguous: 0 };
  const ok = { gmail: stats, calendar: stats, open_loops_reevaluated: true };

  it("kastet feil registreres uten delmengde", async () => {
    const sync = { syncTenant: async (t: string) => { boom(t); return ok; } };
    const { failures, results } = await failuresOf((f) => runBusinessEventSyncForAllTenants(fakePool(), sync as never, f));
    expect(failures).toEqual([{ tenant_id: "bad", error: "bad feilet" }]);
    expect(results["good"]).toEqual(ok);
  });

  it("Gmail nede for én tenant: registreres med delmengde «gmail», Calendar-feil med «calendar», ren kjøring gir ingenting", async () => {
    const sync = {
      syncTenant: async (t: string) =>
        t === "bad"
          ? { gmail: { ...stats, error: "credential_unavailable" }, calendar: { ...stats, error: "rate_limited" }, open_loops_reevaluated: true }
          : ok
    };
    const { failures } = await failuresOf((f) => runBusinessEventSyncForAllTenants(fakePool(), sync as never, f));
    expect(failures).toEqual([
      { tenant_id: "bad", scope: "gmail", error: "credential_unavailable" },
      { tenant_id: "bad", scope: "calendar", error: "rate_limited" }
    ]);

    const clean = new SweepFailureCollector();
    await runBusinessEventSyncForAllTenants(fakePool(["good"]), sync as never, clean);
    expect(clean.failures).toEqual([]);
  });
});

describe("D-442: neonomics-sweep - hvert delsteg som kan feile registreres med eget scope", () => {
  const emptyBanking = {
    listConsents: async () => [] as Array<{ consent_id: string; state: string }>,
    listBankAccounts: async () => [] as Array<{ bank_account_id: string }>,
    verifyConsent: async () => undefined,
    syncAccounts: async () => ({ discovered: 0, updated: 0 }),
    syncTransactions: async () => ({ inserted: 0, transitioned: 0, corrections_flagged: 0 }),
    reconcileBankTransactions: async () => ({ matched: 0 }),
    runBankAnomalyDetection: async () => ({ flags_added: 0 })
  };
  const okFinance = {
    syncPendingNeonomicsPayments: async () => ({ synced: 0, failed: 0 }),
    runNeonomicsProviderAnomalyDetection: async () => ({ flags_added: 0 })
  };

  const run = async (banking: object, finance: object) => {
    const collector = new SweepFailureCollector();
    const results = await runNeonomicsSweepForAllTenants(fakePool(["bad"]), banking as never, finance as never, collector);
    expect(Object.keys(results)).toEqual(["bad"]);
    return collector.failures;
  };

  it("ren kjøring: ingen feil", async () => {
    expect(await run(emptyBanking, okFinance)).toEqual([]);
  });

  it("samtykke-verifisering: consent:<id>", async () => {
    const banking = { ...emptyBanking, listConsents: async () => [{ consent_id: "c1", state: "active" }], verifyConsent: async () => { throw new Error("samtykke utløpt"); } };
    expect(await run(banking, okFinance)).toEqual([{ tenant_id: "bad", scope: "consent:c1", error: "samtykke utløpt" }]);
  });

  it("transaksjonssynk: account:<id>", async () => {
    const banking = { ...emptyBanking, listBankAccounts: async () => [{ bank_account_id: "a1" }], syncTransactions: async () => { throw new Error("bank 503"); } };
    expect(await run(banking, okFinance)).toEqual([{ tenant_id: "bad", scope: "account:a1", error: "bank 503" }]);
  });

  it("samtykkeliste: consent_list", async () => {
    const banking = { ...emptyBanking, listConsents: async () => { throw new Error("credential mangler"); } };
    expect(await run(banking, okFinance)).toEqual([{ tenant_id: "bad", scope: "consent_list", error: "credential mangler" }]);
  });

  it("betalingssynk: payments", async () => {
    const finance = { ...okFinance, syncPendingNeonomicsPayments: async () => { throw new Error("betalings-API nede"); } };
    expect(await run(emptyBanking, finance)).toEqual([{ tenant_id: "bad", scope: "payments", error: "betalings-API nede" }]);
  });

  it("avstemming/avvik: reconciliation", async () => {
    const banking = { ...emptyBanking, reconcileBankTransactions: async () => { throw new Error("avstemming feilet"); } };
    expect(await run(banking, okFinance)).toEqual([{ tenant_id: "bad", scope: "reconciliation", error: "avstemming feilet" }]);
  });
});

describe("D-442: wallester-sweep - hvert delsteg som kan feile registreres med eget scope", () => {
  const okCards = {
    listCards: async () => [] as Array<{ card_id: string; provider_card_id: string | null }>,
    syncCardState: async () => undefined,
    syncAuthorizations: async () => ({ inserted: 0, updated: 0 }),
    syncTransactions: async () => ({ inserted: 0, corrections_flagged: 0 }),
    reconcileCardTransactions: async () => ({ matched: 0 }),
    runCardAnomalyDetection: async () => ({ flags_added: 0 })
  };

  const run = async (cards: object) => {
    const collector = new SweepFailureCollector();
    const results = await runWallesterSweepForAllTenants(fakePool(["bad"]), cards as never, collector);
    expect(Object.keys(results)).toEqual(["bad"]);
    return collector.failures;
  };

  it("ren kjøring: ingen feil", async () => {
    expect(await run(okCards)).toEqual([]);
  });

  it("kortsynk: card:<id>", async () => {
    const cards = { ...okCards, listCards: async () => [{ card_id: "k1", provider_card_id: "p1" }], syncCardState: async () => { throw new Error("kort 500"); } };
    expect(await run(cards)).toEqual([{ tenant_id: "bad", scope: "card:k1", error: "kort 500" }]);
  });

  it("kortliste: card_list", async () => {
    const cards = { ...okCards, listCards: async () => { throw new Error("credential mangler"); } };
    expect(await run(cards)).toEqual([{ tenant_id: "bad", scope: "card_list", error: "credential mangler" }]);
  });

  it("avstemming/avvik: reconciliation", async () => {
    const cards = { ...okCards, runCardAnomalyDetection: async () => { throw new Error("avviksdeteksjon feilet"); } };
    expect(await run(cards)).toEqual([{ tenant_id: "bad", scope: "reconciliation", error: "avviksdeteksjon feilet" }]);
  });
});

describe("D-442: main.ts forkaster aldri et sveipresultat (kildenivå-vakt, main.ts kan ikke importeres - samme presedens som de øvrige *-wiring-testene)", () => {
  const mainSource = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

  it("ingen *ForAllTenants-kall ender i .then(() => undefined) (antimønsteret som gjorde tenant-feil usynlige for DailyScheduler)", () => {
    const discarding = [...mainSource.matchAll(/(run\w+ForAllTenants)\([^;]*?\)\s*\.then\(\(\) => undefined\)/gs)].map((m) => m[1]);
    expect(discarding).toEqual([]);
  });

  it("11 jobber via failOnSweepFailures og 6 via assertNoSweepFailures (retensjons-/minnesveipene som allerede returnerer failed[])", () => {
    const viaCollector = [...mainSource.matchAll(/failOnSweepFailures\("([a-z-]+)"/g)].map((m) => m[1]);
    expect(viaCollector.sort()).toEqual([
      "business-events-sync", "business-open-loop-sweep", "business-scoring-recalc", "conversation-graph-sync",
      "finance-spend-integrity-sweep", "growth-action-recommendation-sweep", "neonomics-sweep", "stripe-payment-sync",
      "support-inbox-sync", "vipps-payment-sync", "wallester-sweep"
    ]);
    const viaFailedList = [...mainSource.matchAll(/assertNoSweepFailures\("([a-z-]+)"/g)].map((m) => m[1]);
    expect(viaFailedList.sort()).toEqual([
      "health-retention-sweep", "location-retention-sweep", "memory-profile-sweep", "memory-reembed-sweep", "memory-retention-sweep",
      "vision-retention-sweep"
    ]);
  });

  it("jobbnavnet i failOnSweepFailures/assertNoSweepFailures er det samme som DailyScheduler-jobbnavnet (last_error må peke på riktig jobb)", () => {
    for (const [, job] of mainSource.matchAll(/(?:failOnSweepFailures|assertNoSweepFailures)\("([a-z-]+)"/g)) {
      expect(mainSource, `DailyScheduler for ${job}`).toMatch(new RegExp(`new DailyScheduler\\(\\s*pool, "${job}"`));
    }
  });

  it("morgenbriefen kaster når leveringen uteble, og ukebriefen kaster KUN når ingen tenant fikk den (retry etter delvis levering ville duplisert)", () => {
    const daily = mainSource.slice(mainSource.indexOf("daily_brief_delivery_failed"), mainSource.indexOf("daily_brief_delivery_failed") + 900);
    expect(daily).toContain('throw new Error("daily-brief: Telegram-levering feilet")');
    const weeklyStart = mainSource.indexOf('"business-weekly-brief"');
    const weekly = mainSource.slice(weeklyStart, mainSource.indexOf("\n  });", weeklyStart));
    expect(weekly).toMatch(/if \(result\.delivered === 0\) \{\s*throw new Error\(`business-weekly-brief:/);
  });
});
