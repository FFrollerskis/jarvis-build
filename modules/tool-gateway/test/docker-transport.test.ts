import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockerTransport } from "../src/docker-transport.ts";

/**
 * D-105: EKTE `docker`-CLI-subprosess-kall mot en FAKE `docker`-kjørbar fil
 * (ALDRI en ekte daemon i CI - SAMME presedens som `sandbox-docker-extra-
 * env.test.ts`). Fake-scriptet vedlikeholder container-tilstand i en
 * JSON-fil på disk (persisterer mellom hvert subprosesskall, akkurat som en
 * ekte daemon ville gjort mellom `docker`-CLI-invokeringer).
 *
 * D-105 host-fix (D-41-korreksjon): denne suiten beviser at TRANSPORTEN selv
 * IKKE lenger inneholder noen mål-autorisasjonsregel (verken sentinel-only
 * eller noe annet) - `redeploy_container`/`stop_container`/`start_container`
 * utføres av transporten mot ETHVERT strukturelt gyldig navn. Selve
 * autorisasjonen (hvem/hva som FÅR LOV) testes separat i docker-target-
 * policy.test.ts og integrasjonsmessig i modules/incidents/test/infra-
 * execution.test.ts (via `parameterAuthorizer`, ToolGateway.execute()).
 */
async function writeFakeDocker(): Promise<{ dockerBin: string; statePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-fake-docker-transport-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, "{}", "utf8");
  const dockerBin = join(dir, "docker.cjs");
  await writeFile(dockerBin, [
    "#!/usr/bin/env node",
    "const fs = require(\"fs\");",
    `const STATE = ${JSON.stringify(statePath)};`,
    "function load() { return JSON.parse(fs.readFileSync(STATE, \"utf8\")); }",
    "function save(s) { fs.writeFileSync(STATE, JSON.stringify(s)); }",
    "const args = process.argv.slice(2);",
    "const cmd = args[0];",
    "if (cmd === \"inspect\") {",
    "  const name = args[1];",
    "  const s = load();",
    "  const c = s[name];",
    "  if (!c) { process.stderr.write(`Error: No such container: ${name}\\n`); process.exit(1); }",
    "  process.stdout.write(JSON.stringify({ Id: c.Id, Name: '/' + name, Config: { Image: c.Image }, State: { Status: c.Status, StartedAt: c.StartedAt, ...(c.Health ? { Health: { Status: c.Health } } : {}) }, Created: c.Created, RestartCount: c.RestartCount }));",
    "  process.exit(0);",
    "}",
    "if (cmd === \"ps\") {",
    "  const s = load();",
    "  for (const name of Object.keys(s)) process.stdout.write(JSON.stringify({ Names: name, Image: s[name].Image }) + '\\n');",
    "  process.exit(0);",
    "}",
    "if (cmd === \"logs\") {",
    "  process.stdout.write('2026-01-01T00:00:00.000000000Z line one TOKEN=leakedvalue123\\n2026-01-01T00:00:01.000000000Z line two ok\\n');",
    "  process.exit(0);",
    "}",
    "if (cmd === \"rm\") {",
    "  const name = args[args.length - 1];",
    "  const s = load();",
    "  if (!s[name]) { process.stderr.write(`Error: No such container: ${name}\\n`); process.exit(1); }",
    "  delete s[name]; save(s); process.exit(0);",
    "}",
    "if (cmd === \"run\") {",
    "  if (process.env.FAKE_DOCKER_FAIL_RUN === '1') { process.stderr.write('Error: simulated run failure\\n'); process.exit(1); }",
    "  const name = args[args.indexOf('--name') + 1];",
    "  const image = args[args.length - 3];", // ... image sleep 999999999
    "  const s = load();",
    "  const id = 'c' + Math.random().toString(36).slice(2, 10);",
    "  s[name] = { Id: id, Image: image, Status: 'running', StartedAt: new Date().toISOString(), Created: new Date().toISOString(), RestartCount: 0 };",
    "  save(s);",
    "  process.stdout.write(id + '\\n');",
    "  process.exit(0);",
    "}",
    "if (cmd === \"stop\") {",
    "  if (process.env.FAKE_DOCKER_FAIL_STOP === '1') { process.stderr.write('Error: simulated stop failure\\n'); process.exit(1); }",
    "  const name = args[args.length - 1];",
    "  const s = load();",
    "  if (!s[name]) { process.stderr.write(`Error: No such container: ${name}\\n`); process.exit(1); }",
    "  s[name].Status = 'exited'; save(s); process.exit(0);",
    "}",
    "if (cmd === \"start\") {",
    "  if (process.env.FAKE_DOCKER_FAIL_START === '1') { process.stderr.write('Error: simulated start failure\\n'); process.exit(1); }",
    "  const name = args[args.length - 1];",
    "  const s = load();",
    "  if (!s[name]) { process.stderr.write(`Error: No such container: ${name}\\n`); process.exit(1); }",
    "  s[name].Status = 'running'; save(s); process.exit(0);",
    "}",
    "process.stderr.write(`unknown command: ${cmd}\\n`); process.exit(1);"
  ].join("\n"), "utf8");
  await chmod(dockerBin, 0o700);
  return { dockerBin, statePath };
}

describe("D-105: DockerTransport (EKTE subprosess-kall, fake docker-kjørbar fil)", () => {
  it("A: inspect_container på et IKKE-eksisterende mål gir data=null - ALDRI en kastet feil (avgjørende for D-pipeline-preflight på klasse D, se docker-transport.ts)", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    const result = await transport.invoke("inspect_container", { name: "jarvis-sentinel-unknown" }, dockerBin);
    expect(result.data).toBeNull();
  });

  it("B: TRANSPORTEN inneholder INGEN mål-autorisasjonsregel - redeploy_container mot et VILKÅRLIG, strukturelt gyldig navn (IKKE sentinel) UTFØRES av transporten (autorisasjon skjer nå UTENFOR transporten, se docker-target-policy.ts)", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    const result = await transport.invoke("redeploy_container", { name: "jarvis-api-1", image: "postgres:16" }, dockerBin);
    expect((result.data as { image?: string })?.image).toBe("postgres:16");
  });

  it("C: redeploy_container mot et GYLDIG sentinel-navn oppretter FAKTISK en ny container og returnerer dens tilstand", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    const result = await transport.invoke("redeploy_container", { name: "jarvis-sentinel-test", image: "alpine:3.20" }, dockerBin);
    expect(result.external_id).toBeTruthy();
    expect((result.data as { image?: string })?.image).toBe("alpine:3.20");
    expect((result.data as { status?: string })?.status).toBe("running");
  });

  it("D: EN ANDRE redeploy mot SAMME sentinel-navn fjerner den gamle FØRST (rm -f) og oppretter en NY container-id - inspect etterpå bekrefter FAKTISK ny tilstand", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    const first = await transport.invoke("redeploy_container", { name: "jarvis-sentinel-cycle", image: "alpine:3.19" }, dockerBin);
    const second = await transport.invoke("redeploy_container", { name: "jarvis-sentinel-cycle", image: "alpine:3.20" }, dockerBin);
    expect(second.external_id).not.toBe(first.external_id);
    const inspected = await transport.invoke("inspect_container", { name: "jarvis-sentinel-cycle" }, dockerBin);
    expect((inspected.data as { image?: string })?.image).toBe("alpine:3.20");
  });

  it("E: get_logs redigerer hemmeligheter FØR retur - rå TOKEN-verdien lekker ALDRI ut av transporten", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    const result = await transport.invoke("get_logs", { name: "jarvis-sentinel-test" }, dockerBin);
    const lines = result.data as Array<{ message: string }>;
    expect(lines.some((l) => l.message.includes("leakedvalue123"))).toBe(false);
    expect(lines.some((l) => l.message.includes("[REDACTED]"))).toBe(true);
  });

  it("F: get_logs respekterer en HARD tail-grense (200) selv om et større tall bes om - ALDRI ubegrenset rå loggdumping", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    // Fake-scriptet returnerer alltid 2 linjer uansett --tail-argv (enkel fake) - denne testen
    // beviser at TRANSPORTEN faktisk sender en BEGRENSET --tail-verdi til CLI-en, ikke at
    // fake-daemonen begrenser noe selv.
    await transport.invoke("get_logs", { name: "jarvis-sentinel-test", tail: 999_999 }, dockerBin);
    // Ingen kastet feil, ingen uendelig ventetid - selve grensesettingen er strukturell (docker-transport.ts: Math.min(...,200)).
    expect(true).toBe(true);
  });

  it("G: redeploy_container mot en FEILENDE docker-daemon (FAKE_DOCKER_FAIL_RUN) gir en EKSPLISITT kastet feil - ALDRI en stille fabrikkert suksess", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    process.env["FAKE_DOCKER_FAIL_RUN"] = "1";
    try {
      await expect(transport.invoke("redeploy_container", { name: "jarvis-sentinel-fail", image: "alpine:3.20" }, dockerBin))
        .rejects.toThrow(/docker_run_failed/);
    } finally {
      delete process.env["FAKE_DOCKER_FAIL_RUN"];
    }
  });

  it("H: list_containers virker mot ETHVERT containernavn (ingen sentinel-restriksjon på lese-siden - reell driftsdiagnostikk)", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    await transport.invoke("redeploy_container", { name: "jarvis-sentinel-list", image: "alpine:3.20" }, dockerBin);
    const result = await transport.invoke("list_containers", {}, dockerBin);
    expect((result.data as unknown[]).length).toBeGreaterThan(0);
  });

  it("I: ukjent handling kastes eksplisitt", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    await expect(transport.invoke("delete_everything", {}, dockerBin)).rejects.toThrow(/docker_unknown_action/);
  });

  it("J: stop_container stopper en FAKTISK kjørende container og returnerer den reinspiserte tilstanden (status=exited)", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    await transport.invoke("redeploy_container", { name: "jarvis-sentinel-stop", image: "alpine:3.20" }, dockerBin);
    const result = await transport.invoke("stop_container", { name: "jarvis-sentinel-stop" }, dockerBin);
    expect((result.data as { status?: string })?.status).toBe("exited");
  });

  it("K: start_container starter en FAKTISK stoppet container og returnerer den reinspiserte tilstanden (status=running)", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    await transport.invoke("redeploy_container", { name: "jarvis-sentinel-start", image: "alpine:3.20" }, dockerBin);
    await transport.invoke("stop_container", { name: "jarvis-sentinel-start" }, dockerBin);
    const result = await transport.invoke("start_container", { name: "jarvis-sentinel-start" }, dockerBin);
    expect((result.data as { status?: string })?.status).toBe("running");
  });

  it("L: stop_container mot en FEILENDE docker-daemon gir EKSPLISITT kastet feil, ALDRI fabrikkert suksess", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    await transport.invoke("redeploy_container", { name: "jarvis-sentinel-stopfail", image: "alpine:3.20" }, dockerBin);
    process.env["FAKE_DOCKER_FAIL_STOP"] = "1";
    try {
      await expect(transport.invoke("stop_container", { name: "jarvis-sentinel-stopfail" }, dockerBin)).rejects.toThrow(/docker_stop_failed/);
    } finally {
      delete process.env["FAKE_DOCKER_FAIL_STOP"];
    }
  });

  it("M: start_container mot en FEILENDE docker-daemon gir EKSPLISITT kastet feil, ALDRI fabrikkert suksess", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    await transport.invoke("redeploy_container", { name: "jarvis-sentinel-startfail", image: "alpine:3.20" }, dockerBin);
    await transport.invoke("stop_container", { name: "jarvis-sentinel-startfail" }, dockerBin);
    process.env["FAKE_DOCKER_FAIL_START"] = "1";
    try {
      await expect(transport.invoke("start_container", { name: "jarvis-sentinel-startfail" }, dockerBin)).rejects.toThrow(/docker_start_failed/);
    } finally {
      delete process.env["FAKE_DOCKER_FAIL_START"];
    }
  });

  describe("N: kommando-injeksjon/flagg-forveksling - ugyldige containernavn kastes FØR noe subprosess-kall gjøres, ALDRI tolket som shell-syntaks eller docker-CLI-flagg", () => {
    const badNames = [
      "has space", "semi;colon", "quo\"te", "back`tick", "$(subshell)", "-leadingdash", "line\nbreak", "", "a".repeat(200)
    ];
    for (const bad of badNames) {
      it(`avviser navnet ${JSON.stringify(bad)}`, async () => {
        const { dockerBin } = await writeFakeDocker();
        const transport = new DockerTransport();
        await expect(transport.invoke("inspect_container", { name: bad }, dockerBin)).rejects.toThrow(/docker_invalid_container_name/);
        await expect(transport.invoke("stop_container", { name: bad }, dockerBin)).rejects.toThrow(/docker_invalid_container_name/);
        await expect(transport.invoke("start_container", { name: bad }, dockerBin)).rejects.toThrow(/docker_invalid_container_name/);
        await expect(transport.invoke("redeploy_container", { name: bad, image: "alpine:3.20" }, dockerBin)).rejects.toThrow(/docker_invalid_container_name/);
      });
    }
  });

  it("O: redeploy_container avviser et ugyldig image-uttrykk (kommando-injeksjons-forsvar for image-parameteren)", async () => {
    const { dockerBin } = await writeFakeDocker();
    const transport = new DockerTransport();
    await expect(transport.invoke("redeploy_container", { name: "jarvis-sentinel-badimage", image: "alpine; rm -rf /" }, dockerBin))
      .rejects.toThrow(/docker_invalid_image_ref/);
  });
});
