import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary } from "../../../ops/backup/lib/tools.mjs";

/** D-370: `age` via Docker for hosts without age (NAS). Uses a stub `docker` - no daemon needed. */
const WRAPPER = resolve(__dirname, "../../../ops/backup/age-docker.sh");
let dir = "";
let env: NodeJS.ProcessEnv = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "age-docker-"));
  // Stub: `docker image inspect` ok; `docker run ... <image> <age args>` echoes its args to a log and
  // "encrypts" stdin by prefixing it.
  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env bash\nif [ "$1" = image ]; then exit 0; fi\necho "$*" >> "${dir}/calls.log"\nprintf 'ENC:'; cat\n`
  );
  chmodSync(join(dir, "docker"), 0o755);
  env = { ...process.env, PATH: `${dir}:${process.env["PATH"]}` };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("D-370 age-docker.sh", () => {
  it("-o FIL oversettes til stdout-omdirigering, filen er 0600, og containeren er isolert", () => {
    const out = join(dir, "x.age");
    const r = spawnSync(WRAPPER, ["-r", "age1abc", "-o", out], { input: "klartekst", env });
    expect(r.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("ENC:klartekst");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const call = readFileSync(join(dir, "calls.log"), "utf8");
    expect(call).toContain("--network none");
    expect(call).toContain("--cap-drop ALL");
    expect(call).toContain("--read-only");
    expect(call).toContain("-r age1abc");
    expect(call).not.toContain("-o ");
    expect(call).not.toContain("-v ");
  });

  it("dekryptering støttes ikke (privatnøkkelen skal aldri nær NAS-en)", () => {
    const r = spawnSync(WRAPPER, ["-d", "-i", "key.txt"], { input: "", env });
    expect(r.status).toBe(2);
    expect(String(r.stderr)).toContain("kun kryptering");
  });

  it("findBinary respekterer JARVIS_AGE_BIN kun for age og kun hvis filen finnes", () => {
    expect(findBinary("age", { ...env, JARVIS_AGE_BIN: WRAPPER })).toBe(WRAPPER);
    expect(findBinary("age", { PATH: "", JARVIS_AGE_BIN: "/finnes/ikke" })).toBeUndefined();
    expect(findBinary("pg_dump", { PATH: "", JARVIS_AGE_BIN: WRAPPER })).not.toBe(WRAPPER);
  });

  it("nas-backup.sh velger wrapperen når age mangler", () => {
    const sh = readFileSync(resolve(__dirname, "../../../ops/backup/nas-backup.sh"), "utf8");
    expect(sh).toContain("command -v age");
    expect(sh).toContain("age-docker.sh");
    execFileSync("bash", ["-n", WRAPPER]);
  });
});
