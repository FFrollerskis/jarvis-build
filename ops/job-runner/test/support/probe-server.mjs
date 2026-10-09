import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

/**
 * Hjelper for credential-scope-tester. Kjøres som EGEN barneprosess (ikke i vitest-prosessen): i dette sandbox-miljøet når ikke
 * en git-underprosess en loopback-socket som vitest-prosessen selv åpnet, men den når en socket i en separat prosess.
 *
 * Oppførsel (styres av første sti-segment):
 *   /challenge/...  -> 401 + `WWW-Authenticate: Basic` (får git til å spørre credential-helperen)
 *   /redirect/<port>/... -> 302 til http://127.0.0.1:<port>/... (credential skal ALDRI følge en redirect)
 *   alt annet       -> 403
 * Hver forespørsel logges som en JSON-linje på stdout: {port, path, auth: true|false}. `auth` er true KUN hvis klienten sendte
 * en Authorization-header - det er nøyaktig det testene må kunne observere («ble credentialen sendt hit?»).
 */

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "serve") {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    process.stdout.write(`${JSON.stringify({ port: server.address().port, path: url.split("?")[0], auth: typeof req.headers.authorization === "string" })}\n`);
    const redirect = /^\/redirect\/(\d+)(\/.*)?$/.exec(url);
    if (redirect) {
      res.writeHead(302, { location: `http://127.0.0.1:${redirect[1]}${redirect[2] ?? "/"}` });
      return res.end();
    }
    if (url.startsWith("/challenge/") && typeof req.headers.authorization !== "string") {
      res.writeHead(401, { "www-authenticate": 'Basic realm="probe"' });
      return res.end();
    }
    res.writeHead(403);
    res.end("forbidden");
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(`${JSON.stringify({ listening: server.address().port })}\n`));
}

/** Starter en probe-server som barneprosess. @returns {Promise<{ port: number, requests: Array<{ port: number, path: string, auth: boolean }>, stop: () => void }>} */
export function startProbeServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], { stdio: ["ignore", "pipe", "inherit"] });
    const requests = [];
    let buffered = "";
    let port = 0;
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const msg = JSON.parse(line);
        if (msg.listening) { port = msg.listening; resolve({ port, requests, stop: () => child.kill() }); } else requests.push(msg);
      }
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("probe-server startet ikke")), 5_000).unref();
  });
}
