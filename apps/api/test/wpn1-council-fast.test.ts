import { describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { classifyContentSensitivity, MemoryTraceSink, type AiCouncil, type ModelGateway } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { localOnlyNote } from "../src/tool-turn-route.ts";

/**
 * WP-N1 (fiks-runde 1, F-A3 + F-B3 L1 + F-A6b): målrettede tester for grenene som overlevde hele N1-settet (reviewer A: C08, C09, C11, T03/T04; reviewer B: R27) og for at hurtigbanen låser FØR noe kjøres.
 *  A. rådet med handlingsutvalgets finanslås (D-381): `councilProposals.actionsFor().min_sensitivity` låser og merker turen (C08).
 *  B. hurtigbanens bakgrunnsjobb: ruteavgjørelsen kan ikke leses (`routing_unreadable`, C09/R27), jobben startet ikke men ruten er låst (C11), og LÅS FØR JOBBSTART (F-A6b): en kastet merking etterlater ingen kjørende jobb.
 *  C. hurtigbane-rapportene som kan bære AI-kost i øre låses FØR de kjøres (F-A4/F-A6b).
 *  D. `localOnlyNote` for `history:restricted`: ingen sifre, ingen leverandørnavn, ingen ord klassifisereren reagerer på, og en ærlig varighetstekst (T03/T04, F-A5).
 * Falske lagre/modeller (ingen database): rekkefølgen av lagring, merking og kall er det som måles.
 */
const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
type Row = { id: string; role: string; content: string; restricted: boolean };

function store(prior: Array<{ role: string; content: string; restricted: boolean }> = [], mark: "ok" | "false" | "throw" = "ok") {
  const rows: Row[] = prior.map((r, i) => ({ id: `p${i}`, ...r }));
  const events: string[] = [];
  const messages = {
    save: async (_i: unknown, role: string, content: string, extra?: { restricted?: boolean }) => { const id = `m${rows.length}`; rows.push({ id, role, content, restricted: extra?.restricted === true }); events.push(`save:${role}${extra?.restricted ? ":restricted" : ""}`); return id; },
    markRestricted: async (_i: unknown, id: string) => {
      events.push("mark");
      if (mark === "throw") throw new Error("db nede");
      if (mark === "false") return false;
      const r = rows.find((m) => m.id === id); if (r) r.restricted = true; return r !== undefined;
    },
    history: async () => rows.map((m) => ({ message_id: m.id, role: m.role, content: m.content, created_at: "t", restricted: m.restricted }))
  };
  return { rows, events, messages };
}

const quiet = () => { const a = vi.spyOn(console, "log").mockImplementation(() => undefined); const b = vi.spyOn(console, "error").mockImplementation(() => undefined); return () => { a.mockRestore(); b.mockRestore(); }; };

// --------------------------------------------------------------------------------------------- A. rådet
async function council(opts: { minSensitivity?: "SECRET_RESTRICTED"; actionsThrow?: boolean; text: string; guard: boolean; mark?: "ok" | "false" | "throw" }) {
  const { rows, events, messages } = store([], opts.mark);
  const councilCalls: Array<{ sensitivity?: string }> = [];
  const councilFake = { run: async (input: { sensitivity?: string }) => { events.push("council"); councilCalls.push({ ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}) }); return { council_id: "c", decision: "Vurdering", consensus_status: "CONSENSUS", supporting_models: ["gemma_local"], dissenting_models: [], key_evidence: [], key_disagreements: [], risk_summary: "", confidence: 70, recommended_action: "", provenance: { council_id: "c", full_council: false, requested_members: [], unavailable_members: [], round1: [], round2: [], round3: [], synthesis_provider: "gemma_local" } }; } } as unknown as AiCouncil;
  const engine = new ConversationEngine({
    messages: messages as never, context: { build: async () => ({ history: await messages.history(), open_tasks: [] }) } as never,
    gateway: {} as unknown as ModelGateway, tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(), council: councilFake,
    councilProposals: { actionsFor: () => { if (opts.actionsThrow) throw new Error("utvalg feilet"); return { actions: [], ...(opts.minSensitivity ? { min_sensitivity: opts.minSensitivity } : {}) }; }, submit: async () => ({ ok: false, reason: "x" }) as never },
    ...(opts.guard ? { restrictedContextGuard: true } : {})
  } as never);
  const restore = quiet();
  try { await engine.handle(identity, opts.text); } catch (e) { events.push(`THROW:${(e as Error).message}`); } finally { restore(); }
  return { events, councilCalls, rows: rows.map((m) => [m.role, m.restricted]) };
}
const NEUTRAL_COUNCIL = "bruk AI-rådet på dette: skal vi bytte leverandør";

describe("A: rådet - handlingsutvalgets finanslås (D-381) låser og merker turen (C08)", () => {
  it("min_sensitivity=SECRET_RESTRICTED med nøytral tekst: rådet kjøres SECRET_RESTRICTED, brukermeldingen merkes FØR rådet, vurderingen lagres begrenset", async () => {
    const r = await council({ text: NEUTRAL_COUNCIL, minSensitivity: "SECRET_RESTRICTED", guard: true });
    expect(r.councilCalls[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(r.events).toEqual(["save:user", "mark", "council", "save:assistant:restricted"]);
    expect(r.rows).toEqual([["user", true], ["assistant", true]]);
  });
  it("uten finanslås og med nøytral tekst: ingen merking", async () => {
    const r = await council({ text: NEUTRAL_COUNCIL, guard: true });
    expect(r.events).toEqual(["save:user", "council", "save:assistant"]);
  });
  it("flagg AV: rådet med finanslås merker aldri noe (som main), men sensitiviteten til rådet er uendret", async () => {
    const r = await council({ text: NEUTRAL_COUNCIL, minSensitivity: "SECRET_RESTRICTED", guard: false });
    expect(r.councilCalls[0]!.sensitivity).toBe("SECRET_RESTRICTED");
    expect(r.events).toEqual(["save:user", "council", "save:assistant"]);
  });
  it("fail-closed: kan brukermeldingen ikke merkes (false eller databasefeil), kjøres IKKE rådet og ingen svarrad lagres", async () => {
    for (const mark of ["false", "throw"] as const) {
      const r = await council({ text: NEUTRAL_COUNCIL, minSensitivity: "SECRET_RESTRICTED", guard: true, mark });
      expect(r.councilCalls, mark).toEqual([]);
      expect(r.events, mark).toEqual(["save:user", "mark", `THROW:${mark === "false" ? "restricted_marking_failed" : "db nede"}`]);
    }
  });
  it("feil i handlingsutvalget (actionsFor kaster) gir ingen forslagsvei og ingen lås på nøytral tekst", async () => {
    const r = await council({ text: NEUTRAL_COUNCIL, actionsThrow: true, guard: true });
    expect(r.events).toEqual(["save:user", "council", "save:assistant"]);
  });
});

// --------------------------------------------------------------------------------------------- B. hurtigbanens bakgrunnsjobb
const DELEGATE_TEXT = "list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen";
const MARKED_PRIOR = [{ role: "user", content: "hva ble det av det", restricted: true }, { role: "assistant", content: "Det er 45 000 igjen.", restricted: true }];

async function fast(opts: { guard: boolean; historyThrows?: boolean; started?: boolean; noTools?: boolean; prior?: typeof MARKED_PRIOR; mark?: "ok" | "false" | "throw"; text?: string; extra?: Record<string, unknown> }) {
  const { rows, events, messages } = store(opts.prior ?? [], opts.mark);
  const delegate: Array<Record<string, unknown> | null> = [];
  const priorCount = opts.prior?.length ?? 0;
  const history = async () => { if (opts.historyThrows) throw new Error("db nede"); return messages.history(); };
  const engine = new ConversationEngine({
    messages: { ...messages, history } as never, context: { build: async () => ({ history: await history(), open_tasks: [] }) } as never,
    gateway: {} as unknown as ModelGateway, tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    tools: { definitions: [], executorFor: () => ({ execute: async () => { throw new Error("x"); } }) as never, select: () => ({ definitions: (opts.noTools ? [] : [{ name: "github__list_pull_requests", description: "x", input_schema: { type: "object", properties: {} } }]) as never, limits: { max_tools_per_round: 8, max_schema_tokens: 1500, max_rounds: 6, max_calls_per_round: 4, max_total_calls: 16 } as never, tool_ids: ["github"] }) } as never,
    toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" },
    delegateBackground: { run: async (_i: unknown, _p: string, o?: Record<string, unknown>) => { events.push("delegate"); delegate.push(o ?? null); return opts.started === false ? null : { started: true, reply: "Jobben er startet i bakgrunnen.", cloud: o?.["cloudAllowed"] === true }; } },
    ...(opts.guard ? { restrictedContextGuard: true } : {}), ...(opts.extra ?? {})
  } as never);
  const restore = quiet();
  let thrown: string | undefined;
  try { await engine.handle(identity, opts.text ?? DELEGATE_TEXT); } catch (e) { thrown = (e as Error).message; } finally { restore(); }
  return { events, delegate, rows: rows.slice(priorCount).map((m) => [m.role, m.restricted]), thrown };
}

describe("B: hurtigbane - bakgrunnsjobb: låst rute merkes FØR jobben startes", () => {
  it("C09/R27: ruteavgjørelsen kan ikke leses (historikken kaster) -> jobben får cloudAllowed=false OG restricted, og turen regnes som LÅST (brukermelding + svar begrenset, lås FØR jobbstart)", async () => {
    const r = await fast({ guard: true, historyThrows: true });
    expect(r.delegate).toEqual([{ cloudAllowed: false, restricted: true }]);
    expect(r.events).toEqual(["save:user", "mark", "delegate", "save:assistant:restricted"]);
    expect(r.rows).toEqual([["user", true], ["assistant", true]]);
  });
  it("C09 flagg AV: samme jobbavgjørelse uten `restricted`, ingen merking (alternativene til run() er NØYAKTIG { cloudAllowed })", async () => {
    const r = await fast({ guard: false, historyThrows: true });
    expect(r.delegate).toEqual([{ cloudAllowed: false }]);
    expect(r.events).toEqual(["save:user", "delegate", "save:assistant"]);
  });
  it("C11: låst rute (merkede rader i historikken uten trygg variant) og jobben startet IKKE: svaret merkes likevel", async () => {
    const r = await fast({ guard: true, started: false, noTools: true, prior: MARKED_PRIOR });
    expect(r.delegate).toEqual([{ cloudAllowed: false, restricted: true }]);
    expect(r.events).toEqual(["save:user", "mark", "delegate", "save:assistant:restricted"]);
    expect(r.rows).toEqual([["user", true], ["assistant", true]]);
  });
  it("kontroll: startet jobb i samme låste rute merkes også; uten merker i historikken er ingenting merket og `restricted` utelates helt", async () => {
    const started = await fast({ guard: true, started: true, noTools: true, prior: MARKED_PRIOR });
    expect(started.events).toEqual(["save:user", "mark", "delegate", "save:assistant:restricted"]);
    const clean = await fast({ guard: true, started: false, noTools: true, prior: [] });
    expect(clean.events).toEqual(["save:user", "delegate", "save:assistant"]);
    expect(clean.delegate).toEqual([{ cloudAllowed: true }]);
    expect(Object.keys(clean.delegate[0]!)).not.toContain("restricted");
  });
  it("F-A6b: kan brukermeldingen ikke merkes (false eller databasefeil), startes ALDRI jobben - turen kaster og ingen svarrad lagres", async () => {
    for (const mark of ["false", "throw"] as const) {
      const r = await fast({ guard: true, historyThrows: true, mark });
      expect(r.delegate, mark).toEqual([]);
      expect(r.events, mark).toEqual(["save:user", "mark"]);
      expect(r.thrown, mark).toBe(mark === "false" ? "restricted_marking_failed" : "db nede");
    }
  });
});

describe("C: hurtigbane-rapporter som kan bære AI-kost i øre låses FØR de kjøres (F-A4/F-A6b)", () => {
  const phrases: Array<[string, string, string]> = [
    ["cost_report", "hva koster du", "costReport"], ["value_report", "hva har du hjulpet meg med", "valueReport"], ["slo_report", "hvor bra yter du", "sloReport"],
    ["self_diagnosis", "hva er galt med deg", "selfDiagnosis"], ["system_status", "status", "selfDiagnosis"]
  ];
  for (const [kind, text, dep] of phrases) {
    it(`${kind}: merkingen skjer FØR rapporten leses (en kastet merking leser ingenting), og svaret lagres begrenset`, async () => {
      const calls: string[] = [];
      const extra = { [dep]: { run: async () => { calls.push(dep); return "Rapport uten tall."; } } };
      const ok = await fast({ guard: true, text, extra });
      expect(ok.events, kind).toEqual(["save:user", "mark", "save:assistant:restricted"]);
      expect(calls, kind).toEqual([dep]);
      calls.length = 0;
      const failing = await fast({ guard: true, text, extra, mark: "false" });
      expect(failing.thrown, kind).toBe("restricted_marking_failed");
      expect(calls, kind).toEqual([]); // rapporten ble aldri hentet
      const off = await fast({ guard: false, text, extra });
      expect(off.events, kind).toEqual(["save:user", "save:assistant"]); // flagg AV: som main
    });
  }
});

// --------------------------------------------------------------------------------------------- D. localOnlyNote
describe("D: localOnlyNote for `history:restricted` (T03/T04, F-A5)", () => {
  const note = localOnlyNote(["history:restricted"]);

  it("ingen sifre, ingen leverandør-/modellnavn, ingen ord klassifisereren reagerer på (notatet fjernes uansett fra historikken, men skal heller ikke selv kunne låse noe)", () => {
    expect(/\d/.test(note)).toBe(false);
    expect(note).not.toMatch(/anthropic|openai|claude|gemini|gemma|ollama|gpt|kimi|hermes|neonomics|stripe|vipps|wallester/i);
    expect(classifyContentSensitivity({ texts: [note] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    expect(note.startsWith("\n\n(")).toBe(true);
    expect(note.endsWith(")")).toBe(true);
  });

  it("F-A5: varighetsteksten er ærlig - samtalen holdes lokal så lenge en begrenset melding er blant de siste meldingene (aldri «til emnet er borte», som er usant når kjeden fornyes), og nevner ingen «ny samtale» (en ny økt nullstiller ikke)", () => {
    expect(note).toContain("Samtalen holdes lokal så lenge en begrenset melding er blant de siste meldingene.");
    expect(note).not.toContain("Dette varer til emnet");
    expect(note).not.toMatch(/ny samtale/i);
  });

  it("uten historikk-årsaken er teksten NØYAKTIG som før N1 (flagg AV kan aldri gi den nye årsaken)", () => {
    expect(localOnlyNote(["text:finance"])).toBe(localOnlyNote(["text:finance"]));
    expect(localOnlyNote(["text:finance"])).toContain("Dette varer til emnet ikke lenger er blant de siste meldingene.");
    expect(localOnlyNote(["text:finance"])).not.toContain("begrenset melding");
    const combined = localOnlyNote(["text:finance", "history:restricted"]);
    expect(combined).toContain("de siste meldingene hørte til en tur som ble holdt lokalt");
    expect(combined).toContain("Samtalen holdes lokal så lenge en begrenset melding er blant de siste meldingene.");
  });
});
