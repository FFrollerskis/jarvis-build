import type { DataSensitivity, ModelPurpose, RouterMode, RoutingReason } from "@jarvis/contracts";
import type { CapabilityRegistry, ModelCapability, ModelProfile } from "./capability-registry.ts";
import type { ProviderHealthTracker } from "./provider-health.ts";

/**
 * UA-1 AI Router (BO-08 §8-§10): deterministisk/scoret valg av provider fra
 * capability registry + health. Ingen LLM brukes for å velge LLM. Modellvalg
 * skjer KUN her (trusted layer) - en modell kan aldri velge seg selv (§35).
 */
export interface RouteInput {
  purpose?: ModelPurpose;
  mode?: RouterMode;
  required_capabilities?: ModelCapability[];
  /** Owner/system-override (§10): eksakt provider. Ingen stille fallback til andre. */
  provider?: string;
  needs_structured?: boolean;
  /**
   * D-80/D-81 (AI Mesh Gemma-first §3/§23, P0-sikkerhetsfiks): VALGFRITT.
   * `hosted_free_tier`-providere (i dag kun `gemma_hosted`) krever et
   * EKSPLISITT `sensitivity === "PUBLIC_OR_LOW_SENSITIVITY"` for å være
   * kvalifisert - udefinert/ukjent sensitivitet blir ALDRI tolket som
   * "public" (fail-safe, D-81). For ALLE ANDRE, allerede betrodde providere
   * (openai/anthropic/gemini/kimi/ollama/local_llm) er ruting UENDRET fra FØR
   * D-80 når feltet er udefinert (§23 migrasjonssikkerhet - ingen eksisterende
   * kalleside mister tilgang til en tidligere kvalifisert provider). Når
   * kalleren eksplisitt klassifiserer dataen:
   *  - PUBLIC_OR_LOW_SENSITIVITY: `hosted_free_tier`-providere blir kvalifisert;
   *    ingen ekstra filtrering for øvrige.
   *  - PRIVATE / BUSINESS_CONFIDENTIAL: `hosted_free_tier`-providere
   *    EKSKLUDERES helt; lokale providere foretrekkes (scoring-bonus), men er
   *    IKKE et hardt krav - en allerede betrodd betalt sky-provider forblir
   *    kvalifisert (D-23: "preferably local... or an approved paid/private
   *    provider configuration").
   *  - SECRET_RESTRICTED: KUN lokale providere er kvalifisert (gjelder for
   *    ALLE providere, inkl. `hosted_free_tier`). Ingen lokal tilgjengelig =>
   *    fail-closed (`NoEligibleProviderError`), ALDRI stille fallback til en
   *    sky-provider - gjelder OGSÅ eksplisitt eier-override.
   */
  sensitivity?: DataSensitivity;
  /**
   * D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse): VALGFRITT
   * policy-felt. `false` = KUN `locality === "local"`-providere er
   * kvalifisert (uansett mode/override) - "ikke bruk betalte modeller"/
   * `paid_models_allowed=false`. Udefinert ELLER `true` = UENDRET ruting fra
   * FØR dette feltet fantes (samme migrasjonssikkerhetsmønster som
   * `sensitivity`, §23). Gjelder OGSÅ eksplisitt eier-override
   * (`SPECIFIC_PROVIDER`/`providerPreference`) - en eier kan ikke omgå denne
   * policyen ved å be om en spesifikk betalt provider; policyen selv endres
   * kun ved at kalleren eksplisitt setter feltet til `true` igjen.
   */
  paid_models_allowed?: boolean;
  /**
   * D-106: ordnet preferanseliste av providernavn (f.eks. "bruk Gemma" ->
   * `["gemma_local","gemma_hosted"]`, siden Gemma kan kjøre lokalt ELLER
   * hostet og brukeren mente modellFAMILIEN, ikke en spesifikk instans).
   * Første kandidat som er konfigurert + dekker påkrevde capabilities +
   * består sensitivitets-/paid-models-gaten vinner - INGEN scoring, INGEN
   * stille fallback til en provider utenfor listen (samme forutsigbarhets-
   * prinsipp som `provider`, §10). Ignoreres hvis `provider` (eksakt) også er
   * satt - `provider` er alltid mer spesifikk og vinner.
   */
  providerPreference?: string[];
  /**
   * WP-D4 (JARVIS-033): kun sammen med `providerPreference`. Av (standard/udefinert) = UENDRET: første kvalifiserte medlem vinner og planen har ÉN kandidat (standardstien hadde derfor
   * aldri en reserve inne i gatewayen). På = ALLE kvalifiserte medlemmer returneres som kandidater i listerekkefølge, så `ModelGateway.executePlan` kan gå til neste medlem ved en klassifisert
   * feil FØR noe er sendt. Listen er fortsatt HARD (ingen leverandør utenfor den, ingen scoring), og HVER port gjelder per medlem akkurat som for enkeltvalget: capabilities, sensitivitet
   * (SECRET_RESTRICTED = kun lokal), `paid_models_allowed`, helse og `mode: "LOCAL"`. Et medlem som feiler en port blir aldri kandidat - failover kan ikke åpne noe et enkeltvalg ville stengt.
   */
  preferenceFailover?: boolean;
  /**
   * WP-D4 (gjennomgang av PR #315, L6): leverandører som allerede er FORSØKT i denne turen og ikke skal prøves igjen. Gjelder kun den scorede (AUTO/FAST/…) grenen - ikke eksakt `provider` og ikke `providerPreference`, som er
   * eierens eksplisitte valg. Brukes av samtalemotorens siste reserve (D-354/D-404): omkjøringen gjennom vanlig ruting gjentok tidligere leverandørene i kjeden (opptil 4 kall til samme leverandør og 11 totalt per tur).
   * Alle øvrige porter (sensitivitet, betaling, `mode: LOCAL`, helse) gjelder uendret - utelukking kan bare gjøre utvalget mindre. Er alt som ellers kvalifiserte allerede forsøkt, kastes
   * `NoEligibleProviderError` med `already_attempted` (kalleren kaster da den opprinnelige feilen, som er den ærligste).
   */
  excludeProviders?: readonly string[];
}

export interface RouteCandidate {
  provider: string;
  model: string;
}

export interface RoutePlan {
  mode: RouterMode;
  reason: RoutingReason;
  /** Primær først; resten er deterministisk fallback-rekkefølge. */
  candidates: RouteCandidate[];
  /**
   * WP-D4 (gjennomgang av PR #315, M2): medlemmer av en preferanseliste som bestod ALLE porter (konfigurert, capabilities, sensitivitet, betaling, `mode: LOCAL`), men ble hoppet over FØR noe kall fordi helsen er UNAVAILABLE
   * (halv-åpen krets etter gjentatte feil). Å bytte til neste medlem er reservebruk like mye som etter en kastet feil, så gatewayen melder dem til `CompleteInput.onAttemptFailed` (ellers ble reserven stille de
   * neste 30 s-5 min etter et utfall). Kun satt for preferanselister.
   */
  unavailable?: string[];
}

/** LOCAL krevd men ingen egnet lokal modell live → tydelig feil, aldri sky bak ryggen (§26). */
export class LocalModelUnavailableError extends Error {
  constructor() {
    super("local_model_unavailable: LOCAL krevd, ingen egnet lokal modell er konfigurert/live");
    this.name = "LocalModelUnavailableError";
  }
}

export class NoEligibleProviderError extends Error {
  constructor(detail: string) {
    super(`no_eligible_provider: ${detail}`);
    this.name = "NoEligibleProviderError";
  }
}

/** D-106: `paid_models_allowed=false` og ingen lokal kandidat kvalifiserer -> fail-closed, aldri stille betalt fallback. */
export class PaidModelsDisabledError extends Error {
  constructor(detail: string) {
    super(`paid_models_disabled: ${detail}`);
    this.name = "PaidModelsDisabledError";
  }
}

const REASONING_PURPOSES: ModelPurpose[] = ["CODE", "REASON", "PLAN", "RESEARCH", "CRITIQUE"];
const CHEAP_PURPOSES: ModelPurpose[] = ["QUICK_CLASSIFICATION", "BACKGROUND"];

/**
 * D-106 HOST-FIX (produksjonsherding, Defekt C): live host-kjøring viste et
 * EKSAKT poengmessig uavgjort (132=132) mellom `gemma_local` og `openai` i
 * AUTO-scoringen for et ordinært chat-purpose - siden `Array.prototype.sort`
 * er stabil, ble uavgjortet FØR denne fiksen avgjort av registrerings-
 * rekkefølgen i `providers`-Map-en (dvs. hvilken adapter `main.ts` happened
 * to construct først) - IKKE av noen bevisst rutingpolicy. Det er nøyaktig
 * det §35 "en modell kan aldri velge seg selv" (og mer generelt: ruting skal
 * være DETERMINISTISK OG AUDITERBAR, aldri en bieffekt av array-konstruksjons-
 * rekkefølge) forbyr.
 *
 * Fiksen: en LITEN, eksplisitt lokal-preferanse-tiebreak-bonus i AUTO/LOCAL-
 * scoringen (`score()` sin default-gren). Verdien (0.5) er BEVISST mindre enn
 * den minste mulige heltalls-differansen scoringsformelen for øvrig kan
 * produsere (kvalitet/kost-faktorene er alltid heltall multiplisert med minst
 * 10, latency bidrar med heltall 1-3) - bonusen kan derfor ALDRI vippe et
 * reelt kvalitets-/kost-/latency-drevet utfall, KUN et eksakt matematisk
 * uavgjort. Dette er en generalisering av den EKSISTERENDE D-79/D-80
 * `localBonus`-ideen (i dag kun trigget av PRIVATE/BUSINESS_CONFIDENTIAL
 * sensitivitet) til å også dekke det generelle "ordinært chat, ingen
 * eksplisitt sensitivitet"-tilfellet - IKKE en ny, parallell mekanisme.
 * Provider-nøytral med hensikt (matcher `LocalOpenAiCompatibleAdapter` sin
 * "et vilkårlig OpenAI-kompatibelt lokalt endepunkt"-filosofi, D-79 §6) -
 * ALDRI et hardkodet `provider === "gemma_local"`-navnesjekk i routeren.
 */
export const AUTO_LOCAL_TIE_BREAK_BONUS = 0.5;

/**
 * D-80/D-81: sensitivitetsgate - kjøres FØR capability-filtrering.
 *
 * D-81 P0-SIKKERHETSFIKS: `hosted_free_tier`-providere (i dag KUN `gemma_hosted`)
 * krever et EKSPLISITT `sensitivity === "PUBLIC_OR_LOW_SENSITIVITY"` for å være
 * kvalifisert - udefinert/ukjent sensitivitet blir ALDRI tolket som "public"
 * (fail-safe, ikke fail-open). Dette er en BEVISST innstramming fra den
 * opprinnelige D-80-implementasjonen, som feilaktig lot udefinert sensitivitet
 * forbli kvalifisert for gratis-tier - se D-81 i DECISIONS_AND_ASSUMPTIONS.md
 * for full begrunnelse og den konkrete risikoen dette lukker.
 *
 * For ALLE ANDRE providere (uten `hosted_free_tier`) er migrasjonssikkerheten
 * fra D-80 uendret: udefinert `sensitivity` ELLER `PUBLIC_OR_LOW_SENSITIVITY`
 * = ingen ekstra filtrering (samme ruting som FØR D-80 for disse - INGEN
 * eksisterende kalleside mister tilgang til en tidligere kvalifisert provider).
 * `SECRET_RESTRICTED` = kun lokale providere kvalifisert (fail-closed, aldri
 * stille sky-fallback) - gjelder for ALLE providere, inkl. `hosted_free_tier`.
 * `PRIVATE`/`BUSINESS_CONFIDENTIAL` = `hosted_free_tier`-providere ekskluderes
 * (dekket av førstesjekken over); øvrige, allerede betrodde betalte
 * sky-providere forblir kvalifisert, uendret fra D-80.
 *
 * D-106 HOST-FIX 2: eksportert (var privat) slik at `AiCouncil` sin
 * dynamiske Gemma-familie-oppløsning (`council.ts`) kan gjenbruke NØYAKTIG
 * DENNE regelen for `gemma_hosted`-kvalifisering, i stedet for å duplisere
 * sensitivitetslogikken en gang til (§"aldri en parallell sikkerhetsvei").
 */
export function isSensitivityEligible(profile: ModelProfile, sensitivity: DataSensitivity | undefined): boolean {
  if (profile.hosted_free_tier && sensitivity !== "PUBLIC_OR_LOW_SENSITIVITY") return false;
  if (!sensitivity || sensitivity === "PUBLIC_OR_LOW_SENSITIVITY") return true;
  if (sensitivity === "SECRET_RESTRICTED") return profile.locality === "local";
  return true;
}

/**
 * D-106: `paid_models_allowed`-policygate. Udefinert/`true` = ingen ekstra
 * filtrering (§23 migrasjonssikkerhet, samme mønster som `isSensitivityEligible`).
 * `false` = KUN `locality === "local"` kvalifiserer - gjelder for ALLE
 * providere uansett `hosted_free_tier` (en gratis-tier-hostet sky-provider er
 * FORTSATT sky, ikke lokal - D-79 §3 sitt "lokal" er en distinkt kategori fra
 * "gratis").
 */
function isPaidModelsEligible(profile: ModelProfile, paidModelsAllowed: boolean | undefined): boolean {
  if (paidModelsAllowed === false) return profile.locality === "local";
  return true;
}

interface ProviderRuntime {
  configured: boolean;
  model: string;
}

export class AiRouter {
  /**
   * `autoVerified` (M3, gjennomgang av PR #315): leverandører eieren har erklært LIVE-verifisert for capabilities registeret bare PÅSTÅR (`ModelProfile.live_unverified`; `JARVIS_MESH_TOOLS_VERIFIED`). Tom (standard) = AUTO-ruting
   * bruker ikke slike leverandører til kall som krever en uverifisert capability (verktøykall, Kimi-streaming). Gjelder kun den scorede grenen - eierens eksplisitte valg (`provider`, `providerPreference`) er uendret.
   */
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly health: ProviderHealthTracker,
    private readonly autoVerified: ReadonlySet<string> = new Set()
  ) {}

  plan(input: RouteInput, providers: Map<string, ProviderRuntime>): RoutePlan {
    const mode: RouterMode = input.provider ? "SPECIFIC_PROVIDER" : (input.mode ?? "AUTO");

    // Owner override: eksakt provider, ingen stille fallback (forutsigbarhet > resiliens her).
    // §38 (P1A): manglende påkrevd capability gir tydelig feil - aldri stille ignorering.
    if (mode === "SPECIFIC_PROVIDER") {
      const name = input.provider as string;
      const rt = providers.get(name);
      if (!rt?.configured) {
        throw new NoEligibleProviderError(`override-provider '${name}' er ikke konfigurert`);
      }
      const requiredForOverride = new Set<ModelCapability>(input.required_capabilities ?? []);
      if (input.needs_structured) requiredForOverride.add("structured_output");
      const profile = this.registry.profileOrGeneric(name, rt.model);
      const missing = [...requiredForOverride].filter((c) => !profile.capabilities.includes(c));
      if (missing.length > 0) {
        throw new NoEligibleProviderError(
          `override_capability_missing: '${name}' mangler [${missing.join(",")}]`
        );
      }
      // D-79 §3: eksplisitt eier-valg er ALDRI en fritakelse fra sensitivitetsloven -
      // et gratis-tier/sky-valg for SECRET_RESTRICTED/PRIVATE-data feiler fortsatt lukket.
      if (!isSensitivityEligible(profile, input.sensitivity)) {
        throw new NoEligibleProviderError(
          `override_sensitivity_blocked: '${name}' er ikke godkjent for sensitivitet ${input.sensitivity}`
        );
      }
      // D-106: samme prinsipp for paid_models_allowed - eksplisitt eier-valg
      // av en betalt/sky-provider omgår ALDRI en aktiv "ikke bruk betalte
      // modeller"-policy.
      if (!isPaidModelsEligible(profile, input.paid_models_allowed)) {
        throw new PaidModelsDisabledError(
          `override_paid_models_disabled: '${name}' er en betalt/sky-provider, paid_models_allowed=false`
        );
      }
      return { mode, reason: "OWNER_OVERRIDE", candidates: [{ provider: name, model: rt.model }] };
    }

    // D-106: preferanserekkefølge (f.eks. "bruk Gemma" -> ["gemma_local","gemma_hosted"]).
    // Ingen scoring - første kandidat i listen som er konfigurert og består
    // capability-/sensitivitets-/paid-models-gatene vinner, samme
    // forutsigbarhetsprinsipp som eksakt `provider`-override (§10). Kun aktiv
    // når `provider` (eksakt) IKKE er satt - eksakt override er alltid mer
    // spesifikk.
    if (input.providerPreference && input.providerPreference.length > 0) {
      const requiredForPref = new Set<ModelCapability>(input.required_capabilities ?? []);
      if (input.needs_structured) requiredForPref.add("structured_output");
      const attempted: string[] = [];
      // D-404: HVILKEN port som avviste hver leverandør (tidligere bare «ingen er konfigurert/kvalifisert» - kostet en hel feilsøkingsrunde).
      const rejected: string[] = [];
      // WP-D4 (JARVIS-033): med `preferenceFailover` samles ALLE kvalifiserte medlemmer (i listerekkefølge) i stedet for å returnere ved det første.
      const chain: RouteCandidate[] = [];
      const unavailable: string[] = [];
      for (const name of input.providerPreference) {
        if (attempted.includes(name)) continue; // samme leverandør to ganger i listen = ett forsøk (ellers dobbelt betalt kall i failover)
        const rt = providers.get(name);
        attempted.push(name);
        if (!rt?.configured) { rejected.push(`${name}:not_configured`); continue; }
        const profile = this.registry.profileOrGeneric(name, rt.model);
        const missing = [...requiredForPref].filter((c) => !profile.capabilities.includes(c));
        if (missing.length > 0) { rejected.push(`${name}:missing_capabilities=${missing.join("+")}`); continue; }
        // WP-D4: `mode: "LOCAL"` gjaldt tidligere bare AUTO-grenen; en preferanseliste med en skyleverandør kunne dermed ignorere «kun lokale modeller». Nå gjelder den også her (strengere, aldri løsere).
        if (mode === "LOCAL" && profile.locality !== "local") { rejected.push(`${name}:not_local`); continue; }
        if (!isSensitivityEligible(profile, input.sensitivity)) { rejected.push(`${name}:sensitivity=${input.sensitivity ?? "undefined"}`); continue; }
        if (!isPaidModelsEligible(profile, input.paid_models_allowed)) { rejected.push(`${name}:paid_models_disabled`); continue; }
        if (this.health.state(name, true) === "UNAVAILABLE") { rejected.push(`${name}:health_unavailable`); unavailable.push(name); continue; }
        if (!input.preferenceFailover) {
          return {
            mode: "SPECIFIC_PROVIDER",
            reason: "PROVIDER_PREFERENCE",
            candidates: [{ provider: name, model: rt.model }],
            ...(unavailable.length > 0 ? { unavailable } : {})
          };
        }
        chain.push({ provider: name, model: rt.model });
      }
      if (chain.length > 0) return { mode: "SPECIFIC_PROVIDER", reason: "PROVIDER_PREFERENCE", candidates: chain, ...(unavailable.length > 0 ? { unavailable } : {}) };
      throw new NoEligibleProviderError(
        `provider_preference_exhausted: ingen av [${attempted.join(",")}] er konfigurert/kvalifisert (${rejected.join("; ")})`
      );
    }

    const required = new Set<ModelCapability>(input.required_capabilities ?? []);
    if (input.purpose === "VISION") required.add("vision");
    if (input.purpose && REASONING_PURPOSES.includes(input.purpose)) required.add("reasoning");
    if (input.needs_structured) required.add("structured_output");

    const eligible: Array<{ profile: ModelProfile; model: string; state: string }> = [];
    let sensitivityExcludedCount = 0;
    let paidExcludedCount = 0;
    const alreadyAttempted = new Set(input.excludeProviders ?? []);
    const skippedAttempted: string[] = [];
    // M3: leverandører som er hoppet over fordi en capability kallet krever er påstått, men ikke live-verifisert av eieren (navn → capabilities).
    const skippedUnverified = new Map<string, ModelCapability[]>();
    for (const [name, rt] of providers) {
      if (!rt.configured) continue;
      if (alreadyAttempted.has(name)) { skippedAttempted.push(name); continue; }
      const profile = this.registry.profileOrGeneric(name, rt.model);
      if (mode === "LOCAL" && profile.locality !== "local") continue;
      if (![...required].every((c) => profile.capabilities.includes(c))) continue;
      if (!isSensitivityEligible(profile, input.sensitivity)) {
        sensitivityExcludedCount++;
        continue;
      }
      if (!isPaidModelsEligible(profile, input.paid_models_allowed)) {
        paidExcludedCount++;
        continue;
      }
      // M3: siste port - påstått, men ikke live-verifisert capability som dette kallet krever (kun hvis leverandøren ellers ville vært kvalifisert).
      const unverified = (profile.live_unverified ?? []).filter((c) => required.has(c));
      if (unverified.length > 0 && !this.autoVerified.has(name)) { skippedUnverified.set(name, unverified); continue; }
      eligible.push({ profile, model: rt.model, state: this.health.state(name, true) });
    }
    if (eligible.length === 0) {
      if (skippedAttempted.length > 0) {
        throw new NoEligibleProviderError(`all_remaining_providers_already_attempted: [${skippedAttempted.join(",")}] er allerede forsøkt i denne turen`);
      }
      if (mode === "LOCAL") throw new LocalModelUnavailableError();
      if (input.paid_models_allowed === false && paidExcludedCount > 0) {
        throw new PaidModelsDisabledError(
          `ingen konfigurert LOKAL provider dekker [${[...required].join(",")}]`
        );
      }
      throw new NoEligibleProviderError(
        `ingen konfigurert provider dekker [${[...required].join(",")}]` +
          (input.sensitivity ? ` (sensitivity=${input.sensitivity})` : "") +
          (skippedUnverified.size > 0
            ? ` (ikke live-verifisert, utelatt fra AUTO-ruting: ${[...skippedUnverified].map(([name, caps]) => `${name}:${caps.join("+")}`).join(", ")} - kjør mesh-live-smoke.ts --tools og sett JARVIS_MESH_TOOLS_VERIFIED)`
            : "")
      );
    }

    // D-106 HOST-FIX Defekt C: brukt til å avgjøre EKSTERNT (utenfor score()) om
    // en gitt kandidat er kvalifisert for tiebreak-bonusen - samme betingelse
    // som INNI score() sin default-gren, holdt i sync bevisst (ren funksjon,
    // ingen skjult tilstand) slik at reason-logikken under kan skille et REELT
    // uavgjort (bonusen avgjorde) fra et vanlig kvalitets-/kost-drevet valg.
    const isAutoLocalTieBreakEligible = (p: ModelProfile): boolean =>
      (mode === "AUTO" || mode === "LOCAL") && p.locality === "local";

    const score = (e: { profile: ModelProfile }): number => {
      const p = e.profile;
      const latency = p.latency_class === "fast" ? 3 : p.latency_class === "medium" ? 2 : 1;
      const cheap = 6 - p.cost_class;
      switch (mode) {
        case "FAST":
          return latency * 30 + p.quality_class;
        case "CHEAP":
          return cheap * 30 + p.quality_class;
        case "QUALITY":
        case "CRITIC":
          return p.quality_class * 30 + latency;
        default: {
          // AUTO/LOCAL: balansert, purpose-justert (§15: kost som signal, ikke hard cap).
          let quality = 2;
          let cost = 1;
          if (input.purpose && REASONING_PURPOSES.includes(input.purpose)) quality = 3;
          if (input.purpose && CHEAP_PURPOSES.includes(input.purpose)) {
            cost = 3;
            quality = 1;
          }
          // D-79 §3/§7: PRIVATE/BUSINESS_CONFIDENTIAL foretrekker lokal MYK (bonus,
          // ikke et hardt krav - D-23 "preferably local... or an approved paid
          // provider") - lokal vinner AUTO-ranking når faktisk tilgjengelig/frisk,
          // men blokkerer ALDRI en allerede kvalifisert betrodd sky-provider.
          const localBonus =
            p.locality === "local" &&
            (input.sensitivity === "PRIVATE" || input.sensitivity === "BUSINESS_CONFIDENTIAL")
              ? 1000
              : 0;
          // D-106 HOST-FIX Defekt C: se AUTO_LOCAL_TIE_BREAK_BONUS over - avgjør
          // KUN eksakte heltalls-uavgjort deterministisk, aldri en reell forskjell.
          const tieBreakBonus = isAutoLocalTieBreakEligible(p) ? AUTO_LOCAL_TIE_BREAK_BONUS : 0;
          return p.quality_class * quality * 10 + cheap * cost * 10 + latency + localBonus + tieBreakBonus;
        }
      }
    };

    // Health-sortering (§11): UNAVAILABLE ekskluderes, RATE_LIMITED bakerst.
    // D-395 (JARVIS-078): uavgjort poengsum avgjøres DETERMINISTISK på providernavn - ikke på registreringsrekkefølgen i main.ts (stabil sortering
    // ga ellers hvilken adapter som tilfeldigvis ble registrert først).
    const byProviderName = (a: { profile: ModelProfile }, b: { profile: ModelProfile }): number => a.profile.provider.localeCompare(b.profile.provider);
    const rankedIgnoringHealth = [...eligible].sort((a, b) => score(b) - score(a) || byProviderName(a, b));
    const healthy = eligible.filter((e) => e.state !== "UNAVAILABLE");
    if (healthy.length === 0) {
      throw new NoEligibleProviderError("alle kvalifiserte providere er UNAVAILABLE");
    }
    const ranked = healthy.sort((a, b) => {
      const aLimited = a.state === "RATE_LIMITED" ? 1 : 0;
      const bLimited = b.state === "RATE_LIMITED" ? 1 : 0;
      if (aLimited !== bLimited) return aLimited - bLimited;
      return score(b) - score(a) || byProviderName(a, b);
    });

    const top = ranked[0] as (typeof ranked)[number];
    const idealTop = rankedIgnoringHealth[0] as (typeof ranked)[number];

    // D-106 HOST-FIX Defekt C: fant AUTO_LOCAL_TIE_BREAK_BONUS faktisk et EKSAKT
    // uavgjort? Sammenligner poengsummen UTEN tiebreak-bonusen for topp-kandidaten
    // mot nest-beste - kun hvis de er identiske UTEN bonusen var bonusen reelt
    // avgjørende (ALDRI rapportert som årsak for en genuin kvalitets-/kost-vinner).
    const baseScore = (e: (typeof ranked)[number]): number =>
      score(e) - (isAutoLocalTieBreakEligible(e.profile) ? AUTO_LOCAL_TIE_BREAK_BONUS : 0);
    const localTieBreakDecisive =
      ranked.length > 1 &&
      isAutoLocalTieBreakEligible(top.profile) &&
      baseScore(top) === baseScore(ranked[1] as (typeof ranked)[number]);

    let reason: RoutingReason;
    if (top.profile.provider !== idealTop.profile.provider) {
      reason = idealTop.state === "RATE_LIMITED" ? "RATE_LIMIT_FALLBACK" : "PRIMARY_UNHEALTHY";
    } else if (mode === "LOCAL") {
      reason = "LOCAL_REQUIRED";
    } else if (mode === "CRITIC") {
      reason = "CRITIC_REQUIRED";
    } else if (required.has("vision")) {
      reason = "VISION_REQUIRED";
    } else if (input.needs_structured) {
      reason = "STRUCTURED_REQUIRED";
    } else if (
      (input.sensitivity === "PRIVATE" || input.sensitivity === "BUSINESS_CONFIDENTIAL") &&
      top.profile.locality === "local"
    ) {
      // D-80 §7: sensitiv + lokal tilgjengelig/frisk => lokal-bonusen avgjorde valget.
      reason = "PRIVACY_PREFERS_LOCAL";
    } else if (input.sensitivity !== "PUBLIC_OR_LOW_SENSITIVITY" && sensitivityExcludedCount > 0) {
      // D-81 P0-fiks: minst én ellers-kvalifisert kandidat (typisk gratis-tier) ble
      // ekskludert - GJELDER OGSÅ udefinert sensitivitet (fail-safe, se isSensitivityEligible()).
      reason = "PRIVACY_RESTRICTED";
    } else if (input.paid_models_allowed === false && paidExcludedCount > 0) {
      // D-106: minst én ellers-kvalifisert betalt/sky-kandidat ble ekskludert av policyen.
      reason = "PAID_MODELS_DISABLED";
    } else if (localTieBreakDecisive) {
      // D-106 HOST-FIX Defekt C: AUTO_LOCAL_TIE_BREAK_BONUS avgjorde et reelt
      // poengmessig uavgjort - se definisjonen over for hvorfor dette ALDRI kan
      // overstyre en genuin kvalitets-/kost-forskjell.
      reason = "LOCAL_PREFERRED_ON_TIE";
    } else if (mode === "FAST") {
      reason = "LOW_LATENCY";
    } else if (mode === "CHEAP" || (input.purpose && CHEAP_PURPOSES.includes(input.purpose))) {
      reason = "LOW_COST";
    } else if (input.purpose && REASONING_PURPOSES.includes(input.purpose)) {
      reason = "REASONING_REQUIRED";
    } else if (ranked.length === 1) {
      reason = "ONLY_AVAILABLE";
    } else {
      reason = "DEFAULT_BALANCED";
    }

    return {
      mode,
      reason,
      candidates: ranked.map((e) => ({ provider: e.profile.provider, model: e.model }))
    };
  }
}
