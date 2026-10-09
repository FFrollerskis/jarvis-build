import { createHarness } from "./harness.mjs";

/**
 * Starter den EKTE vertstjenesten (fake docker, ekte git mot lokalt bare-repo) som en SEPARAT prosess. Brukes av tester der en
 * underprosess (bash/curl) skal snakke med tjenesten: i dette sandbox-miljøet når ikke en underprosess en socket som vitest-prosessen selv åpnet,
 * men den når en socket i en egen prosess. Skriver én JSON-linje med stier når den er klar; avslutter når stdin lukkes.
 */
const options = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const h = await createHarness(options);
process.stdout.write(`${JSON.stringify({
  ready: true, root: h.root, socketPath: h.socketPath, tokenFile: h.tokenFile, baseDir: h.baseDir,
  origins: Object.fromEntries(Object.entries(h.origins).map(([slug, o]) => [slug, o.dir])),
  gitTokenFiles: Object.fromEntries(Object.entries(h.config.gitCredentials).filter(([, c]) => typeof c.tokenFile === "string").map(([slug, c]) => [slug, c.tokenFile])),
  requestTokenRepos: Object.entries(h.config.gitCredentials).filter(([, c]) => c.source === "request").map(([slug]) => slug)
})}\n`);
const stop = async () => { await h.close(); process.exit(0); };
process.stdin.resume();
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
