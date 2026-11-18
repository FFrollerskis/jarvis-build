import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalHashEmbedding } from "@jarvis/memory";
import { LocalModelUnavailableError, MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { ProviderError, type ModelProviderAdapter, type ModelRequest, type ModelResult } from "@jarvis/provider-adapters";
import { guardedFetch } from "@jarvis/tool-gateway";
import { HomeAssistantVisionSource, VisionClassifier, type VisionService } from "@jarvis/vision";
import { FakeHaServer, haTimestamp } from "../../../modules/vision/test/support/fake-ha-server.ts";
import { assertLocalVisionEndpoint, buildVisionRuntime, createVisionPollerGuard, visionAdapterFromEnv, visionFlagsFromEnv, VisionConfigError } from "../src/vision-runtime.ts";

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
    "http://172.16.5.4", "http://172.31.255.255:9", "http://169.254.1.1", "http://ollama-vision:11434", "http://gpu.lan", "http://gpu-box.home.arpa:11434", "http://workstation.local", "http://nas.internal/v1",
    "http://[fd12:3456::1]:11434", "http://[fe80::1]:11434", "https://localhost:8443"
  ];
  const REJECT: Array<[string, string]> = [
    ["https://api.openai.com/v1", "local_url_not_local"], ["http://8.8.8.8:11434", "local_url_not_local"], ["http://172.32.0.1", "local_url_not_local"], ["http://172.15.0.1", "local_url_not_local"],
    ["http://0.0.0.0:11434", "local_url_not_local"], ["http://example.com", "local_url_not_local"], ["http://vision.example.com:11434", "local_url_not_local"], ["http://localhost.evil.com", "local_url_not_local"],
    ["http://127.0.0.1.evil.com", "local_url_not_local"], ["http://evil.com/localhost", "local_url_not_local"], ["http://[2001:db8::1]:11434", "local_url_not_local"], ["http://11.0.0.1", "local_url_not_local"],
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
});

describe("main.ts: flagg-av-identitet i selve koblingen", () => {
  it("adapteren registreres kun via visionAdapterFromEnv (betinget spredning), kjøretiden kun når den ikke er null, og ruten/jobbene finnes ikke uten den", () => {
    expect(MAIN_SRC).toMatch(/const visionAdapter = visionAdapterFromEnv\(process\.env\);/);
    expect(MAIN_SRC).toMatch(/new OllamaAdapter\(\),\n\s*\.\.\.\(visionAdapter !== null \? \[visionAdapter\] : \[\]\)/);
    expect(MAIN_SRC).toMatch(/\.\.\.\(visionRuntime !== null \? \{ vision: visionRuntime\.api \} : \{\}\),/);
    expect(MAIN_SRC).toMatch(/if \(visionRuntime !== null\) \{\n\s*new DailyScheduler\(\n\s*pool, "vision-maintenance-sweep"/);
    // ingen annen kobling: `vision`-avhengigheten settes ikke andre steder, og ingen vision-adapter registreres ubetinget
    expect(MAIN_SRC.match(/vision: visionRuntime/g)).toHaveLength(1);
    expect(MAIN_SRC).not.toMatch(/new LocalOpenAiCompatibleAdapter\([^)]*local_vision/);
  });

  it("HA-kilden bruker guardedFetch (ingen global fetch), og HA-credentials er de eksisterende (vault-kjeden), aldri nye navn", () => {
    expect(RUNTIME_SRC).toMatch(/guardedFetch\(url, init\)/);
    expect(RUNTIME_SRC).not.toMatch(/(?<![.\w])fetch\(/);
    expect(RUNTIME_SRC).toContain('deps.secrets.get("JARVIS_HA_BASE_URL")');
    expect(RUNTIME_SRC).toContain('deps.secrets.get("JARVIS_HA_TOKEN")');
  });
});

describe("buildVisionRuntime", () => {
  const stubs = (envVars: Record<string, string>, over: Record<string, unknown> = {}) => ({
    pool: {} as pg.Pool, env: envVars as NodeJS.ProcessEnv, vision: {} as VisionService, gateway: { complete: async () => ({ text: "{}", provider: "local_vision", model: "m" }) },
    memoryEmbedding: new LocalHashEmbedding(), devices: { approverFor: async () => undefined }, secrets: { get: async () => null },
    ownerControls: { killSwitch: { isActiveDurable: async () => false }, controls: { isFrozenDurable: async () => false, isRevokedDurable: async () => false } }, ...over
  });

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
  const TOKEN = "ha-llat-SECRET-api-3d9e";
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

  async function localServer(behaviour: "ok" | "down"): Promise<string> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (behaviour === "down") {
          res.writeHead(503);
          res.end();
          return;
        }
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "{\"detections\":[{\"event_type\":\"object_detected\",\"object_label\":\"nøkler\",\"confidence\":0.88}]}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
  }

  beforeEach(() => {
    received.length = 0;
  });
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
    server = null;
  });

  const classify = (gateway: ModelGateway) =>
    new VisionClassifier({ gateway }).classify({ tenant_id: "t", task_id: "task-1", image: { bytes: JPEG, media_type: "image/jpeg" }, trigger: "motion_detected" });

  it("flagg PÅ: bildet går til det lokale endepunktet (image_url data-URL), skyleverandørene kalles aldri, og klassifiseringen leses (ubetrodd) fra den lokale modellen", async () => {
    const url = await localServer("ok");
    const adapter = visionAdapterFromEnv({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: url } as NodeJS.ProcessEnv);
    const calls: ModelRequest[] = [];
    const clouds = ["anthropic", "openai", "gemini", "gemma_hosted", "kimi", "hermes"].map((n) => cloudSpy(n, calls));
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [...clouds, ...(adapter ? [adapter] : [])] });
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
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [...clouds, ...(adapter ? [adapter] : [])] });
    expect(await classify(gateway)).toMatchObject({ status: "model_unavailable" });
    expect(calls).toHaveLength(0);
  });

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
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: adapter ? [adapter] : [] });
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
