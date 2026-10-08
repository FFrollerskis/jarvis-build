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
 * Teksten må selv ALDRI inneholde et ord sensitivitetsklassifiseringen reagerer på (ellers ville merknaden holdt samtalen låst lokalt videre) - låst av en test.
 * NB: det gjelder også ord som ikke handler om penger. Mønsteret `gjeld…` fanger verbet «gjelder/gjelde/gjeldende», så ordet unngås her (testen fanget det).
 * Kun kategorier vises, aldri innhold.
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
