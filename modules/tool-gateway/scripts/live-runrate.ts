import { mkdtemp } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres"; import pg from "pg";
import { runMigrations } from "@jarvis/core";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { OpenAiAdapter } from "@jarvis/provider-adapters";
const port = 34567;
const epg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(),"jarvis-live-")), user:"postgres", password:"pw", port, persistent:false });
await epg.initialise(); await epg.start(); await epg.createDatabase("jarvis_live");
const pool = new pg.Pool({ host:"127.0.0.1", port, database:"jarvis_live", user:"postgres", password:"pw" });
await runMigrations(pool);
await pool.query("INSERT INTO tenants (tenant_id,name,kind) VALUES ('tenant-personal','T','person')");
const trace = new MemoryTraceSink();
const gw = new ModelGateway({ pool, trace, providers:[new OpenAiAdapter(undefined, process.env["JARVIS_OPENAI_MODEL"] ?? "gpt-4o-mini")] });
const started = Date.now();
const res = await gw.complete({ tenant_id:"tenant-personal", session_id:"sess-live-1", task_id:"task-live-runrate",
  request:{ system:"Svar med maks fem ord.", messages:[{ role:"user", content:"Bekreft: Jarvis live-runrate-verifisering." }], max_tokens: 24 } });
const row = await pool.query("SELECT provider,model,input_tokens,output_tokens,amount_ore,task_id,session_id FROM cost_events");
console.log(JSON.stringify({ reply: res.text, latency_ms: Date.now()-started, usage: res.usage, cost_events: row.rows, trace: trace.spans.map(s=>({kind:s.kind,name:s.name,cost_ore:s.cost_ore,duration_ms:s.duration_ms})) }, null, 1));
await pool.end(); await epg.stop();
