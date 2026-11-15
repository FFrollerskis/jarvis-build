import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTOR_REGISTRY } from "@jarvis/tool-gateway";
import {
  FULL_MANIFESTS, GUARD_RULES, auditManifestCatalogue, buildManifestCatalogue, productionConnectorDefinitions, runManifestGuard, unregisteredManifestFiles,
  type ConnectorManifest, type GuardRule, type GuardViolation
} from "../src/index.ts";
import { fakeSecretShapes, secretShapedActionKeys, secretShapedConnectorId } from "./fixtures.ts";

/**
 * WP-I (D-472): CI-VAKTEN for connector-manifester. Den første describe-blokken ER porten: den feiler i CI når en connector i registeret mangler manifest, et fullt manifest mangler runbook/teststi,
 * et manifest refererer en hemmelighets VERDI, en skrivekapabel connector mangler idempotensinfo, eller et håndskrevet manifest driver fra registeret. Resten er mutasjonstester som beviser at hver regel biter.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fileExists = (p: string) => existsSync(join(ROOT, p));
const definitions = productionConnectorDefinitions();
const clone = (m: ConnectorManifest): ConnectorManifest => structuredClone(m);
const guard = (authored: readonly unknown[], over: { definitions?: typeof definitions; exists?: (p: string) => boolean } = {}) =>
  runManifestGuard({ definitions: over.definitions ?? definitions, authored, fileExists: over.exists ?? fileExists });
const rulesOf = (vs: readonly GuardViolation[]): GuardRule[] => [...new Set(vs.map((v) => v.rule))].sort();

describe("PORTEN: hvert connector-manifest i repoet holder reglene (feiler CI ved brudd)", () => {
  const report = guard(FULL_MANIFESTS);

  it("ingen brudd: hver registeroppføring har et manifest med eier, tillitsklasse og risikoklasse per handling; fulle manifester har runbook og testbevis som finnes; ingen hemmelighetsverdi; ingen drift", () => {
    expect(report.violations.map((v) => `${v.rule} ${v.connector_id ?? "-"} ${v.path}: ${v.message}`)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("dekningen er ærlig: alle registeroppføringer er med, tre har fullt manifest, resten et avledet skeleton med ukjent-markører som arbeidsliste", () => {
    expect(report.coverage.registry_total).toBe(CONNECTOR_REGISTRY.length);
    expect(report.coverage.full).toEqual(["github", "cloudflare", "stripe"]);
    expect(report.coverage.skeleton).toBe(CONNECTOR_REGISTRY.length - 3);
    expect(report.coverage.built + report.coverage.backlog + report.coverage.model_provider).toBe(CONNECTOR_REGISTRY.length);
    for (const c of CONNECTOR_REGISTRY) {
      const n = report.coverage.unknown_fields_by_connector[c.id];
      expect(n, c.id).toBeGreaterThan(0);
    }
  });

  it("hvert fullt manifest har en runbook som finnes, og hver teststi det oppgir finnes", () => {
    for (const m of FULL_MANIFESTS) {
      const rb = m.operations.runbook;
      expect("unknown" in rb ? "" : rb.path).toMatch(/^docs\/runbooks\/.+\.md$/);
      expect(fileExists("unknown" in rb ? "" : rb.path), m.identity.id).toBe(true);
      for (const t of Object.values(m.tests)) if (!("unknown" in t)) for (const p of t.paths) expect(fileExists(p), `${m.identity.id}: ${p}`).toBe(true);
    }
  });

  it("alle manifestfiler i src/manifests er registrert i FULL_MANIFESTS (en glemt registrering feiler her)", () => {
    const files = readdirSync(join(ROOT, "modules/connector-sdk/src/manifests"));
    expect(unregisteredManifestFiles(files, FULL_MANIFESTS.map((m) => m.identity.id))).toEqual([]);
    expect(unregisteredManifestFiles(["github.ts", "index.ts", "forgotten_connector.ts", "notes.md"], ["github"])).toEqual(["forgotten_connector"]);
  });

  it("vaktens regelliste er låst (en ny regel krever en bevisst endring her)", () => {
    expect([...GUARD_RULES]).toEqual([
      "registry_connector_without_manifest", "manifest_invalid", "missing_owner", "missing_trust_class", "action_without_risk_class", "authored_manifest_not_full",
      "runbook_not_declared", "runbook_file_missing", "test_evidence_without_path", "test_file_missing", "secret_value_in_manifest", "write_capable_without_idempotency",
      "manifest_drift", "orphan_manifest", "duplicate_manifest"
    ]);
  });
});

describe("mutasjonstester: hver regel biter", () => {
  it("registeroppføring uten manifest", () => {
    const catalogue = buildManifestCatalogue({ definitions, authored: FULL_MANIFESTS });
    catalogue.entries = catalogue.entries.filter((e) => e.connector_id !== "slack");
    const v = auditManifestCatalogue({ catalogue, registry: CONNECTOR_REGISTRY, authored: FULL_MANIFESTS, fileExists });
    expect(v.find((x) => x.rule === "registry_connector_without_manifest")?.connector_id).toBe("slack");
  });

  it("manglende eier, tillitsklasse og risikoklasse gir egne, navngitte brudd (og ugyldig manifest)", () => {
    const owner = clone(FULL_MANIFESTS[0]!) as unknown as Record<string, Record<string, unknown>>;
    delete owner["identity"]!["owner"];
    expect(rulesOf(guard([owner]).violations)).toEqual(expect.arrayContaining(["missing_owner", "manifest_invalid"]));
    const trust = clone(FULL_MANIFESTS[0]!) as unknown as { trust: { output: Record<string, unknown> } };
    delete trust.trust.output["class"];
    expect(rulesOf(guard([trust]).violations)).toContain("missing_trust_class");
    const risk = clone(FULL_MANIFESTS[0]!);
    delete (risk.actions[3]!.authority as unknown as Record<string, unknown>)["risk_class"];
    const v = guard([risk]).violations;
    expect(v.find((x) => x.rule === "action_without_risk_class")?.path).toBe("actions[3].authority.risk_class");
  });

  it("håndskrevet manifest som ikke er «full»", () => {
    const sk = clone(FULL_MANIFESTS[0]!);
    sk.completeness = "skeleton";
    expect(rulesOf(guard([sk]).violations)).toContain("authored_manifest_not_full");
  });

  it("fullt manifest: runbook mangler som fil, teststi mangler som fil, «present» uten sti", () => {
    const missingRunbook = clone(FULL_MANIFESTS[0]!);
    missingRunbook.operations.runbook = { path: "docs/runbooks/DOES_NOT_EXIST.md" };
    const a = guard([missingRunbook]).violations.find((v) => v.rule === "runbook_file_missing");
    expect(a?.message).toContain("DOES_NOT_EXIST.md");
    const missingTest = clone(FULL_MANIFESTS[0]!);
    missingTest.tests.contract = { status: "present", paths: ["modules/connector-sdk/test/no-such.test.ts"] };
    expect(rulesOf(guard([missingTest]).violations)).toContain("test_file_missing");
    const noPath = clone(FULL_MANIFESTS[0]!);
    noPath.tests.authority = { status: "present", paths: [] };
    expect(rulesOf(guard([noPath]).violations)).toContain("test_evidence_without_path");
    // runbook-sjekken er filsystem-injisert: samme manifest passerer når stien «finnes».
    expect(guard([FULL_MANIFESTS[0]!], { exists: () => true }).violations).toEqual([]);
    expect(rulesOf(guard([FULL_MANIFESTS[0]!], { exists: () => false }).violations)).toEqual(expect.arrayContaining(["runbook_file_missing", "test_file_missing"]));
  });

  it("runbook ikke deklarert i et fullt manifest", () => {
    const m = clone(FULL_MANIFESTS[0]!);
    m.operations.runbook = { unknown: true, reason: "mangler" };
    const rules = rulesOf(guard([m]).violations);
    expect(rules).toEqual(expect.arrayContaining(["manifest_invalid"]));
  });

  it("hemmelighetsVERDI i manifestet (som referanse og i fritekst) fanges, uten at verdien gjentas i bruddet", () => {
    for (const make of Object.values(fakeSecretShapes)) {
      const value = make();
      const asRef = clone(FULL_MANIFESTS[0]!);
      asRef.secrets.refs[0]!.ref = value;
      const v1 = guard([asRef]).violations;
      expect(rulesOf(v1)).toContain("secret_value_in_manifest");
      const asText = clone(FULL_MANIFESTS[0]!);
      asText.limits.quotas = `bruk ${value}`;
      const v2 = guard([asText]).violations;
      expect(rulesOf(v2)).toContain("secret_value_in_manifest");
      expect(JSON.stringify([v1, v2]).includes(value)).toBe(false);
    }
  });

  it("skrivekapabel connector uten idempotensinfo feiler (dedupe-nøkkel og per-handling-krav)", () => {
    const noKey = clone(FULL_MANIFESTS[0]!);
    noKey.idempotency.dedupe_key = "none";
    expect(rulesOf(guard([noKey]).violations)).toContain("write_capable_without_idempotency");
    const noReq = clone(FULL_MANIFESTS[0]!);
    noReq.actions.find((a) => a.key === "github.create_issue")!.idempotency.requirement = "none";
    expect(rulesOf(guard([noReq]).violations)).toContain("write_capable_without_idempotency");
    const weakD = clone(FULL_MANIFESTS[1]!);
    weakD.actions.find((a) => a.key === "cloudflare.update_dns_record")!.idempotency.requirement = "recommended";
    expect(rulesOf(guard([weakD]).violations)).toContain("write_capable_without_idempotency");
  });

  it("drift mot registeret, foreldreløst og dobbelt manifest", () => {
    const drifted = clone(FULL_MANIFESTS[0]!);
    drifted.actions.find((a) => a.key === "github.merge_pr")!.limits.rate_limit_per_minute = 1;
    expect(guard([drifted]).violations.some((v) => v.rule === "manifest_drift" && v.message.startsWith("drift_rate_limit"))).toBe(true);
    // En risikoendring som også gjør manifestet ugyldig meldes som ugyldig (vakten reviderer aldri et manifest den ikke kan lese).
    const reclassified = clone(FULL_MANIFESTS[0]!);
    reclassified.actions.find((a) => a.key === "github.merge_pr")!.authority.risk_class = "C";
    expect(rulesOf(guard([reclassified]).violations)).toContain("manifest_invalid");
    const ghost = clone(FULL_MANIFESTS[0]!);
    ghost.identity.id = "ghost_connector";
    expect(rulesOf(guard([...FULL_MANIFESTS, ghost]).violations)).toContain("orphan_manifest");
    expect(rulesOf(guard([...FULL_MANIFESTS, clone(FULL_MANIFESTS[2]!)]).violations)).toContain("duplicate_manifest");
  });

  it("en NY handling i en verktøydefinisjon uten manifest-rad feiler vakten for en connector med fullt manifest", () => {
    const extra = { ...definitions.find((d) => d.tool_id === "cloudflare" && d.action === "check_token")!, action: "list_pagerules" };
    const v = guard(FULL_MANIFESTS, { definitions: [...definitions, extra] }).violations;
    expect(v.some((x) => x.rule === "manifest_drift" && x.connector_id === "cloudflare" && x.message.startsWith("drift_action_missing_in_manifest"))).toBe(true);
  });

  it("review M2: en hemmelighetsformet handlingsnøkkel (duplikat, kind/effekt-mismatch) eller connector-id ekkoes aldri i vaktens utdata", () => {
    for (const key of secretShapedActionKeys()) {
      const dup = clone(FULL_MANIFESTS[0]!);
      dup.actions[0]!.key = key;
      dup.actions.push(structuredClone(dup.actions[0]!));
      const kind = clone(FULL_MANIFESTS[0]!);
      kind.actions[0]!.key = key;
      kind.actions[0]!.kind = "write";
      for (const m of [dup, kind]) {
        const r = guard([m]);
        expect(r.ok).toBe(false);
        expect(rulesOf(r.violations)).toEqual(expect.arrayContaining(["secret_value_in_manifest"]));
        expect(JSON.stringify(r).includes(key), key.slice(0, 6)).toBe(false);
      }
    }
    const id = secretShapedConnectorId();
    const bad = clone(FULL_MANIFESTS[0]!);
    bad.identity.id = id;
    const r = guard([bad]);
    expect(JSON.stringify(r).includes(id)).toBe(false);
    expect(r.violations.some((v) => v.connector_id === "<redacted>")).toBe(true);
  });

  it("vakten er rent funksjonell: samme inndata gir samme rapport", () => {
    expect(JSON.stringify(guard(FULL_MANIFESTS))).toBe(JSON.stringify(guard(FULL_MANIFESTS)));
  });
});
