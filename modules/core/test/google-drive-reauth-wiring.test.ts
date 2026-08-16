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

describe("§J/§K: gjenbruker den EKSISTERENDE .env-oppdaterings-/backup-mekanismen (ingen parallell implementasjon)", () => {
  it("importerer buildUpdatedEnvLines/parseEnvValues fra den EKSISTERENDE lib/q21-env-recovery.ts", () => {
    expect(source).toContain('from "./lib/q21-env-recovery.ts"');
    expect(source).toContain("buildUpdatedEnvLines");
    expect(source).toContain("parseEnvValues");
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
  it("buildAuthorizationUrl() kalles med loginHint: configuredAccount - ALDRI en hardkodet/manglende kontohint-verdi", () => {
    const callIdx = indexOfAll("const authUrl = buildAuthorizationUrl({");
    const callLine = source.slice(callIdx, source.indexOf("});", callIdx) + 3);
    expect(callLine).toContain("loginHint: configuredAccount");
  });
});

describe("§4/§G (host-fix): pre-flight URL-validering skjer FØR noen server startes eller nettleser åpnes - fail-closed, .env urørt", () => {
  it("validateAuthorizationUrl() kalles FØR waitForCallback()/openBrowser()", () => {
    const buildIdx = indexOfAll("const authUrl = buildAuthorizationUrl({");
    const validateIdx = indexOfAll("validateAuthorizationUrl(authUrl, REQUIRED_REAUTH_SCOPES);");
    const callbackIdx = indexOfAll("const callbackPromise = waitForCallback(port, state);");
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
 * GOOGLE OAUTH HOST FIX #4 "SETUP-FØRST, ALDRI AUTH MED KJENT WEB-KLIENT"
 * (2026-08-16): Tobias sin FAKTISKE neste host-kjøring beviste at HOST FIX
 * #3 sitt race var feil design - nettleseren åpnet Google OAuth
 * UMIDDELBART med den samme, allerede kjent inkompatible Web-klienten
 * (samme "redirect_uri_mismatch" som HOST FIX #2). Denne seksjonen beviser
 * at racet er FJERNET og erstattet med en STRENGT sekvensiell
 * setup-først-flyt: `resolveProvenDesktopClient()` avgjøres FØRST, og et
 * OAuth-forsøk startes ALDRI før en Desktop-klient er POSITIVT bevist
 * (enten fra før, eller nyoppdaget via `waitForDesktopClientJson()`, som
 * venter ALENE - ingen samtidig OAuth-forsøk).
 */
describe("A (host-fix #4): resolveProvenDesktopClient() avgjøres FØRST i main() - OAuth-URL-en bygges ALDRI FØR client er avklart", () => {
  it("client = resolveProvenDesktopClient(values) skjer FØR buildAuthorizationUrl()-kallet", () => {
    const mainStart = indexOfAll("async function main(): Promise<void> {");
    const resolveIdx = indexOfAll("let client = resolveProvenDesktopClient(values);");
    const authUrlIdx = indexOfAll("const authUrl = buildAuthorizationUrl({");
    expect(mainStart).toBeLessThan(resolveIdx);
    expect(resolveIdx).toBeLessThan(authUrlIdx);
  });
  it("legacy JARVIS_GOOGLE_CLIENT_ID/_SECRET ALENE (uten JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop) gir IKKE en bevist klient - resolveProvenDesktopClient() krever EKSPLISITT enten JSON-import eller den persisterte metadata-linjen", () => {
    const fnStart = indexOfAll("function resolveProvenDesktopClient(values: EnvValues): ProvenDesktopClient | undefined {");
    const fnBody = source.slice(fnStart, source.indexOf("\nasync function main", fnStart));
    expect(fnBody).toContain('clientType === "desktop"');
    expect(fnBody).toContain("return undefined;");
  });
});

describe("B (host-fix #4): INGEN OAuth-URL bygges/åpnes FØR en Desktop-klient er bevist - SETUP_REQUIRED-grenen kjøres FØRST og FERDIG", () => {
  it("Cloud Console-siden (SETUP_REQUIRED) åpnes STRUKTURELT FØR buildAuthorizationUrl()/openBrowser(authUrl) - if(!client)-blokken avsluttes FØR OAuth-seksjonen starter", () => {
    const mainStart = indexOfAll("async function main(): Promise<void> {");
    const setupRequiredIdx = indexOfAll('log("google_desktop_client_status=SETUP_REQUIRED");');
    const waitIdx = indexOfAll("const found = await waitForDesktopClientJson(downloadsDir, runStartMs);");
    const authUrlIdx = indexOfAll("const authUrl = buildAuthorizationUrl({");
    expect(mainStart).toBeLessThan(setupRequiredIdx);
    expect(setupRequiredIdx).toBeLessThan(waitIdx);
    expect(waitIdx).toBeLessThan(authUrlIdx);
  });
  it("Cloud Console-siden åpnes UMIDDELBART i SETUP_REQUIRED-grenen - INGEN 25s-graceperiode/setTimeout lenger (den forrige runden sin GUIDANCE_GRACE_MS er fjernet)", () => {
    expect(codeOnly).not.toContain("GUIDANCE_GRACE_MS");
    const setupRequiredIdx = indexOfAll('log("google_desktop_client_status=SETUP_REQUIRED");');
    const openConsoleIdx = source.indexOf("openBrowser(consoleUrl);", setupRequiredIdx);
    expect(openConsoleIdx).toBeGreaterThan(setupRequiredIdx);
    expect(openConsoleIdx).toBeLessThan(setupRequiredIdx + 400);
  });
});

describe("C (host-fix #4): Nedlastinger-watcheren venter ALENE - INGEN samtidig OAuth-forsøk (ingen race)", () => {
  it("J: ingen Promise.race() finnes NOE STED i fila lenger - det er ALDRI mer enn ett OAuth-forsøk per kjøring", () => {
    expect(codeOnly).not.toMatch(/Promise\.race/);
    expect(codeOnly).not.toContain("attemptOAuth");
    expect(codeOnly).not.toContain("watchForDesktopClientDownload");
  });
  it("waitForDesktopClientJson() bruker homedir()+'Downloads' - den offisielle, dokumenterte standardplasseringen, ALDRI en hardkodet bruker-sti", () => {
    expect(source).toContain('const downloadsDir = join(homedir(), "Downloads");');
    expect(codeOnly).not.toMatch(/C:\\\\Users/);
  });
  it("runStartMs settes FØR readEnv() og sendes til waitForDesktopClientJson() - en gammel, urelatert JSON fra FØR kjøringen startet plukkes ALDRI opp automatisk", () => {
    const runStartIdx = indexOfAll("const runStartMs = Date.now();");
    const readEnvIdx = indexOfAll("const { lines, values } = readEnv();");
    const waitCallIdx = indexOfAll("waitForDesktopClientJson(downloadsDir, runStartMs)");
    expect(runStartIdx).toBeLessThan(readEnvIdx);
    expect(readEnvIdx).toBeLessThan(waitCallIdx);
  });
});

describe("D/E (host-fix #4): waitForDesktopClientJson() validerer HVER kandidat via den EKSISTERENDE parseClientSecretJson() - web/ugyldige filer ekskluderes STILLE, krasjer ALDRI polling-løkka", () => {
  it("tryReadValidDesktopClient() kaller parseClientSecretJson() og fanger ENHVER feil (web-type, ugyldig JSON, manglende felt) til undefined", () => {
    const fnStart = indexOfAll("function tryReadValidDesktopClient(candidate: DownloadCandidateFile): { clientId: string; clientSecret: string } | undefined {");
    const fnBody = source.slice(fnStart, source.indexOf("\n}", fnStart));
    expect(fnBody).toContain('parseClientSecretJson(readFileSync(candidate.path, "utf8"))');
    expect(fnBody).toMatch(/catch\s*\{\s*return undefined;/);
  });
});

describe("E/F (host-fix #4): valid installed-JSON transisjonerer til OAuth - ALLTID med den nyoppdagede klientens EGEN client_id", () => {
  it("E: waitForDesktopClientJson()-resultatet ('found') brukes DIREKTE til å sette 'client' - samme objekt driver den påfølgende OAuth-seksjonen", () => {
    const foundIdx = indexOfAll("const found = await waitForDesktopClientJson(downloadsDir, runStartMs);");
    const clientAssignIdx = indexOfAll('client = { clientId: found.clientId, clientSecret: found.clientSecret, source: "explicit_json" };');
    expect(clientAssignIdx).toBeGreaterThan(foundIdx);
  });
  it("F: buildAuthorizationUrl() bruker client.clientId (den BEVISTE/nyoppdagede klienten) - ALDRI values[\"JARVIS_GOOGLE_CLIENT_ID\"] direkte", () => {
    const callIdx = indexOfAll("const authUrl = buildAuthorizationUrl({");
    const callLine = source.slice(callIdx, source.indexOf("});", callIdx) + 3);
    expect(callLine).toContain("clientId: client.clientId");
    expect(callLine).not.toMatch(/clientId:\s*values\[/);
  });
});

describe("K (host-fix #4): redirect_uri_mismatch-løkka fra den legacy Web-klienten kan IKKE gjenta seg - client_id/_secret leses ALDRI direkte fra .env inn i OAuth-seksjonen", () => {
  it("main() sin OAuth-seksjon (FRA buildAuthorizationUrl til exchangeCode) leser ALDRI values[\"JARVIS_GOOGLE_CLIENT_ID\"]/[\"JARVIS_GOOGLE_CLIENT_SECRET\"] direkte - kun via client.clientId/client.clientSecret", () => {
    const authUrlIdx = indexOfAll("const authUrl = buildAuthorizationUrl({");
    const exchangeIdx = indexOfAll("const exchange = await exchangeCode(client.clientId, client.clientSecret, callback.code, redirectUri);");
    const oauthSection = source.slice(authUrlIdx, exchangeIdx);
    expect(oauthSection).not.toMatch(/values\["JARVIS_GOOGLE_CLIENT_(ID|SECRET)"\]/);
  });
});

describe("G (host-fix #4): flere gyldige kandidater samtidig -> eksplisitt, trygg fil-navn-velger - ALDRI en stille gjetning", () => {
  it("waitForDesktopClientJson() sin 'multiple'-gren kaller promptForCandidateSelection() FØR den returnerer et funn", () => {
    const fnStart = indexOfAll("async function waitForDesktopClientJson(downloadsDir: string, sinceMs: number): Promise<DesktopClientDownloadFound> {");
    const fnBody = source.slice(fnStart, source.indexOf("\n}", fnStart));
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
  it("en timeout UTEN funn kastes EKSPLISITT - aldri en stille tom-retur som ville latt main() fortsette med en udefinert klient", () => {
    expect(source).toContain("google_reauth=FAIL_DESKTOP_CLIENT_TIMEOUT");
  });
});

describe("G/H (host-fix #4): ingen secrets logges av Nedlastinger-oppdagelses-/setup-koden", () => {
  const newCodeStart = indexOfAll("function sleep(ms: number): Promise<void> {");
  const newCodeEnd = source.indexOf("interface TokenResponse {");
  const newCode = source.slice(newCodeStart, newCodeEnd);
  it("ingen log()-linje i hele Nedlastinger-/setup-seksjonen interpolerer clientId/clientSecret direkte (kun trygge verdier: filnavn, stier, URL-er)", () => {
    expect(newCode).not.toMatch(/log\(`[^`]*\$\{.*clientSecret/);
  });
});

describe("G/L (host-fix #4): gammel credential FORBLIR helt urørt frem til FAKTISK OAuth-suksess", () => {
  it("verken JARVIS_GOOGLE_CLIENT_ID, JARVIS_GOOGLE_CLIENT_SECRET eller JARVIS_GOOGLE_TOKEN skrives NOE STED FØR den siste updates-blokken (én eneste buildUpdatedEnvLines()-kall i hele fila)", () => {
    expect([...codeOnly.matchAll(/buildUpdatedEnvLines\(/g)]).toHaveLength(1);
    const updatesIdx = indexOfAll("const updates: EnvValues = {");
    const scopeCheckIdx = indexOfAll("google_reauth=FAIL_INSUFFICIENT_SCOPE");
    const driveProbeIdx = indexOfAll("google_reauth=FAIL_DRIVE_PROBE");
    expect(scopeCheckIdx).toBeLessThan(updatesIdx);
    expect(driveProbeIdx).toBeLessThan(updatesIdx);
  });
});

describe("H (host-fix #4): koherent client_id/client_secret/token/client-type-metadata persisteres SAMMEN, atomisk, KUN etter suksess", () => {
  it("updates-objektet inneholder ALLE FIRE nøklene i ÉN atomisk skriving - ingen delvis skriving", () => {
    const updatesIdx = indexOfAll("const updates: EnvValues = {");
    const updatesBlock = source.slice(updatesIdx, source.indexOf("};", updatesIdx) + 2);
    expect(updatesBlock).toContain("JARVIS_GOOGLE_CLIENT_ID: client.clientId");
    expect(updatesBlock).toContain("JARVIS_GOOGLE_CLIENT_SECRET: client.clientSecret");
    expect(updatesBlock).toContain("JARVIS_GOOGLE_TOKEN: decision.refreshToken");
    expect(updatesBlock).toContain('JARVIS_GOOGLE_OAUTH_CLIENT_TYPE: "desktop"');
  });
});

describe("I (host-fix #4): persistert JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop lar FREMTIDIGE kjøringer hoppe trygt over setup", () => {
  it("resolveProvenDesktopClient() godtar EKSPLISITT clientType === 'desktop' fra .env som bevis - IKKE tilstedeværelse av client_id/_secret alene", () => {
    const fnStart = indexOfAll("function resolveProvenDesktopClient(values: EnvValues): ProvenDesktopClient | undefined {");
    const fnBody = source.slice(fnStart, source.indexOf("\nasync function main", fnStart));
    expect(fnBody).toContain('const clientType = values["JARVIS_GOOGLE_OAUTH_CLIENT_TYPE"];');
    expect(fnBody).toContain('if (clientId && clientSecret && clientType === "desktop") {');
  });
});

describe("K (host-fix #4): JARVIS_GOOGLE_CLIENT_SECRET_JSON persisteres ALDRI selv - kun et engangs import-/bootstrap-artefakt", () => {
  it("ingen kodested skriver JARVIS_GOOGLE_CLIENT_SECRET_JSON til .env (kun JARVIS_GOOGLE_CLIENT_ID/_SECRET/_TOKEN/_OAUTH_CLIENT_TYPE skrives)", () => {
    expect(codeOnly).not.toMatch(/JARVIS_GOOGLE_CLIENT_SECRET_JSON:/);
    const updatesIdx = indexOfAll("const updates: EnvValues = {");
    const updatesBlock = source.slice(updatesIdx, source.indexOf("};", updatesIdx) + 2);
    expect(updatesBlock).not.toContain("JARVIS_GOOGLE_CLIENT_SECRET_JSON");
  });
});

describe("L (host-fix #4): ett-kommando-kontrakten er UENDRET - ingen restart, ingen .env-redigering, ingen filsti å lime inn", () => {
  it("waitForDesktopClientJson() kjøres i SAMME prosess som resten av main() - ingen spawn/execFileSync av seg selv", () => {
    expect(codeOnly).not.toMatch(/execFileSync\("node", \["--experimental-transform-types", "modules\/core\/scripts\/google-drive-reauth\.ts"/);
  });
  it("chainToP1aHostRun() forblir det SISTE steget etter google_drive_reauth=PASS", () => {
    const passLogIdx = indexOfAll('log("google_drive_reauth=PASS");');
    const chainIdx = indexOfAll("chainToP1aHostRun();");
    expect(chainIdx).toBeGreaterThan(passLogIdx);
  });
});
