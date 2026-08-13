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
    private readonly reply: (action: string) => { external_id?: string; data?: JsonValue } = () => ({ external_id: "ext-1" }),
    private readonly failWith?: string
  ) {}
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    if (this.failWith) {
      throw new Error(this.failWith);
    }
    this.calls.push({ action, parameters });
    return this.reply(action);
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
      input_schema: record({ document_id: z.string() }), capability_class: "A",
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
