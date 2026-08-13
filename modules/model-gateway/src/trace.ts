import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Trace-span for observability. Alle modellkall og fast-ruter skal spores. */
export interface TraceSpan {
  trace_id: string;
  kind: "model_call" | "fast_route" | "job" | "budget";
  name: string;
  tenant_id: string;
  session_id?: string;
  task_id?: string;
  at: string;
  duration_ms: number;
  cost_ore?: number;
  metadata?: Record<string, unknown>;
}

/** Observability bak adapter: Langfuse er én implementasjon, ikke et krav i kjernen. */
export interface TraceSink {
  record(span: TraceSpan): void | Promise<void>;
}

/** Test-/utviklingssink i minnet. */
export class MemoryTraceSink implements TraceSink {
  readonly spans: TraceSpan[] = [];
  record(span: TraceSpan): void {
    this.spans.push(span);
  }
}

/** Lokal JSONL-fil (git-ignorert var/-katalog). Enkel, grep-bar, portabel. */
export class JsonlTraceSink implements TraceSink {
  private dirReady = false;
  constructor(private readonly filePath: string) {}

  async record(span: TraceSpan): Promise<void> {
    if (!this.dirReady) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.dirReady = true;
    }
    await appendFile(this.filePath, `${JSON.stringify(span)}\n`, "utf8");
  }
}

/**
 * Langfuse-ingestion (selvhostet). AKTIVERES via miljø når Langfuse kjører
 * (krever Docker/NAS-miljø - uverifisert lokalt til det finnes, se PROJECT_STATUS).
 * Feil i observability skal aldri stoppe samtalen - kun logges.
 */
export class LangfuseTraceSink implements TraceSink {
  constructor(
    private readonly baseUrl: string,
    private readonly publicKey: string,
    private readonly secretKey: string
  ) {}

  async record(span: TraceSpan): Promise<void> {
    const auth = Buffer.from(`${this.publicKey}:${this.secretKey}`).toString("base64");
    // v2-ingestion: trace-create foerst, saa observation - korrelert på traceId.
    // KUN kontrollerte felt sendes (tenant/session/task/kost/usage) - aldri env/credentials.
    const event = {
      batch: [
        {
          id: `${span.trace_id}-t`,
          type: "trace-create",
          timestamp: span.at,
          body: {
            id: span.trace_id,
            name: span.name,
            userId: span.tenant_id,
            sessionId: span.session_id ?? null,
            metadata: { tenant_id: span.tenant_id, task_id: span.task_id ?? null, cost_ore: span.cost_ore ?? null }
          }
        },
        {
          id: `${span.trace_id}-s`,
          type: "span-create",
          timestamp: span.at,
          body: {
            traceId: span.trace_id,
            name: span.name,
            startTime: span.at,
            endTime: new Date(new Date(span.at).getTime() + span.duration_ms).toISOString(),
            metadata: { ...span.metadata, tenant_id: span.tenant_id, task_id: span.task_id, cost_ore: span.cost_ore }
          }
        }
      ]
    };
    try {
      await fetch(`${this.baseUrl}/api/public/ingestion`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
        body: JSON.stringify(event)
      });
    } catch {
      // Observability-feil er ikke fatale.
    }
  }
}
