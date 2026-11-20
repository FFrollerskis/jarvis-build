import { CAR_CAPABILITIES, CarAdapterError, type CarAdapter, type CarCallContext, type CarCapability, type CarCommand, type CarCommandContext, type CarCommandResult, type CarState } from "../../src/personal/car-adapter.ts";

/**
 * WP-G2 P1b: FALSK `CarAdapter` (test-dobbel, IKKE i produksjonsflaten - D-396-vakten). Modellerer en bil som svarer sakte: en kommando settes i kø og slår først inn etter `applyAfterReads` lesinger
 * (som en bil som vekkes). Brytere for å bevise hver sti: `mode` per kjøretøy (`ineffective` = akseptert men aldri utført, `stale` = leverandøren svarer med bufret tilstand, `jam` = utfører aldri låsing),
 * `nextCommandError` (entydig avvisning vs. ukjent utfall) og `nextReadError`. Ingen posisjon, VIN eller fritekst finnes i modellen (som kontrakten krever).
 */
export interface FakeVehicle {
  lock: "locked" | "unlocked" | "unknown";
  climate: "on" | "off" | "unknown";
  charging: "charging" | "stopped" | "complete" | "disconnected" | "unknown";
  charge_percent?: number | null;
  reachable?: boolean;
  mode?: "ok" | "ineffective" | "stale" | "stale_after_command" | "jam";
  /** Antall lesinger etter kommandoen før den slår inn (en bil som vekkes). */
  applyAfterReads?: number;
  /** Tidsstempel adapteren oppgir (ISO). Standard: nå. */
  observed_at?: string | null;
}

interface Pending { command: CarCommand; reads: number }

/** `stale_after_command`: tilstanden er fersk FØR kommandoen, men leverandøren svarer med en BUFRET tilstand (som viser ønsket verdi) etterpå - skal aldri kunne verifisere kommandoen. */

export class FakeCarAdapter implements CarAdapter {
  readonly name = "fake-car";
  readonly capabilities: readonly CarCapability[] = [...CAR_CAPABILITIES];
  readonly vehicles = new Map<string, FakeVehicle>();
  readonly calls: Array<{ kind: "read" | "command"; vehicleId: string; command?: CarCommand; idempotencyKey?: string }> = [];
  nextCommandError: Error | null = null;
  nextReadError: Error | null = null;
  /** Hvis satt, svarer `command()` `accepted: false` (entydig avvist). */
  rejectNextCommand = false;
  private readonly pending = new Map<string, Pending>();

  set(vehicleId: string, vehicle: FakeVehicle): void {
    this.vehicles.set(vehicleId, { reachable: true, mode: "ok", applyAfterReads: 0, ...vehicle });
    this.pending.delete(vehicleId);
  }

  reset(): void {
    this.vehicles.clear(); this.pending.clear(); this.commanded.clear(); this.calls.length = 0; this.nextCommandError = null; this.nextReadError = null; this.rejectNextCommand = false;
  }

  commandCalls(): Array<{ vehicleId: string; command?: CarCommand }> {
    return this.calls.filter((c) => c.kind === "command").map((c) => ({ vehicleId: c.vehicleId, ...(c.command ? { command: c.command } : {}) }));
  }

  private commanded = new Set<string>();

  private apply(vehicle: FakeVehicle, command: CarCommand): void {
    if (vehicle.mode === "ineffective") return;
    switch (command.kind) {
      case "lock": if (vehicle.mode !== "jam") vehicle.lock = "locked"; break;
      case "unlock": vehicle.lock = "unlocked"; break;
      case "climate_start": vehicle.climate = "on"; break;
      case "climate_stop": vehicle.climate = "off"; break;
      case "charge_start": vehicle.charging = "charging"; break;
      case "charge_stop": vehicle.charging = "stopped"; break;
    }
  }

  async readState(vehicleId: string, _context?: CarCallContext): Promise<CarState | null> {
    this.calls.push({ kind: "read", vehicleId });
    if (this.nextReadError) { const err = this.nextReadError; this.nextReadError = null; throw err; }
    const vehicle = this.vehicles.get(vehicleId);
    if (!vehicle) return null;
    const pending = this.pending.get(vehicleId);
    if (pending) {
      if (pending.reads > 0) pending.reads -= 1;
      else { this.apply(vehicle, pending.command); this.pending.delete(vehicleId); }
    }
    return {
      vehicle_id: vehicleId, reachable: vehicle.reachable !== false, lock: vehicle.lock, climate: vehicle.climate, charging: vehicle.charging, charge_percent: vehicle.charge_percent ?? null,
      fresh: vehicle.mode !== "stale" && !(vehicle.mode === "stale_after_command" && this.commanded.has(vehicleId)), observed_at: vehicle.observed_at === undefined ? new Date().toISOString() : vehicle.observed_at
    };
  }

  async command(vehicleId: string, command: CarCommand, context: CarCommandContext): Promise<CarCommandResult> {
    this.calls.push({ kind: "command", vehicleId, command, idempotencyKey: context.idempotencyKey });
    if (this.nextCommandError) { const err = this.nextCommandError; this.nextCommandError = null; throw err; }
    const vehicle = this.vehicles.get(vehicleId);
    if (!vehicle) throw new CarAdapterError("car_vehicle_unknown", true);
    if (this.rejectNextCommand) { this.rejectNextCommand = false; return { accepted: false }; }
    this.pending.set(vehicleId, { command, reads: vehicle.applyAfterReads ?? 0 });
    this.commanded.add(vehicleId);
    return { accepted: true, command_ref: `fake-cmd-${command.kind}` };
  }
}
