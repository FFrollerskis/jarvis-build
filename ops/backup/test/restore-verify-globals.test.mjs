import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256File } from "../lib/backup.mjs";
import { GLOBALS_MAX_BYTES, sanitizeGlobals } from "../lib/globals-filter.mjs";
import { runRestoreVerify } from "../lib/restore-verify.mjs";
import { findBinary } from "../lib/tools.mjs";
import { REAL_GLOBALS_DUMP, cleanupTempDirs, fakeScratchRunner, makeSet, tempDir } from "./helpers.mjs";

afterAll(cleanupTempDirs);
const WHEN = new Date("2026-10-09T02:00:00.000Z");
const haveAge = findBinary("age") !== undefined && findBinary("age-keygen") !== undefined;

/**
 * Review F2 mot den ekte kodeveien: ekte `age` krypterer en (ondsinnet eller ekte) globals.sql som er KONSISTENT mot sitt eget manifest (sjekksummen stemmer - age er ikke
 * autentisert, så det beviser ingenting om hvem som laget den). Scratch-serveren er en falsk psql-klient som logger hva som faktisk ble matet til `psql -f -`.
 * Mot en EKTE psql (positiv kontroll: `\! kommando` kjører faktisk) ligger regresjonstesten i modules/core/test/remediation-1-backup-restore.test.ts.
 */
describe.skipIf(!haveAge)("WP-C2 review F2: runRestoreVerify gir psql kun FILTRERT globals.sql", () => {
  let work;
  let identity;
  let recipient;
  beforeAll(() => {
    work = tempDir("wpc2-glob-");
    identity = join(work, "identity.txt");
    execFileSync(findBinary("age-keygen"), ["-o", identity], { stdio: "pipe" });
    recipient = readFileSync(identity, "utf8").match(/public key: (age1\S+)/)[1];
  });

  const encrypt = (text) => {
    const file = join(tempDir("wpc2-enc-"), "x.age");
    execFileSync(findBinary("age"), ["-r", recipient, "-o", file], { input: text });
    return file;
  };
  async function setWithGlobals(text) {
    const set = makeSet(tempDir(), WHEN);
    writeFileSync(join(set.dir, "globals.sql.age"), readFileSync(encrypt(text)));
    set.manifest.globals.sha256 = await sha256File(join(set.dir, "globals.sql.age"));
    writeFileSync(join(set.dir, "manifest.json"), JSON.stringify(set.manifest));
    return set;
  }
  const verify = (set, scratch) => runRestoreVerify({ setDir: set.dir, identityFile: identity, scratchRunner: scratch.runner, now: WHEN });

  it("ondsinnet globals.sql: metakommandoer og SQL utenfor whitelisten stopper på trinn `globals` - psql får ALDRI teksten, og ingenting skrives til scratch", async () => {
    const marker = join(tempDir("wpc2-marker-"), "pwned");
    const hostile = [
      `\\! touch ${marker}\n`,
      `CREATE ROLE a;\n\\! touch ${marker}\n`,
      `CREATE ROLE a; \\! touch ${marker}\n`,
      `\\restrict abc\n\\! touch ${marker}\n\\unrestrict abc\n`,
      `\\o |touch ${marker}\nSELECT 1;\n`,
      `\\copy (select 1) to program 'touch ${marker}'\n`,
      `COPY (SELECT 1) TO PROGRAM 'touch ${marker}';\n`,
      `DO $$ BEGIN PERFORM 1; END $$;\n`,
      `CREATE ROLE a;\nDROP ROLE postgres;\n`
    ];
    for (const text of hostile) {
      const set = await setWithGlobals(text);
      const scratch = fakeScratchRunner();
      const report = await verify(set, scratch);
      expect(report, text).toMatchObject({ ok: false, stage: "globals" });
      expect(report.error).toContain("globals.sql nektes");
      expect(JSON.stringify(report)).not.toContain(marker);
      expect(scratch.writes(), text).toEqual([]); // ikke engang et psql -f - uten innhold
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("ekte globals.sql: psql får den GJENOPPBYGDE teksten (uten \\restrict og uten passord-hasher), deretter databasene; rapporten teller setninger og fjernede passord", async () => {
    const set = await setWithGlobals(REAL_GLOBALS_DUMP);
    const scratch = fakeScratchRunner();
    const report = await verify(set, scratch);
    // dumpene i denne testen er ikke ekte age-filer, så restoren stopper først på selve databasen - ETTER at roller og CREATE DATABASE er kjørt
    expect(report).toMatchObject({ ok: false, stage: "restore", globals: { statements: 14, passwords_stripped: 1, login_role_statements_skipped: 2 } });
    const [script, create] = scratch.writes();
    expect(script.tool).toBe("psql");
    expect(script.stdin).toBe(sanitizeGlobals(REAL_GLOBALS_DUMP).sql);
    expect(script.stdin).not.toMatch(/\\|restrict|PASSWORD|SCRAM|not-real/i);
    expect(script.stdin).toContain("CREATE ROLE jarvis_app;");
    expect(script.stdin).not.toMatch(/ROLE postgres/); // innloggingsrollen (fake-runneren har ingen `user` => standard postgres) røres aldri (runde 2 M1)
    expect(create.sql).toMatch(/^CREATE DATABASE "restore_verify_jarvis_20261009t020000z"$/);
  });

  it("feil privatnøkkel: age-feil på trinn restore, aldri en stille suksess, og psql får ingenting", async () => {
    const set = await setWithGlobals("CREATE ROLE a;\n");
    const other = join(work, "other.txt");
    execFileSync(findBinary("age-keygen"), ["-o", other], { stdio: "pipe" });
    const scratch = fakeScratchRunner();
    const report = await runRestoreVerify({ setDir: set.dir, identityFile: other, scratchRunner: scratch.runner, now: WHEN });
    expect(report).toMatchObject({ ok: false, stage: "restore" });
    expect(scratch.writes()).toEqual([]);
  });

  it("en dekryptert globals.sql over størrelsesgrensen stoppes underveis (age drepes) - minnet fylles ikke av en dekompresjonsbombe-lignende fil", async () => {
    const set = await setWithGlobals(`-- ${"x".repeat(GLOBALS_MAX_BYTES + 1024)}\nCREATE ROLE a;\n`);
    const scratch = fakeScratchRunner();
    const report = await verify(set, scratch);
    expect(report).toMatchObject({ ok: false, stage: "globals" });
    expect(report.error).toContain("for stor");
    expect(scratch.writes()).toEqual([]);
  });
});
