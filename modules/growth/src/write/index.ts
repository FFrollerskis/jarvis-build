import type { ToolDefinition, ToolTransport } from "@jarvis/tool-gateway";
import { GROWTH_WRITE_PROVIDERS, growthWriteConfigFromEnv, type GrowthProvider, type GrowthWriteConfig } from "./config.ts";
import { Ga4WriteTransport, ga4WriteSpec } from "./ga4-write.ts";
import { GbpWriteTransport, gbpWriteSpec } from "./gbp-write.ts";
import { GoogleAdsWriteTransport, googleAdsWriteSpec } from "./google-ads-write.ts";
import { LinkedinWriteTransport, linkedinWriteSpec } from "./linkedin-write.ts";
import { MetaAdsWriteTransport, metaAdsWriteSpec } from "./meta-ads-write.ts";
import { SearchConsoleWriteTransport, searchConsoleWriteSpec } from "./search-console-write.ts";
import { TiktokWriteTransport, tiktokWriteSpec } from "./tiktok-write.ts";
import { buildGrowthToolDefinitions, type OpSpec, type ProviderToolSpec, type WriteTransportDeps } from "./tool-factory.ts";
import { YoutubeWriteTransport, youtubeWriteSpec } from "./youtube-write.ts";

export * from "./config.ts";
export * from "./executor.ts";
export * from "./journal.ts";
export { GrowthWriteTransportBase, buildGrowthToolDefinitions, composeValidator, killSwitchOpen, type OpSpec, type ProviderToolSpec, type WriteTransportDeps } from "./tool-factory.ts";
export { GoogleAdsWriteTransport, googleAdsWriteSpec } from "./google-ads-write.ts";
export { MetaAdsWriteTransport, metaAdsWriteSpec, TWO_DECIMAL_CURRENCIES } from "./meta-ads-write.ts";
export { Ga4WriteTransport, ga4WriteSpec } from "./ga4-write.ts";
export { SearchConsoleWriteTransport, searchConsoleWriteSpec, urlBelongsToSite } from "./search-console-write.ts";
export { GbpWriteTransport, gbpWriteSpec } from "./gbp-write.ts";
export { YoutubeWriteTransport, youtubeWriteSpec } from "./youtube-write.ts";
export { LinkedinWriteTransport, linkedinWriteSpec, decimalToOre, oreToDecimal } from "./linkedin-write.ts";
export { TiktokWriteTransport, tiktokWriteSpec } from "./tiktok-write.ts";

/**
 * WP-D3 (UA-4 Growth, D-459): ALLE åtte leverandør-spesifikasjonene (ren data - ingen nettverk, ingen hemmeligheter). Brukes av registreringen, eksekutoren (risikoklasse/målstreng), vaktene og runbook-tallene.
 * Verktøy-id-ene er eier-eksklusive navnerom og står i `OWNER_ONLY_NAMESPACES` og `FORBIDDEN_MODEL_TOOL_IDS` - ingen av handlingene kan noen gang stå på en modellflate.
 */
export function growthWriteSpecs(config: Pick<GrowthWriteConfig, "creativeHosts">): Record<GrowthProvider, ProviderToolSpec> {
  return {
    google_ads: googleAdsWriteSpec(config), meta_ads: metaAdsWriteSpec(config), ga4: ga4WriteSpec(), search_console: searchConsoleWriteSpec(),
    google_business_profile: gbpWriteSpec(config), linkedin: linkedinWriteSpec(), youtube: youtubeWriteSpec(), tiktok: tiktokWriteSpec()
  };
}

/** Alle verktøy-id-ene (navnerommene) skrive-familien bruker. */
export const GROWTH_WRITE_TOOL_IDS: readonly string[] = ["growth_googleads", "growth_metaads", "growth_ga4", "growth_searchconsole", "growth_gbp", "growth_linkedin", "growth_youtube", "growth_tiktok"];

/** Oppslag `provider.action` -> (spesifikasjon, handling). Eksekutoren avviser alt som ikke står her (aldri en vilkårlig verktøy-/handlingsstreng fra klienten). */
export function growthOpIndex(specs: Record<GrowthProvider, ProviderToolSpec>): ReadonlyMap<string, { spec: ProviderToolSpec; op: OpSpec }> {
  const index = new Map<string, { spec: ProviderToolSpec; op: OpSpec }>();
  for (const provider of GROWTH_WRITE_PROVIDERS) for (const op of specs[provider].ops) index.set(`${provider}.${op.action}`, { spec: specs[provider], op });
  return index;
}

export interface GrowthWriteRuntime extends WriteTransportDeps {
  /** Leser en hemmelighet/konfig via vault-referanse (aldri fra parametre). */
  readSecret: (ref: string) => Promise<string | null>;
  env: Record<string, string | undefined>;
  /** Injiserbart i tester (standard: den delte `googleAccessToken`). */
  googleAccessToken?: (refreshToken: string) => Promise<string>;
  baseUrls?: Partial<Record<GrowthProvider | "gbp_v4" | "search_console_inspect", string>>;
  sleep?: (ms: number) => Promise<void>;
}

/** Bygger transportene for de PLATTFORMENE som står i `JARVIS_GROWTH_WRITE_PLATFORMS`. Ingen plattform i listen = ingen transport = ingen verktøy (flagg AV er identisk med main). */
export function createGrowthWriteTransports(config: GrowthWriteConfig, runtime: GrowthWriteRuntime): Partial<Record<GrowthProvider, ToolTransport>> {
  const specs = growthWriteSpecs(config);
  const common = { ...(runtime.financeKillSwitch ? { financeKillSwitch: runtime.financeKillSwitch } : {}), ...(runtime.sleep ? { sleep: runtime.sleep } : {}) };
  const google = { ...common, ...(runtime.googleAccessToken ? { accessToken: runtime.googleAccessToken } : {}) };
  const base = (key: GrowthProvider | "gbp_v4" | "search_console_inspect") => (runtime.baseUrls?.[key] !== undefined ? { baseUrl: runtime.baseUrls[key] as string } : {});
  const out: Partial<Record<GrowthProvider, ToolTransport>> = {};
  for (const provider of config.platforms) {
    switch (provider) {
      case "google_ads":
        out.google_ads = new GoogleAdsWriteTransport({
          ...google, spec: specs.google_ads, ...base("google_ads"), apiVersion: runtime.env["JARVIS_GOOGLE_ADS_API_VERSION"] ?? "",
          developerToken: () => runtime.readSecret("JARVIS_GOOGLE_ADS_DEVELOPER_TOKEN"), loginCustomerId: () => runtime.readSecret("JARVIS_GOOGLE_ADS_LOGIN_CUSTOMER_ID")
        });
        break;
      case "meta_ads":
        out.meta_ads = new MetaAdsWriteTransport({ ...common, spec: specs.meta_ads, ...base("meta_ads"), apiVersion: runtime.env["JARVIS_META_ADS_API_VERSION"] ?? "" });
        break;
      case "ga4": out.ga4 = new Ga4WriteTransport({ ...google, spec: specs.ga4, ...base("ga4") }); break;
      case "search_console":
        out.search_console = new SearchConsoleWriteTransport({ ...google, spec: specs.search_console, ...base("search_console"), ...(runtime.baseUrls?.search_console_inspect ? { inspectBaseUrl: runtime.baseUrls.search_console_inspect } : {}) });
        break;
      case "google_business_profile":
        out.google_business_profile = new GbpWriteTransport({ ...google, spec: specs.google_business_profile, ...base("google_business_profile"), ...(runtime.baseUrls?.gbp_v4 ? { v4BaseUrl: runtime.baseUrls.gbp_v4 } : {}) });
        break;
      case "youtube": out.youtube = new YoutubeWriteTransport({ ...google, spec: specs.youtube, ...base("youtube") }); break;
      case "linkedin": out.linkedin = new LinkedinWriteTransport({ ...common, spec: specs.linkedin, ...base("linkedin"), apiVersion: runtime.env["JARVIS_LINKEDIN_API_VERSION"] ?? "" }); break;
      case "tiktok": out.tiktok = new TiktokWriteTransport({ ...common, spec: specs.tiktok, ...base("tiktok") }); break;
    }
  }
  return out;
}

/** ToolDefinitions for de aktiverte plattformene (en plattform uten transport registreres aldri). Tom konfigurasjon = tom liste. */
export function growthWriteToolDefinitions(config: GrowthWriteConfig, transports: Partial<Record<GrowthProvider, ToolTransport>>): ToolDefinition[] {
  const specs = growthWriteSpecs(config);
  const out: ToolDefinition[] = [];
  for (const provider of GROWTH_WRITE_PROVIDERS) {
    const transport = transports[provider];
    if (!config.platforms.has(provider) || transport === undefined) continue;
    out.push(...buildGrowthToolDefinitions(specs[provider], transport, config));
  }
  return out;
}

/** Praktisk: les konfigurasjonen fra miljøet (kun navnene dokumentert i `.env.example`). */
export { growthWriteConfigFromEnv };
