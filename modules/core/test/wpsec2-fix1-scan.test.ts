import { describe, expect, it } from "vitest";
import { SCAN_WINDOW_CHARS, redactLogText, scanForSecrets } from "../src/services/secret-scan.ts";
import { VENDOR_FORMATS } from "./support/connector-fixtures.ts";
import { HIDDEN, body, fullwidth, insertAt, pemBegin, tok } from "./support/secret-fixtures.ts";

/**
 * WP-SEC2 fiks-runde 1, skanner-kjernen (review A: M1, M3, M4, L1, L2, L5, L7, L9 + testhull V5/V7/V8/V9/V12/V17/S5/S17/S18/S21/S23/S32/S33/S37/S38). ALLE verdier bygges sammensatt ved kjøring
 * (`secret-fixtures.ts`/`connector-fixtures.ts`): ingen ekte-lignende nøkler i kildefilene, og ingen `\u`-escapes (kodepunkter via `String.fromCodePoint`).
 */
const cp = (n: number): string => String.fromCodePoint(n);
const J = (...parts: string[]): string => parts.join("");
const marker = (kind: string): string => `[REDACTED:${kind}]`;
/** Lekker noen 10-tegns sekvens (fra og med tegn 6) av `secret` inn i `out`? */
const leaks = (out: string, secret: string): boolean => {
  for (let i = 6; i + 10 <= secret.length; i += 1) if (out.includes(secret.slice(i, i + 10))) return true;
  return false;
};
const unchanged = (text: string): void => expect(scanForSecrets(text), JSON.stringify(text)).toEqual({ text, findings: [] });

const FAMILIES: ReadonlyArray<[string, () => string]> = [
  ["github", tok.github], ["github_pat", tok.githubPat], ["anthropic", tok.anthropic], ["openai", tok.openai], ["stripe", tok.stripe], ["slack", tok.slack], ["aws", tok.aws],
  ["google_api_key", () => J("AI", "za") + body(35, 4)], ["telegram", () => `123456789:${body(35, 5)}`], ["enrollment", () => J("en", "r_") + body(40, 6)], ["jwt", tok.jwt], ["sendgrid", tok.sendgrid],
  ["npm", tok.npm], ["gitlab", tok.gitlab], ["google_oauth", tok.googleOauth], ["huggingface", tok.huggingface]
];

describe("A-M1 (regresjon mot base): skjulte/foldede tegn inntil et token flytter ikke ordgrensen", () => {
  const left: Record<string, string> = {
    "ord + nullbredde": `abc${HIDDEN.zwsp}`, "ord + myk bindestrek": `abc${HIDDEN.softHyphen}`, "ord + kombinerende merke": `abc${HIDDEN.acute}`, "siffer + nullbredde": `123${HIDDEN.zwsp}`,
    "understrek + nullbredde": `x_${HIDDEN.zwsp}`, "fullbredde x": cp(0xff58), "kyrillisk а": cp(0x0430)
  };
  const right: Record<string, string> = {
    "nullbredde + ord": `${HIDDEN.zwsp}abc`, "myk bindestrek + ord": `${HIDDEN.softHyphen}abc`, "kombinerende + ord": `${HIDDEN.acute}abc`, "fullbredde x": cp(0xff58), "kyrillisk а": cp(0x0430), "fullbredde siffer": cp(0xff17)
  };
  for (const [name, make] of FAMILIES) {
    it(`${name}: skjult/foldet tegn rett FØR prefikset og rett ETTER kroppen skjuler ikke tokenet`, () => {
      const token = make();
      for (const [label, l] of Object.entries(left)) expect(leaks(scanForSecrets(`${l}${token} slutt`).text, token), `${name} venstre ${label}`).toBe(false);
      for (const [label, r] of Object.entries(right)) expect(leaks(scanForSecrets(`start ${token}${r} slutt`).text, token), `${name} høyre ${label}`).toBe(false);
    });
  }

  it("reviewerens eksakte tilfeller: `abc<ZWSP>ghp_…` og `AKIA…<ZWSP>abc` redigerer HELE tokenet", () => {
    expect(scanForSecrets(`abc${HIDDEN.zwsp}${tok.github()} slutt`).text).toContain(marker("github_token"));
    expect(scanForSecrets(`${tok.aws()}${HIDDEN.zwsp}abc rest`).text).toBe(`${marker("aws_access_key")}${HIDDEN.zwsp}abc rest`);
  });

  it("ren ASCII-tekst får ikke et ekstra pass, og tekst UTEN funn er fortsatt byte-identisk (også med ikke-ASCII)", () => {
    unchanged(`Møtet på Grünerløkka er flyttet til kl. 14${HIDDEN.zwsp}:00 - ${cp(0xff58)}abc ${cp(0x0430)}bc åäö`);
    unchanged("Ren ASCII-tekst med ghp_ nevnt i prosa og AKIA som forkortelse");
  });
});

describe("A-M3: hex/base64 etter norske BESTEMTE og SAMMENSATTE nøkkelord redigeres", () => {
  const b64 = body(44, 5);
  const hex = "3f2a9c".repeat(11).slice(0, 64);
  const phrases = ["nøkkelen min er", "nøkkelen er", "tokenet er", "tokenet mitt:", "hemmeligheten er", "hemmeligheten:", "API-nøkkelen:", "API-nøkkelen er", "signeringsnøkkelen er", "krypteringsnøkkelen:", "nøkler:", "nøklene:", "passordet er", "my secret is", "secret key:"];
  for (const phrase of phrases) {
    it(`«${phrase} <verdi>»: base64(44) og hex(64) redigeres`, () => {
      expect(scanForSecrets(`${phrase} ${b64}`).text, "base64").not.toContain(b64.slice(8, 30));
      expect(scanForSecrets(`${phrase} ${hex}`).text, "hex").not.toContain(hex.slice(8, 30));
    });
  }
  it("på tvers av linjeskift og uten verdi røres ingenting; frittstående hex/base64 er fortsatt aldri en hemmelighet", () => {
    for (const text of ["nøkkelen er lagret i hvelvet", "tokenet er sendt til deg i går kveld", `nøkkelen\n${b64}`, "hemmeligheten er at ingen vet", `Sjekksum ${hex}`, `trace ${hex}`]) unchanged(text);
  });
  it("K6-ytelse: ny kontekstregel er lineær (200 000 «nøkkelen » og 100 000 «key »)", () => {
    for (const text of ["nøkkelen ".repeat(200_000), "key ".repeat(100_000), `${"token ".repeat(50_000)}${b64}`]) {
      const started = Date.now();
      scanForSecrets(text);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });
});

describe("A-M4: connector-leverandørenes token-formater fanges FRITTSTÅENDE (uten nøkkelord foran) - alle `unverified`", () => {
  for (const format of VENDOR_FORMATS) {
    it(`${format.label}: fanges i prosa, i JSON og etter «TOKEN=», og nære feilformer røres ikke`, () => {
      const token = format.make();
      expect(scanForSecrets(`Her er verdien: ${token} takk`)).toEqual({ text: `Her er verdien: ${marker(format.kind)} takk`, findings: [{ kind: format.kind, count: 1 }] });
      expect(scanForSecrets(`token ${token}`).text).not.toContain(token.slice(6, 30));
      expect(scanForSecrets(`TOKEN=${token}`).text).not.toContain(token.slice(6, 30));
      expect(scanForSecrets(JSON.stringify({ note: `se ${token}` })).text).not.toContain(token.slice(6, 30));
      for (const near of format.nearMisses()) unchanged(`Her er verdien: ${near} takk`);
    });
  }
  it("prefikset nevnt i prosa, og age-offentlig nøkkel, er ikke hemmeligheter", () => {
    for (const text of ["Notion-tokenet starter med ntn_ og Linear bruker lin_api_ som prefiks.", "Sentry: sntrys_ er org-token, tvly- er Tavily, gsk_ er Groq, pat-na1- er HubSpot.", "age-nøkler: AGE-SECRET-KEY-1 er prefikset for den hemmelige nøkkelen."]) unchanged(text);
  });
  it("hver connector-regel er lineær på adversarielle gjentakelser (1 MB hver, under 2 s)", () => {
    for (const unit of ["ntn_ ", "secret_", "lin_api_", "sntrys_", "tvly-", "gsk_", "ATATT", "BSA", "SK", "KEY0", "pat-na1-", "sl.", "M", "hooks.slack.com/services/T", "discord.com/api/webhooks/1", "re_", "EAA", "AGE-SECRET-KEY-1"]) {
      const started = Date.now();
      scanForSecrets(unit.repeat(Math.ceil(1_000_000 / unit.length)));
      expect(Date.now() - started, unit).toBeLessThan(2000);
    }
  });
});

describe("A-L1: et forkastet treff skjuler ikke et ekte treff som ligger inne i det forbrukte området", () => {
  it("cookie: en godartet `Cookie:`-prosa foran en ekte cookie på samme linje", () => {
    const sid = body(24, 3);
    const r = scanForSecrets(`Cookie: godkjent av styret og Cookie: sid=${sid}; theme=dark`);
    expect(r.text).not.toContain(sid);
    expect(r.text).toBe(`Cookie: godkjent av styret og Cookie: ${marker("cookie_header")}`);
    expect(scanForSecrets(r.text).findings).toEqual([]);
  });
  it("JSON-par: et par som forbruker neste pars anførselstegn (`\"d\":\\n\"password\":\"…\"`) skjuler ikke passordet - heller ikke i enkle/escapede former", () => {
    const pw = body(16, 2);
    for (const input of [`x "d":\n"password":"${pw}"`, `x 'd':\n'password':'${pw}'`, `x \\"d\\":\n\\"password\\":\\"${pw}\\"`]) {
      const once = scanForSecrets(input);
      expect(once.text, input).not.toContain(pw);
      expect(scanForSecrets(once.text).findings, `idempotent: ${input}`).toEqual([]);
    }
  });
  it("forkastede treff er fortsatt forkastet (ingen nye falske positiver), og skip-gjenopptakelsen er lineær", () => {
    unchanged('{"status":"ok","count":3,"name":"kari"}');
    unchanged("Cookie: godkjent av styret\nCookies: vi bruker informasjonskapsler");
    for (const text of ["Cookie: x ".repeat(100_000), '"a":"b" '.repeat(100_000), '"a":\n'.repeat(150_000)]) {
      const started = Date.now();
      scanForSecrets(text);
      expect(Date.now() - started).toBeLessThan(2500);
    }
  });
});

describe("A-L2: en privat nøkkel som krysser vindusgrensen over-redigerer ikke godartet tekst før nøkkelen", () => {
  it("BEGIN 100 tegn før vindusslutt: utdata = før + én markør + etter", () => {
    const pre = "word ".repeat(Math.ceil(SCAN_WINDOW_CHARS / 5)).slice(0, SCAN_WINDOW_CHARS - 100) + " ";
    const post = ` .${"word ".repeat(100)}`;
    expect(scanForSecrets(pre + tok.pem(3) + post).text).toBe(`${pre}${marker("private_key")}${post}`);
  });
  it("BEGIN i overlappet og uten END: fail-closed fra BEGIN til slutten, men ikke før BEGIN", () => {
    const pre = "ord ".repeat(Math.ceil(SCAN_WINDOW_CHARS / 4)).slice(0, SCAN_WINDOW_CHARS - 2000) + "\n";
    const out = scanForSecrets(`${pre}${pemBegin()}\n${body(64)}\n${"hale ".repeat(2500)}`).text;
    expect(out).toBe(`${pre}${marker("private_key")}`);
  });
});

describe("A-L5: klemt visning dekker også Stripe, whsec_, xapp-, AIza, telegram, enr_ og ya29.", () => {
  const wrapFamilies: ReadonlyArray<[string, () => string, string]> = [
    ["stripe", tok.stripe, "stripe_key"], ["stripe rk_live", () => J("rk", "_live_") + body(40, 3), "stripe_key"], ["whsec_", () => J("wh", "sec_") + body(32, 2), "stripe_key"],
    ["xapp-", () => J("xa", "pp-1-") + body(40, 2), "slack_app_token"], ["AIza", () => J("AI", "za") + body(35, 4), "google_api_key"], ["telegram", () => `123456789:${body(35, 5)}`, "telegram_bot_token"],
    ["enr_", () => J("en", "r_") + body(40, 6), "enrollment_ticket"], ["ya29.", tok.googleOauth, "google_oauth_token"]
  ];
  for (const [name, make] of wrapFamilies) {
    it(`${name}: delt over linjeskift ved alle brytebredder 10-60 lekker ikke`, () => {
      const token = make();
      const bad: number[] = [];
      for (let width = 10; width <= 60 && width < token.length; width += 1) {
        const wrapped = (token.match(new RegExp(`.{1,${width}}`, "g")) as string[]).join("\n");
        if (leaks(scanForSecrets(`Her er verdien:\n${wrapped}\nslutt`).text, token)) bad.push(width);
      }
      expect(bad, `${name} lekker ved bredde(r)`).toEqual([]);
    });
    it(`${name}: delt med mellomrom i stedet for linjeskift (to deler) fanges, og prosa etter et ferdig token beholdes`, () => {
      const token = make();
      const at = Math.floor(token.length / 2);
      expect(leaks(scanForSecrets(`verdi ${token.slice(0, at)} ${token.slice(at)} slutt`).text, token)).toBe(false);
      expect(scanForSecrets(`${token} og så videre`).text).toMatch(/^\[REDACTED:[a-z_]+\] og så videre$/);
    });
  }
  it("U+FFFC (objekt-erstatningstegn) midt i et token bryter ikke treffet", () => {
    const token = tok.github();
    const out = scanForSecrets(`x ${insertAt(token, 14, cp(0xfffc))} y`);
    expect(out.text).toBe(`x ${marker("github_token")} y`);
  });
});

describe("A-L7: Authorization: Bearer <opak> - kun REELLE plassholderformer er unntatt", () => {
  it("et ekte token som tilfeldigvis starter med <, {, $, % eller [ redigeres", () => {
    const opaque = body(30, 4);
    for (const credential of [`$2a$12$${opaque}`, `%7E${opaque}`, `{${opaque}`, `<${opaque}`, `[${opaque}`, `<${opaque}>`, `{${opaque}}`, `[${opaque}]`, `\${${opaque}}`]) {
      const out = scanForSecrets(`Authorization: Bearer ${credential}`);
      expect(out.text, credential).not.toContain(opaque.slice(4, 24));
      expect(out.findings.length, credential).toBeGreaterThan(0);
    }
  });
  it("reelle plassholdere (<token>, <your token>, ${TOKEN}, $TOKEN, {{ token }}, [token], %TOKEN%, …, ***) står uendret - også mange skjemaer og i prosa", () => {
    for (const text of [
      "Authorization: Bearer <token>", "Authorization: Bearer <your token>", "Authorization: Bearer <YOUR_ACCESS_TOKEN>", "Authorization: Basic <base64>", "Authorization: Bearer ${TOKEN}", "Authorization: Bearer $TOKEN",
      "Authorization: Bearer {{ token }}", "Authorization: Bearer {token}", "Authorization: Bearer [token]", "Authorization: Bearer %TOKEN%", "Authorization: Bearer ...", "Authorization: Bearer ***", "Authorization: Bearer",
      "Bruk Authorization: Bearer <token> når du kaller API-et."
    ]) unchanged(text);
  });
  it("allerede redigert tekst forblir uendret (idempotent), og marker-verdier røres ikke", () => {
    const first = scanForSecrets(`Authorization: Bearer ${body(30, 4)}`).text;
    expect(scanForSecrets(first)).toEqual({ text: first, findings: [] });
    unchanged(`Authorization: ${marker("authorization_header")}`);
  });
});

describe("A-L9: nye falske positiver er lukket uten å miste ekte hemmeligheter", () => {
  it("sidetall-/paginerings-tokens (nextPageToken, page_token, next_token, continuation_token) er ikke hemmeligheter", () => {
    for (const key of ["nextPageToken", "page_token", "next_token", "continuationToken", "pageToken", "nextSyncToken", "cursor_token"]) unchanged(JSON.stringify({ items: [], [key]: `CAESBAgBEAA${body(20)}` }));
  });
  it("status-/plassholderverdier under sterke nøkler er ikke hemmeligheter (strengt: liten liste, hele verdien)", () => {
    for (const text of [
      '{"password":"required"}', '{"api_key":"YOUR_API_KEY"}', '{"cookie":"accepted"}', '{"auth":"oauth2"}', '{"auth":"oauth2|bearer"}', '{"token":" world"}', '{"password":"hidden"}', '{"secret":"REPLACE_ME"}',
      '{"client_secret":"your-client-secret-here"}', '{"api_key":"<API_KEY>"}', '{"password":"invalid"}', '{"password":"enabled"}'
    ]) unchanged(text);
  });
  it("men ekte verdier under de samme nøklene redigeres fortsatt - også når de ligner (men ikke ER) en statusverdi", () => {
    for (const [key, value] of [["password", "required123!"], ["api_key", "YOUR_API_KEY_" + body(20)], ["cookie", "accepted-" + body(16)], ["password", "Sommer2026!x"], ["token", `a${body(20)}`], ["password", "hidden horse battery"], ["auth", body(30)]] as const) {
      const out = scanForSecrets(JSON.stringify({ [key]: value }));
      expect(out.text, `${key}=${value}`).toContain("[REDACTED:");
      expect(out.text, `${key}=${value}`).not.toContain(value);
    }
  });
  it("«commit key: <40-hex>» (git-SHA) er ikke en hemmelighet, men `key: <40-hex>` og `secret: <hex>` uten git-ord er det fortsatt", () => {
    const sha = "3f2a9c1b7d5e4f6a8b0c2d4e6f8a1b3c5d7e9f01";
    for (const text of [`commit key: ${sha}`, `cache key: ${sha}`, `git key ${sha}`, `sha key = ${sha}`]) unchanged(text);
    for (const text of [`key: ${sha}`, `API key: ${sha}`, `secret: ${sha}`, `my key is ${sha}`]) expect(scanForSecrets(text).text, text).not.toContain(sha.slice(4, 30));
  });
  it("ternær: `c ? \"api_key\" : \"short_lived_token\"` er kode, ikke et JSON-par - men ekte JSON med samme nøkkel redigeres", () => {
    unchanged('const v = ok ? "api_key" : "short_lived_token";');
    unchanged('x = cond\n  ? "password" : "passphrase_required";');
    expect(scanForSecrets('{"api_key":"short_lived_token"}').text).toBe(`{"api_key":"${marker("named_secret")}"}`);
  });
});

describe("testhull fra review A (hver test dreper en navngitt mutant)", () => {
  const github = tok.github();
  it("V5: C1-kontrolltegn (U+0090, U+009F) midt i et token fjernes fra visningen - hele spennet erstattes", () => {
    for (const code of [0x90, 0x9f, 0x80]) expect(scanForSecrets(`x ${insertAt(github, 14, cp(code))} y`).text, code.toString(16)).toBe(`x ${marker("github_token")} y`);
  });
  it("V7: løst surrogat midt i et token fjernes fra visningen", () => {
    expect(scanForSecrets(`x ${insertAt(github, 14, String.fromCharCode(0xd800))} y`).text).toBe(`x ${marker("github_token")} y`);
    expect(scanForSecrets(`x ${insertAt(github, 14, String.fromCharCode(0xdc00))} y`).text).toBe(`x ${marker("github_token")} y`);
  });
  it("V8: privat bruk (U+E000) midt i et token fjernes fra visningen", () => {
    expect(scanForSecrets(`x ${insertAt(github, 14, cp(0xe000))} y`).text).toBe(`x ${marker("github_token")} y`);
  });
  it("V9: brailleblankt (U+2800) midt i et token fjernes fra visningen", () => {
    expect(scanForSecrets(`x ${insertAt(github, 14, cp(0x2800))} y`).text).toBe(`x ${marker("github_token")} y`);
  });
  it("V12: homoglyfen «ɡ» (U+0261) for g i prefikset gir et funn", () => {
    expect(scanForSecrets(`x ${cp(0x0261)}${github.slice(1)} y`).text).toBe(`x ${marker("github_token")} y`);
  });
  it("V17: linje-/avsnittsskille (U+2028/U+2029) mellom to deler av et token er blanke, og tokenet fanges", () => {
    for (const sep of [cp(0x2028), cp(0x2029)]) expect(scanForSecrets(`${github.slice(0, 20)}${sep}${github.slice(20)}`).text, sep.codePointAt(0)?.toString(16)).toBe(marker("github_token"));
  });
  it("S5: AKIA + blank + 20 store bokstaver er ikke et AWS-token (eksakt lengde 16), men 16 delt over blank er det", () => {
    unchanged("AKIA ABCDEFGHIJKLMNOPQRST ok");
    expect(scanForSecrets(`${tok.aws().slice(0, 10)} ${tok.aws().slice(10)} ok`).text).toBe(`${marker("aws_access_key")} ok`);
  });
  it("S17: key + 32 rene sifre er ikke en hemmelighet (hex uten bokstav), men blandet hex er det", () => {
    unchanged("key 12345678901234567890123456789012");
    expect(scanForSecrets(`key ${"3f2a9c".repeat(6).slice(0, 32)}`).text).toBe(`key ${marker("secret_blob")}`);
  });
  it("S18: key + sti med mange skråstreker/bindestreker er ikke en hemmelighet", () => {
    unchanged(`key ${"a1B2/".repeat(8)}`);
    unchanged(`key ${"a1B2-".repeat(8)}`);
  });
  it("S21: Luhn-regelen er riktig (n-9) - ekte kortnumre med sifre over 4 etter dobling redigeres", () => {
    const r = scanForSecrets("kort 5500 0000 0000 0004 og 4012 8888 8888 1881 og 4111-1111-1111-1111 ok");
    expect(r.findings).toEqual([{ kind: "card_number", count: 3 }]);
    expect(r.text).not.toMatch(/\d{4}/);
    unchanged("kort 5500 0000 0000 0005 ok"); // Luhn-ugyldig
  });
  it("S23: overlapper to typer, vinner typen med høyest prioritet (github_token over authorization_header)", () => {
    const r = scanForSecrets(`Authorization: Digest username="u", response="${github}"`);
    expect(r.findings).toEqual([{ kind: "github_token", count: 1 }]);
  });
  it("S32: GOCSPX-formatet (Google OAuth-klienthemmelighet) fanges", () => {
    expect(scanForSecrets(`x ${J("GOC", "SPX-")}${body(30, 2)} y`).text).toBe(`x ${marker("google_oauth_token")} y`);
  });
  it("S33: xapp-formatet (Slack app-token) fanges", () => {
    expect(scanForSecrets(`x ${J("xa", "pp-1-")}${body(30, 2)} y`).text).toBe(`x ${marker("slack_app_token")} y`);
  });
  it("S37: {{plassholder}} under et passord er ikke en hemmelighet", () => {
    unchanged('{"password":"{{secret_value}}"}');
  });
  it("S38: dobbelt-escapet JSON med backslash i passordet redigeres hele (ikke bare til backslashen)", () => {
    const input = JSON.stringify(JSON.stringify({ password: "ab\\cd12345" }));
    expect(scanForSecrets(input).text).toBe(JSON.stringify(JSON.stringify({ password: marker("named_secret") })));
  });
  it("fullbredde-token og redactLogText bruker de nye reglene (en felles skanner)", () => {
    expect(scanForSecrets(`x ${fullwidth(github)} y`).text).toBe(`x ${marker("github_token")} y`);
    expect(redactLogText(`feil ${VENDOR_FORMATS[2]?.make() ?? ""} slutt`)).toBe(`feil ${marker("linear_token")} slutt`);
  });
});
