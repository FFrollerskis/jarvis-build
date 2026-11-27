import { z } from "zod";
import { MemorySpaceSchema } from "../identity.ts";
import { DataSensitivitySchema } from "../model.ts";
import { COMPONENT_ID, D_REF, EVENT_TYPE, FINGERPRINT, GIT_SHA, LOG_D_REF, MIGRATION_FILE, REPO_PATH, SEMVER, SHA256_HEX, TABLE_NAME } from "./ids.ts";
import { rangeIsValid } from "./semver.ts";

/**
 * WP-PGA / PG1 (HF6 §24.3, PGA-D-03): SKJEMAENE for den maskinlesbare programindeksen. Indeksen er SHARDET: én fil per komponent (`config/program/components/<component_id>.json`) pluss en liten
 * manifestfil (plan-adopsjonsstatus og vaktregler) og en baseline-fil. Parallelle pakker legger til komponenter/tabeller/hendelsestyper i hver sin fil, så merger blir konfliktfrie.
 *
 * Ren modul: ingen filsystem, ingen kjøretidsimport (ikke eksportert fra `@jarvis/contracts`-barrelen). Alle objekter er `.strict()`: et ukjent felt er en feil, ikke en stille utvidelse.
 * Feltene følger §24.3 (component_id, canonical_owner, contract/schema_version, state_store, events_in/out, dependencies, risk, runtime_state, evidence_ref, owner/escalation) pluss repo-tillegg
 * (kodestier, kontraktfiler med fingeravtrykk, ventende arbeid). Eier = en ROLLE (`owner`), aldri en persons navn.
 */

const TEXT = (min: number, max: number) => z.string().min(min).max(max);
const RepoPathSchema = z.string().max(200).regex(REPO_PATH);
export const ComponentIdSchema = z.string().max(64).regex(COMPONENT_ID);
const SemverSchema = z.string().regex(SEMVER);
const FingerprintSchema = z.string().regex(FINGERPRINT);
const InstantSchema = z.string().datetime();
const TableNameSchema = z.string().regex(TABLE_NAME);
const MigrationFileSchema = z.string().regex(MIGRATION_FILE);
const unique = (items: readonly string[]): boolean => new Set(items).size === items.length;

export const PLAN_IDS = ["HF1", "HF2", "HF3", "HF4", "HF5", "HF6"] as const;
export const PlanIdSchema = z.enum(PLAN_IDS);
export type PlanId = z.infer<typeof PlanIdSchema>;

export const COMPONENT_KINDS = ["app", "package", "module", "service", "tool", "planned"] as const;
/** planned = finnes ikke i kode; built_unwired = bygd, ingen kjøretidsimport; dormant = koblet men flagg AV; active = koblet og på; degraded/frozen/retired som i HF6 §24.3. */
export const RUNTIME_STATES = ["planned", "built_unwired", "dormant", "active", "degraded", "frozen", "retired"] as const;
/** ADR-001 §2.4-ordforrådet: ingenting er VERIFIED uten et lenket artefakt. */
export const VERIFICATION_STATES = ["NOT_VERIFIED", "CODE_FIXED", "DEPLOYED_UNVERIFIED", "VERIFIED"] as const;
export const AUTHORITY_DOMAINS = ["none", "identity", "policy", "tools", "models", "memory", "finance", "comms", "infra", "self_change", "business", "personal", "knowledge", "learning", "diagnostics", "program"] as const;

/**
 * En gjenverifiserbar referanse til evidens (PGA-D-08): stien til en evidensfil under `docs/evidence/`, filens sha256, git-SHA koden stod på ved registrering og to tidspunkt
 * (når evidensen ble til, og når den ble registrert). `contract_fingerprints` er et øyeblikksbilde av de bundne komponentenes kontraktfingeravtrykk ved registrering:
 * endres fingeravtrykket senere, er evidensen foreldet (gate OPEN igjen) - selv om noen glemte å oppdatere `changed_at`.
 */
export const EvidenceRefSchema = z
  .object({
    path: z.string().max(200).regex(/^docs\/evidence\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/),
    sha256: z.string().regex(SHA256_HEX),
    git_sha: z.string().regex(GIT_SHA),
    recorded_at: InstantSchema,
    verified_at: InstantSchema,
    verified_at_source: z.enum(["evidence_header", "flag", "registration_time"]),
    contract_fingerprints: z.record(ComponentIdSchema, FingerprintSchema.nullable())
  })
  .strict()
  .refine((e) => Date.parse(e.verified_at) <= Date.parse(e.recorded_at), { message: "verified_at kan ikke ligge etter recorded_at", path: ["verified_at"] });
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

const EventOutSchema = z
  .object({
    type: z.string().regex(EVENT_TYPE),
    schema_version: SemverSchema.nullable(),
    /** planned = ingen kontrakt i kode ennå; contract_only = typet kontrakt finnes, aldri sendt; active = sendes i kjøretid. */
    status: z.enum(["planned", "contract_only", "active"]),
    idempotency: TEXT(1, 160).nullable(),
    contract_ref: RepoPathSchema.nullable()
  })
  .strict()
  .superRefine((e, ctx) => {
    const planned = e.status === "planned";
    if (planned && e.contract_ref !== null) ctx.addIssue({ code: "custom", path: ["contract_ref"], message: "en planlagt hendelse har ingen kontraktreferanse ennå" });
    if (!planned && e.contract_ref === null) ctx.addIssue({ code: "custom", path: ["contract_ref"], message: "contract_only/active krever en kontraktreferanse" });
    if (planned && e.schema_version !== null) ctx.addIssue({ code: "custom", path: ["schema_version"], message: "en planlagt hendelse har ingen skjemaversjon ennå" });
    if (!planned && e.schema_version === null) ctx.addIssue({ code: "custom", path: ["schema_version"], message: "contract_only/active krever skjemaversjon" });
  });

const DependencySchema = z
  .object({ component_id: ComponentIdSchema, min: SemverSchema, max: z.string().min(1).max(20) })
  .strict()
  .refine((d) => rangeIsValid({ min: d.min, max: d.max }), { message: "ugyldig versjonsintervall (min/max)", path: ["max"] });

const StateStoreSchema = z
  .object({
    /** Autoritative tabeller som finnes i migrasjonene. */
    tables: z.array(TableNameSchema).max(200),
    /** Tabeller en plan navngir, men som ikke finnes i migrasjonene ennå. */
    planned_tables: z.array(TableNameSchema).max(60),
    /** Tabeller koden lager selv ved kjøring (ikke i migrasjonene), f.eks. migratorens loggtabell. */
    runtime_tables: z.array(TableNameSchema).max(20),
    /** Migrasjonsfiler komponenten har laget/endret tabeller i (pluss evt. andre den eier). */
    migrations: z.array(MigrationFileSchema).max(200),
    /** Compose-tjenester komponenten eier. */
    services: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/)).max(20),
    /** Autoritative filer (konfig/manifest) utenfor databasen. */
    files: z.array(RepoPathSchema).max(20)
  })
  .strict();

const RiskSchema = z
  .object({
    /** Høyeste datasensitivitet komponenten lagrer eller håndterer (modellflatens skala). */
    data_sensitivity: DataSensitivitySchema,
    memory_spaces: z.array(MemorySpaceSchema).max(7),
    /** Høyeste handlingsklasse (A-D) komponenten kan utføre; «none» = ingen handlinger. */
    max_action_class: z.enum(["none", "A", "B", "C", "D"]),
    authority_domain: z.enum(AUTHORITY_DOMAINS)
  })
  .strict()
  .refine((r) => unique(r.memory_spaces), { message: "duplikate minneområder", path: ["memory_spaces"] });

const PendingWorkSchema = z
  .object({
    wp: z.string().min(2).max(40),
    note: TEXT(3, 300),
    /** Migrasjonsnumre (tresifret) pakken har reservert. */
    reserved_migrations: z.array(z.string().regex(/^\d{3}$/)).max(10)
  })
  .strict()
  .refine((w) => unique(w.reserved_migrations), { message: "duplikate reserverte migrasjoner", path: ["reserved_migrations"] });

export const ComponentShardSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    component_id: ComponentIdSchema,
    title: TEXT(3, 120),
    summary: TEXT(10, 400),
    kind: z.enum(COMPONENT_KINDS),
    canonical_owner: z
      .object({ plan: PlanIdSchema, subsystem: TEXT(2, 80), d_refs: z.array(z.string().regex(D_REF)).max(12) })
      .strict()
      .refine((o) => unique(o.d_refs), { message: "duplikate beslutningsreferanser", path: ["d_refs"] }),
    runtime_state: z.enum(RUNTIME_STATES),
    verification: z.enum(VERIFICATION_STATES),
    last_verified: InstantSchema.nullable(),
    evidence_ref: EvidenceRefSchema.nullable(),
    contract: z
      .object({
        version: SemverSchema.nullable(),
        schema_version: SemverSchema.nullable(),
        /** Filer hvis bytes definerer kontrakten (hashes inn i fingeravtrykket). */
        files: z.array(RepoPathSchema).max(60),
        fingerprint: FingerprintSchema.nullable(),
        /** Tidspunkt for siste kontraktendring (settes av `fingerprint --write`). Evidens eldre enn dette er foreldet. */
        changed_at: InstantSchema.nullable()
      })
      .strict(),
    /** Kataloger/filer (repo-relative) komponentens kode bor i. En katalog dekker alt under den. */
    code_paths: z.array(RepoPathSchema).max(60),
    state_store: StateStoreSchema,
    events_out: z.array(EventOutSchema).max(60),
    events_in: z.array(z.object({ type: z.string().regex(EVENT_TYPE) }).strict()).max(60),
    dependencies: z.array(DependencySchema).max(60),
    risk: RiskSchema,
    owner: z.object({ role: z.enum(["owner", "platform_operator"]), escalation: TEXT(2, 120), runbook: RepoPathSchema.nullable() }).strict(),
    /** Pakker som er under arbeid og berører komponenten (kun det som er kjent; ingen antatte detaljer). */
    pending_work: z.array(PendingWorkSchema).max(10),
    notes: z.array(TEXT(3, 400)).max(10)
  })
  .strict()
  .superRefine((c, ctx) => {
    const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const isPlanned = c.runtime_state === "planned";
    if (isPlanned !== (c.kind === "planned")) add(["kind"], "kind «planned» og runtime_state «planned» hører sammen");
    const ss = c.state_store;
    const owns = ss.tables.length > 0 || ss.runtime_tables.length > 0;
    if (isPlanned) {
      if (c.code_paths.length > 0) add(["code_paths"], "en planlagt komponent har ingen kode ennå");
      if (ss.tables.length + ss.runtime_tables.length + ss.migrations.length + ss.services.length + ss.files.length > 0) add(["state_store"], "en planlagt komponent har ingen eksisterende lagring (bruk planned_tables)");
      if (c.contract.version !== null || c.contract.schema_version !== null || c.contract.files.length > 0 || c.contract.fingerprint !== null || c.contract.changed_at !== null) add(["contract"], "en planlagt komponent har ingen kontrakt ennå");
      // Fiks 1 (S06): uten kode finnes ingen kontrakt, så en planlagt komponent kan ikke ha en `contract_only`/`active`-hendelse (skanningen sjekker ikke kontraktstiene til planlagte komponenter).
      if (c.events_out.some((e) => e.status !== "planned")) add(["events_out"], "en planlagt komponent har kun planlagte hendelser (ingen kode ennå)");
    } else {
      if (c.code_paths.length === 0) add(["code_paths"], "en bygd komponent har minst én kodesti");
      if (c.contract.version === null) add(["contract", "version"], "en bygd komponent har en kontraktversjon");
      if (c.contract.changed_at === null) add(["contract", "changed_at"], "en bygd komponent har et tidspunkt for siste kontraktendring");
      if ((c.contract.schema_version !== null) !== owns) add(["contract", "schema_version"], "schema_version finnes hvis og bare hvis komponenten eier tabeller");
    }
    if ((c.contract.fingerprint === null) !== (c.contract.files.length === 0)) add(["contract", "fingerprint"], "fingeravtrykk finnes hvis og bare hvis kontraktfiler finnes");
    if (c.verification === "VERIFIED" && (c.evidence_ref === null || c.last_verified === null)) add(["verification"], "VERIFIED krever evidence_ref og last_verified (PGA-D-08)");
    if (c.evidence_ref !== null && c.last_verified === null) add(["last_verified"], "en evidence_ref krever last_verified");
    for (const [name, list] of [
      ["code_paths", c.code_paths],
      ["contract.files", c.contract.files],
      ["state_store.tables", ss.tables],
      ["state_store.planned_tables", ss.planned_tables],
      ["state_store.runtime_tables", ss.runtime_tables],
      ["state_store.migrations", ss.migrations],
      ["state_store.services", ss.services],
      ["state_store.files", ss.files],
      ["events_out", c.events_out.map((e) => e.type)],
      ["events_in", c.events_in.map((e) => e.type)],
      ["dependencies", c.dependencies.map((d) => d.component_id)]
    ] as Array<[string, readonly string[]]>) {
      if (!unique(list)) add(name.split("."), `duplikater i ${name}`);
    }
    const all = [...ss.tables, ...ss.planned_tables, ...ss.runtime_tables];
    if (!unique(all)) add(["state_store"], "tables, planned_tables og runtime_tables må være disjunkte");
    if (c.dependencies.some((d) => d.component_id === c.component_id)) add(["dependencies"], "en komponent kan ikke avhenge av seg selv");
  });
export type ComponentShard = z.infer<typeof ComponentShardSchema>;

const RegexString = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (s) => {
      try {
        new RegExp(s);
        return true;
      } catch {
        return false;
      }
    },
    { message: "ugyldig regulært uttrykk" }
  );

const PlanEntrySchema = z
  .object({
    plan: PlanIdSchema,
    domain: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
    version: z.string().regex(/^v\d+\.\d+(?:\.\d+)?$/),
    /** ACTIVE = eierens navngitte beslutning har adoptert denne versjonen som styrende; alt annet er ikke styrende ennå. */
    status: z.enum(["ACTIVE", "ACKNOWLEDGED_NOT_ADOPTED", "NOT_ADOPTED", "SUPERSEDED"]),
    /** Beslutningen (`D-nnn` i loggen) eller dokumentet (repo-sti) som begrunner statusen. ACTIVE krever en. */
    decision_ref: z.string().max(200).regex(REPO_PATH).nullable()
  })
  .strict()
  .refine((p) => p.status !== "ACTIVE" || p.decision_ref !== null, { message: "ACTIVE krever en navngitt beslutning (decision_ref)", path: ["decision_ref"] })
  // Fiks 1 (M5, D7): «ACTIVE» er eierens adopsjon av planversjonen og skal peke på en NAVNGITT beslutning (`D-nnn` i loggen; skanningen sjekker at raden finnes), aldri på et vilkårlig dokument.
  .refine((p) => p.status !== "ACTIVE" || (p.decision_ref !== null && LOG_D_REF.test(p.decision_ref)), { message: "ACTIVE krever en beslutning i beslutningsloggen (D-nnn), ikke et dokument eller en plan-intern id", path: ["decision_ref"] });
export type PlanEntry = z.infer<typeof PlanEntrySchema>;

export const ManifestSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    guard: z.object({ mode: z.enum(["report", "enforce"]) }).strict(),
    plans: z.array(PlanEntrySchema).min(1).max(30),
    coverage: z
      .object({
        /** Hver direkte underkatalog av disse (apps/*, modules/*, packages/*) må dekkes av minst én komponents code_paths. */
        workspace_roots: z.array(RepoPathSchema).min(1).max(10),
        migrations_dir: RepoPathSchema,
        compose_file: RepoPathSchema,
        /** Hver `.ts`-fil rett under disse må stå i en komponents contract.files. */
        contract_roots: z.array(RepoPathSchema).max(10)
      })
      .strict(),
    exclusive_names: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
            /** Matches TABELLNAVN (aldri kolonnenavn: et `*_id`-felt er en referanse til sannhetskilden). */
            pattern: RegexString,
            allowed_owner_patterns: z.array(RegexString).min(1).max(10),
            reason: TEXT(10, 300),
            /** Eksplisitte, begrunnede unntak for EKSISTERENDE tabeller (nøyaktig tabell hos nøyaktig eier). Å legge til et unntak er en svekkelse: minimumsreglene (`frozen-rules.ts`) tillater bare de kjente. */
            exceptions: z.array(z.object({ table: TableNameSchema, owner: z.string().max(64).regex(COMPONENT_ID), reason: TEXT(10, 300) }).strict()).max(20).optional()
          })
          .strict()
      )
      .max(20),
    reserved_prefixes: z
      .array(z.object({ prefix: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/), owner_patterns: z.array(RegexString).min(1).max(10), reason: TEXT(10, 300) }).strict())
      .max(30),
    no_active_state: z
      .object({ table_prefix: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), forbidden_literal_pattern: RegexString, forbidden_column_pattern: RegexString, reason: TEXT(10, 300) })
      .strict()
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00.000Z`);
    return Number.isFinite(t) && new Date(t).toISOString().startsWith(s);
  }, { message: "ugyldig dato" });

/** Baseline: kjente brudd som kan bare KRYMPE. Hver oppføring er `<regel>:<subjekt>` (samme id som funnet har). */
export const BaselineSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    entries: z
      .array(
        z
          .object({
            id: z.string().min(3).max(200).regex(/^[a-z][a-z_]*:[A-Za-z0-9_.:/@-]+$/),
            reason: TEXT(10, 300),
            since: IsoDate,
            decision_ref: z.string().regex(D_REF).nullable()
          })
          .strict()
      )
      .max(500)
  })
  .strict()
  .refine((b) => unique(b.entries.map((e) => e.id)), { message: "duplikate baseline-id-er", path: ["entries"] });
export type Baseline = z.infer<typeof BaselineSchema>;
