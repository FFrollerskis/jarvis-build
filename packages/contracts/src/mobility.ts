import { z } from "zod";
import type { CapabilityClass, JsonValue } from "./capability.ts";

/**
 * Masterplan-ordre: "Lag provider-nøytral capability/adapter contract dersom
 * dette er nødvendig for UA-8-arkitekturen. Ikke velg bilprovider uten
 * konkret providerbeslutning." Denne filen er PRESIST det - en typet
 * kontrakt, INGEN leverandørvalg (D-64: en bil-integrasjon skal normalt være
 * `EXTERNAL_CANONICAL` - Jarvis eier ikke bilens fysiske tilstand, kun den
 * normaliserte pekeren til den - men SELVE valget av leverandør er en egen,
 * fremtidig Core-vs-Adapter-beslutning (D-64) som IKKE tas her).
 *
 * INGEN reell leverandørimplementasjon her (ingen Tesla-API, ingen generisk
 * OBD-integrasjon) - kun kontrakten, pluss en triviell fake til fremtidig
 * testbruk (samme mønster som `FakePushAdapter` i
 * `modules/core/src/services/device-service.ts`). IKKE koblet inn i
 * `ToolGateway`/verktøyregister/`main.ts` - bevisst stående alene inntil en
 * konkret providerbeslutning foreligger.
 *
 * Risikoformen er strukturelt IDENTISK med Home Assistant
 * (`modules/tool-gateway/src/home-assistant.ts`): en bil er, som et hus,
 * fysisk utstyr en ekstern part fjernstyrer på Jarvis' vegne. Lesing er
 * ufarlig (klasse A). En reversibel, ikke-kritisk fjernhandling (forvarming)
 * er klasse B. `lock_set` er, nøyaktig som HA sin `lock_set`, klasse D:
 * kritisk, MÅ ha `preflight_action` (les nå-tilstand FØR) og readback (les
 * nå-tilstand ETTER) i samme generiske `ToolGateway.execute()`-pipeline den
 * dagen en ekte `ToolDefinition` for dette bygges - se `capability.ts`/
 * `home-assistant.ts` for det eksakte mønsteret denne kontrakten arver.
 */

/**
 * Den LILLE, ærlige mengden ting en bilintegrasjon plausibelt kan gjøre.
 * Bevisst IKKE en større ontologi - det finnes ingen leverandør å validere
 * en større modell mot ennå (masterplan: ikke overmodeller uten provider).
 */
export const MobilityCapabilitySchema = z.enum([
  "lock_status",
  "lock_set",
  "location",
  "fuel_or_charge_level",
  "climate_preconditioning"
]);
export type MobilityCapability = z.infer<typeof MobilityCapabilitySchema>;

/**
 * Tiltenkt risikoklasse per capability (SECURITY_MODEL §3-formen, samme
 * klassifisering som `homeAssistantTools()` bruker for sine handlinger). Kun
 * en DEKLARASJON av hvor streng handlingen MÅ behandles den dagen en ekte
 * `ToolDefinition` bygges - denne filen definerer ingen `ToolDefinition` selv.
 */
export const MOBILITY_CAPABILITY_CLASS: Readonly<Record<MobilityCapability, CapabilityClass>> = {
  lock_status: "A",
  location: "A",
  fuel_or_charge_level: "A",
  climate_preconditioning: "B",
  lock_set: "D"
};

/** Resultatformen fra en enkelt adapter-handling - samme skjelett som `ToolTransport.invoke()`. */
export interface MobilityCommandResult {
  readonly external_id?: string;
  readonly data?: JsonValue;
}

/**
 * Provider-nøytral kjøretøy-adapter. Strukturelt speilbilde av
 * `ToolTransport`/`HomeAdapter`-mønsteret: én lesende metode (klasse A,
 * dobler som PREFLIGHT/READBACK for kritiske handlinger) og én mutasjons-
 * metode (klasse B-D, avhengig av `capability`). INGEN metode her utfører
 * selve preflight/readback-DISIPLINEN - det er `ToolGateway.execute()` sin
 * jobb (se `preflight_action` på `ToolDefinition`) den dagen denne kobles inn;
 * adapteren skal bare kunne SVARE ærlig på "hva er tilstanden nå".
 */
export interface MobilityAdapter {
  readonly name: string;
  /** Hvilke av de fem capabilities denne konkrete adapteren faktisk støtter (D-41: ærlig, aldri overdrevet). */
  readonly capabilities: readonly MobilityCapability[];
  /** Les nå-tilstand for én capability på ett kjøretøy. Alltid klasse A-oppførsel, uansett hvilken capability som leses. */
  readState(vehicleId: string, capability: MobilityCapability): Promise<MobilityCommandResult>;
  /**
   * Utfør en mutasjon (f.eks. `lock_set` eller `climate_preconditioning`).
   * `capability` MÅ finnes i `capabilities`. For `lock_set` forventes kalleren
   * (fremtidig `ToolDefinition`) å lese `readState()` FØR og ETTER - se
   * dokkommentaren over.
   */
  executeCommand(
    vehicleId: string,
    capability: MobilityCapability,
    parameters: Record<string, JsonValue>
  ): Promise<MobilityCommandResult>;
}

/**
 * Triviell in-memory fake til fremtidig testbruk - samme mønster som
 * `FakePushAdapter`. INGEN leverandørlogikk; kun et kontrollert stand-in som
 * lar fremtidige tester bevise pipeline-disiplin (preflight/readback) uten en
 * ekte billeverandør.
 */
export class FakeMobilityAdapter implements MobilityAdapter {
  readonly name = "fake-mobility";
  readonly capabilities: readonly MobilityCapability[] = [
    "lock_status",
    "lock_set",
    "location",
    "fuel_or_charge_level",
    "climate_preconditioning"
  ];
  private readonly state = new Map<string, Partial<Record<MobilityCapability, JsonValue>>>();
  readonly calls: Array<{ vehicleId: string; capability: MobilityCapability; kind: "read" | "command" }> = [];

  /** Testoppsett: sett kjent starttilstand for en capability på et kjøretøy. */
  seed(vehicleId: string, capability: MobilityCapability, value: JsonValue): void {
    const forVehicle = this.state.get(vehicleId) ?? {};
    forVehicle[capability] = value;
    this.state.set(vehicleId, forVehicle);
  }

  async readState(vehicleId: string, capability: MobilityCapability): Promise<MobilityCommandResult> {
    this.calls.push({ vehicleId, capability, kind: "read" });
    const value = this.state.get(vehicleId)?.[capability] ?? null;
    return { data: value };
  }

  async executeCommand(
    vehicleId: string,
    capability: MobilityCapability,
    parameters: Record<string, JsonValue>
  ): Promise<MobilityCommandResult> {
    this.calls.push({ vehicleId, capability, kind: "command" });
    const forVehicle = this.state.get(vehicleId) ?? {};
    // Enkel testsemantikk: for lock_set/climate_preconditioning styres tilstanden av det relevante feltet i parameters.
    if (capability === "lock_set" && typeof parameters["locked"] === "boolean") {
      forVehicle.lock_status = parameters["locked"];
    }
    if (capability === "climate_preconditioning" && typeof parameters["on"] === "boolean") {
      forVehicle.climate_preconditioning = parameters["on"];
    }
    this.state.set(vehicleId, forVehicle);
    return { external_id: `fake-mobility-${vehicleId}-${capability}` };
  }
}
