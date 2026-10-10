import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertDestinationAllowed, isDestinationRef } from "@jarvis/owner-controls";
import { STEP_UP_EXEMPT_ACTIONS, stepUpDenial } from "../src/step-up.ts";

/** Del 3 (JARVIS-024/037): step-up for eierens kontrollflate + vertsallowlist for destinasjons-konfig. */
describe("stepUpDenial", () => {
  const ok = { auth_strength: "signed", channel: "web" } as const;
  it("signert enhetsøkt fra web/desktop/api/mobile slipper gjennom følsomme handlinger", () => {
    for (const channel of ["web", "desktop", "api", "mobile"] as const) {
      expect(stepUpDenial({ auth_strength: "signed", channel }, "set_connector_credential")).toBeUndefined();
      expect(stepUpDenial({ auth_strength: "signed", channel }, "revoke_device")).toBeUndefined();
    }
  });
  it("aktiv/passiv autentisering er ikke nok", () => {
    for (const strength of ["active", "passive"] as const) {
      expect(stepUpDenial({ auth_strength: strength, channel: "web" }, "set_connector_credential")).toBe("step_up_required:signed_device_session");
    }
  });
  it("tale, Telegram, meldingsplattformer og system kan aldri utføre følsomme kontrollhandlinger", () => {
    for (const channel of ["voice", "telegram", "slack", "discord", "twilio", "system", "watch"] as const) {
      expect(stepUpDenial({ auth_strength: "signed", channel }, "restore_credential")).toContain("step_up_required:channel_");
    }
  });
  it("brytere som STOPPER ting er unntatt (kan brukes raskt, også med svakere autentisering)", () => {
    for (const action of STEP_UP_EXEMPT_ACTIONS) {
      expect(stepUpDenial({ auth_strength: "passive", channel: "voice" }, action)).toBeUndefined();
    }
    expect([...STEP_UP_EXEMPT_ACTIONS].sort()).toEqual(["activate_kill_switch", "cancel_task", "enable_finance_kill_switch", "freeze_connector", "pause_domain", "resolve_situation", "test_connector"]);
    for (const sensitive of ["deactivate_kill_switch", "disable_finance_kill_switch", "unfreeze_connector", "revoke_credential", "restore_credential", "revoke_device", "resume_domain", "set_connector_credential"]) {
      expect(stepUpDenial({ auth_strength: "active", channel: "web" }, sensitive), sensitive).toBeDefined();
    }
    void ok;
  });
  it("serveren håndhever step-up i begge muterende ruter FØR gateway.execute", () => {
    const server = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
    for (const marker of ['url.pathname === "/owner-controls/connector-credentials"', 'url.pathname === "/executive/mutate"']) {
      const start = server.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const block = server.slice(start, start + 4500);
      expect(block.indexOf("stepUpDenial(")).toBeGreaterThan(-1);
      expect(block.indexOf("stepUpDenial(")).toBeLessThan(block.indexOf("deps.executive.gateway.execute("));
    }
  });
});

describe("destinasjons-konfig: vertsallowlist", () => {
  it("gjenkjenner URL-/destinasjons-refs, ikke vanlige hemmeligheter", () => {
    for (const ref of ["JARVIS_JIRA_BASE_URL", "JARVIS_GRAFANA_API_BASE_URL", "JARVIS_MCP_ZAPIER_SERVER_URL", "JARVIS_BROWSER_GATEWAY_BASE_URL"]) expect(isDestinationRef(ref), ref).toBe(true);
    for (const ref of ["JARVIS_GITHUB_TOKEN", "JARVIS_TELEGRAM_TOKEN", "JARVIS_JIRA_API_TOKEN"]) expect(isDestinationRef(ref), ref).toBe(false);
  });
  it("tom allowlist = lukket; vert utenfor allowlist avvises; eksakt og *.-mønster godtas", () => {
    expect(() => assertDestinationAllowed("https://jira.firma.no", [])).toThrow("destination_host_allowlist_not_configured");
    expect(() => assertDestinationAllowed("https://evil.example", ["jira.firma.no"])).toThrow("destination_host_not_allowlisted");
    expect(() => assertDestinationAllowed("https://jira.firma.no/rest", ["jira.firma.no"])).not.toThrow();
    expect(() => assertDestinationAllowed("https://a.b.firma.no", ["*.firma.no"])).not.toThrow();
    expect(() => assertDestinationAllowed("https://firma.no", ["*.firma.no"])).toThrow("destination_host_not_allowlisted");
    expect(() => assertDestinationAllowed("https://xfirma.no", ["*.firma.no"])).toThrow("destination_host_not_allowlisted");
  });
  it("kun ren https; http, bakslash, CR/LF og vert-forvirring avvises", () => {
    const allow = ["jira.firma.no"];
    expect(() => assertDestinationAllowed("http://jira.firma.no", allow)).toThrow("destination_url_must_be_https");
    expect(() => assertDestinationAllowed("https://jira.firma.no\\@evil.example", allow)).toThrow("destination_url_unsafe");
    expect(() => assertDestinationAllowed("https://jira.firma.no\r\nHost: evil", allow)).toThrow("destination_url_unsafe");
    expect(() => assertDestinationAllowed("https://evil.example@jira.firma.no", allow)).toThrow();
  });
});
