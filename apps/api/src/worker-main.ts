// Jarvis worker-prosess (BO-07): egen container/prosess som drenerer durable-køen.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { configFromEnv, createPool } from "@jarvis/core";
import {
  DockerSandboxRunner,
  InProcessWorker,
  PgTaskQueue,
  ProcessSandboxRunner
} from "@jarvis/tasks";

const pool = createPool(configFromEnv());
const queue = new PgTaskQueue(pool);
const worker = new InProcessWorker(queue);

// Sandbox-jobber: DockerSandboxRunner på host-runtime (D-32-verifisert). I container
// er prosess-sandbox default (containeren selv er isolasjonsgrensen; ingen Docker-socket
// monteres inn). Velges eksplisitt via JARVIS_SANDBOX=docker|process.
const runner =
  process.env["JARVIS_SANDBOX"] === "docker" ? new DockerSandboxRunner() : new ProcessSandboxRunner();

// Executive-jobber: har jobben en eksplisitt kommando kjøres den i sandbox
// (D-32-mønsteret); ellers kvitteres målet (styringsjobb uten sideeffekter).
worker.register("executive", async (task, ctx) => {
  const input = task.contract.input.data as { command?: string[]; timeout_ms?: number };
  if (!input.command || input.command.length === 0) {
    return { echo: task.contract.goal, done_at: new Date().toISOString() };
  }
  const sb = await runner.create();
  try {
    await ctx.assertNotCancelled();
    const res = sb.exec(input.command[0] as string, input.command.slice(1), input.timeout_ms ?? 60_000);
    if (res.code !== 0) {
      throw new Error(`sandbox_exit_${res.code}: ${res.stderr.slice(0, 200)}`);
    }
    return { stdout: res.stdout.slice(0, 4000), code: res.code, sandbox: runner.name };
  } finally {
    await sb.dispose();
  }
});

console.log(JSON.stringify({ msg: "jarvis-worker started", worker_id: worker.workerId, sandbox: runner.name }));
setInterval(
  () =>
    void worker
      .drain()
      .catch((err) => console.error(JSON.stringify({ msg: "drain_error", error: (err as Error).message }))),
  2_000
);
