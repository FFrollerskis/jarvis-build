import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { envInt } from "@jarvis/contracts";
import type { PolicyAuditEvent } from "@jarvis/policy";
import { withTenantTransaction } from "../db/pool.ts";
import { scanForSecrets } from "./secret-scan.ts";

/**
 * WP-K (D-471, JARVIS-053): VARIG, DB-BASERT revisjons-sink for `PolicyGateway`. Skriver hver avgjørelse til `policy_decisions` (migrasjon 108): append-only, tenant-skopet (RLS), kun metadata.
 * AV som standard - bare `JARVIS_POLICY_AUDIT_SINK=db` slår den på (`createPolicyAuditSinkFromEnv`); uten flagget er oppførselen byte-identisk med D-393 (ringbuffer i minnet).
 *
 * KONTRAKT (testet i `wpk-policy-audit-sink.test.ts` mot ekte Postgres):
 *  - `write()` er SYNKRON, kaster ALDRI og blokkerer aldri en avgjørelse: hendelsen legges i en BEGRENSET kø og skrives av en bakgrunns-flusher i batcher (én transaksjon per tenant).
 *  - MOTTRYKK: en full kø AVVISER nye hendelser (`write()` svarer `false`, `rejected_full` telles og logges strupet). Køen vokser aldri utover `maxQueue` - minnet er avgrenset uansett hvor lenge databasen er nede.
 *  - FEIL: en transient feil (database nede, tidsavbrudd, manglende tabell) beholder batchen i køen og prøver igjen med eksponentiell backoff; en PERMANENT feil på én rad (22xxx/23xxx: ugyldige data, ukjent tenant)
 *    isoleres rad for rad slik at én giftig rad aldri blokkerer resten (den kastes og telles som `rejected_invalid`). Innsettingen er idempotent (`ON CONFLICT DO NOTHING`), så en retry etter et uklart utfall dupliserer aldri.
 *  - AVGJØRELSEN ER ALDRI AVHENGIG AV SINKEN: se `PolicyGateway.emit()` - en kastet/avvist/falsk sink endrer aldri ALLOW/DENY. Feil her er TELT (`stats()`) og synlige (strupet logg + Autoritet-senteret), aldri stille.
 *  - REDAKSJON: hendelsen har aldri parametre/prompts/godkjenningsinnhold (se `PolicyAuditEvent`). I tillegg går hvert tekstfelt gjennom den sentrale hemmelighetsskanneren, kontrolltegn fjernes og lengden kuttes
 *    (grunnkoder 160, id-er 200) før lagring. Feil-etiketter i statistikken er koder/feilnavn, aldri fri feiltekst.
 *  - TENANT: en avgjørelse uten gyldig tenant (ugyldig identitet: `unknown`/tom) har ingen tenant å skrives under (RLS) og telles som `skipped_unattributable` - aldri en oppdiktet tenant/person.
 *  - OPPBEVARING: `prune_policy_decisions()` (migrasjon 108; standard 90 dager, gulv 30) kjøres daglig i api-prosessen sammen med oppbevaringssveipet fra D-395 (`runPolicyDecisionRetentionSweep`).
 */
export interface PolicyAuditSinkStats {
  mode: "db";
  queued: number;
  max_queue: number;
  /** `ok` < 50 % full, `elevated` >= 50 %, `high` >= 80 %, `full` = køen avviser nye hendelser (mottrykk). */
  pressure: "ok" | "elevated" | "high" | "full";
  written: number;
  /** Mottrykk: køen var full - hendelsen ble IKKE journalført (avgjørelsen er uendret). */
  rejected_full: number;
  /** Kunne ikke journalføres: ugyldig form eller permanent avvist av databasen (22xxx/23xxx). */
  rejected_invalid: number;
  /** Ingen gyldig tenant (ugyldig identitet) - ikke journalført, ingen tenant å skrive under. */
  skipped_unattributable: number;
  /** Antall mislykkede flush-forsøk (hendelsene ligger i køen og forsøkes igjen). */
  flush_failures: number;
  consecutive_failures: number;
  last_failure_at: string | null;
  /** Sikker etikett: SQLSTATE/feilkode eller maskinkode, aldri fri feiltekst. */
  last_failure: string | null;
  last_written_at: string | null;
  /** `true` når siste flush feilet eller køen har avvist hendelser de siste 5 minuttene. */
  degraded: boolean;
}

export interface PgPolicyAuditSinkOptions {
  pool: pg.Pool;
  /** Største antall hendelser i køen. Full kø = mottrykk (nye hendelser avvises og telles). Standard 2000. */
  maxQueue?: number;
  /** Største antall hendelser per flush-runde (grupperes per tenant). Standard 200. */
  batchSize?: number;
  /** Ventetid før en ny hendelse skrives (samler en batch). Standard 500 ms. */
  flushIntervalMs?: number;
  /** Tak for backoff etter feil. Standard 30 s. */
  maxBackoffMs?: number;
  /** Frist for én innsetting (tilkobling + setning) før den regnes som en transient feil. Standard 15 s. */
  insertTimeoutMs?: number;
  /** Prosessnavn i raden (`api`/`worker`); standard `JARVIS_PROCESS`. */
  processName?: string | null;
  /** `false` = ingen timere (kun `flush()`/`drain()` skriver) - for tester. Standard `true`. */
  autoFlush?: boolean;
  clock?: () => Date;
}

export interface PolicyDecisionRow {
  tenant_id: string;
  decision_id: string;
  decided_at: string;
  decision: "ALLOW" | "DENY";
  reason: string;
  person_id: string;
  actor_kind: "person" | "system";
  session_id: string | null;
  tool_id: string;
  action: string;
  capability_class: "A" | "B" | "C" | "D" | "unknown";
  task_id: string | null;
  trace_id: string | null;
  process: string | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const CLASSES: ReadonlySet<string> = new Set(["A", "B", "C", "D"]);
const DEGRADED_WINDOW_MS = 5 * 60_000;
const LOG_THROTTLE_MS = 60_000;

/** Fritekst (grunnkode): kontrolltegn bort, hemmeligheter redigert (`[REDACTED:<type>]`), kuttet til `max`. `null` for ikke-tekst/tom. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = scanForSecrets(value.replace(CONTROL_CHARS, " ")).text.trim();
  return text.length === 0 ? null : text.slice(0, max);
}

/**
 * Identifikator (tenant/person/sesjon/verktøy/handling/oppgave/spor/avgjørelse): kontrolltegn bort og kuttet. Skanneren får aldri OMSKRIVE en id (en endret id ville ødelagt korrelasjonen) -
 * hvis den likevel finner noe hemmelig-aktig lagres en deterministisk markør (`redacted-<sha256-prefiks>`): samme inndata gir samme markør (kan fortsatt joines), men ingen hemmelighet lagres.
 */
function cleanId(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(CONTROL_CHARS, " ").trim();
  if (text.length === 0) return null;
  if (scanForSecrets(text).findings.length > 0) return `redacted-${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)}`;
  return text.slice(0, max);
}

function processLabel(explicit: string | null | undefined): string | null {
  const raw = explicit !== undefined ? explicit : process.env["JARVIS_PROCESS"];
  return raw && raw.length > 0 ? raw.replace(CONTROL_CHARS, "").slice(0, 40) : null;
}

/** Hendelse -> rad. `"unattributable"` = ingen gyldig tenant; `"invalid"` = ikke journalførbar form. Aldri en oppdiktet tenant/person. */
export function toPolicyDecisionRow(event: PolicyAuditEvent, processName: string | null, now: Date): PolicyDecisionRow | "unattributable" | "invalid" {
  const tenant = cleanId(event.tenant_id, 200);
  if (tenant === null || tenant === "unknown") return "unattributable";
  if (event.decision !== "ALLOW" && event.decision !== "DENY") return "invalid";
  const id = cleanId(event.decision_id, 80);
  const decidedAt = new Date(event.at);
  const person = cleanId(event.person_id, 200) ?? "unknown";
  return {
    tenant_id: tenant,
    decision_id: id !== null && id.length >= 8 ? id : randomUUID(),
    decided_at: (Number.isNaN(decidedAt.getTime()) ? now : decidedAt).toISOString(),
    decision: event.decision,
    reason: cleanText(event.reason, 160) ?? "unknown",
    person_id: person,
    // Som `writeAudit`: systemhandlinger merkes eksplisitt i stedet for å se ut som en person.
    actor_kind: person === "system" ? "system" : "person",
    session_id: cleanId(event.session_id, 200),
    tool_id: cleanId(event.tool_id, 120) ?? "unknown",
    action: cleanId(event.action, 120) ?? "unknown",
    capability_class: CLASSES.has(event.capability_class) ? (event.capability_class as PolicyDecisionRow["capability_class"]) : "unknown",
    task_id: cleanId(event.task_id, 200),
    trace_id: cleanId(event.trace_id, 200),
    process: processName
  };
}

/** SQLSTATE-klasse 22 (dataunntak) og 23 (integritet) = en bestemt RAD er ugyldig. Alt annet (database nede, manglende tabell/rettighet) er systemisk og forsøkes igjen. */
function isPerRowError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^2[23]/.test(code);
}

/** Sikker etikett for en feil: SQLSTATE/errno hvis den finnes, ellers feilnavnet. Aldri fri tekst. */
function safeLabel(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(e.code) ? e.code : undefined;
  const name = typeof e?.name === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(e.name) ? e.name : "Error";
  if (code !== undefined) return `${name}:${code}`;
  if (typeof e?.message === "string" && /^[a-z0-9_:.-]{1,60}$/.test(e.message)) return e.message;
  return name;
}

const INSERT_SQL = `
  INSERT INTO policy_decisions
    (tenant_id, decision_id, decided_at, decision, reason, person_id, actor_kind, session_id, tool_id, action, capability_class, task_id, trace_id, process)
  SELECT $1, d.decision_id, d.decided_at, d.decision, d.reason, d.person_id, d.actor_kind, d.session_id, d.tool_id, d.action, d.capability_class, d.task_id, d.trace_id, d.process
    FROM unnest($2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[])
      AS d(decision_id, decided_at, decision, reason, person_id, actor_kind, session_id, tool_id, action, capability_class, task_id, trace_id, process)
  ON CONFLICT (tenant_id, decision_id) DO NOTHING`;

export class PgPolicyAuditSink {
  private readonly pool: pg.Pool;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly insertTimeoutMs: number;
  private readonly processName: string | null;
  private readonly autoFlush: boolean;
  private readonly clock: () => Date;

  private queue: PolicyDecisionRow[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | null = null;
  private closed = false;

  private written = 0;
  private rejectedFull = 0;
  private rejectedInvalid = 0;
  private skippedUnattributable = 0;
  private flushFailures = 0;
  private consecutiveFailures = 0;
  private lastFailureAt: string | null = null;
  private lastFailure: string | null = null;
  private lastWrittenAt: string | null = null;
  private lastRejectedAtMs = 0;
  private readonly lastLogAt = new Map<string, number>();
  private degradedLogged = false;

  constructor(options: PgPolicyAuditSinkOptions) {
    this.pool = options.pool;
    this.maxQueue = Math.max(1, Math.trunc(options.maxQueue ?? 2_000));
    this.batchSize = Math.max(1, Math.trunc(options.batchSize ?? 200));
    this.flushIntervalMs = Math.max(0, Math.trunc(options.flushIntervalMs ?? 500));
    this.maxBackoffMs = Math.max(this.flushIntervalMs, Math.trunc(options.maxBackoffMs ?? 30_000));
    this.insertTimeoutMs = Math.max(100, Math.trunc(options.insertTimeoutMs ?? 15_000));
    this.processName = processLabel(options.processName);
    this.autoFlush = options.autoFlush ?? true;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Sinken `PolicyGateway` kaller (`auditSink: sink.write`). SYNKRON og kaster aldri. `true` = tatt imot (eller bevisst hoppet over: ingen tenant), `false` = avvist (full kø/ugyldig/stengt) -
   * `PolicyGateway` teller `false` som `sink_rejected`. Avgjørelsen påvirkes aldri.
   */
  readonly write = (event: PolicyAuditEvent): boolean => {
    try {
      if (this.closed) {
        this.rejectedFull += 1;
        return false;
      }
      const row = toPolicyDecisionRow(event, this.processName, this.clock());
      if (row === "unattributable") {
        this.skippedUnattributable += 1;
        return true;
      }
      if (row === "invalid") {
        this.rejectedInvalid += 1;
        return false;
      }
      if (this.queue.length >= this.maxQueue) {
        this.rejectedFull += 1;
        this.lastRejectedAtMs = Date.now();
        this.logThrottled("policy_audit_sink_overflow", { rejected_full: this.rejectedFull, queued: this.queue.length });
        return false;
      }
      this.queue.push(row);
      this.schedule(this.queue.length >= this.batchSize ? 0 : this.flushIntervalMs);
      return true;
    } catch {
      // `write()` kaster ALDRI (en sink-feil skal aldri kunne endre en policy-avgjørelse).
      this.rejectedInvalid += 1;
      return false;
    }
  };

  stats(): PolicyAuditSinkStats {
    const ratio = this.queue.length / this.maxQueue;
    return {
      mode: "db",
      queued: this.queue.length,
      max_queue: this.maxQueue,
      pressure: this.queue.length >= this.maxQueue ? "full" : ratio >= 0.8 ? "high" : ratio >= 0.5 ? "elevated" : "ok",
      written: this.written,
      rejected_full: this.rejectedFull,
      rejected_invalid: this.rejectedInvalid,
      skipped_unattributable: this.skippedUnattributable,
      flush_failures: this.flushFailures,
      consecutive_failures: this.consecutiveFailures,
      last_failure_at: this.lastFailureAt,
      last_failure: this.lastFailure,
      last_written_at: this.lastWrittenAt,
      degraded: this.consecutiveFailures > 0 || (this.lastRejectedAtMs > 0 && Date.now() - this.lastRejectedAtMs < DEGRADED_WINDOW_MS)
    };
  }

  /** Skriv det som ligger i køen nå (én flusher om gangen). Kaster aldri; resultatet er synlig i `stats()`. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = this.runFlush().finally(() => { this.flushing = null; });
    this.flushing = run;
    return run;
  }

  /** Skriv ut køen (f.eks. ved nedstenging), maks `timeoutMs`. Returnerer antall hendelser som ble igjen. */
  async drain(timeoutMs = 3_000): Promise<{ remaining: number }> {
    const deadline = Date.now() + timeoutMs;
    this.clearTimer();
    while (this.queue.length > 0 && Date.now() < deadline) {
      const before = this.queue.length;
      await Promise.race([this.flush(), new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())).unref())]);
      if (this.queue.length >= before && this.consecutiveFailures > 0) break; // databasen er nede - ikke vent ut fristen forgjeves
    }
    return { remaining: this.queue.length };
  }

  /** Stopper timere og avviser videre hendelser. Køen skrives IKKE ut (bruk `drain()` først). */
  close(): void {
    this.closed = true;
    this.clearTimer();
  }

  // ------------------------------------------------------------------------------------------------------------------------------ internt

  private schedule(delayMs: number): void {
    if (!this.autoFlush || this.closed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, delayMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async runFlush(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, this.batchSize);
        const byTenant = new Map<string, PolicyDecisionRow[]>();
        for (const row of batch) {
          const rows = byTenant.get(row.tenant_id);
          if (rows) rows.push(row);
          else byTenant.set(row.tenant_id, [row]);
        }
        for (const [tenant, rows] of byTenant) {
          const done = await this.writeGroup(tenant, rows);
          this.queue = this.queue.filter((r) => !done.has(r));
          if (done.size < rows.length) {
            // transient feil: resten ligger igjen i køen og forsøkes på nytt etter backoff
            this.afterFailure();
            return;
          }
        }
        this.afterSuccess();
      }
    } catch (err) {
      // Skal ikke kunne skje (writeGroup fanger), men en flusher som dør stille er verre enn en telt feil.
      this.noteFailure(err);
      this.afterFailure();
    }
  }

  /** Skriver én tenant-gruppe. Returnerer radene som er ferdige (skrevet ELLER kastet som ugyldige); resten må forsøkes igjen. */
  private async writeGroup(tenant: string, rows: PolicyDecisionRow[]): Promise<Set<PolicyDecisionRow>> {
    try {
      await this.insert(tenant, rows);
      this.written += rows.length;
      this.lastWrittenAt = this.clock().toISOString();
      return new Set(rows);
    } catch (err) {
      if (!isPerRowError(err) || rows.length === 1) {
        if (isPerRowError(err)) {
          this.rejectedInvalid += 1;
          this.logThrottled("policy_audit_sink_row_rejected", { reason: safeLabel(err) });
          return new Set(rows);
        }
        this.noteFailure(err);
        return new Set();
      }
      // Giftig rad i batchen: isoler rad for rad, så resten ikke blokkeres.
      const done = new Set<PolicyDecisionRow>();
      for (const row of rows) {
        try {
          await this.insert(tenant, [row]);
          this.written += 1;
          this.lastWrittenAt = this.clock().toISOString();
          done.add(row);
        } catch (single) {
          if (isPerRowError(single)) {
            this.rejectedInvalid += 1;
            this.logThrottled("policy_audit_sink_row_rejected", { reason: safeLabel(single) });
            done.add(row);
          } else {
            this.noteFailure(single);
            break;
          }
        }
      }
      return done;
    }
  }

  private async insert(tenant: string, rows: PolicyDecisionRow[]): Promise<void> {
    const column = <K extends keyof PolicyDecisionRow>(key: K): Array<PolicyDecisionRow[K]> => rows.map((r) => r[key]);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("policy_audit_insert_timeout"), { code: "WPK_TIMEOUT" })), this.insertTimeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([
        withTenantTransaction(this.pool, tenant, async (client) => {
          await client.query("SET LOCAL statement_timeout = 8000");
          await client.query(INSERT_SQL, [
            tenant, column("decision_id"), column("decided_at"), column("decision"), column("reason"), column("person_id"), column("actor_kind"), column("session_id"),
            column("tool_id"), column("action"), column("capability_class"), column("task_id"), column("trace_id"), column("process")
          ]);
        }),
        deadline
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private noteFailure(err: unknown): void {
    this.flushFailures += 1;
    this.consecutiveFailures += 1;
    this.lastFailureAt = this.clock().toISOString();
    this.lastFailure = safeLabel(err);
    this.degradedLogged = true;
    this.logThrottled("policy_audit_sink_degraded", { queued: this.queue.length, consecutive_failures: this.consecutiveFailures, error: this.lastFailure });
  }

  private afterFailure(): void {
    const base = Math.max(this.flushIntervalMs, 100);
    this.schedule(Math.min(base * 2 ** Math.min(this.consecutiveFailures, 10), this.maxBackoffMs));
  }

  private afterSuccess(): void {
    if (this.consecutiveFailures > 0 || this.degradedLogged) {
      console.log(JSON.stringify({ msg: "policy_audit_sink_recovered", queued: this.queue.length, written: this.written }));
    }
    this.consecutiveFailures = 0;
    this.degradedLogged = false;
  }

  /** Høyst én loggline per melding per minutt (en død database skal ikke fylle loggen). Aldri hendelsesinnhold - kun tellere og sikre etiketter. */
  private logThrottled(msg: string, fields: Record<string, string | number>): void {
    const nowMs = Date.now();
    if (nowMs - (this.lastLogAt.get(msg) ?? 0) < LOG_THROTTLE_MS) return;
    this.lastLogAt.set(msg, nowMs);
    console.error(JSON.stringify({ msg, ...fields }));
  }
}

// ------------------------------------------------------------------------------------------------------------------------------ oppstart

export interface PolicyAuditSinkConfig {
  /** `db` = varig journal i Postgres; `off` = dagens oppførsel (ringbuffer i minnet). */
  mode: "off" | "db";
  maxQueue: number;
  retentionDays: number;
  /** Satt når `JARVIS_POLICY_AUDIT_SINK` har en verdi vi ikke kjenner (tolkes som `off`, og meldes ved oppstart). */
  unknownValue: string | null;
}

/** Leser flagget. Kun eksakt `db` (uavhengig av store/små bokstaver) slår på; alt annet er AV (en ukjent verdi meldes, aldri stille). Blank = usatt. */
export function policyAuditSinkConfigFromEnv(env: Record<string, string | undefined> = process.env): PolicyAuditSinkConfig {
  const raw = (env["JARVIS_POLICY_AUDIT_SINK"] ?? "").trim().toLowerCase();
  return {
    mode: raw === "db" ? "db" : "off",
    maxQueue: envInt("JARVIS_POLICY_AUDIT_QUEUE_MAX", 2_000, { min: 100, max: 50_000 }, env),
    retentionDays: envInt("JARVIS_POLICY_AUDIT_RETENTION_DAYS", 90, { min: 30, max: 3_650 }, env),
    unknownValue: raw === "" || raw === "db" || raw === "off" ? null : raw.slice(0, 20)
  };
}

/** `null` når flagget er AV (da kobles ingen sink, og `PolicyGateway` bruker ringbufferen som før). Logger beslutningen ved oppstart. */
export function createPolicyAuditSinkFromEnv(
  pool: pg.Pool,
  env: Record<string, string | undefined> = process.env,
  options: Partial<PgPolicyAuditSinkOptions> = {}
): PgPolicyAuditSink | null {
  const config = policyAuditSinkConfigFromEnv(env);
  if (config.unknownValue !== null) {
    console.error(JSON.stringify({ msg: "policy_audit_sink_unknown_value", value: config.unknownValue, effect: "off", hint: "bruk JARVIS_POLICY_AUDIT_SINK=db for å slå på den varige policy-journalen" }));
  }
  if (config.mode !== "db") return null;
  console.log(JSON.stringify({ msg: "policy_audit_sink_enabled", mode: "db", max_queue: config.maxQueue, retention_days: config.retentionDays }));
  return new PgPolicyAuditSink({ pool, maxQueue: config.maxQueue, ...options });
}

/**
 * Skriv ut køen ved SIGTERM/SIGINT (docker stop) FØR prosessen avsluttes: fristen er kort (standard 3 s), og signalet sendes på nytt etterpå slik at standard avslutning (og exit-status) er uendret.
 * Returnerer en funksjon som fjerner lytterne (tester).
 */
export function installPolicyAuditDrain(
  sink: Pick<PgPolicyAuditSink, "drain" | "close">,
  options: { timeoutMs?: number; proc?: Pick<NodeJS.Process, "once" | "off" | "kill" | "pid"> } = {}
): () => void {
  const proc = options.proc ?? process;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  const remove = (): void => { for (const [signal, handler] of handlers) proc.off(signal, handler); handlers.clear(); };
  for (const signal of signals) {
    const handler = (): void => {
      remove();
      void sink.drain(timeoutMs).catch(() => ({ remaining: -1 })).finally(() => {
        sink.close();
        proc.kill(proc.pid, signal); // standard avslutning (uendret exit-status) nå som køen er forsøkt skrevet
      });
    };
    handlers.set(signal, handler);
    proc.once(signal, handler);
  }
  return remove;
}

// ------------------------------------------------------------------------------------------------------------------------------ oppbevaring

export interface PolicyDecisionRetentionResult {
  deleted: number;
  batches: number;
  /** true hvis `maxBatches` ble nådd mens det fortsatt var mer å slette (fortsetter neste kjøring). */
  capped: boolean;
}

/** Daglig sveip (api-prosessen): `prune_policy_decisions()` i begrensede batcher. Databasefunksjonen klemmer dager til minst 30 og batch til 100..50000. */
export async function runPolicyDecisionRetentionSweep(
  pool: pg.Pool,
  opts: { days?: number; batch?: number; maxBatches?: number } = {}
): Promise<PolicyDecisionRetentionResult> {
  const batch = opts.batch ?? 5_000;
  const maxBatches = Math.max(1, opts.maxBatches ?? 20);
  let deleted = 0;
  let batches = 0;
  let more = false;
  while (batches < maxBatches) {
    const { rows } = await pool.query("SELECT prune_policy_decisions($1, $2)::int AS deleted", [opts.days ?? 90, batch]);
    batches += 1;
    const n = (rows[0] as { deleted: number }).deleted;
    deleted += n;
    more = n >= Math.min(Math.max(batch, 100), 50_000);
    if (!more) break;
  }
  return { deleted, batches, capped: more && batches >= maxBatches };
}
