import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore, fastRoute } from "@jarvis/core";
import { BudgetExceededError, type ModelGateway, type TraceSink } from "@jarvis/model-gateway";
import type { TaskService, InProcessWorker } from "@jarvis/tasks";
import { randomUUID } from "node:crypto";

export interface ConversationDeps {
  messages: MessageStore;
  context: ContextBuilder;
  gateway: ModelGateway;
  tasks: TaskService;
  worker: InProcessWorker;
  trace: TraceSink;
}

export interface ChatReply {
  reply: string;
  routed: "fast" | "model" | "blocked";
  task_id?: string;
}

const SYSTEM_PROMPT =
  "Du er Jarvis, Tobias sin personlige assistent. Svar kort og presist på norsk. " +
  "Du har ikke tilgang til verktøy eller eksterne data i denne fasen.";

/**
 * Conversation Engine (fase 3): rask bane først (deterministisk, uten LLM),
 * ellers intelligent bane via Model Gateway. Alle svar persisteres i
 * sesjonshistorikken; rask bane spores i trace (akseptanse 4).
 */
export class ConversationEngine {
  constructor(private readonly deps: ConversationDeps) {}

  async handle(identity: IdentityContext, text: string, onToken?: (t: string) => void): Promise<ChatReply> {
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

    try {
      const context = await this.deps.context.build(identity);
      const history = context.history.slice(-20).map((m) => ({
        role: (m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
        content: m.content
      }));
      const result = await this.deps.gateway.complete({
        tenant_id: identity.tenant_id,
        session_id: identity.session_id,
        request: { system: SYSTEM_PROMPT, messages: history, max_tokens: 1024 },
        ...(onToken ? { onToken } : {})
      });
      await this.deps.messages.save(identity, "assistant", result.text);
      return { reply: result.text, routed: "model" };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        const reply = `Modellkall stoppet av budsjettvakten: ${err.message}`;
        await this.deps.messages.save(identity, "assistant", reply);
        onToken?.(reply);
        return { reply, routed: "blocked" };
      }
      throw err;
    }
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
