import { afterEach, describe, expect, it, vi } from "vitest";
import { OneDriveTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-309. `Authorization: Bearer`-header mot Microsoft Graph v1.0. D-41:
 * `create_folder` er en ekte klasse B-skrivehandling, ikke bare lesing
 * fordi det er enklere.
 */
describe("A: OneDriveTransport.invoke('list_folder', ...) - GET .../children, ren lesing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uten path: kaller mot rot-mappen sitt children-endepunkt", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ value: [] }) } as unknown as Response;
    });
    const transport = new OneDriveTransport();
    const result = await transport.invoke("list_folder", {}, "test-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/drive/root/children");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer test-token" });
    expect(result.data).toEqual({ value: [] });
  });

  it("med path: kaller mot den path-spesifikke children-adressen", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new OneDriveTransport();
    await transport.invoke("list_folder", { path: "Documents/Jarvis" }, "tok");
    expect(calls[0]).toBe("https://graph.microsoft.com/v1.0/me/drive/root:/Documents%2FJarvis:/children");
  });

  it("en HTTP-feil kaster 'onedrive_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new OneDriveTransport();
    await expect(transport.invoke("list_folder", {}, "bad-token")).rejects.toThrow("onedrive_error_401");
  });
});

describe("B: OneDriveTransport.invoke('create_folder', ...) - POST /me/drive/root/children, D-41 ekte skrivehandling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med name/folder/conflictBehavior i body", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: "item-1", name: "Ny mappe" }) } as unknown as Response;
    });
    const transport = new OneDriveTransport();
    const result = await transport.invoke("create_folder", { name: "Ny mappe" }, "test-token");
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/drive/root/children");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ name: "Ny mappe", folder: {}, "@microsoft.graph.conflictBehavior": "fail" }));
    expect(result.data).toEqual({ id: "item-1", name: "Ny mappe" });
  });
});

describe("C: en ukjent handling kaster 'onedrive_unsupported_action_<action>'", () => {
  it("invoke('download', ...) kaster (ikke registrert)", async () => {
    const transport = new OneDriveTransport();
    await expect(transport.invoke("download", {}, "tok")).rejects.toThrow("onedrive_unsupported_action_download");
  });
});

describe("D: firstWaveTools() registrerer onedrive.list_folder som klasse A og onedrive.create_folder som klasse B", () => {
  it("list_folder er klasse A (ren lesing), create_folder er klasse B (ekte skrivehandling, D-41)", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "onedrive");
    expect(tools.map((t) => t.action).sort()).toEqual(["create_folder", "list_folder"]);
    const listFolder = tools.find((t) => t.action === "list_folder")!;
    expect(listFolder.capability_class).toBe("A");
    expect(listFolder.credential_ref).toBe("JARVIS_ONEDRIVE_TOKEN");
    expect(listFolder.output_trust).toBe("untrusted");
    expect(listFolder.idempotent_external).toBe(true);
    const createFolder = tools.find((t) => t.action === "create_folder")!;
    expect(createFolder.capability_class).toBe("B");
    expect(createFolder.credential_ref).toBe("JARVIS_ONEDRIVE_TOKEN");
    expect(createFolder.idempotent_external).toBe(false);
    expect(createFolder.rollback_procedure).toBe("slett den nyopprettede mappen manuelt");
  });
});
