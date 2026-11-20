import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTROL_CENTER_READ_TOOLS, ExecutiveService, ExecutiveTransport, executiveToolDefinitions, type ControlCenterId } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  KnowledgeSearchTransport, MemorySearchTransport, financeToolIntent, firstWaveTools, homeAssistantTools, knowledgeToolDefinitions, memoryToolDefinitions, resolveModelToolSurface, selectSurfaceTools,
  type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";

/**
 * Gjennomgang M1 (H-review): «flagg AV er IKKE identisk med main» - de sovende per-senter-verktøyene ble registrert ubetinget, og 11 av 51 hverdagsfraser fikk et annet verktøyutvalg (det sovende verktøyet ble
 * valgt og `memory.search`-reserven falt bort). BEVISET: denne testen sammenligner `selectSurfaceTools` (begge flater, over den fulle produksjonsflaten: lese-, handlings- og delegeringsnivå) mot en BASELINE
 * generert fra en REN kopi av `origin/main` (`fixtures/wph1-main-selection-baseline.json`). Med alle flagg AV må kandidatflaten, hver frases utvalg (verktøy og rekkefølge, antall droppede og hash av dem,
 * skjematokens, `min_sensitivity`) og `financeToolIntent` være BIT-FOR-BIT lik main.
 *
 * Fixturen er generert slik (kun ved bevisst regenerering mot en ny main): `git archive origin/main` til en egen katalog med samme `node_modules`, og en engangs-test som bygger samme produksjonsflate som
 * `productionSurface` under (uten kontrollsenter-valget) og skriver `{surface_keys, cases[]}`. Frasene (`cases[].text`) er kilden her - legg til nye fraser i fixturen ved regenerering, aldri bare i testen.
 */
interface SelectionOut { selected: string[]; dropped_count: number; dropped_sha256: string; schema_tokens: number; min_sensitivity: string | null }
interface BaselineCase { text: string; recent?: string[]; finance_intent: boolean; web_chat: SelectionOut; voice: SelectionOut }
interface Baseline { baseline: string; baseline_sha: string; surface_keys: string[]; cases: BaselineCase[] }

const baseline = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/wph1-main-selection-baseline.json", import.meta.url)), "utf8")) as Baseline;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const keyOf = (m: { tool_id: string; action: string }): string => `${m.tool_id}.${m.action}`;

/** Samme sammensetning som `wph1-control-tools.test.ts` (produksjonens fabrikker, falske transporter) - med kontrollsenter-verktøyene registrert KUN for `centers` (slik `main.ts` gjør det med flaggene). */
function productionSurface(centers: ReadonlyArray<ControlCenterId>) {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  const defs = firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, {})), { controlCenters: centers }),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
  return resolveModelToolSurface({ list: () => defs } as unknown as ToolGateway, { includeChatReadTier: true, includeChatActTier: true, includeChatDelegateTier: true });
}

function selectionOf(candidates: ReturnType<typeof productionSurface>, surface: "web_chat" | "voice", c: BaselineCase): SelectionOut {
  const sel = selectSurfaceTools(surface, c.text, candidates, c.recent ? { recent_owner_messages: c.recent } : {});
  return { selected: sel.selected.map(keyOf), dropped_count: sel.dropped.length, dropped_sha256: sha(sel.dropped.join("\n")), schema_tokens: sel.schema_tokens, min_sensitivity: sel.min_sensitivity ?? null };
}

const ALL: ReadonlyArray<ControlCenterId> = CONTROL_CENTER_READ_TOOLS.map((t) => t.center);
const off = productionSurface([]);
const on = productionSurface(ALL);

describe("fixturen (generert fra en ren origin/main)", () => {
  it("peker på en eksakt main-commit, dekker begge flater og har minst 51 fraser - inkludert reviewerens eksempler", () => {
    expect(baseline.baseline).toBe("origin/main");
    expect(baseline.baseline_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.cases.length).toBeGreaterThanOrEqual(51);
    const texts = new Set(baseline.cases.map((c) => c.text));
    for (const phrase of ["hva er karantene", "må vi lage en DPIA", "hvilke workere kjører", "hva er en lease", "vis runbooks", "jeg trenger en avstemming av styret", "hva er ukjent utfall"]) {
      expect(texts.has(phrase), phrase).toBe(true);
    }
    for (const c of baseline.cases) {
      expect(c.web_chat, c.text).toBeDefined();
      expect(c.voice, c.text).toBeDefined();
    }
  });

  it("main-flaten har INGEN `get_<senter>_center`-verktøy (de finnes ikke på main) og et stort, ekte verktøysett", () => {
    expect(baseline.surface_keys.length).toBeGreaterThan(300);
    for (const t of CONTROL_CENTER_READ_TOOLS) expect(baseline.surface_keys, t.action).not.toContain(`executive.${t.action}`);
    expect(baseline.surface_keys).toContain("executive.get_control_center");
    expect(baseline.surface_keys).toContain("memory.search");
  });
});

describe("flagg AV er identisk med main", () => {
  it("kandidatflaten (verktøyene modellen kan velge blant) er NØYAKTIG main sin - ingen kontrollsenter-verktøy, ingen andre endringer", () => {
    expect(off.map(keyOf).sort()).toEqual(baseline.surface_keys);
  });

  it("hver frase gir samme utvalg som main - begge flater: verktøy og rekkefølge, antall droppede (og hash), skjematokens og låsen (`min_sensitivity`)", () => {
    const diffs: string[] = [];
    for (const c of baseline.cases) {
      for (const surface of ["web_chat", "voice"] as const) {
        const got = selectionOf(off, surface, c);
        if (JSON.stringify(got) !== JSON.stringify(c[surface])) diffs.push(`${surface}: «${c.text}» ${JSON.stringify(got.selected)} != ${JSON.stringify(c[surface].selected)}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it("`financeToolIntent` (den delegerte jobb-veien) gir samme svar som main for hver frase", () => {
    const diffs = baseline.cases.filter((c) => financeToolIntent(c.text) !== c.finance_intent).map((c) => c.text);
    expect(diffs).toEqual([]);
  });
});

describe("kontrolltest: baseline-sammenligningen er ikke tom", () => {
  it("MED sentrene på endres utvalget for minst 11 av frasene på web-chatten (det reviewer målte) - og flaten får verktøyene", () => {
    const onKeys = on.map(keyOf);
    for (const t of CONTROL_CENTER_READ_TOOLS) expect(onKeys, t.action).toContain(`executive.${t.action}`);
    const changed = baseline.cases.filter((c) => JSON.stringify(selectionOf(on, "web_chat", c)) !== JSON.stringify(c.web_chat));
    expect(changed.length).toBeGreaterThanOrEqual(11);
  });

  it("flaten uten flagg og flaten med flagg skiller seg nøyaktig på kontrollsenter-verktøyene", () => {
    const extra = on.map(keyOf).filter((k) => !off.map(keyOf).includes(k)).sort();
    expect(extra).toEqual(CONTROL_CENTER_READ_TOOLS.map((t) => `executive.${t.action}`).sort());
  });
});
