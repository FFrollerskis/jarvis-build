// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import {
  controlAction, controlItem, controlSection, unknownControlSection,
  type ControlAction, type ControlCenterBuildContext, type ControlCenterDefinition, type ControlCenterParts, type ControlItem, type ControlSection, type ControlStatus,
  type GoldenSuiteControl, type GoldenSuiteRunResult
} from "@jarvis/executive";
import type { KillSwitch, OwnerControls } from "@jarvis/policy";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { actionRequiresStepUp } from "../step-up.ts";
import { readDomainPauses, readFinanceKillSwitch } from "./authority.ts";
import {
  DAY_MS, bySeverityThenLabel, countsNo, globalRows, mergeBy, relativeNo, riskOf, safeCategory, settle, tenantRead, toInt, toIso,
  type ControlCenterPool, type Settled
} from "./shared.ts";

/**
 * WP-H2 (UA-11 Admin Control Center, masterplan v4.0 kap. 21) - SECURITY CENTER: revisjon, credential-hendelser, mistenkelig innhold/eksfiltrering, gjenoppretting og golden-suite (selvtest av forsvaret).
 *
 * Kun LESING av EKSISTERENDE kilder - ingen nye eksterne kall, ingen skriving, aldri innhold:
 *  - REVISJON: `audit_events` (append-only; kun antall, typer, avslagskategorier og tidsstempler - `payload` leses ALDRI) + om append-only-triggeren er intakt (`pg_trigger`, systemkatalogen);
 *  - CREDENTIAL- OG TILGANGSHENDELSER: `audit_events` for kontrollhandlingene (tilbakekall/gjenoppretting/frys/enhet/kill switch) + det som er tilbakekalt/frosset akkurat nå (`owner_control_state`);
 *  - MISTENKELIG INNHOLD: bekreftelser utløst av ubetrodd innhold (`action_confirmations.taint_reasons`), minnekarantene og avviste forslag (`audit_events`). Det som IKKE kan måles herfra står rett ut:
 *    antall hemmeligheter fjernet av hemmelighetsskanneren, treff holdt tilbake av skyskjermen og radar-karantene er ikke lagret noe sted (prosesslokale tellere/logg) - `ikke målt`;
 *  - GJENOPPRETTING: kill switch, finans-nødbryter, frosne connectorer, tilbakekalte credentials og pausede domener (det som venter på å bli opphevet) + hvor mange gjenopprettingshandlinger som er utført;
 *  - GOLDEN-SUITE: knappen som kjører den deterministiske suiten (`golden-suite.ts`) fra kontrollsenteret. Lesende (ingen modell, ingen database, ingen skriving) og BARE tilbudt når `JARVIS_CONTROL_GOLDEN_SUITE=on`.
 *    Resultatet vises med to digester; det holdes kun i prosessens minne (nullstilles ved omstart).
 *
 * Alle gjenopprettingshandlinger bor i Autoritet-senteret (samme eksisterende ruter, step-up og revisjon) - dette senteret viser kun TILSTANDEN og har ingen egne knapper utover selvtesten.
 */

const AUDIT_WINDOW_MS = 7 * DAY_MS;
const EVENT_WINDOW_MS = 30 * DAY_MS;
const MAX_REASON_ROWS = 12;
const MAX_LISTED_REFS = 10;

/** Kontrollhandlingene (executive.* og owner_controls.*) som er credential-/tilgangsendringer. */
export const CREDENTIAL_ACTIONS: readonly string[] = [
  "set_connector_credential", "revoke_credential", "restore_credential", "freeze_connector", "unfreeze_connector", "revoke_device", "test_connector", "activate_kill_switch", "deactivate_kill_switch"
];
/** Handlingene som GJENOPPRETTER noe en eier har stanset. */
export const RECOVERY_ACTIONS: readonly string[] = ["deactivate_kill_switch", "restore_credential", "unfreeze_connector", "resume_domain", "disable_finance_kill_switch"];
/** Revisjonstyper for avviste innlogginger, innrulleringer og grants. */
export const ACCESS_DENIAL_TYPES: readonly string[] = ["device.enrollment_denied", "session_grant.denied", "identity.denied"];
/** Revisjonstyper for minnekarantene og avviste minneforslag (ubetrodd innhold som ble stoppet). */
export const MEMORY_GUARD_TYPES: readonly string[] = ["memory.quarantined_conflict", "memory.rejected"];

const ACTION_NO: Readonly<Record<string, string>> = {
  set_connector_credential: "ny nøkkel lagt inn", revoke_credential: "credential tilbakekalt", restore_credential: "credential gjenopprettet", freeze_connector: "connector frosset", unfreeze_connector: "connector gjenopptatt",
  revoke_device: "enhet tilbakekalt", test_connector: "connector testet", activate_kill_switch: "kill switch aktivert", deactivate_kill_switch: "kill switch opphevet", resume_domain: "domene gjenopptatt", disable_finance_kill_switch: "finans-nødbryter opphevet"
};
const CONFIRMATION_STATUS_NO: Readonly<Record<string, string>> = { pending: "venter på deg", approved: "godkjent", consumed: "godkjent og brukt", rejected: "avvist", expired: "utløpt uten svar" };
const ACCESS_TYPE_NO: Readonly<Record<string, string>> = { "device.enrollment_denied": "innrullering avvist", "session_grant.denied": "sesjons-grant avvist", "identity.denied": "identitet avvist" };
const MEMORY_TYPE_NO: Readonly<Record<string, string>> = { "memory.quarantined_conflict": "minne i karantene (motstrid)", "memory.rejected": "minneforslag avvist" };

// ---------------------------------------------------------------------------------------------------------------------
// Lesere (ekte SQL - bevist som app-rolle i wph2-security-center-db.test.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface SecurityAggregates {
  audit: { events_7d: number; events_24h: number; denied_24h: number; denied_7d: number; failed_7d: number; outcome_unknown_7d: number; last_event_at: string | null; last_denied_at: string | null };
  deny_reasons: Array<{ reason: string; n: number }>;
  credential_events: Array<{ action: string; executed: number; denied: number; failed: number; last_at: string | null }>;
  access_denials: Array<{ type: string; n: number; last_at: string | null }>;
  tainted_confirmations: Array<{ status: string; n: number; last_at: string | null }>;
  memory_guard: Array<{ type: string; n: number; last_at: string | null }>;
  recovery_events: Array<{ action: string; n: number; last_at: string | null }>;
}

export async function readSecurityAggregates(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<SecurityAggregates> {
  const d1 = new Date(nowMs - DAY_MS);
  const d7 = new Date(nowMs - AUDIT_WINDOW_MS);
  const d30 = new Date(nowMs - EVENT_WINDOW_MS);
  return tenantRead(pool, tenantId, async (query) => {
    const a = (await query(
      `SELECT (count(*))::int AS events_7d,
              (count(*) FILTER (WHERE at >= $3))::int AS events_24h,
              (count(*) FILTER (WHERE type = 'tool.denied' AND at >= $3))::int AS denied_24h,
              (count(*) FILTER (WHERE type = 'tool.denied'))::int AS denied_7d,
              (count(*) FILTER (WHERE type = 'tool.failed'))::int AS failed_7d,
              (count(*) FILTER (WHERE type IN ('tool.postcondition_unverified', 'tool.execution_in_flight')))::int AS outcome_unknown_7d,
              max(at) AS last_event_at, max(at) FILTER (WHERE type = 'tool.denied') AS last_denied_at
         FROM audit_events WHERE tenant_id = $1 AND at >= $2`, [tenantId, d7, d1]
    ))[0] ?? {};
    const reasons = await query(
      `SELECT reason, (count(*))::int AS n FROM audit_events WHERE tenant_id = $1 AND at >= $2 AND type = 'tool.denied' GROUP BY reason ORDER BY n DESC, reason LIMIT ${MAX_REASON_ROWS}`, [tenantId, d7]
    );
    const creds = await query(
      `SELECT action, (count(*) FILTER (WHERE type = 'tool.executed'))::int AS executed, (count(*) FILTER (WHERE type = 'tool.denied'))::int AS denied,
              (count(*) FILTER (WHERE type = 'tool.failed'))::int AS failed, max(at) AS last_at
         FROM audit_events WHERE tenant_id = $1 AND at >= $2 AND tool_id IN ('owner_controls', 'executive') AND action = ANY($3::text[]) GROUP BY action ORDER BY action`,
      [tenantId, d30, [...CREDENTIAL_ACTIONS]]
    );
    const access = await query(
      `SELECT type, (count(*))::int AS n, max(at) AS last_at FROM audit_events WHERE tenant_id = $1 AND at >= $2 AND type = ANY($3::text[]) GROUP BY type ORDER BY type`, [tenantId, d30, [...ACCESS_DENIAL_TYPES]]
    );
    const tainted = await query(
      `SELECT status, (count(*))::int AS n, max(created_at) AS last_at FROM action_confirmations WHERE tenant_id = $1 AND created_at >= $2 AND cardinality(taint_reasons) > 0 GROUP BY status ORDER BY status`, [tenantId, d30]
    );
    const memory = await query(
      `SELECT type, (count(*))::int AS n, max(at) AS last_at FROM audit_events WHERE tenant_id = $1 AND at >= $2 AND type = ANY($3::text[]) GROUP BY type ORDER BY type`, [tenantId, d30, [...MEMORY_GUARD_TYPES]]
    );
    const recovery = await query(
      `SELECT action, (count(*))::int AS n, max(at) AS last_at FROM audit_events WHERE tenant_id = $1 AND at >= $2 AND type = 'tool.executed' AND tool_id IN ('owner_controls', 'executive') AND action = ANY($3::text[]) GROUP BY action ORDER BY action`,
      [tenantId, d30, [...RECOVERY_ACTIONS]]
    );
    return {
      audit: {
        events_7d: toInt(a["events_7d"]), events_24h: toInt(a["events_24h"]), denied_24h: toInt(a["denied_24h"]), denied_7d: toInt(a["denied_7d"]), failed_7d: toInt(a["failed_7d"]),
        outcome_unknown_7d: toInt(a["outcome_unknown_7d"]), last_event_at: toIso(a["last_event_at"]), last_denied_at: toIso(a["last_denied_at"])
      },
      deny_reasons: mergeBy(reasons.map((r) => ({ reason: safeCategory(r["reason"]), n: toInt(r["n"]) })), (r) => r.reason, (x, y) => ({ reason: x.reason, n: x.n + y.n })),
      credential_events: creds.map((r) => ({ action: safeCategory(r["action"]), executed: toInt(r["executed"]), denied: toInt(r["denied"]), failed: toInt(r["failed"]), last_at: toIso(r["last_at"]) })),
      access_denials: access.map((r) => ({ type: safeCategory(r["type"]), n: toInt(r["n"]), last_at: toIso(r["last_at"]) })),
      tainted_confirmations: tainted.map((r) => ({ status: safeCategory(r["status"]), n: toInt(r["n"]), last_at: toIso(r["last_at"]) })),
      memory_guard: memory.map((r) => ({ type: safeCategory(r["type"]), n: toInt(r["n"]), last_at: toIso(r["last_at"]) })),
      recovery_events: recovery.map((r) => ({ action: safeCategory(r["action"]), n: toInt(r["n"]), last_at: toIso(r["last_at"]) }))
    };
  });
}

export type AuditTriggerState = "enabled" | "disabled" | "missing";

/** Er append-only-triggeren på `audit_events` intakt? Systemkatalogen (`pg_trigger`) - ingen rader leses. `O` = aktiv i alle modi; alt annet (`D` av, `R` kun replika) regnes som deaktivert. */
export async function readAuditTrigger(pool: ControlCenterPool): Promise<AuditTriggerState> {
  const rows = await globalRows(pool, `SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgrelid = 'audit_events'::regclass AND tgname = 'audit_events_append_only' AND NOT tgisinternal`);
  const row = rows[0];
  if (row === undefined) return "missing";
  return row["enabled"] === "O" || row["enabled"] === "A" ? "enabled" : "disabled";
}

// ---------------------------------------------------------------------------------------------------------------------
// Senteret
// ---------------------------------------------------------------------------------------------------------------------

export interface SecurityCenterDeps {
  pool: ControlCenterPool;
  /** Risikoklassen til selvtest-knappen leses fra verktøydefinisjonen (aldri en kopi). */
  toolGateway: Pick<ToolGateway, "get">;
  /** Frosne connectorer og tilbakekalte credentials (kun referansenavn og tidspunkt, aldri verdier). */
  ownerControls: Pick<OwnerControls, "listFrozenConnectorsDurable" | "listRevokedCredentialsDurable">;
  killSwitch: Pick<KillSwitch, "currentStateDurable">;
  /** Golden-suite-kjøreren. Utelatt = knappen er AV (`JARVIS_CONTROL_GOLDEN_SUITE`): senteret viser da kun at selvtesten ikke er tilgjengelig herfra. */
  goldenSuite?: GoldenSuiteControl;
}

const digestNo = (d: string): string => `${d.slice(0, 12)}…`;

export function createSecurityCenter(deps: SecurityCenterDeps): ControlCenterDefinition {
  return {
    id: "security",
    title_no: "Sikkerhet",
    description_no: "Revisjon, credential- og tilgangshendelser, mistenkelig innhold, det som venter på gjenoppretting og golden-suite (selvtest av forsvaret) - kun tall og tilstander, aldri innhold",
    async build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts> {
      const nowMs = ctx.now.getTime();
      const nowIso = ctx.now.toISOString();
      const tenantId = ctx.identity.tenant_id;
      const rel = (iso: string | null | undefined): string => relativeNo(iso, nowMs);
      const failed = (r: Settled<unknown>): string => (r.ok ? "" : ` (${r.category})`);

      const [aggR, triggerR, killR, controlsR, financeR, pausesR] = await Promise.all([
        settle(() => readSecurityAggregates(deps.pool, tenantId, nowMs)),
        settle(() => readAuditTrigger(deps.pool)),
        settle(() => deps.killSwitch.currentStateDurable()),
        settle(async () => ({ frozen: await deps.ownerControls.listFrozenConnectorsDurable(), revoked: await deps.ownerControls.listRevokedCredentialsDurable() })),
        settle(() => readFinanceKillSwitch(deps.pool, tenantId)),
        settle(() => readDomainPauses(deps.pool))
      ]);

      const sections: ControlSection[] = [];
      const actions: ControlAction[] = [];

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 1. Revisjon
      // -------------------------------------------------------------------------------------------------------------------------------------------
      {
        const items: ControlItem[] = [];
        if (triggerR.ok) {
          const t = triggerR.value;
          items.push(controlItem({
            id: "append_only", label: "Revisjonsloggen er append-only (trigger)", status: t === "enabled" ? "OK" : "FAIL",
            detail_no: t === "enabled" ? "Triggeren som forbyr endring og sletting av revisjonsrader er aktiv." : t === "missing" ? "Triggeren som forbyr endring/sletting av revisjonsrader FINNES IKKE - revisjonsloggen er ikke lenger bevist uforanderlig." : "Triggeren som forbyr endring/sletting av revisjonsrader er DEAKTIVERT - revisjonsloggen er ikke lenger bevist uforanderlig.",
            facts: { trigger: t }
          }));
        } else {
          items.push(controlItem({ id: "append_only", label: "Revisjonsloggen er append-only (trigger)", status: "UNKNOWN", detail_no: `Kunne ikke kontrolleres${failed(triggerR)}.`, facts: { trigger: null } }));
        }
        if (aggR.ok) {
          const a = aggR.value.audit;
          items.push(controlItem({
            id: "activity", label: "Revisjonsaktivitet", status: a.events_7d === 0 ? "UNKNOWN" : "OK", observed_at: a.last_event_at,
            detail_no: a.events_7d === 0
              ? "Ingen revisjonsrader siste 7 døgn: enten er det ingen aktivitet, eller revisjonsskrivingen feiler - det kan ikke skilles herfra (ikke målt)."
              : `${a.events_7d} revisjonsrader siste 7 døgn (${a.events_24h} siste døgn); siste ${rel(a.last_event_at)}.`,
            facts: { events_7d: a.events_7d, events_24h: a.events_24h, last_event_at: a.last_event_at }
          }));
          items.push(controlItem({
            id: "denied", label: "Avslag fra policy og verktøyport", status: "OK", observed_at: a.last_denied_at,
            detail_no: `${a.denied_7d} avslag siste 7 døgn (${a.denied_24h} siste døgn)${a.last_denied_at ? `; siste ${rel(a.last_denied_at)}` : ""}. Avslag er en forsvarslinje som virker, ikke i seg selv et funn.`,
            facts: { denied_7d: a.denied_7d, denied_24h: a.denied_24h, last_denied_at: a.last_denied_at }
          }));
          for (const r of aggR.value.deny_reasons) {
            items.push(controlItem({ id: `reason:${r.reason}`, label: `Avslagsårsak: ${r.reason}`, status: "OK", detail_no: `${r.n} avslag siste 7 døgn med denne årsaken (fri tekst vises ikke - kun kategori).`, facts: { reason: r.reason, count: r.n } }));
          }
          items.push(controlItem({
            id: "outcome_unknown", label: "Verktøyutføringer med ukjent utfall", status: a.outcome_unknown_7d > 0 ? "WARN" : "OK",
            detail_no: a.outcome_unknown_7d > 0 ? `${a.outcome_unknown_7d} utføringer siste 7 døgn har ukjent eller ubekreftet utfall (bivirkningen kan ha skjedd).` : "Ingen utføringer med ukjent utfall siste 7 døgn.",
            facts: { outcome_unknown_7d: a.outcome_unknown_7d, failed_7d: a.failed_7d }
          }));
        } else {
          items.push(controlItem({ id: "activity", label: "Revisjonsaktivitet", status: "UNKNOWN", detail_no: `Kunne ikke leses${failed(aggR)}.`, facts: { measured: false } }));
        }
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "audit", title_no: "Revisjon", observed_at: nowIso, items,
          source: "audit_events (append-only; kun type, antall, avslagskategori og tidsstempler - payload leses aldri; tenant-RLS) + pg_trigger (systemkatalogen)",
          summary_no: aggR.ok ? `${aggR.value.audit.events_7d} revisjonsrader siste 7 døgn, ${aggR.value.audit.denied_7d} avslag. ${countsNo(items)}.` : `Revisjonsaktiviteten er ikke målt. ${countsNo(items)}.`
        }));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 2. Credential- og tilgangshendelser
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (aggR.ok) {
        const v = aggR.value;
        const items: ControlItem[] = v.credential_events.map((e) => controlItem({
          id: `action:${e.action}`, label: `Siste 30 døgn: ${ACTION_NO[e.action] ?? e.action}`, status: e.denied > 0 || e.failed > 0 ? "WARN" : "OK", observed_at: e.last_at,
          detail_no: `${e.executed} utført${e.denied > 0 ? `, ${e.denied} NEKTET` : ""}${e.failed > 0 ? `, ${e.failed} feilet` : ""}; siste ${rel(e.last_at)}.${e.denied > 0 ? " Et nektet forsøk på en kontrollhandling (ikke eier, manglende step-up eller policy) er verdt å se på." : ""}`,
          facts: { action: e.action, executed: e.executed, denied: e.denied, failed: e.failed, last_at: e.last_at }
        }));
        for (const d of v.access_denials) {
          items.push(controlItem({
            id: `access:${d.type}`, label: `Siste 30 døgn: ${ACCESS_TYPE_NO[d.type] ?? d.type}`, status: "WARN", observed_at: d.last_at,
            detail_no: `${d.n} hendelser; siste ${rel(d.last_at)}. Noen (eller noe) ble avvist ved innlogging/innrullering - sjekk at det var deg.`, facts: { type: d.type, count: d.n, last_at: d.last_at }
          }));
        }
        if (controlsR.ok) {
          const { frozen, revoked } = controlsR.value;
          items.push(controlItem({
            id: "revoked_now", label: "Tilbakekalte credentials nå", status: revoked.length > 0 ? "WARN" : "OK",
            detail_no: revoked.length > 0 ? `${revoked.length} credential(s) er tilbakekalt: ${revoked.slice(0, MAX_LISTED_REFS).map((r) => safeCategory(r.credential_ref)).join(", ")}${revoked.length > MAX_LISTED_REFS ? ", …" : ""}. Verdiene slettes aldri.` : "Ingen credentials er tilbakekalt akkurat nå.",
            facts: { revoked: revoked.length }
          }));
          items.push(controlItem({
            id: "frozen_now", label: "Frosne connectorer nå", status: frozen.length > 0 ? "WARN" : "OK",
            detail_no: frozen.length > 0 ? `${frozen.length} connector(e) er frosset: ${frozen.slice(0, MAX_LISTED_REFS).map((f) => safeCategory(f.connector_id)).join(", ")}${frozen.length > MAX_LISTED_REFS ? ", …" : ""}.` : "Ingen connectorer er frosset akkurat nå.",
            facts: { frozen: frozen.length }
          }));
        } else {
          items.push(controlItem({ id: "revoked_now", label: "Tilbakekalte credentials nå", status: "UNKNOWN", detail_no: `Kunne ikke leses${failed(controlsR)}.`, facts: { measured: false } }));
          items.push(controlItem({ id: "frozen_now", label: "Frosne connectorer nå", status: "UNKNOWN", detail_no: `Kunne ikke leses${failed(controlsR)}.`, facts: { measured: false } }));
        }
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "credentials", title_no: "Credential- og tilgangshendelser", observed_at: nowIso, items,
          source: "audit_events (kontrollhandlinger og avviste innlogginger, siste 30 døgn; payload leses aldri) + owner_control_state (kun referansenavn)",
          summary_no: `${v.credential_events.reduce((a, e) => a + e.executed, 0)} utførte og ${v.credential_events.reduce((a, e) => a + e.denied, 0)} nektede kontrollhandlinger siste 30 døgn. ${countsNo(items)}.`
        }));
      } else {
        sections.push(unknownControlSection("credentials", "Credential- og tilgangshendelser", "audit_events + owner_control_state", `kunne ikke leses${failed(aggR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 3. Mistenkelig innhold og eksfiltrering
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (aggR.ok) {
        const v = aggR.value;
        const items: ControlItem[] = v.tainted_confirmations.map((c) => controlItem({
          id: `taint:${c.status}`, label: `Bekreftelser utløst av ubetrodd innhold: ${CONFIRMATION_STATUS_NO[c.status] ?? c.status}`, status: c.status === "pending" ? "WARN" : "OK", observed_at: c.last_at,
          detail_no: `${c.n} siste 30 døgn; siste ${rel(c.last_at)}. En utgående handling i en tur som har lest ubetrodd innhold stoppes til du bekrefter (injeksjonsvernet virker).`,
          facts: { status: c.status, count: c.n, last_at: c.last_at }
        }));
        if (v.tainted_confirmations.length === 0) {
          items.push(controlItem({ id: "taint_none", label: "Bekreftelser utløst av ubetrodd innhold", status: "OK", detail_no: "Ingen utgående handling har blitt stoppet av injeksjonsvernet siste 30 døgn.", facts: { count: 0 } }));
        }
        for (const m of v.memory_guard) {
          items.push(controlItem({
            id: `memory:${m.type}`, label: `Siste 30 døgn: ${MEMORY_TYPE_NO[m.type] ?? m.type}`, status: "OK", observed_at: m.last_at,
            detail_no: `${m.n} hendelser; siste ${rel(m.last_at)}. Ubetrodd innhold går via karantene og blir aldri autoritativt minne uten din godkjenning.`, facts: { type: m.type, count: m.n, last_at: m.last_at }
          }));
        }
        for (const [id, label, why] of [
          ["secret_scan", "Hemmeligheter fjernet av skanneren", "antall fjernede hemmeligheter lagres ikke (kun fjerningen selv skjer)"],
          ["cloud_screen", "Treff holdt tilbake av skyskjermen", "antallet holdt tilbake logges ikke i databasen"],
          ["radar_quarantine", "Radar-karantene (EV-3)", "tellerne er prosesslokale og står i evolusjonsrapporten"]
        ] as const) {
          items.push(controlItem({ id, label, status: "UNKNOWN", detail_no: `IKKE målt herfra: ${why}.`, facts: { measured: false } }));
        }
        items.sort(bySeverityThenLabel);
        const taintTotal = v.tainted_confirmations.reduce((a, c) => a + c.n, 0);
        sections.push(controlSection({
          id: "suspicious", title_no: "Mistenkelig innhold og eksfiltrering", observed_at: nowIso, items,
          source: "action_confirmations (taint_reasons) + audit_events (memory.quarantined_conflict, memory.rejected) - kun antall og tilstand; innholdet leses aldri. Skanner-, skyskjerm- og radartellere er ikke lagret (ikke målt)",
          summary_no: `${taintTotal} utgående handlinger stoppet av injeksjonsvernet siste 30 døgn. Tre forsvar kan ikke telles herfra (ikke målt). ${countsNo(items)}.`
        }));
      } else {
        sections.push(unknownControlSection("suspicious", "Mistenkelig innhold og eksfiltrering", "action_confirmations + audit_events", `kunne ikke leses${failed(aggR)}`));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 4. Gjenoppretting (det som venter på å bli opphevet + utførte gjenopprettingshandlinger)
      // -------------------------------------------------------------------------------------------------------------------------------------------
      {
        const items: ControlItem[] = [];
        if (killR.ok) {
          const k = killR.value;
          items.push(controlItem({
            id: "kill_switch", label: "Kill switch", status: k ? "FAIL" : "OK", observed_at: k ? toIso(k.changed_at) : null,
            detail_no: k ? `AKTIV siden ${rel(toIso(k.changed_at))} - alt er stanset unntatt gjenoppretting. Opphev den i Autoritet-senteret (signert enhet).` : "Av - systemet kjører normalt.", facts: { active: k !== null }
          }));
        } else {
          items.push(controlItem({ id: "kill_switch", label: "Kill switch", status: "UNKNOWN", detail_no: `Tilstanden kunne ikke leses${failed(killR)} - behandles ikke som «av».`, facts: { active: null } }));
        }
        if (financeR.ok) {
          items.push(controlItem({
            id: "finance_kill_switch", label: "Finans-nødbryter", status: financeR.value.enabled ? "WARN" : "OK", observed_at: financeR.value.enabled_at,
            detail_no: financeR.value.enabled ? `AKTIV siden ${rel(financeR.value.enabled_at)} - spend-muliggjørende finanshandlinger er stanset.` : "Av.", facts: { enabled: financeR.value.enabled }
          }));
        } else {
          items.push(controlItem({ id: "finance_kill_switch", label: "Finans-nødbryter", status: "UNKNOWN", detail_no: `Tilstanden kunne ikke leses${failed(financeR)}.`, facts: { enabled: null } }));
        }
        if (controlsR.ok) {
          items.push(controlItem({
            id: "stopped_credentials", label: "Tilbakekalte credentials og frosne connectorer", status: controlsR.value.revoked.length + controlsR.value.frozen.length > 0 ? "WARN" : "OK",
            detail_no: `${controlsR.value.revoked.length} tilbakekalte credentials, ${controlsR.value.frozen.length} frosne connectorer venter på å bli gjenopprettet/gjenopptatt.`, facts: { revoked: controlsR.value.revoked.length, frozen: controlsR.value.frozen.length }
          }));
        } else {
          items.push(controlItem({ id: "stopped_credentials", label: "Tilbakekalte credentials og frosne connectorer", status: "UNKNOWN", detail_no: `Kunne ikke leses${failed(controlsR)}.`, facts: { measured: false } }));
        }
        if (pausesR.ok) {
          items.push(controlItem({
            id: "paused_domains", label: "Pausede situasjonsdomener", status: pausesR.value.length > 0 ? "WARN" : "OK",
            detail_no: pausesR.value.length > 0 ? `${pausesR.value.length} pause(r) venter på å bli opphevet (auto-ACT og nye varsler er stanset).` : "Ingen domener er pauset.", facts: { paused: pausesR.value.length }
          }));
        } else {
          items.push(controlItem({ id: "paused_domains", label: "Pausede situasjonsdomener", status: "UNKNOWN", detail_no: `Kunne ikke leses${failed(pausesR)}.`, facts: { measured: false } }));
        }
        if (aggR.ok) {
          for (const e of aggR.value.recovery_events) {
            items.push(controlItem({
              id: `recovered:${e.action}`, label: `Siste 30 døgn: ${ACTION_NO[e.action] ?? e.action}`, status: "OK", observed_at: e.last_at,
              detail_no: `${e.n} utført; siste ${rel(e.last_at)}.`, facts: { action: e.action, count: e.n, last_at: e.last_at }
            }));
          }
        } else {
          items.push(controlItem({ id: "recovery_history", label: "Utførte gjenopprettingshandlinger", status: "UNKNOWN", detail_no: `Kunne ikke leses${failed(aggR)}.`, facts: { measured: false } }));
        }
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "recovery", title_no: "Gjenoppretting", observed_at: nowIso, items,
          source: "owner_control_state (kill switch, frys, tilbakekall) + finance_kill_switch + situation_domain_pauses + audit_events (utførte gjenopprettingshandlinger). Handlingene bor i Autoritet-senteret",
          summary_no: `${killR.ok && killR.value ? "KILL SWITCH ER AKTIV. " : ""}${items.filter((i) => i.status === "WARN" || i.status === "FAIL").length} ting venter på gjenoppretting. ${countsNo(items)}.`
        }));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 5. Golden-suite (selvtest av forsvaret)
      // -------------------------------------------------------------------------------------------------------------------------------------------
      {
        const SECTION_SOURCE = "apps/api/src/golden-suite.ts (deterministisk regresjonsvern: klassifisering, ruting, verktøyutvalg, skjerming, repo-lås, radar-sone, bundne bekreftelser; ingen modell, ingen database)";
        const limits = "Suiten kjører REGLENE som funksjoner og beviser IKKE at de er koblet inn i chat- og jobbløpene (koblingen låses av egne tester).";
        if (deps.goldenSuite === undefined) {
          sections.push(controlSection({
            id: "golden_suite", title_no: "Golden-suite (selvtest av forsvaret)", observed_at: nowIso, source: SECTION_SOURCE,
            summary_no: "Selvtesten kan ikke kjøres herfra (knappen er AV: JARVIS_CONTROL_GOLDEN_SUITE).",
            items: [controlItem({ id: "golden_state", label: "Siste kjøring", status: "UNKNOWN", detail_no: `IKKE målt: knappen er AV (JARVIS_CONTROL_GOLDEN_SUITE=on slår den på). Suiten kjøres også av CI og vises i evolusjonsrapporten (EV-4). ${limits}`, facts: { enabled: false } })]
          }));
        } else {
          const last: GoldenSuiteRunResult | null = deps.goldenSuite.last();
          const runAction = controlAction({
            id: "security.golden_suite.run", label: "Kjør golden-suite nå", endpoint: "/executive/mutate", body: { action: "run_golden_suite", parameters: {} },
            risk_class: riskOf(deps.toolGateway, "executive", "run_golden_suite"), requires_step_up: actionRequiresStepUp("run_golden_suite"), reversible: true,
            description_no: "Kjører den deterministiske golden-suiten i API-prosessen: rene regler mot stubber, INGEN modellkall, ingen database, ingen skriving. Resultatet (antall bestått, digester) vises her; det holdes kun i prosessens minne.",
            rollback_no: "Ingenting å angre - kjøringen endrer ingenting.", section_id: "golden_suite", item_id: "golden_state"
          });
          actions.push(runAction);
          if (last === null) {
            sections.push(controlSection({
              id: "golden_suite", title_no: "Golden-suite (selvtest av forsvaret)", observed_at: nowIso, source: SECTION_SOURCE,
              summary_no: "Selvtesten er ikke kjørt siden API-et startet. Trykk «Kjør golden-suite nå» (ingen modell kalles).",
              items: [controlItem({ id: "golden_state", label: "Siste kjøring", status: "UNKNOWN", detail_no: `IKKE kjørt siden oppstart (resultatet holdes kun i minnet). ${limits}`, facts: { ran: false } })]
            }));
          } else {
            const state: ControlStatus = last.failed.length > 0 || last.hard_stop ? "FAIL" : last.skipped.length > 0 ? "UNKNOWN" : "OK";
            const items: ControlItem[] = [
              controlItem({
                id: "golden_state", label: "Siste kjøring", status: state, observed_at: last.ran_at,
                detail_no: `${last.passed} av ${last.ran} kjørte oppgaver bestått${last.failed.length > 0 ? `; IKKE bestått: ${last.failed.slice(0, MAX_LISTED_REFS).map(safeCategory).join(", ")}${last.failed.length > MAX_LISTED_REFS ? ", …" : ""} - en regel Jarvis allerede har fungerer ikke lenger` : ""}${last.skipped.length > 0 ? `; ${last.skipped.length} hoppet over (verktøyflaten var ikke tilgjengelig) - IKKE målt` : ""}. Kjørt ${rel(last.ran_at)} på ${last.duration_ms} ms. ${limits}`,
                facts: { total: last.total, ran: last.ran, passed: last.passed, failed: last.failed.length, skipped: last.skipped.length, duration_ms: last.duration_ms, surface_available: last.surface_available, model_calls: 0 }
              }),
              controlItem({
                id: "golden_red_team", label: "Red team-kategorier (forsvar mot egne angrep)", status: last.hard_stop ? "FAIL" : last.uncovered.length > 0 ? "WARN" : "OK",
                detail_no: `${last.red_team.reduce((a, r) => a + r.attempts, 0)} angrepsforsøk i ${last.red_team.length} kategorier: ${last.red_team.reduce((a, r) => a + r.breaches, 0)} brudd${last.hard_stop ? " - HARD STOPP (ett enkelt brudd er nok)" : ""}${last.uncovered.length > 0 ? `; ${last.uncovered.length} kategorier uten dekning` : ""}.`,
                facts: { attempts: last.red_team.reduce((a, r) => a + r.attempts, 0), breaches: last.red_team.reduce((a, r) => a + r.breaches, 0), hard_stop: last.hard_stop, uncovered: last.uncovered.length }
              }),
              controlItem({
                id: "golden_digests", label: "Digester (bevis for hvilken suite og hvilket resultat)", status: "OK", observed_at: last.ran_at,
                detail_no: `Suite ${last.suite_id} v${last.suite_version}, suite-digest ${digestNo(last.suite_digest)}, resultat-digest ${digestNo(last.result_digest)} (hele digestene står i måledata). To kjøringer av samme kode gir samme resultat-digest.`,
                facts: { suite_id: last.suite_id, suite_version: last.suite_version, suite_digest: last.suite_digest, result_digest: last.result_digest }
              })
            ];
            sections.push(controlSection({
              id: "golden_suite", title_no: "Golden-suite (selvtest av forsvaret)", observed_at: last.ran_at, items, source: SECTION_SOURCE,
              summary_no: `Siste kjøring ${rel(last.ran_at)}: ${last.passed} av ${last.ran} bestått${last.failed.length > 0 ? `, ${last.failed.length} IKKE bestått` : ""}${last.skipped.length > 0 ? `, ${last.skipped.length} ikke målt` : ""}. Ingen modellkall (0). ${countsNo(items)}.`
            }));
          }
        }
      }

      return { sections, actions };
    }
  };
}
