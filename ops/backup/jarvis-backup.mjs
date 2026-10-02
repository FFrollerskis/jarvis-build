#!/usr/bin/env node
/**
 * Jarvis backup / restore-verify tool (remediation part 1, JARVIS-007).
 *
 *   backup  --out DIR [--mode docker|direct] [--compose-file F] [--databases a,b,c] [--retain-days N]
 *   verify  --set DIR --identity KEYFILE (--scratch-container NAME | --scratch-host H --scratch-port P) [--scratch-user U] [--allow-same-server]
 *   status  --out DIR [--max-age-hours 25]
 *
 * Secrets come ONLY from the environment: JARVIS_DB_ADMIN_PASSWORD (source), JARVIS_SCRATCH_DB_PASSWORD
 * (scratch server), JARVIS_BACKUP_AGE_RECIPIENT (age PUBLIC key). Nothing secret is accepted on argv
 * or written to the manifest/report.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_DATABASES, runBackup } from "./lib/backup.mjs";
import { backupAgeHours, pruneBackupSets, runRestoreVerify } from "./lib/restore-verify.mjs";
import { makeRunner } from "./lib/runner.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { command, flags };
}

const log = (m) => console.error(`[jarvis-backup] ${m}`);

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, flags } = parseArgs(argv);
  if (command === "backup") {
    const runner = makeRunner({
      mode: flags.mode ?? "docker",
      composeFile: flags["compose-file"] ? resolve(flags["compose-file"]) : undefined,
      host: flags.host ?? "127.0.0.1",
      port: Number(flags.port ?? 5432),
      user: flags.user ?? env.JARVIS_DB_ADMIN_USER ?? "postgres",
      password: env.JARVIS_DB_ADMIN_PASSWORD
    });
    const { setDir, manifest } = await runBackup({
      runner,
      databases: flags.databases ? String(flags.databases).split(",") : DEFAULT_DATABASES,
      outDir: resolve(flags.out),
      recipient: env.JARVIS_BACKUP_AGE_RECIPIENT,
      log
    });
    let pruned = [];
    if (flags["retain-days"]) pruned = pruneBackupSets(resolve(flags.out), Number(flags["retain-days"]), new Date(), (d) => rmSync(d, { recursive: true, force: true }));
    console.log(JSON.stringify({ ok: true, set: manifest.set, dir: setDir, databases: manifest.databases.map((d) => ({ database: d.database, tables: d.tables.length, size_bytes: d.size_bytes })), pruned }, null, 2));
    return 0;
  }
  if (command === "verify") {
    const scratchRunner = flags["scratch-container"]
      ? makeRunner({ mode: "container", container: String(flags["scratch-container"]), user: flags["scratch-user"] ?? "postgres", password: env.JARVIS_SCRATCH_DB_PASSWORD })
      : makeRunner({
          mode: "direct",
          host: flags["scratch-host"],
          port: Number(flags["scratch-port"]),
          user: flags["scratch-user"] ?? "postgres",
          password: env.JARVIS_SCRATCH_DB_PASSWORD
        });
    const report = await runRestoreVerify({
      setDir: resolve(flags.set),
      identityFile: resolve(flags.identity),
      scratchRunner,
      allowSameServer: flags["allow-same-server"] === true,
      log
    });
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 2;
  }
  if (command === "status") {
    const maxAge = Number(flags["max-age-hours"] ?? 25);
    const age = backupAgeHours(resolve(flags.out));
    const ok = age !== undefined && age <= maxAge;
    console.log(JSON.stringify({ ok, newest_backup_age_hours: age === undefined ? null : Number(age.toFixed(2)), max_age_hours: maxAge }));
    return ok ? 0 : 3;
  }
  console.error("usage: jarvis-backup.mjs backup|verify|status ... (see file header)");
  return 1;
}

// D-372: sammenlign file://-URL-er. `new URL(..).pathname` gir `/C:/...` på Windows, så main() kjørte aldri og verktøyet
// avsluttet med exit 0 uten å ha gjort noe (falsk grønn restore-verifisering).
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`[jarvis-backup] FAILED: ${String(err.message).slice(0, 400)}`);
    process.exitCode = 1;
  });
}
