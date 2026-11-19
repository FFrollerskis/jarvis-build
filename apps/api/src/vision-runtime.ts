import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type pg from "pg";
import { envInt } from "@jarvis/contracts";
import { MAX_MODEL_TIMEOUT_MS } from "@jarvis/model-gateway";
import { LocalOpenAiCompatibleAdapter } from "@jarvis/provider-adapters";
import { guardedFetch } from "@jarvis/tool-gateway";
import { embeddingEndpointFromEnv, type EmbeddingProvider } from "@jarvis/memory";
import {
  HomeAssistantVisionSource, LocalFsStorageAdapter, VisionCameraService, VisionCaptureService, VisionClassifier, VisionEmbeddingService, VisionIngestPipeline, VisionInventoryService,
  VisionLastSeenService, VisionPoller, VisionSnapshotService, runVisionMaintenanceSweepForAllTenants, startVisionPoller, type CaptureDeviceRegistry, type VisionHttpFetch,
  type VisionModelGateway, type VisionPollerGuard, type VisionPollerHandle, type VisionService
} from "@jarvis/vision";
import { RateLimiter } from "./http-guard.ts";
import type { VisionApiDeps, VisionMaintenanceStatus, VisionStatusReport } from "./vision-routes.ts";

/**
 * WP-G3 (D-465): kobling av UA-9 (kamerabilder, lokal klassifisering, bilde-lagring, «sist sett», iPhone-opptak) til api-prosessen. ALT er AV som standard: uten `JARVIS_VISION_ENABLED=on` bygges ingenting,
 * ingen adapter registreres, ingen rute finnes og ingen poller starter (flagg-av = identisk med main). Én feil konfigurasjon KASTER ved oppstart (aldri en stille standard).
 *
 * Flagg (alle eksakt «on» for å slå PÅ; alt annet er av):
 *   JARVIS_VISION_ENABLED         hovedbryter: ruter (`/vision/*`), pipeline, vedlikeholdssveip.
 *   JARVIS_VISION_CLASSIFIER      lokal visjonsmodell (krever JARVIS_VISION_LOCAL_URL, som MÅ peke til en lokal/privat adresse - se `assertLocalVisionEndpoint`).
 *   JARVIS_VISION_LOCAL_URL / _MODEL   OpenAI-kompatibelt lokalt endepunkt (Ollama, llama.cpp ...) og modellnavn (standard `local-vision`).
 *   JARVIS_VISION_ALLOW_TAILSCALE tillat Tailscale-adresser (CGNAT 100.64/10 og `*.ts.net`) for det lokale endepunktet og embedding-endepunktet (review A-L5). Uten flagget avvises de.
 *   JARVIS_VISION_MODEL_TIMEOUT_MS tidsavbrudd per modellkall (standard 90000; 5000-180000 = gatewayens harde tak, ellers kastes ved oppstart). Virker nå på selve kallet (review A-M2).
 *   JARVIS_VISION_STORE_SNAPSHOTS lagring av hendelsesbilder (krever JARVIS_VISION_STORAGE_DIR; kun kameraer med policy `store_snapshot` i hjemmesonen lagres). Flagget styrer KUN SKRIVING:
 *                                 så snart JARVIS_VISION_STORAGE_DIR er satt kjører vedlikeholdet (retensjon, erasure, kamera-fjerning, gravsteiner) mot mappen selv om flagget er av (review B-M1).
 *                                 Med flagget PÅ kreves en skrivbar mappe ved oppstart (ellers kastes `storage_dir_not_writable`, review B-L10).
 *   JARVIS_VISION_HA_POLL         poll Home Assistant (bruker den EKSISTERENDE HA-connectorens JARVIS_HA_BASE_URL/JARVIS_HA_TOKEN fra secret-kjeden - ingen ny credential).
 *   JARVIS_VISION_MAX_STORED_MB   lagringstak for bilder per (tenant, space) (standard 2048, 16-10000000; over taket lagres bildet ikke, hendelsen skrives uten bilde).
 *   JARVIS_VISION_POLL_INTERVAL_SECONDS (standard 20, 5-3600), JARVIS_VISION_MAINTENANCE_INTERVAL_MINUTES (standard 15, 1-1440), JARVIS_VISION_RETENTION_SWEEP_HOUR (uendret) og
 *   JARVIS_VISION_MAINTENANCE_HOUR (standard 3, daglig full vedlikeholdskjøring).
 */
export class VisionConfigError extends Error {
  constructor(readonly code: string) {
    super(`vision_config_invalid:${code}`);
    this.name = "VisionConfigError";
  }
}

export interface VisionFlags {
  enabled: boolean;
  classifier: boolean;
  storeSnapshots: boolean;
  haPoll: boolean;
  localUrl: string | undefined;
  localModel: string;
  storageDir: string | undefined;
}

const on = (value: string | undefined): boolean => value === "on";

export function visionFlagsFromEnv(env: NodeJS.ProcessEnv): VisionFlags {
  const enabled = on(env["JARVIS_VISION_ENABLED"]);
  return {
    enabled,
    // Underflagg gjelder KUN under hovedbryteren (hovedbryter av = alt av, uansett underflagg).
    classifier: enabled && on(env["JARVIS_VISION_CLASSIFIER"]),
    storeSnapshots: enabled && on(env["JARVIS_VISION_STORE_SNAPSHOTS"]),
    haPoll: enabled && on(env["JARVIS_VISION_HA_POLL"]),
    localUrl: env["JARVIS_VISION_LOCAL_URL"]?.trim() || undefined,
    localModel: env["JARVIS_VISION_LOCAL_MODEL"]?.trim() || "local-vision",
    storageDir: env["JARVIS_VISION_STORAGE_DIR"]?.trim() || undefined
  };
}

/** Opplastinger per klient-IP per minutt (review B-L4). */
export const VISION_UPLOADS_PER_IP_PER_MINUTE = 20;

const LOCAL_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa", ".localdomain"];

/**
 * Tailscale (CGNAT 100.64.0.0/10 og MagicDNS `*.ts.net`) er KUN tillatt med eierens eksplisitte `JARVIS_VISION_ALLOW_TAILSCALE=on` (review A-L5): et tailnet er eierens eget lukkede nett, så oppsettet «modellen kjører på
 * PC-en min, nådd via Tailscale» må kunne brukes - men `100.x`/`.ts.net` er ellers ikke et privat nett, og uten flagget avvises begge.
 */
export function visionAllowTailscale(env: NodeJS.ProcessEnv): boolean {
  return on(env["JARVIS_VISION_ALLOW_TAILSCALE"]);
}

export interface LocalEndpointOptions {
  allowTailscale?: boolean;
}

/**
 * Er denne IP-adressen lokal? Loopback, RFC 1918 (10/8, 172.16/12, 192.168/16), IPv6 ULA (fc00::/7, som også dekker Tailscales fd7a:115c:a1e0::/48) og - kun med eier-flagget - CGNAT 100.64/10. Link-lokale adresser
 * (169.254/16 - inkludert skymetadata-adressen 169.254.169.254 - og fe80::/10), 0.0.0.0 og alt offentlig er IKKE lokale (review A-L5). En IPv4-mappet IPv6 (`::ffff:10.0.0.1`, slik getaddrinfo kan gi) vurderes som sin IPv4.
 */
export function isLocalAddress(address: string, options: LocalEndpointOptions = {}): boolean {
  let host = address.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped !== null) host = mapped[1] as string;
  const kind = isIP(host);
  if (kind === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return options.allowTailscale === true && a === 100 && b >= 64 && b <= 127;
  }
  if (kind === 6) return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host);
  return false;
}

/**
 * Kamerabilder forlater ALDRI maskinen/det lokale nettverket. `local_vision`-identiteten er «lokal» ved KONFIGURASJON, så endepunktet valideres deterministisk ved oppstart: http(s), ingen brukerinfo,
 * og verten må være loopback, privat IP (se `isLocalAddress`), `host.docker.internal`, et enkelt-label-navn (docker-compose-tjeneste), eller ende på .local/.lan/.internal/.home.arpa (og `.ts.net` med
 * Tailscale-flagget). Et offentlig vertsnavn/IP avvises (`VisionConfigError`) - det finnes ingen overstyring. Dette er den SYNTAKTISKE sjekken; selve navneoppløsningen kontrolleres ved oppstart av
 * `verifyVisionEndpoints` (review A-L5). Redirects følges uansett aldri, se adapteren.
 */
export function assertLocalVisionEndpoint(raw: string, options: LocalEndpointOptions = {}): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VisionConfigError("local_url_malformed");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new VisionConfigError("local_url_scheme");
  if (url.username !== "" || url.password !== "") throw new VisionConfigError("local_url_credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = isIP(host) !== 0
    ? isLocalAddress(host, options)
    : host === "localhost" || host === "host.docker.internal" || !host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s)) || (options.allowTailscale === true && host.endsWith(".ts.net"));
  if (!local) throw new VisionConfigError("local_url_not_local");
  return raw;
}

/** Navneoppslag (injisert; i drift `dns.lookup(host, { all: true })` fra main.ts - visjonsfilene importerer aldri node:dns, byggevakten feller det). */
export type VisionDnsLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

export interface VisionEndpointVerification {
  /** Kode (`embedding_url_not_local` ...) når embedding-endepunktet ikke er lokalt: vision bruker da INGEN embedding (ingen objektvektorer), men API-et starter. `null` = greit eller ikke relevant. */
  embeddingBlockedReason: string | null;
}

const DNS_TIMEOUT_MS = 5_000;

async function lookupWithTimeout(lookup: VisionDnsLookup, host: string, timeoutMs: number): Promise<ReadonlyArray<{ address: string }>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([lookup(host), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("dns_timeout")), timeoutMs); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Løser verten i `rawUrl` og avviser alt som peker utenfor det lokale nettet. Gir `"unresolved"` (med en logglinje uten vertsnavn) når navnet ikke kan løses akkurat nå - se `verifyVisionEndpoints`. */
async function assertResolvesLocal(rawUrl: string, label: string, deps: { lookup: VisionDnsLookup; timeoutMs: number }, options: LocalEndpointOptions): Promise<"checked" | "literal" | "unresolved"> {
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) !== 0) return "literal"; // en IP-adresse er allerede vurdert syntaktisk
  let addresses: ReadonlyArray<{ address: string }>;
  try {
    addresses = await lookupWithTimeout(deps.lookup, host, deps.timeoutMs);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) {
    console.error(JSON.stringify({ msg: "vision_endpoint_unresolved", endpoint: label }));
    return "unresolved";
  }
  if (addresses.some((entry) => !isLocalAddress(entry.address, options))) throw new VisionConfigError(`${label}_resolves_nonlocal`);
  return "checked";
}

/**
 * Review A-L5 og A-INFO-4: løser vertsnavnet i endepunktene ved OPPSTART og avviser offentlige adresser - den syntaktiske sjekken (`assertLocalVisionEndpoint`) slapp gjennom `evil.com.local`, et enkelt-label-navn som
 * i praksis peker utenfor, og `metadata.google.internal` (som peker til skymetadata-adressen). Gjelder (1) den lokale visjonsmodellen (`JARVIS_VISION_LOCAL_URL`, kun med CLASSIFIER på) - en ikke-lokal oppløsning KASTER
 * (`local_url_resolves_nonlocal`) - og (2) embedding-endepunktet minnet bruker (`JARVIS_EMBEDDING_URL` -> `JARVIS_OLLAMA_URL` -> `JARVIS_GEMMA_LOCAL_URL`, kun når provideren er Ollama): er det ikke lokalt, bruker vision
 * INGEN embedding (gir koden `embedding_url_*` tilbake) i stedet for å stoppe hele API-et, siden endepunktet deles med vanlig minne.
 * Et navn som IKKE kan løses akkurat nå (docker-tjeneste som ikke er oppe ennå) stopper ikke oppstarten: da kan heller ingen forbindelse opprettes, og hvert kall feiler lukket - men det logges. Dette er en
 * oppstartssjekk, IKKE per-kall DNS-pinning: et navn som senere endrer svar (DNS rebinding) fanges ikke - eierens DNS er en del av tillitsgrunnlaget (DPIA §7). Uten JARVIS_VISION_ENABLED=on gjøres ingenting.
 */
export async function verifyVisionEndpoints(env: NodeJS.ProcessEnv, deps: { lookup: VisionDnsLookup; timeoutMs?: number }): Promise<VisionEndpointVerification> {
  const flags = visionFlagsFromEnv(env);
  if (!flags.enabled) return { embeddingBlockedReason: null };
  const options: LocalEndpointOptions = { allowTailscale: visionAllowTailscale(env) };
  const lookupDeps = { lookup: deps.lookup, timeoutMs: deps.timeoutMs ?? DNS_TIMEOUT_MS };
  if (flags.classifier && flags.localUrl !== undefined) {
    assertLocalVisionEndpoint(flags.localUrl, options);
    await assertResolvesLocal(flags.localUrl, "local_url", lookupDeps, options);
  }
  const embeddingUrl = embeddingEndpointFromEnv(env);
  if (embeddingUrl === null) return { embeddingBlockedReason: null };
  try {
    assertLocalVisionEndpoint(embeddingUrl, options);
    await assertResolvesLocal(embeddingUrl, "embedding_url", lookupDeps, options);
    return { embeddingBlockedReason: null };
  } catch (err) {
    if (err instanceof VisionConfigError) return { embeddingBlockedReason: embeddingReason(err.code) };
    throw err;
  }
}

/** `local_url_not_local` -> `embedding_url_not_local` (samme feilkoder, men for embedding-endepunktet). */
const embeddingReason = (code: string): string => (code.startsWith("local_url_") ? `embedding_url_${code.slice("local_url_".length)}` : code);

/** Den SYNTAKTISKE sjekken av embedding-endepunktet (kjørt av `buildVisionRuntime` selv, uten DNS): `null` = greit eller ikke Ollama. */
function embeddingBlockReason(env: NodeJS.ProcessEnv): string | null {
  const url = embeddingEndpointFromEnv(env);
  if (url === null) return null;
  try {
    assertLocalVisionEndpoint(url, { allowTailscale: visionAllowTailscale(env) });
    return null;
  } catch (err) {
    if (err instanceof VisionConfigError) return embeddingReason(err.code);
    throw err;
  }
}

/**
 * Tidsavbrudd (ms) for ETT modellkall (`JARVIS_VISION_MODEL_TIMEOUT_MS`, standard 90 s). Review A-M2: knappen var DØD - klassifisereren sendte alltid `timeoutMs: 90000` per kall, og gatewayen skriver den verdien til
 * `request.timeoutMs` som slår adapterens konstruktørverdi (`request.timeoutMs ?? this.timeoutMs`). Den SAMME verdien går nå til både adapteren og klassifisereren. Øvre grense er gatewayens harde tak
 * (`MAX_MODEL_TIMEOUT_MS`, 180 s): en verdi over det kan aldri etterkommes, så den KASTER ved oppstart (aldri en stille klemming - samme regel som gatewayen selv). Den gamle øvre grensen (600 s) kunne aldri virke.
 */
export const VISION_MODEL_TIMEOUT_BOUNDS = { min: 5_000, max: MAX_MODEL_TIMEOUT_MS } as const;
export function visionModelTimeoutMs(env: NodeJS.ProcessEnv): number {
  return envInt("JARVIS_VISION_MODEL_TIMEOUT_MS", 90_000, VISION_MODEL_TIMEOUT_BOUNDS, env);
}

/** `local_vision`-adapteren, kun når hovedbryter + CLASSIFIER er på. `null` ellers (da registreres ingenting). Kaster ved manglende/ikke-lokal URL. */
export function visionAdapterFromEnv(env: NodeJS.ProcessEnv): LocalOpenAiCompatibleAdapter | null {
  const flags = visionFlagsFromEnv(env);
  if (!flags.classifier) return null;
  if (flags.localUrl === undefined) throw new VisionConfigError("local_url_missing");
  const url = assertLocalVisionEndpoint(flags.localUrl, { allowTailscale: visionAllowTailscale(env) });
  return new LocalOpenAiCompatibleAdapter(url, flags.localModel, visionModelTimeoutMs(env), "local_vision", undefined, { vision: true });
}

/** Eier-kontrollene som stanser polleren: kill switch, frosset `home-assistant`-connector, tilbakekalt `JARVIS_HA_TOKEN` (samme live, delte sjekker som gatewayen bruker). */
export interface VisionOwnerControls {
  killSwitch: { isActiveDurable(): Promise<boolean> };
  controls: { isFrozenDurable(connectorId: string): Promise<boolean>; isRevokedDurable(ref: string): Promise<boolean> };
}

export function createVisionPollerGuard(deps: VisionOwnerControls): VisionPollerGuard {
  return {
    async blocked(): Promise<string | null> {
      if (await deps.killSwitch.isActiveDurable()) return "kill_switch_active";
      if (await deps.controls.isFrozenDurable("home-assistant")) return "connector_frozen";
      if (await deps.controls.isRevokedDurable("JARVIS_HA_TOKEN")) return "credential_revoked";
      return null;
    }
  };
}

export interface VisionRuntimeDeps {
  pool: pg.Pool;
  env: NodeJS.ProcessEnv;
  vision: VisionService;
  /** Den ekte `ModelGateway` (strukturelt: `complete`). Kamerabilder låses av gatewayen til lokal modell (restricted media) - se modules/model-gateway. */
  gateway: VisionModelGateway;
  memoryEmbedding: EmbeddingProvider;
  devices: CaptureDeviceRegistry;
  /** Eierens tenant: den ENESTE tenanten HA-polleren leser for (HA-credentialen tilhører eieren). */
  ownerTenantId: string;
  secrets: { get(name: string): Promise<string | null | undefined> };
  ownerControls: VisionOwnerControls;
  /** Test-/drift-injeksjon (standard: `guardedFetch` fra tool-gateway). */
  fetchImpl?: VisionHttpFetch;
  /** Resultatet av `verifyVisionEndpoints` (navneoppløsningen av embedding-endepunktet, kjørt av main.ts ved oppstart). Utelatt = kun den syntaktiske sjekken. */
  embeddingBlockedReason?: string | null;
}

export interface VisionRuntime {
  flags: VisionFlags;
  api: VisionApiDeps;
  pipeline: VisionIngestPipeline;
  /** Den lokale klassifisereren (kun med JARVIS_VISION_CLASSIFIER=on). Eksponert slik at koblingen (tidsavbrudd, gateway) kan bevises i tester. */
  classifier: VisionClassifier | undefined;
  poller: VisionPoller | null;
  pollerHandle: VisionPollerHandle | null;
  /** Hyppig vedlikehold (gravsteiner, pending-bilder, utløp av opptaksforespørsler) - kalles av en intervalltimer i main.ts. Kaster (`vision_maintenance_failed:<n>`) når noen space feilet eller en gravstein er «stuck» (review B-L8). */
  lightMaintenance(): Promise<void>;
  /** Eierens helsebilde (samme som `/vision/status`). */
  status(): VisionStatusReport;
  /** Daglig full vedlikeholdskjøring (bilde-retensjon, inventar, vektorer, gravsteiner) - kalles av en `DailyScheduler` i main.ts. */
  fullMaintenance(): Promise<{ failed: Array<{ tenant_id: string; memory_space_id: string; error: string }> }>;
  stop(): void;
}

/**
 * Review B-L10: skrivetest ved oppstart når lagring er på. Api-containeren kjører som `USER node` med read_only rootfs, og et nytt navngitt volum er root-eid: uten denne testen feilet HVER lagring stille
 * med EACCES (hendelsen ble skrevet uten bilde, kun en logglinje). Oppretter mappen om nødvendig, skriver og sletter én prøvefil; kaster `storage_dir_not_writable` (aldri stien eller feilteksten).
 */
export function assertStorageDirWritable(dir: string): void {
  try {
    // Review delta B LOW-D4: en mappe vi oppretter selv er kun for tjenestebrukeren (0700), som mappene adapteren oppretter under den. En eksisterende mappe (bind-mount, volum) røres ikke - eieren eier rettighetene.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok", { flag: "wx", mode: 0o600 });
    unlinkSync(probe);
  } catch {
    throw new VisionConfigError("storage_dir_not_writable");
  }
}

/** Bygger hele kjøretiden. `null` når hovedbryteren er av (ingenting bygges). */
export function buildVisionRuntime(deps: VisionRuntimeDeps): VisionRuntime | null {
  const flags = visionFlagsFromEnv(deps.env);
  if (!flags.enabled) return null;
  if (flags.classifier && flags.localUrl === undefined) throw new VisionConfigError("local_url_missing");
  if (flags.classifier && flags.localUrl !== undefined) assertLocalVisionEndpoint(flags.localUrl, { allowTailscale: visionAllowTailscale(deps.env) });
  if (flags.storeSnapshots && flags.storageDir === undefined) throw new VisionConfigError("storage_dir_missing");
  if (flags.storageDir !== undefined && !flags.storageDir.startsWith("/")) throw new VisionConfigError("storage_dir_not_absolute");
  if (flags.storeSnapshots && flags.storageDir !== undefined) assertStorageDirWritable(flags.storageDir);

  const cameras = new VisionCameraService(deps.pool);
  const inventory = new VisionInventoryService(deps.pool);
  // Review B-M1: lagringstjenesten bygges så snart STORAGE_DIR er satt - IKKE bare når STORE_SNAPSHOTS er på. Flagget styrer kun SKRIVING (se `storeSnapshots` på pipelinen under); sletting (retensjon, erasure,
  // kamera-fjerning, gravsteiner) MÅ fortsette selv om eieren har slått lagring av, ellers ligger bildefilene igjen for alltid mens radene er slettet.
  const snapshots = flags.storageDir !== undefined
    ? new VisionSnapshotService(deps.pool, new LocalFsStorageAdapter(flags.storageDir), deps.vision, { maxStoredBytes: envInt("JARVIS_VISION_MAX_STORED_MB", 2048, { min: 16, max: 10_000_000 }, deps.env) * 1024 * 1024 })
    : undefined;
  let embeddings: VisionEmbeddingService | undefined;
  // Review A-INFO-4: embedding-endepunktet minnet bruker valideres som privat/lokalt (samme regel som den lokale modellen; navneoppløsningen er allerede kontrollert av `verifyVisionEndpoints` og gitt hit i
  // `embeddingBlockedReason`). Er det ikke lokalt bruker vision INGEN embedding - kamera-avledet tekst (objektnavn) sendes aldri dit - men resten av API-et (og vanlig minne) er uberørt.
  const embeddingBlocked = deps.embeddingBlockedReason ?? embeddingBlockReason(deps.env);
  if (embeddingBlocked !== null) {
    console.error(JSON.stringify({ msg: "vision_embeddings_disabled", code: embeddingBlocked }));
  } else {
    try {
      embeddings = new VisionEmbeddingService(deps.pool, deps.memoryEmbedding);
    } catch (err) {
      // Kun lokal embedding (fail-closed): en sky-provider gir ingen objektvektorer - «sist sett» faller til eksakte treff.
      console.error(JSON.stringify({ msg: "vision_embeddings_disabled", code: (err as Error).name }));
    }
  }
  // Review A-M2: tidsavbruddet fra JARVIS_VISION_MODEL_TIMEOUT_MS går inn i klassifisereren (per kall via gatewayen), ikke bare i adapterens konstruktør.
  const classifier = flags.classifier ? new VisionClassifier({ gateway: deps.gateway, timeoutMs: visionModelTimeoutMs(deps.env) }) : undefined;
  const pipeline = new VisionIngestPipeline({ pool: deps.pool, vision: deps.vision, classifier, snapshots, embeddings, inventory, enabled: true, storeSnapshots: flags.storeSnapshots && snapshots !== undefined });
  const capture = new VisionCaptureService(deps.pool, cameras, pipeline, deps.devices);
  const lastSeen = new VisionLastSeenService(deps.pool, { ...(embeddings !== undefined ? { embeddings } : {}), inventory });

  let poller: VisionPoller | null = null;
  let pollerHandle: VisionPollerHandle | null = null;
  if (flags.haPoll) {
    const fetchImpl: VisionHttpFetch = deps.fetchImpl ?? ((url, init) => guardedFetch(url, init));
    const source = new HomeAssistantVisionSource({
      fetch: fetchImpl,
      baseUrl: async () => (await deps.secrets.get("JARVIS_HA_BASE_URL")) ?? null,
      token: async () => (await deps.secrets.get("JARVIS_HA_TOKEN")) ?? null
    });
    poller = new VisionPoller({ pool: deps.pool, cameras, pipeline, source, guard: createVisionPollerGuard(deps.ownerControls), tenantIds: [deps.ownerTenantId] });
    pollerHandle = startVisionPoller(poller, envInt("JARVIS_VISION_POLL_INTERVAL_SECONDS", 20, { min: 5, max: 3600 }, deps.env) * 1000);
  }

  const maintenanceDeps = { snapshots, inventory, captures: capture, embeddings };
  // Review B-L8: siste vedlikeholdsutfall og pollerens helse samles til eierens helsebilde (`/vision/status`).
  const last: { light: VisionMaintenanceStatus | null; full: VisionMaintenanceStatus | null } = { light: null, full: null };
  const toStatus = (summary: Awaited<ReturnType<typeof runVisionMaintenanceSweepForAllTenants>>): VisionMaintenanceStatus => ({
    at: new Date().toISOString(), failed: summary.failed.length, tombstones_deleted: summary.tombstones_deleted, tombstones_failed: summary.tombstones_failed, tombstones_stuck: summary.tombstones_stuck,
    temp_files_purged: summary.temp_files_purged
  });
  // Review delta B LOW-D4: aldri to lette vedlikeholdskjøringer samtidig i denne prosessen. En kjøring som varer lenger enn intervallet (stor kø, tregt volum) ellers overlapper neste timer-tikk, og to reapere
  // sletter da de samme filene (de falske `failed` fra kappløpet er også fjernet i lagringsadapteren, men to reapere gjør uansett dobbelt arbeid og dobbelt støy). Den overlappende tikken hoppes over.
  let lightRunning = false;
  const status = (): VisionStatusReport => ({
    poller: pollerHandle === null ? { enabled: false } : { enabled: true, ...pollerHandle.status(), consecutive_failures: pollerHandle.health().consecutive_failures, next_delay_ms: pollerHandle.health().next_delay_ms },
    maintenance: { light: last.light, full: last.full },
    storage: { maintenance_enabled: snapshots !== undefined, writing_enabled: flags.storeSnapshots && snapshots !== undefined },
    classifier: classifier !== undefined,
    embeddings: embeddings !== undefined
  });
  return {
    flags,
    // Review B-L4: egen strenge per-IP-grense for opplastingsruten (kroppen er opptil ca. 7 MB og leses FØR grantet verifiseres): 20 opplastinger per minutt per IP er rause rom for én iPhone (ETT opptak per forespørsel).
    api: { cameras, capture, lastSeen, inventory, maxUploadBytes: 5 * 1024 * 1024, uploadLimiter: new RateLimiter(VISION_UPLOADS_PER_IP_PER_MINUTE, 60_000), status },
    pipeline,
    classifier,
    poller,
    pollerHandle,
    status,
    async lightMaintenance(): Promise<void> {
      if (lightRunning) return; // en forrige lett kjøring pågår fortsatt: hopp over denne tikken
      lightRunning = true;
      try {
        const summary = await runVisionMaintenanceSweepForAllTenants(deps.pool, maintenanceDeps, { light: true });
        last.light = toStatus(summary);
        // Review B-L8: en feil (inkl. «stuck» gravsteiner) skal ikke forsvinne i en teller: den kastes, og main.ts-timeren logger den (`vision_light_maintenance_failed`) i stedet for å late som alt gikk bra.
        if (summary.failed.length > 0) throw new Error(`vision_maintenance_failed:${summary.failed.length}`);
      } finally {
        lightRunning = false; // også etter en feil (ellers ville én feilet kjøring stanse alt vedlikehold for alltid)
      }
    },
    async fullMaintenance() {
      const summary = await runVisionMaintenanceSweepForAllTenants(deps.pool, maintenanceDeps);
      last.full = toStatus(summary);
      return summary;
    },
    stop(): void {
      pollerHandle?.stop();
    }
  };
}
