import { describe, expect, it, vi } from "vitest";
import { ProviderError, type ModelRequest, type ToolCallRequest, type ToolExchange } from "@jarvis/provider-adapters";
import { ClaudeBudgetBlockedError, type CompleteInput } from "../src/index.ts";
import { HAIKU, REQ, SPENT, background, build, ownerTask, ownerTurn } from "./support/claude-budget-fakes.ts";

/**
 * WP-B4 (D-476), fikser etter den uavhengige reviewen (M1-M3, L1-L7). Gateway-nivå: de delte fakes (`support/claude-budget-fakes.ts`) gir en ekte `ModelGateway` + `ClaudeBudgetEnforcer` med injisert klokke.
 * Perioden er 15. nov → 15. des 2026; klokka står midt i perioden (kurven 47 250 øre, 1,3 × kurven 61 425, tempobudsjettet 89 250, budsjettet 105 000 øre).
 */

const ECHO_TOOL = { name: "echo", description: "ekko", input_schema: { type: "object" as const, additionalProperties: false, properties: {} } };
const call = (provider: string, model: string, id = "c1"): ToolCallRequest => ({ tool_call_id: id, tool_name: "echo", arguments: {}, provider, model });
const toolRound = (provider: string, model: string) => ({ text: "", tool_calls: [call(provider, model)], finish_reason: "tool_use" });
/** Runde 1 ber om verktøyet, runde 2 gir svar. */
const toolThenAnswer = (provider: string, model: string) => (_request: ModelRequest, n: number) => (n === 1 ? toolRound(provider, model) : {});
const exchange = (provider: string): ToolExchange => ({
  calls: [call(provider, "m")],
  results: [{ tool_call_id: "c1", tool_name: "echo", execution_id: "e1", success: true, output: { ok: true }, at: "2026-11-30T12:00:00.000Z" }]
});
function executor(after?: () => void) {
  return {
    execute: vi.fn(async (c: { tool_call_id: string; tool_name: string }) => {
      after?.();
      return { tool_call_id: c.tool_call_id, tool_name: c.tool_name, execution_id: "e1", success: true, output: { ok: true }, at: "2026-11-30T12:00:00.000Z" };
    })
  };
}

describe("M1: en lukket runde 1 holder runde 2 lukket - ingen hard-stopp-omgåelse via «fortsettelse»", () => {
  const scenarios: Array<{ name: string; spent: number; input: (extra?: Partial<CompleteInput>) => CompleteInput; reason: string }> = [
    { name: "BAKGRUNN-verktøyløkke ved stramt (utsatt)", spent: SPENT.tight, input: background, reason: "tight_background_deferred" },
    { name: "oppbrukt med hard stopp PÅ, eierens egen tur (ESSENSIELL)", spent: SPENT.exhausted, input: ownerTurn, reason: "exhausted_closed" },
    { name: "oppbrukt med hard stopp PÅ, bestilt jobb (VIKTIG)", spent: SPENT.exhausted, input: ownerTask, reason: "exhausted_closed" }
  ];

  for (const s of scenarios) {
    it(`${s.name}: runde 1 går lokalt, runde 2 blir også lokal - Anthropic får ikke ett eneste kall`, async () => {
      const { gateway, db, anthropic, local } = build({ local: { script: toolThenAnswer("gemma_local", "gemma-local") } });
      db.spend.set("t1", s.spent);
      const result = await gateway.completeWithTools(s.input(), { tools: [ECHO_TOOL], executor: executor() });
      expect(result.provider).toBe("gemma_local");
      expect(anthropic.calls).toHaveLength(0);
      expect(local.calls).toHaveLength(2);
      expect(result.metadata?.["tool_rounds"]).toBe(1);
      expect(result.metadata?.["served_providers"]).toBeUndefined(); // kun den lokale betjente turen
      // begge rundene er styrt bort fra Anthropic (revisjon per kall), og runde 2 bærer den samme begrunnelsen som runde 1
      expect(db.audit.map((a) => a.reason)).toEqual([s.reason, s.reason]);
      expect(db.audit[1]?.payload["round_rule"]).toBe("earlier_round_closed");
    });
  }

  it("en lukket runde 1 holder runde 2 lukket selv om kreditten i mellomtiden ser ut til å ha rom (fail-safe-flapping: aldri tilbake til Anthropic midt i turen)", async () => {
    const { gateway, db, anthropic } = build({ local: { script: toolThenAnswer("gemma_local", "gemma-local") } });
    db.spend.set("t1", SPENT.tight);
    const result = await gateway.completeWithTools(background(), {
      tools: [ECHO_TOOL],
      executor: executor(() => db.spend.set("t1", SPENT.on_pace)) // verktøyet tar tid; forbruket «synker» (annen kilde) - turen er likevel startet lokalt
    });
    expect(result.provider).toBe("gemma_local");
    expect(anthropic.calls).toHaveLength(0);
  });

  it("dummy-`tool_exchanges` i et ENKELT kall åpner aldri en lukket kreditt: en utveksling uten Anthropic gir en vanlig (lukket) beslutning", async () => {
    for (const exchanges of [[exchange("gemma_local")], [exchange("openai")], [{ calls: [], results: [] }]]) {
      const { gateway, db, anthropic, local } = build();
      db.spend.set("t1", SPENT.exhausted);
      const request: ModelRequest = { ...REQ, tool_exchanges: exchanges };
      const result = await gateway.complete(ownerTurn({ request }));
      expect(result.provider, JSON.stringify(exchanges)).toBe("gemma_local");
      expect(anthropic.calls, JSON.stringify(exchanges)).toHaveLength(0);
      expect(local.calls).toHaveLength(1);
      expect(db.audit.map((a) => a.reason)).toEqual(["exhausted_closed"]);
    }
  });

  it("en dummy-utveksling som SELV hevder `anthropic` heller ikke: fortsettelse er noe gatewayens egen verktøyløkke vet - aldri noe forespørselen kan påstå (eksplisitt Anthropic er avvist, ellers lokal)", async () => {
    const { gateway, db, anthropic } = build();
    db.spend.set("t1", SPENT.exhausted);
    const request: ModelRequest = { ...REQ, tool_exchanges: [exchange("anthropic")] };
    const explicit = await gateway.complete(ownerTurn({ provider: "anthropic", request })).catch((e: unknown) => e);
    expect(explicit).toBeInstanceOf(ClaudeBudgetBlockedError);
    const auto = await gateway.complete(ownerTurn({ request }));
    expect(auto.provider).toBe("gemma_local");
    expect(anthropic.calls).toHaveLength(0);
  });

  it("stream: samme regel (en lukket runde 1 via stream holder runde 2 lukket)", async () => {
    const { gateway, db, anthropic } = build({ local: { script: toolThenAnswer("gemma_local", "gemma-local") } });
    db.spend.set("t1", SPENT.exhausted);
    const events: string[] = [];
    const result = await gateway.completeWithTools(ownerTurn(), { tools: [ECHO_TOOL], executor: executor(), onEvent: (e) => events.push(e.type) });
    expect(result.provider).toBe("gemma_local");
    expect(anthropic.calls).toHaveLength(0);
    expect(anthropic.streamCalls).toHaveLength(0);
  });
});

describe("M1: en påbegynt tur PÅ Anthropic fullføres fortsatt (fortsettelsesrunder er ikke en ny beslutning)", () => {
  it("runde 1 tillatt, kreditten går tom etter runde 1, runde 2 fullfører turen på Anthropic - uten ny lesing av forbruket", async () => {
    const { gateway, db, anthropic } = build({ anthropic: { script: toolThenAnswer("anthropic", "claude-sonnet-5-5") } });
    db.spend.set("t1", SPENT.tight);
    const result = await gateway.completeWithTools(ownerTurn(), { tools: [ECHO_TOOL], executor: executor(() => db.spend.set("t1", SPENT.exhausted)) });
    expect(result.provider).toBe("anthropic");
    expect(anthropic.calls.length + anthropic.streamCalls.length).toBe(2);
    expect(result.metadata?.["tool_rounds"]).toBe(1);
    expect(db.spendReads).toBe(1); // M3: runde 2 er en fortsettelse - ingen ny lesing
    expect(db.audit).toHaveLength(0); // ESSENSIELL på tempo: kun spor, ingen revisjonsrad
  });

  it("fortsettelsen er IKKE en ny vurdering selv når bufferen har utløpt og kreditten ser oppbrukt ut: runde 2 går fortsatt til Anthropic med billett fra runde 1 (ingen ny lesing)", async () => {
    const { gateway, db, anthropic, clock, budgetSpans } = build({ anthropic: { script: toolThenAnswer("anthropic", "claude-sonnet-5-5") } });
    db.spend.set("t1", SPENT.tight);
    const result = await gateway.completeWithTools(ownerTurn(), { tools: [ECHO_TOOL], executor: executor(() => { db.spend.set("t1", SPENT.exhausted); clock.now += 5_000; }) });
    expect(result.provider).toBe("anthropic");
    expect(anthropic.calls.length + anthropic.streamCalls.length).toBe(2);
    expect(db.spendReads).toBe(1); // en ny vurdering ville lest på nytt (bufferen er utløpt) og sett «oppbrukt»
    expect(budgetSpans().map((span) => span.metadata?.["reason"])).toEqual(["tight_essential_allowed", "continuation_round_allowed"]);
    expect(db.audit).toHaveLength(0);
  });

  it("en nedgradert tur fortsetter på den billigere modellen i neste runde (billetten bæres gjennom løkka, ikke overstyrt til dyr modell)", async () => {
    const { gateway, db, anthropic, clock } = build({ anthropic: { script: toolThenAnswer("anthropic", HAIKU) } });
    db.spend.set("t1", SPENT.ahead);
    // forbruket «synker» og bufferen utløper mellom rundene: en NY vurdering ville gitt full modell, men turen er påbegynt på den billige og forblir der
    const result = await gateway.completeWithTools(background(), { tools: [ECHO_TOOL], executor: executor(() => { db.spend.set("t1", SPENT.on_pace); clock.now += 5_000; }) });
    expect(result.provider).toBe("anthropic");
    expect([...anthropic.calls, ...anthropic.streamCalls].map((c) => c.model)).toEqual([HAIKU, HAIKU]);
  });

  it("fortsettelse krever at en tidligere runde FAKTISK ble betjent av Anthropic: runde 1 betjent av lokal reserve (Anthropic feilet) gir en vanlig beslutning i runde 2", async () => {
    const { gateway, db, anthropic, clock } = build({ anthropic: { fail: new Error("nede") }, local: { script: toolThenAnswer("gemma_local", "gemma-local") } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.spend.set("t1", SPENT.on_pace);
    let anthropicCallsAfterRound1 = -1;
    const result = await gateway.completeWithTools(ownerTurn(), {
      tools: [ECHO_TOOL],
      // verktøyet tar tid (forbruket leses på nytt etter at bufferen på 3 s har utløpt): kreditten er oppbrukt når runde 2 skal avgjøres
      executor: executor(() => { anthropicCallsAfterRound1 = anthropic.calls.length; db.spend.set("t1", SPENT.exhausted); clock.now += 3_000; })
    });
    // runde 1: Anthropic tillatt (på tempo) men feilet → lokal reserve; runde 2: ingen Anthropic-runde å fortsette → ny beslutning (oppbrukt) → lokal, uten nytt Anthropic-forsøk
    expect(result.provider).toBe("gemma_local");
    expect(anthropicCallsAfterRound1).toBeGreaterThan(0);
    expect(anthropic.calls).toHaveLength(anthropicCallsAfterRound1);
    expect(db.audit.map((a) => a.reason)).toEqual(["exhausted_closed"]);
    vi.restoreAllMocks();
  });
});

describe("L1: stengt Anthropic gir LOKAL fallback (Q-67) - aldri en betalt skyleverandør bare fordi Claude-kreditten er brukt opp", () => {
  const CLOUD_TOO = ["anthropic", "gemma_local", "openai"] as const;
  const used = (a: { calls: unknown[]; streamCalls: unknown[] }): number => a.calls.length + a.streamCalls.length;

  for (const mode of ["AUTO", "QUALITY"] as const) {
    for (const purpose of ["REASON", "PLAN", "CODE"] as const) {
      it(`${purpose} (${mode}) ved oppbrukt kreditt og hard stopp: svaret kommer fra den lokale modellen, aldri fra openai/gpt-5`, async () => {
        const { gateway, db, anthropic, local, openai } = build({ providers: [...CLOUD_TOO] });
        db.spend.set("t1", SPENT.exhausted);
        const result = await gateway.complete(ownerTurn({ purpose, mode }));
        expect(result.provider).toBe("gemma_local");
        expect(used(anthropic)).toBe(0);
        expect(used(openai)).toBe(0);
        expect(local.calls).toHaveLength(1);
        expect((result.metadata?.["router"] as { mode?: string } | undefined)?.mode).toBe("LOCAL");
        expect(result.metadata?.["claude_budget"]).toMatchObject({ action: "deny", constraint: "closed", reason: "exhausted_closed" });
      });
    }
    it(`BAKGRUNN REASON (${mode}) ved stramt: utsatt = lokal modell, ikke openai/gpt-5`, async () => {
      const { gateway, db, anthropic, local, openai } = build({ providers: [...CLOUD_TOO] });
      db.spend.set("t1", SPENT.tight);
      const result = await gateway.complete(background({ purpose: "REASON", mode }));
      expect(result.provider).toBe("gemma_local");
      expect(used(anthropic) + used(openai)).toBe(0);
      expect(local.calls).toHaveLength(1);
    });
  }

  it("en vanlig tur UTEN kreditt-innsnevring er uendret: på tempo velger ruteren som før (Anthropic rangerer først i QUALITY), og lokal-only brukes aldri når Anthropic er åpen", async () => {
    const { gateway, db, anthropic, local } = build({ providers: [...CLOUD_TOO] });
    db.spend.set("t1", SPENT.on_pace);
    const result = await gateway.complete(ownerTurn({ purpose: "REASON" }));
    expect(result.provider).toBe("anthropic");
    expect(used(anthropic)).toBe(1);
    expect(local.calls).toHaveLength(0);
  });

  it("INGEN lokal modell, men openai er konfigurert: stengt kreditt gir den tydelige norske meldingen (ClaudeBudgetBlockedError), ikke et stille betalt kall mot openai", async () => {
    const { gateway, db, openai } = build({ providers: ["anthropic", "openai"] });
    db.spend.set("t1", SPENT.exhausted);
    const err = (await gateway.complete(ownerTurn({ purpose: "REASON" })).catch((e: unknown) => e)) as ClaudeBudgetBlockedError;
    expect(err).toBeInstanceOf(ClaudeBudgetBlockedError);
    expect(err.message).toContain("ingen lokal modell");
    expect(used(openai)).toBe(0);
    // samme for utsatt BAKGRUNN (stramt): den tydelige «utsatt»-feilen, ikke openai
    const tight = build({ providers: ["anthropic", "openai"] });
    tight.db.spend.set("t1", SPENT.tight);
    const deferred = (await tight.gateway.complete(background({ purpose: "REASON" })).catch((e: unknown) => e)) as ClaudeBudgetBlockedError;
    expect(deferred).toBeInstanceOf(ClaudeBudgetBlockedError);
    expect(deferred.kind).toBe("deferred");
    expect(used(tight.openai)).toBe(0);
  });

  it("sensitivitetsforrang er uendret: PRIVATE med lokal modell går lokalt; PRIVATE uten lokal modell og stengt kreditt får den tydelige feilen; SECRET_RESTRICTED når aldri budsjettlaget", async () => {
    const withLocal = build({ providers: [...CLOUD_TOO] });
    withLocal.db.spend.set("t1", SPENT.exhausted);
    expect((await withLocal.gateway.complete(ownerTurn({ sensitivity: "PRIVATE" }))).provider).toBe("gemma_local");
    const noLocal = build({ providers: ["anthropic", "openai"] });
    noLocal.db.spend.set("t1", SPENT.exhausted);
    expect(await noLocal.gateway.complete(ownerTurn({ sensitivity: "PRIVATE" })).catch((e: unknown) => e)).toBeInstanceOf(ClaudeBudgetBlockedError);
    expect(used(noLocal.openai)).toBe(0);
    const secret = build({ providers: [...CLOUD_TOO] });
    secret.db.spend.set("t1", SPENT.exhausted);
    expect((await secret.gateway.complete(ownerTurn({ sensitivity: "SECRET_RESTRICTED" }))).provider).toBe("gemma_local");
    expect(secret.db.spendReads).toBe(0);
  });

  it("eksplisitte valg beholder sin egen semantikk: `provider: openai` er eierens valg (ingen kredittbeslutning), en preferanseliste [anthropic, openai] (spesialist-delegering) går videre til openai - men Anthropic får aldri kallet mens den er stengt", async () => {
    const { gateway, db, anthropic, openai } = build({ providers: [...CLOUD_TOO] });
    db.spend.set("t1", SPENT.exhausted);
    const explicitOpenai = await gateway.complete(ownerTurn({ provider: "openai" }));
    expect(explicitOpenai.provider).toBe("openai");
    expect(db.spendReads).toBe(0);
    const specialist = await gateway.complete(ownerTurn({ purpose: "CODE", providerPreference: ["anthropic", "openai", "gemini"], preferenceFailover: true }));
    expect(specialist.provider).toBe("openai");
    expect(used(anthropic)).toBe(0);
    expect(used(openai)).toBe(2);
  });

  it("criticen følger samme regel: er Anthropic innsnevret for kallet, er criticen lokal (aldri en betalt skyleverandør), også når den lokale modellen er den som svarte", async () => {
    const { gateway, db, anthropic, openai } = build({ providers: [...CLOUD_TOO] });
    db.spend.set("t1", SPENT.exhausted);
    const result = await gateway.complete(ownerTurn({ critic: true }));
    expect(result.provider).toBe("gemma_local");
    const critic = result.metadata?.["critic"] as { provider?: string } | undefined;
    expect(critic?.provider).toBe("gemma_local");
    expect(result.metadata?.["critic_error"]).toBeUndefined();
    expect(used(anthropic) + used(openai)).toBe(0);
  });
});

describe("L5: begin() kaster aldri, og ikke-endelige tall behandles som ULESELIG forbruk (fail-safe) - aldri som «på tempo»", () => {
  const hostile: Array<[string, ModelRequest]> = [
    ["content: undefined", { messages: [{ role: "user", content: undefined as never }], max_tokens: 100 }],
    ["content: null", { messages: [{ role: "user", content: null as never }], max_tokens: 100 }],
    ["messages: undefined", { messages: undefined as never, max_tokens: 100 }],
    ["max_tokens: NaN", { messages: [{ role: "user", content: "hei" }], max_tokens: Number.NaN }],
    ["max_tokens: -5", { messages: [{ role: "user", content: "hei" }], max_tokens: -5 }],
    ["max_tokens: Infinity", { messages: [{ role: "user", content: "hei" }], max_tokens: Number.POSITIVE_INFINITY }],
    ["max_tokens: tekst", { messages: [{ role: "user", content: "hei" }], max_tokens: "mange" as never }],
    ["system: objekt", { system: { toString: () => { throw new Error("hostile"); } } as never, messages: [{ role: "user", content: "hei" }] }],
    ["sirkulær tools/tool_exchanges", (() => { const a: Record<string, unknown> = {}; a["self"] = a; return { messages: [{ role: "user", content: "hei" }], tools: [a] as never, tool_exchanges: [a] as never }; })()],
    ["content: delvis ugyldig array", { messages: [{ role: "user", content: [null, { type: "text" }, { type: "text", text: 5 }] as never }] }]
  ];

  for (const [name, request] of hostile) {
    it(`${name}: gateway.complete() lykkes, reservasjonen er et endelig tall ≥ 0, og et samtidig kall ser ikke «NaN-forbruk»`, async () => {
      const gate = { open: () => undefined as void, promise: Promise.resolve() };
      gate.promise = new Promise<void>((resolve) => { gate.open = resolve; });
      const { gateway, db, enforcer, anthropic } = build({ anthropic: { hold: () => gate.promise } });
      db.spend.set("t1", SPENT.tight);
      const first = gateway.complete(ownerTurn({ request }));
      await vi.waitFor(() => expect(anthropic.calls).toHaveLength(1));
      const inFlight = enforcer!.inFlightOre("t1");
      expect(Number.isFinite(inFlight), String(inFlight)).toBe(true);
      expect(inFlight).toBeGreaterThanOrEqual(0);
      // mens det hengende kallet står med sin reservasjon: BAKGRUNN ved stramt er fortsatt utsatt (aldri «på tempo» pga. et NaN-/negativt anslag)
      const next = await gateway.complete(background());
      expect(next.provider).toBe("gemma_local");
      expect(db.audit.at(-1)?.reason).toBe("tight_background_deferred");
      gate.open();
      expect((await first).provider).toBe("anthropic"); // ESSENSIELL ved stramt: tillatt
      expect(enforcer!.inFlightOre("t1")).toBe(0);
    });
  }

  it("begin() direkte med fiendtlige objekter (info uten forespørsel, kastende getters) gir en billett - aldri et avvist løfte", async () => {
    const { enforcer } = build();
    const evil = new Proxy({}, { get: () => { throw new Error("hostile getter"); } });
    for (const info of [{ tenant_id: "t1", request: evil, pricing: evil, catalog: evil, trace_id: "x", started: 0 }, { tenant_id: "t1" }, {}, { tenant_id: "t1", request: undefined }]) {
      const ticket = await enforcer!.begin(info as never);
      expect(["allow", "downgrade", "defer", "deny"]).toContain(ticket.verdict.action);
      expect(ticket.constraint === "open" || ticket.constraint === "cheaper_model" || ticket.constraint === "closed").toBe(true);
      ticket.release();
    }
    vi.restoreAllMocks();
  });

  it("estimateCallOre er alltid et endelig tall ≥ 0 og aldri over taket, uansett fiendtlig innhold", async () => {
    const { estimateCallOre, DEFAULT_PRICING } = await import("../src/index.ts");
    for (const [name, request] of hostile) {
      const ore = estimateCallOre(DEFAULT_PRICING, "anthropic", "claude-sonnet-5-5", request, 105_000);
      expect(Number.isFinite(ore), name).toBe(true);
      expect(ore, name).toBeGreaterThanOrEqual(0);
      expect(ore, name).toBeLessThanOrEqual(5_250);
    }
  });

  it("motoren: ikke-endelig forbruk eller budsjett gir en feil (aldri `allow/on_pace`) - `decide`, `pacingState` og dermed alle flater; endelig forbruk er uendret", async () => {
    const { decide, pacingState, claudeBudgetConfigFromEnv } = await import("../src/index.ts");
    const cfg = claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100" })!;
    const base = { now: MID_FOR_ENGINE, budget_ore: cfg.budget_ore, tier: "essential" as const };
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => decide({ ...base, spent_ore: bad }), String(bad)).toThrow(/ikke endelig|non_finite/i);
      expect(() => pacingState({ now: MID_FOR_ENGINE, budget_ore: cfg.budget_ore, spent_ore: bad }), String(bad)).toThrow();
      expect(() => decide({ ...base, spent_ore: 1_000, budget_ore: bad }), `budsjett ${bad}`).toThrow();
    }
    expect(decide({ ...base, spent_ore: 40_000 })).toMatchObject({ action: "allow", level: "on_pace" });
    expect(decide({ ...base, spent_ore: 0 })).toMatchObject({ action: "allow" });
  });

  it("en forbrukslesing som gir et ikke-endelig tall (database, mellomsum) gir fail-safe per tier, aldri «på tempo»: ESSENSIELL tillates, VIKTIG nedgraderes, BAKGRUNN utsettes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const row of [{ window_ore: Number.POSITIVE_INFINITY, trailing_ore: 0 }, { window_ore: Number.NaN, trailing_ore: 0 }, { window_ore: "Infinity", trailing_ore: 0 }, { window_ore: 10, trailing_ore: Number.NaN }]) {
      const { gateway, db } = build();
      db.spendReadRow = row;
      expect((await gateway.complete(ownerTurn())).provider).toBe("anthropic");
      expect((await gateway.complete(background())).provider).toBe("gemma_local");
      expect(db.audit.map((a) => a.reason), JSON.stringify(row)).toEqual(["spend_unreadable_essential_allowed", "spend_unreadable_background_deferred"]);
    }
    vi.restoreAllMocks();
  });
});

const MID_FOR_ENGINE = Date.UTC(2026, 10, 30, 11, 0, 0); // 30. nov 2026, midt i perioden

describe("M3: lesingen av forbruket er billig og begrenset (buffer, enkeltflyt, negativ buffer, ingen lesing i fortsettelsesrunder)", () => {
  const DAYMS = 86_400_000;

  it("en 4-kalls verktøytur på en frisk database gjør ÉN lesing (ikke fire): første runde leser, fortsettelsesrundene bærer billetten", async () => {
    const { gateway, db } = build({ anthropic: { script: (_r, n) => (n <= 3 ? toolRound("anthropic", "claude-sonnet-5-5") : {}) } });
    db.spend.set("t1", SPENT.on_pace);
    const result = await gateway.completeWithTools(ownerTurn({ provider: "anthropic" }), { tools: [ECHO_TOOL], executor: executor(), maxRounds: 6 });
    expect(result.metadata?.["tool_rounds"]).toBe(3);
    expect(db.spendReads).toBe(1);
  });

  it("buffer (3 s): uavhengige kall innenfor levetiden deler ÉN lesing; ved utløp (>= 3 s) leses det på nytt; en annen tenant har sin egen lesing", async () => {
    const { gateway, db, clock } = build();
    db.spend.set("t1", SPENT.on_pace);
    db.spend.set("t2", SPENT.on_pace);
    for (let i = 0; i < 4; i++) await gateway.complete(ownerTurn());
    expect(db.spendReads).toBe(1);
    clock.now += 2_999;
    await gateway.complete(ownerTurn());
    expect(db.spendReads).toBe(1);
    clock.now += 1; // nøyaktig 3 s siden lesingen
    await gateway.complete(ownerTurn());
    expect(db.spendReads).toBe(2);
    await gateway.complete(ownerTurn({ tenant_id: "t2" }));
    expect(db.spendReads).toBe(3);
  });

  it("enkeltflyt: seks samtidige kall deler ÉN lesing (og ser fortsatt hverandres reservasjoner)", async () => {
    const { gateway, db, anthropic } = build();
    db.spend.set("t1", SPENT.on_pace);
    await Promise.all(Array.from({ length: 6 }, () => gateway.complete(ownerTurn())));
    expect(anthropic.calls.length).toBe(6);
    expect(db.spendReads).toBe(1);
  });

  it("bufferen + overlegget slipper aldri forbruket over hard stopp med mer enn ÉN kalls kostnad (klokka står stille: bufferen er gyldig hele tiden)", async () => {
    const usage = { input_tokens: 2_000, output_tokens: 3_000 }; // faktisk kostnad 36 øre per kall (anslaget fra max_tokens er lavere - overlegget må bruke det bokførte)
    const { gateway, db, config } = build({ anthropic: { usage } });
    const { costOre, DEFAULT_PRICING } = await import("../src/index.ts");
    const actual = costOre(DEFAULT_PRICING, "anthropic", "claude-sonnet-5-5", usage);
    expect(actual).toBe(36);
    db.spend.set("t1", config.budget_ore - 100);
    const request: ModelRequest = { messages: [{ role: "user", content: "x" }], max_tokens: 200 };
    let served = 0;
    for (let i = 0; i < 12; i++) {
      const r = await gateway.complete(ownerTurn({ request })).catch((e: unknown) => e);
      if (!(r instanceof Error) && (r as { provider: string }).provider === "anthropic") served += 1;
    }
    expect(db.spendReads).toBe(1); // hele rekka på ÉN lesing
    expect(served).toBe(3);
    const total = db.spend.get("t1") ?? 0;
    expect(total).toBe(config.budget_ore - 100 + 3 * actual);
    expect(total).toBeLessThanOrEqual(config.budget_ore + actual); // dokumentert overskridelse: høyst ett kalls kostnad
  });

  it("anslaget er høyere enn det faktiske (vanlig): overlegget bruker anslaget og stopper tidligere (konservativt) - aldri over taket", async () => {
    const { gateway, db, config } = build({ anthropic: { usage: { input_tokens: 10, output_tokens: 10 } } });
    db.spend.set("t1", config.budget_ore - 30);
    const request: ModelRequest = { messages: [{ role: "user", content: "x" }], max_tokens: 1_000 }; // anslag ca. 11 øre, faktisk 1 øre
    let served = 0;
    for (let i = 0; i < 12; i++) {
      const r = await gateway.complete(ownerTurn({ request })).catch((e: unknown) => e);
      if (!(r instanceof Error) && (r as { provider: string }).provider === "anthropic") served += 1;
    }
    expect(served).toBe(3); // overlegget bruker anslaget (11 øre per kall) - tre kall fyller de 30 øre som var igjen
    expect(db.spend.get("t1") ?? 0).toBeLessThanOrEqual(config.budget_ore);
  });

  it("når bufferen har utløpt ser neste kall det faktiske forbruket (også fra en annen prosess) - overlegget er bare en bro", async () => {
    const { gateway, db, clock } = build();
    db.spend.set("t1", SPENT.on_pace);
    expect((await gateway.complete(ownerTurn())).provider).toBe("anthropic");
    db.spend.set("t1", SPENT.exhausted); // en annen prosess (worker) brukte opp kreditten
    expect((await gateway.complete(ownerTurn())).provider).toBe("anthropic"); // innenfor 3 s: ikke sett ennå (dokumentert)
    clock.now += 3_000;
    expect((await gateway.complete(ownerTurn())).provider).toBe("gemma_local");
  });

  it("periodeskifte: en buffer fra forrige kredittperiode brukes aldri i den nye, selv innenfor levetiden", async () => {
    const { gateway, db, clock } = build({ now: START_OF_PERIOD + 30 * DAYMS - 1_000 });
    db.spend.set("t1", SPENT.exhausted);
    expect((await gateway.complete(ownerTurn())).provider).toBe("gemma_local"); // gammel periode: oppbrukt, lest og bufret
    db.spend.set("t1", 0); // ny periode: ingenting brukt ennå
    clock.now += 2_000; // over fornyelsen (15. des 00:00), men bufferen er bare 2 s gammel
    expect((await gateway.complete(ownerTurn())).provider).toBe("anthropic");
    expect(db.spendReads).toBe(2);
  });

  describe("negativ buffer: etter en feil/frist hoppes lesingen over i 30 s (fail-safe per tier gjelder så lenge), deretter prøves den igjen", () => {
    it("hengende database: fire kall etter hverandre tar ca. ÉN frist (ikke fire), og bare ÉN lesing er forsøkt", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const FRIST = 120;
      const { gateway, db, anthropic } = build({ spendTimeoutMs: FRIST });
      db.spendReadHangs = true;
      const started = Date.now();
      expect((await gateway.complete(ownerTurn())).provider).toBe("anthropic");
      expect((await gateway.complete(ownerTask())).model).toBe(HAIKU);
      expect((await gateway.complete(background())).provider).toBe("gemma_local");
      expect((await gateway.complete(ownerTurn())).provider).toBe("anthropic");
      const elapsed = Date.now() - started;
      expect(db.spendReads).toBe(1);
      expect(elapsed).toBeGreaterThanOrEqual(FRIST - 10);
      expect(elapsed).toBeLessThan(2 * FRIST + 150); // ikke 4 × frist
      expect(anthropic.calls).toHaveLength(3);
      expect(db.audit.map((a) => a.reason)).toEqual([
        "spend_unreadable_essential_allowed", "spend_unreadable_important_downgraded", "spend_unreadable_background_deferred", "spend_unreadable_essential_allowed"
      ]);
      vi.restoreAllMocks();
    });

    it("feil (ikke bare frist): samme negative buffer; etter 30 s leses det på nytt og en frisk database gir vanlige beslutninger igjen", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { gateway, db, clock } = build();
      db.spendReadError = new Error("nede");
      for (let i = 0; i < 3; i++) await gateway.complete(background());
      expect(db.spendReads).toBe(1);
      clock.now += 29_999;
      await gateway.complete(background());
      expect(db.spendReads).toBe(1);
      db.spendReadError = null;
      db.spend.set("t1", SPENT.tight);
      clock.now += 1; // 30 s
      const r = await gateway.complete(background());
      expect(db.spendReads).toBe(2);
      expect(r.provider).toBe("gemma_local");
      expect(db.audit.at(-1)?.reason).toBe("tight_background_deferred"); // vanlig beslutning fra den leste verdien
      vi.restoreAllMocks();
    });

    it("negativ buffer er per tenant: tenant A sin feil hindrer ikke lesingen for B", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { gateway, db } = build();
      db.spendReadError = new Error("nede");
      await gateway.complete(background({ tenant_id: "A" }));
      db.spendReadError = null;
      db.spend.set("B", SPENT.tight);
      const r = await gateway.complete(background({ tenant_id: "B" }));
      expect(db.spendReads).toBe(2);
      expect(r.provider).toBe("gemma_local");
      vi.restoreAllMocks();
    });
  });
});

const START_OF_PERIOD = Date.UTC(2026, 10, 14, 23, 0, 0); // 15. nov 2026 00:00 Europe/Oslo

describe("L4: beslutningstabellen er MONOTON - 121 forbruksnivåer (0-120 %) × hele perioden × alle tier × hard stopp på/av", () => {
  const STRICT = { allow: 0, downgrade: 1, defer: 2, deny: 3 } as const;
  const HOUR = 3_600_000;
  const START_MS = Date.UTC(2026, 10, 14, 23, 0, 0); // 15. nov 2026 00:00 Oslo
  const END_MS = Date.UTC(2026, 11, 14, 23, 0, 0); // 15. des 2026 00:00 Oslo
  const times: number[] = [];
  for (let t = START_MS; t < END_MS; t += 12 * HOUR) times.push(t);
  times.push(END_MS - 1);

  async function loadEngine() {
    const { decide, claudeBudgetConfigFromEnv, BUDGET_TIERS } = await import("../src/index.ts");
    const cfg = claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100" })!;
    return { decide, tiers: BUDGET_TIERS, B: cfg.budget_ore };
  }

  for (const hardStop of [true, false]) {
    it(`hard stopp ${hardStop ? "PÅ" : "AV (eierens override)"}: mer forbruk gjør aldri en beslutning mildere (121 steg per tid og tier), og tid gjør den aldri strengere`, async () => {
      const { decide, tiers, B } = await loadEngine();
      let decisions = 0;
      for (const tier of tiers) {
        // monoton i FORBRUK: for hvert tidspunkt, 0..120 %
        for (const now of times) {
          let previous = -1;
          for (let pct = 0; pct <= 120; pct++) {
            const d = decide({ now, budget_ore: B, spent_ore: Math.round((B * pct) / 100), tier, params: { hard_stop: hardStop } });
            const rank = STRICT[d.action];
            decisions += 1;
            if (rank < previous) throw new Error(`ikke monoton i forbruk: tier=${tier} hard_stop=${hardStop} t=${new Date(now).toISOString()} ${pct} % ga ${d.action}/${d.reason} etter strengere`);
            previous = rank;
          }
        }
        // monoton i TID: for hvert forbruksnivå gjør tiden (kurven stiger) aldri en beslutning strengere
        for (let pct = 0; pct <= 120; pct++) {
          let previous = Number.POSITIVE_INFINITY;
          for (const now of times) {
            const d = decide({ now, budget_ore: B, spent_ore: Math.round((B * pct) / 100), tier, params: { hard_stop: hardStop } });
            const rank = STRICT[d.action];
            if (rank > previous) throw new Error(`strengere over tid: tier=${tier} hard_stop=${hardStop} ${pct} % t=${new Date(now).toISOString()} ga ${d.action}/${d.reason}`);
            previous = rank;
          }
        }
      }
      expect(decisions).toBe(3 * times.length * 121);
    });
  }

  it("L4-regelen er eksplisitt: med hardstoppen AV er reserven ikke lenger forbeholdt ESSENSIELL (ingenting stenges ved 100 %), så VIKTIG tillates i reserven - og er dermed aldri utsatt for så å bli tillatt igjen; med hardstoppen PÅ er VIKTIG utsatt i reserven og avvist ved 100 %", async () => {
    const { decide, B } = await loadEngine();
    const now = START_MS + 15 * 24 * HOUR;
    const spent = (pct: number) => Math.round((B * pct) / 100);
    const row = (hardStop: boolean) => [86, 90, 99, 100, 110].map((pct) => { const d = decide({ now, budget_ore: B, spent_ore: spent(pct), tier: "important", params: { hard_stop: hardStop } }); return `${pct}:${d.action}`; });
    expect(row(true)).toEqual(["86:defer", "90:defer", "99:defer", "100:deny", "110:deny"]);
    expect(row(false)).toEqual(["86:allow", "90:allow", "99:allow", "100:allow", "110:allow"]);
    expect(decide({ now, budget_ore: B, spent_ore: spent(90), tier: "important", params: { hard_stop: false } }).reason).toBe("reserve_open_hard_stop_off");
    // BAKGRUNN og ESSENSIELL er uendret: BAKGRUNN forblir lokal/utsatt uten hard stopp, ESSENSIELL fortsetter
    expect(decide({ now, budget_ore: B, spent_ore: spent(105), tier: "background", params: { hard_stop: false } }).action).toBe("defer");
    expect(decide({ now, budget_ore: B, spent_ore: spent(105), tier: "essential", params: { hard_stop: false } }).action).toBe("allow");
  });
});

describe("L7: oppbruksvarselet kan ikke konfigureres bort - ALERT_PCTS har alltid 100", () => {
  it("100 legges til når det mangler (og beholdes når det står der); ugyldige lister kaster som før", async () => {
    const { claudeBudgetConfigFromEnv, DEFAULT_ALERT_PCTS } = await import("../src/index.ts");
    const pcts = (raw: string | undefined) => claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100", ...(raw !== undefined ? { JARVIS_CLAUDE_BUDGET_ALERT_PCTS: raw } : {}) })!.alert_pcts;
    expect(pcts(undefined)).toEqual([50, 75, 90, 100]);
    expect(pcts("")).toEqual([...DEFAULT_ALERT_PCTS]);
    expect(pcts("50,75")).toEqual([50, 75, 100]);
    expect(pcts("90")).toEqual([90, 100]);
    expect(pcts("1")).toEqual([1, 100]);
    expect(pcts("10, 20,100")).toEqual([10, 20, 100]);
    expect(pcts("100")).toEqual([100]);
    expect(pcts("1,2,3,4,5,6,7,8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 100]);
    for (const bad of ["0", "101", "50,50", "75,50", "halv", "1,2,3,4,5,6,7,8,9", "50,"]) {
      expect(() => claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100", JARVIS_CLAUDE_BUDGET_ALERT_PCTS: bad }), bad).toThrow(/ALERT_PCTS/);
    }
  });

  it("varslingsnøklene: ved 100 % er `pct:100` alltid forfalt, selv om eieren bare satte lavere terskler", async () => {
    const { claudeBudgetConfigFromEnv, dueAlertKeys, pacingState } = await import("../src/index.ts");
    const cfg = claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100", JARVIS_CLAUDE_BUDGET_ALERT_PCTS: "50,75" })!;
    const state = pacingState({ now: Date.UTC(2026, 10, 30, 11, 0, 0), budget_ore: cfg.budget_ore, spent_ore: cfg.budget_ore });
    expect(dueAlertKeys(state, cfg)).toContain("pct:100");
  });
});

describe("L2: avbrutte/feilede/utløpte Anthropic-kall bokføres med et ANSLAG (input + genererte tokens så langt), ikke 0 øre", () => {
  const SYSTEM = "s".repeat(3_000); // ≈ 1000 inn-tokens (tegn / 3)
  const request: ModelRequest = { system: SYSTEM, messages: [{ role: "user", content: "hei" }], max_tokens: 2_000 };
  const partial = (chars: number) => async (_r: ModelRequest, onEvent: (e: { type: "text_delta"; text: string }) => void, signal: AbortSignal | undefined): Promise<never> => {
    onEvent({ type: "text_delta", text: "x".repeat(chars) });
    await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve()); });
    throw new ProviderError("anthropic", "cancelled", "anthropic_cancelled");
  };
  const expected = async (generatedChars: number): Promise<number> => {
    const { estimateFailedCallOre, DEFAULT_PRICING } = await import("../src/index.ts");
    return estimateFailedCallOre(DEFAULT_PRICING, "anthropic", "claude-sonnet-5-5", request, generatedChars);
  };

  it("taleavbrudd (barge-in): delvis strøm så avbrudd gir ÉN rad med anslaget (inn ≈ 1001 + ut ≈ 1000 tokens = 13 øre), og neste beslutning ser det", async () => {
    const { gateway, db, enforcer } = build({ anthropic: { streamScript: partial(3_000) } });
    db.spend.set("t1", SPENT.on_pace);
    const ac = new AbortController();
    const turn = gateway.stream(ownerTurn({ provider: "anthropic", request }), () => undefined, ac.signal);
    await vi.waitFor(() => expect(db.spendReads).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    ac.abort();
    await expect(turn).rejects.toMatchObject({ kind: "cancelled" });
    expect(db.failedRows).toHaveLength(1);
    expect(db.failedRows[0]).toMatchObject({ provider: "anthropic", kind: "model:failed:cancelled" });
    expect(await expected(3_000)).toBe(13);
    expect(db.failedRows[0]!.amount_ore).toBe(13);
    expect(db.statements).toContain("INSERT_COST_FAILED_ESTIMATED");
    expect(db.spend.get("t1")).toBe(SPENT.on_pace + 13); // raden teller i kredittperioden
    expect(enforcer!.inFlightOre("t1")).toBe(0);
  });

  it("avbrudd FØR noe er generert (kallet er sendt): kun input-anslaget; en kalt-men-aldri-startet runde (avbrutt før retry) bokføres ikke på nytt", async () => {
    const { gateway, db } = build({ anthropic: { streamScript: partial(0) } });
    db.spend.set("t1", SPENT.on_pace);
    const ac = new AbortController();
    const turn = gateway.stream(ownerTurn({ provider: "anthropic", request }), () => undefined, ac.signal);
    await vi.waitFor(() => expect(db.spendReads).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    ac.abort();
    await expect(turn).rejects.toMatchObject({ kind: "cancelled" });
    expect(db.failedRows.map((r) => r.amount_ore)).toEqual([await expected(0)]);
    expect(db.failedRows[0]!.amount_ore).toBeGreaterThan(0);
  });

  it("utløpt frist (timeout) uten svar: input-anslaget; strøm som brytes midt i (stream_interrupted) etter delvis tekst: input + genererte tokens", async () => {
    const timeout = build({ anthropic: { fail: new ProviderError("anthropic", "timeout", "anthropic_timeout") } });
    timeout.db.spend.set("t1", SPENT.on_pace);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await timeout.gateway.complete(ownerTurn({ provider: "anthropic", request })).catch(() => undefined);
    expect(timeout.db.failedRows.every((r) => r.amount_ore === 3)).toBe(true); // 1001 inn-tokens × 2,1 øre/1k = 2,1 → 3
    expect(timeout.db.failedRows.length).toBeGreaterThan(0);

    const interrupted = build({ anthropic: { streamScript: async (_r, onEvent) => { onEvent({ type: "text_delta", text: "y".repeat(1_500) }); throw new ProviderError("anthropic", "stream_interrupted", "anthropic_stream_interrupted"); } } });
    interrupted.db.spend.set("t1", SPENT.on_pace);
    await interrupted.gateway.stream(ownerTurn({ provider: "anthropic", request }), () => undefined).catch(() => undefined);
    expect(interrupted.db.failedRows).toHaveLength(1);
    expect(interrupted.db.failedRows[0]!.amount_ore).toBe(await expected(1_500));
    expect(interrupted.db.failedRows[0]!.amount_ore).toBeGreaterThan(3);
    vi.restoreAllMocks();
  });

  it("feil som ikke faktureres (rate_limit, auth, bad_request, server uten tekst) forblir 0 øre - og andre leverandører er alltid 0 øre", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const kind of ["rate_limit", "auth", "bad_request", "server", "not_configured"] as const) {
      const { gateway, db } = build({ anthropic: { fail: new ProviderError("anthropic", kind, `anthropic_${kind}`) } });
      db.spend.set("t1", SPENT.on_pace);
      await gateway.complete(ownerTurn({ provider: "anthropic", request })).catch(() => undefined);
      expect(db.failedRows.length, kind).toBeGreaterThan(0);
      expect(db.failedRows.every((r) => r.amount_ore === 0), kind).toBe(true);
    }
    const other = build({ providers: ["anthropic", "gemma_local"], local: { fail: new ProviderError("gemma_local", "timeout", "gemma_timeout") } });
    other.db.spend.set("t1", SPENT.on_pace);
    await other.gateway.complete(ownerTurn({ provider: "gemma_local", request })).catch(() => undefined);
    expect(other.db.failedRows.length).toBeGreaterThan(0);
    expect(other.db.failedRows.every((r) => r.amount_ore === 0)).toBe(true);
    vi.restoreAllMocks();
  });

  it("flagg AV: et avbrutt Anthropic-kall bokføres som før (0 øre, samme SQL) - ingenting av anslaget finnes uten Claude-kreditten", async () => {
    const { gateway, db } = build({ flag: false, anthropic: { streamScript: partial(3_000) } });
    const ac = new AbortController();
    const turn = gateway.stream(ownerTurn({ provider: "anthropic", request }), () => undefined, ac.signal);
    await vi.waitFor(() => expect(db.statements).toContain("COMMIT"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    ac.abort();
    await expect(turn).rejects.toMatchObject({ kind: "cancelled" });
    expect(db.failedRows.map((r) => r.amount_ore)).toEqual([0]);
    expect(db.statements).toContain("INSERT_COST_FAILED");
    expect(db.statements).not.toContain("INSERT_COST_FAILED_ESTIMATED");
  });

  it("avbrutt før et begrenset retry: første forsøk er bokført normalt, og det aldri-startede retry-kallet får ikke et anslag", async () => {
    const ac = new AbortController();
    const { gateway, db } = build({
      anthropic: { streamScript: async () => { ac.abort(); return { text: "", usage: { input_tokens: 100, output_tokens: 2_000 }, provider: "anthropic", model: "claude-sonnet-5-5", finish_reason: "length" }; } }
    });
    db.spend.set("t1", SPENT.on_pace);
    await expect(gateway.stream(ownerTurn({ provider: "anthropic", request }), () => undefined, ac.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(db.costRows.filter((r) => r.provider === "anthropic")).toHaveLength(1); // første (avkortede) forsøk, bokført etter faktisk bruk
    expect(db.failedRows.map((r) => r.amount_ore)).toEqual([0]); // avbrutt før retry: ingen kall ble sendt
  });
});

describe("L7: én eiertur ved hard stopp telles ÉN gang - første forsøk (hard preferanse) + D-354-fallbacken er samme avviste kall", () => {
  const chatAttempt = (extra: Partial<CompleteInput> = {}) => ownerTurn({ mode: "AUTO", providerPreference: ["anthropic"], preferenceFailover: true, ...extra });

  it("første forsøk feiler med provider_preference_exhausted, fallbacken (uten preferanse) går lokalt: ÉN revisjonsrad og ÉN lesing - ikke to", async () => {
    const { gateway, db, anthropic, local, budgetSpans } = build();
    db.spend.set("t1", SPENT.exhausted);
    const err = await gateway.complete(chatAttempt()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("provider_preference_exhausted");
    const fallback = await gateway.complete(ownerTurn()); // slik samtalemotoren kjører den (D-354): samme økt og formål, uten preferanse
    expect(fallback.provider).toBe("gemma_local");
    expect(fallback.metadata?.["claude_budget"]).toMatchObject({ action: "deny", constraint: "closed", reason: "exhausted_closed" });
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ decision: "deny", reason: "exhausted_closed" });
    expect(db.spendReads).toBe(1);
    expect(anthropic.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(1);
    expect(budgetSpans().map((s) => s.metadata?.["round_rule"] ?? null)).toEqual([null, "retry_of_closed"]); // sporet viser begge, revisjonen (tellerne) kun den første
  });

  it("merket gjelder KUN det neste kallet fra samme tenant/økt/formål innen 10 s: et senere, uavhengig kall (eller en annen økt) vurderes og telles på nytt", async () => {
    const { gateway, db, clock } = build();
    db.spend.set("t1", SPENT.exhausted);
    await gateway.complete(chatAttempt()).catch(() => undefined);
    await gateway.complete(ownerTurn()); // fallbacken: ikke telt på nytt
    expect(db.audit).toHaveLength(1);
    await gateway.complete(ownerTurn()); // en NY tur (merket er brukt opp): vurdert og telt
    expect(db.audit).toHaveLength(2);
    await gateway.complete(chatAttempt()).catch(() => undefined); // nytt forsøk (telt) - merket står igjen for økta s1
    expect(db.audit).toHaveLength(3);
    await gateway.complete(ownerTurn({ session_id: "s-annen" })); // annen økt: egen beslutning (telt), merket til s1 er urørt
    expect(db.audit).toHaveLength(4);
    clock.now += 10_001; // merket til s1 er utløpt: neste kall er en vanlig, ny beslutning
    await gateway.complete(ownerTurn());
    expect(db.audit).toHaveLength(5);
  });

  it("merket kan aldri ÅPNE noe: en lukket beslutning gjenbrukes bare (aldri over fornyelsen), og et kall med et annet formål får ikke merket", async () => {
    const { gateway, db, clock } = build({ now: START_OF_PERIOD + 30 * 86_400_000 - 2_000 });
    db.spend.set("t1", SPENT.exhausted);
    await gateway.complete(chatAttempt()).catch(() => undefined);
    db.spend.set("t1", 0); // ny periode har ingenting brukt
    clock.now += 3_000; // over fornyelsen: merket gjelder ikke den nye perioden
    expect((await gateway.complete(ownerTurn())).provider).toBe("anthropic");
    const other = build();
    other.db.spend.set("t1", SPENT.exhausted);
    await other.gateway.complete(chatAttempt()).catch(() => undefined);
    await other.gateway.complete(ownerTurn({ purpose: "SUMMARIZE" })); // annet formål: egen beslutning
    expect(other.db.audit).toHaveLength(2);
  });
});

describe("L6: revisjonsraden tilskrives kallets EGEN person (økt → jobb), og eieren kun for systemkall i eierens tenant", () => {
  it("økt kjent: personen som eier økta - også for en annen tenant enn eierens (ikke eierens person_id for alle)", async () => {
    const { gateway, db } = build({ ownerTenantId: "t1" });
    db.spend.set("t2", SPENT.exhausted);
    db.sessionPersons.set("s-x", "person-x");
    await gateway.complete(ownerTurn({ tenant_id: "t2", session_id: "s-x" }));
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ tenant_id: "t2", person_id: "person-x", session_id: "s-x", reason: "exhausted_closed" });
    expect(db.statements).toContain("LOOKUP_SESSION");
  });

  it("jobb kjent (ingen økt): jobbens eier", async () => {
    const { gateway, db } = build({ ownerTenantId: "t1" });
    db.spend.set("t2", SPENT.tight);
    db.taskOwners.set("job-9", "person-job-owner");
    await gateway.complete(background({ tenant_id: "t2", task_id: "job-9" }));
    expect(db.audit[0]).toMatchObject({ tenant_id: "t2", person_id: "person-job-owner", task_id: "job-9", reason: "tight_background_deferred" });
    expect(db.statements).not.toContain("LOOKUP_SESSION");
    expect(db.statements).toContain("LOOKUP_TASK");
  });

  it("økt og jobb: økta vinner; ukjent økt-id faller til jobben", async () => {
    const { gateway, db } = build({ ownerTenantId: "t1" });
    db.spend.set("t2", SPENT.tight);
    db.sessionPersons.set("s-1", "person-session");
    db.taskOwners.set("job-1", "person-job");
    await gateway.complete(background({ tenant_id: "t2", task_id: "job-1", session_id: "s-1" }));
    await gateway.complete(background({ tenant_id: "t2", task_id: "job-1", session_id: "s-finnes-ikke" }));
    expect(db.audit.map((a) => a.person_id)).toEqual(["person-session", "person-job"]);
  });

  it("systemkall (hverken økt eller jobb kjent): eierens person i EIERENS tenant, `system` i alle andre - aldri en fabrikkert person", async () => {
    const { gateway, db } = build({ ownerTenantId: "t1" });
    db.spend.set("t1", SPENT.tight);
    db.spend.set("t2", SPENT.tight);
    await gateway.complete(background({ tenant_id: "t1", task_id: "job-ukjent" }));
    await gateway.complete(background({ tenant_id: "t2", task_id: "job-ukjent" }));
    expect(db.audit.map((a) => [a.tenant_id, a.person_id])).toEqual([["t1", "owner-1"], ["t2", "system"]]);
  });

  it("uten oppgitt eier-tenant (som før): systemkall tilskrives eieren; en lesefeil i oppslaget stopper aldri modellkallet (telles i logFailures)", async () => {
    const { gateway, db } = build();
    db.spend.set("t2", SPENT.tight);
    await gateway.complete(background({ tenant_id: "t2", task_id: "job-x" }));
    expect(db.audit[0]?.person_id).toBe("owner-1");
  });
});

describe("M3: criticens kostnad ses av overlegget (billetten følger med criticen)", () => {
  it("en åpen tur med critic på Anthropic: criticens bokførte kostnad teller i bufferen - neste Anthropic-kall ved kanten stenges i stedet for å slippe gjennom på en gammel buffer", async () => {
    const usage = { input_tokens: 2_000, output_tokens: 3_000 }; // 36 øre per kall
    const { gateway, db, config, anthropic } = build({ anthropic: { usage } });
    db.spend.set("t1", config.budget_ore - 30);
    // primærkallet går lokalt (eksplisitt valg), criticen velger Anthropic (QUALITY, åpen billett): 36 øre bokføres
    const first = await gateway.complete(ownerTurn({ provider: "gemma_local", critic: true }));
    expect((first.metadata?.["critic"] as { provider?: string } | undefined)?.provider).toBe("anthropic");
    expect(anthropic.calls).toHaveLength(1);
    const next = await gateway.complete(ownerTurn());
    expect(next.provider).toBe("gemma_local"); // oppbrukt (30 øre igjen, 36 brukt av criticen) - uten overlegg ville bufferen sagt «på tempo» og sluppet kallet til Anthropic
    expect(anthropic.calls).toHaveLength(1);
  });
});
