import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_MANIFEST, DRIFT_CODES, FULL_MANIFESTS, GITHUB_MANIFEST, STRIPE_MANIFEST, buildManifestCatalogue, checkManifestAgainstDerived, deriveSkeletonManifests,
  isUnknown, productionConnectorDefinitions, validateConnectorManifest, type ConnectorManifest, type DriftCode, type DriftIssue
} from "../src/index.ts";
import { CONNECTOR_REGISTRY } from "@jarvis/tool-gateway";
import { secretShapedActionKeys, secretShapedConnectorId } from "./fixtures.ts";

const definitions = productionConnectorDefinitions();
const derivedById = new Map(deriveSkeletonManifests({ definitions }).map((m) => [m.identity.id, m]));
const clone = (m: ConnectorManifest): ConnectorManifest => structuredClone(m);
const drift = (authored: ConnectorManifest) => checkManifestAgainstDerived(authored, derivedById.get(authored.identity.id)!);
const codes = (authored: ConnectorManifest) => drift(authored).map((d) => d.code);

describe("de tre fulle referansemanifestene (GitHub, Cloudflare, Stripe)", () => {
  it("er gyldige FULLE manifester uten ukjent-markører, og FULL_MANIFESTS er nøyaktig disse tre", () => {
    expect(FULL_MANIFESTS.map((m) => m.identity.id)).toEqual(["github", "cloudflare", "stripe"]);
    for (const m of FULL_MANIFESTS) {
      const r = validateConnectorManifest(m, { require_full: true });
      expect(r.issues, m.identity.id).toEqual([]);
      expect(r.unknown_paths, m.identity.id).toEqual([]);
      expect(m.source).toBe("authored");
    }
  });

  it("har ingen drift mot registeret (handlingsmengde, risiko, effekt, step-up, idempotens, tillit, grenser, credential-referanser, helsesjekk)", () => {
    for (const m of FULL_MANIFESTS) expect(drift(m), m.identity.id).toEqual([]);
  });

  it("GitHub: 23 handlinger; klasse D (merge_pr, delete_branch) har komplett kjede; D-41-gap er navngitt DEFERRED/PARTIAL; webhooks er DEFERRED", () => {
    expect(GITHUB_MANIFEST.actions.length).toBe(23);
    const d = GITHUB_MANIFEST.actions.filter((a) => a.authority.risk_class === "D");
    expect(d.map((a) => a.key).sort()).toEqual(["github.delete_branch", "github.merge_pr"]);
    for (const a of d) expect(a.reversibility.class_d_chain).toEqual({ status: "complete", missing: [] });
    if (isUnknown(GITHUB_MANIFEST.d41_audit)) throw new Error("d41_audit mangler");
    expect(GITHUB_MANIFEST.d41_audit.gaps.length).toBeGreaterThanOrEqual(8);
    expect(GITHUB_MANIFEST.d41_audit.gaps.every((g) => g.status === "DEFERRED" || g.status === "PARTIAL")).toBe(true);
    // Review LOW: den valgfrie Workflows-tillatelsen er dokumentert i runbooken, men kartleggingen mot handlingene er uverifisert - derfor er scopene ikke «fullt verifisert».
    expect(GITHUB_MANIFEST.d41_audit.scopes_verified_against_docs).toBe(false);
    expect(GITHUB_MANIFEST.d41_audit.unverified_scopes.some((s) => s.includes("Workflows"))).toBe(true);
    const gh = isUnknown(GITHUB_MANIFEST.auth.scopes.provider) ? [] : GITHUB_MANIFEST.auth.scopes.provider;
    expect(gh.some((s) => s.scope.includes("Workflows") && s.scope.includes("VALGFRI") && s.needed_for.length === 0)).toBe(true);
    expect(isUnknown(GITHUB_MANIFEST.capabilities.webhooks) ? "" : GITHUB_MANIFEST.capabilities.webhooks.status).toBe("deferred");
  });

  it("Cloudflare: alle C/D-mutasjoner krever step-up og step-up-listen stemmer; delvis verifiserte scopes er ærlig merket (ikke FULL)", () => {
    expect(CLOUDFLARE_MANIFEST.actions.length).toBe(21);
    const mutating = CLOUDFLARE_MANIFEST.actions.filter((a) => a.effect !== "read");
    expect(mutating.length).toBe(8);
    for (const a of mutating) expect(a.authority.step_up_required, a.key).toBe(true);
    if (isUnknown(CLOUDFLARE_MANIFEST.d41_audit)) throw new Error("d41_audit mangler");
    expect(CLOUDFLARE_MANIFEST.d41_audit.classification).toBe("PARTIAL");
    expect(CLOUDFLARE_MANIFEST.d41_audit.scopes_verified_against_docs).toBe(false);
    expect(CLOUDFLARE_MANIFEST.d41_audit.unverified_scopes.length).toBeGreaterThan(0);
    expect(CLOUDFLARE_MANIFEST.core_boundary.system_of_record).toBe("EXTERNAL_CANONICAL");
  });

  it("Stripe: pengehandlingen er klasse D med step-up og irreversibel; HYBRID_WITH_CLEAR_AUTHORITY med delt autoritet; avstemming er påkrevd", () => {
    const refund = STRIPE_MANIFEST.actions.find((a) => a.key === "finance_stripe.submit_refund")!;
    expect(refund.authority).toMatchObject({ risk_class: "D", step_up_required: true });
    expect(refund.effect).toBe("pay");
    expect(refund.reversibility).toMatchObject({ reversible: false, destructive: true });
    expect(STRIPE_MANIFEST.core_boundary.system_of_record).toBe("HYBRID_WITH_CLEAR_AUTHORITY");
    expect(STRIPE_MANIFEST.core_boundary.authority_split).toContain("Jarvis eier");
    expect(STRIPE_MANIFEST.operations.reconciliation?.required).toBe(true);
    expect(STRIPE_MANIFEST.core_boundary.core_dependency_decision_required).toBe(false);
  });

  it("review M3: D-64-grensen siterer beslutningene som loggførte porten (GitHub D-94, Cloudflare D-461, Stripe D-109) - ikke ARCHITECTURE.md §11.9 som grunnlag", () => {
    expect(GITHUB_MANIFEST.core_boundary.decision_refs).toEqual(["D-94", "D-64"]);
    expect(CLOUDFLARE_MANIFEST.core_boundary.decision_refs).toEqual(["D-461"]);
    expect(STRIPE_MANIFEST.core_boundary.decision_refs).toEqual(["D-109"]);
    expect(STRIPE_MANIFEST.core_boundary.authority_split).toContain("D-109");
    expect(STRIPE_MANIFEST.core_boundary.authority_split).not.toMatch(/ARCHITECTURE\.md §11\.9,?\)/);
    for (const m of FULL_MANIFESTS) expect(m.core_boundary.basis, m.identity.id).toBe("audited");
  });

  it("review LOW (Stripe): sletting og tilgangsstyring har gap-oppføringer (ikke stille utelatt), slettesemantikken motsier ikke revisjonen, refusjons-tillatelsen er merket UVERIFISERT, og 23 t-vinduet er en intern avgjørelse", () => {
    if (isUnknown(STRIPE_MANIFEST.d41_audit)) throw new Error("d41_audit mangler");
    const gaps = STRIPE_MANIFEST.d41_audit.gaps.map((g) => `${g.status}: ${g.capability}`).join(" | ");
    expect(gaps).toMatch(/DEFERRED: sletting av Stripe-ressurser/);
    expect(gaps).toMatch(/DEFERRED: tilgangsstyring/);
    expect(STRIPE_MANIFEST.d41_audit.delete.provider_offers).toBe("unknown");
    expect(isUnknown(STRIPE_MANIFEST.data.delete_semantics) ? "" : STRIPE_MANIFEST.data.delete_semantics.provider_side).toBe("deferred");
    const scopes = isUnknown(STRIPE_MANIFEST.auth.scopes.provider) ? [] : STRIPE_MANIFEST.auth.scopes.provider.map((s) => s.scope);
    expect(scopes.some((s) => s.includes("refunds (skriving)"))).toBe(false);
    expect(scopes.filter((s) => s.startsWith("UVERIFISERT") && s.includes("refusjoner")).length).toBe(1);
    expect(STRIPE_MANIFEST.d41_audit.unverified_scopes.some((s) => s.includes("refusjoner"))).toBe(true);
    const note = isUnknown(STRIPE_MANIFEST.idempotency.retry_semantics) ? "" : (STRIPE_MANIFEST.idempotency.retry_semantics.note ?? "");
    expect(note).toContain("EGEN avgjørelse");
    expect(note).toContain("255 tegn");
    expect(note).toContain("minst 24 t");
    expect(note).not.toMatch(/Stripe \(23 t-vindu\)/);
  });

  it("review LOW (Cloudflare): delete er PARTIAL (ikke full) ved siden av utsatte slettbare ressurser, og listetillatelser, purge-maksimum og 90-dagers rotasjon er merket uverifisert", () => {
    if (isUnknown(CLOUDFLARE_MANIFEST.d41_audit)) throw new Error("d41_audit mangler");
    const d = CLOUDFLARE_MANIFEST.d41_audit;
    expect(d.delete.implemented).toBe("partial");
    expect(d.gaps.some((g) => g.status === "DEFERRED" && /sletting av øvrige slettbare ressurser/.test(g.capability))).toBe(true);
    expect(d.unverified_scopes.some((s) => s.includes("List Members"))).toBe(true);
    expect(d.unverified_scopes.some((s) => s.includes("rolle-listen"))).toBe(true);
    expect(d.gaps.some((g) => /purge/.test(g.capability) && /UVERIFISERT/.test(g.reason))).toBe(true);
    expect(isUnknown(CLOUDFLARE_MANIFEST.limits.quotas) ? "" : CLOUDFLARE_MANIFEST.limits.quotas).toContain("UVERIFISERT");
    const rot = isUnknown(CLOUDFLARE_MANIFEST.auth.rotation) ? "" : (CLOUDFLARE_MANIFEST.auth.rotation.note ?? "");
    expect(rot).toContain("UVERIFISERT");
    expect(rot).toContain("Jarvis' egen anbefaling");
  });
});

describe("katalogen: ett manifest per registeroppføring (fullt der det finnes, ellers skeleton)", () => {
  const catalogue = buildManifestCatalogue({ definitions, authored: FULL_MANIFESTS });

  it("dekker hele registeret, uten foreldreløse eller doble manifester og uten drift", () => {
    expect(catalogue.entries.map((e) => e.connector_id)).toEqual(CONNECTOR_REGISTRY.map((c) => c.id));
    expect(catalogue.orphans).toEqual([]);
    expect(catalogue.duplicates).toEqual([]);
    for (const e of catalogue.entries) expect(e.drift, e.connector_id).toEqual([]);
    expect(catalogue.entries.filter((e) => e.level === "full").map((e) => e.connector_id).sort()).toEqual(["cloudflare", "github", "stripe"]);
    expect(catalogue.entries.filter((e) => e.level === "skeleton").length).toBe(CONNECTOR_REGISTRY.length - 3);
  });

  it("et manifest for en connector som ikke finnes i registeret er foreldreløst; to manifester for samme connector er dobbelt", () => {
    const ghost = clone(GITHUB_MANIFEST);
    ghost.identity.id = "ghost_connector";
    const cat = buildManifestCatalogue({ definitions, authored: [...FULL_MANIFESTS, ghost, clone(STRIPE_MANIFEST)] });
    expect(cat.orphans).toEqual(["ghost_connector"]);
    expect(cat.duplicates).toEqual(["stripe"]);
  });
});

describe("DRIFT: manifestet og registeret må være identiske i det som kan avledes (mutasjonstester - hver endring fanges)", () => {
  const act = (m: ConnectorManifest, key: string) => m.actions.find((a) => a.key === key)!;

  it("endret risikoklasse, effekt, step-up, owner-only, idempotenskrav og provider-idempotens", () => {
    const a = clone(CLOUDFLARE_MANIFEST); act(a, "cloudflare.update_dns_record").authority.risk_class = "C";
    expect(codes(a)).toContain("drift_risk_class");
    // Review M5: testen het «endret ... effekt» men muterte aldri effekten (drift_effect hadde ingen mutasjonstest).
    const eff = clone(GITHUB_MANIFEST); act(eff, "github.create_issue").effect = "send";
    expect(drift(eff).filter((d) => d.code === "drift_effect").map((d) => d.path)).toEqual([`actions[${eff.actions.findIndex((x) => x.key === "github.create_issue")}].effect`]);
    expect(drift(eff).find((d) => d.code === "drift_effect")?.message).toContain("manifestet sier send, registeret sier write");
    const b = clone(CLOUDFLARE_MANIFEST); act(b, "cloudflare.purge_cache").authority.step_up_required = false;
    expect(codes(b)).toContain("drift_step_up");
    const c = clone(GITHUB_MANIFEST); act(c, "github.create_issue").idempotency.requirement = "required";
    expect(codes(c)).toContain("drift_idempotency_requirement");
    const d = clone(GITHUB_MANIFEST); act(d, "github.create_issue").idempotency.provider_idempotent = true;
    expect(codes(d)).toContain("drift_provider_idempotent");
    const e = clone(GITHUB_MANIFEST); act(e, "github.read_issues").authority.owner_only = true;
    expect(codes(e)).toContain("drift_owner_only");
  });

  it("review M5: endret kind (kap. 10-bøtte) og reversibel-flagg fanges (drift_kind, drift_reversible hadde ingen mutasjonstest)", () => {
    const k = clone(GITHUB_MANIFEST); act(k, "github.create_issue").kind = "action";
    const kd = drift(k).filter((d) => d.code === "drift_kind");
    expect(kd.length).toBe(1);
    expect(kd[0]!.message).toContain("manifestet sier action, registeret sier write");
    const r = clone(GITHUB_MANIFEST); act(r, "github.create_issue").reversibility.reversible = false;
    const rd = drift(r).filter((d) => d.code === "drift_reversible");
    expect(rd.length).toBe(1);
    expect(rd[0]!.message).toContain("manifestet sier false, registeret sier true");
    const r2 = clone(GITHUB_MANIFEST); act(r2, "github.merge_pr").reversibility.reversible = true;
    expect(codes(r2)).toContain("drift_reversible");
  });

  it("endret rate limit, tidsavbrudd, tillit, før-tilstand, etterbetingelse og klasse D-kjede", () => {
    const a = clone(GITHUB_MANIFEST); act(a, "github.get_branch").limits.rate_limit_per_minute = 1;
    expect(codes(a)).toContain("drift_rate_limit");
    const b = clone(GITHUB_MANIFEST); act(b, "github.merge_pr").operations.timeout_ms = 1;
    expect(codes(b)).toContain("drift_timeout");
    const c = clone(GITHUB_MANIFEST); act(c, "github.read_issues").trust.output = "trusted";
    expect(codes(c)).toContain("drift_trust");
    const d = clone(GITHUB_MANIFEST); act(d, "github.merge_pr").reversibility.evidence.before_state = false;
    expect(codes(d)).toContain("drift_before_state");
    const e = clone(GITHUB_MANIFEST); act(e, "github.merge_pr").reversibility.evidence.postcondition = "none";
    expect(codes(e)).toContain("drift_postcondition");
    const f = clone(GITHUB_MANIFEST); act(f, "github.merge_pr").reversibility.class_d_chain = { status: "deferred", missing: ["postcondition"] };
    expect(codes(f)).toContain("drift_class_d_chain");
  });

  it("manglende og ekstra handling i forhold til registeret", () => {
    const missing = clone(GITHUB_MANIFEST); missing.actions = missing.actions.filter((a) => a.key !== "github.merge_pr");
    expect(drift(missing).find((d) => d.code === "drift_action_missing_in_manifest")?.message).toContain("github.merge_pr");
    const extra = clone(GITHUB_MANIFEST); const copy = clone(GITHUB_MANIFEST).actions[0]!; copy.key = "github.force_push";
    extra.actions.push(copy);
    expect(codes(extra)).toContain("drift_action_not_in_registry");
  });

  it("endret destruktiv-flagg (undervurdering fanges), skjemaparametre og identitetsfelt", () => {
    const a = clone(GITHUB_MANIFEST); act(a, "github.merge_pr").reversibility.destructive = false;
    expect(codes(a)).toContain("drift_destructive_understated");
    const b = clone(GITHUB_MANIFEST); act(b, "github.create_issue").data.input_required = ["repo"];
    expect(codes(b)).toContain("drift_input_required");
    const c = clone(STRIPE_MANIFEST); act(c, "finance_stripe.get_balance").data.identity_fields = [];
    expect(codes(c)).toContain("drift_identity_fields");
  });

  it("endret credential-referanse (også required/optional), scope-etiketter, helsesjekk, høyeste tidsavbrudd, tillitsklasse, id, navn og eierart", () => {
    const a = clone(STRIPE_MANIFEST); a.secrets.refs[0]!.ref = "JARVIS_STRIPE_OTHER_KEY";
    expect(codes(a)).toContain("drift_secret_refs");
    const b = clone(GITHUB_MANIFEST); b.secrets.refs[1]!.required = true;
    expect(codes(b)).toContain("drift_secret_refs");
    const c = clone(GITHUB_MANIFEST); c.auth.scopes.declared_by_actions = ["repo:read"];
    expect(codes(c)).toContain("drift_declared_scopes");
    const d = clone(CLOUDFLARE_MANIFEST); d.operations.health_check = { method: "presence_only", action_key: null };
    expect(codes(d)).toContain("drift_health_check");
    const e = clone(CLOUDFLARE_MANIFEST); e.operations.timeout = { max_ms: 1 };
    expect(codes(e)).toContain("drift_timeout_max");
    const f = clone(GITHUB_MANIFEST); f.trust.output.class = "internal";
    expect(codes(f)).toContain("drift_trust_class");
    const g = clone(GITHUB_MANIFEST); g.identity.name = "Git Hub";
    expect(codes(g)).toContain("drift_name");
    const h = clone(GITHUB_MANIFEST); h.identity.owner.kind = "jarvis_core";
    expect(codes(h)).toContain("drift_owner_kind");
  });

  it("API-versjon og synk-jobber (når kalleren oppgir dem fra Integrasjonssenteret) må også stemme", () => {
    const facts = { apiFacts: { github: { api_version: "X-GitHub-Api-Version 2022-11-28" }, stripe: { api_version: "API v1 (kontoens standardversjon - koden fester ikke Stripe-Version)" } }, syncJobs: { stripe: ["stripe-payment-sync"] } };
    const ok = buildManifestCatalogue({ definitions, authored: FULL_MANIFESTS, ...facts });
    for (const e of ok.entries) expect(e.drift, e.connector_id).toEqual([]);
    const staleApi = buildManifestCatalogue({ definitions, authored: FULL_MANIFESTS, ...facts, apiFacts: { ...facts.apiFacts, github: { api_version: "X-GitHub-Api-Version 2026-01-01" } } });
    expect(staleApi.entries.find((e) => e.connector_id === "github")!.drift.map((d) => d.code)).toContain("drift_provider_api");
    const newSync = buildManifestCatalogue({ definitions, authored: FULL_MANIFESTS, ...facts, syncJobs: { stripe: ["stripe-payment-sync", "stripe-extra-sync"] } });
    expect(newSync.entries.find((e) => e.connector_id === "stripe")!.drift.map((d) => d.code)).toContain("drift_sync_jobs");
    const noSync = buildManifestCatalogue({ definitions, authored: FULL_MANIFESTS, ...facts, syncJobs: {} });
    expect(noSync.entries.find((e) => e.connector_id === "stripe")!.drift.map((d) => d.code)).toContain("drift_sync_jobs");
  });

  it("når REGISTERET endres (en ny risikoklasse/rate limit i en verktøydefinisjon), blir det fulle manifestet røde - registeret er sannheten", () => {
    const changed = definitions.map((d) => (d.tool_id === "github" && d.action === "create_issue" ? { ...d, rate_limit_per_minute: 99 } : d.tool_id === "cloudflare" && d.action === "purge_cache" ? { ...d, capability_class: "D" as const } : d));
    const cat = buildManifestCatalogue({ definitions: changed, authored: FULL_MANIFESTS });
    const gh = cat.entries.find((e) => e.connector_id === "github")!;
    const cf = cat.entries.find((e) => e.connector_id === "cloudflare")!;
    expect(gh.drift.map((d) => d.code)).toContain("drift_rate_limit");
    expect(cf.drift.map((d) => d.code)).toContain("drift_risk_class");
    expect(cat.entries.find((e) => e.connector_id === "stripe")!.drift).toEqual([]);
  });

  it("review M2: driftmeldinger om et UVALIDERT, typet manifest med hemmelighetsformet handlingsnøkkel/connector-id viser aldri verdien", () => {
    for (const key of secretShapedActionKeys()) {
      const m = clone(GITHUB_MANIFEST);
      m.actions[0]!.key = key;
      m.actions[1]!.key = key.replace(".read", ".other");
      const catalogueMsgs = drift(m);
      expect(catalogueMsgs.some((d) => d.code === "drift_action_not_in_registry")).toBe(true);
      expect(JSON.stringify(catalogueMsgs).includes(key), key.slice(0, 6)).toBe(false);
      // Samme handlingsnøkkel som registeret, men en verdi manifestet «sier» som er en hemmelighetsform: skalarvisningen redigerer også den.
      const g = clone(GITHUB_MANIFEST);
      (g.actions[0]!.authority as unknown as Record<string, unknown>)["risk_class"] = key;
      const out = drift(g);
      expect(out.some((d) => d.code === "drift_risk_class" && d.message.includes("<redacted>"))).toBe(true);
      expect(JSON.stringify(out).includes(key)).toBe(false);
    }
    const ghost = clone(GITHUB_MANIFEST);
    ghost.identity.id = secretShapedConnectorId();
    const idDrift = checkManifestAgainstDerived(ghost, derivedById.get("github")!);
    expect(idDrift.some((d) => d.connector_id === "<redacted>" && d.code === "drift_id")).toBe(true);
    expect(JSON.stringify(idDrift).includes(secretShapedConnectorId())).toBe(false);
  });

  it("en ny handling i registeret uten manifest-rad fanges for en fullt dokumentert connector", () => {
    const extraDef = { ...definitions.find((d) => d.tool_id === "github" && d.action === "get_branch")!, action: "get_tag" };
    const cat = buildManifestCatalogue({ definitions: [...definitions, extraDef], authored: FULL_MANIFESTS });
    expect(cat.entries.find((e) => e.connector_id === "github")!.drift.map((d) => d.code)).toContain("drift_action_missing_in_manifest");
  });
});

describe("review M5: HVER driftkode har en mutasjon (uttømmende tabell mot DRIFT_CODES)", () => {
  const act = (m: ConnectorManifest, key: string) => m.actions.find((a) => a.key === key)!;
  const facts = { apiFacts: { github: { api_version: "X-GitHub-Api-Version 2022-11-28" } }, syncJobs: { github: [] as string[] } };
  const derivedWithFacts = new Map(deriveSkeletonManifests({ definitions, ...facts }).map((m) => [m.identity.id, m]));
  const gh = () => clone(GITHUB_MANIFEST);
  const viaFacts = (m: ConnectorManifest): DriftIssue[] => checkManifestAgainstDerived(m, derivedWithFacts.get("github")!);

  /** Hver rad muterer nøyaktig ett felt i et gyldig referansemanifest og må gi sin kode. */
  const MUTATIONS: Array<[DriftCode, () => DriftIssue[]]> = [
    ["drift_id", () => { const m = gh(); m.identity.id = "ghost"; return checkManifestAgainstDerived(m, derivedById.get("github")!); }],
    ["drift_name", () => { const m = gh(); m.identity.name = "Git Hub"; return drift(m); }],
    ["drift_owner_kind", () => { const m = gh(); m.identity.owner.kind = "jarvis_core"; return drift(m); }],
    ["drift_action_not_in_registry", () => { const m = gh(); const c = clone(GITHUB_MANIFEST).actions[0]!; c.key = "github.force_push"; m.actions.push(c); return drift(m); }],
    ["drift_action_missing_in_manifest", () => { const m = gh(); m.actions = m.actions.filter((a) => a.key !== "github.merge_pr"); return drift(m); }],
    ["drift_kind", () => { const m = gh(); act(m, "github.create_issue").kind = "action"; return drift(m); }],
    ["drift_effect", () => { const m = gh(); act(m, "github.create_issue").effect = "send"; return drift(m); }],
    ["drift_risk_class", () => { const m = gh(); act(m, "github.create_issue").authority.risk_class = "C"; return drift(m); }],
    ["drift_step_up", () => { const m = gh(); act(m, "github.merge_pr").authority.step_up_required = true; return drift(m); }],
    ["drift_owner_only", () => { const m = gh(); act(m, "github.read_issues").authority.owner_only = true; return drift(m); }],
    ["drift_reversible", () => { const m = gh(); act(m, "github.create_issue").reversibility.reversible = false; return drift(m); }],
    ["drift_before_state", () => { const m = gh(); act(m, "github.merge_pr").reversibility.evidence.before_state = false; return drift(m); }],
    ["drift_postcondition", () => { const m = gh(); act(m, "github.merge_pr").reversibility.evidence.postcondition = "none"; return drift(m); }],
    ["drift_class_d_chain", () => { const m = gh(); act(m, "github.merge_pr").reversibility.class_d_chain = { status: "deferred", missing: ["postcondition"] }; return drift(m); }],
    ["drift_destructive_understated", () => { const m = gh(); act(m, "github.merge_pr").reversibility.destructive = false; return drift(m); }],
    ["drift_idempotency_requirement", () => { const m = gh(); act(m, "github.create_issue").idempotency.requirement = "required"; return drift(m); }],
    ["drift_provider_idempotent", () => { const m = gh(); act(m, "github.create_issue").idempotency.provider_idempotent = true; return drift(m); }],
    ["drift_trust", () => { const m = gh(); act(m, "github.read_issues").trust.output = "trusted"; return drift(m); }],
    ["drift_rate_limit", () => { const m = gh(); act(m, "github.get_branch").limits.rate_limit_per_minute = 1; return drift(m); }],
    ["drift_timeout", () => { const m = gh(); act(m, "github.merge_pr").operations.timeout_ms = 1; return drift(m); }],
    ["drift_identity_fields", () => { const m = clone(STRIPE_MANIFEST); act(m, "finance_stripe.get_balance").data.identity_fields = []; return checkManifestAgainstDerived(m, derivedById.get("stripe")!); }],
    ["drift_input_required", () => { const m = gh(); act(m, "github.create_issue").data.input_required = ["repo"]; return drift(m); }],
    ["drift_declared_scopes", () => { const m = gh(); m.auth.scopes.declared_by_actions = ["repo:read"]; return drift(m); }],
    ["drift_secret_refs", () => { const m = gh(); m.secrets.refs[1]!.required = true; return drift(m); }],
    ["drift_provider_api", () => { const m = gh(); m.identity.version.provider_api = "GitHub REST API, X-GitHub-Api-Version 2026-01-01"; return viaFacts(m); }],
    ["drift_sync_jobs", () => { const m = gh(); m.capabilities.sync = { status: "implemented", items: ["github-sync"] }; return viaFacts(m); }],
    ["drift_health_check", () => { const m = gh(); m.operations.health_check = { method: "presence_only", action_key: null }; return drift(m); }],
    ["drift_timeout_max", () => { const m = gh(); m.operations.timeout = { max_ms: 1 }; return drift(m); }],
    ["drift_trust_class", () => { const m = gh(); m.trust.output.class = "internal"; return drift(m); }]
  ];

  it.each(MUTATIONS)("%s", (code, mutate) => {
    expect(mutate().map((d) => d.code), code).toContain(code);
  });

  it("tabellen dekker nøyaktig DRIFT_CODES (en ny driftkode uten mutasjon feiler her), og uten mutasjon er det ingen drift", () => {
    expect([...MUTATIONS.map(([c]) => c)].sort()).toEqual([...DRIFT_CODES].sort());
    expect(new Set(DRIFT_CODES).size).toBe(DRIFT_CODES.length);
    expect(drift(gh())).toEqual([]);
    expect(viaFacts(gh())).toEqual([]);
  });
});

