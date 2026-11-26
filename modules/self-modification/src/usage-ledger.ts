import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { EVOLUTION_COST_CATEGORIES } from "./constitution.ts";
import { GENESIS_HASH } from "./change-ledger.ts";

/**
 * WP-EV0 (HF2 kap. 6 «Budget locks» og kap. 29): append-only FORBRUKS- og EIER-TID-register med hash-kjede (migrasjon 280, samme mønster som endringsregisteret 075).
 * Budsjettlåsen (`BudgetLock`) teller herfra: kostnad pr. kategori i ØRE (`spend`) og eierens tid i MINUTTER (`owner_time`), hver rad knyttet til målingen den kommer
 * fra (`source_ref`) og til konstitusjonen som gjaldt. Raden skrives av deterministisk målekode - aldri av Evolution-motoren selv. Databasen nekter UPDATE/DELETE/TRUNCATE
 * og setter `seq`/`entry_hash`; denne klassen validerer, skriver og verifiserer (databasen OG uavhengig i TypeScript).
 */
export const OWNER_ACTIVITIES = ["approval", "label", "review", "governance"] as const;
export type OwnerActivity = (typeof OWNER_ACTIVITIES)[number];
export type UsageKind = "spend" | "owner_time";

/** Samme tegnsett som databasens CHECK: ingen fritekst, aldri mellomrom/hemmeligheter. */
const SAFE_REF = /^[A-Za-z0-9_.:/#-]+$/;
const amount = z.number().int().min(1).max(1_000_000_000);
const common = {
  amount,
  change_id: z.string().min(1).max(200).nullable(),
  /** Hva målingen kommer fra, f.eks. `cost_events:1234` eller `audit_events:77`. Aldri en hemmelighet. */
  source_ref: z.string().min(1).max(300).regex(SAFE_REF),
  constitution_digest: z.string().regex(/^[0-9a-f]{64}$/),
  recorded_by: z.string().min(1).max(200).regex(SAFE_REF)
};

export const UsageEntryInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("spend"), category: z.enum(EVOLUTION_COST_CATEGORIES), ...common }).strict(),
  z.object({ kind: z.literal("owner_time"), category: z.enum(OWNER_ACTIVITIES), ...common }).strict()
]);
export type UsageEntryInput = z.infer<typeof UsageEntryInputSchema>;

export interface UsageLedgerRow {
  seq: string;
  kind: string;
  category: string;
  /** bigint som tekst (pg returnerer bigint som streng). */
  amount: string;
  change_id: string | null;
  source_ref: string;
  constitution_digest: string;
  recorded_by: string;
  /** ISO-8601 UTC med mikrosekunder - nøyaktig den teksten databasen hashet. */
  at_text: string;
  prev_hash: string;
  entry_hash: string;
}

export type UsageLedgerErrorCode = "usage_invalid_entry" | "usage_rule_violation";
export class UsageLedgerError extends Error {
  constructor(readonly code: UsageLedgerErrorCode, detail: string) {
    super(`${code}:${detail}`);
    this.name = "UsageLedgerError";
  }
}

const US = "\x1f";

/** Speiler SQL `usage_ledger_entry_hash` byte for byte. */
export function usageChainHash(row: Omit<UsageLedgerRow, "entry_hash">): string {
  const text = [row.prev_hash, row.seq, row.kind, row.category, row.amount, row.change_id ?? "", row.source_ref, row.constitution_digest, row.recorded_by, row.at_text].join(US);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Ren regelsjekk (ingen I/O) utover skjemaet: eier-tid for godkjenning/review må knyttes til en endring (ellers kan «minutter pr. endring» ikke regnes). */
export function assertUsageRules(entry: UsageEntryInput): void {
  if (entry.kind === "owner_time" && (entry.category === "approval" || entry.category === "review") && entry.change_id === null) {
    throw new UsageLedgerError("usage_rule_violation", "owner_work_needs_change_id");
  }
}

export interface UsageVerifyResult {
  ok: boolean;
  count: number;
  head_hash: string;
  broken_seq: string | null;
}

/** Ren, uavhengig verifisering av en eksportert kjede (samme formel som databasen). */
export function verifyUsageChain(rows: readonly UsageLedgerRow[]): UsageVerifyResult {
  let prev = GENESIS_HASH;
  let expectedSeq = 1n;
  for (const row of rows) {
    const { entry_hash, ...rest } = row;
    if (BigInt(row.seq) !== expectedSeq || row.prev_hash !== prev || usageChainHash(rest) !== entry_hash) {
      return { ok: false, count: rows.length, head_hash: prev, broken_seq: row.seq };
    }
    prev = entry_hash;
    expectedSeq += 1n;
  }
  return { ok: true, count: rows.length, head_hash: prev, broken_seq: null };
}

// OBS: `seq::text AS seq` skygger for kolonnen i ORDER BY (tekst-sortering: «10» før «2») - sorter alltid på `evolution_usage_ledger.seq`.
const SELECT_COLUMNS = `seq::text AS seq, kind, category, amount::text AS amount, change_id, source_ref, constitution_digest, recorded_by, ledger_at_text(at) AS at_text, prev_hash, entry_hash`;

/** Det budsjettlåsen trenger av forbruksregisteret (strukturelt - `UsageLedger` oppfyller det). */
export interface UsageCounter {
  /** Sum av beløpet (øre for `spend`, minutter for `owner_time`) siden `sinceIso`; `categories: null` = alle kategorier. */
  sumSince(kind: UsageKind, categories: readonly string[] | null, sinceIso: string): Promise<number>;
  /** Sum av beløpet for én endring (eier-minutter pr. autonom endring). */
  sumForChange(kind: UsageKind, changeId: string): Promise<number>;
}

export class UsageLedger implements UsageCounter {
  constructor(private readonly db: pg.Pool | pg.PoolClient) {}

  /** Validerer, sjekker reglene og skriver. Databasen setter seq/hash. Kaster `UsageLedgerError` ved ugyldig/regelbrudd. */
  async append(input: UsageEntryInput): Promise<UsageLedgerRow> {
    const parsed = UsageEntryInputSchema.safeParse(input);
    if (!parsed.success) throw new UsageLedgerError("usage_invalid_entry", `${parsed.error.issues[0]?.path.join(".") ?? "schema"}:${parsed.error.issues[0]?.message ?? ""}`);
    const entry = parsed.data;
    assertUsageRules(entry);
    const res = await this.db.query<UsageLedgerRow>(
      `INSERT INTO evolution_usage_ledger (kind, category, amount, change_id, source_ref, constitution_digest, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SELECT_COLUMNS}`,
      [entry.kind, entry.category, entry.amount, entry.change_id, entry.source_ref, entry.constitution_digest, entry.recorded_by]
    );
    return res.rows[0]!;
  }

  async all(): Promise<UsageLedgerRow[]> {
    const res = await this.db.query<UsageLedgerRow>(`SELECT ${SELECT_COLUMNS} FROM evolution_usage_ledger ORDER BY evolution_usage_ledger.seq`);
    return res.rows;
  }

  async sumSince(kind: UsageKind, categories: readonly string[] | null, sinceIso: string): Promise<number> {
    const res = await this.db.query<{ n: string }>(
      `SELECT coalesce(sum(amount), 0)::text AS n FROM evolution_usage_ledger
        WHERE kind = $1 AND at >= $2::timestamptz AND ($3::text[] IS NULL OR category = ANY($3::text[]))`,
      [kind, sinceIso, categories === null ? null : [...categories]]
    );
    return Number(res.rows[0]?.n ?? "0");
  }

  async sumForChange(kind: UsageKind, changeId: string): Promise<number> {
    const res = await this.db.query<{ n: string }>(
      `SELECT coalesce(sum(amount), 0)::text AS n FROM evolution_usage_ledger WHERE kind = $1 AND change_id = $2`,
      [kind, changeId]
    );
    return Number(res.rows[0]?.n ?? "0");
  }

  /** Verifiser i databasen (`evolution_usage_ledger_verify()`) OG uavhengig i TypeScript; begge må være enige. */
  async verify(): Promise<UsageVerifyResult> {
    const rows = await this.all();
    const local = verifyUsageChain(rows);
    const db = await this.db.query<{ broken: string | null }>("SELECT evolution_usage_ledger_verify()::text AS broken");
    const dbBroken = db.rows[0]?.broken ?? null;
    if (dbBroken !== null && local.broken_seq === null) return { ...local, ok: false, broken_seq: dbBroken };
    return local;
  }
}
