import type { MemorySpace } from "@jarvis/contracts";
import type { KnowledgeSource } from "./source.ts";
import { FilesystemKnowledgeSource, DEFAULT_TEXT_EXTENSIONS, type WalkLimits } from "./filesystem-source.ts";
import { GithubKnowledgeSource } from "./github-source.ts";
import { GoogleDriveKnowledgeSource, type GoogleDriveSourceOptions } from "./drive-source.ts";
import { ObsidianVaultKnowledgeSource } from "./obsidian-source.ts";
import { MeetingTranscriptKnowledgeSource } from "./meeting-transcript-source.ts";
import type { TranscriptFormat } from "./transcript-parse.ts";
import { EmailAttachmentKnowledgeSource } from "./email-attachment-source.ts";
import type { OcrProvider, VisionDescriptionProvider } from "./ocr-provider.ts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { IdentityContext } from "@jarvis/contracts";

/**
 * UA-2 P1A §17: typet, FLERE-instans kildekonfigurasjon. Hver config-oppføring
 * er bundet til (tenant_id, memory_space_id, source_instance_id) - det finnes
 * INGEN implisitt/global kilde og INGEN cross-tenant default. En kilde
 * eksisterer for et gitt tenant/space KUN fordi en oppføring eksplisitt sier
 * det, aldri fordi den "arves" eller antas.
 *
 * `source_instance_id` er unik PER (tenant_id, memory_space_id) - to
 * forskjellige tenants kan begge ha en instans kalt "docs-root" uten
 * kollisjon, nettopp fordi canonical identity alltid inkluderer tenant_id.
 */
export type KnowledgeSourceConfig =
  | {
      source_type: "filesystem";
      tenant_id: string;
      memory_space_id: MemorySpace;
      source_instance_id: string;
      root_path: string;
      allowed_extensions?: ReadonlySet<string>;
      /** WP-D1: harde grenser for vandringen (filstørrelse, antall, dybde). Utelatt = standardene. */
      limits?: Partial<WalkLimits>;
    }
  | {
      source_type: "github";
      tenant_id: string;
      memory_space_id: MemorySpace;
      source_instance_id: string;
      repo: string;
    }
  | {
      source_type: "google_drive";
      tenant_id: string;
      memory_space_id: MemorySpace;
      source_instance_id: string;
      /** §18: eksplisitt scope-valg - "whole_drive" MÅ velges bevisst, aldri default. */
      scope: { kind: "folder"; folder_id: string } | { kind: "whole_drive" };
      /** Google-kontoen denne instansen autentiserer som (samme mønster som GmailTransport). */
      account: string;
      /** WP-D1: ark-modus, rad-/kolonnetak og API-pause (se `GoogleDriveSourceOptions`). */
      options?: GoogleDriveSourceOptions;
    }
  | {
      source_type: "obsidian";
      tenant_id: string;
      memory_space_id: MemorySpace;
      source_instance_id: string;
      vault_root: string;
      limits?: Partial<WalkLimits>;
    }
  | {
      /** WP-D1: ferdige møtetranskripter (txt/vtt/srt/json) fra en allowlistet rotmappe. Tale -> tekst er UA-7 og ikke bygget. */
      source_type: "meeting_transcript";
      tenant_id: string;
      memory_space_id: MemorySpace;
      source_instance_id: string;
      root_path: string;
      formats?: readonly TranscriptFormat[];
      limits?: Partial<WalkLimits>;
    }
  | {
      source_type: "email_attachment";
      tenant_id: string;
      memory_space_id: MemorySpace;
      source_instance_id: string;
      /** Gmail-kontoen denne instansen henter fra (samme mønster som google_drive sin `account` - kun dokumenterende, selve autentiseringen skjer via `JARVIS_EMAIL_TOKEN`). */
      account: string;
      /** Valgfritt: maks antall meldinger per sync-runde (default håndteres av kilden selv). */
      max?: number;
      /** Valgfritt: Gmail-søkespørring (default håndteres av kilden selv). */
      query?: string;
    };

export class UnknownSourceInstanceError extends Error {
  constructor(tenantId: string, memorySpaceId: string, sourceInstanceId: string) {
    super(`unknown_source_instance: tenant=${tenantId} space=${memorySpaceId} instance=${sourceInstanceId}`);
    this.name = "UnknownSourceInstanceError";
  }
}

/** Injiserte avhengigheter for kilder som selv trenger dem (ToolGateway-baserte kilder). Filesystem/Obsidian trenger ingen. `ocr` kreves KUN av `email_attachment` (UA-2 P1B-A). */
export interface KnowledgeSourceBuildDeps {
  toolGateway?: ToolGateway;
  identity?: IdentityContext;
  ocr?: OcrProvider & VisionDescriptionProvider;
}

/**
 * UA-2 P1A §17: registry over alle konfigurerte kildeinstanser. Bygges fra en
 * EKSPLISITT, statisk liste (env/konfig-drevet, ingen ny lagringsmekanisme -
 * bevisst enkelt, se advarselen mot en "gigantisk connector-SDK" i
 * byggeordren). `forTenant()` er den primære lesestien - den kan STRUKTURELT
 * ALDRI returnere en annen tenants konfigurasjon, siden filteret er en del av
 * spørringen, ikke noe konsumenten må huske å sjekke selv.
 */
export class KnowledgeSourceRegistry {
  constructor(private readonly configs: readonly KnowledgeSourceConfig[]) {}

  /** Alle konfigurerte instanser for én (tenant, space) - aldri på tvers av tenants. */
  forTenant(tenantId: string, memorySpaceId: MemorySpace): KnowledgeSourceConfig[] {
    return this.configs.filter((c) => c.tenant_id === tenantId && c.memory_space_id === memorySpaceId);
  }

  /**
   * ALLE konfigurerte instanser på tvers av tenants - KUN for ops/host-runner-
   * enumerering (f.eks. "kjør sync for hver konfigurerte instans"). Hver
   * oppføring bærer sin EGEN tenant_id/memory_space_id, så en konsument som
   * itererer denne og bruker oppføringens egne felter blander ALDRI tenants -
   * risikoen oppstår kun hvis en konsument feilaktig bruker en ANNEN
   * identitet enn den oppføringen selv oppgir, noe denne typen strukturelt
   * hindrer (configet er den eneste kilden til tenant_id/memory_space_id).
   */
  all(): readonly KnowledgeSourceConfig[] {
    return this.configs;
  }

  private findConfig(tenantId: string, memorySpaceId: MemorySpace, sourceInstanceId: string): KnowledgeSourceConfig {
    const found = this.configs.find(
      (c) => c.tenant_id === tenantId && c.memory_space_id === memorySpaceId && c.source_instance_id === sourceInstanceId
    );
    if (!found) {
      throw new UnknownSourceInstanceError(tenantId, memorySpaceId, sourceInstanceId);
    }
    return found;
  }

  /**
   * Bygger en konkret `KnowledgeSource` for en EKSPLISITT konfigurert
   * instans. Kaster `UnknownSourceInstanceError` hvis (tenant, space,
   * instans) ikke er konfigurert - aldri en stille no-op-kilde.
   */
  build(tenantId: string, memorySpaceId: MemorySpace, sourceInstanceId: string, deps: KnowledgeSourceBuildDeps = {}): KnowledgeSource {
    const config = this.findConfig(tenantId, memorySpaceId, sourceInstanceId);
    return this.buildFromConfig(config, deps);
  }

  buildFromConfig(config: KnowledgeSourceConfig, deps: KnowledgeSourceBuildDeps = {}): KnowledgeSource {
    switch (config.source_type) {
      case "filesystem":
        return new FilesystemKnowledgeSource(config.root_path, config.source_instance_id, {
          allowedExtensions: config.allowed_extensions ?? DEFAULT_TEXT_EXTENSIONS, ...(config.limits ? { limits: config.limits } : {})
        });
      case "github": {
        if (!deps.toolGateway || !deps.identity) {
          throw new Error("github_source_requires_tool_gateway_and_identity");
        }
        return new GithubKnowledgeSource(deps.toolGateway, deps.identity, config.repo, config.source_instance_id);
      }
      case "google_drive": {
        if (!deps.toolGateway || !deps.identity) {
          throw new Error("google_drive_source_requires_tool_gateway_and_identity");
        }
        return new GoogleDriveKnowledgeSource(
          deps.toolGateway, deps.identity,
          config.scope.kind === "folder" ? { kind: "folder", folder_id: config.scope.folder_id } : { kind: "whole_drive" },
          config.source_instance_id,
          config.options
        );
      }
      case "obsidian":
        return new ObsidianVaultKnowledgeSource(config.vault_root, config.source_instance_id, config.limits);
      case "meeting_transcript":
        return new MeetingTranscriptKnowledgeSource(config.root_path, config.source_instance_id, {
          ...(config.formats ? { formats: config.formats } : {}), ...(config.limits ? { limits: config.limits } : {})
        });
      case "email_attachment": {
        if (!deps.toolGateway || !deps.identity || !deps.ocr) {
          throw new Error("email_attachment_source_requires_tool_gateway_identity_and_ocr");
        }
        return new EmailAttachmentKnowledgeSource(
          deps.toolGateway, deps.identity, deps.ocr, config.source_instance_id,
          { ...(config.max !== undefined ? { max: config.max } : {}), ...(config.query !== undefined ? { query: config.query } : {}) }
        );
      }
    }
  }
}
