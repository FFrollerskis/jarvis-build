import type { CapabilityClass, JsonValue } from "@jarvis/contracts";
import {
  CARD_AMOUNT_KEYS, CARD_PREVIEW_MAX_CHARS, CARD_RECIPIENT_KEYS, CARD_TARGET_KEYS,
  containsHiddenCharacters, sanitizeDisplayText, sanitizeParameterValue, scanForSecrets
} from "@jarvis/core";
import type { ToolDefinition } from "./gateway.ts";
import { CHAT_ACT_TIER_KEYS } from "./chat-act-tier.ts";
import { githubRepoLockViolation } from "./github-repo-lock.ts";
import { bindScopeFields, type MeshToolMapping } from "./mesh-bridge.ts";
import { SURFACE_TOOL_GRANTS, type Surface, type ToolManifest } from "./tool-manifest.ts";
import { selectSurfaceTools } from "./turn-context.ts";

/**
 * WP-D4 (JARVIS-078, rådets bekreftelsesflyt): TRUSTED lag mellom AI-rådets forslag (`CouncilProposal`, model-gateway) og den EKSISTERENDE bekreftelsesveien (`ConfirmationStore`, D-382).
 *
 * Rådet er en vurderingsrolle og får aldri verktøy (§30). Det eneste porten gjør med et forslag er å (1) velge ut, deterministisk og FØR rådet kjører, hvilke handlinger rådet i det hele tatt kan foreslå
 * (`actionsFor`), og (2) legge et forslag frem som en PENDING bekreftelse bundet til det kanoniske kallet (`submit`). Porten har ingen `ToolGateway`/eksekutor - den KAN ikke utføre noe. Utførelsen skjer kun når eieren
 * godkjenner kortet i `/confirmations` (grant-autentisert, `approveAndTake`), gjennom samme ToolGateway (policy, kill switch, klasse D-pipeline, audit) som enhver annen bekreftet handling.
 *
 * Reglene er de samme som for en modellstyrt handling i chatten (`MeshToolExecutor`), slik at rådet aldri får en videre vei enn chatten har:
 *  - kun handlingsnivået (`CHAT_ACT_TIER`: klasse B/C, effekt write/send/delete) og kun flaten `web_chat` (tale/Telegram/bakgrunn har ingen handlinger; STT er ubetrodd),
 *  - verktøyet må finnes i manifestet, og sikkerhetsklassen/effekten leses HER fra manifestet (forslagets egen påstand brukes bare til å oppdage at noe er endret),
 *  - identitets-/scope-felt bindes fra eierens autentiserte identitet (en verdi modellen la inn overstyres alltid),
 *  - Q-50 B: GitHub-kall er låst til eierens repo,
 *  - argumentene valideres mot det REGISTRERTE Zod-skjemaet før noe legges frem (eieren får aldri et kort som ikke kan utføres),
 *  - alt eieren ser på kortet (forventet effekt, medlemmer) er redigert for hemmeligheter og kappet.
 * Ingen ny sikkerhetsvei: ingen ny godkjenningsform, ingen ny utførelsesvei, ingen svekking av D-382 («ALDRI: klasse D, pay/control, eier-/sikkerhetsnavnerom»).
 */
export const COUNCIL_PROPOSAL_TAINT = "council_proposal";
/** Rådet bruker minutter på å svare, og eieren må lese hele vurderingen før han godkjenner: lenger enn standard 5 min, fortsatt kort og bundet (hashen dekker utløpet). */
export const COUNCIL_PROPOSAL_TTL_MS = 15 * 60_000;
export const MAX_COUNCIL_ACTIONS = 16;

/** Det rådet får vite om en handling: strukturelt lik `ProposableAction` i model-gateway (ingen import mellom modulene). */
export interface CouncilActionSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  risk: CapabilityClass;
  effect: string;
}

/** Strukturelt lik `CouncilProposal` i model-gateway - kun feltene porten bruker. */
export interface CouncilProposalSubmission {
  council_id: string;
  proposal_id: string;
  action: { tool: string; arguments: Record<string, JsonValue> };
  expected_effect: string;
  safety: { risk: string; effect: string };
  consensus_status: string;
  supporting_models: readonly string[];
  dissenting_models: readonly string[];
  confidence: number;
  risk_summary: string;
}

export interface CouncilSubmitIdentity {
  tenant_id: string;
  person_id: string;
  memory_space_id?: string;
  device_id?: string | null;
  session_id?: string | null;
}

/** Strukturelt grensesnitt implementert av `ConfirmationStore.propose` (@jarvis/core). Oppretter/gjenbruker en PENDING bekreftelse og gjør ingenting annet. */
export interface CouncilConfirmationGate {
  propose(
    call: { tool_id: string; action: string; parameters: Record<string, JsonValue> },
    who: { tenant_id: string; person_id: string; device_id?: string | null; session_id?: string | null },
    taintReasons: string[],
    options?: { ttlMs?: number; context?: Record<string, JsonValue> }
  ): Promise<{ ok: true; confirmation_id: string; reused: boolean; expires_at: string } | { ok: false; reason: string }>;
}

export type CouncilSubmitDenial =
  | "surface_not_allowed"
  | "tool_not_proposable"
  | "not_in_act_tier"
  | "tool_not_on_surface"
  | "tool_not_in_manifest"
  | "safety_class_mismatch"
  | "github_repo_locked"
  | "invalid_parameters"
  | "confirmation_rejected"
  | "confirmation_unavailable";

export type CouncilSubmitResult =
  | { ok: true; confirmation_id: string; tool: string; reused: boolean; expires_at: string; ttl_minutes: number; bound_summary: string }
  | { ok: false; reason: CouncilSubmitDenial; detail?: string };

export interface CouncilActionsResult {
  actions: CouncilActionSpec[];
  /** D-381: valgte handlinger som eksponerer finansdata hever rådet til SECRET_RESTRICTED (kun lokale modeller), akkurat som i chatten. */
  min_sensitivity?: "SECRET_RESTRICTED";
}

/** All modellskrevet tekst på kortet går gjennom den FELLES renseren (@jarvis/core): ren tekst uten usynlige tegn, lenker, markdown og HTML (M4, gjennomgang av PR #315). */
const clean = sanitizeDisplayText;

const TITLE_KEYS: readonly string[] = ["title", "subject", "name", "summary"];
const TEXT_KEYS: readonly string[] = ["body", "text", "message", "content", "description", "comment", "note"];
const SHOWN_VALUE_MAX = 120;
const SHOWN_TEXT_MAX = 80;
const SHOWN_LIST_MAX = 4;

function showValue(value: JsonValue | undefined, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return sanitizeParameterValue(value, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const shown = value.slice(0, SHOWN_LIST_MAX).map((item) => showValue(item, max)).filter((text) => text !== "");
    return shown.join(", ") + (value.length > SHOWN_LIST_MAX ? ` (+${value.length - SHOWN_LIST_MAX} til)` : "");
  }
  return sanitizeParameterValue(JSON.stringify(value), max);
}

/**
 * Den FASTE linjen om hva handlingen faktisk gjør (M4, gjennomgang av PR #315): mottaker, mål, beløp, tittel og et kort tekstutdrag, lest direkte fra de BUNDNE parameterne med de samme nøklene som kortet bruker
 * (`CARD_*_KEYS`) - aldri fra modelltekst. Feltnavnene er faste (fra koden); verdiene er rensede (ingen lenke-/bilde-/HTML-tegn). Står FØR rådets egen, modellskrevne beskrivelse i chat-merknaden og i kortets kontekst.
 * Finnes ingen av dem, sies det, og feltnavnene vises, slik at eieren ikke tror noe er utelatt.
 */
export function describeBoundParameters(parameters: Record<string, JsonValue>): string {
  const parts: string[] = [];
  const firstOf = (keys: readonly string[], accept: (value: JsonValue) => boolean = () => true): [string, JsonValue] | null => {
    for (const key of keys) {
      const value = parameters[key];
      if (value !== undefined && value !== null && accept(value)) return [key, value];
    }
    return null;
  };
  const add = (label: string, found: [string, JsonValue] | null, max: number, quote = false): void => {
    if (!found) return;
    const text = showValue(found[1], max);
    if (text !== "") parts.push(`${label} (${found[0]}): ${quote ? `«${text}»` : text}`);
  };
  add("Mottaker", firstOf(CARD_RECIPIENT_KEYS), SHOWN_VALUE_MAX);
  add("Mål", firstOf(CARD_TARGET_KEYS), SHOWN_VALUE_MAX);
  add("Beløp", firstOf(CARD_AMOUNT_KEYS), SHOWN_VALUE_MAX);
  add("Tittel", firstOf(TITLE_KEYS, (v) => typeof v === "string"), SHOWN_VALUE_MAX, true);
  add("Tekst", firstOf(TEXT_KEYS, (v) => typeof v === "string"), SHOWN_TEXT_MAX, true);
  if (parts.length > 0) return `Handlingen gjør dette (hentet fra selve kallet, ikke fra rådet): ${parts.join(" · ")}.`;
  const fields = Object.keys(parameters).slice(0, 8).map((key) => sanitizeParameterValue(key, 40)).filter((key) => key !== "");
  return `Handlingen har ingen mottaker, mål, beløp eller tittel i parameterne (felt: ${fields.length > 0 ? fields.join(", ") : "ingen"}). Se bekreftelseskortet for alle parametere.`;
}

/** Farlige nøkler (prototype-forurensning) forkastes også her - porten er den betrodde grensen og stoler ikke på at utkastet allerede er sjekket. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || typeof value !== "object" || value === null) return depth > 8;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item, depth + 1));
  return Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key) || hasForbiddenKey((value as Record<string, unknown>)[key], depth + 1));
}

/** Medlemslistene er leverandørnavn (identifikatorer). Alt annet - eller noe scanneren gjenkjenner som hemmelighet - droppes i stedet for å vises «renset» på kortet. */
const MODEL_NAME = /^[a-z][a-z0-9_.-]{0,39}$/i;
const cleanModelNames = (items: readonly string[]): string[] => items.filter((i): i is string => typeof i === "string" && MODEL_NAME.test(i) && scanForSecrets(i).findings.length === 0).slice(0, 8);

/** `[HANDLING - utføres først når Tobias godkjenner bekreftelsen]`-prefikset gjelder modellens egen tur; rådet får ren beskrivelse. */
const stripActPrefix = (description: string): string => description.replace(/^\[HANDLING[^\]]*\]\s*/, "");

export class CouncilProposalGate {
  private readonly actMappings: ReadonlyArray<MeshToolMapping>;
  private readonly definitions: ReadonlyMap<string, Pick<ToolDefinition, "input_schema">>;
  private readonly ttlMs: number;

  constructor(
    private readonly deps: {
      /** Modellflatens mappinger (alle nivåer) - porten beholder selv kun handlingsnivået (`kind: "act"`). */
      mappings: ReadonlyArray<MeshToolMapping>;
      manifest: ToolManifest;
      /** Registrerte definisjoner (`toolGateway.list()`) - kun for å validere argumentene mot det REGISTRERTE Zod-skjemaet. */
      definitions: ReadonlyArray<Pick<ToolDefinition, "tool_id" | "action" | "input_schema">>;
      confirmations: CouncilConfirmationGate;
      ttlMs?: number;
      /** Klokken som beregner gjenværende levetid (L7) - injiseres kun i tester; bør være den samme som `ConfirmationStore` bruker. */
      now?: () => Date;
    }
  ) {
    this.actMappings = deps.mappings.filter((m) => m.kind === "act" && CHAT_ACT_TIER_KEYS.has(`${m.tool_id}.${m.action}`));
    this.definitions = new Map(deps.definitions.map((d) => [`${d.tool_id}.${d.action}`, d]));
    this.ttlMs = Math.max(60_000, Math.min(deps.ttlMs ?? COUNCIL_PROPOSAL_TTL_MS, 30 * 60_000));
  }

  /**
   * Hvilke handlinger rådet kan foreslå for akkurat denne meldingen: SAMME deterministiske utvalg som chatten bruker for handlingsnivået (handlingsord i meldingen, tjenestenavn, budsjett), begrenset til act-nivået og
   * manifestet. Tom liste = rådet gir en ren vurdering uten forslagsvei. Utvalget ser kun den gjeldende meldingen (rådet ser ikke historikken, så det skal heller ikke arve verktøy fra den).
   */
  actionsFor(input: { surface: Surface; text: string }): CouncilActionsResult {
    if (input.surface !== "web_chat") return { actions: [] };
    const selection = selectSurfaceTools(input.surface, input.text, this.actMappings);
    const actions: CouncilActionSpec[] = [];
    for (const mapped of selection.selected) {
      const entry = this.deps.manifest.get(`${mapped.tool_id}.${mapped.action}`);
      if (!entry || mapped.kind !== "act") continue;
      actions.push({ name: mapped.def.name, description: stripActPrefix(mapped.def.description), input_schema: mapped.def.input_schema, risk: entry.risk, effect: entry.effect });
      if (actions.length >= MAX_COUNCIL_ACTIONS) break;
    }
    return { actions, ...(actions.length > 0 && selection.min_sensitivity ? { min_sensitivity: selection.min_sensitivity } : {}) };
  }

  /** Legger forslaget frem som en PENDING bekreftelse. Utfører ALDRI: porten har ingen eksekutor, og `propose` forbruker aldri en godkjent bekreftelse. */
  async submit(identity: CouncilSubmitIdentity, surface: Surface, proposal: CouncilProposalSubmission): Promise<CouncilSubmitResult> {
    const deny = (reason: CouncilSubmitDenial, detail?: string): CouncilSubmitResult => ({ ok: false, reason, ...(detail !== undefined ? { detail } : {}) });
    if (surface !== "web_chat") return deny("surface_not_allowed");
    const mapped = this.actMappings.find((m) => m.def.name === proposal.action.tool);
    if (!mapped) return deny("tool_not_proposable");
    const key = `${mapped.tool_id}.${mapped.action}`;
    if (!CHAT_ACT_TIER_KEYS.has(key)) return deny("not_in_act_tier");
    if (!SURFACE_TOOL_GRANTS.web_chat.some((g) => `${g.tool_id}.${g.action}` === key)) return deny("tool_not_on_surface");
    const entry = this.deps.manifest.get(key);
    if (!entry) return deny("tool_not_in_manifest");
    // Klassen/effekten kommer fra manifestet. Avviker forslagets påstand, er noe endret siden rådet fikk listen - da legges ingenting frem.
    if (entry.risk !== proposal.safety.risk || entry.effect !== proposal.safety.effect) return deny("safety_class_mismatch");

    if (hasForbiddenKey(proposal.action.arguments)) return deny("invalid_parameters", "forbidden_key");
    // M4: usynlige/styrende tegn (bidi-overstyring, nullbredde, tag-tegn, kontrolltegn) i et argument gjør at det eieren leser ikke er det som utføres. Avvises i stedet for å vises «renset».
    if (containsHiddenCharacters(proposal.action.arguments)) return deny("invalid_parameters", "hidden_characters");
    let parameters: Record<string, unknown> = { ...proposal.action.arguments };
    if (mapped.scope_bindings && mapped.scope_bindings.length > 0) parameters = bindScopeFields(parameters, mapped.scope_bindings, identity);
    if (mapped.tool_id === "github") {
      const violation = githubRepoLockViolation(mapped.action, parameters["repo"] as JsonValue | undefined);
      if (violation) return deny("github_repo_locked");
    }
    const definition = this.definitions.get(key);
    if (!definition) return deny("tool_not_in_manifest");
    const parsed = definition.input_schema.safeParse(parameters);
    // Kun feltnavn i detaljen - aldri verdier (de kan komme fra ubetrodd innhold).
    if (!parsed.success) return deny("invalid_parameters", [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(rot)"))].slice(0, 6).join(", "));
    // M4: kortets forhåndsvisning kutter ved `CARD_PREVIEW_MAX_CHARS`. Er de BUNDNE parameterne (inkl. identitetsfelt) lengre, ville eieren godkjenne mer enn kortet viser - da legges ingenting frem. Målt både før og etter hemmelighetsredigeringen.
    const serialized = JSON.stringify(parameters);
    if (serialized.length > CARD_PREVIEW_MAX_CHARS || scanForSecrets(serialized).text.length > CARD_PREVIEW_MAX_CHARS) return deny("invalid_parameters", "too_long_for_card");
    const boundSummary = describeBoundParameters(parameters as Record<string, JsonValue>);

    const context: Record<string, JsonValue> = {
      source: "ai_council",
      council_id: sanitizeParameterValue(proposal.council_id, 80),
      proposal_id: sanitizeParameterValue(proposal.proposal_id, 80),
      // M4: det handlingen FAKTISK gjør (fra de bundne parameterne) står først og er faste felt; rådets beskrivelse er skrevet av en modell og merkes slik på kortet.
      bound_parameters_no: boundSummary,
      effect_author: "model",
      effect_note_no: "Effektbeskrivelsen er skrevet av en modell og er ingen garanti for hva som skjer - godkjenn ut fra parameterne.",
      expected_effect: clean(proposal.expected_effect, 300),
      safety_class: entry.risk,
      effect: entry.effect,
      consensus: sanitizeParameterValue(proposal.consensus_status, 40),
      supporting_models: cleanModelNames(proposal.supporting_models),
      dissenting_models: cleanModelNames(proposal.dissenting_models),
      confidence: Number.isFinite(proposal.confidence) ? Math.max(0, Math.min(100, Math.round(proposal.confidence))) : 0,
      risk_summary: clean(proposal.risk_summary, 600)
    };
    const who = { tenant_id: identity.tenant_id, person_id: identity.person_id, device_id: identity.device_id ?? null, session_id: identity.session_id ?? null };
    let outcome: Awaited<ReturnType<CouncilConfirmationGate["propose"]>>;
    try {
      outcome = await this.deps.confirmations.propose({ tool_id: mapped.tool_id, action: mapped.action, parameters: parameters as Record<string, JsonValue> }, who, [COUNCIL_PROPOSAL_TAINT], { ttlMs: this.ttlMs, context });
    } catch {
      return deny("confirmation_unavailable");
    }
    if (!outcome.ok) return deny(outcome.reason === "confirmation_rejected" ? "confirmation_rejected" : "confirmation_unavailable");
    // L7: en gjenbrukt PENDING-rad kan ha kortere gjenværende levetid enn standarden - meldingen til eieren bruker raden sin egen utløpstid, aldri en hardkodet verdi.
    const remainingMs = Date.parse(outcome.expires_at) - (this.deps.now ?? (() => new Date()))().getTime();
    const ttlMinutes = Number.isFinite(remainingMs) ? Math.max(1, Math.min(Math.ceil(remainingMs / 60_000), Math.round(this.ttlMs / 60_000))) : Math.round(this.ttlMs / 60_000);
    return { ok: true, confirmation_id: outcome.confirmation_id, tool: key, reused: outcome.reused, expires_at: outcome.expires_at, ttl_minutes: ttlMinutes, bound_summary: boundSummary };
  }
}
