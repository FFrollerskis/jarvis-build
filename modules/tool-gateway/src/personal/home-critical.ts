import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolTransport } from "../gateway.ts";
import { PERSONAL_CONFIG_NAMES, boundedInt } from "./flags.ts";
import {
  buildCriticalToolDefinitions, cleanToken, parseIsoInstant, type CriticalAuthorization, type CriticalOpSpec, type Params, type RiskDirection
} from "./critical-ops.ts";

/**
 * WP-G2 P1a (D-464, UA-8): KRITISKE HJEMMEHANDLINGER mot Home Assistant (HA er enhetsbuss, aldri samtalemotor - CLAUDE.md regel 5). Jarvis eier handlingsmodellen, journalen og policyen (`JARVIS_CANONICAL`);
 * Home Assistant er utfører og kilde til nåtilstand (`EXTERNAL_CANONICAL`, D-64) - utstyret er ikke noe Jarvis kan gjette seg til.
 *
 * REVISJON AV EKSISTERENDE (`home-assistant.ts`, D-388, Q-34): `lock_set`/`alarm_set` er klasse D med preflight og readback, men (1) `entity` på `lock_set` er et vilkårlig `lock.*` uten eier-allowlist,
 * (2) ingen step-up, (3) alarm-normaliseringen regner `arming`/`disarming`/`pending` som «armert» (en kommando kan dermed «verifiseres» midt i overgangen), (4) readback kommer rett etter kommandoen,
 * uten å vente på at låsen/porten faktisk når sluttilstanden, og (5) ingen journal. Disse er UENDRET (flagg AV er identisk med main). Her bygges en STRENG familie ved siden av, kun med flagget på,
 * og de to gamle klasse D-handlingene fjernes fra registeret samtidig (se `legacyCriticalActionsToDrop`) slik at det ikke finnes en parallell vei uten allowlist og step-up.
 *
 * D-41 (maksimal nyttig kapabilitet, A-D styrer HVORDAN): lås/alarm/garasjeport(cover)/ventil/bryter/scene/skript/klima-modus er bygget; delvis posisjon for cover/ventil
 * (`set_cover_position`/`set_valve_position`), `lock.open` (åpne fallen), `input_boolean`, `fan`/`humidifier` og skript-variabler er `DEFERRED` (se runbook). Fakta verifisert mot offisiell HA-dokumentasjon
 * 2026-11-18 (søk): tilstandsnavn og tjenester for lock/alarm/cover/valve/switch/climate/scene/script og at `POST /api/services/<domain>/<service>` blokkerer til tjenesten er ferdig og svarer med endrede tilstander.
 * IKKE verifisert (`unverified`): om HA-integrasjonen for en gitt lås/port oppdaterer tilstanden synkront med tjenestekallet (derfor vente-løkken), og alarmpanel-kodekrav per panel.
 */

export const HOME_ASSISTANT_TOOL_ID = "home-assistant";
export const HOME_ASSISTANT_CREDENTIAL_REF = "JARVIS_HA_TOKEN";
/** Registerets connector-id for Home Assistant (en eier-frys på denne gjelder også den strenge familien; `tool_id`-frysen gjelder uansett). */
export const HOME_ASSISTANT_CONNECTOR_ID = "home_assistant";
/** Starter med `read` (READ_VERB i tool-manifestet): manifestet utleder effekten «read» uten en egen overstyring. */
export const HOME_CRITICAL_READ_ACTION = "read_critical_state";

/** De gamle, uherdede klasse D-handlingene som ikke skal leve side om side med den strenge familien når flagget er på. */
export const LEGACY_HOME_CRITICAL_ACTIONS: readonly string[] = ["lock_set", "alarm_set"];

/** Fjerner `lock_set`/`alarm_set` fra en definisjonsliste (brukes av registreringen KUN med flagget på). Alt annet er uendret og i samme rekkefølge. */
export function legacyCriticalActionsToDrop(definitions: readonly ToolDefinition[]): ToolDefinition[] {
  return definitions.filter((d) => !(d.tool_id === HOME_ASSISTANT_TOOL_ID && LEGACY_HOME_CRITICAL_ACTIONS.includes(d.action)));
}

// ---------------------------------------------------------------------------------------------------------------------
// Konfigurasjon og mål-allowlist
// ---------------------------------------------------------------------------------------------------------------------

export const HOME_CRITICAL_DOMAINS = ["lock", "alarm_control_panel", "cover", "valve", "switch", "scene", "script", "climate"] as const;
export type HomeCriticalDomain = (typeof HOME_CRITICAL_DOMAINS)[number];

const ENTITY_ID = /^(lock|alarm_control_panel|cover|valve|switch|scene|script|climate)\.[a-z0-9_]{1,100}$/;

/** Er verdien en gyldig kritisk hjem-entitets-id (domene fra den lukkede listen + `[a-z0-9_]`)? */
export const isHomeCriticalEntityId = (value: unknown): value is string => typeof value === "string" && ENTITY_ID.test(value);

/** Standard ventetid på sluttilstand (lås, port, ventil, bryter, klima, scene, skript). */
export const HOME_DEFAULT_SETTLE_MS = 20_000;
/** Alarmpaneler har utgangsforsinkelse (armering viser `arming` i 30 s eller mer): egen, lengre standard. */
export const HOME_ALARM_DEFAULT_SETTLE_MS = 90_000;
const HOME_SETTLE_MIN_MS = 3_000;
const HOME_SETTLE_MAX_MS = 300_000;

export interface HomeCriticalConfig {
  /** Eierens EGNE entitets-id-er (eksakt match). Tom = ingen mutasjon er tillatt. */
  readonly targets: ReadonlySet<string>;
  /** Standard ventetid på at utstyret når en sluttilstand før utfallet regnes som UKJENT (gjelder domener uten egen verdi i `settleMsByDomain`). */
  readonly settleMs: number;
  readonly pollMs: number;
  /** Ventetid per domene (alarm lengst: utgangsforsinkelse). Mangler et domene her, gjelder `settleMs`. */
  readonly settleMsByDomain?: Readonly<Partial<Record<HomeCriticalDomain, number>>>;
}

/** Handling -> domenet den virker på (ventetid og tjenestekall følger domenet). */
export const HOME_ACTION_DOMAIN: Readonly<Record<string, HomeCriticalDomain>> = {
  critical_lock: "lock", critical_alarm: "alarm_control_panel", critical_cover: "cover", critical_valve: "valve", critical_switch: "switch", critical_scene: "scene", critical_script: "script", critical_climate_mode: "climate"
};

/** Parser `domene=ms`-par (komma/mellomrom): kun kjente domener og verdier innenfor [3000, 300000]; alt annet hoppes over (domenet får standarden). Aldri en stille klemming. */
export function parseHomeSettleByDomain(raw: string | undefined | null): Partial<Record<HomeCriticalDomain, number>> {
  const out: Partial<Record<HomeCriticalDomain, number>> = {};
  if (!raw) return out;
  for (const part of raw.split(/[\s,]+/).filter((p) => p.length > 0)) {
    const [domain, value] = part.split("=");
    if (domain === undefined || value === undefined || !(HOME_CRITICAL_DOMAINS as readonly string[]).includes(domain)) continue;
    const ms = boundedInt(value, HOME_SETTLE_MIN_MS, HOME_SETTLE_MAX_MS, -1);
    if (ms > 0) out[domain as HomeCriticalDomain] = ms;
  }
  return out;
}

/** Ventetiden for et domene: domenets egen verdi hvis konfigurasjonen har en, ellers den globale. (Alarmens lengre standard legges inn av `homeCriticalConfigFromEnv`, ikke skjult her.) */
export function homeSettleMsFor(config: Pick<HomeCriticalConfig, "settleMs" | "settleMsByDomain">, domain: string): number {
  return config.settleMsByDomain?.[domain as HomeCriticalDomain] ?? config.settleMs;
}

/** Parser `JARVIS_PERSONAL_HOME_TARGETS` (kommaseparert). Ugyldige oppføringer (feil domene, feil form, jokertegn) HOPPES OVER - aldri en løs autorisasjon for resten. */
export function parseHomeTargets(raw: string | undefined | null): ReadonlySet<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (ENTITY_ID.test(id)) out.add(id);
  }
  return out;
}

export function homeCriticalConfigFromEnv(env: Readonly<Record<string, string | undefined>>): HomeCriticalConfig {
  const settleMs = boundedInt(env[PERSONAL_CONFIG_NAMES.homeSettleMs], HOME_SETTLE_MIN_MS, 120_000, HOME_DEFAULT_SETTLE_MS);
  return {
    targets: parseHomeTargets(env[PERSONAL_CONFIG_NAMES.homeTargets]), settleMs, pollMs: Math.max(250, Math.min(2_000, Math.floor(settleMs / 20))),
    // Alarmpaneler har utgangsforsinkelse: egen, lengre standard (aldri kortere enn den globale), som eieren kan overstyre per domene.
    settleMsByDomain: { alarm_control_panel: Math.max(settleMs, HOME_ALARM_DEFAULT_SETTLE_MS), ...parseHomeSettleByDomain(env[PERSONAL_CONFIG_NAMES.homeSettleByDomain]) }
  };
}

/** Fail-closed mål-autorisasjon: målet må stå EKSAKT i eierens liste (store/små bokstaver likegyldig). Årsaken røper aldri hvilke mål som finnes. */
export function authorizeHomeTarget(targetParam: string, parameters: Params, config: Pick<HomeCriticalConfig, "targets">): CriticalAuthorization {
  const raw = parameters[targetParam];
  if (typeof raw !== "string" || !ENTITY_ID.test(raw.toLowerCase())) return { allowed: false, reason: "missing_or_invalid_target" };
  return config.targets.has(raw.toLowerCase()) ? { allowed: true, reason: "owner_configured_target" } : { allowed: false, reason: "home_target_not_authorized" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Normalisert tilstand (kun enumererte tilstandsord, tall og tidsstempler - aldri fritekst-attributter fra utstyret)
// ---------------------------------------------------------------------------------------------------------------------

/** Overgangstilstander per domene (verifisert mot HA-dokumentasjonen): utstyret er på vei, og tilstanden er IKKE en sluttilstand. */
const TRANSITIONAL: Readonly<Record<string, ReadonlySet<string>>> = {
  lock: new Set(["locking", "unlocking", "opening"]),
  alarm_control_panel: new Set(["arming", "pending", "disarming"]),
  cover: new Set(["opening", "closing"]),
  valve: new Set(["opening", "closing"])
};
const HVAC_MODES: readonly string[] = ["off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only"];

/**
 * LUKKET liste over tilstandsord per domene (HA-dokumentasjonen). Utstyrets tilstand er ubetrodd tekst (en lås/integrasjon kan rapportere hva som helst): alt som ikke står her blir `unknown` FØR det når varsel, ledger, audit
 * eller journal (review A, LOW-7). Scene har en tidsstempel-tilstand og håndteres for seg.
 */
const STATE_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  lock: new Set(["locked", "unlocked", "locking", "unlocking", "jammed", "open", "opening", "unavailable", "unknown"]),
  alarm_control_panel: new Set(["disarmed", "armed_home", "armed_away", "armed_night", "armed_vacation", "armed_custom_bypass", "pending", "arming", "disarming", "triggered", "unavailable", "unknown"]),
  cover: new Set(["open", "closed", "opening", "closing", "unavailable", "unknown"]),
  valve: new Set(["open", "closed", "opening", "closing", "unavailable", "unknown"]),
  switch: new Set(["on", "off", "unavailable", "unknown"]),
  script: new Set(["on", "off", "unavailable", "unknown"]),
  climate: new Set([...HVAC_MODES, "unavailable", "unknown"])
};

function stateWordFor(domain: string, raw: string): string {
  if (domain === "scene") return raw === "unavailable" || raw === "unknown" || parseIsoInstant(raw) !== null ? raw : "unknown";
  return STATE_WORDS[domain]?.has(raw) === true ? raw : "unknown";
}

export interface RawHomeEntity {
  entity_id: string;
  state: unknown;
  attributes?: Record<string, unknown> | undefined;
}

export function normalizeHomeCriticalState(entity: RawHomeEntity): Params {
  const entityId = cleanToken(entity.entity_id, 120).toLowerCase();
  const domain = entityId.split(".")[0] ?? "";
  const state = stateWordFor(domain, cleanToken(entity.state));
  const attributes = entity.attributes ?? {};
  const out: Params = {
    entity_id: entityId, domain, state, settled: !(TRANSITIONAL[domain]?.has(state) ?? false),
    usable: state !== "unavailable" && !(state === "unknown" && domain !== "scene")
  };
  switch (domain) {
    case "lock": out["locked"] = state === "locked"; break;
    case "alarm_control_panel": out["armed"] = state.startsWith("armed_"); break;
    case "cover":
    case "valve": {
      const position = attributes["current_position"];
      out["current_position"] = typeof position === "number" && Number.isFinite(position) ? position : null;
      break;
    }
    case "scene": out["last_activated"] = parseIsoInstant(state) === null ? null : state; break;
    case "script": {
      const triggered = cleanToken(attributes["last_triggered"]);
      out["last_triggered"] = parseIsoInstant(triggered) === null ? null : triggered;
      out["running"] = state === "on";
      break;
    }
    case "climate": {
      const modes = attributes["hvac_modes"];
      out["hvac_modes"] = Array.isArray(modes) ? modes.filter((m): m is string => typeof m === "string" && HVAC_MODES.includes(m)) : [];
      break;
    }
    default: break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Handlingene (ren data - ingen nettverk, ingen hemmeligheter)
// ---------------------------------------------------------------------------------------------------------------------

const entityOf = (domain: HomeCriticalDomain) => z.string().regex(new RegExp(`^${domain}\\.[a-z0-9_]{1,100}$`));
const expectedState = z.string().min(1).max(40).optional();

function baseValidation(before: Params, p: Params, opts: { requireSettled?: boolean } = {}): string | null {
  if (before["usable"] !== true) return before["state"] === "unavailable" ? "entity_unavailable" : "entity_state_unknown";
  if (opts.requireSettled !== false && before["settled"] !== true) return "entity_in_transition";
  const expected = p["expected_state"];
  if (typeof expected === "string" && before["state"] !== expected) return "precondition_changed";
  return null;
}

const stateWord = (state: Params | null): string => (state === null ? "ukjent" : String(state["state"] ?? "ukjent"));
const targetOf = (p: Params): string => String(p["entity"] ?? "");

/** Standard rollback-tekster: kort, handlingsrettet og ærlig om hva som IKKE kan angres automatisk. */
const REVERT_BY_OPPOSITE = "send motsatt kommando via samme handling (ny idempotensnøkkel) og bekreft readback; før-tilstanden står i journalen og i varselet";

export const HOME_CRITICAL_OPS: readonly CriticalOpSpec[] = [
  {
    action: "critical_lock", label: "lås", description: "Lås eller lås opp en dør/lås (KRITISK, klasse D): kun eierens egne lås-entiteter, step-up, readback av faktisk sluttilstand (låst/ulåst) og umiddelbart varsel",
    shape: { entity: entityOf("lock"), locked: z.boolean(), expected_state: expectedState }, targetParam: "entity",
    direction: (p) => (p["locked"] === true ? "reduces" : "increases"),
    validate: (before, p) => baseValidation(before, p) ?? (before["state"] === "jammed" ? "lock_jammed" : null),
    post: (after, p) => after["state"] === (p["locked"] === true ? "locked" : "unlocked"),
    summary: (state, p) => `lås ${targetOf(p)}: ${stateWord(state)} -> ${p["locked"] === true ? "locked" : "unlocked"} (ønsket)`,
    rollback: `sett motsatt låstilstand og varsle: ${REVERT_BY_OPPOSITE}`, idempotentExternal: true, scopes: ["lock:call"]
  },
  {
    action: "critical_alarm", label: "alarm", description: "Slå alarmpanelet av/på (KRITISK, klasse D): armer (borte/hjemme/natt/ferie) eller avarmer; kun eierens egne alarm-entiteter, step-up, readback av faktisk sluttilstand (ikke «arming»/«disarming») og umiddelbart varsel",
    shape: { entity: entityOf("alarm_control_panel"), armed: z.boolean(), mode: z.enum(["away", "home", "night", "vacation"]).optional(), expected_state: expectedState }, targetParam: "entity",
    direction: (p) => (p["armed"] === true ? "reduces" : "increases"),
    validate: (before, p) => {
      if (p["armed"] !== true && p["mode"] !== undefined) return "mode_only_for_arm";
      const base = baseValidation(before, p);
      if (base !== null) return base;
      return p["armed"] === true && before["state"] === "triggered" ? "alarm_triggered" : null;
    },
    post: (after, p) => after["state"] === (p["armed"] === true ? `armed_${typeof p["mode"] === "string" ? p["mode"] : "away"}` : "disarmed"),
    summary: (state, p) => `alarm ${targetOf(p)}: ${stateWord(state)} -> ${p["armed"] === true ? `armed_${typeof p["mode"] === "string" ? p["mode"] : "away"}` : "disarmed"} (ønsket)`,
    rollback: `sett forrige alarmtilstand og varsle: ${REVERT_BY_OPPOSITE}`, idempotentExternal: true, scopes: ["alarm:call"]
  },
  {
    action: "critical_cover", label: "port/cover", description: "Åpne eller lukk en garasjeport/cover (KRITISK, klasse D): kun eierens egne cover-entiteter, step-up, venter på sluttilstand (open/closed, ikke «opening»/«closing»), readback og umiddelbart varsel",
    shape: { entity: entityOf("cover"), target: z.enum(["open", "closed"]), expected_state: expectedState }, targetParam: "entity",
    direction: (p) => (p["target"] === "open" ? "increases" : "reduces"),
    validate: (before, p) => baseValidation(before, p),
    post: (after, p) => after["state"] === p["target"],
    summary: (state, p) => `cover ${targetOf(p)}: ${stateWord(state)} -> ${String(p["target"])} (ønsket)`,
    rollback: `sett motsatt posisjon og varsle: ${REVERT_BY_OPPOSITE}`, idempotentExternal: true, scopes: ["cover:call"]
  },
  {
    action: "critical_valve", label: "ventil", description: "Åpne eller lukk en ventil (f.eks. hovedvann) (KRITISK, klasse D): kun eierens egne valve-entiteter, step-up, venter på sluttilstand, readback og umiddelbart varsel",
    shape: { entity: entityOf("valve"), target: z.enum(["open", "closed"]), expected_state: expectedState }, targetParam: "entity",
    direction: (p) => (p["target"] === "open" ? "increases" : "reduces"),
    validate: (before, p) => baseValidation(before, p),
    post: (after, p) => after["state"] === p["target"],
    summary: (state, p) => `ventil ${targetOf(p)}: ${stateWord(state)} -> ${String(p["target"])} (ønsket)`,
    rollback: `sett motsatt ventilstilling og varsle: ${REVERT_BY_OPPOSITE}`, idempotentExternal: true, scopes: ["valve:call"]
  },
  {
    action: "critical_switch", label: "bryter", description: "Slå en bryter av/på (f.eks. varmtvannsbereder) (KRITISK, klasse D): kun eierens egne switch-entiteter, step-up, readback av faktisk tilstand (on/off) og umiddelbart varsel",
    shape: { entity: entityOf("switch"), on: z.boolean(), expected_state: expectedState }, targetParam: "entity",
    direction: (p) => (p["on"] === true ? "increases" : "reduces"),
    validate: (before, p) => baseValidation(before, p, { requireSettled: false }),
    post: (after, p) => after["state"] === (p["on"] === true ? "on" : "off"),
    summary: (state, p) => `bryter ${targetOf(p)}: ${stateWord(state)} -> ${p["on"] === true ? "on" : "off"} (ønsket)`,
    rollback: `sett motsatt bryterstilling og varsle: ${REVERT_BY_OPPOSITE}`, idempotentExternal: true, scopes: ["switch:call"]
  },
  {
    action: "critical_scene", label: "scene", description: "Aktiver en scene (KRITISK, klasse D): kun eierens egne scene-entiteter, step-up. Scenens tilstand ER tidspunktet for siste aktivering, så `expected_last_activated` (fra forhåndsvisningen) MÅ oppgis og readback krever et nyere tidspunkt",
    shape: { entity: entityOf("scene"), expected_last_activated: z.union([z.string().min(1).max(64), z.null()]) }, targetParam: "entity",
    direction: () => "neutral",
    validate: (before, p) => {
      if (before["usable"] !== true) return "entity_unavailable";
      return (before["last_activated"] ?? null) === (p["expected_last_activated"] ?? null) ? null : "precondition_changed";
    },
    post: (after, p) => markerAdvanced(after["last_activated"], p["expected_last_activated"]),
    summary: (_state, p) => `scene ${targetOf(p)} aktivert`,
    rollback: "ingen automatisk tilbakeføring: scenen kan ha endret flere enheter; før-tilstanden for scene-entiteten står i journalen, tilbakestill enhetene manuelt eller med en motsatt scene",
    idempotentExternal: false, irreversible: true, scopes: ["scene:call"]
  },
  {
    action: "critical_script", label: "skript", description: "Start et skript (KRITISK, klasse D): kun eierens egne script-entiteter, step-up, uten variabler. Verifiserer KUN at skriptet STARTET (`last_triggered` er nyere enn `expected_last_triggered` fra forhåndsvisningen), ikke effekten av skriptet (PARTIAL)",
    shape: { entity: entityOf("script"), expected_last_triggered: z.union([z.string().min(1).max(64), z.null()]) }, targetParam: "entity",
    direction: () => "neutral",
    validate: (before, p) => {
      if (before["usable"] !== true) return "entity_unavailable";
      if (before["running"] === true) return "script_already_running";
      return (before["last_triggered"] ?? null) === (p["expected_last_triggered"] ?? null) ? null : "precondition_changed";
    },
    post: (after, p) => markerAdvanced(after["last_triggered"], p["expected_last_triggered"]),
    summary: (_state, p) => `skript ${targetOf(p)} startet`,
    rollback: "ingen automatisk tilbakeføring: skriptet kan ha endret flere enheter og effekten verifiseres ikke; sjekk utstyret skriptet styrer og tilbakestill manuelt",
    idempotentExternal: false, irreversible: true, scopes: ["script:call"]
  },
  {
    action: "critical_climate_mode", label: "klima-modus", description: "Sett klimaanleggets/termostatens modus (off/heat/cool/heat_cool/auto/dry/fan_only) (KRITISK, klasse D): kun eierens egne climate-entiteter, step-up, readback av faktisk modus og umiddelbart varsel. Temperatur settes av det vanlige `climate_set`",
    shape: { entity: entityOf("climate"), hvac_mode: z.enum(["off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only"]), expected_state: expectedState }, targetParam: "entity",
    direction: () => "neutral",
    validate: (before, p) => {
      const base = baseValidation(before, p, { requireSettled: false });
      if (base !== null) return base;
      const modes = before["hvac_modes"];
      return Array.isArray(modes) && modes.length > 0 && !modes.includes(p["hvac_mode"] as JsonValue) ? "hvac_mode_not_supported" : null;
    },
    post: (after, p) => after["state"] === p["hvac_mode"],
    summary: (state, p) => `klima ${targetOf(p)}: ${stateWord(state)} -> ${String(p["hvac_mode"])} (ønsket)`,
    rollback: `sett forrige modus og varsle: ${REVERT_BY_OPPOSITE}`, idempotentExternal: true, scopes: ["climate:call"]
  }
];

/** Markøren (siste aktivering/start) har rykket FREM sammenlignet med før-markøren fra forhåndsvisningen. Ren, uavhengig av klokkeforskjell mellom Jarvis og HA. */
export function markerAdvanced(afterMarker: JsonValue | undefined, beforeMarker: JsonValue | undefined): boolean {
  const after = parseIsoInstant(afterMarker);
  if (after === null) return false;
  const before = parseIsoInstant(beforeMarker);
  return before === null ? true : after > before;
}

export const HOME_CRITICAL_ACTIONS: readonly string[] = HOME_CRITICAL_OPS.map((o) => o.action);

export function homeCriticalDirection(action: string, parameters: Params): RiskDirection {
  return HOME_CRITICAL_OPS.find((o) => o.action === action)?.direction(parameters) ?? "neutral";
}

/** Tjenestekallet (domene/tjeneste/data) en handling tilsvarer. Ren funksjon; alarmkoden legges til av transporten og ligger ALDRI i denne dataen. */
export function homeServiceCall(action: string, p: Params): { domain: string; service: string; data: Params } | null {
  const entity = String(p["entity"] ?? "");
  switch (action) {
    case "critical_lock": return { domain: "lock", service: p["locked"] === true ? "lock" : "unlock", data: { entity_id: entity } };
    case "critical_alarm": {
      const mode = typeof p["mode"] === "string" ? p["mode"] : "away";
      return { domain: "alarm_control_panel", service: p["armed"] === true ? `alarm_arm_${mode}` : "alarm_disarm", data: { entity_id: entity } };
    }
    case "critical_cover": return { domain: "cover", service: p["target"] === "open" ? "open_cover" : "close_cover", data: { entity_id: entity } };
    case "critical_valve": return { domain: "valve", service: p["target"] === "open" ? "open_valve" : "close_valve", data: { entity_id: entity } };
    case "critical_switch": return { domain: "switch", service: p["on"] === true ? "turn_on" : "turn_off", data: { entity_id: entity } };
    case "critical_scene": return { domain: "scene", service: "turn_on", data: { entity_id: entity } };
    case "critical_script": return { domain: "script", service: "turn_on", data: { entity_id: entity } };
    case "critical_climate_mode": return { domain: "climate", service: "set_hvac_mode", data: { entity_id: entity, hvac_mode: String(p["hvac_mode"]) } };
    default: return null;
  }
}

/** Skal transporten vente til tilstanden MATCHER (scene/skript har ingen «sluttilstand» - kun markøren som rykker frem) i stedet for til den er «settled»? */
export const HOME_WAIT_FOR_MATCH_ACTIONS: ReadonlySet<string> = new Set(["critical_scene", "critical_script"]);

/**
 * Gatewayens frist per handling = ventetiden på sluttilstand FOR DOMENET (alarm lengst: utgangsforsinkelse) + rom for to-tre HTTP-kall (lesing, kommando, siste lesing). Er fristen kortere enn ventetiden, blir hver treg
 * handling «utfall ukjent» uten at noe er galt. Gatewayens egen readback kommer ETTER dette kallet og har sin egen frist.
 */
export function homeCriticalTimeoutMs(op: CriticalOpSpec, config: Pick<HomeCriticalConfig, "settleMs" | "settleMsByDomain">): number {
  return homeSettleMsFor(config, HOME_ACTION_DOMAIN[op.action] ?? "") + 25_000;
}

export function homeCriticalToolDefinitions(transport: ToolTransport, config: HomeCriticalConfig): ToolDefinition[] {
  return buildCriticalToolDefinitions({
    toolId: HOME_ASSISTANT_TOOL_ID, credentialRef: HOME_ASSISTANT_CREDENTIAL_REF, transport,
    read: {
      action: HOME_CRITICAL_READ_ACTION, targetParam: "entity", shape: { entity: z.string().regex(ENTITY_ID) },
      description: "Les NØYAKTIG én kritisk hjem-entitets normaliserte tilstand (lås, alarm, cover, ventil, bryter, scene, skript, klima) - kun eierens egne entiteter, kun eieren. Ingen fritekst-attributter. Brukes som preflight og readback for de kritiske handlingene."
    },
    ops: HOME_CRITICAL_OPS,
    authorize: (targetParam, p) => authorizeHomeTarget(targetParam, p, config),
    timeoutMs: (op) => homeCriticalTimeoutMs(op, config),
    freezeConnectorIds: [HOME_ASSISTANT_CONNECTOR_ID]
  });
}
