// BO-08 §45: live AI Mesh-akseptanse i container-runtime.
// Path: ModelGateway → AiRouter → valgt provider → normalized result → cost_event → Langfuse.
// Printer aldri secrets - kun statuser, tokens, reason og kost.
import { configFromEnv, createPool } from "@jarvis/core";
import {
  GeminiAdapter,
  KimiAdapter,
  AnthropicAdapter,
  OllamaAdapter,
  OpenAiAdapter
} from "@jarvis/provider-adapters";
import { LangfuseTraceSink, ModelGateway } from "../src/index.ts";

const pool = createPool(configFromEnv());
const trace = new LangfuseTraceSink(
  process.env["LANGFUSE_BASE_URL"] ?? "http://langfuse:3000",
  process.env["LANGFUSE_PUBLIC_KEY"] ?? "",
  process.env["LANGFUSE_SECRET_KEY"] ?? ""
);
const gateway = new ModelGateway({
  pool,
  trace,
  providers: [
    new OpenAiAdapter(undefined, process.env["JARVIS_OPENAI_MODEL"] ?? "gpt-4o-mini"),
    new AnthropicAdapter(),
    new GeminiAdapter(),
    new KimiAdapter(),
    new OllamaAdapter()
  ]
});

const result = await gateway.complete({
  tenant_id: "tenant-personal",
  session_id: "sess-mesh-live",
  task_id: "task-bo8-mesh",
  purpose: "QUICK_CLASSIFICATION",
  request: {
    system: "Svar med ett ord.",
    messages: [{ role: "user", content: "Er himmelen blå? Svar ja eller nei." }],
    max_tokens: 8
  }
});
console.log("routed-provider:", result.provider, "| model:", result.model);
console.log("text-len:", result.text.length, "| tokens:", result.usage.input_tokens, "/", result.usage.output_tokens);
console.log("latency_ms:", result.latency_ms, "| finish:", result.finish_reason);

const mesh = gateway.meshStatus();
console.log("mesh:", mesh.providers.map((p) => `${p.provider}=${p.state}`).join(" "));

const row = await pool.query(
  `SELECT kind, provider, model, purpose, success, fallback, critic, latency_ms, amount_ore
   FROM cost_events WHERE task_id='task-bo8-mesh' ORDER BY at DESC LIMIT 1`
);
console.log("cost_event:", JSON.stringify(row.rows[0] ?? null));
await pool.end();
