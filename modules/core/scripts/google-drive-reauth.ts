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
// skriver atomisk (tmp-fil + rename), rører NORMALT KUN `JARVIS_GOOGLE_
// TOKEN`-linjen - alle andre linjer/kommentarer/variabler er urørt. (Er
// `JARVIS_GOOGLE_CLIENT_SECRET_JSON` konfigurert - se HOST FIX #2 under -
// skrives `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN` SAMMEN i den ene
// atomiske skrivingen, aldri et blandet/inkoherent sett.) Skriver ALDRI
// client_secret/access_token/refresh_token/authorization_code til
// stdout/stderr eller noe prosessargument (kun i HTTP-body/headers mot
// Google sine egne endepunkt). `.env` endres KUN ved full suksess - enhver
// feilbane returnerer/kaster FØR skrivingen, slik at den eksisterende
// (fungerende, om enn scope-begrensede) credentialen alltid forblir
// gjenopprettbar. Ved suksess kjøres `ua2-p1a-host-run.ts` AUTOMATISK til
// slutt - ingen andre kommando nødvendig fra Tobias.
//
// HOST FIX #2 (2026-08-16, Tobias sitt faktiske host-funn): den forrige
// fiksen løste URL-korrumperingen (§6), men Google svarte deretter med
// "Error 400: redirect_uri_mismatch" - Tobias sin EKSISTERENDE OAuth-klient
// er etter alt å dømme registrert som "Web application"-type (som krever en
// EKSAKT forhåndsregistrert redirect-URI), ikke "Desktop app" (som godtar
// loopback-porter uten forhåndsregistrering - det Google-anbefalte,
// PERMANENTE designet for akkurat Jarvis sin lokale, interaktive
// eier-reauth-flyt). Google validerer redirect_uri FØR noe annet og sender
// ALDRI noen callback tilbake ved mismatch - denne prosessen kan derfor
// IKKE oppdage feilen selv. Det finnes INGEN offentlig Google-API for å
// opprette en OAuth-klient programmatisk (kun Cloud Console-UI) - ETT
// manuelt steg er derfor uunngåelig: opprett én "Desktop app"-klient i
// Cloud Console og trykk "Download JSON" (se HOST FIX #3 under for HVORDAN
// scriptet oppdager DEN nedlastede fila helt av seg selv).
//
// HOST FIX #3 "ZERO MANUAL ENV EDITING" (2026-08-16): Tobias skal IKKE
// måtte gjøre NOE MER enn selve Cloud Console-handlingen over - ALDRI
// redigere .env, kopiere client_id/client_secret, eller lime inn en
// filsti. Den SAMME kjørende prosessen `attemptOAuth()` starter det
// opprinnelige forsøket OG (parallelt, i bakgrunn) en `watchForDesktop
// ClientDownload()`-polling av Tobias sin Nedlastinger-mappe
// (`os.homedir()/Downloads` - den dokumenterte standardplasseringen).
// Racet (`Promise.race`) mellom disse to avgjør veien videre: kommer
// callback-en FØRST (normalflyt, klienten var allerede riktig type),
// fortsetter alt som før - Tobias ser ALDRI noen ekstra fane
// (veiledningen/Cloud Console-siden vises FØRST etter `GUIDANCE_GRACE_MS`,
// 25s - god margin for en vanlig kontovalg+samtykke-interaksjon). Finner
// watcheren en NY, gyldig Desktop-klient-JSON FØRST (Tobias fulgte
// veiledningen), avbrytes det opprinnelige callback-forsøket EKSPLISITT
// (frigjør porten) og et FRISK OAuth-forsøk starter AUTOMATISK med den nye
// klienten - i SAMME prosess, INGEN restart. Flere gyldige kandidatfiler
// samtidig avgjøres ALDRI stille - Tobias velger eksplisitt via en trygg,
// KUN-filnavn nummerert liste. `JARVIS_GOOGLE_CLIENT_SECRET_JSON` (HOST FIX
// #2) forblir støttet for et avansert/manuelt oppsett, men er IKKE lenger
// nødvendig for normalflyten, og persisteres ALDRI selv - kun et
// engangs-import-artefakt. Ved suksess (uansett hvilket forsøk som vant)
// skrives et koherent `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN`-sett til
// de VANLIGE .env-nøklene i ÉN atomisk skriving.

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
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
  buildCredentialsConsoleUrl,
  buildRedirectUri,
  classifyAccountConsistency,
  classifyDiscoveryResult,
  decideRefreshToken,
  deriveProjectNumberFromClientId,
  formatAccountMismatchReport,
  formatCandidateSelectionPrompt,
  hasAllRequiredScopes,
  isValidCallbackState,
  maskEmail,
  parseCallbackQuery,
  parseCandidateSelection,
  parseClientSecretJson,
  selectNewCandidateJsonFiles,
  tokenExchangeFailureReason,
  validateAuthorizationUrl,
  validateClientCredentials,
  type CallbackResult,
  type DownloadCandidateFile
} from "./lib/google-drive-reauth-lib.ts";
import { buildUpdatedEnvLines, parseEnvValues, type EnvValues } from "./lib/q21-env-recovery.ts";

const repoRoot = process.cwd();
const envPath = join(repoRoot, ".env");
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
// HOST FIX #3 "ZERO MANUAL ENV EDITING" (2026-08-16): hvor lenge scriptet
// venter STILLE (ingen ekstra fane, ingen ekstra logg) FØR det viser
// gjenopprettings-veiledningen og åpner Cloud Console-siden automatisk. En
// NORMALT fungerende autorisasjon (riktig klienttype fra før) skal ALDRI
// se noe ekstra - 25s er god margin for en vanlig menneskelig
// kontovalg+samtykke-interaksjon (typisk et titalls sekunder), men KORT nok
// til at Tobias raskt får hjelp hvis Google viste en feilside umiddelbart.
const GUIDANCE_GRACE_MS = 25_000;
const DOWNLOADS_POLL_INTERVAL_MS = 2000;

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

interface CancellableCallback {
  result: Promise<CallbackResult>;
  /** HOST FIX #3: lukker den lokale serveren FØR den naturlige timeouten - trengs når et NYTT Desktop-klient-funn (Nedlastinger-watcheren) vinner racet og en FRISK OAuth-forsøk på SAMME port skal starte umiddelbart (porten må frigjøres først, ellers EADDRINUSE). Resolver ALDRI callback-en som en feil ved kanselering - `main()` bruker DENNE signaturen kun for portoppryddingen, aldri for callback-verdien. */
  cancel: () => void;
}

/** §4/§D/§E i ordren (uendret): én midlertidig loopback-server, venter på ÉN callback-request på OAUTH_CALLBACK_PATH, lukker seg selv deretter (uansett utfall). HOST FIX #3: nå kansellerbar UTENFRA (se `cancel`) - trengs for å racet mot Nedlastinger-watcheren uten å låse porten. */
function waitForCallback(port: number, expectedState: string): CancellableCallback {
  let settled = false;
  let finish: ((value: CallbackResult) => void) | undefined;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const parsed = parseCallbackQuery(req.url ?? "");
      const ok = !parsed.error && isValidCallbackState(parsed.state, expectedState) && Boolean(parsed.code);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ok ? CALLBACK_HTML_OK : CALLBACK_HTML_ERR);
      finish?.(parsed);
    });
    const timer = setTimeout(() => finish?.({ error: "TIMEOUT" }), CALLBACK_TIMEOUT_MS);
    finish = (value: CallbackResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(value);
    };
    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    server.listen(port, "127.0.0.1");
  });
  return { result, cancel: () => finish?.({ error: "CANCELLED" }) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lister KUN vanlige filer (ingen mapper/symlinker forsøkt fulgt) - en manglende/uleselig Nedlastinger-mappe gir ALDRI en krasj, kun en tom kandidatliste (pollingen fortsetter uansett). */
function listDownloadsJsonCandidates(downloadsDir: string): DownloadCandidateFile[] {
  if (!existsSync(downloadsDir)) return [];
  const files: DownloadCandidateFile[] = [];
  for (const entry of readdirSync(downloadsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const fullPath = join(downloadsDir, entry.name);
    try {
      files.push({ name: entry.name, path: fullPath, mtimeMs: statSync(fullPath).mtimeMs });
    } catch {
      // Fila kan ha blitt slettet/flyttet mellom listing og stat (nettleseren skriver ofte en .crdownload/.tmp FØR den fullfører) - hopp over, ikke krasj hele pollingen.
    }
  }
  return files;
}

/** §1 i ordren: leser+validerer ÉN kandidatfil - en "web"-type/ugyldig JSON EKSKLUDERES STILLE (Nedlastinger kan inneholde mange urelaterte JSON-filer) - ALDRI en krasj av hele polling-løkka. */
function tryReadValidDesktopClient(candidate: DownloadCandidateFile): { clientId: string; clientSecret: string } | undefined {
  try {
    return parseClientSecretJson(readFileSync(candidate.path, "utf8"));
  } catch {
    return undefined;
  }
}

/** §4 i ordren: trygg, KUN-filnavn nummerert velger - vises/spørres KUN når §G-tilfellet (flere gyldige kandidater samtidig) faktisk inntreffer. */
async function promptForCandidateSelection(candidates: DownloadCandidateFile[]): Promise<string | undefined> {
  log(
    `Fant FLERE nye Desktop-OAuth-klient-JSON-filer i Nedlastinger samtidig - velg hvilken som er "Jarvis Desktop":\n` +
      formatCandidateSelectionPrompt(candidates.map((c) => c.name))
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Skriv nummeret for riktig fil (eller trykk Enter for å fortsette å vente på flere nedlastinger): ");
    const index = parseCandidateSelection(answer, candidates.length);
    return index === undefined ? undefined : candidates[index]?.path;
  } finally {
    rl.close();
  }
}

interface DesktopClientDownloadFound {
  clientId: string;
  clientSecret: string;
  sourcePath: string;
}

interface CancellableWatch {
  result: Promise<DesktopClientDownloadFound | undefined>;
  cancel: () => void;
}

/**
 * §2/§3/§9 i "ZERO MANUAL ENV EDITING"-ordren: den SAMME kjørende prosessen
 * fortsetter automatisk - ALDRI en restart. Poller Nedlastinger-mappa for
 * en NY, gyldig Desktop-OAuth-klient-JSON (§B/§C: KUN filer fra og med
 * DENNE kjøringens eget starttidspunkt, se `selectNewCandidateJsonFiles()`
 * i lib). Veiledningen/Cloud Console-fanen vises FØRST etter
 * `GUIDANCE_GRACE_MS` (§ikke umiddelbart - en normalt fungerende
 * autorisasjon skal ALDRI se noe ekstra). Flere gyldige kandidater samtidig
 * (§4/§G) -> eksplisitt, trygg fil-navn-velger - ALDRI en stille gjetning.
 */
function watchForDesktopClientDownload(downloadsDir: string, sinceMs: number, onGuidanceDue: () => void): CancellableWatch {
  let cancelled = false;
  const guidanceTimer = setTimeout(onGuidanceDue, GUIDANCE_GRACE_MS);

  const result = (async (): Promise<DesktopClientDownloadFound | undefined> => {
    const deadlineMs = Date.now() + CALLBACK_TIMEOUT_MS;
    try {
      while (!cancelled && Date.now() < deadlineMs) {
        const recent = selectNewCandidateJsonFiles(listDownloadsJsonCandidates(downloadsDir), sinceMs);
        const valid: Array<DownloadCandidateFile & { clientId: string; clientSecret: string }> = [];
        for (const candidate of recent) {
          const parsed = tryReadValidDesktopClient(candidate);
          if (parsed) valid.push({ ...candidate, ...parsed });
        }
        const classification = classifyDiscoveryResult(valid);
        if (classification.kind === "single") {
          const winner = valid.find((v) => v.path === classification.candidate.path);
          if (winner) return { clientId: winner.clientId, clientSecret: winner.clientSecret, sourcePath: winner.path };
        } else if (classification.kind === "multiple") {
          clearTimeout(guidanceTimer);
          onGuidanceDue();
          const chosenPath = await promptForCandidateSelection(classification.candidates);
          const winner = chosenPath ? valid.find((v) => v.path === chosenPath) : undefined;
          if (winner) return { clientId: winner.clientId, clientSecret: winner.clientSecret, sourcePath: winner.path };
        }
        if (!cancelled) await sleep(DOWNLOADS_POLL_INTERVAL_MS);
      }
      return undefined;
    } finally {
      clearTimeout(guidanceTimer);
    }
  })();

  return { result, cancel: () => { cancelled = true; } };
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

interface ResolvedOAuthClient {
  clientId: string;
  clientSecret: string;
  imported: boolean;
}

/**
 * §7 i "ZERO MANUAL ENV EDITING"-ordren: er `JARVIS_GOOGLE_CLIENT_SECRET_JSON`
 * satt i .env, brukes DEN filens "installed" (Desktop app)-credentials for
 * HELE flyten (fortsatt støttet for et avansert/manuelt oppsett - se HOST
 * FIX #2) - garanterer et KOHERENT par (begge fra SAMME nedlastede fil).
 * En "web"-type fil avvises EKSPLISITT FØR noe forsøkes. Er variabelen IKKE
 * satt (normalflyten): uendret oppførsel - de eksisterende `.env`-
 * credentials brukes som FØRSTE forsøk (§7: "allerede importert/konfigurert
 * -> hopp rett til OAuth"). Er DE ogSå en fungerende Desktop-klient (enten
 * fra starten, eller fordi en TIDLIGERE kjøring av DENNE auto-discovery-
 * flyten allerede persisterte en importert Desktop-klient hit), lykkes
 * OAuth-forsøket normalt uten at Nedlastinger-oppdagelsen noensinne
 * trengs.
 */
function resolveOAuthClient(values: EnvValues): ResolvedOAuthClient {
  const jsonPath = values["JARVIS_GOOGLE_CLIENT_SECRET_JSON"] || undefined;
  if (jsonPath) {
    if (!existsSync(jsonPath)) {
      throw new Error(
        `google_reauth=FAIL_CLIENT_SECRET_JSON_NOT_FOUND: JARVIS_GOOGLE_CLIENT_SECRET_JSON peker til "${jsonPath}", men fila finnes ikke. .env er IKKE endret.`
      );
    }
    const parsed = parseClientSecretJson(readFileSync(jsonPath, "utf8"));
    log(
      `bruker Desktop-OAuth-klient importert fra JARVIS_GOOGLE_CLIENT_SECRET_JSON (${jsonPath}, avansert/manuelt oppsett) - IKKE .env sin ` +
        `eksisterende JARVIS_GOOGLE_CLIENT_ID/_SECRET (disse to oppdateres til å samsvare med den importerte klienten ved suksess, ` +
        `sammen med JARVIS_GOOGLE_TOKEN, i ÉN atomisk skriving - aldri et blandet/inkoherent sett).`
    );
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret, imported: true };
  }
  const clientId = values["JARVIS_GOOGLE_CLIENT_ID"];
  const clientSecret = values["JARVIS_GOOGLE_CLIENT_SECRET"];
  validateClientCredentials(clientId, clientSecret);
  return { clientId, clientSecret: clientSecret as string, imported: false };
}

interface OAuthAttemptCallback {
  outcome: "callback";
  callback: CallbackResult;
  usedState: string;
}
interface OAuthAttemptNewClient {
  outcome: "new_client";
  found: DesktopClientDownloadFound;
}
type OAuthAttempt = OAuthAttemptCallback | OAuthAttemptNewClient;

/**
 * §2/§9 i ordren: ÉN autorisasjons-forsøk - bygger/validerer URL-en, åpner
 * nettleseren, og (kun når `watchForNewClient` er sann - dvs. IKKE for en
 * allerede importert/kjent Desktop-klient) racer callback-en mot
 * Nedlastinger-watcheren SAMTIDIG. Vinner Nedlastinger-watcheren (Tobias
 * opprettet+lastet ned en NY Desktop-klient mens denne ventet), avbrytes
 * DENNE callback-serveren EKSPLISITT (frigjør porten) FØR funksjonen
 * returnerer - `main()` kan da starte et FRISK forsøk på SAMME port
 * umiddelbart, i SAMME prosess, uten restart.
 */
async function attemptOAuth(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  port: number;
  state: string;
  loginHint: string | undefined;
  consoleUrl: string;
  watchForNewClient: boolean;
  downloadsDir: string;
  runStartMs: number;
}): Promise<OAuthAttempt> {
  const authUrl = buildAuthorizationUrl({
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    scopes: REQUIRED_REAUTH_SCOPES,
    state: params.state,
    loginHint: params.loginHint
  });
  // §4 i host-fix-ordren: pre-flight - parse den GENERERTE URL-en tilbake og
  // krev eksplisitt response_type=code + client_id/redirect_uri/state + full
  // Drive-scope FØR nettleseren i det hele tatt åpnes. Kaster (server/
  // nettleser startes ALDRI) hvis noe mangler - fail-closed sikkerhetsnett.
  validateAuthorizationUrl(authUrl, REQUIRED_REAUTH_SCOPES);
  const callbackAttempt = waitForCallback(params.port, params.state);
  openBrowser(authUrl);
  log(`venter på autorisasjon i nettleseren (maks 5 minutter)... hvis den ikke åpnet automatisk, gå til:\n${authUrl}`);

  if (!params.watchForNewClient) {
    return { outcome: "callback", callback: await callbackAttempt.result, usedState: params.state };
  }

  // HOST FIX #3 "ZERO MANUAL ENV EDITING": veiledningen/Cloud Console-fanen
  // vises FØRST etter GUIDANCE_GRACE_MS - en normalt fungerende
  // autorisasjon (klienten er allerede Desktop-type) skal ALDRI se en
  // unødvendig ekstra fane. Pollingen av Nedlastinger starter derimot
  // UMIDDELBART i bakgrunnen (stille) - en Tobias som allerede VET han
  // trenger en ny klient og oppretter den proaktivt blir plukket opp med
  // en gang, ingen venting på graceperioden.
  const watch = watchForDesktopClientDownload(params.downloadsDir, params.runStartMs, () => {
    log(
      `HOST FIX #3: ingen autorisasjon mottatt ennå. Ser du en Google-FEILSIDE ("redirect_uri_mismatch") i stedet for ` +
        `en "Jarvis: autorisasjon mottatt"-side: den eksisterende OAuth-klienten er trolig "Web application"-type - ` +
        `Google Cloud Console-siden er allerede åpnet i en egen fane: ${params.consoleUrl}\n` +
        `  1. "Create Credentials" > "OAuth client ID" > velg type "Desktop app", gi den et navn som "Jarvis Desktop"\n` +
        `  2. Trykk "DOWNLOAD JSON"\n` +
        `Det er DET - denne kjørende prosessen oppdager fila i Nedlastinger AUTOMATISK og fortsetter selv, ingen ` +
        `andre kommando, ingen .env-redigering, ingen fil-sti å lime inn.`
    );
    openBrowser(params.consoleUrl);
  });

  const winner = await Promise.race([
    callbackAttempt.result.then((callback) => ({ kind: "callback" as const, callback })),
    watch.result.then((found) => ({ kind: "watch" as const, found }))
  ]);

  if (winner.kind === "callback") {
    watch.cancel();
    return { outcome: "callback", callback: winner.callback, usedState: params.state };
  }
  if (winner.found) {
    // §2/§9 i ordren: EKSPLISITT avbrutt HER, FØR funksjonen returnerer -
    // porten MÅ være fri før main() kan starte et nytt attemptOAuth()-kall.
    callbackAttempt.cancel();
    return { outcome: "new_client", found: winner.found };
  }
  // Nedlastinger-watcherens egen (delte) deadline ble nådd UTEN funn - IKKE
  // avbryt callback-forsøket (det kan fortsatt fullføre et øyeblikk senere
  // hvis Tobias faktisk var midt i å samtykke) - bare vent videre på DET.
  return { outcome: "callback", callback: await callbackAttempt.result, usedState: params.state };
}

async function main(): Promise<void> {
  const runStartMs = Date.now();
  const { lines, values } = readEnv();
  let { clientId, clientSecret, imported: usingImportedClient } = resolveOAuthClient(values);
  const existingRefreshToken = values["JARVIS_GOOGLE_TOKEN"] || undefined;
  const configuredAccount = values["JARVIS_GOOGLE_ACCOUNT"] || undefined;
  const port = values["JARVIS_GOOGLE_REAUTH_PORT"] ? Number(values["JARVIS_GOOGLE_REAUTH_PORT"]) : DEFAULT_REAUTH_PORT;
  const redirectUri = buildRedirectUri(port);
  const downloadsDir = join(homedir(), "Downloads");

  let attempt = await attemptOAuth({
    clientId,
    clientSecret,
    redirectUri,
    port,
    state: randomBytes(24).toString("hex"),
    loginHint: configuredAccount,
    consoleUrl: buildCredentialsConsoleUrl(deriveProjectNumberFromClientId(clientId)),
    watchForNewClient: !usingImportedClient,
    downloadsDir,
    runStartMs
  });

  if (attempt.outcome === "new_client") {
    // §2/§9 i ordren: Tobias opprettet+lastet ned en NY Desktop-klient mens
    // det FØRSTE forsøket ventet - denne SAMME prosessen fortsetter
    // AUTOMATISK med den, ingen restart. Den forrige callback-serveren er
    // allerede lukket (attemptOAuth() avbrøt den FØR "new_client" ble
    // returnert) - porten er fri for et FRISK forsøk (ny state, samme
    // port). `watchForNewClient: false` denne gangen - vi har ALLEREDE en
    // Desktop-klient, ingen grunn til å polle Nedlastinger på nytt.
    log(`Desktop-OAuth-klient oppdaget automatisk fra Nedlastinger (${attempt.found.sourcePath}) - fortsetter AUTOMATISK med DENNE klienten.`);
    clientId = attempt.found.clientId;
    clientSecret = attempt.found.clientSecret;
    usingImportedClient = true;
    attempt = await attemptOAuth({
      clientId,
      clientSecret,
      redirectUri,
      port,
      state: randomBytes(24).toString("hex"),
      loginHint: configuredAccount,
      consoleUrl: buildCredentialsConsoleUrl(deriveProjectNumberFromClientId(clientId)),
      watchForNewClient: false,
      downloadsDir,
      runStartMs
    });
    if (attempt.outcome === "new_client") {
      throw new Error("google_reauth=FAIL_UNEXPECTED_STATE: watchForNewClient var deaktivert men fikk likevel 'new_client' tilbake - intern feil, rapporter dette.");
    }
  }

  const { callback, usedState } = attempt;
  if (callback.error) {
    throw new Error(`google_reauth=FAIL_${callback.error}: Google-samtykket ble avvist eller feilet i nettleseren.`);
  }
  if (!isValidCallbackState(callback.state, usedState)) {
    throw new Error(
      "google_reauth=FAIL_STATE_MISMATCH: callback-staten samsvarte ikke med det denne kjøringen selv genererte " +
        "(mulig CSRF/gammel fane) - INGEN token-exchange forsøkt."
    );
  }
  if (!callback.code) {
    throw new Error("google_reauth=FAIL_NO_CODE: ingen autorisasjonskode mottatt fra Google.");
  }

  log("autorisasjonskode mottatt - bytter den mot access/refresh-token...");
  const exchange = await exchangeCode(clientId, clientSecret, callback.code, redirectUri);

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
    verifiedExistingFullScope = await liveVerifyExistingRefreshTokenScope(clientId, clientSecret, existingRefreshToken);
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

  // §4 i host-fix #2-ordren: brukes en IMPORTERT Desktop-klient, skrives
  // client_id/client_secret/token SAMMEN i ÉN atomisk skriving - aldri kun
  // token alene mot en client_id/_secret som IKKE lenger samsvarer (ville
  // vært et inkoherent sett, og enhver FREMTIDIG kjøring av dette
  // scriptet ville da lest en client_id/_secret-kombinasjon Google aldri
  // faktisk utstedte det nye token-et mot).
  const updates: EnvValues = usingImportedClient
    ? { JARVIS_GOOGLE_CLIENT_ID: clientId, JARVIS_GOOGLE_CLIENT_SECRET: clientSecret, JARVIS_GOOGLE_TOKEN: decision.refreshToken }
    : { JARVIS_GOOGLE_TOKEN: decision.refreshToken };
  const nextLines = buildUpdatedEnvLines(lines, updates);
  const nextContent = nextLines.join("\n");
  if (nextContent === lines.join("\n")) {
    log("JARVIS_GOOGLE_TOKEN (og evt. importert client_id/_secret) er allerede korrekt (idempotent no-op) - .env ikke endret.");
  } else {
    // Sikkerhetskopi FØR endring, deretter atomisk skriv (tmp-fil + rename) -
    // samme mønster som fix-q21-runtime-role.ts (§5/§J/§K/§O i ordren).
    const backupPath = `${envPath}.bak.${Date.now()}`;
    copyFileSync(envPath, backupPath);
    log(`sikkerhetskopi skrevet: ${backupPath}`);
    const tmpPath = `${envPath}.tmp.${Date.now()}`;
    writeFileSync(tmpPath, nextContent);
    renameSync(tmpPath, envPath);
    log(
      usingImportedClient
        ? "JARVIS_GOOGLE_CLIENT_ID/_SECRET/_TOKEN oppdatert sammen i .env (koherent Desktop-klient-sett, alt annet urørt)."
        : "JARVIS_GOOGLE_TOKEN oppdatert i .env (kun denne ene linjen endret, alt annet urørt)."
    );
  }

  log("google_drive_reauth=PASS");
  chainToP1aHostRun();
}

main().catch((err: unknown) => {
  console.error(`[google-drive-reauth] FEILET: ${(err as Error).message}`);
  process.exit(1);
});
