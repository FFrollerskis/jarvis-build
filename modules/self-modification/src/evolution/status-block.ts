import { createHash } from "node:crypto";
import { z } from "zod";
import { CATEGORY_CAP_KEYS, EVOLUTION_COST_CATEGORIES, canonicalizeManifest, type BudgetCaps, type EvolutionCostCategory } from "../constitution.ts";

/**
 * WP-EV0 (HF2 kap. 29/31 pkt. 18, PC2): GENERERT visning av Evolution-takene, faktisk forbruk, run-rate og eier-tid for `docs/PROJECT_STATUS.md`.
 * Det SIGNERTE manifestet er kilden (øre/minutter) - et markdown-dokument kan ikke være en autoritet - og forbruket kommer KUN fra et innsendt forbruksbilde
 * (`UsageSnapshot`, f.eks. `--usage <fil.json>`): det finnes ingen varig forbrukskilde i denne pakken (forbruksregisteret er DEFERRED til WP-EV0b). Alt som ikke er målt
 * står som «ikke målt», ALDRI som 0, og en delsum er aldri en total. Ren logikk: samme input gir byte-lik utdata (tidspunktet gis inn), og visningen skriver aldri
 * `issued_by` (kan være et navn).
 */
export const STATUS_BLOCK_BEGIN = "<!-- EVOLUTION_STATUS_BEGIN -->";
export const STATUS_BLOCK_END = "<!-- EVOLUTION_STATUS_END -->";

const nullableCount = z.number().int().min(0).nullable();
/** Målt forbruk for en kalendermåned og en ISO-uke. `null` = IKKE MÅLT (aldri 0). */
export const UsageSnapshotSchema = z
  .object({
    /** UTC-kalendermåned `ÅÅÅÅ-MM` forbruket gjelder. */
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    /** Dager gått av måneden inkludert i dag (dag-i-måneden); grunnlaget for run-rate-prognosen. */
    days_elapsed: z.number().int().min(1).max(31),
    days_in_month: z.number().int().min(28).max(31),
    spend_ore: z.object({ radar: nullableCount, eval: nullableCount, redteam: nullableCount, shadow: nullableCount, review: nullableCount }).strict(),
    /** Mandag (UTC) i uken eier-tiden gjelder, `ÅÅÅÅ-MM-DD`. */
    week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    owner_minutes_week: nullableCount,
    /** Autonome (E0/E1) merger denne uken. */
    autonomous_changes_week: nullableCount
  })
  .strict()
  .refine((s) => s.days_elapsed <= s.days_in_month, { message: "days_elapsed_above_days_in_month" });
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export interface StatusConstitution {
  version: number;
  digest: string;
  /** true = signatur og festet nøkkel verifisert; false = IKKE verifisert (utkast); null = ukjent. Kun `true` gjør takene autoritative. */
  signed: boolean | null;
  /** Feilkoden når `signed` ikke er true (f.eks. `constitution_unsigned`). */
  verification_code: string | null;
}

export interface EvolutionStatusInput {
  /** ISO-tidspunkt for genereringen (gis inn: deterministisk utdata). */
  generated_at: string;
  constitution: StatusConstitution;
  caps: BudgetCaps;
  /** null = ingen forbruksdata levert (alt vises som «ikke målt»). */
  usage: UsageSnapshot | null;
}

const NOT_MEASURED = "ikke målt";
const CATEGORY_LABEL: Record<EvolutionCostCategory, string> = {
  radar: "Radar", eval: "Evaluering", redteam: "Red team", shadow: "Shadow/canary", review: "Uavhengig review"
};

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const kr = (ore: number): string => `${Math.trunc(ore / 100)},${String(ore % 100).padStart(2, "0")}`;
const percent = (part: number, whole: number): string => `${((part / whole) * 100).toFixed(1).replace(".", ",")} %`;
const hours = (minutes: number): string => `${(minutes / 60).toFixed(1).replace(".", ",")} t`;

function costRow(label: string, capOre: number, actual: number | null, usage: UsageSnapshot | null): string {
  if (actual === null) return `| ${label} | ${kr(capOre)} | ${NOT_MEASURED} | ${NOT_MEASURED} | ${NOT_MEASURED} | ${NOT_MEASURED} |`;
  const projected = usage === null ? null : Math.round((actual * usage.days_in_month) / usage.days_elapsed);
  const used = capOre > 0 ? percent(actual, capOre) : "-";
  let status: string;
  if (capOre === 0) status = actual > 0 ? "OVER TAKET (tak 0)" : "stengt (tak 0)";
  else if (actual > capOre) status = "OVER TAKET";
  else if (projected !== null && projected > capOre) status = "prognose over taket";
  else status = "innenfor";
  return `| ${label} | ${kr(capOre)} | ${kr(actual)} | ${used} | ${projected === null ? NOT_MEASURED : kr(projected)} | ${status} |`;
}

/** Selve blokken (Markdown, norsk) mellom `STATUS_BLOCK_BEGIN` og `STATUS_BLOCK_END`. */
export function renderEvolutionStatusBlock(input: EvolutionStatusInput): string {
  const { caps, constitution, usage } = input;
  const out: string[] = [STATUS_BLOCK_BEGIN];
  out.push(`<!-- evolution-status: constitution_version=${constitution.version} caps_sha256=${sha256(canonicalizeManifest(caps))} -->`);
  out.push("### Evolution: planlagt forbruk, faktisk forbruk, run-rate og eier-tid", "");
  out.push(
    "> GENERERT visning - rediger ikke for hånd. Kilden til takene er den signerte konstitusjonen (øre og minutter); faktisk forbruk kommer fra et innsendt forbruksbilde (ingen varig forbrukskilde ennå). " +
      `Det som ikke er målt står som «${NOT_MEASURED}», aldri som 0.`,
    `> Generert ${input.generated_at}.`, ""
  );
  const status =
    constitution.signed === true ? "SIGNERT og verifisert (festet nøkkel)"
    : constitution.signed === false ? `UTKAST - IKKE signert/verifisert (${constitution.verification_code ?? "ukjent feil"}): takene er IKKE autoritative ennå`
    : "ukjent (kunne ikke verifiseres her): takene er IKKE bekreftet";
  out.push(`- **Konstitusjon:** versjon ${constitution.version} - ${status}`, `- **Digest:** \`${constitution.digest.slice(0, 12)}\` (første 12 tegn)`, "");

  const month = usage === null ? "" : ` for ${usage.month}, dag ${usage.days_elapsed} av ${usage.days_in_month}`;
  out.push(`**Kostnad (kr pr. kalendermåned${month})**`, "");
  out.push("| Kategori | Planlagt (tak) | Faktisk hittil | Brukt | Run-rate (prognose måned) | Status |", "|---|---:|---:|---:|---:|---|");
  const spend = usage?.spend_ore ?? null;
  for (const c of EVOLUTION_COST_CATEGORIES) out.push(costRow(CATEGORY_LABEL[c], caps[CATEGORY_CAP_KEYS[c]], spend === null ? null : spend[c], usage));
  const known = spend === null ? null : EVOLUTION_COST_CATEGORIES.map((c) => spend[c]);
  const total = known === null || known.some((v) => v === null) ? null : known.reduce<number>((n, v) => n + (v as number), 0);
  out.push(costRow("Totalt Evolution", caps.max_evolution_cost_ore_per_month, total, usage), "");

  out.push(
    `**Grenser fra manifestet:** auto-merger ${caps.max_auto_merges_per_day}/døgn · deploys ${caps.max_deploys_per_day}/døgn og ${caps.max_deploys_per_hour}/time · ` +
      `E2-forslag til eier ${caps.max_owner_proposals_per_day}/døgn (forbruket telles av budsjettlåsen fra endringsregisteret, ikke av denne visningen)`, ""
  );

  out.push("**Eier-tid**", "", "| Mål | Verdi |", "|---|---|");
  const weekCap = caps.owner_time_budget_minutes_per_week;
  out.push(`| Ukebudsjett | ${hours(weekCap)} (${weekCap} min) |`);
  const weekLabel = usage === null ? "Brukt denne uken" : `Brukt denne uken (fra ${usage.week_start})`;
  const ownerMinutes = usage?.owner_minutes_week ?? null;
  if (ownerMinutes === null) out.push(`| ${weekLabel} | ${NOT_MEASURED} |`);
  else {
    const pct = weekCap > 0 ? ` · ${percent(ownerMinutes, weekCap)}` : "";
    const flag = weekCap === 0 ? (ownerMinutes > 0 ? " · over budsjettet (tak 0)" : "") : ownerMinutes > weekCap ? " · OVER BUDSJETTET" : "";
    out.push(`| ${weekLabel} | ${hours(ownerMinutes)} (${ownerMinutes} min)${pct}${flag} |`);
  }
  out.push(`| Tak pr. autonom endring | ${caps.max_owner_minutes_per_autonomous_change} min |`);
  const changes = usage?.autonomous_changes_week ?? null;
  out.push(`| Autonome endringer denne uken | ${changes === null ? NOT_MEASURED : changes} |`);
  const perChange = ownerMinutes === null || changes === null ? NOT_MEASURED : changes === 0 ? "ingen autonome endringer" : `${(ownerMinutes / changes).toFixed(1).replace(".", ",")} min`;
  out.push(`| Eier-minutter pr. autonom endring (snitt) | ${perChange} |`, "");

  const caveats: string[] = [];
  if (usage === null) caveats.push("Faktisk forbruk er IKKE målt: ingen forbruksdata ble levert (generatoren viser aldri 0 for noe som ikke er målt).");
  else {
    for (const c of EVOLUTION_COST_CATEGORIES) if (usage.spend_ore[c] === null) caveats.push(`Forbruk for ${CATEGORY_LABEL[c].toLowerCase()} er ikke målt.`);
    if (usage.owner_minutes_week === null) caveats.push("Eier-tid denne uken er ikke målt.");
    if (usage.autonomous_changes_week === null) caveats.push("Antall autonome endringer denne uken er ikke målt.");
  }
  caveats.push("Run-rate er et enkelt snitt (faktisk hittil ÷ dager gått × dager i måneden), ikke en garanti.");
  out.push("**Forbehold**", "", ...caveats.map((c) => `- ${c}`), "", STATUS_BLOCK_END, "");
  return out.join("\n");
}

const MARKER_LINE = /<!-- evolution-status: constitution_version=(\d+) caps_sha256=([0-9a-f]{64}) -->/;

/** Finner blokken (inkl. markørene) i et dokument. `null` = ingen markører; kaster aldri. Ødelagte markører (feil antall/rekkefølge) gir `"malformed"` via `locate`. */
function locate(markdown: string): { start: number; end: number } | "malformed" | null {
  const begins = [...markdown.matchAll(new RegExp(STATUS_BLOCK_BEGIN, "g"))].map((m) => m.index as number);
  const ends = [...markdown.matchAll(new RegExp(STATUS_BLOCK_END, "g"))].map((m) => m.index as number);
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0]! < begins[0]!) return "malformed";
  return { start: begins[0]!, end: ends[0]! + STATUS_BLOCK_END.length };
}

export function extractStatusBlock(markdown: string): string | null {
  const at = locate(markdown);
  return at === null || at === "malformed" ? null : markdown.slice(at.start, at.end);
}

/** Erstatter blokken mellom markørene. `null` hvis dokumentet mangler (eller har ødelagte) markører - den som setter inn blokken første gang gjør det bevisst for hånd. */
export function spliceStatusBlock(markdown: string, block: string): string | null {
  const at = locate(markdown);
  if (at === null || at === "malformed") return null;
  return `${markdown.slice(0, at.start)}${block.trimEnd()}${markdown.slice(at.end)}`;
}

/**
 * Doc-vakt: blokken i PROJECT_STATUS kan ikke avvike fra det signerte manifestet. Tom liste = i orden. Funn: `status_block_missing` (ingen markører - kalleren avgjør om det er en feil),
 * `status_block_malformed`, `status_block_marker_missing` (kontrollinjen er fjernet/ødelagt), `status_block_version_stale:<i blokken>!=<i manifestet>` og `status_block_caps_stale`.
 */
export function checkStatusBlock(markdown: string, manifest: { version: number; caps: BudgetCaps }): string[] {
  const at = locate(markdown);
  if (at === null) return ["status_block_missing"];
  if (at === "malformed") return ["status_block_malformed"];
  const marker = MARKER_LINE.exec(markdown.slice(at.start, at.end));
  if (marker === null) return ["status_block_marker_missing"];
  const findings: string[] = [];
  if (Number(marker[1]) !== manifest.version) findings.push(`status_block_version_stale:${marker[1]}!=${manifest.version}`);
  if (marker[2] !== sha256(canonicalizeManifest(manifest.caps))) findings.push("status_block_caps_stale");
  return findings;
}
