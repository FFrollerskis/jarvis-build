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
    const callbackIdx = indexOfAll('waitForCallback(params.port, params.state);');
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
    const stateCheckIdx = indexOfAll("if (!isValidCallbackState(callback.state, usedState)) {");
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
  it("updates-objektet setter NORMALT (ikke-importert klient) KUN JARVIS_GOOGLE_TOKEN - ingen andre nøkler røres i den grenen", () => {
    const updatesIdx = source.indexOf("const updates: EnvValues = usingImportedClient");
    const updatesBlock = source.slice(updatesIdx, source.indexOf(";", source.indexOf(": { JARVIS_GOOGLE_TOKEN", updatesIdx)) + 1);
    expect(updatesBlock).toContain("JARVIS_GOOGLE_TOKEN: decision.refreshToken");
    // De to grenene av ternary-uttrykket: KUN importert-grenen inneholder client_id/_secret sammen med token:
    const importedBranch = updatesBlock.slice(0, updatesBlock.indexOf(": { JARVIS_GOOGLE_TOKEN"));
    const plainBranch = updatesBlock.slice(updatesBlock.indexOf(": { JARVIS_GOOGLE_TOKEN"));
    expect(importedBranch).toContain("JARVIS_GOOGLE_CLIENT_ID: clientId");
    expect(importedBranch).toContain("JARVIS_GOOGLE_CLIENT_SECRET: clientSecret");
    expect(plainBranch).not.toContain("JARVIS_GOOGLE_CLIENT_ID");
    expect(plainBranch).not.toContain("JARVIS_GOOGLE_CLIENT_SECRET");
    expect(updatesBlock).not.toContain("JARVIS_GOOGLE_ACCOUNT");
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

describe("§P: en fersk state/nonce genereres FOR HVER kjøring/HVERT forsøk - ingen persistert tilstand mellom kjøringer gjør gjentatt bruk utrygg", () => {
  it("state genereres via randomBytes(24) INNI main() for HVERT attemptOAuth()-kall, ikke som en modul-nivå konstant (HOST FIX #3: kan kalles TO GANGER - opprinnelig forsøk + evt. ett friskt forsøk med en nyoppdaget Desktop-klient)", () => {
    const mainStart = indexOfAll("async function main(): Promise<void> {");
    const occurrences = [...source.matchAll(/state: randomBytes\(24\)\.toString\("hex"\)/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    for (const m of occurrences) {
      expect(m.index as number).toBeGreaterThan(mainStart);
    }
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

/**
 * GOOGLE DRIVE REAUTH HOST FIX (2026-08-16): Tobias sin faktiske kjøring
 * feilet med "Required parameter is missing: response_type" OG viste feil
 * konto (henrik@ffskis.com) samtidig - root cause var `openBrowser()` sin
 * daværende Windows-vei (`cmd /c start "" <url>`) som korrumperte URL-en
 * (cmd.exe sin `/c`-linjeparsing splitter på et USITERT `&` i
 * spørrestrengen - Node sin Windows-argv-quoting siterer IKKE et argument
 * som verken har mellomrom eller anførselstegn). Denne seksjonen beviser
 * fiksen strukturelt: `cmd`/`start` er HELT BORTE fra Windows-veien, og
 * pre-flight-validering + tvunget kontovelger er faktisk koblet inn.
 */
describe("§1 (host-fix): cmd.exe/'start' er ALDRI lenger involvert i å åpne nettleseren på Windows", () => {
  it("openBrowser() sin Windows-gren bruker rundll32.exe (native .exe, ingen shell/kommandotolk)", () => {
    const fnStart = source.indexOf("function openBrowser(url: string): void {");
    const fnBody = source.slice(fnStart, source.indexOf("\n}", fnStart));
    expect(fnBody).toContain('execFileSync("rundll32", ["url.dll,FileProtocolHandler", url]');
  });
  it("verken 'cmd' (ComSpec) eller cmd.exe sin 'start'-innebygde brukes NOE STED i fila lenger", () => {
    expect(codeOnly).not.toMatch(/\bComSpec\b/);
    expect(codeOnly).not.toMatch(/"start"/);
    expect(codeOnly).not.toMatch(/\/c["'],?\s*$/m);
  });
});

describe("§2/§C (host-fix): Google sin kontovelger tvinges ALLTID - aldri en stille auto-valgt allerede-innlogget konto", () => {
  it("buildAuthorizationUrl() kalles med loginHint (params.loginHint inni attemptOAuth) - ALDRI en hardkodet/manglende kontohint-verdi", () => {
    const callIdx = indexOfAll("const authUrl = buildAuthorizationUrl({");
    const callLine = source.slice(callIdx, source.indexOf("});", callIdx) + 3);
    expect(callLine).toContain("loginHint: params.loginHint");
  });
  it("main() gir loginHint: configuredAccount til BEGGE mulige attemptOAuth()-kall (opprinnelig + evt. retry)", () => {
    const occurrences = [...source.matchAll(/loginHint: configuredAccount/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

describe("§4/§G (host-fix): pre-flight URL-validering skjer FØR noen server startes eller nettleser åpnes - fail-closed, .env urørt", () => {
  it("validateAuthorizationUrl() kalles FØR waitForCallback()/openBrowser()", () => {
    const buildIdx = indexOfAll("const authUrl = buildAuthorizationUrl({");
    const validateIdx = indexOfAll("validateAuthorizationUrl(authUrl, REQUIRED_REAUTH_SCOPES);");
    const callbackIdx = indexOfAll('const callbackAttempt = waitForCallback(params.port, params.state);');
    const browserIdx = source.indexOf("openBrowser(authUrl);");
    expect(buildIdx).toBeLessThan(validateIdx);
    expect(validateIdx).toBeLessThan(callbackIdx);
    expect(validateIdx).toBeLessThan(browserIdx);
  });
  it("en kastet MalformedAuthorizationUrlError skjer strukturelt FØR .env-backup-koden (samme fail-closed-mønster som de andre feilbanene)", () => {
    const validateIdx = indexOfAll("validateAuthorizationUrl(authUrl, REQUIRED_REAUTH_SCOPES);");
    const backupIdx = indexOfAll("copyFileSync(envPath, backupPath);");
    expect(validateIdx).toBeLessThan(backupIdx);
  });
});

describe("§D/§3 (host-fix): kontomismatch rapporteres trygt (expected_account=/authorized_account=), aldri stille akseptert", () => {
  it("confirmAccountMismatch() bruker formatAccountMismatchReport() - ikke en ad-hoc strengsammensetning", () => {
    const fnStart = source.indexOf("async function confirmAccountMismatch(");
    const fnBody = source.slice(fnStart, source.indexOf("\n}", fnStart));
    expect(fnBody).toContain("formatAccountMismatchReport(configuredMasked, detectedMasked)");
  });
});

describe("§K (host-fix): fortsatt ingen secrets logges etter denne rundens endringer", () => {
  it("ingen log()-linje interpolerer authUrl FØR den er validert (URL-en selv er ikke hemmelig, men logges kun til info/feilsøking etter pre-flight-sjekken har kjørt)", () => {
    const validateIdx = indexOfAll("validateAuthorizationUrl(authUrl, REQUIRED_REAUTH_SCOPES);");
    const firstAuthUrlLogIdx = source.indexOf("log(`venter på autorisasjon");
    expect(firstAuthUrlLogIdx).toBeGreaterThan(validateIdx);
  });
});

/**
 * GOOGLE OAUTH HOST FIX #2 (2026-08-16): Tobias sin faktiske klient ga
 * "Error 400: redirect_uri_mismatch" - Google validerer redirect_uri FØR
 * noe annet og sender ALDRI noen callback tilbake i det tilfellet, så
 * denne prosessen kan IKKE oppdage feilen selv via callback-serveren.
 * Permanent løsning: en dedikert "Desktop app"-OAuth-klient, importert via
 * en nedlastet client-secret-JSON (JARVIS_GOOGLE_CLIENT_SECRET_JSON i
 * .env) - se google-drive-reauth-lib.test.ts for selve
 * JSON-parse-/type-avvisnings-logikken. Denne seksjonen beviser
 * ORCHESTRATOR-koblingen strukturelt: koherent credential-sett,
 * ingen blanding av gammel/ny klient, og en trygg gjenoppta-etter-manuell-
 * handling-flyt.
 */
describe("HOST FIX #2: JARVIS_GOOGLE_CLIENT_SECRET_JSON importeres FØR client-credential-validering - ingen blanding av gammel/ny klient", () => {
  it("resolveOAuthClient() kalles FØRST i main() - client_id/_secret er ALLTID fra ÉN kilde (enten importert JSON eller .env, aldri en blanding), FØR det FØRSTE attemptOAuth()-kallet", () => {
    const mainStart = indexOfAll("async function main(): Promise<void> {");
    const mainEnd = source.indexOf("\nmain().catch", mainStart);
    const mainBody = source.slice(mainStart, mainEnd);
    const resolveIdx = mainBody.indexOf("resolveOAuthClient(values)");
    const firstAttemptIdx = mainBody.indexOf("await attemptOAuth({");
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(firstAttemptIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(firstAttemptIdx);
  });
  it("resolveOAuthClient() feiler FØR credential-json-stien noensinne skrives til .env (eksisterer-sjekk FØR parseClientSecretJson)", () => {
    const fnStart = indexOfAll("function resolveOAuthClient(values: EnvValues): ResolvedOAuthClient {");
    const fnBody = source.slice(fnStart, source.indexOf("\n}", fnStart));
    const existsIdx = fnBody.indexOf("existsSync(jsonPath)");
    const parseIdx = fnBody.indexOf("parseClientSecretJson(");
    expect(existsIdx).toBeGreaterThan(-1);
    expect(parseIdx).toBeGreaterThan(existsIdx);
  });
  it("HELE flyten (autorisasjons-URL, token-exchange, refresh-scope-sjekk) bruker de SAMME clientId/clientSecret-variablene fra resolveOAuthClient() - ingen parallell/duplisert lesing av JARVIS_GOOGLE_CLIENT_ID/_SECRET andre steder i main()", () => {
    const mainStart = indexOfAll("async function main(): Promise<void> {");
    const mainBody = source.slice(mainStart, source.indexOf("\nmain().catch", mainStart));
    const directEnvReads = [...mainBody.matchAll(/values\["JARVIS_GOOGLE_CLIENT_(ID|SECRET)"\]/g)];
    expect(directEnvReads).toHaveLength(0);
  });
});

describe("HOST FIX #2: koherent client_id/client_secret/token-sett - aldri kun token skrevet mot en client_id/_secret som ikke lenger samsvarer", () => {
  it("en IMPORTERT Desktop-klient skriver client_id+client_secret+token SAMMEN i ÉN buildUpdatedEnvLines()-kall - ikke to separate skrivinger", () => {
    expect([...source.matchAll(/buildUpdatedEnvLines\(/g)]).toHaveLength(1);
  });
  it("den importerte klientens EGNE clientId/clientSecret-variabler skrives tilbake (ikke en hardkodet/annen verdi)", () => {
    const updatesIdx = indexOfAll("const updates: EnvValues = usingImportedClient");
    const updatesBlock = source.slice(updatesIdx, source.indexOf(";", source.indexOf(": { JARVIS_GOOGLE_TOKEN", updatesIdx)) + 1);
    expect(updatesBlock).toContain("JARVIS_GOOGLE_CLIENT_ID: clientId");
    expect(updatesBlock).toContain("JARVIS_GOOGLE_CLIENT_SECRET: clientSecret");
  });
});

describe("HOST FIX #2: kontovelger (select_account) er UENDRET/bevart uansett hvilken klientkilde som brukes", () => {
  it("buildAuthorizationUrl()-kallet bruker SAMME REQUIRED_REAUTH_SCOPES/loginHint-mønster uavhengig av usingImportedClient (ingen egen gren som dropper select_account for importerte klienter)", () => {
    expect([...source.matchAll(/buildAuthorizationUrl\(\{/g)]).toHaveLength(1);
  });
});

describe("HOST FIX #2: gjenoppta-etter-manuell-Cloud-Console-handling er .env-drevet (avansert/manuelt oppsett) - ingen CLI-flagg/interaktiv prompt Tobias MÅ bruke", () => {
  it("JARVIS_GOOGLE_CLIENT_SECRET_JSON leses fra samme values-objekt som resten av .env-configen (readEnv()), ikke process.argv", () => {
    expect(source).toContain('values["JARVIS_GOOGLE_CLIENT_SECRET_JSON"]');
    expect(codeOnly).not.toMatch(/process\.argv/);
  });
});

describe("HOST FIX #2: ingen secrets logges av den nye JSON-import-/Console-URL-koden", () => {
  it("ingen log()-linje interpolerer clientSecret (verken fra .env eller fra en importert JSON)", () => {
    expect(codeOnly).not.toMatch(/log\(`[^`]*\$\{clientSecret\}/);
  });
  it("Cloud Console-URL-en (aldri hemmelig - kun et prosjektnummer) er trygg å logge/åpne, men selve jsonPath-innholdet (client_secret-verdien) leses ALDRI inn i en log()-streng direkte", () => {
    const readIdx = indexOfAll("readFileSync(jsonPath, \"utf8\")");
    const lineEnd = source.indexOf("\n", readIdx);
    expect(source.slice(source.lastIndexOf("\n", readIdx), lineEnd)).not.toMatch(/^\s*log\(/);
  });
});

/**
 * GOOGLE OAUTH HOST FIX #3 "ZERO MANUAL ENV EDITING" (2026-08-16): Tobias
 * skal KUN gjøre ÉN uunngåelig manuell handling - opprette en "Desktop
 * app"-OAuth-klient i Cloud Console og trykke "Download JSON". ALDRI
 * redigere .env, kopiere client_id/client_secret, eller lime inn en
 * filsti. Denne seksjonen beviser at Nedlastinger-mappa overvåkes
 * automatisk, i SAMME kjørende prosess, og at et koherent credential-sett
 * persisteres til de VANLIGE JARVIS_GOOGLE_CLIENT_ID/_SECRET-nøklene (ikke
 * en ny permanent variabel) FØRST etter faktisk OAuth-suksess.
 */
describe("A/L (host-fix #3): watchForNewClient er PÅ som standard (ingen 'allerede importert' -> alltid et første forsøk), men AV for en EKSPLISITT JARVIS_GOOGLE_CLIENT_SECRET_JSON-import (hopper over oppdagelse helt)", () => {
  it("A: det FØRSTE attemptOAuth()-kallet i main() setter watchForNewClient: !usingImportedClient - en vanlig (ikke-importert) klient overvåkes ALLTID for en ny Desktop-JSON i bakgrunnen", () => {
    const mainStart = indexOfAll("async function main(): Promise<void> {");
    const firstAttemptIdx = indexOfAll("watchForNewClient: !usingImportedClient,");
    expect(firstAttemptIdx).toBeGreaterThan(mainStart);
  });
  it("L: retry-forsøket (etter et 'new_client'-funn) setter watchForNewClient: false - vi har ALLEREDE en Desktop-klient, ingen grunn til å polle Nedlastinger på nytt i samme kjøring", () => {
    expect(source).toContain("watchForNewClient: false,");
  });
  it("en EKSPLISITT konfigurert JARVIS_GOOGLE_CLIENT_SECRET_JSON (avansert/manuelt oppsett) setter imported: true i resolveOAuthClient() - hopper dermed over Nedlastinger-oppdagelsen helt via samme !usingImportedClient-gate", () => {
    expect(source).toContain("return { clientId: parsed.clientId, clientSecret: parsed.clientSecret, imported: true };");
  });
});

describe("B/C (host-fix #3): Nedlastinger-mappa oppdages via os.homedir() (ikke en hardkodet Windows-bruker-sti), KUN filer fra og med run-starttidspunktet regnes", () => {
  it("B: bruker homedir()+'Downloads' - den offisielle, dokumenterte standardplasseringen på Windows/macOS/Linux, ALDRI en hardkodet C:\\Users\\<navn>-sti", () => {
    expect(source).toContain('const downloadsDir = join(homedir(), "Downloads");');
    expect(codeOnly).not.toMatch(/C:\\\\Users/);
  });
  it("C: runStartMs settes FØR readEnv()/resolveOAuthClient() og sendes uendret til BEGGE attemptOAuth()-kall - en gammel, urelatert JSON fra FØR kjøringen startet plukkes ALDRI opp automatisk", () => {
    const runStartIdx = indexOfAll("const runStartMs = Date.now();");
    const readEnvIdx = indexOfAll("const { lines, values } = readEnv();");
    expect(runStartIdx).toBeLessThan(readEnvIdx);
    expect([...source.matchAll(/runStartMs$/gm)].length + [...source.matchAll(/runStartMs,/g)].length).toBeGreaterThanOrEqual(2);
  });
});

describe("D/E/F (host-fix #3): watchForDesktopClientDownload() validerer HVER kandidat via den EKSISTERENDE parseClientSecretJson() - web/ugyldige filer ekskluderes STILLE, krasjer ALDRI polling-løkka", () => {
  it("D/E/F: tryReadValidDesktopClient() kaller parseClientSecretJson() og fanger ENHVER feil (web-type, ugyldig JSON, manglende felt) til undefined - ingen ny/parallell valideringslogikk, ingen ukontrollert kast ut av polling-løkka", () => {
    const fnStart = indexOfAll("function tryReadValidDesktopClient(candidate: DownloadCandidateFile): { clientId: string; clientSecret: string } | undefined {");
    const fnBody = source.slice(fnStart, source.indexOf("\n}", fnStart));
    expect(fnBody).toContain("parseClientSecretJson(readFileSync(candidate.path, \"utf8\"))");
    expect(fnBody).toMatch(/catch\s*\{\s*return undefined;/);
  });
});

describe("G (host-fix #3): flere gyldige kandidater samtidig -> eksplisitt, trygg fil-navn-velger - ALDRI en stille gjetning", () => {
  it("watchForDesktopClientDownload() sin 'multiple'-gren kaller promptForCandidateSelection() FØR den returnerer et funn - stopper ALDRI stille på den første kandidaten", () => {
    const fnStart = indexOfAll("function watchForDesktopClientDownload(downloadsDir: string, sinceMs: number, onGuidanceDue: () => void): CancellableWatch {");
    const fnBody = source.slice(fnStart, source.indexOf("\n  return { result, cancel:", fnStart));
    expect(fnBody).toContain('classification.kind === "multiple"');
    const multipleIdx = fnBody.indexOf('classification.kind === "multiple"');
    const promptIdx = fnBody.indexOf("promptForCandidateSelection(classification.candidates)");
    expect(promptIdx).toBeGreaterThan(multipleIdx);
  });
  it("promptForCandidateSelection() bruker formatCandidateSelectionPrompt()/parseCandidateSelection() fra lib - ingen ad-hoc parsing, og logger KUN filnavn (ingen client_id/secret)", () => {
    const fnStart = indexOfAll("async function promptForCandidateSelection(candidates: DownloadCandidateFile[]): Promise<string | undefined> {");
    const fnBody = source.slice(fnStart, source.indexOf("\n}", fnStart));
    expect(fnBody).toContain("formatCandidateSelectionPrompt(candidates.map((c) => c.name))");
    expect(fnBody).toContain("parseCandidateSelection(answer, candidates.length)");
  });
});

describe("H (host-fix #3): ingen secrets logges av Nedlastinger-oppdagelses-/race-koden", () => {
  const newCodeStart = indexOfAll("function sleep(ms: number): Promise<void> {");
  const newCodeEnd = source.indexOf("interface TokenResponse {");
  const newCode = source.slice(newCodeStart, newCodeEnd);
  it("ingen log()-linje i hele Nedlastinger-/race-seksjonen interpolerer clientId/clientSecret direkte (kun trygge verdier: filnavn, stier, URL-er)", () => {
    expect(newCode).not.toMatch(/log\(`[^`]*\$\{.*clientSecret/);
    expect(newCode).not.toMatch(/log\(`[^`]*\$\{.*winner\.found\.clientSecret/);
  });
});

describe("I/J (host-fix #3): koherent client_id/client_secret/token persisteres KUN etter FAKTISK OAuth-suksess (scope+Drive-probe+kontosjekk alle bestått FØRST)", () => {
  it("I: 'new_client'-oppdagelsen setter usingImportedClient=true, men SKRIVER INGENTING til .env på det tidspunktet - kun etter en påfølgende, fullt vellykket attemptOAuth()+exchange+scope+Drive-probe lenger nede i main()", () => {
    const newClientIdx = indexOfAll('if (attempt.outcome === "new_client") {');
    const updatesIdx = indexOfAll("const updates: EnvValues = usingImportedClient");
    const scopeCheckIdx = indexOfAll("google_reauth=FAIL_INSUFFICIENT_SCOPE");
    const driveProbeIdx = indexOfAll("google_reauth=FAIL_DRIVE_PROBE");
    expect(newClientIdx).toBeLessThan(scopeCheckIdx);
    expect(scopeCheckIdx).toBeLessThan(updatesIdx);
    expect(driveProbeIdx).toBeLessThan(updatesIdx);
  });
  it("J: client_id/client_secret/token skrives fra de SAMME (evt. oppdaterte) clientId/clientSecret-let-bindingene som ble brukt til selve OAuth-utvekslingen - ingen andre/duplikate variabler", () => {
    const updatesIdx = indexOfAll("const updates: EnvValues = usingImportedClient");
    const updatesBlock = source.slice(updatesIdx, source.indexOf(";", source.indexOf(": { JARVIS_GOOGLE_TOKEN", updatesIdx)) + 1);
    expect(updatesBlock).toContain("JARVIS_GOOGLE_CLIENT_ID: clientId");
    expect(updatesBlock).toContain("JARVIS_GOOGLE_CLIENT_SECRET: clientSecret");
    expect(source).toContain("clientId = attempt.found.clientId;");
    expect(source).toContain("clientSecret = attempt.found.clientSecret;");
  });
});

describe("K (host-fix #3): JARVIS_GOOGLE_CLIENT_SECRET_JSON persisteres ALDRI selv - kun et engangs import-/bootstrap-artefakt, ikke en permanent runtime-variabel", () => {
  it("ingen kodested skriver JARVIS_GOOGLE_CLIENT_SECRET_JSON til .env (kun JARVIS_GOOGLE_CLIENT_ID/_SECRET/_TOKEN skrives, alltid til de VANLIGE nøklene)", () => {
    expect(codeOnly).not.toMatch(/JARVIS_GOOGLE_CLIENT_SECRET_JSON:/);
    const updatesIdx = indexOfAll("const updates: EnvValues = usingImportedClient");
    const updatesBlock = source.slice(updatesIdx, source.indexOf(";", source.indexOf(": { JARVIS_GOOGLE_TOKEN", updatesIdx)) + 1);
    expect(updatesBlock).not.toContain("JARVIS_GOOGLE_CLIENT_SECRET_JSON");
  });
});

describe("M (host-fix #3): SAMME kjørende prosess fortsetter automatisk inn i OAuth-forsøket etter et Nedlastinger-funn - ingen restart", () => {
  it("main() gjenbruker den SAMME clientId/clientSecret/usingImportedClient-let-bindingen for det andre attemptOAuth()-kallet, ikke en ny prosess/spawn", () => {
    expect(codeOnly).not.toMatch(/spawn\(|execFileSync\("node", \["--experimental-transform-types", "modules\/core\/scripts\/google-drive-reauth\.ts"/);
    const newClientIdx = indexOfAll('if (attempt.outcome === "new_client") {');
    const retryAttemptIdx = source.indexOf("attempt = await attemptOAuth({", newClientIdx);
    expect(retryAttemptIdx).toBeGreaterThan(newClientIdx);
  });
  it("callbackAttempt.cancel() kalles FØR 'new_client' returneres fra attemptOAuth() - porten er alltid fri før det andre forsøket starter på SAMME port", () => {
    const winnerFoundIdx = indexOfAll("if (winner.found) {");
    const cancelIdx = source.indexOf("callbackAttempt.cancel();", winnerFoundIdx);
    const returnNewClientIdx = source.indexOf('return { outcome: "new_client", found: winner.found };', winnerFoundIdx);
    expect(cancelIdx).toBeGreaterThan(winnerFoundIdx);
    expect(cancelIdx).toBeLessThan(returnNewClientIdx);
  });
});

describe("N (host-fix #3): fortsetter inn i UA-2 P1A host-akseptanse etter suksess - uendret fra tidligere runder", () => {
  it("chainToP1aHostRun() forblir det SISTE steget etter google_drive_reauth=PASS, uansett om det opprinnelige forsøket eller et Nedlastinger-oppdaget retry-forsøk vant", () => {
    const passLogIdx = indexOfAll('log("google_drive_reauth=PASS");');
    const chainIdx = indexOfAll("chainToP1aHostRun();");
    expect(chainIdx).toBeGreaterThan(passLogIdx);
  });
});
