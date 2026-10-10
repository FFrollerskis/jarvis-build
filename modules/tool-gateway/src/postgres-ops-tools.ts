import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolTransport } from "./gateway.ts";
import { authorizePostgresOpsTarget, type PostgresOpsConfig, type PostgresOpsMutationAction } from "./postgres-ops-target-policy.ts";

/**
 * WP-E1 (UA-5, D-41 maksimal kapabilitet, regel 11): `ToolDefinition`-ene for Postgres-DRIFT (`postgres_ops`). Diagnostikk = klasse A (utdata er ubetrodd:
 * spørringstekst fra applikasjonen, normalisert). `terminate_backend`/`cancel_query`/`vacuum_analyze` = klasse D («DNS/IAM/WAF/secrets og kritisk infra er klasse D»,
 * masterplan UA-5) med HELE kjeden (`assessClassDPipeline`):
 *   1. fersk tilstandslesing + målvalidering (`preflight_action`/`preflight_requires_target`/`preflight_target_check`) - økten må fortsatt være DEN SAMME økten,
 *   2. snapshot (økt, rolle, applikasjon, normalisert spørring, varighet) = `before_state` i `tool_executions` og `infra_executions`,
 *   3. idempotens-nøkkel PÅKREVD,
 *   4. etterbetingelse (readback): økten er borte / spørringen kjører ikke lenger / tabellen er vacuumet nylig,
 *   5. umiddelbar out-of-band-varsling (`ClassDNotifier`),
 *   6. gjenoppretting: BEVISST ærlig «ingen teknisk reversering» (en terminert økt kan ikke gjenopprettes; applikasjonen kobler til på nytt) - journalføres som
 *      `recovery_available=false`, aldri en fabrikkert reversering.
 * Mål-autorisasjon (database/skjema står i eierens lister) håndheves av `parameterAuthorizer` i selve gateway-pipelinen. Verktøy-id `postgres_ops` står i
 * `INFRA_GATED_TOOL_IDS` (PAUSED stanser skriving, DEGRADED stanser D, lesing stanses aldri) og er et eier-eksklusivt navnerom som aldri kan stå på en modellflate.
 * Credential uten verdi (`JARVIS_POSTGRES_OPS_URL` ikke satt) => `credential_unavailable` for ALLE handlinger: connectoren er sovende til eieren har opprettet rollen.
 *
 * STEP-UP (gjennomgang av PR #324, M2): alle tre klasse D-handlingene har `step_up_required: true` - gatewayen SELV nekter uten enhetssignert økt fra en eier-kanal (web/desktop/api/mobile; aldri
 * tale/Telegram/meldingsplattform/system). Å terminere en produksjonsøkt eller starte VACUUM krever mer enn SOVEREIGN-modus alene. Standard = strengest; kan lempes av Tobias per handling (navngitt D-beslutning).
 */
export const POSTGRES_OPS_CREDENTIAL_REF = "JARVIS_POSTGRES_OPS_URL";

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;
const pid = z.number().int().min(1).max(2_147_483_647);
const database = z.string().min(1).max(63);
const pgTimestamp = z.string().min(20).max(32);
const ident = z.string().min(1).max(63);

type Params = Record<string, JsonValue>;
interface BackendView { present?: boolean; state?: string | null; query_start?: string | null; backend_start?: string | null }
interface TableView { seconds_since_vacuum?: number | null; seconds_since_analyze?: number | null }

/** Hvor ferskt «nylig vacuumet» må være for at etterbetingelsen holder (sekunder). */
const VACUUM_FRESH_SECONDS = 300;

export function postgresOpsToolDefinitions(transport: ToolTransport, config: { ops: PostgresOpsConfig }): ToolDefinition[] {
  const authorizer = (action: PostgresOpsMutationAction) => (parameters: Params) => authorizePostgresOpsTarget(action, parameters, config.ops);

  const read = (action: string, description: string, shape: z.ZodRawShape = {}): ToolDefinition => ({
    tool_id: "postgres_ops", action, description, input_schema: record(shape), capability_class: "A", scopes: ["postgres_ops:read"],
    reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true, timeout_ms: 25_000, rate_limit_per_minute: 30,
    credential_ref: POSTGRES_OPS_CREDENTIAL_REF, output_trust: "untrusted", transport
  });
  const write = (
    action: PostgresOpsMutationAction,
    description: string,
    shape: z.ZodRawShape,
    extra: Pick<ToolDefinition, "rollback_procedure" | "preflight_action"> & Partial<ToolDefinition>
  ): ToolDefinition => ({
    tool_id: "postgres_ops", action, description, input_schema: record(shape), capability_class: "D", scopes: ["postgres_ops:write"],
    reversible: false, idempotent_external: false, timeout_ms: 30_000, rate_limit_per_minute: 6,
    credential_ref: POSTGRES_OPS_CREDENTIAL_REF, output_trust: "internal", transport,
    parameterAuthorizer: authorizer(action),
    step_up_required: true,
    ...extra
  });

  return [
    read("get_connections", "Tilkoblinger mot max_connections: antall per tilstand, database, rolle og applikasjon (uten spørringstekst)"),
    read("get_long_running_queries", "Lange spørringer og åpne transaksjoner (varighet, ventehendelse, NORMALISERT spørringstekst uten literaler) - gir pid + backend_start + query_start som terminate/cancel krever",
      { min_seconds: z.number().min(1).max(86_400).optional(), limit: z.number().int().min(1).max(50).optional() }),
    read("get_locks", "Låser: hvem blokkerer hvem (pg_blocking_pids), med varighet og normalisert spørringstekst"),
    read("get_table_sizes", "Største tabeller (total/tabell-størrelse, levende/døde tupler, siste vacuum/analyze) i tilkoblingens database", { limit: z.number().int().min(1).max(50).optional() }),
    read("get_bloat_estimate", "Bloat-ESTIMAT: tabeller med flest døde tupler relativt til levende (ikke byte-nøyaktig) - kandidat for vacuum_analyze",
      { limit: z.number().int().min(1).max(50).optional(), min_dead_tuples: z.number().int().min(0).max(1_000_000_000).optional() }),
    read("get_replication_status", "Replikasjonsstatus: rolle (primær/standby), tilkoblede replikaer med lag, replikasjonsslots og WAL-mottaker"),
    read("get_migration_state", "Migrasjonstilstand: anvendt/ventende/endret sjekksum/ukjent i databasen mot filene i koden (skrivebeskyttet)"),
    read("get_backend", "Les én økt identifisert med pid + database + backend_start (null hvis den ikke finnes) - preflight/readback for terminate_backend", { pid, database, backend_start: pgTimestamp }),
    read("get_query_state", "Les tilstanden til én økt (alltid et objekt; present:false hvis borte) - preflight/readback for cancel_query", { pid, database, backend_start: pgTimestamp }),
    read("get_table_stats", "Les vacuum/analyze-statistikk for én tabell (null hvis den ikke finnes) - preflight/readback for vacuum_analyze", { database, schema: ident, table: ident }),

    write("terminate_backend", "Terminer en økt (pg_terminate_backend) identifisert med pid + backend_start + database; nekter superbruker-/ikke-klient-/egen/beskyttet økt - kun databaser i JARVIS_POSTGRES_OPS_DATABASES",
      { pid, database, backend_start: pgTimestamp },
      {
        rollback_procedure: "ingen teknisk reversering - en terminert økt kan ikke gjenopprettes; applikasjonen kobler til på nytt. Før-tilstand (økt, rolle, applikasjon, normalisert spørring, varighet) er journalført.",
        preflight_action: "get_backend", preflight_requires_target: true, postcondition_target_absent: true
      }),
    write("cancel_query", "Avbryt den pågående spørringen (pg_cancel_backend) i en økt identifisert med pid + backend_start + query_start; rører ikke en ny spørring økten har begynt på siden listingen",
      { pid, database, backend_start: pgTimestamp, query_start: pgTimestamp },
      {
        rollback_procedure: "ingen teknisk reversering - en avbrutt spørring kan ikke gjenopptas; klienten kan kjøre den på nytt. Før-tilstand (økt, normalisert spørring, varighet) er journalført.",
        preflight_action: "get_query_state",
        preflight_target_check: (state, p) => {
          const s = state as BackendView | null;
          return s?.present === true && s.state === "active" && s.query_start === p["query_start"];
        },
        postcondition_predicate: (after, p) => {
          const s = after as BackendView | null;
          return s !== null && (s.present === false || s.state !== "active" || s.query_start !== p["query_start"]);
        }
      }),
    write("vacuum_analyze", "Kjør VACUUM (ANALYZE) - eller kun ANALYZE med analyze_only - på én navngitt tabell i et autorisert skjema (SHARE UPDATE EXCLUSIVE: blokkerer ikke lesing/skriving). VACUUM FULL er ikke tilgjengelig",
      { database, schema: ident, table: ident, analyze_only: z.boolean().optional() },
      {
        rollback_procedure: "ingen reversering nødvendig - VACUUM/ANALYZE endrer ikke data og er idempotent; før-statistikk (døde tupler, siste vacuum/analyze) er journalført.",
        reversible: true, idempotent_external: true, timeout_ms: 300_000, rate_limit_per_minute: 3,
        preflight_action: "get_table_stats", preflight_requires_target: true,
        postcondition_predicate: (after, p) => {
          const s = after as TableView | null;
          if (!s) return false;
          const age = p["analyze_only"] === true ? s.seconds_since_analyze : s.seconds_since_vacuum;
          return typeof age === "number" && age >= 0 && age < VACUUM_FRESH_SECONDS;
        }
      })
  ];
}
