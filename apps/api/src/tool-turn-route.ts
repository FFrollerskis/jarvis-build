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
