import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * WP-C1 (test): en `git`-innpakning som runneren kjører i stedet for `/usr/bin/git` (via `runner.git_bin`, som er en vanlig konfignøkkel - ingen
 * produksjonskode er endret for dette). For HVERT git-kall runneren gjør, logges argv og - kun som en kort SHA-256-fingeravtrykk - hvilket
 * `JARVIS_GIT_CREDENTIAL_TOKEN` kallet fikk i miljøet (ingenting = `none`). Deretter kjøres den ekte git uendret.
 *
 * Det gjør to sikkerhetsegenskaper målbare ende-til-ende: (1) tokenet står ALDRI i argv (som er synlig for andre prosesser via /proc/<pid>/cmdline),
 * og (2) tokenet leveres KUN til de tre nettverkskallene (`ls-remote`, `fetch` mot remote, `push`) - aldri til init, lokal klone, fsck, rev-list o.l.
 */

/** @param {string} dir */
const quote = (dir) => `'${dir.replace(/'/g, "'\\''")}'`;

/** @returns {Promise<{ dir: string, gitBin: string, calls: () => Promise<Array<{ tokenHash: string | null, addressSpace: string, cwd: string, argv: string[], subcommand: string }>> }>} */
export async function createGitSpy() {
  const dir = await mkdtemp(join(tmpdir(), "jr-gitspy-"));
  const log = join(dir, "calls.log");
  const gitBin = join(dir, "git");
  await writeFile(log, "");
  await writeFile(gitBin, `#!/bin/sh
H=none
if [ -n "\${JARVIS_GIT_CREDENTIAL_TOKEN:-}" ]; then H=$(printf %s "$JARVIS_GIT_CREDENTIAL_TOKEN" | sha256sum | cut -c1-12); fi
A=$(awk '/Max address space/ { print $4 }' /proc/$$/limits)
{ printf 'T=%s\\tA=%s\\tC=%s' "$H" "$A" "$PWD"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> ${quote(log)}
exec /usr/bin/git "$@"
`);
  await chmod(gitBin, 0o755);
  return {
    dir,
    gitBin,
    async calls() {
      const text = await readFile(log, "utf8");
      return text.split("\n").filter((l) => l.startsWith("T=")).map((line) => {
        const [first = "T=none", second = "A=unlimited", third = "C=", ...argv] = line.split("\t");
        const tokenHash = first.slice(2) === "none" ? null : first.slice(2);
        const addressSpace = second.slice(2); // «unlimited» eller byte (RLIMIT_AS, målt i selve git-prosessen: prlimit setter den før exec)
        // delkommandoen = første argument som ikke er `-c <verdi>` eller `-C <sti>`
        let i = 0;
        while (i < argv.length && (argv[i] === "-c" || argv[i] === "-C")) i += 2;
        return { tokenHash, addressSpace, cwd: third.slice(2), argv, subcommand: argv[i] ?? "" };
      });
    }
  };
}
