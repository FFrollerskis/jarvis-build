import { createHash } from "node:crypto";
import { composeSignals, currentCallSignal } from "../call-signal.ts";
import { UnsafeVendorUrlError, guardedFetch } from "../url-safety.ts";

/**
 * WP-G2 (D-464, UA-8 Personal Twin) P2e: Apple Kalender / Påminnelser / Kontakter over STANDARDPROTOKOLLENE CalDAV (RFC 4791) og CardDAV (RFC 6352) - en ADAPTER, ikke kjerne (D-64): Jarvis' egen kalender-/kontaktmodell forblir kanonisk, iCloud er kilde og sluk.
 * Alt her er bygget og testet mot en FALSK transport (ingen ekte nettkall); live mot iCloud er `BLOCKED_EXTERNAL` (eieren lager det app-spesifikke passordet, D-108; endepunkter, prinsipal-oppdagelse og Apples vCard-/iCalendar-dialekt er `unverified`).
 * Reglene (håndhevet i kode):
 *  - ALLOWLIST: kun eier-listede samlinger (`kind:navn=https://vert/sti/`) kan nås; hver forespørsel må ligge under en slik samlings URL (SSRF-vern: kun https, ingen IP/localhost/port/brukernavn i URL, aldri redirect).
 *  - INJEKSJONSVERN: all tekst går gjennom RFC 5545/6350-escaping og linjefolding; kontrolltegn avvises; typer/parametere er faste konstanter, aldri innsendt.
 *  - INGEN DATATAP ved endring: en oppdatering endrer KUN de oppgitte egenskapene i selve komponenten og lar alt annet (varsler, deltakere, ukjente felt) stå urørt; serien i et gjentakende arrangement flyttes aldri (avvist).
 *  - IDEMPOTENS/KONKURRANSE: opprettelse bruker en UID utledet fra idempotensnøkkelen + `If-None-Match: *`; endring/sletting krever `If-Match` med etag fra siste lesing (412 = noen andre endret den).
 *  - READBACK: etter hver mutasjon leses ressursen tilbake og sammenlignes (`SUCCESS`/`REPLAYED`/`MISMATCH`); et uavklart svar etter sending er `UNKNOWN` - aldri en blind retry.
 *  - Innhold fra serveren (titler, notater, navn) er UBETRODD data: kuttet og aldri tolket som instruks.
 */
export const DAV_KINDS = ["calendar", "reminders", "contacts"] as const;
export type DavKind = (typeof DAV_KINDS)[number];

export interface DavCollection { name: string; kind: DavKind; /** Slutter alltid på «/». */ url: string }

export type DavErrorCode =
  | "collection_not_allowed" | "invalid_input" | "invalid_text" | "invalid_uid" | "invalid_etag" | "unsupported_change" | "not_found" | "etag_mismatch" | "dav_credentials_unavailable" | "dav_unreachable"
  | "dav_redirect_refused" | "dav_response_too_large" | "dav_auth_rejected" | "dav_malformed_response" | "dav_rejected" | "url_not_allowed"
  // Stoppvakten (kill switch / tilbakekalt credential) FØR hver utsendelse - se `DavSendGuard`.
  | "dav_kill_switch_active" | "dav_credential_revoked" | "dav_guard_unavailable"
  // En hendelse MED deltakere: endring/sletting kan sende e-post til andre (iTIP) og krever eksplisitt eier-bekreftelse.
  | "attendees_confirmation_required";
export class DavError extends Error {
  constructor(readonly code: DavErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.name = "DavError";
  }
}

export interface DavRequest { method: "PROPFIND" | "REPORT" | "GET" | "PUT" | "DELETE"; url: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
export interface DavResponse { status: number; headers: Record<string, string>; body: string }
export interface DavTransport { request(request: DavRequest): Promise<DavResponse> }

// ---------------------------------------------------------------------------------------------------------------------
// Konfigurasjon: eierens samlinger (allowlist)
// ---------------------------------------------------------------------------------------------------------------------
const ENTRY = /^(calendar|reminders|contacts):([a-z0-9][a-z0-9_-]{0,39})=(https:\/\/\S+)$/;
const PATH = /^\/[A-Za-z0-9._~%/@:+=-]*$/;

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Jokertegn-DNS-tjenester som løser `<ip>.<tjeneste>` til IP-en: en vanlig tastefeil-/omvei-vei til localhost og interne adresser. */
const WILDCARD_DNS = /(?:^|\.)(?:nip\.io|sslip\.io|xip\.io|traefik\.me|localtest\.me|lvh\.me|vcap\.me)$/;
/** En IPv4 skjult i vertsnavnet (`127.0.0.1.nip.io`, `169-254-169-254.sslip.io`, `app.10.0.0.5.example.com`): fire oktetter 0-255 adskilt av `.`/`-`. */
const embedsIpv4 = (host: string): boolean => {
  const m = /(?:^|[.-])(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})(?:$|[.-])/.exec(host);
  return m !== null && m.slice(1, 5).every((o) => Number(o) <= 255);
};

/**
 * Gyldig https-URL til en samling: DNS-navn med punktum (ikke IP/localhost), standardport, ingen brukerinfo/spørring/fragment, trygg sti. `null` = avvist. Et TASTEFEIL-vern for eierens EGEN konfig (review B LOW-8), IKKE en
 * SSRF-garanti: `localhost.` (sluttpunktum normaliseres bort), `*.localhost`, `*.internal`, jokertegn-DNS og en innebygd IPv4 avvises; `*.local` (mDNS; selv-hostet NAS) godtas bevisst. Selve utsendelsen går uansett via `guardedFetch` (D-436).
 */
export function normalizeCollectionUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || !host.includes(".") || !host.split(".").every((label) => HOST_LABEL.test(label))) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || WILDCARD_DNS.test(host) || embedsIpv4(host)) return null;
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  if (!PATH.test(path) || path.includes("..")) return null;
  return `https://${host}${path}`;
}

/** `kind:navn=https://vert/sti/` adskilt med komma/mellomrom. Ugyldige og dupliserte oppføringer forkastes (fail closed: ingenting utenfor listen kan nås). */
export function parseDavCollections(raw: string | undefined): { collections: DavCollection[]; rejected: number } {
  const collections: DavCollection[] = [];
  let rejected = 0;
  for (const token of (raw ?? "").split(/[\s,]+/).filter((t) => t.length > 0)) {
    const m = ENTRY.exec(token);
    const url = m ? normalizeCollectionUrl(m[3] as string) : null;
    if (!m || url === null || collections.some((c) => c.name === m[2])) { rejected += 1; continue; }
    collections.push({ kind: m[1] as DavKind, name: m[2] as string, url });
  }
  return { collections, rejected };
}

// ---------------------------------------------------------------------------------------------------------------------
// iCalendar / vCard: escaping, folding, parsing, patching
// ---------------------------------------------------------------------------------------------------------------------
export function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Tekst fra eieren: streng, uten kontrolltegn (unntatt linjeskift og tab) og innenfor lengdegrensen. */
export function cleanText(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || value.length > max) throw new DavError("invalid_text", field);
  for (const ch of value) { const c = ch.charCodeAt(0); if ((c < 32 && c !== 10 && c !== 9) || c === 127) throw new DavError("invalid_text", field); }
  return value;
}

export function foldLine(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 75) { out.push(cur); cur = ` ${ch}`; } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n");
}

/** Folder ut linjer (RFC 5545 §3.1): en linje som begynner med mellomrom/tab hører til forrige. */
export function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines.filter((l) => l.length > 0);
}

/** `group`: vCard-gruppen (`item1.EMAIL` -> gruppe `ITEM1`, navn `EMAIL`; RFC 6350 §3.3). Apple bruker den for primære e-poster/telefoner og etiketter (`item1.X-ABLabel`). */
export interface Prop { name: string; params: Record<string, string>; value: string; group?: string }
export function parseProp(line: string): Prop | null {
  let inQuote = false;
  let cut = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) { cut = i; break; }
  }
  if (cut < 1) return null;
  const [name, ...rawParams] = line.slice(0, cut).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) { const eq = p.indexOf("="); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, ""); }
  const grouped = /^([A-Za-z0-9-]+)\.([A-Za-z0-9-]+)$/.exec(name as string);
  return grouped ? { name: (grouped[2] as string).toUpperCase(), group: (grouped[1] as string).toUpperCase(), params, value: line.slice(cut + 1) } : { name: (name as string).toUpperCase(), params, value: line.slice(cut + 1) };
}

/** Finner den første komponenten med navnet (`BEGIN:NAME` ... tilhørende `END:NAME`, nesting telt) og gir indeksene samt egenskapene på DENS nivå (ikke i underkomponenter som VALARM). */
export function findComponent(lines: readonly string[], name: string): { start: number; end: number; props: Array<{ index: number; prop: Prop }> } | null {
  const begin = `BEGIN:${name}`;
  const start = lines.findIndex((l) => l.toUpperCase() === begin);
  if (start < 0) return null;
  let depth = 0;
  const props: Array<{ index: number; prop: Prop }> = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const upper = (lines[i] as string).toUpperCase();
    if (upper.startsWith("BEGIN:")) { depth += 1; continue; }
    if (upper.startsWith("END:")) { if (depth === 0) return { start, end: i, props }; depth -= 1; continue; }
    if (depth === 0) { const prop = parseProp(lines[i] as string); if (prop) props.push({ index: i, prop }); }
  }
  return null;
}

/** Erstatter/fjerner egenskaper på komponentens eget nivå; ALT annet (underkomponenter, ukjente egenskaper) står urørt. `null`/tom liste = fjern. Nye linjer settes inn rett før `END:`. */
export function patchComponent(raw: string, component: string, changes: Record<string, string[] | null>): string {
  const lines = unfold(raw);
  const found = findComponent(lines, component);
  if (!found) throw new DavError("dav_malformed_response", `no_${component}`);
  const names = new Set(Object.keys(changes));
  const hit = found.props.filter((p) => names.has(p.prop.name));
  // En erstattet egenskap i en vCard-GRUPPE (`item1.EMAIL`) tar sin gruppes øvrige egenskaper (etiketten `item1.X-ABLabel`) med seg - ellers står en foreldreløs etikett igjen. Andre grupper rører vi ikke.
  const groups = new Set(hit.flatMap((p) => (p.prop.group === undefined ? [] : [p.prop.group])));
  const drop = new Set([...hit, ...found.props.filter((p) => p.prop.group !== undefined && groups.has(p.prop.group))].map((p) => p.index));
  const added = Object.values(changes).flatMap((v) => v ?? []);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (drop.has(i)) return;
    if (i === found.end) out.push(...added);
    out.push(line);
  });
  return `${out.map(foldLine).join("\r\n")}\r\n`;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Tidspunkt MED sone (`Z` eller ±hh:mm) - aldri uten (tolkes da som serverens lokale tid), aldri tekst rundt. Sekunder er valgfrie (brøkdel avkortes). */
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * `YYYY-MM-DD` (heldag) eller et ISO-tidspunkt MED sone -> iCalendar-verdi (UTC) og parametere. STRENG (fiks-runde review B LOW-2): ugyldig dato (`2026-02-30`, kl 25) avvises i stedet for å skifte stille til 2. mars,
 * og et tidspunkt uten sone avvises (ville blitt tolket som serverens lokale tid).
 */
export function toIcsDate(input: unknown, field: string): { value: string; allDay: boolean } {
  if (typeof input !== "string") throw new DavError("invalid_input", field);
  if (DATE_ONLY.test(input)) {
    const d = new Date(`${input}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input) throw new DavError("invalid_input", field);
    return { value: input.replaceAll("-", ""), allDay: true };
  }
  const m = DATETIME.exec(input);
  if (!m) throw new DavError("invalid_input", field);
  const [y, mo, day, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  const wall = new Date(Date.UTC(y, mo - 1, day, h, mi, s));
  if (wall.getUTCFullYear() !== y || wall.getUTCMonth() !== mo - 1 || wall.getUTCDate() !== day || h > 23 || mi > 59 || s > 59) throw new DavError("invalid_input", field);
  const zone = m[7] as string;
  const offsetMin = zone === "Z" ? 0 : (zone.startsWith("-") ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
  if (Math.abs(offsetMin) > 14 * 60) throw new DavError("invalid_input", field);
  const d = new Date(wall.getTime() - offsetMin * 60_000);
  return { value: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`, allDay: false };
}

/** `null` = gyldig par. Begge må være samme type (heldag eller tidspunkt), og `end` kan ikke ligge før `start` (en blandet/omvendt hendelse er ugyldig iCalendar og ble tidligere overlatt til serveren). */
export function eventRangeError(start: { value: string; allDay: boolean } | null, end: { value: string; allDay: boolean } | null): string | null {
  if (start === null || end === null) return null;
  if (start.allDay !== end.allDay) return "mixed_date_types";
  return end.value < start.value ? "end_before_start" : null;
}
const stamp = (d: Date): string => toIcsDate(d.toISOString(), "stamp").value;
const dateLine = (name: string, v: { value: string; allDay: boolean }): string => (v.allDay ? `${name};VALUE=DATE:${v.value}` : `${name}:${v.value}`);

function tzOffsetMs(at: number, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)).map((x) => [x.type, x.value])) as Record<string, string>;
  return Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]), Number(p["hour"]), Number(p["minute"]), Number(p["second"])) - Math.floor(at / 1000) * 1000;
}

/** iCalendar-dato -> ISO. Støtter `YYYYMMDD` (heldag), UTC (`...Z`) og lokal tid med IANA-`TZID` (Apple bruker IANA-navn, `unverified`); flytende tid tolkes som UTC. Ukjent/ugyldig = `null`. */
export function fromIcsDate(prop: Prop | undefined): { iso: string; allDay: boolean } | null {
  if (!prop) return null;
  const v = prop.value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return { iso: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  const tz = prop.params["TZID"];
  if (m[7] === "Z" || tz === undefined) return { iso: new Date(guess).toISOString(), allDay: false };
  try {
    const first = guess - tzOffsetMs(guess, tz);
    return { iso: new Date(guess - tzOffsetMs(first, tz)).toISOString(), allDay: false };
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Felter -> ressurser; ressurser -> elementer
// ---------------------------------------------------------------------------------------------------------------------
const UID = /^[A-Za-z0-9][A-Za-z0-9._@-]{5,119}$/;
const ETAG = /^(W\/)?"[^"\r\n]{1,150}"$/;
export const assertUid = (uid: unknown): string => { if (typeof uid !== "string" || !UID.test(uid)) throw new DavError("invalid_uid"); return uid; };
export const assertEtag = (etag: unknown): string => { if (typeof etag !== "string" || !ETAG.test(etag)) throw new DavError("invalid_etag"); return etag; };

export interface DavFields {
  summary?: string; start?: string; end?: string; location?: string; description?: string; status?: string;
  due?: string; completed?: boolean;
  full_name?: string; emails?: string[]; phones?: string[]; org?: string; note?: string;
}
const ALLOWED_FIELDS: Readonly<Record<DavKind, readonly string[]>> = {
  calendar: ["summary", "start", "end", "location", "description", "status"],
  reminders: ["summary", "due", "completed", "description"],
  contacts: ["full_name", "emails", "phones", "org", "note"]
};
const EVENT_STATUS = ["CONFIRMED", "TENTATIVE", "CANCELLED"];
const LIST_MAX = 5;

/** Valgte egenskaper -> `{ NAVN: linjer }` (null = fjern). Strengt skjema per slag; ukjente felt avvises. */
export function propertyChanges(kind: DavKind, fields: unknown, now: Date): Record<string, string[] | null> {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new DavError("invalid_input", "fields");
  const f = fields as Record<string, unknown>;
  const unknown = Object.keys(f).filter((k) => !ALLOWED_FIELDS[kind].includes(k));
  if (unknown.length > 0) throw new DavError("invalid_input", "unknown_field");
  const out: Record<string, string[] | null> = {};
  const text = (name: string, key: string, max: number): void => { if (f[key] !== undefined) out[name] = f[key] === null || f[key] === "" ? null : [`${name}:${escapeText(cleanText(f[key], max, key))}`]; };
  const list = (name: string, key: string, params: string): void => {
    if (f[key] === undefined) return;
    if (!Array.isArray(f[key]) || (f[key] as unknown[]).length > LIST_MAX) throw new DavError("invalid_input", key);
    out[name] = (f[key] as unknown[]).map((v) => `${name}${params}:${escapeText(cleanText(v, 200, key))}`);
  };
  if (kind === "calendar") {
    text("SUMMARY", "summary", 200); text("LOCATION", "location", 200); text("DESCRIPTION", "description", 2000);
    if (f["status"] !== undefined) { if (typeof f["status"] !== "string" || !EVENT_STATUS.includes(f["status"])) throw new DavError("invalid_input", "status"); out["STATUS"] = [`STATUS:${f["status"]}`]; }
    for (const [key, name] of [["start", "DTSTART"], ["end", "DTEND"]] as const) if (f[key] !== undefined) out[name] = [dateLine(name, toIcsDate(f[key], key))];
    // Begge i samme kall: samme type (heldag/tidspunkt) og `end` ikke før `start`. (Ved endring av KUN den ene sjekker klienten mot den eksisterende verdien.)
    if (f["start"] !== undefined && f["end"] !== undefined) {
      const bad = eventRangeError(toIcsDate(f["start"], "start"), toIcsDate(f["end"], "end"));
      if (bad !== null) throw new DavError("invalid_input", bad);
    }
    // DURATION og DTEND utelukker hverandre i en VEVENT (RFC 5545 §3.6.1): en ny `end` fjerner en eksisterende DURATION.
    if (f["end"] !== undefined) out["DURATION"] = null;
  } else if (kind === "reminders") {
    text("SUMMARY", "summary", 200); text("DESCRIPTION", "description", 2000);
    if (f["due"] !== undefined) out["DUE"] = f["due"] === null ? null : [dateLine("DUE", toIcsDate(f["due"], "due"))];
    if (f["completed"] !== undefined) {
      if (typeof f["completed"] !== "boolean") throw new DavError("invalid_input", "completed");
      out["STATUS"] = [f["completed"] ? "STATUS:COMPLETED" : "STATUS:NEEDS-ACTION"];
      out["COMPLETED"] = f["completed"] ? [`COMPLETED:${stamp(now)}`] : null;
      out["PERCENT-COMPLETE"] = f["completed"] ? ["PERCENT-COMPLETE:100"] : null;
    }
  } else {
    if (f["full_name"] !== undefined) {
      const name = cleanText(f["full_name"], 200, "full_name").trim();
      if (name.length === 0) throw new DavError("invalid_input", "full_name");
      const cut = name.lastIndexOf(" ");
      out["FN"] = [`FN:${escapeText(name)}`];
      out["N"] = [cut < 0 ? `N:${escapeText(name)};;;;` : `N:${escapeText(name.slice(cut + 1))};${escapeText(name.slice(0, cut))};;;`];
    }
    list("EMAIL", "emails", ";TYPE=INTERNET"); list("TEL", "phones", ";TYPE=VOICE"); text("ORG", "org", 200); text("NOTE", "note", 2000);
  }
  return out;
}

function documentFor(kind: DavKind, uid: string, changes: Record<string, string[] | null>, now: Date): string {
  const body = Object.values(changes).flatMap((v) => v ?? []);
  const lines = kind === "contacts"
    ? ["BEGIN:VCARD", "VERSION:3.0", "PRODID:-//Jarvis//WP-G2//EN", `UID:${uid}`, ...body, `REV:${stamp(now)}`, "END:VCARD"]
    : ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Jarvis//WP-G2//EN", "CALSCALE:GREGORIAN", kind === "calendar" ? "BEGIN:VEVENT" : "BEGIN:VTODO", `UID:${uid}`, `DTSTAMP:${stamp(now)}`, ...body, kind === "calendar" ? "END:VEVENT" : "END:VTODO", "END:VCALENDAR"];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

const componentOf = (kind: DavKind): string => (kind === "calendar" ? "VEVENT" : kind === "reminders" ? "VTODO" : "VCARD");
const extOf = (kind: DavKind): string => (kind === "contacts" ? ".vcf" : ".ics");
const short = (v: string | undefined, max: number): string | undefined => (v === undefined ? undefined : v.slice(0, max));

export interface DavItem {
  /** `has_attendees` (hendelser og oppgaver): endring/sletting kan da sende e-post til deltakerne (iTIP, uverifisert mot iCloud) og krever eksplisitt eier-bekreftelse. */
  kind: DavKind; uid: string; href: string; etag: string | null; recurring?: boolean; has_attendees?: boolean;
  summary?: string; start?: string; end?: string; all_day?: boolean; location?: string; description?: string; status?: string;
  due?: string; completed?: boolean; full_name?: string; emails?: string[]; phones?: string[]; org?: string; note?: string;
}

/** Ressurs (tekst) -> normalisert element. Innholdet er UBETRODDE data: kuttet, aldri en instruks. `null` = ikke en gyldig ressurs av dette slaget. */
export function itemFromResource(kind: DavKind, raw: string, href: string, etag: string | null): DavItem | null {
  const found = findComponent(unfold(raw), componentOf(kind));
  if (!found) return null;
  const by = (name: string): Prop[] => found.props.filter((p) => p.prop.name === name).map((p) => p.prop);
  const text = (name: string, max = 200): string | undefined => { const p = by(name)[0]; return p === undefined ? undefined : short(unescapeText(p.value), max); };
  const uid = by("UID")[0]?.value.trim();
  if (uid === undefined || uid.length === 0) return null;
  const item: DavItem = { kind, uid: uid.slice(0, 120), href, etag };
  const set = <K extends keyof DavItem>(key: K, value: DavItem[K] | undefined): void => { if (value !== undefined) item[key] = value; };
  if (kind === "calendar") {
    const s = fromIcsDate(by("DTSTART")[0]); const e = fromIcsDate(by("DTEND")[0]);
    set("summary", text("SUMMARY")); set("start", s?.iso); set("end", e?.iso); set("all_day", s?.allDay); set("location", text("LOCATION")); set("description", text("DESCRIPTION", 500)); set("status", text("STATUS"));
    item.recurring = by("RRULE").length > 0 || by("RECURRENCE-ID").length > 0 || by("RDATE").length > 0;
    item.has_attendees = by("ATTENDEE").length > 0;
  } else if (kind === "reminders") {
    set("summary", text("SUMMARY")); set("due", fromIcsDate(by("DUE")[0])?.iso); set("description", text("DESCRIPTION", 500)); set("status", text("STATUS"));
    item.completed = by("STATUS")[0]?.value.trim().toUpperCase() === "COMPLETED" || by("COMPLETED").length > 0;
    item.recurring = by("RRULE").length > 0;
    item.has_attendees = by("ATTENDEE").length > 0;
  } else {
    set("full_name", text("FN")); set("org", text("ORG")); set("note", text("NOTE", 500));
    item.emails = by("EMAIL").slice(0, LIST_MAX).map((p) => unescapeText(p.value).slice(0, 200));
    item.phones = by("TEL").slice(0, LIST_MAX).map((p) => unescapeText(p.value).slice(0, 200));
  }
  return item;
}

// ---------------------------------------------------------------------------------------------------------------------
// WebDAV: forespørsler og multistatus
// ---------------------------------------------------------------------------------------------------------------------
const xmlEscape = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Gyldig tegn fra en numerisk tegnreferanse (ikke surrogat, ikke utenfor Unicode); ellers tomt (aldri en kastet feil på fiendtlig input). */
const charRef = (cp: number): string => (Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "");
/**
 * Pakker ut `<![CDATA[...]]>`-seksjoner (første `]]>` etter åpningen avslutter; en ulukket åpning beholdes som den er). `indexOf`-løkke, LINJÆR: den gamle `/<!\[CDATA\[([\s\S]*?)\]\]>/g` lette etter `]]>` til slutten av teksten fra HVER ulukkede åpning,
 * så `<![CDATA[` gjentatt uten lukking var kvadratisk (11,6 s på 1 MiB, delta-review B NY-1). Uten en lukking etter den første åpningen finnes ingen etter en senere heller, så løkken kan stoppe der.
 */
function stripCdata(v: string): string {
  const OPEN = "<![CDATA[";
  const CLOSE = "]]>";
  let out = "";
  let pos = 0;
  for (;;) {
    const open = v.indexOf(OPEN, pos);
    if (open < 0) break;
    const close = v.indexOf(CLOSE, open + OPEN.length);
    if (close < 0) break;
    out += v.slice(pos, open) + v.slice(open + OPEN.length, close);
    pos = close + CLOSE.length;
  }
  return pos === 0 ? v : out + v.slice(pos);
}
/** `&amp;` sist (ellers dekodes `&amp;#xD;` dobbelt). Numeriske tegnreferanser (`&#xD;`, `&#13;`) dekodes - en server som sender `&#xD;&#10;` mellom linjene skal ikke gi `&#xD;`-haler (review B LOW-3). */
const xmlDecode = (v: string): string => stripCdata(v).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]{1,6});/g, (_m, hex: string) => charRef(Number.parseInt(hex, 16))).replace(/&#(\d{1,7});/g, (_m, dec: string) => charRef(Number(dec))).replace(/&amp;/g, "&");

export function reportBody(kind: DavKind, query: { from?: string; to?: string; text?: string; includeCompleted?: boolean }): string {
  if (kind === "contacts") {
    const filter = query.text === undefined ? "" : `<C:filter test="anyof"><C:prop-filter name="FN"><C:text-match collation="i;unicode-casemap" match-type="contains">${xmlEscape(query.text)}</C:text-match></C:prop-filter></C:filter>`;
    return `<?xml version="1.0" encoding="utf-8"?><C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/><C:address-data/></D:prop>${filter}</C:addressbook-query>`;
  }
  const comp = kind === "calendar" ? "VEVENT" : "VTODO";
  const range = query.from !== undefined && query.to !== undefined ? `<C:time-range start="${toIcsDate(query.from, "from").value.replace(/^(\d{8})$/, "$1T000000Z")}" end="${toIcsDate(query.to, "to").value.replace(/^(\d{8})$/, "$1T000000Z")}"/>` : "";
  return `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="${comp}">${range}</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
}

export interface MultistatusEntry { href: string; etag: string | null; data: string | null; status: number }
/**
 * Linje-token: ett tagg-token (`<tag ...>`, `</tag>`). `[^<>]*` krysser aldri en `<`, så hvert forsøk er begrenset til neste `<` (den gamle `[\s\S]*?`-regexen var kvadratisk: 12,8 s på 1 MiB uten lukking, review B LOW-3). `(?![A-Za-z0-9-])` etter navnet
 * hindrer at navnet gir fra seg tegn ett og ett: uten den prøvde motoren HVER kortere navnelengde, og `[^<>]*` skannet resten på nytt for hver (`<` + `a` x N uten `>` var fortsatt kvadratisk: 7,7 s på 128 KiB, minutter på 1 MiB, delta-review B NY-1).
 * Treffene er identiske: det som følger et kortere navn er ellers `[^<>]*>`, som også følger det fulle navnet.
 */
const TAG_TOKEN = /<(\/?)(?:[A-Za-z0-9]+:)?([A-Za-z0-9-]+)(?![A-Za-z0-9-])[^<>]*>/g;

/** Teksten i det FØRSTE elementet med dette lokale navnet (uten navnerom-prefiks), dekodet; `null` hvis det mangler eller ikke er lukket. Lineær i blokkens størrelse. */
function elementText(block: string, name: string): string | null {
  let contentStart = -1;
  for (const m of block.matchAll(TAG_TOKEN)) {
    if ((m[2] as string).toLowerCase() !== name) continue;
    if (m[1] === "") {
      if (m[0].endsWith("/>")) continue; // tomt element (`<D:getetag/>`)
      if (contentStart < 0) contentStart = (m.index as number) + m[0].length;
    } else if (contentStart >= 0) return xmlDecode(block.slice(contentStart, m.index).trim());
  }
  return null;
}

/** Minimal og defensiv: ingen XML-parser (ingen DTD/entiteter prosesseres); responser med DOCTYPE/ENTITY avvises. LINJÆR (ingen kvadratisk regex). */
export function parseMultistatus(xml: string): MultistatusEntry[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new DavError("dav_malformed_response", "doctype");
  const out: MultistatusEntry[] = [];
  let start = -1;
  for (const m of xml.matchAll(TAG_TOKEN)) {
    if ((m[2] as string).toLowerCase() !== "response") continue;
    const at = m.index as number;
    if (m[1] === "") {
      if (start < 0 && !m[0].endsWith("/>")) start = at;
      continue;
    }
    if (start < 0) continue;
    const block = xml.slice(start, at + m[0].length);
    start = -1;
    const href = elementText(block, "href");
    if (href === null) continue;
    // Statuskoden fra STATUS-ELEMENTET (ikke et tilfeldig `HTTP/1.1 404` i hendelsens tekst).
    const status = /HTTP\/1\.[01]\s+(\d{3})/.exec(elementText(block, "status") ?? "");
    out.push({ href, etag: elementText(block, "getetag"), data: elementText(block, "calendar-data") ?? elementText(block, "address-data"), status: status ? Number(status[1]) : 200 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Klient
// ---------------------------------------------------------------------------------------------------------------------
export type DavOutcome = "SUCCESS" | "REPLAYED" | "MISMATCH" | "UNKNOWN";
export interface DavMutationResult { outcome: DavOutcome; uid: string; etag: string | null; item?: DavItem; reason?: string }

/** Idempotent UID: samme samling + idempotensnøkkel gir ALLTID samme UID (en gjentatt opprettelse treffer `If-None-Match: *` og blir en readback, ikke en duplikat). */
export function uidFromKey(collection: string, idempotencyKey: string): string {
  return `jarvis-${createHash("sha256").update(`${collection}${String.fromCharCode(0)}${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

/** Feil som BEVISER at forespørselen ikke ble utført (avvist før sending eller av serveren). Alt annet etter en mutasjon (tidsavbrudd, nullstilt tilkobling, for stort svar) er et UAVKLART utfall. */
const DEFINITELY_NOT_APPLIED: ReadonlySet<string> = new Set([
  "url_not_allowed", "dav_credentials_unavailable", "dav_auth_rejected", "dav_redirect_refused", "dav_kill_switch_active", "dav_credential_revoked", "dav_guard_unavailable"
]);
const definitelyNotApplied = (err: unknown): boolean => err instanceof DavError && DEFINITELY_NOT_APPLIED.has(err.code);

export interface AppleDavClientOptions { transport: DavTransport; collections: readonly DavCollection[]; now?: () => Date }

/**
 * `allowAttendeeNotification`: eieren bekrefter at endring/sletting av en hendelse MED deltakere er ønsket selv om serveren kan sende e-post til dem (server-side scheduling/iTIP, RFC 6638 - IKKE verifisert mot iCloud; en sendt e-post kan
 * ikke trekkes tilbake). Uten den nektes endring/sletting av en slik hendelse (`attendees_confirmation_required`, ingenting sendt).
 */
export interface DavMutationOptions { allowAttendeeNotification?: boolean }

export class AppleDavClient {
  private readonly transport: DavTransport;
  private readonly collections: readonly DavCollection[];
  private readonly now: () => Date;
  constructor(options: AppleDavClientOptions) {
    this.transport = options.transport;
    this.collections = options.collections;
    this.now = options.now ?? (() => new Date());
  }

  listCollections(): Array<{ name: string; kind: DavKind }> { return this.collections.map((c) => ({ name: c.name, kind: c.kind })); }

  private collection(name: unknown): DavCollection {
    const found = typeof name === "string" ? this.collections.find((c) => c.name === name) : undefined;
    if (!found) throw new DavError("collection_not_allowed");
    return found;
  }

  private hrefFor(c: DavCollection, uid: string): string { return `${c.url}${encodeURIComponent(assertUid(uid))}${extOf(c.kind)}`; }

  /** Serverens href må ligge under samlingen (aldri en annen vert/sti): ellers ignoreres elementet. */
  private safeHref(c: DavCollection, href: string): string | null {
    try {
      const url = new URL(href, c.url);
      const normalized = `https://${url.hostname.toLowerCase()}${url.pathname}`;
      return url.protocol === "https:" && url.port === "" && normalized.startsWith(c.url) && !url.pathname.includes("..") ? normalized : null;
    } catch { return null; }
  }

  private async send(request: DavRequest): Promise<DavResponse> {
    const response = await this.transport.request(request);
    if (response.status === 401 || response.status === 403) throw new DavError("dav_auth_rejected");
    return response;
  }

  async list(name: unknown, query: { from?: string; to?: string; text?: string; limit?: number } = {}): Promise<DavItem[]> {
    const c = this.collection(name);
    if (query.text !== undefined) cleanText(query.text, 100, "text");
    // `from`/`to` hører sammen (ett av dem alene ville stille blitt «alt»); `limit` klemmes til 1-200 (en negativ verdi skal aldri bli «alt unntatt de siste»).
    if ((query.from === undefined) !== (query.to === undefined)) throw new DavError("invalid_input", "from_and_to_together");
    const limit = query.limit === undefined || !Number.isFinite(query.limit) ? 100 : Math.max(1, Math.min(Math.trunc(query.limit), 200));
    const response = await this.send({ method: "REPORT", url: c.url, headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" }, body: reportBody(c.kind, query) });
    if (response.status !== 207) throw new DavError("dav_rejected", String(response.status));
    const items: DavItem[] = [];
    for (const entry of parseMultistatus(response.body)) {
      const href = this.safeHref(c, entry.href);
      if (href === null || entry.data === null || entry.status >= 400) continue;
      const item = itemFromResource(c.kind, entry.data, href, entry.etag);
      if (item) items.push(item);
    }
    return items.slice(0, limit);
  }

  async get(name: unknown, uid: string): Promise<DavItem | null> {
    const c = this.collection(name);
    const href = this.hrefFor(c, uid);
    const response = await this.send({ method: "GET", url: href, headers: { Accept: c.kind === "contacts" ? "text/vcard" : "text/calendar" } });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new DavError("dav_rejected", String(response.status));
    return itemFromResource(c.kind, response.body, href, response.headers["etag"] ?? null);
  }

  private async raw(c: DavCollection, uid: string): Promise<{ body: string; etag: string | null } | null> {
    const response = await this.send({ method: "GET", url: this.hrefFor(c, uid), headers: {} });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new DavError("dav_rejected", String(response.status));
    return { body: response.body, etag: response.headers["etag"] ?? null };
  }

  private matches(item: DavItem | null, expected: Record<string, string[] | null>, kind: DavKind): boolean {
    return item !== null && expectedMatches(item, expected, kind);
  }

  private async readbackOutcome(c: DavCollection, uid: string, expected: Record<string, string[] | null>, replayed: boolean): Promise<DavMutationResult> {
    let item: DavItem | null;
    try { item = await this.get(c.name, uid); } catch { return { outcome: "UNKNOWN", uid, etag: null, reason: "readback_failed" }; }
    if (item !== null && this.matches(item, expected, c.kind)) return { outcome: replayed ? "REPLAYED" : "SUCCESS", uid, etag: item.etag, item };
    return { outcome: "MISMATCH", uid, etag: item?.etag ?? null, ...(item ? { item } : {}), reason: item === null ? "readback_not_found" : "readback_differs" };
  }

  async create(name: unknown, idempotencyKey: unknown, fields: unknown): Promise<DavMutationResult> {
    const c = this.collection(name);
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new DavError("invalid_input", "idempotency_key");
    const changes = propertyChanges(c.kind, fields, this.now());
    // En tom/null/blank tittel er «mangler» (`summary: ""` ble tidligere `null` = ingen SUMMARY, men passerte «kreves»-sjekken; review B LOW-2).
    const blank = (v: string[] | null | undefined): boolean => v === undefined || v === null || /^[A-Z-]+:\s*$/.test(v[0] ?? "");
    if (c.kind === "calendar" && (blank(changes["SUMMARY"]) || changes["DTSTART"] === undefined)) throw new DavError("invalid_input", "summary_and_start_required");
    if (c.kind === "reminders" && blank(changes["SUMMARY"])) throw new DavError("invalid_input", "summary_required");
    if (c.kind === "contacts" && changes["FN"] === undefined) throw new DavError("invalid_input", "full_name_required");
    const uid = uidFromKey(c.name, idempotencyKey);
    let response: DavResponse;
    try {
      response = await this.send({ method: "PUT", url: this.hrefFor(c, uid), headers: { "If-None-Match": "*", "Content-Type": c.kind === "contacts" ? "text/vcard; charset=utf-8" : "text/calendar; charset=utf-8" }, body: documentFor(c.kind, uid, changes, this.now()) });
    } catch (err) {
      if (definitelyNotApplied(err)) throw err;
      // Uavklart etter sending: readback avgjør. Viser den ønsket tilstand er den bevist; ellers er utfallet UKJENT (aldri en blind retry).
      const after = await this.readbackOutcome(c, uid, changes, false);
      return after.outcome === "SUCCESS" ? { ...after, reason: "confirmed_by_readback_after_transport_error" } : { outcome: "UNKNOWN", uid, etag: null, reason: "transport_error_after_send" };
    }
    if (response.status === 201 || response.status === 204 || response.status === 200) return this.readbackOutcome(c, uid, changes, false);
    if (response.status === 412) return this.readbackOutcome(c, uid, changes, true); // finnes fra før: samme innhold = gjentatt kall (REPLAYED), ellers MISMATCH
    if (response.status >= 500) return { outcome: "UNKNOWN", uid, etag: null, reason: `server_${response.status}` };
    throw new DavError("dav_rejected", String(response.status));
  }

  async update(name: unknown, uid: unknown, expectedEtag: unknown, fields: unknown, options: DavMutationOptions = {}): Promise<DavMutationResult> {
    const c = this.collection(name);
    const id = assertUid(uid);
    const etag = assertEtag(expectedEtag);
    const changes = propertyChanges(c.kind, fields, this.now());
    if (Object.keys(changes).length === 0) throw new DavError("invalid_input", "no_changes");
    const current = await this.raw(c, id);
    if (current === null) throw new DavError("not_found");
    if (current.etag !== etag) throw new DavError("etag_mismatch");
    const existing = itemFromResource(c.kind, current.body, this.hrefFor(c, id), current.etag);
    // Deltakere: serveren kan sende e-post til dem ved endring (iTIP). Uten eierens eksplisitte bekreftelse sendes INGENTING (review B LOW-7).
    if (existing?.has_attendees === true && options.allowAttendeeNotification !== true) throw new DavError("attendees_confirmation_required");
    if (existing?.recurring === true && (changes["DTSTART"] !== undefined || changes["DTEND"] !== undefined || changes["DUE"] !== undefined)) throw new DavError("unsupported_change", "recurring_time_change");
    // Ved endring av KUN start eller end måles den nye verdien mot den eksisterende: samme type (heldag/tidspunkt) og `end` ikke før `start` (review B LOW-2).
    if (c.kind === "calendar" && (changes["DTSTART"] !== undefined || changes["DTEND"] !== undefined)) {
      const side = (key: "start" | "end"): { value: string; allDay: boolean } | null => {
        const given = (fields as Record<string, unknown>)[key];
        const source = given !== undefined ? given : existing?.[key];
        if (source === undefined) return null;
        try { return toIcsDate(source, key); } catch { return null; } // en eksisterende verdi vi ikke forstår hindrer ikke endringen
      };
      const bad = eventRangeError(side("start"), side("end"));
      if (bad !== null) throw new DavError("invalid_input", bad);
    }
    const component = componentOf(c.kind);
    const seq = c.kind === "contacts" ? 0 : Number(findComponent(unfold(current.body), component)?.props.find((p) => p.prop.name === "SEQUENCE")?.prop.value ?? 0);
    const patched = patchComponent(current.body, component, {
      ...changes,
      ...(c.kind === "contacts" ? { REV: [`REV:${stamp(this.now())}`] } : { DTSTAMP: [`DTSTAMP:${stamp(this.now())}`], "LAST-MODIFIED": [`LAST-MODIFIED:${stamp(this.now())}`], SEQUENCE: [`SEQUENCE:${(Number.isFinite(seq) ? seq : 0) + 1}`] })
    });
    let response: DavResponse;
    try {
      response = await this.send({ method: "PUT", url: this.hrefFor(c, id), headers: { "If-Match": etag, "Content-Type": c.kind === "contacts" ? "text/vcard; charset=utf-8" : "text/calendar; charset=utf-8" }, body: patched });
    } catch (err) {
      if (definitelyNotApplied(err)) throw err;
      return { outcome: "UNKNOWN", uid: id, etag: null, reason: "transport_error_after_send" };
    }
    if (response.status === 412) throw new DavError("etag_mismatch");
    if (response.status === 404) throw new DavError("not_found");
    if (response.status === 200 || response.status === 201 || response.status === 204) return this.readbackOutcome(c, id, changes, false);
    if (response.status >= 500) return { outcome: "UNKNOWN", uid: id, etag: null, reason: `server_${response.status}` };
    throw new DavError("dav_rejected", String(response.status));
  }

  async remove(name: unknown, uid: unknown, expectedEtag: unknown, options: DavMutationOptions = {}): Promise<DavMutationResult> {
    const c = this.collection(name);
    const id = assertUid(uid);
    const etag = assertEtag(expectedEtag);
    // Hendelser/oppgaver MED deltakere: sletting kan sende avlysning på e-post til andre (iTIP). Forhåndslesing (kun lesing, ingenting endret) avgjør; `If-Match` på DELETE sørger for at det vi leste er det som slettes.
    if (c.kind !== "contacts") {
      const current = await this.raw(c, id);
      if (current !== null) {
        if (current.etag !== etag) throw new DavError("etag_mismatch");
        if (itemFromResource(c.kind, current.body, this.hrefFor(c, id), current.etag)?.has_attendees === true && options.allowAttendeeNotification !== true) throw new DavError("attendees_confirmation_required");
      }
    }
    let response: DavResponse;
    try {
      response = await this.send({ method: "DELETE", url: this.hrefFor(c, id), headers: { "If-Match": etag } });
    } catch (err) {
      if (definitelyNotApplied(err)) throw err;
      return { outcome: "UNKNOWN", uid: id, etag: null, reason: "transport_error_after_send" };
    }
    if (response.status === 412) throw new DavError("etag_mismatch");
    if (response.status >= 500) return { outcome: "UNKNOWN", uid: id, etag: null, reason: `server_${response.status}` };
    if (response.status !== 200 && response.status !== 204 && response.status !== 404) throw new DavError("dav_rejected", String(response.status));
    let after: DavItem | null;
    try { after = await this.get(c.name, id); } catch { return { outcome: "UNKNOWN", uid: id, etag: null, reason: "readback_failed" }; }
    if (after !== null) return { outcome: "MISMATCH", uid: id, etag: after.etag, reason: "still_present" };
    return { outcome: response.status === 404 ? "REPLAYED" : "SUCCESS", uid: id, etag: null };
  }
}

/** Sammenligner det vi ba om med det som ble lest tilbake (kun de egenskapene vi satte). */
function expectedMatches(item: DavItem, expected: Record<string, string[] | null>, kind: DavKind): boolean {
  const lines = (name: string): string[] | null | undefined => expected[name];
  const same = (a: string | undefined, line: string[] | null | undefined, name: string): boolean => {
    if (line === undefined) return true;
    if (line === null) return a === undefined || a === "";
    const p = parseProp(line[0] as string);
    return p !== null && a === unescapeText(p.value).slice(0, name === "DESCRIPTION" || name === "NOTE" ? 500 : 200);
  };
  const dateSame = (iso: string | undefined, line: string[] | null | undefined): boolean => {
    if (line === undefined) return true;
    if (line === null) return iso === undefined;
    const p = parseProp(line[0] as string);
    return p !== null && fromIcsDate(p)?.iso === iso;
  };
  if (kind === "calendar") return same(item.summary, lines("SUMMARY"), "SUMMARY") && same(item.location, lines("LOCATION"), "LOCATION") && same(item.description, lines("DESCRIPTION"), "DESCRIPTION") && dateSame(item.start, lines("DTSTART")) && dateSame(item.end, lines("DTEND")) && (lines("STATUS") === undefined || lines("STATUS")?.[0] === `STATUS:${item.status}`);
  if (kind === "reminders") return same(item.summary, lines("SUMMARY"), "SUMMARY") && same(item.description, lines("DESCRIPTION"), "DESCRIPTION") && dateSame(item.due, lines("DUE")) && (lines("STATUS") === undefined || item.completed === (lines("STATUS")?.[0] === "STATUS:COMPLETED"));
  const listSame = (have: string[] | undefined, line: string[] | null | undefined): boolean => line === undefined || JSON.stringify((line ?? []).map((l) => unescapeText((parseProp(l)?.value ?? "")).slice(0, 200))) === JSON.stringify(have ?? []);
  return same(item.full_name, lines("FN"), "FN") && same(item.org, lines("ORG"), "ORG") && same(item.note, lines("NOTE"), "NOTE") && listSame(item.emails, lines("EMAIL")) && listSame(item.phones, lines("TEL"));
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP-transport (live = BLOCKED_EXTERNAL; testet kun med en injisert fake)
// ---------------------------------------------------------------------------------------------------------------------
/** All utgående leverandørtrafikk i `tool-gateway/src` går via `guardedFetch` (D-436: rå-URL-sjekk, ingen redirect, tidsgrense); aldri rå `fetch`. */
export type DavFetch = typeof guardedFetch;

/**
 * Stoppvakt som kjøres FØR HVER utsendelse (også lesing; en operasjon som `update` sender flere forespørsler, og en kill switch midt i skal stoppe den neste): `null` = fortsett, ellers hvorfor det stoppes. Gatewayen
 * hørte kill switch og credential-revokering for alle verktøykall; DAV-rutene går utenom gatewayen (ruter, ikke verktøy), så uten denne vakten stoppet verken `kill switch` eller `revokeCredential` utgående skriving mot iCloud
 * (fiks-runde review B, MEDIUM-1). Kaster vakten, er svaret fail-closed (`dav_guard_unavailable`).
 */
export type DavSendGuard = () => Promise<"kill_switch_active" | "credential_revoked" | null>;

export interface FetchDavTransportOptions {
  collections: readonly DavCollection[];
  /** Stoppvakten (kill switch + tilbakekalte credentials) FØR hver utsendelse. Uten den sendes alt som før (kun tester/frakoblet bruk). */
  guard?: DavSendGuard;
  /** Hentes per forespørsel fra vaulten; `null` = ikke konfigurert (fail closed). Verdiene logges aldri. */
  credentials: () => Promise<{ user: string; password: string } | null>;
  /** Standard `guardedFetch`; tester injiserer en fake (ingen nettkall). */
  fetchFn?: DavFetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Leser svaret strømmet med et hardt tak: en for stor `Content-Length` avvises før noe leses, og strømmen avbrytes så snart taket er passert (en fiendtlig/feil server kan ikke fylle minnet; tidsavbruddet tar resten).
 * `dav_response_too_large` sier ingenting om hvorvidt forespørselen ble utført: etter en mutasjon er utfallet derfor uavklart (`UNKNOWN`), aldri «bevist ikke-anvendt».
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new DavError("dav_response_too_large");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DavError("dav_response_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class FetchDavTransport implements DavTransport {
  private readonly fetchFn: DavFetch;
  constructor(private readonly options: FetchDavTransportOptions) {
    this.fetchFn = options.fetchFn ?? guardedFetch;
  }

  async request(request: DavRequest): Promise<DavResponse> {
    const url = (() => { try { return new URL(request.url); } catch { return null; } })();
    const allowed = url !== null && url.protocol === "https:" && url.port === "" && this.options.collections.some((c) => `https://${url.hostname.toLowerCase()}${url.pathname}`.startsWith(c.url));
    if (!allowed) throw new DavError("url_not_allowed");
    // Stoppvakten FØR credentials leses og FØR noe sendes (kill switch / tilbakekalt credential = ingenting forlater huset).
    if (this.options.guard !== undefined) {
      let denial: Awaited<ReturnType<DavSendGuard>>;
      try { denial = await this.options.guard(); } catch { throw new DavError("dav_guard_unavailable"); }
      if (denial !== null) throw new DavError(denial === "credential_revoked" ? "dav_credential_revoked" : "dav_kill_switch_active");
    }
    const credentials = await this.options.credentials();
    if (!credentials || credentials.user.length === 0 || credentials.password.length === 0) throw new DavError("dav_credentials_unavailable");
    // Eget tak (standard 20 s) SAMMENSATT med et evt. forespørsels-/kallsignal (aldri bare eget signal, D-471); et allerede avbrutt kall sender ingenting.
    const limit = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    const signal = composeSignals(request.signal, currentCallSignal(), limit) ?? limit;
    try {
      // `redirect: "reject"` for ALLE metoder: et 3xx-svar følges aldri (Authorization skal aldri videre til en annen vert/sti) og gir `dav_redirect_refused`.
      const response = await this.fetchFn(request.url, {
        method: request.method, redirect: "reject", signal,
        headers: { ...request.headers, Authorization: `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString("base64")}` },
        ...(request.body !== undefined ? { body: request.body } : {})
      });
      if (response.status >= 300 && response.status < 400) throw new DavError("dav_redirect_refused"); // en injisert fetch uten «reject»-håndhevelse
      const text = await readCapped(response, this.options.maxBytes ?? 1_048_576);
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      return { status: response.status, headers, body: text };
    } catch (err) {
      if (err instanceof DavError) throw err;
      if (err instanceof UnsafeVendorUrlError) throw new DavError(err.reason.startsWith("unexpected_redirect_http_") ? "dav_redirect_refused" : "url_not_allowed");
      throw new DavError("dav_unreachable"); // aldri feilteksten: den kan inneholde URL-er/hodeverdier
    }
  }
}
