import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-212 (task #120): `server.ts` er et top-level side-effekt-skript sammen
 * med resten av API-appen - `main.ts` kan derfor IKKE trygt importeres
 * direkte i en testfil (samme presedens som `executive-query-wiring.test.ts`).
 * Denne suiten verifiserer KUN den statiske serveringen av `voice.html` under
 * `GET /voice` - selve talestrømmen går IKKE via denne prosessen (egen
 * voice-gateway-prosess, CLAUDE.md ufravikelig regel 5), og dekkes derfor av
 * `apps/voice-gateway/test/`, ikke her.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const serverSource = readSource("../src/server.ts");

describe("A: GET /voice serverer apps/web/voice.html, samme mønster som GET /dashboard", () => {
  it("WEB_VOICE peker på apps/web/voice.html", () => {
    expect(serverSource).toMatch(
      /const WEB_VOICE = fileURLToPath\(new URL\("\.\.\/\.\.\/web\/voice\.html", import\.meta\.url\)\);/
    );
  });

  it('ruten sjekker GET og url.pathname === "/voice" FØR den leser WEB_VOICE', () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/voice"');
    expect(routeIdx).toBeGreaterThan(-1);
    const readIdx = serverSource.indexOf("readFile(WEB_VOICE", routeIdx);
    expect(readIdx).toBeGreaterThan(routeIdx);
  });

  it("svarer med text/html; charset=utf-8, samme som WEB_INDEX/WEB_DASHBOARD-rutene", () => {
    const routeIdx = serverSource.indexOf('url.pathname === "/voice"');
    const block = serverSource.slice(routeIdx, serverSource.indexOf("return;", routeIdx));
    expect(block).toContain('"content-type": "text/html; charset=utf-8"');
  });
});

describe("B: voice.html gjenbruker SAMME enhetsnøkkel-/grant-mekanisme som dashboard.html - ingen ny autentisering oppfunnet", () => {
  const voiceHtml = readSource("../../web/voice.html");
  const dashboardHtml = readSource("../../web/dashboard.html");

  it("bruker samme /devices/challenge + /devices/register-ruter som dashboard.html", () => {
    expect(voiceHtml).toContain('fetch("/devices/challenge"');
    expect(voiceHtml).toContain('fetch("/devices/register"');
  });

  it("bruker SAMME localStorage-nøkkel for enhetsnøkkel som dashboard.html (samme fysiske enhet)", () => {
    expect(voiceHtml).toContain('localStorage.getItem("jarvis.devicekey")');
    expect(dashboardHtml).toContain('localStorage.getItem("jarvis.devicekey")');
  });

  it("device_proof sendes som {challenge, signature} inn i WS start-meldingen, ikke en oppfunnet form", () => {
    expect(voiceHtml).toMatch(/device_proof:\s*\{\s*challenge,\s*signature\s*\}/);
  });

  it("Q-32/processor_terms_status-blokkeringen forklares ÆRLIG for speech_routing_denied_stt/tts, aldri skjules", () => {
    expect(voiceHtml).toContain("speech_routing_denied_stt:");
    expect(voiceHtml).toContain("speech_routing_denied_tts:");
    expect(voiceHtml).toContain("Q-32");
    expect(voiceHtml).not.toMatch(/processor_terms_status\s*=\s*["']VERIFIED["']/);
  });
});

describe("D-259: transcriptEl tømmes ved HVERT 'Start samtale'-klikk - ingen stille sammenblanding av flere test-/bruksøkter i én nettleserfane", () => {
  const voiceHtml = readSource("../../web/voice.html");

  it("startConversation() tømmer transcript-panelet FØR mikrofontilgang/WebSocket-oppkobling", () => {
    const fnIdx = voiceHtml.indexOf("async function startConversation()");
    expect(fnIdx).toBeGreaterThan(-1);
    const clearIdx = voiceHtml.indexOf('transcriptEl.innerHTML = \'<p class="empty">Ingen samtale ennå.</p>\';', fnIdx);
    const micIdx = voiceHtml.indexOf("getUserMedia", fnIdx);
    expect(clearIdx).toBeGreaterThan(fnIdx);
    expect(clearIdx).toBeLessThan(micIdx);
  });
});
