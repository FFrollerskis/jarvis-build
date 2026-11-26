import { isIP } from "node:net";

/**
 * WP-G3 (D-465) -> WP-G4b K4 (D-484): den DELTE «er dette endepunktet lokalt?»-vakten. Flyttet UENDRET ut av `vision-runtime.ts` (som re-eksporterer og kaster sine egne `VisionConfigError`), slik at den lokale visjonsmodellen (G3) og de
 * lokale modellidentitetene `gemma_local`/`local_llm`/`ollama` (K4, `local-model-endpoints.ts`) bruker NØYAKTIG samme regler - ingen kopi. Filen er bevisst uten andre imports enn `node:net` (workeren laster den uten visjonskjøretiden;
 * samme grep som `vision-flags.ts`) og kaster/logger ingenting selv: den svarer, kalleren avgjør hva svaret betyr.
 *
 * Regler (G3 review A-L5): http(s), ingen brukerinfo, og verten må være loopback, privat IP (RFC 1918, IPv6 ULA), `localhost`/`host.docker.internal`, et enkelt-label-navn (docker-compose-tjeneste) eller ende på
 * .local/.lan/.internal/.home.arpa/.localdomain. Tailscale (CGNAT 100.64/10 og `*.ts.net`) KUN med eierens eksplisitte `allowTailscale`. Offentlig vertsnavn/IP, link-lokale adresser (inkl. skymetadata 169.254.169.254) og 0.0.0.0 er IKKE lokale.
 * Navneoppløsningen kontrolleres ved OPPSTART (`resolveEndpointLocality`), ikke per kall (ingen DNS-pinning: eierens DNS er en del av tillitsgrunnlaget).
 */
export const LOCAL_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa", ".localdomain"];

export interface LocalEndpointOptions {
  allowTailscale?: boolean;
}

/** Er denne IP-adressen lokal? Loopback, RFC 1918, IPv6 ULA og - kun med eier-flagget - CGNAT 100.64/10. IPv4-mappet IPv6 vurderes som sin IPv4. */
export function isLocalAddress(address: string, options: LocalEndpointOptions = {}): boolean {
  let host = address.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped !== null) host = mapped[1] as string;
  const kind = isIP(host);
  if (kind === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return options.allowTailscale === true && a === 100 && b >= 64 && b <= 127;
  }
  if (kind === 6) return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host);
  return false;
}

/** Stabil årsakskode (`local_url_malformed|scheme|credentials|not_local`) - aldri URL-en, aldri verten. */
export class LocalEndpointError extends Error {
  constructor(readonly code: string) {
    super(`local_endpoint_invalid:${code}`);
    this.name = "LocalEndpointError";
  }
}

/** SYNTAKTISK sjekk. Returnerer `raw` uendret når endepunktet er lokalt; ellers kastes `LocalEndpointError` (kun koden, aldri URL-en). */
export function assertLocalEndpoint(raw: string, options: LocalEndpointOptions = {}): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LocalEndpointError("local_url_malformed");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new LocalEndpointError("local_url_scheme");
  if (url.username !== "" || url.password !== "") throw new LocalEndpointError("local_url_credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = isIP(host) !== 0
    ? isLocalAddress(host, options)
    : host === "localhost" || host === "host.docker.internal" || !host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s)) || (options.allowTailscale === true && host.endsWith(".ts.net"));
  if (!local) throw new LocalEndpointError("local_url_not_local");
  return raw;
}

/** Navneoppslag (injisert; i drift `dns.lookup(host, { all: true })` fra main.ts/worker-main.ts). */
export type LocalEndpointDnsLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

export const LOCAL_ENDPOINT_DNS_TIMEOUT_MS = 5_000;

export async function lookupWithTimeout(lookup: LocalEndpointDnsLookup, host: string, timeoutMs: number): Promise<ReadonlyArray<{ address: string }>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([lookup(host), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("dns_timeout")), timeoutMs); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `literal`: en IP-adresse (allerede vurdert syntaktisk). `checked`: navnet løses til KUN lokale adresser. `nonlocal`: minst én adresse er ikke lokal. `unresolved`: navnet kunne ikke løses akkurat nå (docker-tjeneste som ikke er
 * oppe ennå): da kan heller ingen forbindelse opprettes og hvert kall feiler lukket - kalleren logger det, men stopper ikke.
 */
export type LocalResolution = "literal" | "checked" | "nonlocal" | "unresolved";

export async function resolveEndpointLocality(rawUrl: string, deps: { lookup: LocalEndpointDnsLookup; timeoutMs: number }, options: LocalEndpointOptions): Promise<LocalResolution> {
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) !== 0) return "literal";
  let addresses: ReadonlyArray<{ address: string }>;
  try {
    addresses = await lookupWithTimeout(deps.lookup, host, deps.timeoutMs);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) return "unresolved";
  if (addresses.some((entry) => !isLocalAddress(entry.address, options))) return "nonlocal";
  return "checked";
}
