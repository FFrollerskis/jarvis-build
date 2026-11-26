import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HARD_CEILINGS, canonicalize, fingerprint, summarize, validateForSigning } from "../sign-constitution.mjs";
import { BUDGET_HARD_CEILINGS, buildConstitution, canonicalizeManifest } from "../../../modules/self-modification/src/index.ts";

/**
 * WP-EV0 (K7): signeringsverktøyet nekter å signere et UTKAST eller et manifest kjøretiden ville avvise (tak/koherens), og kan skrive ut en lesbar oversikt
 * over det eieren signerer. Verktøyet er avhengighetsfritt (kjøres offline); koden speiles derfor, og paritet mot kjøretiden er testet differensielt.
 */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/security/sign-constitution.mjs");
const repoManifest = () => JSON.parse(readFileSync(join(ROOT, "config/evolution/constitution.v1.json"), "utf8"));
/** Et manifest klart til signering: draft-markørene er fjernet (det eieren selv gjør). */
const ready = (mutate) => {
  const m = repoManifest();
  m.issued_by = "platform-operator";
  delete m.notes;
  if (mutate) mutate(m);
  return m;
};
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
const tmp = (manifest) => {
  const dir = mkdtempSync(join(tmpdir(), "sign-const-"));
  const path = join(dir, "m.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return { dir, path, sig: join(dir, "m.sig") };
};

describe("A: paritet mot kjøretiden", () => {
  it("A1: de harde takene i verktøyet er identiske med BUDGET_HARD_CEILINGS i koden (nøkler og verdier)", () => {
    expect(HARD_CEILINGS).toEqual({ ...BUDGET_HARD_CEILINGS });
  });

  it("A2: kanoniseringen er identisk med modulens (det som signeres er det kjøretiden verifiserer)", () => {
    const m = repoManifest();
    expect(canonicalize(m)).toBe(canonicalizeManifest(m));
  });

  it("A3: differensial: for over 400 mutasjoner av tak/versjon/skjemaversjon er «klar til signering» (ingen funn) ekvivalent med at buildConstitution godtar manifestet", () => {
    const keys = Object.keys(repoManifest().budget_caps);
    const values = (key) => [0, 1, Math.max(0, HARD_CEILINGS[key] - 1), HARD_CEILINGS[key], HARD_CEILINGS[key] + 1, -1, 1.5, "7", null];
    let n = 0;
    let agreedOk = 0;
    let agreedBad = 0;
    for (const key of keys) {
      for (const v of values(key)) {
        for (const other of [null, "max_deploys_per_day", "max_evolution_cost_ore_per_month", "owner_time_budget_minutes_per_week"]) {
          const m = ready((x) => { x.budget_caps[key] = v; if (other !== null && other !== key) x.budget_caps[other] = Math.min(HARD_CEILINGS[other], 0); });
          let runtimeOk = true;
          try { buildConstitution(m); } catch { runtimeOk = false; }
          const toolOk = validateForSigning(m).length === 0;
          expect(toolOk, `${key}=${JSON.stringify(v)} other=${other}`).toBe(runtimeOk);
          if (runtimeOk) agreedOk++; else agreedBad++;
          n++;
        }
      }
    }
    for (const patch of [{ version: 0 }, { version: 1.5 }, { version: "2" }, { schema_version: 1 }, { schema_version: 3 }, { issued_by: "" }, { constitution_id: "" }, { extra: 1 }]) {
      const m = { ...ready(), ...patch };
      let runtimeOk = true;
      try { buildConstitution(m); } catch { runtimeOk = false; }
      expect(validateForSigning(m).length === 0, JSON.stringify(patch)).toBe(runtimeOk);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(150);
    expect(agreedOk).toBeGreaterThan(0);
    expect(agreedBad).toBeGreaterThan(0);
  });
});

describe("B: validateForSigning - funn som hindrer signering", () => {
  it("B1: det innsjekkede UTKASTET har KUN draft-funnene (issued_by UNSIGNED-DRAFT og UTKAST-merknaden) - ellers er det teknisk klart", () => {
    expect(validateForSigning(repoManifest()).sort()).toEqual(["draft_marker_in_issued_by", "draft_marker_in_notes"]);
  });

  it("B2: fjernes draft-markørene er det ingen funn; en egen merknad uten UTKAST er tillatt", () => {
    expect(validateForSigning(ready())).toEqual([]);
    expect(validateForSigning(ready((m) => { m.notes = "Eierens egne vurderinger."; }))).toEqual([]);
    expect(validateForSigning(ready((m) => { m.notes = "utkast - ikke endelig"; }))).toEqual(["draft_marker_in_notes"]);
    expect(validateForSigning(ready((m) => { m.issued_by = "unsigned-draft-x"; }))).toEqual(["draft_marker_in_issued_by"]);
  });

  it("B3: tak over det harde taket, koherensbrudd og ugyldige verdier gir navngitte funn", () => {
    expect(validateForSigning(ready((m) => { m.budget_caps.max_evolution_cost_ore_per_month = 100_001; }))).toContain("budget_above_ceiling:max_evolution_cost_ore_per_month");
    expect(validateForSigning(ready((m) => { m.budget_caps.max_radar_cost_ore_per_month = 9_000; }))).toContain("budget_categories_exceed_total");
    expect(validateForSigning(ready((m) => { m.budget_caps.max_deploys_per_hour = 4; m.budget_caps.max_deploys_per_day = 3; }))).toContain("deploys_per_hour_above_per_day");
    expect(validateForSigning(ready((m) => { m.budget_caps.max_owner_minutes_per_autonomous_change = 241; }))).toContain("owner_change_minutes_above_weekly_budget");
    expect(validateForSigning(ready((m) => { delete m.budget_caps.max_review_cost_ore_per_month; }))).toContain("budget_cap_invalid:max_review_cost_ore_per_month");
    expect(validateForSigning(ready((m) => { m.budget_caps.max_review_cost_ore_per_month = -1; }))).toContain("budget_cap_invalid:max_review_cost_ore_per_month");
    expect(validateForSigning(ready((m) => { m.budget_caps.ukjent = 1; }))).toContain("budget_cap_unknown:ukjent");
    expect(validateForSigning(ready((m) => { m.schema_version = 1; }))).toContain("schema_version_must_be_2");
    expect(validateForSigning(ready((m) => { m.version = 0; }))).toContain("version_must_be_positive_integer");
    expect(validateForSigning(null)).toEqual(["manifest_not_an_object"]);
    expect(validateForSigning({ ...ready(), budget_caps: null })).toContain("budget_caps_missing");
  });
});

describe("C: kommandoene", () => {
  it("C1: sign nekter et UTKAST (exit 2), skriver ingen signatur og forklarer hva eieren må gjøre", () => {
    const { dir, path, sig } = tmp(repoManifest());
    const key = join(dir, "k.key");
    const pub = join(dir, "k.pub.pem");
    expect(cli("keygen", key, pub).status).toBe(0);
    const r = cli("sign", key, path, sig);
    expect(r.status).toBe(2);
    expect(existsSync(sig)).toBe(false);
    expect(r.stderr).toContain("draft_marker_in_issued_by");
    expect(r.stderr).toContain("draft_marker_in_notes");
  });

  it("C2: sign nekter et manifest over de harde takene (exit 2, ingen signatur)", () => {
    const { dir, path, sig } = tmp(ready((m) => { m.budget_caps.max_deploys_per_day = 11; }));
    const key = join(dir, "k.key");
    cli("keygen", key, join(dir, "k.pub.pem"));
    const r = cli("sign", key, path, sig);
    expect(r.status).toBe(2);
    expect(existsSync(sig)).toBe(false);
    expect(r.stderr).toContain("budget_above_ceiling:max_deploys_per_day");
  });

  it("C3: et klart manifest signeres, og signaturen verifiseres av verktøyets egen verify og av kjøretidens verifyConstitution", async () => {
    const { dir, path, sig } = tmp(ready());
    const key = join(dir, "k.key");
    const pub = join(dir, "k.pub.pem");
    cli("keygen", key, pub);
    expect(cli("sign", key, path, sig).status).toBe(0);
    expect(cli("verify", pub, path, sig).status).toBe(0);
    const { verifyConstitution } = await import("../../../modules/self-modification/src/index.ts");
    const c = verifyConstitution({
      manifestJson: readFileSync(path, "utf8"), signatureB64: readFileSync(sig, "utf8"), publicKeyPem: readFileSync(pub, "utf8"), pinnedPublicKeySha256: fingerprint(readFileSync(pub, "utf8"))
    });
    expect(c.version).toBe(2);
  });

  it("C4: check gir exit 1 med funn for UTKASTET og exit 0 «klart» for et ferdig manifest", () => {
    const draft = tmp(repoManifest());
    const bad = cli("check", draft.path);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("draft_marker_in_issued_by");
    const ok = cli("check", tmp(ready()).path);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("klart for signering");
  });

  it("C5: summary skriver en lesbar oversikt i kr/timer med harde tak og SHA-256 av det kanoniske manifestet", () => {
    const r = cli("summary", join(ROOT, "config/evolution/constitution.v1.json"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("versjon 2");
    expect(r.stdout).toContain("totalt 100,00 kr (hardt tak 1000,00 kr)");
    expect(r.stdout).toContain("radar 20,00 · evaluering 30,00 · red team 15,00 · shadow/canary 15,00 · review 20,00 (sum 100,00)");
    expect(r.stdout).toContain("4,0 t/uke (240 min; hardt tak 600 min)");
    expect(r.stdout).toContain("15 min pr. autonom endring (hardt tak 60)");
    expect(r.stdout).toContain("deploys 3/døgn (tak 10) og 1/time (tak 3)");
    expect(r.stdout).toContain(`SHA-256 av kanonisk manifest: ${summarize(repoManifest()).digest}`);
    expect(r.stdout).toContain("Blokkerende funn før signering");
    expect(r.stdout).toContain("draft_marker_in_issued_by");
  });

  it("C6: summarize gir samme digest som kjøretidens Constitution.digest (det eieren ser er det som havner i endringsregisteret)", () => {
    const m = repoManifest();
    expect(summarize(m).digest).toBe(buildConstitution(m).digest);
  });

  it("C7: ukjent kommando og manglende filer gir exit 2 (aldri 0); keygen nekter fortsatt å overskrive", () => {
    expect(cli("ukjent").status).toBe(2);
    expect(cli("sign").status).toBe(2);
    expect(cli("check", "/finnes/ikke.json").status).toBe(2);
    expect(cli("summary", "/finnes/ikke.json").status).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), "sign-keygen-"));
    const key = join(dir, "k.key");
    const pub = join(dir, "k.pub.pem");
    expect(cli("keygen", key, pub).status).toBe(0);
    expect(cli("keygen", key, pub).status).toBe(2);
  });

  it("C8: verktøyet inneholder ingen personnavn/kontaktinfo (repoet er offentlig) - kun rolle-/rollebetegnelser", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const forbiddenName = String.fromCharCode(84, 111, 98, 105, 97, 115); // bygd ved kjøring: selve testen skal heller ikke bære navnet
    expect(src.toLowerCase()).not.toContain(forbiddenName.toLowerCase());
    expect(src).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
  });
});
