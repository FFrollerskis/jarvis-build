import { readFileSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingProviderFromEnv, embeddingEndpointFromEnv, LocalHashEmbedding } from "@jarvis/memory";
import { buildLimitationRegistry } from "@jarvis/executive";
import { CapabilityRegistry, DEFAULT_PROFILES, LocalModelUnavailableError, MAX_MODEL_TIMEOUT_MS, MemoryTraceSink, ModelGateway, PROFILES_WITH_LOCAL_VISION, assertProvidersHaveExplicitPricing, pricingFromEnv } from "@jarvis/model-gateway";
import { ProviderError, type ModelProviderAdapter, type ModelRequest, type ModelResult } from "@jarvis/provider-adapters";
import { guardedFetch } from "@jarvis/tool-gateway";
import { HomeAssistantVisionSource, VisionClassifier, type VisionService } from "@jarvis/vision";
import { FakeHaServer, haTimestamp } from "../../../modules/vision/test/support/fake-ha-server.ts";
import { freezeTargetError, knownModelProviders } from "../src/provider-pause.ts";
import {
  assertLocalVisionEndpoint, assertStorageDirWritable, buildVisionRuntime, createVisionPollerGuard, isLocalAddress, verifyVisionEndpoints, visionAdapterFromEnv, visionAllowTailscale, visionFlagsFromEnv, visionModelTimeoutMs,
  VISION_MODEL_TIMEOUT_BOUNDS, VISION_UPLOADS_PER_IP_PER_MINUTE, VisionConfigError
} from "../src/vision-runtime.ts";

/**
 * WP-G3 (D-465): api-koblingen av UA-9 - flagg (alt AV som standard), URL-vakten for den lokale visjonsmodellen, `local_vision`-adapteren, eier-kontroll-porten for polleren, HA-kilden med den ENDELIGE `guardedFetch`
 * og - viktigst - at kamerabilder aldri når en skymodell gjennom den ekte `ModelGateway` + den ekte adapteren, heller ikke når den lokale modellen er nede. Ingen ekte kamera/nett: lokale falske servere.
 */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8]);
const MAIN_SRC = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
const RUNTIME_SRC = readFileSync(fileURLToPath(new URL("../src/vision-runtime.ts", import.meta.url)), "utf8");

describe("flagg: alt er AV som standard, kun eksakt «on», og underflagg gjelder bare under hovedbryteren", () => {
  const flags = (env: Record<string, string | undefined>) => visionFlagsFromEnv(env as NodeJS.ProcessEnv);

  it("tomt miljø = alt av", () => {
    expect(flags({})).toEqual({ enabled: false, classifier: false, storeSnapshots: false, haPoll: false, localUrl: undefined, localModel: "local-vision", storageDir: undefined });
  });

  it("true/1/ON/yes/«on » slår ikke på noe; kun eksakt «on»", () => {
    for (const value of ["true", "1", "ON", "On", "yes", "on ", " on", "enabled", ""]) {
      expect(flags({ JARVIS_VISION_ENABLED: value }).enabled, JSON.stringify(value)).toBe(false);
    }
    expect(flags({ JARVIS_VISION_ENABLED: "on" }).enabled).toBe(true);
  });

  it("underflagg uten hovedbryter er av (CLASSIFIER/STORE_SNAPSHOTS/HA_POLL gjelder kun under JARVIS_VISION_ENABLED=on)", () => {
    expect(flags({ JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_STORE_SNAPSHOTS: "on", JARVIS_VISION_HA_POLL: "on" })).toMatchObject({ enabled: false, classifier: false, storeSnapshots: false, haPoll: false });
    expect(flags({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_STORE_SNAPSHOTS: "on", JARVIS_VISION_HA_POLL: "on" })).toMatchObject({ enabled: true, classifier: true, storeSnapshots: true, haPoll: true });
  });

  it("modellnavn og mappe trimmes; tom streng = ikke satt", () => {
    expect(flags({ JARVIS_VISION_LOCAL_MODEL: " qwen-vl ", JARVIS_VISION_STORAGE_DIR: " /data/vision ", JARVIS_VISION_LOCAL_URL: "  " })).toMatchObject({ localModel: "qwen-vl", storageDir: "/data/vision", localUrl: undefined });
  });
});

describe("assertLocalVisionEndpoint: kamerabilder forlater aldri maskinen/det lokale nettverket", () => {
  const ACCEPT = [
    "http://localhost:11434", "http://127.0.0.1:11434/v1", "http://127.1.2.3", "http://[::1]:11434", "http://host.docker.internal:11434", "http://10.0.0.5:8080", "http://192.168.1.20",
    "http://172.16.5.4", "http://172.31.255.255:9", "http://ollama-vision:11434", "http://gpu.lan", "http://gpu-box.home.arpa:11434", "http://workstation.local", "http://nas.internal/v1",
    "http://[fd12:3456::1]:11434", "https://localhost:8443"
  ];
  const REJECT: Array<[string, string]> = [
    ["https://api.openai.com/v1", "local_url_not_local"], ["http://8.8.8.8:11434", "local_url_not_local"], ["http://172.32.0.1", "local_url_not_local"], ["http://172.15.0.1", "local_url_not_local"],
    ["http://0.0.0.0:11434", "local_url_not_local"], ["http://example.com", "local_url_not_local"], ["http://vision.example.com:11434", "local_url_not_local"], ["http://localhost.evil.com", "local_url_not_local"],
    ["http://127.0.0.1.evil.com", "local_url_not_local"], ["http://evil.com/localhost", "local_url_not_local"], ["http://[2001:db8::1]:11434", "local_url_not_local"], ["http://11.0.0.1", "local_url_not_local"],
    // review A-L5: link-lokale adresser (inkl. skymetadata-adressen) er IKKE lokale i denne betydningen, og Tailscale (CGNAT/.ts.net) avvises uten eier-flagget
    ["http://169.254.169.254", "local_url_not_local"], ["http://169.254.1.1", "local_url_not_local"], ["http://[fe80::1]:11434", "local_url_not_local"], ["http://100.64.0.1:11434", "local_url_not_local"],
    ["http://100.127.255.255", "local_url_not_local"], ["http://pc.tail1234.ts.net:11434", "local_url_not_local"], ["http://[::ffff:8.8.8.8]", "local_url_not_local"],
    ["http://user:pw@localhost:11434", "local_url_credentials"], ["http://user@localhost", "local_url_credentials"], ["ftp://localhost", "local_url_scheme"], ["file:///etc/passwd", "local_url_scheme"],
    ["ws://localhost", "local_url_scheme"], ["not a url", "local_url_malformed"], ["", "local_url_malformed"]
  ];

  it.each(ACCEPT)("godtar %s", (url) => {
    expect(assertLocalVisionEndpoint(url)).toBe(url);
  });

  it.each(REJECT)("avviser %s (%s)", (url, code) => {
    expect(() => assertLocalVisionEndpoint(url)).toThrow(new VisionConfigError(code).message);
  });
});

describe("Tailscale og adresseklassifisering (review A-L5)", () => {
  const TS = { allowTailscale: true };

  it("med JARVIS_VISION_ALLOW_TAILSCALE godtas CGNAT 100.64.0.0/10 og *.ts.net - kanten av området og lignende navn avvises fortsatt", () => {
    for (const url of ["http://100.64.0.1:11434", "http://100.101.102.103", "http://100.127.255.255", "http://pc.tail1234.ts.net:11434", "https://my-pc.ts.net"]) expect(assertLocalVisionEndpoint(url, TS), url).toBe(url);
    for (const url of ["http://100.63.255.255", "http://100.128.0.1", "http://ts.net", "http://pc.ts.net.evil.com", "http://evilts.net", "http://8.8.8.8", "http://169.254.169.254", "http://[fe80::1]"]) {
      expect(() => assertLocalVisionEndpoint(url, TS), url).toThrow(new VisionConfigError("local_url_not_local").message);
    }
  });

  it("uten flagget avvises Tailscale; flagget leses kun som eksakt «on» (true/1/ON slår det ikke på) og gjelder adapteren", () => {
    const base = { JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: "http://pc.tail1234.ts.net:11434" };
    expect(() => visionAdapterFromEnv(base as NodeJS.ProcessEnv)).toThrow("vision_config_invalid:local_url_not_local");
    for (const value of ["true", "1", "ON", "yes", ""]) {
      expect(visionAllowTailscale({ JARVIS_VISION_ALLOW_TAILSCALE: value } as NodeJS.ProcessEnv), value).toBe(false);
      expect(() => visionAdapterFromEnv({ ...base, JARVIS_VISION_ALLOW_TAILSCALE: value } as NodeJS.ProcessEnv), value).toThrow("local_url_not_local");
    }
    expect(visionAllowTailscale({ JARVIS_VISION_ALLOW_TAILSCALE: "on" } as NodeJS.ProcessEnv)).toBe(true);
    expect(visionAdapterFromEnv({ ...base, JARVIS_VISION_ALLOW_TAILSCALE: "on" } as NodeJS.ProcessEnv)?.name).toBe("local_vision");
    expect(buildVisionRuntime(stubs({ ...base, JARVIS_VISION_ALLOW_TAILSCALE: "on" }))).not.toBeNull();
    expect(() => buildVisionRuntime(stubs(base))).toThrow("vision_config_invalid:local_url_not_local");
  });

  it("isLocalAddress: loopback, RFC 1918, ULA og (kun med flagget) CGNAT; link-lokal, offentlig, 0.0.0.0 og ugyldig er ikke lokale; IPv4-mappet IPv6 vurderes som sin IPv4", () => {
    const local = ["127.0.0.1", "127.9.9.9", "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.0.10", "::1", "fd12:3456::1", "fc00::1", "::ffff:10.0.0.5", "::ffff:192.168.1.1"];
    const notLocal = ["8.8.8.8", "172.15.0.1", "172.32.0.1", "169.254.169.254", "169.254.0.1", "0.0.0.0", "100.64.0.1", "fe80::1", "2001:db8::1", "::ffff:8.8.8.8", "::ffff:169.254.169.254", "not-an-ip", "", "999.1.1.1"];
    for (const address of local) expect(isLocalAddress(address), address).toBe(true);
    for (const address of notLocal) expect(isLocalAddress(address), address).toBe(false);
    for (const address of ["100.64.0.1", "100.100.100.100", "100.127.255.255", "::ffff:100.64.0.1"]) expect(isLocalAddress(address, { allowTailscale: true }), address).toBe(true);
    for (const address of ["100.63.0.1", "100.128.0.1", "8.8.8.8", "169.254.169.254"]) expect(isLocalAddress(address, { allowTailscale: true }), address).toBe(false);
  });
});

describe("verifyVisionEndpoints: vertsnavn løses ved oppstart og må peke til det lokale nettet (review A-L5 og A-INFO-4)", () => {
  const VISION = { JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: "http://gpu-box.lan:11434" };
  const lookupTo = (...addresses: string[]) => {
    const asked: string[] = [];
    return { asked, lookup: async (host: string) => { asked.push(host); return addresses.map((address) => ({ address })); } };
  };
  const verify = (env: Record<string, string>, lookup: (host: string) => Promise<ReadonlyArray<{ address: string }>>, timeoutMs?: number) =>
    verifyVisionEndpoints(env as NodeJS.ProcessEnv, { lookup, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hovedbryter av, eller ingen klassifisering/embedding-nettverk: ingen oppslag gjøres i det hele tatt", async () => {
    const spy = lookupTo("8.8.8.8");
    expect(await verify({}, spy.lookup)).toEqual({ embeddingBlockedReason: null });
    expect(await verify({ ...VISION, JARVIS_VISION_ENABLED: "true" }, spy.lookup)).toEqual({ embeddingBlockedReason: null });
    expect(await verify({ JARVIS_VISION_ENABLED: "on" }, spy.lookup)).toEqual({ embeddingBlockedReason: null }); // ingen CLASSIFIER, ingen Ollama-embedding
    expect(spy.asked).toEqual([]);
  });

  it("et navn som peker til en offentlig adresse KASTER (evil.com.local, enkelt-label-navn, metadata.google.internal -> 169.254.169.254); privat oppløsning godtas; blandet oppløsning avvises", async () => {
    const cases: Array<[string, string[], boolean]> = [
      ["http://evil.com.local:11434", ["93.184.216.34"], false],
      ["http://example:11434", ["93.184.216.34"], false],
      ["http://metadata.google.internal", ["169.254.169.254"], false],
      ["http://gpu-box.lan:11434", ["192.168.1.20"], true],
      ["http://ollama-vision:11434", ["172.18.0.3", "fd12::3"], true],
      ["http://mixed.lan", ["192.168.1.20", "8.8.8.8"], false],
      ["http://localhost:11434", ["127.0.0.1", "::1"], true],
      ["http://host.docker.internal:11434", ["::ffff:192.168.65.254"], true]
    ];
    for (const [url, addresses, ok] of cases) {
      const spy = lookupTo(...addresses);
      const promise = verify({ ...VISION, JARVIS_VISION_LOCAL_URL: url }, spy.lookup);
      if (ok) await expect(promise, url).resolves.toEqual({ embeddingBlockedReason: null });
      else await expect(promise, url).rejects.toThrow("vision_config_invalid:local_url_resolves_nonlocal");
      expect(spy.asked, url).toEqual([new URL(url).hostname]);
    }
  });

  it("IP-adresser løses ikke (vurderes syntaktisk), en syntaktisk ikke-lokal URL kastes uten oppslag, og Tailscale-navn krever flagget OG en tailnet-/privat oppløsning", async () => {
    const spy = lookupTo("8.8.8.8");
    await expect(verify({ ...VISION, JARVIS_VISION_LOCAL_URL: "http://192.168.1.5:11434" }, spy.lookup)).resolves.toEqual({ embeddingBlockedReason: null });
    await expect(verify({ ...VISION, JARVIS_VISION_LOCAL_URL: "https://api.openai.com/v1" }, spy.lookup)).rejects.toThrow("local_url_not_local");
    expect(spy.asked).toEqual([]);
    const ts = { ...VISION, JARVIS_VISION_LOCAL_URL: "http://pc.tail1234.ts.net:11434" };
    await expect(verify(ts, lookupTo("100.101.102.103").lookup)).rejects.toThrow("local_url_not_local"); // uten flagget
    await expect(verify({ ...ts, JARVIS_VISION_ALLOW_TAILSCALE: "on" }, lookupTo("100.101.102.103").lookup)).resolves.toEqual({ embeddingBlockedReason: null });
    await expect(verify({ ...ts, JARVIS_VISION_ALLOW_TAILSCALE: "on" }, lookupTo("8.8.8.8").lookup)).rejects.toThrow("local_url_resolves_nonlocal"); // flagget gjør ikke en offentlig oppløsning lokal
    await expect(verify({ ...VISION, JARVIS_VISION_LOCAL_URL: "http://my-pc:11434" }, lookupTo("100.101.102.103").lookup)).rejects.toThrow("local_url_resolves_nonlocal"); // MagicDNS-kortnavn uten flagget
    await expect(verify({ ...VISION, JARVIS_VISION_LOCAL_URL: "http://my-pc:11434", JARVIS_VISION_ALLOW_TAILSCALE: "on" }, lookupTo("100.101.102.103").lookup)).resolves.toBeDefined();
  });

  it("et navn som ikke kan løses akkurat nå (feil, tom liste, tidsavbrudd) stopper IKKE oppstarten, men logges uten vertsnavn - da kan heller ingen forbindelse opprettes", async () => {
    const errors = (console.error as unknown as { mock: { calls: unknown[][] } }).mock;
    const failing = async (): Promise<never> => { throw Object.assign(new Error("getaddrinfo ENOTFOUND secret-host.lan"), { code: "ENOTFOUND" }); };
    await expect(verify(VISION, failing)).resolves.toEqual({ embeddingBlockedReason: null });
    await expect(verify(VISION, async () => [])).resolves.toEqual({ embeddingBlockedReason: null });
    await expect(verify(VISION, () => new Promise<ReadonlyArray<{ address: string }>>(() => undefined), 25)).resolves.toEqual({ embeddingBlockedReason: null });
    const logged = errors.calls.map((c) => String(c[0])).join("\n");
    expect(logged.match(/vision_endpoint_unresolved/g)).toHaveLength(3);
    expect(logged).not.toContain("gpu-box");
    expect(logged).not.toContain("secret-host");
  });

  it("embedding-endepunktet (kun når minnet bruker Ollama): ikke-lokal URL eller oppløsning gir koden embedding_url_* og INGEN oppstartsfeil; lokalt/lokal-hash gir null", async () => {
    const ollama = { JARVIS_VISION_ENABLED: "on", JARVIS_EMBEDDING_PROVIDER: "ollama" };
    expect(await verify({ ...ollama, JARVIS_EMBEDDING_URL: "http://ollama:11434" }, lookupTo("172.18.0.2").lookup)).toEqual({ embeddingBlockedReason: null });
    expect(await verify({ ...ollama, JARVIS_EMBEDDING_URL: "https://embeddings.example.com" }, lookupTo("8.8.8.8").lookup)).toEqual({ embeddingBlockedReason: "embedding_url_not_local" });
    expect(await verify({ ...ollama, JARVIS_EMBEDDING_URL: "http://nas.lan:11434" }, lookupTo("8.8.8.8").lookup)).toEqual({ embeddingBlockedReason: "embedding_url_resolves_nonlocal" });
    expect(await verify({ ...ollama, JARVIS_EMBEDDING_URL: "http://user:pw@ollama:11434" }, lookupTo("172.18.0.2").lookup)).toEqual({ embeddingBlockedReason: "embedding_url_credentials" });
    expect(await verify({ ...ollama, JARVIS_OLLAMA_URL: "http://169.254.169.254" }, lookupTo().lookup)).toEqual({ embeddingBlockedReason: "embedding_url_not_local" });
    expect(await verify({ JARVIS_VISION_ENABLED: "on", JARVIS_EMBEDDING_URL: "https://embeddings.example.com" }, lookupTo("8.8.8.8").lookup)).toEqual({ embeddingBlockedReason: null }); // lokal-hash: ingen nettverk, URL-en brukes ikke
  });

  it("buildVisionRuntime: en ikke-lokal embedding-URL gir INGEN vision-embedding (logg vision_embeddings_disabled), mens en lokal URL eller lokal-hash gir embedding som før", () => {
    const errors = (console.error as unknown as { mock: { calls: unknown[][] } }).mock;
    const logged = (): string => errors.calls.map((c) => String(c[0])).join("\n");
    const ollama = { JARVIS_VISION_ENABLED: "on", JARVIS_EMBEDDING_PROVIDER: "ollama" };
    buildVisionRuntime(stubs({ ...ollama, JARVIS_EMBEDDING_URL: "https://embeddings.example.com" }))?.stop();
    expect(logged()).toContain("\"code\":\"embedding_url_not_local\"");
    errors.calls.length = 0;
    buildVisionRuntime(stubs({ ...ollama, JARVIS_EMBEDDING_URL: "http://ollama:11434" }))?.stop();
    buildVisionRuntime(stubs({ JARVIS_VISION_ENABLED: "on" }))?.stop();
    expect(logged()).not.toContain("vision_embeddings_disabled");
    errors.calls.length = 0;
    buildVisionRuntime(stubs({ ...ollama, JARVIS_EMBEDDING_URL: "http://ollama:11434" }, { embeddingBlockedReason: "embedding_url_resolves_nonlocal" }))?.stop(); // navneoppløsningen fra oppstarten
    expect(logged()).toContain("\"code\":\"embedding_url_resolves_nonlocal\"");
  });
});

describe("embeddingEndpointFromEnv (review A-INFO-4): én kilde for embedding-URL-en minnet og vision bruker", () => {
  it("null for lokal-hash (ingen nettverk) eller manglende URL; ellers JARVIS_EMBEDDING_URL -> JARVIS_OLLAMA_URL -> JARVIS_GEMMA_LOCAL_URL (trimmet) - og faktoren bruker den samme", () => {
    expect(embeddingEndpointFromEnv({})).toBeNull();
    expect(embeddingEndpointFromEnv({ JARVIS_EMBEDDING_PROVIDER: "local-hash", JARVIS_EMBEDDING_URL: "http://x:1" })).toBeNull();
    expect(embeddingEndpointFromEnv({ JARVIS_EMBEDDING_URL: "http://x:1" })).toBeNull(); // uten Ollama-valg brukes ingen URL
    expect(embeddingEndpointFromEnv({ JARVIS_EMBEDDING_PROVIDER: "ollama" })).toBeNull();
    expect(() => createEmbeddingProviderFromEnv({ JARVIS_EMBEDDING_PROVIDER: "ollama" })).toThrow(/memory_embedding_url_missing/);
    const all = { JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_EMBEDDING_URL: " http://a:1 ", JARVIS_OLLAMA_URL: "http://b:1", JARVIS_GEMMA_LOCAL_URL: "http://c:1" };
    expect(embeddingEndpointFromEnv(all)).toBe("http://a:1");
    expect(embeddingEndpointFromEnv({ ...all, JARVIS_EMBEDDING_URL: "" })).toBe("http://b:1");
    expect(embeddingEndpointFromEnv({ ...all, JARVIS_EMBEDDING_URL: "", JARVIS_OLLAMA_URL: "" })).toBe("http://c:1");
    expect(embeddingEndpointFromEnv({ JARVIS_EMBEDDING_MODEL: "nomic-embed-text", JARVIS_OLLAMA_URL: "http://x:11434" })).toBe("http://x:11434");
  });
});

describe("visionAdapterFromEnv", () => {
  const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

  it("AV = null (ingenting registreres): tomt miljø, kun CLASSIFIER uten hovedbryter, hovedbryter uten CLASSIFIER, «true» i stedet for «on»", () => {
    expect(visionAdapterFromEnv(env({}))).toBeNull();
    expect(visionAdapterFromEnv(env({ JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: "http://localhost:11434" }))).toBeNull();
    expect(visionAdapterFromEnv(env({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_LOCAL_URL: "http://localhost:11434" }))).toBeNull();
    expect(visionAdapterFromEnv(env({ JARVIS_VISION_ENABLED: "true", JARVIS_VISION_CLASSIFIER: "true", JARVIS_VISION_LOCAL_URL: "http://localhost:11434" }))).toBeNull();
  });

  it("PÅ: lokal URL gir en `local_vision`-adapter med valgt modell; manglende eller ikke-lokal URL KASTER (oppstart stoppes, aldri en stille standard)", () => {
    const adapter = visionAdapterFromEnv(env({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: "http://127.0.0.1:11434", JARVIS_VISION_LOCAL_MODEL: "qwen-vl" }));
    expect(adapter).not.toBeNull();
    expect(adapter?.name).toBe("local_vision");
    expect(adapter?.model).toBe("qwen-vl");
    expect(adapter?.available()).toBe(true);
    expect(() => visionAdapterFromEnv(env({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on" }))).toThrow("vision_config_invalid:local_url_missing");
    expect(() => visionAdapterFromEnv(env({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: "https://api.openai.com" }))).toThrow("vision_config_invalid:local_url_not_local");
  });

  it("startvakten JARVIS-006 (hver registrert adapter har eksplisitt pris) kaster ikke for local_vision - ellers ville oppstarten stoppet med flagget på", () => {
    const adapter = visionAdapterFromEnv(env({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: "http://127.0.0.1:11434" }));
    expect(adapter?.name).toBe("local_vision");
    expect(() => assertProvidersHaveExplicitPricing(pricingFromEnv(), [adapter?.name ?? ""])).not.toThrow();
  });
});

describe("main.ts: flagg-av-identitet i selve koblingen", () => {
  it("adapteren registreres kun via visionAdapterFromEnv (betinget spredning), kjøretiden kun når den ikke er null, og ruten/jobbene finnes ikke uten den", () => {
    expect(MAIN_SRC).toMatch(/const visionAdapter = visionAdapterFromEnv\(process\.env\);/);
    expect(MAIN_SRC).toMatch(/new OllamaAdapter\(\),\n\s*\.\.\.\(visionAdapter !== null \? \[visionAdapter\] : \[\]\)/);
    expect(MAIN_SRC).toMatch(/\.\.\.\(visionRuntime !== null \? \{ vision: visionRuntime\.api \} : \{\}\),/);
    expect(MAIN_SRC).toMatch(/if \(visionRuntime !== null\) \{\n\s*new DailyScheduler\(\n\s*pool, "vision-maintenance-sweep"/);
    // ingen annen kobling: `vision`-avhengigheten settes ikke andre steder, og ingen vision-adapter registreres ubetinget
    expect(MAIN_SRC.match(/vision: visionRuntime/g)).toHaveLength(1);
    // review B-M2: HA-polleren får EIERENS tenant (og ingen annen kilde) - `owner.tenant_id` er den samme verdien som resten av kjernen bruker som eier
    expect(MAIN_SRC).toMatch(/buildVisionRuntime\(\{\n\s*pool, env: process\.env, vision: visionService, gateway, memoryEmbedding, devices: deviceRegistry, ownerTenantId: owner\.tenant_id, secrets: readSecretProvider,/);
    expect(MAIN_SRC.match(/ownerTenantId:/g)).toHaveLength(1);
    // review A-L5/A-INFO-4: navneoppløsningen kjøres ved oppstart FØR adapteren bygges (offentlig oppløsning kaster), med den ekte dns.lookup, og embedding-vurderingen gis videre til kjøretiden
    expect(MAIN_SRC).toMatch(/const visionEndpoints = await verifyVisionEndpoints\(process\.env, \{ lookup: \(host\) => dnsLookup\(host, \{ all: true, verbatim: true \}\) \}\);\n\s*const visionAdapter = visionAdapterFromEnv\(process\.env\);/);
    expect(MAIN_SRC).toContain('import { lookup as dnsLookup } from "node:dns/promises";');
    expect(MAIN_SRC).toContain("embeddingBlockedReason: visionEndpoints.embeddingBlockedReason");
    expect(MAIN_SRC).not.toMatch(/new LocalOpenAiCompatibleAdapter\([^)]*local_vision/);
  });

  it("HA-kilden bruker guardedFetch (ingen global fetch), og HA-credentials er de eksisterende (vault-kjeden), aldri nye navn", () => {
    expect(RUNTIME_SRC).toMatch(/guardedFetch\(url, init\)/);
    expect(RUNTIME_SRC).not.toMatch(/(?<![.\w])fetch\(/);
    expect(RUNTIME_SRC).toContain('deps.secrets.get("JARVIS_HA_BASE_URL")');
    expect(RUNTIME_SRC).toContain('deps.secrets.get("JARVIS_HA_TOKEN")');
  });
});

describe("flagg-AV-identitet for modellregisteret (review A-L3): local_vision er IKKE en del av standardlistene", () => {
  const VISION_ON = { JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: "http://127.0.0.1:11434" };
  const limitationInput = (modelProfiles: ReadonlyArray<{ provider: string; capabilities: readonly string[] }>) => ({
    forbiddenModelToolIds: [], connectors: [], modelProfiles, allModelCapabilities: ["text", "reasoning", "vision", "tool_calling", "structured_output", "streaming"], backupStatusReadable: true
  });

  it("main.ts legger profilen til gateway-registeret og begrensningsregisteret KUN når adapteren er registrert (betinget spredning), og ingen annen kobling finnes", () => {
    expect(MAIN_SRC).toMatch(/\.\.\.\(visionAdapter !== null \? \{ registry: new CapabilityRegistry\(PROFILES_WITH_LOCAL_VISION\) \} : \{\}\)/);
    expect(MAIN_SRC).toMatch(/modelProfiles: visionAdapter !== null \? PROFILES_WITH_LOCAL_VISION : DEFAULT_PROFILES,/);
    expect(MAIN_SRC.match(/PROFILES_WITH_LOCAL_VISION/g)).toHaveLength(3); // import + registry + begrensningsregister
    expect(MAIN_SRC).not.toMatch(/LOCAL_VISION_PROFILE/);
  });

  it("begrensningsregisteret (self-model, modellsynlig) er uendret med flagg AV; profilen gir kun én ny post når adapteren ER registrert", () => {
    const off = buildLimitationRegistry(limitationInput(DEFAULT_PROFILES));
    expect(JSON.stringify(off)).not.toContain("local_vision");
    const on = buildLimitationRegistry(limitationInput(PROFILES_WITH_LOCAL_VISION));
    expect(on.map((l) => l.id).filter((id) => !off.some((o) => o.id === id))).toEqual(["model_missing:local_vision"]);
    expect(on).toHaveLength(off.length + 1);
  });

  it("knownModelProviders() (frys-/pause-målene) får local_vision kun med ENABLED+CLASSIFIER = on - samme regel som adapteren - ellers identisk med main", () => {
    const off = knownModelProviders(undefined, {});
    expect(off.has("local_vision")).toBe(false);
    const envs: Array<Record<string, string>> = [
      {}, { JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: "http://127.0.0.1:11434" }, { JARVIS_VISION_ENABLED: "on" }, { JARVIS_VISION_ENABLED: "true", JARVIS_VISION_CLASSIFIER: "true" }, VISION_ON
    ];
    for (const env of envs) {
      const known = knownModelProviders(undefined, env as NodeJS.ProcessEnv);
      expect(known.has("local_vision"), JSON.stringify(env)).toBe(visionAdapterFromEnv(env as NodeJS.ProcessEnv) !== null);
      expect([...known].filter((p) => p !== "local_vision").sort()).toEqual([...off].sort());
    }
    expect(freezeTargetError("model:local_vision", knownModelProviders(undefined, {}))).toBe("unknown_model_provider:local_vision");
    expect(freezeTargetError("model:local_vision", knownModelProviders(undefined, VISION_ON as NodeJS.ProcessEnv))).toBeNull();
  });
});

const stubs = (envVars: Record<string, string>, over: Record<string, unknown> = {}) => ({
  pool: {} as pg.Pool, env: envVars as NodeJS.ProcessEnv, vision: {} as VisionService, gateway: { complete: async () => ({ text: "{}", provider: "local_vision", model: "m" }) },
  memoryEmbedding: new LocalHashEmbedding(), devices: { approverFor: async () => undefined }, ownerTenantId: "tenant-owner", secrets: { get: async () => null },
  ownerControls: { killSwitch: { isActiveDurable: async () => false }, controls: { isFrozenDurable: async () => false, isRevokedDurable: async () => false } }, ...over
});

describe("buildVisionRuntime", () => {
  it("hovedbryter av (også «true», også med alle underflagg på) = null: ingenting bygges", () => {
    expect(buildVisionRuntime(stubs({}))).toBeNull();
    expect(buildVisionRuntime(stubs({ JARVIS_VISION_ENABLED: "true", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_STORE_SNAPSHOTS: "on", JARVIS_VISION_HA_POLL: "on" }))).toBeNull();
  });

  it("feil konfigurasjon kaster: manglende/ikke-lokal modell-URL, lagring uten mappe, ikke-absolutt mappe", () => {
    const on = { JARVIS_VISION_ENABLED: "on" };
    expect(() => buildVisionRuntime(stubs({ ...on, JARVIS_VISION_CLASSIFIER: "on" }))).toThrow("vision_config_invalid:local_url_missing");
    expect(() => buildVisionRuntime(stubs({ ...on, JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: "http://example.com" }))).toThrow("vision_config_invalid:local_url_not_local");
    expect(() => buildVisionRuntime(stubs({ ...on, JARVIS_VISION_STORE_SNAPSHOTS: "on" }))).toThrow("vision_config_invalid:storage_dir_missing");
    expect(() => buildVisionRuntime(stubs({ ...on, JARVIS_VISION_STORE_SNAPSHOTS: "on", JARVIS_VISION_STORAGE_DIR: "relative/dir" }))).toThrow("vision_config_invalid:storage_dir_not_absolute");
  });

  it("review B-L10: med lagring PÅ kreves en skrivbar mappe ved oppstart (storage_dir_not_writable); uten lagring (kun vedlikehold) kastes det ikke, og prøvefilen etterlates aldri", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-vision-wprobe-"));
    const plainFile = join(dir, "not-a-dir");
    await writeFile(plainFile, "x");
    const blocked = join(plainFile, "vision"); // under en vanlig fil: kan aldri opprettes (ENOTDIR) - heller ikke som root
    const on = { JARVIS_VISION_ENABLED: "on", JARVIS_VISION_STORE_SNAPSHOTS: "on" };
    expect(() => buildVisionRuntime(stubs({ ...on, JARVIS_VISION_STORAGE_DIR: blocked }))).toThrow("vision_config_invalid:storage_dir_not_writable");
    expect(() => assertStorageDirWritable(blocked)).toThrow("vision_config_invalid:storage_dir_not_writable");
    // uten STORE_SNAPSHOTS (kun vedlikehold av eksisterende filer) gjøres ingen skrivetest: kjøretiden bygges
    expect(buildVisionRuntime(stubs({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_STORAGE_DIR: blocked }))).not.toBeNull();
    // en skrivbar mappe (undermapper opprettes) godtas og får ingen rester
    const ok = join(dir, "vision", "images");
    expect(buildVisionRuntime(stubs({ ...on, JARVIS_VISION_STORAGE_DIR: ok }))).not.toBeNull();
    expect(await readdir(ok)).toEqual([]);
  });

  it("review B-L4: kjøretiden gir opplastingsruten en egen per-IP-grense (20 per minutt) som er per klient-IP", () => {
    const runtime = buildVisionRuntime(stubs({ JARVIS_VISION_ENABLED: "on" }));
    const limiter = runtime?.api.uploadLimiter;
    expect(limiter).toBeDefined();
    expect(VISION_UPLOADS_PER_IP_PER_MINUTE).toBe(20);
    for (let i = 0; i < VISION_UPLOADS_PER_IP_PER_MINUTE; i += 1) expect(limiter?.take("203.0.113.9"), `kall ${i + 1}`).toBe(true);
    expect(limiter?.take("203.0.113.9")).toBe(false);
    expect(limiter?.take("203.0.113.10")).toBe(true);
    runtime?.stop();
  });

  it("kun hovedbryter: rutene kan bygges, men ingen poller, ingen klassifisering og ingen bildelagring (hver del må slås på for seg)", () => {
    const runtime = buildVisionRuntime(stubs({ JARVIS_VISION_ENABLED: "on" }));
    expect(runtime).not.toBeNull();
    expect(runtime?.poller).toBeNull();
    expect(runtime?.pollerHandle).toBeNull();
    expect(runtime?.api.maxUploadBytes).toBe(5 * 1024 * 1024);
    runtime?.stop();
  });

  it("med HA-poll: polleren bygges og kan stoppes; en sky-embedding gir ingen vektorer (fail-closed) men kjøretiden bygges likevel", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cloudish = { ...new LocalHashEmbedding(), model: "cloud", dim: 8, locality: "cloud", embed: async () => [], minSimilarity: 0.5 } as never;
    const runtime = buildVisionRuntime(stubs({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_HA_POLL: "on" }, { memoryEmbedding: cloudish }));
    expect(runtime?.poller).not.toBeNull();
    runtime?.stop();
    expect(errors.mock.calls.map((c) => String(c[0])).join("\n")).toContain("vision_embeddings_disabled");
    errors.mockRestore();
  });
});

describe("JARVIS_VISION_MODEL_TIMEOUT_MS (review A-M2): knappen virker på selve modellkallet", () => {
  const withEnv = (e: Record<string, string> = {}): Record<string, string> => ({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: "http://127.0.0.1:11434", ...e });
  const classifyInput = { tenant_id: "t", task_id: "task-1", image: { bytes: JPEG, media_type: "image/jpeg" }, trigger: "motion_detected" } as const;

  it("standard 90 s, gyldig verdi leses, og grensene er 5 s til gatewayens harde tak - alt utenfor KASTER ved oppstart (aldri en stille klemming)", () => {
    expect(visionModelTimeoutMs(withEnv() as NodeJS.ProcessEnv)).toBe(90_000);
    expect(visionModelTimeoutMs(withEnv({ JARVIS_VISION_MODEL_TIMEOUT_MS: "45000" }) as NodeJS.ProcessEnv)).toBe(45_000);
    expect(VISION_MODEL_TIMEOUT_BOUNDS).toEqual({ min: 5_000, max: MAX_MODEL_TIMEOUT_MS });
    expect(visionModelTimeoutMs(withEnv({ JARVIS_VISION_MODEL_TIMEOUT_MS: String(MAX_MODEL_TIMEOUT_MS) }) as NodeJS.ProcessEnv)).toBe(MAX_MODEL_TIMEOUT_MS);
    for (const bad of ["4999", String(MAX_MODEL_TIMEOUT_MS + 1), "600000", "abc", "-1", "9.5"]) {
      const env = withEnv({ JARVIS_VISION_MODEL_TIMEOUT_MS: bad });
      expect(() => visionAdapterFromEnv(env as NodeJS.ProcessEnv), bad).toThrow(/JARVIS_VISION_MODEL_TIMEOUT_MS/);
      expect(() => buildVisionRuntime(stubs(env)), bad).toThrow(/JARVIS_VISION_MODEL_TIMEOUT_MS/);
    }
  });

  it("klassifisereren sender env-verdien som timeoutMs på HVERT modellkall (ikke en fast 90000)", async () => {
    for (const [value, expected] of [[undefined, 90_000], ["45000", 45_000], ["180000", 180_000], ["5000", 5_000]] as const) {
      const sent: number[] = [];
      const gateway = {
        complete: async (call: { timeoutMs: number }) => {
          sent.push(call.timeoutMs);
          return { text: "{\"detections\":[]}", provider: "local_vision", model: "m" };
        }
      };
      const runtime = buildVisionRuntime(stubs(withEnv(value === undefined ? {} : { JARVIS_VISION_MODEL_TIMEOUT_MS: value }), { gateway }));
      expect(runtime?.classifier, String(value)).toBeDefined();
      await runtime?.classifier?.classify(classifyInput);
      expect(sent, String(value)).toEqual([expected]);
      runtime?.stop();
    }
    // uten CLASSIFIER bygges ingen klassifiserer (og en ugyldig verdi spiller da ingen rolle)
    expect(buildVisionRuntime(stubs({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_MODEL_TIMEOUT_MS: "600000" }))?.classifier).toBeUndefined();
  });
});

describe("createVisionPollerGuard: kill switch, frosset connector, tilbakekalt credential", () => {
  const guard = (over: { kill?: boolean; frozen?: string[]; revoked?: string[] }) =>
    createVisionPollerGuard({
      killSwitch: { isActiveDurable: async () => over.kill === true },
      controls: { isFrozenDurable: async (id) => (over.frozen ?? []).includes(id), isRevokedDurable: async (ref) => (over.revoked ?? []).includes(ref) }
    });

  it("fri bane gir null; hver av de tre stansene gir sin kode, i rekkefølge kill switch -> frosset -> tilbakekalt", async () => {
    expect(await guard({}).blocked()).toBeNull();
    expect(await guard({ kill: true, frozen: ["home-assistant"], revoked: ["JARVIS_HA_TOKEN"] }).blocked()).toBe("kill_switch_active");
    expect(await guard({ frozen: ["home-assistant"], revoked: ["JARVIS_HA_TOKEN"] }).blocked()).toBe("connector_frozen");
    expect(await guard({ revoked: ["JARVIS_HA_TOKEN"] }).blocked()).toBe("credential_revoked");
    expect(await guard({ frozen: ["telegram"], revoked: ["JARVIS_TELEGRAM_TOKEN"] }).blocked()).toBeNull(); // andre connectorer påvirker ikke visjon
  });
});

describe("HA-kilden med den ENDELIGE guardedFetch (som i drift)", () => {
  let ha: FakeHaServer;
  const TOKEN = "canary-ha-credential-0003";
  const source = (base: () => Promise<string | null>) => new HomeAssistantVisionSource({ fetch: (url, init) => guardedFetch(url, init), baseUrl: base, token: async () => TOKEN });
  const cam = { camera_id: "vis-cam-1", source_ref: "camera.front", trigger_entities: ["binary_sensor.front_motion"] };

  beforeEach(async () => {
    ha = await FakeHaServer.start();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await ha.stop();
  });

  it("poll + ett bilde fungerer mot en lokal HA; Bearer kun i headeren", async () => {
    ha.setState("binary_sensor.front_motion", { state: "on", attributes: { device_class: "motion" }, last_changed: haTimestamp(new Date(Date.now() - 3_000)) });
    ha.setImage("camera.front", JPEG);
    const s = source(async () => ha.base);
    const events = await s.pollEvents([cam], new Date());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "motion_detected", trigger: "binary_sensor.front_motion" });
    const image = await s.fetchSnapshot(cam, 1_000_000);
    expect(image.declared_type).toBe("image/jpeg");
    expect(ha.requests.every((r) => r.authorization === `Bearer ${TOKEN}` && !r.url.includes(TOKEN))).toBe(true);
  });

  it("redirect avvises av guardedFetch (stabil kode, målet forespørres aldri); base-URL med brukerinfo/ikke-http/backslash avvises FØR noe sendes", async () => {
    ha.route("/api/camera_proxy/camera.front", (_req, res) => {
      res.writeHead(307, { location: "/api/camera_proxy/camera.other" });
      res.end();
    });
    ha.setImage("camera.other", JPEG);
    await expect(source(async () => ha.base).fetchSnapshot(cam, 1_000_000)).rejects.toThrow("unsafe_vendor_url:unexpected_redirect_http_307");
    expect(ha.requestsTo("/api/camera_proxy/camera.other")).toEqual([]);

    const before = ha.requests.length;
    for (const bad of [`http://user:pw@${ha.base.slice(7)}`, "file:///etc/passwd", `${ha.base}\\@evil.example`, "ftp://127.0.0.1"]) {
      await expect(source(async () => bad).fetchSnapshot(cam, 1_000_000), bad).rejects.toThrow(/unsafe_vendor_url:/);
    }
    expect(ha.requests.length).toBe(before);
  });
});

describe("kamerabilder når ALDRI en skymodell (ekte ModelGateway + ekte local_vision-adapter + ekte klassifisering)", () => {
  let server: Server | null = null;
  const received: Array<Record<string, unknown>> = [];

  function cloudSpy(name: string, calls: ModelRequest[]): ModelProviderAdapter {
    return {
      name, model: "m", available: () => true,
      async complete(request: ModelRequest): Promise<ModelResult> {
        calls.push(request);
        return { text: "{\"detections\":[{\"event_type\":\"object_detected\",\"object_label\":\"ryggsekk\",\"confidence\":0.9}]}", usage: { input_tokens: 1, output_tokens: 1 }, provider: name, model: "m", latency_ms: 1 };
      }
    };
  }
  const fakePool = (): pg.Pool => {
    const client = {
      query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }),
      release: () => undefined
    };
    return { connect: async () => client } as unknown as pg.Pool;
  };

  const timers: NodeJS.Timeout[] = [];
  async function localServer(behaviour: "ok" | "down" | "slow"): Promise<string> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (behaviour === "down") {
          res.writeHead(503);
          res.end();
          return;
        }
        const respond = (): void => {
          received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "{\"detections\":[{\"event_type\":\"object_detected\",\"object_label\":\"nøkler\",\"confidence\":0.88}]}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
        };
        // «slow»: svarer først etter 5,6 s - rett etter den minste tillatte grensen (5 s) for JARVIS_VISION_MODEL_TIMEOUT_MS.
        if (behaviour === "slow") timers.push(setTimeout(respond, 5_600));
        else respond();
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
  }

  beforeEach(() => {
    received.length = 0;
  });
  afterEach(async () => {
    for (const t of timers.splice(0)) clearTimeout(t);
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
    server = null;
  });

  // Slik main.ts bygger gatewayen: `local_vision`-profilen legges til registeret KUN når adapteren er registrert (review A-L3); uten den brukes standardregisteret.
  const visionGateway = (providers: ModelProviderAdapter[], withVisionProfile: boolean): ModelGateway =>
    new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers, ...(withVisionProfile ? { registry: new CapabilityRegistry(PROFILES_WITH_LOCAL_VISION) } : {}) });

  const classify = (gateway: ModelGateway) =>
    new VisionClassifier({ gateway }).classify({ tenant_id: "t", task_id: "task-1", image: { bytes: JPEG, media_type: "image/jpeg" }, trigger: "motion_detected" });

  it("flagg PÅ: bildet går til det lokale endepunktet (image_url data-URL), skyleverandørene kalles aldri, og klassifiseringen leses (ubetrodd) fra den lokale modellen", async () => {
    const url = await localServer("ok");
    const adapter = visionAdapterFromEnv({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: url } as NodeJS.ProcessEnv);
    const calls: ModelRequest[] = [];
    const clouds = ["anthropic", "openai", "gemini", "gemma_hosted", "kimi", "hermes"].map((n) => cloudSpy(n, calls));
    const gateway = visionGateway([...clouds, ...(adapter ? [adapter] : [])], adapter !== null);
    const outcome = await classify(gateway);
    expect(outcome).toMatchObject({ status: "classified", detections: [{ event_type: "object_detected", object_label: "nøkler" }] });
    expect(calls).toHaveLength(0);
    expect(received).toHaveLength(1);
    const userMessage = (received[0]?.["messages"] as Array<{ role: string; content: unknown }>).find((m) => Array.isArray(m.content));
    const parts = (userMessage?.content ?? []) as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("den lokale modellen er NEDE: klassifiseringen feiler lukket (model_unavailable) - og INGEN sky-fallback, selv om skyleverandørene er tilgjengelige", async () => {
    const url = await localServer("down");
    const adapter = visionAdapterFromEnv({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: url } as NodeJS.ProcessEnv);
    const calls: ModelRequest[] = [];
    const clouds = ["anthropic", "openai", "gemini", "gemma_hosted"].map((n) => cloudSpy(n, calls));
    const gateway = visionGateway([...clouds, ...(adapter ? [adapter] : [])], adapter !== null);
    expect(await classify(gateway)).toMatchObject({ status: "model_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("JARVIS_VISION_MODEL_TIMEOUT_MS=5000 (review A-M2): en modell som svarer etter 5,6 s gir model_unavailable - med den gamle konstanten (90 s per kall) ville svaret blitt klassifisert", async () => {
    const url = await localServer("slow");
    const env = { JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: url, JARVIS_VISION_MODEL_TIMEOUT_MS: "5000" };
    const adapter = visionAdapterFromEnv(env as NodeJS.ProcessEnv);
    const gateway = visionGateway(adapter ? [adapter] : [], adapter !== null);
    const runtime = buildVisionRuntime(stubs(env, { gateway }));
    const started = Date.now();
    const outcome = await runtime?.classifier?.classify({ tenant_id: "t", task_id: "task-1", image: { bytes: JPEG, media_type: "image/jpeg" }, trigger: "motion_detected" });
    expect(outcome).toMatchObject({ status: "model_unavailable" });
    // gatewayen prøver et tidsavbrudd én gang til (2 x 5 s); langt under de 90 s den gamle konstanten ville ventet
    expect(Date.now() - started).toBeLessThan(20_000);
    runtime?.stop();
  }, 40_000);

  it("flagg AV (ingen local_vision registrert): kun skyleverandører finnes - klassifiseringen feiler lukket og skyen kalles ALDRI (identisk fail-closed-oppførsel)", async () => {
    const calls: ModelRequest[] = [];
    const clouds = ["anthropic", "openai", "gemini", "gemma_hosted"].map((n) => cloudSpy(n, calls));
    expect(visionAdapterFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: clouds });
    const outcome = await classify(gateway);
    expect(outcome.status).toBe("model_unavailable");
    expect(calls).toHaveLength(0);
    await expect(gateway.complete({ tenant_id: "t", purpose: "VISION", request: { messages: [{ role: "user", content: [{ type: "image", media_type: "image/jpeg", data: "aGVsbG8=", restricted: true }] }] } })).rejects.toBeInstanceOf(LocalModelUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("en redirect fra den lokale modellen følges aldri (bildet sendes ikke videre) - klassifisert som utilgjengelig", async () => {
    const hits: string[] = [];
    const target = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200);
      res.end("{}");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    server = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/exfil` });
      res.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const adapter = visionAdapterFromEnv({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: url } as NodeJS.ProcessEnv);
    const gateway = visionGateway(adapter ? [adapter] : [], adapter !== null);
    try {
      expect(await classify(gateway)).toMatchObject({ status: "model_unavailable" });
      expect(hits).toEqual([]);
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("ProviderError er den eneste feilklassen som slipper gjennom lokalt (typesjekk av testens egen antakelse)", () => {
    expect(new ProviderError("local_vision", "server", "x", 500)).toBeInstanceOf(Error);
  });
});
