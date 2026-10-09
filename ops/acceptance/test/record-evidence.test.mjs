import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTIONS, redact } from "../record-evidence.mjs";

/**
 * WP-J (D-450): evidens-opptakeren. Testene beviser mekanikken (ingen skall, hemmeligheter redigeres bort, filer overskrives aldri, feil er også evidens) -
 * ikke at en ekte kjøring på NAS-en er riktig. Falske hemmeligheter bygges ved kjøring (ikke som bokstaver i filen), så gitleaks ikke flagger testen.
 */
const SCRIPT = resolve(fileURLToPath(new URL("../record-evidence.mjs", import.meta.url)));
const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "evidence-"));
  dirs.push(d);
  return d;
}
function run(args, opts = {}) {
  return spawnSync(process.execPath, [opts.script ?? SCRIPT, ...args], { encoding: "utf8", input: opts.input, timeout: 60_000, env: { ...process.env, ...(opts.env ?? {}) } });
}
/** Et eget git-repo for testen (arbeidstreet her kan være en worktree med gitdir utenfor, og git nekter «dubious ownership» på tvers av brukere). */
function tempRepo() {
  const dir = tmp();
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(dir, "f"), "x");
  git("add", "f");
  git("commit", "-q", "-m", "init");
  return { dir, sha: git("rev-parse", "HEAD").stdout.trim() };
}
function written(dir) {
  const files = readdirSync(dir);
  return files.length === 1 ? { name: files[0], text: readFileSync(join(dir, files[0]), "utf8") } : { name: "", text: "", files };
}
const fake = {
  ghp: () => ["gh", "p_"].join("") + "A1b2C3d4".repeat(5),
  pat: () => ["github", "_pat_"].join("") + "A1b2C3d4_".repeat(4),
  anthropic: () => ["sk", "-ant-"].join("") + "abcDEF123_".repeat(4),
  aws: () => ["AK", "IA"].join("") + "ABCDEFGHIJKLMNOP",
  slack: () => ["xo", "xb-"].join("") + "1234567890-abcdefghij",
  jwt: () => ["ey", "Jhbgcioij9"].join("") + "." + ["ey", "Jzdwiioixmjm0"].join("") + "." + "c2lnbmF0dXJl",
  pem: () => ["-----BEGIN ", "PRIVATE KEY-----"].join("") + "\nMIIEvQIBADANBgkq\nabc\n" + ["-----END ", "PRIVATE KEY-----"].join(""),
  age: () => ["AGE-SECRET", "-KEY-1"].join("") + "QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ"
};

describe("redact()", () => {
  it("fjerner hver kjente hemmelighetsform og teller dem", () => {
    const samples = {
      github_token: fake.ghp(),
      github_pat: fake.pat(),
      anthropic_key: fake.anthropic(),
      aws_access_key: fake.aws(),
      slack_token: fake.slack(),
      jwt: fake.jwt(),
      pem_block: fake.pem(),
      age_secret: fake.age()
    };
    for (const [name, secret] of Object.entries(samples)) {
      const { text, counts } = redact(`før ${secret} etter`);
      expect(text, name).not.toContain(secret);
      expect(text, name).toContain("«REDIGERT»");
      expect(counts[name], name).toBe(1);
    }
  });

  it("redigerer Bearer, URL-credentials og nøkkel=verdi men lar vanlig tekst være", () => {
    const secret = "S3cr3t-" + "x".repeat(20);
    const { text } = redact(`Authorization: Bearer ${secret}\nDB=postgres://jarvis:${secret}@db:5432/jarvis\nJARVIS_API_TOKEN=${secret}\nPASSWORD: ${secret}\nstatus: ok, 12 tjenester, ingenting hemmelig`);
    expect(text).not.toContain(secret);
    expect(text).toContain("postgres://«REDIGERT»@db:5432/jarvis");
    expect(text).toContain("status: ok, 12 tjenester, ingenting hemmelig");
  });

  it("er lineær på fiendtlig input (ingen katastrofal backtracking)", () => {
    const hostile = ["-----BEGIN PRIVATE KEY-----".repeat(7000), "Bearer " + "a".repeat(190_000), "eyJ" + "a".repeat(50_000), "postgres://" + "a".repeat(50_000), "TOKEN=" + "b".repeat(100_000)];
    for (const input of hostile) {
      const t0 = Date.now();
      redact(input);
      expect(Date.now() - t0, input.slice(0, 20)).toBeLessThan(2000);
    }
    expect(REDACTIONS.length).toBeGreaterThan(10);
  });
});

describe("record-evidence.mjs", () => {
  it("kjører en kommando uten skall, skriver filen og gir exit 0", () => {
    const out = tmp();
    const repo = tempRepo();
    const r = run(["t-ok", "--out-dir", out, "--note", "prøvekjøring", "--", process.execPath, "-e", "console.log(process.argv.slice(1).join('|'))", "a;b", "$(whoami)", "`id`"], { env: { JARVIS_EVIDENCE_REPO: repo.dir } });
    expect(r.status, r.stderr).toBe(0);
    const f = written(out);
    expect(f.name).toMatch(/^\d{4}-\d{2}-\d{2}-t-ok\.md$/);
    expect(f.text).toContain("a;b|$(whoami)|`id`"); // bokstavelig – ingen skall tolket noe
    expect(f.text).toContain("- **Exit:** 0");
    expect(f.text).toContain("- **Merknad:** prøvekjøring");
    expect(repo.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(f.text).toContain(`- **Git:** \`${repo.sha}\``);
    expect(f.text).toContain("## Vurdering");
    expect(f.text).toContain("ingen treff");
  });

  it("en feilet kommando er også evidens: filen skrives og exit er 1", () => {
    const out = tmp();
    const r = run(["t-fail", "--out-dir", out, "--", process.execPath, "-e", "console.error('brøt sammen'); process.exit(7)"]);
    expect(r.status).toBe(1);
    const f = written(out);
    expect(f.text).toContain("- **Exit:** 7");
    expect(f.text).toContain("brøt sammen");
  });

  it("en kommando som ikke finnes gir exit 1 og en lesbar årsak, ikke en krasj", () => {
    const out = tmp();
    const r = run(["t-missing", "--out-dir", out, "--", "/finnes/ikke/dette"]);
    expect(r.status).toBe(1);
    expect(written(out).text).toContain("kunne ikke starte kommandoen: ENOENT");
  });

  it("redigerer hemmeligheter i utdataene og varsler om det", () => {
    const out = tmp();
    const secret = fake.ghp();
    const r = run(["t-secret", "--out-dir", out, "--", process.execPath, "-e", `console.log(${JSON.stringify("token er " + secret)})`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ADVARSEL");
    const f = written(out);
    expect(f.text).not.toContain(secret);
    expect(f.text).toContain("github_token×2"); // én i kommandolinjen, én i utdataene
    expect(f.text).toContain("token er «REDIGERT»");
  });

  it("redigerer også hemmeligheter som står i selve kommandolinjen", () => {
    const out = tmp();
    const secret = fake.anthropic();
    const r = run(["t-argv", "--out-dir", out, "--", process.execPath, "-e", "console.log('ok')", `Authorization: Bearer ${secret}`]);
    expect(r.status).toBe(0);
    const f = written(out);
    expect(f.text).not.toContain(secret);
    expect(f.text).toContain("«REDIGERT»");
    expect(r.stdout).toContain("ADVARSEL");
  });

  it("dreper en kommando som overskrider tidsavbruddet og sier det", () => {
    const out = tmp();
    const r = run(["t-timeout", "--out-dir", out, "--timeout-s", "1", "--", process.execPath, "-e", "setTimeout(()=>{}, 60000)"]);
    expect(r.status).toBe(1);
    expect(written(out).text).toMatch(/tidsavbrudd/);
  });

  it("avkorter svært lange utdata og sier det", () => {
    const out = tmp();
    const r = run(["t-big", "--out-dir", out, "--", process.execPath, "-e", "process.stdout.write('x'.repeat(500000))"]);
    expect(r.status).toBe(0);
    const f = written(out);
    expect(f.text).toContain("utdata avkortet ved 200 kB");
    expect(f.text.length).toBeLessThan(260_000);
  });

  it("overskriver aldri en eksisterende evidensfil (exit 3)", () => {
    const out = tmp();
    expect(run(["t-dup", "--out-dir", out, "--", process.execPath, "-e", "console.log(1)"]).status).toBe(0);
    const first = written(out);
    const r = run(["t-dup", "--out-dir", out, "--", process.execPath, "-e", "console.log(2)"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("overskrives aldri");
    expect(readFileSync(join(out, first.name), "utf8")).toBe(first.text);
  });

  it("--stdin leser utdata fra en annen kommando", () => {
    const out = tmp();
    const r = run(["t-stdin", "--out-dir", out, "--stdin"], { input: "PASS=10 WARN=2\n" });
    expect(r.status).toBe(0);
    const f = written(out);
    expect(f.text).toContain("(lest fra stdin)");
    expect(f.text).toContain("PASS=10 WARN=2");
  });

  it("avviser ugyldig bruk med exit 2 og skriver ingenting", () => {
    const out = tmp();
    for (const args of [
      [],
      ["../unnslipp", "--out-dir", out, "--", "true"],
      ["ok-id", "--out-dir", out],
      ["ok-id", "--out-dir", out, "--ukjent", "--", "true"],
      ["ok-id", "--out-dir", out, "--timeout-s", "0", "--", "true"],
      ["ok-id", "--out-dir", out, "--stdin", "--", "true"]
    ]) {
      const r = run(args);
      expect(r.status, JSON.stringify(args)).toBe(2);
    }
    expect(readdirSync(out)).toEqual([]);
  });

  it("virker også når den startes via en symlink (ikke stille ingenting)", () => {
    const out = tmp();
    const link = join(tmp(), "rec.mjs");
    symlinkSync(SCRIPT, link);
    const r = run(["t-link", "--out-dir", out, "--", process.execPath, "-e", "console.log('via lenke')"], { script: link });
    expect(r.status, r.stderr).toBe(0);
    expect(written(out).text).toContain("via lenke");
  });

  it("evidensmappen er docs/evidence som standard og finnes i repoet med README", () => {
    const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    expect(existsSync(join(root, "docs/evidence/README.md"))).toBe(true);
    writeFileSync(join(tmp(), "x"), "");
  });
});
