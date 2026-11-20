import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { CONTROL_CENTER_IDS, ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import type { ToolDefinition, ToolGateway } from "@jarvis/tool-gateway";
import { createApiServer } from "../src/server.ts";

/**
 * WP-B3 (D-475, EV-22): `/control/center` og `/control/centers` for TILLEGGSSENTERET Evolusjon.
 *  - flagg AV (verktøyet er ikke registrert i gatewayen): `center: "evolution"` er et ukjent senter og svarer NØYAKTIG som et hvilket som helst annet ukjent navn (400 `unknown_center`, FØR grantet løses, ingen gateway-kall) - som main;
 *  - flagg PÅ (verktøyet registrert): navnet er kjent, grantet løses og kallet går via ToolGateway (`get_control_center {center}`) - og et senter som likevel ikke er koblet inn gir 404 `center_not_registered`;
 *  - en gateway uten `get` (testdobler) kjenner ingen tilleggssentre (fail-closed), og masterplanens ti er upåvirket av alt dette.
 */
const OWNER: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "business", session_id: "s-owner", device_id: "dev-owner", channel: "web", auth_strength: "signed" };
const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
const defs = (centers: Parameters<typeof executiveToolDefinitions>[1]): ToolDefinition[] => executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, {})), centers);

const servers: Array<ReturnType<typeof createApiServer>> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); });
});

interface Harness { url: string; calls: Array<{ action: string; parameters: unknown }> }
async function start(gateway: Record<string, unknown>, reply: { ok: boolean; data?: unknown; reason?: string } = { ok: true, data: { found: true, summary_no: "x" } }): Promise<Harness> {
  const calls: Harness["calls"] = [];
  const server = createApiServer({
    identity: { resolveIdentity: async () => ({ ok: true, identity: OWNER }) } as never,
    grants: { verify: async (t: string) => (t === "GRANT" ? { ok: true, grant: { person_id: OWNER.person_id, tenant_id: OWNER.tenant_id, memory_space: OWNER.memory_space_id, session_id: OWNER.session_id, device_id: OWNER.device_id, channel: OWNER.channel, auth_strength: OWNER.auth_strength } } : { ok: false, reason: "grant_invalid" }) } as never,
    sessions: {} as never, devices: {} as never, channelAuthority: {} as never, policy: {} as never, worker: {} as never, conversation: {} as never,
    executive: { gateway: { execute: async (req: { action: string; parameters: unknown }) => { calls.push({ action: req.action, parameters: req.parameters }); return reply; }, ...gateway } as unknown as ToolGateway },
    rateLimits: { perIpPerMinute: 100_000, authPerIpPerMinute: 100_000, perDevicePerMinute: 100_000 }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}
async function post(h: Harness, path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const registeredIn = (list: ToolDefinition[]) => ({ get: (t: string, a: string) => list.find((d) => d.tool_id === t && d.action === a) });

describe("flagg AV: `evolution` er et ukjent senter - nøyaktig som main svarer på et ukjent navn", () => {
  it("400 `unknown_center` FØR grantet løses (også med et ugyldig grant), ingen gateway-kall - identisk med svaret for et helt ukjent navn", async () => {
    const h = await start(registeredIn(defs({ controlCenters: [] })));
    const evolution = await post(h, "/control/center", { grant_token: "GRANT", center: "evolution" });
    const unknown = await post(h, "/control/center", { grant_token: "GRANT", center: "billing" });
    expect(evolution.status).toBe(400);
    expect(evolution.body).toMatchObject({ error: "malformed_request", reason: "unknown_center" });
    expect({ status: evolution.status, error: evolution.body["error"], reason: evolution.body["reason"] }).toEqual({ status: unknown.status, error: unknown.body["error"], reason: unknown.body["reason"] });
    const badGrant = await post(h, "/control/center", { grant_token: "BAD", center: "evolution" });
    expect(badGrant.status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it("et annet senters flagg gjør IKKE Evolusjon kjent (kun dets eget verktøy gjør det)", async () => {
    const h = await start(registeredIn(defs({ controlCenters: ["operations", "value", "security"] })));
    expect((await post(h, "/control/center", { grant_token: "GRANT", center: "evolution" })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it("en gateway uten `get` (testdobler) kjenner ingen tilleggssentre (fail-closed), mens masterplanens ti fortsatt er kjent", async () => {
    const h = await start({});
    expect((await post(h, "/control/center", { grant_token: "GRANT", center: "evolution" })).status).toBe(400);
    expect(h.calls).toHaveLength(0);
    for (const center of CONTROL_CENTER_IDS) expect((await post(h, "/control/center", { grant_token: "GRANT", center })).status, center).toBe(200);
    expect(h.calls).toHaveLength(CONTROL_CENTER_IDS.length);
  });

  it("oversikten `/control/centers` er uendret (ingen senter-parameter) og går via `get_control_center` uten parametre", async () => {
    const h = await start(registeredIn(defs({ controlCenters: [] })));
    const r = await post(h, "/control/centers", { grant_token: "GRANT" });
    expect(r.status).toBe(200);
    expect(h.calls).toEqual([{ action: "get_control_center", parameters: {} }]);
    // en sending av `center` til oversiktsruten avvises (kroppsdisiplinen er uendret)
    expect((await post(h, "/control/centers", { grant_token: "GRANT", center: "evolution" })).status).toBe(400);
  });
});

describe("flagg PÅ: `evolution` er kjent når verktøyet er registrert", () => {
  it("grantet løses og kallet går via ToolGateway som `get_control_center {center: \"evolution\"}` - identiteten kommer fra grantet, aldri fra kroppen", async () => {
    const h = await start(registeredIn(defs({ controlCenters: ["evolution"] })));
    const r = await post(h, "/control/center", { grant_token: "GRANT", center: "evolution" });
    expect(r.status).toBe(200);
    expect(h.calls).toEqual([{ action: "get_control_center", parameters: { center: "evolution" } }]);
    // et ugyldig grant avvises nå ETTER at navnet er godkjent (som for alle kjente sentre)
    expect((await post(h, "/control/center", { grant_token: "BAD", center: "evolution" })).status).toBe(403);
    // identitetsfelt i kroppen avvises som alltid
    expect((await post(h, "/control/center", { grant_token: "GRANT", center: "evolution", tenant_id: "t" })).status).toBe(400);
  });

  it("registrert verktøy men senteret er likevel ikke koblet inn (`found: false`): 404 `center_not_registered`, aldri en tom OK", async () => {
    const h = await start(registeredIn(defs({ controlCenters: ["evolution"] })), { ok: true, data: { found: false, center: "evolution", summary_no: "ikke koblet inn" } });
    const r = await post(h, "/control/center", { grant_token: "GRANT", center: "evolution" });
    expect(r.status).toBe(404);
    expect(r.body["error"]).toBe("center_not_registered");
  });

  it("en nektet lesing (verktøyets port) gir 403 `tool_denied` med årsaken - ruten svekker aldri porten", async () => {
    const h = await start(registeredIn(defs({ controlCenters: ["evolution"] })), { ok: false, reason: "control_center_requires_signed_device_session" });
    const r = await post(h, "/control/center", { grant_token: "GRANT", center: "evolution" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "tool_denied", reason: "control_center_requires_signed_device_session" });
  });
});
