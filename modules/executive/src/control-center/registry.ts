import type { IdentityContext } from "@jarvis/contracts";
import {
  composeControlCenterOverview, composeControlCenterReport, explainControlCenterNo, failureCategory, summarizeControlCenter, unknownCenterReport
} from "./report.ts";
import {
  CONTROL_CENTER_IDS, isControlCenterId,
  type ControlAction, type ControlCenterDefinition, type ControlCenterId, type ControlCenterOverview, type ControlCenterParts, type ControlCenterReport, type ControlSection
} from "./types.ts";

/**
 * WP-H0: registeret over kontrollsentrene. Hvert senter registreres med `register(center)`; `list()` gir de registrerte (i masterplanens rekkefølge). Resten av koden - verktøyet
 * `executive.get_control_center`, rutene `/control/centers` + `/control/center` og webflaten - går UTELUKKENDE via registeret, aldri direkte til et senter.
 *
 * Registeret gir fire garantier ingen enkeltbygger kan omgå:
 *  - EIER-KUN, FAIL-CLOSED: uten `isOwner` (eller for en annen identitet enn den suverene eieren) leveres ingen rapport. Rapportene er konfigurasjonsmetadata, og handlingene peker på eier-ruter.
 *  - FAIL-SOFT: en bygger som kaster eller er for treg gir en UNKNOWN-rapport med feilkategorien (aldri meldingen, aldri OK), og velter aldri oversikten over de andre sentrene.
 *  - AVLEDET STATUS: senterstatus og sammendrag regnes ut av `composeControlCenterReport` fra seksjonene.
 *  - SISTE FORSVARSLINJE MOT HEMMELIGHETER: `redact` (i drift `scanForSecrets`) kjøres over alle menneskelesbare strenger i den ferdige rapporten - ikke over id-er, endepunkt eller handlingskropper (strukturelle felt).
 *
 * KROKPUNKT FOR NYE SENTRE: et senter (Finance, Memory, Agent, Operations, Value, Privacy, Security) bygges som en `ControlCenterDefinition` og registreres i
 * `registerControlCenters()` (`apps/api/src/control-center/register.ts`). Value-senteret (WP-C4) registreres der med id `value` så snart verdiløkke-rapporten finnes på main; til da står
 * `value` i oversiktens `unregistered`-liste - aldri som «OK».
 */

export class ControlCenterAccessError extends Error {
  constructor(readonly reason: string) {
    super(`control_center_denied:${reason}`);
    this.name = "ControlCenterAccessError";
  }
}

class ControlCenterTimeoutError extends Error {
  constructor() {
    super("control_center_build_timeout");
    this.name = "ControlCenterTimeoutError";
  }
}

export interface ControlCenterRegistryOptions {
  /**
   * Er identiteten den suverene eieren? FAIL-CLOSED: uten predikat nektes alle. I drift: `resolveAuthorityMode(...) === "SOVEREIGN"` (eier-person, eier-tenant, ingen delegasjon).
   * Gjennomgang av PR #316 (M-2): produksjonskoden lager registeret KUN via `createControlCenterRegistry` (`apps/api/src/control-center/register.ts`), som bygger predikatet fra den samme
   * `AuthorityConfig`-en som Policy Gateway bruker - aldri et eget, inline predikat i `main.ts`.
   */
  isOwner?: (identity: IdentityContext) => boolean;
  now?: () => Date;
  /** Maks tid per senterbygging (ms). Standard 7000. Over grensen blir senteret UNKNOWN. */
  buildTimeoutMs?: number;
  /**
   * Redigerer hemmeligheter i menneskelesbare strenger (se klassekommentaren). Standard: ingen (kun for rene enhetstester av byggerne).
   * Gjennomgang av PR #316 (M-2): en redigerer som IKKE faktisk redigerer (f.eks. identitetsfunksjonen `(t) => t`) avvises ved konstruksjon (`control_center_redact_not_effective`) - se `isEffectiveRedactor`.
   * I drift settes den av `createControlCenterRegistry` (`scanForSecrets`) og er ikke en parameter kallerne kan overstyre.
   */
  redact?: (text: string) => string;
}

/**
 * En syntetisk, IKKE-ekte nøkkel i anthropic-format, bygd under kjøring slik at kildekoden ikke inneholder noe som ligner en hemmelighet. Brukes kun av `isEffectiveRedactor`.
 */
const REDACTION_CANARY = ["sk", "ant", "Kanarifugl", "0123456789"].join("-");

/**
 * Selvtest av en redigerer: fjerner den et kjent nøkkelformat fra en tekst? Identitetsfunksjonen og enhver annen redigerer som lar nøkkelen stå består ikke. Registeret krever dette av hver `redact`
 * det får, slik at «redigeringen er på» ikke bare er en påstand om oppstartskoden (gjennomgang av PR #316, M-2: `redact: (t) => t` i `main.ts` passerte alle tester).
 */
export function isEffectiveRedactor(redact: (text: string) => string): boolean {
  try {
    const out = redact(`nøkkel ${REDACTION_CANARY} slutt`);
    // Uavhengig av store/små bokstaver: en «redigerer» som bare endrer skrivemåten på nøkkelen har ikke fjernet den.
    return typeof out === "string" && !out.toLowerCase().includes(REDACTION_CANARY.toLowerCase());
  } catch {
    return false;
  }
}

export interface RegisteredControlCenter {
  id: ControlCenterId;
  title_no: string;
  description_no: string;
}

const DEFAULT_BUILD_TIMEOUT_MS = 7_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ControlCenterTimeoutError()), ms); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function redactSection(section: ControlSection, redact: (text: string) => string): ControlSection {
  return {
    ...section,
    title_no: redact(section.title_no),
    summary_no: redact(section.summary_no),
    source: redact(section.source),
    items: section.items.map((item) => ({
      ...item,
      label: redact(item.label),
      ...(item.detail_no !== undefined ? { detail_no: redact(item.detail_no) } : {}),
      ...(item.facts !== undefined
        ? { facts: Object.fromEntries(Object.entries(item.facts).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v])) }
        : {})
    }))
  };
}

function redactAction(action: ControlAction, redact: (text: string) => string): ControlAction {
  return {
    ...action,
    label: redact(action.label),
    description_no: redact(action.description_no),
    ...(action.rollback_no !== undefined ? { rollback_no: redact(action.rollback_no) } : {})
  };
}

/** Redigerer kun de menneskelesbare feltene. Id-er, endepunkt og handlingskropper er strukturelle og røres ikke (en falsk positiv der ville ødelagt handlingen). */
export function redactControlCenterReport(report: ControlCenterReport, redact: (text: string) => string): ControlCenterReport {
  return {
    ...report,
    title_no: redact(report.title_no),
    summary_no: redact(report.summary_no),
    sections: report.sections.map((s) => redactSection(s, redact)),
    actions: report.actions.map((a) => redactAction(a, redact))
  };
}

const SAFE_ERROR_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function buildFailureReason(err: unknown): string {
  if (err instanceof ControlCenterTimeoutError) return "målingen tok for lang tid";
  // Våre egne konstante feilkoder (snake_case) er trygge å vise; alt annet reduseres til klassenavn (+ SQLSTATE).
  if (err instanceof Error && err.message.length <= 64 && SAFE_ERROR_CODE.test(err.message)) return `målingen feilet (${err.message})`;
  return `målingen feilet (${failureCategory(err)})`;
}

/**
 * Nøkkel for «samme bygging»: ALLE identitetsfelt (sortert), ikke bare tenant - rapporten kan avhenge av person, enhet og kanal (Authority Center viser «denne enheten»). Ulik identitet deler aldri en bygging.
 */
function identityKey(identity: IdentityContext): string {
  const record = identity as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(record).sort().map((k) => [k, record[k]]));
}

export class ControlCenterRegistry {
  private readonly centers = new Map<ControlCenterId, ControlCenterDefinition>();
  private readonly now: () => Date;
  private readonly buildTimeoutMs: number;
  /** Gjennomgang av PR #316 (L-3): bygginger som pågår akkurat nå, per senter og identitet - se `buildOne`. */
  private readonly inflight = new Map<string, Promise<ControlCenterReport>>();

  constructor(private readonly options: ControlCenterRegistryOptions = {}) {
    if (options.redact !== undefined && !isEffectiveRedactor(options.redact)) throw new Error("control_center_redact_not_effective");
    this.now = options.now ?? (() => new Date());
    this.buildTimeoutMs = options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  }

  /** Registrerer ett senter. Ukjent id, tom tittel/beskrivelse, manglende `build` og dobbeltregistrering avvises (feiler høyt ved oppstart, ikke stille i drift). */
  register(center: ControlCenterDefinition): void {
    if (!isControlCenterId(center.id)) throw new Error(`control_center_unknown_id:${String(center.id).slice(0, 40)}`);
    if (typeof center.title_no !== "string" || center.title_no.trim() === "") throw new Error(`control_center_missing_title:${center.id}`);
    if (typeof center.description_no !== "string" || center.description_no.trim() === "") throw new Error(`control_center_missing_description:${center.id}`);
    if (typeof center.build !== "function") throw new Error(`control_center_missing_build:${center.id}`);
    if (this.centers.has(center.id)) throw new Error(`control_center_already_registered:${center.id}`);
    this.centers.set(center.id, center);
  }

  /** De registrerte sentrene i masterplanens rekkefølge. */
  list(): RegisteredControlCenter[] {
    return CONTROL_CENTER_IDS.filter((id) => this.centers.has(id)).map((id) => {
      const c = this.centers.get(id) as ControlCenterDefinition;
      return { id, title_no: c.title_no, description_no: c.description_no };
    });
  }

  has(id: string): boolean {
    return isControlCenterId(id) && this.centers.has(id);
  }

  /** Eier-kun, fail-closed (uten krav til autentiseringsstyrke - se `authorizeRead`). Brukes av mutasjonsporten (`cancel_task`). */
  authorize(identity: IdentityContext): { allowed: boolean; reason: string } {
    if (!this.options.isOwner) return { allowed: false, reason: "control_center_owner_check_not_configured" };
    let isOwner = false;
    try {
      isOwner = this.options.isOwner(identity) === true;
    } catch {
      isOwner = false;
    }
    return isOwner ? { allowed: true, reason: "owner" } : { allowed: false, reason: "control_center_owner_only" };
  }

  /**
   * Gjennomgang av PR #316 (L-4): LESE-porten = eier OG signert enhetsøkt (`auth_strength === "signed"`). Kontrollsentrene er en eier-flate med enhetssignatur: rapportene er eierens konfigurasjonsmetadata og
   * handlingene peker på eier-ruter, så en passiv/aktiv økt (tale alene gir aldri forhøyet styrke) leser dem ikke - selv om personen er eieren. `authorize` (kun eier) beholdes for MUTASJONENE
   * (`cancel_task`): en stopp-handling skal virke selv under redusert autentisering (STEP_UP_EXEMPT_ACTIONS).
   */
  authorizeRead(identity: IdentityContext): { allowed: boolean; reason: string } {
    const owner = this.authorize(identity);
    if (!owner.allowed) return owner;
    return identity.auth_strength === "signed" ? owner : { allowed: false, reason: "control_center_requires_signed_device_session" };
  }

  private assertAuthorized(identity: IdentityContext): void {
    const decision = this.authorizeRead(identity);
    if (!decision.allowed) throw new ControlCenterAccessError(decision.reason);
  }

  /**
   * Gjennomgang av PR #316 (L-3): SINGLE-FLIGHT. Samtidige forespørsler om samme senter for samme identitet (dobbeltklikk, to faner, oversikt + detalj som overlapper) deler ÉN bygging i stedet for å lese kildene to ganger.
   * Bevisst IKKE en resultat-cache: en rapport som er noen sekunder gammel rett etter at eieren har trykket Pause ville vist tilstanden FØR handlingen. Bygginger som ikke overlapper bygger alltid på nytt
   * (presence mot credential-kilden har sin egen, kortlevde cache). En bygging avsluttes alltid (tidsavbrudd), så en hengende bygging holder aldri nøkkelen opptatt.
   */
  private buildOne(center: ControlCenterDefinition, identity: IdentityContext): Promise<ControlCenterReport> {
    const key = `${center.id}\u0000${identityKey(identity)}`;
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const attempt = this.buildFresh(center, identity);
    this.inflight.set(key, attempt);
    const clear = (): void => { if (this.inflight.get(key) === attempt) this.inflight.delete(key); };
    attempt.then(clear, clear);
    return attempt;
  }

  private async buildFresh(center: ControlCenterDefinition, identity: IdentityContext): Promise<ControlCenterReport> {
    const now = this.now();
    let report: ControlCenterReport;
    try {
      const parts: ControlCenterParts = await withTimeout(center.build({ identity, now }), this.buildTimeoutMs);
      report = composeControlCenterReport(center, parts, now);
    } catch (err) {
      report = unknownCenterReport(center, buildFailureReason(err), now);
    }
    return this.options.redact ? redactControlCenterReport(report, this.options.redact) : report;
  }

  /** Full rapport for ett senter, eller `null` når senteret ikke er registrert (ukjent id eller ikke koblet inn). Kaster `ControlCenterAccessError` for andre enn eieren. */
  async report(id: string, identity: IdentityContext): Promise<ControlCenterReport | null> {
    this.assertAuthorized(identity);
    if (!isControlCenterId(id)) return null;
    const center = this.centers.get(id);
    if (!center) return null;
    return this.buildOne(center, identity);
  }

  /** Oversikt over alle ti sentre: de registrerte bygges parallelt (hver fail-soft), de øvrige listes som `unregistered`. */
  async overview(identity: IdentityContext): Promise<ControlCenterOverview> {
    this.assertAuthorized(identity);
    const registered = this.list();
    const reports = await Promise.all(registered.map((c) => this.buildOne(this.centers.get(c.id) as ControlCenterDefinition, identity)));
    return composeControlCenterOverview(reports.map((r, i) => summarizeControlCenter(r, (registered[i] as RegisteredControlCenter).description_no)), this.now());
  }

  /** `explain(center)`: deterministisk norsk forklaring av hvorfor senteret har sin status (UA-11: «Jarvis forklarer hvorfor»). `null` for ukjent/ikke-koblet senter. */
  async explain(id: string, identity: IdentityContext): Promise<string | null> {
    const report = await this.report(id, identity);
    return report === null ? null : explainControlCenterNo(report);
  }
}
