import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { MemoryTraceSink, type ModelGateway } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine, type ConversationDeps } from "../src/conversation.ts";

/**
 * D-283 (Tobias direkte i chat, "ja bygg minne-skrivingen", ETTER at D-282
 * sin live-samtale avdekket at `MemoryWriter`/`RuleBasedExtractor` var
 * bygget og enhetstestet, men ALDRI kalt fra noe produksjonssted - minnet
 * var en HELT PASSIV lesestruktur for ALLE tenants, se D-283 i
 * DECISIONS_AND_ASSUMPTIONS.md). Beviser `ConversationEngine.handle()` sin
 * NYE, valgfrie `deps.memory.ingest()`-kallested: (1) kalles med eierens
 * RÅ ord for HVER rute (rask/vanlig modell), (2) fire-and-forget - en
 * feilende/treg minneskriving kaster ALDRI og ødelegger ALDRI selve
 * samtalesvaret, (3) fullstendig bakoverkompatibelt når `ingest` er
 * udefinert (uendret oppførsel fra FØR D-283, samme mønster resten av
 * filens øvrige valgfrie felt - `personality`/`tools`/`council` - allerede
 * bruker).
 */
const fakeTasks = {} as unknown as TaskService;
const fakeWorker = {} as unknown as InProcessWorker;

function fakePool(): pg.Pool {
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
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

function buildEngine(memory: ConversationDeps["memory"]): ConversationEngine {
  const pool = fakePool();
  const gateway = {
    complete: async () => ({
      text: "modellsvar",
      usage: { input_tokens: 1, output_tokens: 1 },
      provider: "scripted",
      model: "scripted-1"
    }),
    stream: async () => {
      throw new Error("stream skal ikke kalles i disse testene (ingen onToken gitt)");
    },
    completeWithTools: async () => {
      throw new Error("completeWithTools skal ikke kalles i disse testene (ingen tools konfigurert)");
    }
  } as unknown as ModelGateway;
  return new ConversationEngine({
    messages: new MessageStore(pool),
    context: new ContextBuilder(pool),
    gateway,
    tasks: fakeTasks,
    worker: fakeWorker,
    trace: new MemoryTraceSink(),
    // `exactOptionalPropertyTypes`: `memory` utelates HELT (ikke satt til
    // `undefined`) for test F, som beviser nøyaktig det scenarioet - feltet
    // faktisk fraværende, samme som FØR D-283 la til `memory` i det hele tatt.
    ...(memory !== undefined ? { memory } : {})
  });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("D-283: ConversationEngine.handle() skriver eierens ord til minnet via deps.memory.ingest()", () => {
  it("A: kalles med (identity, RÅ tekst) på normal modell-bane, FØR gateway.complete() returnerer", async () => {
    const calls: Array<{ identity: IdentityContext; text: string }> = [];
    const engine = buildEngine({
      contextFor: async () => "",
      ingest: async (id, text) => {
        calls.push({ identity: id, text });
      }
    });
    const result = await engine.handle(identity, "Jeg heter Tobias og har to barn.");
    expect(result.reply).toBe("modellsvar");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("Jeg heter Tobias og har to barn.");
    expect(calls[0]?.identity).toBe(identity);
  });

  it("B (D-386, erstatter D-283 B): rask-bane-kommandoer (fastRoute) utløser IKKE uttrekk - en kommando er aldri et faktum om eieren (JARVIS-067)", async () => {
    const calls: string[] = [];
    const engine = buildEngine({
      contextFor: async () => "",
      ingest: async (_id, text) => {
        calls.push(text);
      }
    });
    await engine.handle(identity, "status");
    await flushMicrotasks();
    expect(calls).toEqual([]);
    await engine.handle(identity, "Pappa heter Henrik og bor i Bergen.");
    await flushMicrotasks();
    expect(calls).toEqual(["Pappa heter Henrik og bor i Bergen."]);
  });

  it("C: fire-and-forget - en AVVIST ingest()-promise kaster ALDRI og ødelegger ALDRI selve samtalesvaret", async () => {
    const engine = buildEngine({
      contextFor: async () => "",
      ingest: async () => {
        throw new Error("simulert minne-skrivefeil");
      }
    });
    const result = await engine.handle(identity, "Dette skal fortsatt fungere.");
    expect(result.reply).toBe("modellsvar");
  });

  it("D: en avvist ingest()-promise logges strukturert (aldri stille svelget uten spor)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const engine = buildEngine({
      contextFor: async () => "",
      ingest: async () => {
        throw new Error("simulert minne-skrivefeil");
      }
    });
    await engine.handle(identity, "Dette skal logges ved feil.");
    await flushMicrotasks();
    const diagnostics = spy.mock.calls
      .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
      .filter((m) => m["msg"] === "conversation_memory_ingest_failed");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.["error"]).toBe("simulert minne-skrivefeil");
    spy.mockRestore();
  });

  it("E: udefinert deps.memory.ingest -> UENDRET oppforsel (bakoverkompatibelt, ingen krasj, ingen kall)", async () => {
    const engine = buildEngine({ contextFor: async () => "" });
    const result = await engine.handle(identity, "Ingen skrivevei konfigurert her.");
    expect(result.reply).toBe("modellsvar");
  });

  it("F: udefinert deps.memory (hele feltet) -> UENDRET oppforsel, samme som FØR D-283", async () => {
    const engine = buildEngine(undefined);
    const result = await engine.handle(identity, "Fortsatt ingen minnekobling i det hele tatt.");
    expect(result.reply).toBe("modellsvar");
  });
});
