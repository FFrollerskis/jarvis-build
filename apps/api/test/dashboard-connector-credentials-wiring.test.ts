import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Task #122 (D-213): strukturelle DB-uavhengige tester for
 * `apps/web/dashboard.html` sin nye "lim inn nøkkel"/"test connector"-
 * mutasjonsflate. Server-siden (allowlist/grant-avslag/gateway.execute()-
 * videreformidling) er dekket i `executive-query-wiring.test.ts`
 * (beskrivelse C) og `executive-query-e2e.test.ts` (beskrivelse D/E/F) -
 * denne suiten beviser KUN at klienten faktisk kaller DEN nye ruten korrekt,
 * og aldri prøver å smugle en mutasjon inn via `/executive/query`.
 */
function readDashboard(): string {
  return readFileSync(fileURLToPath(new URL("../../web/dashboard.html", import.meta.url)), "utf8");
}

describe("A: dashboard.html sin mutateOwnerControls() bruker den nye, EGNE ruten - aldri /executive/query", () => {
  const html = readDashboard();

  it('POSTer til "/owner-controls/connector-credentials"', () => {
    expect(html).toContain('fetch("/owner-controls/connector-credentials"');
  });

  it("sender {grant_token, action, parameters} - samme kroppsform som queryExecutive(), ALDRI en oppfunnet form", () => {
    const idx = html.indexOf("async function mutateOwnerControls");
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, idx + 600);
    expect(block).toMatch(/JSON\.stringify\(\{\s*grant_token:\s*active\.grant_token,\s*action,\s*parameters\s*\}\)/);
  });

  it("set_connector_credential kalles med {connector_id, credential_ref, value} - verdien leses fra input.value, ALDRI hardkodet", () => {
    expect(html).toMatch(/mutateOwnerControls\("set_connector_credential",\s*\{\s*connector_id:\s*connectorId,\s*credential_ref:\s*credentialRef,\s*value\s*\}\)/);
  });

  it("test_connector kalles med {connector_id}", () => {
    expect(html).toMatch(/mutateOwnerControls\("test_connector",\s*\{\s*connector_id:\s*connectorId\s*\}\)/);
  });
});

describe("B: renderConnectors() aldri ekkoer en credential-VERDI inn i DOM-en - kun ref-navn og configured-boolean", () => {
  const html = readDashboard();

  it("credential-input-feltet har type='password' (skjuler verdien mens den skrives inn)", () => {
    expect(html).toMatch(/<input type="password" placeholder="lim inn ny verdi/);
  });

  it("renderConnectors() interpolerer ALDRI et 'value'-felt fra connector-statusen (kun ref/configured/id/display_name/category/health/test_method)", () => {
    const idx = html.indexOf("function renderConnectors(data)");
    const end = html.indexOf("connectorsEl.addEventListener", idx);
    const block = html.slice(idx, end);
    expect(block).not.toMatch(/cred\.value/);
    expect(block).not.toMatch(/c\.value/);
  });
});

describe("C: /executive/query sin egen kropp-bygging forblir UBERØRT av D-213 - ingen 'parameters'-felt smuglet inn i queryExecutive()", () => {
  it("queryExecutive() sender fortsatt KUN {grant_token, action} - ingen 'parameters'", () => {
    const html = readDashboard();
    const idx = html.indexOf("async function queryExecutive");
    const block = html.slice(idx, idx + 500);
    expect(block).toMatch(/JSON\.stringify\(\{\s*grant_token:\s*active\.grant_token,\s*action\s*\}\)/);
    expect(block).not.toContain("parameters");
  });
});
