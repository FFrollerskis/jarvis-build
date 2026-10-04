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
/**
 * D-381: intensjonsord per verktøy-id for chattens lese-nivå (norsk + engelsk). Kun UTVALG (hva modellen får se denne runden) - aldri
 * autorisasjon; hele nivået er allerede låst av `SURFACE_TOOL_GRANTS`. Uten oppføring brukes selve verktøy-id-en som nøkkelord.
 */
const TOOL_INTENTS: Readonly<Record<string, RegExp>> = {
  finance_neonomics: /(bank|konto|saldo|neonomics|transaksjon|samtykke|kontoutskrift|innskudd|uttak)/i,
  finance_stripe: /(stripe|kortbetaling|refusjon)/i,
  finance_vipps: /(vipps)/i,
  finance_wallester: /(wallester|bankkort|\bkort\b|kortbruk)/i,
  finance_spend: /(utgift|abonnement|innkjøp|forbruk|\bspend\b|faste kostnader|budsjett|\bkostnad)/i,
  notion: /(notion)/i,
  slack: /(slack)/i,
  discord: /(discord)/i,
  telegram: /(telegram)/i,
  drive: /(drive|dokument|\bfil(er)?\b|google docs)/i,
  dropbox: /(dropbox)/i,
  onedrive: /(onedrive)/i,
  google_sheets: /(sheets|regneark)/i,
  microsoft_outlook: /(outlook)/i,
  todoist: /(todoist|gjøremål|oppgaveliste|to-?do)/i,
  contract: /(kontrakt|avtaler\b|fornyelse)/i,
  support: /(support|billett|ticket|kundehenvendelse)/i,
  business: /(forretning|selskap|åpne saker|oppfølging|metrikk)/i,
  growth: /(kampanje|markedsføring|vekst)/i,
  googleads: /(google ?ads|annonse)/i,
  metaads: /(meta ?ads|facebook|instagram|annonse)/i,
  vercel: /(vercel|utrulling|deploy)/i,
  sentry: /(sentry|feillogg|exception)/i,
  brave_search: /(søk (på )?nett|nettsøk|websøk|google|nyheter|brave)/i,
  tavily: /(tavily|søk (på )?nett|nettsøk|nyheter)/i,
  google_maps: /(kart|adresse|koordinat)/i,
  google_places: /(sted|restaurant|butikk|åpningstid)/i,
  google_routes: /(rute|veibeskrivelse|kjøretid|avstand)/i,
  spotify: /(spotify|musikk|spilles)/i,
  twilio: /(twilio|\bsms\b)/i,
  whatsapp: /(whatsapp)/i
};
const GENERIC_SKIP = new Set(["finance", "google", "conversation", "graph", "openai"]);
const toolIntentCache = new Map<string, RegExp | null>();
function toolIntent(tool_id: string): RegExp | null {
  const known = TOOL_INTENTS[tool_id];
  if (known) return known;
  let cached = toolIntentCache.get(tool_id);
  if (cached === undefined) {
    const words = tool_id.split("_").filter((w) => w.length >= 4 && !GENERIC_SKIP.has(w));
    cached = words.length > 0 ? new RegExp(`(${words.join("|")})`, "i") : null;
    toolIntentCache.set(tool_id, cached);
  }
  return cached;
}
/** D-382: handlingsnivået velges kun når meldingen uttrykker en handling (ikke bare nevner tjenesten). */
const ACTION_VERBS = /(send|sende|opprett|lag\b|lage|legg (til|inn)|oppdater|endre|flytt|slett|fjern|arkiver|lukk|åpne? (igjen|på nytt)|svar\b|svare|synk|synkroniser|book|bestill|sett\b|registrer|fullfør|marker|tildel|eskaler|avbryt|kanseller|pause|gjenoppta|aktiver|kommenter|publiser|kjør|start|create|update|add|move|delete|remove|reply|sync|close|assign|schedule|post)/i;
/** D-382: handlingsord → handlingsnavn-prefiks, så den handlingen eieren faktisk ber om rangeres først innenfor budsjettet. */
const VERB_TO_ACTION: ReadonlyArray<[RegExp, RegExp]> = [
  [/synk|synkroniser|sync|avstem/i, /^(sync|reconcile)/],
  [/opprett|lag\b|lage|legg (til|inn)|registrer|create|add|book|bestill|ny\b/i, /^(create|add|append|record|register|ingest)/],
  [/oppdater|endre|sett\b|update|set\b|marker|tildel|assign|link/i, /^(update|set|assign|link|transition|rename)/],
  [/slett|fjern|arkiver|delete|remove|trash|papirkurv/i, /^(trash|delete|remove|archive)/],
  [/send|svar|kommenter|notify|reply|post|varsle|si fra/i, /^(notify|send|reply|comment|publish|dispatch)/],
  [/lukk|fullfør|close|complete|ferdig/i, /^(close|complete)/],
  [/åpne? (igjen|på nytt)|reopen|gjenoppta|resume/i, /^(reopen|resume)/],
  [/flytt|move/i, /^move/],
  [/pause|avbryt|kanseller|cancel|stopp/i, /^(pause|cancel|defer)/],
  [/eskaler|escalate/i, /^escalate/],
  [/aktiver|activate|kjør|run|start/i, /^(activate|run|rerun|start)/]
];
function verbMatches(action: string, text: string): boolean {
  return VERB_TO_ACTION.some(([verb, prefix]) => verb.test(text) && prefix.test(action));
}
/** Finans-verktøy (`finance_*`) gjør turen SECRET_RESTRICTED (D-378: kun lokal modell) - uavhengig av hvordan meldingen er formulert. */
const RESTRICTED_TOOL_ID = /^finance(_|$)/;

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
  /** D-381: laveste sensitivitet turen MÅ ha fordi verktøyene som ble valgt eksponerer data i den klassen. */
  min_sensitivity?: "SECRET_RESTRICTED";
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
  const wantsAction = ACTION_VERBS.test(text);
  let wanted = allowed.filter((m) => {
    const key = mappingKey(m);
    const intent = INTENT_KEYWORDS[key] ?? toolIntent(m.tool_id);
    const hit = (intent?.test(text) ?? false) || (overview && OVERVIEW_KEYS.has(key));
    // D-382: handlinger kun når eieren faktisk ber om en handling - ellers kun lesing.
    return m.kind === "act" ? hit && wantsAction : hit;
  });
  if (wanted.length === 0) wanted = allowed.filter((m) => mappingKey(m) === "memory.search");
  // Rangering innenfor budsjettet: faste prioriteter → handlingen eieren ba om (verbtreff) → lesinger → øvrige handlinger.
  const rank = (m: MeshToolMapping): number => {
    const i = ALWAYS_PRIORITY.indexOf(mappingKey(m));
    if (i !== -1) return i;
    if (m.kind === "act") return verbMatches(m.action, text) ? 10 : 30;
    return 20;
  };
  wanted.sort((a, b) => rank(a) - rank(b));

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
  const restricted = selected.some((m) => RESTRICTED_TOOL_ID.test(m.tool_id));
  return { selected, schema_tokens: tokens, limits, dropped, ...(restricted ? { min_sensitivity: "SECRET_RESTRICTED" as const } : {}) };
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
