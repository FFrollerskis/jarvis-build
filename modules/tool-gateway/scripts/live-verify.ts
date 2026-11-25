// BO-04 live-verifisering gjennom Jarvis' egen stack. Printer ALDRI secrets.
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
  const i = line.indexOf("="); if (i > 0 && !line.startsWith("#")) process.env[line.slice(0, i)] ??= line.slice(i + 1).trim();
}
import { mkdtemp } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres"; import pg from "pg";
import { configuredGithubRepoFromEnv } from "@jarvis/contracts";
import { runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { DailyBrief, EnvSecretProvider, GithubTransport, GmailTransport, GoogleCalendarTransport, TelegramTransport, ToolGateway, buildStatusSource, calendarSource, emailSource, tasksSource } from "../src/index.ts";
const leasedPostgres = await startLeasedEmbeddedPostgres(async (leasedPort) =>
  new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), "jarvis-bo4-")), user: "postgres", password: "pw", port: leasedPort, persistent: false })
);
const epg = leasedPostgres.postgres;
const port = leasedPostgres.port;
await epg.createDatabase("jarvis_live");
const pool = new pg.Pool({ host: "127.0.0.1", port, database: "jarvis_live", user: "postgres", password: "pw" });
await runMigrations(pool);
await pool.query(`INSERT INTO tenants (tenant_id,name,kind) VALUES ('tenant-personal','Tobias','person');
  INSERT INTO people (person_id,display_name) VALUES ('person-tobias','Tobias');
  INSERT INTO person_tenants (person_id,tenant_id) VALUES ('person-tobias','tenant-personal');
  INSERT INTO tasks (task_id,tenant_id,owner_person_id,goal,contract,status) VALUES
   ('task-mac','tenant-personal','person-tobias','Mac mini: Apple-runtime (D-36)','{}'::jsonb,'created')`);
const killSwitch = new KillSwitch(); const controls = new OwnerControls(killSwitch);
const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: { consume: () => true }, killSwitch, controls,
  authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-personal"] } });
const gw = new ToolGateway(pool, policy, new EnvSecretProvider(), controls);
const { firstWaveTools } = await import("../src/integrations.ts");
for (const t of firstWaveTools({ email: new GmailTransport(), calendar: new GoogleCalendarTransport(), github: new GithubTransport(), telegram: new TelegramTransport() })) gw.register(t);
const owner = { person_id: "person-tobias", tenant_id: "tenant-personal", memory_space_id: "personal", session_id: "sess-bo4", device_id: "jarvis-core", channel: "api", auth_strength: "active" } as const;
const out: Record<string, unknown> = {};
const gmail = await gw.execute({ identity: owner as never, tool_id: "email", action: "read_inbox", parameters: { max: 10 } });
out["gmail"] = gmail.ok ? { LIVE: true, messages: ((gmail.data as { messages: unknown[] }).messages).length, account: process.env["JARVIS_GOOGLE_ACCOUNT"] } : { LIVE: false, reason: (gmail as { reason: string }).reason };
const now = new Date();
const cal = await gw.execute({ identity: owner as never, tool_id: "calendar", action: "read_events", parameters: { from: now.toISOString(), to: new Date(now.getTime() + 86400000).toISOString() } });
out["calendar"] = cal.ok ? { LIVE: true, events: ((cal.data as { events: unknown[] }).events).length } : { LIVE: false, reason: (cal as { reason: string }).reason };
const gh = await gw.execute({ identity: owner as never, tool_id: "github", action: "read_issues", parameters: { repo: configuredGithubRepoFromEnv(process.env) } });
out["github"] = gh.ok ? { LIVE: true, issues: ((gh.data as { issues: unknown[] }).issues).length } : { LIVE: false, reason: (gh as { reason: string }).reason };
const tg = await gw.execute({ identity: owner as never, tool_id: "telegram", action: "notify", parameters: { message: "Jarvis live connection verified." } });
out["telegram"] = tg.ok ? { LIVE: true, message_id: (tg as { external_id?: string }).external_id } : { LIVE: false, reason: (tg as { reason: string }).reason };
const brief = new DailyBrief([tasksSource(pool), buildStatusSource(gw, "docs/PROJECT_STATUS.md"), emailSource(gw), calendarSource(gw)], pool);
const artifact = await brief.generate(owner as never);
const delivered = await DailyBrief.deliverViaTelegram(gw, owner as never, artifact);
const artifact2 = await brief.generate(owner as never); // seen-state, andre kjøring
out["daily_brief"] = { generated: artifact.generated_at, top: artifact.top_priorities.length, sections: { today: artifact.today.length, attention: artifact.needs_attention.length, followups: artifact.follow_ups.length, fyi: artifact.fyi.length }, source_errors: artifact.source_errors, delivered_to_telegram: delivered, second_run_fyi: artifact2.fyi.length };
const seen = await pool.query("SELECT count(*)::int AS n, count(last_presented)::int AS presented FROM brief_seen");
const cost = await pool.query("SELECT kind, count(*)::int AS n FROM cost_events GROUP BY kind");
out["seen_state"] = seen.rows[0]; out["cost_events"] = cost.rows;
out["health"] = Object.fromEntries([...gw.health.entries()].map(([k, v]) => [k, v.state]));
const statusText = `JARVIS STATUS\nconnectors: ${Object.entries(out["health"] as Record<string,string>).map(([k,v])=>`${k}:${v}`).join(" ")}\nfase: v4.0 BO-04\nneste: Docker-porter + Mac mini (D-36)`;
const st = await gw.execute({ identity: owner as never, tool_id: "telegram", action: "notify", parameters: { message: statusText } });
out["status_delivered"] = st.ok;
console.log(JSON.stringify(out, null, 1));
await pool.end(); await leasedPostgres.stop();
