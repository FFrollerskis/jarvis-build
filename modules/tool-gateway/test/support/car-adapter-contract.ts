import { describe, expect, it } from "vitest";
import { CarAdapterError, type CarAdapter, type CarState } from "../../src/personal/car-adapter.ts";

/**
 * WP-G2 P1b: KONTRAKTSTESTEN en fremtidig ekte `CarAdapter` må bestå (mot leverandørens SANDBOX - aldri mot eierens produksjonsbil, blast radius). Den sjekker ikke hva leverandøren kan, men at adapteren oppfører seg
 * etter Jarvis' kontrakt: normalisert tilstand uten ekstra felt (aldri posisjon/VIN/fritekst), ukjent kjøretøy er `null`, feil er `CarAdapterError` med `outcomeKnown`, `command()` gir en akseptert/avvist-markør, og tilstanden
 * kan leses på nytt etter kommandoen. Kjøres i dag mot den falske adapteren (bevis for at kittet selv er riktig) og er klar til å brukes mot en ekte adapter når leverandørvalget er tatt (D-64).
 */
export interface CarContractFixture {
  adapter: CarAdapter;
  /** Et kjøretøy-alias som finnes (og er trygt å styre) i test-/sandbox-oppsettet. */
  knownVehicle: string;
  /** Et alias som IKKE finnes. */
  unknownVehicle: string;
  /** Får adapteren til å feile neste kommando FØR den når leverandøren (entydig: ingen bivirkning). */
  failNextCommandBeforeSend(): void;
  /** Får adapteren til å feile neste kommando ETTER at den kan ha nådd leverandøren (ukjent utfall). */
  failNextCommandAfterSend(): void;
}

const STATE_KEYS = ["charge_percent", "charging", "climate", "fresh", "lock", "observed_at", "reachable", "vehicle_id"];

export function carAdapterContract(name: string, make: () => CarContractFixture): void {
  describe(`CarAdapter-kontrakt: ${name}`, () => {
    it("readState: normalisert tilstand med NØYAKTIG kontraktens felt (ingen posisjon/VIN/fritekst), ukjent kjøretøy gir null (aldri kast, aldri en gjettet tilstand)", async () => {
      const f = make();
      const state = (await f.adapter.readState(f.knownVehicle)) as CarState;
      expect(Object.keys(state).sort()).toEqual(STATE_KEYS);
      expect(state.vehicle_id).toBe(f.knownVehicle);
      expect(["locked", "unlocked", "unknown"]).toContain(state.lock);
      expect(["on", "off", "unknown"]).toContain(state.climate);
      expect(["charging", "stopped", "complete", "disconnected", "unknown"]).toContain(state.charging);
      expect(typeof state.fresh).toBe("boolean");
      expect(state.charge_percent === null || (state.charge_percent >= 0 && state.charge_percent <= 100)).toBe(true);
      expect(await f.adapter.readState(f.unknownVehicle)).toBeNull();
    });

    it("capabilities er ærlige (kun kjente kapabiliteter) og navnet er et stabilt ord", () => {
      const f = make();
      expect(f.adapter.name).toMatch(/^[a-z][a-z0-9-]{1,40}$/);
      for (const c of f.adapter.capabilities) expect(["lock_state", "lock_set", "climate_state", "climate_set", "charge_state", "charge_set"]).toContain(c);
    });

    it("command: en kjent bil gir `accepted` med en sikker referanse (ingen hemmelighet); en kommando mot ukjent bil kaster CarAdapterError (entydig, ingen bivirkning)", async () => {
      const f = make();
      const result = await f.adapter.command(f.knownVehicle, { kind: "lock" }, { idempotencyKey: "contract-key-1" });
      expect(result.accepted).toBe(true);
      if (result.command_ref !== undefined) expect(result.command_ref).toMatch(/^[A-Za-z0-9_.:-]{1,120}$/);
      const err = await f.adapter.command(f.unknownVehicle, { kind: "lock" }, { idempotencyKey: "contract-key-2" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CarAdapterError);
      expect((err as CarAdapterError).outcomeKnown).toBe(true);
    });

    it("feil: FØR sending = outcomeKnown true; ETTER sending = outcomeKnown false (adapteren vet det, gatewayen kan ikke gjette)", async () => {
      const f = make();
      f.failNextCommandBeforeSend();
      const before = await f.adapter.command(f.knownVehicle, { kind: "unlock" }, { idempotencyKey: "contract-key-3" }).catch((e: unknown) => e);
      expect(before).toBeInstanceOf(CarAdapterError);
      expect((before as CarAdapterError).outcomeKnown).toBe(true);
      f.failNextCommandAfterSend();
      const after = await f.adapter.command(f.knownVehicle, { kind: "unlock" }, { idempotencyKey: "contract-key-4" }).catch((e: unknown) => e);
      expect(after).toBeInstanceOf(CarAdapterError);
      expect((after as CarAdapterError).outcomeKnown).toBe(false);
    });

    it("etter en akseptert kommando kan tilstanden leses på nytt og er fortsatt normalisert (utførelsen bevises av readback, aldri av «akseptert»)", async () => {
      const f = make();
      await f.adapter.command(f.knownVehicle, { kind: "lock" }, { idempotencyKey: "contract-key-5" });
      let state = (await f.adapter.readState(f.knownVehicle)) as CarState;
      for (let i = 0; i < 5 && state.lock !== "locked"; i += 1) state = (await f.adapter.readState(f.knownVehicle)) as CarState;
      expect(Object.keys(state).sort()).toEqual(STATE_KEYS);
    });
  });
}
