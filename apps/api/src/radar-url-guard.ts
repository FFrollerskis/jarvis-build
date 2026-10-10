// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * L1 (gjennomgang av PR #313): SSRF-vakten for radarkildene. Den første versjonen var KUN syntaktisk (en regex mot `localhost`/`.local`/`.internal`/…), og den var enkel å omgå: `https://localhost./` (punktum-suffiks), `localhost。`
 * (ideografisk punktum), `.localdomain`, `.home.arpa`, `.ts.net`, `.svc`, IP-innebygde navn (`127.0.0.1.nip.io`, `localtest.me`) - og oppløst IP ble aldri kontrollert (DNS-rebinding, eller en helt vanlig DNS-oppføring som peker inn i det
 * private nettet). Her er vakten todelt:
 *   1. SYNTAKS (`radarHostRejection`): verten normaliseres (NFKC, små bokstaver, ingen avsluttende punktum) FØR den vurderes, og reserverte/interne suffikser, jokertegn-DNS som koder inn en IP, IP-litteraler og enkeltlabel-verter avvises.
 *   2. OPPLØSNING (`assertPublicHost`): FØR hver henting løses vertsnavnet (injiserbar `lookupImpl`), og NOEN privat/loopback/link-local/CGNAT/metadata/unik-lokal/IPv4-mappet adresse i svaret avviser hele kilden (en blandet respons er ikke «litt trygg»).
 *
 * ÆRLIG GRENSE (TOCTOU): oppløsningen skjer rett FØR `fetch`, men `fetch` slår opp vertsnavnet på nytt når tilkoblingen opprettes. Global `fetch` kan ikke festes til den kontrollerte IP-en uten en ny avhengighet (eller en egen
 * `node:https`-klient, som er et eget valg), så en angriper som styrer DNS-svaret for en kilde eieren selv har valgt kan i teorien svare offentlig til kontrollen og privat til tilkoblingen (DNS-rebinding). Dette er ikke lukket her.
 * Det som begrenser skaden: kun `https` med sertifikatvalidering (en intern tjeneste har ikke et gyldig sertifikat for angriperens vertsnavn), kun port 443, ingen redirect, tekst-innholdstype, størrelsestak - og kun STATUS (aldri innhold)
 * forlater sveipet. `browser-gateway` har samme problem løst fullt ut (egress-proxy som kobler til den validerte IP-en); å gjøre det samme her er et mulig neste steg.
 */

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Adresser
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], ["100::", 64], ["64:ff9b:1::", 48], ["2001::", 32], ["2001:db8::", 32], ["3fff::", 20], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** De åtte 16-bits gruppene i en IPv6-adresse (håndterer `::`, sluttende punktdesimal IPv4 og sone-id), eller `null` for noe som ikke lar seg tolke. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const dotted = /^([0-9a-f:]*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const q = dotted[2]!.split(".").map(Number);
    if (q.some((part) => part > 255)) return null;
    s = `${dotted[1]!}${(((q[0]! << 8) | q[1]!)).toString(16)}:${(((q[2]! << 8) | q[3]!)).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 && fill < 1) return null;
  const groups = [...head, ...Array.from({ length: fill }, () => "0"), ...tail];
  if (groups.length !== 8) return null;
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return numbers.some((n) => Number.isNaN(n)) ? null : numbers;
}

const quad = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** IPv4-adressen som er innebygd i en IPv6-adresse (IPv4-mappet `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`), eller `null`. */
function embeddedIpv4(groups: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return quad(g6, g7);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return quad(g6, g7); // SIIT (`::ffff:0:a.b.c.d`)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return quad(g6, g7);
  if (g0 === 0x2002) return quad(g1, g2);
  return null;
}

/** `true` KUN for en offentlig rutbar adresse. Alt som ikke lar seg tolke er `false` (fail-closed). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  try {
    if (family === 4) return !blocked.check(address, "ipv4");
    const groups = ipv6Groups(address);
    if (groups === null) return false;
    const embedded = embeddedIpv4(groups);
    if (embedded !== null) return isPublicAddress(embedded);
    return !blocked.check(address.split("%")[0]!, "ipv6");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Vertsnavn (syntaks)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
/** Vertsnavn-suffikser som aldri er offentlige (RFC 6761/6762/8375, vanlige hjemmenett-/bedriftsnavn, Tailscale, Kubernetes/Docker). Treffer både selve suffikset og alt under det. */
const RESERVED_SUFFIXES: readonly string[] = [
  "localhost", "local", "localdomain", "internal", "lan", "home", "corp", "intranet", "intra", "box", "docker", "svc", "ts.net", "arpa", "onion", "test", "invalid"
];
/** Jokertegn-DNS-tjenester som svarer med IP-en navnet koder inn (`127.0.0.1.nip.io`, `localtest.me` → 127.0.0.1): aldri en kilde for en radar, og en klassisk vei inn i det interne nettet. */
const WILDCARD_IP_DOMAINS: readonly string[] = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me"];

const underOrEqual = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** NFKC (fullbredde-/ideografiske tegn → vanlige), små bokstaver, ingen avsluttende punktum. Brukes FØR enhver vurdering, slik at `localhost.` / `localhost。` / `ＬＯＣＡＬＨＯＳＴ` ikke er andre vertsnavn enn `localhost`. */
export function normalizeRadarHost(hostname: string): string {
  let host = hostname.normalize("NFKC").toLowerCase().replace(/[。．｡]/gu, ".");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

/** Hvorfor en vert ikke kan være en radarkilde (kort kode, aldri innhold), eller `null` når den er syntaktisk akseptabel. Den AUTORITATIVE kontrollen er likevel `assertPublicHost` (oppløst adresse). */
export function radarHostRejection(hostname: string): string | null {
  const host = normalizeRadarHost(hostname);
  if (host === "") return "empty_host";
  if (isIP(host) !== 0 || host.includes(":") || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return "ip_literal";
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return host.includes(".") ? "bad_host_characters" : "single_label_host";
  if (RESERVED_SUFFIXES.some((suffix) => underOrEqual(host, suffix))) return "reserved_suffix";
  if (WILDCARD_IP_DOMAINS.some((domain) => underOrEqual(host, domain))) return "wildcard_ip_dns";
  // Navn som starter med en IP (`10.0.0.5.example.com`, `10-0-0-5.example.com`) er jokertegn-DNS under et domene vi ikke kjenner.
  if (/^\d{1,3}(?:[.-]\d{1,3}){3}[.-]/.test(host)) return "ip_embedded_name";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Oppløsning (før hver henting)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export type LookupImpl = (hostname: string) => Promise<ReadonlyArray<{ address: string; family?: number }>>;

/** Standard: systemets resolver, ALLE svar (en vert kan ha både A og AAAA, og én privat adresse er nok til å avvise). */
export const systemLookup: LookupImpl = (hostname) => dnsLookup(hostname, { all: true });

export class RadarHostBlockedError extends Error {
  constructor(readonly reason: "dns_failure" | "dns_empty" | "blocked_address") {
    super(`radar_host_blocked:${reason}`);
    this.name = "RadarHostBlockedError";
  }
}

/**
 * Løser vertsnavnet og krever at ALLE svarene er offentlige adresser. Kaster `RadarHostBlockedError` (`dns_failure` hvis oppslaget feiler eller tidsavbrytes, `dns_empty` uten svar, `blocked_address` hvis NOEN adresse er
 * ikke-offentlig). Kalles rett FØR hver henting - se TOCTOU-forbeholdet øverst.
 */
export async function assertPublicHost(hostname: string, lookup: LookupImpl, timeoutMs: number): Promise<void> {
  const host = normalizeRadarHost(hostname);
  let timer: NodeJS.Timeout | undefined;
  let answers: ReadonlyArray<{ address: string }>;
  try {
    answers = await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("lookup_timeout")), timeoutMs); timer.unref(); })
    ]);
  } catch {
    throw new RadarHostBlockedError("dns_failure");
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!Array.isArray(answers) || answers.length === 0) throw new RadarHostBlockedError("dns_empty");
  if (answers.some((a) => typeof a?.address !== "string" || !isPublicAddress(a.address))) throw new RadarHostBlockedError("blocked_address");
}
