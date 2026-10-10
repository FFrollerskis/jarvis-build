import { FikenTransport } from "./fiken-transport.ts";
import type { FikenCredentials, FikenCredentialsProvider } from "./service.ts";
import type { FikenPostingEntry, FikenPostingListing, FikenPostingReader } from "./reconciliation.ts";

/**
 * WP-F1 (D-462): produksjonsleseren som gir avstemmingen Fiken-bilag. Bruker EKSISTERENDE `FikenTransport.listJournalEntries()` (`GET /companies/{slug}/journalEntries`) -
 * ingen ny Fiken-flate. DORMANT uten credentials: `getCredentials` gir `null` => leseren returnerer `null` og avstemmingen sier `skipped_no_credentials`.
 *
 * NOT VERIFIED (ærlig): Fikens liste-API er ikke verifisert mot primærkilden her (`api.fiken.no` er utilgjengelig fra dette miljøet). Verken pagineringsprotokollen
 * (sidetall/-størrelse som parametre eller headere) eller om svaret bærer posteringslinjer er bekreftet. Leseren melder derfor ALLTID `complete: false` - fravær av et bilag blir
 * aldri konkludert - og beløp avstemmes kun når svaret faktisk bærer heltallige linjebeløp. Når pagineringen er verifisert (se runbook), kan `complete` settes her.
 */
export type FikenJournalLister = { listJournalEntries(): Promise<unknown[]> };

function positiveDebitTotal(lines: unknown): number | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let total = 0;
  for (const line of lines) {
    const amount = (line as { amount?: unknown } | null)?.amount;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount)) return null; // ukjent form => ikke et beløp å avstemme mot (aldri gjettet)
    if (amount > 0) total += amount;
  }
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

export function mapFikenJournalEntries(raw: unknown[]): FikenPostingEntry[] {
  const entries: FikenPostingEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const id = typeof e["journalEntryId"] === "number" && Number.isSafeInteger(e["journalEntryId"]) ? String(e["journalEntryId"])
      : typeof e["journalEntryId"] === "string" && /^[0-9A-Za-z_-]{1,40}$/.test(e["journalEntryId"]) ? e["journalEntryId"] : null;
    if (id === null) continue;
    entries.push({
      journalEntryId: id,
      description: typeof e["description"] === "string" ? e["description"].slice(0, 300) : null,
      date: typeof e["date"] === "string" ? e["date"].slice(0, 10) : null,
      debitTotalOre: positiveDebitTotal(e["lines"])
    });
  }
  return entries;
}

export function createFikenPostingReader(
  credentialsProvider: FikenCredentialsProvider,
  listerFactory: (credentials: FikenCredentials) => FikenJournalLister = (c) => new FikenTransport(c.refreshToken, c.companySlug)
): FikenPostingReader {
  return {
    async listPostings(tenantId: string): Promise<FikenPostingListing | null> {
      const credentials = await credentialsProvider.getCredentials(tenantId);
      if (!credentials) return null;
      const raw = await listerFactory(credentials).listJournalEntries();
      return { entries: mapFikenJournalEntries(Array.isArray(raw) ? raw : []), complete: false };
    }
  };
}
