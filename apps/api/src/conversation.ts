import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore, fastRoute } from "@jarvis/core";
import {
  BudgetExceededError,
  classifyDecisionImportance,
  parseRoutingOverride,
  type AiCouncil,
  type DecisionClassification,
  type ModelGateway,
  type RoutingOverrideIntent,
  type ToolExecutor,
  type TraceSink
} from "@jarvis/model-gateway";
import { ProviderError, type StreamEvent, type ToolDefinition } from "@jarvis/provider-adapters";
import type { TaskService, InProcessWorker } from "@jarvis/tasks";
import { randomUUID } from "node:crypto";

export interface ConversationDeps {
  messages: MessageStore;
  context: ContextBuilder;
  gateway: ModelGateway;
  tasks: TaskService;
  worker: InProcessWorker;
  trace: TraceSink;
  /** Fase 4: hybridminne-kontekst med kildeangivelse (kun gjeldende space). */
  memory?: { contextFor(identity: IdentityContext, userText: string): Promise<string> };
  /**
   * D-30 live-funn: mesh-verktøy for samtalebanen (tekst OG voice går via /chat).
   * Executor bindes til samtalens FAKTISKE resolved identity per kall - aldri en
   * fast global owner-identity - slik at tenant-isolasjon, delegation og
   * authority følger den som snakker. Utførelse går UANSETT via Tool Gateway →
   * Policy/Execution Authority; definisjonene kommer fra trusted lag.
   */
  tools?: {
    definitions: ToolDefinition[];
    executorFor(identity: IdentityContext): ToolExecutor;
  };
  /**
   * D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse §"large
   * decision"-trigger, utvidet i HOST-FIX 2026-08-22 med automatisk høy-
   * innvirkning-klassifisering): VALGFRITT. To distinkte trigger-kilder ruter
   * hit i stedet for normal chat: (1) eksplisitt brukerfrase ("bruk AI-rådet",
   * "spør alle AI-ene") - `trigger_source="explicit_user"`; (2) deterministisk
   * høy-innvirkning-klassifisering (`decision-importance.ts`, INGEN LLM) -
   * `trigger_source="high_impact_classifier"`. Udefinert = IDENTISK oppførsel
   * som før D-106 (begge triggerkildene ignoreres, normal chat fortsetter -
   * §23 migrasjonssikkerhet).
   */
  council?: AiCouncil;
}

export interface ChatReply {
  reply: string;
  routed: "fast" | "model" | "blocked";
  task_id?: string;
  /** BO-11.1 §6: klienten koblet fra/avbrøt - generasjonen ble kansellert upstream. */
  cancelled?: boolean;
  /** §11: streamen ble avbrutt av provider-feil ETTER output-start - aldri skjult. */
  interrupted?: boolean;
}

// Permissions ligger ALDRI i prompten - Policy/Execution Authority er trusted
// runtime og håndhever tilgang deterministisk uansett hva modellen "tror".
const SYSTEM_PROMPT =
  "Du er Jarvis, Tobias sin personlige assistent. Svar kort og presist på norsk. " +
  "Du kan bruke de verktøyene runtime eksplisitt gjør tilgjengelige i denne samtalen. " +
  "Bruk relevante tilgjengelige read-verktøy når spørsmålet krever ekstern informasjon " +
  "(f.eks. kalender, e-post), og ikke påstå at du mangler tilgang før tilgjengelige verktøy er vurdert.";

/**
 * Conversation Engine (fase 3): rask bane først (deterministisk, uten LLM),
 * ellers intelligent bane via Model Gateway. Alle svar persisteres i
 * sesjonshistorikken; rask bane spores i trace (akseptanse 4).
 */
export class ConversationEngine {
  constructor(private readonly deps: ConversationDeps) {}

  async handle(
    identity: IdentityContext,
    text: string,
    onToken?: (t: string) => void,
    /** BO-11.1 §6: klient-disconnect propagerer helt til provider-upstream. */
    signal?: AbortSignal,
    /** BO-12 §33: valgfri owner-override av provider (router håndhever §38). */
    provider?: string,
    /**
     * D-30: trusted verktøy-aktivitet for klienten (SSE `tool_call`/voice-status).
     * Får KUN tool_name - aldri raw arguments eller tool-result-JSON.
     */
    onToolCall?: (toolName: string) => void
  ): Promise<ChatReply> {
    await this.deps.messages.save(identity, "user", text);

    const intent = fastRoute(text);
    if (intent) {
      const started = Date.now();
      const result = await this.handleFastIntent(identity, intent);
      await this.deps.trace.record({
        trace_id: `trace-${randomUUID()}`,
        kind: "fast_route",
        name: intent.kind,
        tenant_id: identity.tenant_id,
        session_id: identity.session_id,
        at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        metadata: { llm_used: false }
      });
      onToken?.(result.reply);
      await this.deps.messages.save(identity, "assistant", result.reply);
      return result;
    }

    // D-106 (§"user routing overrides"): 100% deterministisk fraseparsing
    // (aldri en LLM som tolker instruksjonen) - se override-parser.ts.
    // Eksplisitt `provider`-parameter (API/voice-nivå-override) vinner
    // ALLTID over en tekst-parset frase - mer spesifikk kilde vinner.
    const override = parseRoutingOverride(text);

    // D-106 HOST-FIX (§"LARGE-DECISION TRIGGER"): deterministisk høy-
    // innvirkning-klassifisering - INGEN LLM avgjør dette, ren mønster-
    // gjenkjenning (decision-importance.ts). Kjøres ALLTID (gratis, ingen
    // modellkall) slik at klassifiseringen er auditerbar selv når den IKKE
    // trigger Council (f.eks. spores i cost/kvalitetsanalyse senere).
    const classification = classifyDecisionImportance(text);

    // Trigger-presedens (§"USER OVERRIDES", eksplisitt logget, ALDRI en
    // skjult begrensning på eierens autoritet):
    //   1. Eksplisitt "ikke bruk AI-rådet"-undertrykkelse VINNER over ALT
    //      annet - eieren kan alltid undertrykke, selv en policy-mandatert
    //      høy-innvirkning-klassifisering (§"Do not invent hidden
    //      restrictions on Tobias' owner authority").
    //   2. Eksplisitt "bruk AI-rådet"-trigger.
    //   3. Automatisk høy-innvirkning-klassifisering - en FORCED single-
    //      provider-override (`override?.provider`) i SAMME melding
    //      undertrykker den ALDRI stille (§"forced single-provider override
    //      should not silently suppress a policy-mandated high-impact
    //      Council") - Council trigges uansett, provider-override-feltene
    //      ignoreres KUN for denne ene meldingen (routing til Council, ikke
    //      til enkelt-provider-chat).
    if (override?.suppressCouncil) {
      await this.deps.trace.record({
        trace_id: `trace-${randomUUID()}`,
        kind: "council_suppressed",
        name: "owner_explicit_suppression",
        tenant_id: identity.tenant_id,
        session_id: identity.session_id,
        at: new Date().toISOString(),
        duration_ms: 0,
        metadata: { matched_phrase: override.matched_phrase, decision_importance: classification.decision_importance }
      });
    } else {
      const triggerSource: "explicit_user" | "high_impact_classifier" | undefined = override?.triggerCouncil
        ? "explicit_user"
        : classification.decision_importance === "HIGH_IMPACT_DECISION"
          ? "high_impact_classifier"
          : undefined;
      if (triggerSource) {
        return this.runCouncil(identity, text, triggerSource, classification, override, onToken);
      }
    }

    let partial = "";
    try {
      const context = await this.deps.context.build(identity);
      const history = context.history.slice(-20).map((m) => ({
        role: (m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
        content: m.content
      }));
      const memoryContext = this.deps.memory ? await this.deps.memory.contextFor(identity, text) : "";
      const system = memoryContext ? `${SYSTEM_PROMPT}\n\n${memoryContext}` : SYSTEM_PROMPT;
      // UA-1: Conversation Engine oppgir purpose - aldri provider direkte (§31).
      // P1A (§27): SSE-klienter får normalisert stream; klienten ser aldri provider-format.
      // D-203 (2026-09-20, direkte chat-instruks fra Tobias: "simpel default, lav-sensitiv
      // som standard, fiks det"): denne inputen satte ALDRI `sensitivity` - routeren
      // (D-81 P0-sikkerhetsfiks, router.ts sin `isSensitivityEligible()`) tolker udefinert
      // sensitivitet fail-closed (ALDRI som "public"), så `gemma_hosted` (eneste
      // `hosted_free_tier`-provider) var strukturelt UOPPNÅELIG for vanlig eierchat -
      // "Gemma-first"-kost-policyen (D-79/D-80) virket derfor ALDRI reelt her, uansett
      // D-200s strømmingsfiks (host-verifisert: `routing_reason=PRIVACY_RESTRICTED` på
      // hver eneste chat-generasjon). Eierens EGEN, personlige samtalekanal
      // (`tenant-personal`, ett enkelt-bruker-tenant) er en bevisst, enkel default -
      // IKKE en generell innholdsklassifisering. Council (`runCouncil()` under) er
      // BEVISST UBERØRT - den trigges KUN for eksplisitt høy-innvirkning-beslutninger
      // (`decision-importance.ts`) eller eksplisitt eierfrase, og skal IKKE automatisk
      // nedgraderes til lav-sensitivitet bare fordi normal chat nå er det.
      const input = {
        tenant_id: identity.tenant_id,
        session_id: identity.session_id,
        purpose: "CHAT" as const,
        sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" as const,
        ...(provider !== undefined ? { provider } : override?.provider !== undefined ? { provider: override.provider } : {}),
        ...(provider === undefined && override?.providerPreference !== undefined
          ? { providerPreference: override.providerPreference }
          : {}),
        ...(provider === undefined && override?.mode !== undefined ? { mode: override.mode } : {}),
        ...(override?.paid_models_allowed !== undefined ? { paid_models_allowed: override.paid_models_allowed } : {}),
        request: { system, messages: history, max_tokens: 1024 }
      };
      // D-30 live-funn: med tools konfigurert går BÅDE streaming- og JSON-banen
      // gjennom completeWithTools (samme normaliserte tool-løkke som executive/
      // BO-11) - aldri en voice-spesifikk sidevei. Uten tools: som før.
      // D-30 HOST BLOCKER §1/§2 (spørsmål C): valgfri diagnostikk - kun type/timing,
      // ALDRI event-innhold (aldri prompt/svar-tekst/secrets), kun når eksplisitt på.
      const streamDebug = process.env["JARVIS_STREAM_DEBUG"] === "true";
      const tHandleStart = Date.now();
      const onEvent = onToken
        ? (event: StreamEvent) => {
            if (streamDebug) {
              console.error(JSON.stringify({
                msg: "stream_debug_conversation", event_type: event.type, at_ms: Date.now() - tHandleStart
              }));
            }
            if (event.type === "text_delta") {
              partial += event.text;
              onToken(event.text);
            } else if (event.type === "tool_call_complete") {
              // Kun navnet krysser trust-grensen til klienten (§5) - aldri args.
              onToolCall?.(event.call.tool_name);
            }
          }
        : undefined;
      const result = this.deps.tools
        ? await this.deps.gateway.completeWithTools(input, {
            tools: this.deps.tools.definitions,
            executor: this.deps.tools.executorFor(identity),
            ...(onEvent ? { onEvent } : {}),
            ...(signal ? { signal } : {})
          })
        : onEvent
          ? await this.deps.gateway.stream(input, onEvent, signal)
          : await this.deps.gateway.complete(input);
      await this.deps.messages.save(identity, "assistant", result.text);
      return { reply: result.text, routed: "model" };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        const reply = `Modellkall stoppet av budsjettvakten: ${err.message}`;
        await this.deps.messages.save(identity, "assistant", reply);
        onToken?.(reply);
        return { reply, routed: "blocked" };
      }
      if (err instanceof ProviderError && err.kind === "cancelled") {
        // §6: rent avbrudd - delvis tekst persisteres med eksplisitt markør,
        // ingen zombie-generation, neste tur er upåvirket.
        await this.deps.messages.save(identity, "assistant", `${partial} [avbrutt av bruker]`.trim());
        return { reply: partial, routed: "model", cancelled: true };
      }
      if (err instanceof ProviderError && err.kind === "stream_interrupted") {
        // §11: avbruddet er eksplisitt - aldri stille provider-bytte i samme tekst.
        await this.deps.messages.save(identity, "assistant", `${partial} [stream avbrutt]`.trim());
        return { reply: partial, routed: "model", interrupted: true };
      }
      throw err;
    }
  }

  /**
   * D-106 HOST-FIX (§"COUNCIL REQUIREMENT"): SAMME kanoniske `AiCouncil`
   * (council.ts) for BEGGE trigger-kilder - ingen parallell Council-vei.
   * `sensitivity`/`paid_models_allowed` fra en eventuell tekst-override
   * videreføres UENDRET til Council-kjøringen (samme policy-håndhevelse som
   * normal chat, §11 i order: "paid-model-disabled policy interaction is
   * explicit and fail-closed/honest").
   */
  private async runCouncil(
    identity: IdentityContext,
    text: string,
    triggerSource: "explicit_user" | "high_impact_classifier",
    classification: DecisionClassification,
    override: RoutingOverrideIntent | null,
    onToken?: (t: string) => void
  ): Promise<ChatReply> {
    if (!this.deps.council) {
      const reply = "AI-rådet er ikke konfigurert i denne kjøringen.";
      await this.deps.messages.save(identity, "assistant", reply);
      onToken?.(reply);
      return { reply, routed: "model" };
    }
    const result = await this.deps.council.run({
      tenant_id: identity.tenant_id,
      session_id: identity.session_id,
      decision_context: text,
      ...(override?.paid_models_allowed !== undefined ? { paid_models_allowed: override.paid_models_allowed } : {}),
      trigger: {
        trigger_source: triggerSource,
        decision_importance: classification.decision_importance,
        trigger_reasons: classification.trigger_reasons,
        matched_signals: classification.matched_signals,
        classifier_version: classification.classifier_version
      }
    });
    const reply =
      `${result.decision}\n\n(konsensus: ${result.consensus_status}, tillit: ${result.confidence}%` +
      `${result.dissenting_models.length > 0 ? `, uenig: ${result.dissenting_models.join(", ")}` : ""})`;
    await this.deps.messages.save(identity, "assistant", reply);
    onToken?.(reply);
    return { reply, routed: "model" };
  }

  private async handleFastIntent(
    identity: IdentityContext,
    intent: NonNullable<ReturnType<typeof fastRoute>>
  ): Promise<ChatReply> {
    switch (intent.kind) {
      case "system_status":
        return { reply: "Jarvis kjører. Database og policy er aktive.", routed: "fast" };
      case "help":
        return {
          reply: "Kommandoer: status · opprett jobb: <mål> · jobbstatus <id> · avbryt jobb <id>",
          routed: "fast"
        };
      case "create_task": {
        const result = await this.deps.tasks.create(identity, intent.goal);
        if (!result.ok) {
          return { reply: `Kunne ikke opprette jobb: ${result.reason}`, routed: "fast" };
        }
        return { reply: `Jobb opprettet: ${result.value.task_id}`, routed: "fast", task_id: result.value.task_id };
      }
      case "task_status": {
        const result = await this.deps.tasks.get(identity, intent.task_id);
        if (!result.ok) {
          return { reply: `Fant ikke jobben: ${result.reason}`, routed: "fast" };
        }
        const res = result.value.result ? ` Resultat: ${JSON.stringify(result.value.result)}` : "";
        return { reply: `Jobb ${result.value.task_id}: ${result.value.status}.${res}`, routed: "fast" };
      }
      case "home_light": {
        // Stedsbevisst hjemstyring: rommet hentes fra identity.site_id/room_id.
        // Kjørende HA-integrasjon kobles til via Tool Gateway (fase 9-runtime).
        if (!identity.site_id || !identity.room_id) {
          return { reply: "Jeg vet ikke hvilket rom du er i (mangler sted i konteksten).", routed: "fast" };
        }
        return {
          reply: `Hjemstyring (${intent.on ? "på" : "av"}, ${identity.room_id}) krever tilkoblet Home Assistant-instans.`,
          routed: "fast"
        };
      }
      case "cancel_task": {
        const result = await this.deps.tasks.cancel(identity, intent.task_id);
        if (!result.ok) {
          return { reply: `Kunne ikke avbryte: ${result.reason}`, routed: "fast" };
        }
        return {
          reply: result.value.cancelled ? `Jobb ${intent.task_id} avbrutt.` : `Jobb ${intent.task_id} var ikke aktiv.`,
          routed: "fast"
        };
      }
    }
  }
}
