import type { ControlCenterId, ControlCenterReport } from "./types.ts";

/**
 * WP-H1/H2: per-senter LESE-verktøy (`executive.get_<senter>_center`, klasse A) for sentrene som ble bygget etter H0. Hvert verktøy er et tynt, lesende gjennomslag til SAMME register som `get_control_center`
 * (`ControlCenterRegistry.report`) - ingen egen bygging, ingen egen autorisasjon: eier-kun + enhetssignert økt, FAIL-CLOSED også uten register (samme port som `get_infra_status`), aldri tale/Telegram.
 * Tabellen er ÉN kilde for transporten (definisjoner + dispatch), tool-manifestet og testene - ikke tre håndvedlikeholdte lister.
 *
 * Verktøynavn er stabile API-verdier: legg til, aldri omdøp. `get_control_center` (H0) er uendret og gir de samme rapportene via `center`-parameteren.
 */
export interface ControlCenterReadTool {
  center: ControlCenterId;
  action: string;
  /** Beskrivelsen modellen ser. Kort, deterministisk, og forteller at kun eieren får svar og at ingenting utføres. */
  description: string;
}

const COMMON_TAIL =
  "KUN lesing - jeg utfører ingenting herfra (handlinger skjer på kontrollsiden /control med eierens signerte enhet). Hvert tall er kildeforankret (tabell og når det ble målt); ukjent vises som ukjent, aldri som i orden. " +
  "Kun eieren får svar, og kun fra en signert enhetsøkt (nettleser/app) - aldri over tale eller Telegram. Gjengi summary_no og explanation_no.";

export const CONTROL_CENTER_READ_TOOLS: ReadonlyArray<ControlCenterReadTool> = [
  {
    center: "finance", action: "get_finance_center",
    description: `Les Finans-kontrollsenteret (UA-11): betalingsintensjoner (inkl. de med ukjent utfall), forbruk og faste trekk, avvik, leverandører/kontoer/banksamtykker, avstemming (siste kjøring og åpne funn) og finans-nødbryterens tilstand. Beløp er utelatt i svaret til modellen (kun antall og tilstander). ${COMMON_TAIL}`
  },
  {
    center: "memory", action: "get_memory_center",
    description: `Les Minne-kontrollsenteret (UA-11): minnekilder og synk, aktive minner (rom, sensitivitet), proveniens (ubetrodd innhold i autoritativt minne), karantene og motstrid, slettebevis, og styringsjournalen (beslutninger, risiko, mål) med proveniens. Aldri minneinnhold. ${COMMON_TAIL}`
  },
  {
    center: "agent", action: "get_agent_center",
    description: `Les Agent-kontrollsenteret (UA-11): alle kjørende og ventende agenter/jobber, workere og kø, leaser, forsøk på nytt, avbrytelser, artefakter og nettverksomfang. Aldri jobbtitler eller resultater. ${COMMON_TAIL}`
  }
];

export const CONTROL_CENTER_READ_ACTIONS: ReadonlySet<string> = new Set(CONTROL_CENTER_READ_TOOLS.map((t) => t.action));

export function controlCenterForReadAction(action: string): ControlCenterId | undefined {
  return CONTROL_CENTER_READ_TOOLS.find((t) => t.action === action)?.center;
}

/**
 * Sentre der pengebeløp (`*_ore`-fakta) ALDRI skal nå en modell. Finansdata er `SECRET_RESTRICTED` (D-378: aldri til sky), og kontrollsenterets verktøy kan velges av en tur som ikke er låst lokalt
 * (`get_control_center` gjør det ikke). Beløpene ligger derfor kun i numeriske fakta med nøkkel som ender på `_ore` (aldri i tekstene), og fjernes her når en modell betjener kallet. Siden
 * (`/control/center`, ingen modell i løkka) får hele rapporten. H0-sentrene er uendret.
 */
export const MONEY_REDACTED_CENTERS: readonly ControlCenterId[] = ["finance"];
const MONEY_FACT_KEY = /_ore$/;

export function stripMoneyFacts(report: ControlCenterReport): ControlCenterReport {
  if (!MONEY_REDACTED_CENTERS.includes(report.center)) return report;
  return {
    ...report,
    sections: report.sections.map((section) => ({
      ...section,
      items: section.items.map((item) =>
        item.facts === undefined ? item : { ...item, facts: Object.fromEntries(Object.entries(item.facts).filter(([key]) => !MONEY_FACT_KEY.test(key))) }
      )
    }))
  };
}
