import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-2 P1B-A HOST FIX #1 (2026-08-16): strukturelle bevis for
 * `google-email-reauth.ts` - samme kildeteksts-basert mønster som
 * `google-drive-reauth-wiring.test.ts` (top-level side-effekt-skript, kan
 * ikke trygt importeres direkte). Fokus: KUN Gmail-credential rørt, den
 * eksisterende Desktop-klienten er en PÅKREVD forutsetning (ingen ny
 * klient/JSON-import bygget her), riktig scope-sett, fail-closed rekkefølge.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const source = readSource("../scripts/google-email-reauth.ts");
const codeOnly = source
  .split("\n")
  .filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
  })
  .join("\n");

function indexOfAll(needle: string): number {
  const idx = source.indexOf(needle);
  expect(idx, `forventet å finne: ${needle}`).toBeGreaterThan(-1);
  return idx;
}

describe("ett-kommando-kontrakten", () => {
  it("toppkommentaren viser NØYAKTIG kommandoen", () => {
    expect(source).toContain("node --experimental-transform-types modules/core/scripts/google-email-reauth.ts");
  });
});

describe("A: KUN en PÅKREVD, ALLEREDE PERSISTERT Desktop-klient brukes - INGEN ny klient/JSON-import bygget her", () => {
  it("krever JARVIS_GOOGLE_OAUTH_CLIENT_TYPE==='desktop' FØR noe OAuth-forsøk, kaster ellers en eksplisitt feil som IKKE endrer .env", () => {
    const checkIdx = indexOfAll('clientType !== "desktop"');
    const authUrlIdx = indexOfAll("buildAuthorizationUrl({");
    expect(checkIdx).toBeLessThan(authUrlIdx);
  });
  it("ingen Nedlastinger-mappe-polling/JSON-fil-oppdagelse (google-drive-reauth.ts sin Desktop-klient-bootstrap-logikk) er kopiert inn her", () => {
    expect(codeOnly).not.toMatch(/waitForDesktopClientJson|listDownloadsJsonCandidates|parseClientSecretJson|Downloads/);
  });
});

describe("B: EGET Gmail-scope-sett - REQUIRED_EMAIL_REAUTH_SCOPES, ikke Drive/Calendar-scopene", () => {
  it("importerer og bruker REQUIRED_EMAIL_REAUTH_SCOPES fra lib-fila, ALDRI REQUIRED_REAUTH_SCOPES (Drive/Calendar)", () => {
    expect(source).toContain("REQUIRED_EMAIL_REAUTH_SCOPES");
    expect(codeOnly).not.toMatch(/\bREQUIRED_REAUTH_SCOPES\b/);
  });
});

describe("C: state/CSRF sjekkes FØR token-exchange (samme presedens som Drive-reauth)", () => {
  it("isValidCallbackState() evalueres FØR exchangeCode()", () => {
    const stateCheckIdx = indexOfAll("if (!isValidCallbackState(callback.state, state)) {");
    const exchangeIdx = indexOfAll("await exchangeCode(");
    expect(stateCheckIdx).toBeLessThan(exchangeIdx);
  });
});

describe("D: scope-verifisering OG en FAKTISK Gmail-lesing (ikke bare scope-strengen) FØR persistering", () => {
  it("hasAllRequiredScopes() sjekkes FØR gmailProfileProbe() FØR .env skrives", () => {
    const scopeCheckIdx = indexOfAll("hasAllRequiredScopes(grantedScope, REQUIRED_EMAIL_REAUTH_SCOPES)");
    const probeIdx = indexOfAll("await gmailProfileProbe(exchange.access_token)");
    const writeIdx = indexOfAll("buildUpdatedEnvLines(lines, updates)");
    expect(scopeCheckIdx).toBeLessThan(probeIdx);
    expect(probeIdx).toBeLessThan(writeIdx);
  });
});

describe("E: KUN JARVIS_EMAIL_TOKEN skrives - Drive/Calendar-credentials HELT urørt", () => {
  it("updates-objektet inneholder KUN JARVIS_EMAIL_TOKEN, ingen av Drive/Calendar-nøklene", () => {
    const updatesIdx = source.indexOf("const updates: EnvValues = {");
    const updatesBlock = source.slice(updatesIdx, source.indexOf("};", updatesIdx) + 2);
    expect(updatesBlock).toContain("JARVIS_EMAIL_TOKEN: exchange.refresh_token");
    expect(updatesBlock).not.toContain("JARVIS_GOOGLE_CLIENT_ID");
    expect(updatesBlock).not.toContain("JARVIS_GOOGLE_CLIENT_SECRET");
    expect(updatesBlock).not.toContain("JARVIS_GOOGLE_TOKEN:");
    expect(updatesBlock).not.toContain("JARVIS_GOOGLE_OAUTH_CLIENT_TYPE");
  });
  it("skriver ALDRI direkte til JARVIS_GOOGLE_TOKEN/_CLIENT_ID/_CLIENT_SECRET/_OAUTH_CLIENT_TYPE noe sted i fila (kun LEST for å hente den eksisterende Desktop-klienten)", () => {
    expect(codeOnly).not.toMatch(/JARVIS_GOOGLE_TOKEN\s*[:=]\s*(?!.*values\[)/);
  });
});

describe("F: atomisk .env-skriving med sikkerhetskopi - samme mønster som google-drive-reauth.ts", () => {
  it("kopierer .env til en .bak.<epoch>-fil FØR skriving, skriver til en tmp-fil og renamer atomisk", () => {
    expect(source).toContain("copyFileSync(envPath, backupPath)");
    expect(source).toContain("writeFileSync(tmpPath, nextContent)");
    expect(source).toContain("renameSync(tmpPath, envPath)");
  });
  it("idempotent no-op sjekkes FØR noen fil skrives", () => {
    const noopIdx = indexOfAll('if (nextContent === lines.join("\\n")) {');
    const backupIdx = indexOfAll("copyFileSync(envPath, backupPath)");
    expect(noopIdx).toBeLessThan(backupIdx);
  });
});

describe("G: ingen secrets logges/kastes", () => {
  const logLines = codeOnly.split("\n").filter((line) => /\blog\(|console\.(error|log)\(/.test(line));
  it("ingen log()/console.*-linje interpolerer client_secret/access_token/refresh_token direkte", () => {
    for (const line of logLines) {
      expect(line, `mulig secret-lekkasje: "${line.trim()}"`).not.toMatch(/clientSecret|exchange\.access_token|exchange\.refresh_token/);
    }
  });
});

describe("H: gjenopprettbare Gmail-probe-blokkeringer håndteres via samme klassifiserte mønster som Drive", () => {
  it("bruker isRecoverableDriveProbeBlocker() (den delte, generiske Google-API-feilklassifiseringen) - ikke en ny, parallell klassifiseringstype", () => {
    expect(source).toContain("isRecoverableDriveProbeBlocker(initial.blocker)");
  });
});

describe("I: rundll32-basert Windows nettleser-åpning (samme root cause-fiks som Drive-reauth) - ALDRI cmd.exe/shell", () => {
  it("openBrowser() bruker rundll32 på win32, execFileSync uten shell:true noe sted", () => {
    expect(source).toContain('execFileSync("rundll32", ["url.dll,FileProtocolHandler"');
    expect(codeOnly).not.toMatch(/shell:\s*true/);
  });
});

describe("J: kjeder IKKE automatisk videre til host-run - kalleren (ua2-p1b-a-host-run.ts) styrer gjenopptak selv", () => {
  it("ingen execFileSync/spawn av et host-run-script i denne fila (i motsetning til google-drive-reauth.ts sin chainToP1aHostRun())", () => {
    expect(codeOnly).not.toMatch(/ua2-p1[ab]/);
  });
});
