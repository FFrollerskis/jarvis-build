import { z } from "zod";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { MemoryWriter } from "@jarvis/memory";
import type { ToolDefinition, ToolTransport } from "./gateway.ts";

/**
 * Første bølge-adaptere (INTEGRATIONS.md §3). Reelle HTTP-transporter krever
 * OAuth-/API-credentials som ikke finnes i miljøet - de er skall og er ærlig
 * UVERIFISERTE. FakeTransport brukes i tester og beviser hele pipelinen.
 * Q-07 (Gmail vs. Outlook) er åpen: adapterne er leverandørnøytrale kontrakter;
 * gmail-* er skallnavn fordi INTEGRATIONS.md lister Gmail i første bølge.
 */
export class FakeTransport implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  constructor(
    private readonly reply: (action: string, parameters: Record<string, JsonValue>) => { external_id?: string; data?: JsonValue } = () => ({ external_id: "ext-1" }),
    private readonly failWith?: string
  ) {}
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    if (this.failWith) {
      throw new Error(this.failWith);
    }
    this.calls.push({ action, parameters });
    return this.reply(action, parameters);
  }
}

/** HTTP-skall: kaster til reelle credentials/endepunkt konfigureres. */
export class UnconfiguredHttpTransport implements ToolTransport {
  constructor(private readonly service: string) {}
  async invoke(): Promise<never> {
    throw new Error(`${this.service}_not_configured`);
  }
}

const empty = z.object({}).strict() as unknown as z.ZodType<Record<string, JsonValue>>;
const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

/** Standard førstebølge-register. transportOverride lar tester injisere fakes. */
export function firstWaveTools(transports: Partial<Record<string, ToolTransport>> = {}): ToolDefinition[] {
  const transport = (key: string) => transports[key] ?? new UnconfiguredHttpTransport(key);
  return [
    {
      tool_id: "github", action: "read_issues", description: "Les issues (untrusted ingestion)",
      input_schema: record({ repo: z.string() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      tool_id: "github", action: "create_pr", description: "Opprett PR fra jobb-branch (aldri merge)",
      input_schema: record({ repo: z.string(), branch: z.string(), title: z.string() }),
      capability_class: "C", scopes: ["repo:write-pr"], reversible: true,
      rollback_procedure: "lukk PR", idempotent_external: false, timeout_ms: 15_000,
      rate_limit_per_minute: 10, credential_ref: "JARVIS_GITHUB_TOKEN",
      output_trust: "internal", transport: transport("github")
    },
    {
      tool_id: "calendar", action: "read_events", description: "Les kalender",
      input_schema: record({ from: z.string(), to: z.string() }), capability_class: "A",
      scopes: ["calendar.readonly"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GOOGLE_TOKEN", output_trust: "untrusted", transport: transport("calendar")
    },
    {
      tool_id: "calendar", action: "create_event", description: "Opprett kalenderhendelse",
      input_schema: record({ title: z.string(), start: z.string(), end: z.string() }),
      capability_class: "C", scopes: ["calendar.events"], reversible: true,
      rollback_procedure: "slett opprettet hendelse via external_id", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("calendar")
    },
    {
      tool_id: "email", action: "read_inbox", description: "Les e-post (untrusted ingestion)",
      input_schema: record({ max: z.number().int().min(1).max(50) }), capability_class: "A",
      scopes: ["mail.readonly"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_EMAIL_TOKEN", output_trust: "untrusted", transport: transport("email")
    },
    {
      // Sending av e-post er klasse D i startfasen (INTEGRATIONS.md: alltid godkjenning).
      tool_id: "email", action: "send", description: "Send e-post (krever signert godkjenning)",
      input_schema: record({ to: z.string(), subject: z.string(), body: z.string() }),
      capability_class: "D", scopes: ["mail.send"], reversible: false,
      rollback_procedure: "ikke reverserbar - derfor klasse D", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 5, credential_ref: "JARVIS_EMAIL_TOKEN",
      output_trust: "internal", transport: transport("email")
    },
    {
      tool_id: "drive", action: "read_document", description: "Les dokument (untrusted ingestion)",
      input_schema: record({ document_id: z.string(), mime_type: z.string().optional() }), capability_class: "A",
      scopes: ["drive.readonly"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_GOOGLE_TOKEN", output_trust: "untrusted", transport: transport("drive")
    },
    {
      tool_id: "telegram", action: "notify", description: "Send varsel til Tobias",
      input_schema: record({ message: z.string().max(4000) }), capability_class: "B",
      scopes: ["bot:send"], reversible: true, rollback_procedure: "send korreksjonsmelding",
      idempotent_external: false, timeout_ms: 10_000, rate_limit_per_minute: 20,
      credential_ref: "JARVIS_TELEGRAM_TOKEN", output_trust: "internal", transport: transport("telegram")
    },
    {
      tool_id: "vercel", action: "read_deployments", description: "Les deploy-status",
      input_schema: empty, capability_class: "A", scopes: ["deployments:read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_VERCEL_TOKEN",
      output_trust: "untrusted", transport: transport("vercel")
    },
    {
      // UA-2 P0: repo-metadata for kunnskaps-ingestion (samme scope som read_issues).
      // Lagt til på SLUTTEN av arrayet med hensikt - eksisterende tester bruker
      // posisjonsindeks (f.eks. firstWaveTools({...})[4]) inn i dette arrayet,
      // og en innsetting midt i listen ville forskjøvet dem (regresjon funnet
      // og fikset under denne BO-en).
      tool_id: "github", action: "read_repo_meta", description: "Les repo-metadata (untrusted ingestion)",
      input_schema: record({ repo: z.string() }), capability_class: "A",
      scopes: ["repo:read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GITHUB_TOKEN", output_trust: "untrusted", transport: transport("github")
    },
    {
      // UA-2 P1A §18/§24: én side av en Drive-filliste (mappe-scope ELLER hele
      // driven - avgjøres av `folder_id`-parameteren fra kilden, aldri en
      // default her). Lagt til på SLUTTEN av samme grunn som read_repo_meta
      // over - eksisterende tester indekserer dette arrayet posisjonelt.
      tool_id: "drive", action: "list_files", description: "List filer i en Drive-mappe eller hele driven (untrusted ingestion)",
      input_schema: record({ folder_id: z.string().optional(), page_token: z.string().optional() }),
      capability_class: "A", scopes: ["drive.readonly"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "untrusted", transport: transport("drive")
    },
    // UA-2 P1A scope-endring (2026-08-16, se OWNER CONNECTOR CAPABILITY
    // INVARIANT i CLAUDE.md): Google Drive full read/write/permissions -
    // produksjons-scope er `https://www.googleapis.com/auth/drive` (bekreftet
    // mot Google sitt offisielle Drive API v3-discovery-dokument, IKKE gjettet
    // - `drive.file` dekker kun app-opprettede filer, utilstrekkelig for full
    // tilgang). Lagt til på SLUTTEN av arrayet av samme grunn som de
    // eksisterende drive-oppføringene over - eksisterende tester indekserer
    // posisjonelt.
    {
      tool_id: "drive", action: "get_metadata", description: "Les filmetadata (id/navn/foreldre/trashed/revisjon) - brukes også som preflight/konfliktsjekk før mutasjoner",
      input_schema: record({ file_id: z.string() }), capability_class: "A",
      scopes: ["drive.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60,
      credential_ref: "JARVIS_GOOGLE_TOKEN", output_trust: "untrusted", transport: transport("drive")
    },
    {
      tool_id: "drive", action: "read_permissions", description: "Les delinger/tilgangsstyring på en fil",
      input_schema: record({ file_id: z.string() }), capability_class: "A",
      scopes: ["drive.permissions.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30,
      credential_ref: "JARVIS_GOOGLE_TOKEN", output_trust: "untrusted", transport: transport("drive")
    },
    {
      tool_id: "drive", action: "create_file", description: "Opprett en ny tekstfil i Drive (valgfri mappe)",
      input_schema: record({ name: z.string(), content: z.string().optional(), mime_type: z.string().optional(), parent_folder_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "legg det opprettede dokumentet (external_id) i papirkurven", idempotent_external: false,
      timeout_ms: 15_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive")
    },
    {
      tool_id: "drive", action: "create_folder", description: "Opprett en ny mappe i Drive (valgfri foreldremappe)",
      input_schema: record({ name: z.string(), parent_folder_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "legg den opprettede mappen (external_id) i papirkurven", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive")
    },
    {
      tool_id: "drive", action: "update_content", description: "Erstatt innholdet i en eksisterende Drive-fil (valgfri expected_head_revision_id-precondition)",
      input_schema: record({ file_id: z.string(), content: z.string(), mime_type: z.string().optional(), expected_head_revision_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "gjenopprett forrige innhold via Drive sin revisjonshistorikk", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "get_metadata"
    },
    {
      tool_id: "drive", action: "rename", description: "Gi en Drive-fil/mappe et nytt navn (valgfri expected_head_revision_id-precondition)",
      input_schema: record({ file_id: z.string(), new_name: z.string(), expected_head_revision_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "gi tilbake det opprinnelige navnet", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "get_metadata"
    },
    {
      tool_id: "drive", action: "move", description: "Flytt en Drive-fil/mappe til en ny foreldremappe (valgfri expected_head_revision_id-precondition)",
      input_schema: record({ file_id: z.string(), new_parent_folder_id: z.string(), expected_head_revision_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "flytt tilbake til den opprinnelige foreldremappen", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "get_metadata"
    },
    {
      tool_id: "drive", action: "trash", description: "Legg en Drive-fil/mappe i papirkurven (reversibelt - IKKE permanent sletting; valgfri expected_head_revision_id-precondition)",
      input_schema: record({ file_id: z.string(), expected_head_revision_id: z.string().optional() }),
      capability_class: "C", scopes: ["drive.write"], reversible: true,
      rollback_procedure: "gjenopprett fra papirkurven (trashed=false)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "get_metadata"
    },
    {
      // Drive sin `files.delete` er PERMANENT (bekreftet mot API-dokumentasjonen -
      // flytter IKKE til papirkurv). Klasse D: irreversibel, samme mønster som
      // email.send.
      tool_id: "drive", action: "delete_permanent", description: "Slett en Drive-fil/mappe PERMANENT (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string() }), capability_class: "D",
      scopes: ["drive.delete"], reversible: false,
      rollback_procedure: "ikke reverserbar - derfor klasse D", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "get_metadata"
    },
    {
      // Deling/tilgangsstyring er sikkerhetskritisk (kan eksponere innhold for
      // nye parter) - klasse D uavhengig av at selve handlingen teknisk er
      // reverserbar (fjerne tilgangen igjen).
      tool_id: "drive", action: "create_permission", description: "Del en Drive-fil/mappe med en bruker/domene/alle (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string(), role: z.string(), type: z.string(), email_address: z.string().optional(), domain: z.string().optional() }),
      capability_class: "D", scopes: ["drive.permissions.write"], reversible: true,
      rollback_procedure: "fjern den opprettede tilgangen (delete_permission)", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "read_permissions"
    },
    {
      tool_id: "drive", action: "update_permission", description: "Endre rollen på en eksisterende Drive-deling (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string(), permission_id: z.string(), role: z.string() }),
      capability_class: "D", scopes: ["drive.permissions.write"], reversible: true,
      rollback_procedure: "sett rollen tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "read_permissions"
    },
    {
      tool_id: "drive", action: "delete_permission", description: "Fjern en eksisterende Drive-deling (krever signert godkjenning for delegerte identiteter)",
      input_schema: record({ file_id: z.string(), permission_id: z.string() }),
      capability_class: "D", scopes: ["drive.permissions.write"], reversible: true,
      rollback_procedure: "gjenopprett tilgangen manuelt (ikke automatisk reverserbar)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 15, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "internal", transport: transport("drive"), preflight_action: "read_permissions"
    },
    // UA-2 P1B-A §2: e-post-vedlegg-ingestion - full meldingslisting (body-tekst
    // + vedleggs-MIME-metadata) og separat vedleggsnedlasting. Lagt til på
    // SLUTTEN av arrayet av samme grunn som alle tidligere tillegg over -
    // eksisterende tester indekserer dette arrayet posisjonelt.
    {
      tool_id: "email", action: "list_messages", description: "List e-post FULLT (body-tekst + vedleggs-MIME-metadata) for ingestion",
      input_schema: record({ max: z.number().int().min(1).max(50), query: z.string().optional() }),
      capability_class: "A", scopes: ["mail.readonly"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_EMAIL_TOKEN",
      output_trust: "untrusted", transport: transport("email")
    },
    {
      tool_id: "email", action: "read_attachment", description: "Last ned RÅ bytes for ETT e-postvedlegg (standard base64, untrusted ingestion)",
      input_schema: record({ message_id: z.string(), attachment_id: z.string() }),
      capability_class: "A", scopes: ["mail.readonly"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_EMAIL_TOKEN",
      output_trust: "untrusted", transport: transport("email")
    },
    // UA-3 business-event-linkage (D-57): struktur-fokusert kalenderlisting med
    // faktiske deltaker-e-poster + html_link - brukes til deterministisk
    // kontakt-/selskaps-gjenkjenning (§9 i byggeordren), IKKE av personlig
    // daily brief (som fortsatt bruker read_events uendret). Lagt til på
    // SLUTTEN av arrayet - eksisterende tester indekserer posisjonelt.
    {
      tool_id: "calendar", action: "list_events", description: "List kalenderhendelser MED deltaker-e-poster + kilde-lenke (untrusted ingestion, for forretnings-entitetsgjenkjenning)",
      input_schema: record({ from: z.string(), to: z.string(), max: z.number().int().min(1).max(50).optional() }),
      capability_class: "A", scopes: ["calendar.readonly"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_GOOGLE_TOKEN",
      output_trust: "untrusted", transport: transport("calendar")
    },
    // UA-3 P0 (Business Domain Foundation, D-49): rent internt Business Graph-
    // verktøy - INGEN ekstern leverandør, `credential_ref` er en ikke-hemmelig
    // sentinel (se @jarvis/business sin BusinessInternalSecretProvider) kun
    // for å tilfredsstille ToolGateway sin ubetingede credential-sjekk.
    // `tenant_id`/`memory_space` MÅ bygges av TRUSTED kallerlag (identity),
    // ALDRI av modell-output - samme presedens som calendar/email/github sin
    // trusted parameterbygging i mesh-bridge.ts (ToolTransport.invoke() får
    // ikke IdentityContext - kjent, delt arkitekturbegrensning, ikke ny her).
    // Lagt til på SLUTTEN av arrayet - eksisterende tester indekserer posisjonelt.
    {
      tool_id: "business", action: "create_company", description: "Opprett et forretningsselskap (kunde/prospect)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), name: z.string(), domain: z.string().optional(), status: z.string().optional(), source: z.string().optional(), owner_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett status til 'inactive'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "create_contact", description: "Opprett en forretningskontakt (person hos et selskap)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), name: z.string(), company_id: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), title: z.string().optional(), source: z.string().optional(), owner_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "ingen automatisk angring - korriger via ny create_contact/oppdatering", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "create_lead", description: "Opprett/idempotent-oppdater en lead (idempotent naar source_type+source_instance_id+external_id oppgis)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), title: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), status: z.string().optional(), source: z.string().optional(), source_type: z.string().optional(), source_instance_id: z.string().optional(), external_id: z.string().optional(), owner_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett status til 'disqualified'", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "update_lead_status", description: "Endre status-stadiet til en lead",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), lead_id: z.string(), status: z.string() }),
      capability_class: "C", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett status tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "create_opportunity", description: "Opprett en salgsmulighet/deal",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), title: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), lead_id: z.string().optional(), stage: z.string().optional(), value_ore: z.number().optional(), currency: z.string().optional(), expected_close_date: z.string().optional(), owner_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett stage til 'lost'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "update_opportunity_stage", description: "Flytt en salgsmulighet til et nytt pipeline-stadium (og valgfritt oppdater endelig verdi)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), opportunity_id: z.string(), stage: z.string(), value_ore: z.number().optional() }),
      capability_class: "C", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett stage (og value_ore) tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "record_activity", description: "Registrer en forretningsaktivitet i tidslinjen (idempotent naar source_type+source_instance_id+external_id oppgis)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), activity_type: z.string(), summary: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), opportunity_id: z.string().optional(), lead_id: z.string().optional(), source_type: z.string().optional(), source_instance_id: z.string().optional(), external_id: z.string().optional(), canonical_uri: z.string().optional(), owner_person_id: z.string().optional(), occurred_at: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "ingen automatisk angring - append-only tidslinje", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "read_company_timeline", description: "Les komplett aktivitetstidslinje for ett selskap ('hva skjer med kunde X?')",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), company_id: z.string() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "create_followup", description: "Opprett en oppfoelging/TODO knyttet til kunde/selskap/deal (idempotent naar idempotency_key oppgis)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), title: z.string(), due_at: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), opportunity_id: z.string().optional(), lead_id: z.string().optional(), activity_id: z.string().optional(), reason: z.string().optional(), next_action: z.string().optional(), priority: z.string().optional(), owner_person_id: z.string().optional(), idempotency_key: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "avbryt oppfoelgingen (cancel_followup)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "complete_followup", description: "Marker en oppfoelging som fullført",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), followup_id: z.string() }),
      capability_class: "C", scopes: ["business.write"], reversible: false,
      rollback_procedure: "ikke reverserbar tilstandsovergang - opprett ny oppfoelging ved behov", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "cancel_followup", description: "Avbryt en åpen oppfoelging",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), followup_id: z.string() }),
      capability_class: "C", scopes: ["business.write"], reversible: false,
      rollback_procedure: "ikke reverserbar tilstandsovergang - opprett ny oppfoelging ved behov", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "list_overdue_followups", description: "List forfalte, åpne oppfoelginger (hvem trenger oppfoelging nå)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), as_of: z.string().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "read_metrics", description: "Les grunnleggende drifts-metrikker (åpne leads, aktive muligheter, pipeline-verdi, forfalte oppfoelginger)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    // UA-3 neste slice (D-53): automatisk open-loop-deteksjon + daglig/ukentlig
    // business-brief. Samme "business"-transport/credential-sentinel som P0 -
    // lagt til på SLUTTEN av arrayet, samme grunn som øvrige senere tilføyelser.
    {
      tool_id: "business", action: "list_open_loops", description: "List open loops (uloeste forretningsforhold) for tenanten",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "read_open_loop", description: "Les ett open loop med full begrunnelse/kilde-referanse",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), open_loop_id: z.string() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "get_attention_queue", description: "Les prioritert oppmerksomhets-kø (critical/overdue/due_soon/informational) over aapne open loops",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "get_business_brief", description: "Generer daglig eller ukentlig business-brief (period: 'daily'|'weekly')",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), period: z.string().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "resolve_open_loop", description: "Marker et open loop som loest (manuell resolusjon)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), open_loop_id: z.string(), resolution_reason: z.string() }),
      capability_class: "C", scopes: ["business.write"], reversible: false,
      rollback_procedure: "ikke reverserbar tilstandsovergang - deteksjon gjenaapner automatisk hvis vilkaaret fortsatt er sant", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "defer_open_loop", description: "Utsett (snooze) et open loop til en ny forfallsdato",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), open_loop_id: z.string(), due_at: z.string() }),
      capability_class: "C", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett due_at tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "assign_open_loop", description: "Tildel et open loop til en eier/ansvarlig person",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), open_loop_id: z.string(), owner_person_id: z.string() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "tildel tilbake til forrige eier", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "set_open_loop_next_action", description: "Oppdater anbefalt neste handling for et open loop",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), open_loop_id: z.string(), next_action: z.string() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "sett next_action tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    // UA-3 business-event-linkage (D-57): synkroniser Gmail/Calendar via de
    // EKSISTERENDE UA-0/UA-7-P0-connectorene inn i Business OS-tidslinjen -
    // deterministisk kontakt-/selskaps-gjenkjenning, ALDRI kildeinnhold kopiert
    // (§15). Skriver KUN via `BusinessService.recordActivity()` sin allerede
    // idempotente `ON CONFLICT (tenant_id, source_type, source_instance_id,
    // external_id)` - ingen ny idempotens-mekanisme. Klasse B (interne
    // forretnings-tilstandsskrivinger avledet fra allerede-autoriserte
    // lese-handlinger - samme klasse som `record_activity` selv). Lagt til på
    // SLUTTEN av arrayet - eksisterende tester indekserer posisjonelt.
    {
      tool_id: "business", action: "sync_business_events", description: "Synkroniser nylige Gmail/Calendar-hendelser inn i forretningstidslinjen (deterministisk kontakt-/selskaps-gjenkjenning, aldri gjettet)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "ingen automatisk angring - append-only tidslinje, re-sync er trygt (idempotent)", idempotent_external: true,
      timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    // UA-3 profiling/scoring-slice (D-61): transparent, deterministisk
    // BUSINESS-OPERASJONELL prioritering/risiko-scoring over lead/opportunity
    // (akseptansekriterium 4) - ALDRI generalisert personprofilering (§4/§11 i
    // byggeordren). Scoren er ALLTID forklarbar (faktorer+kilde-referanser er
    // en del av selve svaret på hver lesing) og utleder ALDRI en autonom
    // hoy-konsekvens personbeslutning - kun intern prioriteringstilstand.
    // Klasse A for alle lesinger (samme som read_metrics/list_open_loops).
    // Lagt til på SLUTTEN av arrayet - eksisterende tester indekserer posisjonelt.
    {
      tool_id: "business", action: "get_lead_score", description: "Les gjeldende prioritets-score for en lead, med full faktor-/kilde-forklaring",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), lead_id: z.string() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "get_opportunity_score", description: "Les gjeldende risiko-score for en opportunity, med full faktor-/kilde-forklaring",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), opportunity_id: z.string() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "explain_score", description: "Les gjeldende score for en vilkaarlig entitet (entity_type: 'lead'|'opportunity') med full begrunnelse",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), entity_type: z.string(), entity_id: z.string() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "rank_leads", description: "Ranger leads etter gjeldende prioritets-score (hoyest foerst)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "rank_opportunities", description: "Ranger opportunities etter gjeldende risiko-score (hoyest foerst)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), limit: z.number().optional() }),
      capability_class: "A", scopes: ["business.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "recalculate_score", description: "Tving rekalkulering av scoren for én lead/opportunity (idempotent - samme regelsett, ny beregning)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), entity_type: z.string(), entity_id: z.string() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "ingen automatisk angring - rekalkulering er idempotent og overskriver kun tidligere beregnet score, aldri manuell overstyring", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "set_manual_override", description: "Sett en eier-autorisert manuell overstyring av en scores prioriteringsverdi (endrer ALDRI de underliggende faktorene/kildedataene)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), entity_type: z.string(), entity_id: z.string(), override_score: z.number(), reason: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["business.write"], reversible: true,
      rollback_procedure: "clear_manual_override (tilbake til beregnet score)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    {
      tool_id: "business", action: "clear_manual_override", description: "Fjern en manuell overstyring - gaar tilbake til den sist beregnede scoren",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), entity_type: z.string(), entity_id: z.string() }),
      capability_class: "B", scopes: ["business.write"], reversible: false,
      rollback_procedure: "ikke reverserbar - sett en ny manuell overstyring ved behov (set_manual_override)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("business")
    },
    // UA-3 Native Jarvis Support Core (D-66) §19/§20: provider-nøytralt
    // support.*-namespace - JARVIS_CANONICAL, ZERO ekstern support-
    // leverandør-avhengighet (D-64). Lagt til på SLUTTEN av samme grunn som
    // read_repo_meta/list_files over - eksisterende tester indekserer dette
    // arrayet posisjonelt.
    {
      tool_id: "support", action: "create_ticket", description: "Opprett en support-ticket",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), subject: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), priority: z.string().optional(), assignee_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "sett status til 'closed'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "get_ticket", description: "Les én support-ticket",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string() }),
      capability_class: "A", scopes: ["support.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "list_tickets", description: "List support-tickets etter status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["support.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "search_tickets", description: "Deterministisk filter-/fritekstsøk i support-tickets (ticket-nummer/selskap/kontakt/status/prioritet/ansvarlig/emne)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional(), priority: z.string().optional(),
        assignee_person_id: z.string().optional(), company_id: z.string().optional(), contact_id: z.string().optional(),
        subject_contains: z.string().optional(), ticket_number: z.number().optional(), limit: z.number().optional()
      }),
      capability_class: "A", scopes: ["support.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "update_ticket", description: "Oppdater status og/eller prioritet på en ticket i ett kall",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), status: z.string().optional(), priority: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "sett status/prioritet tilbake via nytt update_ticket-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "set_status", description: "Deterministisk statusovergang (state-machine.ts - ugyldig overgang feiler trygt)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), status: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "sett status tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "set_priority", description: "Sett prioritet (low/normal/high/urgent) - ALDRI avledet fra beskyttede/sensitive kjennetegn",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), priority: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "sett prioritet tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "assign_ticket", description: "Tildel/fjern tildeling av en ticket (gjenbruker eksisterende person-/identitetsarkitektur)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), assignee_person_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "tildel tilbake til forrige ansvarlig", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "add_internal_note", description: "Legg til et internt notat (ALDRI kunde-synlig, sender ALDRI e-post)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), note: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["support.write"], reversible: false,
      rollback_procedure: "ikke reverserbar - notater er append-only historikk", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      tool_id: "support", action: "list_events", description: "List hele hendelseshistorikken for én ticket (kunde-tidslinje, ikke audit_events)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string() }),
      capability_class: "A", scopes: ["support.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      // §16/§20 i byggeordren: kunde-synlig utgående kommunikasjon - klasse C.
      // Delegerer INTERNT til den EKSISTERENDE `email.send` (klasse D, krever
      // signert godkjenning) via ToolGateway/Policy Gateway igjen - denne
      // klassifiseringen svekker ALDRI den underliggende D-håndhevingen for
      // selve e-postutsendelsen.
      tool_id: "support", action: "reply", description: "Svar en kunde på en ticket (ruter GJENNOM eksisterende email.send, klasse D der)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), ticket_id: z.string(), to: z.string(), subject: z.string(), body: z.string(), idempotency_key: z.string() }),
      capability_class: "C", scopes: ["support.write", "mail.send"], reversible: false,
      rollback_procedure: "send en oppfølgende korreksjon - selve e-posten kan ikke kalles tilbake", idempotent_external: true,
      timeout_ms: 15_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_EMAIL_TOKEN",
      output_trust: "internal", transport: transport("support")
    },
    {
      // Untrusted ingestion-vei (Gmail-normalisert melding) - se
      // `email-ingress.ts`. `ingest_message` selv skriver kun strukturerte
      // pekere (§11 pointer-not-payload), aldri rått eksternt innhold.
      tool_id: "support", action: "ingest_message", description: "Ingest en normalisert kanal-melding (kalles av email-ingress.ts, aldri direkte fra rå ekstern payload)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), channel: z.string().optional(),
        source_type: z.string(), source_instance_id: z.string(), source_thread_id: z.string(), source_message_id: z.string(),
        canonical_uri: z.string().optional(), subject: z.string(), summary: z.string(), is_from_customer: z.boolean(),
        entity_resolution: z.string().optional(), company_id: z.string().optional(), contact_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["support.write"], reversible: true,
      rollback_procedure: "sett ticket-status til 'closed'", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "untrusted", transport: transport("support")
    },
    // UA-3 Native Jarvis Contracts Core (D-71): provider-nøytralt
    // `contract.*`-namespace - JARVIS_CANONICAL, ZERO ekstern e-sign-
    // leverandør-avhengighet (D-71/D-64). Lagt til på SLUTTEN av samme
    // grunn som support.* over - eksisterende tester indekserer dette
    // arrayet posisjonelt. Ingen handling her er klasse D (ingen nøstet
    // e-sign-/utsendelseshandling i denne sliceen - juridisk
    // signeringsutførelse er en FREMTIDIG, valgfri adapter).
    {
      tool_id: "contract", action: "create_contract", description: "Opprett en kontrakt (motpart via eksisterende Business OS company/contact)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), title: z.string(), contract_type: z.string().optional(),
        company_id: z.string().optional(), contact_id: z.string().optional(), effective_date: z.string().optional(),
        start_date: z.string().optional(), end_date: z.string().optional(), termination_deadline: z.string().optional(),
        renewal_date: z.string().optional(), auto_renew: z.boolean().optional(), owner_person_id: z.string().optional(),
        canonical_uri: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "sett status til 'cancelled'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "get_contract", description: "Les én kontrakt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "list_contracts", description: "List kontrakter etter status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "search_contracts", description: "Deterministisk filter-/fritekstsøk i kontrakter (kontraktnummer/selskap/kontakt/status/eier/tittel)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional(),
        company_id: z.string().optional(), contact_id: z.string().optional(), owner_person_id: z.string().optional(),
        title_contains: z.string().optional(), contract_number: z.number().optional(), limit: z.number().optional()
      }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "list_by_company", description: "Hva har selskap X aktivt med oss? - deterministisk motparts-oppslag",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), company_id: z.string(), status: z.string().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "upcoming_renewals", description: "Hvilke kontrakter fornyes snart?",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), within_days: z.number().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "upcoming_termination_deadlines", description: "Hvilke avtaler utløper/har nærstående oppsigelsesfrist?",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), within_days: z.number().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "cancellable_now", description: "Hvilke kontrakter kan vi si opp nå? (fortsatt innenfor oppsigelsesvinduet)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "due_obligations", description: "Hva forfaller snart på tvers av kontrakter? (\"What is due next?\")",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), within_days: z.number().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "overdue_obligations", description: "Hvilke forpliktelser er forfalt?",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      // Deterministisk lifecycle-overgang (state-machine.ts) - klasse C: en
      // kontrakts juridiske/forretningsmessige status har et reelt effekt-
      // nivå utover en vanlig feltoppdatering (§"risk classes A-D based on
      // effect" i byggeordren), selv uten noen nøstet ekstern handling.
      tool_id: "contract", action: "set_status", description: "Deterministisk lifecycle-overgang (draft/review/approved/active/expiring/expired/terminated/cancelled)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), status: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "C", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "eksplisitt nytt set_status-kall tilbake til forrige status (unntatt korreksjonsveien fra terminated/cancelled, som kun går til draft)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "set_owner", description: "Sett/fjern kontrakteier (gjenbruker eksisterende person-/identitetsarkitektur)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), owner_person_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "sett eier tilbake til forrige verdi", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "link_counterparty", description: "Oppdater motpart (selskap/kontakt) - gjenbruker eksisterende Business OS-entiteter",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), company_id: z.string().optional(), contact_id: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "sett motpart tilbake via nytt link_counterparty-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "set_renewal_date", description: "Sett/fjern fornyelsesdato",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), renewal_date: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "sett dato tilbake via nytt kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "set_termination_deadline", description: "Sett/fjern oppsigelses-/kanselleringsfrist",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), termination_deadline: z.string().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "sett frist tilbake via nytt kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      // Kontraktversjoner er EKSPLISITTE og IMMUTABLE (byggeordren) - kun
      // append-only, aldri en oppdatering av en eksisterende versjon.
      tool_id: "contract", action: "add_version", description: "Legg til en ny, immutable kontraktversjon (pointer-not-payload - peker til dokumentet, kopierer aldri innholdet)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), summary: z.string(),
        source_type: z.string().optional(), source_instance_id: z.string().optional(), source_message_id: z.string().optional(),
        canonical_uri: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["contract.write"], reversible: false,
      rollback_procedure: "ikke reverserbar - versjoner er append-only historikk", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "list_versions", description: "List alle versjoner av en kontrakt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "get_current_version", description: "Les gjeldende (nyeste) versjon av en kontrakt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "add_obligation", description: "Legg til en forpliktelse (\"What must we do under this contract?\")",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), description: z.string(),
        owner_person_id: z.string().optional(), due_at: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "waive_obligation (marker som frafalt)", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "list_obligations", description: "List forpliktelser for en kontrakt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string(), status: z.string().optional() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "complete_obligation", description: "Marker en forpliktelse som fullført",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), obligation_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "reopen_obligation", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "waive_obligation", description: "Marker en forpliktelse som frafalt",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), obligation_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "reopen_obligation", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "reopen_obligation", description: "Gjenåpne en fullført/frafalt forpliktelse (administrativ korreksjon)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), obligation_id: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["contract.write"], reversible: true,
      rollback_procedure: "complete_obligation/waive_obligation", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    {
      tool_id: "contract", action: "list_events", description: "List hele hendelseshistorikken for én kontrakt (kontrakt-tidslinje, ikke audit_events)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contract_id: z.string() }),
      capability_class: "A", scopes: ["contract.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("contract")
    },
    // UA-4 Native Jarvis Growth Core (D-74): provider-nøytralt `growth.*`-
    // namespace - JARVIS_CANONICAL/HYBRID_WITH_CLEAR_AUTHORITY, ZERO
    // annonseplattform-avhengighet (D-74/D-64). Lagt til på SLUTTEN av
    // samme grunn som contract.* over - eksisterende tester indekserer
    // dette arrayet posisjonelt. Ingen handling her er klasse D (ingen
    // nøstet live budsjett-/bud-/kampanjeutførelse mot en ekstern
    // annonseplattform i denne sliceen - det er en FREMTIDIG, valgfri
    // adapter, se D-74 REPLACEMENT_PATH).
    {
      tool_id: "growth", action: "create_campaign", description: "Opprett en markedsføringskampanje (kanal-nøytral, ingen ekstern leverandør krevd)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), channel: z.string(), name: z.string(),
        budget_amount_ore: z.number().optional(), currency: z.string().optional(), external_campaign_id: z.string().optional(),
        canonical_uri: z.string().optional(), owner_person_id: z.string().optional(), started_at: z.string().optional(),
        actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "sett status til 'ended'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "get_campaign", description: "Les én kampanje",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_campaigns", description: "List kampanjer etter status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "search_campaigns", description: "Deterministisk filter-/fritekstsøk i kampanjer (kanal/status/eier/navn)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional(), channel: z.string().optional(),
        owner_person_id: z.string().optional(), name_contains: z.string().optional(), limit: z.number().optional()
      }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_by_company", description: "Hvilke kampanjer har generert leads/opportunities for selskap X? - via attribusjon, ikke en direkte kampanje-selskap-kobling",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), company_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      // Deterministisk lifecycle-overgang (state-machine.ts) - klasse C: en
      // kampanjes operasjonelle status (aktiv/pause/avsluttet) har reell
      // budsjett-/forretningseffekt utover en vanlig feltoppdatering (§"risk
      // classes A-D based on effect" i byggeordren), selv uten noen nøstet
      // ekstern handling i denne sliceen.
      tool_id: "growth", action: "set_campaign_status", description: "Deterministisk lifecycle-overgang (draft/active/paused/ended)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string(), status: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "C", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "eksplisitt nytt set_campaign_status-kall tilbake til forrige status (unntatt korreksjonsveien fra 'ended', som kun går til 'draft')",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "set_budget", description: "Sett/fjern kampanjebudsjett",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string(), budget_amount_ore: z.number().optional(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "sett budsjett tilbake via nytt kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      // Idempotent per (kampanje, dato, kildetype) - re-synk av samme dag
      // oppdaterer SAMME rad (§"idempotent, auditable, before/after state"
      // i byggeordren), oppretter aldri en duplikatrad.
      tool_id: "growth", action: "record_spend_event", description: "Registrer/oppdater utgift for én kampanje-dag (manuelt/CSV-import/fremtidig live-synk)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string(), event_date: z.string(),
        spend_amount_ore: z.number(), currency: z.string().optional(), clicks: z.number().optional(), impressions: z.number().optional(),
        source_type: z.string().optional(), source_pointer: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "nytt record_spend_event-kall med korrigert beløp for SAMME (kampanje, dato, kildetype)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_spend_events", description: "List utgiftshistorikk for en kampanje",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "campaign_performance", description: "Deterministisk kampanje-funnel (leads/møter/opportunities/won/CAC/ROAS) knyttet til ekte CRM-data (business_activities.activity_type='meeting'/business_opportunities.value_ore/stage='won')",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      // Deterministisk, EKSPLISITT kobling av kaller - ALDRI AI-utledet
      // (Q-26-grensen: ingen inferert kausal påstand i denne sliceen).
      tool_id: "growth", action: "attribute_to_campaign", description: "Koble en eksisterende lead/opportunity til en kampanje (deterministisk, eksplisitt - ingen AI-gjettet tilskrivning)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string(), entity_type: z.string(), entity_id: z.string(),
        attribution_model: z.string().optional(), source_pointer: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "ingen direkte fjerning i denne sliceen - historisk attribusjonsrad", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_attributions", description: "List alle lead/opportunity-attribusjoner for en kampanje",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "create_experiment", description: "Opprett et eksperiment i eksperimentregisteret (valgfritt knyttet til en kampanje)",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), name: z.string(), hypothesis: z.string().optional(),
        campaign_id: z.string().optional(), owner_person_id: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "set_experiment_status til 'abandoned'", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "get_experiment", description: "Les ett eksperiment",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), experiment_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_experiments", description: "List eksperimenter etter status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      // Klasse C: å konkludere/forlate et eksperiment låser et resultat som
      // fremtidige beslutninger bygger på - reelt effektnivå utover en
      // vanlig feltoppdatering.
      tool_id: "growth", action: "set_experiment_status", description: "Deterministisk lifecycle-overgang (draft/running/concluded/abandoned) + valgfri resultatoppsummering",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), experiment_id: z.string(), status: z.string(),
        result_summary: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "C", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "eksplisitt nytt set_experiment_status-kall tilbake til forrige status (unntatt korreksjonsveien fra 'concluded'/'abandoned', som kun går til 'draft')",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_events", description: "List hele hendelseshistorikken for én kampanje (vekst-tidslinje, ikke audit_events)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    // D-82: deterministisk UTM-/klikk-ID-basert auto-attribusjon (lukker
    // Q-29 punkt 6). Lagt til på SLUTTEN av samme grunn som resten av
    // growth.*-namespacet - eksisterende tester indekserer arrayet
    // posisjonelt. ZERO ekstern leverandør - ren Jarvis-intern
    // oppslagslogikk mot EGNE registrerte tagger (027/028_growth*.sql).
    {
      tool_id: "growth", action: "register_campaign_tracking_tag",
      description: "Registrer en sporingstagg (klikk-ID ELLER full utm_source/utm_medium/utm_campaign-triplett) på en kampanje - idempotent, EKSAKT matching",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string(),
        click_id_param: z.string().optional(), click_id_value: z.string().optional(),
        utm_source: z.string().optional(), utm_medium: z.string().optional(), utm_campaign: z.string().optional(),
        actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "registrer en ny tagg med korrigerte verdier for SAMME kampanje (ingen direkte fjerning i denne sliceen - historisk sporingskonfigurasjon)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_campaign_tracking_tags", description: "List alle registrerte sporingstagger for en kampanje",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "resolve_campaign_from_tracking",
      description: "Deterministisk oppslag: hvilken kampanje (om noen) matcher disse sporingsparametrene EKSAKT? Returnerer null (aldri en gjettet kampanje) ved ingen match",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(),
        click_id_param: z.string().optional(), click_id_value: z.string().optional(),
        utm_source: z.string().optional(), utm_medium: z.string().optional(), utm_campaign: z.string().optional()
      }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      // Klasse B, SAMME risikonivå som attribute_to_campaign (§9 i
      // byggeordren: denne handlingen ER attribute_to_campaign, bare nådd
      // via en deterministisk sporingsoppslag i stedet for en direkte
      // campaign_id - ingen AI-gjettet tilskrivning innføres.
      tool_id: "growth", action: "attribute_from_tracking",
      description: "Koble en eksisterende lead/opportunity til en kampanje via deterministisk sporingsoppslag (klikk-ID/utm) - kaster ved ingen EKSAKT match, gjetter aldri",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), entity_type: z.string(), entity_id: z.string(),
        click_id_param: z.string().optional(), click_id_value: z.string().optional(),
        utm_source: z.string().optional(), utm_medium: z.string().optional(), utm_campaign: z.string().optional(),
        attribution_model: z.string().optional(), actor_person_id: z.string().optional()
      }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "ingen direkte fjerning i denne sliceen - historisk attribusjonsrad (samme som attribute_to_campaign)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    // D-85: anomaly -> recommended-action control-plane-fundament.
    // BESLUTNINGS-lag ALENE - `resolve_action_recommendation` er klasse B
    // (REN Jarvis-intern disposisjon-sporing), ALDRI klasse C/D, siden
    // handlingen ALDRI utfører noe mot en ekte annonseplattform (ingen
    // provider-mutate-kapabilitet finnes for noen leverandør i denne
    // kodebasen ennå - Finance Integrity-grensen, D-83/UA-6).
    {
      tool_id: "growth", action: "list_action_recommendations", description: "List deterministiske kampanje-handlingsanbefalinger (generert av anomali-deteksjon), valgfritt filtrert på kampanje/status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "resolve_action_recommendation",
      description: "Marker en anbefaling som godkjent/avvist av eieren - REN Jarvis-intern disposisjon-sporing, utfører ALDRI noe mot en ekte annonseplattform",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), recommendation_id: z.string(), status: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "kall på nytt med motsatt status (ingen provider-side-effekt å rulle tilbake)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    // D-87: provider-nøytral UTFØRELSES-KOMMANDO-modell - det strukturelle
    // bindeleddet mellom D-85 sitt BESLUTNINGS-lag og en FREMTIDIG
    // utførelses-kapabilitet. `generate_execution_command`/
    // `cancel_execution_command` er klasse B (REN Jarvis-intern beregning/
    // kansellering) - ALDRI klasse C/D, siden INGEN kode noensinne kan
    // markere et command 'executed' (databasens CHECK-constraint inneholder
    // ikke den verdien i det hele tatt, se 030_growth_execution_commands.sql).
    {
      tool_id: "growth", action: "generate_execution_command",
      description: "Oversett en ALLEREDE eier-godkjent anbefaling til en presis, provider-nøytral budsjett-kommando - beregner KUN, utfører ALDRI noe mot en ekte annonseplattform",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), recommendation_id: z.string(), actor_person_id: z.string().optional(), reduction_fraction: z.number().optional() }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "kanseller kommandoen (cancel_execution_command) - ingen provider-side-effekt å rulle tilbake", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "cancel_execution_command",
      description: "Kanseller en ventende utførelses-kommando FØR den (aldri) noensinne kunne vært utført",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), command_id: z.string(), actor_person_id: z.string().optional(), reason: z.string().optional() }),
      capability_class: "B", scopes: ["growth.write"], reversible: false,
      rollback_procedure: "ingen (kansellering er en endelig disposisjon, samme prinsipp som avvist anbefaling)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_execution_commands", description: "List provider-nøytrale utførelses-kommandoer, valgfritt filtrert på kampanje/status - ALDRI utført av noen kode i denne sliceen",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    // D-89 MARKETING MEMORY v1: et NARROW, deterministisk OBSERVASJON-lag
    // (`meetings_without_conversion`/`recommendation_disposition_summary`)
    // over ALLEREDE eksisterende kanonisk data - ALDRI en "sannhet"
    // (`status` har INGEN 'verified'-verdi), ALDRI et automatisk
    // handlingstriggerpunkt (kun lesing/deterministisk avledning, ZERO
    // kobling til D-85-anbefalinger/D-87-kommandoer utover å LESE deres
    // status som evidens). `generate_marketing_observations` er klasse B
    // (REN Jarvis-intern beregning/persistens av en observasjon, ALDRI en
    // provider-handling) - ALDRI klasse C/D.
    {
      tool_id: "growth", action: "generate_marketing_observations",
      description: "Avled deterministiske markedsførings-observasjoner for en kampanje (møter-uten-konvertering-gap, anbefaling/kommando-disposisjonsoppsummering) - ALDRI en kausal påstand, ALDRI AI-inferens",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string() }),
      capability_class: "B", scopes: ["growth.write"], reversible: true,
      rollback_procedure: "ingen provider-side-effekt å rulle tilbake (ren intern observasjons-persistens)", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 30, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    {
      tool_id: "growth", action: "list_marketing_observations", description: "List markedsførings-observasjoner, valgfritt filtrert på kampanje/type/status",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), campaign_id: z.string().optional(), observation_type: z.string().optional(), status: z.string().optional() }),
      capability_class: "A", scopes: ["growth.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("growth")
    },
    // UA-4 Google Ads-slice (D-83): FØRSTE ekte leverandøradapter for
    // Growth Core - Google Ads er en ADAPTER (D-64), ALDRI domeneeier.
    // `list_campaigns` er en ren speilings-lesing (INGEN Jarvis-DB-skriving)
    // - klasse A. `sync_*` skriver INN i den EKSISTERENDE, kanoniske
    // Growth-modellen (via `GrowthService.upsertCampaignFromProvider()`/
    // `recordSpendEvent()`/`registerCampaignTrackingTag()`, ALDRI en ny
    // modell) - klasse B, SAMME nivå som `growth.record_spend_event`/
    // `growth.register_campaign_tracking_tag`. INGEN klasse D her - denne
    // sliceen implementerer BEVISST INGEN mutate-/budsjett-/bud-/
    // kampanje-skriving MOT Google (Finance Integrity-grensen, D-83 -
    // se DECISIONS_AND_ASSUMPTIONS.md for D-41-STOPP-begrunnelsen).
    {
      tool_id: "googleads", action: "list_campaigns", description: "Les kampanjeliste direkte fra Google Ads (GAQL, ingen Jarvis-DB-skriving - ren leverandør-speiling)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), customer_id: z.string().optional() }),
      capability_class: "A", scopes: ["googleads.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 20_000, rate_limit_per_minute: 20, credential_ref: "JARVIS_GOOGLE_ADS_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("googleads")
    },
    {
      tool_id: "googleads", action: "sync_campaigns", description: "Synk kampanjeliste fra Google Ads inn i Growth Core (idempotent upsert via external_campaign_id, ingen ny domenemodell)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), customer_id: z.string().optional() }),
      capability_class: "B", scopes: ["googleads.read", "growth.write"], reversible: true,
      rollback_procedure: "ingen direkte fjerning - kampanjerader er historiske Growth Core-fakta, samme som growth.create_campaign", idempotent_external: true,
      timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GOOGLE_ADS_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("googleads")
    },
    {
      tool_id: "googleads", action: "sync_spend", description: "Synk daglig utgift/klikk/visning per kampanje fra Google Ads inn i marketing_spend_events (source_type=provider_sync, idempotent per kampanje+dato)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), customer_id: z.string().optional(), start_date: z.string(), end_date: z.string() }),
      capability_class: "B", scopes: ["googleads.read", "growth.write"], reversible: true,
      rollback_procedure: "nytt sync_spend-kall overskriver SAMME (kampanje, dato, provider_sync)-rad ved korrigert kilde-tall", idempotent_external: true,
      timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GOOGLE_ADS_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("googleads")
    },
    {
      // D-82-integrasjon: gclid fra Google Ads sin click_view-ressurs
      // registrert som EKSAKT samme click_id_param-verdi D-82 sitt skjema
      // allerede anser gyldig - ingen skjemaendring, ingen gjettet
      // attribusjon (kalleren MÅ ha kjørt sync_campaigns FØRST for at en
      // kampanje skal finnes å knytte gclid-en til).
      tool_id: "googleads", action: "sync_tracking_tags", description: "Synk gclid fra Google Ads sin click_view-ressurs inn i marketing_campaign_tracking_tags for ÉN dato (D-82 deterministisk auto-attribusjon)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), customer_id: z.string().optional(), date: z.string() }),
      capability_class: "B", scopes: ["googleads.read", "growth.write"], reversible: true,
      rollback_procedure: "ingen direkte fjerning i denne sliceen - historisk sporingstagg (samme som growth.register_campaign_tracking_tag)", idempotent_external: true,
      timeout_ms: 30_000, rate_limit_per_minute: 10, credential_ref: "JARVIS_GOOGLE_ADS_REFRESH_TOKEN",
      output_trust: "internal", transport: transport("googleads")
    },
    // D-91 (UA-4 NESTE SLICE): Consent / Cookie / Data-Processing Governance
    // Core - provider-nøytralt `consent.*`-namespace. `record_decision`
    // appender EN NY, permanent rad i en append-only-logg (ALDRI en UPDATE)
    // - klasse B (REN Jarvis-intern tilstandsskriving, ALDRI en provider-
    // handling/uigjenkallelig ekstern effekt). `get_current_state`/
    // `list_decisions`/`evaluate_processing_decision` er RENE lesinger -
    // klasse A. `evaluate_processing_decision` er den DETERMINISTISKE,
    // fail-closed håndhevings-kjernen (fravær av data -> ALDRI 'ALLOWED') -
    // ZERO ModelGateway noe sted i dette namespacet.
    {
      tool_id: "consent", action: "record_decision", description: "Registrer EN NY samtykke-/rettslig-grunnlag-beslutning for en kontakt+formål (append-only, ALDRI en overskriving av en tidligere beslutning). 'evidence' er KUN en proveniens-peker (kilde/skjema-versjon/kanal) - ALDRI hemmeligheter (tokens/nøkler/passord) eller full rå persondata-payload.",
      input_schema: record({
        tenant_id: z.string(), memory_space: z.string().optional(), contact_id: z.string(), purpose: z.string(),
        state: z.string(), legal_basis: z.string(), evidence: z.record(z.string(), z.unknown()).optional(),
        policy_version: z.string(), actor_person_id: z.string().optional(), expires_at: z.string().optional()
      }),
      capability_class: "B", scopes: ["consent.write"], reversible: true,
      rollback_procedure: "ingen sletting av rader - registrer en NY beslutning (f.eks. 'withdrawn') for å endre gjeldende tilstand", idempotent_external: false,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    },
    {
      tool_id: "consent", action: "get_current_state", description: "Hent den nyeste registrerte samtykke-/rettslig-grunnlag-beslutningen for en kontakt+formål (null hvis ingen finnes)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contact_id: z.string(), purpose: z.string() }),
      capability_class: "A", scopes: ["consent.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    },
    {
      tool_id: "consent", action: "list_decisions", description: "List alle registrerte samtykke-beslutninger, valgfritt filtrert på kontakt/formål (fullstendig, append-only historikk)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contact_id: z.string().optional(), purpose: z.string().optional() }),
      capability_class: "A", scopes: ["consent.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    },
    {
      tool_id: "consent", action: "evaluate_processing_decision", description: "Deterministisk, fail-closed evaluering: kan denne kontaktens data behandles for dette formålet? (ALLOWED/DENIED/UNKNOWN_NOT_CONFIGURED - ALDRI en bar boolean, ZERO AI-inferens)",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), contact_id: z.string(), purpose: z.string() }),
      capability_class: "A", scopes: ["consent.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    },
    // D-92 (UA-4 NESTE SLICE): Consent Enforcement Activation / Rollout v1 -
    // provider-nøytral aktiverings-flate for D-91-motoren. `get_enforcement_
    // policy` er RENT lesing - klasse A. `set_enforcement_policy` endrer KUN
    // Jarvis-intern rollout-konfigurasjon (disabled/audit/enforce) - ALDRI en
    // ekstern/leverandør-handling, ALDRI en samtykke-beslutning i seg selv -
    // klasse B, SAMME begrunnelse som `consent.record_decision`.
    {
      tool_id: "consent", action: "get_enforcement_policy", description: "Hent gjeldende håndhevings-modus (disabled/audit/enforce) for tenant+space+formål (disabled hvis ingen rad finnes - ALDRI stille 'enforce')",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), purpose: z.string() }),
      capability_class: "A", scopes: ["consent.read"], reversible: true, rollback_procedure: "ingen (lesing)",
      idempotent_external: true, timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    },
    {
      tool_id: "consent", action: "set_enforcement_policy", description: "Sett håndhevings-modus (disabled/audit/enforce) for tenant+space+formål - eksplisitt eier-aktivering, ALDRI en påstand om at et datasubjekt faktisk har samtykket",
      input_schema: record({ tenant_id: z.string(), memory_space: z.string().optional(), purpose: z.string(), mode: z.string(), actor_person_id: z.string().optional() }),
      capability_class: "B", scopes: ["consent.write"], reversible: true,
      rollback_procedure: "sett modus tilbake til forrige verdi (f.eks. 'disabled') via et nytt set_enforcement_policy-kall", idempotent_external: true,
      timeout_ms: 10_000, rate_limit_per_minute: 60, credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal", transport: transport("consent")
    }
  ];
}

/**
 * Ingestion-pipeline (SECURITY_MODEL §2/§9): ekstern kilde → Ingestion Zone →
 * karantene via fase 4-MemoryWriter (untrusted blir ALDRI autoritativt uten
 * policy-godkjent promotering). Proveniens/tenant/tid/tillit bevares.
 */
export class IngestionService {
  constructor(private readonly writer: MemoryWriter) {}

  async ingestExternal(
    identity: IdentityContext,
    source: { kind: "document" | "tool"; ref: string },
    content: string
  ) {
    return this.writer.ingestText(identity, { ...source, trust: "untrusted" }, content);
  }
}
