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
}

function codeOf(err: unknown): string {
  const message = (err as Error | null)?.message;
  const pgCode = (err as { code?: unknown } | null)?.code;
  if (typeof pgCode === "string" && /^[0-9A-Z]{5}$/.test(pgCode)) return `db_${pgCode.toLowerCase()}`;
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
  stop(): void;
}

/** Starter en periodisk runde (aldri overlappende; `unref` så den ikke holder prosessen i live). `intervalMs` klemmes til minst 5 s. Første runde etter ett intervall (aldri i oppstartsstien). */
export function startVisionPoller(poller: VisionPoller, intervalMs: number, now: () => Date = () => new Date()): VisionPollerHandle {
  const state = { last_tick_at: null as string | null, last_status: null as string | null, last_reason: null as string | null, last_source_error: null as string | null };
  const run = async (): Promise<VisionPollTickResult> => {
    const result = await poller.tick();
    state.last_tick_at = now().toISOString();
    state.last_status = result.status;
    state.last_reason = result.status === "blocked" ? result.reason : null;
    state.last_source_error = result.status === "ok" ? (result.summary.source_error ?? null) : null;
    return result;
  };
  const timer = setInterval(() => void run().catch(() => undefined), Math.max(5_000, intervalMs));
  timer.unref();
  return { tick: run, status: () => ({ ...state }), stop: () => clearInterval(timer) };
}
