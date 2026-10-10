import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { ModelProviderAdapter, ModelRequest, ModelResult } from "@jarvis/provider-adapters";
import { CARD_PREVIEW_MAX_CHARS } from "@jarvis/core";
import {
  AiCouncil, MAX_PROPOSABLE_ACTIONS, MAX_PROPOSAL_ARGUMENT_CHARS, MemoryTraceSink, ModelGateway, PROPOSAL_ELIGIBLE_CONSENSUS, buildCouncilProposal, cleanDisplayText, describeProposalRejectionNo, parseProposedAction,
  renderProposalNoteNo, renderProposalPrompt, reviewCouncilProposal,
  type CouncilResult, type ProposableAction
} from "../src/index.ts";

/**
 * WP-D4 (JARVIS-078): `CouncilProposal` - en handling AI-rådet foreslår (ikke bare en tekst). Beviser (1) den strenge lesingen av `proposed_action` (kun en lukket liste, ingen selvrapportert klasse, ren JSON innenfor
 * grenser, ingen hemmeligheter), (2) at Jarvis - ikke modellen - eier klassen, konsensus og medlemslistene, (3) at rådet ALDRI får verktøy (§30) og at uten `proposable_actions` er alt uendret.
 */
const CATALOG: ProposableAction[] = [
  {
    name: "todoist__create_task",
    description: "Opprett en oppgave i Todoist.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
    risk: "B",
    effect: "write"
  },
  {
    name: "slack__notify",
    description: "Send en melding i Slack.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    risk: "C",
    effect: "send"
  }
];
const GOOD = { tool: "todoist__create_task", arguments: { content: "Ring leverandøren" }, expected_effect: "Oppretter en Todoist-oppgave «Ring leverandøren»." };
const FIXED_NOW = () => new Date("2026-10-09T12:00:00.000Z");
const FIXED_ID = () => "11111111-1111-4111-8111-111111111111";
// Bygges her (ikke som litteral) så hemmelighetsskanneren i repoet ikke slår på testdata.
const FAKE_GH = `ghp_${"A1b2C3d4".repeat(5)}`;
const FAKE_ANTHROPIC = `sk-ant-${"x9Y8z7".repeat(6)}`;

describe("parseProposedAction - streng, lukket liste", () => {
  it("gyldig utkast: verktøyet er på listen, argumentene kopieres (ikke samme objekt), effekten renses", () => {
    const args = { content: "Ring leverandøren", nested: { a: [1, 2, { b: true }] } };
    const parsed = parseProposedAction({ ...GOOD, arguments: args }, CATALOG);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.tool).toBe("todoist__create_task");
    expect(parsed.draft.arguments).toEqual(args);
    expect(parsed.draft.arguments).not.toBe(args);
    expect((parsed.draft.arguments["nested"] as { a: unknown[] }).a).not.toBe(args.nested.a);
  });

  it("utelatte argumenter blir {} (skjemaet avgjør senere om det er gyldig)", () => {
    const parsed = parseProposedAction({ tool: "slack__notify", expected_effect: "Varsler." }, CATALOG);
    expect(parsed).toEqual({ ok: true, draft: { tool: "slack__notify", arguments: {}, expected_effect: "Varsler." } });
  });

  it("verktøy utenfor den lukkede listen forkastes - også nesten-treff (store/små bokstaver, mellomrom, prefiks, tool_id.action-form)", () => {
    for (const tool of ["email__send", "github__merge_pr", "TODOIST__CREATE_TASK", " todoist__create_task", "todoist__create_task ", "todoist__create", "todoist.create_task", "owner_controls__activate_kill_switch"]) {
      expect(parseProposedAction({ ...GOOD, tool }, CATALOG), tool).toEqual({ ok: false, reason: "tool_not_proposable" });
    }
  });

  it("modellen kan ikke selvrapportere klasse, effekt, bekreftelsesfrie eller utførelse: ukjente nøkler forkastes (ikke ignoreres)", () => {
    for (const extra of [{ risk: "A" }, { capability_class: "A" }, { effect: "read" }, { requires_owner_confirmation: false }, { executes: true }, { execute: true }, { auto_approve: true }, { confirmation_id: "conf-1" }, { tool_id: "email" }]) {
      expect(parseProposedAction({ ...GOOD, ...extra }, CATALOG), JSON.stringify(extra)).toEqual({ ok: false, reason: "unknown_keys" });
    }
  });

  it("tool mangler eller er ikke en streng", () => {
    for (const tool of [undefined, null, "", 7, ["todoist__create_task"], { name: "x" }]) {
      expect(parseProposedAction({ ...GOOD, tool }, CATALOG), String(tool)).toEqual({ ok: false, reason: "tool_missing" });
    }
  });

  it("selve utkastet må være et objekt", () => {
    for (const raw of ["todoist__create_task", 5, true, ["todoist__create_task"], [GOOD]]) {
      expect(parseProposedAction(raw, CATALOG), JSON.stringify(raw)).toEqual({ ok: false, reason: "not_an_object" });
    }
  });

  it("argumenter må være et objekt", () => {
    for (const args of [["a"], "content", 3, true, null]) {
      expect(parseProposedAction({ ...GOOD, arguments: args }, CATALOG), JSON.stringify(args)).toEqual({ ok: false, reason: "arguments_not_object" });
    }
  });

  it("farlige nøkler (prototype-forurensning) forkastes - også nestet og inne i lister, slik de faktisk ser ut etter JSON.parse", () => {
    const polluted = [
      JSON.parse('{"__proto__": {"admin": true}, "content": "x"}'),
      JSON.parse('{"content": "x", "meta": {"constructor": {"prototype": {"x": 1}}}}'),
      JSON.parse('{"content": "x", "list": [{"prototype": 1}]}'),
      JSON.parse('{"content": "x", "a": {"b": {"__proto__": null}}}')
    ];
    for (const args of polluted) expect(parseProposedAction({ ...GOOD, arguments: args }, CATALOG), JSON.stringify(args)).toEqual({ ok: false, reason: "arguments_forbidden_key" });
    // Beviser at ingenting lekket til Object.prototype under lesingen.
    expect(({} as Record<string, unknown>)["admin"]).toBeUndefined();
  });

  it("grenser: dybde, antall noder, strenglengde og samlet størrelse", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 8; i += 1) deep = { a: deep };
    const wide = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`k${i}`, i]));
    const longString = { content: "x".repeat(2001) };
    // 10 × 1000 tegn = 10 000 > samlet grense, men hver streng er under strenggrensen og antall noder er lavt.
    const big = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "y".repeat(1000)]));
    for (const args of [deep, wide, longString, big]) {
      expect(parseProposedAction({ ...GOOD, arguments: args }, CATALOG), JSON.stringify(args).slice(0, 40)).toEqual({ ok: false, reason: "arguments_too_large" });
    }
    expect(parseProposedAction({ ...GOOD, arguments: { content: "x".repeat(900) } }, CATALOG).ok).toBe(true);
  });

  it("M4: argumentene må kunne vises HELE i bekreftelseskortet - nøyaktig kortets grense passerer, ett tegn mer forkastes (aldri en avkortet visning av det eieren godkjenner)", () => {
    expect(MAX_PROPOSAL_ARGUMENT_CHARS).toBe(CARD_PREVIEW_MAX_CHARS); // samme tall som kortet bruker, ikke en kopi
    expect(MAX_PROPOSAL_ARGUMENT_CHARS).toBe(1000);
    const overhead = JSON.stringify({ content: "" }).length;
    const fits = { content: "x".repeat(MAX_PROPOSAL_ARGUMENT_CHARS - overhead) };
    expect(JSON.stringify(fits)).toHaveLength(MAX_PROPOSAL_ARGUMENT_CHARS);
    expect(parseProposedAction({ ...GOOD, arguments: fits }, CATALOG).ok).toBe(true);
    const tooLong = { content: "x".repeat(MAX_PROPOSAL_ARGUMENT_CHARS - overhead + 1) };
    expect(parseProposedAction({ ...GOOD, arguments: tooLong }, CATALOG)).toEqual({ ok: false, reason: "arguments_too_large" });
    // reviewerens tilfelle: 8000 tegn i argumentene mot en forhåndsvisning på 1000
    expect(parseProposedAction({ ...GOOD, arguments: { content: "x".repeat(7900) } }, CATALOG)).toEqual({ ok: false, reason: "arguments_too_large" });
    // flere felt som til sammen overskrider grensen, hvert for seg lite
    const spread = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`felt${i}`, "z".repeat(90)]));
    expect(parseProposedAction({ ...GOOD, arguments: spread }, CATALOG)).toEqual({ ok: false, reason: "arguments_too_large" });
  });

  it("ikke-JSON-verdier forkastes: NaN/Infinity, funksjon, undefined, symbol, bigint, Date/Map/klasseinstans", () => {
    class Sneaky { content = "x"; }
    for (const value of [NaN, Infinity, -Infinity, () => 1, undefined, Symbol("s"), BigInt(1), new Date(), new Map(), new Sneaky()]) {
      expect(parseProposedAction({ ...GOOD, arguments: { content: value } }, CATALOG), String(typeof value)).toEqual({ ok: false, reason: "arguments_invalid" });
    }
    expect(parseProposedAction({ ...GOOD, arguments: new Sneaky() }, CATALOG)).toEqual({ ok: false, reason: "arguments_invalid" });
  });

  it("en hemmelighet i argumentene forkaster hele forslaget (redigering ville endret meningen) - verdi og nøkkel", () => {
    expect(parseProposedAction({ ...GOOD, arguments: { content: `bruk ${FAKE_GH}` } }, CATALOG)).toEqual({ ok: false, reason: "arguments_contain_secret" });
    expect(parseProposedAction({ ...GOOD, arguments: { content: "x", note: `nøkkel ${FAKE_ANTHROPIC}` } }, CATALOG)).toEqual({ ok: false, reason: "arguments_contain_secret" });
    expect(parseProposedAction({ ...GOOD, arguments: { [FAKE_GH]: "x" } }, CATALOG)).toEqual({ ok: false, reason: "arguments_contain_secret" });
    expect(parseProposedAction({ ...GOOD, arguments: { content: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" } }, CATALOG)).toEqual({ ok: false, reason: "arguments_contain_secret" });
  });

  it("forventet effekt: påkrevd, renset for kontrolltegn, hemmeligheter redigert og kappet til 300 tegn", () => {
    for (const effect of [undefined, null, "", "   ", 5, ["x"], { a: 1 }]) {
      expect(parseProposedAction({ ...GOOD, expected_effect: effect }, CATALOG), String(effect)).toEqual({ ok: false, reason: "expected_effect_missing" });
    }
    const dirty = parseProposedAction({ ...GOOD, expected_effect: `Oppretter\u0000 en\u0007 oppgave\n\n med ${FAKE_GH} i` }, CATALOG);
    expect(dirty.ok).toBe(true);
    if (dirty.ok) {
      // eslint-disable-next-line no-control-regex -- sjekker at kontrolltegn er strippet
      expect(dirty.draft.expected_effect).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
      expect(dirty.draft.expected_effect).not.toContain("ghp_");
      expect(dirty.draft.expected_effect).toContain("REDACTED"); // M4: ren tekst - redigeringsmerket har ingen klammer
      expect(dirty.draft.expected_effect).not.toContain("\n");
    }
    const long = parseProposedAction({ ...GOOD, expected_effect: "å".repeat(900) }, CATALOG);
    expect(long.ok && long.draft.expected_effect.length).toBe(300);
  });

  it("tom liste tillater ingenting", () => {
    expect(parseProposedAction(GOOD, [])).toEqual({ ok: false, reason: "tool_not_proposable" });
  });
});

describe("buildCouncilProposal - Jarvis eier klassen, konsensus og medlemslistene", () => {
  const base = { council_id: "council-1", draft: { tool: "slack__notify", arguments: { text: "hei" }, expected_effect: "Varsler i Slack." }, actions: CATALOG, supporting_models: ["anthropic", "openai"], dissenting_models: ["kimi"], confidence: 71, risk_summary: "moderat", now: FIXED_NOW, newId: FIXED_ID };

  it("sikkerhetsklasse og effekt kommer fra den lukkede listen (manifestet) - aldri fra utkastet", () => {
    const built = buildCouncilProposal({ ...base, consensus_status: "MAJORITY" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.safety).toEqual({ risk: "C", effect: "send", source: "tool_manifest" });
    const other = buildCouncilProposal({ ...base, draft: { ...base.draft, tool: "todoist__create_task" }, consensus_status: "MAJORITY" });
    expect(other.ok && other.proposal.safety).toEqual({ risk: "B", effect: "write", source: "tool_manifest" });
  });

  it("invarianter i selve modellen: krever eierens bekreftelse, utfører aldri, deterministisk id/tid", () => {
    const built = buildCouncilProposal({ ...base, consensus_status: "CONSENSUS" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const p = built.proposal;
    expect(p).toMatchObject({
      schema: "jarvis.council-proposal/1",
      proposal_id: "cprop-11111111-1111-4111-8111-111111111111",
      council_id: "council-1",
      created_at: "2026-10-09T12:00:00.000Z",
      consensus_status: "CONSENSUS",
      supporting_models: ["anthropic", "openai"],
      dissenting_models: ["kimi"],
      confidence: 71,
      requires_owner_confirmation: true,
      executes: false
    });
    expect(p.action).toEqual({ tool: "slack__notify", arguments: { text: "hei" } });
  });

  it("kun CONSENSUS og MAJORITY gir et forslag; SPLIT og DEGRADED_NO_CONSENSUS gir consensus_too_weak", () => {
    expect([...PROPOSAL_ELIGIBLE_CONSENSUS].sort()).toEqual(["CONSENSUS", "MAJORITY"]);
    for (const status of ["SPLIT", "DEGRADED_NO_CONSENSUS"] as const) expect(buildCouncilProposal({ ...base, consensus_status: status }), status).toEqual({ ok: false, reason: "consensus_too_weak" });
    for (const status of ["CONSENSUS", "MAJORITY"] as const) expect(buildCouncilProposal({ ...base, consensus_status: status }).ok, status).toBe(true);
  });

  it("et verktøy som ikke er på listen kan ikke bygges selv om utkastet skulle ha sluppet gjennom", () => {
    expect(buildCouncilProposal({ ...base, draft: { ...base.draft, tool: "email__send" }, consensus_status: "MAJORITY" })).toEqual({ ok: false, reason: "tool_not_proposable" });
  });

  it("tillit klemmes til 0-100 (NaN/uendelig blir 0 eller kantverdi); medlemsnavn og risikotekst renses", () => {
    const at = (confidence: number) => {
      const b = buildCouncilProposal({ ...base, confidence, consensus_status: "MAJORITY" });
      return b.ok ? b.proposal.confidence : -1;
    };
    expect([at(NaN), at(-5), at(250), at(Infinity), at(42)]).toEqual([0, 0, 100, 0, 42]);
    // Medlemsnavn er identifikatorer: alt annet droppes (ikke «renses» til noe som ligner et navn) - også navn som ser ut som en kort hemmelighet.
    const dirty = buildCouncilProposal({ ...base, consensus_status: "MAJORITY", supporting_models: ["any\u0000thropic", 7 as unknown as string, "", "gemma_local", "a b", "x".repeat(41), "ghp_A1b2C3d4A1b2C3d4A1b2C3d4"], dissenting_models: [FAKE_GH, `a${FAKE_GH}`], risk_summary: `risiko ${FAKE_ANTHROPIC} ${"r".repeat(900)}` });
    expect(dirty.ok).toBe(true);
    if (!dirty.ok) return;
    expect(dirty.proposal.supporting_models).toEqual(["gemma_local"]);
    expect(dirty.proposal.dissenting_models).toEqual([]);
    expect(JSON.stringify(dirty.proposal)).not.toContain("ghp_");
    expect(JSON.stringify(dirty.proposal)).not.toContain("sk-ant-");
    expect(dirty.proposal.risk_summary.length).toBeLessThanOrEqual(600);
  });
});

describe("reviewCouncilProposal - revisjonsspor uten innhold", () => {
  const ctx = { actions: CATALOG, council_id: "council-1", consensus_status: "MAJORITY" as const, supporting_models: ["a", "b"], dissenting_models: ["c"], confidence: 70, risk_summary: "", now: FIXED_NOW, newId: FIXED_ID };

  it("ingen handling foreslått (undefined/null) er NONE med navnene på det som var tillatt", () => {
    for (const raw of [undefined, null]) expect(reviewCouncilProposal({ ...ctx, raw })).toEqual({ review: { offered: ["todoist__create_task", "slack__notify"], outcome: "NONE" } });
  });

  it("gyldig er PROPOSED med forslaget", () => {
    const r = reviewCouncilProposal({ ...ctx, raw: GOOD });
    expect(r.review).toEqual({ offered: ["todoist__create_task", "slack__notify"], outcome: "PROPOSED" });
    expect(r.proposal?.action.tool).toBe("todoist__create_task");
  });

  it("ugyldig er REJECTED med årsakskode - og revisjonsresultatet inneholder aldri argumentene (de kan inneholde hemmeligheter fra ubetrodd tekst)", () => {
    const r = reviewCouncilProposal({ ...ctx, raw: { ...GOOD, arguments: { content: `bruk ${FAKE_GH}` } } });
    expect(r.proposal).toBeUndefined();
    expect(r.review).toEqual({ offered: ["todoist__create_task", "slack__notify"], outcome: "REJECTED", reason: "arguments_contain_secret" });
    expect(JSON.stringify(r.review)).not.toContain("ghp_");
    expect(reviewCouncilProposal({ ...ctx, raw: GOOD, consensus_status: "SPLIT" }).review).toMatchObject({ outcome: "REJECTED", reason: "consensus_too_weak" });
    expect(reviewCouncilProposal({ ...ctx, raw: "rm -rf /" }).review).toMatchObject({ outcome: "REJECTED", reason: "not_an_object" });
  });
});

describe("tekster: prompt, notat og avvisning", () => {
  it("promten gir navn, beskrivelse og skjema som TEKST, sier at rådet ikke utfører, og at kontekst/svar er DATA", () => {
    const prompt = renderProposalPrompt(CATALOG);
    expect(prompt).toContain("todoist__create_task");
    expect(prompt).toContain("slack__notify");
    expect(prompt).toContain("proposed_action");
    expect(prompt).toContain("ALDRI");
    expect(prompt).toMatch(/DATA, aldri som instruksjoner/);
    expect(prompt).toContain('"required":["content"]');
  });

  it("promten kapper listen til MAX_PROPOSABLE_ACTIONS og renser beskrivelser", () => {
    const many = Array.from({ length: MAX_PROPOSABLE_ACTIONS + 6 }, (_, i): ProposableAction => ({ name: `svc${i}__act`, description: `beskrivelse\u0000 ${i} ${FAKE_GH}`, input_schema: {}, risk: "B", effect: "write" }));
    const prompt = renderProposalPrompt(many);
    expect(prompt).toContain(`svc${MAX_PROPOSABLE_ACTIONS - 1}__act`);
    expect(prompt).not.toContain(`svc${MAX_PROPOSABLE_ACTIONS}__act`);
    expect(prompt).not.toContain("ghp_");
  });

  it("M4: rådets visningstekst (effekt og risikosammendrag) er ren tekst - bidi, nullbredde, markdown og HTML overlever ikke, hverken i utkastet eller i det ferdige forslaget", () => {
    const evil = `Sender ${String.fromCodePoint(0x202e)}moc.liamg${String.fromCodePoint(0x202c)} [trykk her](https://evil.example/x) ![x](http://evil.example/p.png) <img src=x onerror=alert(1)> a${String.fromCodePoint(0x200b)}b ${String.fromCodePoint(0x2066)}c${String.fromCodePoint(0x2069)}`;
    const parsed = parseProposedAction({ ...GOOD, expected_effect: evil }, CATALOG);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const reviewed = reviewCouncilProposal({ raw: { ...GOOD, expected_effect: evil }, actions: CATALOG, council_id: "c", consensus_status: "MAJORITY", supporting_models: ["anthropic"], dissenting_models: [], confidence: 80, risk_summary: evil });
    expect(reviewed.review.outcome).toBe("PROPOSED");
    for (const text of [parsed.draft.expected_effect, reviewed.proposal?.expected_effect ?? "", reviewed.proposal?.risk_summary ?? ""]) {
      expect(text).not.toMatch(/[[\]()<>`*_#!|\\]/);
      expect(text).not.toMatch(/[\p{C}\p{Zl}\p{Zp}]/u);
      expect(text).not.toMatch(/https?:\/\//i);
      expect(text).toContain("Sender");
    }
    expect(cleanDisplayText(evil, 300)).toBe(parsed.draft.expected_effect);
  });

  it("M4: prompten sier at argumentene må være korte og effekten ren tekst", () => {
    const prompt = renderProposalPrompt(CATALOG);
    expect(prompt).toContain(`under ${MAX_PROPOSAL_ARGUMENT_CHARS} tegn`);
    expect(prompt).toMatch(/ren tekst uten lenker, markdown eller HTML/);
  });

  it("M4: notatet viser FØRST det handlingen faktisk gjør (fast linje fra parameterne), og merker rådets egen beskrivelse som modellskrevet", () => {
    const built = buildCouncilProposal({ council_id: "c", draft: { tool: "slack__notify", arguments: { text: "x" }, expected_effect: "Varsler i Slack." }, actions: CATALOG, consensus_status: "MAJORITY", supporting_models: ["anthropic"], dissenting_models: [], confidence: 80, risk_summary: "" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const bound = "Handlingen gjør dette (hentet fra selve kallet, ikke fra rådet): Mottaker (channel): #ops.";
    const note = renderProposalNoteNo(built.proposal, 15, bound);
    expect(note.indexOf(bound)).toBeGreaterThan(-1);
    expect(note.indexOf(bound)).toBeLessThan(note.indexOf("Varsler i Slack."));
    expect(note).toContain("Rådets beskrivelse av effekten (skrevet av en modell, ikke en garanti): Varsler i Slack.");
    expect(note.startsWith("Forslag fra rådet (IKKE utført).\n")).toBe(true);
    // uten fast linje (eldre kaller): ingen tom linje, men beskrivelsen er fortsatt merket
    const without = renderProposalNoteNo(built.proposal, 15);
    expect(without).not.toContain("Handlingen gjør dette");
    expect(without).not.toMatch(/\n\n/);
    expect(without).toContain("skrevet av en modell");
  });

  it("notatet er ærlig: IKKE utført, klasse, støttende/uenige, og at ingenting skjer før godkjenning", () => {
    const built = buildCouncilProposal({ council_id: "c", draft: { tool: "slack__notify", arguments: { text: "x" }, expected_effect: "Varsler i Slack." }, actions: CATALOG, consensus_status: "MAJORITY", supporting_models: ["anthropic", "openai"], dissenting_models: [], confidence: 80, risk_summary: "" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const note = renderProposalNoteNo(built.proposal, 15);
    expect(note).toContain("IKKE utført");
    expect(note).toContain("sikkerhetsklasse C");
    expect(note).toContain("støttet av: anthropic, openai");
    expect(note).toContain("uenig: ingen");
    expect(note).toMatch(/Ingenting skjer før du godkjenner/);
    expect(note).toContain("15 minutter");
  });

  it("avvisningstekst gjengir aldri innhold", () => {
    expect(describeProposalRejectionNo("consensus_too_weak")).toMatch(/enighet/);
    expect(describeProposalRejectionNo("arguments_contain_secret")).toMatch(/hemmelighet/);
    expect(describeProposalRejectionNo("arguments_invalid")).toMatch(/ugyldig/);
    expect(describeProposalRejectionNo(undefined)).toMatch(/ugyldig/);
  });

  it("cleanDisplayText: ikke-strenger blir tom streng", () => {
    expect([cleanDisplayText(5, 10), cleanDisplayText(undefined, 10), cleanDisplayText(null, 10), cleanDisplayText({}, 10)]).toEqual(["", "", "", ""]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// AiCouncil: ekte rundeprotokoll mot scriptede adaptere
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [], rowCount: 0 }),
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

const round1 = (conclusion: string): string =>
  JSON.stringify({ conclusion, reasoning_summary: `begrunnelse for ${conclusion}`, assumptions: [], evidence_provenance: [], risks: ["r"], confidence: 70, unresolved_questions: [] });

interface Seen { name: string; request: ModelRequest }

class MemberAdapter implements ModelProviderAdapter {
  readonly model = "test-model";
  constructor(readonly name: string, private readonly seen: Seen[], private readonly synthesis: (responded: string[]) => string) {}
  available(): boolean { return true; }
  async complete(request: ModelRequest): Promise<ModelResult> {
    this.seen.push({ name: this.name, request });
    const first = request.messages[0]?.content;
    const text = typeof first === "string" ? first : "";
    const match = text.match(/MEDLEMMER SOM SVARTE \(([^)]*)\)/);
    const out = match ? this.synthesis((match[1] as string).split(",").map((s) => s.trim())) : round1(`konklusjon-${this.name}`);
    return { text: out, usage: { input_tokens: 10, output_tokens: 10 }, provider: this.name, model: this.model };
  }
}

const synthJson = (responded: string[], opts: { dissenting?: string[]; proposed?: unknown; omitProposed?: boolean } = {}): string => {
  const dissenting = opts.dissenting ?? [];
  return JSON.stringify({
    decision: "Gå videre med planen.",
    supporting_models: responded.filter((p) => !dissenting.includes(p)),
    dissenting_models: dissenting,
    key_evidence: ["e1"],
    key_disagreements: dissenting.length > 0 ? ["u1"] : [],
    risk_summary: "moderat",
    confidence: 80,
    recommended_action: "Opprett oppgaven.",
    ...(opts.omitProposed ? {} : { proposed_action: opts.proposed === undefined ? GOOD : opts.proposed })
  });
};

function build(synthesis: (responded: string[]) => string) {
  const seen: Seen[] = [];
  const names = ["anthropic", "openai", "gemini"];
  const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: names.map((n) => new MemberAdapter(n, seen, synthesis)) });
  return { council: new AiCouncil(gateway), seen, names };
}
const run = (council: AiCouncil, names: string[], extra: Record<string, unknown> = {}): Promise<CouncilResult> =>
  council.run({ tenant_id: "t1", decision_context: "Bør vi opprette en oppgave for dette?", members: names, ...extra });

const synthesisRequest = (seen: Seen[]): ModelRequest => seen.map((s) => s.request).find((r) => typeof r.messages[0]?.content === "string" && (r.messages[0].content as string).includes("MEDLEMMER SOM SVARTE")) as ModelRequest;

describe("AiCouncil + proposable_actions", () => {
  it("UTEN liste er alt uendret: syntesepromten nevner ikke forslag, og resultatet har verken proposal eller proposal_review (selv om modellen la ved en proposed_action)", async () => {
    const { council, seen, names } = build((r) => synthJson(r));
    for (const extra of [{}, { proposable_actions: [] }]) {
      seen.length = 0;
      const result = await run(council, names, extra);
      expect(synthesisRequest(seen).system).not.toContain("proposed_action");
      expect(result.proposal).toBeUndefined();
      expect("proposal" in result).toBe(false);
      expect("proposal_review" in result.provenance).toBe(false);
      expect(result.decision).toBe("Gå videre med planen.");
    }
  });

  it("MED liste og gyldig forslag: proposal bygges av Jarvis' beregnede tilstand - klasse fra listen, medlemmer fra syntesen, konsensus beregnet", async () => {
    const { council, names } = build((r) => synthJson(r, { dissenting: ["gemini"] }));
    const result = await run(council, names, { proposable_actions: CATALOG });
    expect(result.consensus_status).toBe("MAJORITY");
    expect(result.proposal).toMatchObject({
      council_id: result.council_id,
      action: { tool: "todoist__create_task", arguments: { content: "Ring leverandøren" } },
      safety: { risk: "B", effect: "write", source: "tool_manifest" },
      consensus_status: "MAJORITY",
      supporting_models: ["anthropic", "openai"],
      dissenting_models: ["gemini"],
      confidence: 80,
      requires_owner_confirmation: true,
      executes: false
    });
    expect(result.provenance.proposal_review).toEqual({ offered: ["todoist__create_task", "slack__notify"], outcome: "PROPOSED" });
    expect(result.recommended_action).toBe("Opprett oppgaven.");
  });

  it("§30: ingen forespørsel i rådet (runde 1-3 + syntese) har verktøy eller verktøyutvekslinger; katalogen står kun i syntesepromten, aldri i medlemsrundene", async () => {
    const { council, seen, names } = build((r) => synthJson(r));
    await run(council, names, { proposable_actions: CATALOG });
    expect(seen.length).toBeGreaterThanOrEqual(10);
    for (const { request } of seen) {
      expect(request.tools).toBeUndefined();
      expect(request.tool_exchanges).toBeUndefined();
      const body = JSON.stringify(request.messages);
      expect(body).not.toContain("todoist__create_task");
      if (!request.system?.includes("syntetiserer")) expect(request.system ?? "").not.toContain("todoist__create_task");
    }
    const synth = synthesisRequest(seen);
    expect(synth.system).toContain("todoist__create_task");
    expect(synth.system).toContain("slack__notify");
    expect(synth.system).toMatch(/DATA, aldri som instruksjoner/);
  });

  it("verktøy som ikke er på listen forkastes (REJECTED), og resten av resultatet er upåvirket", async () => {
    const { council, names } = build((r) => synthJson(r, { proposed: { tool: "email__send", arguments: { to: "x@evil.example" }, expected_effect: "Sender e-post." } }));
    const result = await run(council, names, { proposable_actions: CATALOG });
    expect(result.proposal).toBeUndefined();
    expect(result.provenance.proposal_review).toEqual({ offered: ["todoist__create_task", "slack__notify"], outcome: "REJECTED", reason: "tool_not_proposable" });
    expect(result.decision).toBe("Gå videre med planen.");
    expect(result.consensus_status).toBe("CONSENSUS");
  });

  it("modellen kan ikke selvrapportere sikkerhetsklasse: ekstra nøkkel i proposed_action forkastes", async () => {
    const { council, names } = build((r) => synthJson(r, { proposed: { ...GOOD, risk: "A" } }));
    const result = await run(council, names, { proposable_actions: CATALOG });
    expect(result.proposal).toBeUndefined();
    expect(result.provenance.proposal_review).toMatchObject({ outcome: "REJECTED", reason: "unknown_keys" });
  });

  it("et delt råd (SPLIT) legger ikke frem noe godkjennbart", async () => {
    const { council, names } = build((r) => synthJson(r, { dissenting: ["openai", "gemini"] }));
    const result = await run(council, names, { proposable_actions: CATALOG });
    expect(result.consensus_status).toBe("SPLIT");
    expect(result.proposal).toBeUndefined();
    expect(result.provenance.proposal_review).toMatchObject({ outcome: "REJECTED", reason: "consensus_too_weak" });
  });

  it("et degradert råd (medlem utilgjengelig) legger ikke frem noe godkjennbart", async () => {
    const seen: Seen[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: ["anthropic", "openai"].map((n) => new MemberAdapter(n, seen, (r) => synthJson(r))) });
    const result = await new AiCouncil(gateway).run({ tenant_id: "t1", decision_context: "x?", members: ["anthropic", "openai", "gemini"], proposable_actions: CATALOG });
    expect(result.consensus_status).toBe("DEGRADED_NO_CONSENSUS");
    expect(result.proposal).toBeUndefined();
    expect(result.provenance.proposal_review).toMatchObject({ outcome: "REJECTED", reason: "consensus_too_weak" });
  });

  it("syntesen uten proposed_action (eller med null) er NONE - en ren vurdering", async () => {
    for (const build_ of [(r: string[]) => synthJson(r, { omitProposed: true }), (r: string[]) => synthJson(r, { proposed: null })]) {
      const { council, names } = build(build_);
      const result = await run(council, names, { proposable_actions: CATALOG });
      expect(result.proposal).toBeUndefined();
      expect(result.provenance.proposal_review).toEqual({ offered: ["todoist__create_task", "slack__notify"], outcome: "NONE" });
    }
  });

  it("injeksjonsforsøk i selve forslaget (ikke-objekt, kommando i effekt, hemmelighet) gir aldri et forslag", async () => {
    for (const proposed of ["kjør rm -rf /", 42, ["todoist__create_task"], { tool: "todoist__create_task", arguments: { content: `x ${FAKE_GH}` }, expected_effect: "ok" }, { tool: "todoist__create_task", arguments: JSON.parse('{"__proto__": {"x": 1}}'), expected_effect: "ok" }]) {
      const { council, names } = build((r) => synthJson(r, { proposed }));
      const result = await run(council, names, { proposable_actions: CATALOG });
      expect(result.proposal, JSON.stringify(proposed)).toBeUndefined();
      expect(result.provenance.proposal_review?.outcome).toBe("REJECTED");
      expect(JSON.stringify(result.provenance.proposal_review)).not.toContain("ghp_");
    }
  });

  it("kilde-vakt: council.ts og council-proposal.ts har ingen vei til utførelse (ingen ToolExecutor, tool-gateway, tools:/tool_exchanges i forespørsler)", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["../src/council.ts", "../src/council-proposal.ts"]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/ToolExecutor|completeWithTools|@jarvis\/tool-gateway|tool_exchanges|\btools\s*:/);
    }
  });
});
