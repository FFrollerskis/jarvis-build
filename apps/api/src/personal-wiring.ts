import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import {
  HOME_CRITICAL_OPS, HOME_CRITICAL_READ_ACTION, HOME_ASSISTANT_TOOL_ID, HomeAssistantCriticalTransport, PERSONAL_FLAG_NAMES, PERSONAL_SECRET_REFS, PersonalActionJournal,
  executePersonalAction, homeCriticalConfigFromEnv, homeCriticalToolDefinitions, legacyCriticalActionsToDrop, personalActionIndex, personalFlagOn,
  type ExecutePersonalActionInput, type PersonalActionIndexEntry, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import type { PersonalActionDomainDeps, PersonalApiDeps } from "./personal-routes.ts";

/**
 * WP-G2 (D-464, UA-8 Personal Twin): ÉN komposisjonsfunksjon for hele personlig-domenet (verktøy + rute-avhengigheter + oppstartslogg). ALT er dormant: uten `JARVIS_PERSONAL_*`-flagg returnerer den tom verktøyliste,
 * identitets-filter og `deps: undefined` - verktøylister, utvalg, rate-grenser og ruter er da identiske med main (bevist av `wpg2-personal-flag-off-identity.test.ts`). Kun API-prosessen kaller den (worker/bakgrunn er read-only).
 * `main.ts` trenger tre små kroker: `...personal.tools` blant tilleggsverktøyene, `personal.filterTools(...)` rundt `firstWaveTools(...)` og `...(personal.deps ? { personal: personal.deps } : {})` i `ApiDeps`.
 */
export interface PersonalWiring {
  /** Verktøy som skal registreres (tom uten flagg). */
  tools: ToolDefinition[];
  /** Identitet uten flagg. Med `JARVIS_PERSONAL_HOME_CRITICAL=on` fjernes de gamle uherdede `home-assistant.lock_set`/`alarm_set` (ellers ville de leve side om side med den strenge familien uten allowlist og step-up). */
  filterTools(tools: ToolDefinition[]): ToolDefinition[];
  /** Rute-avhengigheter; `undefined` uten noe flagg (da finnes ikke `/personal/*`). */
  deps: PersonalApiDeps | undefined;
  /** Oppstartslogg: `null` uten flagg (ingen ekstra loggline, oppstarten er identisk med main). */
  describe(): Record<string, unknown> | null;
}

export interface PersonalWiringInput {
  env: Readonly<Record<string, string | undefined>>;
  pool: pg.Pool;
  gateway: Pick<ToolGateway, "execute" | "get">;
  /** Leser en hemmelighet/konfig via vault-referanse (aldri fra parametre). */
  readSecret: (ref: string) => Promise<string | null>;
}

export function createPersonalWiring(input: PersonalWiringInput): PersonalWiring {
  const { env, pool, gateway, readSecret } = input;
  const tools: ToolDefinition[] = [];
  const entries: PersonalActionIndexEntry[] = [];
  const domains = new Map<string, PersonalActionDomainDeps>();
  const log: Record<string, unknown> = {};
  let dropLegacyHome = false;

  if (personalFlagOn(env, PERSONAL_FLAG_NAMES.homeCritical)) {
    const config = homeCriticalConfigFromEnv(env);
    const transport = new HomeAssistantCriticalTransport({
      baseUrl: () => readSecret("JARVIS_HA_BASE_URL"), alarmCode: () => readSecret(PERSONAL_SECRET_REFS.homeAlarmCode), settleMs: config.settleMs, pollMs: config.pollMs
    });
    tools.push(...homeCriticalToolDefinitions(transport, config));
    dropLegacyHome = true;
    domains.set("home", { toolId: HOME_ASSISTANT_TOOL_ID, readAction: HOME_CRITICAL_READ_ACTION });
    entries.push(...HOME_CRITICAL_OPS.map((op): PersonalActionIndexEntry => ({ domain: "home", toolId: HOME_ASSISTANT_TOOL_ID, op })));
    // `targets: 0` er en gyldig (fail-closed) tilstand: verktøyene finnes, men hver mutasjon nektes til eieren har listet sine egne entiteter.
    log["home_critical"] = { targets: config.targets.size, settle_ms: config.settleMs, legacy_lock_alarm_removed: true };
  }

  const executor = { pool, gateway, journal: new PersonalActionJournal(pool), index: personalActionIndex(entries) };
  const actions = domains.size > 0 ? { executor, domains, run: (identity: IdentityContext, request: ExecutePersonalActionInput) => executePersonalAction(executor, identity, request) } : undefined;
  const deps: PersonalApiDeps | undefined = actions ? { actions } : undefined;
  return {
    tools,
    filterTools: (all) => (dropLegacyHome ? legacyCriticalActionsToDrop(all) : all),
    deps,
    describe: () => (Object.keys(log).length === 0 ? null : { msg: "personal_twin", ...log })
  };
}
