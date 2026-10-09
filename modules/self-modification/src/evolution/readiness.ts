/**
 * Aktiveringsberedskap for de SOVENDE Evolution-delene (WP-B, D-452): EV-6 selvkoding, EV-11 utfallslæring, EV-13 personlighetsmotor 2.0 (slidere), EV-14 uttrykkstilstand, EV-15 mål-autonomi, EV-18 connector-fabrikk,
 * EV-20 uavhengig nødtilbakekalling/off-site, og EV-22/EV-23 (bygger på Admin Control Center). Dette er REN logikk: den utfører ingenting og aktiverer ingenting. Den svarer kun på «hva mangler før eieren kan ta en
 * navngitt D-beslutning om aktivering?» ut fra fakta som måles i kjøretiden eller som eieren selv har erklært verifisert (`JARVIS_EV_VERIFIED_GATES`). `activation_decision` er ALLTID false her: ingen kodevei kan
 * gi `ready`-svaret kraft - det er et sjekklistesvar til verifiseringsøkten, ikke en bryter.
 */
export type DormantEv = "EV-6" | "EV-11" | "EV-13" | "EV-14" | "EV-15" | "EV-18" | "EV-20" | "EV-22" | "EV-23";

/** Porter som kan erklæres verifisert av eieren (aldri utledet av kode): `JARVIS_EV_VERIFIED_GATES=D-32,OFFSITE_RESTORE,...` */
export const EXTERNAL_GATES = ["D-32", "OFFSITE_RESTORE", "ADMIN_CONTROL_CENTER", "UA-10_LIVE", "OUTCOME_TRACKING", "PERSONALITY_SLIDERS_WIRED", "EXPRESSION_STATE_WIRED", "CONNECTOR_FACTORY"] as const;
export type ExternalGate = (typeof EXTERNAL_GATES)[number];

export interface ReadinessFacts {
  /** Safety Constitution verifisert (signatur + festet nøkkel) - fra oppstartssjekken. */
  constitution_verified: boolean;
  /** Endringsregisterets hash-kjede intakt. */
  ledger_ok: boolean;
  /** Change freeze er av akkurat nå. */
  change_freeze_off: boolean;
  /** Antall tilkoblinger som er konfigurert, har live-test og siste helse «healthy» (beviste connectorer). */
  proven_connectors: number;
  /** Er jobb-container-runneren konfigurert i denne kjøringen (`JARVIS_JOB_RUNNER=container` + gyldig image/nettverk/proxy)? Konfigurert er ikke det samme som verifisert (D-32). */
  job_runner_configured: boolean;
  /** Porter eieren har erklært verifisert. */
  declared_gates: ReadonlySet<string>;
}

export interface ReadinessRequirement {
  id: string;
  label_no: string;
  met: (facts: ReadinessFacts) => boolean;
}

const gate = (g: ExternalGate, label_no: string): ReadinessRequirement => ({ id: `gate:${g}`, label_no, met: (f) => f.declared_gates.has(g) });
const BASE: readonly ReadinessRequirement[] = [
  { id: "constitution_verified", label_no: "Safety Constitution er signert og verifisert (EV-0)", met: (f) => f.constitution_verified },
  { id: "ledger_ok", label_no: "Endringsregisterets hash-kjede er intakt", met: (f) => f.ledger_ok },
  { id: "change_freeze_off", label_no: "Change freeze er av", met: (f) => f.change_freeze_off }
];

/** Per sovende del: hva som MÅ være på plass før en aktiveringsbeslutning kan vurderes. Alle har i tillegg `owner_decision` (navngitt D-beslutning) - aldri oppfylt av kode. */
export const READINESS: Readonly<Record<DormantEv, { title_no: string; why_dormant_no: string; requirements: readonly ReadinessRequirement[] }>> = {
  "EV-6": {
    title_no: "Selvkoding",
    why_dormant_no: "venter bevist worker-isolasjon (D-32); selvendring er frosset (D-397)",
    requirements: [
      ...BASE,
      gate("D-32", "Worker-isolasjon er verifisert på ekte vert (D-32: ressurs-/nettverksisolasjon, ekte branch/PR)"),
      { id: "job_runner_configured", label_no: "Jobb-container-runneren er konfigurert (JARVIS_JOB_RUNNER=container)", met: (f) => f.job_runner_configured }
    ]
  },
  "EV-11": {
    title_no: "Utfallslæring",
    why_dormant_no: "venter sporbare utfall fra UA-3/4/7 (hva skjedde etter et forslag/en handling)",
    requirements: [...BASE, gate("OUTCOME_TRACKING", "Sporbare utfall finnes og kan kobles til forslag/handlinger"), gate("UA-10_LIVE", "Situasjonsmotoren (UA-10) er observert live")]
  },
  "EV-13": {
    title_no: "Personlighetsmotor 2.0 (slidere)",
    why_dormant_no: "sliderne er ikke koblet til systemprompten; dagens personlighet er et tone-lag (D-214)",
    requirements: [...BASE, gate("PERSONALITY_SLIDERS_WIRED", "Slidere er koblet til tone-laget med eier-låser og canary (E1)")]
  },
  "EV-14": {
    title_no: "Uttrykkstilstand",
    why_dormant_no: "avhenger av EV-13; presenteres som stil, aldri som følelser",
    requirements: [...BASE, gate("EXPRESSION_STATE_WIRED", "Uttrykkstilstand er koblet til presentasjonslaget (med følelsesord-vakt)"), gate("PERSONALITY_SLIDERS_WIRED", "EV-13 er koblet")]
  },
  "EV-15": {
    title_no: "Mål-autonomi",
    why_dormant_no: "venter UA-10/UA-11 (situasjonsmotor + kontrollsentre)",
    requirements: [...BASE, gate("UA-10_LIVE", "Situasjonsmotoren (UA-10) er observert live"), gate("ADMIN_CONTROL_CENTER", "Kontrollsentrene (UA-11) finnes")]
  },
  "EV-18": {
    title_no: "Connector-fabrikk",
    why_dormant_no: "venter 3–5 beviste connectorer (mønsteret må være bevist før det genereres)",
    requirements: [
      ...BASE,
      { id: "proven_connectors>=3", label_no: "Minst 3 connectorer er konfigurert, live-testet og friske", met: (f) => f.proven_connectors >= 3 },
      gate("CONNECTOR_FACTORY", "Connector SDK/fabrikk er bygget og gjennomgått")
    ]
  },
  "EV-20": {
    title_no: "Uavhengig nødtilbakekalling og off-site",
    why_dormant_no: "venter bevist off-site restore (UA-0)",
    requirements: [...BASE, gate("OFFSITE_RESTORE", "Off-site backup og restore-drill er bevist med RTO/RPO")]
  },
  "EV-22": {
    title_no: "Evolution-flate i kontrollsentrene",
    why_dormant_no: "bygger på Admin Control Center (UA-11)",
    requirements: [...BASE, gate("ADMIN_CONTROL_CENTER", "Kontrollsentrene (UA-11) finnes")]
  },
  "EV-23": {
    title_no: "Eier-godkjenning av evolusjon i kontrollsentrene",
    why_dormant_no: "bygger på Admin Control Center (UA-11)",
    requirements: [...BASE, gate("ADMIN_CONTROL_CENTER", "Kontrollsentrene (UA-11) finnes")]
  }
};

export interface ReadinessVerdict {
  ev: DormantEv;
  title_no: string;
  why_dormant_no: string;
  /** Alltid false: kode aktiverer aldri noe. Aktivering krever en navngitt D-beslutning fra eieren. */
  activation_decision: false;
  /** Alle tekniske krav er oppfylt - da kan eieren vurdere en D-beslutning (ikke det samme som at noe er aktivert). */
  ready_for_owner_decision: boolean;
  met: string[];
  missing: Array<{ id: string; label_no: string }>;
}

export function parseDeclaredGates(raw: string | undefined): Set<string> {
  const known = new Set<string>(EXTERNAL_GATES);
  return new Set((raw ?? "").split(",").map((g) => g.trim()).filter((g) => known.has(g)));
}

export function evaluateReadiness(ev: DormantEv, facts: ReadinessFacts): ReadinessVerdict {
  const spec = READINESS[ev];
  const met = spec.requirements.filter((r) => r.met(facts)).map((r) => r.id);
  const missing = spec.requirements.filter((r) => !r.met(facts)).map((r) => ({ id: r.id, label_no: r.label_no }));
  return { ev, title_no: spec.title_no, why_dormant_no: spec.why_dormant_no, activation_decision: false, ready_for_owner_decision: missing.length === 0, met, missing };
}

export function evaluateAllReadiness(facts: ReadinessFacts): ReadinessVerdict[] {
  return (Object.keys(READINESS) as DormantEv[]).map((ev) => evaluateReadiness(ev, facts));
}
