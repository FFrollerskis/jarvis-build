import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { CapabilityRegistry, DEFAULT_PROFILES, MemoryTraceSink, ModelGateway, demoteLocalProfileToCloud, type CompleteInput, type ModelProfile } from "@jarvis/model-gateway";
import type { ModelProviderAdapter, ModelRequest, ModelResult } from "@jarvis/provider-adapters";
import { ModelSignalAssist, type AssistInput } from "@jarvis/situations";
// @ts-expect-error - ren .mjs uten typer (genererer compose-blokkene)
import { SERVICE_ENV } from "../../../infra/local/service-env.mjs";
import { cloudToolTurnsAllowed } from "../src/chat-jobs.ts";
import { servedByCloudModel } from "../src/cloud-tool-screen.ts";
import { isLocalAddress as visionIsLocalAddress } from "../src/vision-runtime.ts";
import { isLocalAddress } from "../src/local-endpoint-guard.ts";
import { LOCAL_MODEL_ENDPOINTS, enforceLocalModelEndpoints, parseLocalModelEndpointGuard } from "../src/local-model-endpoints.ts";
import { FINANCE_EXECUTION_LOCK, financeLockServedLocally, withholdsRestrictedJobFromCloud } from "../src/restricted-context-guard.ts";

/**
 * WP-G4b K4 (D-484, JARVIS-115 d): «lokal» modell er en `locality`-etikett. Med `JARVIS_LOCAL_MODEL_URL_GUARD=on` valideres URL-en til `gemma_local`/`local_llm`/`ollama` ved oppstart med G3-vakten (delt kode), og en ugyldig/offentlig
 * URL gjør identiteten IKKE-lokal PÅ SELVE profilen, slik at ALLE lokalitetsavgjørelser ser det (ruteren, gatewayens låser, den sentrale `financeLockServedLocally`, chat-jobbene, assist-vakten).
 *  A: flaggparseren (kun eksakt `on`).   B: vakten (URL-former, tailnet, DNS, fail-lukket, logg uten URL).   C: demoteringen flyter inn i HVER lokalitetsavgjørelse (mot den delte `DEFAULT_PROFILES`).
 *  D: struktur (api OG worker kaller vakten FØR gatewayen; flaggene leses kun i vaktfilen; miljø/compose).
 */
// Standard-lokalitet slik den står i `DEFAULT_PROFILES` ved import (FØR noen test demoterer). Tilbakestillingen finnes KUN her: produksjonskoden har bevisst ingen `cloud -> local`-funksjon.
const DEFAULT_LOCALITY = new Map(DEFAULT_PROFILES.map((profile) => [profile.provider, profile.locality] as const));
const resetProfileLocalityToDefaults = (): void => {
  for (const profile of DEFAULT_PROFILES) {
    const original = DEFAULT_LOCALITY.get(profile.provider);
    if (original !== undefined) profile.locality = original;
  }
};
// rekkefølgen er `LOCAL_MODEL_ENDPOINTS`
const NAMES = ["local_llm", "gemma_local", "ollama"];
const profilesCopy = (): ModelProfile[] => DEFAULT_PROFILES.map((profile) => ({ ...profile }));
const localityOf = (profiles: ModelProfile[], provider: string): string | undefined => profiles.find((p) => p.provider === provider)?.locality;
const noLookup = async (): Promise<Array<{ address: string }>> => { throw new Error("lookup skulle ikke vært kalt"); };
const on = { JARVIS_LOCAL_MODEL_URL_GUARD: "on" };
// Fiktiv, ikke leverandørformet «hemmelighet» (settes sammen ved kjøring) som skal være UMULIG å finne i logglinjene.
const SECRET = ["ikke", "en", "ekte", "verdi"].join("-");

describe("A: flaggparseren - kun den eksakte verdien `on`", () => {
  it("AV som standard; `true`/`1`/`ON`/mellomrom/tom er AV; flaggene er uavhengige", () => {
    expect(parseLocalModelEndpointGuard({})).toEqual({ enabled: false, allowTailscale: false });
    for (const v of ["true", "1", "ON", " on", "on ", "yes", "", "off"]) expect(parseLocalModelEndpointGuard({ JARVIS_LOCAL_MODEL_URL_GUARD: v, JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE: v }), JSON.stringify(v)).toEqual({ enabled: false, allowTailscale: false });
    expect(parseLocalModelEndpointGuard({ JARVIS_LOCAL_MODEL_URL_GUARD: "on" })).toEqual({ enabled: true, allowTailscale: false });
    expect(parseLocalModelEndpointGuard({ JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE: "on" })).toEqual({ enabled: false, allowTailscale: true });
  });
});

describe("B: enforceLocalModelEndpoints", () => {
  const run = async (env: Record<string, string>, over: { lookup?: (h: string) => Promise<Array<{ address: string }>>; timeoutMs?: number } = {}) => {
    const profiles = profilesCopy();
    const lines: Array<{ line: Record<string, unknown>; level: string }> = [];
    const verdicts = await enforceLocalModelEndpoints(env, { lookup: over.lookup ?? noLookup, profiles, ...(over.timeoutMs !== undefined ? { timeoutMs: over.timeoutMs } : {}), log: (line, level) => lines.push({ line, level }) });
    return { verdicts, profiles, lines };
  };
  const gemma = (url: string) => ({ ...on, JARVIS_GEMMA_LOCAL_URL: url });

  it("flagg AV = identisk med main: ingenting leses, ingenting endres, ingenting logges, ingen DNS", async () => {
    const out = await run({ JARVIS_GEMMA_LOCAL_URL: "http://evil.example.com:11434", LOCAL_LLM_BASE_URL: "http://8.8.8.8", JARVIS_OLLAMA_URL: "ftp://x" });
    expect(out.verdicts).toBeNull();
    expect(out.lines).toEqual([]);
    expect(out.profiles).toEqual(DEFAULT_PROFILES);
  });

  it("flagg PÅ uten konfigurerte URL-er: ingenting å validere (not_configured), ingenting demotert, én oppsummeringslinje", async () => {
    const out = await run(on);
    expect(out.verdicts).toEqual(NAMES.map((identity) => ({ identity, status: "not_configured", code: null })));
    expect(out.profiles).toEqual(DEFAULT_PROFILES);
    expect(out.lines.map((l) => l.line["msg"])).toEqual(["local_model_endpoint_guard"]);
  });

  it("gyldige lokale former beholder `local`: loopback, RFC 1918, localhost, host.docker.internal, enkelt-label, .local/.lan, IPv6 ULA/loopback, med og uten /v1 og port", async () => {
    for (const url of ["http://127.0.0.1:11434", "http://localhost:11434/", "http://10.0.0.7:8080/v1", "http://172.16.4.2", "http://172.31.255.254:1", "http://192.168.1.50:11434", "http://host.docker.internal:11434",
      "http://ollama:11434", "http://gpu-boks.local:11434", "http://pc.lan", "https://llm.home.arpa", "http://[::1]:11434", "http://[fd12:3456::1]:11434", "http://pc.internal:11434", "http://box.localdomain"]) {
      // navn løses til en privat adresse; IP-literaler trenger ikke DNS
      const out = await run(gemma(url), { lookup: async () => [{ address: "192.168.1.9" }] });
      expect(out.verdicts?.find((v) => v.identity === "gemma_local"), url).toMatchObject({ status: "local", code: null });
      expect(localityOf(out.profiles, "gemma_local"), url).toBe("local");
    }
  });

  it("ugyldige/offentlige URL-er gjør identiteten IKKE-lokal (cloud) med en stabil årsakskode - for hver av de tre identitetene, og de andre berøres ikke", async () => {
    const cases: Array<[string, string]> = [
      ["http://api.example.com:11434", "local_url_not_local"], ["https://llm.mitt-selskap.no", "local_url_not_local"], ["http://8.8.8.8:11434", "local_url_not_local"], ["http://[2001:4860:4860::8888]", "local_url_not_local"],
      ["http://169.254.169.254/latest", "local_url_not_local"], ["http://0.0.0.0:11434", "local_url_not_local"], ["http://100.64.0.5:11434", "local_url_not_local"], ["http://min-pc.tail1234.ts.net:11434", "local_url_not_local"],
      ["not a url", "local_url_malformed"], ["ftp://192.168.1.2", "local_url_scheme"], ["file:///etc/passwd", "local_url_scheme"], [`http://bruker:${SECRET}@192.168.1.2:11434`, "local_url_credentials"]
    ];
    const envFor = { gemma_local: "JARVIS_GEMMA_LOCAL_URL", local_llm: "LOCAL_LLM_BASE_URL", ollama: "JARVIS_OLLAMA_URL" } as const;
    for (const identity of NAMES) {
      for (const [url, code] of cases) {
        const out = await run({ ...on, [envFor[identity as keyof typeof envFor]]: url });
        expect(out.verdicts?.find((v) => v.identity === identity), `${identity} ${code}`).toEqual({ identity, status: "demoted", code });
        expect(localityOf(out.profiles, identity), identity).toBe("cloud");
        for (const other of NAMES.filter((n) => n !== identity)) expect(localityOf(out.profiles, other), `${identity}->${other}`).toBe("local");
        expect(localityOf(out.profiles, "anthropic")).toBe("cloud");
        expect(localityOf(out.profiles, "scripted")).toBe("local"); // testleverandøren er ikke en konfigurert identitet
      }
    }
  });

  it("tailnet (100.64/10, *.ts.net) regnes som lokalt KUN med `JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE=on`", async () => {
    for (const url of ["http://100.86.89.57:11434", "http://100.127.255.255", "http://min-pc.tail1234.ts.net:11434"]) {
      const without = await run(gemma(url), { lookup: async () => [{ address: "100.86.89.57" }] });
      expect(localityOf(without.profiles, "gemma_local"), `uten: ${url}`).toBe("cloud");
      const withTs = await run({ ...gemma(url), JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE: "on" }, { lookup: async () => [{ address: "100.86.89.57" }] });
      expect(localityOf(withTs.profiles, "gemma_local"), `med: ${url}`).toBe("local");
    }
    // utenfor 100.64/10 er aldri tailnet
    const outside = await run({ ...gemma("http://100.128.0.1:11434"), JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE: "on" });
    expect(localityOf(outside.profiles, "gemma_local")).toBe("cloud");
  });

  it("navneoppløsning ved oppstart: et navn som peker til en OFFENTLIG adresse demoterer (selv enkelt-label og .local), privat beholder, og ett offentlig svar blant flere er nok", async () => {
    const cases: Array<[string, Array<{ address: string }>, string]> = [
      ["http://gpu-boks:11434", [{ address: "93.184.216.34" }], "demoted"],
      ["http://evil.com.local:11434", [{ address: "8.8.8.8" }], "demoted"],
      ["http://metadata.google.internal", [{ address: "169.254.169.254" }], "demoted"],
      ["http://gpu-boks:11434", [{ address: "192.168.1.9" }, { address: "93.184.216.34" }], "demoted"],
      ["http://gpu-boks:11434", [{ address: "192.168.1.9" }, { address: "10.0.0.4" }], "local"],
      ["http://gpu-boks:11434", [{ address: "::ffff:10.0.0.4" }], "local"],
      ["http://gpu-boks:11434", [{ address: "::ffff:8.8.8.8" }], "demoted"]
    ];
    for (const [url, addresses, status] of cases) {
      const out = await run(gemma(url), { lookup: async () => addresses });
      expect(out.verdicts?.find((v) => v.identity === "gemma_local"), `${url} ${JSON.stringify(addresses)}`).toMatchObject({ status, ...(status === "demoted" ? { code: "local_url_resolves_nonlocal" } : {}) });
    }
  });

  it("et navn som ikke kan løses akkurat nå beholdes (ingen forbindelse kan opprettes; samme valg som G3) men LOGGES; en lookup som kaster eller henger regnes likt", async () => {
    for (const lookup of [async () => [], async () => { throw new Error("ENOTFOUND"); }, () => new Promise<Array<{ address: string }>>(() => undefined)]) {
      const out = await run(gemma("http://gpu-boks:11434"), { lookup, timeoutMs: 20 });
      expect(out.verdicts?.find((v) => v.identity === "gemma_local")).toEqual({ identity: "gemma_local", status: "unresolved", code: null });
      expect(localityOf(out.profiles, "gemma_local")).toBe("local");
      expect(out.lines.some((l) => l.line["msg"] === "local_model_endpoint_unresolved" && l.line["identity"] === "gemma_local" && l.level === "warn")).toBe(true);
    }
  });

  it("FAIL-LUKKET: en uventet feil i selve sjekken (ikke en `LocalEndpointError`) demoterer med `local_url_check_failed` - aldri en stille «lokal»", async () => {
    // en navneoppløsning som svarer med en ugyldig adresse får selve vurderingen (`isLocalAddress`) til å kaste en TypeError utenfor lookup-feilhåndteringen: «ikke bevist lokal» = demotert (mutantfunn: den gamle testen godtok både `unresolved` og `demoted`)
    const out = await run(gemma("http://gpu-boks:11434"), { lookup: async () => [{ address: undefined as unknown as string }] });
    expect(out.verdicts?.find((v) => v.identity === "gemma_local")).toEqual({ identity: "gemma_local", status: "demoted", code: "local_url_check_failed" });
    expect(localityOf(out.profiles, "gemma_local")).toBe("cloud");
    expect(out.lines.some((l) => l.line["msg"] === "local_model_endpoint_demoted" && l.line["code"] === "local_url_check_failed" && l.level === "warn")).toBe(true);
    // en lookup som kaster synkront er derimot «kan ikke løses nå» (beholdes, logges): ikke samme gren
    const thrown = await run(gemma("http://gpu-boks:11434"), { lookup: (() => { throw new TypeError("uventet"); }) as never });
    expect(thrown.verdicts?.find((v) => v.identity === "gemma_local")).toEqual({ identity: "gemma_local", status: "unresolved", code: null });
  });

  it("LOGGEN har kun identitetsnavn, statuskoder og tall - aldri URL, vert, port, brukernavn eller hemmelighet", async () => {
    const out = await run({
      ...on, JARVIS_GEMMA_LOCAL_URL: `http://bruker:${SECRET}@api.example.com:12345/hemmelig/sti?token=${SECRET}`, LOCAL_LLM_BASE_URL: "http://min-skjulte-vert.example.org:9999", JARVIS_OLLAMA_URL: "http://gpu-boks:11434"
    }, { lookup: async () => [] });
    const text = JSON.stringify(out.lines);
    for (const forbidden of [SECRET, "api.example.com", "12345", "hemmelig", "bruker", "min-skjulte-vert", "9999", "gpu-boks", "http", "11434"]) expect(text, forbidden).not.toContain(forbidden);
    expect(out.lines.filter((l) => l.line["msg"] === "local_model_endpoint_demoted").map((l) => [l.line["identity"], l.line["code"]])).toEqual([["local_llm", "local_url_not_local"], ["gemma_local", "local_url_credentials"]]);
    expect(out.lines.filter((l) => l.level === "warn").length).toBeGreaterThanOrEqual(3);
    expect(out.lines[out.lines.length - 1]!.line).toMatchObject({ msg: "local_model_endpoint_guard", enabled: true });
  });

  it("tom/blank URL = ikke konfigurert (adapteren er heller ikke tilgjengelig): ingen demotering", async () => {
    const out = await run({ ...on, JARVIS_GEMMA_LOCAL_URL: "   ", LOCAL_LLM_BASE_URL: "" });
    expect(out.verdicts?.map((v) => v.status)).toEqual(["not_configured", "not_configured", "not_configured"]);
  });

  it("adressereglene er DE SAMME som G3 sine (delt kode: `vision-runtime` re-eksporterer `isLocalAddress` fra vaktfilen)", () => {
    expect(visionIsLocalAddress).toBe(isLocalAddress);
    expect(isLocalAddress("100.64.0.1")).toBe(false);
    expect(isLocalAddress("100.64.0.1", { allowTailscale: true })).toBe(true);
  });

  it("grensene i adresserommet (begge sider av hver grense): RFC 1918, loopback, CGNAT kun med tailnet-flagget, IPv6 ULA/loopback og IPv4-mappet IPv6", () => {
    const local = ["127.0.0.1", "127.255.255.255", "10.0.0.0", "10.255.255.255", "172.16.0.0", "172.31.255.255", "192.168.0.0", "192.168.255.255", "::1", "fc00::1", "fd12:3456::1", "::ffff:10.0.0.1", "[::1]"];
    const nonLocal = ["126.255.255.255", "128.0.0.1", "9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "169.254.169.254", "0.0.0.0", "8.8.8.8", "::", "fe80::1", "fb00::1", "fe00::1", "2001:db8::1", "::ffff:172.32.0.1", "::ffff:8.8.8.8", "ikke-en-adresse", ""];
    for (const a of local) expect(isLocalAddress(a), a).toBe(true);
    for (const a of nonLocal) expect(isLocalAddress(a), a).toBe(false);
    // tailnet (CGNAT 100.64.0.0/10) kun med eierens flagg, og aldri utenfor blokken
    for (const a of ["100.64.0.0", "100.100.1.1", "100.127.255.255"]) {
      expect(isLocalAddress(a), a).toBe(false);
      expect(isLocalAddress(a, { allowTailscale: true }), a).toBe(true);
    }
    for (const a of ["100.63.255.255", "100.128.0.0", "99.64.0.1", "101.64.0.1"]) expect(isLocalAddress(a, { allowTailscale: true }), a).toBe(false);
  });
});

describe("C: demoteringen flyter inn i HVER lokalitetsavgjørelse (mot den delte DEFAULT_PROFILES)", () => {
  afterEach(() => resetProfileLocalityToDefaults());

  const model = (provider: string) => ({ provider, model: "m" });
  const fakePool = (): pg.Pool => ({ connect: async () => ({ query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }), release: () => undefined }) }) as unknown as pg.Pool;
  const fake = (name: string): ModelProviderAdapter & { calls: ModelRequest[] } => {
    const calls: ModelRequest[] = [];
    return { name, model: "m", calls, available: () => true, async complete(request: ModelRequest): Promise<ModelResult> { calls.push(request); return { text: "ok", usage: { input_tokens: 1, output_tokens: 1 }, provider: name, model: "m", latency_ms: 1 }; } };
  };
  const restricted = (): CompleteInput => ({ tenant_id: "t", purpose: "QUICK_CLASSIFICATION", sensitivity: "SECRET_RESTRICTED", mode: "LOCAL", paid_models_allowed: false, request: { messages: [{ role: "user", content: "x" }] } });

  it("utgangspunkt (flagg AV): de tre identitetene er lokale i ALLE leserne", () => {
    for (const provider of NAMES) {
      expect(servedByCloudModel({ provider }), provider).toBe(false);
      expect(financeLockServedLocally(model(provider)), provider).toBe(true);
      expect(FINANCE_EXECUTION_LOCK.servedLocally?.(model(provider)), provider).toBe(true);
      expect(withholdsRestrictedJobFromCloud(model(provider)), provider).toBe(false);
    }
  });

  it("etter demotering: `servedByCloudModel`, den sentrale `financeLockServedLocally`/`FINANCE_EXECUTION_LOCK`, jobb-tilbakeholdet og chat-jobbene ser identiteten som SKY", () => {
    expect(demoteLocalProfileToCloud("gemma_local")).toBe(true);
    expect(servedByCloudModel({ provider: "gemma_local" })).toBe(true);
    expect(financeLockServedLocally(model("gemma_local"))).toBe(false);
    expect(FINANCE_EXECUTION_LOCK.servedLocally?.(model("gemma_local"))).toBe(false);
    expect(withholdsRestrictedJobFromCloud(model("gemma_local"))).toBe(true);
    // chat-jobbene: en tur betjent av en SKY-regnet modell er ikke låst lokalt
    const job = { title: "Åpne PR-er", prompt: "list åpne PR-er", memorySpaces: ["personal"] as const, contentOrigin: undefined };
    expect(cloudToolTurnsAllowed({ ...job, servingModel: model("gemma_local") })).toBe(true);
    expect(cloudToolTurnsAllowed({ ...job, servingModel: model("ollama") })).toBe(false); // uberørt identitet = lokal = ikke skybetjent
    // de andre identitetene er uberørt
    for (const provider of ["local_llm", "ollama"]) {
      expect(servedByCloudModel({ provider }), provider).toBe(false);
      expect(financeLockServedLocally(model(provider)), provider).toBe(true);
    }
    // idempotent og kun nedgradering
    expect(demoteLocalProfileToCloud("gemma_local")).toBe(false);
    expect(demoteLocalProfileToCloud("anthropic")).toBe(false);
    expect(demoteLocalProfileToCloud("finnes-ikke")).toBe(false);
  });

  it("registeret og ruteren: en demotert identitet kan aldri få SECRET_RESTRICTED-innhold (lokal-modus, betalte modeller av) - ingen adapter kalles; ikke-demotert får kallet", async () => {
    const local = fake("gemma_local");
    const cloud = fake("anthropic");
    const make = () => new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [cloud, local] });
    expect((await make().complete(restricted())).provider).toBe("gemma_local"); // kontroll: uten demotering virker det
    local.calls.length = 0;
    demoteLocalProfileToCloud("gemma_local");
    await expect(make().complete(restricted())).rejects.toThrow();
    expect(local.calls).toHaveLength(0);
    expect(cloud.calls).toHaveLength(0);
    // også uten lokal-modus: SECRET_RESTRICTED alene stenger skyen
    await expect(make().complete({ ...restricted(), mode: undefined as never })).rejects.toThrow();
    expect(local.calls).toHaveLength(0);
    expect(cloud.calls).toHaveLength(0);
  });

  it("en gateway bygget med et EGET register fra de delte profilene ser samme demotering (objektene deles)", () => {
    const registry = new CapabilityRegistry(DEFAULT_PROFILES);
    expect(registry.get("ollama")?.locality).toBe("local");
    demoteLocalProfileToCloud("ollama");
    expect(registry.get("ollama")?.locality).toBe("cloud");
    resetProfileLocalityToDefaults();
    expect(registry.get("ollama")?.locality).toBe("local");
  });

  it("assist-vakten for begrensede domener: et svar fra en demotert identitet forkastes selv om navnet står i listen (snevrer inn, widner aldri)", async () => {
    const input: AssistInput = { tenant_id: "t", memory_space: "home", rule_key: "vision:motion_detected", domain: "vision", priority: "low", facts: { event_type: "motion_detected", night: true }, detection_key: "k" };
    const answer = JSON.stringify({ category: "attention", priority: "normal", explanation: "ok" });
    const gatewayFor = (provider: string) => ({ complete: async () => ({ text: answer, provider, model: "m" }) });
    const isLocal = (provider: string) => financeLockServedLocally({ provider, model: "" });
    const before = await new ModelSignalAssist({ gateway: gatewayFor("gemma_local"), isLocalProvider: isLocal }).assess(input);
    expect(before.status).toBe("assessed");
    demoteLocalProfileToCloud("gemma_local");
    const after = await new ModelSignalAssist({ gateway: gatewayFor("gemma_local"), isLocalProvider: isLocal }).assess(input);
    expect(after).toMatchObject({ status: "rejected", reason: "non_local_provider" });
    // uten den nye valgfrie vakten er oppførselen uendret (kun navnelisten)
    expect((await new ModelSignalAssist({ gateway: gatewayFor("gemma_local") }).assess(input)).status).toBe("assessed");
    // vakten kan aldri utvide: en leverandør utenfor navnelisten godtas ikke selv om registeret sier lokal
    expect((await new ModelSignalAssist({ gateway: gatewayFor("scripted"), isLocalProvider: () => true }).assess(input)).status).toBe("rejected");
  });
});

describe("D: struktur - api OG worker kaller vakten FØR gatewayen, flaggene leses ett sted, miljø og compose", () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("INGEN produksjonskode kan gjøre en profil lokal igjen: den eneste tilordningen til `.locality` er nedgraderingen til `cloud` (`capability-registry.ts`)", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "test" || name === "dist") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (name.endsWith(".ts") || name.endsWith(".mjs")) out.push(full);
      }
      return out;
    };
    const hits: string[] = [];
    for (const file of [...walk(join(root, "modules")), ...walk(join(root, "apps")), ...walk(join(root, "packages"))]) {
      if (!file.includes("/src/") && !file.includes("/scripts/")) continue;
      for (const m of strip(readFileSync(file, "utf8")).matchAll(/\.locality\s*=(?!=)\s*([^;\n]*)/g)) hits.push(`${file.slice(root.length)}: ${m[0].trim()}`);
    }
    expect(hits).toEqual(['modules/model-gateway/src/capability-registry.ts: .locality = "cloud"']);
  });

  it("main.ts og worker-main.ts: `await enforceLocalModelEndpoints(process.env, ...)` står FØR `new ModelGateway(`", () => {
    for (const file of ["../src/main.ts", "../src/worker-main.ts"]) {
      const code = strip(read(file));
      const call = code.indexOf("await enforceLocalModelEndpoints(process.env,");
      const gateway = code.indexOf("new ModelGateway(");
      expect(call, file).toBeGreaterThan(-1);
      expect(gateway, file).toBeGreaterThan(call);
      expect(code.match(/enforceLocalModelEndpoints\(/g)?.length, file).toBe(1);
      // FIX-5: importen har også `localModelNoRedirect` (omdirigeringsvakten bruker samme flaggparser); ingen annen import fra filen
      expect(code, file).toMatch(/import \{ enforceLocalModelEndpoints, localModelNoRedirect \} from "\.\/local-model-endpoints\.ts";/);
    }
  });

  it("flaggene leses KUN i `local-model-endpoints.ts` (ingen annen kode i apps/api/src og modulene kjenner navnene)", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "test" || name === "dist") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (name.endsWith(".ts")) out.push(full);
      }
      return out;
    };
    const hits = [...walk(join(root, "apps")), ...walk(join(root, "modules")), ...walk(join(root, "packages"))]
      .filter((f) => /JARVIS_LOCAL_MODEL_(URL_GUARD|ALLOW_TAILSCALE)/.test(strip(readFileSync(f, "utf8")))).map((f) => f.slice(root.length));
    expect(hits).toEqual(["apps/api/src/local-model-endpoints.ts"]);
  });

  it("identitetene og miljøvariablene vakten kjenner er de adapterne faktisk leser", () => {
    expect(LOCAL_MODEL_ENDPOINTS.map((e) => [e.provider, e.env_name])).toEqual([["local_llm", "LOCAL_LLM_BASE_URL"], ["gemma_local", "JARVIS_GEMMA_LOCAL_URL"], ["ollama", "JARVIS_OLLAMA_URL"]]);
    expect(read("../../../packages/provider-adapters/src/local-llm.ts")).toContain('process.env["LOCAL_LLM_BASE_URL"]');
    expect(read("../../../packages/provider-adapters/src/ollama.ts")).toContain('process.env["JARVIS_OLLAMA_URL"]');
    for (const file of ["../src/main.ts", "../src/worker-main.ts"]) expect(read(file), file).toContain('process.env["JARVIS_GEMMA_LOCAL_URL"]');
  });

  it("flaggene står i api OG worker (felles MODEL_ENV), ikke i voice/browser; compose og .env.example er konsistente", () => {
    for (const name of ["JARVIS_LOCAL_MODEL_URL_GUARD", "JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE"]) {
      expect(SERVICE_ENV.api, `api ${name}`).toContain(name);
      expect(SERVICE_ENV.worker, `worker ${name}`).toContain(name);
      for (const service of Object.keys(SERVICE_ENV).filter((s) => s !== "api" && s !== "worker")) expect((SERVICE_ENV as Record<string, string[]>)[service], `${service} ${name}`).not.toContain(name);
      expect(read("../../../.env.example")).toMatch(new RegExp(`^${name}=$`, "m"));
      expect(read("../../../infra/local/docker-compose.yml").match(new RegExp(`${name}: "\\$\\{${name}:-\\}"`, "g"))?.length, name).toBe(2);
    }
  });
});
