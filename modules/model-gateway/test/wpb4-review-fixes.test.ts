import { describe, expect, it, vi } from "vitest";
import type { ModelRequest, ToolCallRequest, ToolExchange } from "@jarvis/provider-adapters";
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

  it("en nedgradert tur fortsetter på den billigere modellen i neste runde (billetten bæres gjennom løkka, ikke overstyrt til dyr modell)", async () => {
    const { gateway, db, anthropic } = build({ anthropic: { script: toolThenAnswer("anthropic", HAIKU) } });
    db.spend.set("t1", SPENT.ahead);
    const result = await gateway.completeWithTools(background(), { tools: [ECHO_TOOL], executor: executor() });
    expect(result.provider).toBe("anthropic");
    expect([...anthropic.calls, ...anthropic.streamCalls].map((c) => c.model)).toEqual([HAIKU, HAIKU]);
  });

  it("fortsettelse krever at en tidligere runde FAKTISK ble betjent av Anthropic: runde 1 betjent av lokal reserve (Anthropic feilet) gir en vanlig beslutning i runde 2", async () => {
    const { gateway, db, anthropic } = build({ anthropic: { fail: new Error("nede") }, local: { script: toolThenAnswer("gemma_local", "gemma-local") } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.spend.set("t1", SPENT.on_pace);
    let anthropicCallsAfterRound1 = -1;
    const result = await gateway.completeWithTools(ownerTurn(), {
      tools: [ECHO_TOOL],
      executor: executor(() => { anthropicCallsAfterRound1 = anthropic.calls.length; db.spend.set("t1", SPENT.exhausted); })
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
