import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * EV-0 (D-410): Jarvis kan ALDRI holde, lese, rotere eller eksportere eierens offline-nøkkel (plan kap. 5/6, E3 `read_break_glass_key`).
 * Statiske vakter: ingen tjeneste får en privatnøkkel-variabel, ingen kildefil signerer eller genererer nøkler, ingen privatnøkkel-literal,
 * og privatnøkler er git-ignorert. (Disse beviser fravær i REPOET - ikke at en operatør aldri limer en nøkkel inn i NAS-.env.)
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", ".next"].includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const sourceFiles = ["apps", "modules", "packages"].flatMap((d) => walk(join(ROOT, d))).filter(
  (p) => /\.(ts|mjs|js|sh)$/.test(p) && !/[\\/](test|tests|scripts)[\\/]/.test(p) && !/\.test\./.test(p)
);

describe("break-glass: Jarvis holder aldri eierens nøkkel", () => {
  it("service-env gir ingen tjeneste en privatnøkkel/recovery-nøkkel-variabel", () => {
    const env = readFileSync(join(ROOT, "infra/local/service-env.mjs"), "utf8");
    expect(env).not.toMatch(/BREAK_GLASS|RECOVERY_KEY|CONSTITUTION_(PRIVATE|SIGNING|SECRET)|SIGNING_KEY/i);
  });

  it("ingen kildefil (utenom tester/scripts) inneholder en privatnøkkel-literal", () => {
    const offenders = sourceFiles.filter((p) => /-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(readFileSync(p, "utf8")));
    expect(offenders.map((p) => relative(ROOT, p))).toEqual([]);
  });

  it("selvendrings-modulen kan bare VERIFISERE: ingen signering, nøkkelgenerering eller privatnøkkel-import", () => {
    const dir = join(ROOT, "modules/self-modification/src");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/createPrivateKey|generateKeyPair|createSign\b|\bsign\s*as\b|import\s*\{[^}]*\bsign\b[^}]*\}\s*from\s*"node:crypto"/);
    }
  });

  it("ingen kildefil i api/worker/voice leser nøkkelfiler (.key) eller constitution-privatnøkkel fra disk", () => {
    const offenders = sourceFiles
      .filter((p) => /apps[\\/]/.test(p))
      .filter((p) => /readFile(Sync)?\([^)]*\.key["'`]|constitution[^"'`\n]*\.key/i.test(readFileSync(p, "utf8")));
    expect(offenders.map((p) => relative(ROOT, p))).toEqual([]);
  });

  it(".gitignore ignorerer privatnøkler (*.key, *private*.pem), men ikke den offentlige nøkkelen", () => {
    const gi = readFileSync(join(ROOT, ".gitignore"), "utf8");
    expect(gi).toMatch(/^\*\.key$/m);
    expect(gi).toMatch(/^\*private\*\.pem$/m);
    expect(gi).not.toMatch(/^\*\.pem$/m);
  });

  it("break-glass-skriptet leser ingen nøkler og skriver ingen .env-verdier ut", () => {
    const sh = readFileSync(join(ROOT, "ops/break-glass/freeze-jarvis.sh"), "utf8");
    expect(sh).not.toMatch(/\.key\b|PRIVATE KEY|source "?\$ENV_FILE|\. "?\$ENV_FILE/);
    expect(sh).toMatch(/--yes/);
  });
});
