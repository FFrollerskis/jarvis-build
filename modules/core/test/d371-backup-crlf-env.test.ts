import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/** D-371: en .env med Windows-linjeskift (CRLF) ga «role "postgres\r" does not exist» i nas-backup.sh. */
const SRC = resolve(__dirname, "../../../ops/backup");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("D-371 nas-backup.sh .env med CRLF", () => {
  it("sender brukernavn og passord uten \\r videre til backup-verktøyet", () => {
    const root = mkdtempSync(join(tmpdir(), "nas-backup-"));
    dirs.push(root);
    mkdirSync(join(root, "ops/backup"), { recursive: true });
    mkdirSync(join(root, "bin"));
    for (const f of ["nas-backup.sh", "age-docker.sh"]) copyFileSync(join(SRC, f), join(root, "ops/backup", f));
    chmodSync(join(root, "ops/backup/nas-backup.sh"), 0o755);
    chmodSync(join(root, "ops/backup/age-docker.sh"), 0o755);
    writeFileSync(join(root, ".env"), "JARVIS_DB_ADMIN_USER=postgres\r\nJARVIS_DB_ADMIN_PASSWORD=pw123\r\n");
    writeFileSync(join(root, "recipient"), "age1abc\n");
    const seen = join(root, "seen.txt");
    // Stub-`node` skriver ut det backup-verktøyet ville fått; stub-`docker` gjør ingenting.
    writeFileSync(join(root, "bin/node"), `#!/usr/bin/env bash\nprintf '[%s][%s]\\n' "$JARVIS_DB_ADMIN_USER" "$JARVIS_DB_ADMIN_PASSWORD" >> "${seen}"\n`);
    writeFileSync(join(root, "bin/docker"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(root, "bin/node"), 0o755);
    chmodSync(join(root, "bin/docker"), 0o755);
    const r = spawnSync(join(root, "ops/backup/nas-backup.sh"), [join(root, "out")], {
      env: { PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: root, JARVIS_BACKUP_RECIPIENT_FILE: join(root, "recipient") },
      encoding: "utf8"
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(seen, "utf8")).toContain("[postgres][pw123]");
    expect(readFileSync(seen, "utf8")).not.toContain("\r");
  });
});
