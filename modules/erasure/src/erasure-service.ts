import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import type { PolicyGateway } from "@jarvis/policy";
import { withMemoryTransaction, MemoryRetriever, type EmbeddingProvider } from "@jarvis/memory";
import { KnowledgeRetriever } from "@jarvis/knowledge";
import {
  completeErasureRequest,
  failErasureRequest,
  findErasureRequest,
  insertPendingErasureRequest,
  recordErasureFingerprints
} from "@jarvis/core";
import { type ErasureScope, scopeSummary } from "./scope.ts";
import { planScope } from "./plan.ts";
import { setErasureInProgress, setTenantOnlyContext } from "./context.ts";

export interface ErasurePreview {
  scope: ErasureScope;
  affected: Record<string, number>;
  /** Deterministiske blockers - f.eks. et scope som ikke matcher noe (ikke en feil, bare informasjon). */
  blockers: string[];
}

export interface ErasureResult {
  request_id: string;
  status: "completed" | "failed";
  record_counts: Record<string, number>;
  idempotent_replay: boolean;
  error?: string;
}

export interface ExecuteErasureParams {
  scope: ErasureScope;
  requestId: string;
  identity: IdentityContext;
  /** Kreves for klasse D med mindre kalleren er owner i SOVEREIGN-modus (samme regel som alle andre D-handlinger). */
  approval?: unknown;
}

export interface VerifyErasureParams {
  identity: IdentityContext;
  spaces: readonly MemorySpace[];
  /** Streng som IKKE lenger skal kunne hentes - live-scriptet/testene bruker en unik SENTINEL. */
  sentinel: string;
}

export interface VerifyErasureResult {
  fts_hits: number;
  vector_hits: number;
  hybrid_hits: number;
  memory_hits: number;
}

/**
 * Q-20 (docs/DATA_ERASURE.md): sentral, typed data-erasure/purge-tjeneste.
 * Rå SQL på tvers av tabeller - samme etablerte mønster som
 * `modules/watchdog/src/backup.ts` (BackupService), ikke en ny arkitektur-stil.
 */
export class ErasureService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly policy: PolicyGateway,
    private readonly embeddings: EmbeddingProvider
  ) {}

  /** Read-only, deterministisk. ALDRI payload i resultatet - kun identifiers/counts (§3 i BO-en). */
  async previewErasure(scope: ErasureScope): Promise<ErasurePreview> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const plan = await planScope(client, "count", scope);
      await client.query("ROLLBACK"); // preview er read-only uansett - ROLLBACK som ekstra sikkerhetsnett
      const blockers = Object.values(plan.recordCounts).every((n) => n === 0) ? ["scope_matches_nothing"] : [];
      return { scope, affected: plan.recordCounts, blockers };
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr) => {
        console.error(JSON.stringify({
          msg: "erasure_preview_rollback_failed",
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        }));
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * §7: policy-sjekk gjenbruker EKSISTERENDE PolicyGateway/D-klasse-mekanikk
   * uendret - ingen ny separat auth-modell. §9: går IKKE via
   * ToolGateway.execute() sin D-pipeline (den ville lagret en KOPI av
   * innholdet som slettes i `tool_executions.before_state` - se
   * docs/DATA_ERASURE.md §7 for hvorfor det ville undergravd erasure).
   */
  async executeErasure(params: ExecuteErasureParams): Promise<ErasureResult> {
    const { scope, requestId, identity, approval } = params;
    if (scope.tenant_id !== identity.tenant_id) {
      // Fail-closed: en identitet kan aldri be om purge for en ANNEN tenant enn sin egen.
      return { request_id: requestId, status: "failed", record_counts: {}, idempotent_replay: false, error: "cross_tenant_purge_denied" };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await setTenantOnlyContext(client, scope.tenant_id);
      const existing = await findErasureRequest(client, scope.tenant_id, requestId);
      if (existing?.status === "completed") {
        // §7 i BO-en (idempotency): samme request igjen -> lagret resultat, INGEN ny sletting, INGEN feil.
        await client.query("COMMIT");
        return { request_id: requestId, status: "completed", record_counts: existing.record_counts, idempotent_replay: true };
      }

      const decision = await this.policy.authorize({
        identity,
        toolCall: { tool_id: "data-erasure", action: "purge", capability_class: "D", parameters: scopeSummary(scope) },
        approval
      });
      if (decision.decision !== "ALLOW") {
        await client.query("ROLLBACK");
        return { request_id: requestId, status: "failed", record_counts: {}, idempotent_replay: false, error: `policy_denied:${decision.reason}` };
      }

      if (!existing) {
        await insertPendingErasureRequest(client, requestId, scope.tenant_id, scope.type, scopeSummary(scope), {
          personId: identity.person_id,
          deviceId: identity.device_id
        });
      }

      // D-358: lar KUN memory_versions sin append-only-trigger slippe gjennom
      // DENNE transaksjonens DELETE (062_memory_erasure_bypass.sql) - satt
      // rett FØR selve slettingen, ALDRI for "count"/preview-grenen over.
      await setErasureInProgress(client);
      const plan = await planScope(client, "delete", scope);
      await recordErasureFingerprints(
        client,
        scope.tenant_id,
        requestId,
        plan.knowledgeIdentities.map((k) => ({
          sourceType: k.source_type,
          sourceInstanceId: k.source_instance_id,
          externalId: k.external_id
        }))
      );
      await completeErasureRequest(client, requestId, plan.recordCounts);
      await client.query("COMMIT");
      return { request_id: requestId, status: "completed", record_counts: plan.recordCounts, idempotent_replay: false };
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr) => {
        console.error(JSON.stringify({
          msg: "erasure_execute_rollback_failed",
          request_id: requestId,
          tenant_id: scope.tenant_id,
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        }));
      });
      const message = (err as Error).message.slice(0, 200);
      // D-220: hvis DENNE persisteringen selv feiler, skal kalleren FORTSATT få et
      // ærlig {status:"failed"} i minnet (uendret av denne fiksen) - MEN `erasure_
      // requests` får da INGEN rad i det hele tatt for denne forespørselen (den
      // tidligere `insertPendingErasureRequest()`-innsettingen skjedde i SAMME
      // transaksjon som selve sletteforsøket og ble rullet tilbake MED den) - en
      // GDPR-sletteforespørsel uten NOE spor i revisjonsloggen. Samme
      // "isolasjon beholdes, feilen gjøres OBSERVERBAR"-mønster som D-218/D-219.
      await failErasureRequest(this.pool, scope.tenant_id, requestId, scope.type, scopeSummary(scope), message).catch((persistErr) => {
        console.error(JSON.stringify({
          msg: "erasure_request_fail_status_persist_failed",
          request_id: requestId,
          tenant_id: scope.tenant_id,
          scope_type: scope.type,
          original_error: message,
          persist_error: persistErr instanceof Error ? persistErr.message : String(persistErr)
        }));
      });
      return { request_id: requestId, status: "failed", record_counts: {}, idempotent_replay: false, error: message };
    } finally {
      client.release();
    }
  }

  /**
   * Bruker de FAKTISKE produksjons-retrieval-veiene (KnowledgeRetriever/
   * MemoryRetriever) for hybrid/memory - ikke en egen reimplementasjon som
   * kan drifte fra ekte oppførsel. FTS/vector isoleres separat med minimale
   * spørringer som speiler retrieverenes egne predikater (samme tsvector-
   * språk, samme cosine-terskel) for å gi et PRESIST per-modus-signal.
   */
  async verifyErasure(params: VerifyErasureParams): Promise<VerifyErasureResult> {
    const { identity, spaces, sentinel } = params;

    const ftsHits = await withMemoryTransaction(this.pool, identity.tenant_id, spaces, async (client) => {
      const r = await client.query(
        `SELECT content FROM knowledge_documents WHERE tenant_id = $1 AND deleted = false AND fts @@ plainto_tsquery('norwegian', $2)`,
        [identity.tenant_id, sentinel]
      );
      return (r.rows as Array<{ content: string }>).filter((row) => row.content.includes(sentinel)).length;
    });

    const queryVector = await this.embeddings.embed(sentinel);
    const vectorHits = await withMemoryTransaction(this.pool, identity.tenant_id, spaces, async (client) => {
      const pgv = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='knowledge_embeddings' AND column_name='vec') AS has"
      );
      const usesPgVector = (pgv.rows[0] as { has: boolean }).has;
      const simExpr = usesPgVector ? "1 - (e.vec <=> ($1::text)::vector)" : "cosine_sim(e.embedding, $1::real[])";
      const vecArg = usesPgVector ? JSON.stringify(queryVector) : queryVector;
      const r = await client.query(
        `SELECT d.content FROM knowledge_embeddings e JOIN knowledge_documents d ON d.knowledge_document_id = e.knowledge_document_id
         WHERE d.deleted = false${usesPgVector ? " AND e.vec IS NOT NULL" : ""} AND ${simExpr} >= 0.4`,
        [vecArg]
      );
      return (r.rows as Array<{ content: string }>).filter((row) => row.content.includes(sentinel)).length;
    });

    const knowledgeRetriever = new KnowledgeRetriever(this.pool, this.embeddings);
    const hybridResults = await knowledgeRetriever.search(identity, { query: sentinel, spaces: [...spaces] });
    const hybridHits = hybridResults.filter((r) => r.content.includes(sentinel)).length;

    const memoryRetriever = new MemoryRetriever(this.pool, this.embeddings);
    const memoryResults = await memoryRetriever.search(identity, { query: sentinel, spaces: [...spaces] });
    const memoryHits = memoryResults.filter((r) => r.content.includes(sentinel)).length;

    return { fts_hits: ftsHits, vector_hits: vectorHits, hybrid_hits: hybridHits, memory_hits: memoryHits };
  }
}
