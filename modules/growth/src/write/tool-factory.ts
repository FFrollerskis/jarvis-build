import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import {
  OUTCOME_UNKNOWN_PREFIX, abortableSleep, adoptCallSignal, afterAcceptedMutation, type ToolDefinition, type ToolInvocationContext, type ToolTransport
} from "@jarvis/tool-gateway";
import { authorizeGrowthTarget, type GrowthProvider, type GrowthWriteConfig } from "./config.ts";
import { zRecord, type Params } from "./validators.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): ÉN deklarativ modell for alle skrivehandlinger mot annonse-/analyseplattformene - og ÉN fabrikk som gjør hver handling om til en `ToolDefinition` med HELE
 * klasse D-kjeden. Hver leverandørmodul (`google-ads-write.ts` ...) beskriver kun sine handlinger (`OpSpec`) og sin HTTP; kjeden er identisk og testet ÉN gang her.
 *
 * KJEDEN per skrivehandling (CLAUDE.md regel 2/11, masterplan Appendiks B nivå A):
 *   1. mål-autorisasjon FØR transporten (`parameterAuthorizer`: eierens egen konto/eiendom i `JARVIS_GROWTH_WRITE_TARGETS`) - også for lesingene;
 *   2. step-up: enhetssignert eier-økt (`step_up_required`) for ALLE skrivehandlinger (klasse C og D; strengeste standard, Q-55) - gatewayen håndhever det selv;
 *   3. fersk tilstandslesing (`preflight_action` = leverandør-tilstanden) + målvalidering + deterministisk validator (`preflight_validator`);
 *   4. idempotensnøkkel (klasse D: påkrevd) + ledger-reservasjon i gatewayen; nøkkel + readback; samme nøkkel gir aldri en ny mutasjon;
 *   5. mutasjon (transporten leser tilstanden på nytt, validerer med SAMME validator, utfører, og leser tilbake);
 *   6. etterbetingelse (readback) - `postcondition_predicate` i gatewayen (D) OG i transporten (alle): mismatch = `outcome_unknown:..._postcondition_mismatch` (UTFALL UKJENT, aldri «ok»);
 *   7. før-/etter-tilstand i `tool_executions`/`audit_events` (gatewayen), umiddelbart eier-varsel (klasse D), `rollback_procedure` per handling.
 * FINANS-NØDBRYTER (UA-6 «finance kill switch stops new transactions»): handlinger som ØKER eller STARTER utgift (`spend: increases|starts`, og beløpsendringer som går opp) nektes mens
 * eierens nødbryter er på OG når tilstanden er ukjent (fail-closed). Det er IKKE et beløpstak (Finance Integrity Gateway er revisjon/avstemming); å REDUSERE/pause er alltid tillatt.
 */
export type SpendEffect = "none" | "reduces" | "increases" | "starts" | "structural" | "directional";

export interface OpSpec {
  action: string;
  description: string;
  shape: z.ZodRawShape;
  /** A = lesing/tilstand, C/D = skriving (A-D styrer HVORDAN, aldri OM eieren har kapabiliteten, D-41). */
  risk: "A" | "C" | "D";
  /** Pengeeffekt (kun skriving). `directional` = retningen avgjøres av validatoren (budsjett/bud: opp krever åpen nødbryter). */
  spend?: SpendEffect;
  /** Navnet på målparameteren (kontoen/eiendommen) som mål-autorisasjonen sjekker. */
  targetParam: string;
  /** Lese-handlingen som er preflight OG readback (påkrevd for skriving). */
  stateAction?: string;
  rollback?: string;
  /** `true` = beskrivelse av en handling som ikke kan angres teknisk (reversible=false). */
  irreversible?: boolean;
  /** Absolutt-tilstand-oppdateringer er idempotente hos leverandøren (standard true); opprettelser er det IKKE (false). */
  idempotentExternal?: boolean;
  scopes: string[];
  /** Spesifikk målsjekk på den ferske tilstanden (ekstra til «tilstanden finnes»). */
  targetCheck?: (state: JsonValue, p: Params) => boolean;
  /** `null` = gyldig, ellers en kort, stabil årsakskode. */
  validate?: (state: JsonValue, p: Params) => string | null;
  /** Etterbetingelse på den leste etter-tilstanden. */
  post?: (after: JsonValue, p: Params) => boolean;
  /** `true`: en readback som svarer «finnes ikke» (null) er suksess (sletting). */
  absentIsDone?: boolean;
  /** Kort, REDIGERT sammendrag til eier-varselet (aldri hemmeligheter/innhold). */
  summary?: (state: JsonValue | null, p: Params) => string | null;
  /** `true` når tilstanden ALLEREDE er den ønskede (idempotent no-op): ingen mutasjon og ingen verifisering - svaret er `{ unchanged: true }`. */
  noop?: (state: JsonValue, p: Params) => boolean;
  /** Stabil, lesbar målstreng til journal og varsel (id-er - aldri hemmeligheter eller leverandørtekst). Påkrevd for skriving. */
  target?: (p: Params) => string;
  timeoutMs?: number;
  rate?: number;
}

export interface ProviderToolSpec {
  provider: GrowthProvider;
  toolId: string;
  credentialRef: string;
  ops: readonly OpSpec[];
}

/** Er finans-nødbryteren BEKREFTET av (`false`)? Alt annet (på eller ukjent) er «ikke åpen» - fail-closed. */
export function killSwitchOpen(state: JsonValue | null | undefined): boolean {
  return typeof state === "object" && state !== null && !Array.isArray(state) && (state as Record<string, unknown>)["finance_kill_switch_active"] === false;
}

/** Validatoren som kjører BÅDE i gatewayens preflight og i transporten (samme funksjon): nødbryter for pengeøkende handlinger, deretter handlingens egen. */
export function composeValidator(op: OpSpec): (state: JsonValue, p: Params) => string | null {
  return (state, p) => {
    if ((op.spend === "increases" || op.spend === "starts") && !killSwitchOpen(state)) return "finance_kill_switch_active_or_unknown";
    return op.validate ? op.validate(state, p) : null;
  };
}

export function buildGrowthToolDefinitions(spec: ProviderToolSpec, transport: ToolTransport, config: Pick<GrowthWriteConfig, "targets">): ToolDefinition[] {
  return spec.ops.map((op): ToolDefinition => {
    const base = {
      tool_id: spec.toolId, action: op.action, description: op.description, input_schema: zRecord(op.shape), scopes: op.scopes, credential_ref: spec.credentialRef, transport, owner_only: true,
      parameterAuthorizer: (p: Params) => authorizeGrowthTarget(spec.provider, op.targetParam, p, config),
      timeout_ms: op.timeoutMs ?? (op.risk === "A" ? 25_000 : 45_000), rate_limit_per_minute: op.rate ?? (op.risk === "A" ? 30 : 10)
    };
    if (op.risk === "A") return { ...base, capability_class: "A", reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true, output_trust: "untrusted" };
    // Fail-closed ved registrering: en skrivehandling uten hele kjeden registreres aldri.
    if (!op.stateAction || !op.post || !op.target || !op.rollback || op.rollback.trim().length < 20) throw new Error(`growth_write_op_incomplete:${spec.toolId}.${op.action}`);
    return {
      ...base, capability_class: op.risk, reversible: op.irreversible !== true, rollback_procedure: op.rollback, idempotent_external: op.idempotentExternal ?? true, output_trust: "internal",
      step_up_required: true, preflight_action: op.stateAction, preflight_requires_target: true,
      ...(op.targetCheck ? { preflight_target_check: op.targetCheck } : {}),
      preflight_validator: composeValidator(op), postcondition_predicate: op.post,
      ...(op.absentIsDone === true ? { postcondition_target_absent: true } : {}),
      ...(op.summary ? { notification_summary: op.summary } : {})
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Felles transport-skall
// ---------------------------------------------------------------------------------------------------------------------

export interface Auth {
  headers: Record<string, string>;
  query?: Record<string, string>;
  /** Verdier som skal vaskes bort fra all feiltekst. */
  secrets: string[];
}

export interface WriteTransportDeps {
  /** Er eierens finans-nødbryter på for tenanten? Mangler proben (eller kaster den), er tilstanden «ukjent» (`null`) og pengeøkende handlinger nektes. */
  financeKillSwitch?: (tenantId: string) => Promise<boolean> | boolean;
  /** Venting før den ene verifiserings-gjentakelsen (standard: avbrytbar, 800 ms). Injiseres i tester. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Felles skall for skrivetransportene: ÉN dispatch som gir samme rekkefølge for ALLE leverandører (les tilstand -> valider -> mutér -> les tilbake -> verifiser). Leverandørmodulen
 * implementerer kun `authenticate`, `readState` og `applyWrite`. `readState` svarer `null` når målet ikke finnes.
 */
export abstract class GrowthWriteTransportBase implements ToolTransport {
  protected abstract readonly label: string;
  protected abstract readonly ops: ReadonlyMap<string, OpSpec>;

  protected constructor(protected readonly deps: WriteTransportDeps = {}) {}

  protected abstract authenticate(credential: string): Promise<Auth>;
  protected abstract readState(action: string, p: Params, auth: Auth): Promise<JsonValue | null>;
  protected abstract applyWrite(action: string, p: Params, auth: Auth, before: JsonValue): Promise<{ external_id?: string; data?: JsonValue }>;

  async invoke(action: string, parameters: Params, credential: string, context?: ToolInvocationContext, signal?: AbortSignal): Promise<{ external_id?: string; data?: JsonValue }> {
    return adoptCallSignal(signal, () => this.dispatch(action, parameters, credential, context));
  }

  private async killSwitch(tenantId: string | undefined): Promise<boolean | null> {
    if (tenantId === undefined || this.deps.financeKillSwitch === undefined) return null;
    try {
      return (await this.deps.financeKillSwitch(tenantId)) === true;
    } catch {
      return null; // ukjent = ikke åpen (fail-closed)
    }
  }

  private async withKillSwitch(state: JsonValue | null, tenantId: string | undefined): Promise<JsonValue | null> {
    if (state === null || typeof state !== "object" || Array.isArray(state)) return state;
    return { ...(state as Record<string, JsonValue>), finance_kill_switch_active: await this.killSwitch(tenantId) };
  }

  private async dispatch(action: string, p: Params, credential: string, context: ToolInvocationContext | undefined): Promise<{ external_id?: string; data?: JsonValue }> {
    const op = this.ops.get(action);
    if (!op) throw new Error(`${this.label}_action_not_implemented:${action}`);
    const tenantId = context?.identity.tenant_id;
    const auth = await this.authenticate(credential);
    if (op.risk === "A") return { data: await this.withKillSwitch(await this.readState(action, p, auth), tenantId) };

    const stateAction = op.stateAction as string;
    const before = await this.withKillSwitch(await this.readState(stateAction, p, auth), tenantId);
    if (before === null || (op.targetCheck && !op.targetCheck(before, p))) throw new Error(`${this.label}_target_not_found`);
    // SAMME validator som gatewayens preflight - kjøres på ferske data rett før mutasjonen (forsvar i dybden; transporten kan også nås uten gatewayen i skript).
    const invalid = composeValidator(op)(before, p);
    if (invalid !== null) throw new Error(`growth_precondition_failed:${invalid}`);
    if (op.noop?.(before, p) === true) return { data: { unchanged: true } };

    const result = await this.applyWrite(action, p, auth, before);
    if ((result.data as { unchanged?: unknown } | undefined)?.unchanged === true) return result; // ingen mutasjon skjedde - ingenting å verifisere
    // ETTER en akseptert mutasjon: enhver feil herfra er «utfall ukjent» (aldri en vanlig, retry-bar feil).
    if (!(await this.verifyAfter(op, stateAction, p, auth, tenantId))) throw new Error(`${OUTCOME_UNKNOWN_PREFIX}:${this.label}_postcondition_mismatch`);
    return result;
  }

  /** Readback + etterbetingelse. Ett (1) ekstra forsøk etter en kort pause tåler at leverandørens lesing henger litt etter skrivingen; deretter er utfallet UKJENT (aldri «ok»). */
  private async verifyAfter(op: OpSpec, stateAction: string, p: Params, auth: Auth, tenantId: string | undefined): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const after = await afterAcceptedMutation(`${this.label}_readback_failed`, () => this.readState(stateAction, p, auth));
      const ok = after === null ? op.absentIsDone === true : (op.post as (a: JsonValue, q: Params) => boolean)((await this.withKillSwitch(after, tenantId)) as JsonValue, p);
      if (ok) return true;
      if (attempt === 0) await (this.deps.sleep ? this.deps.sleep(800) : abortableSleep(800));
    }
    return false;
  }
}
