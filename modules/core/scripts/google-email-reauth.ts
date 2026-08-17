// UA-2 P1B-A HOST FIX #1 (2026-08-16, host-funn run_id `3af67dab`): host-
// kjøringen feilet med `p1b_gmail_list_messages_live=FAIL
// reason=tool_failed:google_auth_failed_401` - `JARVIS_EMAIL_TOKEN` kunne
// ikke veksles til et access-token. Dette scriptet reautoriserer KUN Gmail
// (`JARVIS_EMAIL_TOKEN`) - gjenbruker den ALLEREDE PERSISTERTE, host-bevist-
// fungerende Google Desktop-OAuth-klienten (`JARVIS_GOOGLE_CLIENT_ID`/
// `_SECRET`, se D-41/D-42-lukkingen av `google-drive-reauth.ts`) - INGEN ny
// Google Cloud-klient, INGEN ny JSON-nedlasting, INGEN Drive-reauth, og
// `JARVIS_GOOGLE_TOKEN`/`_CLIENT_ID`/`_SECRET`/`_OAUTH_CLIENT_TYPE` (Drive/
// Calendar sine credentials) forblir HELT URØRT.
//
// Kjøres PÅ HOSTEN (Windows), fra repo-roten - ÉN kommando:
//
//   node --experimental-transform-types modules/core/scripts/google-email-reauth.ts
//
// (`modules/knowledge/scripts/ua2-p1b-a-host-run.ts` kaller dette scriptet
// AUTOMATISK som et under-steg når Gmail-autentiseringen klassifiseres som
// gjenopprettbar - se dens egen toppkommentar. Kan også kjøres frittstående.)
//
// Samme trygge loopback-arkitektur (RFC 8252) som Drive-reauth: en lokal
// `http://127.0.0.1:<port>/oauth2callback`-server, `prompt=consent
// select_account` (ALLTID kontovelger + fersk refresh_token), CSRF-state,
// pre-flight URL-validering. Forskjellen fra Drive-reauth: INGEN Desktop-
// klient-oppdagelse/-import (den finnes allerede - se §1.A under, feiler
// EKSPLISITT hvis den ikke gjør det, i stedet for å prøve å bygge en ny),
// EGET scope-sett (`REQUIRED_EMAIL_REAUTH_SCOPES` - gmail.readonly +
// gmail.send + userinfo.email, se lib-fila for full begrunnelse), og
// persisterer KUN `JARVIS_EMAIL_TOKEN` ved suksess.
//
// `.env` endres KUN ved FULL suksess (callback+state+scope+Gmail-live-probe+
// kontosjekk alle bestått) - sikkerhetskopi (`.env.bak.<epoch>`) FØR endring,
// atomisk skriving (tmp-fil + rename), samme mønster som
// `google-drive-reauth.ts`/`fix-q21-runtime-role.ts`. Skriver ALDRI
// client_secret/access_token/refresh_token/authorization_code til
// stdout/stderr.

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_EMAIL_REAUTH_PORT,
  GOOGLE_ADMIN_API_CONTROLS_URL,
  GOOGLE_OAUTH_TOKEN_ENDPOINT,
  OAUTH_CALLBACK_PATH,
  REQUIRED_EMAIL_REAUTH_SCOPES,
  buildAuthorizationUrl,
  buildRedirectUri,
  classifyAccountConsistency,
  classifyDriveProbeError,
  deriveProjectNumberFromClientId,
  formatAccountMismatchReport,
  formatDriveProbeReport,
  hasAllRequiredScopes,
  isRecoverableDriveProbeBlocker,
  isValidCallbackState,
  maskEmail,
  parseCallbackQuery,
  tokenExchangeFailureReason,
  validateAuthorizationUrl,
  type CallbackResult,
  type DriveProbeErrorDetails
} from "./lib/google-drive-reauth-lib.ts";
import { buildUpdatedEnvLines, parseEnvValues, type EnvValues } from "./lib/q21-env-recovery.ts";

const repoRoot = process.cwd();
const envPath = join(repoRoot, ".env");
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const PROBE_RETRY_TIMEOUT_MS = 5 * 60_000;
const PROBE_RETRY_INTERVAL_MS = 5000;
const GMAIL_PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/** Samme URL-mønster som buildDriveApiEnableUrl() i lib-fila (Google sin stabile Cloud Console-"enable API"-sti), for gmail.googleapis.com i stedet for drive.googleapis.com. */
function buildGmailApiEnableUrl(projectNumber: string | undefined): string {
  const base = "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview";
  return projectNumber ? `${base}?project=${projectNumber}` : base;
}

function log(msg: string): void {
  console.log(`[google-email-reauth] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnv(): { lines: string[]; values: EnvValues } {
  if (!existsSync(envPath)) {
    throw new Error(`.env ikke funnet: ${envPath} - kjør fra repo-roten.`);
  }
  const content = readFileSync(envPath, "utf8");
  return { lines: content.split("\n"), values: parseEnvValues(content) };
}

/** Identisk Windows-fiks (rundll32, ingen cmd.exe/shell) som google-drive-reauth.ts - samme root cause-forsvar mot URL-korrumpering. */
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

const CALLBACK_HTML_OK = "<html><body><h3>Jarvis: Gmail-autorisasjon mottatt.</h3><p>Du kan lukke denne fanen og gå tilbake til terminalen.</p></body></html>";
const CALLBACK_HTML_ERR = "<html><body><h3>Jarvis: Gmail-autorisasjon feilet.</h3><p>Gå tilbake til terminalen for detaljer.</p></body></html>";

async function waitForCallback(port: number, expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const parsed = parseCallbackQuery(req.url ?? "");
      const ok = !parsed.error && isValidCallbackState(parsed.state, expectedState) && Boolean(parsed.code);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ok ? CALLBACK_HTML_OK : CALLBACK_HTML_ERR);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(parsed);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      resolve({ error: "TIMEOUT" });
    }, CALLBACK_TIMEOUT_MS);
    server.on("error", (err) => {
      if (settled) return;
      settled = true;
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
}

/** Identisk mønster som google-drive-reauth.ts sin exchangeCode() - Google sin egen error/error_description tas med RÅTT i feilmeldingen (aldri en secret - Google ekko-er aldri token/client_secret tilbake i en feilrespons). */
async function exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<TokenResponse> {
  const response = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri: redirectUri })
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; error_description?: string };
    throw new Error(`google_email_reauth=FAIL_${tokenExchangeFailureReason(response.status)} (${body.error ?? "ukjent"}: ${body.error_description ?? "ingen beskrivelse"})`);
  }
  return (await response.json()) as TokenResponse;
}

type GmailProbeResult = { ok: true; emailAddress: string | undefined } | { ok: false; details: DriveProbeErrorDetails };

/** §11 i host-fix-ordren: IKKE nok at token-exchange lyktes - en FAKTISK Gmail-lesing (profile - billig, read-only) må også lykkes FØR noe persisteres. `emailAddress` gjenbrukes direkte til §6-kontosjekken (ingen egen userinfo-kall nødvendig). */
async function gmailProfileProbe(accessToken: string): Promise<GmailProbeResult> {
  const response = await fetch(GMAIL_PROFILE_ENDPOINT, { headers: { authorization: `Bearer ${accessToken}` } });
  if (response.ok) {
    const body = (await response.json()) as { emailAddress?: string };
    return { ok: true, emailAddress: body.emailAddress };
  }
  const rawBody = await response.text().catch(() => "");
  return { ok: false, details: classifyDriveProbeError(response.status, rawBody) };
}

/**
 * Lettere versjon av google-drive-reauth.ts sin `retryDriveProbeUntilRecovered()`
 * - samme klassifiserte gjenopprettbarhets-sjekk (`isRecoverableDriveProbeBlocker`)
 * og samme "åpne riktig side automatisk, prøv på nytt i SAMME prosess"-mønster,
 * men uten access-token-refresh-underveis-grenen (Gmail API er i praksis
 * ALLTID allerede aktivert i et prosjekt som allerede har fungerende Drive -
 * denne grenen er derfor et sjeldnere, men fortsatt trygt håndtert tilfelle).
 */
async function retryGmailProbeUntilRecovered(initial: DriveProbeErrorDetails, accessToken: string, clientId: string): Promise<{ emailAddress: string | undefined }> {
  if (!isRecoverableDriveProbeBlocker(initial.blocker)) {
    throw new Error(
      `google_email_reauth=FAIL_GMAIL_PROBE: ${formatDriveProbeReport(initial)} melding="${initial.safeMessage}". ` +
        "Denne blokkeringstypen kan IKKE løses automatisk - .env er IKKE endret."
    );
  }
  let recoveryUrl: string;
  let instruction: string;
  if (initial.blocker === "API_NOT_ENABLED") {
    recoveryUrl = initial.enableUrl ?? buildGmailApiEnableUrl(deriveProjectNumberFromClientId(clientId));
    instruction = "Trykk Enable for Gmail API, gå deretter tilbake hit.";
    log("gmail_api_enabled=FAIL gmail_blocker=API_NOT_ENABLED - åpner Cloud Console-siden for Gmail API automatisk.");
  } else {
    recoveryUrl = GOOGLE_ADMIN_API_CONTROLS_URL;
    instruction = 'Finn "Jarvis Desktop" i listen over tredjeparts-apper og gi den eksplisitt tillit for Gmail-scopet, gå deretter tilbake hit.';
    log("gmail_blocker=WORKSPACE_ADMIN_POLICY - åpner Google Admin Console sin API Controls-side automatisk.");
  }
  openBrowser(recoveryUrl);
  log(instruction);
  log(`venter i denne SAMME prosessen - prøver Gmail-probe på nytt hvert ${Math.round(PROBE_RETRY_INTERVAL_MS / 1000)}. sekund i opptil ${Math.round(PROBE_RETRY_TIMEOUT_MS / 60_000)} minutter...`);
  const deadlineMs = Date.now() + PROBE_RETRY_TIMEOUT_MS;
  let lastDetails = initial;
  while (Date.now() < deadlineMs) {
    await sleep(PROBE_RETRY_INTERVAL_MS);
    const probe = await gmailProfileProbe(accessToken);
    if (probe.ok) {
      log("gmail_api_enabled=PASS (samme-prosess-retry lyktes)");
      return { emailAddress: probe.emailAddress };
    }
    lastDetails = probe.details;
  }
  throw new Error(`google_email_reauth=FAIL_GMAIL_PROBE_TIMEOUT: fortsatt blokkert (${formatDriveProbeReport(lastDetails)}) etter ${Math.round(PROBE_RETRY_TIMEOUT_MS / 60_000)} minutter. .env er IKKE endret.`);
}

async function confirmAccountMismatch(detectedMasked: string, configuredMasked: string): Promise<boolean> {
  log("ADVARSEL: Google-kontoen du nettopp autoriserte for Gmail samsvarer IKKE med den konfigurerte JARVIS_GOOGLE_ACCOUNT.");
  log(formatAccountMismatchReport(configuredMasked, detectedMasked));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Skriv nøyaktig "YES" for å fortsette med DENNE kontoen likevel, eller trykk Ctrl+C for å avbryte: ');
    return answer.trim() === "YES";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { lines, values } = readEnv();

  // §1.A i ordren: den Desktop-OAuth-klienten som Drive-reauth allerede har
  // bevist (JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop) er en PÅKREVD
  // forutsetning - dette scriptet oppretter/importerer ALDRI en ny klient
  // selv (§4 i ordren: "No new Google Cloud client. No new JSON download.").
  const clientId = values["JARVIS_GOOGLE_CLIENT_ID"];
  const clientSecret = values["JARVIS_GOOGLE_CLIENT_SECRET"];
  const clientType = values["JARVIS_GOOGLE_OAUTH_CLIENT_TYPE"];
  if (!clientId || !clientSecret || clientType !== "desktop") {
    throw new Error(
      "google_email_reauth=FAIL_NO_PROVEN_DESKTOP_CLIENT: JARVIS_GOOGLE_CLIENT_ID/_SECRET + " +
        'JARVIS_GOOGLE_OAUTH_CLIENT_TYPE="desktop" må allerede finnes i .env (persistert av en tidligere ' +
        "vellykket google-drive-reauth.ts-kjøring) - dette scriptet oppretter ALDRI en ny OAuth-klient selv. " +
        "Kjør google-drive-reauth.ts først hvis Desktop-klienten ikke er satt opp ennå. .env er IKKE endret."
    );
  }

  const configuredAccount = values["JARVIS_GOOGLE_ACCOUNT"] || undefined;
  const port = values["JARVIS_GOOGLE_EMAIL_REAUTH_PORT"] ? Number(values["JARVIS_GOOGLE_EMAIL_REAUTH_PORT"]) : DEFAULT_EMAIL_REAUTH_PORT;
  const redirectUri = buildRedirectUri(port);

  const state = randomBytes(24).toString("hex");
  const authUrl = buildAuthorizationUrl({ clientId, redirectUri, scopes: REQUIRED_EMAIL_REAUTH_SCOPES, state, loginHint: configuredAccount });
  validateAuthorizationUrl(authUrl, REQUIRED_EMAIL_REAUTH_SCOPES);

  const callbackPromise = waitForCallback(port, state);
  openBrowser(authUrl);
  log(`venter på Gmail-autorisasjon i nettleseren (maks 5 minutter)... hvis den ikke åpnet automatisk, gå til:\n${authUrl}`);

  const callback = await callbackPromise;
  if (callback.error) {
    throw new Error(`google_email_reauth=FAIL_${callback.error}: Google-samtykket ble avvist eller feilet i nettleseren.`);
  }
  if (!isValidCallbackState(callback.state, state)) {
    throw new Error("google_email_reauth=FAIL_STATE_MISMATCH: callback-staten samsvarte ikke - INGEN token-exchange forsøkt.");
  }
  if (!callback.code) {
    throw new Error("google_email_reauth=FAIL_NO_CODE: ingen autorisasjonskode mottatt fra Google.");
  }

  log("autorisasjonskode mottatt - bytter den mot access/refresh-token...");
  const exchange = await exchangeCode(clientId, clientSecret, callback.code, redirectUri);

  const grantedScope = exchange.scope ?? "";
  if (!hasAllRequiredScopes(grantedScope, REQUIRED_EMAIL_REAUTH_SCOPES)) {
    const grantedSet = new Set(grantedScope.split(/\s+/).filter(Boolean));
    const missing = REQUIRED_EMAIL_REAUTH_SCOPES.filter((scope) => !grantedSet.has(scope));
    throw new Error(`google_email_reauth=FAIL_INSUFFICIENT_SCOPE: Google returnerte ikke alle påkrevde Gmail-scopes (mangler: ${missing.join(", ")}). .env er IKKE endret.`);
  }
  if (!exchange.refresh_token) {
    throw new Error(
      "google_email_reauth=FAIL_NO_REFRESH_TOKEN: token-responsen manglet refresh_token (uventet - prompt=consent " +
        "skal alltid tvinge en fersk en). .env er IKKE endret. Fjern Jarvis sin Gmail-tilgang på " +
        "https://myaccount.google.com/permissions og prøv igjen."
    );
  }

  let verifiedEmail: string | undefined;
  const probe = await gmailProfileProbe(exchange.access_token);
  if (probe.ok) {
    verifiedEmail = probe.emailAddress;
    log("gmail_live_read_probe=PASS (users/me/profile lyktes med det ferske access-tokenet)");
  } else {
    log(`google_email_reauth=FAIL_GMAIL_PROBE ${formatDriveProbeReport(probe.details)}`);
    const recovered = await retryGmailProbeUntilRecovered(probe.details, exchange.access_token, clientId);
    verifiedEmail = recovered.emailAddress;
  }

  const consistency = classifyAccountConsistency(verifiedEmail, configuredAccount);
  if (consistency === "mismatch") {
    const confirmed = await confirmAccountMismatch(maskEmail(verifiedEmail as string), maskEmail(configuredAccount as string));
    if (!confirmed) {
      throw new Error("google_email_reauth=FAIL_ACCOUNT_MISMATCH_NOT_CONFIRMED: bekreftelse ikke gitt - .env er IKKE endret.");
    }
    log("konto-mismatch eksplisitt bekreftet av Tobias - fortsetter.");
  } else if (consistency === "match") {
    log(`Gmail-konto bekreftet: ${maskEmail(verifiedEmail as string)} samsvarer med konfigurert JARVIS_GOOGLE_ACCOUNT.`);
  } else if (consistency === "undetermined") {
    log("ADVARSEL: kunne ikke bestemme Gmail-kontoens identitet for sammenligning - fortsetter uten kontosjekk (scope er likevel live-bevist over).");
  } else {
    log(`Gmail-konto (ingen JARVIS_GOOGLE_ACCOUNT konfigurert fra før å sammenligne mot): ${verifiedEmail ? maskEmail(verifiedEmail) : "ukjent"}`);
  }

  // §7 i ordren: KUN JARVIS_EMAIL_TOKEN - JARVIS_GOOGLE_CLIENT_ID/_SECRET/
  // _TOKEN/_OAUTH_CLIENT_TYPE (Drive/Calendar sine credentials) er HELT
  // urørt i denne oppdateringen.
  const updates: EnvValues = { JARVIS_EMAIL_TOKEN: exchange.refresh_token };
  const nextLines = buildUpdatedEnvLines(lines, updates);
  const nextContent = nextLines.join("\n");
  if (nextContent === lines.join("\n")) {
    log("JARVIS_EMAIL_TOKEN er allerede korrekt (idempotent no-op) - .env ikke endret.");
  } else {
    const backupPath = `${envPath}.bak.${Date.now()}`;
    copyFileSync(envPath, backupPath);
    log(`sikkerhetskopi skrevet: ${backupPath}`);
    const tmpPath = `${envPath}.tmp.${Date.now()}`;
    writeFileSync(tmpPath, nextContent);
    renameSync(tmpPath, envPath);
    log("JARVIS_EMAIL_TOKEN oppdatert i .env (KUN denne linjen - JARVIS_GOOGLE_CLIENT_ID/_SECRET/_TOKEN/_OAUTH_CLIENT_TYPE urørt).");
  }

  log("google_email_reauth=PASS");
}

main().catch((err: unknown) => {
  console.error(`[google-email-reauth] FEILET: ${(err as Error).message}`);
  process.exit(1);
});
