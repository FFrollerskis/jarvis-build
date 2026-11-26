import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OWNER_PLACEHOLDER, codeownersPattern, renderCodeowners } from "../github-governance/codeowners.mjs";
import { REQUIRED_PROTECTED_PROBES } from "../../../modules/self-modification/src/index.ts";

/** WP-EV0 (K7): CODEOWNERS- og regelsett-UTKAST (ikke aktive; eieren aktiverer) holdes i synk med det signerte manifestet og CI-jobbene. */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DIR = join(ROOT, "ops/security/github-governance");
const manifest = () => JSON.parse(readFileSync(join(ROOT, "config/evolution/constitution.v1.json"), "utf8"));
const draft = () => readFileSync(join(DIR, "CODEOWNERS.draft"), "utf8");
const ruleset = () => JSON.parse(readFileSync(join(DIR, "ruleset-main.draft.json"), "utf8"));

/** Minimal gitignore-/CODEOWNERS-matcher for de mønstertypene generatoren lager (ledende /, avsluttende /, *, ingen **). */
function matches(pattern, path) {
  const anchored = pattern.startsWith("/");
  const body = pattern.replace(/^\//, "");
  const dir = body.endsWith("/");
  const core = dir ? body.slice(0, -1) : body;
  const rx = core.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  const prefix = anchored ? "^" : "(^|.*/)";
  return new RegExp(`${prefix}${rx}${dir ? "/.*$" : "(/.*)?$"}`).test(path);
}
const patternsOf = (text) => text.split("\n").filter((l) => l !== "" && !l.startsWith("#")).map((l) => l.split(/\s+/));

describe("A: CODEOWNERS-utkastet", () => {
  it("A1: den innsjekkede draften er identisk med generatorens utdata (kjør `codeowners.mjs --write` ved avvik)", () => {
    expect(draft()).toBe(renderCodeowners(manifest()));
  });

  it("A2: eneste eier i draften er plassholderen - aldri et ekte brukernavn, e-post eller navn (repoet er offentlig)", () => {
    const lines = patternsOf(draft());
    expect(lines.length).toBeGreaterThan(20);
    for (const [pattern, ...owners] of lines) {
      expect(owners, pattern).toEqual([OWNER_PLACEHOLDER]);
      expect(pattern.startsWith("@")).toBe(false);
    }
    expect(OWNER_PLACEHOLDER).toBe("@PLATFORM-OPERATOR");
    expect(draft()).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it("A3: HVER beskyttede sti i manifestet og HVER påkrevd sonde dekkes av minst ett mønster", () => {
    const patterns = patternsOf(draft()).map(([p]) => p);
    for (const probe of REQUIRED_PROTECTED_PROBES) expect(patterns.some((p) => matches(p, probe)), probe).toBe(true);
    for (const rule of manifest().protected_paths) {
      const sample = rule.kind === "suffix" ? `x/${rule.value}` : rule.kind === "basename" ? `deep/dir/${rule.value}` : rule.kind === "prefix" ? `${rule.value}${rule.value.endsWith("/") ? "x/y.ts" : "rc"}` : rule.value;
      expect(patterns.some((p) => matches(p, sample)), `${rule.kind}:${rule.value}`).toBe(true);
    }
  });

  it("A4: vanlig kode dekkes IKKE (ellers ville enhver PR kreve eier-review)", () => {
    const patterns = patternsOf(draft()).map(([p]) => p);
    for (const path of ["apps/api/src/server.ts", "modules/memory/src/x.ts", "docs/ARCHITECTURE.md", "apps/web/index.html", "modules/tool-gateway/src/live-transports.ts", "ops/evolution/dependency-check.ts"]) {
      expect(patterns.some((p) => matches(p, path)), path).toBe(false);
    }
  });

  it("A5: mønsteroversettelsen: prefiks, eksakt, suffiks og basename; ukjent type kaster", () => {
    expect(codeownersPattern({ kind: "prefix", value: "infra/" })).toBe("/infra/");
    expect(codeownersPattern({ kind: "prefix", value: ".env" })).toBe("/.env*");
    expect(codeownersPattern({ kind: "exact", value: "apps/api/src/step-up.ts" })).toBe("/apps/api/src/step-up.ts");
    expect(codeownersPattern({ kind: "suffix", value: "CLAUDE.md" })).toBe("*CLAUDE.md");
    expect(codeownersPattern({ kind: "basename", value: "package.json" })).toBe("package.json");
    expect(() => codeownersPattern({ kind: "regex", value: "x" })).toThrow();
  });

  it("A6: matcheren selv: forankret katalog, dypt basename, jokertegn og nær-bom", () => {
    expect(matches("/infra/", "infra/local/x.yml")).toBe(true);
    expect(matches("/infra/", "apps/infra/x.yml")).toBe(false);
    expect(matches("package.json", "apps/api/package.json")).toBe(true);
    expect(matches("package.json", "apps/api/package.jsonx")).toBe(false);
    expect(matches("/.env*", ".env.production")).toBe(true);
    expect(matches("/.env*", "apps/.env")).toBe(false);
    expect(matches("*CLAUDE.md", "docs/CLAUDE.md")).toBe(true);
  });
});

describe("B: regelsett-utkastet (ikke aktivt)", () => {
  const rules = () => Object.fromEntries(ruleset().rules.map((r) => [r.type, r]));

  it("B1: utkastet er deaktivert (`disabled`), gjelder standardgrenen og har ingen bypass-aktører (eierbeslutning)", () => {
    const r = ruleset();
    expect(r.enforcement).toBe("disabled");
    expect(r.target).toBe("branch");
    expect(r.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
    expect(r.bypass_actors).toEqual([]);
    expect(r.name).toMatch(/DRAFT/);
  });

  it("B2: ingen sletting og ingen force-push; PR kreves med kodeeier-review og løste tråder", () => {
    const r = rules();
    expect(r.deletion).toBeDefined();
    expect(r.non_fast_forward).toBeDefined();
    expect(r.pull_request.parameters).toMatchObject({ require_code_owner_review: true, required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, required_review_thread_resolution: true });
  });

  it("B3: kun to-forelder merge-commit (merge-protokollen): ingen squash/rebase og ingen lineær historikk", () => {
    const r = rules();
    expect(r.pull_request.parameters.allowed_merge_methods).toEqual(["merge"]);
    expect(r.required_linear_history).toBeUndefined();
  });

  it("B4: de påkrevde CI-jobbene er NØYAKTIG jobbene i ci.yml (ingen mangler, ingen oppdiktede)", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const jobs = [...ci.slice(ci.indexOf("\njobs:")).matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((m) => m[1]).sort();
    const required = rules().required_status_checks.parameters.required_status_checks.map((c) => c.context).sort();
    expect(required).toEqual(jobs);
    expect(rules().required_status_checks.parameters.strict_required_status_checks_policy).toBe(true);
  });

  it("B5: README-en sier ærlig at utkastene er uaktive og uverifiserte, og nevner utelåsing, Actions og merge-protokollen", () => {
    const readme = readFileSync(join(DIR, "README.md"), "utf8");
    for (const word of ["UTKAST", "NOT VERIFIED", "BLOCKED_EXTERNAL", "låse seg ute", "Actions", "to-forelder", "unverified"]) expect(readme, word).toContain(word);
    const forbiddenName = String.fromCharCode(84, 111, 98, 105, 97, 115);
    expect(readme.toLowerCase()).not.toContain(forbiddenName.toLowerCase());
  });
});
