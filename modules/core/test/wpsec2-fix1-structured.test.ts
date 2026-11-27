import { describe, expect, it } from "vitest";
import { classifyKey } from "../src/services/secret-scan-keys.ts";
import { scanStructuredForSecrets } from "../src/services/secret-scan-structured.ts";
import { scanForSecrets } from "../src/services/secret-scan.ts";
import { HIDDEN, body, fullwidth, pemBegin, tok } from "./support/secret-fixtures.ts";

/**
 * WP-SEC2 fiks-runde 1, strukturert skanning og nøkkelklassifisering (review A: M2, L3, L4, L6, L9 + testhull K2/K9/T12/T15). Alle verdier bygges sammensatt ved kjøring.
 */
const J = (...parts: string[]): string => parts.join("");
const marker = (kind: string): string => `[REDACTED:${kind}]`;
const NAMED = marker("named_secret");
const json = (value: unknown): string => JSON.stringify(value);

describe("A-M2: nøkkelkollisjon i scanStructuredForSecrets er ikke kvadratisk", () => {
  const collidingKeys = (count: number): string[] => {
    const keys: string[] = [];
    for (let i = 0; i < count; i += 1) keys.push(J("gh", "p_") + body(36, i) + String(i).padStart(6, "0").replace(/\d/g, (d) => "abcdefghij"[Number(d)] as string));
    return keys;
  };
  it("20 000 nøkler som alle blir [REDACTED:github_token] skannes på under 1 s (tidligere 30 s)", () => {
    const obj: Record<string, number> = {};
    for (const k of collidingKeys(20_000)) obj[k] = 1;
    const started = Date.now();
    const r = scanStructuredForSecrets(obj);
    expect(Date.now() - started).toBeLessThan(1000);
    const keys = Object.keys(r.value as Record<string, unknown>);
    expect(keys).toHaveLength(20_000);
    expect(new Set(keys).size).toBe(20_000);
    expect(keys[0]).toBe(marker("github_token"));
    expect(keys[1]).toBe(`${marker("github_token")}~2`);
    expect(keys[19_999]).toBe(`${marker("github_token")}~20000`);
    expect(r.findings).toEqual([{ kind: "github_token", count: 20_000 }]);
  });
  it("kollisjoner med en eksisterende nøkkel `<markør>~2` hoppes over, og navnene forblir unike og stabile", () => {
    const [a, b, c] = collidingKeys(3) as [string, string, string];
    const r = scanStructuredForSecrets({ [a]: 1, [`${marker("github_token")}~2`]: 2, [b]: 3, [c]: 4 });
    const keys = Object.keys(r.value as Record<string, unknown>);
    expect(new Set(keys).size).toBe(4);
    expect(keys).toEqual([marker("github_token"), `${marker("github_token")}~2`, `${marker("github_token")}~3`, `${marker("github_token")}~4`]);
  });
  it("20 000 kolliderende nøkler MED strengverdier (som også skannes) holder samme tak", () => {
    const obj: Record<string, string> = {};
    for (const k of collidingKeys(20_000)) obj[k] = "ok";
    const started = Date.now();
    scanStructuredForSecrets(obj);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("A-L3: uavsluttet privat nøkkel med skjult/fullbredde BEGIN blant søsken lekker ikke", () => {
  it("fullbredde og nullbredde i BEGIN-linjen, ingen END, minst to søsken", () => {
    const b = body(64, 1);
    for (const begin of [fullwidth(pemBegin()), pemBegin().replace("BEGIN", `BE${HIDDEN.zwsp}GIN`), pemBegin().replace("-----BEGIN", `-----${HIDDEN.softHyphen}BEGIN`)]) {
      expect(json(scanStructuredForSecrets(["før", `${begin}\n${b}`, "etter"]).value), json(begin.slice(0, 14))).not.toContain(b);
      expect(json(scanStructuredForSecrets({ a: "før", b: `${begin}\n${b}`, c: "etter" }).value), json(begin.slice(0, 14))).not.toContain(b);
    }
  });
  it("vanlig (synlig) BEGIN uten END og søsken uten BEGIN er uendret som før", () => {
    const b = body(64, 1);
    expect(json(scanStructuredForSecrets(["før", `${pemBegin()}\n${b}`, "etter"]).value)).not.toContain(b);
    const plain = ["første", "andre", "tredje"];
    expect(scanStructuredForSecrets(plain).value).toBe(plain);
  });
});

describe("A-L4: Error med enumerable egenskaper returneres ikke uskannet, og skanningen kaster aldri", () => {
  it("axios-lignende feil: config.headers.Authorization og egenskaper med token redigeres (JSON.stringify av resultatet)", () => {
    const err = new Error("x") as Error & Record<string, unknown>;
    err["config"] = { headers: { Authorization: `Bearer ${body(30)}` } };
    err["extra"] = tok.github();
    const r = scanStructuredForSecrets({ e: err });
    expect(json(r.value)).not.toContain(body(30));
    expect(json(r.value)).not.toContain(tok.github().slice(8, 30));
    expect(r.findings.length).toBeGreaterThan(0);
  });
  it("en Error uten enumerable egenskaper returneres uendret (samme referanse), også inni et objekt", () => {
    const err = new Error(`feil ${tok.github()}`);
    expect(scanStructuredForSecrets(err).value).toBe(err);
    const holder = { e: err, n: 1 };
    expect(scanStructuredForSecrets(holder).value).toBe(holder);
  });
  it("kastende getter, kastende Proxy og tilbakekalt Proxy kaster ikke ut av skanningen: noden erstattes fail-closed, resten skannes", () => {
    const evil = { a: "ok", get b(): string { throw new Error("boom"); } };
    const proxy = new Proxy({}, { ownKeys() { throw new Error("ownKeys"); }, getPrototypeOf() { throw new Error("proto"); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const r = scanStructuredForSecrets({ evil, proxy, revoked: revoked.proxy, keep: `bruk ${tok.github()}`, fine: "viktig" });
    const out = r.value as Record<string, unknown>;
    expect(out["evil"]).toBe(marker("structure_limit"));
    expect(out["proxy"]).toBe(marker("structure_limit"));
    expect(out["revoked"]).toBe(marker("structure_limit"));
    expect(out["keep"]).toBe(`bruk ${marker("github_token")}`);
    expect(out["fine"]).toBe("viktig");
    expect(r.findings).toEqual(expect.arrayContaining([{ kind: "structure_limit", count: 3 }, { kind: "github_token", count: 1 }]));
  });
  it("kastende toJSON og toppnivå-Proxy gir fail-closed markør i stedet for kast", () => {
    expect(() => scanStructuredForSecrets({ toJSON() { throw new Error("x"); } })).not.toThrow();
    const top = new Proxy({}, { ownKeys() { throw new Error("x"); } });
    expect(scanStructuredForSecrets(top).value).toBe(marker("structure_limit"));
  });
});

describe("A-L6: nøkkelklassifisering - flere hemmelighetsnøkler, men ikke id-er uten hemmelighetsord", () => {
  const secretKeys = [
    "password_confirmation", "passwordConfirm", "password_again", "password1", "password2", "passwd2", "secret_key_base", "SECRET_KEY_BASE", "recovery_code", "recovery_codes", "backup_codes", "ssh_key", "deploy_key", "cvv", "cvc", "cvv2",
    "webhook_url", "signed_url", "presigned_url", "nøkkel", "api_nøkkel", "privat_nøkkel", "hemmelig_nøkkel", "signeringsnøkkel_pem"
  ];
  for (const key of secretKeys) it(`«${key}» er en hemmelighetsnøkkel`, () => expect(classifyKey(key).secret, key).toBe(true));

  const plainKeys = [
    "session_id", "sessionId", "user_id", "request_id", "primary_key", "sort_key", "cache_key", "idempotency_key", "partition_key", "key", "keys", "webhook_id", "url", "callback_url", "password_policy",
    "password_min_length", "token_count", "nextPageToken", "page_token", "next_token", "primær_nøkkel", "fremmed_nøkkel", "database", "knowledge_base", "recovery_email", "backup_enabled", "deploy_target", "cvv_required"
  ];
  for (const key of plainKeys) it(`«${key}» er IKKE en hemmelighetsnøkkel (id/teller/metadata/uten hemmelighetsord)`, () => expect(classifyKey(key).secret, key).toBe(false));

  it("sterke nøkler redigerer også tall (cvv, passord), svake (nøkkel, token) gjør ikke det", () => {
    expect(scanStructuredForSecrets({ cvv: 123, password1: 1234, nøkkel: 12 }).value).toEqual({ cvv: NAMED, password1: NAMED, nøkkel: 12 });
    expect(classifyKey("nøkkel").strong).toBe(false);
    expect(classifyKey("api_nøkkel").strong).toBe(true);
  });
  it("strukturert: de nye nøklene redigerer verdien, og session_id/primary_key røres ikke", () => {
    const value = body(20);
    const input = { password_confirmation: value, secret_key_base: value, recovery_code: value, ssh_key: value, deploy_key: value, cvv: "123", webhook_url: `https://hooks.example.com/${value}`, nøkkel: value, session_id: value, primary_key: value };
    const out = scanStructuredForSecrets(input).value as Record<string, unknown>;
    for (const key of ["password_confirmation", "secret_key_base", "recovery_code", "ssh_key", "deploy_key", "cvv", "webhook_url", "nøkkel"]) expect(out[key], key).toBe(NAMED);
    expect(out["session_id"]).toBe(value);
    expect(out["primary_key"]).toBe(value);
  });
  it("tekst-JSON: de nye nøklene redigeres også i `\"navn\":\"verdi\"`-form", () => {
    const value = body(20);
    for (const key of ["password_confirmation", "passwordConfirm", "secret_key_base", "recovery_code", "ssh_key", "deploy_key", "cvv", "webhook_url", "signed_url", "nøkkel"]) {
      const out = scanForSecrets(json({ ok: true, [key]: value }));
      expect(out.text, key).not.toContain(value);
      expect(out.text, key).toContain(NAMED);
    }
    const plain = json({ session_id: value, primary_key: value, nextPageToken: value });
    expect(scanForSecrets(plain)).toEqual({ text: plain, findings: [] });
  });
  it("authorization_header / auth_header med `Basic …`: verdien redigeres, men et headernavn og en plassholder røres ikke", () => {
    const basic = `Basic ${body(24, 2)}==`;
    for (const key of ["authorization_header", "auth_header", "authHeader", "proxy_authorization_header"]) {
      expect(scanStructuredForSecrets({ [key]: basic }).value, key).toEqual({ [key]: NAMED });
      expect(scanForSecrets(json({ [key]: basic })).text, key).toBe(json({ [key]: NAMED }));
      for (const harmless of ["X-Api-Key", "Authorization", "Bearer <token>", "Basic <base64>", "none"]) expect(scanStructuredForSecrets({ [key]: harmless }).value, `${key}=${harmless}`).toEqual({ [key]: harmless });
    }
  });
});

describe("A-L9 (strukturert): paginerings-tokens og status-/plassholderverdier", () => {
  it("nextPageToken/page_token/next_token er uendret (samme referanse)", () => {
    const value = { items: [1], nextPageToken: `CAESBAgBEAA${body(20)}`, page_token: `CAESBAgBEAA${body(20)}`, next_token: body(30) };
    expect(scanStructuredForSecrets(value).value).toBe(value);
  });
  it("status- og plassholderverdier under hemmelighetsnøkler er uendret, ekte verdier redigeres fortsatt", () => {
    const harmless = { password: "required", api_key: "YOUR_API_KEY", cookie: "accepted", auth: "oauth2", token: " world", client_secret: "your-client-secret-here", secret: "REPLACE_ME" };
    expect(scanStructuredForSecrets(harmless).value).toBe(harmless);
    const real = { password: "required123!", api_key: `YOUR_API_KEY_${body(20)}`, cookie: `accepted-${body(16)}`, token: body(30), auth: body(30) };
    const out = scanStructuredForSecrets(real).value as Record<string, unknown>;
    for (const key of Object.keys(real)) expect(out[key], key).toBe(NAMED);
  });
});

describe("testhull fra review A (strukturert; hver test dreper en navngitt mutant)", () => {
  it("K2: `client` er et nøkkelkvalifikasjonsord (client_key er en hemmelig nøkkel, også for en kort verdi)", () => {
    expect(scanStructuredForSecrets({ client_key: "abcdefghij" }).value).toEqual({ client_key: NAMED });
    expect(scanForSecrets('{"client_key":"abcdefghij"}').text).toBe(`{"client_key":"${NAMED}"}`);
  });
  it("K9: `auth` er et hemmelighetsord (`auth: <lang verdi>` redigeres), mens en kort verdi under den ikke-sterke nøkkelen røres ikke", () => {
    expect(scanStructuredForSecrets({ auth: "longvalue123" }).value).toEqual({ auth: NAMED });
    expect(scanStructuredForSecrets({ auth: "x1" }).value).toEqual({ auth: "x1" });
  });
  it("T15: toJSON() skannes (verdien toJSON returnerer, ikke objektet selv)", () => {
    expect(scanStructuredForSecrets({ x: { toJSON: () => ({ password: "abc12345" }) } }).value).toEqual({ x: { password: NAMED } });
    expect(scanStructuredForSecrets({ x: { toJSON: () => `bruk ${tok.github()}` } }).value).toEqual({ x: `bruk ${marker("github_token")}` });
  });
  it("T12: Map og Set røres ikke (samme referanse), mens en Error med egenskaper skannes", () => {
    const map = new Map([["k", tok.github()]]);
    const set = new Set([tok.github()]);
    const r = scanStructuredForSecrets({ map, set });
    expect((r.value as Record<string, unknown>)["map"]).toBe(map);
    expect((r.value as Record<string, unknown>)["set"]).toBe(set);
    const err = Object.assign(new Error("x"), { tok: tok.github() });
    expect(json(scanStructuredForSecrets({ err }).value)).toBe(json({ err: { tok: marker("github_token") } }));
  });
  it("allerede redigert tekst under en hemmelig forelder røres ikke (markør-regelen)", () => {
    const r = scanStructuredForSecrets({ credentials: { a: marker("github_token") } });
    expect(r.value).toEqual({ credentials: { a: marker("github_token") } });
    expect(r.findings).toEqual([]);
  });
});
