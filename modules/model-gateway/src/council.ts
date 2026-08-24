import { randomUUID } from "node:crypto";
import type pg from "pg";
import { EventWriter, withTenantTransaction } from "@jarvis/core";
import type { DataSensitivity, JsonValue } from "@jarvis/contracts";
import { ModelGateway, type CompleteInput } from "./model-gateway.ts";
import { isSensitivityEligible } from "./router.ts";

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
  /**
   * D-106 HOST-FIX (§"AUDITABILITY"): hvorfor denne Council-kjøringen faktisk
   * skjer - `"explicit_user"` (bruker sa "bruk AI-rådet"-frasen) eller
   * `"high_impact_classifier"` (deterministisk klassifisering,
   * `decision-importance.ts`, matchet et høy-innvirkning-signal). VALGFRITT -
   * kalleren (`ConversationEngine`) setter dette; `AiCouncil` selv avgjør
   * ALDRI om den skal trigges - den kjører bare når `.run()` faktisk kalles.
   * Persisteres UENDRET i `provenance.trigger` for et fullstendig auditerbart
   * spor (§"No silent five-model spend").
   */
  trigger?: {
    trigger_source: "explicit_user" | "high_impact_classifier";
    decision_importance?: string;
    trigger_reasons?: string[];
    matched_signals?: Array<{ name: string; matched_text: string }>;
    classifier_version?: string;
  };
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
    /** D-106 HOST-FIX: uendret kopi av `CouncilInput.trigger` - auditerbart hvorfor DENNE kjøringen skjedde. */
    trigger?: CouncilInput["trigger"];
    /**
     * D-106 HOST-FIX 2 (§"Council Gemma family mismatch"): satt KUN når `members`
     * ikke ble eksplisitt oppgitt (den DEFAULT fem-familie-veien - eneste vei
     * `ConversationEngine` bruker) - hvilken KONKRET provider (`gemma_local`/
     * `gemma_hosted`) som faktisk representerte Gemma-familien i DENNE
     * kjøringen. `undefined` når Gemma-familien ikke kunne løses til noen
     * konkret provider (se `unavailable_members` for `provider: "gemma"`) -
     * ALDRI en gjettet/antatt verdi.
     */
    gemma_family_provider?: string;
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

/**
 * D-106 HOST-FIX 2 (§"Council Gemma family mismatch", 2026-08-22): de fem
 * kanoniske Council-FAMILIENE. Gemma er BEVISST representert som "gemma" her
 * (en familie-label, IKKE en providernavn/adapter-identitet) - familien har
 * TO mulige konkrete backends (`gemma_local`/`gemma_hosted`), løst DYNAMISK
 * per kjøring av `AiCouncil.resolveGemmaFamilyProvider()`, ALDRI en statisk
 * antakelse. De fire andre familiene ER allerede sine egne konkrete
 * providernavn (ingen tilsvarende tvetydighet).
 */
export const CANONICAL_COUNCIL_FAMILIES = ["anthropic", "openai", "gemini", "kimi", "gemma"] as const;

/** De fire familiene som ALLTID er sine egne konkrete providernavn - Gemma-familiens konkrete medlem løses separat, se `resolveGemmaFamilyProvider()`. */
const NON_GEMMA_DEFAULT_MEMBERS = ["anthropic", "openai", "gemini", "kimi"];

const ROUND1_SCHEMA_HINT = `{"conclusion": string, "reasoning_summary": string, "assumptions": string[], "evidence_provenance": string[], "risks": string[], "confidence": number (0-100), "unresolved_questions": string[]}`;
const ROUND2_SCHEMA_HINT = `{"critiques": [{"target_provider": string, "critique": string}]}`;
const SYNTHESIS_SCHEMA_HINT = `{"decision": string, "supporting_models": string[], "dissenting_models": string[], "key_evidence": string[], "key_disagreements": string[], "risk_summary": string, "confidence": number (0-100), "recommended_action": string}`;

/**
 * D-106 PR #53 HOST FIX (live-bevis, 2026-08-23): 1024 var for lavt for ekte
 * medlemmer. Live-kjøring mot Tobias sin ekte OpenAI (gpt-5, reasoning-modell)
 * og Anthropic viste BEGGE feile på `max_tokens: 1024` - GPT-5 brukte HELE
 * budsjettet på interne reasoning-tokens (finish_reason=length,
 * text.length=0, INGEN synlig tekst i det hele tatt), Anthropic ble kuttet
 * midt i et ellers korrekt formatert JSON-objekt (finish_reason=max_tokens).
 * `extractJson()`/`isRoundAnswer()` avviste begge KORREKT (ufullstendig JSON
 * er IKKE gyldig JSON) - defekten var budsjettet, ikke parseren. Økt til et
 * nivå med reell margin for reasoning-modeller PLUSS et fullstendig 7-felts
 * skjema-svar, ikke en gjettet leverandør-detalj (D-41-skillet: dette er et
 * internt Jarvis-budsjettvalg, ikke en påstand om ekstern API-oppførsel).
 */
const COUNCIL_ROUND_MAX_TOKENS = 4096;
const COUNCIL_SYNTHESIS_MAX_TOKENS = 4096;

/**
 * D-106 Council reliability (§ARCHITECTURE DECISION, evidensbasert 2026-08-24):
 * en konkurrent, kanonisk-identisk runde-1-diagnostikk (fem medlemmer samtidig
 * via `Promise.allSettled`, EKTE produksjonsprovidere, ingen kodeendring) viste
 * Kimi fullføre KUN 135ms under den ordinære `JARVIS_MODEL_TIMEOUT_MS`-grensen
 * (59865ms av 60000ms) - og tre FORUTGÅENDE reelle Council-forsøk hadde ALLE
 * feilet nettopp på denne grensen (`kimi_timeout`, ~60s). En ISOLERT
 * (ikke-konkurrent) kjøring av SAMME arbeidsmengde fullførte derimot komfortabelt
 * på 41695ms - konsistent med at fem samtidige, tunge, strukturerte
 * flermodell-kall (`COUNCIL_ROUND_MAX_TOKENS=4096`, JSON-skjema-krav) gir
 * vesentlig mindre tidsmargin enn ett enkelt ordinært kall, uavhengig av hvilken
 * spesifikk provider som til slutt viser det tydeligst.
 *
 * Dette er BEVISST IKKE en Kimi-spesifikk fiks (§DESIGN REQUIREMENTS: ingen
 * `if provider === "kimi"`-gren noe sted) - det er en generisk,
 * ARBEIDSMENGDE-spesifikk timeout for HELE Council-protokollen (runde 1-3 OG
 * syntese - alle fire behandler samme klasse tunge, strukturerte
 * flermodell-arbeidsmengde med samme `COUNCIL_ROUND_MAX_TOKENS`/
 * `COUNCIL_SYNTHESIS_MAX_TOKENS`-tokenbudsjett; syntese er i tillegg det
 * TYNGSTE enkeltkallet - den digesterer alle fem medlemmers fulle runde-3-
 * output på én gang). Ordinære `ModelGateway.complete()`-kall UTENFOR Council
 * (inkludert det eksisterende ett-mot-ett critic-mønsteret) er STRENGT
 * UENDRET - fortsatt `DEFAULT_MODEL_TIMEOUT_MS`/60000 - dette gjelder KUN
 * `AiCouncil` sin egen arbeidsmengde.
 *
 * `JARVIS_COUNCIL_MODEL_TIMEOUT_MS` er en VALGFRI miljø-overstyring (samme
 * konvensjon som `JARVIS_MODEL_TIMEOUT_MS` ellers i adapterlaget) - Tobias
 * trenger ALDRI endre `.env` for normal drift (default 120000ms er allerede
 * satt). Selve validering (endelig tall, >0, <=`MAX_MODEL_TIMEOUT_MS`=180000)
 * skjer IKKE her, men i `ModelGateway.applyTimeoutOverride()` - én sentral
 * valideringsplass, aldri duplisert - en feilkonfigurert verdi feiler derfor
 * høylytt (`InvalidTimeoutError`) ved første faktiske Council-kall, aldri en
 * stille fallback til en gjettet verdi.
 */
const COUNCIL_MODEL_TIMEOUT_MS =
  process.env["JARVIS_COUNCIL_MODEL_TIMEOUT_MS"] !== undefined
    ? Number(process.env["JARVIS_COUNCIL_MODEL_TIMEOUT_MS"])
    : 120_000;

/**
 * D-106 HOST-FIX (produksjonsherding, Defekt D): live host-kjøring viste
 * ekte parse-feil (`invalid_json_shape`/`council_synthesis_invalid`) mot
 * FAKTISKE modellsvar - den opprinnelige uthentingen tok naivt den FØRSTE
 * balanserte `{...}`-blokken den fant og stoppet der, UTEN å sjekke om det
 * fantes en ANNEN, konkurrerende kandidat lenger ut i teksten (stille
 * tvetydighet), og var IKKE streng-bevisst i sin egen dybdetelling (en
 * bokstavelig `{`/`}` inni et streng-felt kunne forstyrre balanseringen).
 *
 * Matcher trimmet innmatnings-teksten mot NØYAKTIG én av disse balanserte
 * kandidat-brace-blokkene (funnet via `findMatchingBrace()` sin streng-
 * bevisste skanning, som IKKE lar en `{`/`}` inni et streng-felt telle med
 * i dybden). Flere kandidater som HVER parser gyldig er tvetydig og feiler
 * ÆRLIG (returnerer `undefined`), ALDRI en gjettet vinner.
 */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Alle ikke-overlappende, balanserte topp-nivå `{...}`-kandidater i teksten, i rekkefølge. */
function findBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{") {
      const end = findMatchingBrace(text, i);
      if (end === -1) break;
      candidates.push(text.slice(i, end + 1));
      i = end + 1;
    } else {
      i++;
    }
  }
  return candidates;
}

/**
 * Prøver direkte parse først (dekker rå JSON, evt. med kun omkringliggende
 * whitespace). Feiler direkte parse: skanner etter balanserte `{...}`-
 * kandidater og krever at PRESIST ÉN av dem parser til gyldig JSON - null
 * gyldige kandidater (malformert/avkuttet JSON) OG flere gyldige kandidater
 * (tvetydig - "hvilken av disse er svaret?") feiler BEGGE ÆRLIG, ALDRI en
 * gjettet/fabrikert vinner.
 */
function parseUnambiguousJsonObject(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    // fall through - skann etter nøyaktig én balansert, gyldig kandidat.
  }
  const parsed: unknown[] = [];
  for (const candidate of findBalancedJsonCandidates(text)) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      // ikke gyldig JSON - ikke en reell kandidat, ignoreres (IKKE en feil i seg selv).
    }
  }
  return parsed.length === 1 ? parsed[0] : undefined;
}

/** Matcher ett fenced kodeblokk-par (```json ... ``` ELLER generisk ``` ... ```), språk-tag valgfri. */
const MARKDOWN_FENCE_RE = /```[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)```/g;

/**
 * Deterministisk, streng JSON-uthenting fra en modells fritekstsvar - delt
 * med `collaboration.ts` (samme mønster for "be en provider om strukturert
 * JSON-i-tekst uten å kreve structured_output-capability", provider-nøytralt
 * - se council.ts sin filkommentar). ALDRI en gjettet/fabrikert struktur ved
 * feil - returnerer `undefined` for ALLE feilklasser (malformert JSON,
 * avkuttet JSON, tvetydig flere kandidater), ALDRI en delvis/beste-gjett
 * struktur. Selve SKJEMA-valideringen (er de påkrevde feltene til stede med
 * riktig type) skjer FORTSATT hos kalleren (`isRoundAnswer()` i denne filen,
 * tilsvarende i `collaboration.ts`) - denne funksjonen har KUN ansvar for
 * "fant jeg entydig gyldig JSON i teksten", aldri for skjemaets form.
 *
 * Rekkefølge (D-106 HOST-FIX Defekt D):
 *  1. Nøyaktig ÉN markdown-fenced kodeblokk (```json ... ``` eller generisk
 *     ``` ... ```) funnet: bruk KUN dens innhold - en bevisst fence er et
 *     sterkt, utvetydig signal om "svaret er HER", så det INGEN fallback til
 *     resten av teksten hvis fence-innholdet selv feiler å parse (ÆRLIG feil,
 *     ikke et gjettet søk andre steder).
 *  2. FLERE fenced kodeblokker funnet: tvetydig - `undefined` (aldri en
 *     gjettet "riktig" blokk).
 *  3. INGEN fence: prøv direkte parse av HELE teksten (dekker rå JSON +
 *     kun-whitespace-omsluttet JSON), ellers skann etter presist én
 *     balansert, gyldig `{...}`-kandidat omgitt av fritekst (bounded prose).
 */
export function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const fenceMatches = [...trimmed.matchAll(MARKDOWN_FENCE_RE)];
  if (fenceMatches.length === 1) {
    const content = (fenceMatches[0]?.[2] ?? "").trim();
    if (!content) return undefined;
    try {
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }
  if (fenceMatches.length > 1) {
    return undefined;
  }

  return parseUnambiguousJsonObject(trimmed);
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

  /**
   * D-106 HOST-FIX 2 (§"Council Gemma family mismatch"): Gemma-familien har TO
   * mulige konkrete backends (`gemma_local` på Tobias sin RTX 4070-vert /
   * `gemma_hosted` via Googles Gemini API) - NØYAKTIG én av dem representerer
   * familien for en gitt kjøring, ALDRI begge (§ordre-krav: "Never count
   * local + hosted Gemma as two Council members"). Valget er 100%
   * DETERMINISTISK Jarvis-kode (§35 - "en modell kan aldri velge seg selv"):
   *   1. `gemma_local` FORETRUKKET når konfigurert OG helsetilstand IKKE er
   *      UNAVAILABLE - SAMME "ikke UNAVAILABLE"-kvalifiseringsregel som
   *      `AiRouter` selv bruker for ordinær Gemma-first-ruting (router.ts,
   *      linje ~212) - ALDRI et krav om at helsen allerede må være LIVE (en
   *      helt fersk prosess har ingen historikk ennå, samme presedens).
   *   2. Ellers `gemma_hosted` SOM FALLBACK - KUN når konfigurert, helse ikke
   *      UNAVAILABLE, `paid_models_allowed !== false` (hostet Gemma er en
   *      BETALT leverandør - samme paid_models_allowed-policy-gate som resten
   *      av D-106 sitt routing-lag), OG `sensitivity`-kvalifisert via DEN
   *      EKSISTERENDE `isSensitivityEligible()`-regelen fra `router.ts`
   *      (D-81 P0-sikkerhetsfiks - `gemma_hosted` er `hosted_free_tier`, som
   *      KREVER eksplisitt `sensitivity === "PUBLIC_OR_LOW_SENSITIVITY"`;
   *      udefinert sensitivitet kvalifiserer ALDRI. Gjenbrukt uendret, ALDRI
   *      duplisert - en Council-beslutning skal ALDRI kunne lekke til en
   *      delt gratis-tier-leverandør via en parallell, svakere sjekk).
   *   3. Ellers INGEN konkret provider - familien er `unavailable` (kalleren,
   *      `run()`, seeder DA en eksplisitt `{provider:"gemma", reason}`-
   *      oppføring i `unavailable_members` FØR runde 1 i det hele tatt
   *      forsøkes - ALDRI stille utelatt, ALDRI en falsk `full_council=true`).
   */
  private resolveGemmaFamilyProvider(
    paid_models_allowed?: boolean,
    sensitivity?: DataSensitivity
  ): { provider?: "gemma_local" | "gemma_hosted"; reason?: string } {
    const configured = new Set(this.gateway.listConfiguredProviders());
    const isHealthy = (name: string): boolean => configured.has(name) && this.gateway.health.state(name, true) !== "UNAVAILABLE";
    if (isHealthy("gemma_local")) {
      return { provider: "gemma_local" };
    }
    const gemmaHostedProfile = this.gateway.capabilityRegistry.get("gemma_hosted");
    const gemmaHostedSensitivityOk = gemmaHostedProfile === undefined || isSensitivityEligible(gemmaHostedProfile, sensitivity);
    if (paid_models_allowed !== false && gemmaHostedSensitivityOk && isHealthy("gemma_hosted")) {
      return { provider: "gemma_hosted" };
    }
    return {
      reason:
        paid_models_allowed === false && configured.has("gemma_hosted")
          ? "gemma_local_unavailable_and_paid_models_disabled"
          : configured.has("gemma_hosted") && !gemmaHostedSensitivityOk
            ? "gemma_local_unavailable_and_gemma_hosted_not_sensitivity_eligible"
            : "neither_gemma_local_nor_gemma_hosted_available"
    };
  }

  async run(input: CouncilInput): Promise<CouncilResult> {
    const councilId = `council-${randomUUID()}`;
    const unavailable: Array<{ provider: string; reason: string }> = [];
    let members: string[];
    let gemmaFamilyProvider: string | undefined;
    // D-106 HOST-FIX 2: dynamisk familie-oppløsning gjelder KUN den DEFAULT
    // fem-familie-veien (`input.members` ikke oppgitt - eneste vei
    // `ConversationEngine` faktisk bruker). En kaller som eksplisitt oppgir
    // `members` (f.eks. eksisterende tester) beholder UENDRET, bokstavelig
    // oppførsel - ingen Gemma-spesialhåndtering i det tilfellet.
    if (input.members !== undefined) {
      members = input.members;
    } else {
      const gemma = this.resolveGemmaFamilyProvider(input.paid_models_allowed, input.sensitivity);
      gemmaFamilyProvider = gemma.provider;
      members = gemma.provider ? [...NON_GEMMA_DEFAULT_MEMBERS, gemma.provider] : [...NON_GEMMA_DEFAULT_MEMBERS];
      if (!gemma.provider) {
        unavailable.push({ provider: "gemma", reason: gemma.reason ?? "gemma_family_unresolved" });
      }
    }

    const baseInput = (provider: string): CompleteInput => ({
      tenant_id: input.tenant_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      provider,
      purpose: "REASON" as const,
      ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      ...(input.paid_models_allowed !== undefined ? { paid_models_allowed: input.paid_models_allowed } : {}),
      // D-106 Council reliability: generisk arbeidsmengde-timeout for runde 1-3 (§ARCHITECTURE DECISION over).
      timeoutMs: COUNCIL_MODEL_TIMEOUT_MS,
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
          max_tokens: COUNCIL_ROUND_MAX_TOKENS
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
          max_tokens: COUNCIL_ROUND_MAX_TOKENS
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
          max_tokens: COUNCIL_ROUND_MAX_TOKENS
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
      // D-106 Council reliability: syntese er det TYNGSTE enkeltkallet (digesterer alle fem medlemmers fulle runde-3-output) - samme arbeidsmengde-timeout som runde 1-3 (§ARCHITECTURE DECISION over).
      timeoutMs: COUNCIL_MODEL_TIMEOUT_MS,
      request: {
        system: synthesisSystem,
        messages: [
          {
            role: "user",
            content: `BESLUTNINGSKONTEKST:\n${input.decision_context}\n\nMEDLEMMER SOM SVARTE (${round3.map((r) => r.provider).join(", ")}):\n${round3Digest}`
          }
        ],
        max_tokens: COUNCIL_SYNTHESIS_MAX_TOKENS
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
        synthesis_provider: synthesisResult.provider,
        ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
        ...(gemmaFamilyProvider !== undefined ? { gemma_family_provider: gemmaFamilyProvider } : {})
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
