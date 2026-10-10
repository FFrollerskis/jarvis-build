import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * WP-C1: en LITEN falsk Docker Engine API over Unix-socket, så den EKTE `docker`-CLI-en (uten daemon) kan kjøres mot den og vi kan lese NØYAKTIG det klienten sender til
 * daemonen. Fake-docker-testene (`fake-docker.mjs`) beviser hva runneren SENDER til `docker`; `docker-cli-argv.test.mjs` beviser at den ekte CLI-en PARSER flaggene; denne fyller
 * hullet imellom: hvilken containerkonfigurasjon den ekte CLI-en gjør flaggene OM TIL (privileged, cap-drop, mounts, minne, nettverk, env ...), slik daemonen ville fått den.
 *
 * Dekker KUN det runneren bruker: ping, versjon, nettverksinspeksjon, container create/start/inspect/list/delete og exec-opprettelse. `exec/<id>/start` krever en kapret
 * (hijacked) forbindelse og er IKKE emulert (svarer 500, så `docker exec` avslutter med feil ETTER at exec-konfigurasjonen er mottatt og lagret). Dette er IKKE bevis for at en ekte
 * daemon isolerer containeren - det er `ops/job-runner/acceptance.sh` på verten.
 */

const API_VERSION = "1.50";

/** @param {{ networkName?: string, internal?: boolean }} [options] */
export async function startFakeEngine(options = {}) {
  const networkName = options.networkName ?? "jarvis-jobs";
  const dir = await mkdtemp(join(tmpdir(), "jr-engine-"));
  const socketPath = join(dir, "docker.sock");
  const state = { internal: options.internal ?? true };
  /** @type {Array<{ method: string, path: string, query: URLSearchParams, body: any, rawBody: string }>} */
  const requests = [];
  /** @type {Map<string, { id: string, name: string, config: any, running: boolean }>} */
  const containers = new Map();
  let execSeq = 0;
  /** @type {Map<string, { container: string, config: any }>} */
  const execs = new Map();

  /** @param {http.ServerResponse} res @param {number} status @param {unknown} [json] */
  const reply = (res, status, json) => {
    if (json === undefined) {
      res.writeHead(status, { "Content-Length": "0" });
      res.end();
      return;
    }
    const text = JSON.stringify(json);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://engine");
      const path = url.pathname.replace(/^\/v[0-9.]+/, "");
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body;
      try { body = rawBody.length > 0 ? JSON.parse(rawBody) : undefined; } catch { body = undefined; }
      requests.push({ method: req.method ?? "", path, query: url.searchParams, body, rawBody });
      const method = req.method ?? "";

      if (path === "/_ping") {
        res.writeHead(200, { "Api-Version": API_VERSION, "Docker-Experimental": "false", OSType: "linux", "Content-Type": "text/plain", "Content-Length": "2" });
        res.end(method === "HEAD" ? undefined : "OK");
        return;
      }
      if (method === "GET" && path === "/version") {
        return reply(res, 200, { Version: "27.3.1", ApiVersion: API_VERSION, MinAPIVersion: "1.24", Os: "linux", Arch: "amd64", KernelVersion: "6.1.0", GoVersion: "go1.22", GitCommit: "fake", Components: [] });
      }
      let m = /^\/networks\/([^/]+)$/.exec(path);
      if (method === "GET" && m) {
        if (decodeURIComponent(m[1] ?? "") !== networkName) return reply(res, 404, { message: `network ${m[1]} not found` });
        return reply(res, 200, { Name: networkName, Id: "net0123456789ab", Driver: "bridge", Internal: state.internal, Scope: "local", Options: {}, IPAM: { Config: [] }, Containers: {} });
      }
      if (method === "POST" && path === "/containers/create") {
        const name = url.searchParams.get("name") ?? "";
        const id = `${String(containers.size + 1).padStart(2, "0")}${"ab".repeat(31)}`;
        containers.set(name, { id, name, config: body, running: false });
        return reply(res, 201, { Id: id, Warnings: [] });
      }
      m = /^\/containers\/([^/]+)\/start$/.exec(path);
      if (method === "POST" && m) {
        const c = containers.get(decodeURIComponent(m[1] ?? ""));
        if (!c) return reply(res, 404, { message: `No such container: ${m[1]}` });
        c.running = true;
        return reply(res, 204);
      }
      m = /^\/containers\/([^/]+)\/json$/.exec(path);
      if (method === "GET" && m) {
        const c = containers.get(decodeURIComponent(m[1] ?? ""));
        if (!c) return reply(res, 404, { message: `No such container: ${m[1]}` });
        return reply(res, 200, { Id: c.id, Name: `/${c.name}`, State: { Running: c.running, Paused: false, Restarting: false, Status: c.running ? "running" : "created" }, Config: { Tty: false, ...(c.config ?? {}) }, HostConfig: c.config?.HostConfig ?? {}, NetworkSettings: {} });
      }
      m = /^\/containers\/([^/]+)\/exec$/.exec(path);
      if (method === "POST" && m) {
        const c = containers.get(decodeURIComponent(m[1] ?? ""));
        if (!c) return reply(res, 404, { message: `No such container: ${m[1]}` });
        execSeq += 1;
        const id = `exec${execSeq}`;
        execs.set(id, { container: c.name, config: body });
        return reply(res, 201, { Id: id });
      }
      if (method === "POST" && /^\/exec\/[^/]+\/start$/.test(path)) return reply(res, 500, { message: "fake engine: exec/start (hijack) er ikke emulert" });
      m = /^\/containers\/([^/]+)$/.exec(path);
      if (method === "DELETE" && m) {
        const key = decodeURIComponent(m[1] ?? "");
        if (!containers.has(key)) return reply(res, 404, { message: `No such container: ${key}` });
        containers.delete(key);
        return reply(res, 204);
      }
      if (method === "GET" && path === "/containers/json") {
        const filters = url.searchParams.get("filters") ?? "{}";
        let wanted = [];
        try { wanted = Object.keys(/** @type {Record<string, Record<string, boolean>>} */ (JSON.parse(filters))["label"] ?? {}); } catch { wanted = []; }
        const list = [...containers.values()]
          .filter((c) => wanted.every((w) => { const [k, v] = w.split("="); return (c.config?.Labels ?? {})[k ?? ""] === v; }))
          .map((c) => ({ Id: c.id, Names: [`/${c.name}`], Image: c.config?.Image ?? "", State: c.running ? "running" : "created", Status: "", Labels: c.config?.Labels ?? {}, Created: 0, Command: "", Ports: [], Mounts: [] }));
        return reply(res, 200, list);
      }
      reply(res, 500, { message: `fake engine: ikke implementert: ${method} ${path}` });
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve(undefined)); });

  return {
    socketPath, requests, containers, execs, state,
    /** Alle forespørsler som matcher metode + stiregex. @param {string} method @param {RegExp} pattern */
    find: (method, pattern) => requests.filter((r) => r.method === method && pattern.test(r.path)),
    async stop() {
      await new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); });
      await rm(dir, { recursive: true, force: true });
    }
  };
}
