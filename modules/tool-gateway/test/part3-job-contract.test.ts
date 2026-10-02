import { describe, expect, it } from "vitest";
import { curatedReadOnlyMeshTools, filterMeshToolsForJob, jobContractAllows, jobIdentityFor, SURFACE_TOOL_GRANTS } from "@jarvis/tool-gateway";

/**
 * Del 3 (JARVIS-005/012): jobbkontraktens `allowed_tools` filtrerer BÅDE skjemalisten og utførelsen, og jobbidentiteten kommer fra
 * den signerte kontrakten. Gateway-håndhevelsen (`tool_not_in_job_contract`/`job_identity_mismatch`) testes mot ekte ToolGateway i
 * `part3-job-gateway-enforcement.test.ts`.
 */
describe("jobContractAllows", () => {
  it("tool_id slipper alle handlinger; tool_id.action kun den handlingen; tom liste ingenting", () => {
    expect(jobContractAllows(["calendar"], "calendar", "read_events")).toBe(true);
    expect(jobContractAllows(["calendar"], "calendar", "create_event")).toBe(true);
    expect(jobContractAllows(["calendar.read_events"], "calendar", "read_events")).toBe(true);
    expect(jobContractAllows(["calendar.read_events"], "calendar", "create_event")).toBe(false);
    expect(jobContractAllows([], "calendar", "read_events")).toBe(false);
    expect(jobContractAllows(["calendar.read_events"], "calendar2", "read_events")).toBe(false);
  });
});

const MESH_TOOLS = curatedReadOnlyMeshTools();
describe("filterMeshToolsForJob", () => {
  const granted = SURFACE_TOOL_GRANTS.background.map((g) => `${g.tool_id}.${g.action}`);
  it("tom allowed_tools gir tom skjemaliste", () => {
    expect(filterMeshToolsForJob(MESH_TOOLS, { allowed_tools: [] })).toEqual([]);
  });
  it("skjemalisten er aldri større enn bakgrunnsflaten, selv om kontrakten ber om alt", () => {
    const everything = [...new Set(MESH_TOOLS.map((m) => m.tool_id))];
    const result = filterMeshToolsForJob(MESH_TOOLS, { allowed_tools: everything });
    for (const m of result) expect(granted).toContain(`${m.tool_id}.${m.action}`);
    expect(result.length).toBeLessThanOrEqual(granted.length);
  });
  it("tool_id.action begrenser til nøyaktig den handlingen", () => {
    const first = granted[0]!;
    const result = filterMeshToolsForJob(MESH_TOOLS, { allowed_tools: [first] });
    expect(result.map((m) => `${m.tool_id}.${m.action}`).every((k) => k === first)).toBe(true);
  });
});

describe("jobIdentityFor", () => {
  const base = { person_id: "worker", tenant_id: "t-worker", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "api" };
  it("person/tenant/session kommer fra kontrakten, aldri fra worker-identiteten", () => {
    const id = jobIdentityFor(base, { owner_person_id: "person-a", tenant_id: "tenant-a", task_id: "t1", allowed_memory_spaces: ["business", "health"] });
    expect(id).toMatchObject({ person_id: "person-a", tenant_id: "tenant-a", memory_space_id: "business", session_id: "job:t1", device_id: "d" });
  });
  it("ukjent/manglende memory space faller til project (aldri personal)", () => {
    expect(jobIdentityFor(base, { owner_person_id: "p", tenant_id: "t", task_id: "t2", allowed_memory_spaces: [] }).memory_space_id).toBe("project");
    expect(jobIdentityFor(base, { owner_person_id: "p", tenant_id: "t", task_id: "t3", allowed_memory_spaces: ["bogus"] }).memory_space_id).toBe("project");
  });
});
