#!/usr/bin/env node
/**
 * WP-C1: git `credential.helper` for den vertsside runneren. Startes KUN av git (via `sh -c`), aldri av API-et.
 *
 *   credential.helper = !'<node>' '<dette skriptet>' '<protocol>' '<host>' '<owner/repo>'     (git legger til operasjonen: get|store|erase)
 *
 * Scopet (protokoll + vert + repo-sti) kommer som argv fra runneren (validert der) og token kun via prosess-env
 * (`JARVIS_GIT_CREDENTIAL_TOKEN`, satt av runneren på akkurat det ene git-kallet). Helperen svarer med credential KUN når git
 * ber om NØYAKTIG dette scopet: en fremmed vert, et annet repo eller en annen protokoll får ingenting (git feiler da lukket).
 * Speiler scope-logikken i modules/tasks/src/git-auth.ts (JARVIS-064). Ingen filskriving, ingen nettverk, ingen logging.
 */
const [protocol, host, scopePath, operation] = process.argv.slice(2);

if (operation !== "get") {
  // store/erase: Jarvis sin credential persisteres ALDRI av git. Drener stdin og avslutt stille.
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (input.length > 8192) process.exit(0); // aldri les ubegrenset
  });
  process.stdin.on("end", () => {
    /** @type {Record<string, string>} */
    const req = {};
    for (const line of input.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx > 0) req[line.slice(0, idx)] = line.slice(idx + 1);
    }
    const path = String(req["path"] ?? "").replace(/^\/+/, "").replace(/\.git$/i, "").toLowerCase();
    const ok = typeof protocol === "string" && typeof host === "string" && typeof scopePath === "string"
      && req["protocol"] === protocol
      && String(req["host"] ?? "").toLowerCase() === host.toLowerCase()
      && path === scopePath.toLowerCase();
    if (!ok) process.exit(0); // ingen svar = ingen credential til fremmed vert/repo
    const token = process.env["JARVIS_GIT_CREDENTIAL_TOKEN"] ?? "";
    if (token.length === 0) process.exit(0); // aldri et tomt passord
    process.stdout.write("username=x-access-token\n");
    process.stdout.write(`password=${token}\n`);
  });
  process.stdin.on("error", () => process.exit(0));
}
