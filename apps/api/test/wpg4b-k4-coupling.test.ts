import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { DEFAULT_PROFILES } from "@jarvis/model-gateway";
import type { AssistInput, ModelSignalAssist } from "@jarvis/situations";
import { LocalEndpointError, assertLocalEndpoint } from "../src/local-endpoint-guard.ts";
import { enforceLocalModelEndpoints } from "../src/local-model-endpoints.ts";
import { createSituationSignalsWiring, type SituationSignalsWiringDeps as WiringDeps } from "../src/situation-signals-wiring.ts";

/**
 * WP-G4b fiks-runde 1, FIX-4 / FIX-4b: K4-testhull som overlevde reviewernes mutanter.
 *  - K4-10: brukerinfo med KUN passord (`http://:pw@host`) er avvist (ikke bare brukernavn).
 *  - K4-17 / M49: `main.ts` kobler assist-vakten til den LEVENDE lokalitetsregelen (`financeLockServedLocally`), ikke en konstant.
 *  - M70: `createSituationSignalsWiring` gir `isLocalProvider` videre til `ModelSignalAssist` (en demotert leverandoer forkastes), og uten den er oppfoerselen uendret.
 */
const hoisted = vi.hoisted(() => ({ created: [] as Array<{ options: Record<string, unknown>; instance: unknown }> }));
vi.mock("@jarvis/situations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jarvis/situations")>();
  class RecordingAssist extends actual.ModelSignalAssist {
    constructor(options: ConstructorParameters<typeof actual.ModelSignalAssist>[0]) {
      super(options);
      hoisted.created.push({ options: options as unknown as Record<string, unknown>, instance: this });
    }
  }
  return { ...actual, ModelSignalAssist: RecordingAssist };
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ORIGINAL = new Map(DEFAULT_PROFILES.map((p) => [p.provider, p.locality] as const));
afterEach(() => { for (const p of DEFAULT_PROFILES) { const o = ORIGINAL.get(p.provider); if (o !== undefined) p.locality = o; } });

describe("K4-10: brukerinfo med kun passord er avvist (hele brukerinfo-feltet, ikke bare brukernavn)", () => {
  const CREDS = ["http://:pw@10.0.0.1:11434", "http://user:pw@10.0.0.1:11434", "http://user@10.0.0.1:11434", "http://:@10.0.0.1:11434x"];
  it("`assertLocalEndpoint`: passord-eneste, bruker+passord og bare bruker gir `local_url_credentials` (kun koden, aldri URL)", () => {
    for (const url of CREDS.slice(0, 3)) {
      let thrown: unknown;
      try { assertLocalEndpoint(url); } catch (err) { thrown = err; }
      expect(thrown, url).toBeInstanceOf(LocalEndpointError);
      expect((thrown as LocalEndpointError).code, url).toBe("local_url_credentials");
      expect((thrown as Error).message).not.toContain("pw");
    }
  });

  it("alle tre chat-identitetene: en passord-eneste URL demoterer identiteten med `local_url_credentials`", async () => {
    for (const [provider, envName] of [["local_llm", "LOCAL_LLM_BASE_URL"], ["gemma_local", "JARVIS_GEMMA_LOCAL_URL"], ["ollama", "JARVIS_OLLAMA_URL"]] as const) {
      const lines: Array<Record<string, unknown>> = [];
      const verdicts = await enforceLocalModelEndpoints({ JARVIS_LOCAL_MODEL_URL_GUARD: "on", [envName]: "http://:pw@192.168.1.5:11434" }, {
        lookup: async () => { throw new Error("skal ikke kalles"); }, profiles: DEFAULT_PROFILES.map((p) => ({ ...p })), log: (line) => lines.push(line)
      });
      expect(verdicts?.find((v) => v.identity === provider), provider).toEqual({ identity: provider, status: "demoted", code: "local_url_credentials" });
      expect(JSON.stringify(lines)).not.toContain("pw");
    }
  });
});

describe("K4-17 / M49: main.ts kobler assist-vakten til den LEVENDE lokalitetsregelen", () => {
  const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("`createSituationSignalsWiring({... isLocalProvider: (provider) => financeLockServedLocally({ provider, model: \"\" }) ...})`; importert fra restricted-context-guard (ingen egen kopi, ingen konstant)", () => {
    const main = strip(readFileSync(resolve(ROOT, "apps/api/src/main.ts"), "utf8"));
    const call = /createSituationSignalsWiring\(\{[\s\S]*?\}\);/.exec(main)?.[0] ?? "";
    expect(call).not.toBe("");
    expect(call).toMatch(/isLocalProvider:\s*\(provider\)\s*=>\s*financeLockServedLocally\(\{\s*provider,\s*model:\s*""\s*\}\)/);
    expect(main).toMatch(/import\s*\{[^}]*\bfinanceLockServedLocally\b[^}]*\}\s*from\s*"\.\/restricted-context-guard\.ts"/);
    // aldri en konstant/alltid-sann vakt
    expect(call).not.toMatch(/isLocalProvider:\s*\(\)\s*=>\s*(true|false)/);
  });

  it("kablingen sender `isLocalProvider` til `ModelSignalAssist` kun når den er gitt (strukturelt)", () => {
    const wiring = strip(readFileSync(resolve(ROOT, "apps/api/src/situation-signals-wiring.ts"), "utf8"));
    expect(wiring).toMatch(/new ModelSignalAssist\(\{\s*gateway:\s*deps\.modelGateway,\s*\.\.\.\(deps\.isLocalProvider !== undefined \? \{ isLocalProvider: deps\.isLocalProvider \} : \{\}\)\s*\}\)/);
  });
});

describe("M70: kablingen gir assist-vakten den levende lokaliteten (atferd)", () => {
  const OWNER = "person-owner";
  const ownerIdentity: IdentityContext = { person_id: OWNER, tenant_id: "t-owner", memory_space_id: "personal", session_id: "sess-api", device_id: "jarvis-core", channel: "api", auth_strength: "active" };
  const answer = JSON.stringify({ category: "attention", priority: "normal", explanation: "ok" });
  const input: AssistInput = { tenant_id: "t", memory_space: "home", rule_key: "vision:motion_detected", domain: "vision", priority: "low", facts: { event_type: "motion_detected", night: true }, detection_key: "k" };
  const deps = (over: Partial<WiringDeps>): WiringDeps => ({
    env: { JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_MODEL_ASSIST: "on" }, pool: {} as never, engine: {} as never, domainPauses: {} as never, gateway: {} as never,
    modelGateway: { complete: async () => ({ text: answer, provider: "gemma_local", model: "m" }) }, ownerIdentity, ownerTenant: "t-owner", ownerPersonId: OWNER,
    incidents: { listIncidents: async () => [] }, vision: { getRecentEvents: async () => [] }, health: { getRecentMetrics: async () => [] }, haTransport: { invoke: async () => ({}) },
    killSwitch: { isActiveDurable: async () => false }, now: () => Date.parse("2026-11-19T12:00:00.000Z"), ...over
  });
  const builtAssist = (): ModelSignalAssist => {
    expect(hoisted.created).toHaveLength(1);
    return hoisted.created[0]!.instance as ModelSignalAssist;
  };

  it("med `isLocalProvider`: en leverandoer som IKKE er lokal akkurat naa (demotert) forkastes for et begrenset domene; en lokal godtas", async () => {
    hoisted.created.length = 0;
    createSituationSignalsWiring(deps({ isLocalProvider: (provider) => provider !== "gemma_local" }));
    expect(hoisted.created[0]!.options["isLocalProvider"]).toBeTypeOf("function");
    expect(await builtAssist().assess(input)).toMatchObject({ status: "rejected", reason: "non_local_provider" });
    hoisted.created.length = 0;
    createSituationSignalsWiring(deps({ isLocalProvider: () => true }));
    expect(await builtAssist().assess(input)).toMatchObject({ status: "assessed" });
  });

  it("uten `isLocalProvider` er oppfoerselen uendret (kun navnelisten): ingen nøkkel sendes videre, og en listet leverandoer godtas", async () => {
    hoisted.created.length = 0;
    createSituationSignalsWiring(deps({}));
    expect(Object.keys(hoisted.created[0]!.options)).toEqual(["gateway"]);
    expect(await builtAssist().assess(input)).toMatchObject({ status: "assessed" });
  });

  it("modellassistanse AV (kun hovedbryteren): ingen assist bygges", () => {
    hoisted.created.length = 0;
    createSituationSignalsWiring(deps({ env: { JARVIS_SITUATION_SIGNALS: "on" } }));
    expect(hoisted.created).toHaveLength(0);
  });
});
