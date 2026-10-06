import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { EvChangeClassSchema, canonicalizeManifest } from "./constitution.ts";

/**
 * EV-0 (D-408): append-only endringsregister med hash-kjede (migrasjon 075). Databasen setter `seq`, `prev_hash` og `entry_hash`
 * (trigger under advisory-lås) og nekter UPDATE/DELETE/TRUNCATE - denne klassen validerer, skriver og verifiserer.
 *
 * Regler som håndheves allerede her (og for E3 også som CHECK i databasen):
 *   - E3 (forbudt for Evolution Engine) kan aldri registreres som `approved`/`merged`/`deployed`.
 *   - E2 `merged`/`deployed` krever eksplisitt eier-godkjenning bundet til commiten (`evidence.approved_by`, `evidence.approved_head_sha === head_sha`).
 *   - E1 `merged`/`deployed` krever `evidence.ci_green === true` og commit-SHA.
 */

export const LedgerDecisionSchema = z.enum(["proposed", "approved", "rejected", "blocked", "merged", "deployed", "rolled_back"]);
export type LedgerDecision = z.infer<typeof LedgerDecisionSchema>;

export const ChangeLedgerInputSchema = z
  .object({
    change_id: z.string().min(1).max(200),
    change_class: EvChangeClassSchema,
    decision: LedgerDecisionSchema,
    constitution_digest: z.string().regex(/^[0-9a-f]{64}$/),
    subject: z.string().min(1).max(500),
    paths: z.array(z.string().min(1).max(500)).max(500),
    branch: z.string().max(300),
    head_sha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
    /** Tester, reviewer, godkjenner, deploy-referanser. Lagres som kanonisk JSON. Aldri secrets. */
    evidence: z.record(z.unknown()),
    recorded_by: z.string().min(1).max(200)
  })
  .strict();
export type ChangeLedgerInput = z.infer<typeof ChangeLedgerInputSchema>;

export interface ChangeLedgerRow {
  seq: string;
  change_id: string;
  change_class: string;
  decision: string;
  constitution_digest: string;
  subject: string;
  paths: string[];
  branch: string;
  head_sha: string | null;
  evidence: string;
  recorded_by: string;
  /** ISO-8601 UTC med mikrosekunder - nøyaktig den teksten databasen hashet. */
  at_text: string;
  prev_hash: string;
  entry_hash: string;
}

export const GENESIS_HASH = "0".repeat(64);
const US = "\x1f";
const RS = "\x1e";

/** Speiler SQL `ledger_entry_hash` byte for byte. */
export function chainHash(row: Omit<ChangeLedgerRow, "entry_hash">): string {
  const text = [
    row.prev_hash, row.seq, row.change_id, row.change_class, row.decision, row.constitution_digest, row.subject,
    row.paths.join(RS), row.branch, row.head_sha ?? "", row.evidence, row.recorded_by, row.at_text
  ].join(US);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type LedgerErrorCode = "ledger_invalid_entry" | "ledger_rule_violation";
export class LedgerError extends Error {
  constructor(readonly code: LedgerErrorCode, detail: string) {
    super(`${code}:${detail}`);
    this.name = "LedgerError";
  }
}

/** Ren regelsjekk (ingen I/O). */
export function assertLedgerRules(entry: ChangeLedgerInput): void {
  const executed = entry.decision === "merged" || entry.decision === "deployed";
  if (entry.change_class === "E3" && (entry.decision === "approved" || executed)) {
    throw new LedgerError("ledger_rule_violation", "e3_cannot_be_approved_or_executed");
  }
  if (executed && entry.head_sha === null) throw new LedgerError("ledger_rule_violation", "executed_change_needs_head_sha");
  if (executed && entry.change_class === "E2") {
    const by = entry.evidence["approved_by"];
    const sha = entry.evidence["approved_head_sha"];
    if (typeof by !== "string" || by.length === 0) throw new LedgerError("ledger_rule_violation", "e2_needs_owner_approval");
    if (sha !== entry.head_sha) throw new LedgerError("ledger_rule_violation", "e2_approval_not_bound_to_head_sha");
  }
  if (executed && entry.change_class === "E1" && entry.evidence["ci_green"] !== true) {
    throw new LedgerError("ledger_rule_violation", "e1_needs_green_ci");
  }
}

// OBS: `seq::text AS seq` skygger for kolonnen i ORDER BY (Postgres sorterer på utdata-kolonnen = tekst: «10» før «2») - sorter alltid
// på `evolution_change_ledger.seq`.
const SELECT_COLUMNS = `seq::text AS seq, change_id, change_class, decision, constitution_digest, subject, paths, branch, head_sha,
  evidence, recorded_by, ledger_at_text(at) AS at_text, prev_hash, entry_hash`;

export interface VerifyResult {
  ok: boolean;
  count: number;
  head_hash: string;
  /** Første ødelagte `seq`, ellers null. */
  broken_seq: string | null;
}

/** Ren, uavhengig verifisering av en eksportert kjede (samme formel som databasen). */
export function verifyChain(rows: readonly ChangeLedgerRow[]): VerifyResult {
  let prev = GENESIS_HASH;
  let expectedSeq = 1n;
  for (const row of rows) {
    const { entry_hash, ...rest } = row;
    if (BigInt(row.seq) !== expectedSeq || row.prev_hash !== prev || chainHash(rest) !== entry_hash) {
      return { ok: false, count: rows.length, head_hash: prev, broken_seq: row.seq };
    }
    prev = entry_hash;
    expectedSeq += 1n;
  }
  return { ok: true, count: rows.length, head_hash: prev, broken_seq: null };
}

export class ChangeLedger {
  constructor(private readonly db: pg.Pool | pg.PoolClient) {}

  /** Validerer, sjekker reglene og skriver. Databasen setter seq/hash. Kaster `LedgerError` ved ugyldig/regelbrudd. */
  async append(input: ChangeLedgerInput): Promise<ChangeLedgerRow> {
    const parsed = ChangeLedgerInputSchema.safeParse(input);
    if (!parsed.success) throw new LedgerError("ledger_invalid_entry", parsed.error.issues[0]?.message ?? "schema");
    const entry = parsed.data;
    assertLedgerRules(entry);
    const res = await this.db.query<ChangeLedgerRow>(
      `INSERT INTO evolution_change_ledger
         (change_id, change_class, decision, constitution_digest, subject, paths, branch, head_sha, evidence, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${SELECT_COLUMNS}`,
      [
        entry.change_id, entry.change_class, entry.decision, entry.constitution_digest, entry.subject, entry.paths, entry.branch,
        entry.head_sha, canonicalizeManifest(entry.evidence), entry.recorded_by
      ]
    );
    return res.rows[0]!;
  }

  async history(changeId: string): Promise<ChangeLedgerRow[]> {
    const res = await this.db.query<ChangeLedgerRow>(
      `SELECT ${SELECT_COLUMNS} FROM evolution_change_ledger WHERE change_id = $1 ORDER BY evolution_change_ledger.seq`, [changeId]
    );
    return res.rows;
  }

  async all(): Promise<ChangeLedgerRow[]> {
    const res = await this.db.query<ChangeLedgerRow>(`SELECT ${SELECT_COLUMNS} FROM evolution_change_ledger ORDER BY evolution_change_ledger.seq`);
    return res.rows;
  }

  /** Verifiser i databasen (`evolution_ledger_verify()`) OG uavhengig i TypeScript; begge må være enige. */
  async verify(): Promise<VerifyResult> {
    const rows = await this.all();
    const local = verifyChain(rows);
    const db = await this.db.query<{ broken: string | null }>("SELECT evolution_ledger_verify()::text AS broken");
    const dbBroken = db.rows[0]?.broken ?? null;
    if (dbBroken !== null && local.broken_seq === null) return { ...local, ok: false, broken_seq: dbBroken };
    return local;
  }
}
