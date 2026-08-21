import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * D-103 HOST-FIX: en ekte, minimal git smart-HTTP-server (bygget over git sin
 * EGEN `git http-backend` CGI-kommando) - IKKE en simulert/fake git-protokoll.
 * Eneste vei å BEVISE at git sin credential-oppløsning (ambient
 * `credential.helper` vs. eksplisitt `GIT_ASKPASS`) faktisk oppfører seg som
 * antatt, er å la EKTE `git clone`/`git push` faktisk forhandle Basic Auth
 * mot en server som gir en 401-utfordring - lokale bare-repo-filsti-kloner
 * (brukt i alle øvrige D-103-tester) trigger ALDRI credential-oppløsning i
 * det hele tatt (ingen autentisering er meningsfull for en lokal filsti), og
 * kunne derfor STRUKTURELT ALDRI bevise dette.
 *
 * VIKTIG IMPLEMENTASJONSDETALJ (oppdaget under bygging av denne testen):
 * serveren MÅ kjøre i en HELT SEPARAT `node`-BARNEPROSESS (spawnet via
 * `child_process.spawn`), ALDRI som en in-process `http.createServer()`
 * inne i selve vitest-testprosessen. Denne test-sandboxen blokkerer en
 * git/curl-underprosess fra å nå en loopback-socket som selve vitest-worker-
 * prosessen (som kjører testkoden) selv åpnet - empirisk bevist ved en
 * minimal probe (in-process server + `fetch()` fra SAMME prosess: fungerer;
 * SAMME server + en `curl`-underprosess: henger for alltid). En server startet
 * som en EGEN, SEPARAT barneprosess (samme "avstand" fra vitest-workeren som
 * selve git-underprosessen) ER derimot nåbar fra en annen underprosess -
 * dette er derfor IKKE en sandbox-begrensning på loopback-nettverk generelt,
 * kun på "vitest-workerens EGEN prosess som server-endepunkt for en
 * underprosess-klient".
 *
 * Utelukkende test-infrastruktur - ALDRI importert fra src/, ALDRI del av
 * produksjonskoden. Loopback-only (127.0.0.1, tilfeldig OS-tildelt port).
 */

interface AcceptedCredential {
  user: string;
  pass: string;
}

export interface GitSmartHttpServer {
  readonly reposRoot: string;
  /** Alle Basic-Auth-brukernavn serveren faktisk mottok, i kronologisk rekkefølge. */
  readonly authenticatedUsernames: string[];
  url(repoName: string): string;
  createBareRepo(repoName: string, opts?: { allowPush?: boolean }): void;
  close(): Promise<void>;
}

/**
 * Innholdet i barneprosess-server-skriptet. Skriver ÉN linje `AUTH:<user>`
 * til stdout for HVER autentiserte forespørsel den mottar - dette er den
 * ENESTE måten foreldreprosessen (vitest-testen) kan observere HVILKEN
 * identitet som faktisk ble brukt, siden serveren kjører i en annen prosess
 * og dermed ikke deler minne/lukking med testen.
 */
function serverScriptContent(): string {
  return `
import { spawn } from "node:child_process";
import http from "node:http";

const reposRoot = process.argv[2];
const accepted = JSON.parse(process.argv[3]);

function parseBasicAuth(header) {
  if (!header || !header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx === -1) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

function isAccepted(user, pass) {
  return accepted.some((c) => c.user === user && c.pass === pass);
}

const server = http.createServer((req, res) => {
  const auth = parseBasicAuth(req.headers.authorization);
  if (!auth || !isAccepted(auth.user, auth.pass)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="jarvis-test"' });
    res.end();
    return;
  }
  process.stdout.write("AUTH:" + auth.user + "\\n");
  const [pathPart, query = ""] = req.url.split("?");
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: reposRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(pathPart),
      QUERY_STRING: query,
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers["content-type"] || "",
      CONTENT_LENGTH: req.headers["content-length"] || "0",
      REMOTE_USER: auth.user,
      GATEWAY_INTERFACE: "CGI/1.1"
    }
  });
  req.pipe(child.stdin);
  let buf = Buffer.alloc(0);
  let headersParsed = false;
  child.stdout.on("data", (chunk) => {
    if (headersParsed) { res.write(chunk); return; }
    buf = Buffer.concat([buf, chunk]);
    const sepIdx = buf.indexOf("\\r\\n\\r\\n");
    const sepIdx2 = buf.indexOf("\\n\\n");
    const idx = sepIdx !== -1 ? sepIdx : sepIdx2;
    const sepLen = sepIdx !== -1 ? 4 : 2;
    if (idx !== -1) {
      const headerText = buf.slice(0, idx).toString("utf8");
      const body = buf.slice(idx + sepLen);
      const headers = {};
      let status = 200;
      for (const line of headerText.split(/\\r?\\n/)) {
        if (!line) continue;
        const ci = line.indexOf(":");
        const k = line.slice(0, ci).trim();
        const v = line.slice(ci + 1).trim();
        if (k.toLowerCase() === "status") status = parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      if (body.length) res.write(body);
      headersParsed = true;
    }
  });
  child.stdout.on("end", () => res.end());
  child.on("error", () => res.end());
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write("PORT:" + server.address().port + "\\n");
});
`;
}

export async function startGitSmartHttpServer(accepted: AcceptedCredential[]): Promise<GitSmartHttpServer> {
  const reposRoot = await mkdtemp(join(tmpdir(), "jarvis-git-smart-http-"));
  const scriptDir = await mkdtemp(join(tmpdir(), "jarvis-git-smart-http-script-"));
  const scriptPath = join(scriptDir, "server.mjs");
  await writeFile(scriptPath, serverScriptContent(), "utf8");

  const authenticatedUsernames: string[] = [];
  const child: ChildProcess = spawn(process.execPath, [scriptPath, reposRoot, JSON.stringify(accepted)], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (const line of buf.split("\n")) {
        const portMatch = /^PORT:(\d+)/.exec(line);
        if (portMatch) {
          resolve(parseInt(portMatch[1]!, 10));
          return;
        }
        const authMatch = /^AUTH:(.+)/.exec(line);
        if (authMatch) authenticatedUsernames.push(authMatch[1]!);
      }
    };
    child.stdout!.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`git-smart-http-server barneprosess avsluttet tidlig (kode ${code})`)));
    setTimeout(() => reject(new Error("timeout: fikk aldri PORT: fra git-smart-http-server barneprosessen")), 5_000);
  });

  // Fortsett å konsumere stdout for å fange AUTH:-linjer for RESTEN av serverens levetid.
  let tail = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    tail += chunk.toString("utf8");
    const lines = tail.split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) {
      const authMatch = /^AUTH:(.+)/.exec(line);
      if (authMatch) authenticatedUsernames.push(authMatch[1]!);
    }
  });

  return {
    reposRoot,
    authenticatedUsernames,
    url: (repoName: string) => `http://127.0.0.1:${port}/${repoName}`,
    createBareRepo: (repoName: string, opts = {}) => {
      const bareDir = join(reposRoot, repoName);
      const init = spawnSync("git", ["init", "--bare", "--initial-branch=main", repoName], { cwd: reposRoot, encoding: "utf8" });
      if (init.status !== 0) throw new Error(`git init --bare feilet: ${init.stderr}`);
      if (opts.allowPush !== false) {
        spawnSync("git", ["config", "http.receivepack", "true"], { cwd: bareDir, encoding: "utf8" });
      }
    },
    close: async () => {
      child.kill();
    }
  };
}
