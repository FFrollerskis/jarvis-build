import type { ControlCenterId } from "./types.ts";

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
    description: `Les Finans-kontrollsenteret (UA-11): betalingsintensjoner (inkl. de med ukjent utfall), forbruk og faste trekk, avvik, leverandører/kontoer/banksamtykker, avstemming (siste kjøring og åpne funn) og finans-nødbryterens tilstand. Finansdata er SECRET_RESTRICTED (D-378): en skymodell får IKKE rapporten (den holdes tilbake ved utførelse); kun en lokal modell og kontrollsiden får den. ${COMMON_TAIL}`
  },
  {
    center: "memory", action: "get_memory_center",
    description: `Les Minne-kontrollsenteret (UA-11): minnekilder og synk, aktive minner (rom, sensitivitet), proveniens (ubetrodd innhold i autoritativt minne), karantene og motstrid, slettebevis, og styringsjournalen (beslutninger, risiko, mål) med proveniens. Aldri minneinnhold. ${COMMON_TAIL}`
  },
  {
    center: "agent", action: "get_agent_center",
    description: `Les Agent-kontrollsenteret (UA-11): alle kjørende og ventende agenter/jobber, workere og kø, leaser, forsøk på nytt, avbrytelser, artefakter og nettverksomfang. Aldri jobbtitler eller resultater. ${COMMON_TAIL}`
  },
  {
    center: "operations", action: "get_operations_center",
    description: `Les Drift-kontrollsenteret (UA-11): åpne hendelser (antall, alvorlighet, bevisgrad - aldri titler), skymål og produsenter, runbooks (antall), backup og restore-øvelser, planlagte jobber, oppetid og kapasitet. Ikke målt (diskplass, oppetid-prosent, vakthundens egne sjekker) sies rett ut. ${COMMON_TAIL}`
  },
  {
    center: "value", action: "get_value_center",
    description: `Les Verdi-kontrollsenteret (UA-11): verdiløkkene V1-V5 med tilstandsord, bruksfrekvens, lukkede jobber, spart tid og dine korrigeringer (de to siste er IKKE målt og står som ikke målt, aldri som 0). Kun tall fra eksisterende målinger, inkl. AI-kostnad i øre: en skymodell får IKKE rapporten (den holdes tilbake ved utførelse, SECRET_RESTRICTED inntil eieren har avgjort noe annet); kun en lokal modell og kontrollsiden får den. ${COMMON_TAIL}`
  },
  {
    center: "privacy", action: "get_privacy_center",
    description: `Les Personvern-kontrollsenteret (UA-11): behandlingsoversikten mot de levende tabellene, DPIA-status (slik dokumentet erklærer; ikke en juridisk vurdering), oppbevaring og slettebevis. Aldri personinnhold. ${COMMON_TAIL}`
  },
  {
    center: "security", action: "get_security_center",
    description: `Les Sikkerhet-kontrollsenteret (UA-11): revisjon (inkl. om append-only-triggeren er intakt), credential- og tilgangshendelser, mistenkelig innhold/eksfiltrering (det som ikke kan telles sies rett ut), det som venter på gjenoppretting og siste golden-suite-kjøring. Aldri innhold eller hemmeligheter. ${COMMON_TAIL}`
  }
];

export const CONTROL_CENTER_READ_ACTIONS: ReadonlySet<string> = new Set(CONTROL_CENTER_READ_TOOLS.map((t) => t.action));

export function controlCenterForReadAction(action: string): ControlCenterId | undefined {
  return CONTROL_CENTER_READ_TOOLS.find((t) => t.action === action)?.center;
}

/**
 * Sentre som ALDRI leveres til en skymodell (gjennomgang M2). Finansdata er `SECRET_RESTRICTED` (D-378: aldri til sky; en LOKAL modell får lov til å se alt, D-378 punkt 2). Låsen i turn-konteksten
 * (`RESTRICTED_TOOL_KEYS`) gjelder bare når `get_finance_center` blir VALGT av utvalget, og `MeshToolExecutor` sjekker bare flate-tildelingen - en skymodell som likevel kaller verktøyet (tom-utvalg-tur,
 * `get_control_center {center: "finance"}`, oversikten) ville derfor fått rapporten. Håndhevingen skjer derfor VED UTFØRELSE, i transporten: ber en skymodell om dette senteret, bygges det ikke engang -
 * svaret er en kort merknad. Lokale modeller og siden (`/control`, ingen modell i løkka) får hele rapporten, inkl. beløp i øre.
 */
export const CLOUD_WITHHELD_CENTERS: readonly ControlCenterId[] = ["finance", "value"];

/**
 * Hvorfor et senter holdes tilbake (vises til modellen i «holdt tilbake»-merknaden, uten tall). Verdi-senteret (H2) holdes tilbake HELT fordi verdimålingene inkluderer AI-kostnad i øre (`unit: "ore"`) - strengeste regel
 * inntil eieren har avgjort om AI-kostnaden kan vises til en skymodell (åpent spørsmål; `get_value_report` fra WP-C4 og AI-senteret fra H0 på main er uendret og viser den fortsatt). Å åpne for skyen igjen er å fjerne
 * `value` fra `CLOUD_WITHHELD_CENTERS`/`EXECUTION_GUARDED_RESTRICTED_KEYS` (og `RESTRICTED_TOOL_KEYS` i turn-context.ts, `restricted` i manifestet) - invarianttesten sier fra hvis noe av det glemmes.
 */
const WITHHELD_REASON_NO: Readonly<Partial<Record<ControlCenterId, string>>> = {
  finance: "finansdata er SECRET_RESTRICTED (D-378) og går aldri til en skymodell",
  value: "verdimålingene inkluderer AI-kostnad i øre, som holdes som finansdata (SECRET_RESTRICTED, D-378) og ikke går til en skymodell inntil eieren har avgjort noe annet"
};

/**
 * Verktøynøklene (`tool_id.action`) som er håndhevet VED UTFØRELSE mot skymodeller (ikke bare ved utvalg). Låst mot manifestets `restricted`-merking av `wph1-restricted-tools-invariant.test.ts`:
 * et verktøy merket `restricted` på en modellflate må enten være låst i utvalget (turen blir lokal) eller stå her.
 */
export const EXECUTION_GUARDED_RESTRICTED_KEYS: ReadonlySet<string> = new Set(["executive.get_finance_center", "executive.get_value_center"]);

export function isCloudWithheldCenter(center: string): boolean {
  return (CLOUD_WITHHELD_CENTERS as readonly string[]).includes(center);
}

/** Svaret en skymodell får i stedet for et holdt-tilbake senter: ingen tall, ingen seksjoner, ingen tilstand - kun hvorfor og hva eieren kan gjøre. */
export function withheldCenterData(center: ControlCenterId, title_no: string): Record<string, unknown> {
  const summary_no = `${title_no}-kontrollsenteret holdes tilbake fra denne modellen: ${WITHHELD_REASON_NO[center] ?? `${title_no.toLowerCase()}data er SECRET_RESTRICTED (D-378) og går aldri til en skymodell`}. Åpne kontrollsiden (/control) fra en innrullert enhet, eller still spørsmålet til en lokal modell.`;
  return { found: true, withheld: true, center, summary_no, explanation_no: summary_no };
}
