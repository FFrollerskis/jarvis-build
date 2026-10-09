import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, tempDir } from "./helpers.mjs";

afterAll(cleanupTempDirs);
const SRC = dirname(fileURLToPath(new URL("../nas-schedule.sh", import.meta.url)));
const SCRIPT = join(SRC, "nas-schedule.sh");

/**
 * nas-schedule.sh uten ekte docker/node: en stub-`node` skriver ut argv og de variablene backup-verktøyet ville fått. Beviser innlesingen av .env
 * (CRLF, anførselstegn, kommentarer, miljø-vinner, kun JARVIS_BACKUP_*), kommando-videreføring og at ingenting annet fra .env slipper gjennom.
 */
function setup({ env = "", withRecipientFile = true, withAge = true } = {}) {
  const root = tempDir("nas-sched-");
  mkdirSync(join(root, "ops/backup"), { recursive: true });
  mkdirSync(join(root, "infra/local"), { recursive: true });
  mkdirSync(join(root, "bin"));
  for (const f of ["nas-schedule.sh", "age-docker.sh"]) {
    copyFileSync(join(SRC, f), join(root, "ops/backup", f));
    chmodSync(join(root, "ops/backup", f), 0o755);
  }
  writeFileSync(join(root, "infra/local/docker-compose.yml"), "services: {}\n");
  writeFileSync(join(root, ".env"), env);
  const seen = join(root, "seen.txt");
  writeFileSync(join(root, "bin/node"), `#!/usr/bin/env bash
{ printf 'ARGS:%s\\n' "$*"; printf 'CWD:%s\\n' "$PWD"; env | grep -E '^(JARVIS_|ANTHROPIC_|SECRET_)' | sort; } >> "${seen}"
exit 0
`);
  writeFileSync(join(root, "bin/docker"), `#!/usr/bin/env bash\necho "docker $*" >> "${seen}"\nexit 0\n`);
  chmodSync(join(root, "bin/node"), 0o755);
  chmodSync(join(root, "bin/docker"), 0o755);
  if (withAge) writeFileSync(join(root, "bin/age"), "#!/usr/bin/env bash\nexit 0\n");
  if (withAge) chmodSync(join(root, "bin/age"), 0o755);
  // Minimal PATH: stubbene + nøyaktig de systemverktøyene skriptet bruker (så `age` finnes IKKE med mindre vi la en stub).
  const tools = join(root, "tools");
  mkdirSync(tools);
  for (const t of ["bash", "env", "grep", "sed", "sort", "tail", "head", "tr", "mkdir", "chmod", "dirname", "cat", "uname"]) {
    for (const dir of ["/usr/bin", "/bin"]) {
      if (existsSync(join(dir, t))) { symlinkSync(join(dir, t), join(tools, t)); break; }
    }
  }
  const recipient = join(root, "recipient");
  if (withRecipientFile) writeFileSync(recipient, "age1publicpublicpublicpublicpublicpublicpublicpublicpublicp\n");
  return {
    root, seen,
    run: (args, extraEnv = {}) =>
      spawnSync("bash", [join(root, "ops/backup/nas-schedule.sh"), ...args], {
        encoding: "utf8", cwd: tempDir("nas-sched-cwd-"),
        env: { PATH: `${join(root, "bin")}:${tools}`, HOME: root, JARVIS_BACKUP_RECIPIENT_FILE: recipient, ...extraEnv }
      })
  };
}

describe("nas-schedule.sh", () => {
  it("er gyldig bash", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("tick: sender --mode docker --compose-file <repo>/infra/local/docker-compose.yml --out <dir>, kjører fra repoets rot, og er stille", () => {
    const { root, seen, run } = setup({ env: "JARVIS_DB_ADMIN_USER=postgres\nJARVIS_DB_ADMIN_PASSWORD=pw123\n" });
    const out = join(root, "backups");
    const r = run([out]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    const log = readFileSync(seen, "utf8");
    expect(log).toContain(`ARGS:${join(root, "ops/backup/schedule.mjs")} tick --mode docker --compose-file ${join(root, "infra/local/docker-compose.yml")} --out ${out}`);
    expect(log).toContain(`CWD:${root}`);
    expect(log).toContain("JARVIS_DB_ADMIN_PASSWORD=pw123");
    expect(log).toContain("JARVIS_DB_ADMIN_USER=postgres");
    expect(log).toContain("JARVIS_BACKUP_AGE_RECIPIENT=age1publicpublic");
    expect(existsSync(out)).toBe(true);
  });

  it("flagg etter kommandoen sendes videre (--force-backup, --json)", () => {
    const { root, seen, run } = setup({ env: "JARVIS_DB_ADMIN_PASSWORD=x\n" });
    run([join(root, "b"), "tick", "--force-backup", "--json"]);
    expect(readFileSync(seen, "utf8")).toMatch(/ARGS:.*tick --mode docker --compose-file .* --out .*b --force-backup --json/);
  });

  it(".env i Windows-/compose-stil: CRLF, anførselstegn og etterfølgende kommentarer fjernes; passordet kommer ut uten \\r", () => {
    const env = [
      'JARVIS_DB_ADMIN_USER="postgres"\r', "JARVIS_DB_ADMIN_PASSWORD='p@ss w0rd'\r", "JARVIS_BACKUP_INTERVAL_HOURS=12 # hvert halve døgn\r", 'JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE="b2:jarvis/backups"\r',
      "JARVIS_BACKUP_HEARTBEAT_URL=https://hc.example/abc-def\r", "JARVIS_BACKUP_RETAIN_DAYS=\r", "ANTHROPIC_API_KEY=sk-skal-ikke-videre\r", "SECRET_FOO=skal-ikke-videre\r", "jarvis_backup_lower=nei\r"
    ].join("\n");
    const { root, seen, run } = setup({ env });
    expect(run([join(root, "b")]).status).toBe(0);
    const log = readFileSync(seen, "utf8");
    expect(log).toContain("JARVIS_DB_ADMIN_USER=postgres\n");
    expect(log).toContain("JARVIS_DB_ADMIN_PASSWORD=p@ss w0rd\n");
    expect(log).toContain("JARVIS_BACKUP_INTERVAL_HOURS=12\n");
    expect(log).toContain("JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE=b2:jarvis/backups\n");
    expect(log).toContain("JARVIS_BACKUP_HEARTBEAT_URL=https://hc.example/abc-def\n");
    expect(log).not.toContain("\r");
    expect(log).not.toContain("JARVIS_BACKUP_RETAIN_DAYS"); // tom = usatt
    expect(log).not.toMatch(/ANTHROPIC|SECRET_FOO|skal-ikke-videre|jarvis_backup_lower/); // kun JARVIS_BACKUP_* + DB-admin slipper gjennom
  });

  it("miljøet som allerede er satt vinner over .env (samme som compose)", () => {
    const { root, seen, run } = setup({ env: "JARVIS_DB_ADMIN_PASSWORD=x\nJARVIS_BACKUP_INTERVAL_HOURS=12\n" });
    run([join(root, "b")], { JARVIS_BACKUP_INTERVAL_HOURS: "6" });
    const log = readFileSync(seen, "utf8");
    expect(log).toContain("JARVIS_BACKUP_INTERVAL_HOURS=6\n");
    expect(log).not.toContain("JARVIS_BACKUP_INTERVAL_HOURS=12");
  });

  it("uten mottakerfil og uten mottaker i miljøet feiler tick høylytt (exit 1) uten å starte noe", () => {
    const { root, seen, run } = setup({ env: "JARVIS_DB_ADMIN_PASSWORD=x\n", withRecipientFile: false });
    const r = run([join(root, "b")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("offentlig age-nøkkel");
    expect(existsSync(seen)).toBe(false);
    // …men en mottaker i miljøet er nok
    const ok = run([join(root, "b")], { JARVIS_BACKUP_AGE_RECIPIENT: "age1fraenvfraenvfraenvfraenvfraenvfraenvfraenvfraenvfraenvfraenv" });
    expect(ok.status).toBe(0);
  });

  it("status og offsite-check videreføres uten backup-flaggene (--mode/--compose-file hører bare til tick); ukjent kommando = exit 1", () => {
    const { root, seen, run } = setup({ env: "JARVIS_DB_ADMIN_PASSWORD=x\n" });
    expect(run([join(root, "b"), "status", "--json"]).status).toBe(0);
    expect(run([join(root, "b"), "offsite-check"]).status).toBe(0);
    const log = readFileSync(seen, "utf8");
    expect(log).toMatch(/ARGS:.*schedule\.mjs status --out .*b --json/);
    expect(log).toMatch(/ARGS:.*schedule\.mjs offsite-check --out /);
    expect(log).not.toMatch(/status --mode|offsite-check --mode/);
    const bad = run([join(root, "b"), "slett-alt"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("ukjent kommando");
  });

  it("uten `age` på verten velges engangs-container-wrapperen (D-370) og imaget sikres - som nas-backup.sh", () => {
    const { root, seen, run } = setup({ env: "JARVIS_DB_ADMIN_PASSWORD=x\n", withAge: false });
    const r = run([join(root, "b")]);
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(seen, "utf8");
    expect(log).toContain(`JARVIS_AGE_BIN=${join(root, "ops/backup/age-docker.sh")}`);
    expect(log).toContain("docker image inspect");
  });

  it("mangler .env feiler det tydelig (exit 1)", () => {
    const { root, run } = setup();
    writeFileSync(join(root, ".env"), "");
    // ingen .env-fil i det hele tatt
    const dir = tempDir("nas-sched-noenv-");
    mkdirSync(join(dir, "ops/backup"), { recursive: true });
    copyFileSync(SCRIPT, join(dir, "ops/backup/nas-schedule.sh"));
    const r = spawnSync("bash", [join(dir, "ops/backup/nas-schedule.sh"), join(dir, "b")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("finner ikke");
    expect(run([join(root, "b")]).status).toBe(0); // en tom .env er lov (feilen kommer da fra schedule.mjs' konfig-sjekk)
  });
});
