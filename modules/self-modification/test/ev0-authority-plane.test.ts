import { spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  BUDGET_HARD_CEILINGS, E3_ACTION_ENFORCEMENT_PATHS, FORBIDDEN_PATH_PATTERNS, HttpSelfModificationGithubClient, INVALID_PATH_KEY, PROTECTED_DIRECTORY_NAMES, PROTECTED_DIRECTORY_ROOTS,
  REQUIRED_E3_ACTIONS, REQUIRED_PROTECTED_DIRECTORY_PROBES, REQUIRED_PROTECTED_PROBES, ConstitutionError, buildConstitution, canonicalizeManifest, classifyRawDiff, classifySelfModification,
  isInvalidPathKey, isValidMinVersion, parseRawDiffZ, protectionKey, publicKeyFingerprint, verifyConstitution, type ConstitutionManifest
} from "../src/index.ts";

/**
 * WP-EV0 fix1 (A-F1, A-F2, L3, I5, L1): Authority Plane-dekning FØR første signering. Katalogen SELV og rename-kilden er E3 (ikke E2), resten av Authority Plane (kontrakter, risikoklasser,
 * autonomi, oppstartsverifisereren, budsjett-/personvernvakter, vakthunden) og gate-/forsyningskjede-konfig er E3, stier med format-/kontrolltegn er ugyldige (E3), manifestet er dypfryst og
 * `minVersion` kan aldri stille ignoreres. Ren logikk, unntatt en ekte-git-prøve (symlink-bytte) i en midlertidig katalog.
 */
const ROOT = new URL("../../../", import.meta.url);
const manifest = (): ConstitutionManifest => JSON.parse(readFileSync(new URL("config/evolution/constitution.v1.json", ROOT), "utf8")) as ConstitutionManifest;
const constitution = buildConstitution(manifest());
const msg = (fn: () => unknown): string => {
  try { fn(); } catch (err) { return (err as Error).message; }
  return "no_error";
};
const asE3 = (paths: string[], label: string): void => {
  expect(classifySelfModification(paths), `legacy ${label}`).toBe("forbidden");
  expect(constitution.classify(paths), `E ${label}`).toBe("E3");
};
const asE2 = (path: string): void => {
  expect(classifySelfModification([path]), `legacy ${path}`).toBe("requires_approval");
  expect(constitution.classify([path]), `E ${path}`).toBe("E2");
};
/** Skrivemåter som ikke skal kunne slippe unna: store bokstaver, `./`, `\`, `//`, etterfølgende punktum/mellomrom, `/./`, fullbredde skråstrek. */
const variants = (p: string): string[] => [
  p, p.toUpperCase(), `./${p}`, p.replace(/\//g, "\\"), p.replace(/\//g, "//"), `${p}.`, `${p} `, p.replace("/", "/./"), p.replace(/\//g, String.fromCodePoint(0xff0f))
];

describe("A: katalogen SELV er E3 (A-F1) - i begge lag, for HVER beskyttet katalog", () => {
  const FORMS = (dir: string): string[] => [dir, `${dir}/`, `${dir}/zz.ts`, `${dir}/test/zz.test.ts`, `${dir}/a/b/c.json`, `${dir}/package.json`];

  it("A1: hver rot-forankret katalog: katalogen selv, med skråstrek, fil, testfil, dypt tre og package.json er forbudt (legacy) og E3 (konstitusjon) - i alle skrivemåter", () => {
    expect(PROTECTED_DIRECTORY_ROOTS.length).toBeGreaterThanOrEqual(16);
    for (const dir of PROTECTED_DIRECTORY_ROOTS) {
      for (const form of FORMS(dir)) {
        for (const v of variants(form)) asE3([v], JSON.stringify(v));
      }
    }
  });

  it("A2: hver katalog som er beskyttet på ALLE nivåer (.git, .claude, .husky): i roten og nestet", () => {
    expect([...PROTECTED_DIRECTORY_NAMES].sort()).toEqual([".claude", ".git", ".husky"]);
    for (const name of PROTECTED_DIRECTORY_NAMES) {
      for (const base of ["", "apps/web/", "a/b/c/"]) {
        for (const form of FORMS(`${base}${name}`)) asE3([form], JSON.stringify(form));
      }
    }
  });

  it("A3: nære bom er IKKE E3 (mønstrene er forankret: `modules/policy-x`, `infra-old`, `.gitx`, `.github-x` og søsken er vanlig kode = E2)", () => {
    for (const dir of PROTECTED_DIRECTORY_ROOTS) {
      // rot-forankret: et søsken med samme prefiks og den samme katalogen under en annen forelder er vanlig kode
      for (const near of [`${dir}-x/src/a.ts`, `${dir}x`, `${dir}_old/a.ts`, `x/${dir}/a.ts`]) asE2(near);
    }
    for (const near of [".gitx/a", ".github-x/a", ".claudex/a", ".huskyx/a", "apps/.gitx/a", "infra-old/a.ts", "xinfra/a.ts"]) asE2(near);
  });

  it("A4: hver katalog har en sonde (og omvendt): en katalog kan ikke fjernes fra mønstrene uten at en sonde feiler, og en sonde kan ikke stå uten katalog", () => {
    expect([...REQUIRED_PROTECTED_DIRECTORY_PROBES].sort()).toEqual([...PROTECTED_DIRECTORY_ROOTS, ...PROTECTED_DIRECTORY_NAMES].sort());
    for (const probe of REQUIRED_PROTECTED_DIRECTORY_PROBES) {
      const key = protectionKey(probe);
      expect(FORBIDDEN_PATH_PATTERNS.some((rx) => rx.test(key)), `mønstre alene: ${probe}`).toBe(true);
    }
  });

  it("A5: katalogsondene dekkes av det SIGNERTE manifestet: dekker ingen regel selve katalogen (men fortsatt filene under), avvises manifestet med den katalogen i feilen", () => {
    expect(() => buildConstitution(manifest())).not.toThrow();
    for (const dir of REQUIRED_PROTECTED_DIRECTORY_PROBES) {
      const m = manifest();
      const covering = m.protected_paths.filter((r) => r.kind === "prefix" && protectionKey(r.value).replace(/\/$/, "") === protectionKey(dir));
      expect(covering.length, dir).toBeGreaterThan(0);
      // fjern katalogregelen og dekk i stedet hver FIL-sonde under katalogen med en eksakt regel: da er det kun katalogen selv som er udekket
      const below = REQUIRED_PROTECTED_PROBES.filter((p) => protectionKey(p).startsWith(`${protectionKey(dir)}/`));
      m.protected_paths = [...m.protected_paths.filter((r) => !covering.includes(r)), ...below.map((value) => ({ kind: "exact" as const, value }))];
      expect(msg(() => buildConstitution(m)), dir).toBe(`constitution_weakened:unprotected:${dir}`);
    }
  });

  it("A6: manifest-reglene `prefix` med skråstrek dekker katalogen selv, men ikke et søsken med samme prefiks (`modules/policy-x`)", () => {
    const only: ConstitutionManifest = { ...manifest(), protected_paths: [...REQUIRED_PROTECTED_PROBES, ...REQUIRED_PROTECTED_DIRECTORY_PROBES].map((value) => ({ kind: "exact" as const, value })) };
    const m = buildConstitution({ ...only, protected_paths: [...only.protected_paths, { kind: "prefix", value: "modules/hemmelig/" }] });
    // `modules/hemmelig` er IKKE i de hardkodede mønstrene: kun manifest-regelen kan gjøre den til E3
    expect(m.classify(["modules/hemmelig"])).toBe("E3");
    expect(m.classify(["modules/hemmelig/src/x.ts"])).toBe("E3");
    expect(m.classify(["modules/hemmelig-x/src/x.ts"])).toBe("E2");
    expect(m.classify(["modules/hemmeligx"])).toBe("E2");
    // uten avsluttende skråstrek er prefikset et rent strengprefiks (uendret): `modules/hem` treffer `modules/hemmelig`, men katalog-selv-regelen gjelder ikke
    const raw = buildConstitution({ ...only, protected_paths: [...only.protected_paths, { kind: "prefix", value: "modules/hem" }] });
    expect(raw.classify(["modules/hemmelig-x/a.ts"])).toBe("E3");
  });
});

describe("A-rename: kilden til en omdøping er en endret sti (GitHub `previous_filename`)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const jsonResponse = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const changed = async (pages: unknown[][]): Promise<string[]> => {
    let page = 0;
    vi.stubGlobal("fetch", async () => jsonResponse(pages[page++] ?? []));
    return new HttpSelfModificationGithubClient("tok").getPullRequestChangedFiles("o/r", "1");
  };

  it("R1: filename + previous_filename er begge med (kilde først etter navn), vanlige filer uendret, og tomt/manglende previous_filename gir kun filename", async () => {
    const files = await changed([[
      { filename: "modules/policy-x/src/gateway.ts", previous_filename: "modules/policy/src/gateway.ts", status: "renamed" },
      { filename: "docs/a.md", status: "modified" },
      { filename: "docs/b.md", previous_filename: "", status: "added" },
      { filename: "docs/c.md", previous_filename: 5 as unknown as string, status: "added" }
    ]]);
    expect(files).toEqual(["modules/policy-x/src/gateway.ts", "modules/policy/src/gateway.ts", "docs/a.md", "docs/b.md", "docs/c.md"]);
  });

  it("R2: en ren omdøping ut av en beskyttet katalog er E3 (uten kilden ville den vært E2); med symlinken på toppen er den E3 uansett", async () => {
    const renameOnly = await changed([[{ filename: "modules/policy-x/src/gateway.ts", previous_filename: "modules/policy/src/gateway.ts", status: "renamed" }]]);
    asE3(renameOnly, "ren omdøping");
    // uten previous_filename (slik koden var): kun det nye navnet, som ser uskyldig ut
    asE2("modules/policy-x/src/gateway.ts");
    const swap = await changed([[{ filename: "modules/policy", status: "added" }, { filename: "modules/policy-x/src/gateway.ts", previous_filename: "modules/policy/src/gateway.ts", status: "renamed" }]]);
    asE3(swap, "symlink-bytte");
  });

  it("R3: sidetelling bruker responsens lengde (ikke antall navn): 100 omdøpte filer på side 1 gir en side til; 200 navn totalt", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `n/${i}.ts`, previous_filename: `o/${i}.ts`, status: "renamed" }));
    const files = await changed([page1, [{ filename: "z.ts" }]]);
    expect(files).toHaveLength(201);
    expect(files.slice(0, 2)).toEqual(["n/0.ts", "o/0.ts"]);
    expect(files[200]).toBe("z.ts");
  });
});

describe("A-diff: `git diff --no-renames --raw -z` - parser og klassifisering (modus 120000/160000 er E3)", () => {
  const rec = (status: string, oldMode: string, newMode: string, ...paths: string[]): string => `:${oldMode} ${newMode} 1234567 7654321 ${status}\0${paths.join("\0")}\0`;
  const sha = "a".repeat(40);

  it("P1: tolker poster (A/M/D/T), alle stier uten duplikater, og modusene gammel/ny", () => {
    const parsed = parseRawDiffZ(rec("M", "100644", "100644", "docs/a.md") + rec("A", "000000", "100755", "ops/x.sh") + rec("M", "100644", "100644", "docs/a.md"))!;
    expect(parsed.paths).toEqual(["docs/a.md", "ops/x.sh"]);
    expect(parsed.entries.map((e) => [e.status, e.old_mode, e.new_mode])).toEqual([["M", "100644", "100644"], ["A", "000000", "100755"], ["M", "100644", "100644"]]);
    expect(parsed.special_modes).toEqual([]);
    expect(parseRawDiffZ(`:100644 100644 ${sha} ${sha} M\0docs/a.md\0`)!.paths).toEqual(["docs/a.md"]);
  });

  it("P2: symlink (120000) og gitlink (160000) på gammel ELLER ny side gir special_modes, med modus og sti", () => {
    expect(parseRawDiffZ(rec("A", "000000", "120000", "modules/policy"))!.special_modes).toEqual(["120000:modules/policy"]);
    expect(parseRawDiffZ(rec("D", "120000", "000000", "x/link"))!.special_modes).toEqual(["120000:x/link"]);
    expect(parseRawDiffZ(rec("T", "100644", "120000", "docs/a.md"))!.special_modes).toEqual(["120000:docs/a.md"]);
    expect(parseRawDiffZ(rec("M", "160000", "160000", "vendor/sub"))!.special_modes).toEqual(["160000:vendor/sub", "160000:vendor/sub"]);
  });

  it("P3: R/C (skal ikke forekomme med --no-renames, men håndteres) har to stier; begge er med", () => {
    const parsed = parseRawDiffZ(`:100644 100644 1234567 7654321 R087\0modules/policy/a.ts\0modules/policy-x/a.ts\0`)!;
    expect(parsed.paths).toEqual(["modules/policy/a.ts", "modules/policy-x/a.ts"]);
  });

  it("P4: alt som ikke kan tolkes gir null (tom streng er en tom, gyldig diff): ikke-git-utdata, avkortet post, manglende sti, tom sti, sti som ligner en header, ukjent status", () => {
    expect(parseRawDiffZ("")!.paths).toEqual([]);
    for (const bad of ["docs/a.md\0", "garbage", ":100644 100644 1234567 7654321 M", ":100644 100644 1234567 7654321 M\0", ":100644 100644 1234567 7654321 M\0\0", ":100644 100644 1234567 7654321 R100\0a\0",
      ":100644 100644 1234567 7654321 M\0:100644 100644 1234567 7654321 M\0", ":100644 100644 1234567 7654321 Q\0a\0", ":100644 100644 xx 7654321 M\0a\0", ":10064 100644 1234567 7654321 M\0a\0",
      ":100644 100644 1234567 7654321 M\0a\0trailing", `${rec("M", "100644", "100644", "a")}x`]) {
      expect(parseRawDiffZ(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseRawDiffZ(undefined as unknown as string)).toBeNull();
  });

  it("P5: classifyRawDiff: ikke-tolkbart, tom diff og symlink/gitlink er E3 (uansett sti); ellers konstitusjonens klasse for ALLE berørte stier", () => {
    expect(classifyRawDiff(constitution, "garbage")).toBe("E3");
    expect(classifyRawDiff(constitution, "")).toBe("E3");
    expect(classifyRawDiff(constitution, rec("A", "000000", "120000", "docs/ufarlig-lenke.md"))).toBe("E3");
    expect(classifyRawDiff(constitution, rec("M", "160000", "160000", "docs/sub"))).toBe("E3");
    expect(classifyRawDiff(constitution, rec("D", "120000", "000000", "docs/gammel-lenke.md"))).toBe("E3");
    expect(classifyRawDiff(constitution, rec("M", "100644", "100644", "docs/a.md"))).toBe("E2");
    expect(classifyRawDiff(constitution, rec("M", "100644", "100644", "docs/a.md") + rec("M", "100644", "100644", "modules/policy/src/gateway.ts"))).toBe("E3");
    expect(classifyRawDiff(constitution, rec("M", "100644", "100644", "config/charlie-personality.json"))).toBe("E1");
    // kilde og mål av en omdøping: begge klassifiseres
    expect(classifyRawDiff(constitution, rec("D", "100644", "000000", "modules/policy/src/gateway.ts") + rec("A", "000000", "100644", "modules/policy-x/src/gateway.ts"))).toBe("E3");
  });

  describe("ekte git (midlertidig repo): symlink-bytte av en beskyttet katalog", () => {
    const dirs: string[] = [];
    afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
    const git = (cwd: string, ...args: string[]): string => {
      const r = spawnSync("git", ["-c", "user.name=ev0-test", "-c", "user.email=ev0-test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.quotepath=true", ...args], {
        cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
      });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} feilet: ${r.stderr}`);
      return r.stdout;
    };
    const repo = (): string => {
      const dir = mkdtempSync(join(tmpdir(), "ev0-diff-"));
      dirs.push(dir);
      git(dir, "init", "-q");
      mkdirSync(join(dir, "modules/policy/src"), { recursive: true });
      writeFileSync(join(dir, "modules/policy/src/gateway.ts"), "export const gateway = 1;\n");
      writeFileSync(join(dir, "README.txt"), "x\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      return dir;
    };

    it("G1: `git mv` + symlink: standardutskriften (rename-deteksjon) skjuler kilden, men begge lag gir nå E3; `--no-renames --raw -z` viser alt og symlinken er E3", () => {
      const dir = repo();
      git(dir, "mv", "modules/policy", "modules/policy-x");
      symlinkSync("policy-x", join(dir, "modules/policy"));
      git(dir, "add", "-A");
      const nameOnly = git(dir, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
      expect(nameOnly).toEqual(["modules/policy", "modules/policy-x/src/gateway.ts"]); // kilden `modules/policy/src/gateway.ts` er borte fra listen
      asE3(nameOnly, "name-only (katalog-selv)");
      const raw = git(dir, "diff", "--cached", "--no-renames", "--raw", "-z");
      const parsed = parseRawDiffZ(raw)!;
      expect(parsed.paths).toEqual(expect.arrayContaining(["modules/policy", "modules/policy-x/src/gateway.ts", "modules/policy/src/gateway.ts"]));
      expect(parsed.special_modes).toEqual(["120000:modules/policy"]);
      expect(classifyRawDiff(constitution, raw)).toBe("E3");
    });

    it("G2: en ren omdøping (uten symlink): `--name-only` viser kun det nye navnet (E2), `--no-renames --raw -z` viser begge og gir E3", () => {
      const dir = repo();
      git(dir, "mv", "modules/policy", "modules/policy-x");
      git(dir, "add", "-A");
      const nameOnly = git(dir, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
      expect(nameOnly).toEqual(["modules/policy-x/src/gateway.ts"]);
      expect(constitution.classify(nameOnly)).toBe("E2");
      const raw = git(dir, "diff", "--cached", "--no-renames", "--raw", "-z");
      expect(parseRawDiffZ(raw)!.paths.sort()).toEqual(["modules/policy-x/src/gateway.ts", "modules/policy/src/gateway.ts"]);
      expect(classifyRawDiff(constitution, raw)).toBe("E3");
    });

    it("G3: uten `-z` siterer git en sti med uvanlige tegn (`\"docs/caf\\303\\251.md\"`); en slik sti kan ikke tolkes og er E3 - med `-z` er stien rå og gyldig", () => {
      const dir = repo();
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs/café.md"), "x\n");
      git(dir, "add", "-A");
      const quoted = git(dir, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
      expect(quoted[0]!.startsWith("\"")).toBe(true);
      asE3(quoted, "sitert git-sti");
      const raw = git(dir, "diff", "--cached", "--no-renames", "--raw", "-z");
      expect(parseRawDiffZ(raw)!.paths).toEqual(["docs/café.md"]);
      expect(classifyRawDiff(constitution, raw)).toBe("E2");
    });

    it("G4: en vanlig endring i en ubeskyttet fil gir E2 og ingen symlink; filen finnes (repoet er ekte)", () => {
      const dir = repo();
      writeFileSync(join(dir, "README.txt"), "y\n");
      expect(existsSync(join(dir, ".git"))).toBe(true);
      const raw = git(dir, "diff", "--no-renames", "--raw", "-z");
      expect(parseRawDiffZ(raw)!.special_modes).toEqual([]);
      expect(classifyRawDiff(constitution, raw)).toBe("E2");
      expect(dirname(join(dir, "README.txt"))).toBe(dir);
    });
  });
});

/** Sondene FØR fix1 (20 opprinnelige + 29 fra WP-EV0). Gulvet kan bare vokse: ingen av disse kan fjernes. */
const ORIGINAL_FIRST_BATCH = [
  "modules/policy/src/gateway.ts", "modules/owner-controls/src/service.ts", "modules/self-modification/src/policy.ts", "modules/tool-gateway/src/gateway.ts", "modules/core/src/db/migrations/001_init.sql",
  ".github/workflows/ci.yml", "infra/local/docker-compose.yml", "package.json", "apps/api/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".env", ".env.production",
  "docs/security/SECURITY_MODEL.md", "CLAUDE.md", "config/evolution/constitution.v1.json", "config/evolution/constitution.v1.sig", "config/evolution/constitution.pub.pem",
  "ops/security/sign-constitution.mjs", "ops/break-glass/freeze-jarvis.sh", "modules/policy/src/policy-gateway.ts", "modules/policy/src/approval-verifier.ts", "modules/policy/src/kill-switch.ts",
  "modules/tool-gateway/src/class-d-pipeline.ts", "modules/tool-gateway/src/finance-class-d.ts", "modules/tool-gateway/src/model-tool-surface.ts", "apps/api/src/step-up.ts",
  "modules/core/src/services/audit-writer.ts", "modules/core/src/services/policy-audit-sink.ts", "modules/core/src/services/approval-store.ts", "modules/core/src/services/identity-service.ts",
  "modules/core/src/services/session-grant-service.ts", "modules/core/src/services/device-authority.ts", "modules/core/src/services/channel-session-authority.ts",
  "modules/core/src/services/voice-session-authority.ts", "modules/core/src/services/telegram-owner-authority.ts", "modules/core/src/services/runtime-role.ts", "modules/core/src/db/pool.ts",
  "modules/executive/src/self-model/confidence-gate.ts", "config/program/index.json", "docs/remediation/ADR-001-dokumenthierarki.md", "docs/SECURITY_MODEL.md", "docs/CANONICAL_SPEC.md",
  "modules/core/src/db/migrations/001_identity.sql", "ops/security/check-containment.mjs", "ops/backup/jarvis-backup.mjs", "ops/job-runner/egress-proxy.mjs", "ops/job-runner/credential-helper.mjs",
  "ops/claude-worker/worker.mjs"
];
/** Lead-ordrens minimumsliste (A-F2) - en navngitt sonde for hver. */
const REVIEWER_MINIMUM = [
  ...["approval", "canonical", "capability", "identity", "session-grant", "voice-authority"].map((n) => `packages/contracts/src/${n}.ts`),
  ...["tool-manifest", "chat-read-tier", "chat-act-tier", "chat-delegate-tier", "autonomy-bindable", "url-safety"].map((n) => `modules/tool-gateway/src/${n}.ts`),
  "modules/tool-gateway/src/docker-target-policy.ts", "modules/tool-gateway/src/personal/critical-ops.ts", "modules/situations/src/autonomy-guard.ts", "modules/core/src/db/migrator.ts",
  "modules/core/src/services/secret-scan.ts", "modules/core/src/services/confirmation-store.ts", "apps/api/src/ev0-boot.ts", "apps/api/src/http-guard.ts", "apps/api/src/restricted-context-guard.ts",
  "modules/model-gateway/src/budget-guard.ts", "modules/model-gateway/src/claude-budget.ts", "modules/model-gateway/src/content-sensitivity.ts", "modules/watchdog/src/watchdog.ts",
  ".sops.yaml", ".gitleaksignore", "vitest.config.ts", "eslint.config.mjs", "tsconfig.base.json", ".git/config", ".claude/settings.json", ".mcp.json", ".npmrc", ".pnpmfile.cjs", ".gitattributes",
  ".gitmodules", ".husky/pre-commit", "apps/api/.env"
];

describe("B: resten av Authority Plane og gate-/forsyningskjede-konfig er E3 (A-F2)", () => {
  /** Hver fil under kommer fra reviewerens minimumsliste; alle skal finnes i repoet (se C), og hver alternativ i mønstrene har en sonde. */
  const FILES: string[] = [
    ...["approval", "canonical", "capability", "identity", "session-grant", "voice-authority"].map((n) => `packages/contracts/src/${n}.ts`),
    ...["tool-manifest", "chat-read-tier", "chat-act-tier", "chat-delegate-tier", "autonomy-bindable", "url-safety", "cloudflare-target-policy", "docker-target-policy", "gce-target-policy", "postgres-ops-target-policy"].map((n) => `modules/tool-gateway/src/${n}.ts`),
    "modules/tool-gateway/src/personal/critical-ops.ts",
    "modules/situations/src/autonomy-guard.ts",
    "modules/core/src/db/migrator.ts", "modules/core/src/services/secret-scan.ts", "modules/core/src/services/confirmation-store.ts",
    "apps/api/src/ev0-boot.ts", "apps/api/src/http-guard.ts", "apps/api/src/restricted-context-guard.ts",
    "modules/model-gateway/src/budget-guard.ts", "modules/model-gateway/src/claude-budget.ts", "modules/model-gateway/src/claude-budget-enforcer.ts", "modules/model-gateway/src/content-sensitivity.ts",
    "modules/watchdog/src/watchdog.ts", "modules/watchdog/src/backup.ts", "modules/watchdog/scripts/x.ts"
  ];
  /** Filer som er beskyttet på ALLE nivåer: roten og nestet. */
  const DOTFILES = [".sops.yaml", ".gitleaksignore", ".gitignore", ".dockerignore", ".mcp.json", ".npmrc", ".pnpmfile.cjs", ".gitattributes", ".gitmodules"];
  const CONFIGS = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "eslint.config.mjs", "eslint.config.js", "eslint.config.cjs", "tsconfig.base.json"];

  it("B1: hver navngitt Authority Plane-fil er forbudt (legacy) og E3 (konstitusjon) i alle skrivemåter", () => {
    for (const file of FILES) for (const v of variants(file)) asE3([v], JSON.stringify(v));
  });

  it("B2: dotfiler og konfig: i roten OG nestet på alle nivåer (en nestet .npmrc/.gitignore/vitest.config styrer også verktøyet)", () => {
    for (const file of [...DOTFILES, ...CONFIGS]) {
      for (const where of ["", "apps/api/", "a/b/c/"]) for (const v of variants(`${where}${file}`)) asE3([v], JSON.stringify(v));
    }
  });

  it("B3: `.env*` på alle nivåer (A-F2: tidligere kun roten): nestet .env, .env.local, .env.production og .envrc", () => {
    for (const p of [".env", ".env.local", "apps/api/.env", "apps/api/.env.local", "a/b/c/.env.production", "packages/x/.envrc", "APPS/WEB/.ENV"]) asE3([p], p);
  });

  it("B4: fremtidige filer som følger navnemønstrene (`*-target-policy`, `secret-scan*`, `claude-budget*`) er også E3", () => {
    for (const p of [
      "modules/tool-gateway/src/vercel-target-policy.ts", "modules/tool-gateway/src/-target-policy.ts", "modules/core/src/services/secret-scan-rules.ts", "modules/core/src/services/secret-scan2.ts",
      "modules/model-gateway/src/claude-budget-v2.ts", "modules/model-gateway/src/claude-budget-meter.ts"
    ]) asE3([p], p);
  });

  it("B5: nære bom er IKKE E3 (vanlig kode = E2): søsken-filer, testfiler, andre filtyper, pakkenes egne tsconfig.json og lignende navn", () => {
    for (const p of [
      "packages/contracts/src/index.ts", "packages/contracts/src/approval.test.ts", "packages/contracts/src/approvals.ts", "packages/contracts/test/approval.ts",
      "modules/tool-gateway/src/live-transports.ts", "modules/tool-gateway/src/chat-tier.ts", "modules/tool-gateway/src/target-policy.ts", "modules/tool-gateway/src/tool-manifest-helper.ts",
      "modules/tool-gateway/src/personal/other.ts", "modules/situations/src/engine.ts", "modules/core/src/db/migrator-helper.ts", "modules/core/src/services/message-store.ts",
      "apps/api/src/server.ts", "apps/api/src/ev0-boot-helper.ts", "modules/model-gateway/src/routing-advisor.ts", "modules/model-gateway/src/budget-guard.ts.bak", "modules/model-gateway/src/budgets.ts",
      ".gitignore.bak", "docs/gitignore.md", "vitest.config.ts.bak", "eslint.config.mjs.old", "tsconfig.json", "apps/api/tsconfig.json", "tsconfig.base.json.bak", "apps/api/src/environment.ts"
    ]) {
      // `apps/api/src/environment.ts` har ikke `.env` som segmentstart; `.env`-mønsteret treffer kun segmenter som BEGYNNER med `.env`
      asE2(p);
    }
  });

  it("B6: E3-handlingene har sti-dekning: `raise_autonomy_level` (autonomivakt + bindbarhet) og `disable_security_alarm` (vakthunden) m.fl. - hver sti er sonde, finnes, og er E3 i begge lag", () => {
    const keys = Object.keys(E3_ACTION_ENFORCEMENT_PATHS);
    for (const a of keys) expect(REQUIRED_E3_ACTIONS, a).toContain(a);
    expect(E3_ACTION_ENFORCEMENT_PATHS["raise_autonomy_level"]).toEqual(["modules/situations/src/autonomy-guard.ts", "modules/tool-gateway/src/autonomy-bindable.ts"]);
    expect(E3_ACTION_ENFORCEMENT_PATHS["disable_security_alarm"]).toEqual(["modules/watchdog/src/watchdog.ts"]);
    expect(Object.isFrozen(E3_ACTION_ENFORCEMENT_PATHS)).toBe(true);
    for (const [action, paths] of Object.entries(E3_ACTION_ENFORCEMENT_PATHS)) {
      expect(Object.isFrozen(paths), action).toBe(true);
      expect(paths.length, action).toBeGreaterThan(0);
      for (const p of paths) {
        expect(REQUIRED_PROTECTED_PROBES, `${action}: ${p}`).toContain(p);
        expect(existsSync(new URL(p, ROOT)), `${action}: ${p} finnes`).toBe(true);
        asE3([p], `${action}: ${p}`);
        expect(constitution.isActionForbidden(action), action).toBe(true);
      }
    }
  });

  it("B7: monotoni: de 49 opprinnelige sondene og reviewerens minimumsliste er fortsatt med (gulvet kan bare vokse), uten duplikater", () => {
    expect(ORIGINAL_FIRST_BATCH).toHaveLength(49);
    for (const p of [...ORIGINAL_FIRST_BATCH, ...REVIEWER_MINIMUM]) expect(REQUIRED_PROTECTED_PROBES, p).toContain(p);
    expect(REQUIRED_PROTECTED_PROBES.slice(0, 49)).toEqual(ORIGINAL_FIRST_BATCH);
    expect(new Set(REQUIRED_PROTECTED_PROBES).size).toBe(REQUIRED_PROTECTED_PROBES.length);
    expect(REQUIRED_PROTECTED_PROBES.length - 49).toBeGreaterThanOrEqual(REVIEWER_MINIMUM.length);
  });

  it("B8: HVER sonde (gamle og nye) dekkes av det signerte manifestet, og manifestet er gyldig; en fjernet regel for en ny sonde gir constitution_weakened", () => {
    expect(() => buildConstitution(manifest())).not.toThrow();
    const newProbes = REQUIRED_PROTECTED_PROBES.filter((p) => !ORIGINAL_FIRST_BATCH.includes(p));
    expect(newProbes.length).toBeGreaterThanOrEqual(REVIEWER_MINIMUM.length);
    for (const probe of newProbes) {
      const m = manifest();
      const before = m.protected_paths.length;
      m.protected_paths = m.protected_paths.filter((r) => {
        const key = protectionKey(probe);
        const v = protectionKey(r.value);
        return !(r.kind === "prefix" ? key.startsWith(v) : r.kind === "exact" ? key === v : r.kind === "suffix" ? key.endsWith(v) : key === v || key.endsWith(`/${v}`));
      });
      expect(m.protected_paths.length, probe).toBeLessThan(before);
      expect(msg(() => buildConstitution(m)), probe).toMatch(/^constitution_weakened:unprotected:/);
    }
  });
});

describe("C: sondene finnes i repoet - bortsett fra de dokumenterte kommende filene", () => {
  it("C1: hver NY sonde er en sporbar fil (eller en katalog), unntatt filer som kan komme til (listet)", () => {
    const FUTURE = new Set([".mcp.json", ".npmrc", ".pnpmfile.cjs", ".gitattributes", ".gitmodules", ".git/config", ".claude/settings.json", ".husky/pre-commit", "apps/api/.env"]);
    const missing = REQUIRED_PROTECTED_PROBES.filter((p) => !ORIGINAL_FIRST_BATCH.includes(p)).filter((p) => !existsSync(new URL(p, ROOT)) && !FUTURE.has(p));
    expect(missing).toEqual([]);
    for (const p of FUTURE) expect(REQUIRED_PROTECTED_PROBES, p).toContain(p);
    // katalogsondene: katalogene finnes, unntatt de som kan komme til
    const FUTURE_DIRS = new Set([".claude", ".husky", "config/program"]); // `config/program` (HF6 program-indeks) finnes ikke i basen ennå
    const missingDirs = REQUIRED_PROTECTED_DIRECTORY_PROBES.filter((d) => !existsSync(new URL(d, ROOT)) && !FUTURE_DIRS.has(d));
    expect(missingDirs).toEqual([]);
  });
});

describe("D: protectionKey avviser format-/kontrolltegn og sitert git-sti (L3) - E3, ikke E2", () => {
  const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
  const ALIASES: Array<[string, string]> = [
    ["ZWSP U+200B", cp(0x200b)], ["ZWNJ U+200C", cp(0x200c)], ["ZWJ U+200D", cp(0x200d)], ["LRM U+200E", cp(0x200e)], ["RLM U+200F", cp(0x200f)], ["LRE U+202A", cp(0x202a)],
    ["RLO U+202E", cp(0x202e)], ["isolate U+2066", cp(0x2066)], ["word joiner U+2060", cp(0x2060)], ["BOM U+FEFF", cp(0xfeff)], ["soft hyphen U+00AD", cp(0xad)],
    ["C1 NEL U+0085", cp(0x85)], ["C1 U+009F", cp(0x9f)], ["C1 U+0080", cp(0x80)], ["DEL U+007F", cp(0x7f)], ["tab", "\t"], ["LF", "\n"], ["Mongolian vowel sep U+180E", cp(0x180e)]
  ];

  it("D1: et format-/kontrolltegn hvor som helst i stien gir en ugyldig nøkkel (så en endring som skjuler en beskyttet fil med et alias-tegn er E3)", () => {
    for (const [name, ch] of ALIASES) {
      for (const p of [`modules/pol${ch}icy/src/x.ts`, `${ch}modules/policy/src/x.ts`, `modules/policy/src/x.ts${ch}`, `apps/api/pack${ch}age.json`, `.gi${ch}thub/workflows/ci.yml`]) {
        expect(isInvalidPathKey(protectionKey(p)), `${name}: ${JSON.stringify(p)}`).toBe(true);
        asE3([p], `${name}: ${JSON.stringify(p)}`);
      }
    }
  });

  it("D2: en ledende `\"` (git-sitert sti uten -z) er ugyldig - også fullbredde-anførselstegn (foldes av NFKC) - mens anførselstegn inni et filnavn ikke er det", () => {
    for (const p of ["\"modules/policy/src/x.ts\"", "\"docs/caf\\303\\251.md\"", `${cp(0xff02)}modules/policy/x.ts${cp(0xff02)}`, "\"", "\"a"]) {
      expect(protectionKey(p), JSON.stringify(p)).toBe(INVALID_PATH_KEY);
      asE3([p], JSON.stringify(p));
    }
    expect(protectionKey("docs/a\"b.md")).toBe("docs/a\"b.md");
    expect(protectionKey("docs/ab\".md")).toBe("docs/ab\".md");
  });

  it("D3: vanlige ikke-ASCII-navn er fortsatt gyldige (ikke for bredt): æøå, aksenter, kinesisk, emoji og NFC/NFD-former foldes til samme nøkkel", () => {
    expect(protectionKey("docs/notat-ÆØÅ.md")).toBe("docs/notat-æøå.md");
    expect(protectionKey(`docs/caf${cp(0xe9)}.md`)).toBe(protectionKey(`docs/cafe${cp(0x301)}.md`));
    for (const p of ["docs/漢字.md", `docs/${cp(0x1f600)}.md`, "docs/ñandú.md"]) expect(isInvalidPathKey(protectionKey(p)), p).toBe(false);
    asE2("docs/notat-æøå.md");
  });

  it("D4: de gamle ugyldighetsreglene gjelder fortsatt (kolon, `..`, absolutt, `~`, 8.3, tom)", () => {
    for (const p of ["a:b", "../x", "/x", "~x", "modules/POLIC~1/x", "", " "]) expect(protectionKey(p), JSON.stringify(p)).toBe(INVALID_PATH_KEY);
  });
});

describe("E: manifestet er dypfryst og versjonen har en øvre grense (I5)", () => {
  it("E1: Constitution.manifest og alt under er frosset - mutasjon kaster, og klassifiseringen endres ikke", () => {
    const c = buildConstitution(manifest());
    const m = c.manifest as { protected_paths: Array<{ kind: string; value: string }>; e3_actions: string[]; e1_allowlist: string[]; budget_caps: Record<string, number>; version: number };
    for (const frozen of [c.manifest, m.protected_paths, m.protected_paths[0], m.e3_actions, m.e1_allowlist, m.budget_caps, c.budget]) expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => { m.protected_paths.length = 0; }).toThrow(TypeError);
    expect(() => { m.protected_paths.pop(); }).toThrow(TypeError);
    expect(() => { m.protected_paths[0]!.value = "x/"; }).toThrow(TypeError);
    expect(() => { m.e3_actions.splice(0, 1); }).toThrow(TypeError);
    expect(() => { m.e1_allowlist.push("x"); }).toThrow(TypeError);
    expect(() => { m.budget_caps["max_auto_merges_per_day"] = 99; }).toThrow(TypeError);
    expect(() => { m.version = 99; }).toThrow(TypeError);
    expect(c.classify(["modules/policy/src/x.ts"])).toBe("E3");
    expect(c.isActionForbidden("modify_kill_switch")).toBe(true);
    expect(c.digest).toBe(buildConstitution(manifest()).digest);
  });

  it("E2: versjon: 1 og 2^53-1 er gyldige; 0, negativ, brøk, 2^53, 1e300, NaN og streng avvises (constitution_invalid) - rollback-vernet kan ikke sammenligne usikre tall", () => {
    for (const ok of [1, 2, Number.MAX_SAFE_INTEGER]) expect(() => buildConstitution({ ...manifest(), version: ok }), String(ok)).not.toThrow();
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2 ** 53, 1e300, Number.NaN, Number.POSITIVE_INFINITY, "2" as unknown as number]) {
      expect(msg(() => buildConstitution({ ...manifest(), version: bad })), String(bad)).toMatch(/^constitution_invalid:/);
    }
  });
});

describe("F: minVersion kan aldri stille ignoreres (L1)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fp = publicKeyFingerprint(createPublicKey(pem));
  const signed = (version: number): { manifestJson: string; signatureB64: string } => {
    const m = { ...manifest(), version, issued_by: "platform-operator" } as Record<string, unknown>;
    delete m["notes"];
    return { manifestJson: JSON.stringify(m), signatureB64: cryptoSign(null, Buffer.from(canonicalizeManifest(m), "utf8"), privateKey).toString("base64") };
  };
  const verify = (version: number, minVersion?: unknown): string => msg(() => verifyConstitution({ ...signed(version), publicKeyPem: pem, pinnedPublicKeySha256: fp, ...(minVersion !== undefined ? { minVersion: minVersion as number } : {}) }));

  it("F1: signert v2 + min 2 = ok; min 3 = constitution_rollback:2<3; uten min = ok; v3 + min 3 = ok", () => {
    expect(verify(2)).toBe("no_error");
    expect(verify(2, 2)).toBe("no_error");
    expect(verify(2, 1)).toBe("no_error");
    expect(verify(2, 3)).toBe("constitution_rollback:2<3");
    expect(verify(3, 3)).toBe("no_error");
    expect(verify(1, 2)).toBe("constitution_rollback:1<2");
  });

  it("F2: ugyldig min (NaN, 0, negativ, brøk, Infinity, 2^53, streng, null, objekt) kaster constitution_min_version_invalid - FØR signatur-sjekken, og aldri stille ignorert", () => {
    for (const bad of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 53, "3", null, {}, [], true]) {
      expect(verify(2, bad), String(bad)).toBe(`constitution_min_version_invalid:${String(bad)}`);
    }
    // gjelder selv om manifestet ikke er signert: en feilkonfigurert terskel skal ikke skjules
    expect(msg(() => verifyConstitution({ manifestJson: "{}", signatureB64: null, publicKeyPem: null, pinnedPublicKeySha256: null, minVersion: Number.NaN }))).toBe("constitution_min_version_invalid:NaN");
    expect(new ConstitutionError("constitution_min_version_invalid").code).toBe("constitution_min_version_invalid");
  });

  it("F3: isValidMinVersion: kun trygge heltall >= 1", () => {
    for (const ok of [1, 2, 999, Number.MAX_SAFE_INTEGER]) expect(isValidMinVersion(ok), String(ok)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined, {}, true]) expect(isValidMinVersion(bad), String(bad)).toBe(false);
  });

  it("F4: de harde takene er uendret av denne runden (regresjonsvakt for budsjettet)", () => {
    expect(BUDGET_HARD_CEILINGS.max_evolution_cost_ore_per_month).toBe(100_000);
    expect(Object.keys(BUDGET_HARD_CEILINGS)).toHaveLength(12);
  });
});
