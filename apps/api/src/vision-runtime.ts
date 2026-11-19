import { isIP } from "node:net";
import type pg from "pg";
import { envInt } from "@jarvis/contracts";
import { MAX_MODEL_TIMEOUT_MS } from "@jarvis/model-gateway";
import { LocalOpenAiCompatibleAdapter } from "@jarvis/provider-adapters";
import { guardedFetch } from "@jarvis/tool-gateway";
import type { EmbeddingProvider } from "@jarvis/memory";
import {
  HomeAssistantVisionSource, LocalFsStorageAdapter, VisionCameraService, VisionCaptureService, VisionClassifier, VisionEmbeddingService, VisionIngestPipeline, VisionInventoryService,
  VisionLastSeenService, VisionPoller, VisionSnapshotService, runVisionMaintenanceSweepForAllTenants, startVisionPoller, type CaptureDeviceRegistry, type VisionHttpFetch,
  type VisionModelGateway, type VisionPollerGuard, type VisionPollerHandle, type VisionService
} from "@jarvis/vision";
import type { VisionApiDeps } from "./vision-routes.ts";

/**
 * WP-G3 (D-465): kobling av UA-9 (kamerabilder, lokal klassifisering, bilde-lagring, «sist sett», iPhone-opptak) til api-prosessen. ALT er AV som standard: uten `JARVIS_VISION_ENABLED=on` bygges ingenting,
 * ingen adapter registreres, ingen rute finnes og ingen poller starter (flagg-av = identisk med main). Én feil konfigurasjon KASTER ved oppstart (aldri en stille standard).
 *
 * Flagg (alle eksakt «on» for å slå PÅ; alt annet er av):
 *   JARVIS_VISION_ENABLED         hovedbryter: ruter (`/vision/*`), pipeline, vedlikeholdssveip.
 *   JARVIS_VISION_CLASSIFIER      lokal visjonsmodell (krever JARVIS_VISION_LOCAL_URL, som MÅ peke til en lokal/privat adresse - se `assertLocalVisionEndpoint`).
 *   JARVIS_VISION_LOCAL_URL / _MODEL   OpenAI-kompatibelt lokalt endepunkt (Ollama, llama.cpp ...) og modellnavn (standard `local-vision`).
 *   JARVIS_VISION_MODEL_TIMEOUT_MS tidsavbrudd per modellkall (standard 90000; 5000-180000 = gatewayens harde tak, ellers kastes ved oppstart). Virker nå på selve kallet (review A-M2).
 *   JARVIS_VISION_STORE_SNAPSHOTS lagring av hendelsesbilder (krever JARVIS_VISION_STORAGE_DIR; kun kameraer med policy `store_snapshot` i hjemmesonen lagres).
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

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./];
const LOCAL_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa", ".localdomain"];

/**
 * Kamerabilder forlater ALDRI maskinen/det lokale nettverket. `local_vision`-identiteten er «lokal» ved KONFIGURASJON, så endepunktet valideres deterministisk ved oppstart: http(s), ingen brukerinfo,
 * og verten må være loopback, privat/link-lokal IP, `host.docker.internal`, et enkelt-label-navn (docker-compose-tjeneste), eller ende på .local/.lan/.internal/.home.arpa. Et offentlig vertsnavn/IP
 * avvises (`VisionConfigError`) - det finnes ingen overstyring. (DNS oppløses ikke her: et lokalt navn som peker utenfor er eierens nettverksoppsett; redirects følges uansett aldri, se adapteren.)
 */
export function assertLocalVisionEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VisionConfigError("local_url_malformed");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new VisionConfigError("local_url_scheme");
  if (url.username !== "" || url.password !== "") throw new VisionConfigError("local_url_credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const kind = isIP(host);
  let local = false;
  if (kind === 4) local = host === "0.0.0.0" ? false : PRIVATE_V4.some((p) => p.test(host));
  else if (kind === 6) local = host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
  else local = host === "localhost" || host === "host.docker.internal" || !host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s));
  if (!local) throw new VisionConfigError("local_url_not_local");
  return raw;
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
  const url = assertLocalVisionEndpoint(flags.localUrl);
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
}

export interface VisionRuntime {
  flags: VisionFlags;
  api: VisionApiDeps;
  pipeline: VisionIngestPipeline;
  /** Den lokale klassifisereren (kun med JARVIS_VISION_CLASSIFIER=on). Eksponert slik at koblingen (tidsavbrudd, gateway) kan bevises i tester. */
  classifier: VisionClassifier | undefined;
  poller: VisionPoller | null;
  pollerHandle: VisionPollerHandle | null;
  /** Hyppig vedlikehold (gravsteiner, pending-bilder, utløp av opptaksforespørsler) - kalles av en intervalltimer i main.ts. */
  lightMaintenance(): Promise<void>;
  /** Daglig full vedlikeholdskjøring (bilde-retensjon, inventar, vektorer, gravsteiner) - kalles av en `DailyScheduler` i main.ts. */
  fullMaintenance(): Promise<{ failed: Array<{ tenant_id: string; memory_space_id: string; error: string }> }>;
  stop(): void;
}

/** Bygger hele kjøretiden. `null` når hovedbryteren er av (ingenting bygges). */
export function buildVisionRuntime(deps: VisionRuntimeDeps): VisionRuntime | null {
  const flags = visionFlagsFromEnv(deps.env);
  if (!flags.enabled) return null;
  if (flags.classifier && flags.localUrl === undefined) throw new VisionConfigError("local_url_missing");
  if (flags.classifier && flags.localUrl !== undefined) assertLocalVisionEndpoint(flags.localUrl);
  if (flags.storeSnapshots && flags.storageDir === undefined) throw new VisionConfigError("storage_dir_missing");
  if (flags.storageDir !== undefined && !flags.storageDir.startsWith("/")) throw new VisionConfigError("storage_dir_not_absolute");

  const cameras = new VisionCameraService(deps.pool);
  const inventory = new VisionInventoryService(deps.pool);
  const snapshots = flags.storeSnapshots && flags.storageDir !== undefined
    ? new VisionSnapshotService(deps.pool, new LocalFsStorageAdapter(flags.storageDir), deps.vision, { maxStoredBytes: envInt("JARVIS_VISION_MAX_STORED_MB", 2048, { min: 16, max: 10_000_000 }, deps.env) * 1024 * 1024 })
    : undefined;
  let embeddings: VisionEmbeddingService | undefined;
  try {
    embeddings = new VisionEmbeddingService(deps.pool, deps.memoryEmbedding);
  } catch (err) {
    // Kun lokal embedding (fail-closed): en sky-provider gir ingen objektvektorer - «sist sett» faller til eksakte treff.
    console.error(JSON.stringify({ msg: "vision_embeddings_disabled", code: (err as Error).name }));
  }
  // Review A-M2: tidsavbruddet fra JARVIS_VISION_MODEL_TIMEOUT_MS går inn i klassifisereren (per kall via gatewayen), ikke bare i adapterens konstruktør.
  const classifier = flags.classifier ? new VisionClassifier({ gateway: deps.gateway, timeoutMs: visionModelTimeoutMs(deps.env) }) : undefined;
  const pipeline = new VisionIngestPipeline({ pool: deps.pool, vision: deps.vision, classifier, snapshots, embeddings, inventory, enabled: true, storeSnapshots: snapshots !== undefined });
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
  return {
    flags,
    api: { cameras, capture, lastSeen, inventory, maxUploadBytes: 5 * 1024 * 1024 },
    pipeline,
    classifier,
    poller,
    pollerHandle,
    async lightMaintenance(): Promise<void> {
      await runVisionMaintenanceSweepForAllTenants(deps.pool, maintenanceDeps, { light: true });
    },
    async fullMaintenance() {
      return runVisionMaintenanceSweepForAllTenants(deps.pool, maintenanceDeps);
    },
    stop(): void {
      pollerHandle?.stop();
    }
  };
}
