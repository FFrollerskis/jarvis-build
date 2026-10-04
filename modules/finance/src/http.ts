/**
 * D-392 (JARVIS-019): felles HTTP-disiplin for alle finansleverandører. Uten tidsavbrudd kunne et hengende leverandørkall holde en
 * DB-forbindelse/radlås (og en `ToolGateway`-slot) åpen for alltid; uten retry-regel ble en 5xx på en NY betaling/journalpost gjentatt
 * selv om leverandøren kan ha utført den første (Fiken/Neonomics/Wallester har ingen Idempotency-Key).
 */
export const FINANCE_FETCH_TIMEOUT_MS = 20_000;

export function financeSignal(): AbortSignal {
  return AbortSignal.timeout(FINANCE_FETCH_TIMEOUT_MS);
}

/**
 * 429 er et avslag FØR behandling og kan alltid gjentas. 5xx gjentas kun for lesing (GET/HEAD) eller når kallet bærer en Idempotency-Key
 * (leverandøren slår da sammen duplikater). En mutasjon uten nøkkel som får 5xx kan allerede være utført - da kastes feilen, aldri en retry.
 */
export function isRetrySafe(method: string, status: number, hasIdempotencyKey: boolean): boolean {
  if (status === 429) return true;
  if (status < 500) return false;
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || hasIdempotencyKey;
}
