import type { JsonValue } from "@jarvis/contracts";

/**
 * WP-D3 (UA-4 Growth, D-459): konfigurasjon og MÅL-AUTORISASJON for skrivehandlingene mot annonse-/analyseplattformene.
 *
 * Samme modell som Cloudflare (`cloudflare-target-policy.ts`, WP-E1): transportene transporterer, mål-autorisasjonen håndheves av `ToolGateway.execute()` selv via
 * `ToolDefinition.parameterAuthorizer` (aldri en regel inni transporten som kan omgås). Fail-closed i alle retninger:
 *  - SKRIVING er AV med mindre plattformen står i `JARVIS_GROWTH_WRITE_PLATFORMS` (tom/ukjent = ingen verktøy registreres, ingen rute åpnes).
 *  - Målet (eierens EGEN konto/eiendom/lokasjon) MÅ stå EKSAKT i `JARVIS_GROWTH_WRITE_TARGETS` (`<plattform>:<id>`, kommaseparert, ingen jokertegn). Tom liste = ingen skriving.
 *    En ugyldig enkeltoppføring HOPPES OVER (aldri en løs/gjettet autorisasjon for resten av listen).
 *  - Akseptanse/test kjøres mot SANDBOX-/testkontoer eieren selv legger i listen (blast radius, D-41) - ingenting her sier at produksjonstilgang er begrenset.
 *  - Kreativer med mål-URL krever at verten står EKSAKT i `JARVIS_GROWTH_CREATIVE_URL_HOSTS` (forsvar mot at ubetrodd tekst omdirigerer annonsetrafikk).
 * Identifikatorer valideres STRENGT før de brukes i en URL-sti eller GAQL (ingen sti-/spørringsinjeksjon).
 */
export const GROWTH_WRITE_PROVIDERS = ["google_ads", "meta_ads", "ga4", "search_console", "google_business_profile", "linkedin", "youtube", "tiktok"] as const;
export type GrowthProvider = (typeof GROWTH_WRITE_PROVIDERS)[number];

export interface GrowthWriteConfig {
  readonly platforms: ReadonlySet<GrowthProvider>;
  readonly targets: ReadonlyMap<GrowthProvider, ReadonlySet<string>>;
  readonly creativeHosts: ReadonlySet<string>;
}

const DIGITS = (min: number, max: number) => new RegExp(`^\\d{${min},${max}}$`);

/** Normaliserer en rå mål-id til kanonisk form, eller `null` hvis den er ugyldig for plattformen. Eksakt formkontroll - ingen gjetting. */
export function normalizeGrowthTarget(provider: GrowthProvider, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  switch (provider) {
    case "google_ads": {
      const id = value.replace(/-/g, "");
      return DIGITS(10, 10).test(id) ? id : null;
    }
    case "meta_ads": {
      const id = value.replace(/^act_/, "");
      return DIGITS(5, 20).test(id) ? id : null;
    }
    case "ga4": {
      const id = value.replace(/^properties\//, "");
      return DIGITS(4, 20).test(id) ? id : null;
    }
    case "search_console":
      // URL-prefiks-eiendom (https://example.com/ - MÅ slutte på «/») eller domeneeiendom (sc-domain:example.com).
      return /^https:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?\/[A-Za-z0-9._~%/-]{0,200}$/i.test(value) || /^sc-domain:[a-z0-9.-]{1,253}$/i.test(value) ? value : null;
    case "google_business_profile": {
      const id = value.replace(/^locations\//, "");
      return DIGITS(4, 25).test(id) ? id : null;
    }
    case "linkedin": {
      const id = value.replace(/^urn:li:sponsoredAccount:/, "");
      return DIGITS(4, 20).test(id) ? id : null;
    }
    case "youtube":
      return /^UC[A-Za-z0-9_-]{22}$/.test(value) ? value : null;
    case "tiktok":
      return DIGITS(5, 25).test(value) ? value : null;
  }
}

/** Parser `JARVIS_GROWTH_WRITE_PLATFORMS` (kommaseparert). Ukjente navn hoppes over; tom/manglende -> tomt sett (AV). */
export function parseGrowthWritePlatforms(raw: string | undefined | null): ReadonlySet<GrowthProvider> {
  const out = new Set<GrowthProvider>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if ((GROWTH_WRITE_PROVIDERS as readonly string[]).includes(name)) out.add(name as GrowthProvider);
  }
  return out;
}

/** Parser `JARVIS_GROWTH_WRITE_TARGETS`: `<plattform>:<id>` kommaseparert. EKSAKT match senere; ugyldige oppføringer hoppes over. */
export function parseGrowthWriteTargets(raw: string | undefined | null): ReadonlyMap<GrowthProvider, ReadonlySet<string>> {
  const out = new Map<GrowthProvider, Set<string>>();
  if (!raw) return out;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    const cut = trimmed.indexOf(":");
    if (cut < 1) continue;
    const provider = trimmed.slice(0, cut).toLowerCase();
    if (!(GROWTH_WRITE_PROVIDERS as readonly string[]).includes(provider)) continue;
    const id = normalizeGrowthTarget(provider as GrowthProvider, trimmed.slice(cut + 1));
    if (id === null) continue;
    const set = out.get(provider as GrowthProvider) ?? new Set<string>();
    set.add(id);
    out.set(provider as GrowthProvider, set);
  }
  return out;
}

/** Parser `JARVIS_GROWTH_CREATIVE_URL_HOSTS`: eksakte vertsnavn (ingen jokertegn, ingen skjema/sti). Ugyldige hoppes over. */
export function parseCreativeUrlHosts(raw: string | undefined | null): ReadonlySet<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const host = part.trim().toLowerCase();
    if (/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) out.add(host);
  }
  return out;
}

export function growthWriteConfigFromEnv(env: Record<string, string | undefined>): GrowthWriteConfig {
  return {
    platforms: parseGrowthWritePlatforms(env["JARVIS_GROWTH_WRITE_PLATFORMS"]),
    targets: parseGrowthWriteTargets(env["JARVIS_GROWTH_WRITE_TARGETS"]),
    creativeHosts: parseCreativeUrlHosts(env["JARVIS_GROWTH_CREATIVE_URL_HOSTS"])
  };
}

export interface TargetAuthorization {
  allowed: boolean;
  reason: string;
}

/**
 * Fail-closed mål-autorisasjon (kjøres av gatewayen for HVER handling i skrive-familien, også lesingene): målet må være gyldig for plattformen OG stå eksakt i eierens liste.
 * `parameters[targetParam]` kan være oppgitt i en tolerant form (`act_123`, `123-456-7890`); den normaliseres før sammenligning.
 */
export function authorizeGrowthTarget(provider: GrowthProvider, targetParam: string, parameters: Record<string, JsonValue>, config: Pick<GrowthWriteConfig, "targets">): TargetAuthorization {
  const target = normalizeGrowthTarget(provider, parameters[targetParam]);
  if (target === null) return { allowed: false, reason: "missing_or_invalid_target" };
  if (!config.targets.get(provider)?.has(target)) return { allowed: false, reason: "growth_target_not_authorized" };
  return { allowed: true, reason: "owner_configured_target" };
}

/**
 * Review L2: en WHATWG-parser og en RFC 3986-parser leser IKKE alltid samme vert i samme streng: «https://allowed.test<backslash>@evil.test/x» har vert `allowed.test` for WHATWG (backslash = skråstrek), men
 * brukerinfo og vert `evil.test` for en RFC 3986-parser (leverandørens), og tab/linjeskift fjernes stille av WHATWG. Forsvaret er tredelt: (1) tegn som gir parser-forskjeller (backslash, kontrolltegn) avvises,
 * (2) kun standardport (en ikke-tom port avvises), og (3) det som SENDES er alltid den normaliserte `href` fra WHATWG (aldri råstrengen), slik at vertssjekken og leverandøren ser nøyaktig samme URL.
 */
const PARSER_DIFFERENTIAL_CHARS = /[\\\p{Cc}]/u;

/** `true` når strengen har tegn som gir ulik lesing i ulike URL-parsere (backslash, kontrolltegn). Brukes også av Search Console-URL-ene (nettstedskart/inspeksjon). */
export const hasParserDifferentialChars = (value: string): boolean => PARSER_DIFFERENTIAL_CHARS.test(value);

function parseCreativeUrl(url: unknown): URL | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048 || PARSER_DIFFERENTIAL_CHARS.test(url)) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null;
  return parsed;
}

/** Normalisert `href` for en kreativ-URL (https, ingen brukerinfo, standardport, ingen backslash/kontrolltegn) hvis verten står EKSAKT i listen, ellers `null` = avvist. Dette er strengen som skal SENDES. */
export function creativeUrlHref(url: unknown, hosts: ReadonlySet<string>): string | null {
  const parsed = parseCreativeUrl(url);
  return parsed !== null && hosts.has(parsed.hostname.toLowerCase()) ? parsed.href : null;
}

/** Vert for en kreativ-URL (samme regler som `creativeUrlHref`). `null` = avvist. */
export function creativeUrlHost(url: unknown, hosts: ReadonlySet<string>): string | null {
  const href = creativeUrlHref(url, hosts);
  return href === null ? null : new URL(href).hostname.toLowerCase();
}

/**
 * Transportens vei til strengen som SENDES: den normaliserte `href` (strukturreglene som over; vertslisten er allerede sjekket av validatoren som kjører rett før skrivingen). Kaster ved en URL som ikke tåler
 * strukturreglene, i stedet for å sende råstrengen.
 */
export function creativeHref(url: unknown): string {
  const parsed = parseCreativeUrl(url);
  if (parsed === null) throw new Error("growth_invalid_creative_url");
  return parsed.href;
}

/** Som `creativeHref`, men gir råstrengen tilbake når URL-en ikke kan normaliseres (kun for sammenligning i noop/etterbetingelse, aldri for sending). */
export const creativeHrefOrRaw = (url: unknown): string => parseCreativeUrl(url)?.href ?? String(url);
