// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import {
  controlAction, controlItem, controlSection, unknownControlSection,
  type ControlAction, type ControlCenterBuildContext, type ControlCenterDefinition, type ControlCenterParts, type ControlItem, type ControlSection, type ControlStatus
} from "@jarvis/executive";
import { budgetConfigFromEnv } from "@jarvis/model-gateway";
import { resolveAuthorityMode, type AuthorityConfig, type InfraExecutionGate, type KillSwitch, type OwnerControls } from "@jarvis/policy";
import { allowedReposFromEnv } from "@jarvis/tasks";
import {
  assertManifestInvariants, buildToolManifest, configuredGithubRepo, githubReposUnlocked, parseDockerMutationTargets, parseGceMutationTargets,
  ToolManifestViolationError, type ToolGateway, type ToolManifestEntry
} from "@jarvis/tool-gateway";
import { STEP_UP_CHANNELS, STEP_UP_EXEMPT_ACTIONS, actionRequiresStepUp } from "../step-up.ts";
import { parseDailyCapOre } from "../tool-turn-route.ts";
import {
  bySeverityThenLabel, countsNo, globalRows, joinFact, relativeNo, riskOf, settle, tenantRead, tenantSpaceRead, toIso,
  type ControlCenterPool, type Settled
} from "./shared.ts";

/**
 * WP-H0 (UA-11 Admin Control Center) - AUTHORITY CENTER: hvem kan hva, og hva eieren kan stoppe.
 *
 * Alt er LESING av eksisterende tilstand; handlingene peker på eksisterende ruter (`/executive/mutate`) og er de samme brytere dashbordet har:
 *  - Eier-/delegert autoritet (`resolveAuthorityMode`, `authority.ts`): eieren er SOVEREIGN, delegater (identiteter med `delegation_id`) arver ALDRI eier-autoritet. Enheter og aktive grants (`devices`, `session_grants`)
 *    viser hvem som har live tilgang; «tilbakekall delegasjon» er `revoke_device` (permanent, ikke angrebar) - aldri på enheten du sitter på.
 *  - Delegert autonomi (`situation_autonomy_policies`): hvilke handlinger Jarvis har fått binde seg til å utføre selv per domene (parametre vises aldri).
 *  - Brytere: kill switch, finans-nødbryter, infra-modus, domene-pauser, frosne connectorer og tilbakekalte credentials (`owner_control_state`).
 *  - Risikoklasser A-D fra verktøymanifestet (A-D styrer HVORDAN en handling utføres, aldri OM eieren har kapabiliteten - D-41) og manifest-invariantene.
 *  - Aktive valgfrie policyer (kostnadsbudsjett, dagstak, klasse D-pipeline, credential-binding, step-up) og eksterne begrensninger (GitHub-repo-lås, destinasjons-allowlist, infra-mål).
 *  - Åpne bekreftelser (`action_confirmations`).
 *
 * DEFERRED (ikke stille utelatt): tilbakekall av en autonomi-binding er DEFERRED uten `JARVIS_CONTROL_AUTONOMY_REVOKE=on` (WP-H2: da finnes `executive.revoke_autonomy_binding` på `/executive/mutate` og en knapp per binding i økta sitt eget rom; pause av domenet stopper auto-ACT i mellomtiden), infra-modus-endring herfra og
 * godkjenn/avvis av bekreftelser (utfører en handling; skjer i chat/dashbord der parametrene vises).
 */

/** Alle minnerom UTEN health: health er isolert (aldri sammen med andre rom) og leses kun som antall. */
const NON_HEALTH_SPACES = ["personal", "business", "project", "home", "guest", "shared"] as const;
const MAX_DEVICES = 60;

export interface DeviceRow { device_id: string; person_id: string; kind: string; created_at: string | null; revoked_at: string | null; role: string; active_grants: number; last_grant_at: string | null }

export async function readDevices(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<DeviceRow[]> {
  const rows = await tenantRead(pool, tenantId, (query) => query(
    `SELECT d.device_id, d.person_id, d.kind, d.created_at, d.revoked_at, coalesce(pt.role, 'ukjent') AS role,
            (SELECT (count(*))::int FROM session_grants g WHERE g.tenant_id = d.tenant_id AND g.device_id = d.device_id AND g.revoked_at IS NULL AND g.expires_at > $2) AS active_grants,
            (SELECT max(g.issued_at) FROM session_grants g WHERE g.tenant_id = d.tenant_id AND g.device_id = d.device_id) AS last_grant_at
       FROM devices d LEFT JOIN person_tenants pt ON pt.person_id = d.person_id AND pt.tenant_id = d.tenant_id
      WHERE d.tenant_id = $1
      ORDER BY (d.revoked_at IS NOT NULL), d.created_at DESC
      LIMIT ${MAX_DEVICES}`,
    [tenantId, new Date(nowMs)]
  ));
  return rows.map((r) => ({
    device_id: String(r["device_id"]), person_id: String(r["person_id"]), kind: String(r["kind"]), created_at: toIso(r["created_at"]), revoked_at: toIso(r["revoked_at"]),
    role: String(r["role"]), active_grants: Number(r["active_grants"] ?? 0), last_grant_at: toIso(r["last_grant_at"])
  }));
}

export interface AutonomyRow { memory_space_id: string; domain: string; tool_id: string; action: string; enabled: boolean; updated_at: string | null }
export interface AutonomyRead { rows: AutonomyRow[]; health_count: number; situation_domains: string[] }

/** Autonomi-policyer (kun handlingens NAVN, aldri parametrene) og domenene situasjoner finnes i. `health` leses kun som antall (isolert rom). */
export async function readAutonomy(pool: ControlCenterPool, tenantId: string): Promise<AutonomyRead> {
  const main = await tenantSpaceRead(pool, tenantId, NON_HEALTH_SPACES, async (query) => ({
    policies: await query(
      `SELECT memory_space_id, domain, tool_id, action, enabled, updated_at FROM situation_autonomy_policies WHERE tenant_id = $1 ORDER BY domain, memory_space_id LIMIT 100`, [tenantId]
    ),
    domains: await query(`SELECT DISTINCT domain FROM situations WHERE tenant_id = $1 ORDER BY domain LIMIT 60`, [tenantId])
  }));
  const health = await tenantSpaceRead(pool, tenantId, ["health"], (query) => query(`SELECT (count(*))::int AS n FROM situation_autonomy_policies WHERE tenant_id = $1`, [tenantId]));
  return {
    rows: main.policies.map((r) => ({
      memory_space_id: String(r["memory_space_id"]), domain: String(r["domain"]), tool_id: String(r["tool_id"]), action: String(r["action"]),
      enabled: Boolean(r["enabled"]), updated_at: toIso(r["updated_at"])
    })),
    health_count: Number(health[0]?.["n"] ?? 0),
    situation_domains: main.domains.map((r) => String(r["domain"]))
  };
}

export interface DomainPauseRow { domain: string; paused_by: string | null; paused_at: string | null }

/** `situation_domain_pauses` er en global driftstabell (ingen tenant). `reason` leses ikke (fri tekst). */
export async function readDomainPauses(pool: ControlCenterPool): Promise<DomainPauseRow[]> {
  const rows = await globalRows(pool, "SELECT domain, paused_by, paused_at FROM situation_domain_pauses ORDER BY domain");
  return rows.map((r) => ({ domain: String(r["domain"]), paused_by: r["paused_by"] === null || r["paused_by"] === undefined ? null : String(r["paused_by"]), paused_at: toIso(r["paused_at"]) }));
}

export interface FinanceKillRow { enabled: boolean; enabled_at: string | null }

export async function readFinanceKillSwitch(pool: ControlCenterPool, tenantId: string): Promise<FinanceKillRow> {
  const rows = await tenantRead(pool, tenantId, (query) => query(`SELECT enabled, enabled_at FROM finance_kill_switch WHERE tenant_id = $1`, [tenantId]));
  const row = rows[0];
  return { enabled: row ? Boolean(row["enabled"]) : false, enabled_at: row ? toIso(row["enabled_at"]) : null };
}

export interface ConfirmationRow { confirmation_id: string; tool_id: string; action: string; created_at: string | null; expires_at: string | null; taint_reasons: string[] }

export async function readPendingConfirmations(pool: ControlCenterPool, tenantId: string): Promise<ConfirmationRow[]> {
  const rows = await tenantRead(pool, tenantId, (query) => query(
    `SELECT confirmation_id, tool_id, action, created_at, expires_at, taint_reasons FROM action_confirmations WHERE tenant_id = $1 AND status = 'pending' ORDER BY created_at LIMIT 50`, [tenantId]
  ));
  return rows.map((r) => ({
    confirmation_id: String(r["confirmation_id"]), tool_id: String(r["tool_id"]), action: String(r["action"]), created_at: toIso(r["created_at"]), expires_at: toIso(r["expires_at"]),
    taint_reasons: Array.isArray(r["taint_reasons"]) ? (r["taint_reasons"] as unknown[]).map(String) : []
  }));
}

export interface ManifestSummary {
  by_class: Record<"A" | "B" | "C" | "D", { actions: number; tools: number; on_model_surface: number; effects: string }>;
  total: number;
  violations: string[];
}

/** Risikoklassene A-D slik verktøymanifestet (den eneste kilden) har dem for de REGISTRERTE handlingene, pluss boot-invariantene. */
export function summarizeManifest(defs: Parameters<typeof buildToolManifest>[0]): ManifestSummary {
  const manifest = buildToolManifest(defs);
  const entries: ToolManifestEntry[] = [...manifest.values()];
  const by_class = {} as ManifestSummary["by_class"];
  for (const cls of ["A", "B", "C", "D"] as const) {
    const of = entries.filter((e) => e.risk === cls);
    const effects = new Map<string, number>();
    for (const e of of) effects.set(e.effect, (effects.get(e.effect) ?? 0) + 1);
    by_class[cls] = {
      actions: of.length, tools: new Set(of.map((e) => e.tool_id)).size, on_model_surface: of.filter((e) => e.surfaces.length > 0).length,
      effects: [...effects].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k}:${n}`).join(", ")
    };
  }
  let violations: string[] = [];
  try {
    assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true });
  } catch (err) {
    violations = err instanceof ToolManifestViolationError ? err.violations : ["manifest_invariant_check_failed"];
  }
  return { by_class, total: entries.length, violations };
}

const CLASS_TITLE_NO: Readonly<Record<"A" | "B" | "C" | "D", string>> = {
  A: "Klasse A - lesing", B: "Klasse B - skriving innen Jarvis", C: "Klasse C - ekstern endring", D: "Klasse D - kritisk (penger, sletting, utsending, tilgang)"
};
const CLASS_DETAIL_NO: Readonly<Record<"A" | "B" | "C" | "D", string>> = {
  A: "Ufarlig lesing - kan stå på modellflater.",
  B: "Lavrisiko skriving - preflight/readback og revisjon.",
  C: "Ekstern, reversibel endring - sovereign eier utfører uten approval-friksjon, med revisjon og tilbakerulling.",
  D: "Håndheves i deterministisk kode (signert godkjenning, preflight, readback, revisjon) og kan aldri stå på en modellflate."
};

export interface AuthorityCenterDeps {
  pool: ControlCenterPool;
  /** Miljøet policyene leses fra. Kun ikke-hemmelige verdier (grenser, repo-navn, vertsnavn) vises; ingen hemmelige variabler leses. */
  env: Readonly<Record<string, string | undefined>>;
  /** Samme eier-autoritetskonfigurasjon som Policy Gateway bruker. Utelatt = ikke konfigurert (ingen suveren modus). */
  authority?: AuthorityConfig;
  toolGateway: Pick<ToolGateway, "list" | "get"> & Partial<Pick<ToolGateway, "policyFlags">>;
  ownerControls: Pick<OwnerControls, "listFrozenConnectorsDurable" | "listRevokedCredentialsDurable">;
  killSwitch: Pick<KillSwitch, "currentStateDurable">;
  infraGate?: Pick<InfraExecutionGate, "statusDurable">;
  /**
   * WP-H2: tilby «Tilbakekall autonomi» per binding (`executive.revoke_autonomy_binding`, klasse C, eier-kun, step-up). AV som standard (`JARVIS_CONTROL_AUTONOMY_REVOKE`): uten den er senteret uendret fra H0.
   * Knappen tilbys kun for bindinger i den innloggede økta sitt EGET minnerom (`clear_autonomy_policy` virker alltid i identitetens eget rom) - bindinger i andre rom vises med en forklaring i stedet.
   */
  autonomyRevoke?: boolean;
}

const kr = (ore: number): string => `${Math.round(ore / 100)} kr`;

export function createAuthorityCenter(deps: AuthorityCenterDeps): ControlCenterDefinition {
  return {
    id: "authority",
    title_no: "Autoritet",
    description_no: "Hvem som kan hva, hva Jarvis får gjøre selv, og hva du kan stoppe: kill switch, pauser, tilbakekall, risikoklasser, grenser og åpne bekreftelser",
    async build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts> {
      const nowMs = ctx.now.getTime();
      const nowIso = ctx.now.toISOString();
      const tenantId = ctx.identity.tenant_id;
      const rel = (iso: string | null | undefined): string => relativeNo(iso, nowMs);

      const [killR, controlsR, infraR, devicesR, autonomyR, pausesR, financeR, confirmR] = await Promise.all([
        settle(() => deps.killSwitch.currentStateDurable()),
        settle(async () => ({ frozen: await deps.ownerControls.listFrozenConnectorsDurable(), revoked: await deps.ownerControls.listRevokedCredentialsDurable() })),
        deps.infraGate ? settle(() => deps.infraGate!.statusDurable()) : Promise.resolve(null),
        settle(() => readDevices(deps.pool, tenantId, nowMs)),
        settle(() => readAutonomy(deps.pool, tenantId)),
        settle(() => readDomainPauses(deps.pool)),
        settle(() => readFinanceKillSwitch(deps.pool, tenantId)),
        settle(() => readPendingConfirmations(deps.pool, tenantId))
      ]);

      const sections: ControlSection[] = [];
      const actions: ControlAction[] = [];
      const failed = (r: Settled<unknown> | null): string => (r !== null && !r.ok ? ` (${r.category})` : "");

      // ---------------------------------------------------------------------------------------------------------------------------------------------
      // 1. Eier- og delegert autoritet
      // ---------------------------------------------------------------------------------------------------------------------------------------------
      const viewerMode = resolveAuthorityMode(deps.authority, ctx.identity);
      const otherPeople = devicesR.ok ? devicesR.value.filter((d) => d.person_id !== ctx.identity.person_id && d.revoked_at === null) : null;
      const authorityItems: ControlItem[] = [
        controlItem({
          id: "owner", label: "Eier-autoritet (suveren)", status: deps.authority ? "OK" : "WARN",
          detail_no: deps.authority
            ? `Eieren er konfigurert som suveren i ${deps.authority.owner_tenants.length} tenant(er); din identitet nå: ${viewerMode}. A-D styrer HVORDAN en handling utføres (preflight, readback, revisjon), aldri OM eieren har kapabiliteten.`
            : "Eier-autoritet er IKKE konfigurert: alle identiteter behandles som SCOPED (eksisterende godkjenningsregler gjelder) - ingen suveren modus.",
          facts: { configured: deps.authority !== undefined, owner_tenants: deps.authority?.owner_tenants.length ?? 0, viewer_mode: viewerMode }
        }),
        controlItem({
          // Gjennomgang av PR #316 (M-1): reglen er alltid i kraft, men elementet viser også hvor mange andre enheter som har tilgang - kan enhetsoversikten ikke leses, er det ukjent (aldri «i orden»).
          id: "delegates", label: "Delegert autoritet", status: devicesR.ok ? "OK" : "UNKNOWN",
          detail_no: `Identiteter med delegasjon arver ALDRI eier-autoritet: de er alltid SCOPED og må gjennom mandat/godkjenning for klasse C og D (resolveAuthorityMode).${devicesR.ok ? "" : " Enhetsoversikten kunne ikke leses, så antall enheter med delegert tilgang er ukjent."}`,
          facts: {
            rule: "delegation_id => SCOPED",
            other_person_devices: otherPeople === null ? null : otherPeople.length,
            other_person_active_grants: otherPeople === null ? null : otherPeople.reduce((a, d) => a + d.active_grants, 0)
          }
        })
      ];
      sections.push(controlSection({
        id: "authority", title_no: "Eier- og delegert autoritet", source: "authority.ts (resolveAuthorityMode) · devices/session_grants (tenant-RLS)", observed_at: nowIso,
        summary_no: deps.authority ? `Eier er suveren; delegater er SCOPED. ${otherPeople === null ? "Enhetsoversikt kunne ikke leses." : `${otherPeople.length} aktive enheter tilhører andre enn deg.`}` : "Eier-autoritet er ikke konfigurert.",
        status: devicesR.ok ? "OK" : "UNKNOWN", items: authorityItems
      }));

      // ---------------------------------------------------------------------------------------------------------------------------------------------
      // 2. Enheter og tilgang (tilbakekall delegasjon = revoke_device)
      // ---------------------------------------------------------------------------------------------------------------------------------------------
      if (devicesR.ok) {
        const items: ControlItem[] = [];
        for (const d of devicesR.value) {
          const revokedDevice = d.revoked_at !== null;
          const current = d.device_id === ctx.identity.device_id;
          const delegated = d.person_id !== ctx.identity.person_id;
          items.push(controlItem({
            id: d.device_id, label: `${d.kind}: ${d.device_id}`, status: "OK", observed_at: d.last_grant_at,
            detail_no: [
              revokedDevice ? `tilbakekalt ${rel(d.revoked_at)}` : `${d.active_grants} aktive grants`,
              delegated ? "tilhører en annen person (delegert tilgang)" : "din enhet",
              current ? "DENNE enheten (kan ikke tilbakekalles herfra)" : "",
              d.last_grant_at ? `sist innlogget ${rel(d.last_grant_at)}` : "aldri innlogget"
            ].filter((x) => x !== "").join(" · "),
            facts: { kind: d.kind, person_id: d.person_id, role: d.role, delegated, revoked: revokedDevice, active_grants: d.active_grants, enrolled_at: d.created_at, last_grant_at: d.last_grant_at, current_device: current }
          }));
          if (!revokedDevice && !current) {
            actions.push(controlAction({
              id: `authority.revoke_device:${d.device_id}`, label: `Tilbakekall enhet ${d.device_id}`, endpoint: "/executive/mutate",
              body: { action: "revoke_device", parameters: { device_id: d.device_id, reason: "Tilbakekalt av eier fra kontrollsenteret" } },
              risk_class: riskOf(deps.toolGateway, "executive", "revoke_device"), requires_step_up: actionRequiresStepUp("revoke_device"), reversible: false,
              description_no: `Tilbakekaller ALLE aktive grants for enheten «${d.device_id}» og fjerner nøkkelen PERMANENT - enheten må rulles inn på nytt for ny tilgang.`,
              rollback_no: "Kan ikke angres: enheten må re-rulles inn (enrollment).", section_id: "devices", item_id: d.device_id
            }));
          }
        }
        items.sort(bySeverityThenLabel);
        const active = devicesR.value.filter((d) => d.revoked_at === null);
        const grants = active.reduce((a, d) => a + d.active_grants, 0);
        sections.push(controlSection({
          id: "devices", title_no: "Enheter og tilgang", source: "devices + session_grants (tenant-RLS; nøkler og token vises aldri)", observed_at: nowIso,
          summary_no: `${active.length} aktive og ${devicesR.value.length - active.length} tilbakekalte enheter; ${grants} aktive grants. Tilbakekall er permanent.`, items
        }));
      } else {
        sections.push(unknownControlSection("devices", "Enheter og tilgang", "devices + session_grants (tenant-RLS)", `kunne ikke leses (${devicesR.category})`));
      }

      // ---------------------------------------------------------------------------------------------------------------------------------------------
      // 3. Delegert autonomi
      // ---------------------------------------------------------------------------------------------------------------------------------------------
      const pausedDomains = new Map<string, DomainPauseRow>();
      if (pausesR.ok) for (const p of pausesR.value) pausedDomains.set(p.domain, p);
      const allPaused = pausedDomains.has("*");
      if (autonomyR.ok) {
        const items: ControlItem[] = autonomyR.value.rows.map((p) => {
          const paused = allPaused || pausedDomains.has(p.domain);
          // Gjennomgang av PR #316 (M-1): kan domene-pausene ikke leses, VET vi ikke om en aktiv binding er stanset - da er den ukjent (aldri «i orden»), og faktaet sier null i stedet for «ikke pauset».
          const pauseUnknown = !pausesR.ok && p.enabled;
          const ownSpace = p.memory_space_id === ctx.identity.memory_space_id;
          if (deps.autonomyRevoke === true && ownSpace) {
            actions.push(controlAction({
              id: `authority.revoke_autonomy:${p.memory_space_id}:${p.domain}`, label: `Tilbakekall autonomi: ${p.domain}`, endpoint: "/executive/mutate",
              body: { action: "revoke_autonomy_binding", parameters: { domain: p.domain } },
              risk_class: riskOf(deps.toolGateway, "executive", "revoke_autonomy_binding"), requires_step_up: actionRequiresStepUp("revoke_autonomy_binding"), reversible: false,
              description_no: `Fjerner bindingen som lar Jarvis utføre ${p.tool_id}.${p.action} selv i domenet «${p.domain}» (rommet ${p.memory_space_id}). Uten binding utfører Jarvis ingenting selv i domenet (fail-closed): situasjoner blir liggende som forslag til du handler. Parametrene til bindingen slettes og lagres ikke.`,
              rollback_no: "Kan ikke angres herfra: bind domenet på nytt med situations.set_autonomy_policy (handling og parametre må da gis på nytt).",
              section_id: "autonomy", item_id: `${p.memory_space_id}:${p.domain}`
            }));
          }
          return controlItem({
            id: `${p.memory_space_id}:${p.domain}`, label: `${p.domain} (${p.memory_space_id})`, status: pauseUnknown ? "UNKNOWN" : p.enabled && paused ? "WARN" : "OK", observed_at: p.updated_at,
            detail_no: `${p.tool_id}.${p.action} - ${p.enabled ? "aktiv" : "av"}${paused ? " · domenet er PAUSET (auto-ACT stanset)" : ""}${pauseUnknown ? " · domene-pausene kunne ikke leses (ukjent om domenet er pauset)" : ""} · endret ${rel(p.updated_at)}${deps.autonomyRevoke === true && !ownSpace ? ` · tilbakekall krever en økt i rommet «${p.memory_space_id}» (kontrollsenteret tilbakekaller kun bindinger i økta sitt eget rom: ${ctx.identity.memory_space_id})` : ""}`,
            facts: { tool: p.tool_id, action: p.action, risk_class: deps.toolGateway.get(p.tool_id, p.action)?.capability_class ?? "ukjent", enabled: p.enabled, domain_paused: pausesR.ok ? paused : null, space: p.memory_space_id }
          });
        });
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "autonomy", title_no: "Delegert autonomi (Jarvis handler selv)", source: "situation_autonomy_policies (tenant + minnerom-RLS; parametre vises aldri)", observed_at: nowIso,
          summary_no: `${items.length} autonomi-bindinger (${autonomyR.value.rows.filter((p) => p.enabled).length} aktive)${autonomyR.value.health_count > 0 ? `; ${autonomyR.value.health_count} i health-rommet (isolert, ikke listet)` : ""}. Pause domenet under «Pauser og tilbakekall» for å stanse auto-ACT; ${deps.autonomyRevoke === true ? "«Tilbakekall autonomi» fjerner selve bindingen (kun i økta sitt eget rom; bindinger i health-rommet er isolert og kan ikke tilbakekalles herfra)." : "tilbakekall av selve bindingen er DEFERRED (ingen rute)."}`,
          items
        }));
      } else {
        sections.push(unknownControlSection("autonomy", "Delegert autonomi (Jarvis handler selv)", "situation_autonomy_policies (tenant + minnerom-RLS)", `kunne ikke leses (${autonomyR.category})`));
      }

      // ---------------------------------------------------------------------------------------------------------------------------------------------
      // 4. Globale brytere
      // ---------------------------------------------------------------------------------------------------------------------------------------------
      const switchItems: ControlItem[] = [];
      if (killR.ok) {
        const k = killR.value;
        switchItems.push(controlItem({
          id: "kill_switch", label: "Kill switch (stanser ALT)", status: k ? "FAIL" : "OK", observed_at: k?.changed_at ? toIso(k.changed_at) : null,
          detail_no: k ? `AKTIV siden ${rel(toIso(k.changed_at))} - alle verktøykall og handlinger er stanset unntatt gjenoppretting.` : "Av - systemet kjører normalt.",
          facts: { active: k !== null, since: k ? toIso(k.changed_at) : null, activated_by: k?.actor_person_id ?? null }
        }));
      } else {
        switchItems.push(controlItem({ id: "kill_switch", label: "Kill switch (stanser ALT)", status: "UNKNOWN", detail_no: `Tilstanden kunne ikke leses${failed(killR)} - behandles ikke som «av».`, facts: { active: null } }));
      }
      const killActive = killR.ok && killR.value !== null;
      if (killActive) {
        actions.push(controlAction({
          id: "authority.kill_switch.deactivate", label: "Opphev kill switch", endpoint: "/executive/mutate", body: { action: "deactivate_kill_switch", parameters: {} },
          risk_class: riskOf(deps.toolGateway, "executive", "deactivate_kill_switch"), requires_step_up: actionRequiresStepUp("deactivate_kill_switch"), reversible: true,
          description_no: "Opphever kill switch og gjenopptar normal drift.", rollback_no: "Aktiver kill switch igjen.", section_id: "switches", item_id: "kill_switch"
        }));
      } else {
        actions.push(controlAction({
          id: "authority.kill_switch.activate", label: "Aktiver kill switch", endpoint: "/executive/mutate",
          body: { action: "activate_kill_switch", parameters: { reason: "Stanset av eier fra kontrollsenteret" } },
          risk_class: riskOf(deps.toolGateway, "executive", "activate_kill_switch"), requires_step_up: actionRequiresStepUp("activate_kill_switch"), reversible: true,
          description_no: "Stanser HELE systemet umiddelbart, uansett risikoklasse eller verktøy. Kun gjenoppretting og lesing av kontrolltilstand virker til du opphever den.",
          rollback_no: "Opphev kill switch (krever signert enhetsøkt).", section_id: "switches", item_id: "kill_switch"
        }));
      }

      if (financeR.ok) {
        const f = financeR.value;
        switchItems.push(controlItem({
          id: "finance_kill_switch", label: "Finans-nødbryter", status: f.enabled ? "WARN" : "OK", observed_at: f.enabled_at,
          detail_no: f.enabled ? `AKTIV siden ${rel(f.enabled_at)} - alle spend-muliggjørende finans- og kort-handlinger er stanset.` : "Av - finans kjører normalt (utgifter krever fortsatt egne godkjenninger).",
          facts: { enabled: f.enabled, since: f.enabled_at }
        }));
        actions.push(f.enabled
          ? controlAction({
            id: "authority.finance_kill_switch.disable", label: "Opphev finans-nødbryter", endpoint: "/executive/mutate", body: { action: "disable_finance_kill_switch", parameters: {} },
            risk_class: riskOf(deps.toolGateway, "executive", "disable_finance_kill_switch"), requires_step_up: actionRequiresStepUp("disable_finance_kill_switch"), reversible: true,
            description_no: "Opphever finans-nødbryteren: spend-muliggjørende handlinger kan igjen utføres (med sine egne godkjenninger).", rollback_no: "Aktiver finans-nødbryteren igjen.", section_id: "switches", item_id: "finance_kill_switch"
          })
          : controlAction({
            id: "authority.finance_kill_switch.enable", label: "Aktiver finans-nødbryter", endpoint: "/executive/mutate",
            body: { action: "enable_finance_kill_switch", parameters: { reason: "Stanset av eier fra kontrollsenteret" } },
            risk_class: riskOf(deps.toolGateway, "executive", "enable_finance_kill_switch"), requires_step_up: actionRequiresStepUp("enable_finance_kill_switch"), reversible: true,
            description_no: "Stanser ALLE spend-muliggjørende finans- og kort-handlinger for tenanten umiddelbart.", rollback_no: "Opphev finans-nødbryteren (krever signert enhetsøkt).", section_id: "switches", item_id: "finance_kill_switch"
          }));
      } else {
        switchItems.push(controlItem({ id: "finance_kill_switch", label: "Finans-nødbryter", status: "UNKNOWN", detail_no: `Tilstanden kunne ikke leses${failed(financeR)}.`, facts: { enabled: null } }));
      }

      if (infraR === null) {
        switchItems.push(controlItem({ id: "infra_mode", label: "Infra-modus", status: "UNKNOWN", detail_no: "Infra-porten er ikke koblet inn i dette senteret.", facts: { mode: null } }));
      } else if (infraR.ok) {
        const s = infraR.value;
        const status: ControlStatus = !s.shared_readable ? "UNKNOWN" : s.state.mode !== "NORMAL" || !s.in_sync ? "WARN" : "OK";
        switchItems.push(controlItem({
          id: "infra_mode", label: "Infra-modus (docker/GCE-mutasjon)", status, observed_at: s.state.at,
          detail_no: !s.shared_readable
            ? "Delt modus kunne ikke leses - gjeldende modus kan ikke bekreftes (mutasjon avslås fail-closed)."
            : `${s.state.mode}${s.state.mode === "PAUSED" ? " - all infra-mutasjon (B/C/D) stanset" : s.state.mode === "DEGRADED" ? " - klasse D blokkert" : ""}${s.in_sync ? "" : " · IKKE i synk mellom prosessene"}`,
          facts: { mode: s.state.mode, local_mode: s.local.mode, shared_mode: s.shared?.mode ?? "NORMAL", shared_readable: s.shared_readable, in_sync: s.in_sync }
        }));
      } else {
        switchItems.push(controlItem({ id: "infra_mode", label: "Infra-modus", status: "UNKNOWN", detail_no: `Modus kunne ikke leses${failed(infraR)}.`, facts: { mode: null } }));
      }
      switchItems.sort(bySeverityThenLabel);
      sections.push(controlSection({
        id: "switches", title_no: "Globale brytere", source: "owner_control_state (kill_switch, infra_mode) · finance_kill_switch (tenant-RLS)", observed_at: nowIso,
        summary_no: `${killActive ? "KILL SWITCH ER AKTIV. " : ""}${switchItems.length} brytere: ${countsNo(switchItems)}. Infra-modus endres ikke herfra (DEFERRED).`, items: switchItems
      }));

      // ---------------------------------------------------------------------------------------------------------------------------------------------
      // 5. Pauser og tilbakekall (domener, frosne connectorer, tilbakekalte credentials)
      // ---------------------------------------------------------------------------------------------------------------------------------------------
      const pauseItems: ControlItem[] = [];
      if (pausesR.ok) {
        const domains = new Set<string>(["*"]);
        for (const p of pausesR.value) domains.add(p.domain);
        if (autonomyR.ok) {
          for (const p of autonomyR.value.rows) domains.add(p.domain);
          for (const d of autonomyR.value.situation_domains) domains.add(d);
        }
        for (const domain of [...domains].sort((a, b) => (a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b, "nb")))) {
          const pause = pausedDomains.get(domain);
          const all = domain === "*";
          const effective = pause !== undefined || (!all && allPaused);
          pauseItems.push(controlItem({
            id: `domain:${domain}`, label: all ? "Alle domener (hele Situation Engine)" : `Domene: ${domain}`, status: effective ? "WARN" : "OK", observed_at: pause?.paused_at ?? null,
            detail_no: pause ? `PAUSET ${rel(pause.paused_at)} - auto-ACT og nye varsler stanset` : effective ? "Pauset via «alle domener»" : "Aktiv",
            facts: { domain, paused: effective, paused_directly: pause !== undefined, paused_by: pause?.paused_by ?? null, paused_at: pause?.paused_at ?? null }
          }));
          const anchor = { section_id: "pauses", item_id: `domain:${domain}` };
          if (pause !== undefined) {
            actions.push(controlAction({
              id: `authority.resume:${domain}`, label: all ? "Gjenoppta alle domener" : `Gjenoppta ${domain}`, endpoint: "/executive/mutate",
              body: { action: "resume_domain", parameters: { domain } },
              risk_class: riskOf(deps.toolGateway, "executive", "resume_domain"), requires_step_up: actionRequiresStepUp("resume_domain"), reversible: true,
              description_no: all ? "Opphever pausen av hele Situation Engine." : `Opphever pausen av domenet «${domain}».`, rollback_no: "Pause domenet igjen.", ...anchor
            }));
          } else if (!effective) {
            actions.push(controlAction({
              id: `authority.pause:${domain}`, label: all ? "Pause alle domener" : `Pause ${domain}`, endpoint: "/executive/mutate",
              body: { action: "pause_domain", parameters: { domain, reason: "Pauset av eier fra kontrollsenteret" } },
              risk_class: riskOf(deps.toolGateway, "executive", "pause_domain"), requires_step_up: actionRequiresStepUp("pause_domain"), reversible: true,
              description_no: all ? "Pauser HELE Situation Engine (alle domener) umiddelbart: ingen auto-ACT og ingen nye varsler." : `Pauser auto-ACT og nye varsler for domenet «${domain}» umiddelbart.`,
              rollback_no: "Gjenoppta domenet.", ...anchor
            }));
          }
        }
      }
      if (controlsR.ok) {
        for (const f of controlsR.value.frozen) {
          const since = toIso(f.changed_at);
          pauseItems.push(controlItem({
            id: `frozen:${f.connector_id}`, label: `Frosset: ${f.connector_id}`, status: "WARN", observed_at: since,
            detail_no: `Alle handlinger mot «${f.connector_id}» er stanset siden ${rel(since)}.`, facts: { connector_id: f.connector_id, frozen_at: since, frozen_by: f.actor_person_id }
          }));
          actions.push(controlAction({
            id: `authority.unfreeze:${f.connector_id}`, label: `Gjenoppta ${f.connector_id}`, endpoint: "/executive/mutate",
            body: { action: "unfreeze_connector", parameters: { connector_id: f.connector_id } },
            risk_class: riskOf(deps.toolGateway, "executive", "unfreeze_connector"), requires_step_up: actionRequiresStepUp("unfreeze_connector"), reversible: true,
            description_no: `Opphever frysen av «${f.connector_id}».`, rollback_no: "Frys connectoren igjen.", section_id: "pauses", item_id: `frozen:${f.connector_id}`
          }));
        }
        for (const r of controlsR.value.revoked) {
          const since = toIso(r.changed_at);
          pauseItems.push(controlItem({
            id: `revoked:${r.credential_ref}`, label: `Tilbakekalt: ${r.credential_ref}`, status: "WARN", observed_at: since,
            detail_no: `Handlinger som bruker «${r.credential_ref}» er stanset siden ${rel(since)} (verdien er ikke slettet).`, facts: { credential_ref: r.credential_ref, revoked_at: since, revoked_by: r.actor_person_id }
          }));
          actions.push(controlAction({
            id: `authority.restore:${r.credential_ref}`, label: `Gjenopprett ${r.credential_ref}`, endpoint: "/executive/mutate",
            body: { action: "restore_credential", parameters: { credential_ref: r.credential_ref } },
            risk_class: riskOf(deps.toolGateway, "executive", "restore_credential"), requires_step_up: actionRequiresStepUp("restore_credential"), reversible: true,
            description_no: `Gjenoppretter den tilbakekalte legitimasjonen «${r.credential_ref}».`, rollback_no: "Tilbakekall legitimasjonen igjen.", section_id: "pauses", item_id: `revoked:${r.credential_ref}`
          }));
        }
      }
      const pauseFailures = [pausesR.ok ? "" : `domene-pauser${failed(pausesR)}`, controlsR.ok ? "" : `frys/tilbakekall${failed(controlsR)}`].filter((x) => x !== "");
      pauseItems.sort(bySeverityThenLabel);
      sections.push(controlSection({
        id: "pauses", title_no: "Pauser og tilbakekall", source: "situation_domain_pauses (global) · owner_control_state (connector_freeze, credential_revocation)", observed_at: nowIso,
        status: pauseFailures.length > 0 ? "UNKNOWN" : "OK",
        summary_no: `${pauseItems.filter((i) => i.status === "WARN").length} aktive pauser/tilbakekall av ${pauseItems.length} oppføringer.${pauseFailures.length > 0 ? ` Kunne ikke leses: ${pauseFailures.join(", ")} - behandles ikke som «ingen pauser».` : ""} Pause stopper ting umiddelbart og krever ikke signert enhet; å gjenoppta krever det.`,
        items: pauseItems
      }));

      // ---------------------------------------------------------------------------------------------------------------------------------------------
      // 6. Risikoklasser A-D fra manifestet
      // ---------------------------------------------------------------------------------------------------------------------------------------------
      try {
        const m = summarizeManifest(deps.toolGateway.list());
        const classItems: ControlItem[] = (["A", "B", "C", "D"] as const).map((cls) => {
          const c = m.by_class[cls];
          return controlItem({
            id: cls, label: CLASS_TITLE_NO[cls], status: cls === "D" && c.on_model_surface > 0 ? "FAIL" : "OK",
            detail_no: `${c.actions} handlinger i ${c.tools} verktøy; ${c.on_model_surface} på modellflater. ${CLASS_DETAIL_NO[cls]}`,
            facts: { actions: c.actions, tools: c.tools, on_model_surface: c.on_model_surface, effects: c.effects }
          });
        });
        classItems.push(controlItem({
          id: "invariants", label: "Manifest-invarianter (boot-sjekken)", status: m.violations.length > 0 ? "FAIL" : "OK",
          detail_no: m.violations.length > 0 ? `${m.violations.length} brudd, f.eks. ${joinFact(m.violations.slice(0, 2).map((v) => v.split(":")[0] ?? v), 200)}` : "Holder: ingen modellflate har skriving, betaling, kontroll eller klasse D.",
          facts: { violations: m.violations.length, registered_actions: m.total }
        }));
        sections.push(controlSection({
          id: "risk_classes", title_no: "Risikoklasser A-D", source: "verktøymanifestet (buildToolManifest over de registrerte handlingene)", observed_at: nowIso,
          summary_no: `${m.total} registrerte handlinger: A ${m.by_class.A.actions}, B ${m.by_class.B.actions}, C ${m.by_class.C.actions}, D ${m.by_class.D.actions}. A-D er risikoklasser som styrer hvordan en handling utføres - ikke om eieren har kapabiliteten (D-41).`,
          items: classItems
        }));
      } catch (err) {
        sections.push(unknownControlSection("risk_classes", "Risikoklasser A-D", "verktøymanifestet", `kunne ikke bygges (${err instanceof Error ? err.name : "feil"})`));
      }

      // ---------------------------------------------------------------------------------------------------------------------------------------------
      // 7. Aktive valgfrie policyer
      // ---------------------------------------------------------------------------------------------------------------------------------------------
      const policyItems: ControlItem[] = [];
      try {
        const b = budgetConfigFromEnv({ ...deps.env });
        policyItems.push(controlItem({
          id: "budget", label: "Månedlig kostnadsbudsjett (modell)", status: b.spend_approved ? "WARN" : "OK",
          detail_no: `Varsel ved ${kr(b.warn_ore)}, krever godkjenning ved ${kr(b.approval_ore)}, stopper ved ${kr(b.hard_limit_ore)}.${b.spend_approved ? " EIER-OVERSTYRING AKTIV: forbruk over godkjenningsgrensen slippes gjennom (JARVIS_BUDGET_APPROVED)." : ""}`,
          facts: { warn_ore: b.warn_ore, approval_ore: b.approval_ore, hard_limit_ore: b.hard_limit_ore, spend_approved: b.spend_approved }
        }));
      } catch {
        policyItems.push(controlItem({ id: "budget", label: "Månedlig kostnadsbudsjett (modell)", status: "FAIL", detail_no: "Ugyldig budsjettkonfigurasjon (varsel <= godkjenning <= hardgrense brutt) - gjeldende grenser kan ikke fastsettes.", facts: { valid: false } }));
      }
      const capOre = parseDailyCapOre(deps.env["JARVIS_TOOL_TURN_DAILY_CAP_ORE"]);
      policyItems.push(controlItem({
        id: "tool_turn_cap", label: "Dagstak for verktøyturer til sky", status: "OK",
        detail_no: capOre === 0 ? "Ingen tak (0) - verktøyturer til sky er ikke begrenset per døgn." : `Når dagens modellkostnad når ${kr(capOre)} går verktøyturer til lokal modell til neste døgn.`,
        facts: { daily_cap_ore: capOre }
      }));
      const flags = deps.toolGateway.policyFlags?.();
      policyItems.push(controlItem({
        id: "class_d_pipeline", label: "Klasse D-pipeline (harde porter)", status: flags === undefined ? "UNKNOWN" : flags.class_d_pipeline_enforced ? "OK" : "FAIL",
        detail_no: flags === undefined ? "Kan ikke leses fra verktøygatewayen." : flags.class_d_pipeline_enforced ? "Håndheves: uten full kjede (nøkkel, preflight, readback, varsling) er klasse D utilgjengelig (fail-closed)." : "IKKE håndhevet i denne prosessen.",
        facts: { enforced: flags?.class_d_pipeline_enforced ?? null }
      }));
      policyItems.push(controlItem({
        id: "credential_binding", label: "Credential-binding til eieren", status: flags === undefined ? "UNKNOWN" : flags.credential_binding_active ? "OK" : "WARN",
        detail_no: flags === undefined ? "Kan ikke leses fra verktøygatewayen." : flags.credential_binding_active ? "Eier-tilkoblede leverandør-credentials er bundet til den autentiserte eieren i eierens tenant." : "Ikke aktiv: credentials er ikke bundet til eieren.",
        facts: { active: flags?.credential_binding_active ?? null }
      }));
      policyItems.push(controlItem({
        id: "step_up", label: "Step-up for kontrollhandlinger", status: "OK",
        detail_no: `Alle kontrollhandlinger unntatt de som STOPPER ting krever signert enhetsøkt fra kanalene ${[...STEP_UP_CHANNELS].join(", ")}. Unntatt: ${[...STEP_UP_EXEMPT_ACTIONS].join(", ")}.`,
        facts: { channels: [...STEP_UP_CHANNELS].join(", "), exempt_actions: [...STEP_UP_EXEMPT_ACTIONS].join(", ") }
      }));
      const autoApproveOff = deps.env["JARVIS_MEMORY_AUTO_APPROVE"] === "false";
      policyItems.push(controlItem({
        id: "memory_auto_approve", label: "Auto-godkjenning av dine uttrykte minner", status: "OK",
        detail_no: autoApproveOff ? "Av: ALLE minneforslag går via karantene og venter på din godkjenning." : "På: minner du selv uttrykker lagres direkte; alt annet går via karantene.",
        facts: { auto_approve: !autoApproveOff }
      }));
      const dockerTargets = parseDockerMutationTargets(deps.env["JARVIS_DOCKER_MUTATION_TARGETS"]).size;
      const gceTargets = parseGceMutationTargets(deps.env["JARVIS_GCE_MUTATION_TARGETS"]).size;
      policyItems.push(controlItem({
        id: "infra_targets", label: "Autoriserte mål for infra-mutasjon", status: "OK",
        detail_no: dockerTargets + gceTargets === 0 ? "Ingen produksjonsmål er autorisert (fail-closed): docker-/GCE-mutasjon mot produksjon avslås." : `${dockerTargets} docker- og ${gceTargets} GCE-mål er autorisert for mutasjon.`,
        facts: { docker_targets: dockerTargets, gce_targets: gceTargets }
      }));
      sections.push(controlSection({
        id: "policies", title_no: "Aktive policyer og grenser", source: "miljøkonfigurasjon (kun ikke-hemmelige verdier) · ToolGateway.policyFlags() · step-up.ts", observed_at: nowIso,
        summary_no: `${policyItems.length} policyer: ${countsNo(policyItems)}. Dette er grensene du har satt - ikke noe Jarvis kan endre selv.`, items: policyItems
      }));

      // ---------------------------------------------------------------------------------------------------------------------------------------------
      // 8. Eksterne begrensninger
      // ---------------------------------------------------------------------------------------------------------------------------------------------
      const externalItems: ControlItem[] = [];
      const unlocked = githubReposUnlocked(deps.env);
      externalItems.push(controlItem({
        id: "github_repo", label: "GitHub-repo-lås (modellflaten)", status: unlocked ? "WARN" : "OK",
        detail_no: unlocked ? "ÅPEN: modellen kan nå andre GitHub-repo enn det konfigurerte (JARVIS_GITHUB_ALLOW_OTHER_REPOS)." : `Låst til ${configuredGithubRepo(deps.env)}: en modell styrt av ubetrodd innhold kan ikke nå andre repo med ditt token.`,
        facts: { repo: configuredGithubRepo(deps.env), other_repos_allowed: unlocked }
      }));
      try {
        const repos = allowedReposFromEnv({ ...deps.env });
        externalItems.push(controlItem({
          id: "code_job_repos", label: "Tillatte repo for kodejobber", status: repos.length === 0 ? "WARN" : "OK",
          detail_no: repos.length === 0 ? "Tom allowlist: alle kodejobber feiler lukket." : `Kodejobber kan kun arbeide mot: ${joinFact(repos, 200)}.`, facts: { repos: repos.length, list: joinFact(repos, 200) }
        }));
      } catch {
        externalItems.push(controlItem({ id: "code_job_repos", label: "Tillatte repo for kodejobber", status: "FAIL", detail_no: "Ugyldig repo-allowlist (JARVIS_GIT_ALLOWED_REPOS) - kodejobber feiler lukket.", facts: { repos: null } }));
      }
      const hosts = (deps.env["JARVIS_DESTINATION_HOST_ALLOWLIST"] ?? "").split(",").map((h) => h.trim()).filter((h) => h.length > 0);
      externalItems.push(controlItem({
        id: "destination_hosts", label: "Allowlist for destinasjons-URL-er (Jira, Grafana, n8n m.fl.)", status: "OK",
        detail_no: hosts.length === 0 ? "Tom (lukket): ingen destinasjons-URL kan lagres - en lagret URL ville styrt hvor credentials sendes." : `Kun disse vertene kan lagres som destinasjon: ${joinFact(hosts, 240)}.`,
        facts: { hosts: hosts.length, list: joinFact(hosts, 240) }
      }));
      sections.push(controlSection({
        id: "external", title_no: "Eksterne begrensninger", source: "miljøkonfigurasjon (JARVIS_GITHUB_REPO, JARVIS_GIT_ALLOWED_REPOS, JARVIS_DESTINATION_HOST_ALLOWLIST)", observed_at: nowIso,
        summary_no: `${externalItems.length} begrensninger: ${countsNo(externalItems)}.`, items: externalItems
      }));

      // ---------------------------------------------------------------------------------------------------------------------------------------------
      // 9. Åpne bekreftelser
      // ---------------------------------------------------------------------------------------------------------------------------------------------
      if (confirmR.ok) {
        const confirmItems: ControlItem[] = confirmR.value.map((c) => {
          const expired = c.expires_at !== null && Date.parse(c.expires_at) <= nowMs;
          return controlItem({
            id: c.confirmation_id, label: `${c.tool_id}.${c.action}`, status: expired ? "OK" : "WARN", observed_at: c.created_at,
            detail_no: expired ? `Utløpt ${rel(c.expires_at)} - kan ikke lenger godkjennes.` : `Venter på din beslutning siden ${rel(c.created_at)}; utløper ${c.expires_at ?? "ukjent"}.`,
            facts: { tool: c.tool_id, action: c.action, expired, created_at: c.created_at, expires_at: c.expires_at, taint: joinFact(c.taint_reasons, 200) }
          });
        });
        confirmItems.sort(bySeverityThenLabel);
        const waiting = confirmItems.filter((i) => i.status === "WARN").length;
        sections.push(controlSection({
          id: "confirmations", title_no: "Åpne bekreftelser", source: "action_confirmations (status pending, tenant-RLS)", observed_at: nowIso,
          summary_no: waiting === 0 ? "Ingen bekreftelser venter på deg." : `${waiting} bekreftelser venter på din beslutning (handlingen er stoppet til du godkjenner eller avviser). Godkjenning skjer i chat/dashbord der parametrene vises (DEFERRED her).`,
          items: confirmItems
        }));
      } else {
        sections.push(unknownControlSection("confirmations", "Åpne bekreftelser", "action_confirmations (status pending, tenant-RLS)", `kunne ikke leses (${confirmR.category})`));
      }

      return { sections, actions };
    }
  };
}
