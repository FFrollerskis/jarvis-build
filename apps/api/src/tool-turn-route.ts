/**
 * D-431: hvor verktøyturer i chatten sendes. Ren prat går til den lokale modellen (gratis); når et ekte verktøy er valgt for turen går den til en
 * skymodell, fordi en liten lokal modell bruker verktøy upålitelig. Styres av `JARVIS_TOOL_TURN_MODEL` = `provider:model`
 * (f.eks. `anthropic:claude-sonnet-5-5` eller `anthropic:claude-haiku-4-5-20251001`). Standard (ikke satt) er Sonnet 5.5.
 * `off`/`local`/`none` slår det av (alt går lokalt, som før). Ugyldig verdi feiler lukket til «av» med en tydelig logg - aldri en tilfeldig modell.
 */
export interface ToolTurnRoute {
  provider: string;
  model: string;
}

export const DEFAULT_TOOL_TURN_ROUTE: ToolTurnRoute = { provider: "anthropic", model: "claude-sonnet-5-5" };

const PROVIDER = /^[a-z0-9_]{1,40}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export function parseToolTurnRoute(raw: string | undefined): ToolTurnRoute | null {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_TOOL_TURN_ROUTE;
  if (/^(off|local|none|false)$/i.test(value)) return null;
  const at = value.indexOf(":");
  const provider = at > 0 ? value.slice(0, at) : "";
  const model = at > 0 ? value.slice(at + 1) : "";
  if (!PROVIDER.test(provider) || !MODEL.test(model)) {
    console.error(JSON.stringify({ msg: "tool_turn_route_invalid", reason: "forventet provider:model eller off", fallback: "off" }));
    return null;
  }
  return { provider, model };
}

/**
 * D-432: dagstak (øre) for samlet modellkostnad i dag. Når taket er nådd går verktøyturer til lokal modell (med en synlig merknad) til neste døgn.
 * `JARVIS_TOOL_TURN_DAILY_CAP_ORE`: tom = standard 3000 øre (30 kr); `0` = ingen tak; ugyldig = standard (aldri «ubegrenset» ved en feil).
 */
export const DEFAULT_TOOL_TURN_DAILY_CAP_ORE = 3000;

export function parseDailyCapOre(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_TOOL_TURN_DAILY_CAP_ORE;
  if (!/^\d{1,9}$/.test(value)) {
    console.error(JSON.stringify({ msg: "tool_turn_daily_cap_invalid", fallback_ore: DEFAULT_TOOL_TURN_DAILY_CAP_ORE }));
    return DEFAULT_TOOL_TURN_DAILY_CAP_ORE;
  }
  return Number.parseInt(value, 10);
}

/**
 * D-447 (NAS-test 2026-10-08): en verktøytur som ellers ville gått til sky, men som sensitivitetsreglene (D-378: helse/økonomi/hemmeligheter går aldri til sky)
 * tvinger til den lokale modellen, SKAL si det. Uten merknaden fikk eieren et uleselig svar fra en liten lokal modell uten å vite hvorfor - Jarvis' eget forrige
 * svar hadde nevnt et økonomiord, og de siste meldingene i samtalen teller med (D-384). Reglene er uendret; dette gjør bare valget synlig.
 *
 * Merknaden lagres i samtalen som en del av svaret og må ikke selv låse samtalen lokalt videre. Q-52 A (D-450) la «helse» til i klassifiseringens ordforråd, og merknaden bruker nettopp det ordet for å si hva som ble beskyttet.
 * Derfor garanteres nøytraliteten nå STRUKTURELT: `stripSystemNotes` fjerner en slik avsluttende merknad fra assistent-radene FØR historikken klassifiseres og sendes til noen modell (låst av tester), i stedet for å
 * love at ordforrådet aldri vokser inn i teksten. Kun kategorier vises, aldri innhold.
 */
const LOCAL_ONLY_AREAS: Readonly<Record<string, { area: string; from: "text" | "memory" }>> = {
  "text:finance": { area: "økonomi", from: "text" },
  "text:health": { area: "helse", from: "text" },
  "text:secret": { area: "nøkler eller hemmeligheter", from: "text" },
  "memory_space:health": { area: "helseminnet", from: "memory" },
  "memory_sensitivity:special": { area: "minne merket som særlig sensitivt", from: "memory" }
};

const joinNo = (items: readonly string[]): string => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} og ${items[items.length - 1]}`);

export function localOnlyNote(reasons: readonly string[]): string {
  const areas = (from: "text" | "memory"): string[] => [...new Set(reasons.flatMap((r) => (LOCAL_ONLY_AREAS[r]?.from === from ? [LOCAL_ONLY_AREAS[r]!.area] : [])))];
  const fromText = areas("text");
  const fromMemory = areas("memory");
  const parts: string[] = [];
  if (fromText.length > 0) parts.push(`meldingen eller de siste meldingene berører ${joinNo(fromText)}`);
  if (fromMemory.length > 0) parts.push(`${joinNo(fromMemory)} ble brukt som kontekst`);
  const why = parts.length > 0 ? parts.join(", og ") : "innholdet er klassifisert som følsomt";
  const hint = fromText.length > 0 ? " Dette varer til emnet ikke lenger er blant de siste meldingene." : "";
  return `\n\n(Svart på den lokale modellen: ${why}, og slikt sendes aldri til skyen.${hint})`;
}

/**
 * D-449 (Q-50, gjennomgang nr. 2): merknaden i svaret på «… i bakgrunnen» når jobben kjører på den lokale modellen i stedet for skyruten (eierens ruteoverstyring, innlimt tekst, en samtale som nylig berørte
 * økonomi/helse/hemmeligheter, helse-minnerom, eller en historikk som ikke kunne leses). Samme prinsipp som D-447: aldri en usynlig nedgradering, kun kategorier (aldri innhold), og teksten må selv ikke
 * inneholde ord sensitivitetsklassifiseringen reagerer på (svaret lagres i samtalen) - låst av en test.
 */
const JOB_LOCAL_REASONS: Readonly<Record<string, string>> = {
  // Gjelder enhver instruks om modellvalg i meldingen («kun lokale modeller», «bruk Claude», «ikke bruk AI-rådet» ...): en bakgrunnsjobb kan ikke velge modell per melding, så den holdes lokal.
  owner_routing_override: "meldingen har en egen instruks om modellvalg, og slike jobber holdes lokale",
  explicit_provider: "denne enheten eller økten er satt til en bestemt modell",
  pasted_content: "innlimt tekst regnes ikke som dine egne ord",
  routing_unreadable: "samtalen kunne ikke kontrolleres",
  "tool_selection:SECRET_RESTRICTED": "meldingen peker på økonomitjenester, og slikt sendes aldri til skyen",
  // Gjennomgang nr. 4: samtalen var ren, men selve jobbteksten (tittel + prompt) berører økonomi, helse eller hemmeligheter, så transporten ga ikke jobben skyflagget.
  job_text_gate: "selve jobbteksten berører økonomi, helse eller hemmeligheter, og slikt sendes aldri til skyen"
};

export function jobLocalOnlyNote(reasons: readonly string[]): string {
  const areas = [...new Set(reasons.flatMap((r) => (LOCAL_ONLY_AREAS[r] ? [LOCAL_ONLY_AREAS[r]!.area] : [])))];
  const parts: string[] = [];
  if (areas.length > 0) parts.push(`samtalen berører ${joinNo(areas)}, og slikt sendes aldri til skyen`);
  for (const reason of reasons) if (JOB_LOCAL_REASONS[reason]) parts.push(JOB_LOCAL_REASONS[reason]!);
  const why = parts.length > 0 ? parts.join(", og ") : "innholdet er klassifisert som følsomt";
  return `\n\n(Jobben kjører på den lokale modellen: ${why}.)`;
}

/**
 * D-404/D-431/D-444/D-449: leverandørfeil som får en flate til å svare via en ANNEN rute (lokal modell) i stedet for å vise en feil - kun FØR noe er sendt og FØR noe verktøy er
 * utført. `invalid_response` (D-444) er et tomt eller ubrukelig svar som gatewayen ikke kunne redde med retry/neste kandidat (D-441 gjør det til en ærlig feil
 * i stedet for en stille tom melding): for eieren er en lokal modell som svarer tomt det samme som en lokal modell som er nede. Delt av chatten (`conversation.ts`)
 * og delegerte bakgrunnsjobber (`executive.ts`, D-449), så de to aldri er uenige om hva som er en «rute er nede»-feil.
 */
export const LOCAL_FALLBACK_ERROR_KINDS: readonly string[] = ["timeout", "network", "server", "rate_limit", "not_configured", "invalid_response"];

/**
 * D-449 (Q-50): dagstak-merknaden for en delegert bakgrunnsjobb (samme regel og tak som chatten, D-432). Står FORAN jobbens svartekst (leveringsvisningen avkorter svaret bakfra, så en merknad
 * bakerst kunne forsvunnet), som leveres til samtalen som DATA. Teksten må selv ikke inneholde ord sensitivitetsklassifiseringen reagerer på (samme vakt som `localOnlyNote`).
 */
export function jobDayCapNote(capOre: number): string {
  return `(Dagstaket for sky på ${Math.round(capOre / 100)} kr er nådd i dag, så jobben kjørte på den lokale modellen. Taket nullstilles i morgen.)`;
}

/**
 * D-449 (Q-50): en egen bryter for DELEGERTE JOBBERS skyrute (`JARVIS_JOB_TOOL_TURN_MODEL`), slik at eieren kan slå den av uten å slå av chattens verktøyruting. Tom/ikke satt = samme rute som
 * chatten (`JARVIS_TOOL_TURN_MODEL`); `off`/`local`/`none` = jobber kjører lokalt; ellers `provider:model` (kan f.eks. være en billigere modell enn chattens). Ugyldig verdi = av (aldri en tilfeldig modell).
 */
export function resolveJobToolTurnRoute(rawJobRoute: string | undefined, chatRoute: ToolTurnRoute | null): ToolTurnRoute | null {
  if ((rawJobRoute ?? "").trim() === "") return chatRoute;
  return parseToolTurnRoute(rawJobRoute);
}

/**
 * Q-53 A (D-450, Tobias 2026-10-09: «Ja til alle Q»): D-431 sier at ren prat - turer der KUN minne-reserven er valgt - forblir på den lokale modellen, og at først et ekte verktøy sender turen til skymodellen.
 * Koden sjekket tidligere `name.startsWith("memory__")`, men minneverktøyene heter `search_my_memory` og `suggest_memory` i produksjon (tjeneste `memory`, handlingene `search` og `propose`), så «reserven» ble aldri gjenkjent og
 * nesten alle meldinger som ikke var småprat gikk til Sonnet. Nå avgjøres det STRUKTURELT: utvalget oppgir `tool_id` for hvert valgte verktøy (`tool_ids`, samme rekkefølge som definisjonene), og turen er «kun minne»
 * når alle tilhører tjenesten `memory`. Uten `tool_ids` (eldre/testoppsett) brukes de kjente navnene (`search_my_memory`, `suggest_memory`) og det eldre `memory__`-prefikset. Ingen definisjoner = ingen verktøytur.
 */
const MEMORY_RESERVE_TOOL_NAMES: ReadonlySet<string> = new Set(["search_my_memory", "suggest_memory"]);
export function isMemoryReserveOnly(definitions: ReadonlyArray<{ name: string }>, toolIds?: ReadonlyArray<string>): boolean {
  if (definitions.length === 0) return true;
  if (toolIds !== undefined && toolIds.length === definitions.length) return toolIds.every((id) => id === "memory");
  return definitions.every((d) => d.name.startsWith("memory__") || MEMORY_RESERVE_TOOL_NAMES.has(d.name));
}

/**
 * Q-51 D (D-450): merknaden i svaret når en skybundet verktøytur ble sendt UTEN de enkelte følsomme meldingene (og parene deres) i stedet for å låses til den lokale modellen. Samme prinsipp som D-447: aldri en usynlig
 * endring, kun antall (aldri innhold). Ingen parenteser inne i teksten (se `stripSystemNotes`).
 */
export function cloudHistoryNote(withheld: number): string {
  const what = withheld === 1 ? "1 tidligere melding" : `${withheld} tidligere meldinger`;
  return `\n\n(Svart på skymodellen uten ${what}: de berører følsomme emner, og slikt sendes aldri til skyen. Nevn emnet i spørsmålet hvis du vil ha dem med, så svarer den lokale modellen.)`;
}

/**
 * Starten på hver rutemerknad Jarvis selv legger bak et svar (chatten: `localOnlyNote`, dagstaket, `cloudHistoryNote`, skjermet minnesøk; hurtigbanen: `jobLocalOnlyNote`). Listen og `stripSystemNotes` hører sammen og er låst av en test
 * mot hver funksjon som lager en merknad.
 */
const SYSTEM_NOTE_PREFIXES: readonly string[] = [
  "Svart på den lokale modellen:",
  "Jobben kjører på den lokale modellen:",
  "Dagstaket for sky på",
  "Svart på skymodellen uten",
  "Deler av minnesøket ble holdt tilbake"
];
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TRAILING_SYSTEM_NOTE = new RegExp(`(?:\\n\\n|^)\\((?:${SYSTEM_NOTE_PREFIXES.map(escapeRegExp).join("|")})[^()]*\\)\\s*$`);

/**
 * Fjerner avsluttende rutemerknader fra et assistent-svar slik det ligger i samtalehistorikken. Merknadene er til EIEREN (hvorfor svaret kom fra en bestemt modell); de er ikke en del av samtalen modellen skal se, og de skal
 * heller ikke telle med når historikken klassifiseres (Q-52 A la «helse» til ordforrådet, og merknaden bruker det ordet for å si hva som ble beskyttet - uten stripping ville merknaden selv holdt samtalen låst lokalt).
 * Sikkert ved konstruksjon: det som fjernes sendes heller ikke til noen modell, så en modell som later som den skriver en merknad kan ikke skjule innhold FOR klassifiseringen mens det likevel når en modell.
 */
export function stripSystemNotes(content: string): string {
  let out = content;
  for (let round = 0; round < 4; round += 1) {
    const next = out.replace(TRAILING_SYSTEM_NOTE, "");
    if (next === out) break;
    out = next;
  }
  return out;
}
