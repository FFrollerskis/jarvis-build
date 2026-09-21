import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Task #124 (UA-11 Executive dashboard-UI, MUTASJONS-DELEN, D-199 §7):
 * strukturelle DB-uavhengige tester for `apps/web/dashboard.html` sin nye
 * "Kontrollhandlinger"-flate (de 12 `executive.*`-mutasjonshandlingene).
 * Server-siden (allowlist/grant-avslag/tool_id/videreformidling) er dekket i
 * `executive-mutate-wiring.test.ts` (struktur) og `executive-query-e2e.test.ts`
 * beskrivelse G/H/I (ekte HTTP) - denne suiten beviser KUN at klienten
 * faktisk kaller DEN nye ruten korrekt, ALLTID via bekreftelsesmodalen, og
 * aldri prøver å smugle en mutasjon inn via `/executive/query`.
 */
function readDashboard(): string {
  return readFileSync(fileURLToPath(new URL("../../web/dashboard.html", import.meta.url)), "utf8");
}

describe("A: mutateExecutive() bruker den nye, EGNE ruten - aldri /executive/query eller /owner-controls/connector-credentials", () => {
  const html = readDashboard();

  it('POSTer til "/executive/mutate"', () => {
    expect(html).toContain('fetch("/executive/mutate"');
  });

  it("sender {grant_token, action, parameters} - samme kroppsform som mutateOwnerControls()/queryExecutive(), ALDRI en oppfunnet form", () => {
    const idx = html.indexOf("async function mutateExecutive");
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, idx + 600);
    expect(block).toMatch(/JSON\.stringify\(\{\s*grant_token:\s*active\.grant_token,\s*action,\s*parameters:\s*parameters \|\| \{\}\s*\}\)/);
  });
});

describe("B: runExecutiveMutation() ALLTID viser openConfirmModal() FØR mutateExecutive() kalles, avbrutt = ingen kall", () => {
  const html = readDashboard();

  it("await openConfirmModal(action) kommer FØR await mutateExecutive(...) i samme funksjon", () => {
    const idx = html.indexOf("async function runExecutiveMutation");
    expect(idx).toBeGreaterThan(-1);
    const end = html.indexOf("\n  }", idx);
    const block = html.slice(idx, end);
    const confirmIdx = block.indexOf("openConfirmModal(action)");
    const mutateIdx = block.indexOf("mutateExecutive(action, parameters)");
    expect(confirmIdx).toBeGreaterThan(-1);
    expect(mutateIdx).toBeGreaterThan(-1);
    expect(confirmIdx).toBeLessThan(mutateIdx);
  });

  it("en avbrutt bekreftelse (confirmed === false) returnerer FØR mutateExecutive() nås", () => {
    const idx = html.indexOf("async function runExecutiveMutation");
    const block = html.slice(idx, idx + 300);
    expect(block).toMatch(/if \(!confirmed\) return;/);
  });
});

describe("C: openConfirmModal() krever typed confirmation for klasse D (kill switch-familien), ikke for B/C", () => {
  const html = readDashboard();

  it("ACTION_META klassifiserer NØYAKTIG de fire kill-switch-handlingene som klasse D, resten B/C", () => {
    const idx = html.indexOf("const ACTION_META = {");
    expect(idx).toBeGreaterThan(-1);
    const end = html.indexOf("\n  };", idx);
    const block = html.slice(idx, end);
    for (const action of ["activate_kill_switch", "deactivate_kill_switch", "enable_finance_kill_switch", "disable_finance_kill_switch"]) {
      const actionIdx = block.indexOf(action + ":");
      expect(actionIdx).toBeGreaterThan(-1);
      expect(block.slice(actionIdx, actionIdx + 200)).toMatch(/class:\s*"D"/);
    }
    for (const action of ["pause_domain", "resume_domain", "freeze_connector", "unfreeze_connector", "revoke_credential", "restore_credential", "revoke_device"]) {
      const actionIdx = block.indexOf(action + ":");
      expect(actionIdx).toBeGreaterThan(-1);
      expect(block.slice(actionIdx, actionIdx + 200)).toMatch(/class:\s*"C"/);
    }
    const resolveIdx = block.indexOf("resolve_situation:");
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(block.slice(resolveIdx, resolveIdx + 200)).toMatch(/class:\s*"B"/);
  });

  it("requiresTyped (class === 'D') gater confirmOkBtn.disabled og krever eksakt handlingsnavn i confirmTyped", () => {
    const idx = html.indexOf("function openConfirmModal");
    expect(idx).toBeGreaterThan(-1);
    const end = html.indexOf("\n  }\n", idx);
    const block = html.slice(idx, end);
    expect(block).toMatch(/requiresTyped\s*=\s*meta\.class\s*===\s*"D"/);
    expect(block).toMatch(/confirmOkBtn\.disabled\s*=\s*confirmTyped\.value\.trim\(\)\s*!==\s*action/);
  });
});

describe("D: de fire mutasjonene med et nytt, ikke-allerede-listet mål (pause/freeze/revoke_credential/revoke_device) går via runExecutiveMutation() med korrekte parametre", () => {
  const html = readDashboard();

  it("pause_domain kalles med {domain, reason} fra pause-domain-name/-reason", () => {
    expect(html).toMatch(/runExecutiveMutation\("pause_domain",\s*\{\s*domain,\s*reason\s*\}/);
  });

  it("freeze_connector kalles med {connector_id, reason} fra freeze-connector-id/-reason", () => {
    expect(html).toMatch(/runExecutiveMutation\("freeze_connector",\s*\{\s*connector_id:\s*connectorId,\s*reason\s*\}/);
  });

  it("revoke_credential kalles med {credential_ref, reason} fra revoke-credential-ref/-reason", () => {
    expect(html).toMatch(/runExecutiveMutation\("revoke_credential",\s*\{\s*credential_ref:\s*credentialRef,\s*reason\s*\}/);
  });

  it("revoke_device kalles med {device_id, reason} fra revoke-device-id/-reason", () => {
    expect(html).toMatch(/runExecutiveMutation\("revoke_device",\s*\{\s*device_id:\s*deviceId,\s*reason\s*\}/);
  });
});

describe("E: de fire mutasjonene på ALLEREDE synlige rader (resume/unfreeze/restore/resolve) er event-delegert, ALDRI ett listener per rad", () => {
  const html = readDashboard();

  it("resume_domain/unfreeze_connector/restore_credential er delegert på controlSurfaceEl.addEventListener", () => {
    const idx = html.indexOf('controlSurfaceEl.addEventListener("click"');
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, idx + 1200);
    expect(block).toContain('runExecutiveMutation("unfreeze_connector"');
    expect(block).toContain('runExecutiveMutation("restore_credential"');
    expect(block).toContain('runExecutiveMutation("resume_domain"');
  });

  it("resolve_situation er delegert på attentionQueueEl.addEventListener", () => {
    const idx = html.indexOf('attentionQueueEl.addEventListener("click"');
    expect(idx).toBeGreaterThan(-1);
    const block = html.slice(idx, idx + 400);
    expect(block).toContain('runExecutiveMutation("resolve_situation"');
  });
});

describe("F: /executive/query sin egen kroppsbygging forblir UBERØRT av task #124 - ingen mutasjon smuglet inn i queryExecutive()", () => {
  it("queryExecutive() sender fortsatt KUN {grant_token, action} - ingen 'parameters'", () => {
    const html = readDashboard();
    const idx = html.indexOf("async function queryExecutive");
    const block = html.slice(idx, idx + 500);
    expect(block).toMatch(/JSON\.stringify\(\{\s*grant_token:\s*active\.grant_token,\s*action\s*\}\)/);
    expect(block).not.toContain("parameters");
  });
});
