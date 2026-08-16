import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * GOOGLE DRIVE FULL-ACCESS REAUTH (2026-08-16) §13: strukturelle bevis for
 * `google-drive-reauth.ts` som ikke kan uttrykkes som ren funksjonslogikk
 * (google-drive-reauth-lib.test.ts dekker den delen) - fail-closed-
 * rekkefølge, secrets-i-logg/argv-fravær, atomisk .env-skriving, og at
 * scriptet faktisk kjeder inn i `ua2-p1a-host-run.ts` ved suksess. Samme
 * kildeteksts-basert mønster som ua2-p1a-host-run-wiring.test.ts - ingen
 * ekte nettleser/Google-konto/nettverk kjøres her.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const source = readSource("../scripts/google-drive-reauth.ts");
const codeOnly = source
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

function indexOfAll(needle: string): number {
  const idx = source.indexOf(needle);
  expect(idx, `forventet å finne: ${needle}`).toBeGreaterThan(-1);
  return idx;
}

describe("§14: ett-kommando-kontrakten er dokumentert og eksakt", () => {
  it("toppkommentaren viser NØYAKTIG kommandoen Tobias skal kjøre", () => {
    expect(source).toContain("node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts");
  });
});

describe("§A: manglende client credentials -> fail-closed FØR noe startes (ingen server/nettleser)", () => {
  it("validateClientCredentials() kalles FØR waitForCallback()/openBrowser()", () => {
    const validateIdx = indexOfAll("validateClientCredentials(clientId, clientSecret);");
    const callbackIdx = indexOfAll("waitForCallback(port, state)");
    const browserIdx = indexOfAll("openBrowser(authUrl);");
    expect(validateIdx).toBeLessThan(callbackIdx);
    expect(validateIdx).toBeLessThan(browserIdx);
  });
});

describe("§C: den avviklede OOB-flyten brukes ALDRI i orchestratoren", () => {
  it("ingen 'urn:ietf:wg:oauth:2.0:oob' i noen KODE-linje (kommentaren over forklarer bevisst HVORFOR den unngås, og nevner strengen som dokumentasjon - ikke bruk)", () => {
    expect(codeOnly).not.toContain("urn:ietf:wg:oauth:2.0:oob");
  });
  it("bruker en loopback-IP redirect_uri (127.0.0.1), ikke en ekstern/skjult redirect", () => {
    expect(source).toContain("buildRedirectUri(port)");
  });
});

describe("§D/§E: state/CSRF sjekkes FØR noen token-exchange forsøkes", () => {
  it("isValidCallbackState() evalueres FØR exchangeCode() kalles", () => {
    const stateCheckIdx = indexOfAll("if (!isValidCallbackState(callback.state, state)) {");
    const exchangeIdx = indexOfAll("await exchangeCode(");
    expect(stateCheckIdx).toBeLessThan(exchangeIdx);
  });
});

describe("§G: token-exchange-HTTP-feil håndteres eksplisitt (aldri stille videre med en ugyldig respons)", () => {
  it("exchangeCode() sjekker response.ok og kaster en typet feil FØR noe JSON antas gyldig for videre bruk", () => {
    const fnStart = source.indexOf("async function exchangeCode(");
    const fnBody = source.slice(fnStart, source.indexOf("\n}", fnStart));
    expect(fnBody).toContain("if (!response.ok)");
    expect(fnBody).toContain("tokenExchangeFailureReason(response.status)");
  });
});

describe("§H: utilstrekkelig scope stopper FØR .env noensinne røres", () => {
  it("FAIL_INSUFFICIENT_SCOPE-kastet skjer FØR backup/skriving av .env", () => {
    const scopeFailIdx = indexOfAll("google_reauth=FAIL_INSUFFICIENT_SCOPE");
    const backupIdx = indexOfAll("copyFileSync(envPath, backupPath);");
    expect(scopeFailIdx).toBeLessThan(backupIdx);
  });
  it("§7: en FAKTISK Drive-metadata-lesing (ikke bare scope-strengen) må også lykkes FØR .env røres", () => {
    const driveProbeFailIdx = indexOfAll("google_reauth=FAIL_DRIVE_PROBE");
    const backupIdx = indexOfAll("copyFileSync(envPath, backupPath);");
    expect(driveProbeFailIdx).toBeLessThan(backupIdx);
  });
});

describe("§I/§O: refresh-token-beslutning + konto-mismatch-avslag stopper FØR .env røres - gammel credential forblir gjenopprettbar", () => {
  it("decision.action === 'fail' håndteres FØR backup/skriving", () => {
    const decisionFailIdx = indexOfAll('if (decision.action === "fail") {');
    const backupIdx = indexOfAll("copyFileSync(envPath, backupPath);");
    expect(decisionFailIdx).toBeLessThan(backupIdx);
  });
  it("FAIL_ACCOUNT_MISMATCH_NOT_CONFIRMED håndteres FØR backup/skriving", () => {
    const mismatchFailIdx = indexOfAll("google_reauth=FAIL_ACCOUNT_MISMATCH_NOT_CONFIRMED");
    const backupIdx = indexOfAll("copyFileSync(envPath, backupPath);");
    expect(mismatchFailIdx).toBeLessThan(backupIdx);
  });
  it("O: .env skrives KUN via backup FØRST, deretter atomisk tmp+rename (samme mønster som fix-q21-runtime-role.ts) - aldri direkte writeFileSync(envPath, ...)", () => {
    const backupIdx = indexOfAll("copyFileSync(envPath, backupPath);");
    const renameIdx = indexOfAll("renameSync(tmpPath, envPath);");
    expect(backupIdx).toBeLessThan(renameIdx);
    expect(source).not.toMatch(/writeFileSync\(envPath,/);
  });
});

describe("§J/§K: kun JARVIS_GOOGLE_TOKEN-linjen røres, gjenbruker den EKSISTERENDE .env-oppdaterings-/backup-mekanismen (ingen parallell implementasjon)", () => {
  it("importerer buildUpdatedEnvLines/parseEnvValues fra den EKSISTERENDE lib/q21-env-recovery.ts", () => {
    expect(source).toContain('from "./lib/q21-env-recovery.ts"');
    expect(source).toContain("buildUpdatedEnvLines");
    expect(source).toContain("parseEnvValues");
  });
  it("updates-objektet setter KUN JARVIS_GOOGLE_TOKEN - ingen andre nøkler røres av dette scriptet", () => {
    const updatesIdx = source.indexOf("const updates: EnvValues = {");
    const updatesLine = source.slice(updatesIdx, source.indexOf("};", updatesIdx) + 1);
    expect(updatesLine).toContain("JARVIS_GOOGLE_TOKEN: decision.refreshToken");
    expect(updatesLine).not.toContain("JARVIS_GOOGLE_CLIENT_ID");
    expect(updatesLine).not.toContain("JARVIS_GOOGLE_CLIENT_SECRET");
    expect(updatesLine).not.toContain("JARVIS_GOOGLE_ACCOUNT");
  });
  it("timestemplet backup skrives med .env.bak.<epoch>-mønsteret", () => {
    expect(source).toContain("`${envPath}.bak.${Date.now()}`");
  });
});

describe("§L: secrets logges ALDRI (client_secret/access_token/refresh_token/authorization_code)", () => {
  const logLines = codeOnly.split("\n").filter((line) => /\blog\(|console\.(error|log)\(/.test(line));
  const forbiddenIdentifiers = ["clientSecret", "access_token", "refresh_token", "existingRefreshToken", "decision.refreshToken", "callback.code", "body.access_token"];

  it("ingen log()/console.*-linje interpolerer en av de forbudte credential-identifikatorene", () => {
    for (const line of logLines) {
      for (const forbidden of forbiddenIdentifiers) {
        expect(line, `secret-lekkasje-kandidat: "${line.trim()}" inneholder ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
  it("kun MASKERT e-post logges for konto-identitet, aldri hele adressen ubearbeidet", () => {
    const emailLogLines = logLines.filter((line) => line.includes("detectedEmail") || line.includes("configuredAccount"));
    for (const line of emailLogLines) {
      expect(line).toMatch(/maskEmail\(/);
    }
  });
});

describe("§M: ingen secret som argv-element i noe barneprosess-kall", () => {
  const callBlocks = [...source.matchAll(/execFileSync\(([\s\S]*?)\);/g)].map((m) => m[1] ?? "");
  const forbiddenIdentifiers = ["clientSecret", "accessToken", "refreshToken", "existingRefreshToken", "exchange.access_token", "exchange.refresh_token", "decision.refreshToken", "callback.code"];

  it("finner minst de to forventede execFileSync-kallene (nettleser-åpning + kjeding til ua2-p1a-host-run.ts)", () => {
    expect(callBlocks.length).toBeGreaterThanOrEqual(2);
  });
  it("ingen av dem sender en credential-verdi som prosessargument", () => {
    for (const block of callBlocks) {
      for (const forbidden of forbiddenIdentifiers) {
        expect(block, `secret-i-argv-kandidat: "${block.trim()}" inneholder ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("§N: suksessfull reauth kjeder AUTOMATISK inn i ua2-p1a-host-run.ts - ingen andre kommando fra Tobias", () => {
  it("chainToP1aHostRun() kalles ETTER 'google_drive_reauth=PASS' logges, ikke før", () => {
    const passLogIdx = indexOfAll('log("google_drive_reauth=PASS");');
    const callSiteIdx = source.lastIndexOf("chainToP1aHostRun();");
    expect(callSiteIdx).toBeGreaterThan(passLogIdx);
  });
  it("chainToP1aHostRun() kjører NØYAKTIG samme kommando som Tobias ellers ville kjørt selv, med --experimental-transform-types", () => {
    const fnStart = source.indexOf("function chainToP1aHostRun(): void {");
    const fnBody = source.slice(fnStart, source.indexOf("\n}", fnStart));
    expect(fnBody).toContain("--experimental-transform-types");
    expect(fnBody).toContain("modules/core/scripts/ua2-p1a-host-run.ts");
    expect(fnBody).toContain('stdio: "inherit"');
  });
});

describe("§P: en fersk state/nonce genereres FOR HVER kjøring - ingen persistert tilstand mellom kjøringer gjør gjentatt bruk utrygg", () => {
  it("state genereres via randomBytes(24) INNI main(), ikke som en modul-nivå konstant", () => {
    const mainStart = indexOfAll("async function main(): Promise<void> {");
    const stateIdx = indexOfAll('const state = randomBytes(24).toString("hex");');
    expect(stateIdx).toBeGreaterThan(mainStart);
  });
  it("ingen nonce/state-fil skrives til disk - writeFileSync brukes KUN for den atomiske .env-oppdateringen (tmpPath, avledet av envPath)", () => {
    const writeFileSyncCalls = [...source.matchAll(/writeFileSync\(([^,]+),/g)].map((m) => (m[1] ?? "").trim());
    expect(writeFileSyncCalls.length).toBeGreaterThan(0);
    for (const target of writeFileSyncCalls) {
      expect(target).toBe("tmpPath");
    }
  });
});

describe("§11: ingen skjult fallback til en gammel/utilstrekkelig credential ved feil", () => {
  it("kun ÉN writeFileSync/renameSync-linje mot .env i hele fila (ingen alternativ skrivevei et annet sted)", () => {
    expect([...source.matchAll(/writeFileSync\(/g)]).toHaveLength(1);
    expect([...source.matchAll(/renameSync\(/g)]).toHaveLength(1);
  });
});

describe("§12: reauth-scriptet muterer ALDRI Drive utover trygg lese-verifisering", () => {
  it("ingen POST/PATCH/PUT/DELETE mot googleapis.com/drive - kun GET-baserte metadata-lesinger", () => {
    expect(source).not.toMatch(/method:\s*"(POST|PATCH|PUT|DELETE)"[^}]*drive\/v3/s);
    expect(source).toContain("GOOGLE_DRIVE_ROOT_METADATA_ENDPOINT");
  });
});
