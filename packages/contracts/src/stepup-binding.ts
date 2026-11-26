/**
 * WP-S1 (JARVIS-111, Q-71): modusen for server-side kanalbinding og den FAIL-CLOSED koblingen til høyrisiko-flaggene som ventet på den. Ren og deterministisk (ingen I/O): parseren og porten kjøres én gang ved
 * oppstart i `apps/api/src/main.ts`, og hele den effektive miljø-kopien som går videre til de fire flaggfamiliene kommer herfra.
 *
 * MODUS (`JARVIS_STEPUP_CHANNEL_BINDING`):
 *  - `observe` (STANDARD, også når usatt): serveren beregner «ville nektet» og skriver en revisjonsrad, men nekter ingenting = atferden er identisk med main pluss revisjonsstøy. Eieren gjennomgår enhetslisten.
 *  - `enforce`: en kanal som ikke hører til enhetstypen nektes (`channel_not_allowed_for_device_kind`), fail-closed. Settes av eieren etter gjennomgangen (runbook).
 *  - Alt annet (skrivefeil som `enforced`, `ENFORCE`, `on`, `true`) = `observe` og MELDES som `invalid_value` i status. Modusen er aldri «enforce» ved en feiltolkning, og oppstarten krasjer ikke. Dette er trygt fordi
 *    høyrisiko-flaggene under bare får effekt i `enforce`: en skrivefeil kan aldri skru på noe, bare la være å stramme inn.
 *
 * FAIL-CLOSED KOBLING: kapabilitetene som avhenger av at kanalen i en økt er sann (step-up for hjem/bil/familie/helse-inntak/Apple/økonomi-lesing, vekstskriving, utgående kommunikasjon, hendelsesabonnementet) får
 * INGEN effekt når modusen ikke er `enforce`. Flaggene fjernes fra den effektive miljø-kopien (`env`) FØR de leses, og hvert flagg eieren faktisk hadde slått på meldes i `blocked` med årsaken
 * `stepup_binding_not_enforced` (vises i `/infra/status` og oppstartsloggen). Ingen stille suksess: flagget står på, men kapabiliteten finnes ikke, og status sier hvorfor.
 */
export const STEPUP_CHANNEL_BINDING_ENV = "JARVIS_STEPUP_CHANNEL_BINDING";
export const STEPUP_BINDING_NOT_ENFORCED = "stepup_binding_not_enforced";

export type StepUpBindingMode = "observe" | "enforce";

export interface StepUpBindingSetting {
  readonly mode: StepUpBindingMode;
  readonly enforced: boolean;
  /** Den rå verdien når den var satt men ugyldig (avkortet, kun synlige ASCII-tegn); ellers `null`. Aldri en hemmelighet: kun modusnavnet eieren skrev. */
  readonly invalid_value: string | null;
}

export function parseStepUpBindingMode(raw: string | undefined): StepUpBindingSetting {
  if (raw === undefined || raw === "" || raw === "observe") return { mode: "observe", enforced: false, invalid_value: null };
  if (raw === "enforce") return { mode: "enforce", enforced: true, invalid_value: null };
  return { mode: "observe", enforced: false, invalid_value: raw.replace(/[^\x21-\x7e]/g, "?").slice(0, 40) };
}

/** `on` = flagget er slått på med eksakt `on` (etter trim); `list` = ikke-tom liste/verdi (f.eks. plattformlisten). */
export type StepUpBoundFlagRequest = "on" | "list";

export interface StepUpBoundFlag {
  readonly name: string;
  readonly request: StepUpBoundFlagRequest;
}

export interface StepUpBoundGroup {
  readonly id: string;
  /** Hva gruppen gir som avhenger av en sann kanal (for status og runbook). */
  readonly relies_on: string;
  readonly flags: readonly StepUpBoundFlag[];
}

/**
 * ALLE flaggene som er koblet til modusen. Listen er verifisert mot koden (runbook §5): `PERSONAL_FLAG_NAMES` (`modules/tool-gateway/src/personal/flags.ts`), `parseGrowthWritePlatforms`
 * (`modules/growth/src/write/config.ts`), `parseCommsConfig` (`modules/comms/src/config.ts`: utgående + de fire flaggene som krever `JARVIS_COMMS_OUTBOUND`, ellers stopper oppstarten) og `situationFlagsFromEnv`
 * (`modules/situations/src/flags.ts`: hovedbryteren; underflaggene gjelder kun under den). En vakttest låser at hvert navn her finnes i koden og at ingen av familienes flagg mangler.
 */
export const STEPUP_BOUND_FLAG_GROUPS: readonly StepUpBoundGroup[] = Object.freeze([
  {
    id: "personal",
    relies_on: "step-up (signert enhetsøkt fra en eier-kanal) for kritiske hjem-/bilhandlinger, familie, Apple CalDAV/CardDAV, personlig økonomi-lesing; helse-inntaket krever kanalene mobile/watch",
    flags: [
      { name: "JARVIS_PERSONAL_HOME_CRITICAL", request: "on" }, { name: "JARVIS_PERSONAL_CAR", request: "on" }, { name: "JARVIS_PERSONAL_FAMILY", request: "on" },
      { name: "JARVIS_PERSONAL_HEALTH_INGEST", request: "on" }, { name: "JARVIS_PERSONAL_APPLE_DAV", request: "on" }, { name: "JARVIS_PERSONAL_FINANCE_READ", request: "on" },
      { name: "JARVIS_PERSONAL_CONTEXT", request: "on" }
    ]
  },
  {
    id: "growth_write",
    relies_on: "step-up for alle skrivehandlinger mot annonse-/analyseplattformene (pengeøkende klasse C/D)",
    flags: [{ name: "JARVIS_GROWTH_WRITE_PLATFORMS", request: "list" }]
  },
  {
    id: "comms_outbound",
    relies_on: "step-up for eierens utgående kommunikasjon (`/comms/action`, `comms.*`); leverandør-lesing, utgående samtale, kontakter og møter krever utgående",
    flags: [
      { name: "JARVIS_COMMS_OUTBOUND", request: "on" }, { name: "JARVIS_COMMS_VENDOR_READS", request: "on" }, { name: "JARVIS_COMMS_CALLS", request: "on" },
      { name: "JARVIS_COMMS_CONTACTS", request: "on" }, { name: "JARVIS_COMMS_MEETINGS", request: "on" }
    ]
  },
  {
    id: "situation_signals",
    relies_on: "step-up for eierens kontrollhandlinger på hendelsesabonnementet (hovedbryteren; underflaggene gjelder kun under den)",
    flags: [{ name: "JARVIS_SITUATION_SIGNALS", request: "on" }]
  }
]);

export interface StepUpBlockedFlag {
  readonly flag: string;
  readonly group: string;
  readonly reason: typeof STEPUP_BINDING_NOT_ENFORCED;
}

export interface StepUpBindingGate {
  readonly setting: StepUpBindingSetting;
  /** Den EFFEKTIVE miljø-kopien flaggfamiliene skal lese. I `enforce` (og når ingenting var slått på) er innholdet likt originalen; ellers er de blokkerte flaggene fjernet. Originalen røres aldri. */
  readonly env: Record<string, string | undefined>;
  /** Flagg eieren HADDE slått på, men som ikke har effekt fordi modusen ikke er `enforce`. Tom i `enforce`. */
  readonly blocked: readonly StepUpBlockedFlag[];
}

function requested(flag: StepUpBoundFlag, value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return flag.request === "on" ? trimmed === "on" : trimmed !== "";
}

export function applyStepUpBindingGate(source: Readonly<Record<string, string | undefined>>): StepUpBindingGate {
  const setting = parseStepUpBindingMode(source[STEPUP_CHANNEL_BINDING_ENV]);
  const env: Record<string, string | undefined> = { ...source };
  if (setting.enforced) return { setting, env, blocked: [] };
  const blocked: StepUpBlockedFlag[] = [];
  for (const group of STEPUP_BOUND_FLAG_GROUPS) {
    for (const flag of group.flags) {
      if (requested(flag, source[flag.name])) blocked.push({ flag: flag.name, group: group.id, reason: STEPUP_BINDING_NOT_ENFORCED });
      // Fjernes UANSETT (også en verdi som ikke teller som «på»): en parser som er mer tolerant enn denne funksjonen skal aldri kunne lese en verdi herfra.
      delete env[flag.name];
    }
  }
  return { setting, env, blocked };
}

/** Status for `/infra/status` og oppstartsloggen: ingen verdier, kun modus, ugyldig verdi og blokkerte flaggnavn. */
export interface StepUpBindingStatus {
  mode: StepUpBindingMode;
  enforced: boolean;
  invalid_value: string | null;
  blocked: Array<{ flag: string; group: string; reason: string }>;
}

export function describeStepUpBinding(gate: Pick<StepUpBindingGate, "setting" | "blocked">): StepUpBindingStatus {
  return {
    mode: gate.setting.mode, enforced: gate.setting.enforced, invalid_value: gate.setting.invalid_value,
    blocked: gate.blocked.map((b) => ({ flag: b.flag, group: b.group, reason: b.reason }))
  };
}
