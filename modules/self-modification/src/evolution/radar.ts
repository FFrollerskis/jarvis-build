import { z } from "zod";
import type { EvChangeClass } from "../constitution.ts";
import { atLeast, sensitiveTouches } from "./common.ts";

/**
 * EV-3 (Evolution Masterplan v1.2 kap. 10): Continuous Improvement Radar - kun SIKKERHETSSONEN og scoringen (rene funksjoner). Selve
 * innhenting fra leverandørkilder (nettverk) er DEFERRED. Alt radarinnhold tagges UNTRUSTED_RESEARCH ved ingest; instruksjoner i kilden er data,
 * aldri kommandoer; mistenkelig innhold settes i karantene. Radar-output kan ikke bli evidens før det har passert gaten.
 */
export const RADAR_KINDS = ["model", "api", "integration", "dependency", "security", "hardware"] as const;
export type RadarKind = (typeof RADAR_KINDS)[number];

export const RadarItemSchema = z
  .object({
    kind: z.enum(RADAR_KINDS),
    source_url: z.string().url().max(500),
    source_name: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    body: z.string().max(20_000),
    fetched_at: z.string().datetime()
  })
  .strict();
export type RadarItem = z.infer<typeof RadarItemSchema>;

/** Mønstre som tyder på prompt-injection/kildemanipulasjon i ekstern tekst (norsk + engelsk). Treff = karantene + sikkerhetshendelse. */
const INJECTION_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["ignore_instructions", /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|all)\b.{0,30}\b(instruction|prompt|rule)s?\b/i],
  ["ignorer_instruksjoner", /\b(ignorer|glem)\b.{0,30}\b(tidligere|alle|forrige)\b.{0,30}\b(instruks|regel|prompt)/i],
  ["role_override", /\b(you are now|act as|new system prompt|system prompt:|developer message)\b/i],
  ["tool_authority", /\b(call|invoke|execute|run)\b.{0,20}\b(tool|function|command|shell)\b/i],
  ["pipe_to_shell", /(curl|wget)[^\n|]{0,200}\|\s*(ba|z)?sh\b/i],
  ["credential_request", /\b(send|post|upload|reveal|print)\b.{0,40}\b(api[_ -]?key|token|secret|password|credential|\.env)\b/i],
  ["disable_safety", /\b(disable|bypass|turn off|skip)\b.{0,30}\b(safety|policy|approval|review|kill switch|guard)\b/i],
  ["merge_or_deploy", /\b(merge|deploy|publish|push)\b.{0,30}\b(now|immediately|without (review|approval))\b/i]
];

/** Id-ene til injeksjonsmønstrene (L4, gjennomgang av PR #313): gull-suiten krever én oppgave per mønster, så et nytt mønster uten oppgave gjør en test rød. */
export const INJECTION_PATTERN_IDS: readonly string[] = INJECTION_PATTERNS.map(([id]) => id);

/** Kodepunkt-områder som fjernes fra ubetrodd tekst: kontrolltegn (unntatt tab/linjeskift), DEL, zero-width, retningstegn, linje-/avsnittsskille. */
const STRIPPED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]
];
const isStripped = (cp: number): boolean => STRIPPED_RANGES.some(([a, b]) => cp >= a && cp <= b);

/** Fjerner kontrolltegn/zero-width, kollapser whitespace og kutter lengde. Sanitert tekst er fortsatt UBETRODD data. */
export function sanitizeUntrustedText(text: string, maxChars: number): string {
  let out = "";
  for (const ch of text) if (!isStripped(ch.codePointAt(0)!)) out += ch;
  return out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
}

export interface RadarIngestResult {
  ok: boolean;
  /** Alltid UNTRUSTED_RESEARCH - radarinnhold er aldri trusted. */
  tag: "UNTRUSTED_RESEARCH";
  trust: "untrusted" | "quarantined";
  quarantined: boolean;
  /** Sikkerhetssone-hendelse (Security Center) når mistenkelig innhold funnet. */
  security_event: boolean;
  findings: string[];
  sanitized: { title: string; body: string } | null;
  source_url: string | null;
}

export function ingestRadarItem(raw: unknown): RadarIngestResult {
  const parsed = RadarItemSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, tag: "UNTRUSTED_RESEARCH", trust: "quarantined", quarantined: true, security_event: false, findings: [`schema_invalid:${parsed.error.issues[0]?.path.join(".") ?? ""}`], sanitized: null, source_url: null };
  }
  const item = parsed.data;
  const title = sanitizeUntrustedText(item.title, 300);
  const body = sanitizeUntrustedText(item.body, 20_000);
  const findings: string[] = [];
  for (const [id, rx] of INJECTION_PATTERNS) if (rx.test(title) || rx.test(body)) findings.push(`injection:${id}`);
  // Kilde med innebygd legitimasjon i URL (user:pass@) eller ikke-https er mistenkelig kilde.
  const url = new URL(item.source_url);
  if (url.username || url.password) findings.push("source_url_has_credentials");
  if (url.protocol !== "https:") findings.push("source_not_https");
  const quarantined = findings.length > 0;
  return {
    ok: !quarantined, tag: "UNTRUSTED_RESEARCH", trust: quarantined ? "quarantined" : "untrusted", quarantined,
    security_event: findings.some((f) => f.startsWith("injection:") || f === "source_url_has_credentials"),
    findings, sanitized: { title, body }, source_url: item.source_url
  };
}

/** Radarforslag som berører avhengigheter/credentials/nettverk/beskyttede stier blir automatisk E2 - uansett modellens anbefaling. */
export function radarProposalClass(paths: readonly string[], base: EvChangeClass = "E1"): EvChangeClass {
  return sensitiveTouches(paths).any ? atLeast(base, "E2") : base;
}

/** Improvement Opportunity Score (plan kap. 10). Alle faktorer 0-1; høy gevinst og lav risiko gir høy score. Rangering, aldri autorisasjon. */
export const OpportunityInputSchema = z
  .object({
    quality_gain: z.number().min(0).max(1),
    cost_reduction: z.number().min(0).max(1),
    reliability_gain: z.number().min(0).max(1),
    security_urgency: z.number().min(0).max(1),
    business_value: z.number().min(0).max(1),
    complexity: z.number().min(0).max(1),
    reversibility: z.number().min(0).max(1),
    blast_radius: z.number().min(0).max(1),
    credential_or_external_dependency: z.number().min(0).max(1),
    evidence_quality: z.number().min(0).max(1)
  })
  .strict();
export type OpportunityInput = z.infer<typeof OpportunityInputSchema>;

export interface OpportunityScore {
  score: number;
  gain: number;
  risk: number;
  /** Sikkerhetsregresjon/akutt sikkerhetsbehov løftes foran andre (hotfix-prioritet), men endrer aldri klassen. */
  security_priority: boolean;
}

export function improvementOpportunityScore(raw: OpportunityInput): OpportunityScore {
  const i = OpportunityInputSchema.parse(raw);
  const gain = 0.25 * i.quality_gain + 0.15 * i.cost_reduction + 0.2 * i.reliability_gain + 0.2 * i.security_urgency + 0.2 * i.business_value;
  const risk = 0.3 * i.complexity + 0.25 * (1 - i.reversibility) + 0.25 * i.blast_radius + 0.2 * i.credential_or_external_dependency;
  // Evidenskvalitet demper hele scoren: svak evidens gir aldri høy prioritet.
  const raw100 = Math.max(0, gain - 0.6 * risk) * i.evidence_quality * 100;
  return { score: Math.round(raw100 * 10) / 10, gain: Math.round(gain * 1000) / 1000, risk: Math.round(risk * 1000) / 1000, security_priority: i.security_urgency >= 0.8 && i.evidence_quality >= 0.6 };
}
