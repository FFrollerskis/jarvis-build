import type pg from "pg";
import { listTenantMemorySpaces } from "@jarvis/core";
import type { MemorySpace } from "@jarvis/contracts";
import type { VisionCamera, VisionCameraService } from "./cameras.ts";
import type { PollSummary, VisionIngestPipeline } from "./pipeline.ts";
import type { VisionSource } from "./source.ts";

/**
 * WP-G3 (D-465), P1a: bakgrunnspolleren - EN runde = les utløserne til alle PÅSLÅTTE kameraer av kildens type, i alle tenantens spaces, og la pipelinen behandle dem (policy -> idempotens ->
 * ETT bilde -> lokal klassifisering -> én transaksjon).
 *
 * KUN de oppgitte tenantene polles (`tenantIds`): kilden (HA) og dens credential tilhører EIEREN, så en annen tenants kamera-rader polles aldri med eierens HA-token (ingen kryss-tenant-lesing via en delt credential).
 *
 * Eier-kontrollene (kill switch, frosset connector, tilbakekalt credential) er en INNSATT port (`guard`): `blocked()` gir `null` (kjør) eller en kort årsakskode. Porten sjekkes FØR første lesing OG før
 * hvert space, og en kastet feil fra den tolkes som «stanset» (fail-closed) - polleren gjør aldri noe i et system eieren har stanset. Én tenant/space som feiler velter aldri resten (samme
 * isolasjon som sveipene), men telles og logges med kode (aldri innhold).
 *
 * Samtidighet: aldri to runder samtidig i denne prosessen (en treg HA skal ikke stable runder); pipelinens egen lås + cooldown dekker resten. `tick()` kaster aldri.
 */
export interface VisionPollerGuard {
  blocked(): Promise<string | null>;
}

export interface VisionPollerDeps {
  pool: pg.Pool;
  cameras: Pick<VisionCameraService, "listEnabledForPolling">;
  pipeline: Pick<VisionIngestPipeline, "pollSource">;
  source: VisionSource;
  guard: VisionPollerGuard;
  /** Tenantene kildens credential gjelder for (i drift: kun eierens tenant). Tom liste = ingenting polles. */
  tenantIds: readonly string[];
}

export type VisionPollTickResult =
  | { status: "blocked"; reason: string }
  | { status: "ok"; spaces_polled: number; cameras_polled: number; failed_spaces: number; summary: PollSummary };

const EMPTY: PollSummary = { events_seen: 0, recorded: 0, duplicates: 0, discarded: 0, cooldown: 0, failed: 0 };

function merge(into: PollSummary, add: PollSummary): void {
  into.events_seen += add.events_seen;
  into.recorded += add.recorded;
  into.duplicates += add.duplicates;
  into.discarded += add.discarded;
  into.cooldown += add.cooldown;
  into.failed += add.failed;
  if (add.source_error !== undefined && into.source_error === undefined) into.source_error = add.source_error;
  // Review delta2 A LOW-E3 + B LOW-E1: hoppede inventarskrivinger summeres på tvers av spaces/personer (kun til stede når > 0).
  if (add.inventory_label_invalid !== undefined) into.inventory_label_invalid = (into.inventory_label_invalid ?? 0) + add.inventory_label_invalid;
  if (add.inventory_label_rejected !== undefined) into.inventory_label_rejected = (into.inventory_label_rejected ?? 0) + add.inventory_label_rejected;
}

function codeOf(err: unknown): string {
  const message = (err as Error | null)?.message;
  const pgCode = (err as { code?: unknown } | null)?.code;
  // SQLSTATE har 5 tegn og minst ett siffer (`42P01`, `XX000`); et Node-feilnummer (`EPERM`, `EPIPE`) har ikke siffer og er et fil-/nettverksavvik, ikke en databasefeil (samme regel som `errorCode` i pipeline.ts, review delta2 A INFO-E7a).
  if (typeof pgCode === "string" && /^(?=[0-9A-Z]*[0-9])[0-9A-Z]{5}$/.test(pgCode)) return `db_${pgCode.toLowerCase()}`;
  if (typeof pgCode === "string" && /^E[A-Z0-9]{2,15}$/.test(pgCode)) return `os_${pgCode.toLowerCase()}`;
  return typeof message === "string" && /^[a-z0-9_]{3,60}$/.test(message) ? message : "poller_error";
}

export class VisionPoller {
  private running = false;

  constructor(private readonly deps: VisionPollerDeps) {
    if (deps.source.source_type !== "home_assistant" && deps.source.source_type !== "iphone") throw new Error("vision_poller_unsupported_source");
  }

  private async blockedReason(): Promise<string | null> {
    try {
      return await this.deps.guard.blocked();
    } catch {
      return "guard_error"; // fail-closed: kan ikke avgjøre -> stanset
    }
  }

  async tick(): Promise<VisionPollTickResult> {
    if (this.running) return { status: "blocked", reason: "tick_in_progress" };
    this.running = true;
    try {
      const first = await this.blockedReason();
      if (first !== null) return { status: "blocked", reason: first };
      const summary: PollSummary = { ...EMPTY };
      let spacesPolled = 0;
      let camerasPolled = 0;
      let failedSpaces = 0;
      const tenantIds = [...new Set(this.deps.tenantIds)];
      const sourceType = this.deps.source.source_type as "home_assistant" | "iphone";
      for (const tenantId of tenantIds) {
        let spaces: string[];
        try {
          spaces = await listTenantMemorySpaces(this.deps.pool, tenantId);
        } catch (err) {
          failedSpaces += 1;
          console.error(JSON.stringify({ msg: "vision_poll_spaces_failed", tenant_id: tenantId, code: codeOf(err) }));
          continue;
        }
        for (const spaceName of spaces) {
          const space = spaceName as MemorySpace;
          const stop = await this.blockedReason();
          if (stop !== null) return { status: "blocked", reason: stop };
          try {
            const cameras = await this.deps.cameras.listEnabledForPolling(tenantId, space, sourceType);
            if (cameras.length === 0) continue;
            spacesPolled += 1;
            camerasPolled += cameras.length;
            const byPerson = new Map<string, VisionCamera[]>();
            for (const camera of cameras) byPerson.set(camera.person_id, [...(byPerson.get(camera.person_id) ?? []), camera]);
            for (const [personId, group] of byPerson) {
              merge(summary, await this.deps.pipeline.pollSource({ tenant_id: tenantId, memory_space: space, person_id: personId, task_id: `vision-poll:${sourceType}`, session_id: "vision-poller" }, this.deps.source, group));
            }
          } catch (err) {
            failedSpaces += 1;
            console.error(JSON.stringify({ msg: "vision_poll_space_failed", tenant_id: tenantId, memory_space_id: spaceName, code: codeOf(err) }));
          }
        }
      }
      return { status: "ok", spaces_polled: spacesPolled, cameras_polled: camerasPolled, failed_spaces: failedSpaces, summary };
    } finally {
      this.running = false;
    }
  }
}

export interface VisionPollerHandle {
  tick(): Promise<VisionPollTickResult>;
  /** Siste rundes utfall (kort kode/tall, aldri innhold). */
  status(): { last_tick_at: string | null; last_status: string | null; last_reason: string | null; last_source_error: string | null };
  /**
   * Review B-L8: feilserie og neste ventetid. `consecutive_failures` teller runder på rad med kildefeil (HA nede/feil token) eller feilede spaces; en stanset runde (kill switch, frosset connector) og en vellykket runde
   * nullstiller den. `next_delay_ms` er ventetiden før neste runde: grunnintervallet, doblet per feil på rad opp til taket (`max_delay_ms`).
   */
  health(): { consecutive_failures: number; next_delay_ms: number; base_interval_ms: number; max_delay_ms: number };
  stop(): void;
}

/** Øvre grense for ventetiden mellom runder under en feilserie (review B-L8). */
export const POLLER_MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Starter periodiske runder (aldri overlappende; `unref` så den ikke holder prosessen i live). `intervalMs` klemmes til minst 5 s. Første runde etter ett intervall (aldri i oppstartsstien).
 * Review B-L8: en feilserie (kildefeil/feilede spaces) gir EKSPONENTIELL backoff (intervall x 2^feil, tak 5 min) i stedet for en fast rytme mot en kilde som er nede (med HA «black-holet» kan en runde ta 8 s per sensor);
 * første vellykkede runde (eller en eier-stans) tilbake til grunnintervallet. Runder planlegges ETTER at forrige er ferdig (setTimeout-kjede), så de overlapper aldri.
 */
export function startVisionPoller(poller: VisionPoller, intervalMs: number, now: () => Date = () => new Date(), options: { maxBackoffMs?: number } = {}): VisionPollerHandle {
  const base = Math.max(5_000, intervalMs);
  const cap = Math.max(base, options.maxBackoffMs ?? POLLER_MAX_BACKOFF_MS);
  const state = { last_tick_at: null as string | null, last_status: null as string | null, last_reason: null as string | null, last_source_error: null as string | null };
  let failures = 0;
  let nextDelay = base;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const delayAfter = (n: number): number => Math.min(cap, base * 2 ** Math.min(n, 12));
  const record = (failed: boolean): void => {
    failures = failed ? failures + 1 : 0;
    nextDelay = delayAfter(failures);
  };
  const run = async (): Promise<VisionPollTickResult> => {
    const result = await poller.tick();
    // En overlappende runde (manuelt `tick()` mens en runde pågår) er ingen ny måling: status og feilserie står som de var.
    if (result.status === "blocked" && result.reason === "tick_in_progress") return result;
    state.last_tick_at = now().toISOString();
    state.last_status = result.status;
    state.last_reason = result.status === "blocked" ? result.reason : null;
    state.last_source_error = result.status === "ok" ? (result.summary.source_error ?? null) : null;
    // En eier-stans (kill switch, frosset connector) er ingen feil og nullstiller serien; kildefeil og feilede spaces teller.
    record(result.status === "ok" && (result.summary.source_error !== undefined || result.failed_spaces > 0));
    return result;
  };
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void run()
        .catch(() => record(true))
        .finally(schedule);
    }, nextDelay);
    timer.unref();
  };
  schedule();
  return {
    tick: run,
    status: () => ({ ...state }),
    health: () => ({ consecutive_failures: failures, next_delay_ms: nextDelay, base_interval_ms: base, max_delay_ms: cap }),
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
