import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECTOR_REGISTRY } from "@jarvis/tool-gateway";
import {
  MODEL_FREEZE_PREFIX, createProviderPauseSource, modelFreezeTarget, pausedProvidersFrom, providerCredentialRefs, providerOfFreezeTarget
} from "../src/provider-pause.ts";

/**
 * WP-H0 / JARVIS-087: eierens pause/tilbakekall av en modellleverandør gjenbruker de EKSISTERENDE eierbryterne (`freeze_connector` med målet `model:<leverandør>`, `revoke_credential` på leverandørens nøkkel).
 *  1. ren avledning: hvilke leverandører er pauset gitt frosne mål og tilbakekalte nøkler (verktøyfrys rører aldri en modell, ugyldige mål ignoreres);
 *  2. nøkkelkartet speiler adapterne (drift-test mot kildekoden) og connector-registeret;
 *  3. kilden feiler høyt (gatewayen feiler lukket) i stedet for å svelge en lesefeil;
 *  4. KILDEVAKT: hver `new ModelGateway(` i api-koden har `providerPause`, så en ny gateway aldri stille hopper over eierens stopp.
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SRC = resolve(import.meta.dirname, "../src");

describe("frys-målet for en modellleverandør", () => {
  it("model:<navn> gir leverandørnavnet; alt annet (verktøy-id, tomt, store bokstaver, sti, mellomrom, for langt) er ikke en modellpause", () => {
    expect(modelFreezeTarget("anthropic")).toBe("model:anthropic");
    expect(MODEL_FREEZE_PREFIX).toBe("model:");
    expect(providerOfFreezeTarget("model:anthropic")).toBe("anthropic");
    expect(providerOfFreezeTarget("model:gemma_local")).toBe("gemma_local");
    for (const bad of ["github", "model:", "model:Anthropic", "model:../etc", "model:a b", "model:a:b", `model:${"x".repeat(41)}`, "MODEL:anthropic", " model:anthropic", "models:anthropic", ""]) {
      expect(providerOfFreezeTarget(bad), bad).toBeNull();
    }
  });
});

describe("pausedProvidersFrom", () => {
  it("frosne model:-mål pauser leverandøren; et frosset VERKTØY (github) og ukjente mål pauser ingen modell", () => {
    expect([...pausedProvidersFrom(["model:anthropic", "github", "email", "model:", "model:BAD"], [])]).toEqual(["anthropic"]);
    expect(pausedProvidersFrom([], []).size).toBe(0);
  });

  it("tilbakekalt nøkkel pauser leverandørene som bruker den - også de som deler nøkkel (GEMINI_API_KEY → gemini OG gemma_hosted)", () => {
    expect([...pausedProvidersFrom([], ["ANTHROPIC_API_KEY"])]).toEqual(["anthropic"]);
    expect([...pausedProvidersFrom([], ["OPENAI_API_KEY"])]).toEqual(["openai"]);
    expect([...pausedProvidersFrom([], ["GEMINI_API_KEY"])].sort()).toEqual(["gemini", "gemma_hosted"]);
    expect([...pausedProvidersFrom([], ["GEMMA_API_KEY"])]).toEqual(["gemma_hosted"]);
    expect([...pausedProvidersFrom([], ["MOONSHOT_API_KEY"])]).toEqual(["kimi"]);
    expect([...pausedProvidersFrom([], ["NOUS_API_KEY"])]).toEqual(["hermes"]);
  });

  it("andre tilbakekalte nøkler (GitHub, e-post, intern fellesref) og lokale leverandører berøres ikke", () => {
    expect(pausedProvidersFrom([], ["GITHUB_TOKEN", "JARVIS_EMAIL_TOKEN", "JARVIS_BUSINESS_INTERNAL_TOKEN", "NO_SUCH_REF"]).size).toBe(0);
    const refs = providerCredentialRefs();
    for (const local of ["gemma_local", "local_llm", "ollama", "scripted"]) expect(refs.has(local), local).toBe(false);
  });

  it("frys og tilbakekall slås sammen uten duplikater", () => {
    expect([...pausedProvidersFrom(["model:anthropic", "model:openai"], ["ANTHROPIC_API_KEY"])].sort()).toEqual(["anthropic", "openai"]);
  });
});

describe("nøkkelkartet", () => {
  const ADAPTER_FILE: Record<string, string> = {
    anthropic: "anthropic.ts", openai: "openai.ts", gemini: "gemini.ts", gemma_hosted: "gemma.ts", kimi: "kimi.ts", hermes: "hermes.ts"
  };

  it("modellleverandørene i connector-registeret er med, med registerets egne credential-refs (én kilde)", () => {
    const map = providerCredentialRefs();
    for (const def of CONNECTOR_REGISTRY.filter((c) => c.category === "model_provider")) {
      expect(map.get(def.id), def.id).toEqual(def.credential_refs);
    }
  });

  it("DRIFT: hver credential-ref i kartet står i kildekoden til adapteren som bruker den (en ref som ikke lenger leses stanser ingenting)", () => {
    for (const [provider, refs] of providerCredentialRefs()) {
      const file = ADAPTER_FILE[provider];
      expect(file, `ingen adapterfil kjent for ${provider}`).toBeDefined();
      const path = resolve(REPO_ROOT, "packages/provider-adapters/src", file as string);
      expect(existsSync(path), path).toBe(true);
      const source = readFileSync(path, "utf8");
      for (const ref of refs) expect(source, `${provider}:${ref}`).toContain(`"${ref}"`);
    }
  });

  it("DRIFT: hver adapter som leser en API-nøkkel fra miljøet har en oppføring (ingen leverandør kan ha en nøkkel eieren ikke kan tilbakekalle)", () => {
    const map = providerCredentialRefs();
    const withKey = Object.keys(ADAPTER_FILE);
    for (const provider of withKey) expect(map.has(provider), provider).toBe(true);
  });
});

describe("createProviderPauseSource", () => {
  it("leser frosne mål og tilbakekalte nøkler ved HVERT kall (ingen cache)", async () => {
    let frozen = [{ connector_id: "model:anthropic" }];
    let calls = 0;
    const source = createProviderPauseSource({
      listFrozenConnectorsDurable: async () => { calls += 1; return frozen; },
      listRevokedCredentialsDurable: async () => []
    });
    expect([...(await source.pausedProviders())]).toEqual(["anthropic"]);
    frozen = [];
    expect((await source.pausedProviders()).size).toBe(0);
    expect(calls).toBe(2);
  });

  it("en lesefeil kastes videre (gatewayen avgjør fail-closed) - kilden svelger den aldri som «ingen er pauset»", async () => {
    const source = createProviderPauseSource({
      listFrozenConnectorsDurable: async () => { throw new Error("db nede"); },
      listRevokedCredentialsDurable: async () => []
    });
    await expect(source.pausedProviders()).rejects.toThrow("db nede");
    const other = createProviderPauseSource({
      listFrozenConnectorsDurable: async () => [],
      listRevokedCredentialsDurable: async () => { throw new Error("db nede"); }
    });
    await expect(other.pausedProviders()).rejects.toThrow("db nede");
  });
});

describe("KILDEVAKT: hver ModelGateway i api-koden kjenner eierens pause", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(resolve(dir, e.name)) : e.name.endsWith(".ts") ? [resolve(dir, e.name)] : []));
  }

  /** Argumenttekst til `new ModelGateway(` ... matchende `)` (brace-/paren-telling; strenger med parenteser i kommentarer er ikke et problem her fordi vi teller kun i kall-argumentet). */
  function gatewayArguments(text: string): string[] {
    const out: string[] = [];
    let from = 0;
    for (;;) {
      const at = text.indexOf("new ModelGateway(", from);
      if (at === -1) return out;
      let depth = 0;
      let i = at + "new ModelGateway".length;
      const start = i;
      for (; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "(") depth += 1;
        else if (ch === ")") { depth -= 1; if (depth === 0) break; }
      }
      out.push(text.slice(start, i + 1));
      from = i;
    }
  }

  it("alle `new ModelGateway(` i apps/api/src har providerPause satt til poolbasert kilde", () => {
    const found: Array<{ file: string; args: string }> = [];
    for (const file of sources(SRC)) for (const args of gatewayArguments(readFileSync(file, "utf8"))) found.push({ file: file.replace(SRC, "src"), args });
    expect(found.map((f) => f.file).sort()).toEqual(["src/main.ts", "src/worker-main.ts"]);
    for (const { file, args } of found) {
      expect(args, file).toContain("providerPause: createProviderPauseSourceFromPool(pool)");
    }
  });

  it("begge prosessene importerer kilden fra provider-pause.ts", () => {
    for (const f of ["main.ts", "worker-main.ts"]) {
      expect(readFileSync(resolve(SRC, f), "utf8"), f).toContain('import { createProviderPauseSourceFromPool } from "./provider-pause.ts";');
    }
  });
});
