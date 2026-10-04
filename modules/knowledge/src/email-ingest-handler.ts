import type pg from "pg";
import { MemorySpaceSchema, type IdentityContext, type MemorySpace } from "@jarvis/contracts";
import type { ClaimedTask, JobContext } from "@jarvis/tasks";
import type { EmbeddingProvider } from "@jarvis/memory";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { ModelGatewayVisionExtractor, type VisionCompleter } from "./ocr-provider.ts";
import { KnowledgeSourceRegistry } from "./registry.ts";
import { KnowledgeSyncService } from "./sync.ts";

export interface EmailIngestHandlerOptions {
  pool: pg.Pool;
  toolGateway: ToolGateway;
  embeddings: EmbeddingProvider;
  visionGateway: VisionCompleter;
  registry: KnowledgeSourceRegistry;
}

/**
 * UA-2 P1B-A (D-43 §5): kjører `KnowledgeSyncService.sync()` for ÉN
 * konfigurert `email_attachment`-kildeinstans som en DURABLE jobb - gjenbruker
 * EKSISTERENDE `InProcessWorker`/`PgTaskQueue` (lease/checkpoint/retry på
 * JOBB-nivå, samme mønster som `executiveHandler` i `apps/api/src/executive.ts`).
 * Finkornet per-vedlegg-checkpointing INNI én sync-kjøring er IKKE bygget
 * denne runden (D-43 §5 - eksplisitt dokumentert, ikke stille utelatt).
 *
 * `task.contract.input.data` MÅ inneholde `source_instance_id`; `memory_space_id`
 * er valgfri (default `"personal"`); `tenant_id`/`owner_person_id` kommer fra
 * `task.contract`/`task.tenant_id` selv (ALDRI fra jobb-input - unngår at en
 * jobb kan late som den tilhører en annen tenant).
 */
export function emailIngestHandler(opts: EmailIngestHandlerOptions) {
  return async (task: ClaimedTask, ctx: JobContext): Promise<Record<string, unknown>> => {
    await ctx.assertNotCancelled();
    const input = task.contract.input.data as {
      source_instance_id?: string;
      memory_space_id?: string;
      session_id?: string;
      device_id?: string;
    };
    const sourceInstanceId = input.source_instance_id;
    if (!sourceInstanceId) {
      throw new Error("email_ingest_handler_requires_source_instance_id");
    }
    // D-396 (JARVIS-032): jobb-input er ikke-betrodd - en ukjent memory space ble tidligere castet rått og endte som en SQL-/RLS-feil dypt nede.
    const parsedSpace = MemorySpaceSchema.safeParse(input.memory_space_id ?? "personal");
    if (!parsedSpace.success) throw new Error("email_ingest_invalid_memory_space");
    const memorySpaceId: MemorySpace = parsedSpace.data;

    const identity: IdentityContext = {
      person_id: task.contract.owner_person_id, tenant_id: task.tenant_id, memory_space_id: memorySpaceId,
      session_id: input.session_id ?? `sess-knowledge-ingest-email-${task.task_id}`,
      device_id: input.device_id ?? "jarvis-core", channel: "api", auth_strength: "active"
    };

    const ocr = new ModelGatewayVisionExtractor(opts.visionGateway, task.tenant_id, task.task_id);
    const source = opts.registry.build(task.tenant_id, memorySpaceId, sourceInstanceId, {
      toolGateway: opts.toolGateway, identity, ocr
    });

    await ctx.assertNotCancelled();
    const sync = new KnowledgeSyncService(opts.pool, opts.embeddings);
    const report = await sync.sync(identity, memorySpaceId, source);
    return { ...report };
  };
}
