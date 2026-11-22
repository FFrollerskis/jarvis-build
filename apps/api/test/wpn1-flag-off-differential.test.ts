import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runScenario, type ChannelName, type Observation } from "./support/n1-engine-harness.ts";
import { SCENARIOS } from "./support/n1-scenarios.ts";

/**
 * WP-N1 (K5/K7a): FLAGG AV ER IDENTISK MED MAIN - differensialtest av samtalemotoren, begge flater (web og tale).
 *
 * Hvert scenario (historikk x spørsmål, hurtigbane, råd, ruteoverstyring, feilbaner, minnevarianter ...) kjøres gjennom `ConversationEngine` med falske modeller, og ALT som kan observeres utenfra sammenlignes med en
 * BASELINE generert fra en REN kopi av `origin/main`: hvert modellkall (sensitivitet, leverandørpreferanse, modell, meldinger, verktøy), hver lagrede rad (rolle, innhold og ANTALL argumenter til `messages.save` - main kaller
 * alltid med tre), kall til `markRestricted` (main har ingen), svaret og strømmede tokens, rådets sensitivitet, bakgrunnsjobbens skyflagg, minneuttrekkets siste turer og loggede hendelser. Historikkene bærer også
 * `restricted: true`-merker på nøytral tekst (slik en tidligere periode med flagget PÅ kunne etterlatt dem): med flagget AV skal de være HELT usynlige.
 *
 * Fixturen (`fixtures/wpn1-main-engine-baseline.json`) er generert slik (kun ved bevisst regenerering mot en ny main - scenariosettet er KILDEN, legg nye scenarier i `support/n1-scenarios.ts`):
 *   1. `git archive origin/main | tar -x -C <ny katalog>`; lenk rot-`node_modules` til dette treets, og kopier hver pakkes `node_modules` med `cp -a` (relative lenker, så `@jarvis/*` peker på kopiens egne kilder),
 *   2. kopier `apps/api/test/support/n1-engine-harness.ts` og `n1-scenarios.ts` UENDRET inn i kopien (de bruker kun API-er som finnes på main),
 *   3. kjør en engangs-test i kopien som kaller `runScenario(s, "web")` og `runScenario(s, "voice")` for hvert `SCENARIOS`-element og skriver `{ baseline, baseline_sha, scenarios: [{ id, web, voice }] }`.
 * Baseline er festet til main-commit i `baseline_sha`. En LEGITIM atferdsendring i motoren fra en senere WP gjør testen rød til fixturen regenereres etter punktene over - den skal aldri «oppdateres blindt»: diffen under viser nøyaktig hva som endret seg.
 */
interface Baseline { baseline: string; baseline_sha: string; scenarios: Array<{ id: string; web: Observation; voice: Observation }> }
const baseline = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/wpn1-main-engine-baseline.json", import.meta.url)), "utf8")) as Baseline;
const byId = new Map(baseline.scenarios.map((s) => [s.id, s]));
const CHANNELS: ChannelName[] = ["web", "voice"];

afterEach(() => vi.restoreAllMocks());

describe("fixturen (generert fra en ren origin/main)", () => {
  it("peker på en eksakt main-commit, dekker alle scenarier på begge flater, og scenariosettet er stort nok (minst 60 historier/fraser)", () => {
    expect(baseline.baseline).toBe("origin/main");
    expect(baseline.baseline_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(60);
    expect(baseline.scenarios.map((s) => s.id)).toEqual(SCENARIOS.map((s) => s.id));
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of baseline.scenarios) for (const channel of CHANNELS) expect(s[channel], `${s.id}/${channel}`).toBeDefined();
  });

  it("baseline viser at main ALDRI kaller markRestricted og alltid lagrer med nøyaktig tre argumenter (det er det flagg AV må gjenta)", () => {
    for (const s of baseline.scenarios) {
      for (const channel of CHANNELS) {
        const o = s[channel];
        expect(o.marks, `${s.id}/${channel}`).toBe(0);
        for (const row of o.saved) expect(row.argc, `${s.id}/${channel}`).toBe(3);
      }
    }
  });

  it("scenariosettet er ikke trivielt: begge sensitivitetsutfall, sky- og lokalruter, hurtigbane, råd, feilbaner og minst 20 scenarier med varianten uten tidligere meldinger eller låst tur", () => {
    const gateways = baseline.scenarios.flatMap((s) => CHANNELS.flatMap((c) => s[c].gateway));
    expect(new Set(gateways.map((g) => g.sensitivity))).toEqual(new Set(["PUBLIC_OR_LOW_SENSITIVITY", "PRIVATE", "BUSINESS_CONFIDENTIAL", "SECRET_RESTRICTED"]));
    expect(gateways.some((g) => g.preference?.[0] === "anthropic")).toBe(true);
    expect(gateways.some((g) => g.preference?.[0] === "gemma_local")).toBe(true);
    const routed = new Set(baseline.scenarios.flatMap((s) => CHANNELS.map((c) => ("routed" in s[c].result ? s[c].result.routed : "thrown"))));
    expect([...routed].sort()).toEqual(["blocked", "fast", "model", "thrown"]);
    const logs = new Set(baseline.scenarios.flatMap((s) => CHANNELS.flatMap((c) => s[c].logs)));
    for (const msg of ["q51_cloud_variant_without_sensitive_messages", "d447_tool_turn_local_sensitivity", "d431_cloud_tools_failed_fallback_local", "d432_tool_turn_day_cap_reached", "d380_local_model_rejected_tools_fallback", "d449_fast_delegate_local"]) {
      expect(logs.has(msg), msg).toBe(true);
    }
    const locked = baseline.scenarios.filter((s) => CHANNELS.some((c) => s[c].gateway.some((g) => g.sensitivity === "SECRET_RESTRICTED") || s[c].logs.includes("q51_cloud_variant_without_sensitive_messages")));
    expect(locked.length).toBeGreaterThanOrEqual(20);
  });
});

describe("flagg AV er identisk med main", () => {
  for (const [name, guard] of [["flagget utelatt (slik main.ts gjør det med flagget AV)", undefined], ["restrictedContextGuard: false", "explicit-false" as const]] as const) {
    it(`${name}: hvert scenario x begge flater gir NØYAKTIG samme observasjon som main (modellkall, lagring, svar, logger, minne, jobber, råd)`, async () => {
      const diffs: string[] = [];
      let compared = 0;
      for (const scenario of SCENARIOS) {
        const want = byId.get(scenario.id)!;
        for (const channel of CHANNELS) {
          const got = await runScenario(scenario, channel, guard === undefined ? {} : { guard });
          compared += 1;
          if (JSON.stringify(got) !== JSON.stringify(want[channel])) diffs.push(`${scenario.id}/${channel}: ${firstDifference(got, want[channel])}`);
        }
      }
      expect(compared).toBe(SCENARIOS.length * 2);
      expect(diffs).toEqual([]);
    });
  }
});

describe("kontrolltest: sammenligningen er ikke tom (den oppdager en forskjell når den finnes)", () => {
  it("med flagget PÅ avviker minst 90 av observasjonene fra main (låste turer merkes og leser merker) - og scenariene med gamle merker er blant dem", async () => {
    const differing = new Set<string>();
    for (const scenario of SCENARIOS) {
      for (const channel of CHANNELS) {
        const got = await runScenario(scenario, channel, { guard: true });
        if (JSON.stringify(got) !== JSON.stringify(byId.get(scenario.id)![channel])) differing.add(`${scenario.id}/${channel}`);
      }
    }
    expect(differing.size).toBeGreaterThanOrEqual(90);
    for (const channel of CHANNELS) {
      expect(differing.has(`restricted_neutral_recent.github/${channel}`)).toBe(true);
      expect(differing.has(`empty.finance/${channel}`)).toBe(true);
      expect(differing.has(`fast.cost/${channel}`)).toBe(true);
    }
  });

  it("scenarier som ALDRI berører noe begrenset er identiske med main også med flagget PÅ (vakten endrer ikke vanlige turer)", async () => {
    for (const id of ["clean.github", "clean.plain", "clean.email", "empty.plain", "empty.github", "pr_then_clean.github", "fast.status", "fast.help", "fast.light", "council.explicit", "error.budget", "daycap.github"]) {
      const scenario = SCENARIOS.find((s) => s.id === id)!;
      for (const channel of CHANNELS) {
        const got = await runScenario(scenario, channel, { guard: true });
        // `rows_after`/`events` er like fordi ingenting merkes; kun én log-forskjell er mulig (ingen) - hele observasjonen skal være lik main.
        expect(JSON.stringify(got), `${id}/${channel}`).toBe(JSON.stringify(byId.get(id)![channel]));
      }
    }
  });
});

/** Første felt som skiller to observasjoner (for en lesbar feilmelding). */
function firstDifference(got: Observation, want: Observation): string {
  for (const key of Object.keys(want) as Array<keyof Observation>) {
    if (JSON.stringify(got[key]) !== JSON.stringify(want[key])) return `${key}: fikk ${JSON.stringify(got[key]).slice(0, 300)} - main ${JSON.stringify(want[key]).slice(0, 300)}`;
  }
  return "ukjent forskjell (nøkler)";
}
