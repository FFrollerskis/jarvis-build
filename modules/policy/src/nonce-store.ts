/**
 * Engangs-ID-lager for replay-vern på signerte godkjenninger.
 * Fase 1: in-memory (bevises i tester). Persistent lager kommer med
 * databasen i fase 2 - grensesnittet er stabilt.
 */
export interface NonceStore {
  /** Forsøker å forbruke nonce. true = første bruk (OK), false = allerede brukt. */
  consume(nonce: string): boolean;
}

export class InMemoryNonceStore implements NonceStore {
  private readonly used = new Set<string>();

  consume(nonce: string): boolean {
    if (this.used.has(nonce)) {
      return false;
    }
    this.used.add(nonce);
    return true;
  }
}
