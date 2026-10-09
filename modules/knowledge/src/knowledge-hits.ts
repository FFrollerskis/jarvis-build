import type { MemorySpace } from "@jarvis/contracts";
import { KNOWLEDGE_SOURCE_KINDS, type KnowledgeSourceKind } from "@jarvis/tool-gateway";
import type { KnowledgeSensitivity, KnowledgeTrustLevel } from "./sensitivity.ts";

/**
 * WP-D1 (UA-2): normalisert treff fra kunnskapslaget slik det krysser modellgrensen (`knowledge.search`). Formen er et KONTRAKTSPUNKT: skyskjermen
 * (`apps/api/src/cloud-tool-screen.ts`) kjenner NØYAKTIG disse feltene og holder et treff med et ukjent felt tilbake (fail-closed) - et nytt felt kan bære tekst
 * ingen har klassifisert. Legges et felt til her MÅ det klassifiseres i skjermen (en test mot ekte retriever-utdata feiler ellers).
 */
export interface KnowledgeHit {
  document_id: string;
  /** Konfigurert kildetype (`drive`, `obsidian`, `filesystem`, `github`, `email_attachment`, `meeting_transcript`) - ikke databasens `source_type`. */
  source_kind: string;
  title: string;
  /** Avkortet, nøytralisert utdrag (ingen kontrolltegn, ingen `<`/`>`): sitert DATA, aldri instruks. */
  snippet: string;
  /** Kildens egen lenke/sti (`canonical_uri`) - proveniens, aldri modellgenerert. */
  uri: string;
  memory_space: MemorySpace;
  sensitivity: KnowledgeSensitivity;
  trust_level: KnowledgeTrustLevel;
  score: number;
  /** Når Jarvis sist synkroniserte dokumentet (ISO). */
  observed_at: string;
  /** Kildens eget endringstidspunkt (ISO), `null` når kilden ikke oppgir det. */
  modified_at: string | null;
  /** Entiteter dokumentet nevner (navn/type, aldri e-postadresser i klartekst) - kun når entitetsgrafen er på og dokumentet er indeksert. */
  entities?: Array<{ kind: string; name: string }>;
}

/** Feltene et treff kan ha. Låst av en test mot ekte retriever-utdata og brukt av skyskjermen til fail-closed på ukjente felt. */
export const KNOWLEDGE_HIT_FIELDS: ReadonlySet<string> = new Set([
  "document_id", "source_kind", "title", "snippet", "uri", "memory_space", "sensitivity", "trust_level", "score", "observed_at", "modified_at", "entities"
]);

/** DB `source_type` -> konfigurert `kind`. Drive heter `google_drive` i databasen (P1A) men `drive` i konfigurasjon og treff. */
const SOURCE_TYPE_TO_KIND: Readonly<Record<string, KnowledgeSourceKind>> = {
  google_drive: "drive",
  obsidian: "obsidian",
  filesystem: "filesystem",
  github: "github",
  email_attachment: "email_attachment",
  meeting_transcript: "meeting_transcript"
};
const KIND_TO_SOURCE_TYPE: Readonly<Record<KnowledgeSourceKind, string>> = {
  drive: "google_drive",
  obsidian: "obsidian",
  filesystem: "filesystem",
  github: "github",
  email_attachment: "email_attachment",
  meeting_transcript: "meeting_transcript"
};

/** Ukjent `source_type` returneres uendret - skyskjermen holder da treffet tilbake til typen er gjennomgått (fail-closed). */
export function sourceKindOf(sourceType: string): string {
  return SOURCE_TYPE_TO_KIND[sourceType] ?? sourceType;
}

export function sourceTypeOf(kind: KnowledgeSourceKind): string {
  return KIND_TO_SOURCE_TYPE[kind];
}

export function isKnowledgeSourceKind(value: unknown): value is KnowledgeSourceKind {
  return typeof value === "string" && (KNOWLEDGE_SOURCE_KINDS as readonly string[]).includes(value);
}

export const SNIPPET_MAX_CHARS = 400;
export const TITLE_MAX_CHARS = 160;
export const URI_MAX_CHARS = 300;

/** Kontrolltegn (C0/C1 unntatt vanlig blank) og usynlige/toveis-formateringstegn, avgjort på kodepunkt (ingen usynlige tegn i selve kildekoden). */
const isControlCode = (code: number): boolean => code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
const isInvisibleCode = (code: number): boolean =>
  (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;

/**
 * Nøytraliserer ubetrodd tekst før den krysser modellgrensen: kontrolltegn og usynlige/toveis-tegn fjernes (kan skjule tekst eller snu leseretning), `<` og `>` byttes
 * mot `‹`/`›` (innholdet kan ikke lukke et omsluttende tagg-/delimiter-element eller etterligne et rollemerke), og blanke tegn slås sammen. Dette er DATA-hygiene,
 * ikke en erstatning for kontrollen som faktisk gjelder: resultatet tainter turen (`output_trust: "untrusted"`), så en instruks i et dokument kan aldri utløse en handling uten
 * eierens egen bundne bekreftelse.
 */
/** Fjerner usynlige/toveis-tegn og bytter kontrolltegn med blank - uten å røre vanlig tekst (brukes også av transkript-inntaket). */
export function stripControlAndInvisible(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (isInvisibleCode(code)) continue;
    out += isControlCode(code) ? " " : ch;
  }
  return out;
}

export function neutralizeUntrustedText(text: string): string {
  return stripControlAndInvisible(text).replace(/</g, "\u2039").replace(/>/g, "\u203a").replace(/\s+/g, " ").trim();
}

/** Kutter uten å dele et surrogatpar, og legger på «…» når noe ble kuttet. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // høyt surrogat helt til slutt: ta det ikke med
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * Utdraget rundt det første treffet på et søkeord (ellers starten av dokumentet), nøytralisert og avkortet. Søkeordene er allerede normalisert (små bokstaver, kun
 * bokstaver/sifre) av `queryTerms`; treff på bøyde former finnes ikke her, så uten treff vises starten av dokumentet - utdraget er ledetekst, ikke et bevis.
 */
export function extractSnippet(content: string, terms: readonly string[], max: number = SNIPPET_MAX_CHARS): string {
  const lower = content.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at === -1 ? 0 : Math.max(0, at - 80);
  // Hent mer enn `max` rå tegn: nøytraliseringen slår sammen blanke tegn og kan korte teksten.
  const window = content.slice(start, start + max * 3);
  const cleaned = neutralizeUntrustedText(window);
  const body = truncateText(cleaned, max);
  return `${start > 0 ? "…" : ""}${body}`;
}
