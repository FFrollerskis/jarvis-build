import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILES, type ModelProfile } from "@jarvis/model-gateway";
import { enforceLocalModelEndpoints } from "../src/local-model-endpoints.ts";

/**
 * WP-G4b fiks-runde 1, FIX-6 (review B L2): DNS kontrolleres kun ved oppstart, og et navn som IKKE kunne loeses ble tidligere beholdt som «lokalt» for hele prosessens levetid, selv om det senere kunne loese seg til en
 * offentlig adresse (resolver nede ved boot etter et stroembrudd). Valgt (a), den minste trygge: et uloest navn MED PUNKTUM (FQDN) er ikke bevist lokalt og DEMOTERES (`local_url_unresolved_fqdn`) for chat-identitetene
 * (`local_llm`/`gemma_local`/`ollama`). Et enkelt-label-navn (docker-tjeneste som ikke er oppe ennaa) kan aldri vaere offentlig og beholdes (som foer). Minnets embedding kan ikke demoteres til sky og stopper ikke API-et
 * for et uloest navn (en avslaatt PC med et `.lan`-navn skal ikke velte oppstarten): den beholdes med en advarsel (dokumentert hull i `not_covered`). Flagg AV = som main.
 */
const ORIGINAL = new Map(DEFAULT_PROFILES.map((p) => [p.provider, p.locality] as const));
afterEach(() => { for (const p of DEFAULT_PROFILES) { const o = ORIGINAL.get(p.provider); if (o !== undefined) p.locality = o; } });

const NOT_RESOLVING: Array<[string, (h: string) => Promise<ReadonlyArray<{ address: string }>>]> = [
  ["tomt svar", async () => []],
  ["ENOTFOUND", async () => { throw new Error("ENOTFOUND"); }],
  ["henger (tidsavbrudd)", () => new Promise<Array<{ address: string }>>(() => undefined)]
];
const run = async (env: Record<string, string>, lookup: (h: string) => Promise<ReadonlyArray<{ address: string }>>) => {
  const profiles: ModelProfile[] = DEFAULT_PROFILES.map((p) => ({ ...p }));
  const lines: Array<{ line: Record<string, unknown>; level: string }> = [];
  const verdicts = await enforceLocalModelEndpoints({ JARVIS_LOCAL_MODEL_URL_GUARD: "on", ...env }, { lookup, profiles, timeoutMs: 20, log: (line, level) => lines.push({ line, level }) });
  return { verdicts, profiles, lines };
};
const localityOf = (profiles: ModelProfile[], provider: string): string | undefined => profiles.find((p) => p.provider === provider)?.locality;
const CHAT = [["local_llm", "LOCAL_LLM_BASE_URL"], ["gemma_local", "JARVIS_GEMMA_LOCAL_URL"], ["ollama", "JARVIS_OLLAMA_URL"]] as const;

describe("uloest navn med punktum (FQDN) er ikke bevist lokalt: chat-identiteten demoteres", () => {
  for (const [label, lookup] of NOT_RESOLVING) {
    for (const [provider, envName] of CHAT) {
      it(`${provider} (${label}): http://gpu.lan -> demotert med local_url_unresolved_fqdn, profilen er sky`, async () => {
        const out = await run({ [envName]: "http://gpu.lan:11434" }, lookup);
        expect(out.verdicts?.find((v) => v.identity === provider)).toEqual({ identity: provider, status: "demoted", code: "local_url_unresolved_fqdn" });
        expect(localityOf(out.profiles, provider)).toBe("cloud");
        expect(out.lines.filter((l) => l.line["msg"] === "local_model_endpoint_demoted")).toEqual([{ line: { msg: "local_model_endpoint_demoted", identity: provider, code: "local_url_unresolved_fqdn" }, level: "warn" }]);
        expect(JSON.stringify(out.lines)).not.toContain("gpu.lan");
      });
    }
  }

  it("alle lokale suffikser og tailnet-navn (med flagget) er FQDN og demoteres naar de ikke loeses; host.docker.internal likesaa", async () => {
    for (const url of ["http://pc.lan", "http://nas.local", "http://gpu.internal", "http://x.home.arpa", "http://y.localdomain", "http://host.docker.internal:11434"]) {
      const out = await run({ JARVIS_GEMMA_LOCAL_URL: url }, async () => []);
      expect(out.verdicts?.find((v) => v.identity === "gemma_local"), url).toMatchObject({ status: "demoted", code: "local_url_unresolved_fqdn" });
    }
    const tailnet = await run({ JARVIS_GEMMA_LOCAL_URL: "http://pc.tail1234.ts.net:11434", JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE: "on" }, async () => []);
    expect(tailnet.verdicts?.find((v) => v.identity === "gemma_local")).toMatchObject({ status: "demoted", code: "local_url_unresolved_fqdn" });
  });
});

describe("det som IKKE endres", () => {
  it("enkelt-label-navn (docker-tjeneste) som ikke loeses beholdes og logges (kan aldri vaere offentlig)", async () => {
    for (const [, lookup] of NOT_RESOLVING) {
      const out = await run({ JARVIS_GEMMA_LOCAL_URL: "http://gpu-boks:11434" }, lookup);
      expect(out.verdicts?.find((v) => v.identity === "gemma_local")).toEqual({ identity: "gemma_local", status: "unresolved", code: null });
      expect(localityOf(out.profiles, "gemma_local")).toBe("local");
      expect(out.lines.some((l) => l.line["msg"] === "local_model_endpoint_unresolved" && l.level === "warn")).toBe(true);
    }
  });

  it("et FQDN som LOESES til en privat adresse er lokalt; til en offentlig er demotert som for (`local_url_resolves_nonlocal`); IP-literaler paavirkes ikke", async () => {
    expect((await run({ JARVIS_GEMMA_LOCAL_URL: "http://gpu.lan" }, async () => [{ address: "192.168.1.9" }])).verdicts?.find((v) => v.identity === "gemma_local")).toMatchObject({ status: "local", code: null });
    expect((await run({ JARVIS_GEMMA_LOCAL_URL: "http://gpu.lan" }, async () => [{ address: "93.184.216.34" }])).verdicts?.find((v) => v.identity === "gemma_local")).toMatchObject({ status: "demoted", code: "local_url_resolves_nonlocal" });
    const literal = await run({ JARVIS_GEMMA_LOCAL_URL: "http://192.168.1.9:11434" }, async () => { throw new Error("skal ikke kalles"); });
    expect(literal.verdicts?.find((v) => v.identity === "gemma_local")).toMatchObject({ status: "local" });
  });

  it("minnets embedding med et uloest FQDN stopper IKKE oppstarten: beholdt med advarsel (kan ikke demoteres; en avslaatt PC skal ikke velte API-et)", async () => {
    for (const [, lookup] of NOT_RESOLVING) {
      const out = await run({ JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_EMBEDDING_MODEL: "bge-m3", JARVIS_EMBEDDING_URL: "http://gpu.lan:11434" }, lookup);
      expect(out.verdicts?.find((v) => v.identity === "memory_embedding")).toEqual({ identity: "memory_embedding", status: "unresolved", code: null });
      expect(out.lines.some((l) => l.line["msg"] === "local_model_endpoint_unresolved" && l.line["identity"] === "memory_embedding")).toBe(true);
    }
  });

  it("flagg AV: ingenting skjer for et uloest FQDN (som main)", async () => {
    const lines: unknown[] = [];
    const out = await enforceLocalModelEndpoints({ JARVIS_GEMMA_LOCAL_URL: "http://gpu.lan" }, { lookup: async () => [], profiles: DEFAULT_PROFILES.map((p) => ({ ...p })), log: (l) => lines.push(l) });
    expect(out).toBeNull();
    expect(lines).toEqual([]);
  });
});
