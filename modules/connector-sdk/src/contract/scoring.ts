import { isUnknown, safeIdentifier, type ConnectorManifest } from "../manifest.ts";
import { redactText } from "./redact.ts";
import type { AdapterKind, ContractCheckResult } from "./types.ts";

/**
 * WP-I (D-472): AKSEPTANSE-SCORING mot masterplanens Appendiks B («Connector acceptance nivå R / A»). Nivå R = lese-/synk-connectorer; nivå A = skrive-/utførende (inkluderer alle R-krav).
 * Hvert krav får en ÆRLIG status - aldri en falsk «bestått»:
 *  - `proven`: kontraktstest-kittet KJØRTE og beviste det mot en EKTE transport (`adapter_kind: real_transport`, bak en fake leverandørserver - broen er DEFERRED, så ingen connector har dette i dag).
 *  - `modelled` (review M4): kittet KJØRTE og beviste det mot en FAKE bygget av manifestet selv (`adapter_kind: fake_from_manifest`). Det beviser at manifestets garantier er konsistente og at kittet kan felle brudd -
 *    IKKE at en ekte transport holder dem (referansefakene er laget fra manifestene de testes mot; f.eks. har GitHub et dokumentert ekte gap i replay-beskyttelsen som en fake aldri kan vise).
 *  - `declared`: manifestet PÅSTÅR det og er gyldig (CI-vakten drift-sjekker det som kan avledes), men ingenting har utført det.
 *  - `gap`: kittet feilet, eller manifestet deklarerer selv at det mangler/er delvis (circuit breaker `partial`, D-41-gap, ufullstendig klasse D-kjede ...).
 *  - `not_proven`: krever evidens kittet aldri kan gi (live smoke mot ekte konto/sandbox, reversibel live-handling) og som manifestet ikke oppgir som tilstede.
 *  - `not_applicable`: kravet gjelder ikke denne connectoren (f.eks. avstemming for en connector som ikke flytter penger).
 * Ingenting her er `VERIFIED`: det krever en kjøring mot ekte leverandør (NAS/sandbox), jf. fellesbriefens regel 11.
 */

export type AcceptanceStatus = "proven" | "modelled" | "declared" | "gap" | "not_proven" | "not_applicable";

export interface AcceptanceItem {
  id: string;
  level: "R" | "A";
  /** Kravet slik Appendiks B formulerer det. */
  requirement: string;
  basis: "kit" | "manifest" | "external" | "composite";
  status: AcceptanceStatus;
  /** Norsk, redaksjonssikker begrunnelse (hva som bevises/deklareres/mangler). */
  evidence: string;
}

export interface AcceptanceReport {
  /** Proveniens for kit-bevisene (review M4): en fake bygget av manifestet gir høyst `modelled`; kun en ekte transport kan gi `proven`. */
  adapter_kind: AdapterKind;
  /** R når connectoren kun leser; A så snart den har skrive-/utførende handlinger (Appendiks B). */
  required_level: "R" | "A";
  items: AcceptanceItem[];
  summary: Record<AcceptanceStatus, number>;
  /** `gaps` = minst ett navngitt gap; `live_evidence_pending` = ingen gap, men live-/ekstern evidens mangler; `complete_on_paper` = alt bevist eller deklarert (fortsatt IKKE verifisert mot ekte leverandør). */
  verdict: "gaps" | "live_evidence_pending" | "complete_on_paper";
  gaps: string[];
}

type Statuses = Map<string, ContractCheckResult["status"]>;

/** Kit-bevis for en gruppe sjekker: alle bestått = proven; en feilet = gap; ellers (hoppet over) = not_proven. */
function fromKit(statuses: Statuses, ids: readonly string[]): { status: "proven" | "gap" | "not_proven"; failed: string[]; skipped: string[] } {
  const failed = ids.filter((id) => statuses.get(id) === "fail");
  const skipped = ids.filter((id) => statuses.get(id) !== "pass" && statuses.get(id) !== "fail");
  return { status: failed.length > 0 ? "gap" : skipped.length > 0 ? "not_proven" : "proven", failed, skipped };
}

const list = (xs: readonly string[]): string => xs.join(", ");

/**
 * `adapter_kind` har en fail-safe standard: uten opplysning regnes beviset som en fake (`modelled`). Kun `real_transport` gir `proven`.
 * Review N3: dette er en REN funksjon - det tredje argumentet er KALLERENS påstand om proveniens. Den eneste kilden som er sikret er `runConnectorContract`, som utleder det av den modul-private branden
 * (`provenance.ts`) og dermed aldri kan gi `proven` for en kopi av en fake. Kall aldri `scoreAcceptance(..., "real_transport")` utenom en bro som faktisk kjørte en ekte transport.
 */
export function scoreAcceptance(manifest: ConnectorManifest, checks: readonly ContractCheckResult[], adapterKind: AdapterKind = "fake_from_manifest"): AcceptanceReport {
  const kind: AdapterKind = adapterKind === "real_transport" ? "real_transport" : "fake_from_manifest";
  /** Kit-bevisets styrke: `proven` kun mot en ekte transport, ellers `modelled`. */
  const kitStatus = (s: "proven" | "gap" | "not_proven"): AcceptanceStatus => (s === "proven" ? (kind === "real_transport" ? "proven" : "modelled") : s);
  const st: Statuses = new Map(checks.map((c) => [c.id, c.status]));
  const writeCapable = manifest.actions.some((a) => a.effect !== "read");
  const items: AcceptanceItem[] = [];
  // Review M2: evidensteksten siterer manifestfelt (handlingsnøkler, notater, uverifiserte scopes) - alt går gjennom redigeringen, så en hemmelighetsform i et uvalidert manifest aldri havner i rapporten.
  const add = (id: string, level: "R" | "A", requirement: string, basis: AcceptanceItem["basis"], status: AcceptanceStatus, evidence: string): void => {
    const text = status === "modelled" ? `${evidence} [modellert: fake bygget fra manifestet - ikke bevist mot en ekte transport]` : evidence;
    items.push({ id, level, requirement, basis, status, evidence: redactText(text) });
  };
  const m = manifest;

  // ----- Nivå R ---------------------------------------------------------------------------------------------------------
  const d41 = m.d41_audit;
  if (isUnknown(d41)) add("R.docs_checked", "R", "Official/current API docs and terms checked", "manifest", "gap", "D-41-revisjonen mangler (skeleton): leverandørdokumentasjonen er ikke gjennomgått i manifestet");
  else if (!d41.scopes_verified_against_docs) add("R.docs_checked", "R", "Official/current API docs and terms checked", "manifest", "gap", `dokumentasjon referert, men scopes er ikke fullt verifisert: ${list(d41.unverified_scopes)}`);
  else add("R.docs_checked", "R", "Official/current API docs and terms checked", "manifest", "declared", `dokumentasjon lest ${d41.verified_on ?? "?"} og referert (vilkår/ToS er ikke et manifestfelt og er ikke vurdert her)`);

  const secretsOk = st.get("manifest.secret_scan") === "pass";
  const provider = m.auth.scopes.provider;
  if (!secretsOk) add("R.minimal_scopes_vault_refs", "R", "Minimal auth scopes and vault refs", "composite", "gap", "manifestet har en hemmelighetsform (kun hvelvreferanser er lov)");
  else if (isUnknown(provider)) add("R.minimal_scopes_vault_refs", "R", "Minimal auth scopes and vault refs", "composite", "gap", "leverandør-scopes er ikke oppgitt (skeleton)");
  else add("R.minimal_scopes_vault_refs", "R", "Minimal auth scopes and vault refs", "composite", "declared", `${provider.length} leverandør-scope(s) oppgitt; kun hvelvreferanser (skanning bestått); at scopene er MINIMALE er en vurdering, ikke bevist`);

  const dataKeys = ["schemas", "provenance", "freshness", "retention"] as const;
  const dataUnknown = dataKeys.filter((k) => isUnknown(m.data[k]));
  if (dataUnknown.length > 0) add("R.data_schema_provenance_freshness_retention", "R", "Data schema/provenance/freshness/retention", "manifest", "gap", `mangler i manifestet: ${list(dataUnknown)}`);
  else add("R.data_schema_provenance_freshness_retention", "R", "Data schema/provenance/freshness/retention", "manifest", "declared", "skjema, proveniens, ferskhet og retensjon er deklarert");

  const rIds = checks.filter((c) => c.level === "R").map((c) => c.id);
  const rKit = fromKit(st, rIds.filter((id) => id !== "data.delete_semantics_declared"));
  const fa = m.tests.fake_adapter;
  const ct = m.tests.contract;
  const testsDeclared = !isUnknown(fa) && !isUnknown(ct) && fa.status !== "missing" && ct.status !== "missing";
  if (rKit.status === "gap") add("R.fake_adapter_contract_tests", "R", "Fake adapter + contract tests", "kit", "gap", `kontraktstester feilet: ${list(rKit.failed)}`);
  else if (!testsDeclared) add("R.fake_adapter_contract_tests", "R", "Fake adapter + contract tests", "composite", "gap", "kittet består, men manifestet oppgir ikke fake-adapter og kontrakttester (tests.fake_adapter/contract)");
  else add("R.fake_adapter_contract_tests", "R", "Fake adapter + contract tests", "kit", kitStatus(rKit.status === "proven" ? "proven" : "not_proven"), rKit.status === "proven" ? "alle nivå R-sjekker bestått mot adapteren under test" : `hoppet over: ${list(rKit.skipped)}`);

  const inj = fromKit(st, ["trust.labelling", "trust.injection_is_data"]);
  const injDecl = !isUnknown(m.trust.injection_exposure);
  add("R.injection_classification", "R", "Prompt-injection classification for untrusted content", "composite", inj.status === "gap" ? "gap" : !injDecl ? "gap" : kitStatus(inj.status), inj.status === "gap" ? `feilet: ${list(inj.failed)}` : !injDecl ? "injeksjonseksponering er ikke vurdert i manifestet" : "ubetrodd innhold merkes ubetrodd og forblir data (kittet), eksponeringen er vurdert (manifestet)");

  const live = m.tests.live_smoke;
  if (!isUnknown(live) && live.status === "present") add("R.live_read_smoke", "R", "Live read/sync smoke", "external", "declared", `manifestet oppgir at en live smoke finnes (${list(live.paths)}); ikke kjørt av kittet`);
  else add("R.live_read_smoke", "R", "Live read/sync smoke", "external", "not_proven", isUnknown(live) ? "live smoke er ukjent (skeleton)" : `live smoke er ${live.status}${live.note !== undefined ? ` - ${live.note}` : ""}`);

  const aud = fromKit(st, ["audit.no_secret_values", "redaction.no_secret_shapes"]);
  add("R.audit_without_secret_values", "R", "Audit without secret values", "kit", kitStatus(aud.status), aud.status === "proven" ? "revisjon og utdata har aldri credential eller hemmelighetsformer, for alle feilklasser (kittet)" : aud.status === "gap" ? `feilet: ${list(aud.failed)}` : `hoppet over: ${list(aud.skipped)}`);

  const hr = fromKit(st, ["health.degrades_and_recovers", "errors.taxonomy", "timeout.abort"]);
  const cb = m.operations.circuit_breaker;
  const rb = m.operations.runbook;
  const hrGaps: string[] = [];
  if (hr.status === "gap") hrGaps.push(`kittet feilet: ${list(hr.failed)}`);
  if (isUnknown(cb)) hrGaps.push("circuit breaker er ukjent");
  else if (cb.status !== "implemented" && cb.status !== "not_applicable") hrGaps.push(`circuit breaker er ${cb.status}`);
  if (isUnknown(rb)) hrGaps.push("runbook er ukjent");
  add("R.health_retry_breaker_runbook", "R", "Health/retry/circuit breaker/runbook", "composite", hrGaps.length > 0 ? "gap" : hr.status === "proven" ? "declared" : "not_proven",
    hrGaps.length > 0 ? hrGaps.join("; ") : hr.status === "proven" ? "helse, feiltaksonomi og tidsavbrudd bevist (kittet); circuit breaker og runbook er deklarert" : `hoppet over: ${list(hr.skipped)}`);

  const rv = fromKit(st, ["revoke.and_reauth"]);
  const del = m.data.delete_semantics;
  add("R.delete_revoke_reauth", "R", "Delete/revoke/reauth tested", "composite", rv.status === "gap" || isUnknown(del) ? "gap" : kitStatus(rv.status),
    rv.status === "gap" ? "tilbakekall/reauth feilet i kittet" : isUnknown(del) ? "slettesemantikk er ukjent (skeleton)" : rv.status === "proven" ? "tilbakekall og reauth bevist (kittet); slettesemantikk deklarert" : "tilbakekall/reauth ikke kjørt");

  const mo = m.operations.maintenance_owner;
  add("R.cost_maintenance_measurement", "R", "Cost/maintenance measurement", "manifest", !isUnknown(mo) && mo.ledger !== undefined ? "declared" : "gap",
    !isUnknown(mo) && mo.ledger !== undefined ? "vedlikeholdseier og connector_maintenance_log er deklarert; selve målingen ligger i vedlikeholdsjournalen (connector-gjeld)" : "vedlikeholdseier/-journal er ikke oppgitt");

  const rItems = [...items];

  // ----- Nivå A ---------------------------------------------------------------------------------------------------------
  if (writeCapable) {
    const rGaps = rItems.filter((i) => i.status === "gap").map((i) => i.id);
    const rPending = rItems.filter((i) => i.status === "not_proven").map((i) => i.id);
    add("A.all_level_r", "A", "All Level R requirements", "composite", rGaps.length > 0 ? "gap" : rPending.length > 0 ? "not_proven" : "declared",
      rGaps.length > 0 ? `nivå R har gap: ${list(rGaps)}` : rPending.length > 0 ? `nivå R venter på evidens: ${list(rPending)}` : "alle nivå R-krav er bevist eller deklarert");

    const au = fromKit(st, ["authority.tenant_isolation", "authority.delegated"]);
    add("A.authority_target_resolution", "A", "Owner/delegated authority and target-account resolution", "kit", kitStatus(au.status), au.status === "proven" ? "tenant-binding (inkl. kryss-tenant-replay) og delegert autoritet bevist (kittet)" : au.status === "gap" ? `feilet: ${list(au.failed)}` : `hoppet over: ${list(au.skipped)}`);

    add("A.risk_class_a_d", "A", "Risk class A-D", "manifest", st.get("manifest.valid") === "pass" ? "declared" : "gap",
      st.get("manifest.valid") === "pass" ? `risikoklasse per handling er deklarert for alle ${m.actions.length} handlinger (CI-vakten drift-sjekker mot registeret)` : "manifestet er ugyldig");

    const pv = fromKit(st, ["params.validated_before_provider", "evidence.before_after"]);
    add("A.param_validation_state_readback", "A", "Deterministic parameter validation and state readback", "kit", kitStatus(pv.status), pv.status === "proven" ? "ugyldige kall (hver påkrevd parameter fjernet i tur) avvises før leverandøren; før-/etter-readback bevist (kittet)" : pv.status === "gap" ? `feilet: ${list(pv.failed)}` : `hoppet over: ${list(pv.skipped)}`);

    const idem = fromKit(st, ["idempotency.same_key_one_effect", "idempotency.distinct_keys_distinct_effects", "idempotency.required_key_enforced", "idempotency.key_reuse_other_payload", "timeout.after_effect_unknown_not_replayed", "timeout.before_effect_applies_nothing", "errors.write_5xx_is_outcome_unknown"]);
    // Kun de to sjekkene som har en LEGITIM hopp-over (ingen handling krever nøkkel / ingen påkrevde parametre) kan hoppes over uten å svekke beviset. Hoppes noe annet over - f.eks. fordi connectorens
    // eneste skrivehandling er en utsatt klasse D (ingen utførbare skrivehandlinger, review N1) - er idempotens IKKE bevist, og kravet kan aldri bli `modelled`.
    const idemOptionalSkipsOnly = idem.status === "not_proven" && idem.skipped.every((id) => id === "idempotency.required_key_enforced" || id === "idempotency.key_reuse_other_payload");
    const idemStatus = idemOptionalSkipsOnly ? "proven" : idem.status;
    add("A.idempotency_replay", "A", "Idempotency/replay protection", "kit", kitStatus(idemStatus),
      idemStatus === "gap" ? `feilet: ${list(idem.failed)}`
        : idemStatus === "not_proven" ? `hoppet over (ingenting å kjøre mot, f.eks. ingen utførbare skrivehandlinger): ${list(idem.skipped)}`
          : "samme nøkkel = én effekt, annen nyttelast under samme nøkkel avvises, ukjent utfall (tidsavbrudd etter effekt, 5xx på skriving) gjentas aldri, avbrudd før effekt er trygt å prøve igjen (kittet)");

    const ev = fromKit(st, ["evidence.before_after"]);
    add("A.before_after_evidence", "A", "Before/after evidence", "kit", kitStatus(ev.status), ev.status === "proven" ? "før-/etter-evidens bevist: finnes, og skiller seg når tilstanden endret seg (kittet)" : ev.status === "gap" ? "evidens mangler" : "ikke kjørt (ingen handling lover evidens)");

    const rbk = fromKit(st, ["recovery.rollback_restores_state"]);
    add("A.rollback_or_documented_recovery", "A", "Rollback/compensating action or documented no-rollback recovery", "composite",
      rbk.status === "gap" ? "gap" : rbk.status === "proven" ? kitStatus("proven") : "declared",
      rbk.status === "gap" ? "kompensasjon gjenopprettet ikke tilstanden" : rbk.status === "proven" ? "automatisk rollback gjenoppretter tilstanden (kittet); øvrige handlinger har dokumentert rollback/ingen reversering (manifestet)" : "ingen automatisk rollback; dokumentert rollback/ingen reversering per handling (manifestet)");

    const dActions = m.actions.filter((a) => a.authority.risk_class === "D");
    const deferred = dActions.filter((a) => a.reversibility.class_d_chain?.status === "deferred");
    const cd = fromKit(st, ["classd.chain_and_notification"]);
    if (dActions.length === 0) add("A.classd_snapshot_notification", "A", "D-class snapshot/checkpoint where possible + immediate notification", "kit", "not_applicable", "ingen klasse D-handlinger");
    else if (cd.status === "gap") add("A.classd_snapshot_notification", "A", "D-class snapshot/checkpoint where possible + immediate notification", "kit", "gap", "klasse D-kjeden feilet i kittet");
    else if (deferred.length > 0) add("A.classd_snapshot_notification", "A", "D-class snapshot/checkpoint where possible + immediate notification", "composite", "gap", `ufullstendig klasse D-kjede (utilgjengelig under håndhevelse, DEFERRED): ${list(deferred.map((a) => safeIdentifier(a.key)))}`);
    else add("A.classd_snapshot_notification", "A", "D-class snapshot/checkpoint where possible + immediate notification", "kit", kitStatus(cd.status), cd.status === "proven" ? "komplett kjede, evidens og umiddelbar varsling bevist (kittet)" : "ikke kjørt");

    const money = m.actions.filter((a) => a.effect === "pay");
    if (money.length === 0) add("A.finance_reconciliation", "A", "Finance reconciliation for money-affecting actions", "manifest", "not_applicable", "ingen penge-berørende handlinger");
    else add("A.finance_reconciliation", "A", "Finance reconciliation for money-affecting actions", "manifest", m.operations.reconciliation?.required === true ? "declared" : "gap",
      m.operations.reconciliation?.required === true ? `avstemming er påkrevd og beskrevet for ${list(money.map((a) => safeIdentifier(a.key)))}` : `penge-berørende handlinger (${list(money.map((a) => safeIdentifier(a.key)))}) uten deklarert avstemming`);

    const pr = fromKit(st, ["control.pause_blocks_all", "revoke.and_reauth"]);
    add("A.pause_revoke_kill_switch", "A", "Pause/revoke/kill-switch tested", "kit", kitStatus(pr.status), pr.status === "proven" ? "pause og tilbakekall stanser alle kall (også gjentakelser) uten leverandørkall (kittet)" : pr.status === "gap" ? `feilet: ${list(pr.failed)}` : `hoppet over: ${list(pr.skipped)}`);

    if (!isUnknown(live) && live.status === "present") add("A.live_reversible_action_smoke", "A", "Live reversible action smoke in real environment", "external", "declared", `manifestet oppgir en live smoke (${list(live.paths)}); ikke kjørt av kittet`);
    else add("A.live_reversible_action_smoke", "A", "Live reversible action smoke in real environment", "external", "not_proven", isUnknown(live) ? "live smoke er ukjent (skeleton)" : `live smoke er ${live.status}${live.note !== undefined ? ` - ${live.note}` : ""}`);
  }

  const summary: Record<AcceptanceStatus, number> = { proven: 0, modelled: 0, declared: 0, gap: 0, not_proven: 0, not_applicable: 0 };
  for (const i of items) summary[i.status] += 1;
  const gaps = items.filter((i) => i.status === "gap").map((i) => i.id);
  return {
    adapter_kind: kind,
    required_level: writeCapable ? "A" : "R",
    items, summary,
    verdict: gaps.length > 0 ? "gaps" : summary.not_proven > 0 ? "live_evidence_pending" : "complete_on_paper",
    gaps
  };
}
