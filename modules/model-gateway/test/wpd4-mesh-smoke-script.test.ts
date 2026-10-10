import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SmokeEvidence } from "../src/index.ts";

/**
 * WP-D4 (JARVIS-033/036): `scripts/mesh-live-smoke.ts` kjørt SOM PROSESS mot lokale fake-servere (ekte `fetch`, ekte adaptere, ekte `ModelGateway`) - ingen ekte nøkler og ingen ekte leverandører.
 * Beviser hele eierløpet: PASS med tre live leverandører og bevist fallback, FAIL/INCOMPLETE med riktig avslutningskode, at nøkler aldri havner i evidens eller utskrift, og at `--tools`/`--parallel`
 * fungerer ende til ende. Verifiserer IKKE at ekte Kimi/Hermes/Gemma oppfører seg slik - det er hele poenget med at EIEREN kjører skriptet.
 */
const SCRIPT = fileURLToPath(new URL("../scripts/mesh-live-smoke.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// Fiktive, lavt-entropi nøkler bygd her (ikke i skriptet): skal ALDRI dukke opp i evidens eller utskrift.
const KIMI_KEY = "ikke-en-ekte-kimi-nokkel";
const HERMES_KEY = "ikke-en-ekte-hermes-nokkel";

interface Hit { path: string; auth: string | undefined; body: Record<string, unknown> }
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); })));
});

type Mode = "ok" | "auth" | "tools_text_only";
async function openAiServer(mode: Mode, hits: Hit[] = [], style: "native" | "hermes" = "native"): Promise<string> {
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>; } catch { body = {}; }
      hits.push({ path: req.url ?? "", auth: req.headers["authorization"] as string | undefined, body });
      const json = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      if (mode === "auth") return json(401, { error: { message: "ugyldig nøkkel", type: "auth" } });
      const text = JSON.stringify(body["messages"] ?? []);
      const wantsTool = style === "native" ? Array.isArray(body["tools"]) && (body["tools"] as unknown[]).length > 0 : text.includes("smoke_get_time");
      const afterTool = /20\d\d-\d\d-\d\dT/.test(text); // verktøyresultatet (med dagens tidspunkt) er sendt tilbake
      const usage = { prompt_tokens: 7, completion_tokens: 2 };
      if (wantsTool && mode !== "tools_text_only" && !afterTool) {
        if (style === "hermes") return json(200, { choices: [{ message: { role: "assistant", content: '<tool_call>\n{"name": "smoke_get_time", "arguments": {}}\n</tool_call>' }, finish_reason: "stop" }], usage });
        if (body["stream"] === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunks = [
            { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_s", type: "function", function: { name: "smoke_get_time", arguments: "" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage }
          ];
          for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        return json(200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "smoke_get_time", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage });
      }
      return json(200, { choices: [{ message: { role: "assistant", content: wantsTool ? "Klokka er tolv." : "OK" }, finish_reason: "stop" }], usage });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Run { code: number | null; stdout: string; stderr: string; evidencePath: string }
async function runScript(args: string[], env: Record<string, string>): Promise<Run> {
  const dir = await mkdtemp(join(tmpdir(), "mesh-smoke-"));
  const evidencePath = join(dir, "evidens.json");
  const outArgs = args.includes("--out") || args.includes("--help") ? args : [...args, "--out", evidencePath];
  // Minimalt miljø: aldri eierens ekte nøkler, og ingen proxy.
  const childEnv: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: dir, ...env };
  return await new Promise<Run>((resolve) => {
    const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", SCRIPT, ...outArgs], { cwd: ROOT, env: childEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("close", (code) => resolve({ code, stdout, stderr, evidencePath }));
  });
}
const evidenceOf = async (run: Run): Promise<SmokeEvidence> => JSON.parse(await readFile(run.evidencePath, "utf8")) as SmokeEvidence;

describe("mesh-live-smoke.ts som prosess (fake leverandører)", () => {
  it("PASS: gemma_local + kimi + hermes live, fallback bevist (gemma_local sperret), porten holdt, ingen nøkler i evidens/utskrift", async () => {
    const hits: Hit[] = [];
    const [local, kimi, hermes] = await Promise.all([openAiServer("ok", hits), openAiServer("ok", hits), openAiServer("ok", hits, "hermes")]);
    const run = await runScript(["--providers", "gemma_local,kimi,hermes"], { JARVIS_GEMMA_LOCAL_URL: local, JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY, JARVIS_HERMES_URL: hermes, HERMES_API_KEY: HERMES_KEY });
    expect(run.stderr).not.toContain("mesh-live-smoke avbrutt");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const ev = await evidenceOf(run);
    expect(ev).toMatchObject({ schema: "jarvis.mesh-smoke/1", verdict: "PASS", mode: "no_db", probe_route: "direct_adapter", live_providers: ["gemma_local", "kimi", "hermes"], reasons: [] });
    expect(ev.providers.map((p) => [p.provider, p.status])).toEqual([["gemma_local", "LIVE"], ["kimi", "LIVE"], ["hermes", "LIVE"]]);
    expect(ev.fallback).toMatchObject({ status: "PROVEN", blocked: "gemma_local", served_by: "kimi", fallback_from: ["gemma_local"], gateway_state: "VERIFIED" });
    expect(ev.fallback.blocked_attempts).toBeGreaterThan(0);
    expect(ev.sensitivity_gate).toMatchObject({ status: "PASS", cloud_calls: 0 });
    expect(ev.tools).toBeNull();
    expect(ev.cost.cap_hit).toBe(false);
    // Hemmelighetsfri: verken nøklene, Authorization-verdier eller URL-er fra fake-serverne står i evidensen eller utskriften.
    const everything = (await readFile(run.evidencePath, "utf8")) + run.stdout + run.stderr;
    for (const secret of [KIMI_KEY, HERMES_KEY, `Bearer ${KIMI_KEY}`]) expect(everything).not.toContain(secret);
    expect(run.stdout).toContain("AI Mesh røyktest (uten database): PASS");
    expect(run.stdout).toContain("fallback: PROVEN (gemma_local sperret → svart av kimi)");
    // Nøklene gikk kun i Authorization-headeren til riktig leverandør.
    expect(hits.some((h) => h.auth === `Bearer ${KIMI_KEY}`)).toBe(true);
    expect((await stat(run.evidencePath)).mode & 0o777).toBe(0o600);
  }, 90_000);

  it("--block velger hvilken leverandør som sperres; kjeden starter med den og reserven er neste live", async () => {
    const [local, kimi, hermes] = await Promise.all([openAiServer("ok"), openAiServer("ok"), openAiServer("ok", [], "hermes")]);
    const run = await runScript(["--providers", "gemma_local,kimi,hermes", "--block", "kimi"], { JARVIS_GEMMA_LOCAL_URL: local, JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY, JARVIS_HERMES_URL: hermes, HERMES_API_KEY: HERMES_KEY });
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const ev = await evidenceOf(run);
    expect(ev.fallback).toMatchObject({ status: "PROVEN", blocked: "kimi", chain: ["kimi", "gemma_local", "hermes"], served_by: "gemma_local" });
  }, 90_000);

  it("INCOMPLETE (avslutningskode 2): bare to konfigurerte leverandører - sier hva som mangler, og fallback kan likevel bevises", async () => {
    const [local, kimi] = await Promise.all([openAiServer("ok"), openAiServer("ok")]);
    const run = await runScript(["--providers", "gemma_local,kimi,hermes"], { JARVIS_GEMMA_LOCAL_URL: local, JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY });
    expect(run.code, run.stdout + run.stderr).toBe(2);
    const ev = await evidenceOf(run);
    expect(ev.verdict).toBe("INCOMPLETE");
    expect(ev.providers.find((p) => p.provider === "hermes")).toMatchObject({ configured: false, status: "NOT_CONFIGURED" });
    expect(ev.reasons.join(" ")).toContain("Bare 2 konfigurerte");
    expect(ev.fallback.status).toBe("PROVEN");
  }, 90_000);

  it("FAIL (avslutningskode 1): tre konfigurert, men kimi avviser nøkkelen - årsaken er klasse + kode, aldri nøkkelen", async () => {
    const [local, kimi, hermes] = await Promise.all([openAiServer("ok"), openAiServer("auth"), openAiServer("ok", [], "hermes")]);
    const run = await runScript(["--providers", "gemma_local,kimi,hermes"], { JARVIS_GEMMA_LOCAL_URL: local, JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY, JARVIS_HERMES_URL: hermes, HERMES_API_KEY: HERMES_KEY });
    expect(run.code, run.stdout + run.stderr).toBe(1);
    const ev = await evidenceOf(run);
    expect(ev.verdict).toBe("FAIL");
    expect(ev.providers.find((p) => p.provider === "kimi")).toMatchObject({ status: "FAILED", error_kind: "auth" });
    expect(ev.reasons.join(" ")).toContain("kimi=FAILED(auth)");
    expect(JSON.stringify(ev) + run.stdout).not.toContain(KIMI_KEY);
  }, 90_000);

  it("--tools: verktøykall, rundtur og streaming (kimi) og prompt-protokollen (hermes) kjører ende til ende; gemma_local har ikke tool_calling i registeret og hoppes over", async () => {
    const [local, kimi, hermes] = await Promise.all([openAiServer("ok"), openAiServer("ok"), openAiServer("ok", [], "hermes")]);
    const run = await runScript(["--providers", "gemma_local,kimi,hermes", "--tools"], { JARVIS_GEMMA_LOCAL_URL: local, JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY, JARVIS_HERMES_URL: hermes, HERMES_API_KEY: HERMES_KEY });
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const ev = await evidenceOf(run);
    const byProvider = Object.fromEntries((ev.tools ?? []).map((t) => [t.provider, t]));
    expect(byProvider["kimi"]).toMatchObject({ call: "TOOL_CALL_OK", roundtrip: "ROUNDTRIP_OK", stream: "STREAM_TOOL_CALL_OK" });
    expect(byProvider["hermes"]).toMatchObject({ call: "TOOL_CALL_OK", roundtrip: "ROUNDTRIP_OK", stream: "SKIPPED" });
    expect(run.stdout).toContain("verktøy kimi: kall=TOOL_CALL_OK rundtur=ROUNDTRIP_OK streaming=STREAM_TOOL_CALL_OK");
  }, 90_000);

  it("--tools mot en server som svarer med ren tekst: NO_TOOL_CALL registreres ærlig (påstanden i registeret er ikke bevist)", async () => {
    const [local, kimi, hermes] = await Promise.all([openAiServer("ok"), openAiServer("tools_text_only"), openAiServer("ok", [], "hermes")]);
    const run = await runScript(["--providers", "gemma_local,kimi,hermes", "--tools"], { JARVIS_GEMMA_LOCAL_URL: local, JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY, JARVIS_HERMES_URL: hermes, HERMES_API_KEY: HERMES_KEY });
    const ev = await evidenceOf(run);
    expect((ev.tools ?? []).find((t) => t.provider === "kimi")).toMatchObject({ call: "NO_TOOL_CALL", roundtrip: "SKIPPED" });
  }, 90_000);

  it("--parallel: alene-kall og samtidige kall måles per live leverandør (overhead rapporteres, aldri funnet på)", async () => {
    const [local, kimi, hermes] = await Promise.all([openAiServer("ok"), openAiServer("ok"), openAiServer("ok", [], "hermes")]);
    const run = await runScript(["--providers", "gemma_local,kimi,hermes", "--parallel", "--solo-calls", "3", "--parallel-calls", "3"], { JARVIS_GEMMA_LOCAL_URL: local, JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY, JARVIS_HERMES_URL: hermes, HERMES_API_KEY: HERMES_KEY });
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const ev = await evidenceOf(run);
    expect(ev.parallel).toHaveLength(3);
    for (const p of ev.parallel ?? []) {
      expect(p).toMatchObject({ solo_samples: 3, parallel_samples: 3, failed_calls: 0 });
      expect(p.overhead_ms).toBeTypeOf("number");
    }
    expect(run.stdout).toContain("parallell kimi:");
  }, 90_000);

  it("kostnadstaket stopper kjøringen: INCOMPLETE (aldri PASS), de gjenstående hoppes over", async () => {
    const [local, kimi, hermes] = await Promise.all([openAiServer("ok"), openAiServer("ok"), openAiServer("ok", [], "hermes")]);
    const pricing = JSON.stringify({ "kimi:kimi-k3": { input_per_1k_ore: 1_000_000, output_per_1k_ore: 1_000_000 } });
    const run = await runScript(["--providers", "gemma_local,kimi,hermes", "--max-cost-ore", "1"], { JARVIS_GEMMA_LOCAL_URL: local, JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY, JARVIS_HERMES_URL: hermes, HERMES_API_KEY: HERMES_KEY, JARVIS_MODEL_PRICING: pricing });
    expect(run.code, run.stdout + run.stderr).toBe(2);
    const ev = await evidenceOf(run);
    expect(ev.verdict).toBe("INCOMPLETE");
    expect(ev.cost.cap_hit).toBe(true);
    expect(ev.providers.find((p) => p.provider === "hermes")?.status).toBe("SKIPPED_COST_CAP");
  }, 90_000);

  it("ugyldige flagg og --help: avslutningskode 2 med bruksanvisning (ingen evidensfil) / 0 for --help", async () => {
    const bad = await runScript(["--ukjent"], {});
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("ukjent flagg");
    expect(bad.stderr).toContain("mesh-live-smoke - eierens akseptanse");
    await expect(stat(bad.evidencePath)).rejects.toThrow();
    const help = await runScript(["--help"], {});
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--max-cost-ore");
  }, 60_000);

  it("evidensfilen må kunne skrives FØR noe betalt kall gjøres: uskrivbar --out gir avslutningskode 2 med råd om --out, og leverandørene får ingen forespørsler", async () => {
    const hits: Hit[] = [];
    const [local, kimi, hermes] = await Promise.all([openAiServer("ok", hits), openAiServer("ok", hits), openAiServer("ok", hits, "hermes")]);
    // En FIL som «katalog» gir en skrivefeil uavhengig av hvem testen kjører som (samme klasse som api-containerens skrivebeskyttede rotfilsystem). Merk: /proc fungerer ikke her - rekursiv mkdir looper evig mot den.
    const blocker = join(await mkdtemp(join(tmpdir(), "mesh-smoke-blocker-")), "ikke-en-katalog");
    await writeFile(blocker, "x");
    const run = await runScript(["--providers", "gemma_local,kimi,hermes", "--out", join(blocker, "evidens.json")], { JARVIS_GEMMA_LOCAL_URL: local, JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY, JARVIS_HERMES_URL: hermes, HERMES_API_KEY: HERMES_KEY });
    expect(run.code, run.stdout + run.stderr).toBe(2);
    expect(run.stderr).toContain("kan ikke skrive evidensfilen");
    expect(run.stderr).toContain("--out /tmp/mesh-smoke.json");
    expect(run.stderr).toContain("Ingen kall er gjort");
    expect(hits).toHaveLength(0);
    expect(run.stdout).not.toContain("Fase 1");
    expect(run.stderr + run.stdout).not.toContain(KIMI_KEY);
  }, 60_000);

  it("--db uten eierens tenant (verken --tenant eller JARVIS_TENANT_ID): avslutningskode 2 med forklaring, ingen kall og ingen gjettet tenant", async () => {
    const hits: Hit[] = [];
    const kimi = await openAiServer("ok", hits);
    const run = await runScript(["--providers", "kimi", "--db"], { JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY });
    expect(run.code, run.stdout + run.stderr).toBe(2);
    expect(run.stderr).toContain("--db trenger eierens tenant");
    expect(run.stderr).toContain("JARVIS_TENANT_ID");
    expect(hits).toHaveLength(0);
  }, 60_000);

  it("uten noen konfigurert leverandør: INCOMPLETE, ingen nettkall, og sensitivitetsporten er SKIPPED", async () => {
    const run = await runScript([], {});
    expect(run.code, run.stdout + run.stderr).toBe(2);
    const ev = await evidenceOf(run);
    expect(ev.verdict).toBe("INCOMPLETE");
    expect(ev.providers.every((p) => !p.configured)).toBe(true);
    expect(ev.sensitivity_gate.status).toBe("SKIPPED");
  }, 60_000);
});
