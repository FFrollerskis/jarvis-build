import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { MemoryTraceSink, type AiCouncil, type CompleteInput, type ModelGateway } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";

/**
 * `tasks`/`worker` er IKKE på noen kodesti disse testene faktisk øver (ingen
 * av testtekstene treffer `fastRoute()`, og verken council- eller
 * override-grenene i `ConversationEngine.handle()` bruker dem) - rene typede
 * stubs, IKKE ekte `TaskService`/`PolicyGateway`/`PgTaskQueue`-konstruksjon
 * (som ville krevd unødvendig policy-/kø-oppsett for disse presist avgrensede
 * routing-testene).
 */
const fakeTasks = {} as unknown as TaskService;
const fakeWorker = {} as unknown as InProcessWorker;

/**
 * D-106 (§"user routing overrides" / §"AI Council trigger"): beviser at
 * `ConversationEngine.handle()` faktisk komponerer `parseRoutingOverride()`s
 * resultat inn i `CompleteInput`, og at "bruk alle AI-ene" ruter til
 * `AiCouncil` i stedet for normal chat. Samme `fakePool()`-mønster som
 * `modules/model-gateway/test/council.test.ts` - ingen ekte Postgres
 * nødvendig (MessageStore/ContextBuilder er ekte instanser mot en fake pool,
 * ikke egne håndrullede mocks - mer realistisk enn å mocke deres offentlige
 * grensesnitt).
 */
function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM tasks")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

const identity: IdentityContext = {
  person_id: "person-1",
  tenant_id: "tenant-1",
  memory_space_id: "personal",
  session_id: "session-1",
  device_id: "dev-1",
  channel: "web",
  auth_strength: "active"
};

function buildEngine(opts: {
  onComplete?: (input: CompleteInput) => void;
  onCouncilRun?: (input: unknown) => void;
}): ConversationEngine {
  const pool = fakePool();
  const messages = new MessageStore(pool);
  const context = new ContextBuilder(pool);
  const gateway = {
    complete: async (input: CompleteInput) => {
      opts.onComplete?.(input);
      return { text: "modellsvar", usage: { input_tokens: 1, output_tokens: 1 }, provider: "scripted", model: "scripted-1" };
    },
    stream: async () => {
      throw new Error("stream skal ikke kalles i disse testene (ingen onToken gitt)");
    },
    completeWithTools: async () => {
      throw new Error("completeWithTools skal ikke kalles i disse testene (ingen tools konfigurert)");
    }
  } as unknown as ModelGateway;
  const council = {
    run: async (input: unknown) => {
      opts.onCouncilRun?.(input);
      return {
        council_id: "council-test",
        decision: "Rådets anbefaling",
        consensus_status: "CONSENSUS" as const,
        supporting_models: ["anthropic", "openai"],
        dissenting_models: [],
        key_evidence: [],
        key_disagreements: [],
        risk_summary: "",
        confidence: 90,
        recommended_action: "gjør X",
        provenance: {
          council_id: "council-test",
          full_council: true,
          requested_members: ["anthropic", "openai"],
          unavailable_members: [],
          round1: [],
          round2: [],
          round3: [],
          synthesis_provider: "anthropic"
        }
      };
    }
  } as unknown as AiCouncil;
  return new ConversationEngine({
    messages,
    context,
    gateway,
    tasks: fakeTasks,
    worker: fakeWorker,
    trace: new MemoryTraceSink(),
    council
  });
}

describe("D-106 ConversationEngine: AI Council-trigger", () => {
  it("A: 'bruk alle AI-ene' ruter til AiCouncil.run() i stedet for normal chat - gateway.complete kalles ALDRI", async () => {
    let councilCalled = false;
    let completeCalled = false;
    const engine = buildEngine({
      onCouncilRun: () => {
        councilCalled = true;
      },
      onComplete: () => {
        completeCalled = true;
      }
    });
    const result = await engine.handle(identity, "bruk alle AI-ene på dette spørsmålet");
    expect(councilCalled).toBe(true);
    expect(completeCalled).toBe(false);
    expect(result.reply).toContain("Rådets anbefaling");
    expect(result.reply).toContain("CONSENSUS");
  });

  it("B: Council-frase uten konfigurert `council` -> eksplisitt beskjed, gateway.complete kalles ALDRI (aldri en stille no-op)", async () => {
    const pool = fakePool();
    const messages = new MessageStore(pool);
    const context = new ContextBuilder(pool);
    let completeCalled = false;
    const gateway = {
      complete: async () => {
        completeCalled = true;
        return { text: "x", usage: { input_tokens: 1, output_tokens: 1 }, provider: "scripted", model: "scripted-1" };
      }
    } as unknown as ModelGateway;
    const engine = new ConversationEngine({
      messages,
      context,
      gateway,
      tasks: fakeTasks,
      worker: fakeWorker,
      trace: new MemoryTraceSink()
    });
    const result = await engine.handle(identity, "bruk AI-rådet");
    expect(completeCalled).toBe(false);
    expect(result.reply).toContain("ikke konfigurert");
  });
});

describe("D-106 ConversationEngine: routing overrides folder inn i CompleteInput", () => {
  it("C: 'bruk bare Claude' -> CompleteInput.provider='anthropic'", async () => {
    let captured: CompleteInput | undefined;
    const engine = buildEngine({ onComplete: (input) => (captured = input) });
    await engine.handle(identity, "bruk bare Claude til dette");
    expect(captured?.provider).toBe("anthropic");
  });

  it("D: 'ikke bruk betalte modeller' -> CompleteInput.paid_models_allowed=false", async () => {
    let captured: CompleteInput | undefined;
    const engine = buildEngine({ onComplete: (input) => (captured = input) });
    await engine.handle(identity, "ikke bruk betalte modeller på dette");
    expect(captured?.paid_models_allowed).toBe(false);
  });

  it("E: 'bruk bare lokale modeller' -> CompleteInput.mode='LOCAL'", async () => {
    let captured: CompleteInput | undefined;
    const engine = buildEngine({ onComplete: (input) => (captured = input) });
    await engine.handle(identity, "bruk bare lokale modeller");
    expect(captured?.mode).toBe("LOCAL");
  });

  it("F: eksplisitt API-nivå `provider`-parameter VINNER over en tekst-parset frase", async () => {
    let captured: CompleteInput | undefined;
    const engine = buildEngine({ onComplete: (input) => (captured = input) });
    await engine.handle(identity, "bruk bare Claude til dette", undefined, undefined, "openai");
    expect(captured?.provider).toBe("openai");
  });

  it("G: vanlig tekst uten kjent frase -> ingen override-felt satt (uendret oppførsel, §23)", async () => {
    let captured: CompleteInput | undefined;
    const engine = buildEngine({ onComplete: (input) => (captured = input) });
    await engine.handle(identity, "hva er klokken?");
    expect(captured?.provider).toBeUndefined();
    expect(captured?.mode).toBeUndefined();
    expect(captured?.paid_models_allowed).toBeUndefined();
    expect(captured?.providerPreference).toBeUndefined();
  });

  it("H: 'bruk Gemma' -> CompleteInput.providerPreference=[gemma_local, gemma_hosted]", async () => {
    let captured: CompleteInput | undefined;
    const engine = buildEngine({ onComplete: (input) => (captured = input) });
    await engine.handle(identity, "bruk gemma til dette");
    expect(captured?.providerPreference).toEqual(["gemma_local", "gemma_hosted"]);
  });
});

/**
 * D-106 HOST-FIX (§"LARGE-DECISION TRIGGER"): beviser at ConversationEngine
 * FAKTISK ruter til AiCouncil for automatisk klassifiserte høy-innvirkning-
 * meldinger, UTEN at brukeren må si "bruk AI-rådet" - jf. ordren "The user
 * must NOT need to say 'use AI Council' in these cases."
 */
describe("D-106 HOST-FIX: automatisk høy-innvirkning-klassifisering trigger Council", () => {
  it("I: arkitektur-beslutning trigger Council automatisk, med trigger_source='high_impact_classifier'", async () => {
    let captured: unknown;
    let completeCalled = false;
    const engine = buildEngine({
      onCouncilRun: (input) => (captured = input),
      onComplete: () => (completeCalled = true)
    });
    await engine.handle(identity, "Should we replace Jarvis' canonical memory architecture?");
    expect(completeCalled).toBe(false);
    const input = captured as { trigger?: { trigger_source?: string; matched_signals?: unknown[] } };
    expect(input.trigger?.trigger_source).toBe("high_impact_classifier");
    expect(input.trigger?.matched_signals?.length).toBeGreaterThan(0);
  });

  it("J: stor finansiell beslutning trigger Council automatisk", async () => {
    let councilCalled = false;
    const engine = buildEngine({ onCouncilRun: () => (councilCalled = true) });
    await engine.handle(identity, "Should we spend 800,000 NOK on this business acquisition?");
    expect(councilCalled).toBe(true);
  });

  it("K: produksjon/sikkerhet-beslutning trigger Council automatisk", async () => {
    let councilCalled = false;
    const engine = buildEngine({ onCouncilRun: () => (councilCalled = true) });
    await engine.handle(identity, "Should Jarvis rotate/revoke all production credentials?");
    expect(councilCalled).toBe(true);
  });

  it("L: vanlig samtale trigger ALDRI Council automatisk", async () => {
    let councilCalled = false;
    let completeCalled = false;
    const engine = buildEngine({
      onCouncilRun: () => (councilCalled = true),
      onComplete: () => (completeCalled = true)
    });
    await engine.handle(identity, "Can you brainstorm five taglines for our new product?");
    expect(councilCalled).toBe(false);
    expect(completeCalled).toBe(true);
  });

  it("M: normalt verktøykall-språk trigger ALDRI Council automatisk", async () => {
    let councilCalled = false;
    const engine = buildEngine({ onCouncilRun: () => (councilCalled = true) });
    await engine.handle(identity, "Show me my calendar for tomorrow");
    expect(councilCalled).toBe(false);
  });

  it("N: klasse D-flavored tekst UTEN høy-innvirkning-språk trigger ALDRI Council (risikoklasse != beslutnings-viktighet)", async () => {
    let councilCalled = false;
    const engine = buildEngine({ onCouncilRun: () => (councilCalled = true) });
    await engine.handle(identity, "Restart the jarvis-sentinel-test container");
    expect(councilCalled).toBe(false);
  });

  it("O: eksplisitt bruker-trigger ('bruk AI-rådet') gir trigger_source='explicit_user' (distinkt fra klassifiseringen)", async () => {
    let captured: unknown;
    const engine = buildEngine({ onCouncilRun: (input) => (captured = input) });
    await engine.handle(identity, "bruk AI-rådet på dette");
    const input = captured as { trigger?: { trigger_source?: string } };
    expect(input.trigger?.trigger_source).toBe("explicit_user");
  });

  it("P: FORCED single-provider-override UNDERTRYKKER IKKE stille et policy-mandatert høy-innvirkning-Council-trigger", async () => {
    let councilCalled = false;
    let completeCalled = false;
    const engine = buildEngine({
      onCouncilRun: () => (councilCalled = true),
      onComplete: () => (completeCalled = true)
    });
    // "bruk bare Claude" (provider-override) OG et høy-innvirkning-signal i SAMME melding
    await engine.handle(identity, "bruk bare Claude - should we make this provider a core dependency?");
    expect(councilCalled).toBe(true);
    expect(completeCalled).toBe(false);
  });

  it("Q: eksplisitt 'ikke bruk AI-rådet' UNDERTRYKKER et ellers policy-mandatert høy-innvirkning-trigger, og undertrykkelsen er auditerbar", async () => {
    let councilCalled = false;
    let completeCalled = false;
    const engine = buildEngine({
      onCouncilRun: () => (councilCalled = true),
      onComplete: () => (completeCalled = true)
    });
    const result = await engine.handle(identity, "ikke bruk AI-rådet - should we make this provider a core dependency?");
    expect(councilCalled).toBe(false);
    expect(completeCalled).toBe(true);
    expect(result.routed).toBe("model");
  });

  it("R: tenant_id/session_id videreføres UENDRET til AiCouncil.run() ved automatisk trigger (tenant-isolasjon)", async () => {
    let captured: unknown;
    const engine = buildEngine({ onCouncilRun: (input) => (captured = input) });
    await engine.handle(identity, "Should we migrate production from Postgres to another database?");
    const input = captured as { tenant_id?: string; session_id?: string };
    expect(input.tenant_id).toBe(identity.tenant_id);
    expect(input.session_id).toBe(identity.session_id);
  });

  it("S: paid_models_allowed=false-policy videreføres til Council når den samtidig gjelder (fail-closed/ærlig interaksjon)", async () => {
    let captured: unknown;
    const engine = buildEngine({ onCouncilRun: (input) => (captured = input) });
    await engine.handle(identity, "ikke bruk betalte modeller - should we make this provider a core dependency?");
    const input = captured as { paid_models_allowed?: boolean };
    expect(input.paid_models_allowed).toBe(false);
  });
});
