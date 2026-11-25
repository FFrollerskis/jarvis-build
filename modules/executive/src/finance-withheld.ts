import type { FrozenConnectorEntry, KillSwitchState, OwnerControlState, RevokedCredentialEntry } from "@jarvis/owner-controls";
import type { SituationAutonomyPolicy } from "@jarvis/situations";
import {
  financeWithheldMarker, isFinanceConnectorId, isFinanceCredentialRef, isFinanceDerivedSituationDomain, isFinanceToolId,
  type ConnectorStatus, type FinanceWithheldMarker
} from "@jarvis/tool-gateway";
import { composeSloReport } from "./slo/report.ts";
import type { SloReport } from "./slo/types.ts";
import type { CapabilityStatus } from "./types.ts";

/**
 * WP-N1b (JARVIS-116 a, K2): RENE formingsfunksjoner som holder FINANSAVLEDET innhold tilbake fra statusverktøyene til en sky-/ukjent modell (kalt av `ExecutiveTransport`/`ExecutiveService` når den sentrale lesningen
 * `withholdFinanceFromCurrentModel()` sier ja). Ingen I/O, ingen lesing av modell eller flagg her: kallerne avgjør OM, disse avgjør HVA. Alle fail-closed: noe som ikke kan avgjøres (ikke-streng, ukjent id) regnes som finansavledet.
 * Hvert resultat får det nøytrale merket (`finance_withheld: true` + fast merknad), også når ingenting ble fjernet, så merket aldri røper om noe fantes.
 */

/** `owner_control` slik en SKYmodell ser det: finansavledede koblinger/legitimasjon er borte, og ALLE fritekst-begrunnelser (eierens egne ord, kan nevne finans) er holdt tilbake (`reason: null`). */
export interface OwnerControlStateForCloud {
  kill_switch: Omit<KillSwitchState, "reason"> & { reason: null };
  frozen_connectors: Array<Omit<FrozenConnectorEntry, "reason"> & { reason: null }>;
  revoked_credentials: Array<Omit<RevokedCredentialEntry, "reason"> & { reason: null }>;
  /** `true`: fritekst-begrunnelsene (global stopp, frysing, tilbakekall) er holdt tilbake - ukjent hva eieren har skrevet der (strengeste regel). */
  reasons_withheld: true;
}

export function shapeOwnerControlForCloud(state: OwnerControlState): OwnerControlStateForCloud {
  return {
    kill_switch: { ...state.kill_switch, reason: null },
    frozen_connectors: state.frozen_connectors.filter((f) => !isFinanceConnectorId(f.connector_id)).map((f) => ({ ...f, reason: null })),
    revoked_credentials: state.revoked_credentials.filter((r) => !isFinanceCredentialRef(r.credential_ref)).map((r) => ({ ...r, reason: null })),
    reasons_withheld: true
  };
}

/** Domenene en eier har pauset, uten finansavledede (`spend`: eieren har skrudd av økonomivarsler). */
export function shapePausedDomainsForCloud(paused: readonly string[]): string[] {
  return paused.filter((d) => !isFinanceDerivedSituationDomain(d));
}

/** Autonomi-bindinger uten de som gjelder finansdomenet (`spend`) eller et finansverktøy (verktøy-id/handling/parametre kan bære beløp og id-er). */
export function shapeAutonomyPoliciesForCloud(policies: readonly SituationAutonomyPolicy[]): SituationAutonomyPolicy[] {
  return policies.filter((p) => !isFinanceDerivedSituationDomain(p.domain) && !isFinanceToolId(p.tool_id));
}

/** `get_capability_status` uten finansverktøyene (id, handlinger, `configured`) og uten finanstilkoblingenes helse (tilstand og feildetaljer). Finansverktøy er uansett ikke brukbare for en skymodell (utførelseslåsen). */
export function shapeCapabilityStatusForCloud(status: CapabilityStatus): CapabilityStatus & FinanceWithheldMarker {
  return {
    ...status,
    chat_accessible_tools: status.chat_accessible_tools.filter((t) => !isFinanceToolId(t.tool_id) && !isFinanceConnectorId(t.tool_id)),
    connector_health: status.connector_health.filter((h) => !isFinanceToolId(h.tool_id) && !isFinanceConnectorId(h.tool_id)),
    ...financeWithheldMarker()
  };
}

/** `get_connector_status` uten finanskoblingene (id, navn, credential-refs, konfigurasjon, helse). */
export function shapeConnectorsForCloud(connectors: readonly ConnectorStatus[]): ConnectorStatus[] {
  return connectors.filter((c) => c.category !== "finance" && !isFinanceConnectorId(c.id));
}

/**
 * SLO-rapporten uten kostnadsdriften («Kostnad per kall økte fra 3 til 6.7 øre»): `cost_per_call_ore`-funnene utelates og rapporten KOMPONERES PÅ NYTT fra resten (sammendraget bygges av de gjenværende funnene), så teksten
 * aldri bærer en rest av kostnaden. Selve tjenestemålene (suksess, latens) har ingen kostnad og er uendret.
 */
export function shapeSloReportForCloud(report: SloReport): SloReport & FinanceWithheldMarker {
  const drift = report.drift === null ? null : { ...report.drift, findings: report.drift.findings.filter((f) => f.metric !== "cost_per_call_ore") };
  return { ...composeSloReport({ as_of: report.as_of, slos: report.slos, drift, data_quality: report.data_quality }), ...financeWithheldMarker() };
}
