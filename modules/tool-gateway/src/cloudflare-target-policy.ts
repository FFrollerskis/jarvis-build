import { isIPv4, isIPv6 } from "node:net";

/**
 * WP-E1 (UA-5 Developer & Cloud Control Plane, D-41/D-64): mål-autorisasjon og deterministisk inndata-validering for Cloudflare. SAMME
 * oppdeling som Docker (`docker-target-policy.ts`) og GCE (`gce-target-policy.ts`): transporten (`cloudflare-transport.ts`) transporterer,
 * mål-autorisasjonen håndheves av `ToolGateway.execute()` selv via `ToolDefinition.parameterAuthorizer` - aldri en regel inni transporten som kan
 * omgås ved å kalle gatewayen på en annen måte.
 *
 * D-64 Core-vs-Adapter: Cloudflare er en ADAPTER (`EXTERNAL_CANONICAL` for DNS/WAF/sone-innstillinger - leverandøren eier tilstanden, Jarvis
 * normaliserer den til pekere og journalfører før/etter i `tool_executions` + `infra_executions`). Ingen Jarvis-domenemodell avhenger av
 * Cloudflares API-form, og ingenting her gjør Cloudflare til domenekjernen (`CORE_DEPENDENCY_DECISION_REQUIRED=false`).
 *
 * MÅL-MODELL (fail-closed i alle retninger):
 *  - Skriving krever at sonen står EKSAKT i `JARVIS_CLOUDFLARE_MUTATION_ZONES` (kommaseparert liste av 32-tegns hex-sone-id-er, ingen wildcard).
 *    Tom/ukonfigurert liste = ingen skriving er tillatt (lesing er uberørt og styres av tokenets scopes).
 *  - Sone-id-en MÅ tilhøre den konfigurerte kontoen (`JARVIS_CLOUDFLARE_ACCOUNT_ID`) - det kontrolleres av transporten mot Cloudflare selv (en
 *    ren, synkron autorisator kan ikke gjøre I/O), og skriving uten konfigurert konto feiler lukket.
 *  - Sone-id-er og ressurs-id-er er ALLTID 32 tegn hex (Cloudflare-identifikatorer) - alt annet avvises FØR det interpoleres i en URL-sti.
 *
 * D-41 (eier-tilkoblet connector, maksimal nyttig kapabilitet): A-D styrer HVORDAN en handling utføres, aldri OM eieren har kapabiliteten.
 * Hele den verifiserte skrive-/slette-flaten er bygget (DNS-poster, WAF-/rate-limit-regler, sone-innstillinger, cache-purge). Det som IKKE er bygget
 * står i `CLOUDFLARE_CAPABILITIES` med status DEFERRED/PARTIAL og begrunnelse - aldri stille utelatt.
 */

export type CloudflareMutationAction =
  | "create_dns_record"
  | "update_dns_record"
  | "delete_dns_record"
  | "create_waf_rule"
  | "update_waf_rule"
  | "delete_waf_rule"
  | "update_zone_setting"
  | "purge_cache";

export const CLOUDFLARE_MUTATION_ACTIONS: readonly CloudflareMutationAction[] = [
  "create_dns_record", "update_dns_record", "delete_dns_record",
  "create_waf_rule", "update_waf_rule", "delete_waf_rule",
  "update_zone_setting", "purge_cache"
];

/** Cloudflare-identifikatorer (sone, DNS-post, ruleset, regel, konto) er 32 tegn hex. Verifisert mot API-referansen (`Identifier`, maks 32 tegn). */
const CLOUDFLARE_ID = /^[0-9a-f]{32}$/;

export function isCloudflareId(value: unknown): value is string {
  return typeof value === "string" && CLOUDFLARE_ID.test(value);
}

/**
 * Parser `JARVIS_CLOUDFLARE_MUTATION_ZONES` - kommaseparert liste av EKSAKTE sone-id-er eieren har autorisert for skriving. EKSAKT match (ingen
 * wildcard/prefiks). En ugyldig enkelt-id HOPPES OVER (aldri en løs/gjettet autorisasjon for resten av listen); tom/manglende verdi -> tomt sett.
 */
export function parseCloudflareMutationZones(raw: string | undefined | null): ReadonlySet<string> {
  if (!raw) return new Set();
  const zones = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (id.length === 0) continue;
    if (!CLOUDFLARE_ID.test(id)) continue;
    zones.add(id);
  }
  return zones;
}

export interface CloudflareTargetAuthorization {
  allowed: boolean;
  reason: string;
}

/**
 * Fail-closed: manglende/ugyldig sone-id -> nektet; sone utenfor eierens liste -> nektet; ellers tillatt. Gjelder ALLE skrivehandlinger likt
 * (det finnes ingen «sentinel»-sone-tier som for Docker/GCE: en sone kan ikke gjenskapes som et engangsmål, så akseptanse kjøres mot en
 * SANDBOX-sone som eieren selv legger i listen - se `docs/runbooks/CLOUDFLARE_CONNECTOR.md`).
 */
export function authorizeCloudflareTarget(
  action: CloudflareMutationAction,
  zoneId: unknown,
  configuredZones: ReadonlySet<string>
): CloudflareTargetAuthorization {
  if (!CLOUDFLARE_MUTATION_ACTIONS.includes(action)) return { allowed: false, reason: "cloudflare_action_unknown" };
  if (!isCloudflareId(zoneId)) return { allowed: false, reason: "missing_or_invalid_zone_id" };
  if (!configuredZones.has(zoneId)) return { allowed: false, reason: "cloudflare_zone_not_authorized" };
  return { allowed: true, reason: "owner_configured_zone" };
}

/** WAF-faser som kan skrives (verifisert mot Ruleset Engine-dokumentasjonen: `http_request_firewall_custom` = WAF custom rules, `http_ratelimit` = rate limiting rules). */
export const CLOUDFLARE_WAF_PHASES = ["http_request_firewall_custom", "http_ratelimit"] as const;
export type CloudflareWafPhase = (typeof CLOUDFLARE_WAF_PHASES)[number];
/** Faser som kan LESES (managed rules leses bare - overstyring av managed rulesets er DEFERRED). */
export const CLOUDFLARE_READABLE_PHASES = ["http_request_firewall_custom", "http_ratelimit", "http_request_firewall_managed"] as const;

/** Regel-handlinger vi tillater (blokkerende/utfordrende/logg). `skip`/`execute`/`rewrite` krever action_parameters og er DEFERRED. */
export const CLOUDFLARE_WAF_ACTIONS = ["block", "challenge", "managed_challenge", "js_challenge", "log"] as const;
export type CloudflareWafAction = (typeof CLOUDFLARE_WAF_ACTIONS)[number];

/**
 * Sone-innstillinger vi leser/skriver, med LUKKEDE verdimengder (verifisert mot offisiell dokumentasjon 2026-10-09: `ssl`, `min_tls_version`,
 * `always_use_https`, `development_mode`, `security_level`, `tls_1_3`). Batch-endepunktene (`/zones/{id}/settings`) er deprecated (EOL 2027-03-31) -
 * kun per-innstilling-endepunktet brukes. Andre innstillinger er DEFERRED til de er verifisert enkeltvis.
 */
export const CLOUDFLARE_ZONE_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  ssl: ["off", "flexible", "full", "strict"],
  min_tls_version: ["1.0", "1.1", "1.2", "1.3"],
  always_use_https: ["on", "off"],
  development_mode: ["on", "off"],
  security_level: ["off", "essentially_off", "low", "medium", "high", "under_attack"],
  tls_1_3: ["on", "off", "zrt"]
};
export const CLOUDFLARE_ZONE_SETTING_IDS = Object.keys(CLOUDFLARE_ZONE_SETTINGS);

/** DNS-posttyper det kan SKRIVES til (enkle `content`-typer). Strukturerte typer (SRV/CAA/HTTPS/LOC/…) krever `data`-objekt og er DEFERRED. */
export const CLOUDFLARE_DNS_WRITE_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"] as const;
export type CloudflareDnsWriteType = (typeof CLOUDFLARE_DNS_WRITE_TYPES)[number];
const PROXIABLE_TYPES: ReadonlySet<string> = new Set(["A", "AAAA", "CNAME"]);

export type CloudflareCapabilityStatus = "IMPLEMENTED" | "PARTIAL" | "DEFERRED";

export interface CloudflareCapability {
  capability: string;
  status: CloudflareCapabilityStatus;
  /** Risikoklasse for handlingen (A-D) - styrer HVORDAN den utføres, aldri OM eieren har kapabiliteten (D-41). */
  risk: "A" | "B" | "C" | "D" | "-";
  /** Nødvendig API-token-tillatelse (permission group-navn fra Cloudflares dokumentasjon; navnene er kosmetiske - gruppe-id-ene er autoritative). */
  token_permission: string;
  note: string;
}

/**
 * D-41-matrise (regel 11): hver leverandørkapabilitet er enten bygget, delvis bygget eller eksplisitt DEFERRED med begrunnelse. Tillatelsesnavnene er
 * verifisert mot developers.cloudflare.com (søk 2026-10-09; direkte nedlasting av dokumentasjonen var blokkert i byggemiljøet, så NAVNENE er lest
 * fra søkeutdrag av de offisielle sidene og skal bekreftes mot token-oppsettet i dashbordet - se runbooken).
 */
export const CLOUDFLARE_CAPABILITIES: readonly CloudflareCapability[] = [
  { capability: "Token-verifisering (GET /accounts/{id}/tokens/verify eller /user/tokens/verify)", status: "IMPLEMENTED", risk: "A", token_permission: "(ingen ekstra - verifiserer tokenet selv)", note: "status active/disabled/expired + utløp; selve tokenet returneres aldri" },
  { capability: "Soner: liste og detaljer (GET /zones, /zones/{id})", status: "IMPLEMENTED", risk: "A", token_permission: "Zone Read", note: "filtreres til konfigurert konto" },
  { capability: "DNS-poster: liste, hent, finn (GET /zones/{id}/dns_records)", status: "IMPLEMENTED", risk: "A", token_permission: "DNS Read (eller DNS Write)", note: "paginert, begrenset til 10 sider; eksakt filtrering gjøres også lokalt" },
  { capability: "DNS-poster: opprett/endre/slett (POST/PATCH/DELETE)", status: "IMPLEMENTED", risk: "D", token_permission: "DNS Write", note: "A/AAAA/CNAME/TXT/MX/NS; navn og type kan ikke endres på eksisterende post; snapshot av posten før endring/sletting; kompensasjon via recovery" },
  { capability: "DNS-poster: strukturerte typer (SRV/CAA/HTTPS/LOC/SSHFP/TLSA …), tags, batch, import/eksport", status: "DEFERRED", risk: "-", token_permission: "DNS Write", note: "krever per-type `data`-skjema som ikke er verifisert enkeltvis; byggs når eieren trenger en bestemt type" },
  { capability: "WAF custom rules + rate limiting rules: les entrypoint (GET /zones/{id}/rulesets/phases/{fase}/entrypoint)", status: "IMPLEMENTED", risk: "A", token_permission: "Zone WAF Read (eller Zone WAF Write)", note: "faser http_request_firewall_custom, http_ratelimit, http_request_firewall_managed (kun lesing)" },
  { capability: "WAF custom rules + rate limiting rules: opprett/endre/slett regel (POST/PATCH/DELETE …/rulesets/{id}/rules)", status: "IMPLEMENTED", risk: "D", token_permission: "Zone WAF Write", note: "faser http_request_firewall_custom og http_ratelimit; handlinger block/challenge/managed_challenge/js_challenge/log; deterministisk vakt mot regler som treffer all trafikk" },
  { capability: "WAF: skip/execute-regler, managed ruleset-overstyringer, custom block-respons", status: "DEFERRED", risk: "-", token_permission: "Zone WAF Write", note: "krever action_parameters-skjema som ikke er verifisert; legacy Firewall Rules/Filters-API er deprecated siden 2025-06-15 og brukes ikke" },
  { capability: "Sone-innstillinger: les/skriv per innstilling (GET/PATCH /zones/{id}/settings/{setting})", status: "PARTIAL", risk: "D", token_permission: "Zone Settings Read / Zone Settings Write", note: "kun ssl, min_tls_version, always_use_https, development_mode, security_level, tls_1_3 (verifiserte id-er og verdier); batch-endepunktet er deprecated og brukes ikke" },
  { capability: "Cache-purge (POST /zones/{id}/purge_cache)", status: "IMPLEMENTED", risk: "C", token_permission: "Cache Purge", note: "everything/files/hosts/prefixes/tags; klasse C fordi det flytter produksjonslast mot opprinnelsen og ikke kan angres (cachen fylles på igjen)" },
  { capability: "Tilgangsstyring (les): kontomedlemmer, roller, API-token-metadata, audit-logg", status: "PARTIAL", risk: "A", token_permission: "Account Settings Read; Account API Tokens Read; (audit-logg: Account Settings Read)", note: "kun metadata (e-post maskeres, token-verdier finnes ikke i API-et). VERIFISERT mot offisiell dokumentasjon 2026-10-09: medlemsliste og audit-logg v2 = Account Settings Read, token-liste = Account API Tokens Read. IKKE bekreftet: tillatelsen for ROLLELISTEN (kun enkelt-rolle-oppslaget er verifisert som Account Settings Read) - en 403 gir en tydelig feil. Audit-logg v2 krever since+before (standard siste 24 t); kun første side leses (cursor-paginering er ikke bygget)" },
  { capability: "Tilgangsstyring (skriv): medlemmer, roller, opprett/tilbakekall API-token", status: "DEFERRED", risk: "-", token_permission: "Account Settings Write; Account API Tokens Write", note: "et token som kan opprette tokens er privilegie-eskalering; krever egen eierbeslutning og et eget isolert token (rot-credentials skal aldri nås av modellen)" },
  { capability: "Workers/Pages/R2/Tunnel/Zero Trust/Load Balancing/Page Rules/Cache Rules/Transform Rules/Logpush/GraphQL-analyse", status: "DEFERRED", risk: "-", token_permission: "(per produkt)", note: "utenfor masterplanens «Cloudflare (DNS/WAF)»-avgrensning; hver krever egen D-41-verifisering" }
];

function reject(code: string, detail?: unknown): never {
  throw new Error(`cloudflare_invalid_${code}${detail === undefined ? "" : `:${String(detail).slice(0, 80)}`}`);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** Fullt kvalifisert vertsnavn (ASCII/Punycode): etiketter 1-63 tegn av a-z0-9_*-, ingen ledende/etterfølgende punktum, maks 253 totalt. */
export function assertDnsName(value: unknown, label = "name"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) reject(label);
  const name = (value as string).toLowerCase();
  if (CONTROL.test(name) || name.startsWith(".") || name.endsWith(".")) reject(label, "format");
  const labels = name.split(".");
  for (const part of labels) {
    if (part.length < 1 || part.length > 63 || !/^[a-z0-9_*-]+$/.test(part)) reject(label, "label");
    if (part.includes("*") && part !== "*") reject(label, "wildcard");
  }
  if (labels.slice(1).includes("*")) reject(label, "wildcard");
  return name;
}

/** `name` må være sonen selv eller et underdomene av den. Cloudflare krever det også, men vi avviser FØR kallet (og før noe leses/skrives). */
export function assertNameWithinZone(name: string, zoneName: string): void {
  const zone = zoneName.toLowerCase();
  if (name !== zone && !name.endsWith(`.${zone}`)) reject("name_outside_zone", name);
}

const HOSTNAME_CONTENT = /^(?=.{1,253}$)([a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?)(\.[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?)*$/;

export function assertDnsType(value: unknown): CloudflareDnsWriteType {
  if (typeof value !== "string" || !(CLOUDFLARE_DNS_WRITE_TYPES as readonly string[]).includes(value)) reject("type", value);
  return value as CloudflareDnsWriteType;
}

/** Innhold per posttype. TXT: fritekst (maks 2048 tegn, ingen kontrolltegn). */
export function assertDnsContent(type: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) reject("content");
  const content = value as string;
  if (CONTROL.test(content)) reject("content", "control_characters");
  switch (type) {
    case "A":
      if (!isIPv4(content)) reject("content", "ipv4");
      return content;
    case "AAAA":
      if (!isIPv6(content)) reject("content", "ipv6");
      return content;
    case "CNAME":
    case "MX":
    case "NS":
      if (!HOSTNAME_CONTENT.test(content.replace(/\.$/, ""))) reject("content", "hostname");
      return content;
    case "TXT":
      if (content.length > 2048) reject("content", "too_long");
      return content;
    default:
      return reject("type", type);
  }
}

/**
 * Sammenligner ønsket og lest postinnhold uten å la leverandørens normalisering gi falske avvik: TXT leveres av og til i anførselstegn, CNAME/MX/NS
 * kan ha etterfølgende punktum og ulik store/små bokstaver, IPv6 kan være skrevet komprimert eller utvidet. Brukes av etterbetingelsene (readback).
 */
export function dnsContentMatches(type: string, expected: string, actual: string): boolean {
  const unquote = (v: string): string => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
  switch (type) {
    case "TXT":
      return unquote(expected) === unquote(actual);
    case "CNAME":
    case "MX":
    case "NS":
      return expected.replace(/\.$/, "").toLowerCase() === actual.replace(/\.$/, "").toLowerCase();
    case "AAAA": {
      if (!isIPv6(expected) || !isIPv6(actual)) return expected === actual;
      try {
        return new URL(`http://[${expected}]/`).hostname === new URL(`http://[${actual}]/`).hostname;
      } catch {
        return expected.toLowerCase() === actual.toLowerCase();
      }
    }
    default:
      return expected === actual;
  }
}

export function assertDnsTtl(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !(value === 1 || (value >= 60 && value <= 86_400))) reject("ttl", value);
  return value as number;
}

export function assertProxiedAllowed(type: string, proxied: unknown): boolean {
  if (typeof proxied !== "boolean") reject("proxied");
  if (proxied === true && !PROXIABLE_TYPES.has(type)) reject("proxied", `${type}_kan_ikke_proxies`);
  return proxied as boolean;
}

export function assertMxPriority(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65_535) reject("priority", value);
  return value as number;
}

export function assertDnsComment(value: unknown): string {
  if (typeof value !== "string" || value.length > 100 || CONTROL.test(value)) reject("comment");
  return value as string;
}

/** Regel-uttrykk (wirefilter) er ugjennomsiktig for oss; vi sjekker kun lengde/tegn og at det ikke er en åpenbar «treffer alt»-regel for en blokkerende handling. */
export function assertWafExpression(value: unknown, action: string): string {
  if (typeof value !== "string") reject("expression");
  const expression = (value as string).trim();
  if (expression.length === 0 || expression.length > 4096 || CONTROL.test(expression.replace(/[\n\t]/g, " "))) reject("expression");
  const compact = expression.replace(/\s+/g, "").toLowerCase();
  const matchesAll = compact === "true" || compact === "(true)" || /^\(*true\)*$/.test(compact);
  if (matchesAll && action !== "log") reject("expression", "treffer_all_trafikk");
  return expression;
}

export function assertWafAction(value: unknown): CloudflareWafAction {
  if (typeof value !== "string" || !(CLOUDFLARE_WAF_ACTIONS as readonly string[]).includes(value)) reject("action", value);
  return value as CloudflareWafAction;
}

export function assertWafPhase(value: unknown): CloudflareWafPhase {
  if (typeof value !== "string" || !(CLOUDFLARE_WAF_PHASES as readonly string[]).includes(value)) reject("phase", value);
  return value as CloudflareWafPhase;
}

export function assertReadablePhase(value: unknown): (typeof CLOUDFLARE_READABLE_PHASES)[number] {
  if (typeof value !== "string" || !(CLOUDFLARE_READABLE_PHASES as readonly string[]).includes(value)) reject("phase", value);
  return value as (typeof CLOUDFLARE_READABLE_PHASES)[number];
}

export interface CloudflareRateLimit {
  characteristics: string[];
  period: number;
  requests_per_period: number;
  mitigation_timeout?: number;
}

/** `ratelimit`-objektet for `http_ratelimit` (felt verifisert mot dokumentasjonseksempelet: characteristics, period, requests_per_period, mitigation_timeout). */
export function assertRateLimit(value: unknown): CloudflareRateLimit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("ratelimit");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["characteristics", "period", "requests_per_period", "mitigation_timeout"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) reject("ratelimit_field", key);
  const characteristics = raw["characteristics"];
  if (!Array.isArray(characteristics) || characteristics.length === 0 || characteristics.length > 10) reject("ratelimit_characteristics");
  for (const c of characteristics as unknown[]) if (typeof c !== "string" || !/^[A-Za-z0-9_.\-[\]"]{1,120}$/.test(c)) reject("ratelimit_characteristics", c);
  const period = raw["period"];
  const rpp = raw["requests_per_period"];
  if (typeof period !== "number" || !Number.isInteger(period) || period < 1 || period > 86_400) reject("ratelimit_period");
  if (typeof rpp !== "number" || !Number.isInteger(rpp) || rpp < 1 || rpp > 1_000_000) reject("ratelimit_requests_per_period");
  const out: CloudflareRateLimit = { characteristics: characteristics as string[], period: period as number, requests_per_period: rpp as number };
  if (raw["mitigation_timeout"] !== undefined) {
    const mt = raw["mitigation_timeout"];
    if (typeof mt !== "number" || !Number.isInteger(mt) || mt < 0 || mt > 86_400) reject("ratelimit_mitigation_timeout");
    out.mitigation_timeout = mt as number;
  }
  return out;
}

export function assertZoneSetting(settingId: unknown, value: unknown): { setting_id: string; value: string } {
  if (typeof settingId !== "string" || !Object.hasOwn(CLOUDFLARE_ZONE_SETTINGS, settingId)) reject("setting_id", settingId);
  const allowed = CLOUDFLARE_ZONE_SETTINGS[settingId as string] as readonly string[];
  if (typeof value !== "string" || !allowed.includes(value)) reject("setting_value", value);
  return { setting_id: settingId as string, value: value as string };
}

export type CloudflarePurgeMode = "everything" | "files" | "hosts" | "prefixes" | "tags";
export const CLOUDFLARE_PURGE_MODES: readonly CloudflarePurgeMode[] = ["everything", "files", "hosts", "prefixes", "tags"];
/** Konservativ øvre grense per kall (ikke bekreftet maks fra leverandøren - lavere er alltid trygt). */
export const CLOUDFLARE_PURGE_MAX_ITEMS = 30;

/** Validerer purge-innhold mot sonenavnet og bygger riktig forespørselskropp (kun ÉN velger, aldri purge_everything sammen med andre - Cloudflare avviser det med feil 1092). */
export function buildPurgeBody(mode: unknown, items: unknown, zoneName: string): Record<string, unknown> {
  if (typeof mode !== "string" || !(CLOUDFLARE_PURGE_MODES as readonly string[]).includes(mode)) reject("purge_mode", mode);
  if (mode === "everything") {
    if (items !== undefined && !(Array.isArray(items) && items.length === 0)) reject("purge_items", "everything_tar_ingen_elementer");
    return { purge_everything: true };
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > CLOUDFLARE_PURGE_MAX_ITEMS) reject("purge_items");
  const list = items as unknown[];
  const zone = zoneName.toLowerCase();
  const hostInZone = (host: string): boolean => host === zone || host.endsWith(`.${zone}`);
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || item.length === 0 || item.length > 2048 || CONTROL.test(item)) reject("purge_item");
    const text = item as string;
    if (mode === "files") {
      let url: URL;
      try { url = new URL(text); } catch { return reject("purge_item", "url"); }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || !hostInZone(url.hostname.toLowerCase())) reject("purge_item", "utenfor_sonen");
      out.push(text);
    } else if (mode === "hosts") {
      const host = assertDnsName(text, "purge_host");
      if (host.includes("*") || !hostInZone(host)) reject("purge_item", "utenfor_sonen");
      out.push(host);
    } else if (mode === "prefixes") {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.includes("?") || text.includes("#")) reject("purge_item", "prefiks_uten_skjema_sporring_fragment");
      const host = text.split("/")[0] as string;
      if (!hostInZone(assertDnsName(host, "purge_prefix_host"))) reject("purge_item", "utenfor_sonen");
      out.push(text);
    } else {
      if (!/^[A-Za-z0-9._:-]{1,1024}$/.test(text)) reject("purge_item", "tag");
      out.push(text);
    }
  }
  return { [mode]: out };
}
