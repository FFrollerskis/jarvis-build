import type { Limitation } from "./types.ts";

/**
 * EV-1: Limitation Registry - eksplisitt liste over det Jarvis VET at han ikke kan. Det meste AVLEDES mekanisk fra kodens egne registre (forbudte
 * verktøy-id-er, connectorer uten full test, modellprofiler uten en evne) slik at registeret ikke kan avvike fra virkeligheten; resten er
 * håndskrevne, kildehenviste poster (frosset selvendring, kun eier-handlinger, ubekreftet i drift).
 */
export interface LimitationInput {
  /** `FORBIDDEN_MODEL_TOOL_IDS`: verktøy-id-er modellen aldri får kalle. */
  forbiddenModelToolIds: readonly string[];
  /** `CONNECTOR_REGISTRY` (kun feltene vi trenger). */
  connectors: ReadonlyArray<{ id: string; category?: string; test_method?: string }>;
  /** `CapabilityRegistry`-profilene. `all` = alle evner systemet kjenner til. */
  modelProfiles: ReadonlyArray<{ provider: string; capabilities: readonly string[] }>;
  allModelCapabilities: readonly string[];
  /** WP-C2: sant når en backup-statusfil er montert og leses (`backup`-området har en leser). Da er «ingen heartbeat»-begrensningen byttet ut med en presis. */
  backupStatusReadable?: boolean;
  /** WP-OPS2a K1: sant når vakthundens tikk registreres varig og leses (`watchdog`-leseren har en kilde, dvs. incident-produsentene er på). Da er «jeg ser ikke watchdogens status»-begrensningen byttet ut med en presis. */
  watchdogStateReadable?: boolean;
}

const HAND_WRITTEN: readonly Limitation[] = [
  {
    id: "self_modification_frozen",
    statement: "Jeg kan ikke endre min egen kode eller konfigurasjon: selvendring er frosset (ikke koblet inn i drift).",
    kind: "policy",
    source_ref: "D-397"
  },
  {
    id: "owner_only_actions",
    statement: "Betaling, permanent sletting, merge, servere/containere, og endring av sikkerhets- og eierinnstillinger kan jeg ikke gjøre fra samtalen - de krever eieren via egen, godkjent vei.",
    kind: "policy",
    source_ref: "apps/api/src/conversation.ts (systemprompt) + FORBIDDEN_MODEL_TOOL_IDS"
  },
  {
    id: "no_own_authority_changes",
    statement: "Jeg kan aldri heve mine egne rettigheter eller budsjettgrenser, endre kill switch, godkjenningsverifisering eller revisjonsintegritet, eller lese eierens offline-nøkkel.",
    kind: "policy",
    source_ref: "EV-0 (D-406, D-409, D-410)"
  },
  {
    id: "constitution_unsigned_until_owner",
    statement: "Safety Constitution er ikke aktiv før eieren har signert den offline og festet nøkkelfingeravtrykket.",
    kind: "unverified",
    source_ref: "docs/runbooks/EV0_CONSTITUTION_SIGNING.md"
  },
  {
    id: "no_backup_heartbeat",
    statement: "Jeg kan ikke selv se alderen på siste backup: backup kjører utenfor meg og har ingen heartbeat jeg kan lese.",
    kind: "technical",
    source_ref: "ops/backup/jarvis-backup.mjs (CLI), D-407-serien"
  },
  {
    id: "no_cross_process_watchdog_state",
    statement: "Watchdog kjører i en annen prosess (worker) og lagrer ikke siste resultat jeg kan lese - jeg ser ikke watchdogens status herfra.",
    kind: "technical",
    source_ref: "modules/watchdog (worker-main.ts)"
  },
  {
    id: "no_gpu_cpu_view_of_pc",
    statement: "Jeg ser ikke GPU- eller CPU-bruk på PC-en (kun hvor NAS-prosessen kjører); lokal modell vises bare som nåbar/ikke nåbar.",
    kind: "technical",
    source_ref: "modules/model-gateway ProviderHealthTracker"
  },
  {
    id: "no_consciousness_claim",
    statement: "Jeg er systembevisst programvare: jeg kan beskrive hva jeg kjører, kan og ikke kan. Jeg påstår ikke bevissthet eller følelser.",
    kind: "policy",
    source_ref: "Evolution Masterplan v1.2 kap. 8"
  }
];

/** WP-C2: med en lesbar statusfil er den gamle påstanden usann - men det jeg ser er fortsatt kun det backup-skriptet selv melder. */
const BACKUP_STATUS_READABLE: Limitation = {
  id: "no_backup_heartbeat",
  statement: "Jeg ser backup kun slik backup-skriptet selv melder det i en statusfil (alder, off-site, restore-verifisering); jeg kan ikke selv ta backup, kjøre en restore eller bevise at kopiene virker.",
  kind: "technical",
  source_ref: "ops/backup/schedule.mjs (backup-status.json), apps/api/src/backup-status.ts"
};

/** WP-OPS2a K1: med registrerte tikk er den gamle påstanden usann - men det jeg ser er fortsatt kun siste registrerte tikk, og jeg kan verken starte vakthunden på nytt eller lese sjekkenes egne meldinger. */
const WATCHDOG_STATE_READABLE: Limitation = {
  id: "no_cross_process_watchdog_state",
  statement: "Jeg ser vakthunden kun slik dens tikk er registrert varig; jeg kan ikke starte den på nytt. Det jeg ser er når den sist tikket og hvor mange sjekker som feilet - aldri sjekkenes egne meldinger.",
  kind: "technical",
  source_ref: "apps/api/src/watchdog-status.ts (incident_producer_runs, producer watchdog), modules/incidents/src/producers/run-store.ts"
};

export function buildLimitationRegistry(input: LimitationInput): Limitation[] {
  const out: Limitation[] = HAND_WRITTEN.map((l) => {
    if (l.id === "no_backup_heartbeat" && input.backupStatusReadable === true) return BACKUP_STATUS_READABLE;
    if (l.id === "no_cross_process_watchdog_state" && input.watchdogStateReadable === true) return WATCHDOG_STATE_READABLE;
    return l;
  });

  for (const toolId of [...input.forbiddenModelToolIds].sort()) {
    out.push({
      id: `forbidden_tool:${toolId}`,
      statement: `Jeg kan ikke kalle verktøyet «${toolId}» fra samtalen (forbudt for modellflaten).`,
      kind: "policy",
      source_ref: "FORBIDDEN_MODEL_TOOL_IDS"
    });
  }

  for (const c of [...input.connectors].sort((a, b) => a.id.localeCompare(b.id))) {
    if (c.category !== undefined && c.category.startsWith("backlog")) {
      out.push({ id: `connector_backlog:${c.id}`, statement: `Tilkoblingen «${c.id}» er ikke bygget ennå (planlagt).`, kind: "deferred", source_ref: "CONNECTOR_REGISTRY" });
    } else if (c.test_method === "presence_only") {
      out.push({
        id: `connector_unverified:${c.id}`,
        statement: `For «${c.id}» kan jeg bare se at en nøkkel er satt - ikke at tilkoblingen faktisk virker.`,
        kind: "unverified",
        source_ref: "CONNECTOR_REGISTRY (test_method presence_only)"
      });
    }
  }

  for (const p of [...input.modelProfiles].sort((a, b) => a.provider.localeCompare(b.provider))) {
    const missing = input.allModelCapabilities.filter((cap) => !p.capabilities.includes(cap));
    if (missing.length > 0) {
      out.push({
        id: `model_missing:${p.provider}`,
        statement: `Modellen «${p.provider}» støtter ikke: ${missing.join(", ")}.`,
        kind: "technical",
        source_ref: "modules/model-gateway capability-registry"
      });
    }
  }
  return out;
}
