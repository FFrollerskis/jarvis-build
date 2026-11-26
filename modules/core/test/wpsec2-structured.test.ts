import { describe, expect, it } from "vitest";
import { STRUCTURED_MAX_DEPTH, STRUCTURED_MAX_NODES, scanStructuredForSecrets } from "../src/services/secret-scan-structured.ts";
import { classifyKey } from "../src/services/secret-scan-keys.ts";
import { body, tok } from "./support/secret-fixtures.ts";

/**
 * WP-SEC2 (K2b, K3, K6): strukturert skanning. `scanStructuredForSecrets(value)` skanner hver streng, limer søsken-strenger i samme objekt/liste sammen (delte tokens), redigerer verdier under hemmelige NØKKELNAVN (med en
 * hviteliste av teller-/metadatanøkler), og er fail-closed og begrenset (dybde, antall noder, sykluser).
 */
const MARK = (kind: string): string => `[REDACTED:${kind}]`;

describe("K2b: søsken-strenger skannes sammen", () => {
  it("[\"ghp_\", \"A1b2…\"] fanges (begge deler redigeres) og telles som ÉN hemmelighet", () => {
    const token = tok.github();
    const r = scanStructuredForSecrets([token.slice(0, 4), token.slice(4)]);
    expect(r.value).toEqual([MARK("github_token"), MARK("github_token")]);
    expect(r.findings).toEqual([{ kind: "github_token", count: 1 }]);
  });

  it("samme i objekt (to felt), tre deler, og en del midt i vanlige strenger", () => {
    const token = tok.github(2);
    expect(scanStructuredForSecrets({ a: token.slice(0, 4), b: token.slice(4, 20), c: token.slice(20) }).value).toEqual({ a: MARK("github_token"), b: MARK("github_token"), c: MARK("github_token") });
    const r = scanStructuredForSecrets({ før: "hei", a: token.slice(0, 22), b: token.slice(22), etter: "ha det" });
    expect(r.value).toEqual({ før: "hei", a: MARK("github_token"), b: MARK("github_token"), etter: "ha det" });
    const nested = scanStructuredForSecrets({ rad: { deler: [token.slice(0, 10), token.slice(10)] }, id: 7 });
    expect(nested.value).toEqual({ rad: { deler: [MARK("github_token"), MARK("github_token")] }, id: 7 });
  });

  it("delt over blanke i EN streng og over to strenger samtidig (den ene med linjeskift)", () => {
    const token = tok.githubX();
    const r = scanStructuredForSecrets([`bruk ${token.slice(0, 10)}\n${token.slice(10, 20)}`, `${token.slice(20)} slutt`]);
    expect(r.value).toEqual([`bruk ${MARK("github_token")}`, `${MARK("github_token")} slutt`]);
    expect(r.findings).toEqual([{ kind: "github_token", count: 1 }]);
  });

  it("to uavhengige ord på hver sin plass røres ikke, og uendrede verdier returneres som SAMME objekt", () => {
    const input = { liste: ["ghp", "_", "sk", "-", "vanlig", "tekst"], navn: "Kari", antall: 3, ok: true, ingen: null };
    const r = scanStructuredForSecrets(input);
    expect(r.findings).toEqual([]);
    expect(r.value).toBe(input);
    const list = ["Hei", "verden", "er", "fin"];
    expect(scanStructuredForSecrets(list).value).toBe(list);
  });

  it("en privat nøkkel uten avslutning i EN streng sluker ikke søsknene (hver streng skannes for seg)", () => {
    const r = scanStructuredForSecrets(["før", `-----BEGIN PRIVATE KEY-----\n${body(64)}`, "andre søsken som skal stå igjen"]);
    expect(r.value).toEqual(["før", MARK("private_key"), "andre søsken som skal stå igjen"]);
  });

  it("en privat nøkkel delt over to strenger (BEGIN i én, END i neste) fanges", () => {
    const r = scanStructuredForSecrets([`-----BEGIN PRIVATE KEY-----\n${body(64)}`, `${body(64, 1)}\n-----END PRIVATE KEY-----`]);
    expect(JSON.stringify(r.value)).not.toContain(body(64));
    expect(r.findings).toEqual([{ kind: "private_key", count: 1 }]);
  });

  it("alle tekstfunn gjelder også i strukturen: JWT, AWS-nøkkel og NAVN=verdi", () => {
    const r = scanStructuredForSecrets({ a: `bruk ${tok.jwt()}`, b: `nøkkel ${tok.aws()}`, c: `JARVIS_TOKEN=${body(12)}` });
    expect(JSON.stringify(r.value)).not.toContain(tok.aws());
    expect(r.findings.map((f) => f.kind).sort()).toEqual(["aws_access_key", "jwt", "named_secret"]);
  });
});

describe("K3: nøkkelnavn-bevisst redaksjon i strukturer", () => {
  const secretKeys = ["password", "Password", "passord", "passwd", "api_key", "apiKey", "API-KEY", "client_secret", "clientSecret", "aws_secret_access_key", "private_key", "secret", "access_token", "refreshToken", "authorization", "Authorization", "cookie", "x-api-key", "accesstoken", "db_password", "session_token", "credentials", "bearer"];
  for (const key of secretKeys) {
    it(`verdien under «${key}» redigeres uansett format`, () => {
      const r = scanStructuredForSecrets({ id: "r1", [key]: "enkelt-ord-uten-format", ok: true });
      expect(r.value).toEqual({ id: "r1", [key]: MARK("named_secret"), ok: true });
      expect(r.findings).toEqual([{ kind: "named_secret", count: 1 }]);
    });
  }

  it("hvitliste: teller-/metadatanøkler beholder verdien - og hele objektet returneres uendret", () => {
    const input = {
      status: "ok", token_count: 12, passwords_checked: 4, input_tokens: 120, output_tokens: 48, max_tokens: 4096, token_type: "Bearer", expires_at: "2026-12-01T10:00:00Z", expires_in: 3600,
      secret_name: "JARVIS_GITHUB_TOKEN", password_policy: "strong", api_key_id: "abc-123", private_key_id: "k1", token_url: "https://auth.example.com/token", auth: "none", key: "x", cache_key: "a:b:c",
      idempotency_key: "k-1", primary_key: "id", password_hash: "hash", tokens: ["a", "b"], passwords: 3, author: "Kari", tokenizer: "bpe", secretary: "Per"
    };
    const r = scanStructuredForSecrets(input);
    expect(r.findings).toEqual([]);
    expect(r.value).toBe(input);
    expect(classifyKey("token_count")).toMatchObject({ secret: false, safe: true });
    expect(classifyKey("password")).toMatchObject({ secret: true, strong: true });
    expect(classifyKey("auth_token")).toMatchObject({ secret: true });
    expect(classifyKey("max_tokens").secret).toBe(false);
    expect(classifyKey("api_key")).toMatchObject({ secret: true, strong: true });
    expect(classifyKey("cache_key").secret).toBe(false);
  });

  it("tall under en STERK nøkkel (passord/PIN/privat nøkkel) redigeres, men ikke under `token` (ofte en teller); boolske og null røres aldri", () => {
    const r = scanStructuredForSecrets({ password: 12345678, pin: 4821, token: 12345, passwords: 3, secret: true, api_key: null, count: 5 });
    expect(r.value).toEqual({ password: MARK("named_secret"), pin: MARK("named_secret"), token: 12345, passwords: 3, secret: true, api_key: null, count: 5 });
  });

  it("korte verdier under ikke-sterke nøkler (`auth: none`, `token: ok`) røres ikke, men et passord av enhver lengde redigeres", () => {
    expect(scanStructuredForSecrets({ auth: "none", token: "ok", password: "x" }).value).toEqual({ auth: "none", token: "ok", password: MARK("named_secret") });
  });

  it("en hemmelig FORELDER redigerer alle strenger under seg (rekursivt, også i lister), men beholder metadatanøkler", () => {
    const r = scanStructuredForSecrets({
      credentials: { type: "oauth", client_id: "jarvis-web", access_token: "abc", nested: { user: "kari", pass: "pw", list: ["a", "b"], expires_at: "2026-12-01" } },
      other: { user: "kari" }
    });
    expect(r.value).toEqual({
      credentials: { type: "oauth", client_id: "jarvis-web", access_token: MARK("named_secret"), nested: { user: MARK("named_secret"), pass: MARK("named_secret"), list: [MARK("named_secret"), MARK("named_secret")], expires_at: "2026-12-01" } },
      other: { user: "kari" }
    });
  });

  it("allerede redigerte verdier røres ikke (idempotent), og en andre skanning finner ingenting", () => {
    const once = scanStructuredForSecrets({ password: "hunter22", note: `bruk ${tok.github()}` });
    const twice = scanStructuredForSecrets(once.value);
    expect(twice.findings).toEqual([]);
    expect(twice.value).toEqual(once.value);
  });

  it("selve nøkkelnavnet kan være en hemmelighet: redigeres, og kollisjoner gjør nøklene unike", () => {
    const a = tok.github(1);
    const b = tok.github(2);
    const r = scanStructuredForSecrets({ [`${a}`]: 1, [`${b}`]: 2 });
    expect(JSON.stringify(r.value)).not.toContain(a.slice(4));
    expect(Object.keys(r.value as object)).toEqual([MARK("github_token"), `${MARK("github_token")}~2`]);
    expect(r.findings).toEqual([{ kind: "github_token", count: 2 }]);
  });

  it("andre verdityper bevares: Date, Buffer, undefined, nøstede tomme strukturer", () => {
    const date = new Date("2026-11-26T10:00:00Z");
    const buf = Buffer.from("hei");
    const input = { at: date, raw: buf, u: undefined, e: {}, l: [] as unknown[] };
    const r = scanStructuredForSecrets(input);
    expect((r.value as typeof input).at).toBe(date);
    expect((r.value as typeof input).raw).toBe(buf);
    expect(r.value).toBe(input);
  });
});

describe("K6: fail-closed og begrenset (dybde, antall, sykluser) - alle under 2 s", () => {
  it("JSON-dybde 10 000: ingen stakkoverflyt; alt under dybdegrensen erstattes av en markør (fail-closed) og funnet rapporteres", () => {
    let deep: unknown = { hemmelig: `bruk ${tok.github()}` };
    for (let i = 0; i < 10_000; i += 1) deep = { a: deep };
    const started = Date.now();
    const r = scanStructuredForSecrets(deep);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.findings).toEqual([{ kind: "structure_limit", count: 1 }]);
    let node = r.value as Record<string, unknown>;
    for (let i = 0; i < STRUCTURED_MAX_DEPTH; i += 1) node = node["a"] as Record<string, unknown>;
    expect(node).toBe(MARK("structure_limit"));
    // også lister
    let deepList: unknown = ["x"];
    for (let i = 0; i < 10_000; i += 1) deepList = [deepList];
    expect(scanStructuredForSecrets(deepList).findings).toEqual([{ kind: "structure_limit", count: 1 }]);
  });

  it("100 000 søsken-strenger (og et delt token i halen) skannes under 2 s", () => {
    const token = tok.github();
    const siblings = Array.from({ length: 100_000 }, (_, i) => `ord${i}`);
    siblings.push(token.slice(0, 10), token.slice(10));
    const started = Date.now();
    const r = scanStructuredForSecrets(siblings);
    expect(Date.now() - started).toBeLessThan(2000);
    const out = r.value as string[];
    expect(out).toHaveLength(100_002);
    expect(out[100_000]).toBe(MARK("github_token"));
    expect(out[100_001]).toBe(MARK("github_token"));
    expect(out[5]).toBe("ord5");
    expect(r.findings).toEqual([{ kind: "github_token", count: 1 }]);
    // og 100 000 søsken i et objekt
    const obj: Record<string, string> = {};
    for (let i = 0; i < 100_000; i += 1) obj[`k${i}`] = `verdi ${i}`;
    const started2 = Date.now();
    expect(scanStructuredForSecrets(obj).findings).toEqual([]);
    expect(Date.now() - started2).toBeLessThan(2000);
  });

  it("sykliske referanser gir en markør i stedet for uendelig rekursjon, og for mange noder kappes fail-closed", () => {
    const a: Record<string, unknown> = { navn: "a" };
    a["self"] = a;
    const r = scanStructuredForSecrets(a);
    expect((r.value as Record<string, unknown>)["self"]).toBe(MARK("structure_limit"));
    expect(r.findings).toEqual([{ kind: "structure_limit", count: 1 }]);
    const many = Array.from({ length: STRUCTURED_MAX_NODES + 10 }, () => 1);
    const rm = scanStructuredForSecrets({ rader: many.map((n, i) => (i % 2 === 0 ? { n } : n)) });
    expect(rm.findings.some((f) => f.kind === "structure_limit")).toBe(true);
  });

  it("en streng på toppnivå skannes som tekst", () => {
    expect(scanStructuredForSecrets(`bruk ${tok.aws()} nå`)).toEqual({ value: `bruk ${MARK("aws_access_key")} nå`, findings: [{ kind: "aws_access_key", count: 1 }] });
    expect(scanStructuredForSecrets(42)).toEqual({ value: 42, findings: [] });
    expect(scanStructuredForSecrets(null)).toEqual({ value: null, findings: [] });
  });
});
