import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { writeAudit } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import {
  fileUsageSource, isPseudonymousRef, parseWebhookUsagePayload, verifyUsageWebhookSignature, type UsageFileFormat
} from "./product-usage-sources.ts";
import {
  USAGE_LIMITS, UsageImportError, type NormalizedUsageEvent, type ParsedUsageBatch, type ProductUsageSource, type RejectedUsageEvent
} from "./product-usage-types.ts";

/**
 * WP-D2 (UA-3 «churn/product usage», migrasjon 090): LAGRING av produktbruk-hendelser og eierens kobling konto -> kundeselskap. Kildene (`product-usage-sources.ts`)
 * eier avlesing og normalisering; denne tjenesten eier idempotens, tenant-vakt, oppbevaring og revisjon - slik at webhook, JSONL og CSV deler NØYAKTIG de samme reglene.
 *
 * Garantier:
 *  - **Kun i en bedrifts-tenant** (`tenants.kind = 'business'`, memory space `business`). Webhooken skriver til én eier-konfigurert tenant (aldri avledet fra innholdet).
 *  - **Idempotent**: `UNIQUE (tenant_id, external_event_id)` - samme hendelse (uansett kilde) teller aldri to ganger; samme id med ANNET innhold telles som `conflicts` og
 *    anvendes ikke (en stille overskriving av historikk ville vært en feil å skjule).
 *  - **Pseudonymt**: kun `account_ref`/`user_ref` (avsenderen hasher selv), funksjonsnøkkel, tidspunkt og antall. Kolonner og CHECK-er i 090 avviser alt annet også om appkoden feilet.
 *  - **Alt-eller-ingenting per kall**: én transaksjon (kontoer, hendelser og revisjonsrad); feiler noe, rulles hele kallet tilbake.
 *  - **Ingen handling**: tjenesten kaller ingen modell, ingen ekstern tjeneste og ingen ToolGateway - den lagrer og teller.
 */

export type ProductUsageErrorCode =
  | "not_business_tenant"
  | "not_business_space"
  | "invalid_input"
  | "company_not_found"
  | "not_configured"
  | "invalid_signature";

export class ProductUsageError extends Error {
  constructor(readonly code: ProductUsageErrorCode, detail?: string) {
    super(detail ? `product_usage:${code}:${detail}` : `product_usage:${code}`);
    this.name = "ProductUsageError";
  }
}

/** Nøkkel-sikkerhet: en webhook-hemmelighet kortere enn dette regnes som ikke konfigurert (fail closed). */
export const MIN_USAGE_WEBHOOK_SECRET_LENGTH = 32;
/** Hvor mange avviste hendelser en oppsummering lister (resten telles). */
export const MAX_REJECTED_DETAIL = 20;

const CHUNK = 1000;

/**
 * Revisjonsraden (`audit_events`) er append-only og KAN IKKE slettes av erasure (APPEND_ONLY_EVIDENCE) - derfor skrives aldri konto-pseudonymet dit, kun en kort hash
 * som viser at «en konto» ble koblet, uten at pseudonymet overlever en sletting av kontoen.
 */
const refHash = (ref: string): string => createHash("sha256").update(ref).digest("hex").slice(0, 12);

export interface IngestContext {
  /** Hvem/hva som leverte: webhook (ingen person), eierens CLI-import eller et tool. */
  via: "webhook" | "import";
  /** Person-id for revisjon (CLI/eier); webhook = `system`. Aldri autoritet. */
  actor_person_id?: string | null;
}

export interface IngestSummary {
  source_id: string;
  /** Distinkte, gyldige hendelser i kallet (etter fjerning av duplikater INNE I samme batch). */
  received: number;
  inserted: number;
  /** Allerede lagret med identisk innhold. */
  duplicates: number;
  /** Samme hendelses-id lagret med ANNET innhold - ikke anvendt. */
  conflicts: number;
  rejected: number;
  rejected_detail: RejectedUsageEvent[];
  accounts_seen: number;
  new_accounts: number;
}

export interface UsageAccountRow {
  account_ref: string;
  company_id: string | null;
  linked_at: string | null;
  first_event_at: string | null;
  last_event_at: string | null;
}

export interface LinkResult {
  account_ref: string;
  company_id: string;
  changed: boolean;
  previous_company_id: string | null;
}

export interface ProductUsageConfig {
  /** Webhook-hemmeligheten (leses ved HVERT kall - rotasjon gjelder umiddelbart). */
  webhookSecretProvider?: () => Promise<string | null>;
  /** Tenanten webhooken skriver til (eier-konfigurert). `null` = ikke konfigurert. */
  tenantResolver?: () => string | null;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

async function assertBusinessTarget(client: pg.PoolClient, tenantId: string, space: MemorySpace): Promise<void> {
  if (space !== "business") throw new ProductUsageError("not_business_space", space);
  // `tenants_self`-RLS: raden er synlig fordi transaksjonens jarvis.tenant_id ER tenanten vi sjekker.
  const r = await client.query("SELECT kind FROM tenants WHERE tenant_id = $1", [tenantId]);
  if ((r.rows[0] as { kind?: string } | undefined)?.kind !== "business") throw new ProductUsageError("not_business_tenant");
}

function mapPgError(err: unknown): unknown {
  const code = (err as { code?: string }).code;
  if (err instanceof ProductUsageError || err instanceof UsageImportError) return err;
  if (code === "23514" || code === "22P02" || code === "22003" || code === "22007" || code === "22008") return new ProductUsageError("invalid_input", "verdien ble avvist av databasen");
  return err;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sameEvent(stored: Record<string, unknown>, incoming: NormalizedUsageEvent): boolean {
  // pg leverer timestamptz som Date; `new Date(String(date))` ville avkortet millisekundene og feilklassifisert en identisk hendelse som konflikt.
  const storedMs = stored["occurred_at"] instanceof Date ? stored["occurred_at"].getTime() : new Date(String(stored["occurred_at"])).getTime();
  return stored["kind"] === incoming.kind
    && stored["account_ref"] === incoming.account_ref
    && (stored["user_ref"] ?? null) === incoming.user_ref
    && (stored["feature"] ?? null) === incoming.feature
    && Number(stored["quantity"]) === incoming.quantity
    && storedMs === new Date(incoming.occurred_at).getTime();
}

export class ProductUsageService {
  constructor(private readonly pool: pg.Pool, private readonly config: ProductUsageConfig = {}) {}

  // ------------------------------------------------------------------------------------------------------------------------------------------------------
  // Innhenting
  // ------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Lagrer en ferdig validert batch. Alt-eller-ingenting; se klassekommentaren. */
  async ingest(tenantId: string, source: Pick<ProductUsageSource, "source_id">, batch: ParsedUsageBatch, ctx: IngestContext): Promise<IngestSummary> {
    const space: MemorySpace = "business";
    const events = [...batch.accepted].sort((a, b) => (a.external_event_id < b.external_event_id ? -1 : a.external_event_id > b.external_event_id ? 1 : 0));
    try {
      return await withMemoryTransaction(this.pool, tenantId, [space], async (client): Promise<IngestSummary> => {
        await assertBusinessTarget(client, tenantId, space);
        const summary: IngestSummary = {
          source_id: source.source_id, received: events.length, inserted: 0, duplicates: 0, conflicts: 0,
          rejected: batch.rejected.length, rejected_detail: batch.rejected.slice(0, MAX_REJECTED_DETAIL), accounts_seen: 0, new_accounts: 0
        };
        if (events.length > 0) {
          // Kontoer først (FK), i sortert rekkefølge: to samtidige kall som låser de samme radene gjør det i samme rekkefølge (ingen vranglås).
          const byAccount = new Map<string, { first: string; last: string }>();
          for (const e of events) {
            const cur = byAccount.get(e.account_ref);
            if (!cur) byAccount.set(e.account_ref, { first: e.occurred_at, last: e.occurred_at });
            else {
              if (e.occurred_at < cur.first) cur.first = e.occurred_at;
              if (e.occurred_at > cur.last) cur.last = e.occurred_at;
            }
          }
          const accounts = [...byAccount.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
          summary.accounts_seen = accounts.length;
          for (const part of chunks(accounts, CHUNK)) {
            const r = await client.query(
              `INSERT INTO product_usage_accounts (tenant_id, memory_space_id, account_ref, first_event_at, last_event_at)
               SELECT $1, $2, t.ref, t.first_at, t.last_at FROM unnest($3::text[], $4::timestamptz[], $5::timestamptz[]) AS t(ref, first_at, last_at)
               ON CONFLICT (tenant_id, account_ref) DO UPDATE SET
                 first_event_at = LEAST(product_usage_accounts.first_event_at, EXCLUDED.first_event_at),
                 last_event_at = GREATEST(product_usage_accounts.last_event_at, EXCLUDED.last_event_at),
                 updated_at = now()
               RETURNING (xmax = 0) AS inserted`,
              [tenantId, space, part.map(([ref]) => ref), part.map(([, v]) => v.first), part.map(([, v]) => v.last)]
            );
            summary.new_accounts += r.rows.filter((row) => (row as { inserted: boolean }).inserted).length;
          }
          for (const part of chunks(events, CHUNK)) {
            const inserted = await client.query(
              `INSERT INTO product_usage_events
                 (event_id, tenant_id, memory_space_id, source_id, external_event_id, kind, account_ref, user_ref, feature, quantity, occurred_at)
               SELECT t.event_id, $1, $2, $3, t.ext, t.kind, t.account_ref, t.user_ref, t.feature, t.quantity, t.occurred_at
                 FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::int[], $11::timestamptz[])
                      AS t(event_id, ext, kind, account_ref, user_ref, feature, quantity, occurred_at)
               ON CONFLICT (tenant_id, external_event_id) DO NOTHING
               RETURNING external_event_id`,
              [
                tenantId, space, source.source_id,
                part.map(() => `pue-${randomUUID()}`), part.map((e) => e.external_event_id), part.map((e) => e.kind), part.map((e) => e.account_ref),
                part.map((e) => e.user_ref), part.map((e) => e.feature), part.map((e) => e.quantity), part.map((e) => e.occurred_at)
              ]
            );
            const insertedIds = new Set(inserted.rows.map((row) => (row as { external_event_id: string }).external_event_id));
            summary.inserted += insertedIds.size;
            const skipped = part.filter((e) => !insertedIds.has(e.external_event_id));
            if (skipped.length > 0) {
              const stored = await client.query(
                `SELECT external_event_id, kind, account_ref, user_ref, feature, quantity, occurred_at FROM product_usage_events
                  WHERE tenant_id = $1 AND external_event_id = ANY($2::text[])`,
                [tenantId, skipped.map((e) => e.external_event_id)]
              );
              const byId = new Map(stored.rows.map((row) => [(row as { external_event_id: string }).external_event_id, row as Record<string, unknown>]));
              for (const e of skipped) {
                const row = byId.get(e.external_event_id);
                if (row && sameEvent(row, e)) summary.duplicates += 1;
                else summary.conflicts += 1;
              }
            }
          }
        }
        // Revisjon: ÉN rad per kall med tellere (aldri hendelsesinnhold, aldri referanser).
        await writeAudit(client, { tenant_id: tenantId, person_id: ctx.actor_person_id ?? "system" }, {
          type: "business.product_usage_ingested", decision: "ALLOW",
          payload: {
            source_id: source.source_id, via: ctx.via, received: summary.received, inserted: summary.inserted, duplicates: summary.duplicates,
            conflicts: summary.conflicts, rejected: summary.rejected, accounts_seen: summary.accounts_seen, new_accounts: summary.new_accounts
          }
        });
        return summary;
      });
    } catch (err) {
      throw mapPgError(err);
    }
  }

  /**
   * Webhook-inngangen: signatur FØRST (mot rå kropp), deretter parsing og lagring. Kaster `ProductUsageError('not_configured' | 'invalid_signature')`,
   * `UsageImportError` (ugyldig HELE kropp) - enkelthendelser som feiler valideringen kommer tilbake som `rejected` i oppsummeringen.
   */
  async ingestWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<IngestSummary> {
    const secret = this.config.webhookSecretProvider ? await this.config.webhookSecretProvider() : null;
    const tenantId = this.config.tenantResolver ? this.config.tenantResolver() : null;
    if (!secret || secret.length < MIN_USAGE_WEBHOOK_SECRET_LENGTH) throw new ProductUsageError("not_configured", "webhook_secret");
    if (!tenantId) throw new ProductUsageError("not_configured", "tenant");
    const verification = verifyUsageWebhookSignature(rawBody, signatureHeader, secret, nowSeconds);
    if (!verification.valid) throw new ProductUsageError("invalid_signature", verification.reason ?? "unknown");
    const batch = parseWebhookUsagePayload(rawBody, nowSeconds * 1000);
    return this.ingest(tenantId, { source_id: "webhook" }, batch, { via: "webhook", actor_person_id: null });
  }

  /** Filimport (CSV/JSONL) - kjøres av eierens CLI. `label` er eierens egen etikett (sporing). Ugyldig fil som helhet kaster `UsageImportError`. */
  async importText(
    tenantId: string, format: UsageFileFormat, label: string, text: string, ctx: Omit<IngestContext, "via"> = {}, nowMs: number = Date.now()
  ): Promise<IngestSummary> {
    const source = fileUsageSource(format, label);
    const batch = source.parse(text, nowMs);
    return this.ingest(tenantId, source, batch, { via: "import", ...ctx });
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------
  // Kobling konto -> kundeselskap (eierens valg)
  // ------------------------------------------------------------------------------------------------------------------------------------------------------

  async linkAccount(tenantId: string, space: MemorySpace, accountRef: unknown, companyId: unknown, actorPersonId?: string | null): Promise<LinkResult> {
    if (typeof accountRef !== "string" || !isPseudonymousRef(accountRef)) throw new ProductUsageError("invalid_input", "account_ref: må være en pseudonym referanse");
    if (typeof companyId !== "string" || !ID_RE.test(companyId)) throw new ProductUsageError("invalid_input", "company_id: ugyldig id");
    try {
      return await withMemoryTransaction(this.pool, tenantId, [space], async (client): Promise<LinkResult> => {
        await assertBusinessTarget(client, tenantId, space);
        const company = await client.query("SELECT 1 FROM business_companies WHERE tenant_id = $1 AND company_id = $2", [tenantId, companyId]);
        if (company.rowCount === 0) throw new ProductUsageError("company_not_found");
        const prior = await client.query(
          "SELECT company_id FROM product_usage_accounts WHERE tenant_id = $1 AND account_ref = $2 FOR UPDATE", [tenantId, accountRef]
        );
        const previous = (prior.rows[0] as { company_id: string | null } | undefined)?.company_id ?? null;
        if (previous === companyId) return { account_ref: accountRef, company_id: companyId, changed: false, previous_company_id: previous };
        await client.query(
          `INSERT INTO product_usage_accounts (tenant_id, memory_space_id, account_ref, company_id, linked_by, linked_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (tenant_id, account_ref) DO UPDATE SET company_id = EXCLUDED.company_id, linked_by = EXCLUDED.linked_by, linked_at = now(), updated_at = now()`,
          [tenantId, space, accountRef, companyId, actorPersonId ?? null]
        );
        // Ny kobling = gamle vurderinger hørte til en annen kunde: fjernes, neste sveip beregner på nytt.
        await client.query("DELETE FROM business_churn_assessments WHERE tenant_id = $1 AND account_ref = $2", [tenantId, accountRef]);
        await writeAudit(client, { tenant_id: tenantId, person_id: actorPersonId ?? "system" }, {
          type: "business.product_account_linked", decision: "ALLOW",
          payload: { account_ref_sha256_12: refHash(accountRef), company_id: companyId, previous_company_id: previous }
        });
        return { account_ref: accountRef, company_id: companyId, changed: true, previous_company_id: previous };
      });
    } catch (err) {
      throw mapPgError(err);
    }
  }

  async unlinkAccount(tenantId: string, space: MemorySpace, accountRef: unknown, actorPersonId?: string | null): Promise<{ changed: boolean }> {
    if (typeof accountRef !== "string" || !isPseudonymousRef(accountRef)) throw new ProductUsageError("invalid_input", "account_ref: må være en pseudonym referanse");
    try {
      return await withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
        await assertBusinessTarget(client, tenantId, space);
        const r = await client.query(
          `UPDATE product_usage_accounts SET company_id = NULL, linked_by = NULL, linked_at = NULL, updated_at = now()
            WHERE tenant_id = $1 AND account_ref = $2 AND company_id IS NOT NULL RETURNING company_id`,
          [tenantId, accountRef]
        );
        if (r.rowCount === 0) return { changed: false };
        await client.query("DELETE FROM business_churn_assessments WHERE tenant_id = $1 AND account_ref = $2", [tenantId, accountRef]);
        await writeAudit(client, { tenant_id: tenantId, person_id: actorPersonId ?? "system" }, {
          type: "business.product_account_unlinked", decision: "ALLOW",
          payload: { account_ref_sha256_12: refHash(accountRef), previous_company_id: (r.rows[0] as { company_id: string }).company_id }
        });
        return { changed: true };
      });
    } catch (err) {
      throw mapPgError(err);
    }
  }

  /** Kontoer sortert på siste hendelse (nyeste først). `linked: false` lister ukoblede - det eieren må koble før en churn-vurdering kan finnes. */
  async listAccounts(tenantId: string, space: MemorySpace, options: { linked?: boolean; limit?: number } = {}): Promise<UsageAccountRow[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const filter = options.linked === undefined ? "" : options.linked ? "AND company_id IS NOT NULL" : "AND company_id IS NULL";
      const r = await client.query(
        `SELECT account_ref, company_id, linked_at, first_event_at, last_event_at FROM product_usage_accounts
          WHERE tenant_id = $1 ${filter} ORDER BY last_event_at DESC NULLS LAST, account_ref ASC LIMIT $2`,
        [tenantId, limit]
      );
      return r.rows as UsageAccountRow[];
    });
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------
  // Oppbevaring og sletting
  // ------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Oppbevaring: hendelser eldre enn `maxAgeDays` (standard `USAGE_LIMITS.max_age_days` = 400) slettes. Eldre hendelser avvises uansett ved innhenting, så sletting kan
   * ikke åpne for at en gammel hendelse legges inn på nytt (idempotensnøkkelen forsvinner sammen med hendelsen). Returnerer antall slettede.
   */
  async purgeExpired(tenantId: string, space: MemorySpace, maxAgeDays: number = USAGE_LIMITS.max_age_days): Promise<number> {
    const days = Math.max(Math.trunc(maxAgeDays), 30);
    // Ingen business-tenant-vakt her: RLS skoper til tenanten, og å slette egne utløpte rader er trygt (sveipet kjører uansett bare for bedrifts-tenants).
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const r = await client.query(
        "DELETE FROM product_usage_events WHERE tenant_id = $1 AND occurred_at < now() - make_interval(days => $2)", [tenantId, days]
      );
      return r.rowCount ?? 0;
    });
  }

  /** «Glem én bruker»: nuller `user_ref` på alle hendelser (volumet per konto beholdes). Returnerer antall rader som ble endret. */
  async forgetUserRef(tenantId: string, space: MemorySpace, userRef: unknown, actorPersonId?: string | null): Promise<number> {
    if (typeof userRef !== "string" || !isPseudonymousRef(userRef)) throw new ProductUsageError("invalid_input", "user_ref: må være en pseudonym referanse");
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      await assertBusinessTarget(client, tenantId, space);
      const r = await client.query("UPDATE product_usage_events SET user_ref = NULL WHERE tenant_id = $1 AND user_ref = $2", [tenantId, userRef]);
      const changed = r.rowCount ?? 0;
      await writeAudit(client, { tenant_id: tenantId, person_id: actorPersonId ?? "system" }, {
        type: "business.product_usage_user_forgotten", decision: "ALLOW", payload: { events_changed: changed }
      });
      return changed;
    });
  }
}
