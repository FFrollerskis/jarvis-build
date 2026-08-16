// GOOGLE DRIVE FULL-ACCESS REAUTH (2026-08-16): host run_id `262ac1bb` viste
// `google_drive_auth_scope=BLOCKED_REAUTH_REQUIRED` (get_metadata("root") ->
// `drive_auth_error_403`) - det eksisterende `JARVIS_GOOGLE_TOKEN` mangler
// full Drive-scope. Tobias skal ALDRI måtte lime inn en autorisasjonskode,
// redigere .env manuelt, eller kjøre en egen andre kommando for selve P1A-
// akseptansen etterpå - dette scriptet gjør HELE reautoriseringen (og
// kjeder rett videre til `ua2-p1a-host-run.ts`) i ÉN kommando.
//
// Offisiell OAuth 2.0-flyt for installerte/CLI-klienter: "authorization
// code" + en LOOPBACK IP-adresse (`http://127.0.0.1:<port>/oauth2callback`)
// som redirect_uri - RFC 8252 sin anbefalte erstatning for den nå avviklede
// "out-of-band" (OOB, `urn:ietf:wg:oauth:2.0:oob`)-flyten, som denne koden
// ALDRI bruker (se google-drive-reauth-lib.test.ts §C). En "Desktop app"-
// registrert OAuth-klient godtar loopback-porter UTEN forhåndsregistrering;
// en "Web application"-klient krever en EKSAKT forhåndsregistrert URI - se
// loggmeldingen FØR nettleseren åpnes for nøyaktig hva Tobias skal sjekke
// hvis Google viser "redirect_uri_mismatch" (ingen gjetning gjort - feilen
// vises eksplisitt av Google selv, aldri antatt bort).
//
// `exchangeCode()` gjenbruker SAMME token-endepunkt/skjema som den
// eksisterende `googleAccessToken()`-hjelperen i
// modules/tool-gateway/src/live-transports.ts (client_id/client_secret som
// form-POST-felt) - ingen parallell credential-form oppfunnet.
//
// HOST-FIX (2026-08-16, Tobias sin faktiske kjøring): Google avviste med
// "Required parameter is missing: response_type" OG viste feil konto
// (`henrik@ffskis.com`) - samtidig, fra SAMME root cause. Den genererte
// autorisasjons-URL-en har ALLTID inneholdt `response_type=code` (bevist av
// google-drive-reauth-lib.test.ts §B siden forrige runde) - feilen lå i
// `openBrowser()` sin daværende Windows-vei: `cmd /c start "" <url>`.
// URL-en inneholder `&` (et gyldig spørrestreng-skilletegn), men verken
// mellomrom eller anførselstegn - Node sin Windows-argv-til-kommandolinje-
// quoting SITÉRER derfor IKKE argumentet automatisk. cmd.exe mottok URL-en
// USITERT i `/c`-modus, og cmd.exe sin EGEN linje-parsing splitter på HVERT
// ubeskyttet `&` som et kommando-skille - Google mottok dermed reelt KUN
// `...auth?client_id=<id>` (nok til å identifisere appen og falle stille
// tilbake til en allerede innlogget nettleser-konto), ALDRI
// `redirect_uri`/`response_type`/`scope`/`state`. BEGGE host-symptomene
// forklares dermed av NØYAKTIG denne ene URL-avkuttingen. Fikset ved å
// ALDRI la cmd.exe se URL-en i det hele tatt: `rundll32.exe
// url.dll,FileProtocolHandler <url>` er den klassiske, dokumenterte måten å
// åpne en URL i standardnettleseren på Windows UTEN cmd.exe (native .exe,
// execFileSync uten shell - samme DEP0190-presedens som
// lib/package-manager-resolve.ts). I tillegg: `prompt` inkluderer nå
// `select_account` (tvinger ALLTID Google sin kontovelger, aldri en stille
// auto-valgt konto) + `validateAuthorizationUrl()` kjøres FØR nettleseren
// åpnes i det hele tatt (fail-closed sikkerhetsnett mot enhver FREMTIDIG
// regresjon i selve URL-byggingen).
//
// Kjøres PÅ HOSTEN (Windows), fra repo-roten - ÉN kommando:
//
//   node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts
//
// Leser/skriver `.env` DIREKTE via filsystemet (samme mønster som
// fix-q21-runtime-role.ts) - INGEN `--env-file`-flagg nødvendig på selve
// dette kallet. Sikkerhetskopierer `.env` FØR endring (`.env.bak.<epoch>`),
// skriver atomisk (tmp-fil + rename), rører KUN `JARVIS_GOOGLE_TOKEN`-
// linjen - alle andre linjer/kommentarer/variabler er urørt. Skriver ALDRI
// client_secret/access_token/refresh_token/authorization_code til
// stdout/stderr eller noe prosessargument (kun i HTTP-body/headers mot
// Google sine egne endepunkt). `.env` endres KUN ved full suksess - enhver
// feilbane returnerer/kaster FØR skrivingen, slik at den eksisterende
// (fungerende, om enn scope-begrensede) credentialen alltid forblir
// gjenopprettbar. Ved suksess kjøres `ua2-p1a-host-run.ts` AUTOMATISK til
// slutt - ingen andre kommando nødvendig fra Tobias.

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_REAUTH_PORT,
  GOOGLE_DRIVE_ROOT_METADATA_ENDPOINT,
  GOOGLE_OAUTH_TOKENINFO_ENDPOINT,
  GOOGLE_OAUTH_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  OAUTH_CALLBACK_PATH,
  REQUIRED_REAUTH_SCOPES,
  buildAuthorizationUrl,
  buildRedirectUri,
  classifyAccountConsistency,
  decideRefreshToken,
  formatAccountMismatchReport,
  hasAllRequiredScopes,
  isValidCallbackState,
  maskEmail,
  parseCallbackQuery,
  tokenExchangeFailureReason,
  validateAuthorizationUrl,
  validateClientCredentials,
  type CallbackResult
} from "./lib/google-drive-reauth-lib.ts";
import { buildUpdatedEnvLines, parseEnvValues, type EnvValues } from "./lib/q21-env-recovery.ts";

const repoRoot = process.cwd();
const envPath = join(repoRoot, ".env");
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

function log(msg: string): void {
  console.log(`[google-drive-reauth] ${msg}`);
}

function readEnv(): { lines: string[]; values: EnvValues } {
  if (!existsSync(envPath)) {
    throw new Error(`.env ikke funnet: ${envPath} - kjør fra repo-roten, kopier .env.example til .env først`);
  }
  const content = readFileSync(envPath, "utf8");
  return { lines: content.split("\n"), values: parseEnvValues(content) };
}

/**
 * Best-effort - en URL uten secrets er trygg å vise/åpne; feiler ALDRI hele
 * flyten hvis nettleseren ikke kan åpnes automatisk (headless/SSH-host).
 *
 * HOST-FIX (2026-08-16): Windows-veien bruker BEVISST `rundll32.exe
 * url.dll,FileProtocolHandler <url>` - IKKE `cmd /c start "" <url>` (den
 * forrige, KORRUMPERENDE veien - se toppkommentaren for full forklaring av
 * hvorfor cmd.exe sin `/c`-linjeparsing splitter en usitert URL med `&` i
 * spørrestrengen). `rundll32.exe` er en native .exe - INGEN
 * kommandotolk/shell involvert i det hele tatt, samme
 * "native-exe-trenger-ingen-wrapper"-presedens som
 * lib/package-manager-resolve.ts sin `requiresCmdWrapper`-logikk.
 */
function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      execFileSync("rundll32", ["url.dll,FileProtocolHandler", url], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
    log("åpnet standardnettleseren automatisk.");
  } catch {
    log(`kunne IKKE åpne nettleseren automatisk - åpne denne URL-en manuelt:\n${url}`);
  }
}

const CALLBACK_HTML_OK = "<html><body><h3>Jarvis: autorisasjon mottatt.</h3><p>Du kan lukke denne fanen og gå tilbake til terminalen.</p></body></html>";
const CALLBACK_HTML_ERR = "<html><body><h3>Jarvis: autorisasjon feilet.</h3><p>Gå tilbake til terminalen for detaljer.</p></body></html>";

/** §4/§D/§E i ordren: én midlertidig loopback-server, venter på ÉN callback-request på OAUTH_CALLBACK_PATH, lukker seg selv deretter (uansett utfall). */
async function waitForCallback(port: number, expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const result = parseCallbackQuery(req.url ?? "");
      const ok = !result.error && isValidCallbackState(result.state, expectedState) && Boolean(result.code);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ok ? CALLBACK_HTML_OK : CALLBACK_HTML_ERR);
      clearTimeout(timer);
      server.close();
      resolve(result);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("google_reauth=FAIL_TIMEOUT: ingen callback mottatt innen 5 minutter - autorisasjonen ble ikke fullført i nettleseren."));
    }, CALLBACK_TIMEOUT_MS);
    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(port, "127.0.0.1");
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
}

async function exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<TokenResponse> {
  const response = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri: redirectUri })
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; error_description?: string };
    throw new Error(`google_reauth=FAIL_${tokenExchangeFailureReason(response.status)} (${body.error ?? "ukjent"}: ${body.error_description ?? "ingen beskrivelse"})`);
  }
  return (await response.json()) as TokenResponse;
}

/** §7 i ordren: IKKE nok at exchange lyktes - en FAKTISK Drive-metadata-lesing med den nye access_token-en må også lykkes. */
async function verifyDriveAccess(accessToken: string): Promise<boolean> {
  const response = await fetch(GOOGLE_DRIVE_ROOT_METADATA_ENDPOINT, { headers: { authorization: `Bearer ${accessToken}` } });
  return response.ok;
}

/** §6-fallback: LIVE re-verifisering av en EKSISTERENDE refresh_token sin FAKTISKE nåværende scope - aldri en antakelse om Google sin interne inkrementell-auth-oppførsel. */
async function liveVerifyExistingRefreshTokenScope(clientId: string, clientSecret: string, existingRefreshToken: string): Promise<boolean> {
  try {
    const response = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: existingRefreshToken })
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { access_token: string };
    const infoResponse = await fetch(`${GOOGLE_OAUTH_TOKENINFO_ENDPOINT}?access_token=${encodeURIComponent(body.access_token)}`);
    if (!infoResponse.ok) return false;
    const info = (await infoResponse.json()) as { scope?: string };
    return hasAllRequiredScopes(info.scope ?? "", REQUIRED_REAUTH_SCOPES);
  } catch {
    return false;
  }
}

/** §8 i ordren: kun en TRYGG, minimal identitetsverdi (e-post) - aldri ytterligere profildata. */
async function detectAccountEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${GOOGLE_USERINFO_ENDPOINT}?fields=email`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { email?: string };
    return body.email;
  } catch {
    return undefined;
  }
}

async function confirmAccountMismatch(detectedMasked: string, configuredMasked: string): Promise<boolean> {
  log(`ADVARSEL: Google-kontoen du nettopp autoriserte samsvarer IKKE med den konfigurerte JARVIS_GOOGLE_ACCOUNT.`);
  log(formatAccountMismatchReport(configuredMasked, detectedMasked));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Skriv nøyaktig "YES" for å fortsette med DENNE kontoen likevel, eller trykk Ctrl+C for å avbryte: ');
    return answer.trim() === "YES";
  } finally {
    rl.close();
  }
}

function chainToP1aHostRun(): void {
  log("reautorisering fullført - kjører UA-2 P1A host-akseptanse (ua2-p1a-host-run.ts) automatisk...");
  execFileSync("node", ["--experimental-transform-types", "modules/core/scripts/ua2-p1a-host-run.ts"], { stdio: "inherit", cwd: repoRoot });
}

async function main(): Promise<void> {
  const { lines, values } = readEnv();
  const clientId = values["JARVIS_GOOGLE_CLIENT_ID"];
  const clientSecret = values["JARVIS_GOOGLE_CLIENT_SECRET"];
  validateClientCredentials(clientId, clientSecret);
  const existingRefreshToken = values["JARVIS_GOOGLE_TOKEN"] || undefined;
  const configuredAccount = values["JARVIS_GOOGLE_ACCOUNT"] || undefined;
  const port = values["JARVIS_GOOGLE_REAUTH_PORT"] ? Number(values["JARVIS_GOOGLE_REAUTH_PORT"]) : DEFAULT_REAUTH_PORT;
  const redirectUri = buildRedirectUri(port);
  const state = randomBytes(24).toString("hex");

  log(
    `redirect_uri=${redirectUri} (hvis Google viser "redirect_uri_mismatch": denne OAuth-klienten er registrert som ` +
      `"Web application"-type og krever en EKSAKT forhåndsregistrert redirect-URI - legg til nøyaktig denne URI-en i ` +
      `Google Cloud Console, eller sett JARVIS_GOOGLE_REAUTH_PORT i .env til en allerede registrert port og kjør på ` +
      `nytt. Er klienten "Desktop app"-type fungerer loopback-porten uten forhåndsregistrering - ingen gjetning gjort ` +
      `her, Google selv viser feilen eksplisitt hvis antakelsen ikke stemmer for din klient.)`
  );
  const authUrl = buildAuthorizationUrl({ clientId, redirectUri, scopes: REQUIRED_REAUTH_SCOPES, state, loginHint: configuredAccount });
  // §4 i host-fix-ordren: pre-flight - parse den GENERERTE URL-en tilbake og
  // krev eksplisitt response_type=code + client_id/redirect_uri/state + full
  // Drive-scope FØR nettleseren i det hele tatt åpnes. Kaster (server/
  // nettleser startes ALDRI) hvis noe mangler - fail-closed sikkerhetsnett.
  validateAuthorizationUrl(authUrl, REQUIRED_REAUTH_SCOPES);
  const callbackPromise = waitForCallback(port, state);
  openBrowser(authUrl);
  log(`venter på autorisasjon i nettleseren (maks 5 minutter)... hvis den ikke åpnet automatisk, gå til:\n${authUrl}`);

  const callback = await callbackPromise;
  if (callback.error) {
    throw new Error(`google_reauth=FAIL_${callback.error}: Google-samtykket ble avvist eller feilet i nettleseren.`);
  }
  if (!isValidCallbackState(callback.state, state)) {
    throw new Error(
      "google_reauth=FAIL_STATE_MISMATCH: callback-staten samsvarte ikke med det denne kjøringen selv genererte " +
        "(mulig CSRF/gammel fane) - INGEN token-exchange forsøkt."
    );
  }
  if (!callback.code) {
    throw new Error("google_reauth=FAIL_NO_CODE: ingen autorisasjonskode mottatt fra Google.");
  }

  log("autorisasjonskode mottatt - bytter den mot access/refresh-token...");
  const exchange = await exchangeCode(clientId as string, clientSecret as string, callback.code, redirectUri);

  const grantedScope = exchange.scope ?? "";
  if (!hasAllRequiredScopes(grantedScope, REQUIRED_REAUTH_SCOPES)) {
    const grantedSet = new Set(grantedScope.split(/\s+/).filter(Boolean));
    const missing = REQUIRED_REAUTH_SCOPES.filter((scope) => !grantedSet.has(scope));
    throw new Error(
      `google_reauth=FAIL_INSUFFICIENT_SCOPE: Google returnerte ikke alle påkrevde scopes (mangler: ${missing.join(", ")}). .env er IKKE endret.`
    );
  }
  const driveOk = await verifyDriveAccess(exchange.access_token);
  if (!driveOk) {
    throw new Error(
      "google_reauth=FAIL_DRIVE_PROBE: scope-strengen så riktig ut, men en faktisk Drive-metadata-lesing feilet likevel. .env er IKKE endret."
    );
  }
  log("google_drive_full_scope=PASS (scope-streng + en faktisk Drive-lesing begge bekreftet)");

  let verifiedExistingFullScope = false;
  if (!exchange.refresh_token && existingRefreshToken) {
    verifiedExistingFullScope = await liveVerifyExistingRefreshTokenScope(clientId as string, clientSecret as string, existingRefreshToken);
  }
  const decision = decideRefreshToken({ refreshToken: exchange.refresh_token }, existingRefreshToken, verifiedExistingFullScope);
  if (decision.action === "fail") {
    throw new Error(`google_reauth=FAIL: ${decision.reason} .env er IKKE endret.`);
  }

  const detectedEmail = await detectAccountEmail(exchange.access_token);
  const consistency = classifyAccountConsistency(detectedEmail, configuredAccount);
  if (consistency === "mismatch") {
    const confirmed = await confirmAccountMismatch(maskEmail(detectedEmail as string), maskEmail(configuredAccount as string));
    if (!confirmed) {
      throw new Error("google_reauth=FAIL_ACCOUNT_MISMATCH_NOT_CONFIRMED: bekreftelse ikke gitt - .env er IKKE endret.");
    }
    log("konto-mismatch eksplisitt bekreftet av Tobias - fortsetter.");
  } else if (consistency === "match") {
    log(`google-konto bekreftet: ${maskEmail(detectedEmail as string)} samsvarer med konfigurert JARVIS_GOOGLE_ACCOUNT.`);
  } else if (consistency === "undetermined") {
    log("ADVARSEL: kunne ikke bestemme Google-kontoens identitet for sammenligning - fortsetter uten kontosjekk (Drive/Calendar-scope er likevel live-bevist over).");
  } else {
    log(`google-konto (ingen JARVIS_GOOGLE_ACCOUNT konfigurert fra før å sammenligne mot): ${detectedEmail ? maskEmail(detectedEmail) : "ukjent"}`);
  }

  const updates: EnvValues = { JARVIS_GOOGLE_TOKEN: decision.refreshToken };
  const nextLines = buildUpdatedEnvLines(lines, updates);
  const nextContent = nextLines.join("\n");
  if (nextContent === lines.join("\n")) {
    log("JARVIS_GOOGLE_TOKEN er allerede korrekt (idempotent no-op) - .env ikke endret.");
  } else {
    // Sikkerhetskopi FØR endring, deretter atomisk skriv (tmp-fil + rename) -
    // samme mønster som fix-q21-runtime-role.ts (§5/§J/§K/§O i ordren).
    const backupPath = `${envPath}.bak.${Date.now()}`;
    copyFileSync(envPath, backupPath);
    log(`sikkerhetskopi skrevet: ${backupPath}`);
    const tmpPath = `${envPath}.tmp.${Date.now()}`;
    writeFileSync(tmpPath, nextContent);
    renameSync(tmpPath, envPath);
    log("JARVIS_GOOGLE_TOKEN oppdatert i .env (kun denne ene linjen endret, alt annet urørt).");
  }

  log("google_drive_reauth=PASS");
  chainToP1aHostRun();
}

main().catch((err: unknown) => {
  console.error(`[google-drive-reauth] FEILET: ${(err as Error).message}`);
  process.exit(1);
});
