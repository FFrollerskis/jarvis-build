import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTOR_REGISTRY, type ConnectorDefinition } from "@jarvis/tool-gateway";
import {
  FULL_MANIFESTS, GUARD_RULES, SKELETON_BASELINE, auditManifestCatalogue, buildManifestCatalogue, decisionLogHasRow, productionConnectorDefinitions, runManifestGuard, unregisteredManifestFiles,
  type ConnectorManifest, type GuardRule, type GuardViolation
} from "../src/index.ts";
import { evidenceFileExists } from "../scripts/report.ts";
import { fakeSecretShapes, secretShapedActionKeys, secretShapedConnectorId } from "./fixtures.ts";

/**
 * WP-I (D-472): CI-VAKTEN for connector-manifester. Den første describe-blokken ER porten: den feiler i CI når en connector i registeret mangler manifest, et fullt manifest mangler runbook/teststi,
 * et manifest refererer en hemmelighets VERDI, en skrivekapabel connector mangler idempotensinfo, eller et håndskrevet manifest driver fra registeret. Resten er mutasjonstester som beviser at hver regel biter.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** CI-portens `fileExists` (samme implementasjon som `scripts/report.ts`): stien er en vanlig, ikke-tom fil (review LOW: vakten selv leser aldri innholdet, så en tom plassholderfil var nok som runbook-/testbevis). */
const fileExists = evidenceFileExists(ROOT);
/** Beslutningsloggen er en markdown-tabell: `| D-109 | ...`. Vakten får den injisert, som filsystemet. */
const decisionLog = readFileSync(join(ROOT, "docs/DECISIONS_AND_ASSUMPTIONS.md"), "utf8");
const decisionExists = (id: string) => decisionLogHasRow(decisionLog, id);
const definitions = productionConnectorDefinitions();
const clone = (m: ConnectorManifest): ConnectorManifest => structuredClone(m);
/**
 * Mutasjonstestene kjører ofte vakten med BARE ÉN av de tre fulle manifestene. Standardbaselinen (`pendingBaseline`) er da ALLE de bygde registeroppføringene som ikke har et håndskrevet manifest i `authored` (de to fulle som
 * ikke er med regnes som «ikke skrevet ennå»), så skeleton-baselinen ikke feller dem for noe annet enn det testen undersøker - og så en urelatert WP som legger til en bygd registeroppføring ikke gjør hver mutasjonstest rød
 * (review N6: det var 11 røde tester; nå er det bare de to PORTEN-testene, som er selve porten). PORTEN bruker den COMMITTEDE baselinen eksplisitt (`baseline: SKELETON_BASELINE`). En test overstyrer med `baseline`.
 */
const pendingBaseline = (authored: readonly unknown[]): string[] => {
  const authoredIds = new Set(authored.map((m) => (m as { identity?: { id?: string } }).identity?.id));
  return CONNECTOR_REGISTRY.filter((c) => c.category !== "backlog" && c.category !== "backlog_d64_gate" && !authoredIds.has(c.id)).map((c) => c.id);
};
const guard = (authored: readonly unknown[], over: { definitions?: typeof definitions; exists?: (p: string) => boolean; registry?: readonly ConnectorDefinition[]; baseline?: readonly string[]; decisions?: (id: string) => boolean } = {}) => {
  const baseline = over.baseline ?? pendingBaseline(authored);
  return runManifestGuard({
    definitions: over.definitions ?? definitions, authored, fileExists: over.exists ?? fileExists, decisionExists: over.decisions ?? decisionExists, skeleton_baseline: baseline,
    ...(over.registry !== undefined ? { registry: over.registry } : {})
  });
};
const newBuiltEntry = (id = "brand_new_vendor"): ConnectorDefinition => ({ id, display_name: "Brand New Vendor", category: "tool_gateway", credential_refs: ["JARVIS_BRAND_NEW_TOKEN"] });
const rulesOf = (vs: readonly GuardViolation[]): GuardRule[] => [...new Set(vs.map((v) => v.rule))].sort();

describe("PORTEN: hvert connector-manifest i repoet holder reglene (feiler CI ved brudd)", () => {
  const report = guard(FULL_MANIFESTS, { baseline: SKELETON_BASELINE });

  it("ingen brudd: hver registeroppføring har et manifest med eier, tillitsklasse og risikoklasse per handling; fulle manifester har runbook og testbevis som finnes; ingen hemmelighetsverdi; ingen drift", () => {
    expect(report.violations.map((v) => `${v.rule} ${v.connector_id ?? "-"} ${v.path}: ${v.message}`)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("dekningen er ærlig: alle registeroppføringer er med, tre har fullt manifest, resten et avledet skeleton med ukjent-markører som arbeidsliste", () => {
    expect(report.coverage.registry_total).toBe(CONNECTOR_REGISTRY.length);
    expect(report.coverage.full).toEqual(["github", "cloudflare", "stripe"]);
    expect(report.coverage.skeleton).toBe(CONNECTOR_REGISTRY.length - 3);
    expect(report.coverage.built + report.coverage.backlog + report.coverage.model_provider).toBe(CONNECTOR_REGISTRY.length);
    // Arbeidslisten gjelder bare skeletons: en connector med fullt manifest har ingen ukjent-markører å lukke og står ikke i den.
    const fullIds = new Set(FULL_MANIFESTS.map((m) => m.identity.id));
    for (const c of CONNECTOR_REGISTRY) {
      const n = report.coverage.unknown_fields_by_connector[c.id];
      if (fullIds.has(c.id)) expect(n, c.id).toBeUndefined();
      else expect(n, c.id).toBeGreaterThan(0);
    }
    expect(Object.keys(report.coverage.unknown_fields_by_connector).length).toBe(CONNECTOR_REGISTRY.length - FULL_MANIFESTS.length);
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

  it("CI-portens fileExists er streng: kun en vanlig fil med synlig innhold er bevis - ikke en tom fil, en fil med ett linjeskift/bare blanke tegn, en katalog, en symlenke eller en sti som ikke finnes (review N7)", () => {
    expect(fileExists("docs/runbooks/WPI_CONNECTOR_SDK.md")).toBe(true);
    expect(fileExists("modules/connector-sdk/test/no-such.test.ts")).toBe(false);
    expect(fileExists("modules/connector-sdk")).toBe(false); // en katalog er ikke et runbook-/testbevis
    // Alt under lages i en egen midlertidig katalog (ikke i repoet) og ryddes etterpå.
    const dir = mkdtempSync(join(tmpdir(), "wpi-evidence-"));
    const sub = join(dir, "docs");
    mkdirSync(sub);
    try {
      const put = (name: string, content: string): void => writeFileSync(join(sub, name), content);
      put("RUNBOOK_EMPTY.md", "");
      put("RUNBOOK_FILLED.md", "# Runbook\n");
      put("RUNBOOK_NEWLINE.md", "\n");
      put("RUNBOOK_WHITESPACE.md", "  \t\r\n \n\n   ");
      const cp = (...points: number[]): string => String.fromCodePoint(...points); // usynlige tegn bygges av kodepunkt (aldri som rå tegn eller \u-escapes i kilden)
      put("RUNBOOK_BOM_NEWLINE.md", `${cp(0xfeff)}\n`);
      put("RUNBOOK_ZEROWIDTH.md", `${cp(0x200b, 0x200b)}\n${cp(0x2060)}`);
      put("RUNBOOK_ONE_CHAR.md", "x");
      symlinkSync(join(sub, "RUNBOOK_FILLED.md"), join(sub, "RUNBOOK_LINK.md")); // peker til en gyldig, fylt fil - er likevel ikke bevis
      symlinkSync(sub, join(sub, "LINK_TO_DIR"));
      symlinkSync(join(dir, "finnes-ikke.md"), join(sub, "RUNBOOK_DANGLING.md"));
      const check = evidenceFileExists(dir);
      expect(check("docs/RUNBOOK_FILLED.md")).toBe(true);
      expect(check("docs/RUNBOOK_ONE_CHAR.md")).toBe(true);
      for (const bad of ["RUNBOOK_EMPTY.md", "RUNBOOK_NEWLINE.md", "RUNBOOK_WHITESPACE.md", "RUNBOOK_BOM_NEWLINE.md", "RUNBOOK_ZEROWIDTH.md", "RUNBOOK_LINK.md", "LINK_TO_DIR", "RUNBOOK_DANGLING.md", "finnes_ikke.md"]) expect(check(`docs/${bad}`), bad).toBe(false);
      expect(check("docs")).toBe(false);
      // Og vakten feller et fullt manifest hvis runbooken er en tom plassholder, en fil med bare et linjeskift eller en symlenke:
      for (const placeholder of ["RUNBOOK_EMPTY.md", "RUNBOOK_NEWLINE.md", "RUNBOOK_LINK.md"]) {
        const m = clone(FULL_MANIFESTS.find((x) => x.identity.id === "stripe")!);
        m.operations.runbook = { path: `docs/${placeholder}` };
        const withBad = guard(FULL_MANIFESTS.map((x) => (x.identity.id === "stripe" ? m : x)), { exists: (p) => (p === `docs/${placeholder}` ? check(p) : fileExists(p)) });
        expect(withBad.violations.some((v) => v.rule === "runbook_file_missing" && v.connector_id === "stripe"), placeholder).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vaktens regelliste er låst (en ny regel krever en bevisst endring her)", () => {
    expect([...GUARD_RULES]).toEqual([
      "registry_connector_without_manifest", "manifest_invalid", "missing_owner", "missing_trust_class", "action_without_risk_class", "authored_manifest_not_full",
      "runbook_not_declared", "runbook_file_missing", "test_evidence_without_path", "test_file_missing", "secret_value_in_manifest", "write_capable_without_idempotency",
      "manifest_drift", "orphan_manifest", "duplicate_manifest", "built_connector_unreviewed", "skeleton_baseline_stale", "decision_ref_missing"
    ]);
  });

  it("skeleton-baselinen er nøyaktig de BYGDE registeroppføringene som ikke har fullt manifest (ingen duplikater, ingen døde oppføringer)", () => {
    const full = new Set(FULL_MANIFESTS.map((m) => m.identity.id));
    const built = CONNECTOR_REGISTRY.filter((c) => c.category !== "backlog" && c.category !== "backlog_d64_gate");
    const expected = built.filter((c) => !full.has(c.id)).map((c) => c.id).sort();
    expect([...SKELETON_BASELINE].sort()).toEqual(expected);
    expect(new Set(SKELETON_BASELINE).size).toBe(SKELETON_BASELINE.length);
    // Review N6: ikke-vakuøsitet måles mot REGISTERET (som bare vokser), ikke mot baselinen - den kan og skal legitimt krympe (helt til 0) når connectorer får fullt manifest.
    expect(built.length).toBeGreaterThan(40);
    expect(SKELETON_BASELINE.length).toBe(built.length - [...full].filter((id) => built.some((c) => c.id === id)).length);
  });

  it("review N6: decisionLogHasRow er den ene beslutningsraden-sjekken (CI-porten og rapporten bruker den): en RAD som starter med `| D-n |`, eksakt id, og aldri en id med mønsterstegn", () => {
    const log = "| D-5 | x |\n| D-50 | y |\ntekst | D-77 | midt i en linje\n  | D-12 | innrykket\n";
    expect(decisionLogHasRow(log, "D-5")).toBe(true);
    expect(decisionLogHasRow(log, "D-50")).toBe(true);
    expect(decisionLogHasRow(log, "D-500")).toBe(false); // D-5-raden dekker ikke D-500, og D-50 ikke D-5000
    expect(decisionLogHasRow(log, "D-77")).toBe(false); // ikke først på linjen
    expect(decisionLogHasRow(log, "D-12")).toBe(false); // innrykket er ikke en tabellrad
    for (const bad of ["D-.*", ".*", "D-5|D-50", "D-5\n", "d-5", "D-", "", "D-12345", "^\\| D-5 \\|"]) expect(decisionLogHasRow(log, bad), JSON.stringify(bad)).toBe(false);
    expect(decisionLogHasRow(decisionLog, "D-109")).toBe(true);
    expect(decisionLogHasRow(decisionLog, "D-9999")).toBe(false);
  });
});

describe("mutasjonstester: hver regel biter", () => {
  it("registeroppføring uten manifest", () => {
    const catalogue = buildManifestCatalogue({ definitions, authored: FULL_MANIFESTS });
    catalogue.entries = catalogue.entries.filter((e) => e.connector_id !== "slack");
    const v = auditManifestCatalogue({ catalogue, registry: CONNECTOR_REGISTRY, authored: FULL_MANIFESTS, fileExists, decisionExists });
    expect(v.find((x) => x.rule === "registry_connector_without_manifest")?.connector_id).toBe("slack");
  });

  it("review M5: en NY bygd registeroppføring uten fullt manifest og uten baseline-oppføring feller vakten (reviewens repro ga før ok=true fordi skeletonet avledes automatisk)", () => {
    const registry = [...CONNECTOR_REGISTRY, newBuiltEntry()];
    const r = guard(FULL_MANIFESTS, { registry });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => `${v.rule}:${v.connector_id}`)).toEqual(["built_connector_unreviewed:brand_new_vendor"]);
    expect(r.violations[0]!.message).toContain("SKELETON_BASELINE");
    // Bevisst oppføring i baselinen gjør den grønn igjen (en synlig handling i PR-en - en KONVENSJON, vakten hindrer ikke at listen vokser, jf. guard.ts), og skeletonet er fortsatt validert.
    expect(guard(FULL_MANIFESTS, { registry, baseline: [...pendingBaseline(FULL_MANIFESTS), "brand_new_vendor"] }).violations).toEqual([]);
    // Backlog (ikke bygget) trenger ingen oppføring; i det øyeblikket kategorien endres til bygd, kreves en.
    expect(guard(FULL_MANIFESTS, { registry: [...CONNECTOR_REGISTRY, { ...newBuiltEntry("future_vendor"), category: "backlog" }] }).violations).toEqual([]);
    const flipped = guard(FULL_MANIFESTS, { registry: [...CONNECTOR_REGISTRY.filter((c) => c.id !== "apple_music"), ...CONNECTOR_REGISTRY.filter((c) => c.id === "apple_music").map((c) => ({ ...c, category: "tool_gateway" as const }))] });
    expect(flipped.violations.map((v) => `${v.rule}:${v.connector_id}`)).toEqual(["built_connector_unreviewed:apple_music"]);
  });

  it("review M5: baselinen kan bare krympe - en id som ikke finnes, en backlog-oppføring eller en connector som nå har fullt manifest feller vakten", () => {
    const ghost = guard(FULL_MANIFESTS, { baseline: [...pendingBaseline(FULL_MANIFESTS), "no_such_connector"] });
    expect(ghost.violations.map((v) => `${v.rule}:${v.connector_id}`)).toEqual(["skeleton_baseline_stale:no_such_connector"]);
    const backlog = CONNECTOR_REGISTRY.find((c) => c.category === "backlog")!;
    expect(guard(FULL_MANIFESTS, { baseline: [...pendingBaseline(FULL_MANIFESTS), backlog.id] }).violations.map((v) => `${v.rule}:${v.connector_id}`)).toEqual([`skeleton_baseline_stale:${backlog.id}`]);
    const full = guard(FULL_MANIFESTS, { baseline: [...pendingBaseline(FULL_MANIFESTS), "github"] });
    expect(full.violations.map((v) => `${v.rule}:${v.connector_id}`)).toEqual(["skeleton_baseline_stale:github"]);
    expect(full.violations[0]!.message).toContain("skal bare krympe");
  });

  it("review M3: en decision_ref som ikke finnes i beslutningsloggen feller vakten (og de ekte referansene finnes)", () => {
    for (const m of FULL_MANIFESTS) for (const ref of m.core_boundary.decision_refs ?? []) expect(decisionExists(ref), `${m.identity.id}: ${ref}`).toBe(true);
    const m = clone(FULL_MANIFESTS[2]!);
    m.core_boundary.decision_refs = ["D-109", "D-9999"];
    const v = guard([FULL_MANIFESTS[0]!, FULL_MANIFESTS[1]!, m]).violations;
    expect(v.map((x) => `${x.rule}:${x.connector_id}`)).toEqual(["decision_ref_missing:stripe"]);
    expect(v[0]!.message).toContain("D-9999");
    expect(guard(FULL_MANIFESTS, { decisions: () => false }).violations.map((x) => x.rule)).toEqual(["decision_ref_missing", "decision_ref_missing", "decision_ref_missing", "decision_ref_missing"]);
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

  it("review M5: runbook ikke deklarert i et fullt manifest gir NØYAKTIG runbook_not_declared (regelen var uoppnåelig - kun manifest_invalid fyrte)", () => {
    const m = clone(FULL_MANIFESTS[0]!);
    m.operations.runbook = { unknown: true, reason: "mangler" };
    const v = guard([m]).violations;
    expect(v.map((x) => `${x.rule} ${x.path}`)).toEqual(["runbook_not_declared operations.runbook"]);
    expect(v[0]!.connector_id).toBe("github");
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

  it("review N5: bruddet sier HVILKEN funn-type som slo til (skannerfunn), aldri teksten - også for en falsk positiv på vanlig prosa", () => {
    const asText = clone(FULL_MANIFESTS[0]!);
    asText.limits.quotas = `bruk ${fakeSecretShapes.githubToken()} her`;
    const v = guard([asText]).violations.filter((x) => x.rule === "secret_value_in_manifest");
    expect(v.map((x) => x.message)).toEqual(["manifestet inneholder noe som ikke er en hvelvreferanse (en verdi?) - kun referanser er lov (skannerfunn: github_token)"]);
    const prose = clone(FULL_MANIFESTS[0]!);
    prose.limits.quotas = "credential: bundet til eieren";
    const p = guard([prose]).violations.filter((x) => x.rule === "secret_value_in_manifest");
    expect(p.length).toBe(1);
    expect(p[0]!.message).toContain("skannerfunn: named_secret");
    expect(JSON.stringify(p).includes("bundet til eieren")).toBe(false);
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
