import { describe, expect, it } from "vitest";
import type pg from "pg";
import { ProviderError, type ContentPart, type ModelProviderAdapter, type ModelRequest, type ModelResult, type StreamEvent } from "@jarvis/provider-adapters";
import { CapabilityRegistry, DEFAULT_PROFILES, LocalModelUnavailableError, MemoryTraceSink, ModelGateway, NoEligibleProviderError, PROFILES_WITH_LOCAL_VISION, type CompleteInput } from "../src/index.ts";

/**
 * WP-G3 (D-465), P1b: «skyvisjon for kamerabilder er FORBUDT, hindret i kode og test». Et kamerabilde er en bildedel med `restricted: true`.
 * Det som bevises her (alle mot `ModelGateway` med fake adaptere, ingen nettkall):
 *   A. uten at kalleren oppgir NOE sensitivitet/modus går bildet kun til den lokale visjonsleverandøren,
 *   B. en kaller som ber om en skyleverandør eksplisitt (eier-override) eller oppgir lav sensitivitet får ikke bildet sendt dit,
 *   C. når den lokale leverandøren FEILER, finnes det INGEN fallback til sky (feilen kastes; skyadapterne er aldri kalt),
 *   D. en preferanseliste med sky først hopper over skyen,
 *   E. utførelseslåsen i `executePlan` virker UAVHENGIG av ruteren (en plan med en skykandidat får aldri kalle den) og regner en ukjent
 *      leverandør som sky,
 *   F. streaming-banen har samme lås,
 *   G. flagg-AV-identitet: et vanlig bilde (uten `restricted`) rutes som før - til skyen,
 *   H. `local_vision` er dedikert til `vision`: vanlig prat velger den aldri.
 */
function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }),
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

interface Fake extends ModelProviderAdapter {
  calls: ModelRequest[];
}

function fake(name: string, behaviour: "ok" | "fail" = "ok"): Fake {
  const calls: ModelRequest[] = [];
  return {
    name,
    model: "m",
    calls,
    available: () => true,
    async complete(request: ModelRequest, onToken?: (t: string) => void): Promise<ModelResult> {
      calls.push(request);
      if (behaviour === "fail") throw new ProviderError(name, "server", `${name}_server_500`, 500);
      onToken?.("{\"detections\":[]}");
      return { text: "{\"detections\":[]}", usage: { input_tokens: 1, output_tokens: 1 }, provider: name, model: "m", latency_ms: 1 };
    }
  };
}

const IMAGE: ContentPart = { type: "image", media_type: "image/jpeg", data: "aGVsbG8=", restricted: true };
const PLAIN_IMAGE: ContentPart = { type: "image", media_type: "image/jpeg", data: "aGVsbG8=" };
const request = (image: ContentPart = IMAGE): ModelRequest => ({ messages: [{ role: "user", content: [{ type: "text", text: "klassifiser" }, image] }] });
// Slik main.ts bygger gatewayen når `local_vision`-adapteren ER registrert: registeret får den lokale profilen (den står bevisst ikke i DEFAULT_PROFILES, review A-L3).
const make = (providers: ModelProviderAdapter[]): ModelGateway => new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers, registry: new CapabilityRegistry(PROFILES_WITH_LOCAL_VISION) });
const base = (over: Partial<CompleteInput> = {}): CompleteInput => ({ tenant_id: "t", purpose: "VISION", request: request(), ...over });

describe("A: kamerabilder går kun til lokal leverandør, selv uten sensitivitet/modus fra kalleren", () => {
  it("uten sensitivity/mode/provider: kun local_vision kalles; anthropic og gemma_hosted aldri", async () => {
    const cloud = fake("anthropic");
    const hosted = fake("gemma_hosted");
    const local = fake("local_vision");
    const result = await make([cloud, hosted, local]).complete(base({ required_capabilities: ["vision"] }));
    expect(result.provider).toBe("local_vision");
    expect(cloud.calls).toHaveLength(0);
    expect(hosted.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(1);
  });

  it("også uten required_capabilities: skyleverandører er stengt av låsen (ruten er sensitivitet SECRET_RESTRICTED)", async () => {
    const cloud = fake("anthropic");
    const local = fake("local_vision");
    await make([cloud, local]).complete({ tenant_id: "t", purpose: "VISION", request: request() });
    expect(cloud.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(1);
  });

  it("ingen lokal leverandør konfigurert: feiler lukket (LocalModelUnavailableError, ruten er LOCAL) og skyen kalles ikke", async () => {
    const cloud = fake("anthropic");
    await expect(make([cloud]).complete(base())).rejects.toBeInstanceOf(LocalModelUnavailableError);
    expect(cloud.calls).toHaveLength(0);
  });
});

describe("B: eksplisitte valg og lav sensitivitet omgår ikke låsen", () => {
  it("provider: anthropic (eier-override) avvises, bildet sendes ikke", async () => {
    const cloud = fake("anthropic");
    const local = fake("local_vision");
    await expect(make([cloud, local]).complete(base({ provider: "anthropic" }))).rejects.toBeInstanceOf(NoEligibleProviderError);
    expect(cloud.calls).toHaveLength(0);
    expect(local.calls).toHaveLength(0);
  });

  it("sensitivity: PUBLIC_OR_LOW_SENSITIVITY og paid_models_allowed: true fra kalleren overstyres (kun innstramming)", async () => {
    const cloud = fake("anthropic");
    const hosted = fake("gemma_hosted");
    const local = fake("local_vision");
    const result = await make([cloud, hosted, local]).complete(base({ sensitivity: "PUBLIC_OR_LOW_SENSITIVITY", paid_models_allowed: true, mode: "QUALITY", required_capabilities: ["vision"] }));
    expect(result.provider).toBe("local_vision");
    expect(cloud.calls.length + hosted.calls.length).toBe(0);
  });
});

describe("C: lokal feil gir ALDRI sky-fallback", () => {
  it("local_vision feiler (500): feilen kastes og anthropic/gemma_hosted er aldri kalt", async () => {
    const cloud = fake("anthropic");
    const hosted = fake("gemma_hosted");
    const local = fake("local_vision", "fail");
    await expect(make([cloud, hosted, local]).complete(base({ required_capabilities: ["vision"] }))).rejects.toBeInstanceOf(ProviderError);
    expect(cloud.calls).toHaveLength(0);
    expect(hosted.calls).toHaveLength(0);
    expect(local.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("D: preferanseliste med sky først", () => {
  it("providerPreference [anthropic, local_vision]: skyen hoppes over, lokal brukes", async () => {
    const cloud = fake("anthropic");
    const local = fake("local_vision");
    const result = await make([cloud, local]).complete(base({ providerPreference: ["anthropic", "local_vision"], required_capabilities: ["vision"] }));
    expect(result.provider).toBe("local_vision");
    expect(cloud.calls).toHaveLength(0);
  });
});

describe("E: utførelseslåsen i executePlan er uavhengig av ruteren", () => {
  type ExecutePlan = (input: CompleteInput, plan: unknown, traceId: string, started: number, budgetLevel: string, isCritic: boolean) => Promise<ModelResult>;
  const run = (gateway: ModelGateway, plan: { candidates: Array<{ provider: string; model: string }> }, req: ModelRequest = request()): Promise<ModelResult> =>
    (gateway as unknown as { executePlan: ExecutePlan }).executePlan({ tenant_id: "t", request: req }, { mode: "AUTO", reason: "DEFAULT_BALANCED", ...plan }, "trace-test", Date.now(), "ok", false);

  it("en plan som (feilaktig) har en skykandidat FØRST: skyen kalles aldri, den lokale tar over", async () => {
    const cloud = fake("anthropic");
    const local = fake("local_vision");
    const failures: string[] = [];
    const gateway = make([cloud, local]);
    const result = await (gateway as unknown as { executePlan: (...a: unknown[]) => Promise<ModelResult> }).executePlan(
      { tenant_id: "t", request: request(), onAttemptFailed: (f: { provider: string; kind: string }) => failures.push(`${f.provider}:${f.kind}`) },
      { mode: "AUTO", reason: "DEFAULT_BALANCED", candidates: [{ provider: "anthropic", model: "m" }, { provider: "local_vision", model: "m" }] },
      "trace-test", Date.now(), "ok", false
    );
    expect(result.provider).toBe("local_vision");
    expect(cloud.calls).toHaveLength(0);
    expect(failures).toEqual(["anthropic:restricted_media_blocked"]);
  });

  it("en plan med KUN skykandidater feiler lukket (bad_request), ingenting sendt", async () => {
    const cloud = fake("anthropic");
    const hosted = fake("gemma_hosted");
    const gateway = make([cloud, hosted]);
    await expect(run(gateway, { candidates: [{ provider: "anthropic", model: "m" }, { provider: "gemma_hosted", model: "m" }] })).rejects.toMatchObject({ kind: "bad_request" });
    expect(cloud.calls.length + hosted.calls.length).toBe(0);
  });

  it("en leverandør som ikke står i registeret regnes som sky (fail-closed) og blokkeres", async () => {
    const unknown = fake("ukjent_leverandor");
    const gateway = make([unknown]);
    await expect(run(gateway, { candidates: [{ provider: "ukjent_leverandor", model: "m" }] })).rejects.toMatchObject({ kind: "bad_request" });
    expect(unknown.calls).toHaveLength(0);
  });

  it("uten restricted-del slipper skykandidaten gjennom som før (identisk oppførsel for alle eksisterende kall)", async () => {
    const cloud = fake("anthropic");
    const gateway = make([cloud]);
    const result = await run(gateway, { candidates: [{ provider: "anthropic", model: "m" }] }, request(PLAIN_IMAGE));
    expect(result.provider).toBe("anthropic");
    expect(cloud.calls).toHaveLength(1);
  });
});

describe("F: streaming-banen har samme lås", () => {
  it("stream() med et restricted bilde går kun til lokal leverandør", async () => {
    const cloud = fake("anthropic");
    const local = fake("local_vision");
    const events: StreamEvent[] = [];
    const result = await make([cloud, local]).stream(base({ required_capabilities: ["vision"] }), (e) => events.push(e));
    expect(result.provider).toBe("local_vision");
    expect(cloud.calls).toHaveLength(0);
  });
});

describe("G: flagg-AV-identitet", () => {
  it("et vanlig bilde (uten restricted) rutes uendret: provider: anthropic fungerer, og sensitivitet røres ikke", async () => {
    const cloud = fake("anthropic");
    const result = await make([cloud]).complete({ tenant_id: "t", purpose: "VISION", provider: "anthropic", request: request(PLAIN_IMAGE) });
    expect(result.provider).toBe("anthropic");
    expect(cloud.calls).toHaveLength(1);
  });
});

describe("H: local_vision er dedikert til vision", () => {
  it("vanlig prat (ingen vision-krav) velger aldri local_vision - selv når den er eneste lokale leverandør", async () => {
    const local = fake("local_vision");
    await expect(make([local]).complete({ tenant_id: "t", purpose: "CHAT", request: { messages: [{ role: "user", content: "hei" }] } })).rejects.toBeInstanceOf(NoEligibleProviderError);
    expect(local.calls).toHaveLength(0);
  });

  it("et kall som krever vision og er lokalt velger den", async () => {
    const local = fake("local_vision");
    const result = await make([local]).complete({ tenant_id: "t", purpose: "VISION", mode: "LOCAL", request: request(PLAIN_IMAGE) });
    expect(result.provider).toBe("local_vision");
  });
});

describe("I: local_vision-profilen står UTENFOR standardregisteret (review A-L3: flagg-AV er identisk med main)", () => {
  const MAIN_PROVIDERS = ["openai", "anthropic", "gemini", "gemma_hosted", "local_llm", "gemma_local", "kimi", "hermes", "ollama", "scripted"];

  it("DEFAULT_PROFILES er nøyaktig main sin liste (ingen local_vision), og profilen legges til kun via PROFILES_WITH_LOCAL_VISION", () => {
    expect(DEFAULT_PROFILES.map((p) => p.provider)).toEqual(MAIN_PROVIDERS);
    expect(new CapabilityRegistry().get("local_vision")).toBeUndefined();
    expect(PROFILES_WITH_LOCAL_VISION.map((p) => p.provider)).toEqual([...MAIN_PROVIDERS, "local_vision"]);
    expect(new CapabilityRegistry(PROFILES_WITH_LOCAL_VISION).get("local_vision")).toMatchObject({ locality: "local", dedicated_to: "vision", capabilities: ["text", "vision"] });
  });

  it("uten profilen regnes en leverandør som heter local_vision som SKY (fail-closed): kamerabilder sendes ikke dit selv om adapteren finnes", async () => {
    const stray = fake("local_vision");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [stray] }); // standardregisteret, uten local_vision-profil
    await expect(gateway.complete(base({ required_capabilities: ["vision"] }))).rejects.toBeInstanceOf(LocalModelUnavailableError);
    expect(stray.calls).toHaveLength(0);
  });
});

describe("J: critic arver låsen for kamerabilder (review A-L1)", () => {
  const meta = (r: ModelResult): Record<string, unknown> => (r.metadata ?? {}) as Record<string, unknown>;

  it("med arven intakt: en critic kalles aldri på en skyleverandør, og bildet sendes aldri dit", async () => {
    const cloud = fake("anthropic");
    const hosted = fake("gemma_hosted");
    const local = fake("local_vision");
    const result = await make([cloud, hosted, local]).complete(base({ required_capabilities: ["vision"], critic: true }));
    expect(result.provider).toBe("local_vision");
    expect(cloud.calls.length + hosted.calls.length).toBe(0);
  });

  it("med arven FJERNET (simulert: lockRestrictedMedia gjør ingenting): criticveien stenger selv - ingen skykall, feilen står i metadata og primærsvaret er uberørt", async () => {
    const cloud = fake("anthropic");
    const hosted = fake("gemma_hosted");
    const local = fake("local_vision");
    const gateway = make([cloud, hosted, local]);
    (gateway as unknown as { lockRestrictedMedia: (input: CompleteInput) => CompleteInput }).lockRestrictedMedia = (input) => input;
    const result = await gateway.complete(base({ providerPreference: ["local_vision"], required_capabilities: ["vision"], critic: true }));
    expect(result.provider).toBe("local_vision");
    expect(result.text).toBe("{\"detections\":[]}");
    expect(cloud.calls.length + hosted.calls.length).toBe(0);
    expect(meta(result)["critic_error"]).toBe("critic_restricted_media_nonlocal");
    expect(meta(result)["critic"]).toBeUndefined();
  });

  it("HVER critic-kandidat sjekkes, ikke bare den første: en LOKAL kandidat først og en SKY-kandidat som backup stenger også (review delta A LOW-D4)", async () => {
    // Criticplanen er rangert etter kvalitet (QUALITY): en lokal critic-modell med kvalitet 5/rask rangeres FØR anthropic (kvalitet 5/medium). Planen er da [local_llm, anthropic, ...]: skyen ligger bak som
    // fallback og ville blitt kalt med et svar avledet av kamerabildet hvis bare første kandidat ble sjekket (og den lokale critic-modellen feilet). local_llm har en eksplisitt pris (gatewayen krever det for alle
    // registrerte leverandører); profilen overstyres her kun for å få den øverst i rangeringen.
    const standardLocalLlm = DEFAULT_PROFILES.find((p) => p.provider === "local_llm");
    if (standardLocalLlm === undefined) throw new Error("local_llm_profile_missing");
    const criticLocalProfile = { ...standardLocalLlm, locality: "local" as const, quality_class: 5 as const, latency_class: "fast" as const, capabilities: ["text" as const, "reasoning" as const] };
    const cloud = fake("anthropic");
    const criticLocal = fake("local_llm");
    const local = fake("local_vision");
    const gateway = new ModelGateway({
      pool: fakePool(), trace: new MemoryTraceSink(), providers: [cloud, criticLocal, local], registry: new CapabilityRegistry([...PROFILES_WITH_LOCAL_VISION, criticLocalProfile])
    });
    (gateway as unknown as { lockRestrictedMedia: (input: CompleteInput) => CompleteInput }).lockRestrictedMedia = (input) => input;
    const result = await gateway.complete(base({ providerPreference: ["local_vision"], required_capabilities: ["vision"], critic: true }));
    expect(result.provider).toBe("local_vision");
    expect(meta(result)["critic_error"]).toBe("critic_restricted_media_nonlocal");
    expect(meta(result)["critic"]).toBeUndefined();
    expect(cloud.calls).toHaveLength(0);
    expect(criticLocal.calls).toHaveLength(0); // stengt FØR noen critic-kandidat kalles (også den lokale)
    // Kontroll: kun lokale critic-kandidater (ingen sky i puljen) gir en vanlig critic-kjøring - den lokale critic-modellen kalles, og får ikke bildet.
    const onlyLocal = fake("local_llm");
    const local2 = fake("local_vision");
    const localGateway = new ModelGateway({
      pool: fakePool(), trace: new MemoryTraceSink(), providers: [onlyLocal, local2], registry: new CapabilityRegistry([...PROFILES_WITH_LOCAL_VISION, criticLocalProfile])
    });
    (localGateway as unknown as { lockRestrictedMedia: (input: CompleteInput) => CompleteInput }).lockRestrictedMedia = (input) => input;
    const ok = await localGateway.complete(base({ providerPreference: ["local_vision"], required_capabilities: ["vision"], critic: true }));
    expect(meta(ok)["critic_error"]).toBeUndefined();
    expect(onlyLocal.calls).toHaveLength(1);
    expect(JSON.stringify(onlyLocal.calls[0])).not.toContain("aGVsbG8="); // criticen får kun tekst (primærsvaret), aldri bildedataene
  });

  it("non-vakuitet: uten restricted-del beholder criticen sin vanlige skyvei (identisk oppførsel for alle eksisterende kall)", async () => {
    const cloud = fake("anthropic");
    const second = fake("openai");
    const result = await make([cloud, second]).complete({ tenant_id: "t", purpose: "CHAT", provider: "anthropic", critic: true, request: { messages: [{ role: "user", content: "hei" }] } });
    expect(result.provider).toBe("anthropic");
    expect(meta(result)["critic_error"]).toBeUndefined();
    expect(second.calls).toHaveLength(1);
  });
});
