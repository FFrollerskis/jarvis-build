import type pg from "pg";
import type { SweepFailureCollector } from "@jarvis/contracts";
import { listBusinessTenantIds } from "@jarvis/core";
import type { CardService } from "./card-service.ts";

export interface WallesterSweepResult {
  cards_state_synced: number;
  authorizations: { inserted: number; updated: number };
  transactions: { inserted: number; corrections_flagged: number };
  reconciliation: { matched_by_purpose: number; matched_by_amount: number; mismatch_flagged: number; ambiguous: number };
  anomalies: { transaction_flags_added: number; flags_cleared: number; card_flags_added: number };
}

const EMPTY_RESULT: WallesterSweepResult = {
  cards_state_synced: 0,
  authorizations: { inserted: 0, updated: 0 },
  transactions: { inserted: 0, corrections_flagged: 0 },
  reconciliation: { matched_by_purpose: 0, matched_by_amount: 0, mismatch_flagged: 0, ambiguous: 0 },
  anomalies: { transaction_flags_added: 0, flags_cleared: 0, card_flags_added: 0 }
};

/**
 * D-112 (UA-6 Slice 6) §19: periodisk kortsveip for ALLE bedrifts-tenants
 * - SAMME reboot-durable `DailyScheduler`-mekanisme og "for-alle-tenants"-
 * mønster som Stripe-/Vipps-/Neonomics-sveipene, ingen ny scheduler-
 * arkitektur. Rekkefølge: korttilstandssynk -> autorisasjons-/
 * transaksjonssynk -> avstemming -> avviksdeteksjon (ferske data FØR
 * reglene evaluerer). Feil på ETT steg/kort/tenant velter ALDRI resten
 * (per-steg try/catch). Uten konfigurerte Wallester-credentials blir
 * provider-stegene no-op (credential_unavailable fanges per steg) mens de
 * RENT LOKALE stegene (avstemming/avvik) fortsatt kjører - passiv
 * integritet er aldri credential-gated (§11/§19).
 */
export async function runWallesterSweepForAllTenants(pool: pg.Pool, cards: CardService, failures?: SweepFailureCollector): Promise<Record<string, WallesterSweepResult>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, WallesterSweepResult> = {};
  for (const tenantId of tenantIds) {
    const result: WallesterSweepResult = structuredClone(EMPTY_RESULT);
    try {
      const cardRows = await cards.listCards(tenantId, "business", false, 200);
      for (const card of cardRows.filter((c) => c.provider_card_id !== null)) {
        try {
          await cards.syncCardState(tenantId, "business", card.card_id);
          result.cards_state_synced++;
          const auths = await cards.syncAuthorizations(tenantId, "business", card.card_id);
          result.authorizations.inserted += auths.inserted;
          result.authorizations.updated += auths.updated;
          const txs = await cards.syncTransactions(tenantId, "business", card.card_id);
          result.transactions.inserted += txs.inserted;
          result.transactions.corrections_flagged += txs.corrections_flagged;
        } catch (err) {
          // Ett korts provider-/synkfeil isoleres - resten fortsetter. Isolasjonen er UENDRET,
          // kun stillheten var feilen (D-227, samme anti-mønster-klasse som D-218-222).
          console.error(JSON.stringify({
            msg: "wallester_sweep_card_sync_failed", tenant_id: tenantId, card_id: card.card_id,
            error: err instanceof Error ? err.message : String(err)
          }));
          failures?.record(tenantId, err, `card:${card.card_id}`);
        }
      }
    } catch (err) {
      // Credential-/listefeil - fortsett til de lokale stegene. Isolasjonen er UENDRET (D-227).
      console.error(JSON.stringify({
        msg: "wallester_sweep_card_list_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
      failures?.record(tenantId, err, "card_list");
    }
    try {
      result.reconciliation = await cards.reconcileCardTransactions(tenantId, "business");
      result.anomalies = await cards.runCardAnomalyDetection(tenantId, "business");
    } catch (err) {
      // Én tenants sveipfeil velter aldri de andre - isolasjonen er UENDRET (D-227).
      console.error(JSON.stringify({
        msg: "wallester_sweep_reconciliation_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
      failures?.record(tenantId, err, "reconciliation");
    }
    results[tenantId] = result;
  }
  return results;
}
