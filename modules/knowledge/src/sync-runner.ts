import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { withMemoryTransaction, type EmbeddingProvider } from "@jarvis/memory";
import type { LlmPassReport } from "./entity-llm.ts";
import { KnowledgeRetentionService } from "./retention.ts";
import type { ConfiguredKnowledgeSource } from "./source-config.ts";
import type { KnowledgeSource } from "./source.ts";
import { KnowledgeSyncService, type KnowledgeEntityIndexPort, type SyncReport } from "./sync.ts";

/**
 * WP-D1 (UA-2, JARVIS-032): kjører de konfigurerte kunnskapskildene (`JARVIS_KNOWLEDGE_SOURCES`) periodisk i worker-prosessen. DVALE som standard: uten kilder gjør `start()` ingenting (ingen timer, ingen
 * database- eller nettverkstilgang). Hver kilde synkes via den ordinære `KnowledgeSyncService` (kilden lister, tjenesten eier identitet/dedupe/tombstone - en feilet listing tombstoner aldri noe), med
 * kildens egen sensitivitetspolicy og oppbevaringsfrist, deterministisk entitetsindeksering og (valgfritt, AV som standard) det modellassisterte entitetspasset.
 *
 * SIKKERHET OG DRIFT:
 *  - Tenant og rom kommer fra den konfigurerte kilden (som igjen er bundet til eierens tenant), aldri fra innholdet kilden leverer.
 *  - `preflight` (f.eks. «ligger den sanne roten fortsatt innenfor allowlisten», «finnes Drive-credentialen») avgjør FØR hver synk om kilden kan kjøres nå. En kilde som ikke kan det hoppes over (loggført,
 *    prøves igjen neste runde) - aldri en synk som kan se ut som «alt er slettet».
 *  - Ingen overlapp: en kilde som fortsatt synkes startes ikke på nytt, og høyst `maxConcurrent` kilder går samtidig (Drive er tregt av hensyn til API-begrenseren og skal ikke blokkere lokale kilder).
 *  - Omstart: tidsplanen holdes kun i minnet, men den PLANLAGTE første synken etter en omstart hoppes over når kilden ble synket innenfor intervallet (siste `last_synced_at` i databasen) - en worker som
 *    oppdateres/starter flere ganger skal ikke skanne hele Drive på nytt hver gang (API-kvoten). `runNow` kjører alltid.
 *  - En feil i én kilde (eller i oppbevarings-/modellpasset) stopper aldri de andre eller løkka; ved feil prøves kilden igjen etter høyst 30 minutter.
 *  - Loggene bærer kun kilde-id, kildetype, rom, tall og en kort (avkortet) feilmelding fra koden/databasen - aldri filnavn, tittel eller innhold fra dokumentene.
 */
export type SyncRunOutcome =
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }
  | { status: "synced"; report: SyncReport; purged: number; llm?: LlmPassReport };

export interface KnowledgeSyncRunnerDeps {
  pool: pg.Pool;
  embeddings: EmbeddingProvider;
  sources: readonly ConfiguredKnowledgeSource[];
  /** Bygger kildeobjektet (typisk `registry.build(...)` med ToolGateway/identitet/OCR der kilden trenger dem). Kaster => synken feiler (logges), ingenting skrives. */
  buildSource(source: ConfiguredKnowledgeSource, identity: IdentityContext): KnowledgeSource;
  identityFor(source: ConfiguredKnowledgeSource): IdentityContext;
  /** `null`/utelatt = kan kjøres. En streng = kilden hoppes over denne runden (kort årsakskode, aldri en verdi fra innholdet). */
  preflight?: ((source: ConfiguredKnowledgeSource) => Promise<string | null>) | undefined;
  /** Deterministisk entitetsindeksering inne i synk-transaksjonen. */
  entityIndexer?: KnowledgeEntityIndexPort | undefined;
  /** Det modellassisterte entitetspasset (AV som standard: utelatt = ingen modellkall). */
  llmPass?: { run(identity: IdentityContext, space: ConfiguredKnowledgeSource["memory_space"], options: { limit?: number; source?: { source_type: string; source_instance_id: string } }): Promise<LlmPassReport> } | undefined;
  now?: (() => Date) | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
  /** Hvor ofte løkka ser etter forfalte kilder. Standard 30 s. */
  tickMs?: number | undefined;
  /** Ventetid før første synk etter oppstart (la workeren bli ferdig med oppstarten), og forskyvning mellom kildene. */
  firstRunDelayMs?: number | undefined;
  staggerMs?: number | undefined;
  /** Høyst så mange kilder samtidig. Standard 2. */
  maxConcurrent?: number | undefined;
  /**
   * Gjennomgang av PR #325 (funn 2): maks tid én kilde kan bruke på én synk før plassen frigis (standard 20 min). En kilde som henger (en NAS-monteringen som står, en fil som blokkerer) skal aldri holde en av de få
   * samtidige plassene til workeren restartes. Den hengende kjøringen kan ikke avbrytes, men regnes som feilet (`source_sync_timeout`) og prøves igjen om høyst 30 min.
   */
  sourceTimeoutMs?: number | undefined;
}

const FAILURE_RETRY_MS = 30 * 60_000;
const MINUTE_MS = 60_000;
export const DEFAULT_SOURCE_TIMEOUT_MS = 20 * MINUTE_MS;

export interface SyncRunnerStatusEntry {
  id: string;
  kind: string;
  memory_space: string;
  next_due_at: string | null;
  last_outcome: SyncRunOutcome["status"] | null;
  last_run_at: string | null;
}

export class KnowledgeSyncRunner {
  private readonly sync: KnowledgeSyncService;
  private readonly retention: KnowledgeRetentionService;
  private readonly nextDue = new Map<string, number>();
  private readonly lastOutcome = new Map<string, { status: SyncRunOutcome["status"]; at: number }>();
  private readonly inFlight = new Map<string, Promise<SyncRunOutcome>>();
  /** Kilder der «synket nylig»-sjekken mot databasen er gjort (høyst én gang per kilde per oppstart). */
  private readonly resumeChecked = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly clock: () => Date;
  private readonly log: (entry: Record<string, unknown>) => void;
  private readonly tickMs: number;
  private readonly firstRunDelayMs: number;
  private readonly staggerMs: number;
  private readonly maxConcurrent: number;
  private readonly sourceTimeoutMs: number;

  constructor(private readonly deps: KnowledgeSyncRunnerDeps) {
    this.sync = new KnowledgeSyncService(deps.pool, deps.embeddings);
    this.retention = new KnowledgeRetentionService(deps.pool);
    this.clock = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
    this.tickMs = Math.max(1_000, Math.floor(deps.tickMs ?? 30_000));
    this.firstRunDelayMs = Math.max(0, Math.floor(deps.firstRunDelayMs ?? 20_000));
    this.staggerMs = Math.max(0, Math.floor(deps.staggerMs ?? 10_000));
    this.maxConcurrent = Math.min(Math.max(Math.floor(deps.maxConcurrent ?? 2), 1), 8);
    this.sourceTimeoutMs = Math.max(10, Math.floor(deps.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS));
  }

  get sourceCount(): number {
    return this.deps.sources.length;
  }

  /** Starter løkka. Uten kilder: ingenting skjer (dvale). Kan kalles flere ganger (idempotent). */
  start(): void {
    if (this.timer !== undefined || this.deps.sources.length === 0) return;
    const start = this.clock().getTime();
    this.deps.sources.forEach((source, index) => this.nextDue.set(source.id + "\u0000" + source.memory_space, start + this.firstRunDelayMs + index * this.staggerMs));
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private keyOf(source: ConfiguredKnowledgeSource): string {
    return `${source.id}\u0000${source.memory_space}`;
  }

  /** Starter alle forfalte kilder (opp til samtidighetsgrensen) uten å vente på dem. Bruk `idle()` for å vente. */
  async tick(): Promise<void> {
    const now = this.clock().getTime();
    for (const source of this.deps.sources) {
      if (this.inFlight.size >= this.maxConcurrent) break;
      const key = this.keyOf(source);
      if (this.inFlight.has(key)) continue;
      if ((this.nextDue.get(key) ?? Number.POSITIVE_INFINITY) > now) continue;
      // Første gang kilden er forfalt etter oppstart: ble den allerede synket innenfor intervallet (før omstarten), utsettes den til intervallet er gått.
      await this.deferIfRecentlySynced(source);
      if ((this.nextDue.get(key) ?? Number.POSITIVE_INFINITY) > now) continue;
      void this.launch(source);
    }
  }

  private async deferIfRecentlySynced(source: ConfiguredKnowledgeSource): Promise<void> {
    const key = this.keyOf(source);
    if (this.resumeChecked.has(key)) return;
    this.resumeChecked.add(key);
    try {
      const last = await this.lastSyncedAt(source);
      if (last !== null) {
        const next = last.getTime() + source.sync_interval_minutes * MINUTE_MS;
        if (next > (this.nextDue.get(key) ?? 0)) this.nextDue.set(key, next);
      }
    } catch {
      // Uten tilstand (databasen utilgjengelig): kjør som planlagt - synk-tjenesten feiler da selv, lukket.
    }
  }

  /** Siste synketidspunkt for kildeinstansen i rommet (RLS som app-rolle), eller `null` når den aldri har lagret et dokument. */
  private async lastSyncedAt(source: ConfiguredKnowledgeSource): Promise<Date | null> {
    const identity = this.deps.identityFor(source);
    return withMemoryTransaction(this.deps.pool, identity.tenant_id, [source.memory_space], async (client) => {
      const result = await client.query(
        "SELECT max(last_synced_at) AS at FROM knowledge_documents WHERE tenant_id = $1 AND memory_space_id = $2 AND source_type = $3 AND source_instance_id = $4",
        [identity.tenant_id, source.memory_space, source.config.source_type, source.config.source_instance_id]
      );
      const at = (result.rows[0] as { at: Date | null } | undefined)?.at;
      return at instanceof Date ? at : null;
    });
  }

  /** Venter til alle pågående synker er ferdige. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }

  /** Kjører én kilde nå (ellers samme vei som løkka). Pågår den allerede, returneres den pågående kjøringen. */
  runNow(sourceId: string, memorySpace?: string): Promise<SyncRunOutcome> {
    const source = this.deps.sources.find((s) => s.id === sourceId && (memorySpace === undefined || s.memory_space === memorySpace));
    if (source === undefined) return Promise.resolve({ status: "skipped", reason: "unknown_source" });
    return this.launch(source);
  }

  status(): SyncRunnerStatusEntry[] {
    return this.deps.sources.map((source) => {
      const key = this.keyOf(source);
      const due = this.nextDue.get(key);
      const last = this.lastOutcome.get(key);
      return {
        id: source.id, kind: source.kind, memory_space: source.memory_space,
        next_due_at: due === undefined ? null : new Date(due).toISOString(),
        last_outcome: last?.status ?? null, last_run_at: last === undefined ? null : new Date(last.at).toISOString()
      };
    });
  }

  private launch(source: ConfiguredKnowledgeSource): Promise<SyncRunOutcome> {
    const key = this.keyOf(source);
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const promise = this.withWatchdog(source, this.runSource(source))
      .then((outcome) => {
        const now = this.clock().getTime();
        this.lastOutcome.set(key, { status: outcome.status, at: now });
        const intervalMs = source.sync_interval_minutes * MINUTE_MS;
        const retryable = outcome.status === "failed" || outcome.status === "skipped" || (outcome.status === "synced" && outcome.report.error_class !== undefined);
        this.nextDue.set(key, now + (retryable ? Math.min(intervalMs, FAILURE_RETRY_MS) : intervalMs));
        return outcome;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Frigir plassen når en synk tar for lang tid (se `sourceTimeoutMs`). Den hengende kjøringen får fortsette i bakgrunnen, men utfallet er «feilet» og neste forsøk planlegges som ved enhver feil. */
  private withWatchdog(source: ConfiguredKnowledgeSource, run: Promise<SyncRunOutcome>): Promise<SyncRunOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SyncRunOutcome>((resolve) => {
      timer = setTimeout(() => {
        this.log({ msg: "knowledge_source_timeout", source_id: source.id, kind: source.kind, memory_space: source.memory_space, after_ms: this.sourceTimeoutMs });
        resolve({ status: "failed", error: "source_sync_timeout" });
      }, this.sourceTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([run, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  private async runSource(source: ConfiguredKnowledgeSource): Promise<SyncRunOutcome> {
    const tags = { source_id: source.id, kind: source.kind, memory_space: source.memory_space };
    try {
      const reason = (await this.deps.preflight?.(source)) ?? null;
      if (reason !== null) {
        this.log({ msg: "knowledge_source_skipped", ...tags, reason });
        return { status: "skipped", reason };
      }
      const identity = this.deps.identityFor(source);
      const built = this.deps.buildSource(source, identity);
      const report = await this.sync.sync(identity, source.memory_space, built, {
        policy: source.policy,
        ...(source.retention_days !== undefined ? { retention_days: source.retention_days } : {}),
        now: this.clock(),
        ...(this.deps.entityIndexer ? { entity_indexer: this.deps.entityIndexer } : {})
      });
      const ref = { source_type: built.source_type, source_instance_id: built.source_instance_id };
      let purged = 0;
      if (source.retention_days !== undefined && report.error_class === undefined && report.failed === 0) {
        try {
          const result = await this.retention.purgeExpired(identity, source.memory_space, ref, source.retention_days, { now: this.clock() });
          purged = result.documents;
        } catch {
          this.log({ msg: "knowledge_source_purge_failed", ...tags });
        }
      }
      let llm: LlmPassReport | undefined;
      if (this.deps.llmPass !== undefined && report.error_class === undefined) {
        try {
          llm = await this.deps.llmPass.run(identity, source.memory_space, { source: ref, limit: 5 });
        } catch {
          this.log({ msg: "knowledge_source_entity_llm_failed", ...tags });
        }
      }
      this.log({ msg: report.error_class === undefined ? "knowledge_source_synced" : "knowledge_source_sync_degraded", ...tags, ...report, purged, ...(llm ? { llm } : {}) });
      return { status: "synced", report, purged, ...(llm ? { llm } : {}) };
    } catch (err) {
      // Kun en kort feilmelding fra koden vår: bygging av kilden og synk-oppsett (per-dokument-feil logges av synk-tjenesten med hash av id, aldri filnavn).
      const error = (err as Error).message.slice(0, 200);
      this.log({ msg: "knowledge_source_failed", ...tags, error });
      return { status: "failed", error };
    }
  }
}
