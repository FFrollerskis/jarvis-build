import { describe, expect, it } from "vitest";
import { SCAN_OVERLAP_CHARS, SCAN_WINDOW_CHARS, containsSecret, scanForSecrets } from "../src/services/secret-scan.ts";
import { HIDDEN, body, fullwidth, insertAt, pemBegin, pemEnd, tok } from "./support/secret-fixtures.ts";

/**
 * WP-SEC2 (JARVIS-013/069, K1-K4, K6): evasjonsbestandig, nøkkelnavn-bevisst skanning. Hver test under var RØD mot skanneren på `main` (målt av lead; se rapporten). Fikstur-tokens bygges sammensatt (support/secret-fixtures.ts).
 */
const redacted = (kind: string): string => `[REDACTED:${kind}]`;
const uuid = ["123e4567", "e89b", "12d3", "a456", "426614174000"].join("-");

describe("K1: skjulte tegn, fullbredde og kombinerende merker unngår ikke skanneren - hele det opprinnelige spennet erstattes", () => {
  const github = tok.github();
  // Skjulte tegn skal ligge INNE i hemmeligheten; da erstattes hele spennet (kun hemmelighetens første til siste tegn).
  const evasions: Array<[string, string]> = [
    ["nullbredde (U+200B) midt i prefikset", insertAt(github, 1, HIDDEN.zwsp)],
    ["nullbredde i kroppen", insertAt(github, 12, HIDDEN.zwsp)],
    ["nullbredde etter hvert tegn", [...github].join(HIDDEN.zwsp)],
    ["ZWNJ + ZWJ + word joiner + BOM i kroppen", insertAt(insertAt(insertAt(insertAt(github, 8, HIDDEN.zwnj), 15, HIDDEN.zwj), 20, HIDDEN.wordJoiner), 30, HIDDEN.bom)],
    ["myk bindestrek (U+00AD) i prefikset og kroppen", insertAt(insertAt(github, 2, HIDDEN.softHyphen), 18, HIDDEN.softHyphen)],
    ["bidi-overstyring (U+202E ... U+202C) inni", insertAt(insertAt(github, 6, HIDDEN.rlo), 25, HIDDEN.pdf)],
    ["bidi-isolater (U+2066 ... U+2069) inni", insertAt(insertAt(github, 5, HIDDEN.lri), 22, HIDDEN.pdi)],
    ["tag-tegn (U+E0041) i kroppen", insertAt(github, 9, HIDDEN.tagA)],
    ["variantvelger og CGJ i kroppen", insertAt(insertAt(github, 7, HIDDEN.vs16), 14, HIDDEN.cgj)],
    ["kontrolltegn (NUL, ESC) i kroppen", insertAt(insertAt(github, 10, HIDDEN.nul), 17, HIDDEN.esc)],
    ["Hangul-fyller (default ignorable) i kroppen", insertAt(github, 11, HIDDEN.hangulFiller)],
    ["kombinerende aksent etter prefiksbokstaver", insertAt(insertAt(github, 1, HIDDEN.acute), 3, HIDDEN.ring)],
    ["kombinerende aksent etter hver bokstav i prefikset", [...github.slice(0, 4)].map((c) => c + HIDDEN.acute).join("") + github.slice(4)],
    ["fullbredde (ｇｈｐ＿ + kropp)", fullwidth(github)],
    ["fullbredde kun i prefikset", fullwidth(github.slice(0, 4)) + github.slice(4)],
    ["kyrillisk homoglyf (һ for h) i prefikset", github[0] + String.fromCodePoint(0x04bb) + github.slice(2)],
    ["kyrillisk homoglyf (а for a) i kroppen", github.slice(0, 6) + String.fromCodePoint(0x0430) + github.slice(7)]
  ];
  for (const [label, evaded] of evasions) {
    it(`GitHub-token med ${label} fanges og hele spennet erstattes`, () => {
      const r = scanForSecrets(`bruk ${evaded} nå`);
      expect(r.text).toBe(`bruk ${redacted("github_token")} nå`);
      expect(r.findings).toEqual([{ kind: "github_token", count: 1 }]);
      expect(containsSecret(evaded)).toBe(true);
    });
  }

  it("skjulte tegn UTENFOR hemmeligheten (før/etter) beholdes - kun selve spennet erstattes", () => {
    const r = scanForSecrets(`${HIDDEN.zwsp}${github}${HIDDEN.rlo}`);
    expect(r.text).toBe(`${HIDDEN.zwsp}${redacted("github_token")}${HIDDEN.rlo}`);
  });

  const other: Array<[string, string, string]> = [
    ["anthropic_key", "Anthropic-nøkkel", tok.anthropic()],
    ["openai_key", "OpenAI-nøkkel", tok.openai()],
    ["aws_access_key", "AWS nøkkel-ID", tok.aws()],
    ["slack_token", "Slack-token", tok.slack()],
    ["stripe_key", "Stripe-nøkkel", tok.stripe()],
    ["jwt", "JWT", tok.jwt()],
    ["sendgrid_key", "SendGrid-nøkkel", tok.sendgrid()]
  ];
  for (const [kind, label, token] of other) {
    it(`${label}: nullbredde midt i, fullbredde og myk bindestrek fanges (type ${kind})`, () => {
      for (const evaded of [insertAt(token, 3, HIDDEN.zwsp), insertAt(token, Math.floor(token.length / 2), HIDDEN.zwj), fullwidth(token), insertAt(token, 4, HIDDEN.softHyphen)]) {
        const r = scanForSecrets(`her: ${evaded} !`);
        expect(r.findings.map((f) => f.kind), JSON.stringify(evaded)).toEqual([kind]);
        expect(r.text).toBe(`her: ${redacted(kind)} !`);
      }
    });
  }

  it("ikke-brytende bindestrek (U+2011) i `sk-`-prefikset og tankestrek i `sk-proj-` fanges", () => {
    const key = tok.openaiProject();
    const evaded = key.replace(/-/g, HIDDEN.nonBreakingHyphen);
    const r = scanForSecrets(`nøkkel ${evaded} slutt`);
    expect(r.findings.map((f) => f.kind)).toEqual(["openai_key"]);
    expect(r.text).toBe(`nøkkel ${redacted("openai_key")} slutt`);
  });

  it("privat nøkkel: nullbredde i `-----BEGIN`-linjen, i kroppen og i END-linjen fanges, og hele blokken erstattes", () => {
    const pem = tok.pem(3);
    for (const evaded of [insertAt(pem, 8, HIDDEN.zwsp), insertAt(pem, 30, HIDDEN.zwsp), fullwidth(pemBegin()) + pem.slice(27), pem.replace("PRIVATE KEY", `PRIV${HIDDEN.zwj}ATE KEY`)]) {
      const r = scanForSecrets(`før\n${evaded}\netter`);
      expect(r.text, JSON.stringify(evaded.slice(0, 40))).toBe(`før\n${redacted("private_key")}\netter`);
    }
  });

  it("tekst UTEN funn er BYTE-IDENTISK uendret: æøåÆØÅ i NFC og NFD, emoji med ZWJ, «ﬁ»-ligatur, kombinerende aksenter, CJK, arabisk, hindi, kyrillisk", () => {
    const texts = [
      "Blåbærsyltetøy hos Ørjan og Åse i Ålesund, ÆØÅ æøå",
      "👨‍👩‍👧 familien, 🏳️‍🌈 flagget og 👍🏽 takk",
      "ﬁnansiering, eﬃsient og ﬂaske",
      "café med résumé og näive",
      "会议记录：下周三下午三点在东京开会。",
      "مرحبا بالعالم سنلتقي غدا",
      "नमस्ते दुनिया, कल मिलते हैं",
      "Привет, как дела? Встреча завтра в 10:00",
      `soft${HIDDEN.softHyphen}hyphen og null${HIDDEN.zwsp}bredde i vanlig prosa`,
      `${HIDDEN.bom}Tekst med BOM først og ${HIDDEN.rlo}bidi${HIDDEN.pdf} etterpå`
    ];
    for (const text of texts) {
      for (const form of [text, text.normalize("NFC"), text.normalize("NFD"), text.normalize("NFKC")]) {
        const r = scanForSecrets(form);
        expect(r.findings, JSON.stringify(form)).toEqual([]);
        expect(r.text).toBe(form);
        expect(r.text === form && Object.is(r.text, form)).toBe(true);
      }
    }
  });

  it("er idempotent og beholder funntypene fra før: ren ASCII gir samme tekst og type som tidligere, og en andre skanning finner ingenting", () => {
    const inputs = [
      `min token er ${tok.github()} takk`,
      `${tok.anthropic()} og ${tok.aws()}`,
      `passordet mitt er ${body(10)}`,
      `${insertAt(tok.github(), 5, HIDDEN.zwsp)} og ${fullwidth(tok.aws())}`,
      tok.pem(2)
    ];
    for (const input of inputs) {
      const once = scanForSecrets(input);
      expect(once.findings.length).toBeGreaterThan(0);
      const twice = scanForSecrets(once.text);
      expect(twice.findings).toEqual([]);
      expect(twice.text).toBe(once.text);
    }
    expect(scanForSecrets(`min token er ${tok.github()} takk`).findings).toEqual([{ kind: "github_token", count: 1 }]);
  });
});

describe("K2a: en hemmelighet delt over mellomrom/linjeskift fanges (klemt visning, kun prefiks-forankrede regler)", () => {
  const splits: Array<[string, (t: string) => string]> = [
    ["midt i, over linjeskift", (t) => `${t.slice(0, 22)}\n${t.slice(22)}`],
    ["midt i, over mellomrom", (t) => `${t.slice(0, 22)} ${t.slice(22)}`],
    ["etter prefikset, over linjeskift", (t) => `${t.slice(0, 4)}\n${t.slice(4)}`],
    ["etter prefikset, over CRLF", (t) => `${t.slice(0, 4)}\r\n${t.slice(4)}`],
    ["i tre deler", (t) => `${t.slice(0, 15)} ${t.slice(15, 27)}\n${t.slice(27)}`],
    ["i fire deler med tabulator", (t) => `${t.slice(0, 10)}\t${t.slice(10, 20)}\t${t.slice(20, 30)}\t${t.slice(30)}`],
    ["inni prefikset (g hp_ ...)", (t) => `${t.slice(0, 1)} ${t.slice(1)}`],
    ["mellomrom mellom HVERT tegn", (t) => [...t].join(" ")],
    ["nullbredde + mellomrom blandet", (t) => `${t.slice(0, 10)}${HIDDEN.zwsp} ${HIDDEN.zwsp}${t.slice(10)}`]
  ];
  for (const [label, split] of splits) {
    it(`ghp_-token delt ${label}: hele spennet erstattes, teksten rundt røres ikke`, () => {
      for (const token of [tok.github(), tok.githubX()]) {
        const r = scanForSecrets(`Her er den: ${split(token)} og så videre`);
        expect(r.text, JSON.stringify(split(token))).toBe(`Her er den: ${redacted("github_token")} og så videre`);
        expect(r.findings).toEqual([{ kind: "github_token", count: 1 }]);
      }
    });
  }

  const families: Array<[string, string, string]> = [
    ["github_token", "github_pat_", tok.githubPat()],
    ["anthropic_key", "sk-ant-", tok.anthropic()],
    ["openai_key", "sk-", tok.openai()],
    ["slack_token", "xox", tok.slack()],
    ["aws_access_key", "AKIA", tok.aws()],
    ["jwt", "eyJ", tok.jwt()],
    ["npm_token", "npm_", tok.npm()],
    ["sendgrid_key", "SG.", tok.sendgrid()]
  ];
  for (const [kind, prefix, token] of families) {
    it(`${prefix}-formatet (${kind}) delt over linjeskift og mellomrom fanges`, () => {
      const at = Math.floor(token.length / 2);
      for (const split of [`${token.slice(0, at)}\n${token.slice(at)}`, `${token.slice(0, prefix.length)} ${token.slice(prefix.length)}`, `${token.slice(0, at)} ${token.slice(at, at + 5)}\n${token.slice(at + 5)}`]) {
        const r = scanForSecrets(`nøkkel:\n${split}\nslutt`);
        expect(r.findings.map((f) => f.kind), JSON.stringify(split)).toEqual([kind]);
        expect(r.text).toBe(`nøkkel:\n${redacted(kind)}\nslutt`);
      }
    });
  }

  it("privat nøkkel med BEGIN-linjen delt over linjeskift/mellomrom fanges (hele blokken)", () => {
    for (const header of ["-----BEGIN PRIVATE\nKEY-----", "-----BEGIN\nPRIVATE KEY-----", "-----BEGIN PRIVATE  KEY\n-----", "-----BEGIN RSA PRIVATE\nKEY-----"]) {
      const text = `${header}\n${body(64)}\n${body(64, 1)}\n-----END PRIVATE KEY-----\nferdig`;
      const r = scanForSecrets(text);
      expect(r.text, JSON.stringify(header)).toBe(`${redacted("private_key")}\nferdig`);
    }
  });

  it("to uavhengige ord på hver sin linje røres ikke, og et ferdig token med prosa etter seg beholder prosaen", () => {
    for (const text of ["ghp\n_\nvanlig tekst", "sk\n-\nnoe annet", "Hei\nverden\ner fin\ni dag", "AKIA\nsom prefiks", "Min token er " + tok.github() + " og den virker\nneste linje er vanlig"]) {
      const r = scanForSecrets(text);
      if (text.startsWith("Min token")) {
        expect(r.text).toBe(`Min token er ${redacted("github_token")} og den virker\nneste linje er vanlig`);
        continue;
      }
      expect(r, text).toEqual({ text, findings: [] });
    }
  });

  it("et prefiks nevnt i prosa (uten selve hemmeligheten) er ikke en hemmelighet - heller ikke med kortere ord etterpå", () => {
    for (const text of [
      "Tokens starter med ghp_ og er 40 tegn lange, så de kan ikke gjettes.",
      "I skjemaet står sk- foran nøkkelen, men verdien er fjernet.",
      "Prefikset xox brukes av Slack, og eyJ er starten på base64-kodet JSON.",
      "ghp_ er prefikset\nog resten står ikke her",
      "Risk-assessment of the pipeline is pending and Husk-listen er klar"
    ]) expect(scanForSecrets(text), text).toEqual({ text, findings: [] });
  });
});

describe("K3: nøkkelnavn-bevisst tekstform - JSON, Authorization og Cookie", () => {
  const value = body(18);
  const jsonKeys = ["api_key", "apiKey", "password", "passord", "passwd", "client_secret", "aws_secret_access_key", "private_key", "secret", "access_token", "refresh_token", "x-api-key", "Cookie", "authorization"];
  for (const key of jsonKeys) {
    it(`{"${key}": "…"} redigerer verdien og beholder gyldig JSON med nøkkelen`, () => {
      const input = JSON.stringify({ status: "ok", [key]: value, count: 3 });
      const r = scanForSecrets(input);
      expect(r.text).not.toContain(value);
      expect(r.findings.map((f) => f.kind)).toHaveLength(1);
      const parsed = JSON.parse(r.text) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(["status", key, "count"]);
      expect(parsed["status"]).toBe("ok");
    });
  }

  it("JSON med mellomrom, enkle anførselstegn og dobbelt-escapet JSON (`\\\"navn\\\":\\\"verdi\\\"`) fanges også", () => {
    for (const input of [`{ "password" :  "${value}" }`, `{'password': '${value}'}`, JSON.stringify(JSON.stringify({ password: value })), `{"a":{"b":{"client_secret":"${value}"}}}`, `{\n  "api_key":\n    "${value}"\n}`]) {
      const r = scanForSecrets(input);
      expect(r.text, input).not.toContain(value);
      expect(r.findings.length, input).toBeGreaterThan(0);
    }
  });

  it("trygge teller-/metadatanøkler og vanlig JSON er UENDRET: token_count, input_tokens, passwords_checked, token_type, expires_at ...", () => {
    for (const input of [
      `{"status":"ok","token_count":12,"passwords_checked":4}`,
      `{"input_tokens":120,"output_tokens":48,"max_tokens":4096,"total_tokens":168}`,
      `{"token_type":"Bearer","expires_in":3600,"expires_at":"2026-12-01T10:00:00Z","scope":"read write"}`,
      `{"password_policy":"strong","password_min_length":12,"secret_name":"JARVIS_GITHUB_TOKEN","api_key_id":"abc-123"}`,
      `{"auth":"none","token":"[REDACTED:named_secret]","description":"passord kreves ikke"}`,
      `{"user":"kari","email":"kari@example.no","active":true,"password_set":"ja"}`
    ]) expect(scanForSecrets(input), input).toEqual({ text: input, findings: [] });
  });

  it("Authorization: <skjema> <credential> for ALLE skjemaer redigerer credential, ikke skjemaordet (og feilen med «Bearer» er fikset)", () => {
    const cred = body(20, 2);
    const cases: Array<[string, string]> = [
      [`Authorization: Basic ${cred}==`, "Basic"],
      [`Authorization: Bearer abc123`, "Bearer"],
      [`Authorization: Bearer ${cred}`, "Bearer"],
      [`authorization: token ${cred}`, "token"],
      [`Authorization: ApiKey ${cred}`, "ApiKey"],
      [`Proxy-Authorization: Basic ${cred}`, "Basic"],
      [`Authorization: ${cred}`, ""],
      [`{"Authorization":"Basic ${cred}"}`, "Basic"],
      [`Authorization = Bearer ${cred}`, "Bearer"]
    ];
    for (const [input, scheme] of cases) {
      const r = scanForSecrets(input);
      expect(r.text, input).not.toContain("abc123");
      expect(r.text, input).not.toContain(cred);
      if (scheme !== "" && input.includes("abc123")) expect(r.text).toBe(`Authorization: Bearer ${redacted("authorization_header")}`);
      // `bearer_token` (≥ 16 tegn) erstatter hele «Bearer <token>» (uendret oppførsel, låst av growth-testen); alle andre skjemaer og korte Bearer-credentials beholder skjemaordet.
      else if (scheme !== "" && scheme !== "Bearer") expect(r.text, input).toContain(scheme);
      expect(r.findings.length, input).toBeGreaterThan(0);
      expect(scanForSecrets(r.text).findings, `idempotent: ${input}`).toEqual([]);
    }
  });

  it("Authorization-skjemaer med flere parametre (Digest, AWS4-HMAC-SHA256) redigeres til linjeslutt, og neste linje røres ikke", () => {
    const digest = `Authorization: Digest username="kari", realm="x", nonce="${body(16)}", response="${body(32)}"\nneste linje`;
    const r = scanForSecrets(digest);
    expect(r.text).toBe(`Authorization: Digest ${redacted("authorization_header")}\nneste linje`);
    const aws = `Authorization: AWS4-HMAC-SHA256 Credential=ID/20261126/eu-north-1/s3/aws4_request, SignedHeaders=host, Signature=${body(32, 4)}`;
    expect(scanForSecrets(aws).text).toBe(`Authorization: AWS4-HMAC-SHA256 ${redacted("authorization_header")}`);
    // en nøkkel-ID i credential-delen gir en annen type, men hele linjen er likevel redigert
    const withKey = scanForSecrets(`Authorization: AWS4-HMAC-SHA256 Credential=${tok.aws()}/20261126/eu-north-1/s3/aws4_request, Signature=${body(32, 4)}`);
    expect(withKey.text).not.toContain(tok.aws());
    expect(withKey.text).not.toContain(body(32, 4));
  });

  it("Authorization med plassholder eller bare skjemaet er ikke en hemmelighet og får ikke «Bearer» redigert", () => {
    for (const text of ["Bruk Authorization: Bearer <token> når du kaller API-et.", "Authorization: Basic <base64>", "Authorization: Bearer ${TOKEN}", "Authorization: Bearer", "Authorization-headeren settes av proxyen."]) {
      expect(scanForSecrets(text), text).toEqual({ text, findings: [] });
    }
  });

  it("Cookie: og Set-Cookie: redigeres til linjeslutt (kun med name=value), og prosa med «Cookie» røres ikke", () => {
    expect(scanForSecrets(`Cookie: session=${body(20)}; theme=dark\nHost: x`).text).toBe(`Cookie: ${redacted("cookie_header")}\nHost: x`);
    expect(scanForSecrets(`Set-Cookie: sid=${body(20)}; Path=/; HttpOnly`).text).toBe(`Set-Cookie: ${redacted("cookie_header")}`);
    for (const text of ["Cookie: godkjent av styret", "Cookies: vi bruker informasjonskapsler", "Cookie-banner vises første gang", "Set-Cookie-policyen oppdateres"]) {
      expect(scanForSecrets(text), text).toEqual({ text, findings: [] });
    }
  });
});

describe("K4: nye formater (alle `unverified`: docs-vertene var blokkert) og kontekst-policy for hex/base64", () => {
  const formats: Array<[string, () => string]> = [
    ["sendgrid_key", tok.sendgrid],
    ["npm_token", tok.npm],
    ["gitlab_token", tok.gitlab],
    ["google_oauth_token", tok.googleOauth],
    ["huggingface_token", tok.huggingface]
  ];
  for (const [kind, make] of formats) {
    it(`${kind}: fanges i prosa og i NAVN=verdi, og et nært, men feil format røres ikke`, () => {
      const token = make();
      const r = scanForSecrets(`se ${token}, takk`);
      expect(r.text).toBe(`se ${redacted(kind)}, takk`);
      expect(scanForSecrets(`${token.slice(0, 5)} er et prefiks`)).toEqual({ text: `${token.slice(0, 5)} er et prefiks`, findings: [] });
    });
  }

  it("Azure: AccountKey=… og SAS-signatur (sig=) i tilkoblingsstreng/URL redigeres", () => {
    const conn = `DefaultEndpointsProtocol=https;AccountName=lager;AccountKey=${tok.azureKey()};EndpointSuffix=core.windows.net`;
    expect(scanForSecrets(conn).text).toBe(`DefaultEndpointsProtocol=https;AccountName=lager;AccountKey=${redacted("azure_key")};EndpointSuffix=core.windows.net`);
    const sas = `https://lager.blob.core.windows.net/c/f.txt?sv=2022-11-02&ss=b&srt=co&sp=r&se=2026-12-01T00:00:00Z&sig=${body(30)}%3D`;
    const r = scanForSecrets(sas);
    expect(r.findings.map((f) => f.kind)).toEqual(["azure_key"]);
    expect(r.text).toContain("sv=2022-11-02&ss=b");
    expect(r.text).not.toContain(body(30));
  });

  it("hex og base64 redigeres KUN med et hemmelighetsord rett foran (aldri frittstående)", () => {
    const hex = "3f2a9c".repeat(11).slice(0, 64);
    const b64 = body(44, 5);
    for (const text of [`the signing secret is ${hex}`, `key: ${hex}`, `HMAC key ${hex}`, `nøkkel ${b64}`, `signing secret = ${b64}`, `secret: "${b64}"`, `salt ${b64}==`]) {
      const r = scanForSecrets(text);
      expect(r.findings.length, text).toBeGreaterThan(0);
      expect(r.text, text).not.toContain(hex);
      expect(r.text, text).not.toContain(b64);
      expect(r.text, text).toContain("[REDACTED:");
    }
    // frittstående og kjente trygge former: uendret
    for (const text of [
      hex, b64, `sha256sum: ${hex}`, `commit ${"0123456789abcdef".repeat(3).slice(0, 40)}`, `image@sha256:${hex}`, `uuid ${uuid}`,
      `data:image/png;base64,${body(120, 2)}`, `trace_id=4bf92f3577b34da6a3ce929d0e0e4736`, `${["ke", "y"].join("")}: ${uuid}`, `secret kvalitetssikringsprosedyrebeskrivelsesdokumentet`,
      `key my-very-long-article-slug-2026-edition-final-v2`
    ]) expect(scanForSecrets(text), text).toEqual({ text, findings: [] });
  });

  it("privat nøkkel-blokken fanges for alle vanlige etiketter, også uten END (fail-closed til slutten)", () => {
    for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
      const r = scanForSecrets(`a\n${tok.pem(2, label)}\nb`);
      expect(r.text, label).toBe(`a\n${redacted("private_key")}\nb`);
    }
    expect(scanForSecrets(`før\n${pemBegin()}\n${body(64)}\nuten slutt`).text).toBe(`før\n${redacted("private_key")}`);
  });
});

describe("K6: ytelse og vinduer - hver adversarielle inndata tar under 2 s, og et spenn over vindusgrensen fanges", () => {
  const timed = (label: string, text: string): number => {
    const started = Date.now();
    scanForSecrets(text);
    const ms = Date.now() - started;
    expect(ms, label).toBeLessThan(2000);
    return ms;
  };

  it("1 MB nullbredde / kombinerende merker / fullbredde / blanke / usynlige tegn", () => {
    timed("nullbredde", HIDDEN.zwsp.repeat(1_000_000));
    timed("kombinerende", `a${HIDDEN.acute}`.repeat(500_000));
    timed("fullbredde", fullwidth("ghp_").repeat(250_000));
    timed("fullbredde prosa", fullwidth("passord er ").repeat(100_000));
    timed("blanke", " ".repeat(1_000_000));
    timed("usynlige blandet", `x${HIDDEN.zwsp}${HIDDEN.softHyphen}${HIDDEN.rlo}`.repeat(250_000));
  });

  it("gjentatte prefikser uten kropp og uavsluttede blokker: ghp_, BEGIN uten END, eyJ + punktum, a.", () => {
    timed("ghp_", "ghp_".repeat(125_000));
    timed("ghp_ med mellomrom", "ghp_ ".repeat(100_000));
    timed("g h p _", "g h p _ ".repeat(70_000));
    timed("BEGIN uten END", `${pemBegin()}\n`.repeat(20_000));
    timed("BEGIN uten END (216 KB)", pemBegin().repeat(8_000));
    timed("eyJ + punktum", "eyJ.".repeat(125_000));
    timed("eyJ med punktum og mellomrom", "eyJabcdefghij. ".repeat(40_000));
    timed("a. (500 KB)", "a.".repeat(250_000));
    timed("sk- med mellomrom", "sk- ".repeat(125_000));
    timed("xox / AKIA / SG.", "xox AKIA SG. npm_ glpat- hf_ ".repeat(20_000));
    timed("mellomrom mellom token-tegn", "ghp_ " + "a ".repeat(250_000));
    timed("tegn-mellomrom-tegn uten prefiks", "ab ".repeat(300_000));
    timed("JSON-nøkler uten verdi", '"password":'.repeat(80_000));
    timed("Cookie:-flom", "Cookie:".repeat(100_000));
    timed("Authorization:-flom", "Authorization: ".repeat(60_000));
    timed("secret + lang løpe", "secret " + "a1B2".repeat(150_000));
    timed("lege-lege og TOKEN-", "lege-".repeat(100_000) + "TOKEN-".repeat(80_000));
  });

  it("vinduer: et token som krysser vindusgrensen fanges ved alle forskyvninger, og overlappet er minst 8 KiB", () => {
    expect(SCAN_OVERLAP_CHARS).toBeGreaterThanOrEqual(8 * 1024);
    expect(SCAN_WINDOW_CHARS).toBeGreaterThan(2 * SCAN_OVERLAP_CHARS);
    const token = tok.github();
    const step = SCAN_WINDOW_CHARS - SCAN_OVERLAP_CHARS;
    for (const offset of [-60, -37, -36, -20, -8, -1, 0, 1, 20, 36, 60]) {
      const at = SCAN_WINDOW_CHARS + offset;
      const text = `${" ".repeat(at)}${token}${" ".repeat(SCAN_WINDOW_CHARS * 2)}`;
      const r = scanForSecrets(text);
      expect(r.findings, `offset ${offset}`).toEqual([{ kind: "github_token", count: 1 }]);
      expect(r.text.length, `offset ${offset}`).toBe(text.length - token.length + redacted("github_token").length);
    }
    // også i andre vinduskifter
    for (const k of [2, 3]) {
      const at = k * step + SCAN_OVERLAP_CHARS - 10;
      const text = `${" ".repeat(at)}${token}${" ".repeat(SCAN_WINDOW_CHARS)}`;
      expect(scanForSecrets(text).findings, `k=${k}`).toEqual([{ kind: "github_token", count: 1 }]);
    }
    // delt over blanke OG over vindusgrensen
    const split = `${token.slice(0, 20)}\n${token.slice(20)}`;
    const text = `${" ".repeat(SCAN_WINDOW_CHARS - 10)}${split}${" ".repeat(SCAN_WINDOW_CHARS)}`;
    expect(scanForSecrets(text).findings).toEqual([{ kind: "github_token", count: 1 }]);
  });

  it("vinduer: funn i alle vinduer telles riktig (ingen dobbelttelling i overlappet), og en privat nøkkel som strekker seg over flere vinduer redigeres helt", () => {
    const token = tok.github();
    const filler = " ".repeat(40_000);
    const text = Array.from({ length: 20 }, (_, i) => `${filler}${tok.github(i)}`).join("\n");
    expect(text.length).toBeGreaterThan(3 * SCAN_WINDOW_CHARS);
    const r = scanForSecrets(text);
    expect(r.findings).toEqual([{ kind: "github_token", count: 20 }]);
    expect(r.text).not.toContain(token.slice(4, 14));
    const bigKey = `${pemBegin()}\n${Array.from({ length: 12_000 }, (_, i) => body(64, i)).join("\n")}\n${pemEnd()}`;
    expect(bigKey.length).toBeGreaterThan(2 * SCAN_WINDOW_CHARS);
    const r2 = scanForSecrets(`start\n${bigKey}\nslutt ${token}`);
    expect(r2.text).toBe(`start\n${redacted("private_key")}\nslutt ${redacted("github_token")}`);
    // uavsluttet nøkkel over flere vinduer: alt til slutten er redigert
    const open = `start\n${pemBegin()}\n${Array.from({ length: 12_000 }, (_, i) => body(64, i)).join("\n")}`;
    expect(scanForSecrets(open).text).toBe(`start\n${redacted("private_key")}`);
  });
});
