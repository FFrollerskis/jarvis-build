import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, type MessageStore } from "@jarvis/core";
import { MemoryTraceSink, classifyContentSensitivity, type ModelGateway } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { jobLocalOnlyNote } from "../src/tool-turn-route.ts";

/**
 * D-449 (Q-50, gjennomgang nr. 2, funn H1): hurtigbanen «… i bakgrunnen» hopper over modellen og dermed over alt chatten bruker for å velge rute. Skal jobben få skyruten, må samtalemotoren treffe SAMME
 * avgjørelse som for en verktøytur: eierens eksplisitte ruting, de siste meldingene (D-384-vinduet), minnerommet og innlimt tekst. Her testes motoren (`ConversationEngine`) med en falsk meldingslager og en
 * `delegateBackground` som registrerer hva den får - det er der avgjørelsen tas, og `main.ts` setter bare eier-merket når `cloudAllowed === true`.
 */
const base: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
const STARTED = "Jobben «list åpne PR-er» er startet i bakgrunnen. Jeg gir beskjed her når den er ferdig - du kan fortsette å snakke med meg.";
const PR_ASK = "list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen";

type Row = { role: "user" | "assistant"; content: string };
function build(opts: { prior?: Row[]; throwOnHistory?: boolean; withDelegate?: boolean; runResult?: string | null }) {
  const runs: Array<{ prompt: string; options: { cloudAllowed: boolean } | undefined }> = [];
  const saved: Array<[string, string]> = [];
  let historyLimit: number | undefined;
  const store: Row[] = [...(opts.prior ?? [])];
  const messages = {
    save: async (_id: IdentityContext, role: "user" | "assistant", content: string) => { store.push({ role, content }); saved.push([role, content]); },
    history: async (_id: IdentityContext, limit = 20) => {
      historyLimit = limit;
      if (opts.throwOnHistory) throw new Error("db nede");
      return store.slice(-limit).map((m, i) => ({ message_id: `m${i}`, role: m.role, content: m.content, created_at: new Date().toISOString() }));
    }
  } as unknown as MessageStore;
  const engine = new ConversationEngine({
    messages,
    context: new ContextBuilder({ connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }) } as unknown as pg.Pool),
    gateway: {} as unknown as ModelGateway,
    tasks: {} as unknown as TaskService,
    worker: {} as unknown as InProcessWorker,
    trace: new MemoryTraceSink(),
    ...(opts.withDelegate === false ? {} : {
      delegateBackground: {
        run: async (_id: IdentityContext, prompt: string, options?: { cloudAllowed: boolean }) => {
          runs.push({ prompt, options });
          return opts.runResult === undefined ? STARTED : opts.runResult;
        }
      }
    })
  });
  return { engine, runs, saved, historyLimit: () => historyLimit };
}

let logSpy: ReturnType<typeof vi.spyOn> | undefined;
function captureLocalLog(): () => Array<{ msg: string; reasons: string[] }> {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () =>
    (logSpy as ReturnType<typeof vi.spyOn>).mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])) as { msg: string; reasons: string[] }; } catch { return { msg: "", reasons: [] }; } })
      .filter((l) => l.msg === "d449_fast_delegate_local");
}
afterEach(() => { logSpy?.mockRestore(); logSpy = undefined; });

describe("D-449: hurtigbanens skyvalg følger chattens avgjørelse", () => {
  it("nøytral melding uten sensitiv historikk → cloudAllowed=true, ingen merknad, og historikkvinduet er det samme som chattens (D-384)", async () => {
    const logs = captureLocalLog();
    const t = build({ prior: [{ role: "user", content: "hei" }, { role: "assistant", content: "Hei!" }] });
    const result = await t.engine.handle(base, PR_ASK);
    expect(t.runs).toEqual([{ prompt: PR_ASK, options: { cloudAllowed: true } }]);
    expect(result.reply).toBe(STARTED);
    expect(result.routed).toBe("fast");
    expect(t.historyLimit()).toBe(4);
    expect(logs()).toEqual([]);
  });

  it("de siste meldingene berørte økonomi/helse (selv om denne meldingen er nøytral, «om dette») → lokalt, med merknad og logglinje med kategorier (aldri innhold)", async () => {
    for (const [prior, area] of [
      [{ role: "user" as const, content: "Saldoen min er 45 000 kr og lånet er på 2 mill" }, "økonomi"],
      [{ role: "user" as const, content: "Jeg hadde legetime i dag og fikk en ny diagnose" }, "helse"],
      [{ role: "assistant" as const, content: "Saldoen din er lav akkurat nå." }, "økonomi"]
    ] as const) {
      const logs = captureLocalLog();
      const t = build({ prior: [prior] });
      const result = await t.engine.handle(base, "Finn alle e-postene fra banken om dette og oppsummer dem i bakgrunnen");
      expect(t.runs[0]!.options, prior.content).toEqual({ cloudAllowed: false });
      expect(result.reply, prior.content).toContain(STARTED);
      expect(result.reply, prior.content).toContain("Jobben kjører på den lokale modellen");
      expect(result.reply, prior.content).toContain(area);
      expect(logs()).toHaveLength(1);
      expect(logs()[0]!.reasons).toContain(area === "økonomi" ? "text:finance" : "text:health");
      expect(JSON.stringify(logs())).not.toMatch(/saldo|diagnose|legetime|banken/i);
      logSpy?.mockRestore();
    }
  });

  it("samme vindu som chatten: en sensitiv melding ELDRE enn de siste fire (inkl. denne) låser ikke jobben, men en innenfor gjør det", async () => {
    captureLocalLog();
    const filler: Row[] = [{ role: "assistant", content: "ok" }, { role: "user", content: "takk" }];
    // [finans, ok, takk, <denne>] = fire meldinger → finans er fortsatt innenfor vinduet.
    const inside = build({ prior: [{ role: "user", content: "Saldoen min er lav" }, ...filler] });
    await inside.engine.handle(base, PR_ASK);
    expect(inside.runs[0]!.options).toEqual({ cloudAllowed: false });
    // [finans, ok, takk, ok, <denne>] = fem meldinger → finans er utenfor.
    const outside = build({ prior: [{ role: "user", content: "Saldoen min er lav" }, ...filler, { role: "assistant", content: "greit" }] });
    await outside.engine.handle(base, PR_ASK);
    expect(outside.runs[0]!.options).toEqual({ cloudAllowed: true });
  });

  it("eierens eksplisitte ruting vinner: «kun lokale modeller» og «ikke bruk betalte modeller» (og «bruk bare lokale modeller») → lokalt, med merknad «du ba om lokal behandling»", async () => {
    captureLocalLog();
    for (const ask of [
      "Kun lokale modeller: sjekk e-posten min og oppsummer den i bakgrunnen",
      "Ikke bruk betalte modeller, men list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen",
      "bruk bare lokale modeller og list åpne PR-er i bakgrunnen"
    ]) {
      const t = build({});
      const result = await t.engine.handle(base, ask);
      expect(t.runs, ask).toHaveLength(1);
      expect(t.runs[0]!.options, ask).toEqual({ cloudAllowed: false });
      expect(result.reply, ask).toContain("du ba om lokal behandling");
    }
  });

  it("innlimt tekst (e-posthoder, lange tekster) regnes ikke som eierens egne ord → lokalt", async () => {
    captureLocalLog();
    const pasted = `Fra: noen@example.com\nEmne: Rapport\n\nHei, kan du list åpne PR-er i bakgrunnen?`;
    const t = build({});
    const result = await t.engine.handle(base, pasted);
    expect(t.runs[0]!.options).toEqual({ cloudAllowed: false });
    expect(result.reply).toContain("innlimt tekst regnes ikke som dine egne ord");
  });

  it("helse-minnerom → lokalt; historikk som ikke kan leses → lokalt (fail-closed) med merknad", async () => {
    captureLocalLog();
    const health = build({});
    await health.engine.handle({ ...base, memory_space_id: "health" }, PR_ASK);
    expect(health.runs[0]!.options).toEqual({ cloudAllowed: false });

    const unreadable = build({ throwOnHistory: true });
    const result = await unreadable.engine.handle(base, PR_ASK);
    expect(unreadable.runs[0]!.options).toEqual({ cloudAllowed: false });
    expect(result.reply).toContain("samtalen kunne ikke kontrolleres");
  });

  it("på tale legges ingen merknad til (men jobben går fortsatt lokalt); mislykket start gir den vanlige feilmeldingen uten merknad; uten delegering leses ikke historikken", async () => {
    captureLocalLog();
    const voice = build({ prior: [{ role: "user", content: "Saldoen min er lav" }] });
    const spoken = await voice.engine.handle({ ...base, channel: "voice" }, PR_ASK);
    expect(voice.runs[0]!.options).toEqual({ cloudAllowed: false });
    expect(spoken.reply).toBe(STARTED);

    const failed = build({ prior: [{ role: "user", content: "Saldoen min er lav" }], runResult: null });
    const failure = await failed.engine.handle(base, PR_ASK);
    expect(failure.reply).toContain("Jeg fikk ikke startet bakgrunnsjobben");
    expect(failure.reply).not.toContain("Jobben kjører på den lokale modellen");

    const none = build({ withDelegate: false });
    const noDelegate = await none.engine.handle(base, PR_ASK);
    expect(noDelegate.reply).toContain("Jeg fikk ikke startet bakgrunnsjobben");
    expect(none.historyLimit()).toBeUndefined();
  });

  it("merknaden (som lagres i samtalen) kan aldri selv låse samtalen lokalt: ingen reasons-kombinasjon gir ord klassifiseringen reagerer på", () => {
    const combos = [
      ["text:finance"], ["text:health"], ["text:secret"], ["memory_space:health"], ["memory_sensitivity:special"],
      ["text:finance", "text:health", "text:secret", "memory_space:health", "memory_sensitivity:special"],
      ["owner_routing_override"], ["pasted_content"], ["history_unreadable"],
      ["owner_routing_override", "text:finance"], ["pasted_content", "text:health", "memory_space:health"], []
    ];
    for (const reasons of combos) {
      const note = jobLocalOnlyNote(reasons);
      expect(classifyContentSensitivity({ texts: [note] }).sensitivity, reasons.join(",")).toBe("PUBLIC_OR_LOW_SENSITIVITY");
      expect(note).toContain("Jobben kjører på den lokale modellen");
    }
  });
});
