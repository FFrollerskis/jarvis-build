import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextBuilder, MessageStore } from "@jarvis/core";
import type { IdentityContext } from "@jarvis/contracts";
import { MemoryTraceSink, classifyContentSensitivity, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { selectSurfaceTools, type MeshToolMapping } from "@jarvis/tool-gateway";
import { ConversationEngine } from "../src/conversation.ts";
import { jobLocalOnlyNote } from "../src/tool-turn-route.ts";

/**
 * D-449 (Q-50, gjennomgang nr. 2 og 3): hurtigbanen «… i bakgrunnen» hopper over modellen og dermed over alt chatten bruker for å velge rute. Den første rettelsen kopierte deler av chattens avgjørelse
 * (siste meldinger, ruteoverstyring), og gjennomgang 3 fant at resten manglet (verktøyutvalgets finansnivå D-381, minnemetadata, eksplisitt `provider`). Nå bruker begge SAMME beregning
 * (`ConversationEngine.resolveTurnRouting`). Denne filen låser det med en PARITETSTEST: den samme meldingen sendt som vanlig chat (med produksjonens verktøyutvalg) og som «… i bakgrunnen» må
 * ende på samme side av sky/lokalt - for hver rad i tabellen.
 */
const base: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
const STARTED = "Jobben «list åpne PR-er» er startet i bakgrunnen. Jeg gir beskjed her når den er ferdig - du kan fortsette å snakke med meg.";
const PR_ASK = "list åpne PR-er på tsworkflow/jarvisbuild";
const BG = " i bakgrunnen";
const route = { provider: "anthropic", model: "claude-sonnet-5-5" };

type Row = { role: "user" | "assistant"; content: string };
type Meta = { text: string; spaces: string[]; sensitivities: string[] };

/** Produksjonens utvalgsfunksjon (`selectSurfaceTools`) over et realistisk utsnitt av chat-flatens verktøy, inkl. finansverktøyene som hever turen til SECRET_RESTRICTED (D-381). */
const mapping = (tool_id: string, action: string): MeshToolMapping =>
  ({ def: { name: `${tool_id}__${action}`, description: `${tool_id}.${action}`, input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }, tool_id, action }) as unknown as MeshToolMapping;
const SURFACE: MeshToolMapping[] = [
  mapping("email", "read_inbox"), mapping("calendar", "read_events"), mapping("github", "read_issues"), mapping("executive", "get_capability_status"),
  mapping("memory", "search"), mapping("memory", "propose"), mapping("tasks", "delegate_background_task"), mapping("tasks", "get_task_status"),
  mapping("finance_neonomics", "list_bank_transactions"), mapping("finance_neonomics", "list_balances"), mapping("finance_spend", "list_spend_records"),
  mapping("finance_stripe", "get_balance"), mapping("finance_vipps", "list_captures")
];
const LIMITS = { max_tools_per_round: 8, max_schema_tokens: 4000, max_rounds: 4, max_calls_per_round: 4, max_total_calls: 16 };

interface Built {
  engine: ConversationEngine;
  runs: Array<{ prompt: string; options: { cloudAllowed: boolean } | undefined }>;
  captured: CompleteInput[];
  store: Row[];
}

function build(opts: { prior?: Row[]; meta?: Meta; metaThrows?: boolean; historyThrows?: boolean; withDelegate?: boolean; runResult?: { started: boolean; reply: string } | null }): Built {
  const runs: Built["runs"] = [];
  const captured: CompleteInput[] = [];
  const store: Row[] = [...(opts.prior ?? [])];
  const rows = (limit: number) => store.slice(-limit).map((m, i) => ({ message_id: `m${i}`, role: m.role, content: m.content, created_at: new Date().toISOString() }));
  const messages = {
    save: async (_id: IdentityContext, role: "user" | "assistant", content: string) => { store.push({ role, content }); },
    history: async (_id: IdentityContext, limit = 20) => { if (opts.historyThrows) throw new Error("db nede"); return rows(limit); }
  } as unknown as MessageStore;
  const context = { build: async () => ({ history: rows(20), open_tasks: [] }) } as unknown as ContextBuilder;
  const gateway = {
    complete: async () => ({ text: "svar", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }),
    stream: async () => ({ text: "svar", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }),
    completeWithTools: async (input: CompleteInput) => { captured.push(input); return { text: "svar", usage: { input_tokens: 1, output_tokens: 1 }, provider: "x", model: "m" }; }
  } as unknown as ModelGateway;
  const engine = new ConversationEngine({
    messages, context, gateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    toolTurnRoute: route,
    memory: {
      contextFor: async () => (opts.meta ?? { text: "" }).text,
      contextWithMeta: async () => { if (opts.metaThrows) throw new Error("minne nede"); return opts.meta ?? { text: "", spaces: [], sensitivities: [] }; }
    },
    tools: {
      definitions: SURFACE.map((m) => m.def) as never,
      executorFor: () => ({ execute: async () => { throw new Error("ikke brukt"); } }) as unknown as ToolExecutor,
      select: ({ surface, text, recent_owner_messages }) => {
        const sel = selectSurfaceTools(surface, text, SURFACE, { recent_owner_messages: recent_owner_messages ?? [] });
        return { definitions: sel.selected.map((m) => m.def) as never, limits: LIMITS, ...(sel.min_sensitivity ? { min_sensitivity: sel.min_sensitivity } : {}) };
      }
    },
    ...(opts.withDelegate === false ? {} : {
      delegateBackground: {
        run: async (_id: IdentityContext, prompt: string, options?: { cloudAllowed: boolean }) => {
          runs.push({ prompt, options });
          return opts.runResult === undefined ? { started: true, reply: STARTED } : opts.runResult;
        }
      }
    })
  });
  return { engine, runs, captured, store };
}

let logSpy: ReturnType<typeof vi.spyOn> | undefined;
function captureLogs(): (msg: string) => Array<{ msg: string; reasons?: string[] }> {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return (msg) =>
    (logSpy as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])) as { msg: string; reasons?: string[] }; } catch { return { msg: "" }; } })
      .filter((l) => l.msg === msg);
}
afterEach(() => { logSpy?.mockRestore(); logSpy = undefined; });

const FINANCE_PRIOR: Row = { role: "user", content: "Saldoen min er 45 000 kr og lånet er på 2 mill" };
const HEALTH_PRIOR: Row = { role: "user", content: "Jeg hadde legetime i dag og fikk en ny diagnose" };
const filler = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ role: "assistant" as const, content: `greit ${i}` }));

interface Case {
  name: string;
  message: string;
  prior?: Row[];
  meta?: Meta;
  provider?: string;
  cloud: boolean;
}

/** Hver rad: samme melding som vanlig chat og som «… i bakgrunnen» må ende på samme side - og på den forventede. */
const CASES: Case[] = [
  { name: "nøytral GitHub-forespørsel", message: PR_ASK, cloud: true },
  { name: "nøytral forespørsel etter småprat", message: PR_ASK, prior: [{ role: "user", content: "hei" }, { role: "assistant", content: "Hei!" }], cloud: true },
  { name: "bank/e-post (finansverktøy valgt, D-381) - ingen ord klassifiseringen kjenner", message: "Finn alle e-postene fra banken forrige måned og oppsummer dem", cloud: false },
  { name: "utgifter/abonnement (finansverktøy valgt)", message: "Gå gjennom utgiftene og abonnementene mine i e-posten", cloud: false },
  { name: "kontoutskrift (finansverktøy valgt)", message: "Sjekk kontoutskriften fra DNB i e-posten min", cloud: false },
  { name: "kontoen/banken (finansverktøy valgt)", message: "Hva står på kontoen min ifølge e-postene fra banken", cloud: false },
  { name: "finans nylig i samtalen (D-384-vinduet)", message: PR_ASK, prior: [FINANCE_PRIOR], cloud: false },
  { name: "helse nylig i samtalen", message: PR_ASK, prior: [HEALTH_PRIOR], cloud: false },
  { name: "sensitiv melding eldre enn vinduet låser ikke", message: PR_ASK, prior: [FINANCE_PRIOR, ...filler(4)], cloud: true },
  { name: "finansverktøy arves fra eierens tidligere melding (D-389), eldre enn vinduet", message: "og den neste da?", prior: [{ role: "user", content: "vis bank-transaksjonene mine" }, ...filler(4)], cloud: false },
  { name: "eksplisitt provider (API/tale-enhet)", message: PR_ASK, provider: "gemma_local", cloud: false },
  { name: "«kun lokale modeller» i teksten", message: `Kun lokale modeller: ${PR_ASK}`, cloud: false },
  { name: "«ikke bruk betalte modeller» i teksten", message: `Ikke bruk betalte modeller, men ${PR_ASK}`, cloud: false },
  { name: "minnetreff merket special (direkte treff)", message: PR_ASK, meta: { text: "- [minne] noe", spaces: ["personal"], sensitivities: ["special"] }, cloud: false },
  { name: "minnetreff i helse-rommet", message: PR_ASK, meta: { text: "- [minne] noe", spaces: ["health"], sensitivities: ["normal"] }, cloud: false },
  { name: "vanlig personlig minnetreff", message: PR_ASK, meta: { text: "- [minne] noe", spaces: ["personal"], sensitivities: ["normal"] }, cloud: true }
];

describe("D-449: paritet - hurtigbanen og chatten treffer samme ruteavgjørelse", () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.cloud ? "sky" : "lokalt"} i begge`, async () => {
      captureLogs();
      // Chatten: samme melding uten «i bakgrunnen» (modellturen). Skyruten = providerPreference ["anthropic"].
      const chat = build({ prior: c.prior ?? [], ...(c.meta ? { meta: c.meta } : {}) });
      await chat.engine.handle(base, c.message, undefined, undefined, c.provider);
      expect(chat.captured.length, "chatturen må ha brukt verktøy for at paritet er meningsfull").toBe(1);
      // «Ikke bruk betalte modeller» sender fortsatt skyruten som preferanse, men med `paid_models_allowed: false` - ruteren avviser da Anthropic og turen faller lokalt (D-354).
      const chatCloud = chat.captured[0]!.providerPreference?.[0] === "anthropic" && chat.captured[0]!.paid_models_allowed !== false;
      expect(chatCloud, "chattens avgjørelse").toBe(c.cloud);

      // Hurtigbanen: samme melding + «i bakgrunnen».
      const fast = build({ prior: c.prior ?? [], ...(c.meta ? { meta: c.meta } : {}) });
      await fast.engine.handle(base, `${c.message}${BG}`, undefined, undefined, c.provider);
      expect(fast.runs, "hurtigbanen må ha delegert").toHaveLength(1);
      expect(fast.captured, "hurtigbanen bruker ingen modell").toHaveLength(0);
      expect(fast.runs[0]!.options, "hurtigbanens avgjørelse").toEqual({ cloudAllowed: chatCloud });
    });
  }
});

describe("D-449: hurtigbanens øvrige regler", () => {
  it("lokalt-tvang gir synlig merknad (ikke på tale) med kategorier, og logglinjen d449_fast_delegate_local uten innhold", async () => {
    const logs = captureLogs();
    const t = build({ prior: [FINANCE_PRIOR] });
    const result = await t.engine.handle(base, `${PR_ASK}${BG}`);
    expect(result.reply).toContain(STARTED);
    expect(result.reply).toContain("Jobben kjører på den lokale modellen");
    expect(result.reply).toContain("økonomi");
    const lines = logs("d449_fast_delegate_local");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.reasons).toContain("text:finance");
    expect(JSON.stringify(lines)).not.toMatch(/saldo|lån|jarvisbuild/i);

    const voice = build({ prior: [FINANCE_PRIOR] });
    const spoken = await voice.engine.handle({ ...base, channel: "voice" }, `${PR_ASK}${BG}`);
    expect(voice.runs[0]!.options).toEqual({ cloudAllowed: false });
    expect(spoken.reply).toBe(STARTED);
  });

  it("verktøyutvalgets finansnivå gir kategorien «økonomitjenester» i merknaden (uten ord klassifiseringen kjenner)", async () => {
    captureLogs();
    const t = build({});
    const result = await t.engine.handle(base, `Finn alle e-postene fra banken forrige måned og oppsummer dem${BG}`);
    expect(t.runs[0]!.options).toEqual({ cloudAllowed: false });
    expect(result.reply).toContain("meldingen peker på økonomitjenester");
  });

  it("innlimt tekst (e-posthoder, lange tekster) regnes ikke som eierens egne ord → lokalt, med merknad", async () => {
    captureLogs();
    const t = build({});
    const result = await t.engine.handle(base, `Fra: noen@example.com\nEmne: Rapport\n\nHei, kan du list åpne PR-er${BG}?`);
    expect(t.runs[0]!.options).toEqual({ cloudAllowed: false });
    expect(result.reply).toContain("innlimt tekst regnes ikke som dine egne ord");
  });

  it("ruteavgjørelsen kan ikke beregnes (historikk eller minne feiler) → lokalt (fail-closed) med merknad", async () => {
    captureLogs();
    for (const failing of [{ historyThrows: true }, { metaThrows: true }] as const) {
      const t = build({ ...failing });
      const result = await t.engine.handle(base, `${PR_ASK}${BG}`);
      expect(t.runs[0]!.options, JSON.stringify(failing)).toEqual({ cloudAllowed: false });
      expect(result.reply).toContain("samtalen kunne ikke kontrolleres");
    }
  });

  it("minnet leses uten å oppdatere «sist brukt» (touch: false) - hurtigbanen bruker ikke minnet, den vurderer bare ruten", async () => {
    captureLogs();
    const seen: Array<{ touch?: boolean } | undefined> = [];
    const t = build({});
    // Overstyr minnet med en variant som registrerer valgene.
    const engine = new ConversationEngine({
      ...(t.engine as unknown as { deps: ConstructorParameters<typeof ConversationEngine>[0] }).deps,
      memory: { contextFor: async () => "", contextWithMeta: async (_i, _t, options) => { seen.push(options); return { text: "", spaces: ["personal"], sensitivities: [] }; } }
    });
    await engine.handle(base, `${PR_ASK}${BG}`);
    expect(seen.length).toBeGreaterThan(0);
    for (const options of seen) expect(options?.touch).toBe(false);
  });

  it("jobben ble ikke startet (for mange aktive jobber o.l.) → forklaringen vises uten merknad om lokal modell; uten delegering leses ingenting", async () => {
    captureLogs();
    const full = build({ prior: [FINANCE_PRIOR], runResult: { started: false, reply: "Det kjører allerede 5 bakgrunnsjobber. Vent til en er ferdig." } });
    const r1 = await full.engine.handle(base, `${PR_ASK}${BG}`);
    expect(r1.reply).toBe("Det kjører allerede 5 bakgrunnsjobber. Vent til en er ferdig.");

    const failed = build({ runResult: null });
    expect((await failed.engine.handle(base, `${PR_ASK}${BG}`)).reply).toContain("Jeg fikk ikke startet bakgrunnsjobben");

    const none = build({ withDelegate: false, historyThrows: true });
    expect((await none.engine.handle(base, `${PR_ASK}${BG}`)).reply).toContain("Jeg fikk ikke startet bakgrunnsjobben");
  });

  it("merknaden (som lagres i samtalen) kan aldri selv låse samtalen lokalt: ingen reasons-kombinasjon gir ord klassifiseringen reagerer på", () => {
    const combos = [
      ["text:finance"], ["text:health"], ["text:secret"], ["memory_space:health"], ["memory_sensitivity:special"], ["tool_selection:SECRET_RESTRICTED"],
      ["text:finance", "text:health", "text:secret", "memory_space:health", "memory_sensitivity:special", "tool_selection:SECRET_RESTRICTED"],
      ["owner_routing_override"], ["explicit_provider"], ["pasted_content"], ["routing_unreadable"],
      ["owner_routing_override", "text:finance"], ["pasted_content", "text:health", "memory_space:health"], []
    ];
    for (const reasons of combos) {
      const note = jobLocalOnlyNote(reasons);
      expect(classifyContentSensitivity({ texts: [note] }).sensitivity, reasons.join(",")).toBe("PUBLIC_OR_LOW_SENSITIVITY");
      expect(note).toContain("Jobben kjører på den lokale modellen");
    }
  });
});
