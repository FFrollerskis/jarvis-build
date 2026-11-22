import { describe, expect, it, vi } from "vitest";
import { AiCouncil, type CompleteInput, type CouncilInput } from "../src/index.ts";
import { SPENT, build } from "./support/claude-budget-fakes.ts";

/**
 * WP-B4 (D-476): AI-rådet og Claude-kreditten. Brief: «rådsrunder» er bakgrunnsarbeid - men en EKSPLISITT bestilling («bruk AI-rådet») er en oppgave eieren bestilte (VIKTIG), mens den AUTOMATISKE triggeren
 * (høy-innvirkning-klassifisering, fem betalte kall + kritikk + syntese) er BAKGRUNN. Opphavs-hintet settes av rådet KUN når Claude-kreditten er på; uten den er innputtet til gatewayen byte-identisk med main.
 * Rådet kjøres her mot scriptede adaptere som ikke leverer gyldig JSON - det er kallene INN til gatewayen (og beslutningen de får) som testes, ikke rådets protokoll (se `council.test.ts`).
 */
const RUN: Omit<CouncilInput, "trigger"> = { tenant_id: "t1", session_id: "s1", decision_context: "Skal vi velge A eller B?", members: ["anthropic", "gemma_local"] };
const explicit = { trigger_source: "explicit_user" as const };
const automatic = { trigger_source: "high_impact_classifier" as const };

async function runCouncil(council: AiCouncil, input: CouncilInput): Promise<void> {
  await council.run(input).catch(() => undefined); // adapterne gir ikke gyldig JSON - rådet feiler lukket, og det er greit her
}

describe("opphavet til rådets modellkall (Claude-kreditten på)", () => {
  it("eksplisitt bestilling = bestilt oppgave (VIKTIG); automatisk trigger og ingen trigger = BAKGRUNN - sporet viser opphavet for hvert medlemskall", async () => {
    for (const [trigger, origin, tier] of [[explicit, "owner_task", "important"], [automatic, "background", "background"], [undefined, "background", "background"]] as const) {
      const { gateway, budgetSpans } = build();
      await runCouncil(new AiCouncil(gateway), { ...RUN, ...(trigger !== undefined ? { trigger } : {}) });
      const spans = budgetSpans();
      expect(spans.length, String(trigger?.trigger_source)).toBeGreaterThan(0);
      for (const span of spans) expect(span.metadata, String(trigger?.trigger_source)).toMatchObject({ origin, tier });
    }
  });

  it("når det er STRAMT: det bestilte rådet får bruke Anthropic, det automatiske rådet får ikke (medlemmet feiler lukket - eksplisitt valg omrutes aldri stille)", async () => {
    const ordered = build();
    ordered.db.spend.set("t1", SPENT.tight);
    await runCouncil(new AiCouncil(ordered.gateway), { ...RUN, trigger: explicit });
    expect(ordered.anthropic.calls.length).toBeGreaterThan(0);

    const auto = build();
    auto.db.spend.set("t1", SPENT.tight);
    await runCouncil(new AiCouncil(auto.gateway), { ...RUN, trigger: automatic });
    expect(auto.anthropic.calls).toHaveLength(0);
    expect(auto.db.audit.map((a) => a.reason)).toContain("tight_background_deferred");
  });

  it("når kreditten er OPPBRUKT får heller ikke det bestilte rådet noe Anthropic-kall (hard stopp), men de lokale medlemmene fortsetter", async () => {
    const { gateway, db, anthropic, local } = build();
    db.spend.set("t1", SPENT.exhausted);
    await runCouncil(new AiCouncil(gateway), { ...RUN, trigger: explicit });
    expect(anthropic.calls).toHaveLength(0);
    expect(local.calls.length).toBeGreaterThan(0);
  });
});

describe("flagg AV: rådets innputt til gatewayen er uendret", () => {
  it("ingen `budget_origin` i noe av kallene (hverken runde 1, kritikk, revisjon eller syntese), og ingen spor/revisjon fra kreditten", async () => {
    const { gateway, budgetSpans, db } = build({ flag: false });
    const spy = vi.spyOn(gateway, "complete");
    await runCouncil(new AiCouncil(gateway), { ...RUN, trigger: explicit });
    expect(spy).toHaveBeenCalled();
    const inputs = spy.mock.calls.map((c) => c[0] as CompleteInput);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect("budget_origin" in input, JSON.stringify(Object.keys(input))).toBe(false);
    expect(budgetSpans()).toHaveLength(0);
    expect(db.audit).toHaveLength(0);
  });

  it("selve gatewayen sier `claudeBudgetActive` = false uten flagget og true med", () => {
    expect(build({ flag: false }).gateway.claudeBudgetActive).toBe(false);
    expect(build().gateway.claudeBudgetActive).toBe(true);
  });
});
