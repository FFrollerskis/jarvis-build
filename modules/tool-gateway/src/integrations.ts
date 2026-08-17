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
