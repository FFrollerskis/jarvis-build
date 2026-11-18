import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { abortableSleep, throwIfAborted } from "../call-signal.ts";
import type { ToolDefinition, ToolTransport } from "../gateway.ts";

/**
 * WP-G2 (D-464, UA-8 Personal Digital Twin): ÉN deklarativ modell for kritiske FYSISKE handlinger (hjem og bil) - og ÉN fabrikk som gjør hver handling om til en `ToolDefinition` med HELE klasse D-kjeden.
 * Hjemme- og bilmodulen beskriver bare sine handlinger (`CriticalOpSpec`); kjeden er identisk og testes ÉN gang her (samme grep som `growth/src/write/tool-factory.ts`, WP-D3).
 *
 * KJEDEN per handling (CLAUDE.md regel 2/11, masterplan UA-8: «critical home/car actions ... current-state readback, target validation and post-action confirmation»):
 *   1. mål-autorisasjon FØR transporten (`parameterAuthorizer`: eierens EGNE entitets-/kjøretøy-id-er, eksakt match, tom liste = ingenting tillatt) - også for lesingen;
 *   2. step-up: enhetssignert eier-økt (`step_up_required`, strengeste standard, Q-55/D-468) - gatewayen håndhever det selv; ingen binding, skript eller modell lemper på det;
 *   3. fersk tilstandslesing av NØYAKTIG målet (`preflight_action`) + målvalidering (finnes målet? er det i en gyldig før-tilstand?) - ukjent mål er fail-closed (`preflight_requires_target`);
 *   4. idempotensnøkkel (klasse D: påkrevd) + ledger-reservasjon i gatewayen; samme nøkkel gir aldri en ny mutasjon;
 *   5. kommando (transporten leser på nytt, validerer med SAMME validator, sender, og VENTER på at utstyret når en sluttilstand - lås/port/ventil/alarm er ikke øyeblikkelige);
 *   6. readback av den FAKTISK resulterende tilstanden og etterbetingelse (`postcondition_predicate`): feil sluttilstand er aldri «ok» (gatewayen gir `postcondition_mismatch`/`unverified`);
 *   7. umiddelbart eier-varsel (klasse D-varsleren) med et redigert sammendrag, før-/etter-tilstand i ledger og audit, og `rollback_procedure` per handling.
 * ALLE mutasjoner er klasse D: kjeden håndheves av gatewayen bare for D, og strengeste standard er enklest å bevise (en kjede, ikke to). RisikoRETNINGEN (`reduces`/`increases`) står i journalen - det er
 * den som en senere, eier-besluttet autonomi-lemping (Q-G2-1) ville støtte seg på; ingenting av det er bygget (CLAUDE.md regel 11: A-D styrer HVORDAN, aldri OM eieren har kapabiliteten).
 */
export type Params = Record<string, JsonValue>;
export type RiskDirection = "reduces" | "increases" | "neutral";

/** En ren objekt-tilstand (ikke array/null). */
export function isRecord(value: unknown): value is Params {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const zRecord = (shape: z.ZodRawShape): z.ZodType<Params> => z.object(shape).strict() as unknown as z.ZodType<Params>;

export interface CriticalOpSpec {
  action: string;
  description: string;
  /** Kort etikett til journal og varsel («lås», «garasjeport»). */
  label: string;
  shape: z.ZodRawShape;
  /** Navnet på parameteren som peker på det fysiske målet (`entity` | `vehicle_id`). */
  targetParam: string;
  direction: (p: Params) => RiskDirection;
  /** `null` = gyldig før-tilstand, ellers en kort, stabil årsakskode. Kjører BÅDE i gatewayens preflight og i transporten (samme funksjon, forsvar i dybden). */
  validate: (before: Params, p: Params) => string | null;
  /** Etterbetingelsen på den leste etter-tilstanden (den FAKTISKE sluttilstanden). */
  post: (after: Params, p: Params) => boolean;
  /** Kort, REDIGERT sammendrag til eier-varselet (kun enumererte tilstander og eierens egne id-er - aldri fritekst fra utstyret). */
  summary: (state: Params | null, p: Params) => string | null;
  rollback: string;
  /** `false` = en ny kommando gir en NY bivirkning (scene/skript): aldri retry-bar etter uavklart svar. */
  idempotentExternal: boolean;
  irreversible?: boolean;
  scopes: string[];
}

export interface CriticalAuthorization {
  allowed: boolean;
  reason: string;
}

export interface CriticalToolFactoryConfig {
  toolId: string;
  credentialRef: string;
  /** Lese-handlingen: klasse A, preflight OG readback for hver mutasjon. */
  read: { action: string; description: string; shape: z.ZodRawShape; targetParam: string };
  ops: readonly CriticalOpSpec[];
  transport: ToolTransport;
  /** Mål-autorisasjon (eierens egne id-er). Kjøres av gatewayen for HVER handling, også lesingen. */
  authorize: (targetParam: string, parameters: Params) => CriticalAuthorization;
  /** Tidsavbruddet gatewayen gir én handling: må være STØRRE enn ventetiden på sluttilstand, ellers blir hver treg handling «utfall ukjent». */
  timeoutMs: (op: CriticalOpSpec) => number;
  /** Connector-id-er en frys også skal gjelde (utledet av den løste credential-referansen). Tom = kun `tool_id`-frysen. */
  freezeConnectorIds?: readonly string[];
}

/**
 * Fail-closed ved registrering: en mutasjon uten hele kjeden (readback-etterbetingelse, validator, sammendrag, en forklarende tilbakeføringsprosedyre) registreres aldri. Flagg AV = fabrikken kalles ikke.
 */
export function buildCriticalToolDefinitions(config: CriticalToolFactoryConfig): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  const common = { tool_id: config.toolId, credential_ref: config.credentialRef, transport: config.transport, owner_only: true as const };
  const freeze = (ref: string): readonly string[] => (ref === config.credentialRef ? config.freezeConnectorIds ?? [] : []);
  out.push({
    ...common, action: config.read.action, description: config.read.description, input_schema: zRecord(config.read.shape), capability_class: "A", scopes: ["states:read"], reversible: true,
    rollback_procedure: "ingen (lesing)", idempotent_external: true, timeout_ms: 15_000, rate_limit_per_minute: 30, output_trust: "untrusted",
    parameterAuthorizer: (p) => config.authorize(config.read.targetParam, p), connector_ids_for: freeze
  });
  for (const op of config.ops) {
    if (typeof op.validate !== "function" || typeof op.post !== "function" || typeof op.summary !== "function" || op.rollback.trim().length < 20) {
      throw new Error(`critical_op_incomplete:${config.toolId}.${op.action}`);
    }
    out.push({
      ...common, action: op.action, description: op.description, input_schema: zRecord(op.shape), capability_class: "D", scopes: op.scopes, reversible: op.irreversible !== true, rollback_procedure: op.rollback,
      idempotent_external: op.idempotentExternal, timeout_ms: config.timeoutMs(op), rate_limit_per_minute: 10, output_trust: "internal",
      step_up_required: true,
      parameterAuthorizer: (p) => config.authorize(op.targetParam, p), connector_ids_for: freeze,
      preflight_action: config.read.action, preflight_requires_target: true,
      preflight_validator: (state, p) => (isRecord(state) ? op.validate(state, p) : "state_malformed"),
      postcondition_predicate: (after, p) => isRecord(after) && op.post(after, p),
      notification_summary: (state, p) => op.summary(isRecord(state) ? state : null, p)
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ventetid på sluttilstand («settle»)
// ---------------------------------------------------------------------------------------------------------------------

export interface SettleOptions {
  /** Leser nåtilstanden (`null` = målet finnes ikke lenger). Kaster ved lesefeil. */
  read: () => Promise<Params | null>;
  /** Har utstyret nådd en SLUTTilstand (ikke «åpner», «låser», «utgangsforsinkelse»)? */
  isSettled: (state: Params) => boolean;
  /** Er sluttilstanden den ønskede? Kortslutter ventingen. */
  matches: (state: Params) => boolean;
  deadlineMs: number;
  pollMs: number;
  /** Injiserbar klokke og søvn (tester kjører uten ekte tid). Standard: `Date.now` og avbrytbar søvn. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SettleResult {
  state: Params | null;
  settled: boolean;
  matched: boolean;
  polls: number;
}

/**
 * Leser tilstanden til den matcher ønsket sluttilstand, utstyret har SETTLET (på noe annet - da er det en feil sluttilstand), eller fristen går ut. Leser alltid minst én gang. Avbrytbar (kallsignalet):
 * en avbrutt venting sender aldri en ny forespørsel. Returnerer siste lesning - tolkningen (mismatch = utfall ukjent) gjør kalleren.
 */
export async function settleUntil(options: SettleOptions): Promise<SettleResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms));
  const started = now();
  let polls = 0;
  for (;;) {
    throwIfAborted();
    const state = await options.read();
    polls += 1;
    if (state === null) return { state: null, settled: false, matched: false, polls };
    const settled = options.isSettled(state);
    const matched = options.matches(state);
    if (matched || settled) return { state, settled, matched, polls };
    if (now() - started + options.pollMs > options.deadlineMs) return { state, settled: false, matched: false, polls };
    await sleep(options.pollMs);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Små hjelpere delt av hjem og bil
// ---------------------------------------------------------------------------------------------------------------------

/** Tekst fra utstyret/leverandøren er UBETRODD data: kontrolltegn bort og kort. Brukes bare på enumererte tilstandsord og tidsstempler - aldri fritekst-attributter. */
export function cleanToken(value: unknown, max = 64): string {
  if (typeof value !== "string") return "";
  return value.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").trim().slice(0, max);
}

/** Streng ISO-8601-parsing (tidsstempel med dato og klokkeslett); `null` ved alt annet. Brukes for scene-/skript-markørene. */
export function parseIsoInstant(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
