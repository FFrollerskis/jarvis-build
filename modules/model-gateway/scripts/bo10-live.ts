// BO-10: multi-provider live closure i container-runtime. Printer aldri secrets.
// Kontrollerte transiente feil lages i wrapper-adaptere (berører aldri ekte nøkler);
// suksesskallene går mot ekte OpenAI- og Anthropic-API-er.
import { configFromEnv, createPool } from "@jarvis/core";
import {
  AnthropicAdapter,
  OpenAiAdapter,
  ProviderError,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult
} from "@jarvis/provider-adapters";
import type { ModelPurpose } from "@jarvis/contracts";
import { CapabilityRegistry, DEFAULT_PROFILES, ModelGateway, traceSinkFromEnv } from "../src/index.ts";

const pool = createPool(configFromEnv());
const OPENAI_MODEL = process.env["JARVIS_OPENAI_MODEL"] ?? "gpt-4o-mini";

function newGateway(providers: ModelProviderAdapter[], registry?: CapabilityRegistry): ModelGateway {
  return new ModelGateway({ pool, trace: traceSinkFromEnv(), providers, ...(registry ? { registry } : {}) });
}

/** Kontrollert transient feil: feiler N ganger med gitt kind, deretter ekte kall. */
class FlakyOnce implements ModelProviderAdapter {
  private failures: number;
  constructor(
    private readonly inner: ModelProviderAdapter,
    private readonly kind: "timeout" | "rate_limit" | "server",
    failures = 1
  ) {
    this.failures = failures;
  }
  get name(): string {
    return this.inner.name;
  }
  get model(): string | undefined {
    return this.inner.model;
  }
  available(): boolean {
    return this.inner.available();
  }
  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new ProviderError(this.name, this.kind, `${this.name}_${this.kind}_simulert`);
    }
    return this.inner.complete(request, onToken);
  }
}

const routerInfo = (r: ModelResult): string => {
  const info = r.metadata?.["router"] as { mode?: string; reason?: string; fallback_from?: string[] } | undefined;
  return `${info?.mode}/${info?.reason}${info?.fallback_from ? ` fallback_from=${info.fallback_from.join(",")}` : ""}`;
};
const REQ = (text: string, max = 60): ModelRequest => ({ messages: [{ role: "user", content: text }], max_tokens: max });

// ===== 2. ANTHROPIC LIVE =====
console.log("== ANTHROPIC LIVE (§2) ==");
const gw = newGateway([new OpenAiAdapter(undefined, OPENAI_MODEL), new AnthropicAdapter()]);
try {
  const claude = await gw.complete({
    tenant_id: "tenant-personal",
    session_id: "sess-bo10",
    task_id: "task-bo10-claude-live",
    provider: "anthropic",
    request: REQ("Si kun 'claude-live-ok'.", 20)
  });
  console.log(
    `anthropic: ${claude.provider}:${claude.model} | tokens ${claude.usage.input_tokens}/${claude.usage.output_tokens} | ${claude.latency_ms}ms | finish=${claude.finish_reason} | req-id=${claude.provider_request_id ? "SET" : "MANGLER"} | text-ok=${claude.text.includes("claude-live-ok")}`
  );
} catch (err) {
  const pe = err as ProviderError;
  console.log(`ANTHROPIC BLOCKER: kind=${pe.kind ?? "ukjent"} status=${pe.status ?? "-"} (${(pe.message ?? "").slice(0, 60)})`);
  process.exit(1);
}

// ===== 3. OWNER OVERRIDE BEGGE =====
console.log("== OWNER OVERRIDE (§3) ==");
for (const p of ["openai", "anthropic"] as const) {
  const r = await gw.complete({
    tenant_id: "tenant-personal", session_id: "sess-bo10", task_id: `task-bo10-ov-${p}`,
    provider: p, request: REQ("Si 'ok'.", 8)
  });
  console.log(`${p}: ${routerInfo(r)}`);
}

// ===== 4. AUTO =====
console.log("== AUTO (§4) ==");
const AUTO: Array<{ purpose: ModelPurpose; prompt: string }> = [
  { purpose: "QUICK_CLASSIFICATION", prompt: "POSITIV eller NEGATIV: 'elendig service'. Ett ord." },
  { purpose: "SUMMARIZE", prompt: "Oppsummer i én setning: AI Mesh ruter modellkall deterministisk." },
  { purpose: "CODE", prompt: "TypeScript-funksjon som reverserer en streng. Kun kode." },
  { purpose: "REASON", prompt: "Er alle kvadrater rektangler? Kort begrunnelse." },
  { purpose: "PLAN", prompt: "3-punkts plan for ukentlig backup-rutine. Kompakt." }
];
for (const t of AUTO) {
  const r = await gw.complete({
    tenant_id: "tenant-personal", session_id: "sess-bo10", task_id: `task-bo10-auto-${t.purpose.toLowerCase()}`,
    purpose: t.purpose, request: REQ(t.prompt, 120)
  });
  console.log(`${t.purpose}: ${r.provider}:${r.model} | ${routerInfo(r)} | ${r.latency_ms}ms`);
}

// ===== 5. LIVE CROSS-PROVIDER FALLBACK =====
console.log("== CROSS-PROVIDER FALLBACK (§5) ==");
// OpenAI → Claude: openai primær i AUTO; kontrollert timeout x2 (også retry) → anthropic ekte.
const gwA = newGateway([new FlakyOnce(new OpenAiAdapter(undefined, OPENAI_MODEL), "timeout", 2), new AnthropicAdapter()]);
const fbA = await gwA.complete({
  tenant_id: "tenant-personal", session_id: "sess-bo10", task_id: "task-bo10-fb-openai-claude",
  purpose: "CHAT", request: REQ("Si 'fallback-a-ok'.", 12)
});
console.log(`openai→claude: endte hos ${fbA.provider} | ${routerInfo(fbA)} | mesh.fallback=${gwA.meshStatus().fallback}`);

// Claude → OpenAI: registry-konfig gir anthropic førsteplass (konfigurerbart registry er designet for dette).
const claudeFirst = new CapabilityRegistry(
  DEFAULT_PROFILES.map((p) => (p.provider === "anthropic" ? { ...p, cost_class: 1 as const, latency_class: "fast" as const } : p))
);
const gwB = newGateway([new FlakyOnce(new AnthropicAdapter(), "timeout", 2), new OpenAiAdapter(undefined, OPENAI_MODEL)], claudeFirst);
const fbB = await gwB.complete({
  tenant_id: "tenant-personal", session_id: "sess-bo10", task_id: "task-bo10-fb-claude-openai",
  purpose: "CHAT", request: REQ("Si 'fallback-b-ok'.", 12)
});
console.log(`claude→openai: endte hos ${fbB.provider} | ${routerInfo(fbB)} | mesh.fallback=${gwB.meshStatus().fallback}`);

// ===== 6-8. AUTH / 429 / TIMEOUT =====
console.log("== AUTH/429/TIMEOUT (§6-8) ==");
const badAuth = await new AnthropicAdapter("sk-ant-invalid-bo10")
  .complete(REQ("x", 4))
  .then(() => "UVENTET_SUKSESS")
  .catch((e: unknown) => (e instanceof ProviderError ? `${e.kind} (status ${e.status})` : "feil-type"));
console.log(`anthropic ugyldig nøkkel -> ${badAuth}`);
const gwRL = newGateway([new FlakyOnce(new OpenAiAdapter(undefined, OPENAI_MODEL), "rate_limit", 1), new AnthropicAdapter()]);
const rl = await gwRL.complete({
  tenant_id: "tenant-personal", session_id: "sess-bo10", task_id: "task-bo10-429",
  purpose: "CHAT", request: REQ("Si 'rl-ok'.", 8)
});
console.log(`429-simulering: endte hos ${rl.provider} | health openai=${gwRL.health.state("openai", true)}`);
const toDirect = await new AnthropicAdapter(undefined, "claude-sonnet-5", "https://api.anthropic.com", 1)
  .complete(REQ("x", 4))
  .then(() => "UVENTET_SUKSESS")
  .catch((e: unknown) => (e instanceof ProviderError ? e.kind : "feil-type"));
console.log(`anthropic 1ms timeout -> ${toDirect}`);

// ===== 9-10. MULTI-PROVIDER CRITIC / SECOND OPINION =====
console.log("== MULTI-PROVIDER CRITIC (§9-10) ==");
const cr1 = await gw.complete({
  tenant_id: "tenant-personal", session_id: "sess-bo10", task_id: "task-bo10-critic-oa",
  provider: "openai", critic: true,
  request: REQ("Plan: slette alle logger daglig for å spare plass. Vurder.", 150)
});
const c1 = cr1.metadata?.["critic"] as { provider?: string; critique?: string };
console.log(`primary=openai critic=${c1?.provider} critique-len=${c1?.critique?.length ?? 0} ulik-provider=${c1?.provider !== "openai"}`);
const cr2 = await gw.complete({
  tenant_id: "tenant-personal", session_id: "sess-bo10", task_id: "task-bo10-critic-ao",
  provider: "anthropic", critic: true,
  request: REQ("Second opinion: er UUIDv4 egnet som primærnøkkel?", 150)
});
const c2 = cr2.metadata?.["critic"] as { provider?: string; critique?: string };
console.log(`primary=anthropic critic=${c2?.provider} critique-len=${c2?.critique?.length ?? 0} ulik-provider=${c2?.provider !== "anthropic"}`);

// ===== 11. BENCHMARK =====
console.log("== BENCHMARK OpenAI vs Claude (§11) ==");
const BENCH: Array<{ name: string; prompt: string; structured?: boolean }> = [
  { name: "classification", prompt: "POSITIV eller NEGATIV: 'fantastisk opplevelse'. Ett ord." },
  { name: "summarization", prompt: "Oppsummer i én setning: Postgres håndterer relasjonelle data med ACID-garantier." },
  { name: "code", prompt: "TypeScript-funksjon isPalindrome(s: string): boolean. Kun kode." },
  { name: "reasoning", prompt: "Tog A kjører 60 km/t, tog B 90 km/t samme vei med 30 km forsprang for A. Når tar B igjen A? Kort." },
  { name: "structured", prompt: "Returner KUN gyldig JSON: {\"land\":\"Norge\",\"hovedstad\":\"Oslo\"} for Sverige.", structured: true }
];
for (const provider of ["openai", "anthropic"] as const) {
  for (const b of BENCH) {
    const started = Date.now();
    try {
      const r = await gw.complete({
        tenant_id: "tenant-personal", session_id: "sess-bo10-bench", task_id: `task-bo10-bench-${provider}-${b.name}`,
        provider, request: REQ(b.prompt, 150)
      });
      let compliant = "-";
      if (b.structured) {
        try {
          const parsed = JSON.parse(r.text.replace(/```json|```/g, "").trim()) as { hovedstad?: string };
          compliant = String(Boolean(parsed.hovedstad));
        } catch {
          compliant = "false";
        }
      }
      console.log(
        `${provider}/${b.name}: OK ${r.latency_ms}ms tokens=${r.usage.input_tokens}/${r.usage.output_tokens} structured=${compliant}`
      );
    } catch (err) {
      console.log(`${provider}/${b.name}: FAIL ${(err as Error).message.slice(0, 60)} (${Date.now() - started}ms)`);
    }
  }
}

// ===== 12. HEALTH =====
console.log("== HEALTH (§12) ==");
const mesh = gw.meshStatus();
console.log(mesh.providers.map((p) => `${p.provider}=${p.state}${p.avg_latency_ms ? `(~${p.avg_latency_ms}ms)` : ""}`).join(" "));
console.log(`router=${mesh.router} fallback(gw)=${mesh.fallback} critic=${mesh.critic}`);

// ===== 14. COST_EVENTS multi-provider =====
console.log("== COST_EVENTS (§14) ==");
const corr = await pool.query(`
  SELECT provider, count(*) AS calls, count(*) FILTER (WHERE fallback) AS fallbacks,
         count(*) FILTER (WHERE critic) AS critic_calls, count(*) FILTER (WHERE NOT success) AS failures,
         round(avg(latency_ms)) AS avg_ms, sum(amount_ore) AS sum_ore
  FROM cost_events WHERE session_id LIKE 'sess-bo10%' GROUP BY provider ORDER BY provider`);
for (const row of corr.rows) console.log(JSON.stringify(row));
await pool.end();
