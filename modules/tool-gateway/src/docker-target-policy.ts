/**
 * D-105 host-fix (Tobias sin eksplisitte D-41-avgjørelse - se DECISIONS_AND_
 * ASSUMPTIONS.md): mål-autorisasjon for Docker-mutasjon FLYTTET UT AV
 * transporten (`docker-transport.ts` transporterer nå kun - INGEN permanent
 * forretningsregel der) og inn på policy-/orkestreringsgrensen. Håndheves av
 * `ToolGateway.execute()` selv via `ToolDefinition.parameterAuthorizer` (se
 * gateway.ts) - SAMME håndhevelsespunkt uansett innslagsvei (dedikert REST-
 * rute I DAG, en fremtidig samtale-drevet verktøykalls-vei I MORGEN) - ALDRI
 * et sted en transport-spesifikk regel kan omgås ved å kalle gateway.execute()
 * direkte.
 *
 * To tiers, EKSPLISITT atskilt:
 *  - `jarvis-sentinel-*`: AKSEPTANSE-ONLY. Alltid tillatt for ALLE muterende
 *    docker-handlinger (host-akseptanse-runboken, D105_INFRA_OPS_V2_HOST_
 *    ACCEPTANCE.md, bruker UTELUKKENDE denne veien mot et disponibelt
 *    engangsmål - ALDRI en ekte tjeneste).
 *  - eier-konfigurert (`JARVIS_DOCKER_MUTATION_TARGETS`): PRODUKSJON. Tillatt
 *    KUN for handlinger som er BEVIST trygge mot en ekte kjørende tjeneste
 *    (se `PRODUCTION_SAFE_ACTIONS` under).
 *
 * `redeploy_container` sin nåværende implementasjon (docker-transport.ts:
 * rm -f + run -d, KUN navn/image bevart) er IKKE bevist trygg mot en ekte
 * produksjonscontainer - mounts/miljøvariabler/nettverk/porter/restart-
 * policy/healthcheck/entrypoint/command GÅR TAPT ved en slik rekonstruksjon.
 * Den forblir derfor STRUKTURELT DEFERRED for produksjon (kun sentinel-mål)
 * inntil en konfigurasjonsbevarende redeploy er bygget og bevist (se D-105-
 * raden i DECISIONS_AND_ASSUMPTIONS.md, "REDEPLOY_DEFERRED_FOR_PRODUCTION").
 * `stop_container`/`start_container` endrer IKKE containerens konfigurasjon
 * i det hele tatt (ren kjøretilstand, ingenting å miste) - BEVIST trygg,
 * derfor de ENESTE produksjons-autoriserte mutasjonsklassene i denne sliceen.
 */
const SENTINEL_PREFIX = "jarvis-sentinel-";

export type DockerMutationAction = "redeploy_container" | "stop_container" | "start_container";

const PRODUCTION_SAFE_ACTIONS: ReadonlySet<DockerMutationAction> = new Set(["stop_container", "start_container"]);

/** Docker sitt eget navnealfabet (samme mønster brukt til input-validering i docker-transport.ts). */
const VALID_TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isSentinelTarget(name: string): boolean {
  return name.startsWith(SENTINEL_PREFIX);
}

/**
 * Parser `JARVIS_DOCKER_MUTATION_TARGETS` - kommaseparert liste av EKSAKTE,
 * eier-navngitte produksjonscontainere Tobias har autorisert for docker-
 * mutasjon. EKSAKT match (INGEN wildcard/prefiks-tolkning - unngår
 * utilsiktet bred autorisasjon, jf. byggeordrens §4 "avoid unsafe broad
 * wildcard parsing"). Et ugyldig enkeltnavn (feil tegnsett) HOPPES OVER
 * (ALDRI en løs/gjettet autorisasjon for resten av listen); tom/manglende
 * verdi -> tomt sett. Sentinel-navn ekskluderes eksplisitt fra det
 * PRODUKSJONS-autoriserte settet - sentinel er/forblir KUN akseptanse-tier,
 * uavhengig av hva som (feilaktig) står i denne env-variabelen.
 */
export function parseDockerMutationTargets(raw: string | undefined | null): ReadonlySet<string> {
  if (!raw) {
    return new Set();
  }
  const names = new Set<string>();
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name.length === 0) continue;
    if (!VALID_TARGET_NAME.test(name)) continue;
    if (isSentinelTarget(name)) continue;
    names.add(name);
  }
  return names;
}

export interface DockerTargetAuthorization {
  allowed: boolean;
  reason: string;
}

/**
 * Fail-closed i alle retninger: ukonfigurert/ukjent mål -> nektet, en
 * handling utenfor `PRODUCTION_SAFE_ACTIONS` mot et ikke-sentinel mål ->
 * nektet (uansett om målet er konfigurert), ALDRI en stille tillatelse.
 */
export function authorizeDockerTarget(
  action: DockerMutationAction,
  target: string,
  configuredProductionTargets: ReadonlySet<string>
): DockerTargetAuthorization {
  if (isSentinelTarget(target)) {
    return { allowed: true, reason: "acceptance_sentinel_target" };
  }
  if (!PRODUCTION_SAFE_ACTIONS.has(action)) {
    return { allowed: false, reason: "action_deferred_for_production_targets" };
  }
  if (configuredProductionTargets.has(target)) {
    return { allowed: true, reason: "owner_configured_production_target" };
  }
  return { allowed: false, reason: "docker_target_not_authorized" };
}
