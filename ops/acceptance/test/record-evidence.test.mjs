import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTIONS, redact, sanitize } from "../record-evidence.mjs";

/**
 * WP-J (D-450): evidens-opptakeren. Testene beviser mekanikken (ingen skall, hemmeligheter redigeres bort, filer overskrives aldri, feil er også evidens) -
 * ikke at en ekte kjøring på NAS-en er riktig. Falske hemmeligheter bygges ved kjøring (ikke som bokstaver i filen), så gitleaks ikke flagger testen.
 */
const SCRIPT = resolve(fileURLToPath(new URL("../record-evidence.mjs", import.meta.url)));
const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "evidence-"));
  dirs.push(d);
  return d;
}
function run(args, opts = {}) {
  return spawnSync(process.execPath, [opts.script ?? SCRIPT, ...args], { encoding: "utf8", input: opts.input, timeout: 60_000, env: { ...process.env, ...(opts.env ?? {}) } });
}
/** Et eget git-repo for testen (arbeidstreet her kan være en worktree med gitdir utenfor, og git nekter «dubious ownership» på tvers av brukere). */
function tempRepo() {
  const dir = tmp();
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(dir, "f"), "x");
  git("add", "f");
  git("commit", "-q", "-m", "init");
  return { dir, sha: git("rev-parse", "HEAD").stdout.trim() };
}
function written(dir) {
  const files = readdirSync(dir);
  return files.length === 1 ? { name: files[0], text: readFileSync(join(dir, files[0]), "utf8") } : { name: "", text: "", files };
}
const fake = {
  ghp: () => ["gh", "p_"].join("") + "A1b2C3d4".repeat(5),
  pat: () => ["github", "_pat_"].join("") + "A1b2C3d4_".repeat(4),
  anthropic: () => ["sk", "-ant-"].join("") + "abcDEF123_".repeat(4),
  aws: () => ["AK", "IA"].join("") + "ABCDEFGHIJKLMNOP",
  slack: () => ["xo", "xb-"].join("") + "1234567890-abcdefghij",
  jwt: () => ["ey", "Jhbgcioij9"].join("") + "." + ["ey", "Jzdwiioixmjm0"].join("") + "." + "c2lnbmF0dXJl",
  pem: () => ["-----BEGIN ", "PRIVATE KEY-----"].join("") + "\nMIIEvQIBADANBgkq\nabc\n" + ["-----END ", "PRIVATE KEY-----"].join(""),
  age: () => ["AGE-SECRET", "-KEY-1"].join("") + "QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
  stripeLive: () => ["sk", "_live_"].join("") + "A1b2C3d4E5f6G7h8I9",
  stripeTest: () => ["sk", "_test_"].join("") + "A1b2C3d4E5f6G7h8I9",
  stripeRestricted: () => ["rk", "_live_"].join("") + "A1b2C3d4E5f6G7h8I9",
  stripeWebhook: () => ["wh", "sec_"].join("") + "A1b2C3d4E5f6G7h8I9",
  telegram: () => "123456789:" + ["AA", "E"].join("") + "_abcdefghijklmnopqrstuvwxyz012345",
  npm: () => ["np", "m_"].join("") + "abcdefghijklmnopqrstuvwxyz0123456789",
  vault: () => ["hv", "s."].join("") + "CAESIJlWPabcdefghijklmnopqrstu",
  infisical: () => ["s", "t."].join("") + "abcdef.0123456789abcdef.0123456789abcdef",
  hf: () => ["hf", "_"].join("") + "a1B2c3D4e5".repeat(4),
  groq: () => ["gs", "k_"].join("") + "a1B2c3D4e5".repeat(4),
  sendgrid: () => ["S", "G."].join("") + "a1B2c3D4e5f6G7h8" + "." + "i9J0k1L2m3N4o5P6",
  notion: () => ["sec", "ret_"].join("") + "a1B2c3D4e5".repeat(4),
  mailgun: () => ["ke", "y-"].join("") + "0123456789abcdef".repeat(2),
  googleOauth: () => ["ya", "29."].join("") + "a0Af".repeat(10),
  gocspx: () => ["GOC", "SPX-"].join("") + "a1B2c3D4e5".repeat(3),
  gitlab: () => ["glp", "at-"].join("") + "a1B2c3D4e5".repeat(2),
  skLong: () => ["sk", "-proj-"].join("") + "a1B2c3D4e5".repeat(25)
};

describe("redact()", () => {
  it("fjerner hver kjente hemmelighetsform og teller dem", () => {
    const samples = {
      github_token: fake.ghp(),
      github_pat: fake.pat(),
      anthropic_key: fake.anthropic(),
      aws_access_key: fake.aws(),
      slack_token: fake.slack(),
      jwt: fake.jwt(),
      pem_block: fake.pem(),
      age_secret: fake.age()
    };
    for (const [name, secret] of Object.entries(samples)) {
      const { text, counts } = redact(`før ${secret} etter`);
      expect(text, name).not.toContain(secret);
      expect(text, name).toContain("«REDIGERT»");
      expect(counts[name], name).toBe(1);
    }
  });

  it("redigerer Bearer, URL-credentials og nøkkel=verdi men lar vanlig tekst være", () => {
    const secret = "S3cr3t-" + "x".repeat(20);
    const { text } = redact(`Authorization: Bearer ${secret}\nDB=postgres://jarvis:${secret}@db:5432/jarvis\nJARVIS_API_TOKEN=${secret}\nPASSWORD: ${secret}\nstatus: ok, 12 tjenester, ingenting hemmelig`);
    expect(text).not.toContain(secret);
    expect(text).toContain("postgres://«REDIGERT»@db:5432/jarvis");
    expect(text).toContain("status: ok, 12 tjenester, ingenting hemmelig");
  });

  it("er lineær på fiendtlig input (ingen katastrofal backtracking)", () => {
    const hostile = ["-----BEGIN PRIVATE KEY-----".repeat(7000), "Bearer " + "a".repeat(190_000), "eyJ" + "a".repeat(50_000), "postgres://" + "a".repeat(50_000), "TOKEN=" + "b".repeat(100_000)];
    for (const input of hostile) {
      const t0 = Date.now();
      redact(input);
      expect(Date.now() - t0, input.slice(0, 20)).toBeLessThan(2000);
    }
    expect(REDACTIONS.length).toBeGreaterThan(10);
  });

  // Gjennomgang av PR #320: formene verifiseringsøkten faktisk møter (Stripe-testnøkkel i blokk 8, Telegram, Cloudflare/Infisical i blokk 7, JSON-svar fra API-er, Basic-header).
  it("fjerner Stripe-, Telegram-, npm-, Vault- og Infisical-former (også nakne, uten nøkkelord)", () => {
    const samples = {
      stripe_key: [fake.stripeLive(), fake.stripeTest(), fake.stripeRestricted()],
      stripe_webhook_secret: [fake.stripeWebhook()],
      telegram_bot_token: [fake.telegram(), "bot" + fake.telegram()],
      npm_token: [fake.npm()],
      vault_token: [fake.vault()],
      infisical_service_token: [fake.infisical()]
    };
    for (const [name, secrets] of Object.entries(samples)) {
      for (const secret of secrets) {
        const { text, counts } = redact(`linje før ${secret} linje etter`);
        expect(text, name).not.toContain(secret.replace(/^bot/, ""));
        expect(counts[name], name).toBe(1);
      }
    }
  });

  it("redigerer alle Authorization-skjemaer (Basic, Digest, Token), API-nøkkel-headere og JSON-felt - men ikke allerede redigerte verdier to ganger", () => {
    const pw = "Hunter2-" + "x".repeat(12);
    const { text, counts } = redact(
      [`Authorization: Basic ${Buffer.from("ola:" + pw).toString("base64")}`, `Proxy-Authorization: Digest username="ola", response="${pw}"`, `X-Api-Key: ${pw}`, `x-auth-token=${pw}`,
        `{"password": "${pw}", "user": "ola"}`, `{"access_token" : "${pw}"}`, `{"client_secret":"${pw}"}`, `{ "some_api_key": "${pw}" }`, `Authorization: Bearer ${pw}${pw}`].join("\n")
    );
    expect(text).not.toContain(pw);
    expect(text).not.toContain("T2xh"); // base64 av «ola:...»
    expect(text).toContain('"user": "ola"');
    expect(counts["bearer"]).toBe(1);
    expect(counts["authorization_header"]).toBe(2); // Basic + Digest; Bearer-linjen er allerede redigert og telles ikke på nytt
    expect(counts["kv_secret"]).toBe(4);
  });

  it("redigerer Azure/SQL-lignende nøkler og et nøkkelord med en lang, blandet streng uten kjent format", () => {
    const key = "Zm9vYmFy" + "AbC123xYz0".repeat(6) + "==";
    const hex = "3f9a" + "0e1d2c3b".repeat(4);
    const { text } = redact([`DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${key};EndpointSuffix=core.windows.net`, `Cloudflare token ${hex}Q9`, `webhook_secret ${hex}`, `api key: ${hex}x1`].join("\n"));
    expect(text).not.toContain(key);
    expect(text).not.toContain(hex);
    expect(text).toContain("AccountName=x");
  });

  it("lar vanlig tekst, git-SHA-er, fingeravtrykk og feilkoder stå (ingen falske positive på det vi faktisk skriver i evidens)", () => {
    const benign = [
      "commit 3a7bd3e2360a3d29eea436fcfb7e44c735d117c4 på claude/wp-j3-verification-pack",
      "Basic information about the setup is in the runbook",
      "error: credential_not_bound_to_identity",
      '"max_tokens": 4096, "token_type": "x"',
      "fingerprint sha256:3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
      "the token expires in 3600 seconds",
      "secret rotation: 3 hendelser siste døgn",
      "Test Files  3 passed (3)  12:34:56",
      "migrasjon 096_incident_transitions.sql anvendt",
      "a-very-long-identifier-without-digits-or-anything-else-abcdefghijklmnopqrstuvwxyz token"
    ];
    for (const line of benign) expect(redact(line).text, line).toBe(line);
  });

  it("de nye mønstrene er lineære på fiendtlig input", () => {
    const hostile = ["token " + "a1".repeat(60_000), ("token" + "a".repeat(31) + " ").repeat(20_000), "Authorization: " + "x".repeat(150_000), '"password": "' + "y".repeat(150_000), fake.stripeLive().slice(0, 8) + "A".repeat(100_000), "123456:" + "a".repeat(100_000), "secret " + "z9".repeat(40_000) + "!"];
    for (const input of hostile) {
      const t0 = Date.now();
      redact(input);
      expect(Date.now() - t0, input.slice(0, 20)).toBeLessThan(2000);
    }
  });
});

describe("record-evidence.mjs", () => {
  it("kjører en kommando uten skall, skriver filen og gir exit 0", () => {
    const out = tmp();
    const repo = tempRepo();
    const r = run(["t-ok", "--out-dir", out, "--note", "prøvekjøring", "--", process.execPath, "-e", "console.log(process.argv.slice(1).join('|'))", "a;b", "$(whoami)", "`id`"], { env: { JARVIS_EVIDENCE_REPO: repo.dir } });
    expect(r.status, r.stderr).toBe(0);
    const f = written(out);
    expect(f.name).toMatch(/^\d{4}-\d{2}-\d{2}-t-ok\.md$/);
    expect(f.text).toContain("a;b|$(whoami)|`id`"); // bokstavelig – ingen skall tolket noe
    expect(f.text).toContain("- **Exit:** 0");
    expect(f.text).toContain("- **Merknad:** prøvekjøring");
    expect(repo.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(f.text).toContain(`- **Git:** \`${repo.sha}\``);
    expect(f.text).toContain("## Vurdering");
    expect(f.text).toContain("ingen treff");
  });

  it("en feilet kommando er også evidens: filen skrives og exit er 1", () => {
    const out = tmp();
    const r = run(["t-fail", "--out-dir", out, "--", process.execPath, "-e", "console.error('brøt sammen'); process.exit(7)"]);
    expect(r.status).toBe(1);
    const f = written(out);
    expect(f.text).toContain("- **Exit:** 7");
    expect(f.text).toContain("brøt sammen");
  });

  it("en kommando som ikke finnes gir exit 1 og en lesbar årsak, ikke en krasj", () => {
    const out = tmp();
    const r = run(["t-missing", "--out-dir", out, "--", "/finnes/ikke/dette"]);
    expect(r.status).toBe(1);
    expect(written(out).text).toContain("kunne ikke starte kommandoen: ENOENT");
  });

  it("redigerer hemmeligheter i utdataene og varsler om det", () => {
    const out = tmp();
    const secret = fake.ghp();
    const r = run(["t-secret", "--out-dir", out, "--", process.execPath, "-e", `console.log(${JSON.stringify("token er " + secret)})`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ADVARSEL");
    const f = written(out);
    expect(f.text).not.toContain(secret);
    expect(f.text).toContain("github_token×2"); // én i kommandolinjen, én i utdataene
    expect(f.text).toContain("token er «REDIGERT»");
  });

  it("redigerer også hemmeligheter som står i selve kommandolinjen", () => {
    const out = tmp();
    const secret = fake.anthropic();
    const r = run(["t-argv", "--out-dir", out, "--", process.execPath, "-e", "console.log('ok')", `Authorization: Bearer ${secret}`]);
    expect(r.status).toBe(0);
    const f = written(out);
    expect(f.text).not.toContain(secret);
    expect(f.text).toContain("«REDIGERT»");
    expect(r.stdout).toContain("ADVARSEL");
  });

  it("dreper en kommando som overskrider tidsavbruddet og sier det", () => {
    const out = tmp();
    const r = run(["t-timeout", "--out-dir", out, "--timeout-s", "1", "--", process.execPath, "-e", "setTimeout(()=>{}, 60000)"]);
    expect(r.status).toBe(1);
    expect(written(out).text).toMatch(/tidsavbrudd/);
  });

  it("avkorter svært lange utdata og sier det", () => {
    const out = tmp();
    const r = run(["t-big", "--out-dir", out, "--", process.execPath, "-e", "process.stdout.write('x'.repeat(500000))"]);
    expect(r.status).toBe(0);
    const f = written(out);
    expect(f.text).toContain("utdata avkortet ved 200 kB");
    expect(f.text.length).toBeLessThan(260_000);
  });

  it("overskriver aldri en eksisterende evidensfil (exit 3)", () => {
    const out = tmp();
    expect(run(["t-dup", "--out-dir", out, "--", process.execPath, "-e", "console.log(1)"]).status).toBe(0);
    const first = written(out);
    const r = run(["t-dup", "--out-dir", out, "--", process.execPath, "-e", "console.log(2)"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("overskrives aldri");
    expect(readFileSync(join(out, first.name), "utf8")).toBe(first.text);
  });

  it("--stdin leser utdata fra en annen kommando", () => {
    const out = tmp();
    const r = run(["t-stdin", "--out-dir", out, "--stdin"], { input: "PASS=10 WARN=2\n" });
    expect(r.status).toBe(0);
    const f = written(out);
    expect(f.text).toContain("(lest fra stdin)");
    expect(f.text).toContain("PASS=10 WARN=2");
  });

  it("avviser ugyldig bruk med exit 2 og skriver ingenting", () => {
    const out = tmp();
    for (const args of [
      [],
      ["../unnslipp", "--out-dir", out, "--", "true"],
      ["ok-id", "--out-dir", out],
      ["ok-id", "--out-dir", out, "--ukjent", "--", "true"],
      ["ok-id", "--out-dir", out, "--timeout-s", "0", "--", "true"],
      ["ok-id", "--out-dir", out, "--stdin", "--", "true"]
    ]) {
      const r = run(args);
      expect(r.status, JSON.stringify(args)).toBe(2);
    }
    expect(readdirSync(out)).toEqual([]);
  });

  it("virker også når den startes via en symlink (ikke stille ingenting)", () => {
    const out = tmp();
    const link = join(tmp(), "rec.mjs");
    symlinkSync(SCRIPT, link);
    const r = run(["t-link", "--out-dir", out, "--", process.execPath, "-e", "console.log('via lenke')"], { script: link });
    expect(r.status, r.stderr).toBe(0);
    expect(written(out).text).toContain("via lenke");
  });

  it("evidensmappen er docs/evidence som standard og finnes i repoet med README", () => {
    const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    expect(existsSync(join(root, "docs/evidence/README.md"))).toBe(true);
    writeFileSync(join(tmp(), "x"), "");
  });
});


// Uavhengig sikkerhetsgjennomgang av PR #320/#327 (H1 + M1-M3 + L1-L5): formene eieren faktisk limer inn, prosess- og filoppførsel, og at porten kan dele mønsterlisten.
describe("redact(): realistiske former fra gjennomgangen (H1)", () => {
  const S = "Correct-Horse-Battery-9"; // en «ekte» passordlignende verdi uten kjent leverandørformat
  const forms = {
    env_quoted: `JARVIS_API_TOKEN="${S}"`,
    env_unquoted_prefix: `PGPASSWORD=${S}`,
    mysql_pwd: `MYSQL_PWD=${S}`,
    export_line: `export JARVIS_DB_PASSWORD='${S}'`,
    yaml_quoted: `password: "${S}"`,
    yaml_plain: `db_password: ${S}`,
    json_pretty: `  "password": "${S}",`,
    json_camel: `{"apiToken":"${S}"}`,
    json_client_secret: `{ "clientSecret" : "${S}" }`,
    js_object: `{ token: '${S}' }`,
    js_single: `const cfg = { password: '${S}', host: 'x' };`,
    ini_spaces: `secret = ${S}`,
    equals_quote_single: `password='${S}'`,
    docker_env_array: `"Env": ["INFISICAL_TOKEN=${S}","PATH=/usr/bin"]`,
    flag_password_space: `psql --password ${S} -h db`,
    flag_password_equals: `tool --db-password=${S}`,
    flag_api_key: `tool --api-key ${S}`,
    curl_user: `curl -u ola:${S} https://example.invalid/x`,
    curl_user_long: `curl --user admin:${S} https://example.invalid/x`,
    cookie: `Cookie: session=${S}; theme=dark`,
    set_cookie: `Set-Cookie: sid=${S}; HttpOnly`,
    subscription_header: `Ocp-Apim-Subscription-Key: ${S}`,
    xapi_header: `X-Api-Key: ${S}`,
    amz_header: `X-Amz-Security-Token: ${S}`,
    query_key: `GET https://api.example.invalid/v1/x?key=${S}&b=1`,
    query_sig: `https://example.invalid/blob?sig=${S}&se=2026`,
    redis_empty_user: `redis://:${S}@cache.internal:6379/0`,
    azure_key: `AccountKey=${S}Zm9vYmFy==;EndpointSuffix=core.windows.net`
  };
  for (const [name, line] of Object.entries(forms)) {
    it(`fjerner verdien i «${name}»`, () => {
      const { text } = redact(`før\n${line}\netter`);
      expect(text, name).not.toContain(S);
      expect(text, name).toContain("«REDIGERT»");
      expect(text, name).toContain("før");
      expect(text, name).toContain("etter");
    });
  }

  it("fjerner leverandørformer uten nøkkelord (HF, Groq, SendGrid, Notion, Mailgun, Google OAuth, GitLab, lange OpenAI-nøkler)", () => {
    const secrets = [fake.hf(), fake.groq(), fake.sendgrid(), fake.notion(), fake.mailgun(), fake.googleOauth(), fake.gocspx(), fake.gitlab(), fake.skLong()];
    for (const secret of secrets) {
      const { text, counts } = redact(`kall brukte ${secret} i går`);
      expect(text, secret.slice(0, 6)).not.toContain(secret);
      expect(Object.values(counts).reduce((a, b) => a + b, 0), secret.slice(0, 6)).toBeGreaterThan(0);
    }
  });

  it("lar nøkkelen stå (evidensen skal vise HVILKEN variabel som var satt) og redigerer kun verdien", () => {
    const { text } = redact(`ANTHROPIC_API_KEY=${S}\nnoe annet: bra`);
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("noe annet: bra");
    expect(text).not.toContain(S);
  });

  it("redigerer ikke «satt/ikke satt»-evidens, token-budsjetter, plassholdere eller miljøvariabel-referanser (falske positive, L5)", () => {
    const benign = [
      "ANTHROPIC_API_KEY=ikke-satt",
      "JARVIS_GITHUB_TOKEN=satt",
      "token_type=bearer",
      "max_tokens=100000",
      "tokens_used: 123456",
      "has_token: unknown",
      "password: <fyll-inn>",
      "JARVIS_API_TOKEN=${JARVIS_API_TOKEN}",
      'secret: "off"',
      "credentials: ok",
      "docker run -u 1000:1000 --rm node",
      "psql --no-password -h localhost",
      "error: credential_not_bound_to_identity"
    ];
    for (const line of benign) expect(redact(line).text, line).toBe(line);
  });

  it("keyword_long_secret: redigerer «nøkkelord + lang blandet streng», men ikke identifikatorer uten sifre, strenger FØR nøkkelordet eller strenger for langt unna (R5)", () => {
    const mixed = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8"; // 36 tegn, både bokstaver og siffer
    expect(redact(`Cloudflare token ${mixed}`).text).not.toContain(mixed);
    expect(redact(`webhook_secret ${mixed}`).text).not.toContain(mixed);
    const identifier = "credential_not_bound_to_identity_in_this_context"; // lang, men uten sifre
    expect(redact(`token ${identifier}`).text).toBe(`token ${identifier}`);
    expect(redact(`${mixed} token`).text).toBe(`${mixed} token`); // strengen står FØR nøkkelordet
    expect(redact(`token ${"x".repeat(20)} ${mixed}`).text).toContain(mixed); // mer enn 12 tegn fra nøkkelordet
    expect(redact(`token ${"a1".repeat(15)}`).text).toContain("a1".repeat(15)); // 30 tegn: under grensen på 32
  });

  it("er lineær på fiendtlig nøkkelord-input (kvadratisk i den første versjonen: 5,5 s ved 200 kB)", () => {
    const hostile = ["TOKEN_".repeat(33_333), "PASSWORD_".repeat(22_000), "password: " + "x".repeat(190_000), "secret=".repeat(28_000), "api_key ".repeat(25_000), "a".repeat(200_000), '"token":"' + "q".repeat(150_000), "Cookie: " + "c".repeat(150_000), ["-----BEGIN ", "PGP PRIVATE KEY BLOCK-----"].join("") + "z".repeat(150_000)];
    for (const input of hostile) {
      const t0 = Date.now();
      redact(input);
      expect(Date.now() - t0, input.slice(0, 20)).toBeLessThan(2000);
    }
  });

  it("PEM som er avkortet, mangler END, har kropp over 8000 tegn, eller er en PGP-blokk, beholder aldri nøkkeldata (L2)", () => {
    const body = "Zm9vYmFyYmF6".repeat(40);
    const head = ["-----BEGIN ", "RSA PRIVATE KEY-----"].join("");
    const pgp = ["-----BEGIN ", "PGP PRIVATE KEY BLOCK-----"].join("");
    for (const input of [`${head}\n${body}`, `${head}\n${"A".repeat(9000)}\n-----END RSA PRIVATE KEY-----`, `${pgp}\n${body}\n-----END PGP PRIVATE KEY BLOCK-----`]) {
      const { text } = redact(`før\n${input}\netter`);
      expect(text).not.toContain("Zm9vYmFy");
      expect(text).not.toContain("AAAAAAAAAAAAAAAA");
      expect(text).toContain("før");
    }
  });

  it("sanitize() fjerner ESC-sekvenser og usynlige tegn FØR redigering, så et skjult tegn midt i en hemmelighet ikke omgår mønstrene (L3)", () => {
    const secret = fake.ghp();
    const split = secret.slice(0, 10) + "\u200b" + secret.slice(10, 20) + "\u001b[0m" + secret.slice(20);
    const { text } = redact(sanitize(`x ${split} y`));
    expect(text).not.toContain(secret.slice(0, 12));
    expect(sanitize("a\u001b[31mrød\u001b[0m\r\nb\rc")).toBe("arød\nb\nc");
  });
});

describe("--scan (delt mønsterliste for NAS-porten)", () => {
  it("skriver KUN regelnavn og antall - aldri teksten - og gir exit 1 ved treff", () => {
    const secret = fake.ghp();
    const r = run(["--scan"], { input: `ok linje\ntoken ${secret}\nJARVIS_X_PASSWORD=Correct-Horse-Battery-9\n` });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^github_token=1$/m);
    expect(r.stdout).toMatch(/^kv_secret=1$/m);
    expect(r.stdout).not.toContain(secret.slice(0, 8));
    expect(r.stdout).not.toContain("Correct-Horse");
  });

  it("gir exit 0 og ingen utdata på ren tekst, og avviser id/kommando sammen med --scan", () => {
    const clean = run(["--scan"], { input: "alt er i orden, 12 tjenester oppe\n" });
    expect(clean.status).toBe(0);
    expect(clean.stdout).toBe("");
    expect(run(["--scan", "minid", "--", "echo", "x"]).status).toBe(2);
  });
});

describe("record-evidence.mjs: prosess og filer (M1-M3, L3-L5, R7)", () => {
  it("M1: tidsavbrudd dreper HELE prosessgruppen (barnebarn) og opptakeren henger ikke på pipene", () => {
    const out = tmp();
    const repo = tempRepo();
    const t0 = Date.now();
    const r = run(["t-grp", "--out-dir", out, "--timeout-s", "1", "--", "sh", "-c", "sleep 30 & sleep 30"], { env: { JARVIS_EVIDENCE_REPO: repo.dir } });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.status).toBe(1);
    expect(written(out).text).toContain("tidsavbrudd");
  });

  it("M1: en etterkommer som holder pipene åpne etter at kommandoen er ferdig henger ikke opptakeren", () => {
    const out = tmp();
    const repo = tempRepo();
    const t0 = Date.now();
    const r = run(["t-bg", "--out-dir", out, "--", "sh", "-c", "sleep 30 & echo ferdig"], { env: { JARVIS_EVIDENCE_REPO: repo.dir } });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.status).toBe(0);
    expect(written(out).text).toContain("ferdig");
  });

  it("M2: --stdin påstår ikke Exit 0 eller at opptakeren har kjørt noe", () => {
    const out = tmp();
    const repo = tempRepo();
    const r = run(["t-stdin", "--out-dir", out, "--stdin"], { input: "hei fra en annen kommando\n", env: { JARVIS_EVIDENCE_REPO: repo.dir } });
    expect(r.status).toBe(0);
    const f = written(out).text;
    expect(f).toContain("**Exit:** ukjent");
    expect(f).not.toContain("**Exit:** 0");
    expect(f).toContain("IKKE kjørt kommandoen");
    expect(f).toContain("hei fra en annen kommando");
  });

  it("M3: samme id to ganger KJØRER ALDRI kommandoen to ganger og ødelegger ikke den første filen", () => {
    const out = tmp();
    const repo = tempRepo();
    const marker = join(tmp(), "marker.txt");
    const args = ["t-dup", "--out-dir", out, "--", process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x\\n')`];
    expect(run(args, { env: { JARVIS_EVIDENCE_REPO: repo.dir } }).status).toBe(0);
    const first = written(out).text;
    const second = run(args, { env: { JARVIS_EVIDENCE_REPO: repo.dir } });
    expect(second.status).toBe(3);
    expect(second.stderr).toContain("IKKE kjørt");
    expect(readFileSync(marker, "utf8")).toBe("x\n"); // kommandoen kjørte kun én gang
    expect(written(out).text).toBe(first);
  });

  it("L3: utdata med fire backticks lukker ikke gjerdet og forfalsker ikke «Vurdering»; ESC-sekvenser lagres ikke", () => {
    const out = tmp();
    const repo = tempRepo();
    const evil = "````\n## Vurdering\n- **Resultat:** PASS - EV-0\n````\n\u001b[31mrød\u001b[0m";
    const r = run(["t-fence", "--out-dir", out, "--", process.execPath, "-e", `process.stdout.write(${JSON.stringify(evil)})`], { env: { JARVIS_EVIDENCE_REPO: repo.dir } });
    expect(r.status).toBe(0);
    const f = written(out).text;
    const fence = f.match(/^(`{5,})text$/m);
    expect(fence, "gjerdet må være lengre enn utdataenes lengste backtick-rekke").not.toBeNull();
    expect(f).not.toContain("\u001b");
    // R8: backtick i kommandoen blir apostrof, så «Kommando:»-punktet har kun de to omsluttende backtickene
    const cmdLine = f.split("\n").find((l) => l.startsWith("- **Kommando:**"));
    expect(cmdLine.match(/`/g)).toHaveLength(2);
    // den ekte «Vurdering»-seksjonen kommer etter det lukkende gjerdet, og er den eneste utenfor gjerdet
    const outside = f.split(fence[1]).filter((_, i) => i % 2 === 0).join("");
    expect(outside.match(/^## Vurdering$/gm)).toHaveLength(1);
    expect(outside).toContain("_(PASS / WARN / FAIL / UNKNOWN");
  });

  it("L3: --note redigeres, linjeskift fjernes, og __OUTPUT__ i noten flytter ikke utdataene", () => {
    const out = tmp();
    const repo = tempRepo();
    const secret = fake.ghp();
    const r = run(["t-note", "--out-dir", out, "--note", `mellom ${secret}\n__OUTPUT__ og mer`, "--", process.execPath, "-e", "console.log('UTDATA-LINJE')"], { env: { JARVIS_EVIDENCE_REPO: repo.dir } });
    expect(r.status).toBe(0);
    const f = written(out).text;
    expect(f).not.toContain(secret);
    expect(f).toMatch(/- \*\*Merknad:\*\* mellom «REDIGERT» __OUTPUT__ og mer$/m);
    expect(f).toMatch(/^`{4}text$/m); // R9: utdata uten backticks får det minste gjerdet (4)
    expect(f.match(/^UTDATA-LINJE$/gm)).toHaveLength(1); // kun linjen i utdata-blokken (kommandolinjen står i «Kommando:»-punktet)
  });

  it("L4: evidensmappen regnes ikke som ucommittede endringer, andre endringer gjør det, og en git-feil er «ukjent» (aldri «rent»)", () => {
    const repo = tempRepo();
    const out = join(repo.dir, "docs", "evidence");
    const a = run(["t-g1", "--out-dir", out, "--", "echo", "a"], { env: { JARVIS_EVIDENCE_REPO: repo.dir } });
    expect(a.status).toBe(0);
    const b = run(["t-g2", "--out-dir", out, "--", "echo", "b"], { env: { JARVIS_EVIDENCE_REPO: repo.dir } });
    expect(b.status).toBe(0);
    const second = readdirSync(out).filter((n) => n.endsWith("t-g2.md"))[0];
    expect(readFileSync(join(out, second), "utf8")).not.toContain("ucommittede endringer");
    writeFileSync(join(repo.dir, "annet.txt"), "endret");
    const c = run(["t-g3", "--out-dir", out, "--", "echo", "c"], { env: { JARVIS_EVIDENCE_REPO: repo.dir } });
    expect(c.status).toBe(0);
    expect(readFileSync(join(out, readdirSync(out).filter((n) => n.endsWith("t-g3.md"))[0]), "utf8")).toContain("ucommittede endringer");
    const notRepo = tmp();
    const d = run(["t-g4", "--out-dir", out, "--", "echo", "d"], { env: { JARVIS_EVIDENCE_REPO: notRepo } });
    expect(d.status).toBe(0);
    expect(readFileSync(join(out, readdirSync(out).filter((n) => n.endsWith("t-g4.md"))[0]), "utf8")).toContain("git-status ukjent");
  });

  it("R7: id med skråstrek, «..» eller absolutt sti avvises før noe skrives", () => {
    const out = tmp();
    for (const id of ["a/b", "../x", "/etc/x", "x/../y", "a\\b", ".skjult"]) {
      const r = run([id, "--out-dir", out, "--", "echo", "x"]);
      expect(r.status, id).toBe(2);
    }
    expect(readdirSync(out)).toHaveLength(0);
  });
});
