import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Trace-span for observability. Alle modellkall og fast-ruter skal spores. */
export interface TraceSpan {
  trace_id: string;
  /** D-106 HOST-FIX: `council_suppressed` spores når eieren eksplisitt undertrykker et policy-mandatert Council-trigger (§"AUDITABILITY" - aldri en stille undertrykkelse). */
  kind: "model_call" | "fast_route" | "job" | "budget" | "council_suppressed";
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

/**
 * BO-09: velg trace-sink fra miljø - Langfuse når konfigurert (D-27-runtime),
 * ellers lokal JSONL. Samme valg for api og worker; ingen secrets i kode.
 */
export function traceSinkFromEnv(jsonlPath = "var/traces.jsonl"): TraceSink {
  const base = process.env["LANGFUSE_BASE_URL"];
  const pub = process.env["LANGFUSE_PUBLIC_KEY"];
  const secret = process.env["LANGFUSE_SECRET_KEY"];
  if (base && pub && secret) {
    return new LangfuseTraceSink(base, pub, secret);
  }
  return new JsonlTraceSink(jsonlPath);
}

/**
 * D-395 (JARVIS-074): JSONL-sporet vokste uten grense i containerlaget. Filen roteres nå ved `maxBytes`
 * (`fil` → `fil.1` → … → `fil.<maxFiles>`; den eldste slettes), så det samlede diskforbruket er begrenset til
 * omtrent (maxFiles + 1) × maxBytes.
 */
export interface JsonlRotation {
  /** Rotér når neste linje ville gjort filen større enn dette. */
  maxBytes: number;
  /** Antall roterte filer som beholdes ved siden av den aktive. */
  maxFiles: number;
}

export const DEFAULT_JSONL_ROTATION: JsonlRotation = { maxBytes: 50 * 1024 * 1024, maxFiles: 3 };

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

const ignoreMissing = (err: unknown): void => {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
};

/** Lokal JSONL-fil (git-ignorert var/-katalog). Enkel, grep-bar, portabel. Størrelsesbasert rotasjon (se `JsonlRotation`). */
export class JsonlTraceSink implements TraceSink {
  private dirReady = false;
  private size: number | undefined;
  /** Skrivinger serialiseres: rotasjon og append må aldri flettes sammen. */
  private chain: Promise<void> = Promise.resolve();
  private readonly rotation: JsonlRotation;

  constructor(private readonly filePath: string, rotation: Partial<JsonlRotation> = {}) {
    this.rotation = {
      maxBytes: Math.max(1, rotation.maxBytes ?? DEFAULT_JSONL_ROTATION.maxBytes),
      maxFiles: Math.max(1, rotation.maxFiles ?? DEFAULT_JSONL_ROTATION.maxFiles)
    };
  }

  record(span: TraceSpan): Promise<void> {
    const run = this.chain.then(() => this.write(span));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async write(span: TraceSpan): Promise<void> {
    if (!this.dirReady) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.dirReady = true;
    }
    const line = `${JSON.stringify(span)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.size === undefined) this.size = await fileSize(this.filePath);
    if (this.size > 0 && this.size + bytes > this.rotation.maxBytes) {
      await this.rotate();
      this.size = 0;
    }
    await appendFile(this.filePath, line, "utf8");
    this.size += bytes;
  }

  private async rotate(): Promise<void> {
    const { maxFiles } = this.rotation;
    await rm(`${this.filePath}.${maxFiles}`, { force: true });
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      await rename(`${this.filePath}.${i}`, `${this.filePath}.${i + 1}`).catch(ignoreMissing);
    }
    await rename(this.filePath, `${this.filePath}.1`).catch(ignoreMissing);
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
            id: `${span.trace_id}-span`,
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
