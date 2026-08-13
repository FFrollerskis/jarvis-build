import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalSigningBytes, type ApprovalPayload, type SignedApproval } from "@jarvis/contracts";
import {
  ContextBuilder,
  IdentityService,
  MessageStore,
  PgApprovalStore,
  SessionService,
  createPool,
  runMigrations,
  withTenantTransaction
} from "@jarvis/core";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FailingAdapter, ScriptedAdapter } from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { createApiServer } from "../src/server.ts";

const PORT = 30000 + Math.floor(Math.random() * 20000);
const watchKeys = generateKeyPairSync("ed25519");

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;
let scripted: ScriptedAdapter;
let trace: MemoryTraceSink;
let worker: InProcessWorker;
let gateway: ModelGateway;

const webIdentity = {
  person_id: "person-tobias",
  tenant_id: "tenant-personal",
  device_id: "dev-web",
  memory_space: "personal",
  channel: "web"
} as const;

function makeApproval(overrides: Partial<ApprovalPayload> = {}): SignedApproval {
  const payload: ApprovalPayload = {
    action: "critical_demo",
    parameters: { confirm: true },
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    nonce: `nonce-${randomUUID()}`,
    approving_device_id: "watch-1",
    ...overrides
  };
  const signature = sign(null, approvalSigningBytes(payload), watchKeys.privateKey).toString("base64");
  return { ...payload, signature };
}

async function chat(message: string, identity: Record<string, string> = webIdentity) {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...identity, message })
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg3-"));
  epg = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "test-superuser-pw",
    port: PORT,
    persistent: false
  });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({
    host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "test-superuser-pw"
  });
  // Teardown-race (embedded-PG): server-terminert klient skal aldri bli uncaught.
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'test-app-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES
      ('tenant-personal', 'Tobias personlig', 'person'),
      ('tenant-budget', 'Budsjett-test', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias', 'Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES
      ('person-tobias', 'tenant-personal'), ('person-tobias', 'tenant-budget');
    INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES
      ('dev-web', 'tenant-personal', 'person-tobias', 'web'),
      ('dev-web-b', 'tenant-budget', 'person-tobias', 'web');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('sp-personal', 'tenant-personal', 'personal'),
      ('sp-budget', 'tenant-budget', 'personal');
    -- Simulert forbruk over hardgrensen (3 000 kr = 300 000 øre) for tenant-budget:
    INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ('tenant-budget', 'model:test', 310000);
  `);

  appPool = createPool({
    host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "test-app-pw"
  });

  const devices = new InMemoryDeviceRegistry();
  devices.register("watch-1", watchKeys.publicKey);
  const policy = new PolicyGateway({
    devices,
    nonces: new PgApprovalStore(appPool),
    killSwitch: new KillSwitch()
  });
  scripted = new ScriptedAdapter((req) =>
    // BO-11.1 §7: "langsom" gir mange tokens (~1 ms hver i stream) slik at
    // klient-frakobling deterministisk treffer midt i genereringen.
    req.messages.at(-1)?.content.includes("langsom")
      ? Array.from({ length: 150 }, (_, i) => `ord${i} `).join("")
      : "Hei Tobias, dette er et modellsvar."
  );
  trace = new MemoryTraceSink();
  gateway = new ModelGateway({
    pool: appPool,
    trace,
    providers: [new FailingAdapter(), scripted] // beviser også fallback: failing → scripted
  });
  const queue = new PgTaskQueue(appPool);
  worker = new InProcessWorker(queue);
  worker.register("executive", async (task) => ({ echo: task.contract.goal }));
  server = createApiServer({
    identity: new IdentityService(appPool),
    sessions: new SessionService(appPool),
    policy,
    worker,
    conversation: new ConversationEngine({
      messages: new MessageStore(appPool),
      context: new ContextBuilder(appPool),
      gateway,
      tasks: new TaskService(appPool, queue, policy),
      worker,
      trace
    })
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("Akseptanse 1: samtale oppretter og følger jobb til sluttstatus", () => {
  it("opprett jobb → worker kjører → jobbstatus viser completed", async () => {
    const created = await chat("opprett jobb: skriv ukesrapport");
    expect(created.status).toBe(200);
    const taskId = created.body["task_id"] as string;
    expect(taskId).toMatch(/^task-/);
    expect(created.body["routed"]).toBe("fast");

    const before = await chat(`jobbstatus ${taskId}`);
    expect(before.body["reply"]).toContain("created");

    await fetch(`${baseUrl}/worker/tick`, { method: "POST" });

    const after = await chat(`jobbstatus ${taskId}`);
    expect(after.body["reply"]).toContain("completed");
    expect(after.body["reply"]).toContain("skriv ukesrapport");
  });
});

describe("Akseptanse 2: modellkall har kostnad knyttet til session/task", () => {
  it("modellsvar skriver cost_events-rad og trace-span med kostnad", async () => {
    const result = await chat("hva synes du om planen min?");
    expect(result.body["routed"]).toBe("model");
    const sessionId = result.body["session_id"] as string;

    const cost = await withTenantTransaction(appPool, "tenant-personal", (c) =>
      // UA-1: også feilforsøk (failing-provider) logges som egne rader - filtrer på suksessraden.
      c.query("SELECT kind, amount_ore, session_id FROM cost_events WHERE session_id = $1 AND kind = 'model:scripted'", [sessionId])
    );
    expect(cost.rows.length).toBeGreaterThan(0);
    expect(cost.rows[0].kind).toBe("model:scripted");
    expect(Number(cost.rows[0].amount_ore)).toBeGreaterThan(0);

    const span = trace.spans.find((s) => s.kind === "model_call" && s.session_id === sessionId);
    expect(span).toBeDefined();
    expect(span?.cost_ore).toBeGreaterThan(0);
  });

  it("fallback: første provider feiler, neste brukes", async () => {
    const result = await chat("fortell en kort vits");
    expect(result.body["routed"]).toBe("model");
    expect((result.body["reply"] as string).length).toBeGreaterThan(0);
  });
});

describe("Akseptanse 3: kritisk verktøy (klasse D) i kjørende app", () => {
  const identityBody = {
    person_id: "person-tobias",
    tenant_id: "tenant-personal",
    memory_space: "personal",
    session_id: "sess-critical",
    device_id: "dev-web",
    channel: "web",
    auth_strength: "active"
  };

  async function criticalDemo(approval?: SignedApproval) {
    const response = await fetch(`${baseUrl}/tools/critical-demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: identityBody, parameters: { confirm: true }, approval })
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("uten godkjenning → 403 DENY", async () => {
    const result = await criticalDemo();
    expect(result.status).toBe(403);
    expect(result.body["reason"]).toBe("class_d_missing_approval");
  });

  it("gyldig signert godkjenning → ALLOW; replay → DENY (persistent nonce)", async () => {
    const approval = makeApproval();
    const first = await criticalDemo(approval);
    expect(first.status).toBe(200);
    expect(first.body["decision"]).toBe("ALLOW");

    const replay = await criticalDemo(approval);
    expect(replay.status).toBe(403);
    expect(replay.body["reason"]).toBe("class_d_nonce_already_used");
  });

  it("to samtidige forsøk med samme godkjenning → nøyaktig én ALLOW", async () => {
    const approval = makeApproval();
    const [a, b] = await Promise.all([criticalDemo(approval), criticalDemo(approval)]);
    const allowed = [a, b].filter((r) => r.status === 200);
    expect(allowed).toHaveLength(1);
  });

  it("feil action brenner ikke nonce; korrekt bruk etterpå → ALLOW", async () => {
    const approval = makeApproval({ action: "annen_handling" });
    const wrong = await criticalDemo(approval);
    expect(wrong.status).toBe(403);
    expect(wrong.body["reason"]).toBe("class_d_action_mismatch");

    const correct = makeApproval({ nonce: approval.nonce });
    const ok = await criticalDemo(correct);
    expect(ok.status).toBe(200);
  });
});

describe("Akseptanse 4: kjente kommandoer uten LLM-kall (verifisert i trace)", () => {
  it("'status' rutes deterministisk; ingen modellkall gjøres", async () => {
    const callsBefore = scripted.calls.length;
    const result = await chat("status");
    expect(result.body["routed"]).toBe("fast");
    expect(scripted.calls.length).toBe(callsBefore);

    const span = trace.spans.find((s) => s.kind === "fast_route" && s.name === "system_status");
    expect(span).toBeDefined();
    expect(span?.metadata?.["llm_used"]).toBe(false);
  });
});

describe("Akseptanse 5: hardgrense på budsjett håndheves med tydelig feilmelding", () => {
  it("tenant over 3 000 kr/mnd får modellkall nektet", async () => {
    const result = await chat("hva bør jeg prioritere?", {
      person_id: "person-tobias",
      tenant_id: "tenant-budget",
      device_id: "dev-web-b",
      memory_space: "personal",
      channel: "web"
    });
    expect(result.body["routed"]).toBe("blocked");
    expect(result.body["reply"]).toContain("budsjett");
    expect(result.body["reply"]).toContain("nektes");
  });
});

describe("SSE-streaming", () => {
  it("chat med Accept: text/event-stream gir token- og done-events", async () => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ ...webIdentity, message: "status" })
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: token");
    expect(text).toContain("event: done");
  });
});

describe("BO-11.1 §6-§7: SSE klient-disconnect → upstream abort (barge-in-fundament §8)", () => {
  it("A/C/E: frakobling midt i stream kansellerer generasjonen upstream - ingen health-straff, ingen zombie", async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ ...webIdentity, message: "fortell en langsom historie" }),
      signal: controller.signal
    });
    // Les til første token-event er mottatt, koble så fra midt i genereringen:
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      if (buffer.includes("event: token")) {
        controller.abort();
        break;
      }
    }
    // Gi serveren tid til å registrere close og kansellere upstream:
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A: generasjonen ble faktisk kansellert i Conversation Engine (ikke bare
    // stoppet socket-skriving) - delvis svar persistert med eksplisitt markør:
    const saved = await adminPool.query(
      `SELECT content FROM messages WHERE content LIKE '%[avbrutt av bruker]%' LIMIT 1`
    );
    expect(saved.rowCount).toBe(1);
    // C (§35): bruker-kansellering er ALDRI provider-feil:
    expect(gateway.meshStatus().providers.find((p) => p.provider === "scripted")?.failures).toBe(0);
  });

  it("B/D: ny request rett etterpå fungerer normalt med nøyaktig ett done-event", async () => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ ...webIdentity, message: "hva er planen for dagen?" })
    });
    const text = await response.text();
    expect(text).toContain("Hei Tobias, dette er et modellsvar.".split(" ")[0] as string);
    expect(text.match(/event: done/g)?.length).toBe(1); // aldri duplisert final
  });
});
