import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectRun, parseArgs, runStatusBlock } from "../project-status-block.ts";
import { renderEvolutionStatusBlock, STATUS_BLOCK_BEGIN, STATUS_BLOCK_END } from "../../../modules/self-modification/src/evolution/status-block.ts";
import { canonicalize, fingerprint } from "../../security/sign-constitution.mjs";

/** WP-EV0 (K6): PROJECT_STATUS-generatoren som skript. Eksempelutskriften er en golden-fil (oppdateres med JARVIS_UPDATE_GOLDEN=1). */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/evolution/project-status-block.ts");
const REPO_MANIFEST = join(ROOT, "config/evolution/constitution.v1.json");
const FIXTURES = join(ROOT, "ops/evolution/fixtures");

const USAGE = {
  month: "2026-12", days_elapsed: 10, days_in_month: 31, spend_ore: { radar: 450, eval: 1000, redteam: 0, shadow: 1500, review: 300 },
  week_start: "2026-12-07", owner_minutes_week: 90, autonomous_changes_week: 6
};
const NOW = "2026-12-10T12:00:00.000Z";

/** Et midlertidig «repo» med manifestet (kopi av det innsjekkede) og eventuelt signatur + offentlig nøkkel fra et NYTT kastbart nøkkelpar. */
function workdir({ signed = false, mutate } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "status-block-"));
  const cfg = join(dir, "config/evolution");
  mkdirSync(cfg, { recursive: true });
  const manifest = JSON.parse(readFileSync(REPO_MANIFEST, "utf8"));
  if (mutate) mutate(manifest);
  writeFileSync(join(cfg, "constitution.v1.json"), JSON.stringify(manifest, null, 2));
  let fp = null;
  if (signed) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    writeFileSync(join(cfg, "constitution.pub.pem"), pem);
    writeFileSync(join(cfg, "constitution.v1.sig"), cryptoSign(null, Buffer.from(canonicalize(manifest), "utf8"), privateKey).toString("base64"));
    fp = fingerprint(pem);
  }
  return { dir, fp, manifest };
}
const run = (dir, args = {}, env = {}) => runStatusBlock({ cwd: dir, now: NOW, ...args }, env);

describe("A: eksempelutskriften (golden) og skjemaet", () => {
  it("A1: eksempel-input gir nøyaktig golden-filen (oppdater med JARVIS_UPDATE_GOLDEN=1)", () => {
    const input = JSON.parse(readFileSync(join(FIXTURES, "status-block.example.input.json"), "utf8"));
    const out = renderEvolutionStatusBlock(input);
    const golden = join(FIXTURES, "status-block.example.md");
    if (process.env.JARVIS_UPDATE_GOLDEN === "1") writeFileSync(golden, out);
    expect(out).toBe(readFileSync(golden, "utf8"));
    expect(out).toContain("| Uavhengig review | 20,00 | ikke målt |"); // en ikke-målt kategori vises ærlig i eksempelet
  });
});

describe("B: manifest og signatur", () => {
  it("B1: usignert manifest vises som UTKAST med feilkode (exit 0, takene er ikke autoritative)", async () => {
    const { dir } = workdir();
    const r = await run(dir);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("UTKAST - IKKE signert/verifisert (constitution_unsigned)");
    expect(r.stdout).toContain("| Totalt Evolution | 100,00 | ikke målt |");
    expect(r.stdout.startsWith(STATUS_BLOCK_BEGIN)).toBe(true);
  });

  it("B2: signert manifest + festet nøkkel (flagg eller miljøvariabel) gir «SIGNERT og verifisert»", async () => {
    const { dir, fp } = workdir({ signed: true });
    expect((await run(dir, { pinned: fp })).stdout).toContain("SIGNERT og verifisert");
    expect((await run(dir, {}, { JARVIS_CONSTITUTION_PUBKEY_SHA256: fp })).stdout).toContain("SIGNERT og verifisert");
  });

  it("B3: signert, men uten festet nøkkel eller med feil nøkkel => UTKAST med riktig kode (en nøkkel i repoet er ikke nok)", async () => {
    const { dir, fp } = workdir({ signed: true });
    expect((await run(dir)).stdout).toContain("(constitution_key_not_pinned)");
    expect((await run(dir, { pinned: fp.replace(/^./, fp[0] === "a" ? "b" : "a") })).stdout).toContain("(constitution_key_mismatch)");
  });

  it("B4: manifest endret etter signering => UTKAST (constitution_signature_invalid)", async () => {
    const { dir, fp } = workdir({ signed: true });
    const p = join(dir, "config/evolution/constitution.v1.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.budget_caps.max_radar_cost_ore_per_month += 1;
    m.budget_caps.max_evolution_cost_ore_per_month += 1;
    writeFileSync(p, JSON.stringify(m));
    expect((await run(dir, { pinned: fp })).stdout).toContain("(constitution_signature_invalid)");
  });

  it("B5: et SVEKKET manifest (signert eller ei) gir aldri tak: exit 2, tom stdout, årsak i stderr", async () => {
    const weaken = (m) => { m.budget_caps.max_evolution_cost_ore_per_month = 100_001; };
    const unsigned = workdir({ mutate: weaken });
    const a = await run(unsigned.dir);
    expect(a).toMatchObject({ exit: 2, stdout: "" });
    expect(a.stderr).toContain("constitution_weakened");
    const signed = workdir({ signed: true, mutate: weaken });
    const b = await run(signed.dir, { pinned: signed.fp });
    expect(b).toMatchObject({ exit: 2, stdout: "" });
    expect(b.stderr).toContain("avvist");
    expect(b.stderr).toContain("constitution_weakened");
  });

  it("B6: ugyldig JSON, manglende manifest og ugyldig --now gir exit 2 (aldri 0)", async () => {
    const { dir } = workdir();
    writeFileSync(join(dir, "config/evolution/constitution.v1.json"), "{ikke json");
    expect((await run(dir)).exit).toBe(2);
    expect((await run(join(dir, "finnes-ikke"))).exit).toBe(2);
    const ok = workdir();
    for (const now of ["i går", "2026-12-10", "2026-13-10T12:00:00Z", ""]) expect((await run(ok.dir, { now })).exit, now).toBe(2);
  });

  it("B7: issued_by (kan være et navn) skrives aldri til utdataene", async () => {
    const { dir } = workdir({ mutate: (m) => { m.issued_by = "Et Personnavn"; } });
    const r = await run(dir);
    expect(r.exit).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("Personnavn");
  });
});

describe("C: forbruksbilde", () => {
  it("C1: --usage gir faktiske tall og run-rate; uten det står alt som «ikke målt»", async () => {
    const { dir } = workdir();
    writeFileSync(join(dir, "usage.json"), JSON.stringify(USAGE));
    const r = await run(dir, { usage: "usage.json" });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("| Radar | 20,00 | 4,50 | 22,5 % | 13,95 | innenfor |");
    expect(r.stdout).toContain("| Totalt Evolution | 100,00 | 32,50 |");
    expect((await run(dir)).stdout).toContain("Faktisk forbruk er IKKE målt");
  });

  it("C2: ugyldig eller uleselig forbruksbilde gir exit 2 med årsak (aldri en stille «ikke målt»)", async () => {
    const { dir } = workdir();
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...USAGE, spend_ore: { ...USAGE.spend_ore, radar: -1 } }));
    writeFileSync(join(dir, "junk.json"), "{nei");
    const bad = await run(dir, { usage: "bad.json" });
    expect(bad.exit).toBe(2);
    expect(bad.stderr).toContain("ugyldig forbruksbilde");
    expect((await run(dir, { usage: "junk.json" })).exit).toBe(2);
    expect((await run(dir, { usage: "finnes-ikke.json" })).exit).toBe(2);
  });
});

describe("D: --write og --check mot et dokument med markørblokk", () => {
  const doc = (inner = "gammelt innhold") => `# STATUS\n\nfør\n\n${STATUS_BLOCK_BEGIN}\n${inner}\n${STATUS_BLOCK_END}\n\netter\n`;

  it("D1: --write erstatter KUN blokken, og --check er deretter grønn; endres taket i manifestet er --check rød (exit 1)", async () => {
    const { dir } = workdir();
    writeFileSync(join(dir, "STATUS.md"), doc());
    const w = await run(dir, { write: "STATUS.md" });
    expect(w.exit).toBe(0);
    const after = readFileSync(join(dir, "STATUS.md"), "utf8");
    expect(after.startsWith("# STATUS\n\nfør\n\n")).toBe(true);
    expect(after.endsWith("\n\netter\n")).toBe(true);
    expect(after).not.toContain("gammelt innhold");
    expect(after).toContain("| Totalt Evolution |");
    expect((await run(dir, { check: "STATUS.md" })).exit).toBe(0);
    const p = join(dir, "config/evolution/constitution.v1.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.budget_caps.max_review_cost_ore_per_month -= 1;
    writeFileSync(p, JSON.stringify(m));
    const stale = await run(dir, { check: "STATUS.md" });
    expect(stale.exit).toBe(1);
    expect(stale.stdout).toContain("status_block_caps_stale");
  });

  it("D2: --write uten markører endrer ingenting og gir exit 2; --check uten blokk gir exit 1 (status_block_missing)", async () => {
    const { dir } = workdir();
    const plain = "# STATUS\n\ningen markører\n";
    writeFileSync(join(dir, "PLAIN.md"), plain);
    const w = await run(dir, { write: "PLAIN.md" });
    expect(w.exit).toBe(2);
    expect(readFileSync(join(dir, "PLAIN.md"), "utf8")).toBe(plain);
    const c = await run(dir, { check: "PLAIN.md" });
    expect(c.exit).toBe(1);
    expect(c.stdout).toContain("status_block_missing");
    expect((await run(dir, { check: "finnes-ikke.md" })).exit).toBe(2);
    expect((await run(dir, { write: "finnes-ikke.md" })).exit).toBe(2);
  });

  it("D3: --check og --write samtidig er en bruksfeil (exit 2)", async () => {
    const { dir } = workdir();
    writeFileSync(join(dir, "S.md"), doc());
    expect((await run(dir, { check: "S.md", write: "S.md" })).exit).toBe(2);
  });

  it("D4: repoets egen docs/PROJECT_STATUS.md: har den en markørblokk, MÅ den stemme med manifestet (ellers er visningen foreldet)", async () => {
    const md = readFileSync(join(ROOT, "docs/PROJECT_STATUS.md"), "utf8");
    if (!md.includes(STATUS_BLOCK_BEGIN)) return; // blokken settes inn av docs-agenten; vakten blir levende når den finnes
    const r = await runStatusBlock({ check: "docs/PROJECT_STATUS.md", now: NOW }, {});
    expect(r.stdout, r.stdout).toContain("stemmer med manifestet");
    expect(r.exit).toBe(0);
  });
});

describe("E: argumenter og prosess", () => {
  it("E1: parseArgs avviser ukjente flagg og flagg uten verdi", () => {
    expect(parseArgs(["--ukjent", "x"])).toContain("ukjent flagg");
    expect(parseArgs(["--now"])).toContain("mangler verdi");
    expect(parseArgs(["--now", "--check", "x"])).toContain("mangler verdi");
    expect(parseArgs(["--now", NOW, "--check", "a.md"])).toEqual({ now: NOW, check: "a.md" });
    expect(parseArgs([])).toEqual({});
  });

  const node = (...args) => spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, JARVIS_CONSTITUTION_PUBKEY_SHA256: "" } });

  it("E2: som prosess mot repoets manifest: exit 0 og blokken på stdout (UTKAST fordi manifestet ikke er signert)", () => {
    const r = node("--now", NOW);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("### Evolution: planlagt forbruk");
    expect(r.stdout).toContain("UTKAST");
    expect(r.stderr).toBe("");
  });

  it("E3: som prosess: ukjent flagg og ugyldig manifest gir exit 2 og ingenting på stdout", () => {
    const bad = node("--ukjent", "x");
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    const { dir } = workdir({ mutate: (m) => { m.budget_caps.max_evolution_cost_ore_per_month = 999_999; } });
    const weak = node("--cwd", dir, "--now", NOW);
    expect(weak.status).toBe(2);
    expect(weak.stdout).toBe("");
  });

  it("E4: kjøring via symlink gjør fortsatt jobben (isDirectRun følger symlinker)", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-link-"));
    const link = join(dir, "psb.ts");
    symlinkSync(SCRIPT, link);
    const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", link, "--now", NOW], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("### Evolution");
    expect(isDirectRun(undefined, import.meta.url)).toBe(false);
    expect(isDirectRun(join(dir, "finnes-ikke"), import.meta.url)).toBe(false);
  });

  it("E5: skriptet kan bare VERIFISERE: ingen nøkkelgenerering, signering, privatnøkkel-import eller nøkkelfiler (.key)", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/createPrivateKey|generateKeyPair|createSign\b|PRIVATE KEY|\.key["'`]/);
    expect(src).not.toMatch(/import\s*\{[^}]*\bsign\b[^}]*\}\s*from\s*"node:crypto"/);
  });
});
