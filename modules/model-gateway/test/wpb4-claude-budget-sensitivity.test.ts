import { describe, expect, it } from "vitest";
import { ProviderError } from "@jarvis/provider-adapters";
import { ClaudeBudgetBlockedError, ClaudeBudgetEnforcer, MemoryTraceSink, ModelGateway, NoEligibleProviderError, PaidModelsDisabledError, claudeBudgetConfigFromEnv } from "../src/index.ts";
import { FakeDb, MID, SPENT, adapter, build, ownerTurn } from "./support/claude-budget-fakes.ts";

/**
 * WP-B4 (D-476): SENSITIVITET GÅR ALLTID FØR KREDITTEN. Kreditten kan bare SNEVRE INN Anthropic (billigere modell, stengt) - den kan aldri åpne noe sensitivitetsreglene, «betalte modeller av», eierens
 * utelukkelser eller eierens pause har stengt, heller ikke når kreditten selv sier «tillat» (på tempo, eller oppbrukt med eierens override `JARVIS_CLAUDE_BUDGET_HARD_STOP=off`). Testene kjører HELE gatewayen
 * (ekte ruter) på alle nivåer.
 */
const LEVELS: ReadonlyArray<readonly [string, number, Record<string, string>]> = [
  ["på tempo", SPENT.on_pace, {}],
  ["foran tempo", SPENT.ahead, {}],
  ["stramt", SPENT.tight, {}],
  ["inne i reserven", SPENT.reserve, {}],
  ["oppbrukt, hard stopp PÅ", SPENT.exhausted, {}],
  ["oppbrukt, hard stopp AV (kreditten sier «tillat»)", SPENT.exhausted, { JARVIS_CLAUDE_BUDGET_HARD_STOP: "off" }]
];

describe("sensitivitet før kreditt: kreditten kan aldri åpne det sensitiviteten har stengt", () => {
  it("SECRET_RESTRICTED forblir på lokal modell på ALLE nivåer - Anthropic får aldri ett kall, og forbruket leses ikke engang (kallet kan ikke nå Anthropic)", async () => {
    for (const [label, spent, env] of LEVELS) {
      const { gateway, db, anthropic, local } = build({ env });
      db.spend.set("t1", spent);
      const result = await gateway.complete(ownerTurn({ sensitivity: "SECRET_RESTRICTED", mode: "AUTO" }));
      expect(result.provider, label).toBe("gemma_local");
      expect(anthropic.calls, label).toHaveLength(0);
      expect(local.calls, label).toHaveLength(1);
      expect(db.spendReads, label).toBe(0);
    }
  });

  it("uten lokal modell er kreditten ikke «snill»: SECRET_RESTRICTED med KUN Anthropic gir ruterens egen feil (aldri ClaudeBudgetBlockedError, aldri et Anthropic-kall) på alle nivåer, også når kreditten ellers ville sluppet Anthropic gjennom", async () => {
    for (const [label, spent, env] of LEVELS) {
      const { gateway, db, anthropic } = build({ providers: ["anthropic"], env });
      db.spend.set("t1", spent);
      const err = await gateway.complete(ownerTurn({ sensitivity: "SECRET_RESTRICTED", mode: "AUTO" })).catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(NoEligibleProviderError);
      expect(err, label).not.toBeInstanceOf(ClaudeBudgetBlockedError);
      expect(anthropic.calls, label).toHaveLength(0);
    }
  });

  it("betalte modeller av (paid_models_allowed=false) med KUN Anthropic: ruterens PaidModelsDisabledError på alle nivåer - kreditten åpner ikke en betalt modell eieren har slått av", async () => {
    for (const [label, spent, env] of LEVELS) {
      const { gateway, db, anthropic } = build({ providers: ["anthropic"], env });
      db.spend.set("t1", spent);
      const err = await gateway.complete(ownerTurn({ paid_models_allowed: false })).catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(PaidModelsDisabledError);
      expect(anthropic.calls, label).toHaveLength(0);
    }
  });

  it("eierens utelukkelse (excludeProviders: anthropic) står også når kreditten sier «tillat»: kallet går lokalt, Anthropic får ikke ett kall", async () => {
    for (const [label, spent, env] of LEVELS) {
      const { gateway, db, anthropic } = build({ env });
      db.spend.set("t1", spent);
      const result = await gateway.complete(ownerTurn({ excludeProviders: ["anthropic"] }));
      expect(result.provider, label).toBe("gemma_local");
      expect(anthropic.calls, label).toHaveLength(0);
    }
  });

  it("eierens pause av Anthropic står foran kreditten: et eksplisitt valg av pauset Anthropic gir pause-feilen (aldri en kreditt-melding), og uten eksplisitt valg går kallet lokalt uten at forbruket leses", async () => {
    for (const [label, spent, env] of LEVELS) {
      const db = new FakeDb();
      db.spend.set("t1", spent);
      const trace = new MemoryTraceSink();
      const config = claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100", ...env });
      if (config === null) throw new Error("test-oppsett");
      const enforcer = new ClaudeBudgetEnforcer({ config, pool: db.pool(), trace, actor_person_id: "owner-1", now: () => MID });
      const anthropic = adapter("anthropic", "claude-sonnet-5-5", { withStream: true });
      const local = adapter("gemma_local", "gemma-local");
      const gateway = new ModelGateway({
        pool: db.pool(), trace, providers: [anthropic, local], claudeBudget: enforcer, providerPause: { pausedProviders: async () => new Set(["anthropic"]) }
      });
      const explicit = await gateway.complete(ownerTurn({ provider: "anthropic" })).catch((e: unknown) => e);
      expect(explicit, label).toBeInstanceOf(ProviderError);
      expect((explicit as Error).message, label).toContain("anthropic_paused_by_owner");
      expect(explicit, label).not.toBeInstanceOf(ClaudeBudgetBlockedError);
      const plain = await gateway.complete(ownerTurn());
      expect(plain.provider, label).toBe("gemma_local");
      expect(anthropic.calls, label).toHaveLength(0);
      expect(db.spendReads, label).toBe(0);
    }
  });
});
