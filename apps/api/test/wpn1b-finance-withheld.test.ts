import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FINANCE_DERIVED_LOOP_TYPE, FINANCE_DERIVED_LOOP_TYPES, isFinanceDerivedLoopType, loopFamily, type OpenLoopType
} from "@jarvis/business";
import {
  GUARDED_CLOUD_WITHHELD_CENTERS, CLOUD_WITHHELD_CENTERS, composeSloReport, withheldCenterData, shapeAutonomyPoliciesForCloud, shapeCapabilityStatusForCloud, shapeConnectorsForCloud,
  shapeOwnerControlForCloud, shapePausedDomainsForCloud, shapeSloReportForCloud, type CapabilityStatus, type SloReport
} from "@jarvis/executive";
import { domainForLoopType } from "@jarvis/situations";
import {
  CONNECTOR_REGISTRY, FINANCE_DERIVED_SITUATION_DOMAINS, FINANCE_WITHHELD_NOTE_NO, financeWithheldMarker, isFinanceConnectorId, isFinanceCredentialRef, isFinanceDerivedSituationDomain,
  isFinanceToolId, isKnownNonFinanceConnectorId, isKnownNonFinanceCredentialRef, listConnectorStatus, type ConnectorStatus
} from "@jarvis/tool-gateway";
import { UNKNOWN_FINANCE_LOOKING_IDS, UNKNOWN_FINANCE_LOOKING_REFS } from "./support/n1b-unknown-ids.ts";

/**
 * WP-N1b (K2/K4): enhetstester (uten DB) for byggeklossene som holder finansAVLEDET innhold tilbake - merket, gjenkjenningen og de rene formingsfunksjonene - og pinner klassifiseringene mot de EKSISTERENDE kildene
 * (situasjonsbroen, Finans-senteret, connector-registeret), så de ikke kan drive fra hverandre.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string): string => readFileSync(`${root}${rel}`, "utf8");

describe("det nøytrale merket", () => {
  it("merknaden har INGEN sifre, id-er, uuid-er, beløp, tellinger eller leverandørnavn, og merket er alltid det samme (konstant tekst)", () => {
    expect(FINANCE_WITHHELD_NOTE_NO).not.toMatch(/\d/);
    expect(FINANCE_WITHHELD_NOTE_NO).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    for (const vendor of [...CONNECTOR_REGISTRY.filter((c) => c.category === "finance").flatMap((c) => [c.id, c.display_name]), "Neonomics", "Stripe", "Vipps", "Fiken", "Wallester", "NOK", "kr"]) {
      expect(FINANCE_WITHHELD_NOTE_NO.toLowerCase(), vendor).not.toContain(vendor.toLowerCase() === "kr" ? " kr " : vendor.toLowerCase());
    }
    expect(FINANCE_WITHHELD_NOTE_NO.length).toBeLessThan(500);
    expect(financeWithheldMarker()).toEqual({ finance_withheld: true, note_no: FINANCE_WITHHELD_NOTE_NO });
    expect(financeWithheldMarker()).toEqual(financeWithheldMarker());
  });

  it("de vakt-styrte kontrollsentrenes merknader er også uten sifre og leverandørnavn", () => {
    for (const center of GUARDED_CLOUD_WITHHELD_CENTERS) {
      const text = JSON.stringify(withheldCenterData(center, "Tittel"));
      expect(text, center).not.toMatch(/\d/);
      for (const vendor of ["Stripe", "Vipps", "Fiken", "Neonomics", "Wallester"]) expect(text, `${center}/${vendor}`).not.toContain(vendor);
    }
  });
});

describe("gjenkjenning av finanskoblinger og -legitimasjon (fra connector-registeret, fail-closed)", () => {
  const finance = CONNECTOR_REGISTRY.filter((c) => c.category === "finance");

  it("alle fem finanskoblinger (id, verktøy-id fra live-testen og alle credential-refs) gjenkjennes", () => {
    expect(finance.map((c) => c.id).sort()).toEqual(["fiken", "neonomics", "stripe", "vipps", "wallester"]);
    for (const c of finance) {
      expect(isFinanceConnectorId(c.id), c.id).toBe(true);
      if (c.live_test) expect(isFinanceConnectorId(c.live_test.tool_id), c.live_test.tool_id).toBe(true);
      for (const ref of [...c.credential_refs, ...(c.optional_credential_refs ?? [])]) expect(isFinanceCredentialRef(ref), ref).toBe(true);
    }
    for (const tool of ["finance", "finance_spend", "finance_stripe", "finance_vipps", "finance_neonomics", "finance_wallester"]) {
      expect(isFinanceToolId(tool), tool).toBe(true);
      expect(isFinanceConnectorId(tool), tool).toBe(true);
    }
  });

  it("INGEN ikke-finans-connector i registeret (id, verktøy-id eller credential-ref) regnes som finansavledet (ingen falske positive)", () => {
    for (const c of CONNECTOR_REGISTRY.filter((x) => x.category !== "finance")) {
      expect(isFinanceConnectorId(c.id), `id ${c.id}`).toBe(false);
      if (c.live_test) expect(isFinanceConnectorId(c.live_test.tool_id), `tool ${c.live_test.tool_id}`).toBe(false);
      for (const ref of [...c.credential_refs, ...(c.optional_credential_refs ?? [])]) expect(isFinanceCredentialRef(ref), `ref ${ref} (${c.id})`).toBe(false);
    }
  });

  it("fail-closed: ikke-strenger regnes som finansavledet; ukjente id-er/refs som nevner en finansleverandør også; tom streng og vanlige navn gjør det ikke", () => {
    for (const bad of [undefined, null, 7, {}, [], true]) {
      expect(isFinanceConnectorId(bad as never)).toBe(true);
      expect(isFinanceCredentialRef(bad as never)).toBe(true);
    }
    for (const id of ["stripe-test", "FINANCE_X", "my_vipps_conn", "neonomics.sandbox", "bank_x", "payment-gw"]) expect(isFinanceConnectorId(id), id).toBe(true);
    for (const ref of ["STRIPE_WEBHOOK_SECRET", "FINANCE_VIPPS_CRED_REF", "x_fiken_y", "JARVIS_WALLESTER_X"]) expect(isFinanceCredentialRef(ref), ref).toBe(true);
    for (const ok of ["", "  ", "github", "model:anthropic", "JARVIS_GITHUB_TOKEN", "bankid-ish"]) {
      expect(isFinanceConnectorId(ok), ok).toBe(false);
      expect(isFinanceCredentialRef(ok), ok).toBe(false);
    }
  });

  it("situasjonsdomenene: `spend` er finansavledet (også med store bokstaver/mellomrom); andre domener ikke; ikke-strenger er det (fail-closed)", () => {
    expect([...FINANCE_DERIVED_SITUATION_DOMAINS]).toEqual(["spend"]);
    for (const d of ["spend", "SPEND", " spend ", "Spend\n"]) expect(isFinanceDerivedSituationDomain(d), d).toBe(true);
    for (const d of ["pipeline", "support", "deadlines", "product", "operations", "retention", "infra", "home", "health"]) expect(isFinanceDerivedSituationDomain(d), d).toBe(false);
    for (const d of [undefined, null, 1, {}]) expect(isFinanceDerivedSituationDomain(d as never)).toBe(true);
  });
});

describe("FIX-A: TILLATELSESLISTE for fritekst-id-er (ukjent = finansavledet): kun KJENTE ikke-finanskoblinger slipper til en sky-/ukjent modell", () => {
  const nonFinance = CONNECTOR_REGISTRY.filter((c) => c.category !== "finance");
  const finance = CONNECTOR_REGISTRY.filter((c) => c.category === "finance");

  it("hver ikke-finanskobling i registeret (id og live-test-verktøy-id) og hver av credential-refene deres (også valgfrie) er KJENT", () => {
    expect(nonFinance.length).toBeGreaterThan(40);
    for (const c of nonFinance) {
      expect(isKnownNonFinanceConnectorId(c.id), `id ${c.id}`).toBe(true);
      if (c.live_test) expect(isKnownNonFinanceConnectorId(c.live_test.tool_id), `tool ${c.live_test.tool_id}`).toBe(true);
      for (const ref of [...c.credential_refs, ...(c.optional_credential_refs ?? [])]) expect(isKnownNonFinanceCredentialRef(ref), `ref ${ref} (${c.id})`).toBe(true);
    }
  });

  it("ingen finanskobling (id, verktøy-id, ref), ingenting i finans-navnerommene og ingenting som treffer ordstammene er kjent", () => {
    for (const c of finance) {
      expect(isKnownNonFinanceConnectorId(c.id), c.id).toBe(false);
      if (c.live_test) expect(isKnownNonFinanceConnectorId(c.live_test.tool_id), c.live_test.tool_id).toBe(false);
      for (const ref of [...c.credential_refs, ...(c.optional_credential_refs ?? [])]) expect(isKnownNonFinanceCredentialRef(ref), ref).toBe(false);
    }
    for (const id of ["finance", "finance_spend", "finance_stripe", "stripe-test", "bank_x", "payment-gw", "FINANCE_X"]) expect(isKnownNonFinanceConnectorId(id), id).toBe(false);
    for (const ref of ["STRIPE_WEBHOOK_SECRET", "JARVIS_VIPPS_CLIENT_SECRET", "x_fiken_y"]) expect(isKnownNonFinanceCredentialRef(ref), ref).toBe(false);
  });

  it("de 16 ukjente fritekst-id-ene og 10 ukjente credential-refene (uten ordstamme) er IKKE kjente - og stamme-svartelisten alene fanger dem ikke (det var hullet)", () => {
    for (const id of UNKNOWN_FINANCE_LOOKING_IDS) {
      expect(isFinanceConnectorId(id), `svartelisten fanger ikke ${id} (hullet)`).toBe(false);
      expect(isKnownNonFinanceConnectorId(id), id).toBe(false);
    }
    for (const ref of UNKNOWN_FINANCE_LOOKING_REFS) {
      expect(isFinanceCredentialRef(ref), `svartelisten fanger ikke ${ref} (hullet)`).toBe(false);
      expect(isKnownNonFinanceCredentialRef(ref), ref).toBe(false);
    }
    expect(UNKNOWN_FINANCE_LOOKING_IDS.length).toBe(16);
    expect(UNKNOWN_FINANCE_LOOKING_REFS.length).toBe(10);
  });

  it("FAIL-CLOSED: ikke-strenger, tom/blank streng, ukjente navn uten finanspreg og avvikende skrivemåte av en kjent id (STORE bokstaver, mellomrom) er IKKE kjent (eksakt treff)", () => {
    for (const bad of [undefined, null, 7, {}, [], true]) {
      expect(isKnownNonFinanceConnectorId(bad as never)).toBe(false);
      expect(isKnownNonFinanceCredentialRef(bad as never)).toBe(false);
    }
    for (const id of ["", "  ", "some_future_connector", "ollama", "GitHub", " github", "github ", "github\n", "model:anthropic", "constructor", "__proto__", "toString"]) expect(isKnownNonFinanceConnectorId(id), JSON.stringify(id)).toBe(false);
    for (const ref of ["", "  ", "JARVIS_SOME_FUTURE_TOKEN", "jarvis_github_token", " JARVIS_GITHUB_TOKEN", "constructor"]) expect(isKnownNonFinanceCredentialRef(ref), JSON.stringify(ref)).toBe(false);
  });

  it("`shapeOwnerControlForCloud`: av frosne koblinger og tilbakekalte credentials beholdes KUN de kjente ikke-finans-ene (alle 16 ukjente id-er og alle 10 ukjente refer er ute); alle begrunnelser `null`", () => {
    const at = { actor_person_id: "p", changed_at: "2026-11-21T08:00:00.000Z" };
    const state = {
      kill_switch: { active: false, reason: "FRITEKST-KILL", ...at },
      frozen_connectors: [...["github", "slack", "stripe", ...UNKNOWN_FINANCE_LOOKING_IDS, "some_future_connector"].map((connector_id) => ({ connector_id, reason: `FRITEKST-${connector_id}`, ...at }))],
      revoked_credentials: [...["JARVIS_GITHUB_TOKEN", "JARVIS_VIPPS_CLIENT_SECRET", ...UNKNOWN_FINANCE_LOOKING_REFS, "JARVIS_SOME_FUTURE_TOKEN"].map((credential_ref) => ({ credential_ref, reason: `FRITEKST-${credential_ref}`, ...at }))]
    };
    const shaped = shapeOwnerControlForCloud(state);
    expect(shaped.frozen_connectors.map((f) => f.connector_id)).toEqual(["github", "slack"]);
    expect(shaped.revoked_credentials.map((r) => r.credential_ref)).toEqual(["JARVIS_GITHUB_TOKEN"]);
    expect(JSON.stringify(shaped)).not.toContain("FRITEKST");
    for (const unknown of [...UNKNOWN_FINANCE_LOOKING_IDS, ...UNKNOWN_FINANCE_LOOKING_REFS]) expect(JSON.stringify(shaped), unknown).not.toContain(unknown);
  });
});

describe("løkketype-klassifiseringen er den ENE sannheten og er enig med de eksisterende kildene", () => {
  const types = Object.keys(FINANCE_DERIVED_LOOP_TYPE) as OpenLoopType[];

  it("settet er uttømmende over `OpenLoopType` (27 typer) og følger situasjonsbroen: finansavledet ⇔ domenet `spend`", () => {
    expect(types.length).toBe(27);
    for (const t of types) {
      expect(isFinanceDerivedLoopType(t), t).toBe(domainForLoopType(t) === "spend");
      expect(isFinanceDerivedSituationDomain(domainForLoopType(t)), t).toBe(isFinanceDerivedLoopType(t));
    }
    expect(FINANCE_DERIVED_LOOP_TYPES.length).toBe(12);
  });

  it("`loopFamily` (korroborering) sier «finance» for alle finanstyper unntatt markedsutgift (som er `growth` der): forskjellen er nøyaktig én, bevisst type", () => {
    const familyFinance = types.filter((t) => loopFamily(t) === "finance");
    for (const t of familyFinance) expect(isFinanceDerivedLoopType(t), t).toBe(true);
    expect(types.filter((t) => isFinanceDerivedLoopType(t) && !familyFinance.includes(t))).toEqual(["marketing_spend_anomaly"]);
  });

  it("Finans-senterets egen liste (`FINANCE_LOOP_TYPES`) er en delmengde (åtte typer, inkl. markedsutgift)", () => {
    const src = read("apps/api/src/control-center/finance.ts");
    const list = /const FINANCE_LOOP_TYPES = \[([\s\S]*?)\] as const/.exec(src)?.[1] ?? "";
    const centerTypes = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(centerTypes.length).toBe(8);
    for (const t of centerTypes) expect(isFinanceDerivedLoopType(t), t).toBe(true);
  });

  it("FAIL-CLOSED: en ukjent løkketype og ikke-strenger regnes som finansavledet; kjente ikke-finanstyper ikke", () => {
    for (const bad of ["ny_type_fra_fremtiden", "", "constructor", "__proto__", "toString", undefined, null, 5]) expect(isFinanceDerivedLoopType(bad), String(bad)).toBe(true);
    for (const ok of ["overdue_followup", "support_ticket_overdue", "contract_renewal_due", "customer_churn_risk", "operations_task_overdue", "product_item_needs_triage"]) expect(isFinanceDerivedLoopType(ok), ok).toBe(false);
  });
});

describe("de rene formingsfunksjonene (executive)", () => {
  const owner = {
    kill_switch: { active: true, reason: "FRITEKST-KILL", actor_person_id: "p", changed_at: "2026-11-21T08:00:00.000Z" },
    frozen_connectors: [
      { connector_id: "github", reason: "FRITEKST-GH", actor_person_id: "p", changed_at: "2026-11-21T08:10:00.000Z" },
      { connector_id: "stripe", reason: "FRITEKST-STRIPE", actor_person_id: "p", changed_at: "2026-11-21T08:20:00.000Z" },
      { connector_id: "finance_vipps", reason: "FRITEKST-VIPPS", actor_person_id: "p", changed_at: "2026-11-21T08:30:00.000Z" }
    ],
    revoked_credentials: [
      { credential_ref: "JARVIS_GITHUB_TOKEN", reason: "FRITEKST-TOKEN", actor_person_id: "p", changed_at: "2026-11-21T09:00:00.000Z" },
      { credential_ref: "JARVIS_VIPPS_CLIENT_SECRET", reason: "FRITEKST-VIPPS2", actor_person_id: "p", changed_at: "2026-11-21T09:10:00.000Z" }
    ]
  };

  it("owner_control: finanskoblinger og -legitimasjon ut, ALLE begrunnelser (også kill switch) holdt tilbake, resten (id, aktør, tid) bevart og merket satt", () => {
    const shaped = shapeOwnerControlForCloud(owner);
    expect(shaped.frozen_connectors.map((f) => f.connector_id)).toEqual(["github"]);
    expect(shaped.revoked_credentials.map((r) => r.credential_ref)).toEqual(["JARVIS_GITHUB_TOKEN"]);
    expect(shaped.kill_switch).toEqual({ active: true, reason: null, actor_person_id: "p", changed_at: "2026-11-21T08:00:00.000Z" });
    expect(shaped.reasons_withheld).toBe(true);
    expect(JSON.stringify(shaped)).not.toContain("FRITEKST");
  });

  it("pauser og autonomi-bindinger: `spend` og finansverktøy ut, resten urørt", () => {
    expect(shapePausedDomainsForCloud(["spend", "pipeline", "SPEND", "support"])).toEqual(["pipeline", "support"]);
    const policies = [
      { domain: "pipeline", tool_id: "business", action: "create_followup", enabled: true, parameters: {}, memory_space_id: "business", actor_person_id: null, updated_at: "x" },
      { domain: "spend", tool_id: "finance_spend", action: "pause_recurring_commitment", enabled: true, parameters: { id: "N1B" }, memory_space_id: "business", actor_person_id: null, updated_at: "x" },
      { domain: "ops", tool_id: "finance_vipps", action: "request_refund", enabled: true, parameters: {}, memory_space_id: "business", actor_person_id: null, updated_at: "x" }
    ] as never[];
    expect(shapeAutonomyPoliciesForCloud(policies).map((p) => p.domain)).toEqual(["pipeline"]);
  });

  it("get_capability_status: finansverktøy og finanshelse ut (også en finanshelse uten verktøy), resten bevart, merket satt", () => {
    const status: CapabilityStatus = {
      chat_accessible_tools: [
        { tool_id: "business", actions: ["a"], capability_classes: ["A"], configured: true },
        { tool_id: "finance_stripe", actions: ["get_balance"], capability_classes: ["A"], configured: false },
        { tool_id: "finance", actions: ["list_x"], capability_classes: ["A"], configured: true }
      ],
      connector_health: [{ tool_id: "github", state: "healthy", at: "t" }, { tool_id: "finance_neonomics", state: "unavailable", at: "t", detail: "N1B-DETAIL" }, { tool_id: "stripe", state: "auth_failed", at: "t" }],
      serving_model: { provider: "anthropic", model: "m" }
    };
    const shaped = shapeCapabilityStatusForCloud(status);
    expect(shaped.chat_accessible_tools.map((t) => t.tool_id)).toEqual(["business"]);
    expect(shaped.connector_health.map((h) => h.tool_id)).toEqual(["github"]);
    expect(shaped.serving_model).toEqual({ provider: "anthropic", model: "m" });
    expect(shaped.finance_withheld).toBe(true);
    expect(JSON.stringify(shaped)).not.toContain("N1B-DETAIL");
  });

  it("get_connector_status: registerets finanskoblinger ut (alle fem), alle andre bevart", async () => {
    const connectors = await listConnectorStatus({ hasSecret: async () => true, health: new Map() } as never);
    const shaped: ConnectorStatus[] = shapeConnectorsForCloud(connectors);
    expect(connectors.length - shaped.length).toBe(5);
    expect(shaped.some((c) => c.category === "finance")).toBe(false);
    expect(shaped.some((c) => c.id === "github")).toBe(true);
  });

  it("SLO-rapporten: kostnadsdriften ut og sammendraget komponert PÅ NYTT (ingen rest av «Kostnad per kall»), øvrig drift og tjenestemål bevart, merket satt", () => {
    const report: SloReport = composeSloReport({
      as_of: "2026-11-25T10:00:00.000Z",
      slos: [],
      drift: { window_recent_hours: 24, window_baseline_hours: 168, insufficient: ["jobs"], findings: [
        { series: "model:CHAT", metric: "cost_per_call_ore", baseline: 3, recent: 6.7, change: 1.2, detail: "Kostnad per kall økte fra 3 til 6.7 øre (+122 %)" },
        { series: "model:CHAT", metric: "p95_ms", baseline: 800, recent: 1500, change: 0.9, detail: "p95-latens økte" }
      ] } as never,
      data_quality: null
    });
    expect(report.summary_no).toContain("Kostnad per kall");
    const shaped = shapeSloReportForCloud(report);
    expect(shaped.drift?.findings.map((f) => f.metric)).toEqual(["p95_ms"]);
    expect(shaped.summary_no).not.toContain("Kostnad per kall");
    expect(shaped.summary_no).toContain("p95-latens økte");
    expect(shaped.drift?.insufficient).toEqual(["jobs"]);
    expect(shaped.finance_withheld).toBe(true);
    // ingen drift (null) og ingen kostnadsfunn: samme innhold + merket
    expect(shapeSloReportForCloud(composeSloReport({ as_of: "x", slos: [], drift: null, data_quality: null })).drift).toBeNull();
  });
});

describe("vakt-styrte kontrollsentre", () => {
  it("settet er nøyaktig Autoritet, Integrasjoner og AI, og overlapper ikke med de alltid-tilbakeholdte (Finans, Verdi, Evolusjon)", () => {
    expect([...GUARDED_CLOUD_WITHHELD_CENTERS].sort()).toEqual(["ai", "authority", "integration"]);
    for (const c of GUARDED_CLOUD_WITHHELD_CENTERS) expect((CLOUD_WITHHELD_CENTERS as readonly string[]).includes(c), c).toBe(false);
  });
});
