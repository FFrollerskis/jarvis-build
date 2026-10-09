/**
 * WP-C4, V3 Jarvis Builder Loop (masterplan v4.0 kap. 9: «Jarvis følger sitt eget prosjekt, finner feil/gates, delegerer coding work og holder status kontinuerlig oppdatert») - SOVENDE.
 *
 * Dette er REN beredskapslogikk i samme stil som aktiveringsberedskapen for de øvrige sovende Evolution-delene: den utfører ingenting, kaller ingenting og importerer ingenting (ingen tjeneste, ingen transport, ingen
 * GitHub-klient). Den svarer kun på «hva mangler før eieren kan ta en navngitt D-beslutning om å aktivere løkken?». `activation_decision` er ALLTID `false`: ingen kodevei - heller ikke «alle krav er oppfylt» - kan
 * aktivere løkken eller starte selvmodifikasjon (frosset, D-397). Aktivering krever en D-beslutning fra Tobias, og eierens beslutning (`owner_decision:V3`) kan aldri være oppfylt av kode.
 *
 * Fakta er enten målt (EV-0-oppstartssjekk, change freeze, GitHub-tilkoblingens helse) eller ERKLÆRT av eieren (`JARVIS_VALUE_VERIFIED_GATES`: D-32 og worker-isolasjon kan ikke utledes av kode). Et faktum som ikke kan
 * fastslås (`null`) er ukjent og dermed IKKE oppfylt - aldri «antatt greit».
 */
import type { BuilderLoopVerdict, BuilderRequirement } from "./types.ts";

/** Porter eieren kan erklære verifisert (kun disse navnene gjelder; alt annet ignoreres). */
export const BUILDER_VERIFIED_GATES = ["D-32", "WORKER_ISOLATION"] as const;
export type BuilderVerifiedGate = (typeof BUILDER_VERIFIED_GATES)[number];

/** `JARVIS_VALUE_VERIFIED_GATES=D-32,WORKER_ISOLATION` -> kjente porter (eksakt navn, uten duplikater). Ukjente navn og tom verdi gir ingen porter. */
export function parseDeclaredValueGates(raw: string | undefined): BuilderVerifiedGate[] {
  const known = new Set<string>(BUILDER_VERIFIED_GATES);
  const out = new Set<BuilderVerifiedGate>();
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim();
    if (known.has(name)) out.add(name as BuilderVerifiedGate);
  }
  return [...out];
}

export interface BuilderLoopFacts {
  /** Safety Constitution verifisert (signatur + festet nøkkel). null = oppstartssjekken har ikke kjørt (ukjent). */
  constitution_verified: boolean | null;
  /** Endringsregisterets hash-kjede intakt. null = ukjent. */
  ledger_ok: boolean | null;
  /** Change freeze akkurat nå. null = kunne ikke vurderes (ukjent). */
  change_freeze: { frozen: boolean; reasons: readonly string[] } | null;
  /** GitHub-tilkoblingen er satt opp OG siste kjente helse er frisk. null = satt opp, men aldri kalt (ukjent). */
  github_connector_healthy: boolean | null;
  /** Porter eieren har erklært verifisert. */
  declared_gates: readonly string[];
}

const flag = (id: string, label_no: string, value: boolean | null): BuilderRequirement => ({ id, label_no, kind: "technical", met: value === true, unknown: value === null });

/** Hva som MÅ være på plass, i fast rekkefølge. Eierens beslutning står sist og er aldri oppfylt av kode. */
export function evaluateBuilderLoopReadiness(facts: BuilderLoopFacts): BuilderLoopVerdict {
  const gates = new Set(facts.declared_gates);
  const requirements: BuilderRequirement[] = [
    flag("ev0.constitution_verified", "Safety Constitution er signert og verifisert (EV-0)", facts.constitution_verified),
    flag("ev0.ledger_ok", "Endringsregisterets hash-kjede er intakt (EV-0)", facts.ledger_ok),
    flag("change_freeze_off", "Change freeze er av (ingen åpen hendelse, kill switch eller brutt tjenestemål)", facts.change_freeze === null ? null : !facts.change_freeze.frozen),
    flag("github_connector_healthy", "GitHub-tilkoblingen er satt opp og frisk (løkken følger prosjektet via GitHub)", facts.github_connector_healthy),
    flag("gate:D-32", "D-32 er verifisert på ekte vert (ekte branch/PR fra NAS med ressurs- og nettverksisolasjon)", gates.has("D-32")),
    flag("gate:WORKER_ISOLATION", "Worker-isolasjon er bevist (filsystem, nettverk, legitimasjon, kansellering, krasj og gjenopptakelse)", gates.has("WORKER_ISOLATION")),
    { id: "owner_decision:V3", label_no: "Tobias har tatt en navngitt D-beslutning om å aktivere V3 (aldri oppfylt av kode)", kind: "owner_decision", met: false, unknown: false }
  ];
  const technical = requirements.filter((r) => r.kind === "technical");
  return {
    loop: "V3",
    title_no: "Jarvis Builder Loop",
    why_dormant_no: "selvmodifikasjon er frosset (D-397) og venter bevist worker-isolasjon (D-32) og et verifisert EV-0",
    activation_decision: false,
    ready_for_owner_decision: technical.every((r) => r.met),
    requirements,
    met: requirements.filter((r) => r.met).map((r) => r.id),
    missing: requirements.filter((r) => !r.met).map((r) => ({ id: r.id, label_no: r.label_no, unknown: r.unknown }))
  };
}

export interface FreezeSignals {
  incident_open: boolean;
  observability_ok: boolean;
  slo_breaches: number;
  kill_switch_active: boolean;
}

/**
 * Change freeze-reglene (ustabilt system: hendelse, manglende observerbarhet, brutt tjenestemål eller kill switch). Samme fire regler som `changeFreeze()` i EV-8 (`@jarvis/self-modification`); duplisert fordi
 * `@jarvis/executive` ikke avhenger av den pakken, og låst mot den av `apps/api/test/wpc4-value-wiring.test.ts` (likhet for alle 16 kombinasjoner) så de to aldri kan drive fra hverandre.
 */
export function deriveChangeFreeze(s: FreezeSignals): { frozen: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (s.kill_switch_active) reasons.push("kill_switch_active");
  if (s.incident_open) reasons.push("incident_open");
  if (!s.observability_ok) reasons.push("observability_missing");
  if (s.slo_breaches > 0) reasons.push("slo_breached");
  return { frozen: reasons.length > 0, reasons };
}
