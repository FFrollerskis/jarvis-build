import { DEFAULT_PROFILES, demoteLocalProfileToCloud, type ModelProfile } from "@jarvis/model-gateway";
import {
  LOCAL_ENDPOINT_DNS_TIMEOUT_MS, LocalEndpointError, assertLocalEndpoint, resolveEndpointLocality, type LocalEndpointDnsLookup, type LocalEndpointOptions
} from "./local-endpoint-guard.ts";

/**
 * WP-G4b K4 (D-484, JARVIS-115 d): «LOKAL» modell er en `locality`-etikett i modellregisteret - til nå uten at URL-en til `gemma_local`, `local_llm` og `ollama` ble sjekket (kun visjonsidentiteten hadde G3-vakten). En URL som
 * peker utenfor det lokale nettet (feiltastet vert, en offentlig tjeneste, en omdirigert DNS-oppføring) ville fortsatt regnes som LOKAL, og SECRET_RESTRICTED-innhold (helse, økonomi, kamera-avledet) ville blitt sendt dit.
 *
 * Denne filen er den ENE, flaggstyrte parseren og håndhevelsen:
 *  - `JARVIS_LOCAL_MODEL_URL_GUARD=on` (kun den eksakte verdien; AV som standard = identisk med main: ingenting leses, ingenting endres, ingenting logges).
 *  - `JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE=on`: tailnet (CGNAT 100.64/10 og `*.ts.net`) regnes som lokalt - eierens eget lukkede nett (samme avveining som `JARVIS_VISION_ALLOW_TAILSCALE` i G3, men modell-nøytralt navn slik at
 *    workeren ikke trenger visjonsflagg). Uten den avvises tailnet-adresser.
 *  - For hver konfigurert identitet (URL satt) kjøres G3-vakten (`local-endpoint-guard.ts`, UENDRET delt kode): syntaks ved oppstart, og navneoppløsning ved oppstart (en offentlig oppløsning avviser). En ugyldig/offentlig URL
 *    gjør identiteten IKKE-lokal: `locality` på SELVE profilen settes til `cloud` (`demoteLocalProfileToCloud`, kilden alle lokalitetsavgjørelser leser: ruteren, gatewayens kjøringslås, `servedByCloudModel` og dermed
 *    `financeLockServedLocally`, chat-jobbene og kontrollsentrene). Det finnes ingen fjerde kopi av lokalitetsregelen.
 *  - FAIL-LUKKET: kun det som BEVISES lokalt er lokalt. Et navn som ikke kan løses akkurat nå beholdes (da kan heller ingen forbindelse opprettes), men logges (samme valg som G3). Oppløsningen kontrolleres kun ved oppstart (ingen
 *    DNS-pinning per kall; eierens DNS er en del av tillitsgrunnlaget, samme som G3/DPIA).
 *  - Logg: KUN identitetsnavn og årsakskode, aldri URL (kan inneholde brukerinfo/hemmeligheter) eller vert.
 *
 * Gjelder api OG worker (begge bygger en `ModelGateway` med disse identitetene og kaller `enforceLocalModelEndpoints` FØR den). Utenfor omfanget (`PARTIAL`, se runbook): minnets embedding-leverandør leser samme URL-variabler
 * (`JARVIS_EMBEDDING_URL` -> `JARVIS_OLLAMA_URL` -> `JARVIS_GEMMA_LOCAL_URL`) med en konstant `locality`-etikett i `modules/memory`.
 */
export const LOCAL_MODEL_URL_GUARD_FLAG = "JARVIS_LOCAL_MODEL_URL_GUARD";
export const LOCAL_MODEL_ALLOW_TAILSCALE_FLAG = "JARVIS_LOCAL_MODEL_ALLOW_TAILSCALE";

export interface LocalModelEndpointGuardConfig {
  enabled: boolean;
  allowTailscale: boolean;
}

/** ÉN flaggparser (kun eksakt `on`; `true`/`1`/`ON`/mellomrom er AV). Ingen annen kode leser disse miljøvariablene (låst av `wpg4b-local-model-guard.test.ts`). */
export function parseLocalModelEndpointGuard(env: Readonly<Record<string, string | undefined>> = process.env): LocalModelEndpointGuardConfig {
  return { enabled: env[LOCAL_MODEL_URL_GUARD_FLAG] === "on", allowTailscale: env[LOCAL_MODEL_ALLOW_TAILSCALE_FLAG] === "on" };
}

/**
 * De tre identitetene som er «lokale» KUN ved konfigurasjon, og miljøvariabelen som setter URL-en (samme variabler som adapterne leser: `LocalOpenAiCompatibleAdapter` (`local_llm`, og `gemma_local` via `main.ts`/`worker-main.ts`)
 * og `OllamaAdapter`). `local_vision` har sin egen, strengere vakt (kaster ved oppstart) og er ikke med her.
 */
export const LOCAL_MODEL_ENDPOINTS: ReadonlyArray<{ readonly provider: string; readonly env_name: string }> = Object.freeze([
  Object.freeze({ provider: "local_llm", env_name: "LOCAL_LLM_BASE_URL" }),
  Object.freeze({ provider: "gemma_local", env_name: "JARVIS_GEMMA_LOCAL_URL" }),
  Object.freeze({ provider: "ollama", env_name: "JARVIS_OLLAMA_URL" })
]);

export type LocalModelEndpointStatus = "not_configured" | "local" | "unresolved" | "demoted";

export interface LocalModelEndpointVerdict {
  identity: string;
  status: LocalModelEndpointStatus;
  /** Årsakskode (`local_url_malformed|scheme|credentials|not_local|resolves_nonlocal|check_failed`) når `demoted`, ellers `null`. Aldri URL eller vert. */
  code: string | null;
}

export interface EnforceLocalModelEndpointsDeps {
  lookup: LocalEndpointDnsLookup;
  /** Profilene som demoteres (standard: den delte `DEFAULT_PROFILES` som alle lokalitetsavgjørelser leser). */
  profiles?: ModelProfile[];
  timeoutMs?: number;
  /** Logg (standard: JSON-linjer til stdout/stderr). Mottar kun identitetsnavn, statuskoder og tall. */
  log?: (line: Record<string, unknown>, level: "info" | "warn") => void;
}

const defaultLog = (line: Record<string, unknown>, level: "info" | "warn"): void => {
  if (level === "warn") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
};

/**
 * Kjør vakten. `null` = flagget er AV (ingenting skjedde). Ellers ett svar per identitet i `LOCAL_MODEL_ENDPOINTS`; en demotert identitet er allerede satt til `cloud` på profilen når funksjonen returnerer.
 * Kaster aldri for en enkelt identitet: en uventet feil i sjekken regnes som «ikke bevist lokal» og demoterer (fail-lukket).
 */
export async function enforceLocalModelEndpoints(env: Readonly<Record<string, string | undefined>>, deps: EnforceLocalModelEndpointsDeps): Promise<LocalModelEndpointVerdict[] | null> {
  const config = parseLocalModelEndpointGuard(env);
  if (!config.enabled) return null;
  const log = deps.log ?? defaultLog;
  const profiles = deps.profiles ?? DEFAULT_PROFILES;
  const options: LocalEndpointOptions = { allowTailscale: config.allowTailscale };
  const timeoutMs = deps.timeoutMs ?? LOCAL_ENDPOINT_DNS_TIMEOUT_MS;
  const verdicts: LocalModelEndpointVerdict[] = [];
  for (const { provider, env_name } of LOCAL_MODEL_ENDPOINTS) {
    const raw = (env[env_name] ?? "").trim();
    if (raw === "") {
      verdicts.push({ identity: provider, status: "not_configured", code: null });
      continue;
    }
    let demoteCode: string | null = null;
    let status: LocalModelEndpointStatus = "local";
    try {
      assertLocalEndpoint(raw, options);
      const resolution = await resolveEndpointLocality(raw, { lookup: deps.lookup, timeoutMs }, options);
      if (resolution === "nonlocal") demoteCode = "local_url_resolves_nonlocal";
      else if (resolution === "unresolved") status = "unresolved";
    } catch (err) {
      demoteCode = err instanceof LocalEndpointError ? err.code : "local_url_check_failed";
    }
    if (demoteCode !== null) {
      demoteLocalProfileToCloud(provider, profiles);
      verdicts.push({ identity: provider, status: "demoted", code: demoteCode });
      log({ msg: "local_model_endpoint_demoted", identity: provider, code: demoteCode }, "warn");
    } else {
      verdicts.push({ identity: provider, status, code: null });
      if (status === "unresolved") log({ msg: "local_model_endpoint_unresolved", identity: provider }, "warn");
    }
  }
  log({ msg: "local_model_endpoint_guard", enabled: true, tailscale: config.allowTailscale, identities: verdicts.map((v) => ({ identity: v.identity, status: v.status })) }, "info");
  return verdicts;
}
