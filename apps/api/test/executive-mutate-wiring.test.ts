import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Task #124 (UA-11 Executive dashboard-UI, MUTASJONS-DELEN, D-199 §7 sitt
 * eget eksplisitt utsatte gap): strukturelle DB-uavhengige tester for
 * `POST /executive/mutate` i `apps/api/src/server.ts` - EGEN, HELT NY rute,
 * EGET hardkodet allowlist (`EXECUTIVE_MUTATE_ACTIONS`), ALDRI en utvidelse
 * av `EXECUTIVE_QUERY_ACTIONS` (som D-199 selv sier skal forbli lese-kun
 * for alltid - se `executive-query-wiring.test.ts` beskrivelse B for det
 * beviset, UBERØRT av denne sliceen). Ekte HTTP-bevis (allowlist-avslag/
 * grant-avslag/videreformidling) ligger i `executive-query-e2e.test.ts`
 * beskrivelse G/H/I - denne suiten beviser KUN rutens KILDEKODE-struktur.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const serverSource = readSource("../src/server.ts");

describe("A: EXECUTIVE_MUTATE_ACTIONS inneholder NØYAKTIG de 12 executive.*-mutasjonshandlingene", () => {
  it("inneholder alle 12 forventede handlinger, ingen flere, ingen færre", () => {
    const match = serverSource.match(/const EXECUTIVE_MUTATE_ACTIONS = \[([\s\S]*?)\] as const;/);
    expect(match).not.toBeNull();
    const actions = (match?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/"/g, ""))
      .filter(Boolean);
    expect(actions.sort()).toEqual(
      [
        "pause_domain", "resume_domain", "resolve_situation",
        "activate_kill_switch", "deactivate_kill_switch",
        "freeze_connector", "unfreeze_connector",
        "revoke_credential", "restore_credential", "revoke_device",
        "enable_finance_kill_switch", "disable_finance_kill_switch"
      ].sort()
    );
  });

  it("ingen lese-handling (get_attention_queue/get_control_surface_status/get_connector_status/get_attention_item/get_pause_state/get_delegation_board/get_capability_status/get_finance_kill_switch) forekommer i EXECUTIVE_MUTATE_ACTIONS-blokken", () => {
    const match = serverSource.match(/const EXECUTIVE_MUTATE_ACTIONS = \[[\s\S]*?\] as const;/);
    expect(match).not.toBeNull();
    const block = match?.[0] ?? "";
    for (const readAction of [
      "get_attention_queue", "get_control_surface_status", "get_connector_status",
      "get_attention_item", "get_pause_state", "get_delegation_board", "get_capability_status", "get_finance_kill_switch"
    ]) {
      expect(block).not.toContain(readAction);
    }
  });
});

describe("B: EXECUTIVE_QUERY_ACTIONS forblir UENDRET/lese-kun av denne sliceen", () => {
  it("fortsatt KUN get_attention_queue, get_control_surface_status, get_connector_status, get_delegation_board (D-230 la til den fjerde, ikke denne sliceen)", () => {
    const match = serverSource.match(/const EXECUTIVE_QUERY_ACTIONS = \[([\s\S]*?)\] as const;/);
    expect(match).not.toBeNull();
    const actions = (match?.[1] ?? "").split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
    expect(actions.sort()).toEqual(
      ["get_attention_queue", "get_control_surface_status", "get_connector_status", "get_delegation_board"].sort()
    );
  });
});

describe("C: /executive/mutate-ruten - avslagsrekkefølge, identitet, tool_id", () => {
  it("ruten avslår en handling utenfor allowlistet FØR gateway.execute() nås", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/executive/mutate"');
    expect(routeIdx).toBeGreaterThan(-1);
    const executeIdx = serverSource.indexOf("deps.executive.gateway.execute(", routeIdx);
    const allowlistCheckIdx = serverSource.indexOf("action_not_allowed", routeIdx);
    expect(allowlistCheckIdx).toBeGreaterThan(-1);
    expect(executeIdx).toBeGreaterThan(-1);
    expect(allowlistCheckIdx).toBeLessThan(executeIdx);
  });

  it("identiteten som sendes til gateway.execute() kommer fra resolveFromGrant(), ALDRI fra en kaller-oppgitt identitet i body", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/executive/mutate"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf("deps.executive.gateway.execute(", routeIdx) + 400);
    expect(block).toContain("resolveFromGrant(deps,");
    expect(block).toContain("identity: resolved.identity");
  });

  it("kaller gateway.execute() med tool_id='executive', ALDRI 'owner_controls'/'situations'/'finance' direkte", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/executive/mutate"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf("deps.executive.gateway.execute(", routeIdx) + 400);
    expect(block).toMatch(/tool_id:\s*"executive"/);
  });

  it("et gateway.execute()-avslag (ok:false) videreformidles som 403 tool_denied", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/executive/mutate"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf('url.pathname === "/devices/register"'));
    expect(block).toMatch(/if \(!result\.ok\) \{\s*return json\(res, 403, \{ error: "tool_denied", reason: result\.reason \}\);/);
  });

  it("ruten krever deps.executive (samme valgfrie-avhengighet-mønster som /executive/query/owner-controls-ruten - helse-modus uten database gir 404, ikke en krasj)", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/executive/mutate"');
    const lineStart = serverSource.lastIndexOf("if (", routeIdx);
    const line = serverSource.slice(lineStart, routeIdx + 40);
    expect(line).toContain("deps.executive &&");
  });
});
