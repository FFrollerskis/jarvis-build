import type { MeshToolMapping } from "./mesh-bridge.ts";
import {
  SURFACE_LIMITS,
  SURFACE_TOOL_GRANTS,
  estimateSchemaTokens,
  type Surface,
  type SurfaceLimits
} from "./tool-manifest.ts";

/**
 * Del 3 (JARVIS-002/014/028): tilstand for ÉN samtaletur, eid av trusted lag (aldri modellen).
 *   - `taint`: settes når beslutningsgrunnlaget inneholder ubetrodd materiale (ubetrodd verktøyoutput, upålitelig kanal).
 *   - tellere + grenser per flate (kall per runde / totalt).
 * Taint kan bare gå EN vei innen en tur: en gang tainted, alltid tainted. Den er ikke en del av `IdentityContext` (som er .strict()).
 */
export class TurnTaint {
  private readonly reasonSet = new Set<string>();
  get tainted(): boolean {
    return this.reasonSet.size > 0;
  }
  get reasons(): string[] {
    return [...this.reasonSet];
  }
  mark(reason: string): void {
    this.reasonSet.add(reason);
  }
}

export interface TurnContext {
  /** Eierens RÅ melding (redigert for hemmeligheter) - trusted: kommer fra grant-autentisert kanal, aldri fra modell/verktøy. */
  user_message: string;
  surface: Surface;
  taint: TurnTaint;
  limits: SurfaceLimits;
  /** Samlede verktøykall så langt i turen. */
  calls: { total: number };
}

/** Kanaler der selve inputen er upålitelig fra første stund (tale-transkripsjon: STT-feil, omgivelser, andres stemmer). */
const UNTRUSTED_INPUT_SURFACES: ReadonlySet<Surface> = new Set(["voice"]);

export function createTurnContext(surface: Surface, userMessage: string): TurnContext {
  const taint = new TurnTaint();
  if (UNTRUSTED_INPUT_SURFACES.has(surface)) taint.mark(`untrusted_input:${surface}`);
  return { user_message: userMessage, surface, taint, limits: SURFACE_LIMITS[surface], calls: { total: 0 } };
}

/** Intensjons-nøkkelord per handling. Kun handlinger som er tildelt flaten kan velges - dette er IKKE en autorisasjon, bare utvalg. */
const INTENT_KEYWORDS: Readonly<Record<string, RegExp>> = {
  "email.read_inbox": /(e-?post|\bmail\b|innboks|inbox|melding|brev)/i,
  "calendar.read_events": /(kalender|møte|avtale|timeplan|calendar|schedule|\bi dag\b|dagens|\bi morgen\b)/i,
  "github.read_issues": /(github|issue|repo\b|pull request|\bpr\b|\bbug\b|kodebase)/i,
  "executive.get_capability_status": /(status|tilkobl|connector|kapabilitet|integrasjon|hva kan du|hva er koblet)/i,
  "memory.search": /(husker|husk\b|minne|sa jeg|nevnte|forrige|tidligere|hva heter|hvem er|vet du|fortalte)/i,
  "memory.propose": /(husk\b|ikke glem|lagre|noter|ta vare|remember|foreslå)/i
};
const OVERVIEW = /(oversikt|hva skjer|brief|morgenbrief|hva har jeg)/i;
const OVERVIEW_KEYS = new Set(["email.read_inbox", "calendar.read_events", "github.read_issues"]);
const ALWAYS_PRIORITY = ["memory.search", "email.read_inbox", "calendar.read_events", "github.read_issues", "executive.get_capability_status", "memory.propose"];

export interface SurfaceSelection {
  selected: MeshToolMapping[];
  /** Estimert skjema-tokens for det valgte settet. */
  schema_tokens: number;
  limits: SurfaceLimits;
  /** Handlinger som ble felt bort av utvalg/grenser (diagnostikk). */
  dropped: string[];
}

const mappingKey = (m: MeshToolMapping) => `${m.tool_id}.${m.action}`;

/**
 * Deterministisk, per-flate verktøyutvalg (INGEN LLM): 1) HARD allowlist for flaten (alt utenfor feller utvalget lukket),
 * 2) intensjonsutvalg på brukerens tekst (kun relevante verktøy, ikke hele settet), 3) grenser (antall + skjema-tokens).
 * Uten treff velges kun det billigste generelle verktøyet (`memory.search`) hvis flaten har det.
 */
export function selectSurfaceTools(surface: Surface, text: string, candidates: ReadonlyArray<MeshToolMapping>): SurfaceSelection {
  const limits = SURFACE_LIMITS[surface];
  const granted = new Set(SURFACE_TOOL_GRANTS[surface].map((g) => `${g.tool_id}.${g.action}`));
  const allowed = candidates.filter((m) => granted.has(mappingKey(m)));
  const overview = OVERVIEW.test(text);
  let wanted = allowed.filter((m) => {
    const key = mappingKey(m);
    return (INTENT_KEYWORDS[key]?.test(text) ?? false) || (overview && OVERVIEW_KEYS.has(key));
  });
  if (wanted.length === 0) wanted = allowed.filter((m) => mappingKey(m) === "memory.search");
  wanted.sort((a, b) => ALWAYS_PRIORITY.indexOf(mappingKey(a)) - ALWAYS_PRIORITY.indexOf(mappingKey(b)));

  const selected: MeshToolMapping[] = [];
  const dropped: string[] = allowed.filter((m) => !wanted.includes(m)).map(mappingKey);
  let tokens = 0;
  for (const m of wanted) {
    const cost = estimateSchemaTokens(m.def);
    if (selected.length >= limits.max_tools_per_round || tokens + cost > limits.max_schema_tokens) {
      dropped.push(mappingKey(m));
      continue;
    }
    selected.push(m);
    tokens += cost;
  }
  // Hard allowlist ETTER utvalget: aldri et verktøy utenfor flaten (forsvar mot en fremtidig utvalgsfeil).
  for (const m of selected) {
    if (!granted.has(mappingKey(m))) throw new Error(`surface_selection_violation:${surface}:${mappingKey(m)}`);
  }
  return { selected, schema_tokens: tokens, limits, dropped };
}

const JOB_MEMORY_SPACES = ["personal", "business", "project", "health", "home", "guest", "shared"] as const;

/**
 * Del 3 (JARVIS-005/012): identiteten en delegert jobb handler med kommer fra den SIGNERTE kontrakten (som `TaskService.submit` har
 * bundet til den grant-autentiserte personen/tenanten) - aldri en fast worker-/system-identitet og aldri modellargumenter.
 * Memory space = kontraktens første tillatte rom (ellers `project`); `session_id` er unikt per jobb.
 */
export function jobIdentityFor<T extends { memory_space_id: string; session_id: string; person_id: string; tenant_id: string }>(
  base: T,
  contract: { owner_person_id: string; tenant_id: string; task_id: string; allowed_memory_spaces: readonly string[] }
): T {
  const space = contract.allowed_memory_spaces.find((s): s is (typeof JOB_MEMORY_SPACES)[number] => (JOB_MEMORY_SPACES as readonly string[]).includes(s));
  return {
    ...base,
    person_id: contract.owner_person_id,
    tenant_id: contract.tenant_id,
    memory_space_id: space ?? "project",
    session_id: `job:${contract.task_id}`
  };
}
