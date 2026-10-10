import { createHash } from "node:crypto";
import type { JsonValue } from "@jarvis/contracts";
import { registrableDomain } from "./claim-verification.ts";
import { neutralizeUntrustedText, truncateText } from "./knowledge-hits.ts";

/**
 * WP-D1 (UA-2): entitetsuttrekk for kunnskapsgrafen («hvilke dokumenter nevner X», «hva henger sammen med Y»). REN logikk bak et `EntityExtractor`-grensesnitt - ingen database, ingen nettverk, ingen modell
 * i den deterministiske uttrekkeren. En modellassistert uttrekker (`entity-llm.ts`) implementerer samme grensesnitt og er AV som standard.
 *
 * DETERMINISTISK uttrekk (ingen gjetning - kun mønstre og eierens egne kjente navn):
 *  - KJENTE ENTITETER: navn fra minnets `entities`-tabell (samme rom), funnet som hele ord/ordsekvenser (token-n-gram, ingen delstrengtreff). Korte enkeltnavn (<= 4 tegn) må være skrevet med stor forbokstav.
 *  - E-POSTADRESSER (aldri i klartekst: nøkkelen er sha256 av adressen, visningsnavnet maskert) og DOMENER (fra adresser, `http(s)://`-URL-er og `www.`-navn; ikke løse «filnavn.endelse»-treff, ikke gratis e-posttjenester).
 *  - REPO-NAVN (`github.com/eier/repo` og konfigurerte `eier/repo`) og PROSJEKTNØKLER (`ABC-123` -> `ABC`, med nektliste mot ISO-/UTF-/COVID-lignende treff og årstall).
 *  - DELTAKERE i møtereferat (kun navn fra kildens egen metadata, aldri e-postadresser).
 * Alt som leses er UBETRODD tekst: visningsnavn renses (kontroll-/usynlige tegn, `<>`), lengder og antall er begrenset, og regulære uttrykk er enkle (ingen nestede kvantifikatorer).
 */
export const ENTITY_KINDS = ["known_entity", "person", "organization", "place", "topic", "email_address", "domain", "repo", "project_key"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export type EntityMethod = "deterministic" | "llm";

export interface ExtractedEntity {
  kind: EntityKind;
  /** Stabil nøkkel innen (tenant, rom, art): normalisert navn, sha256 av e-postadresse, registrerbart domene, `eier/repo` eller prosjektprefiks. */
  canonical_key: string;
  display_name: string;
  mention_count: number;
  /** Løs peker til minnets `entities.entity_id` når navnet ble gjenkjent fra minnets ordliste. */
  memory_entity_id?: string | undefined;
}

export interface KnownEntity {
  entity_id: string;
  kind: string;
  name: string;
}

export interface EntityExtractionInput {
  source_type: string;
  title: string;
  content: string;
  /** Kildens egne (betrodde) proveniens-felt - f.eks. deltakerlisten i et møtereferat. */
  metadata: Record<string, JsonValue>;
  known: readonly KnownEntity[];
}

export interface EntityExtractor {
  readonly name: string;
  /** Endres den, bygges lenkene på nytt for alle dokumenter ved neste synk. */
  readonly version: string;
  readonly method: EntityMethod;
  extract(input: EntityExtractionInput): ExtractedEntity[] | Promise<ExtractedEntity[]>;
}

export const ENTITY_LIMITS = {
  maxPerDocument: 200,
  /** Regulære uttrykk og token-skanning leser aldri mer enn dette av et dokument (lineær kostnad, ingen ubegrenset tid). */
  maxScanChars: 500_000,
  maxNameTokens: 6,
  minNameChars: 3,
  maxKnown: 2_000,
  maxDisplayChars: 120,
  maxCanonicalChars: 200,
  maxParticipants: 50
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Normalisering
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const TOKEN_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Normalisert navn: NFKC, små bokstaver, ordsekvens med ett mellomrom. Samme normalisering brukes på ordlisten og på spørringen («mentions»), så de alltid treffer hverandre. */
export function normalizeEntityName(raw: string): string {
  const tokens = raw.normalize("NFKC").toLowerCase().match(TOKEN_RE);
  return tokens === null ? "" : tokens.join(" ");
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Nøkkelen for en e-postadresse: aldri adressen selv. */
export const emailEntityKey = (address: string): string => sha256Hex(address.normalize("NFKC").trim().toLowerCase());

/** `ola.nordmann@acme.no` -> `o***@acme.no` (første tegn i lokaldelen og hele domenet; domenet er også en egen entitet). */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  const first = [...address.slice(0, at)][0] ?? "*";
  return `${first}***${address.slice(at)}`.toLowerCase().slice(0, ENTITY_LIMITS.maxDisplayChars);
}

function displayName(raw: string): string {
  return truncateText(neutralizeUntrustedText(raw), ENTITY_LIMITS.maxDisplayChars);
}

const EMAIL_RE = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}/gu;
const URL_HOST_RE = /\bhttps?:\/\/([a-z0-9][a-z0-9.-]{0,252})/gi;
// (ikke etter `/`, `.`, `-` eller et ordtegn: `https://www.x.no` er alt telt av URL-mønsteret, og `xwww.y.no` er ikke et www-navn)
const WWW_HOST_RE = /(?<![\w./-])www\.([a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63}){0,4}\.[a-z]{2,24})\b/gi;
const GITHUB_REPO_RE = /\bgithub\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9._-]{1,100})/gi;
const PROJECT_KEY_RE = /\b([A-Z]{2}[A-Z0-9]{0,8})-(\d{1,6})\b/g;
const CONFIGURED_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** Gratis e-posttjenester og plattformer som ville gjort «domene»-entiteter til støy (alt peker til dem). Bevisst liten liste; ikke en fullstendig. */
const NOISE_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "online.no", "getmail.no",
  "google.com", "googleapis.com", "gstatic.com", "googleusercontent.com", "github.com", "githubusercontent.com", "microsoft.com", "office.com", "sharepoint.com", "dropbox.com",
  "notion.so", "slack.com", "zoom.us", "w3.org", "schema.org", "example.com", "example.org", "example.net", "localhost"
]);
const RESERVED_GITHUB_OWNERS: ReadonlySet<string> = new Set([
  "features", "orgs", "settings", "topics", "marketplace", "sponsors", "about", "pricing", "login", "join", "explore", "notifications", "issues", "pulls", "search", "collections", "events",
  "readme", "security", "enterprise", "customer-stories", "apps", "organizations"
]);
/** Prefikser som ligner prosjektnøkler, men er standarder/forkortelser. */
const PROJECT_KEY_DENY: ReadonlySet<string> = new Set([
  "UTF", "ISO", "SHA", "MD", "COVID", "RFC", "CVE", "TLS", "SSL", "AES", "RSA", "HTTP", "TCP", "UDP", "WCAG", "ECMA", "PDF", "USB", "GPT", "HTML", "CSS", "SQL", "XML", "JSON", "PNG", "JPG",
  "IEEE", "ANSI", "DIN", "EN", "NS", "IEC", "ASCII", "GDPR", "SARS", "MERS", "HIV", "ABS", "RGB", "CMYK", "UUID", "ECDSA", "ED", "HMAC", "NIST", "SOC", "PCI", "FY", "ST"
]);

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Deterministisk uttrekker
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface DeterministicExtractorOptions {
  /** Repo-navn (`eier/repo`) som også gjenkjennes som ren tekst (utover `github.com/eier/repo`-URL-er). Typisk `JARVIS_GITHUB_REPO`. Ugyldige navn forkastes. */
  repos?: readonly string[] | undefined;
  maxEntities?: number | undefined;
}

interface KnownIndex {
  /** normalisert navn -> entitet */
  byPhrase: Map<string, { entity: KnownEntity; kind: EntityKind; tokenCount: number; shortName: boolean }>;
  maxTokens: number;
}

/** Minnets entitetsart -> kunnskapsgrafens art (ukjent art = `known_entity`). */
function mapKnownKind(kind: string): EntityKind {
  const k = kind.toLowerCase().trim();
  return k === "person" || k === "organization" || k === "place" || k === "topic" ? k : "known_entity";
}

const SHORT_NAME_MAX = 4;
const isCapitalized = (token: string): boolean => {
  const first = [...token][0] ?? "";
  return first !== first.toLowerCase() && first === first.toUpperCase();
};

export class DeterministicEntityExtractor implements EntityExtractor {
  readonly name: string = "deterministic";
  /** Heves når uttrekksreglene endres: alle dokumenter indekseres da på nytt ved neste synk. */
  readonly version: string = "1";
  readonly method = "deterministic" as const;
  private readonly repos: readonly string[];
  private readonly maxEntities: number;
  private readonly knownCache = new WeakMap<readonly KnownEntity[], KnownIndex>();

  constructor(options: DeterministicExtractorOptions = {}) {
    this.repos = (options.repos ?? []).filter((r) => CONFIGURED_REPO_RE.test(r)).map((r) => r.toLowerCase());
    this.maxEntities = Math.min(Math.max(Math.floor(options.maxEntities ?? ENTITY_LIMITS.maxPerDocument), 1), ENTITY_LIMITS.maxPerDocument);
  }

  extract(input: EntityExtractionInput): ExtractedEntity[] {
    const found = new Map<string, ExtractedEntity>();
    const bump = (kind: EntityKind, key: string, name: string, count = 1, memoryEntityId?: string): void => {
      if (key.length === 0 || key.length > ENTITY_LIMITS.maxCanonicalChars) return;
      const label = displayName(name);
      if (label.length === 0) return;
      const id = `${kind}\u0000${key}`;
      const existing = found.get(id);
      if (existing === undefined) found.set(id, { kind, canonical_key: key, display_name: label, mention_count: count, ...(memoryEntityId !== undefined ? { memory_entity_id: memoryEntityId } : {}) });
      else {
        existing.mention_count += count;
        if (existing.memory_entity_id === undefined && memoryEntityId !== undefined) existing.memory_entity_id = memoryEntityId;
      }
    };

    // Tittel + innhold, avkortet. NFKC så tegnvarianter ikke slipper forbi (fullbredde-bokstaver, ligaturer).
    const text = `${input.title}\n${input.content}`.slice(0, ENTITY_LIMITS.maxScanChars).normalize("NFKC");

    this.extractKnown(text, input.known, bump);
    this.extractEmailAndDomains(text, bump);
    this.extractRepos(text, bump);
    this.extractProjectKeys(text, bump);
    this.extractParticipants(input, bump);

    return [...found.values()]
      .sort((a, b) => b.mention_count - a.mention_count || a.kind.localeCompare(b.kind) || a.canonical_key.localeCompare(b.canonical_key))
      .slice(0, this.maxEntities);
  }

  private knownIndex(known: readonly KnownEntity[]): KnownIndex {
    const cached = this.knownCache.get(known);
    if (cached !== undefined) return cached;
    const byPhrase: KnownIndex["byPhrase"] = new Map();
    let maxTokens = 1;
    for (const entity of known.slice(0, ENTITY_LIMITS.maxKnown)) {
      if (typeof entity.name !== "string" || typeof entity.entity_id !== "string") continue;
      const tokens = entity.name.normalize("NFKC").toLowerCase().match(TOKEN_RE);
      if (tokens === null || tokens.length > ENTITY_LIMITS.maxNameTokens) continue;
      const phrase = tokens.join(" ");
      if (phrase.length < ENTITY_LIMITS.minNameChars || /^[\p{N}\s]+$/u.test(phrase)) continue;
      if (!byPhrase.has(phrase)) byPhrase.set(phrase, { entity, kind: mapKnownKind(entity.kind), tokenCount: tokens.length, shortName: tokens.length === 1 && phrase.length <= SHORT_NAME_MAX });
      maxTokens = Math.max(maxTokens, tokens.length);
    }
    const index = { byPhrase, maxTokens };
    this.knownCache.set(known, index);
    return index;
  }

  private extractKnown(text: string, known: readonly KnownEntity[], bump: (kind: EntityKind, key: string, name: string, count?: number, memoryEntityId?: string) => void): void {
    if (known.length === 0) return;
    const index = this.knownIndex(known);
    if (index.byPhrase.size === 0) return;
    const rawTokens = text.match(TOKEN_RE);
    if (rawTokens === null) return;
    const lowered = rawTokens.map((t) => t.toLowerCase());
    for (let i = 0; i < lowered.length; i += 1) {
      let phrase = "";
      for (let n = 1; n <= index.maxTokens && i + n <= lowered.length; n += 1) {
        phrase = n === 1 ? (lowered[i] as string) : `${phrase} ${lowered[i + n - 1] as string}`;
        const hit = index.byPhrase.get(phrase);
        if (hit === undefined) continue;
        if (hit.shortName && !isCapitalized(rawTokens[i] as string)) continue; // «Per»/«Mai» som vanlige ord telles ikke
        bump(hit.kind, phrase, hit.entity.name, 1, hit.entity.entity_id);
      }
    }
  }

  private extractEmailAndDomains(text: string, bump: (kind: EntityKind, key: string, name: string, count?: number) => void): void {
    const addDomain = (host: string): void => {
      const clean = host.toLowerCase().replace(/\.+$/, "");
      if (!clean.includes(".") || isIpAddress(clean)) return;
      const domain = registrableDomain(clean);
      if (!domain.includes(".") || NOISE_DOMAINS.has(domain)) return;
      bump("domain", domain, domain);
    };
    for (const match of text.matchAll(EMAIL_RE)) {
      const address = match[0].toLowerCase();
      bump("email_address", emailEntityKey(address), maskEmail(address));
      addDomain(address.slice(address.lastIndexOf("@") + 1));
    }
    for (const match of text.matchAll(URL_HOST_RE)) addDomain(match[1] as string);
    for (const match of text.matchAll(WWW_HOST_RE)) addDomain(`www.${match[1] as string}`);
  }

  private extractRepos(text: string, bump: (kind: EntityKind, key: string, name: string, count?: number) => void): void {
    for (const match of text.matchAll(GITHUB_REPO_RE)) {
      const owner = (match[1] as string).toLowerCase();
      if (RESERVED_GITHUB_OWNERS.has(owner)) continue;
      const repo = (match[2] as string).toLowerCase().replace(/\.git$/, "").replace(/[.-]+$/, "");
      if (repo.length === 0) continue;
      bump("repo", `${owner}/${repo}`, `${owner}/${repo}`);
    }
    if (this.repos.length === 0) return;
    const lower = text.toLowerCase();
    for (const repo of this.repos) {
      let from = 0;
      let count = 0;
      for (;;) {
        const at = lower.indexOf(repo, from);
        if (at === -1) break;
        from = at + repo.length;
        // Ordgrense: tegnet før/etter kan ikke være en del av et lengre navn (`xtsworkflow/jarvisbuild2`).
        const before = at === 0 ? "" : (lower[at - 1] as string);
        const after = lower[at + repo.length] ?? "";
        if (/[a-z0-9._/-]/.test(before) || /[a-z0-9_-]/.test(after)) continue;
        count += 1;
      }
      // `github.com/eier/repo` er alt telt over; en ren tekstomtale kommer i tillegg.
      if (count > 0) bump("repo", repo, repo, count);
    }
  }

  private extractProjectKeys(text: string, bump: (kind: EntityKind, key: string, name: string, count?: number) => void): void {
    for (const match of text.matchAll(PROJECT_KEY_RE)) {
      const prefix = match[1] as string;
      const number = match[2] as string;
      if (PROJECT_KEY_DENY.has(prefix)) continue;
      if (/^(19|20)\d{2}$/.test(number)) continue; // «FY-2026»-lignende årstall er ikke saksnummer
      bump("project_key", prefix, prefix);
    }
  }

  private extractParticipants(input: EntityExtractionInput, bump: (kind: EntityKind, key: string, name: string, count?: number, memoryEntityId?: string) => void): void {
    // Kun møtereferat bærer en deltakerliste kilden selv har laget (navn + nøytral ref, aldri e-post). Andre kilders metadata er ikke en deltakerliste.
    if (input.source_type !== "meeting_transcript") return;
    const participants = input.metadata["participants"];
    if (!Array.isArray(participants)) return;
    const index = input.known.length > 0 ? this.knownIndex(input.known) : undefined;
    for (const p of participants.slice(0, ENTITY_LIMITS.maxParticipants)) {
      if (typeof p !== "object" || p === null || Array.isArray(p)) continue;
      const name = (p as Record<string, JsonValue>)["name"];
      if (typeof name !== "string" || name.includes("@")) continue;
      const key = normalizeEntityName(name);
      if (key.length < ENTITY_LIMITS.minNameChars) continue;
      // Et navn som også er en kjent PERSON i minnet får minnets id (samme rad); en annen art med samme navn gjør ikke deltakeren til noe annet enn en person.
      const known = index?.byPhrase.get(key);
      bump("person", key, name, 1, known?.kind === "person" ? known.entity.entity_id : undefined);
    }
  }
}
