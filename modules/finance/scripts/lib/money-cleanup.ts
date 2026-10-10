import type pg from "pg";

/**
 * Operatør-/testopprydding av pengeradene til en test-tenant (host-akseptanseskriptene rydder opp sine egne `*-live-<runId>`-tenants som admin-rolle).
 *
 * Migrasjon 101 (review M-F3) avviser sletting av en pengerad som har eller har hatt kontakt med leverandøren, utenom i en erasure-transaksjon. Opprydding av en
 * test-tenant ER en bevisst fjerning av slike rader, så den kjøres i en transaksjon med SAMME transaksjonslokale GUC som `ErasureService` setter
 * (`jarvis.erasure_in_progress`) - eksplisitt og synlig i skriptet, aldri en generell omgåelse (GUC-en forsvinner ved COMMIT/ROLLBACK og gjelder kun disse DELETE-ene).
 */
export type MoneyTable = "payment_intents" | "stripe_refunds" | "vipps_captures" | "vipps_refunds";

export async function deleteMoneyRows(adminPool: pg.Pool, table: MoneyTable, tenantId: string): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('jarvis.erasure_in_progress', 'true', true)");
    await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
