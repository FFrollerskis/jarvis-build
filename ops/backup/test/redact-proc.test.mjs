import { afterAll, describe, expect, it } from "vitest";
import { minimalEnv, runProcess } from "../lib/proc.mjs";
import { makeRedactor, secretValuesFrom } from "../lib/redact.mjs";
import { cleanupTempDirs } from "./helpers.mjs";

afterAll(cleanupTempDirs);

describe("WP-C2 redact: ingen hemmelighet i status, logg eller feilmelding", () => {
  const env = {
    JARVIS_DB_ADMIN_PASSWORD: "pg-admin-Passw0rd-xyz",
    JARVIS_SCRATCH_DB_PASSWORD: "scratch-pw-123456",
    JARVIS_BACKUP_HEARTBEAT_URL: "https://hc-ping.example/not-real-not-real-not-real",
    RCLONE_CONFIG_PASS: "rclone-config-pass",
    JARVIS_BACKUP_AGE_RECIPIENT: "age1publickeyisnotsecretpublickeyisnotsecretpublickeyisnotsecret",
    JARVIS_ENV: "production"
  };
  const redact = makeRedactor(env);

  it("kjente hemmeligheter fra miljøet fjernes bokstavelig - også delen av en heartbeat-URL som er nøkkelen", () => {
    const msg = redact(`pg_dump: connection to server failed: password authentication failed (PGPASSWORD=${env.JARVIS_DB_ADMIN_PASSWORD}) ping not-real-not-real-not-real rclone ${env.RCLONE_CONFIG_PASS}`);
    for (const secret of [env.JARVIS_DB_ADMIN_PASSWORD, "not-real-not-real-not-real", env.RCLONE_CONFIG_PASS]) expect(msg).not.toContain(secret);
    expect(msg).toContain("password authentication failed"); // diagnostisk tekst beholdes
  });

  it("mønstre fjernes uansett opprinnelse: URL-er, age-privatnøkler, passord=..., bearer-tokens", () => {
    const msg = redact("GET https://user:pw@host.example/secret/path?token=abc failed; AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ; password: hunter2 Authorization: Bearer abcdef.ghi");
    expect(msg).not.toMatch(/host\.example|hunter2|AGE-SECRET-KEY|abcdef\.ghi|token=abc/);
    expect(msg).toContain("<url>");
    expect(msg).toContain("<age-secret>");
  });

  it("offentlige og ikke-hemmelige verdier regnes ikke som hemmeligheter (kun navnemønsteret avgjør)", () => {
    const values = secretValuesFrom(env);
    expect(values).toContain(env.JARVIS_DB_ADMIN_PASSWORD);
    expect(values).not.toContain(env.JARVIS_BACKUP_AGE_RECIPIENT);
    expect(values).not.toContain("production");
  });

  it("alltid én linje, uten kontrolltegn, avkortet", () => {
    const msg = redact(`linje1\nlinje2\u0000\u001b[31mrød${"x".repeat(1000)}`, 120);
    // eslint-disable-next-line no-control-regex
    expect(msg).not.toMatch(/[\n\u0000\u001b]/);
    expect(msg.length).toBeLessThanOrEqual(120);
  });

  it("korte verdier (< 8 tegn) brukes ikke som søkestreng (ville ødelagt vanlig tekst)", () => {
    expect(secretValuesFrom({ SOME_PASSWORD: "abc" })).toEqual([]);
  });
});

describe("WP-C2 proc: underprosesser uten shell, med tidsavbrudd og minimalt miljø", () => {
  it("minimalEnv slipper aldri DB-passord eller andre JARVIS_*-hemmeligheter gjennom, men beholder PATH/HOME og RCLONE_*", () => {
    const env = minimalEnv({ EXTRA: "ja" }, {
      PATH: "/usr/bin", HOME: "/home/x", JARVIS_DB_ADMIN_PASSWORD: "hemmelig", JARVIS_BACKUP_AGE_RECIPIENT: "age1x", RCLONE_CONFIG_PASS: "rc", ANTHROPIC_API_KEY: "sk", SSH_AUTH_SOCK: "/tmp/agent"
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", RCLONE_CONFIG_PASS: "rc", EXTRA: "ja" });
  });

  it("kjører argv uten shell: metategn i argumentene tolkes ikke", async () => {
    const res = await runProcess(process.execPath, ["-e", "process.stdout.write(process.argv.slice(1).join('|'))", "a;b", "$(id)", "`id`", "&&", "x y"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("a;b|$(id)|`id`|&&|x y");
  });

  it("tidsavbrudd dreper prosessen og rapporterer timedOut", async () => {
    const t0 = Date.now();
    const res = await runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("review F4: en prosess som ikke dør av SIGKILL (hengt I/O) gir opp etter fristen i stedet for å henge tikket for alltid", async () => {
    const kills = [];
    const t0 = Date.now();
    const res = await runProcess("sleep", ["30"], { timeoutMs: 100, killGraceMs: 50, abandonGraceMs: 100, kill: (child, signal) => kills.push({ pid: child.pid, signal }) });
    expect(res).toMatchObject({ timedOut: true, code: null });
    expect(kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - t0).toBeLessThan(5000);
    process.kill(-kills[0].pid, "SIGKILL"); // rydd opp den «ukillbare» prosessen testen lot stå igjen
  });

  it("en prosess som dør ved SIGTERM avslutter som før (ingen ekstra ventetid)", async () => {
    const t0 = Date.now();
    const res = await runProcess("sleep", ["30"], { timeoutMs: 100, killGraceMs: 5_000, abandonGraceMs: 10_000 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("manglende binær gir spawnError i stedet for et kast", async () => {
    const res = await runProcess("finnes-ikke-wpc2-xyz", []);
    expect(res.spawnError).toBe("ENOENT");
    expect(res.code).toBeNull();
  });

  it("utdata er begrenset (en løpsk prosess fyller ikke minnet)", async () => {
    const res = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(200000))"], { maxStdout: 1000 });
    expect(res.stdout.length).toBeLessThanOrEqual(1000);
    expect(res.truncated).toBe(true);
  });

  it("stdin-input leveres (brukes til å kryptere manifestet)", async () => {
    const res = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: Buffer.from("manifest-bytes") });
    expect(res.stdout).toBe("manifest-bytes");
  });
});
