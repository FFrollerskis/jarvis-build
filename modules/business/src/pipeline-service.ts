import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { canonicalStringify, type JsonValue, type MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";
import { recordActivityInTransaction } from "./service.ts";
import type { BusinessLead, BusinessOpportunity, LeadStatus, OpportunityStage } from "./types.ts";

/**
 * WP-D2 (JARVIS-049 «oppdaterings-/produsentverktøy», mandat D-450): skrive-handlinger for salgs-pipelinen (lead/opportunity) som TJENESTE - opprett, oppdater,
 * flytt mellom stadier/statuser, sett neste handling, lukk med utfall og slett. Transporten (`transport.ts`) er kun en tynn bro hit.
 *
 * Garantier, alle i SAMME transaksjon som selve endringen:
 *  - **Kun i en bedrifts-tenant**: skriving krever `tenants.kind = 'business'` OG memory space `business` (`not_business_tenant`/`not_business_space`). En
 *    person-tenant kan aldri få CRM-pipelinedata skrevet av disse handlingene (JARVIS-044: «skriving kun i eierens business-tenant»).
 *  - **Før/etter-registrering**: hver faktisk endring gir ÉN rad i `business_change_log` (full før- og etter-tilstand, endrede felt, aktør, nøkkel). Ingen endring = ingen rad.
 *  - **Idempotens per kall**: med `idempotency_key` gir samme nøkkel samme effekt, aldri to ganger (rad-lås via advisory lock + `UNIQUE (tenant_id, idempotency_key)`);
 *    samme nøkkel med ANNET innhold avvises (`idempotency_key_conflict`) i stedet for å bli stille ignorert. Uten nøkkel finnes ingen tjeneste-dedupe (da gjelder
 *    kun ToolGateway sin egen ledger) - en innholdsavledet nøkkel ville feilaktig dedupet en bevisst frem-og-tilbake-endring.
 *  - **Streng validering**: ukjente felt, kontrolltegn, for lange tekster, ugyldige id-er/datoer/beløp avvises FØR noe skrives. Id-felt er parametriserte og
 *    kobles via tenant-skopede komposittnøkler (JARVIS-076) - en id fra en annen tenant kan ikke refereres.
 *  - **Sletting** (klasse C, bak bekreftelse) detacher avhengige rader (oppfølginger/aktiviteter/muligheter beholdes uten pekeren) og fjerner KUN deriverte rader
 *    (open loops, score). Før-tilstanden bevares i change-loggen. Polymorfe løse pekere (f.eks. markedsføringsattribusjon) berøres ikke.
 * Tjenesten fatter ingen beslutninger selv og kaller ingen modell eller ekstern tjeneste.
 */

export type PipelineEntityType = "lead" | "opportunity";
export type PipelineAction = "create" | "update" | "set_status" | "move_stage" | "set_next_action" | "close" | "delete";

export type PipelineErrorCode =
  | "not_business_tenant"
  | "not_business_space"
  | "not_found"
  | "invalid_input"
  | "reference_not_found"
  | "has_dependents"
  | "idempotency_key_invalid"
  | "idempotency_key_conflict";

export class BusinessPipelineError extends Error {
  constructor(readonly code: PipelineErrorCode, detail?: string) {
    super(`business_pipeline:${code}${detail ? `:${detail}` : ""}`);
    this.name = "BusinessPipelineError";
  }
}

export interface PipelineContext {
  /** Autentisert aktør (identitetens person-id). Kun for revisjon - aldri autoritet. */
  actor_person_id?: string | null;
  idempotency_key?: string | null;
}

type Snap = Record<string, JsonValue>;

export interface PipelineResult<E> {
  /** Etter-tilstand (null kun for sletting). */
  entity: E | null;
  changed: boolean;
  /** `true` når en tidligere kjøring med samme idempotency_key ble gjenbrukt (ingenting ble skrevet nå). */
  replayed: boolean;
  change_id: string | null;
  changed_fields: string[];
}

export interface PipelineDeleteResult {
  deleted: true;
  entity_id: string;
  replayed: boolean;
  change_id: string;
  detached: { opportunities: number; followups: number; activities: number };
  removed: { open_loops: number; scores: number };
}

// WP-AUTH2a: vokabularet og de terminale statusene er eksportert (uendret innhold) slik at klasse C-adapteren (`class-c-adapter.ts`) bruker de SAMME konstantene som tjenesten - ingen kopi som kan drifte.
export const LEAD_STATUSES: readonly LeadStatus[] = ["new", "contacted", "qualified", "disqualified", "converted"];
const OPPORTUNITY_STAGES: readonly OpportunityStage[] = ["new", "qualified", "proposal", "negotiation", "won", "lost"];
export const LEAD_TERMINAL: ReadonlySet<string> = new Set(["disqualified", "converted"]);
const OPPORTUNITY_TERMINAL: ReadonlySet<string> = new Set(["won", "lost"]);
export const LEAD_CLOSE_OUTCOMES = ["converted", "disqualified"] as const;
export const OPPORTUNITY_CLOSE_OUTCOMES = ["won", "lost"] as const;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:=-]{7,127}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_INT4 = 2_147_483_647;

const TABLE: Record<PipelineEntityType, { table: string; idCol: string; prefix: string }> = {
  lead: { table: "business_leads", idCol: "lead_id", prefix: "biz-ld-" },
  opportunity: { table: "business_opportunities", idCol: "opportunity_id", prefix: "biz-op-" }
};

const NOW = Symbol("now");
type SetValue = unknown | typeof NOW;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Validering (alt kaster `invalid_input` med feltnavn - aldri verdien)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

function bad(field: string, why: string): never {
  throw new BusinessPipelineError("invalid_input", `${field}: ${why}`);
}

function parseText(field: string, v: unknown, min: number, max: number): string {
  if (typeof v !== "string") return bad(field, "må være tekst");
  if (CONTROL_RE.test(v)) return bad(field, "kontrolltegn er ikke tillatt");
  const t = v.normalize("NFC").trim();
  if (t.length < min || t.length > max) return bad(field, `må være ${min}-${max} tegn`);
  return t;
}

function parseId(field: string, v: unknown): string {
  if (typeof v !== "string" || !ID_RE.test(v)) return bad(field, "ugyldig id");
  return v;
}

function parseIsoDate(field: string, v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return bad(field, "må være YYYY-MM-DD");
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return bad(field, "ugyldig dato");
  return v;
}

function parseTimestamp(field: string, v: unknown): string {
  if (typeof v !== "string" || v.length > 40 || !/^\d{4}-\d{2}-\d{2}/.test(v)) return bad(field, "må være en ISO-tid");
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return bad(field, "ugyldig tid");
  return d.toISOString();
}

function parseOre(field: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_INT4) return bad(field, `må være et heltall 0-${MAX_INT4} (øre)`);
  return v;
}

interface FieldSpec { column: string; nullable: boolean; parse: (field: string, v: unknown) => unknown }
const textSpec = (column: string, max: number, nullable: boolean): FieldSpec => ({ column, nullable, parse: (f, v) => parseText(f, v, 1, max) });
const idSpec = (column: string): FieldSpec => ({ column, nullable: true, parse: parseId });

/** Felt som kan endres via `update_lead` (status/stadium har egne handlinger). `assign_to_person_id` er BEVISST ikke et scope-felt (`owner_person_id` bindes til aktøren av chat-executoren). */
const LEAD_PATCH: Record<string, FieldSpec> = {
  title: textSpec("title", 300, false),
  company_id: idSpec("company_id"),
  contact_id: idSpec("contact_id"),
  source: textSpec("source", 200, true),
  assign_to_person_id: idSpec("owner_person_id")
};
const OPPORTUNITY_PATCH: Record<string, FieldSpec> = {
  title: textSpec("title", 300, false),
  company_id: idSpec("company_id"),
  contact_id: idSpec("contact_id"),
  lead_id: idSpec("lead_id"),
  value_ore: { column: "value_ore", nullable: true, parse: parseOre },
  currency: { column: "currency", nullable: false, parse: (f, v) => (typeof v === "string" && /^[A-Z]{3}$/.test(v) ? v : bad(f, "må være en ISO-valutakode (3 store bokstaver)")) },
  expected_close_date: { column: "expected_close_date", nullable: true, parse: parseIsoDate },
  assign_to_person_id: idSpec("owner_person_id")
};

function parsePatch(spec: Record<string, FieldSpec>, input: unknown): Map<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("patch", "må være et objekt");
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) continue;
    const field = spec[key];
    if (!field) return bad(key, "ukjent eller ikke-endrebart felt");
    if (value === null) {
      if (!field.nullable) return bad(key, "kan ikke være tomt");
      out.set(field.column, null);
    } else {
      out.set(field.column, field.parse(key, value));
    }
  }
  if (out.size === 0) return bad("patch", "ingen felt å endre");
  return out;
}

function normalizeKey(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !KEY_RE.test(raw)) throw new BusinessPipelineError("idempotency_key_invalid", "8-128 tegn: a-z A-Z 0-9 . _ : = -");
  return raw;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Små hjelpere
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

function sameValue(column: string, a: unknown, b: unknown): boolean {
  if (a === undefined || a === null) return b === undefined || b === null;
  if (b === undefined || b === null) return false;
  if (column.endsWith("_at")) return new Date(String(a)).getTime() === new Date(String(b)).getTime();
  return a === b;
}

function requestHash(action: PipelineAction, type: PipelineEntityType, entityId: string, input: unknown): string {
  return createHash("sha256").update(canonicalStringify({ v: 1, action, type, entityId, input: input as JsonValue })).digest("hex");
}

async function assertBusinessTarget(client: pg.PoolClient, tenantId: string, space: MemorySpace): Promise<void> {
  if (space !== "business") throw new BusinessPipelineError("not_business_space", space);
  // `tenants_self`-RLS: raden er synlig fordi transaksjonens jarvis.tenant_id ER tenanten vi sjekker.
  const r = await client.query("SELECT kind FROM tenants WHERE tenant_id = $1", [tenantId]);
  if ((r.rows[0] as { kind?: string } | undefined)?.kind !== "business") throw new BusinessPipelineError("not_business_tenant");
}

async function assertMember(client: pg.PoolClient, tenantId: string, personId: string): Promise<void> {
  const r = await client.query("SELECT 1 FROM person_tenants WHERE tenant_id = $1 AND person_id = $2", [tenantId, personId]);
  if (r.rowCount === 0) throw new BusinessPipelineError("reference_not_found", "assign_to_person_id er ikke medlem av tenanten");
}

function mapPgError(err: unknown): unknown {
  const code = (err as { code?: string }).code;
  if (err instanceof BusinessPipelineError) return err;
  if (code === "23503") return new BusinessPipelineError("reference_not_found");
  if (code === "23514" || code === "22P02" || code === "22003" || code === "22007" || code === "22008") return new BusinessPipelineError("invalid_input", "verdien ble avvist av databasen");
  return err;
}

interface BodyOut {
  entity_id: string;
  before: Snap | null;
  after: Snap | null;
  changed_fields: string[];
}
interface Outcome extends BodyOut {
  replayed: boolean;
  change_id: string | null;
}

async function lockEntity(client: pg.PoolClient, type: PipelineEntityType, tenantId: string, id: string): Promise<Snap | null> {
  const { table, idCol } = TABLE[type];
  const r = await client.query(`SELECT to_jsonb(t.*) AS snap FROM ${table} t WHERE t.tenant_id = $1 AND t.${idCol} = $2 FOR UPDATE`, [tenantId, id]);
  return (r.rows[0] as { snap: Snap } | undefined)?.snap ?? null;
}

/** Oppdaterer KUN hvitelistede kolonner (fra faste kart over) - kolonnenavn kommer aldri fra brukerinput. Returnerer etter-tilstand. */
async function applySets(client: pg.PoolClient, type: PipelineEntityType, tenantId: string, id: string, sets: Map<string, SetValue>): Promise<Snap> {
  const { table, idCol } = TABLE[type];
  const values: unknown[] = [tenantId, id];
  const assignments: string[] = [];
  for (const [column, value] of sets) {
    if (!/^[a-z_]+$/.test(column)) throw new Error("pipeline_internal_bad_column");
    if (value === NOW) assignments.push(`${column} = now()`);
    else { values.push(value); assignments.push(`${column} = $${values.length}`); }
  }
  const r = await client.query(
    `UPDATE ${table} SET ${assignments.join(", ")}, updated_at = now() WHERE tenant_id = $1 AND ${idCol} = $2 RETURNING to_jsonb(${table}.*) AS snap`,
    values
  );
  return (r.rows[0] as { snap: Snap }).snap;
}

/** Hvilke av de ønskede kolonnene som faktisk avviker fra dagens verdi (for-diff - hopper over UPDATE uten endring). */
function pendingChanges(before: Snap, wanted: Map<string, SetValue>): Map<string, SetValue> {
  const out = new Map<string, SetValue>();
  for (const [column, value] of wanted) {
    if (value === NOW || !sameValue(column, before[column], value)) out.set(column, value);
  }
  return out;
}

function actuallyChanged(before: Snap, after: Snap, columns: Iterable<string>): string[] {
  return [...columns].filter((c) => !sameValue(c, before[c], after[c]));
}

/**
 * Terminal-overganger holder `closed_at`/`close_reason` konsistent med status/stadium: inn i terminal => `closed_at` settes (på nytt hvis utfallet endres mellom to
 * terminale verdier); ut av terminal => begge nullstilles.
 */
function terminalSets(before: Snap, nextValue: string, column: "status" | "stage", terminal: ReadonlySet<string>): Map<string, SetValue> {
  const sets = new Map<string, SetValue>();
  const wasTerminal = terminal.has(String(before[column]));
  const willBeTerminal = terminal.has(nextValue);
  if (willBeTerminal && (!wasTerminal || before[column] !== nextValue || before["closed_at"] === null)) sets.set("closed_at", NOW);
  if (!willBeTerminal && (before["closed_at"] !== null || before["close_reason"] !== null)) {
    sets.set("closed_at", null);
    sets.set("close_reason", null);
  }
  return sets;
}

export class BusinessPipelineService {
  constructor(private readonly pool: pg.Pool) {}

  // ------------------------------------------------------------------------------------------------------------------------------------------------------
  // Kjernen: én transaksjon per endring, idempotens, tenant-vakt og change-logg
  // ------------------------------------------------------------------------------------------------------------------------------------------------------

  private async mutate(
    tenantId: string,
    space: MemorySpace,
    type: PipelineEntityType,
    action: PipelineAction,
    entityId: string,
    hashInput: unknown,
    ctx: PipelineContext,
    body: (client: pg.PoolClient, changeId: string) => Promise<BodyOut | null>
  ): Promise<Outcome> {
    const key = normalizeKey(ctx.idempotency_key);
    // En opprettelse genererer id-en PER KALL: den kan ikke være en del av innholdshashen, ellers ville et gjentatt kall med samme nøkkel feilaktig bli «annet innhold».
    const hash = requestHash(action, type, action === "create" ? "(new)" : entityId, hashInput);
    const changeId = `biz-chg-${randomUUID()}`;
    try {
      return await withMemoryTransaction(this.pool, tenantId, [space], async (client): Promise<Outcome> => {
        await assertBusinessTarget(client, tenantId, space);
        if (key !== undefined) {
          // Serialiser samtidige kall med SAMME nøkkel: det andre venter til det første er committet og ser da raden under (replay, ikke dobbel effekt).
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340002))", [`${tenantId}|business_change_log|${key}`]);
          const prior = await client.query(
            "SELECT change_id, entity_id, request_hash, before_state, after_state, changed_fields FROM business_change_log WHERE tenant_id = $1 AND idempotency_key = $2",
            [tenantId, key]
          );
          const row = prior.rows[0] as { change_id: string; entity_id: string; request_hash: string; before_state: Snap | null; after_state: Snap | null; changed_fields: string[] } | undefined;
          if (row) {
            if (row.request_hash !== hash) throw new BusinessPipelineError("idempotency_key_conflict");
            return { replayed: true, change_id: row.change_id, entity_id: row.entity_id, before: row.before_state, after: row.after_state, changed_fields: row.changed_fields };
          }
        }
        const out = await body(client, changeId);
        if (!out) throw new BusinessPipelineError("not_found");
        if (out.changed_fields.length === 0) return { ...out, replayed: false, change_id: null };
        await client.query(
          `INSERT INTO business_change_log
             (change_id, tenant_id, memory_space_id, entity_type, entity_id, action, idempotency_key, request_hash, actor_person_id, changed_fields, before_state, after_state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [changeId, tenantId, space, type, out.entity_id, action, key ?? null, key !== undefined ? hash : null, ctx.actor_person_id ?? null, out.changed_fields,
            out.before === null ? null : JSON.stringify(out.before), out.after === null ? null : JSON.stringify(out.after)]
        );
        return { ...out, replayed: false, change_id: changeId };
      });
    } catch (err) {
      throw mapPgError(err);
    }
  }

  private toResult<E>(o: Outcome): PipelineResult<E> {
    return { entity: o.after as unknown as E | null, changed: o.changed_fields.length > 0 && !o.replayed, replayed: o.replayed, change_id: o.change_id, changed_fields: o.changed_fields };
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------
  // Lead
  // ------------------------------------------------------------------------------------------------------------------------------------------------------

  async createLead(
    tenantId: string,
    space: MemorySpace,
    input: {
      title: unknown; company_id?: unknown; contact_id?: unknown; status?: unknown; source?: unknown;
      source_type?: unknown; source_instance_id?: unknown; external_id?: unknown; owner_person_id?: unknown;
    },
    ctx: PipelineContext = {}
  ): Promise<PipelineResult<BusinessLead>> {
    const title = parseText("title", input.title, 1, 300);
    const status = input.status === undefined ? "new" : String(input.status);
    if (!(LEAD_STATUSES as readonly string[]).includes(status)) bad("status", "ukjent lead-status");
    const optId = (f: string, v: unknown): string | null => (v === undefined || v === null ? null : parseId(f, v));
    const optText = (f: string, v: unknown, max: number): string | null => (v === undefined || v === null ? null : parseText(f, v, 1, max));
    const row = {
      company_id: optId("company_id", input.company_id), contact_id: optId("contact_id", input.contact_id), source: optText("source", input.source, 200),
      source_type: optText("source_type", input.source_type, 100), source_instance_id: optText("source_instance_id", input.source_instance_id, 200),
      external_id: optText("external_id", input.external_id, 200), owner_person_id: optId("owner_person_id", input.owner_person_id)
    };
    const entityId = `${TABLE.lead.prefix}${randomUUID()}`;
    const out = await this.mutate(tenantId, space, "lead", "create", entityId, { title, status, ...row }, ctx, async (client) => {
      const r = await client.query(
        `INSERT INTO business_leads (lead_id, tenant_id, memory_space_id, company_id, contact_id, title, status, source, source_type, source_instance_id, external_id, owner_person_id, closed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $7 IN ('disqualified','converted') THEN now() ELSE NULL END)
         ON CONFLICT (tenant_id, source_type, source_instance_id, external_id) DO UPDATE SET title = business_leads.title
         RETURNING to_jsonb(business_leads.*) AS snap, (xmax = 0) AS inserted`,
        [entityId, tenantId, space, row.company_id, row.contact_id, title, status, row.source, row.source_type, row.source_instance_id, row.external_id, row.owner_person_id]
      );
      const { snap, inserted } = r.rows[0] as { snap: Snap; inserted: boolean };
      // Samme kilde-hendelse som en eksisterende lead (idempotent ingestion §22): eksisterende rad returneres UENDRET, ingen change-rad.
      return { entity_id: String(snap["lead_id"]), before: null, after: snap, changed_fields: inserted ? ["created"] : [] };
    });
    return this.toResult<BusinessLead>(out);
  }

  async updateLead(tenantId: string, space: MemorySpace, leadId: string, patch: unknown, ctx: PipelineContext = {}): Promise<PipelineResult<BusinessLead>> {
    const id = parseId("lead_id", leadId);
    const wanted = parsePatch(LEAD_PATCH, patch);
    const out = await this.mutate(tenantId, space, "lead", "update", id, Object.fromEntries(wanted), ctx, async (client) => {
      const before = await lockEntity(client, "lead", tenantId, id);
      if (!before) return null;
      if (wanted.has("owner_person_id") && wanted.get("owner_person_id") !== null) await assertMember(client, tenantId, String(wanted.get("owner_person_id")));
      const pending = pendingChanges(before, wanted);
      if (pending.size === 0) return { entity_id: id, before, after: before, changed_fields: [] };
      const after = await applySets(client, "lead", tenantId, id, pending);
      return { entity_id: id, before, after, changed_fields: actuallyChanged(before, after, pending.keys()) };
    });
    return this.toResult<BusinessLead>(out);
  }

  /** `update_lead_status` (eksisterende klasse C-handling) - nå med lukketidspunkt, before/after og valgfri idempotens. */
  async setLeadStatus(tenantId: string, space: MemorySpace, leadId: string, status: unknown, ctx: PipelineContext = {}): Promise<PipelineResult<BusinessLead>> {
    const id = parseId("lead_id", leadId);
    if (typeof status !== "string" || !(LEAD_STATUSES as readonly string[]).includes(status)) bad("status", "ukjent lead-status");
    const next = status as string;
    const out = await this.mutate(tenantId, space, "lead", "set_status", id, { status: next }, ctx, async (client) => {
      const before = await lockEntity(client, "lead", tenantId, id);
      if (!before) return null;
      const wanted = new Map<string, SetValue>([["status", next], ...terminalSets(before, next, "status", LEAD_TERMINAL)]);
      const pending = pendingChanges(before, wanted);
      if (pending.size === 0) return { entity_id: id, before, after: before, changed_fields: [] };
      const after = await applySets(client, "lead", tenantId, id, pending);
      return { entity_id: id, before, after, changed_fields: actuallyChanged(before, after, pending.keys()) };
    });
    return this.toResult<BusinessLead>(out);
  }

  /** «Lukk med utfall»: terminal status + grunn + lukketidspunkt, og en `status_change`-aktivitet i kundens tidslinje (samme transaksjon). */
  async closeLead(
    tenantId: string, space: MemorySpace, leadId: string, input: { outcome: unknown; reason?: unknown }, ctx: PipelineContext = {}
  ): Promise<PipelineResult<BusinessLead>> {
    const id = parseId("lead_id", leadId);
    if (typeof input.outcome !== "string" || !(LEAD_CLOSE_OUTCOMES as readonly string[]).includes(input.outcome)) bad("outcome", "må være converted eller disqualified");
    const outcome = input.outcome;
    const reason = input.reason === undefined || input.reason === null ? undefined : parseText("reason", input.reason, 1, 500);
    const out = await this.mutate(tenantId, space, "lead", "close", id, { outcome, reason: reason ?? null }, ctx, async (client, changeId) => {
      const before = await lockEntity(client, "lead", tenantId, id);
      if (!before) return null;
      const wanted = new Map<string, SetValue>([["status", outcome], ...terminalSets(before, outcome, "status", LEAD_TERMINAL)]);
      if (reason !== undefined) wanted.set("close_reason", reason);
      else if (before["status"] !== outcome) wanted.set("close_reason", null);
      const pending = pendingChanges(before, wanted);
      if (pending.size === 0) return { entity_id: id, before, after: before, changed_fields: [] };
      const after = await applySets(client, "lead", tenantId, id, pending);
      const changed = actuallyChanged(before, after, pending.keys());
      if (changed.includes("status")) {
        await recordActivityInTransaction(client, tenantId, space, {
          activity_type: "status_change", summary: `Lead lukket som ${outcome}`, lead_id: id,
          ...(typeof after["company_id"] === "string" ? { company_id: after["company_id"] } : {}),
          ...(typeof after["contact_id"] === "string" ? { contact_id: after["contact_id"] } : {}),
          source_type: "business_pipeline", source_instance_id: tenantId, external_id: changeId
        });
      }
      return { entity_id: id, before, after, changed_fields: changed };
    });
    return this.toResult<BusinessLead>(out);
  }

  async deleteLead(tenantId: string, space: MemorySpace, leadId: string, ctx: PipelineContext = {}): Promise<PipelineDeleteResult> {
    return this.deleteEntity(tenantId, space, "lead", leadId, ctx);
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------
  // Opportunity
  // ------------------------------------------------------------------------------------------------------------------------------------------------------

  async createOpportunity(
    tenantId: string,
    space: MemorySpace,
    input: {
      title: unknown; company_id?: unknown; contact_id?: unknown; lead_id?: unknown; stage?: unknown; value_ore?: unknown; currency?: unknown;
      expected_close_date?: unknown; owner_person_id?: unknown;
    },
    ctx: PipelineContext = {}
  ): Promise<PipelineResult<BusinessOpportunity>> {
    const title = parseText("title", input.title, 1, 300);
    const stage = input.stage === undefined ? "new" : String(input.stage);
    if (!(OPPORTUNITY_STAGES as readonly string[]).includes(stage)) bad("stage", "ukjent stadium");
    const optId = (f: string, v: unknown): string | null => (v === undefined || v === null ? null : parseId(f, v));
    const row = {
      company_id: optId("company_id", input.company_id), contact_id: optId("contact_id", input.contact_id), lead_id: optId("lead_id", input.lead_id),
      value_ore: input.value_ore === undefined || input.value_ore === null ? null : parseOre("value_ore", input.value_ore),
      currency: input.currency === undefined ? "NOK" : (typeof input.currency === "string" && /^[A-Z]{3}$/.test(input.currency) ? input.currency : bad("currency", "ugyldig valutakode")),
      expected_close_date: input.expected_close_date === undefined || input.expected_close_date === null ? null : parseIsoDate("expected_close_date", input.expected_close_date),
      owner_person_id: optId("owner_person_id", input.owner_person_id)
    };
    const entityId = `${TABLE.opportunity.prefix}${randomUUID()}`;
    const out = await this.mutate(tenantId, space, "opportunity", "create", entityId, { title, stage, ...row }, ctx, async (client) => {
      const r = await client.query(
        `INSERT INTO business_opportunities (opportunity_id, tenant_id, memory_space_id, company_id, contact_id, lead_id, title, stage, value_ore, currency, expected_close_date, owner_person_id, closed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $8 IN ('won','lost') THEN now() ELSE NULL END)
         RETURNING to_jsonb(business_opportunities.*) AS snap`,
        [entityId, tenantId, space, row.company_id, row.contact_id, row.lead_id, title, stage, row.value_ore, row.currency, row.expected_close_date, row.owner_person_id]
      );
      const snap = (r.rows[0] as { snap: Snap }).snap;
      return { entity_id: entityId, before: null, after: snap, changed_fields: ["created"] };
    });
    return this.toResult<BusinessOpportunity>(out);
  }

  async updateOpportunity(tenantId: string, space: MemorySpace, opportunityId: string, patch: unknown, ctx: PipelineContext = {}): Promise<PipelineResult<BusinessOpportunity>> {
    const id = parseId("opportunity_id", opportunityId);
    const wanted = parsePatch(OPPORTUNITY_PATCH, patch);
    const out = await this.mutate(tenantId, space, "opportunity", "update", id, Object.fromEntries(wanted), ctx, async (client) => {
      const before = await lockEntity(client, "opportunity", tenantId, id);
      if (!before) return null;
      if (wanted.has("owner_person_id") && wanted.get("owner_person_id") !== null) await assertMember(client, tenantId, String(wanted.get("owner_person_id")));
      const pending = pendingChanges(before, wanted);
      if (pending.size === 0) return { entity_id: id, before, after: before, changed_fields: [] };
      const after = await applySets(client, "opportunity", tenantId, id, pending);
      return { entity_id: id, before, after, changed_fields: actuallyChanged(before, after, pending.keys()) };
    });
    return this.toResult<BusinessOpportunity>(out);
  }

  /** `update_opportunity_stage` (eksisterende klasse C-handling): flytt mellom stadier, valgfritt med endelig verdi - nå med before/after og valgfri idempotens. */
  async moveOpportunityStage(
    tenantId: string, space: MemorySpace, opportunityId: string, stage: unknown, valueOre?: unknown, ctx: PipelineContext = {}
  ): Promise<PipelineResult<BusinessOpportunity>> {
    const id = parseId("opportunity_id", opportunityId);
    if (typeof stage !== "string" || !(OPPORTUNITY_STAGES as readonly string[]).includes(stage)) bad("stage", "ukjent stadium");
    const next = stage as string;
    const value = valueOre === undefined || valueOre === null ? undefined : parseOre("value_ore", valueOre);
    const out = await this.mutate(tenantId, space, "opportunity", "move_stage", id, { stage: next, value_ore: value ?? null }, ctx, async (client) => {
      const before = await lockEntity(client, "opportunity", tenantId, id);
      if (!before) return null;
      const wanted = new Map<string, SetValue>([["stage", next], ...terminalSets(before, next, "stage", OPPORTUNITY_TERMINAL)]);
      if (value !== undefined) wanted.set("value_ore", value);
      const pending = pendingChanges(before, wanted);
      if (pending.size === 0) return { entity_id: id, before, after: before, changed_fields: [] };
      const after = await applySets(client, "opportunity", tenantId, id, pending);
      return { entity_id: id, before, after, changed_fields: actuallyChanged(before, after, pending.keys()) };
    });
    return this.toResult<BusinessOpportunity>(out);
  }

  async closeOpportunity(
    tenantId: string, space: MemorySpace, opportunityId: string, input: { outcome: unknown; reason?: unknown; final_value_ore?: unknown }, ctx: PipelineContext = {}
  ): Promise<PipelineResult<BusinessOpportunity>> {
    const id = parseId("opportunity_id", opportunityId);
    if (typeof input.outcome !== "string" || !(OPPORTUNITY_CLOSE_OUTCOMES as readonly string[]).includes(input.outcome)) bad("outcome", "må være won eller lost");
    const outcome = input.outcome;
    const reason = input.reason === undefined || input.reason === null ? undefined : parseText("reason", input.reason, 1, 500);
    const finalValue = input.final_value_ore === undefined || input.final_value_ore === null ? undefined : parseOre("final_value_ore", input.final_value_ore);
    const out = await this.mutate(tenantId, space, "opportunity", "close", id, { outcome, reason: reason ?? null, final_value_ore: finalValue ?? null }, ctx, async (client, changeId) => {
      const before = await lockEntity(client, "opportunity", tenantId, id);
      if (!before) return null;
      const wanted = new Map<string, SetValue>([["stage", outcome], ...terminalSets(before, outcome, "stage", OPPORTUNITY_TERMINAL)]);
      if (reason !== undefined) wanted.set("close_reason", reason);
      else if (before["stage"] !== outcome) wanted.set("close_reason", null);
      if (finalValue !== undefined) wanted.set("value_ore", finalValue);
      const pending = pendingChanges(before, wanted);
      if (pending.size === 0) return { entity_id: id, before, after: before, changed_fields: [] };
      const after = await applySets(client, "opportunity", tenantId, id, pending);
      const changed = actuallyChanged(before, after, pending.keys());
      if (changed.includes("stage")) {
        await recordActivityInTransaction(client, tenantId, space, {
          activity_type: "status_change", summary: `Mulighet lukket som ${outcome}`, opportunity_id: id,
          ...(typeof after["company_id"] === "string" ? { company_id: after["company_id"] } : {}),
          ...(typeof after["contact_id"] === "string" ? { contact_id: after["contact_id"] } : {}),
          ...(typeof after["lead_id"] === "string" ? { lead_id: after["lead_id"] } : {}),
          source_type: "business_pipeline", source_instance_id: tenantId, external_id: changeId
        });
      }
      return { entity_id: id, before, after, changed_fields: changed };
    });
    return this.toResult<BusinessOpportunity>(out);
  }

  async deleteOpportunity(tenantId: string, space: MemorySpace, opportunityId: string, ctx: PipelineContext = {}): Promise<PipelineDeleteResult> {
    return this.deleteEntity(tenantId, space, "opportunity", opportunityId, ctx);
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------
  // Neste handling (begge entiteter)
  // ------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Erstatter HELE paret (tekst + valgfri frist); `next_action: null` nullstiller begge. Bumper `updated_at` (stagnasjonsvinduet starter på nytt). */
  async setNextAction(
    tenantId: string, space: MemorySpace, type: PipelineEntityType, entityId: string, input: { next_action: unknown; next_action_due_at?: unknown }, ctx: PipelineContext = {}
  ): Promise<PipelineResult<BusinessLead | BusinessOpportunity>> {
    if (type !== "lead" && type !== "opportunity") bad("entity_type", "må være lead eller opportunity");
    const id = parseId("entity_id", entityId);
    const text = input.next_action === null ? null : parseText("next_action", input.next_action, 1, 500);
    const due = input.next_action_due_at === undefined || input.next_action_due_at === null ? null : parseTimestamp("next_action_due_at", input.next_action_due_at);
    if (text === null && due !== null) bad("next_action_due_at", "kan ikke settes uten next_action");
    const out = await this.mutate(tenantId, space, type, "set_next_action", id, { next_action: text, next_action_due_at: due }, ctx, async (client) => {
      const before = await lockEntity(client, type, tenantId, id);
      if (!before) return null;
      const wanted = new Map<string, SetValue>([["next_action", text], ["next_action_due_at", due]]);
      const pending = pendingChanges(before, wanted);
      if (pending.size === 0) return { entity_id: id, before, after: before, changed_fields: [] };
      const after = await applySets(client, type, tenantId, id, pending);
      return { entity_id: id, before, after, changed_fields: actuallyChanged(before, after, pending.keys()) };
    });
    return this.toResult<BusinessLead | BusinessOpportunity>(out);
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------
  // Sletting (klasse C)
  // ------------------------------------------------------------------------------------------------------------------------------------------------------

  private async deleteEntity(tenantId: string, space: MemorySpace, type: PipelineEntityType, entityId: string, ctx: PipelineContext): Promise<PipelineDeleteResult> {
    const id = parseId(`${type}_id`, entityId);
    const { table, idCol } = TABLE[type];
    const out = await this.mutate(tenantId, space, type, "delete", id, {}, ctx, async (client) => {
      const before = await lockEntity(client, type, tenantId, id);
      if (!before) return null;
      const detached = { opportunities: 0, followups: 0, activities: 0 };
      const removed = { open_loops: 0, scores: 0 };
      try {
        if (type === "lead") {
          detached.opportunities = (await client.query("UPDATE business_opportunities SET lead_id = NULL, updated_at = now() WHERE tenant_id = $1 AND lead_id = $2", [tenantId, id])).rowCount ?? 0;
        }
        detached.followups = (await client.query(`UPDATE business_followups SET ${idCol} = NULL, updated_at = now() WHERE tenant_id = $1 AND ${idCol} = $2`, [tenantId, id])).rowCount ?? 0;
        detached.activities = (await client.query(`UPDATE business_activities SET ${idCol} = NULL WHERE tenant_id = $1 AND ${idCol} = $2`, [tenantId, id])).rowCount ?? 0;
        removed.open_loops = (await client.query(`DELETE FROM business_open_loops WHERE tenant_id = $1 AND ${idCol} = $2`, [tenantId, id])).rowCount ?? 0;
        removed.scores = (await client.query("DELETE FROM business_scores WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3", [tenantId, type, id])).rowCount ?? 0;
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND ${idCol} = $2`, [tenantId, id]);
      } catch (err) {
        // Rader i andre memory spaces enn `business` som fortsatt peker på entiteten kan ikke detaches under denne konteksten - da slettes ingenting.
        if ((err as { code?: string }).code === "23503") throw new BusinessPipelineError("has_dependents");
        throw err;
      }
      return { entity_id: id, before, after: { deleted: true, detached, removed } as unknown as Snap, changed_fields: ["deleted"] };
    });
    const after = (out.after ?? {}) as unknown as { detached?: PipelineDeleteResult["detached"]; removed?: PipelineDeleteResult["removed"] };
    return {
      deleted: true, entity_id: out.entity_id, replayed: out.replayed, change_id: out.change_id as string,
      detached: after.detached ?? { opportunities: 0, followups: 0, activities: 0 }, removed: after.removed ?? { open_loops: 0, scores: 0 }
    };
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------------
  // Lesing: forhåndssnapshot for ToolGateway sin klasse C-evidens (før/etter i audit_events)
  // ------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Saneret snapshot for gatewayens før/etter-evidens (`preflight_action`): kun struktur (id-er, status, beløp, datoer) og en kort HASH av tittelen - ALDRI tittel,
   * neste-handling-tekst eller lukkegrunn. `audit_events` er append-only og kan ikke slettes av erasure (APPEND_ONLY_EVIDENCE); fritekst hører hjemme i
   * `business_change_log` (RLS + erasure). Returnerer null når raden ikke finnes.
   */
  async inspect(tenantId: string, space: MemorySpace, type: PipelineEntityType, entityId: string): Promise<Record<string, JsonValue> | null> {
    const id = parseId(`${type}_id`, entityId);
    const { table, idCol } = TABLE[type];
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const r = await client.query(`SELECT to_jsonb(t.*) AS snap FROM ${table} t WHERE t.tenant_id = $1 AND t.${idCol} = $2`, [tenantId, id]);
      const snap = (r.rows[0] as { snap: Snap } | undefined)?.snap;
      if (!snap) return null;
      const { title, next_action, close_reason, source, ...rest } = snap as Record<string, JsonValue>;
      return {
        ...rest,
        title_sha256_12: createHash("sha256").update(String(title ?? "")).digest("hex").slice(0, 12),
        has_next_action: next_action !== null && next_action !== undefined,
        has_close_reason: close_reason !== null && close_reason !== undefined,
        has_source: source !== null && source !== undefined
      };
    });
  }

  /** De siste endringene for én entitet (nyeste først) - full før/etter. RLS-skopet; kun lesing. */
  async listChanges(tenantId: string, space: MemorySpace, type: PipelineEntityType, entityId: string, limit = 20): Promise<Array<Record<string, unknown>>> {
    const id = parseId("entity_id", entityId);
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const r = await client.query(
        `SELECT change_id, action, changed_fields, actor_person_id, idempotency_key, before_state, after_state, created_at
           FROM business_change_log WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at DESC LIMIT $4`,
        [tenantId, type, id, Math.min(Math.max(Math.trunc(limit), 1), 100)]
      );
      return r.rows as Array<Record<string, unknown>>;
    });
  }
}
