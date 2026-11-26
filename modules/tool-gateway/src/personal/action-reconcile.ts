import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { holdPersonalTarget, type PersonalActionExecutorDeps, type PersonalActionIndexEntry } from "./action-executor.ts";
import { actionRequestDigest, type PersonalActionRow } from "./action-journal.ts";
import { isRecord, parseIsoInstant, type Params } from "./critical-ops.ts";

/**
 * WP-G2c (D-483, JARVIS-113 b, Q-73 pkt 10): AVSTEMMING av journalrader med utfall `outcome_unknown` (en handling som ble sendt til utstyret, men der sluttilstanden ikke ble bekreftet: tidsavbrudd, uleselig readback, feil sluttilstand).
 * Eier-initiert (`POST /personal/actions/reconcile`: kun eier, enhetssignert økt, ingen modellflate, ingen delegat). Avstemmingen LESER målets faktiske tilstand på nytt via den EKSISTERENDE lese-handlingen (`read_critical_state` /
 * `read_vehicle_state`: klasse A gjennom ToolGateway, så policy, kill switch, frys, credential-revokering og mål-allowlist gjelder som for enhver lesing) og avgjør raden - ALDRI en automatisk retry, og ALDRI et kall til selve
 * skrive-verktøyet (eksekutoren kalles ikke; kun lese-handlingen). Reglene (hver er en test):
 *  - `applied` KUN når handlingens EGEN etterbetingelse (`op.post`, den samme som gatewayens readback) holder på en FERSK, brukbar og ferdig-settlet lesing - og ingen nyere handling mot samme mål kan ha forårsaket tilstanden
 *    (da kan sluttilstanden ikke tilskrives denne raden: den står). For bil kreves i tillegg `fresh` og et `observed_at` som ikke er eldre enn forespørselen (en bufret «låst» fra før kommandoen bekrefter aldri noe).
 *  - `failed` KUN når det er BEVIST at handlingen ikke skjedde: for tilstandshandlinger at HAs `last_changed` (når tilstandsverdien sist endret seg) er ELDRE enn forespørselen (minus klokkeskjevhet) og tilstanden fortsatt er den LAGREDE før-tilstanden
 *    (uten lagret før-tilstand: aldri `failed`), for scene/skript at markøren (siste aktivering/start) er UENDRET siden forhåndsvisningen - og i begge tilfeller kun uten en nyere handling mot målet (den kan ha reversert kommandoen) og først en frist etter
 *    at eksekutoren konkluderte (en sen forespørsel skal ha rukket å dø). Klokkebeviset bortfaller når HAs klokke er MÅLT (HTTP-`Date`) til å avvike mer enn `HA_MEASURED_SKEW_LIMIT_MS`. Bil kan ikke bevises «ikke utført»
 *    (adapter-kontrakten har ikke noe endringstidspunkt): kun `applied` er mulig der (PARTIAL).
 *  - ellers forblir raden `outcome_unknown`, med tidspunkt, antall forsøk og en kort begrunnelseskode (aldri utstyrets tekst) - aldri en gjetning. Typiske koder: `read_failed:*`, `observed_in_transition`, `state_changed_since_request`, `later_action_on_target`.
 *  - idempotent: en terminal rad leses ikke på nytt og skrives ikke (`already_terminal`); et nytt forsøk på en rad som fortsatt er ukjent leser på nytt og teller opp. Samme prosess-lokale lås som handlingene (`holdPersonalTarget`): en handling i
 *    flukt mot målet gir `personal_action_target_busy` (409, ingenting leses eller skrives), så en avstemming aldri tolker en pågående kommando som beviset for en eldre rad.
 *  - revidert: hvert forsøk som endrer raden skriver `personal.action_reconciled` (uten innhold) i samme transaksjon som journalendringen (migrasjon 144: triggeren tvinger teller +1, uforanderlig `request_params`, ingen endring av en terminal rad).
 * Begrensninger (ærlige): attribusjon («ingen nyere handling») ser kun journalen i eierens egen (tenant, memory space); en endring utenfor Jarvis (manuelt, en HA-automasjon) kan ikke skilles fra kommandoen - sluttilstanden er likevel det eieren
 * ba om. `last_changed` forutsetter at HAs og Jarvis' klokker ikke avviker mer enn `HA_CLOCK_SKEW_MS`; en skjevhet over `HA_MEASURED_SKEW_LIMIT_MS` fanges kun når HA-svaret har en `Date`-header (ellers, eller bak en proxy med egen klokke, gjelder antakelsen ukontrollert). `requested`-rader (en krasjet vinner) avstemmes ikke her: de blir `outcome_unknown` først når samme nøkkel sendes på nytt (eksekutoren).
 */
export type ReconcileResolution = "applied" | "failed" | "unknown" | "already_terminal";

export interface ReconcileOutcome {
  /** Raden slik den står ETTER avstemmingen. */
  action: PersonalActionRow;
  resolution: ReconcileResolution;
  /** Kort, stabil kode for hvorfor raden ble avgjort/står (aldri utstyrets tekst). For `already_terminal`: radens lagrede begrunnelse (eller `already_terminal`). */
  basis: string;
  /** Den leste, normaliserte tilstanden (kun enumererte tilstandsord, tall og tidsstempler; ubetrodd data), eller `null` når ingenting ble lest. */
  observed: Params | null;
  /** `true` = raden var allerede avgjort (ingenting lest eller skrevet). */
  replayed: boolean;
}

export interface ReconcileDomainDeps {
  toolId: string;
  readAction: string;
}

export interface PersonalActionReconcileDeps {
  executor: PersonalActionExecutorDeps;
  /** Domene -> lese-handlingen (samme kart som rutene). Et domene uten oppføring (flagget AV) kan ikke avstemmes. */
  domains: ReadonlyMap<string, ReconcileDomainDeps>;
  /** Klokke (ms) for alders-/frist-reglene; tester injiserer den. Standard `Date.now`. */
  now?: () => number;
}

/** Frist etter at eksekutoren konkluderte `outcome_unknown` før `failed` kan bevises (lengste gateway-frist er < 6 min; en sen forespørsel skal ha rukket å dø - også uten avbruddsmekanismen). Samme 5 min som eksekutorens `IN_FLIGHT_GRACE_MS`. */
export const RECONCILE_FAILED_MIN_AGE_MS = 5 * 60_000;
/** Klokkeskjevhet mellom HA og Jarvis som `failed`-beviset tåler: `last_changed` må være eldre enn forespørselen med minst dette (en endring forårsaket av kommandoen har `last_changed` >= forespørselen). */
export const HA_CLOCK_SKEW_MS = 60_000;
/**
 * Største MÅLTE klokkeskjevhet (HA mot Jarvis, begge retninger) som `failed`-beviset tåler (fiks-runde 1, LOW-1). Transporten måler skjevheten fra HTTP-`Date` i HA-svaret (`clock_skew_ms` i den leste tilstanden, nøyaktig til ca. ett sekund).
 * `HA_CLOCK_SKEW_MS` alene dekker bare at HA ligger FREM (da blir `last_changed` for ny: forsiktig); ligger HA BAK med mer enn 60 s pluss tiden til en revertering, kan en endring kommandoen selv forårsaket få en `last_changed` som ser eldre ut enn
 * forespørselen, og en revertert handling ville blitt en falsk `failed`. Over denne grensen finnes derfor ikke noe klokkebevis. Mangler målingen (ingen `Date`; en proxy kan også sette sin egen klokke), er oppførselen som før (dokumentert begrensning).
 */
export const HA_MEASURED_SKEW_LIMIT_MS = 30_000;

/** Markør-handlinger (scene/skript): tilstanden er et «sist aktivert/startet»-tidsstempel som bare går fremover. `observed` = feltet i den leste tilstanden, `expected` = parameteren fra forhåndsvisningen. */
const MARKER_OPS: Readonly<Record<string, { observed: string; expected: string }>> = {
  critical_scene: { observed: "last_activated", expected: "expected_last_activated" },
  critical_script: { observed: "last_triggered", expected: "expected_last_triggered" }
};

export interface ReconcileDecision { resolution: "applied" | "failed" | "unknown"; basis: string }
const applied = (basis: string): ReconcileDecision => ({ resolution: "applied", basis });
const failed = (basis: string): ReconcileDecision => ({ resolution: "failed", basis });
const unknown = (basis: string): ReconcileDecision => ({ resolution: "unknown", basis });

export interface ReconcileEvidence {
  entry: PersonalActionIndexEntry;
  /** De lagrede, verifiserte parameterne forespørselen hadde. */
  params: Params;
  row: Pick<PersonalActionRow, "requested_at" | "completed_at" | "before_state">;
  /** Den ferske, normaliserte tilstanden fra lese-handlingen. */
  observed: Params;
  nowMs: number;
  /** Finnes en nyere handling mot samme mål som kan ha forårsaket den observerte tilstanden? */
  laterAction: boolean;
}

const ms = (value: unknown): number => (value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN);

/** RENT (ingen I/O): hva beviser den observerte tilstanden om raden? Hver gren er en test (`wpg2c-reconcile-decision`). */
export function decideReconcile(e: ReconcileEvidence): ReconcileDecision {
  const { entry, params, observed, row } = e;
  const requestedMs = ms(row.requested_at);
  if (!Number.isFinite(requestedMs)) return unknown("request_time_invalid");
  // Brukbarhet: en lesing som sier «utilgjengelig/ukjent» eller «på vei» (lås som låser, alarm som armerer) sier ingenting om sluttilstanden - aldri en gjetning.
  if (observed["usable"] === false) return unknown("observed_unusable");
  if (observed["settled"] === false) return unknown("observed_in_transition");
  if (entry.domain === "car") {
    // En bil-observasjon bevises ikke av adapterens `fresh` alene: den må være levende OG ikke eldre enn forespørselen (en bufret tilstand fra FØR kommandoen er aldri et bevis).
    if (observed["fresh"] !== true) return unknown("observed_not_fresh");
    const at = parseIsoInstant(observed["observed_at"]);
    if (at === null) return unknown("observed_at_missing");
    if (at < requestedMs) return unknown("observed_before_request");
  }
  const marker = MARKER_OPS[entry.op.action];

  let reached: boolean;
  try { reached = entry.op.post(observed, params); } catch { reached = false; }
  if (reached) {
    // Den ønskede sluttilstanden er observert. En NYERE handling mot samme mål kan like gjerne ha forårsaket den: da kan den ikke tilskrives denne raden.
    if (e.laterAction) return unknown("later_action_on_target");
    return applied(marker ? "marker_advanced" : "postcondition_observed");
  }

  // Sluttilstanden er IKKE observert. `failed` krever et BEVIS for at handlingen ikke skjedde - ellers står raden.
  if (entry.domain === "car") return unknown("not_executed_unprovable_for_car");
  // En nyere handling mot samme mål (også en Jarvis selv har gjort, f.eks. en motsatt kommando) kan ha endret målet - også tilbake til før-tilstanden - så «uendret siden forespørselen» sier ingenting om DENNE raden (fiks-runde 1, LOW-1).
  if (e.laterAction) return unknown("later_action_on_target");
  let basis: string;
  if (marker) {
    if (observed["running"] === true) return unknown("script_running");
    const expectedRaw = params[marker.expected];
    const expected = expectedRaw === null || expectedRaw === undefined ? null : parseIsoInstant(expectedRaw);
    if (expectedRaw !== null && expectedRaw !== undefined && expected === null) return unknown("marker_param_unparseable");
    const current = parseIsoInstant(observed[marker.observed]);
    if (current !== expected) return unknown("marker_state_unclear");
    basis = "marker_unchanged_since_preflight";
  } else {
    // Klokkebeviset (HAs `last_changed` mot Jarvis' `requested_at`) gjelder kun med samsvarende klokker: en målt skjevhet over grensen (eller en måling som er til stede men uleselig) er fail-closed; manglende måling (ingen `Date`) = som før.
    const skew = observed["clock_skew_ms"];
    if (skew !== undefined && skew !== null && !(typeof skew === "number" && Number.isFinite(skew) && Math.abs(skew) <= HA_MEASURED_SKEW_LIMIT_MS)) return unknown("ha_clock_skew");
    const changed = parseIsoInstant(observed["last_changed"]);
    if (changed === null) return unknown("change_time_unavailable");
    if (changed + HA_CLOCK_SKEW_MS > requestedMs) return unknown("state_changed_since_request");
    // Før-tilstanden MÅ være lagret og stemme med den observerte: uten den er «uendret» et løst påstand (fiks-runde 1, LOW-1).
    const before = isRecord(row.before_state) ? row.before_state["state"] : undefined;
    if (typeof before !== "string") return unknown("before_state_missing");
    if (before !== observed["state"]) return unknown("before_state_differs");
    basis = "no_state_change_since_request";
  }
  const concludedMs = ms(row.completed_at ?? row.requested_at);
  if (!Number.isFinite(concludedMs) || e.nowMs - concludedMs < RECONCILE_FAILED_MIN_AGE_MS) return unknown("too_recent_for_failed_proof");
  return failed(basis);
}

const RECONCILE_ID = /^pers-act-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Begrunnelseskoden fra en lesefeil: små bokstaver/tall/`_:.-`, maks 60 tegn (databasens CHECK på `reconcile_basis` tillater 80 inkl. prefikset). Alt som ikke er tekst gir en tom kode - aldri en feil. */
const safeCode = (reason: unknown): string => (typeof reason === "string" ? reason : "").toLowerCase().replace(/[^a-z0-9_:.-]/g, "_").slice(0, 60);

export interface ReconcileInput { action_id: string }

/**
 * Avstemmer ÉN journalrad. Kaster kun våre egne, bevisste feilkoder (`personal_action_*`): ikke eier/delegat, ugyldig id, ikke funnet, `requested` (kan ikke avstemmes), domene ikke slått på, målet er opptatt. Alt annet (leser feilet, bevis mangler) er et
 * NORMALT utfall: raden forblir `outcome_unknown` med begrunnelse.
 */
export async function reconcilePersonalAction(deps: PersonalActionReconcileDeps, identity: IdentityContext, input: ReconcileInput): Promise<ReconcileOutcome> {
  // Eier-assert (fiks-runde 1, I-1): ruten er porten (eier + enhetssignert økt), men funksjonen skal heller ikke kunne kalles av en delegat - da ville en lesing mislyktes og et forsøk blitt telt uten at eieren ba om det. FØR noe leses.
  if (identity.delegation_id !== undefined) throw new Error("personal_action_reconcile_owner_only");
  if (typeof input.action_id !== "string" || !RECONCILE_ID.test(input.action_id)) throw new Error("personal_action_reconcile_id_invalid");
  const { journal, index, gateway } = deps.executor;
  const tenantId = identity.tenant_id;
  const space = identity.memory_space_id as MemorySpace;

  const row = await journal.findById(tenantId, space, input.action_id);
  if (row === null) throw new Error("personal_action_not_found");
  // Kun personen som startet handlingen (eieren) kan avstemme den; en annen person i samme (tenant, rom) får ingenting - verken avgjørelse, lagret utfall eller et talt forsøk.
  if (row.actor_person_id !== identity.person_id) throw new Error("personal_action_reconcile_owner_only");
  // Idempotens: en rad som allerede er avgjort leses ikke på nytt og skrives ikke - svaret er det lagrede.
  if (row.status === "applied" || row.status === "failed") return { action: row, resolution: "already_terminal", basis: row.reconcile_basis ?? "already_terminal", observed: null, replayed: true };
  if (row.status !== "outcome_unknown") throw new Error("personal_action_not_reconcilable");

  const entry = index.get(`${row.domain}.${row.action}`);
  const domain = deps.domains.get(row.domain);
  if (entry === undefined || domain === undefined || entry.toolId !== row.tool_id || !gateway.get(domain.toolId, domain.readAction)) throw new Error("personal_action_domain_not_enabled");

  // Samme lås som handlingene: en handling (eller en annen avstemming) i flukt mot målet = ingenting leses eller skrives.
  const release = holdPersonalTarget(row.domain, row.target_ref);
  if (release === null) throw new Error("personal_action_target_busy");
  try {
    const record = async (decision: ReconcileDecision, observed: Params | null): Promise<ReconcileOutcome> => {
      const written = await journal.recordReconcile(identity, space, row.action_id, {
        status: decision.resolution === "unknown" ? "outcome_unknown" : decision.resolution, basis: decision.basis, observed: observed as JsonValue | null
      });
      // En samtidig avgjørelse (en replay med samme nøkkel) vant: det lagrede utfallet gjelder.
      if (!written.updated) return { action: written.row, resolution: "already_terminal", basis: written.row.reconcile_basis ?? "already_terminal", observed: null, replayed: true };
      return { action: written.row, resolution: decision.resolution, basis: decision.basis, observed, replayed: false };
    };

    // De lagrede parameterne MÅ stemme med forespørselens digest (bevis for at de er nøyaktig det som ble bedt om) og peke på radens mål.
    const params = row.request_params;
    if (params === null || params === undefined || !isRecord(params)) return await record(unknown("request_params_missing"), null);
    if (actionRequestDigest(row.domain, row.action, params) !== row.request_digest) return await record(unknown("request_params_unverifiable"), null);
    if (String(params[entry.op.targetParam] ?? "").slice(0, 200) !== row.target_ref) return await record(unknown("request_params_unverifiable"), null);

    // Lesing av NØYAKTIG målet via den eksisterende lese-handlingen (aldri skrive-verktøyet).
    const read = await gateway.execute({ identity, tool_id: domain.toolId, action: domain.readAction, parameters: { [entry.op.targetParam]: row.target_ref } });
    if (!read.ok) return await record(unknown(`read_failed:${safeCode(read.reason)}`), null);
    if (read.data === null || read.data === undefined) return await record(unknown("target_not_found"), null);
    if (!isRecord(read.data)) return await record(unknown("state_malformed"), null);
    const observed = read.data as Params;

    // Attribusjon: en nyere handling mot samme mål (innen eierens journal) kan ha forårsaket tilstanden. Kun nødvendig å vite når sluttilstanden er observert, men billig - alltid beregnet.
    const laterAction = await journal.hasLaterAction(tenantId, space, row.action_id);
    return await record(decideReconcile({ entry, params, row, observed, nowMs: (deps.now ?? Date.now)(), laterAction }), observed);
  } finally {
    release();
  }
}
