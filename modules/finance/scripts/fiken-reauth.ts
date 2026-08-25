// FIKEN OAUTH BOOTSTRAP (D-107 HOST-FIX #3) - engangs autorisasjonsflyt som
// veksler Tobias sitt Fiken-samtykke til den persisterte
// `JARVIS_FIKEN_REFRESH_TOKEN` + `JARVIS_FIKEN_COMPANY_SLUG` i `.env`.
// Modellert NØYAKTIG på `google-drive-reauth.ts`-mønsteret (lokal loopback-
// callback-server, state-CSRF-vern, atomisk backup+tmp+rename-.env-skriv) -
// gjenbruker den ETABLERTE kjeden i stedet for nye mekanismer:
//   - rene Fiken-OAuth-byggefunksjoner: `../src/fiken-oauth.ts` (SAMME kode
//     som runtime-refresh-flyten i `fiken-transport.ts` bruker)
//   - callback-parsing/state-validering: `google-drive-reauth-lib.ts`
//     (generisk, allerede testet)
//   - .env-les/skriv: `q21-env-recovery.ts` (parseEnvValues/
//     buildUpdatedEnvLines, allerede testet)
//
// FORUTSETNING (fail-closed): `JARVIS_FIKEN_CLIENT_ID` og
// `JARVIS_FIKEN_CLIENT_SECRET` står ALLEREDE i `.env` (lagt inn via skjult
// PowerShell-input - se D-107-instruksjonene; denne prosessen ber ALDRI om
// dem interaktivt og printer dem ALDRI).
//
// SIKKERHET: authorization code, access token, refresh token og client
// secret logges ALDRI - hverken helt eller delvis. Company-slugs er IKKE
// hemmeligheter (offentlige selskap-identifikatorer i API-stier) og kan
// trygt vises for valg.
//
// Kjøres (host, repo-rot): node --env-file=.env --experimental-transform-types modules/finance/scripts/fiken-reauth.ts

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  DEFAULT_FIKEN_REAUTH_PORT,
  FIKEN_OAUTH_CALLBACK_PATH,
  FIKEN_OAUTH_TOKEN_ENDPOINT,
  buildAuthorizationCodeExchangeBody,
  buildFikenAuthorizationUrl,
  buildFikenRedirectUri,
  extractFikenRefreshToken,
  fikenBasicAuthHeader,
  fikenTokenExchangeFailureReason,
  validateFikenAuthorizationUrl,
  type FikenTokenResponse
} from "../src/fiken-oauth.ts";
import { isValidCallbackState, parseCallbackQuery, type CallbackResult } from "../../core/scripts/lib/google-drive-reauth-lib.ts";
import { buildUpdatedEnvLines, parseEnvValues, type EnvValues } from "../../core/scripts/lib/q21-env-recovery.ts";

const FIKEN_API_BASE = "https://api.fiken.no/api/v2";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

const repoRoot = process.cwd();
const envPath = join(repoRoot, ".env");

function log(msg: string): void {
  console.log(`[fiken-reauth] ${msg}`);
}

function readEnv(): { lines: string[]; values: EnvValues } {
  if (!existsSync(envPath)) {
    throw new Error(`.env ikke funnet: ${envPath} - kjør fra repo-roten, kopier .env.example til .env først`);
  }
  const content = readFileSync(envPath, "utf8");
  return { lines: content.split("\n"), values: parseEnvValues(content) };
}

/** Samme korrupsjonssikre Windows-vei som google-drive-reauth (rundll32, aldri cmd /c start - se host-fix-historikken der). URL-en inneholder ingen secrets. */
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

const CALLBACK_HTML_OK = "<html><body><h3>Jarvis: Fiken-autorisasjon mottatt.</h3><p>Du kan lukke denne fanen og gå tilbake til terminalen.</p></body></html>";
const CALLBACK_HTML_ERR = "<html><body><h3>Jarvis: Fiken-autorisasjon feilet.</h3><p>Gå tilbake til terminalen for detaljer.</p></body></html>";

/** Én midlertidig loopback-server, ÉN callback, lukker seg selv (samme mønster som google-drive-reauth sin waitForCallback). */
async function waitForCallback(port: number, expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== FIKEN_OAUTH_CALLBACK_PATH) {
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

/** Veksler autorisasjonskoden mot tokens - Basic-auth per Fikens dokumentasjon, via NØYAKTIG samme delte hjelpere som runtime-flyten. Feil logger KUN HTTP-status, aldri kropp/kode/tokens. */
async function exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string, state: string): Promise<FikenTokenResponse> {
  const response = await fetch(FIKEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { authorization: fikenBasicAuthHeader(clientId, clientSecret), "content-type": "application/x-www-form-urlencoded" },
    body: buildAuthorizationCodeExchangeBody(code, redirectUri, state)
  });
  if (!response.ok) {
    throw new Error(fikenTokenExchangeFailureReason(response.status));
  }
  return (await response.json()) as FikenTokenResponse;
}

/** Live-bevis + slug-oppdagelse i ETT lese-kall (ZERO mutasjon): GET /companies med det ferske access-tokenet. */
async function discoverCompanies(accessToken: string): Promise<Array<{ slug: string; name: string }>> {
  const response = await fetch(`${FIKEN_API_BASE}/companies`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`fiken_reauth_companies_probe_failed_${response.status}`);
  }
  return (await response.json()) as Array<{ slug: string; name: string }>;
}

/** Nummerert valg når kontoen har flere selskaper - slugs/navn er ikke hemmeligheter. Spør på nytt ved ugyldig svar, gjetter aldri. */
async function promptForCompanySelection(companies: Array<{ slug: string; name: string }>): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
  try {
    log("kontoen har flere Fiken-selskaper - velg hvilket Jarvis skal bruke:");
    companies.forEach((c, i) => log(`  ${i + 1}) ${c.name} (slug: ${c.slug})`));
    for (;;) {
      const answer = (await ask("[fiken-reauth] nummer: ")).trim();
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= companies.length) return companies[n - 1]!.slug;
      log(`ugyldig valg "${answer}" - oppgi et tall mellom 1 og ${companies.length}.`);
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  log("FIKEN OAUTH BOOTSTRAP (D-107) - engangs autorisasjon + refresh-token/company-slug-persistering");

  const { lines, values } = readEnv();
  const clientId = values["JARVIS_FIKEN_CLIENT_ID"];
  const clientSecret = values["JARVIS_FIKEN_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error(
      "fiken_reauth_missing_client_credentials: JARVIS_FIKEN_CLIENT_ID og/eller JARVIS_FIKEN_CLIENT_SECRET mangler i .env - " +
        "legg dem inn via den skjulte PowerShell-inputen først (se D-107-instruksjonene). Ingen nettleser åpnet, ingen lokal server startet."
    );
  }

  const port = DEFAULT_FIKEN_REAUTH_PORT;
  const redirectUri = buildFikenRedirectUri(port);
  log(`redirect-URI for denne flyten (MÅ være registrert EKSAKT slik på Jarvis-appen i Fiken): ${redirectUri}`);

  const state = randomBytes(24).toString("hex");
  const authUrl = buildFikenAuthorizationUrl({ clientId, redirectUri, state });
  validateFikenAuthorizationUrl(authUrl);

  log("starter lokal callback-server og åpner Fiken-autorisasjonen i nettleseren...");
  const callbackPromise = waitForCallback(port, state);
  openBrowser(authUrl);
  const callback = await callbackPromise;

  if (callback.error === "TIMEOUT") {
    throw new Error("fiken_reauth_callback_timeout: ingen callback mottatt innen 5 minutter. Sjekk at redirect-URI-en over er registrert EKSAKT slik på appen i Fiken, og prøv igjen. .env er IKKE endret.");
  }
  if (callback.error) {
    throw new Error(`fiken_reauth_authorization_denied: Fiken returnerte error=${callback.error}. .env er IKKE endret.`);
  }
  if (!isValidCallbackState(callback.state, state)) {
    throw new Error("fiken_reauth_state_mismatch: callback-state matchet ikke denne kjøringens egen state (mulig CSRF/foreldet fane) - avviser koden. .env er IKKE endret.");
  }
  if (!callback.code) {
    throw new Error("fiken_reauth_no_code: callbacken manglet authorization code. .env er IKKE endret.");
  }
  log("autorisasjonskode mottatt (logges aldri) - veksler mot tokens med Basic-auth per Fikens dokumentasjon...");

  const tokens = await exchangeCode(clientId, clientSecret, callback.code, redirectUri, state);
  const refreshToken = extractFikenRefreshToken(tokens);
  if (!tokens.access_token) {
    throw new Error("fiken_reauth_no_access_token: token-responsen manglet access_token - kan ikke live-verifisere. .env er IKKE endret.");
  }
  log("token-veksling OK (tokens logges aldri) - live-verifiserer med GET /companies...");

  const companies = await discoverCompanies(tokens.access_token);
  if (companies.length === 0) {
    throw new Error(
      "fiken_reauth_no_companies: autorisasjonen ga tilgang til NULL selskaper - sjekk at Fiken-kontoen har API-tilgang for selskapet og at samtykket ble gitt for riktig konto. .env er IKKE endret."
    );
  }
  log(`fiken_live_companies_ok=true company_count=${companies.length}`);

  const existingSlug = values["JARVIS_FIKEN_COMPANY_SLUG"];
  let companySlug: string;
  if (existingSlug && companies.some((c) => c.slug === existingSlug)) {
    companySlug = existingSlug;
    log(`beholder allerede konfigurert JARVIS_FIKEN_COMPANY_SLUG=${existingSlug} (bekreftet autorisert).`);
  } else if (companies.length === 1) {
    companySlug = companies[0]!.slug;
    log(`ett autorisert selskap - velger slug=${companySlug} (${companies[0]!.name}).`);
  } else {
    companySlug = await promptForCompanySelection(companies);
    log(`valgt slug=${companySlug}.`);
  }

  // Atomisk skriv (backup + tmp + rename) - SAMME mønster som
  // google-drive-reauth/fix-q21-runtime-role. KUN de to bootstrap-produserte
  // variablene skrives; CLIENT_ID/SECRET og alt annet i .env forblir urørt.
  const updates: EnvValues = {
    JARVIS_FIKEN_REFRESH_TOKEN: refreshToken,
    JARVIS_FIKEN_COMPANY_SLUG: companySlug
  };
  const nextLines = buildUpdatedEnvLines(lines, updates);
  const nextContent = nextLines.join("\n");
  if (nextContent === lines.join("\n")) {
    log("JARVIS_FIKEN_REFRESH_TOKEN/_COMPANY_SLUG er allerede identiske (idempotent no-op) - .env ikke endret.");
  } else {
    const backupPath = `${envPath}.bak.${Date.now()}`;
    copyFileSync(envPath, backupPath);
    log(`sikkerhetskopi skrevet: ${backupPath}`);
    const tmpPath = `${envPath}.tmp.${Date.now()}`;
    writeFileSync(tmpPath, nextContent);
    renameSync(tmpPath, envPath);
    log("JARVIS_FIKEN_REFRESH_TOKEN=PRESENT og JARVIS_FIKEN_COMPANY_SLUG=PRESENT skrevet atomisk til .env (verdier logges aldri, alt annet urørt).");
  }

  log("fiken_reauth=PASS");
  log("neste steg: kjør den guardede host-akseptansen (fiken-live-host-run.ts via PowerShell-blokken i D-107-instruksjonene) for live provider-verifisering.");
}

main().catch((err: unknown) => {
  console.error(`[fiken-reauth] FEILET: ${(err as Error).message}`);
  process.exit(1);
});
