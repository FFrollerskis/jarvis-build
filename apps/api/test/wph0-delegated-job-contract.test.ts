import { describe, expect, it } from "vitest";
import { CONTROL_CENTER_IDS } from "@jarvis/executive";
import { MemorySearchTransport, SURFACE_TOOL_GRANTS, allMeshTools, filterMeshToolsForJob, jobContractAllows, memoryToolDefinitions, type ToolDefinition, type ToolGateway } from "@jarvis/tool-gateway";
import { TasksDelegateTransport } from "../src/chat-jobs.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";

/**
 * WP-H0, gjennomgang av PR #316 (L-7): den delegerte jobbens kontrakt (`allowed_tools`) skal ikke tillate hele `executive`. Jobber kjører som eieren; `executive` har mutasjoner (cancel_task, kill switch, frys,
 * tilbakekall, enhetstilbakekall, pause …) som en hel-verktøy-oppføring tillot på KONTRAKTSnivå - bare bakgrunnsflatens filter stoppet dem. Nå står kun lese-handlingen bakgrunnsflaten faktisk har.
 */
const identity = { tenant_id: "t1", person_id: "p1", memory_space_id: "personal", device_id: "d1", session_id: "s-chat" };
const defs: ToolDefinition[] = [...productionToolDefinitions(), ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never))];
const gw = { list: () => defs } as unknown as ToolGateway;
const executiveActions = defs.filter((d) => d.tool_id === "executive").map((d) => d.action);

async function delegatedContract(): Promise<{ allowed_tools: string[] }> {
  const submitted: unknown[] = [];
  const transport = new TasksDelegateTransport(
    { submit: async (_id: unknown, c: unknown) => { submitted.push(c); return { ok: true as const, value: { task_id: (c as { task_id: string }).task_id } }; } } as never,
    { activeCount: async () => 0, get: async () => null, list: async () => [] } as never
  );
  await transport.invoke("delegate_background_task", { title: "Med verktøy", prompt: "Se i kalenderen og rapporter.", use_tools: true }, "", { identity: identity as never });
  return submitted[0] as { allowed_tools: string[] };
}

describe("delegert jobbkontrakt: executive er kun lese-handlingen bakgrunnsflaten har", () => {
  it("kontrakten har ingen hel-verktøy-oppføring for executive, men nøyaktig get_capability_status", async () => {
    const { allowed_tools } = await delegatedContract();
    expect(allowed_tools).not.toContain("executive");
    expect(allowed_tools.filter((t) => t === "executive" || t.startsWith("executive."))).toEqual(["executive.get_capability_status"]);
    expect(allowed_tools).toEqual(["email", "calendar", "github", "memory", "executive.get_capability_status"]);
  });

  it("ingen mutasjon (og ingen annen executive-lesing, f.eks. kontrollsentrene) er tillatt på kontraktsnivå: cancel_task, kill switch, frys, tilbakekall, enhetstilbakekall, pause", async () => {
    const { allowed_tools } = await delegatedContract();
    expect(executiveActions.length).toBeGreaterThan(20); // produksjonsdefinisjonene, ikke en håndlagd liste
    for (const action of ["cancel_task", "activate_kill_switch", "deactivate_kill_switch", "freeze_connector", "unfreeze_connector", "revoke_credential", "restore_credential", "revoke_device", "pause_domain", "resume_domain", "enable_finance_kill_switch", "disable_finance_kill_switch", "resolve_situation"]) {
      expect(executiveActions, action).toContain(action); // finnes faktisk som handling (testen er ikke tom)
      expect(jobContractAllows(allowed_tools, "executive", action), action).toBe(false);
    }
    // eneste tillatte executive-handling er lesingen bakgrunnsflaten har; alt annet nektes
    expect(executiveActions.filter((a) => jobContractAllows(allowed_tools, "executive", a))).toEqual(["get_capability_status"]);
    expect(jobContractAllows(allowed_tools, "executive", "get_control_center")).toBe(false);
    expect(CONTROL_CENTER_IDS.length).toBe(10);
    // andre eier-verktøy er ikke i kontrakten i det hele tatt
    for (const tool of ["owner_controls", "situations", "tasks", "governance", "run_rate"]) expect(allowed_tools.includes(tool), tool).toBe(false);
  });

  it("drift: executive-oppføringen er NØYAKTIG bakgrunnsflatens executive-tildeling (en ny lesing på bakgrunnsflaten krever en bevisst kontraktsendring)", async () => {
    const { allowed_tools } = await delegatedContract();
    const backgroundExecutive = SURFACE_TOOL_GRANTS.background.filter((g) => g.tool_id === "executive").map((g) => `${g.tool_id}.${g.action}`);
    expect(allowed_tools.filter((t) => t.startsWith("executive"))).toEqual(backgroundExecutive);
  });

  it("ingen lese-handling jobber bruker i dag er fjernet: verktøyene en jobb ser (kontrakt ∩ bakgrunnsflate) er identiske med før", async () => {
    const { allowed_tools } = await delegatedContract();
    const before = ["email", "calendar", "github", "memory", "executive"]; // kontrakten før L-7
    const mappings = allMeshTools(gw);
    const names = (allowed: string[]) => filterMeshToolsForJob(mappings, { allowed_tools: allowed }).map((m) => `${m.tool_id}.${m.action}`).sort();
    expect(names(allowed_tools)).toEqual(names(before));
    expect(names(allowed_tools)).toContain("executive.get_capability_status");
    expect(names(allowed_tools)).toContain("memory.search");
  });

  it("uten verktøy (use_tools: false) er kontrakten uendret tom", async () => {
    const submitted: unknown[] = [];
    const transport = new TasksDelegateTransport(
      { submit: async (_id: unknown, c: unknown) => { submitted.push(c); return { ok: true as const, value: { task_id: (c as { task_id: string }).task_id } }; } } as never,
      { activeCount: async () => 0, get: async () => null, list: async () => [] } as never
    );
    await transport.invoke("delegate_background_task", { title: "Uten verktøy", prompt: "Skriv et dikt om høsten uten verktøy.", use_tools: false }, "", { identity: identity as never });
    expect((submitted[0] as { allowed_tools: string[] }).allowed_tools).toEqual([]);
  });
});
