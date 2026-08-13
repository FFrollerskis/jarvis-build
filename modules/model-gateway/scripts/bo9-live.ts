// BO-09: multi-provider live-validering i container-runtime. Printer aldri secrets -
// kun statuser, reason codes, tokens, latency og øre. Providere uten credential
// rapporteres NOT_CONFIGURED (aldri fake LIVE).
import { configFromEnv, createPool } from "@jarvis/core";
import {
  AnthropicAdapter,
  GeminiAdapter,
  KimiAdapter,
  OllamaAdapter,
  OpenAiAdapter,
  ProviderError
} from "@jarvis/provider-adapters";
import type { ModelPurpose } from "@jarvis/contracts";
import { ModelGateway, traceSinkFromEnv } from "../src/index.ts";

const pool = createPool(configFromEnv());
const gateway = new ModelGateway({
  pool,
  trace: traceSinkFromEnv(),
  providers: [
    new OpenAiAdapter(undefined, process.env["JARVIS_OPENAI_MODEL"] ?? "gpt-4o-mini"),
    new AnthropicAdapter(),
    new GeminiAdapter(),
    new KimiAdapter(),
    new OllamaAdapter()
  ]
});

const routerInfo = (r: { metadata?: Record<string, unknown> }): string => {
  const info = r.metadata?.["router"] as { mode?: string; reason?: string } | undefined;
  return `${info?.mode}/${info?.reason}`;
};

// §9 AUTO router live - fem purposes, ekte kall.
const AUTO_TASKS: Array<{ purpose: ModelPurpose; prompt: string }> = [
  { purpose: "QUICK_CLASSIFICATION", prompt: "Klassifiser som POSITIV eller NEGATIV: 'dette var flott'. Svar ett ord." },
  { purpose: "SUMMARIZE", prompt: "Oppsummer i én setning: Jarvis er et personlig AI-operativsystem med policy-gateway og durable workers." },
  { purpose: "CODE", prompt: "Skriv en TypeScript-funksjon som summerer et tall-array. Kun kode." },
  { purpose: "REASON", prompt: "Hvis A>B og B>C, hva er relasjonen mellom A og C? Kort svar." },
  { purpose: "PLAN", prompt: "Lag en 3-punkts plan for å rydde en garasje. Kompakt." }
];
console.log("== AUTO ROUTING LIVE (§9) ==");
for (const t of AUTO_TASKS) {
  const started = Date.now();
  const r = await gateway.complete({
    tenant_id: "tenant-personal",
    session_id: "sess-bo9",
    task_id: `task-bo9-${t.purpose.toLowerCase()}`,
    purpose: t.purpose,
    request: { messages: [{ role: "user", content: t.prompt }], max_tokens: 120 }
  });
  console.log(
    `${t.purpose}: ${r.provider}:${r.model} | ${routerInfo(r)} | ${r.latency_ms ?? Date.now() - started}ms | tokens ${r.usage.input_tokens}/${r.usage.output_tokens}`
  );
}

// §8 owner override live.
console.log("== OWNER OVERRIDE LIVE (§8) ==");
const ov = await gateway.complete({
  tenant_id: "tenant-personal",
  session_id: "sess-bo9",
  task_id: "task-bo9-override",
  provider: "openai",
  request: { messages: [{ role: "user", content: "Si 'override-ok'." }], max_tokens: 8 }
});
console.log(`override: ${ov.provider} | ${routerInfo(ov)}`);

// §7C structured output live.
console.log("== STRUCTURED OUTPUT LIVE (§7C) ==");
const st = await gateway.complete({
  tenant_id: "tenant-personal",
  session_id: "sess-bo9",
  task_id: "task-bo9-structured",
  purpose: "EXTRACT",
  request: {
    messages: [{ role: "user", content: "Er vann vått? Returner JSON med feltet verdict (ja/nei)." }],
    max_tokens: 32,
    structured_schema: {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false
    }
  }
});
console.log(`structured: ${st.provider} | ${routerInfo(st)} | parsed=${JSON.stringify(st.structured_output)}`);

// §15-§16 critic/second opinion live (single- eller multi-provider avhengig av credentials).
console.log("== CRITIC / SECOND OPINION LIVE (§15-16) ==");
const cr = await gateway.complete({
  tenant_id: "tenant-personal",
  session_id: "sess-bo9",
  task_id: "task-bo9-critic",
  purpose: "PLAN",
  critic: true,
  request: { messages: [{ role: "user", content: "Foreslå plan: flytte database til ny server i ett steg uten backup." }], max_tokens: 150 }
});
const critic = cr.metadata?.["critic"] as { provider?: string; critique?: string } | undefined;
console.log(`primary: ${cr.provider} | critic-provider: ${critic?.provider} | critique-len: ${critic?.critique?.length ?? 0}`);

// §12 auth live: ugyldig nøkkel mot ekte endepunkt (direkte adapterkall - berører ikke gateway-health).
console.log("== AUTH FAILURE LIVE (§12) ==");
const badAuth = await new OpenAiAdapter("sk-invalid-bo9-test", "gpt-4o-mini")
  .complete({ messages: [{ role: "user", content: "x" }], max_tokens: 4 })
  .then(() => "UVENTET_SUKSESS")
  .catch((e: unknown) => (e instanceof ProviderError ? `${e.kind} (status ${e.status})` : "feil-type"));
console.log(`invalid key -> ${badAuth}`);

// §14 timeout live: 1 ms timeout mot ekte endepunkt.
console.log("== TIMEOUT LIVE (§14) ==");
const to = await new OpenAiAdapter(undefined, "gpt-4o-mini", "https://api.openai.com", 1)
  .complete({ messages: [{ role: "user", content: "x" }], max_tokens: 4 })
  .then(() => "UVENTET_SUKSESS")
  .catch((e: unknown) => (e instanceof ProviderError ? e.kind : "feil-type"));
console.log(`1ms timeout -> ${to}`);

// §25 mesh-status fra runtime-evidens.
console.log("== MESH STATUS (§25) ==");
const mesh = gateway.meshStatus();
console.log(mesh.providers.map((p) => `${p.provider}=${p.state}`).join(" "));
console.log(`router=${mesh.router} fallback=${mesh.fallback} critic=${mesh.critic}`);

// §19/§24: korrelasjon purpose/provider/success/latency/kost fra cost_events.
console.log("== QUALITY SIGNAL CORRELATION (§19) ==");
const corr = await pool.query(`
  SELECT purpose, provider, model, count(*) AS calls,
         round(avg(latency_ms)) AS avg_ms, sum(amount_ore) AS sum_ore,
         count(*) FILTER (WHERE NOT success) AS failures,
         count(*) FILTER (WHERE critic) AS critic_calls
  FROM cost_events
  WHERE session_id = 'sess-bo9' OR task_id LIKE 'task-bo9-%'
  GROUP BY purpose, provider, model ORDER BY purpose NULLS LAST`);
for (const row of corr.rows) {
  console.log(JSON.stringify(row));
}
await pool.end();
