import type { Finding, Limitation, Observation, SelfDiagnosis, SelfStatus } from "./types.ts";

/**
 * EV-1: selvdiagnose («Hva er galt med deg akkurat nå?») komponert av KILDEBELAGTE observasjoner - aldri modellens magefølelse.
 * Hver leser er en smal, injisert funksjon (ingen avhengighet til hele systemet). En leser som mangler eller kaster gir `UNKNOWN`, aldri en
 * gjetning om «frisk».
 */
export type ObservationReader = () => Promise<Observation | Observation[]>;

/** Områder som alltid skal ha en observasjon. Mangler leser eller svarer den feil => UNKNOWN. `critical` styrer `overall`. */
export const EXPECTED_AREAS: ReadonlyArray<{ id: string; critical: boolean; label: string }> = [
  { id: "database", critical: true, label: "Database" },
  { id: "providers", critical: true, label: "Modellleverandører" },
  { id: "controls", critical: true, label: "Eier-kontroller (kill switch, frysing)" },
  { id: "connectors", critical: false, label: "Tilkoblinger" },
  { id: "tasks", critical: false, label: "Jobber" },
  // D-443: daglige bakgrunnsjobber (DailyScheduler) - feilet/ga opp/tapt i går, fra `scheduler_state`.
  { id: "scheduled_jobs", critical: false, label: "Daglige bakgrunnsjobber" },
  { id: "errors", critical: false, label: "Verktøyfeil siste time" },
  { id: "process", critical: false, label: "Prosess (minne, disk, last)" },
  { id: "constitution", critical: false, label: "Safety Constitution" },
  { id: "ledger", critical: false, label: "Endringsregister" },
  { id: "backup", critical: false, label: "Backup" },
  { id: "watchdog", critical: false, label: "Watchdog" },
  { id: "build", critical: false, label: "Bygg/versjon" },
  // EV-2 (D-417): tjenestemål (SLO), gradvis forverring (drift) og dataskvalitet.
  { id: "slo", critical: false, label: "Tjenestemål (SLO)" },
  { id: "drift", critical: false, label: "Gradvis forverring (drift)" },
  { id: "data_quality", critical: false, label: "Dataskvalitet (minne)" }
];

const RANK: Record<SelfStatus, number> = { OK: 0, UNKNOWN: 1, DEGRADED: 2, DOWN: 3 };

function unknownObservation(area: string, why: string): Observation {
  return { status: "UNKNOWN", source: `self-model:${area}`, observed_at: null, detail: why };
}

export interface ComposeInput {
  readers: Readonly<Record<string, ObservationReader | undefined>>;
  limitations: readonly Limitation[];
  now?: () => Date;
}

export async function composeSelfDiagnosis(input: ComposeInput): Promise<SelfDiagnosis> {
  const nowIso = (input.now ?? (() => new Date()))().toISOString();
  const observations: Record<string, Observation> = {};
  const areaOf = new Map<string, string>(); // observasjonsnøkkel -> område

  await Promise.all(
    EXPECTED_AREAS.map(async ({ id }) => {
      const reader = input.readers[id];
      if (reader === undefined) {
        observations[id] = unknownObservation(id, "ingen måling tilgjengelig (leser ikke koblet inn eller ikke bygget)");
        areaOf.set(id, id);
        return;
      }
      try {
        const result = await reader();
        const list = Array.isArray(result) ? result : [result];
        if (list.length === 0) {
          observations[id] = unknownObservation(id, "leseren ga ingen observasjoner");
          areaOf.set(id, id);
        }
        list.forEach((obs, i) => {
          const key = list.length === 1 ? id : `${id}:${i}`;
          observations[key] = obs;
          areaOf.set(key, id);
        });
      } catch (err) {
        observations[id] = unknownObservation(id, `måling feilet: ${(err as Error).message.slice(0, 120)}`);
        areaOf.set(id, id);
      }
    })
  );

  const findings: Finding[] = [];
  const unknown: string[] = [];
  for (const [key, obs] of Object.entries(observations).sort(([a], [b]) => a.localeCompare(b))) {
    if (obs.status === "OK") continue;
    if (obs.status === "UNKNOWN") unknown.push(key);
    findings.push({
      severity: obs.status === "DOWN" ? "critical" : obs.status === "DEGRADED" ? "warning" : "info",
      area: key, message: obs.detail, source: obs.source, observed_at: obs.observed_at
    });
  }
  const order = { critical: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.area.localeCompare(b.area));

  // overall: verste status blant KRITISKE områder; ukjent kritisk del gir UNKNOWN (aldri OK). Ikke-kritisk DOWN/DEGRADED gir DEGRADED.
  const critical = new Set(EXPECTED_AREAS.filter((a) => a.critical).map((a) => a.id));
  let overall: SelfStatus = "OK";
  for (const [key, obs] of Object.entries(observations)) {
    const isCritical = critical.has(areaOf.get(key) ?? key);
    const effective: SelfStatus = isCritical ? obs.status : obs.status === "DOWN" || obs.status === "DEGRADED" ? "DEGRADED" : "OK";
    if (RANK[effective] > RANK[overall]) overall = effective;
  }

  return { as_of: nowIso, overall, findings, observations, unknown, limitations: [...input.limitations] };
}
