/**
 * D-337 (Google Cloud "servere"-sliceen, Tobias sin eksplisitte D-41/Q-41-
 * presisering i chat: "Google cloud skal være Google ads alle servere...").
 * SAMME mønster som `docker-target-policy.ts` (D-105 host-fix) - mål-
 * autorisasjon for GCE-mutasjon FLYTTET UT AV transporten (`gce-transport.ts`
 * transporterer rent - se dens filhode) og inn på policy-/orkestrerings-
 * grensen. Håndheves av `ToolGateway.execute()` selv via `ToolDefinition.
 * parameterAuthorizer` (se gateway.ts) - SAMME håndhevelsespunkt uansett
 * innslagsvei, ALDRI et sted en transport-spesifikk regel kan omgås ved å
 * kalle gateway.execute() direkte.
 *
 * To tiers, EKSPLISITT atskilt (SAMME struktur som Docker):
 *  - `jarvis-sentinel-*`: AKSEPTANSE-ONLY. Alltid tillatt for ALLE muterende
 *    GCE-handlinger mot et disponibelt engangsmål - ALDRI en ekte tjeneste.
 *  - eier-konfigurert (`JARVIS_GCE_MUTATION_TARGETS`): PRODUKSJON. Tillatt
 *    KUN for handlinger som er BEVIST trygge mot en ekte kjørende instans
 *    (se `PRODUCTION_SAFE_ACTIONS` under).
 *
 * `reset_instance` er en HARD reboot - i motsetning til `start_instance`/
 * `stop_instance` (som KUN endrer kjøretilstand, ingen data går tapt) kan en
 * reset kappe pågående skriving/tilkoblinger midt i (samme risikoklasse som
 * Docker sin `redeploy_container` - IKKE bevist trygg mot en ekte
 * produksjonsinstans). Den forblir derfor STRUKTURELT DEFERRED for
 * produksjon (kun `jarvis-sentinel-*`, host-akseptanse) inntil egen
 * vurdering er gjort - se D-337 i DECISIONS_AND_ASSUMPTIONS.md.
 *
 * Mål-formatet er en SAMMENSATT streng `zone/instance` (GCE sin egen
 * URL-path-adressering, `projects/{project}/zones/{zone}/instances/
 * {instance}`) - prosjektet er FAST (ÉN `JARVIS_GOOGLE_CLOUD_PROJECT_ID`,
 * ikke en del av mål-strengen), men zone+instance MÅ begge autoriseres
 * eksplisitt (samme instans-NAVN kan gjenbrukes på tvers av soner).
 */
const SENTINEL_PREFIX = "jarvis-sentinel-";

export type GceMutationAction = "start_instance" | "stop_instance" | "reset_instance";

const PRODUCTION_SAFE_ACTIONS: ReadonlySet<GceMutationAction> = new Set(["start_instance", "stop_instance"]);

/** GCE sitt eget instans-navnealfabet (RFC 1035-lignende: lowercase, siffer, bindestrek, MÅ starte med bokstav). Sonenavn følger samme mønster (f.eks. `europe-west1-b`). */
const VALID_TARGET_PART = /^[a-z][a-z0-9-]{0,62}$/;

export function isGceSentinelTarget(instanceName: string): boolean {
  return instanceName.startsWith(SENTINEL_PREFIX);
}

function compositeTarget(zone: string, instanceName: string): string {
  return `${zone}/${instanceName}`;
}

/**
 * Parser `JARVIS_GCE_MUTATION_TARGETS` - kommaseparert liste av EKSAKTE,
 * eier-navngitte `zone/instance`-par Tobias har autorisert for GCE-mutasjon.
 * EKSAKT match (INGEN wildcard/prefiks-tolkning, samme "unngå utilsiktet
 * bred autorisasjon"-disiplin som Docker). Et ugyldig enkeltpar (feil
 * tegnsett, mangler "/") HOPPES OVER (ALDRI en løs/gjettet autorisasjon for
 * resten av listen); tom/manglende verdi -> tomt sett. Sentinel-instansnavn
 * ekskluderes eksplisitt fra det PRODUKSJONS-autoriserte settet.
 */
export function parseGceMutationTargets(raw: string | undefined | null): ReadonlySet<string> {
  if (!raw) {
    return new Set();
  }
  const targets = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx <= 0 || slashIdx === trimmed.length - 1) continue;
    const zone = trimmed.slice(0, slashIdx);
    const instanceName = trimmed.slice(slashIdx + 1);
    if (!VALID_TARGET_PART.test(zone) || !VALID_TARGET_PART.test(instanceName)) continue;
    if (isGceSentinelTarget(instanceName)) continue;
    targets.add(compositeTarget(zone, instanceName));
  }
  return targets;
}

export interface GceTargetAuthorization {
  allowed: boolean;
  reason: string;
}

/**
 * Fail-closed i alle retninger: ukonfigurert/ukjent mål -> nektet, en
 * handling utenfor `PRODUCTION_SAFE_ACTIONS` mot et ikke-sentinel mål ->
 * nektet (uansett om målet er konfigurert), ALDRI en stille tillatelse.
 */
export function authorizeGceTarget(
  action: GceMutationAction,
  zone: string,
  instanceName: string,
  configuredProductionTargets: ReadonlySet<string>
): GceTargetAuthorization {
  if (isGceSentinelTarget(instanceName)) {
    return { allowed: true, reason: "acceptance_sentinel_target" };
  }
  if (!PRODUCTION_SAFE_ACTIONS.has(action)) {
    return { allowed: false, reason: "action_deferred_for_production_targets" };
  }
  if (configuredProductionTargets.has(compositeTarget(zone, instanceName))) {
    return { allowed: true, reason: "owner_configured_production_target" };
  }
  return { allowed: false, reason: "gce_target_not_authorized" };
}
