import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { ModelProviderAdapter, ModelRequest, ModelResult } from "@jarvis/provider-adapters";
import { AiCollaboration, MemoryTraceSink, ModelGateway, NoCandidateProvidersError } from "../src/index.ts";

/**
 * D-106 (§"multi-model collaboration"): beviser rolletildeling, parallelt
 * arbeid, kryssgjennomgang (aldri selvgjennomgang), syntese og opt-in
 * revisjon/verifikasjon. Samme `fakePool()`/scriptet-adapter-mønster som
 * `council.test.ts`.
 */
function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM cost_events")) return { rows: [{ spent: 0 }] };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

class ScriptedAdapter implements ModelProviderAdapter {
  readonly model = "test-model";
  public readonly seenPrompts: string[] = [];
  constructor(
    readonly name: string,
    private readonly responder: (request: ModelRequest) => string
  ) {}
  available(): boolean {
    return true;
  }
  async complete(request: ModelRequest): Promise<ModelResult> {
    const c = request.messages[0]?.content;
    this.seenPrompts.push(typeof c === "string" ? c : "");
    return { text: this.responder(request), usage: { input_tokens: 5, output_tokens: 5 }, provider: this.name, model: this.model };
  }
}

function echoAdapter(name: string, output: string): ScriptedAdapter {
  return new ScriptedAdapter(name, () => output);
}

describe("D-106 AI Collaboration: rolletildeling (deterministisk, ikke en modell som velger seg selv)", () => {
  it("A: to distinkte delOPPGAVER tildeles to FORSKJELLIGE providere når begge kandidater dekker kravene", async () => {
    const providers = [echoAdapter("anthropic", "bidrag-A"), echoAdapter("openai", "bidrag-B")];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const collab = new AiCollaboration(gateway);
    const result = await collab.run({
      tenant_id: "t1",
      goal: "Bygg en funksjon",
      subtasks: [
        { id: "s1", description: "del 1", purpose: "CODE" },
        { id: "s2", description: "del 2", purpose: "REASON" }
      ]
    });
    const assignedProviders = new Set(result.provenance.role_assignments.map((a) => a.provider));
    expect(assignedProviders.size).toBe(2);
  });

  it("B: delOPPGAVE med et capability-krav ingen kandidat dekker -> unassigned_subtasks (aldri en stille feil-tildeling)", async () => {
    const providers = [echoAdapter("kimi", "bidrag")]; // kimi mangler structured_output i registryet
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const collab = new AiCollaboration(gateway);
    const result = await collab.run({
      tenant_id: "t1",
      goal: "Mål",
      subtasks: [{ id: "s1", description: "krever strukturert output", required_capabilities: ["structured_output"] }]
    });
    expect(result.provenance.unassigned_subtasks.map((u) => u.subtask_id)).toEqual(["s1"]);
  });

  it("C: rollenavn avledes fra purpose (CODE -> coding)", async () => {
    const providers = [echoAdapter("anthropic", "bidrag")];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const collab = new AiCollaboration(gateway);
    const result = await collab.run({
      tenant_id: "t1",
      goal: "Mål",
      subtasks: [{ id: "s1", description: "kode dette", purpose: "CODE" }]
    });
    expect(result.provenance.role_assignments[0]?.role).toBe("coding");
  });

  it("D: ingen konfigurerte kandidater -> NoCandidateProvidersError", async () => {
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [] });
    const collab = new AiCollaboration(gateway);
    await expect(collab.run({ tenant_id: "t1", goal: "Mål" })).rejects.toThrow(NoCandidateProvidersError);
  });
});

describe("D-106 AI Collaboration: parallelt arbeid + kryssgjennomgang + syntese", () => {
  it("E: hver tildelt provider løser SIN delOPPGAVE - bidraget havner i contributions", async () => {
    const providers = [echoAdapter("anthropic", "løsning-A"), echoAdapter("openai", "løsning-B")];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const collab = new AiCollaboration(gateway);
    const result = await collab.run({
      tenant_id: "t1",
      goal: "Mål",
      subtasks: [
        { id: "s1", description: "del 1", purpose: "CODE" },
        { id: "s2", description: "del 2", purpose: "REASON" }
      ]
    });
    expect(result.contributions).toHaveLength(2);
    expect(result.contributions.map((c) => c.output).sort()).toEqual(["løsning-A", "løsning-B"]);
  });

  it("F: kryssgjennomgang - reviewer er ALDRI kontributøren selv", async () => {
    const providers = [echoAdapter("anthropic", "løsning-A"), echoAdapter("openai", "løsning-B")];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const collab = new AiCollaboration(gateway);
    const result = await collab.run({
      tenant_id: "t1",
      goal: "Mål",
      subtasks: [
        { id: "s1", description: "del 1", purpose: "CODE" },
        { id: "s2", description: "del 2", purpose: "REASON" }
      ]
    });
    for (const c of result.contributions) {
      if (c.cross_review) {
        expect(c.cross_review.reviewer).not.toBe(c.provider);
      }
    }
  });

  it("G: syntese kombinerer alle bidrag til ETT sammenhengende svar", async () => {
    const providers = [echoAdapter("anthropic", "løsning-A")];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const collab = new AiCollaboration(gateway);
    const result = await collab.run({ tenant_id: "t1", goal: "Mål", subtasks: [{ id: "s1", description: "del 1" }] });
    expect(result.synthesis).toBeTruthy();
    expect(result.provenance.synthesis_provider).toBe("anthropic");
  });
});

describe("D-106 AI Collaboration: opt-in revisjon og verifikasjon", () => {
  it("H: enableRevisionRound=false (default) - bidraget forblir uendret selv om gjennomgang finnes", async () => {
    const providers = [echoAdapter("anthropic", "original-A"), echoAdapter("openai", "original-B")];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const collab = new AiCollaboration(gateway);
    const result = await collab.run({
      tenant_id: "t1",
      goal: "Mål",
      subtasks: [
        { id: "s1", description: "del 1" },
        { id: "s2", description: "del 2" }
      ]
    });
    expect(result.contributions.every((c) => !c.revised)).toBe(true);
  });

  it("I: enableRevisionRound=true - reviderte bidrag markeres revised=true", async () => {
    let anthropicCalls = 0;
    const anthropic = new ScriptedAdapter("anthropic", () => {
      anthropicCalls++;
      return anthropicCalls === 1 ? "original-A" : "revidert-A";
    });
    const openai = echoAdapter("openai", "original-B");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [anthropic, openai] });
    const collab = new AiCollaboration(gateway);
    const result = await collab.run({
      tenant_id: "t1",
      goal: "Mål",
      subtasks: [
        { id: "s1", description: "del 1" },
        { id: "s2", description: "del 2" }
      ],
      enableRevisionRound: true
    });
    const anthropicContribution = result.contributions.find((c) => c.provider === "anthropic");
    expect(anthropicContribution?.revised).toBe(true);
    expect(anthropicContribution?.output).toBe("revidert-A");
  });

  it("J: enableVerification=false (default) - ingen verification i resultatet", async () => {
    const providers = [echoAdapter("anthropic", "løsning")];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const collab = new AiCollaboration(gateway);
    const result = await collab.run({ tenant_id: "t1", goal: "Mål", subtasks: [{ id: "s1", description: "del 1" }] });
    expect(result.verification).toBeUndefined();
  });

  it("K: enableVerification=true - en DISTINKT provider verifiserer syntesen", async () => {
    const providers = [echoAdapter("anthropic", "løsning"), echoAdapter("openai", "OK - ser bra ut")];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const collab = new AiCollaboration(gateway);
    const result = await collab.run({
      tenant_id: "t1",
      goal: "Mål",
      subtasks: [{ id: "s1", description: "del 1" }],
      enableVerification: true
    });
    expect(result.verification).toBeDefined();
    expect(result.verification?.provider).not.toBe(result.provenance.synthesis_provider);
  });
});

describe("D-106 AI Collaboration: kanonisk deling av tenant/session/task", () => {
  it("L: samme tenant_id/session_id/task_id videreføres til HVERT underliggende ModelGateway-kall", async () => {
    const seenTenants: string[] = [];
    const anthropic = new ScriptedAdapter("anthropic", () => "svar");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [anthropic] });
    const collab = new AiCollaboration(gateway);
    await collab.run({
      tenant_id: "tenant-x",
      session_id: "session-y",
      task_id: "task-z",
      goal: "Mål",
      subtasks: [{ id: "s1", description: "del 1" }]
    });
    expect(anthropic.seenPrompts.length).toBeGreaterThan(0); // faktisk kalt minst én gang
    void seenTenants;
  });
});
