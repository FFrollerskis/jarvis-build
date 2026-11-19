import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { adoptCallSignal } from "../call-signal.ts";
import { afterAcceptedMutation } from "../after-accepted-mutation.ts";
import { OUTCOME_UNKNOWN_PREFIX, isOutcomeUnknownMessage, type ToolDefinition, type ToolInvocationContext, type ToolTransport } from "../gateway.ts";
import { PERSONAL_CONFIG_NAMES, boundedInt } from "./flags.ts";
import { CarAdapterError, normalizeCarState, type CarAdapter, type CarCommand, type CarState } from "./car-adapter.ts";
import { buildCriticalToolDefinitions, settleUntil, type CriticalAuthorization, type CriticalOpSpec, type Params } from "./critical-ops.ts";

/**
 * WP-G2 P1b (D-464, UA-8): KRITISKE BILHANDLINGER bak `CarAdapter` (leverandørnøytral; INGEN leverandør er valgt, D-64). Samme klasse D-kjede som hjemmehandlingene (`critical-ops.ts`): mål-allowlist (eierens EGNE kjøretøy-alias),
 * step-up, fersk tilstandslesing + målvalidering, ledger, kommando, VENT på sluttilstand, readback av den FAKTISK resulterende tilstanden og umiddelbart varsel. Lås opp = klasse D; også lås, klima og lading er D (en kjede, strengeste standard).
 * Etterbetingelsene krever `fresh: true` (leverandøren sier at tilstanden er levende): en bufret «låst» kan aldri verifisere en kommando. Biler er trege (vekking, kø hos leverandøren): standard ventetid er 60 s, og feil sluttilstand eller
 * uavklart svar vises som MISMATCH/UKJENT umiddelbart - aldri en antatt suksess.
 * D-41-revisjon og `DEFERRED` står i runbooken (§3): posisjon/GPS (lokasjonsdata, egen DPIA-kategori), dører/bagasjerom/vinduer, vekking, ladegrense/-tidsplan, sentralt aggregat-API (D-64-port), leverandørvalg.
 * Verktøy-id `car` er et eier-eksklusivt navnerom og står på ingen modellflate (manifest: effekt `control`, `surfaces: []`).
 */
export const CAR_TOOL_ID = "car";
export const CAR_CREDENTIAL_REF = "JARVIS_PERSONAL_CAR_CREDENTIAL";
export const CAR_READ_ACTION = "read_vehicle_state";
const VEHICLE_ID = /^[a-z0-9][a-z0-9_-]{1,40}$/;
export interface CarCriticalConfig {
  /** Eierens EGNE kjøretøy-alias (eksakt match). Tom = ingen mutasjon er tillatt. */
  readonly targets: ReadonlySet<string>;
  readonly settleMs: number;
  readonly pollMs: number;
}

/** Parser `JARVIS_PERSONAL_CAR_TARGETS` (kommaseparert alias). Ugyldige oppføringer (stor bokstav, jokertegn, for kort/lang, VIN-lignende 17 tegn med blanding er likevel gyldig form - se runbook: bruk et alias, aldri VIN) hoppes over. */
export function parseCarTargets(raw: string | undefined | null): ReadonlySet<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (VEHICLE_ID.test(id)) out.add(id);
  }
  return out;
}

export function carCriticalConfigFromEnv(env: Readonly<Record<string, string | undefined>>): CarCriticalConfig {
  const settleMs = boundedInt(env[PERSONAL_CONFIG_NAMES.carSettleMs], 5_000, 300_000, 60_000);
  return { targets: parseCarTargets(env[PERSONAL_CONFIG_NAMES.carTargets]), settleMs, pollMs: Math.max(1_000, Math.min(5_000, Math.floor(settleMs / 20))) };
}

export function authorizeCarTarget(targetParam: string, parameters: Params, config: Pick<CarCriticalConfig, "targets">): CriticalAuthorization {
  const raw = parameters[targetParam];
  if (typeof raw !== "string" || !VEHICLE_ID.test(raw)) return { allowed: false, reason: "missing_or_invalid_target" };
  return config.targets.has(raw) ? { allowed: true, reason: "owner_configured_target" } : { allowed: false, reason: "car_target_not_authorized" };
}

const vehicle = z.string().regex(VEHICLE_ID);
const expectedLock = z.enum(["locked", "unlocked"]).optional();

/** Før-tilstanden må være LEVENDE (`fresh` - normaliseringen har allerede sjekket alderen mot klokken, så validatoren er ren). */
function baseValidation(before: Params): string | null {
  return before["fresh"] === true ? null : "vehicle_state_not_fresh";
}

const word = (state: Params | null, key: string): string => (state === null ? "ukjent" : String(state[key] ?? "ukjent"));
const target = (p: Params): string => String(p["vehicle_id"] ?? "");
const BACK = "send motsatt kommando via samme handling (ny idempotensnøkkel) og bekreft readback; før-tilstanden står i journalen og i varselet";

export const CAR_CRITICAL_OPS: readonly CriticalOpSpec[] = [
  {
    action: "lock", label: "bil-lås", description: "Lås bilen (KRITISK, klasse D): kun eierens egne kjøretøy-alias, step-up, fersk tilstand FØR, venter på at leverandøren viser «locked» (levende, ikke bufret), readback og umiddelbart varsel",
    shape: { vehicle_id: vehicle, expected_lock: expectedLock }, targetParam: "vehicle_id", direction: () => "reduces",
    validate: (before, p) => baseValidation(before) ?? (before["lock"] === "unknown" ? "vehicle_lock_unknown" : typeof p["expected_lock"] === "string" && before["lock"] !== p["expected_lock"] ? "precondition_changed" : null),
    post: (after) => after["fresh"] === true && after["lock"] === "locked",
    summary: (state, p) => `bil ${target(p)}: lås ${word(state, "lock")} -> locked (ønsket)`, rollback: `lås opp igjen vil kreve en egen, ny bekreftelse (unlock): ${BACK}`, idempotentExternal: true, scopes: ["car:lock"]
  },
  {
    action: "unlock", label: "bil-lås opp", description: "Lås opp bilen (KRITISK, klasse D): kun eierens egne kjøretøy-alias, step-up, fersk tilstand FØR, venter på «unlocked» (levende), readback og umiddelbart varsel",
    shape: { vehicle_id: vehicle, expected_lock: expectedLock }, targetParam: "vehicle_id", direction: () => "increases",
    validate: (before, p) => baseValidation(before) ?? (before["lock"] === "unknown" ? "vehicle_lock_unknown" : typeof p["expected_lock"] === "string" && before["lock"] !== p["expected_lock"] ? "precondition_changed" : null),
    post: (after) => after["fresh"] === true && after["lock"] === "unlocked",
    summary: (state, p) => `bil ${target(p)}: lås ${word(state, "lock")} -> unlocked (ønsket)`, rollback: `lås bilen igjen (lock): ${BACK}`, idempotentExternal: true, scopes: ["car:unlock"]
  },
  {
    action: "climate_set", label: "bil-klima", description: "Start eller stopp klimaforvarming (KRITISK, klasse D): kun eierens egne kjøretøy-alias, step-up, fersk tilstand FØR, venter på «on»/«off» (levende), readback og umiddelbart varsel. Start i lukket garasje er en fysisk risiko for forbrenningsbiler - eierens ansvar",
    shape: { vehicle_id: vehicle, on: z.boolean(), expected_climate: z.enum(["on", "off"]).optional() }, targetParam: "vehicle_id", direction: (p) => (p["on"] === true ? "increases" : "reduces"),
    validate: (before, p) => baseValidation(before) ?? (before["climate"] === "unknown" ? "vehicle_climate_unknown" : typeof p["expected_climate"] === "string" && before["climate"] !== p["expected_climate"] ? "precondition_changed" : null),
    post: (after, p) => after["fresh"] === true && after["climate"] === (p["on"] === true ? "on" : "off"),
    summary: (state, p) => `bil ${target(p)}: klima ${word(state, "climate")} -> ${p["on"] === true ? "on" : "off"} (ønsket)`, rollback: `sett motsatt klimatilstand: ${BACK}`, idempotentExternal: true, scopes: ["car:climate"]
  },
  {
    action: "charge_set", label: "bil-lading", description: "Start eller stopp lading (KRITISK, klasse D): kun eierens egne kjøretøy-alias, step-up, fersk tilstand FØR (må være tilkoblet), venter på «charging»/«stopped» (levende), readback og umiddelbart varsel",
    shape: { vehicle_id: vehicle, charging: z.boolean() }, targetParam: "vehicle_id", direction: () => "neutral",
    validate: (before, p) => {
      const base = baseValidation(before);
      if (base !== null) return base;
      if (before["charging"] === "unknown") return "vehicle_charge_unknown";
      if (before["charging"] === "disconnected") return "vehicle_not_plugged_in";
      return p["charging"] === true && before["charging"] === "complete" ? "charge_complete" : null;
    },
    post: (after, p) => after["fresh"] === true && after["charging"] === (p["charging"] === true ? "charging" : "stopped"),
    summary: (state, p) => `bil ${target(p)}: lading ${word(state, "charging")} -> ${p["charging"] === true ? "charging" : "stopped"} (ønsket)`, rollback: `sett motsatt ladetilstand: ${BACK}`, idempotentExternal: true, scopes: ["car:charge"]
  }
];

export const CAR_CRITICAL_ACTIONS: readonly string[] = CAR_CRITICAL_OPS.map((o) => o.action);

/** Kommandoen en handling tilsvarer (ren funksjon). */
export function carCommandFor(action: string, p: Params): CarCommand | null {
  switch (action) {
    case "lock": return { kind: "lock" };
    case "unlock": return { kind: "unlock" };
    case "climate_set": return { kind: p["on"] === true ? "climate_start" : "climate_stop" };
    case "charge_set": return { kind: p["charging"] === true ? "charge_start" : "charge_stop" };
    default: return null;
  }
}

/** Gatewayens frist per handling: ventetiden på sluttilstand + rom for lesing, kommando og siste lesing hos en treg leverandør. */
export function carCriticalTimeoutMs(_op: CriticalOpSpec, config: Pick<CarCriticalConfig, "settleMs">): number {
  return config.settleMs + 40_000;
}

export function carCriticalToolDefinitions(transport: ToolTransport, config: CarCriticalConfig): ToolDefinition[] {
  return buildCriticalToolDefinitions({
    toolId: CAR_TOOL_ID, credentialRef: CAR_CREDENTIAL_REF, transport,
    read: { action: CAR_READ_ACTION, targetParam: "vehicle_id", shape: { vehicle_id: vehicle }, description: "Les NØYAKTIG ett kjøretøys normaliserte tilstand (lås, klima, lading, om tilstanden er levende) - kun eierens egne kjøretøy-alias, kun eieren. Ingen posisjon, VIN eller fritekst. Brukes som preflight og readback." },
    ops: CAR_CRITICAL_OPS, authorize: (targetParam, p) => authorizeCarTarget(targetParam, p, config), timeoutMs: (op) => carCriticalTimeoutMs(op, config), freezeConnectorIds: [CAR_TOOL_ID]
  });
}

export interface CarTransportDeps {
  adapter: CarAdapter;
  settleMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Veggklokke (ms siden epoch) for alderssjekken av leverandørens tidsstempel. Injiseres i tester. */
  wallClock?: () => number;
}

const OPS = new Map(CAR_CRITICAL_OPS.map((op) => [op.action, op] as const));

/** Gjør en adapterfeil om til en trygg feilkode: `outcomeKnown` = vanlig feil (retry tillatt), ellers `outcome_unknown:<kode>` (aldri retry-bar). Feilteksten fra leverandøren brukes aldri. */
function commandFailure(err: unknown): Error {
  if (err instanceof CarAdapterError) return new Error(err.outcomeKnown ? err.code : `${OUTCOME_UNKNOWN_PREFIX}:${err.code}`);
  return new Error(`${OUTCOME_UNKNOWN_PREFIX}:car_command_failed`);
}

export class CarTransport implements ToolTransport {
  constructor(private readonly deps: CarTransportDeps) {}

  async invoke(action: string, parameters: Params, _credential: string, _context?: ToolInvocationContext, signal?: AbortSignal): Promise<{ external_id?: string; data?: JsonValue }> {
    return adoptCallSignal(signal, () => this.dispatch(action, parameters, signal));
  }

  private async read(vehicleId: string, signal?: AbortSignal | undefined): Promise<Params | null> {
    let raw: Awaited<ReturnType<CarAdapter["readState"]>>;
    try {
      raw = await this.deps.adapter.readState(vehicleId, { signal });
    } catch (err) {
      // En lesing har ingen bivirkning: kun en fast kode (aldri leverandørens tekst). Gatewayens eget tidsavbrudd/avbrudd (`tool_timeout`) går uendret videre (klassifiseringen «utfall ukjent» avhenger av det).
      if (err instanceof Error && isOutcomeUnknownMessage(err.message)) throw err;
      throw new Error(err instanceof CarAdapterError ? err.code : "car_read_failed");
    }
    const state: CarState | null = normalizeCarState(vehicleId, raw as Partial<Record<keyof CarState, unknown>> | null, (this.deps.wallClock ?? Date.now)());
    return state === null ? null : { ...state };
  }

  private async dispatch(action: string, p: Params, signal?: AbortSignal | undefined): Promise<{ external_id?: string; data?: JsonValue }> {
    const vehicleId = p["vehicle_id"];
    if (typeof vehicleId !== "string" || !VEHICLE_ID.test(vehicleId)) throw new Error("car_invalid_vehicle_id");
    if (action === CAR_READ_ACTION) return { data: await this.read(vehicleId, signal) };
    const op = OPS.get(action);
    const command = carCommandFor(action, p);
    if (!op || command === null) throw new Error(`car_unsupported_action:${action.slice(0, 40).replace(/[^A-Za-z0-9_]/g, "_")}`);

    const before = await this.read(vehicleId, signal);
    if (before === null) throw new Error("car_target_not_found");
    const invalid = op.validate(before, p);
    if (invalid !== null) throw new Error(`car_precondition_failed:${invalid}`);

    let commandRef: string | undefined;
    try {
      const accepted = await this.deps.adapter.command(vehicleId, command, { idempotencyKey: randomUUID(), signal });
      if (!accepted.accepted) throw new CarAdapterError("car_rejected", true);
      commandRef = typeof accepted.command_ref === "string" ? accepted.command_ref.slice(0, 120).replace(/[^A-Za-z0-9_.:-]/g, "_") : undefined;
    } catch (err) {
      throw commandFailure(err);
    }

    // ETTER akseptert kommando: enhver feil herfra er «utfall ukjent», aldri en vanlig, retry-bar feil.
    const settled = await afterAcceptedMutation("car_readback_failed", () => settleUntil({
      read: () => this.read(vehicleId, signal), isSettled: () => false, matches: (state) => op.post(state, p), deadlineMs: this.deps.settleMs, pollMs: this.deps.pollMs,
      ...(this.deps.now ? { now: this.deps.now } : {}), ...(this.deps.sleep ? { sleep: this.deps.sleep } : {})
    }));
    return { external_id: commandRef ?? `car.${command.kind}:${vehicleId}`, data: { settled: settled.settled, matched: settled.matched, polls: settled.polls, state: settled.state } };
  }
}
