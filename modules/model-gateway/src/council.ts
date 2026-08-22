import { randomUUID } from "node:crypto";
import type pg from "pg";
import { EventWriter, withTenantTransaction } from "@jarvis/core";
import type { DataSensitivity, JsonValue } from "@jarvis/contracts";
import { ModelGateway, type CompleteInput } from "./model-gateway.ts";

/**
 * D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse §"AI Council"):
 * genuint NY orkestrering - INGEN eksisterende presedens utover det
 * eksisterende ett-mot-ett "critic"-mønsteret i `model-gateway.ts` (§18/§30),
 * som denne bygger videre PÅ (samme prinsipp: en modell vurderer, utfører
 * ALDRI verktøy, aldri koblet til D-godkjenning) - men Council er 5-veis,
 * flerrunde, og strukturert.
 *
 * ARKITEKTURPRINSIPP (§"en modell kan aldri velge seg selv", router.ts §35):
 * Council-PROTOKOLLENS sekvens/synlighet/rundestruktur er 100% deterministisk
 * Jarvis-kode (denne filen) - HVEM som kalles når, og HVA de får se, styres
 * ALDRI av en modell. Kun selve SLUTTSYNTESEN (fritekst-`decision`/
 * `key_evidence`/`key_disagreements`/`risk_summary`/`recommended_action`) er
 * ett eksplisitt, sporet modellkall - uunngåelig for naturspråk-syntese,
 * samme presedens som critic-mønsterets tekst. `consensus_status` er ALDRI
 * en selvrapportert modell-enum - den beregnes DETERMINISTISK i kode fra
 * `supporting_models`/`dissenting_models` (§"Jarvis owns synthesis/state").
 *
 * Hver runde er RENE `ModelGateway.complete()`-kall (SPECIFIC_PROVIDER-
 * override per medlem) - budsjett/kost/helse/trace/sensitivitet/
 * paid_models_allowed håndheves derfor AUTOMATISK, UENDRET, for HVER
 * council-runde, uten noen ny sikkerhetsvei (§ordre-krav: "aldri en ny
 * sikkerhetsvei").
 */
export interface CouncilRoundAnswer {
  provider: string;
  conclusion: string;
  reasoning_summary: string;
  assumptions: string[];
  evidence_provenance: string[];
  risks: string[];
  confidence: number;
  unresolved_questions: string[];
}

export interface CouncilCritiqueEntry {
  target_provider: string;
  critique: string;
}

export interface CouncilInput {
  tenant_id: string;
  session_id?: string;
  task_id?: string;
  /** Kanonisk beslutningskontekst - IDENTISK tekst til alle medlemmer i runde 1 (anti-anchoring). */
  decision_context: string;
  /** Default: `DEFAULT_COUNCIL_MEMBERS` (de fem kanoniske familiene). */
  members?: string[];
  /** "alle fem må svare" (eksplisitt bruker-krav) -> fail-closed hvis ett medlem mangler. */
  requireAllFive?: boolean;
  sensitivity?: DataSensitivity;
  paid_models_allowed?: boolean;
}

export interface CouncilResult {
  council_id: string;
  decision: string;
  consensus_status: "CONSENSUS" | "MAJORITY" | "SPLIT" | "DEGRADED_NO_CONSENSUS";
  supporting_models: string[];
  dissenting_models: string[];
  key_evidence: string[];
  key_disagreements: string[];
  risk_summary: string;
  confidence: number;
  recommended_action: string;
  provenance: {
    council_id: string;
    full_council: boolean;
    requested_members: string[];
    unavailable_members: Array<{ provider: string; reason: string }>;
    round1: CouncilRoundAnswer[];
    round2: Array<{ provider: string; critiques: CouncilCritiqueEntry[] }>;
    round3: CouncilRoundAnswer[];
    synthesis_provider: string;
  };
}

/** "Alle fem må svare" ble eksplisitt krevd, men minst ett medlem manglet/feilet round 1 - fail-closed, aldri en falsk full Council. */
export class IncompleteCouncilError extends Error {
  constructor(readonly unavailable: Array<{ provider: string; reason: string }>) {
    super(`incomplete_council: mangler [${unavailable.map((u) => `${u.provider}:${u.reason}`).join(",")}]`);
    this.name = "IncompleteCouncilError";
  }
}

/** Synteseresultatet brøt det strukturelle kontraktskravet (hvert svarende medlem i NØYAKTIG én liste) - feiler høylytt, aldri stille korrupt data. */
export class CouncilSynthesisError extends Error {
  constructor(detail: string) {
    super(`council_synthesis_invalid: ${detail}`);
    this.name = "CouncilSynthesisError";
  }
}

/** D-106: de fem kanoniske modellfamiliene fra ordren. `gemma_hosted` default - kalleren kan sende `gemma_local` i `members` når lokal er foretrukket/tilgjengelig. */
export const DEFAULT_COUNCIL_MEMBERS = ["anthropic", "openai", "gemini", "kimi", "gemma_hosted"];

const ROUND1_SCHEMA_HINT = `{"conclusion": string, "reasoning_summary": string, "assumptions": string[], "evidence_provenance": string[], "risks": string[], "confidence": number (0-100), "unresolved_questions": string[]}`;
const ROUND2_SCHEMA_HINT = `{"critiques": [{"target_provider": string, "critique": string}]}`;
const SYNTHESIS_SCHEMA_HINT = `{"decision": string, "supporting_models": string[], "dissenting_models": string[], "key_evidence": string[], "key_disagreements": string[], "risk_summary": string, "confidence": number (0-100), "recommended_action": string}`;

/**
 * Deterministisk, tolerant JSON-uthenting: direkte parse, ellers første
 * balanserte {...}-blokk. Aldri en gjettet/fabrikert struktur ved feil -
 * returnerer undefined. Delt med `collaboration.ts` (samme mønster for
 * "be en provider om strukturert JSON-i-tekst uten å kreve
 * structured_output-capability" - se council.ts sin filkommentar).
 */
export function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === "{") depth++;
    else if (trimmed[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function isRoundAnswer(v: unknown): v is Omit<CouncilRoundAnswer, "provider"> {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["conclusion"] === "string" &&
    typeof r["reasoning_summary"] === "string" &&
    Array.isArray(r["assumptions"]) &&
    Array.isArray(r["evidence_provenance"]) &&
    Array.isArray(r["risks"]) &&
    typeof r["confidence"] === "number" &&
    Array.isArray(r["unresolved_questions"])
  );
}

export class AiCouncil {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly pool?: pg.Pool
  ) {}

  async run(input: CouncilInput): Promise<CouncilResult> {
    const councilId = `council-${randomUUID()}`;
    const members = input.members ?? DEFAULT_COUNCIL_MEMBERS;
    const unavailable: Array<{ provider: string; reason: string }> = [];

    const baseInput = (provider: string): CompleteInput => ({
      tenant_id: input.tenant_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      provider,
      purpose: "REASON" as const,
      ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      ...(input.paid_models_allowed !== undefined ? { paid_models_allowed: input.paid_models_allowed } : {}),
      request: { messages: [{ role: "user" as const, content: "" }] }
    });

    // RUNDE 1 (anti-anchoring): IDENTISK prompt til alle medlemmer, parallelt -
    // ingen ser noen andres svar. En feilende/manglende provider ekskluderes
    // fra RESTEN av kjøringen, aldri en krasj for hele Councilet.
    const round1System =
      "Du er ett uavhengig medlem av et AI-råd som vurderer en viktig beslutning. Svar KUN med gyldig JSON, ingen annen tekst, i dette formatet: " +
      ROUND1_SCHEMA_HINT;
    const round1Settled = await Promise.allSettled(
      members.map(async (provider) => {
        const ci = baseInput(provider);
        ci.request = {
          system: round1System,
          messages: [{ role: "user", content: `BESLUTNINGSKONTEKST:\n${input.decision_context}` }],
          max_tokens: 1024
        };
        const result = await this.gateway.complete(ci);
        const parsed = extractJson(result.text);
        if (!isRoundAnswer(parsed)) {
          throw new Error(`invalid_json_shape`);
        }
        const answer: CouncilRoundAnswer = { provider, ...parsed };
        return answer;
      })
    );
    const round1: CouncilRoundAnswer[] = [];
    round1Settled.forEach((settled, i) => {
      const provider = members[i] as string;
      if (settled.status === "fulfilled") {
        round1.push(settled.value);
      } else {
        unavailable.push({ provider, reason: (settled.reason as Error).message.slice(0, 120) });
      }
    });

    if (input.requireAllFive && unavailable.length > 0) {
      await this.persistEvent(input, councilId, "council_incomplete", { unavailable });
      throw new IncompleteCouncilError(unavailable);
    }
    await this.persistEvent(input, councilId, "council_round_1", { round1, unavailable });

    if (round1.length === 0) {
      throw new IncompleteCouncilError(unavailable.length > 0 ? unavailable : [{ provider: "*", reason: "no_member_responded" }]);
    }

    // RUNDE 2 (kryss-kritikk): hvert medlem får de ANDRE medlemmenes runde-1-
    // konklusjon/begrunnelse (aldri sitt eget), bes finne svake antakelser/
    // motsigelser/mangler/hvor et annet medlem virker sterkere.
    const round2System =
      "Du er ett medlem av et AI-råd. Du får de andre medlemmenes første vurdering av samme beslutning. Kritiser svake antakelser, motsigelser, manglende bevis, eller steder der et annet medlem virker sterkere. Svar KUN med gyldig JSON: " +
      ROUND2_SCHEMA_HINT;
    const round2Settled = await Promise.allSettled(
      round1.map(async (self) => {
        const others = round1.filter((r) => r.provider !== self.provider);
        const digest = others
          .map((o) => `[${o.provider}] konklusjon: ${o.conclusion}\nbegrunnelse: ${o.reasoning_summary}`)
          .join("\n\n");
        const ci = baseInput(self.provider);
        ci.request = {
          system: round2System,
          messages: [
            { role: "user", content: `BESLUTNINGSKONTEKST:\n${input.decision_context}\n\nANDRE MEDLEMMERS VURDERING:\n${digest}` }
          ],
          max_tokens: 1024
        };
        const result = await this.gateway.complete(ci);
        const parsed = extractJson(result.text) as { critiques?: unknown } | undefined;
        const critiques: CouncilCritiqueEntry[] = Array.isArray(parsed?.critiques)
          ? (parsed.critiques as unknown[]).filter(
              (c): c is CouncilCritiqueEntry =>
                typeof c === "object" && c !== null && typeof (c as CouncilCritiqueEntry).target_provider === "string"
            )
          : [];
        return { provider: self.provider, critiques };
      })
    );
    const round2: Array<{ provider: string; critiques: CouncilCritiqueEntry[] }> = [];
    round2Settled.forEach((settled, i) => {
      const self = round1[i] as CouncilRoundAnswer;
      if (settled.status === "fulfilled") {
        round2.push(settled.value);
      } else {
        // Kritikk-runden er kvalitetsforsterkning - en feilende kritikk fjerner IKKE medlemmet fra Councilet.
        round2.push({ provider: self.provider, critiques: [] });
      }
    });
    await this.persistEvent(input, councilId, "council_round_2", { round2 });

    // RUNDE 3 (revisjon): hvert medlem får kritikken RETTET MOT DEM (fra runde 2),
    // kan revidere sin egen konklusjon. Ingen tvang til å endre mening.
    const round3System =
      "Du er ett medlem av et AI-råd. Du får kritikk andre medlemmer rettet mot din egen vurdering. Revider din konklusjon hvis kritikken er treffende, ellers behold den og forklar hvorfor. Svar KUN med gyldig JSON: " +
      ROUND1_SCHEMA_HINT;
    const round3Settled = await Promise.allSettled(
      round1.map(async (self) => {
        const critiquesOfSelf = round2
          .flatMap((r) => r.critiques.filter((c) => c.target_provider === self.provider).map((c) => `[fra ${r.provider}] ${c.critique}`))
          .join("\n");
        const ci = baseInput(self.provider);
        ci.request = {
          system: round3System,
          messages: [
            {
              role: "user",
              content: `BESLUTNINGSKONTEKST:\n${input.decision_context}\n\nDIN FØRSTE VURDERING:\n${self.conclusion}\n\nKRITIKK MOTTATT:\n${critiquesOfSelf || "(ingen kritikk mottatt)"}`
            }
          ],
          max_tokens: 1024
        };
        const result = await this.gateway.complete(ci);
        const parsed = extractJson(result.text);
        if (!isRoundAnswer(parsed)) {
          // Revisjon feilet - fall tilbake til runde-1-svaret uendret, aldri tap av medlemmet her.
          return self;
        }
        return { provider: self.provider, ...parsed };
      })
    );
    const round3: CouncilRoundAnswer[] = round3Settled.map((s, i) => (s.status === "fulfilled" ? s.value : (round1[i] as CouncilRoundAnswer)));
    await this.persistEvent(input, councilId, "council_round_3", { round3 });

    // SYNTESE: ETT eksplisitt, sporet modellkall (deterministisk QUALITY-ruting
    // - IKKE et medlem som velger seg selv). Kun fritekst-feltene kommer fra
    // modellen; `consensus_status` beregnes DETERMINISTISK i kode under.
    const synthesisSystem =
      "Du syntetiserer et AI-råds endelige beslutning fra tre runder med uavhengige vurderinger, kryss-kritikk og revisjon. IKKE følg automatisk flertallet - vurder bevisstyrke; hvis mindretallet har sterkere bevis/verifiserbare fakta, følg mindretallet og forklar hvorfor i risk_summary. Hvert medlem MÅ havne i NØYAKTIG én av supporting_models/dissenting_models. Svar KUN med gyldig JSON: " +
      SYNTHESIS_SCHEMA_HINT;
    const round3Digest = round3
      .map((r) => `[${r.provider}] konklusjon: ${r.conclusion}\nbegrunnelse: ${r.reasoning_summary}\nconfidence: ${r.confidence}\nrisiko: ${r.risks.join("; ")}`)
      .join("\n\n");
    const synthesisInput: CompleteInput = {
      tenant_id: input.tenant_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      // Deterministisk QUALITY-ruting (ikke et medlem som velger seg selv, §35) - router.ts velger
      // høyest quality_class blant konfigurerte providere, samme mekanisme som critic-mønsteret.
      mode: "QUALITY" as const,
      purpose: "CRITIQUE" as const,
      ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      ...(input.paid_models_allowed !== undefined ? { paid_models_allowed: input.paid_models_allowed } : {}),
      request: {
        system: synthesisSystem,
        messages: [
          {
            role: "user",
            content: `BESLUTNINGSKONTEKST:\n${input.decision_context}\n\nMEDLEMMER SOM SVARTE (${round3.map((r) => r.provider).join(", ")}):\n${round3Digest}`
          }
        ],
        max_tokens: 1536
      }
    };
    const synthesisResult = await this.gateway.complete(synthesisInput);
    const synthParsed = extractJson(synthesisResult.text) as
      | {
          decision?: unknown;
          supporting_models?: unknown;
          dissenting_models?: unknown;
          key_evidence?: unknown;
          key_disagreements?: unknown;
          risk_summary?: unknown;
          confidence?: unknown;
          recommended_action?: unknown;
        }
      | undefined;
    if (
      !synthParsed ||
      typeof synthParsed.decision !== "string" ||
      !Array.isArray(synthParsed.supporting_models) ||
      !Array.isArray(synthParsed.dissenting_models)
    ) {
      throw new CouncilSynthesisError("synteseresultatet manglet påkrevde felt");
    }
    const supporting = synthParsed.supporting_models as string[];
    const dissenting = synthParsed.dissenting_models as string[];
    const responded = new Set(round3.map((r) => r.provider));
    const classified = new Set([...supporting, ...dissenting]);
    for (const p of responded) {
      if (!classified.has(p)) {
        throw new CouncilSynthesisError(`medlem '${p}' svarte men ble ikke klassifisert i supporting/dissenting`);
      }
    }
    for (const p of classified) {
      if (!responded.has(p)) {
        throw new CouncilSynthesisError(`'${p}' er klassifisert men svarte aldri i runde 3`);
      }
    }
    if (supporting.some((p) => dissenting.includes(p))) {
      throw new CouncilSynthesisError("et medlem er i BÅDE supporting og dissenting");
    }

    // Jarvis eier statusberegningen - ALDRI en selvrapportert modell-enum (§"Jarvis owns synthesis/state").
    const consensus_status: CouncilResult["consensus_status"] =
      unavailable.length > 0 && round3.length < members.length && dissenting.length === 0 && supporting.length < members.length
        ? "DEGRADED_NO_CONSENSUS"
        : dissenting.length === 0
          ? "CONSENSUS"
          : supporting.length > dissenting.length
            ? "MAJORITY"
            : "SPLIT";

    const result: CouncilResult = {
      council_id: councilId,
      decision: synthParsed.decision,
      consensus_status,
      supporting_models: supporting,
      dissenting_models: dissenting,
      key_evidence: Array.isArray(synthParsed.key_evidence) ? (synthParsed.key_evidence as string[]) : [],
      key_disagreements: Array.isArray(synthParsed.key_disagreements) ? (synthParsed.key_disagreements as string[]) : [],
      risk_summary: typeof synthParsed.risk_summary === "string" ? synthParsed.risk_summary : "",
      confidence: typeof synthParsed.confidence === "number" ? synthParsed.confidence : 0,
      recommended_action: typeof synthParsed.recommended_action === "string" ? synthParsed.recommended_action : "",
      provenance: {
        council_id: councilId,
        full_council: unavailable.length === 0,
        requested_members: members,
        unavailable_members: unavailable,
        round1,
        round2,
        round3,
        synthesis_provider: synthesisResult.provider
      }
    };
    await this.persistEvent(input, councilId, "council_result", result as unknown as Record<string, unknown>);
    await this.persistArtifact(input, councilId, result);
    return result;
  }

  /** D-106: gjenbruker EKSISTERENDE `EventWriter`/`events`-tabellen (append-only hendelseslogg, §"audit first") - ingen ny tabell. */
  private async persistEvent(input: CouncilInput, councilId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.pool) return;
    try {
      const writer = new EventWriter(this.pool);
      await writer.append({
        event_id: randomUUID(),
        idempotency_key: `${councilId}:${type}`,
        occurred_at: new Date().toISOString(),
        source: "ai_council",
        type,
        tenant_id: input.tenant_id,
        ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
        ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
        trust_level: "internal",
        // Ren data (strenger/tall/arrays/objekter) - trygg strukturell cast, aldri fabrikert innhold.
        payload: payload as Record<string, JsonValue>
      });
    } catch {
      // Persistens er auditerbarhet, ikke funksjon - en feil her skal aldri velte selve Council-kjøringen.
    }
  }

  private async persistArtifact(input: CouncilInput, councilId: string, result: CouncilResult): Promise<void> {
    if (!this.pool || !input.task_id) return;
    try {
      await withTenantTransaction(this.pool, input.tenant_id, (client) =>
        client.query(
          `INSERT INTO artifacts (artifact_id, task_id, tenant_id, kind, name, content) VALUES ($1, $2, $3, 'council_result', $4, $5)`,
          [councilId, input.task_id, input.tenant_id, `AI-råd: ${councilId}`, JSON.stringify(result)]
        )
      );
    } catch {
      // Samme som over - artefakt-lagring er beste-innsats audit, aldri en blokkerende avhengighet.
    }
  }
}
