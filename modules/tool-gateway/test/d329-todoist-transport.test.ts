import { afterEach, describe, expect, it, vi } from "vitest";
import { TodoistTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-329. Todoist - FØRSTE av de seks D-64-port-krevende CRM-/prosjekt-
 * styrings-leverandørene som faktisk er bygget (D-291 stengte selve porten).
 * API-formen er BEVISST verifisert via WebSearch denne økten fordi den gamle
 * `/rest/v2/tasks`-veien (kjent fra trent kunnskap) er BEKREFTET pensjonert
 * i favør av den unifiserte `/api/v1/`-veien - se live-transports.ts sin
 * doc-kommentar for full sekundærkilde-krysssjekket evidens.
 */
describe("A: TodoistTransport.invoke('list_tasks'/'get_task', ...) - GET, INGEN sideeffekt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("list_tasks kaller GET /api/v1/tasks med Bearer-header og returnerer svaret som data", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ([{ id: "1", content: "kjøp melk" }]) } as unknown as Response;
    });
    const transport = new TodoistTransport();
    const result = await transport.invoke("list_tasks", {}, "tok-123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.todoist.com/api/v1/tasks");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer tok-123" });
    expect(result.data).toEqual([{ id: "1", content: "kjøp melk" }]);
  });

  it("get_task kaller GET /api/v1/tasks/<task_id>", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ id: "42", content: "x" }) } as unknown as Response;
    });
    const transport = new TodoistTransport();
    const result = await transport.invoke("get_task", { task_id: "42" }, "tok");
    expect(calls[0]).toBe("https://api.todoist.com/api/v1/tasks/42");
    expect(result.data).toMatchObject({ id: "42" });
  });
});

describe("B: TodoistTransport.invoke('create_task', ...) - POST /api/v1/tasks, EKTE ekstern tilstand skapes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTer content + valgfrie felter, returnerer external_id fra svarets id", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ id: "999", content: "ring Ola" }) } as unknown as Response;
    });
    const transport = new TodoistTransport();
    const result = await transport.invoke(
      "create_task",
      { content: "ring Ola", project_id: "p1", due_string: "i morgen", priority: 3 },
      "tok"
    );
    expect(calls[0]!.url).toBe("https://api.todoist.com/api/v1/tasks");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      content: "ring Ola", project_id: "p1", due_string: "i morgen", priority: 3
    });
    expect(result.external_id).toBe("999");
  });

  it("utelater valgfrie felter helt når de ikke er oppgitt (ikke undefined-verdier i body)", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, status: 200, json: async () => ({ id: "1" }) } as unknown as Response;
    });
    const transport = new TodoistTransport();
    await transport.invoke("create_task", { content: "kun tittel" }, "tok");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ content: "kun tittel" });
  });

  it("en HTTP-feil kaster 'todoist_error_<status>' UTEN å late som oppgaven ble skapt", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 403 }) as unknown as Response);
    const transport = new TodoistTransport();
    await expect(transport.invoke("create_task", { content: "x" }, "bad-tok")).rejects.toThrow("todoist_error_403");
  });
});

describe("C: TodoistTransport.invoke('update_task'/'close_task'/'reopen_task', ...) - POST, muterer eksisterende oppgave", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("update_task POSTer kun de oppgitte feltene til /api/v1/tasks/<task_id>", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ id: "5" }) } as unknown as Response;
    });
    const transport = new TodoistTransport();
    await transport.invoke("update_task", { task_id: "5", content: "ny tittel" }, "tok");
    expect(calls[0]!.url).toBe("https://api.todoist.com/api/v1/tasks/5");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ content: "ny tittel" });
  });

  it("close_task POSTer til /api/v1/tasks/<task_id>/close og håndterer 204-svar med tomt body", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, status: 204, json: async () => { throw new Error("skal ikke kalles på 204"); } } as unknown as Response;
    });
    const transport = new TodoistTransport();
    const result = await transport.invoke("close_task", { task_id: "5" }, "tok");
    expect(calls[0]).toBe("https://api.todoist.com/api/v1/tasks/5/close");
    expect(result.data).toBeNull();
  });

  it("reopen_task POSTer til /api/v1/tasks/<task_id>/reopen", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, status: 204, json: async () => { throw new Error("skal ikke kalles på 204"); } } as unknown as Response;
    });
    const transport = new TodoistTransport();
    await transport.invoke("reopen_task", { task_id: "5" }, "tok");
    expect(calls[0]).toBe("https://api.todoist.com/api/v1/tasks/5/reopen");
  });
});

describe("D: en ukjent handling kaster 'todoist_unsupported_action_<action>'", () => {
  it("invoke('delete_task', ...) kaster (D-41 DEFERRED - ingen sekundærkilde bekreftet eksakt HTTP-metode/status)", async () => {
    await expect(new TodoistTransport().invoke("delete_task", {}, "tok")).rejects.toThrow("todoist_unsupported_action_delete_task");
  });
});

describe("E: firstWaveTools() registrerer alle todoist.*-handlinger med korrekt risikoklasse", () => {
  it("todoist.list_tasks/get_task er klasse A (lesing)", () => {
    const list = firstWaveTools().find((t) => t.tool_id === "todoist" && t.action === "list_tasks");
    const get = firstWaveTools().find((t) => t.tool_id === "todoist" && t.action === "get_task");
    expect(list!.capability_class).toBe("A");
    expect(get!.capability_class).toBe("A");
  });

  it("todoist.create_task/update_task/close_task/reopen_task er klasse B (muterer ekstern tilstand)", () => {
    for (const action of ["create_task", "update_task", "close_task", "reopen_task"]) {
      const tool = firstWaveTools().find((t) => t.tool_id === "todoist" && t.action === action);
      expect(tool, action).toBeDefined();
      expect(tool!.capability_class, action).toBe("B");
      expect(tool!.credential_ref).toBe("JARVIS_TODOIST_API_TOKEN");
    }
  });

  it("INGEN todoist.delete_task er registrert - D-41 BEVISST DEFERRED, ikke stille utelatt", () => {
    const tool = firstWaveTools().find((t) => t.tool_id === "todoist" && t.action === "delete_task");
    expect(tool).toBeUndefined();
  });
});
