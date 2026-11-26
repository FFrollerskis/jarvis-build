import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { OpenLoopService } from "../src/open-loop-service.ts";

/**
 * WP-FIN2 fiks-runde 1 (FIX-8): en kortinnsending uten svar (prosessen døde midt i Wallester-kallet: markøren `submitted_at` er satt, men kortet har intet leverandør-id og INGET flagg) overflates
 * som `card_anomaly_attention` når reservasjonen er eldre enn leasen (120 s; her 5 minutter med margin) - tidligere ble den aldri synlig i attention-køen (regelen krevde avviksflagg). Rene SQL-fixturer mot
 * `provider_cards` (`@jarvis/business` importerer bevisst ikke `@jarvis/finance`, samme presedens som `open-loop-finance.test.ts`).
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let openLoops: OpenLoopService;
const TENANT = "tenant-fin2-attention";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-attention-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_fin2_attention LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_fin2_attention");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'FIN2 attention', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('person-fin2-attention', 'Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-fin2-attention', '${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-fin2-attention-business', '${TENANT}', 'business');
  `);
  appPool = createPool({ ...base, user: "jarvis_fin2_attention", password: "pw2" });
  openLoops = new OpenLoopService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

async function card(opts: { submittedAgo: string | null; flags?: string[]; providerCardId?: string | null; state?: string; name?: string }): Promise<string> {
  const id = `card-${randomUUID()}`;
  await adminPool.query(
    `INSERT INTO provider_cards (card_id, tenant_id, memory_space_id, idempotency_key, name, purpose, card_type, state, currency, provider_card_id, anomaly_flags, submitted_at)
     VALUES ($1, $2, 'business', $3, $4, 'P', 'virtual', $5, 'EUR', $6, $7::jsonb, ${opts.submittedAgo === null ? "NULL" : `now() - interval '${opts.submittedAgo}'`})`,
    [id, TENANT, `idem-${id}`, opts.name ?? "Testkort", opts.state ?? "draft", opts.providerCardId ?? null, JSON.stringify(opts.flags ?? [])]
  );
  return id;
}
async function loopFor(cardId: string) {
  const loops = await openLoops.listOpenLoops(TENANT, "business", "open");
  return (loops as unknown as Array<{ loop_type: string; detection_key: string; reason: string; next_action: string; priority: string }>).find((l) => l.detection_key === `card_anomaly_attention:card:${cardId}`);
}

describe("FIX-8: kort med en innsending uten svar overflates etter at leasen er utløpt", () => {
  it("draft uten leverandør-id og uten flagg, med reservasjon eldre enn 5 minutter -> card_anomaly_attention (high) som peker på eierens avklaring", async () => {
    const id = await card({ submittedAgo: "10 minutes", name: "Krasjkort" });
    const result = await openLoops.detectCardAnomalies(TENANT, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loop = await loopFor(id);
    expect(loop?.loop_type).toBe("card_anomaly_attention");
    expect(loop?.priority).toBe("high");
    expect(loop?.reason).toMatch(/innsending til Wallester uten svar/);
    expect(loop?.reason).toContain("Krasjkort");
    expect(loop?.next_action).toContain(id);
    expect(loop?.next_action).toContain("§11.3 A");
  });

  it("en FRISK reservasjon (innsendingen pågår) og et kort som aldri er sendt inn gir INGEN loop", async () => {
    const fresh = await card({ submittedAgo: "30 seconds" });
    const never = await card({ submittedAgo: null });
    await openLoops.detectCardAnomalies(TENANT, "business");
    expect(await loopFor(fresh)).toBeUndefined();
    expect(await loopFor(never)).toBeUndefined();
  });

  it("et kort som HAR leverandør-id (innsendingen fikk svar) og ikke er flagget gir ingen loop, uansett alder", async () => {
    const answered = await card({ submittedAgo: "2 days", providerCardId: `wc-${randomUUID().slice(0, 8)}`, state: "pending_provider" });
    // forsvar i dybden: selv en (inkonsistent) rad som er `draft` men HAR leverandør-id regnes aldri som «innsending uten svar»
    const inconsistent = await card({ submittedAgo: "2 days", providerCardId: `wc-${randomUUID().slice(0, 8)}`, state: "draft" });
    await openLoops.detectCardAnomalies(TENANT, "business");
    expect(await loopFor(answered)).toBeUndefined();
    expect(await loopFor(inconsistent)).toBeUndefined();
  });

  it("draft-vernet: et kort som IKKE er draft (pending_provider/active/frozen/closed) uten leverandør-id og uten flagg, med en gammel reservasjonsmarkør, gir ingen loop; kontroll: samme rad som draft gir loop", async () => {
    // fiks-runde 2 (FIX-D): markøren `submitted_at` kan stå igjen på et kort som siden er avsluttet/endret lokalt (f.eks. lukket uten at innsendingen noen gang fikk svar) - det er ikke lenger en «innsending uten svar»
    const nonDraft: string[] = [];
    for (const state of ["pending_provider", "active", "frozen", "closed"]) nonDraft.push(await card({ submittedAgo: "10 minutes", state, name: `Ikke-draft ${state}` }));
    const draft = await card({ submittedAgo: "10 minutes", name: "Draft-kontroll" });
    await openLoops.detectCardAnomalies(TENANT, "business");
    for (const id of nonDraft) expect(await loopFor(id), id).toBeUndefined();
    expect((await loopFor(draft))?.reason).toMatch(/innsending til Wallester uten svar/);
  });

  it("et flagget kort gir fortsatt loopen med flaggene i teksten (uendret oppførsel)", async () => {
    const id = await card({ submittedAgo: "10 minutes", flags: ["CARD_SUBMIT_OUTCOME_UNKNOWN"] });
    await openLoops.detectCardAnomalies(TENANT, "business");
    const loop = await loopFor(id);
    expect(loop?.reason).toMatch(/uløste kortavvik: CARD_SUBMIT_OUTCOME_UNKNOWN/);
    expect(loop?.next_action).toBe(`Undersøk kort ${id}`);
  });

  it("loopen lukkes av seg selv når eieren har ryddet markøren (admin-SQL §11.3 A.1)", async () => {
    const id = await card({ submittedAgo: "10 minutes" });
    await openLoops.detectCardAnomalies(TENANT, "business");
    expect(await loopFor(id)).toBeDefined();
    await adminPool.query("UPDATE provider_cards SET submitted_at = NULL WHERE card_id = $1", [id]);
    const sweep = await openLoops.detectCardAnomalies(TENANT, "business");
    expect(sweep.auto_resolved).toBeGreaterThanOrEqual(1);
    expect(await loopFor(id)).toBeUndefined();
  });
});

/**
 * FIX-5 (fiks-runde 1): en banktransaksjon med ukjent/manglende leverandørstatus settes av `BankingService.syncTransactions` i karantene (lagret som `pending` med flagget
 * `BANK_TRANSACTION_STATUS_UNKNOWN`). Runbooken (`FINANCE_D_CHAIN.md` §11.6) lover at den overflates som `bank_transaction_unmatched` i attention-køen; den eksisterende regelen
 * (`detectBankTransactionAnomalies`: enhver transaksjon med avviksflagg, uavhengig av status) hadde ingen test. Rene SQL-fixturer, samme presedens som kortene over.
 */
describe("FIX-5: en banktransaksjon i karantene (ukjent status) overflates i attention-køen", () => {
  const QUARANTINE_FLAG = "BANK_TRANSACTION_STATUS_UNKNOWN";
  async function bankAccount(): Promise<string> {
    const consentId = `consent-${randomUUID()}`;
    const accountId = `bank-acc-${randomUUID()}`;
    await adminPool.query("INSERT INTO bank_consents (consent_id, tenant_id, bank_id, state) VALUES ($1, $2, 'bank-x', 'active')", [consentId, TENANT]);
    await adminPool.query("INSERT INTO bank_accounts (bank_account_id, tenant_id, provider_account_id, consent_id, bank_id) VALUES ($1, $2, $3, $4, 'bank-x')", [accountId, TENANT, `pa-${randomUUID()}`, consentId]);
    return accountId;
  }
  async function bankTx(accountId: string, flags: string[]): Promise<string> {
    const id = `bank-tx-${randomUUID()}`;
    await adminPool.query(
      `INSERT INTO bank_transactions (bank_transaction_id, tenant_id, bank_account_id, provider_transaction_id, status, direction, amount_ore, currency, anomaly_flags)
       VALUES ($1, $2, $3, $4, 'pending', 'debit', 7000, 'NOK', $5::jsonb)`,
      [id, TENANT, accountId, `ptx-${randomUUID()}`, JSON.stringify(flags)]
    );
    return id;
  }
  async function bankLoopFor(txId: string) {
    const loops = await openLoops.listOpenLoops(TENANT, "business", "open");
    return (loops as unknown as Array<{ loop_type: string; detection_key: string; reason: string }>).find((l) => l.detection_key === `bank_transaction_unmatched:${txId}`);
  }

  it("pending-rad med karantene-flagget gir bank_transaction_unmatched med flagget i årsaken; en rad uten flagg gir ingen loop; loopen lukkes når flagget er fjernet (banken sendte en kjent status)", async () => {
    const accountId = await bankAccount();
    const quarantined = await bankTx(accountId, [QUARANTINE_FLAG]);
    const clean = await bankTx(accountId, []);
    await openLoops.detectBankTransactionAnomalies(TENANT, "business");
    const loop = await bankLoopFor(quarantined);
    expect(loop?.loop_type).toBe("bank_transaction_unmatched");
    expect(loop?.reason).toContain(QUARANTINE_FLAG);
    expect(await bankLoopFor(clean)).toBeUndefined();
    await adminPool.query("UPDATE bank_transactions SET anomaly_flags = '[]'::jsonb WHERE bank_transaction_id = $1", [quarantined]);
    const sweep = await openLoops.detectBankTransactionAnomalies(TENANT, "business");
    expect(sweep.auto_resolved).toBeGreaterThanOrEqual(1);
    expect(await bankLoopFor(quarantined)).toBeUndefined();
  });
});
