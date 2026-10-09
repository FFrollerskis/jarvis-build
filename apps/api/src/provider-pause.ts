// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { DEFAULT_PROFILES, type ProviderPauseSource } from "@jarvis/model-gateway";
import { OwnerControlsService, type OwnerControlsDeviceRevocationDeps } from "@jarvis/owner-controls";
import { KillSwitch, OwnerControls } from "@jarvis/policy";
import { CONNECTOR_REGISTRY, type ConnectorDefinition } from "@jarvis/tool-gateway";

/**
 * WP-H0 / JARVIS-087 (UA-11): eierens pause og tilbakekall av en MODELLLEVERANDØR - uten ny skrivevei og uten ny tabell.
 *
 * To EKSISTERENDE eierbrytere (`owner_control_state`, varig og delt mellom api og worker, eier-autoritet håndheves i `OwnerControls`) gjelder nå også modellleverandørene:
 *  - PAUSE: `executive.freeze_connector` med `connector_id = "model:<leverandør>"` (f.eks. `model:anthropic`). Navnerommet `model:` kan aldri kollidere med et `tool_id` (ToolGateway fryser på tool_id), så en
 *    modellpause stanser ikke et verktøy og omvendt. Gjenopptak = `executive.unfreeze_connector` med samme mål. Pause stopper ting og krever derfor ikke step-up; å gjenoppta krever det.
 *  - TILBAKEKALL: `executive.revoke_credential` på leverandørens credential-ref (f.eks. `ANTHROPIC_API_KEY`). Før dette stanset et tilbakekall kun verktøy som bruker nøkkelen; adapterne leser nøkkelen direkte
 *    fra miljøet og så aldri tilbakekallet. Nå gjelder det også ModelGateway-rutingen. Verdien slettes aldri.
 *
 * `ModelGateway` leser dette LIVE ved hvert kall (`ProviderPauseSource`), så en pause virker umiddelbart, uten omstart, i begge prosessene. Auditert av de eksisterende veiene: ToolGateway skriver
 * `tool.executed` for hver mutasjon, og `owner_control_state` bærer aktør og tidspunkt.
 */
export const MODEL_FREEZE_PREFIX = "model:";

/** Frys-målet for en modellleverandør i `connector_freeze` (`model:anthropic`). */
export function modelFreezeTarget(provider: string): string {
  return `${MODEL_FREEZE_PREFIX}${provider}`;
}

const PROVIDER_NAME = /^[a-z0-9_]{1,40}$/;

/** Leverandørnavnet i et frys-mål (`model:anthropic` → `anthropic`), eller null når målet ikke er en modellpause (verktøy-id, tomt eller ugyldig navn). */
export function providerOfFreezeTarget(target: string): string | null {
  if (!target.startsWith(MODEL_FREEZE_PREFIX)) return null;
  const name = target.slice(MODEL_FREEZE_PREFIX.length);
  return PROVIDER_NAME.test(name) ? name : null;
}

/**
 * Kjente modellleverandører = modellregisteret (profilene i `DEFAULT_PROFILES`, som dekker alle adaptere) pluss leverandørene som har en nøkkel (`providerCredentialRefs`). Samme navn som `ModelGateway` ruter på.
 */
export function knownModelProviders(registry: readonly ConnectorDefinition[] = CONNECTOR_REGISTRY): ReadonlySet<string> {
  return new Set<string>([...DEFAULT_PROFILES.map((p) => p.provider), ...providerCredentialRefs(registry).keys()]);
}

/**
 * Gjennomgang av PR #316 (L-5): validering av et frys-mål ved SKRIVING. Uten denne ga `model:Anthropic` (stor bokstav), `model:` eller `model:finnes_ikke` «Utført» uten å pause noe: raden ble lagret, men
 * `providerOfFreezeTarget` leser bare små bokstaver/tall/understrek, og ingen leverandør har navnet, så eieren trodde leverandøren var stanset mens den fortsatt ble brukt.
 * Returnerer `null` når målet er greit (et vanlig `tool_id` røres ikke - den veien er uendret), ellers en kort feilkode som vises til eieren. Gjelder KUN frysing: å gjenoppta et (gammelt, ugyldig) mål skal
 * alltid være mulig.
 */
export function freezeTargetError(target: string, known: ReadonlySet<string> = knownModelProviders()): string | null {
  if (!target.startsWith(MODEL_FREEZE_PREFIX)) return null;
  const name = target.slice(MODEL_FREEZE_PREFIX.length);
  const shown = name.slice(0, 40).replace(/[^A-Za-z0-9_.:-]/g, "?");
  if (!PROVIDER_NAME.test(name)) return `invalid_model_freeze_target:${shown}`;
  if (!known.has(name)) return `unknown_model_provider:${shown}`;
  return null;
}

/**
 * Gjennomgang av PR #316 (L-5, wiring-vakt): ENESTE måte produksjonskoden lager en `OwnerControlsService` på. Den kobler alltid `freezeTargetValidator` (`model:<leverandør>` valideres mot modellregisteret ved frysing), slik at
 * en ny konstruksjon i `main.ts` ikke stille kan hoppe over validatoren (en test leser kildefilene og avviser enhver `new OwnerControlsService(` utenfor denne filen - samme mønster som `createControlCenterRegistry`, M-2).
 */
export function createOwnerControlsService(killSwitch: KillSwitch, ownerControls: OwnerControls, deviceRevocation?: OwnerControlsDeviceRevocationDeps): OwnerControlsService {
  return new OwnerControlsService(killSwitch, ownerControls, deviceRevocation, { freezeTargetValidator: (target) => freezeTargetError(target) });
}

/**
 * Hvilke credential-refs hver ModelGateway-leverandør bruker (adapternavn → refs). `anthropic`/`openai`/`gemini` kommer fra connector-registeret (category `model_provider`, id = adapternavn); de øvrige
 * adapterne har ikke en connector-oppføring og står her eksplisitt. Drift-testen låser at hver ref faktisk står i adapterens kildekode. Lokale leverandører (gemma_local, local_llm, ollama) har ingen nøkkel.
 */
const EXTRA_PROVIDER_REFS: Readonly<Record<string, readonly string[]>> = {
  gemma_hosted: ["GEMMA_API_KEY", "GEMINI_API_KEY"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
  hermes: ["HERMES_API_KEY", "NOUS_API_KEY"]
};

export function providerCredentialRefs(registry: readonly ConnectorDefinition[] = CONNECTOR_REGISTRY): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>(Object.entries(EXTRA_PROVIDER_REFS));
  for (const def of registry) if (def.category === "model_provider") map.set(def.id, def.credential_refs);
  return map;
}

/** Hvilke leverandører er pauset gitt frosne mål og tilbakekalte credential-refs? Ren funksjon (testbar uten database). */
export function pausedProvidersFrom(
  frozenTargets: Iterable<string>,
  revokedRefs: Iterable<string>,
  refsByProvider: ReadonlyMap<string, readonly string[]> = providerCredentialRefs()
): ReadonlySet<string> {
  const paused = new Set<string>();
  for (const target of frozenTargets) {
    const name = providerOfFreezeTarget(target);
    if (name !== null) paused.add(name);
  }
  const revoked = new Set(revokedRefs);
  for (const [provider, refs] of refsByProvider) if (refs.some((ref) => revoked.has(ref))) paused.add(provider);
  return paused;
}

export interface ProviderPauseControls {
  listFrozenConnectorsDurable(): Promise<ReadonlyArray<{ connector_id: string }>>;
  listRevokedCredentialsDurable(): Promise<ReadonlyArray<{ credential_ref: string }>>;
}

export function createProviderPauseSource(controls: ProviderPauseControls, refsByProvider?: ReadonlyMap<string, readonly string[]>): ProviderPauseSource {
  return {
    async pausedProviders() {
      const [frozen, revoked] = await Promise.all([controls.listFrozenConnectorsDurable(), controls.listRevokedCredentialsDurable()]);
      return pausedProvidersFrom(frozen.map((f) => f.connector_id), revoked.map((r) => r.credential_ref), refsByProvider);
    }
  };
}

/**
 * Pausekilden for en prosess: en skrivebeskyttet `OwnerControls` over app-poolen (`*Durable()`-listene går rett mot `owner_control_state` og krever ingen autoritet; denne instansen muterer aldri).
 * Brukes likt i api og worker - workeren konstruerer sine egne eierkontroller etter gatewayen, så kilden er selvstendig i stedet for å avhenge av rekkefølgen.
 */
export function createProviderPauseSourceFromPool(pool: pg.Pool): ProviderPauseSource {
  return createProviderPauseSource(new OwnerControls(new KillSwitch(pool), pool));
}
