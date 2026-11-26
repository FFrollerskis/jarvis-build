import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { MeshToolExecutor, type MeshToolMapping, type ToolGateway } from "@jarvis/tool-gateway";

/**
 * WP-N1 (fiks-runde 1, F-A8/Q-8): utførelseslåsen (og H1/H2-vaktene) bygger på at `servingModel` ALLTID stemples når en MODELL kaller et verktøy. Uten stempel (fravær = eierens egne ruter, bevisst uendret) omgår en modellsti låsen.
 * Reviewerne bekreftet med grep at stemplingen skjer kun i `MeshToolExecutor`; her er det en test, så en fremtidig modellsti som glemmer å stemple blir RØD:
 *  A. `servingModel: { provider: call.provider, model: call.model }` står nøyaktig ÉN gang i produksjonskoden (mesh-bridge.ts), og settet av filer som overhodet nevner `servingModel` er kjent.
 *  B. ALLE modellløkker (`.completeWithTools(` utenfor modellgatewayen) er kjent (chatten og jobbhandleren) og får executoren fra `executorFor` -> `new MeshToolExecutor(` (main.ts, worker-main.ts).
 *  C. executor-wrapperne (`trackedExecutor`, `cloudScreenedExecutor`) kaller alltid en indre executor - de erstatter aldri MeshToolExecutor.
 *  D. kjøring: MeshToolExecutor stempler `{provider, model}` fra adapterens kall, aldri fra modellens argumenter.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string): string => readFileSync(`${root}${rel}`, "utf8");
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === "test" || e.name === "dist" ? [] : e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []));
const files = ["apps", "modules", "packages"].flatMap((top) =>
  readdirSync(`${root}${top}`, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => { try { return walk(`${root}${top}/${e.name}/src`); } catch { return []; } })
);
const countBy = (re: RegExp): Record<string, number> =>
  Object.fromEntries(files.flatMap((f) => { const n = (code(readFileSync(f, "utf8")).match(re) ?? []).length; return n > 0 ? [[f.slice(root.length), n]] : []; }).sort());

describe("A: stemplingen av servingModel", () => {
  it("skanneren ser produksjonskoden (ikke tom)", () => expect(files.length).toBeGreaterThan(200));

  it("`servingModel: { provider: call.provider, model: call.model }` står nøyaktig ÉN gang i hele produksjonskoden: MeshToolExecutor (adapterens kall)", () => {
    expect(countBy(/servingModel:\s*\{\s*provider:\s*call\.provider,\s*model:\s*call\.model\s*\}/g)).toEqual({ "modules/tool-gateway/src/mesh-bridge.ts": 1 });
  });

  it("settet av filer som overhodet nevner `servingModel` er kjent (gateway/mesh-bridge, executive, governance og jobbtransporten leser/videreformidler); en ny fil må vurderes mot utførelseslåsen", () => {
    // WP-N1b (K1): `model-scope.ts` er vurdert (vaktens egen instruks) - den nevner `servingModel` kun som feltnavn i den modell-stemplede konteksten som `ToolGateway.execute()` setter (ENESTE setter, låst av
    // `wpn1b-structure.test.ts`); den STEMPLER ingenting og leser ingenting fra parametere.
    expect(Object.keys(countBy(/\bservingModel\b/g))).toEqual([
      "apps/api/src/chat-jobs.ts", "modules/executive/src/service.ts", "modules/executive/src/transport.ts", "modules/governance/src/transport.ts", "modules/tool-gateway/src/gateway.ts", "modules/tool-gateway/src/mesh-bridge.ts",
      "modules/tool-gateway/src/model-scope.ts"
    ]);
    expect(countBy(/\bservingModel\b/g)["modules/tool-gateway/src/mesh-bridge.ts"]).toBe(1); // kun stemplet, ingen annen bruk
  });
});

describe("B: alle modellløkker går via executorFor -> MeshToolExecutor", () => {
  it("`.completeWithTools(` kalles i produksjonskode kun fra chatten (conversation.ts, 1) og jobbhandleren (executive.ts, 4); en ny modellløkke må vurderes (og stemple servingModel via MeshToolExecutor)", () => {
    expect(countBy(/\.completeWithTools\(/g)).toEqual({ "apps/api/src/conversation.ts": 1, "apps/api/src/executive.ts": 4 });
  });

  it("chatten og jobbhandleren får executoren fra `executorFor` (injisert), aldri bygget lokalt", () => {
    expect(code(read("apps/api/src/conversation.ts"))).toContain("this.deps.tools!.executorFor(identity,");
    expect(code(read("apps/api/src/executive.ts"))).toContain("opts.tools.executorFor(task, allowed)");
    expect(code(read("apps/api/src/conversation.ts"))).not.toMatch(/new MeshToolExecutor|new ToolExecutor|implements ToolExecutor/);
    expect(code(read("apps/api/src/executive.ts"))).not.toMatch(/new MeshToolExecutor|implements ToolExecutor/);
  });

  it("`executorFor` bygger i produksjon alltid en `new MeshToolExecutor(` (main.ts: chat + jobb, worker-main.ts: jobb); golden-suite.ts er gullkontrollen", () => {
    expect(countBy(/new MeshToolExecutor\(/g)).toEqual({ "apps/api/src/golden-suite.ts": 1, "apps/api/src/main.ts": 2, "apps/api/src/worker-main.ts": 1 });
    expect(code(read("apps/api/src/main.ts"))).toMatch(/executorFor: \(identity, turn\) => new MeshToolExecutor\(/);
    expect(code(read("apps/api/src/main.ts"))).toMatch(/executorFor: \(task, allowed\) => new MeshToolExecutor\(/);
    expect(code(read("apps/api/src/worker-main.ts"))).toMatch(/executorFor: \(task, allowed\) => new MeshToolExecutor\(/);
  });
});

describe("C: wrapperne erstatter aldri den indre executoren", () => {
  it("de tre executor-wrapperne i produksjon (trackedExecutor i conversation.ts og executive.ts, cloudScreenedExecutor) kaller alltid `inner`/`screened`", () => {
    expect(code(read("apps/api/src/cloud-tool-screen.ts"))).toContain("await inner.execute(call, ctx)");
    expect(code(read("apps/api/src/conversation.ts"))).toContain("await inner.execute(call, ctx)");
    expect(code(read("apps/api/src/executive.ts"))).toContain("screened.execute(call, callCtx)");
    // ingen annen implementasjon av ToolExecutor.execute i api-koden (utenom golden-suite sin gullkontroll og kall-videreformidlingen i worker-main)
    expect(countBy(/\bexecute:\s*async\s*\(call/g)).toEqual({ "apps/api/src/cloud-tool-screen.ts": 1, "apps/api/src/conversation.ts": 1, "apps/api/src/executive.ts": 1 });
  });
});

describe("D: MeshToolExecutor stempler fra adapteren, ikke fra modellen", () => {
  it("`servingModel` er alltid {provider, model} fra ToolCallRequest, uansett hva modellens argumenter hevder (forfalskning av `servingModel`/`provider`/`model` i arguments påvirker ikke)", async () => {
    const seen: unknown[] = [];
    const gateway = { get: () => undefined, list: () => [], async execute(req: Record<string, unknown>) { seen.push(req["servingModel"]); return { ok: true, data: {} }; } } as unknown as ToolGateway;
    const mapping: MeshToolMapping = { def: { name: "calendar__read_events", description: "x", input_schema: { type: "object", properties: {} } }, tool_id: "calendar", action: "read_events", parameters: () => ({ from: "2026-11-22", to: "2026-11-23" }) };
    const identity = { person_id: "p", tenant_id: "t", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "active" } as IdentityContext;
    const executor = new MeshToolExecutor(gateway, identity, 20_000, [mapping]);
    const ctx = { tenant_id: "t", idempotency_key: "k" };
    await executor.execute({ tool_call_id: "c1", tool_name: "calendar__read_events", arguments: { servingModel: { provider: "gemma_local", model: "x" }, provider: "gemma_local" }, provider: "anthropic", model: "claude" }, ctx);
    await executor.execute({ tool_call_id: "c2", tool_name: "calendar__read_events", arguments: {}, provider: "gemma_local", model: "gemma3:4b" }, { ...ctx, idempotency_key: "k2" });
    expect(seen).toEqual([{ provider: "anthropic", model: "claude" }, { provider: "gemma_local", model: "gemma3:4b" }]);
  });
});
