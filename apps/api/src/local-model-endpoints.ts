import { embeddingEndpointFromEnv, type EmbeddingEnv } from "@jarvis/memory";
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
 * Gjelder api OG worker (begge bygger en `ModelGateway` med disse identitetene og kaller `enforceLocalModelEndpoints` FØR den).
 *
 * WP-G4b fiks-runde 1 (FIX-1, review B M1): MINNETS embedding-leverandør (`modules/memory`, `OllamaEmbedding`) leser URL-en fra `JARVIS_EMBEDDING_URL` -> `JARVIS_OLLAMA_URL` -> `JARVIS_GEMMA_LOCAL_URL` med en konstant
 * `locality: "local"`, og sender minneinnhold (inkl. helse/økonomi, D-386) dit. Vakten kaller derfor `embeddingEndpointFromEnv` (samme URL-valg som leverandøren selv) og kjører NØYAKTIG samme syntaks- og DNS-sjekk. Embedding er
 * ikke en modellprofil som kan demoteres til sky (minnets vektorrom MÅ være lokalt), så en ikke-lokal URL KASTER `MemoryEmbeddingNotLocalError` (`memory_embedding_must_be_local:<kode>`) og stopper oppstarten FØR leverandøren
 * opprettes; loggen har kun `identity: "memory_embedding"` og koden. Et navn som ikke kan løses akkurat nå beholdes med en advarsel (som for de andre identitetene; en av-slått PC med et `.lan`-navn skal ikke stoppe hele API-et).
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

/** Identiteten for minnets embedding-leverandør i verdikt og logger (ikke en modellprofil: kan ikke demoteres, en ikke-lokal URL stopper oppstarten). */
export const MEMORY_EMBEDDING_IDENTITY = "memory_embedding";

/** Kastet ved oppstart når minnets embedding-URL ikke er lokal (flagget PÅ). Kun den stabile koden, aldri URL eller vert. */
export class MemoryEmbeddingNotLocalError extends Error {
  constructor(readonly code: string) {
    super(`memory_embedding_must_be_local:${code}`);
    this.name = "MemoryEmbeddingNotLocalError";
  }
}

/** Det vakten IKKE dekker (ærlig oppstartslogg; oppdateres når et hull lukkes). */
export const LOCAL_MODEL_GUARD_NOT_COVERED: readonly string[] = Object.freeze(["redirects", "dns_after_startup"]);

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

/** ÉN sjekk for alle identiteter (syntaks, så navneoppløsning ved oppstart): `demoteCode` satt = ikke bevist lokal; ellers `status` `local` eller `unresolved` (navnet kunne ikke løses akkurat nå). Kaster aldri: en uventet feil er «ikke bevist lokal». */
async function checkEndpoint(raw: string, lookup: LocalEndpointDnsLookup, timeoutMs: number, options: LocalEndpointOptions): Promise<{ demoteCode: string | null; status: "local" | "unresolved" }> {
  try {
    assertLocalEndpoint(raw, options);
    const resolution = await resolveEndpointLocality(raw, { lookup, timeoutMs }, options);
    if (resolution === "nonlocal") return { demoteCode: "local_url_resolves_nonlocal", status: "local" };
    return { demoteCode: null, status: resolution === "unresolved" ? "unresolved" : "local" };
  } catch (err) {
    return { demoteCode: err instanceof LocalEndpointError ? err.code : "local_url_check_failed", status: "local" };
  }
}

/**
 * Kjør vakten. `null` = flagget er AV (ingenting skjedde). Ellers ett svar per identitet i `LOCAL_MODEL_ENDPOINTS` (pluss `memory_embedding` når minnet bruker Ollama-embedding); en demotert identitet er allerede satt til `cloud` på
 * profilen når funksjonen returnerer. Kaster aldri for en chat-identitet: en uventet feil i sjekken regnes som «ikke bevist lokal» og demoterer (fail-lukket). Eneste unntak: en ikke-lokal minne-embedding KASTER
 * `MemoryEmbeddingNotLocalError` (ingen sky-profil å demotere til; oppstarten stoppes før minnet kan sende noe dit).
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
    const check = await checkEndpoint(raw, deps.lookup, timeoutMs, options);
    if (check.demoteCode !== null) {
      demoteLocalProfileToCloud(provider, profiles);
      verdicts.push({ identity: provider, status: "demoted", code: check.demoteCode });
      log({ msg: "local_model_endpoint_demoted", identity: provider, code: check.demoteCode }, "warn");
    } else {
      verdicts.push({ identity: provider, status: check.status, code: null });
      if (check.status === "unresolved") log({ msg: "local_model_endpoint_unresolved", identity: provider }, "warn");
    }
  }
  // FIX-1: minnets embedding-leverandør (null = lokal hash/ingen Ollama-URL: ingen nettverk, ingenting å sjekke). Samme sjekk; ikke-lokal = stopp (ingen sky-profil å demotere til).
  const embeddingUrl = embeddingEndpointFromEnv(env as EmbeddingEnv);
  if (embeddingUrl !== null) {
    const check = await checkEndpoint(embeddingUrl, deps.lookup, timeoutMs, options);
    if (check.demoteCode !== null) {
      log({ msg: "local_model_endpoint_rejected", identity: MEMORY_EMBEDDING_IDENTITY, code: check.demoteCode }, "warn");
      throw new MemoryEmbeddingNotLocalError(check.demoteCode);
    }
    verdicts.push({ identity: MEMORY_EMBEDDING_IDENTITY, status: check.status, code: null });
    if (check.status === "unresolved") log({ msg: "local_model_endpoint_unresolved", identity: MEMORY_EMBEDDING_IDENTITY }, "warn");
  }
  log({ msg: "local_model_endpoint_guard", enabled: true, tailscale: config.allowTailscale, identities: verdicts.map((v) => ({ identity: v.identity, status: v.status })), not_covered: [...LOCAL_MODEL_GUARD_NOT_COVERED] }, "info");
  return verdicts;
}
