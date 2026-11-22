import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { CONTROL_CENTER_READ_TOOLS, ExecutiveService, ExecutiveTransport, executiveToolDefinitions, type ControlCenterId } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  KnowledgeSearchTransport, MemorySearchTransport, firstWaveTools, homeAssistantTools, knowledgeToolDefinitions, memoryToolDefinitions, resolveModelToolSurface, selectSurfaceTools,
  type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { createControlCenterRegistry, registerControlCenters } from "../src/control-center/register.ts";
import { CONTROL_CENTER_FLAGS, CONTROL_FEATURE_FLAGS, controlCentersWithTools } from "../src/control-center/shared.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";
import { EXECUTIVE_MUTATE_ACTIONS, EXECUTIVE_MUTATE_FLAGGED_ACTIONS, createApiServer } from "../src/server.ts";

/**
 * WP-H2 gjennomgang M1 («flagg AV er IKKE identisk med main»): flaggene AV skal gi NØYAKTIG main sin oppførsel - uten at et gyldig grant for et ukjent navn gir noe annet enn main gir. Beviset er mot OPPTAK fra en REN
 * kopi av `origin/main` (`git archive`; filene i `fixtures/` sier hvilken commit), ikke mot H2 selv:
 *  1. `/executive/mutate`: de to nye handlingsnavnene (og et helt ukjent navn) svarer med flaggene AV nøyaktig som main (400 `action_not_allowed` FØR grantet løses, ingen gateway-kall, ingen `tool.denied`-rad);
 *  2. de registrerte `executive`-verktøyene: samme handlinger i samme rekkefølge, klasse, rate-grense, step-up-krav, tidsavbrudd og beskrivelse (SHA-256) som main;
 *  3. verktøyutvalget over hele produksjonsflaten (begge flater, 95 fraser inkl. hverdagsfrasene som reviewer fant at endret seg) og `financeToolIntent` er identiske - dekket av `wph1-flag-off-selection-baseline.test.ts`, her kjørt
 *     mot H2-sammensetningen (alle H2-valg eksplisitt AV);
 *  4. med flaggene PÅ endrer alt seg KUN for det flagget slår på (kontrolltester: testen er ikke tom).
 */
interface MutateBaseline { baseline_sha: string; responses: Record<string, { status: number; body: unknown; gateway_calls: number }> }
interface ToolsBaseline { baseline_sha: string; tools: Array<{ action: string; capability_class: string; rate_limit_per_minute: number; step_up_required: boolean | null; reversible: boolean; timeout_ms: number; has_parameter_authorizer: boolean; description_sha: string }> }
const fixture = <T>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8")) as T;
const mutateBaseline = fixture<MutateBaseline>("wph2-main-mutate-baseline.json");
const toolsBaseline = fixture<ToolsBaseline>("wph2-main-executive-tools-baseline.json");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const OWNER: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "business", session_id: "s-owner", device_id: "dev-owner", channel: "web", auth_strength: "signed" };
const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
const NEW_NAMES = ["run_golden_suite", "revoke_autonomy_binding"] as const;

function executiveDefs(options: Parameters<typeof executiveToolDefinitions>[1] = {}): ToolDefinition[] {
  return executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, {})), options);
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. /executive/mutate mot opptaket fra ren main
// ---------------------------------------------------------------------------------------------------------------------
const servers: Array<ReturnType<typeof createApiServer>> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); });
});

/** Samme harness som opptaket (en gateway som svarer `unknown_tool` og teller kall), men `get` speiler de REGISTRERTE definisjonene - slik den ekte ToolGateway gjør. */
async function startRoute(registered: ToolDefinition[]): Promise<{ url: string; calls: () => number }> {
  let calls = 0;
  const gateway = {
    execute: async () => { calls += 1; return { ok: false, reason: "unknown_tool" }; },
    get: (tool_id: string, action: string) => registered.find((d) => d.tool_id === tool_id && d.action === action)
  } as unknown as ToolGateway;
  const server = createApiServer({
    identity: { resolveIdentity: async () => ({ ok: true, identity: OWNER }) } as never,
    grants: { verify: async (t: string) => (t === "GRANT" ? { ok: true, grant: { person_id: OWNER.person_id, tenant_id: OWNER.tenant_id, memory_space: OWNER.memory_space_id, session_id: OWNER.session_id, device_id: OWNER.device_id, channel: OWNER.channel, auth_strength: OWNER.auth_strength } } : { ok: false, reason: "grant_invalid" }) } as never,
    sessions: {} as never, devices: {} as never, channelAuthority: {} as never, policy: {} as never, worker: {} as never, conversation: {} as never,
    executive: { gateway },
    rateLimits: { perIpPerMinute: 100_000, authPerIpPerMinute: 100_000, perDevicePerMinute: 100_000 }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => calls };
}
async function mutate(route: { url: string; calls: () => number }, action: string, grant = "GRANT"): Promise<{ status: number; body: unknown; gateway_calls: number }> {
  const before = route.calls();
  const res = await fetch(`${route.url}/executive/mutate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_token: grant, action, parameters: { domain: "x" } }) });
  return { status: res.status, body: await res.json(), gateway_calls: route.calls() - before };
}

describe("1. /executive/mutate med flaggene AV svarer NØYAKTIG som ren main", () => {
  it("opptaket er fra en eksakt main-commit og dekker de to nye navnene, et ukjent navn, kjente navn og et ugyldig grant", () => {
    expect(mutateBaseline.baseline_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(mutateBaseline.responses).sort()).toEqual(["cancel_task", "pause_domain", "revoke_autonomy_binding", "run_golden_suite", "run_golden_suite__bad_grant", "totally_unknown_action"]);
    for (const name of NEW_NAMES) expect(mutateBaseline.responses[name]).toEqual({ status: 400, body: { error: "malformed_request", reason: "action_not_allowed" }, gateway_calls: 0 });
  });

  it("hvert opptatt svar (status, kropp og antall gateway-kall) er identisk når verktøyene IKKE er registrert (flaggene AV)", async () => {
    const route = await startRoute(executiveDefs());
    for (const action of ["run_golden_suite", "revoke_autonomy_binding", "totally_unknown_action", "pause_domain", "cancel_task"]) {
      expect(await mutate(route, action), action).toEqual(mutateBaseline.responses[action]);
    }
    expect(await mutate(route, "run_golden_suite", "BAD")).toEqual(mutateBaseline.responses["run_golden_suite__bad_grant"]);
  });

  it("uten `get` på gatewayen (en testdobler) er de to navnene IKKE kjent (fail-closed) - som main", async () => {
    let calls = 0;
    const server = createApiServer({
      identity: { resolveIdentity: async () => ({ ok: true, identity: OWNER }) } as never,
      grants: { verify: async () => ({ ok: true, grant: { person_id: OWNER.person_id, tenant_id: OWNER.tenant_id, memory_space: OWNER.memory_space_id, session_id: OWNER.session_id, device_id: OWNER.device_id, channel: OWNER.channel, auth_strength: OWNER.auth_strength } }) } as never,
      sessions: {} as never, devices: {} as never, channelAuthority: {} as never, policy: {} as never, worker: {} as never, conversation: {} as never,
      executive: { gateway: { execute: async () => { calls += 1; return { ok: false, reason: "unknown_tool" }; } } as unknown as ToolGateway },
      rateLimits: { perIpPerMinute: 100_000, authPerIpPerMinute: 100_000, perDevicePerMinute: 100_000 }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/executive/mutate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_token: "GRANT", action: "run_golden_suite", parameters: {} }) });
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("main sin allowliste er uendret (13 handlinger) - de to flaggstyrte står i en egen liste og er aldri med uten registrering", () => {
    expect(EXECUTIVE_MUTATE_ACTIONS).toHaveLength(13);
    expect([...EXECUTIVE_MUTATE_FLAGGED_ACTIONS].sort()).toEqual([...NEW_NAMES].sort());
    for (const name of NEW_NAMES) expect(EXECUTIVE_MUTATE_ACTIONS as readonly string[]).not.toContain(name);
  });

  it("KONTROLL: med flagget PÅ (verktøyet registrert) kjenner ruten navnet og når gatewayen - kun for det flagget som er på; et ukjent navn er fortsatt 400", async () => {
    const both = await startRoute(executiveDefs({ goldenSuite: true, autonomyRevoke: true }));
    for (const name of NEW_NAMES) expect(await mutate(both, name), name).toEqual({ status: 403, body: { error: "tool_denied", reason: "unknown_tool" }, gateway_calls: 1 });
    expect((await mutate(both, "totally_unknown_action")).status).toBe(400);
    expect((await mutate(both, "run_golden_suite", "BAD")).status).toBe(403); // grantet løses nå, og feiler som for alle kjente navn
    const onlyGolden = await startRoute(executiveDefs({ goldenSuite: true }));
    expect((await mutate(onlyGolden, "run_golden_suite")).gateway_calls).toBe(1);
    expect(await mutate(onlyGolden, "revoke_autonomy_binding")).toEqual(mutateBaseline.responses["revoke_autonomy_binding"]);
    const onlyRevoke = await startRoute(executiveDefs({ autonomyRevoke: true }));
    expect((await mutate(onlyRevoke, "revoke_autonomy_binding")).gateway_calls).toBe(1);
    expect(await mutate(onlyRevoke, "run_golden_suite")).toEqual(mutateBaseline.responses["run_golden_suite"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. De registrerte executive-verktøyene mot opptaket fra ren main
// ---------------------------------------------------------------------------------------------------------------------
describe("2. executive-verktøyene med flaggene AV er identiske med ren main (handling, klasse, rate-grense, step-up, tidsavbrudd, beskrivelse)", () => {
  const off = executiveDefs();
  const summarize = (d: ToolDefinition) => ({
    action: d.action, capability_class: d.capability_class, rate_limit_per_minute: d.rate_limit_per_minute, step_up_required: d.step_up_required ?? null, reversible: d.reversible,
    timeout_ms: d.timeout_ms, has_parameter_authorizer: d.parameterAuthorizer !== undefined, description_sha: sha(d.description)
  });

  it("samme verktøy i samme rekkefølge med samme egenskaper - ingen `get_<senter>_center`, ingen `run_golden_suite`, ingen `revoke_autonomy_binding`, `get_control_center` har 30/min", () => {
    expect(toolsBaseline.baseline_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(off.map(summarize)).toEqual(toolsBaseline.tools);
    const actions = off.map((d) => d.action);
    for (const t of CONTROL_CENTER_READ_TOOLS) expect(actions, t.action).not.toContain(t.action);
    for (const name of NEW_NAMES) expect(actions, name).not.toContain(name);
    expect(off.find((d) => d.action === "get_control_center")?.rate_limit_per_minute).toBe(30);
  });

  it("KONTROLL: hvert flagg legger til NØYAKTIG sitt verktøy (og kun det) - og `get_control_center` får 120/min først når minst ett SENTER er på (ikke av funksjonsflaggene)", () => {
    const extra = (defs: ToolDefinition[]): string[] => defs.map((d) => d.action).filter((a) => !toolsBaseline.tools.some((t) => t.action === a)).sort();
    expect(extra(executiveDefs({ goldenSuite: true }))).toEqual(["run_golden_suite"]);
    expect(extra(executiveDefs({ autonomyRevoke: true }))).toEqual(["revoke_autonomy_binding"]);
    for (const t of CONTROL_CENTER_READ_TOOLS) expect(extra(executiveDefs({ controlCenters: [t.center] })), t.center).toEqual([t.action]);
    expect(extra(executiveDefs({ controlCenters: CONTROL_CENTER_READ_TOOLS.map((t) => t.center) }))).toEqual(CONTROL_CENTER_READ_TOOLS.map((t) => t.action).sort());
    expect(executiveDefs({ goldenSuite: true, autonomyRevoke: true }).find((d) => d.action === "get_control_center")?.rate_limit_per_minute).toBe(30);
    expect(executiveDefs({ controlCenters: ["operations"] }).find((d) => d.action === "get_control_center")?.rate_limit_per_minute).toBe(120);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Verktøyutvalget over hele produksjonsflaten, mot baselinen fra ren main - H2-sammensetningen med alle H2-valg AV
// ---------------------------------------------------------------------------------------------------------------------
interface SelectionOut { selected: string[]; dropped_count: number; dropped_sha256: string; schema_tokens: number; min_sensitivity: string | null }
interface SelectionBaseline { baseline_sha: string; surface_keys: string[]; cases: Array<{ text: string; recent?: string[]; web_chat: SelectionOut; voice: SelectionOut }> }
const selectionBaseline = fixture<SelectionBaseline>("wph1-main-selection-baseline.json");
const keyOf = (m: { tool_id: string; action: string }): string => `${m.tool_id}.${m.action}`;

/** Samme sammensetning som `main.ts` (flaggstyrte verktøy fra `controlCentersWithTools` + de to funksjonsflaggene), ut fra et miljø. */
function productionSurface(env: Record<string, string | undefined>) {
  const registry = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
  const pool = {} as never;
  registerControlCenters(registry, {
    pool, env, toolGateway: { get: () => undefined } as never, ownerControls: {} as never, killSwitch: {} as never,
    valueReport: async () => ({}) as never, infraStatus: async () => ({}) as never
  });
  const controlCenters: ControlCenterId[] = controlCentersWithTools(env, registry);
  const defs = firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, {})), { controlCenters, goldenSuite: env[CONTROL_FEATURE_FLAGS.goldenSuite] === "on", autonomyRevoke: env[CONTROL_FEATURE_FLAGS.autonomyRevoke] === "on" }),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
  return resolveModelToolSurface({ list: () => defs } as unknown as ToolGateway, { includeChatReadTier: true, includeChatActTier: true, includeChatDelegateTier: true });
}
const selectionOf = (candidates: ReturnType<typeof productionSurface>, surface: "web_chat" | "voice", c: SelectionBaseline["cases"][number]): SelectionOut => {
  const sel = selectSurfaceTools(surface, c.text, candidates, c.recent ? { recent_owner_messages: c.recent } : {});
  return { selected: sel.selected.map(keyOf), dropped_count: sel.dropped.length, dropped_sha256: sha(sel.dropped.join("\n")), schema_tokens: sel.schema_tokens, min_sensitivity: sel.min_sensitivity ?? null };
};
const H2_PHRASES = ["hva er karantene", "må vi lage en DPIA", "hvilke workere kjører", "hva er en lease", "vis runbooks", "hva er oppetid", "hvordan er backup-status", "hva er bruksfrekvens", "hvem er databehandler for e-posten", "kjør golden suite", "har det vært mistenkelig aktivitet", "jeg trenger en avstemming av styret", "hva er ukjent utfall"];

describe("3. verktøyutvalget (hele produksjonsflaten, 95 fraser, begge flater) er identisk med ren main med ALLE flagg AV - også med H2-koblingen fra main.ts", () => {
  const allOff = productionSurface({});
  const allOn = productionSurface({ ...Object.fromEntries(Object.values(CONTROL_CENTER_FLAGS).map((f) => [f, "on"])), [CONTROL_FEATURE_FLAGS.goldenSuite]: "on", [CONTROL_FEATURE_FLAGS.autonomyRevoke]: "on" });

  it("baselinen dekker hverdagsfrasene reviewer fant (11 av 51 endret seg), kandidatflaten er nøyaktig main sin, og hver frase gir samme utvalg på begge flater", () => {
    const texts = new Set(selectionBaseline.cases.map((c) => c.text));
    for (const phrase of H2_PHRASES) expect(texts.has(phrase), phrase).toBe(true);
    expect(allOff.map(keyOf).sort()).toEqual(selectionBaseline.surface_keys);
    const diffs: string[] = [];
    for (const c of selectionBaseline.cases) {
      for (const surface of ["web_chat", "voice"] as const) if (JSON.stringify(selectionOf(allOff, surface, c)) !== JSON.stringify(c[surface])) diffs.push(`${surface}: «${c.text}»`);
    }
    expect(diffs).toEqual([]);
  });

  it("KONTROLL: med ALLE flagg PÅ endres utvalget for minst 11 av hverdagsfrasene på web-chatten og flaten får de sju verktøyene - sammenligningen over er ikke tom", () => {
    const onKeys = allOn.map(keyOf);
    for (const t of CONTROL_CENTER_READ_TOOLS) expect(onKeys, t.action).toContain(`executive.${t.action}`);
    const changed = selectionBaseline.cases.filter((c) => JSON.stringify(selectionOf(allOn, "web_chat", c)) !== JSON.stringify(c.web_chat));
    expect(changed.length).toBeGreaterThanOrEqual(11);
    // de fire H2-sentrenes egne hverdagsfraser er blant dem som endres
    const changedTexts = new Set(changed.map((c) => c.text));
    for (const phrase of ["hvilke workere kjører", "hva er en lease", "vis runbooks", "må vi lage en DPIA"]) expect(changedTexts.has(phrase), phrase).toBe(true);
  });

  it("KONTROLL: ett flagg slår på KUN sitt senters verktøy på flaten", () => {
    for (const [center, flag] of Object.entries(CONTROL_CENTER_FLAGS)) {
      const surface = productionSurface({ [flag]: "on" });
      const extra = surface.map(keyOf).filter((k) => !selectionBaseline.surface_keys.includes(k));
      const expected = CONTROL_CENTER_READ_TOOLS.filter((t) => t.center === center).map((t) => `executive.${t.action}`);
      // et senter uten sine avhengigheter (her: ingen pool-koblinger for Finans/Agent) registreres ikke - og får derfor ikke noe verktøy
      expect(extra.every((k) => expected.includes(k)), `${center}: ${extra.join(",")}`).toBe(true);
    }
  });
});
