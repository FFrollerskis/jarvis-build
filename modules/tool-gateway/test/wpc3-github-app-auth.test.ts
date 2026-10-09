import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GITHUB_APP_ERROR_HINTS, GitHubAppAuth, GitHubAppAuthError, createGitHubAppJwt, maskGitHubSecrets, normalizeGitHubApiBase,
  normalizeGitHubAppPrivateKey, parseGitHubAppPrivateKey, type GitHubAppAuthErrorCode, type GitHubAppAuthOptions, type GitHubAuthLogEvent
} from "../src/github-app-auth.ts";
import { FakeGitHubApp, testKeys, type ScriptedResponse } from "./support/fake-github-app.ts";

/**
 * WP-C3 (Q-45 b / D-35): GitHub App-autentisering mot en LOKAL fake GitHub-server (127.0.0.1) som verifiserer JWT-signatur og -claims selv.
 * INGEN eksterne nettkall. A: nøkkel + JWT. B: utstedelse + scope. C: cache/single-flight/fornyelse. D: feilkategorier + backoff.
 * E: klokkeskjev. F: API-base. G: hemmelighetshygiene (adversarielt). H: installasjon/revokering.
 */

// PEM-rammer og token-prefikser bygges dynamisk, slik at hemmelighetsskannere (gitleaks) ikke tar test-fikstureringen for en ekte nøkkel/token.
const BEGIN_RSA = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const END_RSA = ["-----END", "RSA PRIVATE KEY-----"].join(" ");
const BEGIN_PKCS8 = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const GHS = ["gh", "s_"].join("");
const GHP = ["gh", "p_"].join("");

const APP_ID = "123456";
const INSTALLATION_ID = "9876543";
const REPO = "tsworkflow/jarvisbuild";
const T0 = Date.parse("2026-10-09T12:00:00Z");
const keys = testKeys();
const servers: FakeGitHubApp[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) await servers.pop()?.stop();
});

interface Harness {
  readonly fake: FakeGitHubApp;
  readonly clock: { t: number };
  readonly sleeps: number[];
  readonly logs: GitHubAuthLogEvent[];
  readonly auth: GitHubAppAuth;
}

async function harness(options: { serverSkewMs?: number; overrides?: Partial<GitHubAppAuthOptions>; installationRepos?: string[]; owner?: string } = {}): Promise<Harness> {
  const clock = { t: T0 };
  const fake = await FakeGitHubApp.start({
    publicKey: keys.publicKey, appId: APP_ID, installationId: INSTALLATION_ID,
    serverNow: () => clock.t + (options.serverSkewMs ?? 0),
    ...(options.installationRepos ? { installationRepos: options.installationRepos } : {}),
    ...(options.owner ? { owner: options.owner } : {})
  });
  servers.push(fake);
  const sleeps: number[] = [];
  const logs: GitHubAuthLogEvent[] = [];
  const auth = new GitHubAppAuth({
    appId: APP_ID, installationId: INSTALLATION_ID, privateKey: async () => keys.pkcs1, apiBase: fake.baseUrl,
    repositories: [REPO], allowLoopbackHttpForTests: true,
    now: () => clock.t, sleep: async (ms) => { sleeps.push(ms); clock.t += ms; }, random: () => 0.5, log: (event) => { logs.push(event); },
    ...options.overrides
  });
  return { fake, clock, sleeps, logs, auth };
}

async function failure(promise: Promise<unknown>): Promise<GitHubAppAuthError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(GitHubAppAuthError);
    return err as GitHubAppAuthError;
  }
  throw new Error("forventet at kallet skulle feile");
}

// ---------------------------------------------------------------------------------------------------------------------------------
describe("A: privatnøkkel og JWT", () => {
  const pemBody = (pem: string): string => pem.split("\n").filter((l) => !l.startsWith("-----")).join("");

  it("A1: GitHubs nedlastingsformat (PKCS#1) og PKCS#8 godtas og kan signere", () => {
    for (const pem of [keys.pkcs1, keys.pkcs8]) {
      const key = parseGitHubAppPrivateKey(pem);
      expect(key.asymmetricKeyType).toBe("rsa");
      const jwt = createGitHubAppJwt(key, APP_ID, T0);
      const [h, p, s] = jwt.split(".") as [string, string, string];
      expect(verify("sha256", Buffer.from(`${h}.${p}`), keys.publicKey, Buffer.from(s, "base64url"))).toBe(true);
    }
  });

  it("A2: JWT har header {alg:RS256,typ:JWT}, iat = nå-60 s, exp = nå+9 min (<= 10 min), iss = App-id", () => {
    const jwt = createGitHubAppJwt(parseGitHubAppPrivateKey(keys.pkcs1), APP_ID, T0 + 999);
    const [h, p] = jwt.split(".") as [string, string];
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, number | string>;
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    const nowSec = Math.floor((T0 + 999) / 1000);
    expect(payload).toEqual({ iat: nowSec - 60, exp: nowSec + 540, iss: APP_ID });
    expect((payload["exp"] as number) - nowSec).toBeLessThanOrEqual(600);
    expect((payload["exp"] as number) - (payload["iat"] as number)).toBeLessThanOrEqual(600);
  });

  it("A3: nøkkel som er limt inn i dashbordet/.env/vaulten i ulike former normaliseres til samme gyldige nøkkel", () => {
    const oneLineSpaces = keys.pkcs1.trim().replace(/\n/g, " ");
    const literalEscapes = keys.pkcs1.trim().replace(/\n/g, "\\n");
    const base64File = Buffer.from(keys.pkcs1, "utf8").toString("base64");
    const variants: Record<string, string> = {
      "ekte PEM": keys.pkcs1,
      "CRLF": keys.pkcs1.replace(/\n/g, "\r\n"),
      "ledende/etterfølgende blanke": `\n\n  ${keys.pkcs1}\n\n`,
      "linjeskift borte (enlinjes passordfelt)": oneLineSpaces,
      "bokstavelig \\n (.env)": literalEscapes,
      "omsluttet av anførselstegn": `"${literalEscapes}"`,
      "enkle anførselstegn": `'${oneLineSpaces}'`,
      "hele filen base64-kodet på én linje": base64File
    };
    for (const [name, raw] of Object.entries(variants)) {
      const pem = normalizeGitHubAppPrivateKey(raw);
      expect(pem.startsWith(`${BEGIN_RSA}\n`), name).toBe(true);
      expect(pem.trimEnd().endsWith(END_RSA), name).toBe(true);
      expect(pemBody(pem), name).toBe(pemBody(keys.pkcs1));
      expect(parseGitHubAppPrivateKey(raw).asymmetricKeyType, name).toBe("rsa");
    }
  });

  it("A4: avviser for liten (1024 bit), ikke-RSA (EC/Ed25519), passordbeskyttet (PKCS#8 og legacy PKCS#1), offentlig nøkkel, søppel og tom - uten nøkkelmateriale i meldingen", () => {
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const encryptedPkcs8 = rsa.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "hemmelig" }).toString();
    const encryptedPkcs1 = rsa.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "hemmelig" }).toString();
    const publicPem = createPublicKey(rsa).export({ type: "spki", format: "pem" }).toString();
    const mismatchedLabels = keys.pkcs1.replace("END RSA PRIVATE KEY", "END PRIVATE KEY");
    const truncated = `${BEGIN_RSA}\n${pemBody(keys.pkcs1).slice(0, 120)}\n${END_RSA}`;
    const badBase64 = `${BEGIN_RSA}\n!!!!not-base64!!!!\n${END_RSA}`;
    const cases: Array<[string, string, string]> = [
      ["for liten", small, "too_small"], ["EC", ec, "not_rsa"], ["Ed25519", ed, "not_rsa"],
      ["kryptert PKCS#8", encryptedPkcs8, "encrypted"], ["kryptert PKCS#1", encryptedPkcs1, "encrypted"],
      ["offentlig nøkkel", publicPem, "unsupported_format"], ["søppel", "dette er ikke en nøkkel", "no_pem_block"],
      ["tom", "   ", "empty"], ["ulike BEGIN/END-etiketter", mismatchedLabels, "no_pem_block"], ["avkortet", truncated, "unparseable"],
      ["ugyldig base64", badBase64, "bad_base64"], ["for lang", "x".repeat(20_000), "too_long"]
    ];
    for (const [name, raw, reason] of cases) {
      let thrown: unknown;
      try { parseGitHubAppPrivateKey(raw); } catch (err) { thrown = err; }
      expect(thrown, name).toBeInstanceOf(GitHubAppAuthError);
      const error = thrown as GitHubAppAuthError;
      expect(error.code, name).toBe("GITHUB_APP_KEY_INVALID");
      expect(error.message, name).toContain(reason);
      expect(error.message, name).not.toContain(pemBody(keys.pkcs1).slice(10, 40));
      expect(error.message, name).not.toContain("hemmelig");
    }
  });

  it("A5: hver feilkategori har en norsk eier-forklaring (brukes av script og runbook)", () => {
    const codes: GitHubAppAuthErrorCode[] = ["GITHUB_APP_AUTH_FAILED", "GITHUB_APP_KEY_INVALID", "GITHUB_APP_INSTALLATION_NOT_FOUND", "GITHUB_APP_RATE_LIMITED", "GITHUB_APP_UNAVAILABLE"];
    for (const code of codes) expect(GITHUB_APP_ERROR_HINTS[code].length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("B: utstedelse mot fake GitHub - JWT verifisert av serveren, scope som konfigurert", () => {
  let h: Harness;
  beforeAll(() => { /* nøkler genereres lazily */ });

  it("B1: POSTer til /app/installations/{id}/access_tokens med gyldig RS256-JWT (iss/iat/exp<=10 min) og repositories = konfigurert repo-NAVN", async () => {
    h = await harness();
    const issued = await h.auth.issue();
    const [req] = h.fake.mintRequests();
    expect(h.fake.mintRequests()).toHaveLength(1);
    expect(req?.path).toBe(`/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(req?.jwtProblems).toEqual([]);
    expect(req?.jwt?.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(req?.jwt?.payload["iss"]).toBe(APP_ID);
    expect(req?.headers["accept"]).toBe("application/vnd.github+json");
    expect(req?.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(req?.headers["user-agent"]).toBe("jarvis");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ repositories: ["jarvisbuild"] });
    expect(issued.token).toMatch(/^ghs_/);
    expect(issued.info.repository_selection).toBe("selected");
    expect(issued.info.repositories).toEqual([REPO]);
    expect(issued.info.expires_at).toBe(new Date(T0 + 3_600_000).toISOString());
    expect(issued.info.permissions["contents"]).toBe("write");
  });

  it("B2: standard-scope er ALLTID de konfigurerte repoene; flere repoer -> alle navn; aldri «alle»", async () => {
    h = await harness({ overrides: { repositories: [REPO, "tsworkflow/other-repo"] } });
    const issued = await h.auth.issue();
    expect(JSON.parse(h.fake.mintRequests()[0]?.body ?? "{}")).toEqual({ repositories: ["jarvisbuild", "other-repo"] });
    expect(issued.info.repositories).toEqual([REPO, "tsworkflow/other-repo"]);
  });

  it("B3: ingen konfigurert scope -> GITHUB_APP_SCOPE_UNDEFINED UTEN nettverkskall; en eksplisitt TOM liste betyr aldri «alle»", async () => {
    h = await harness({ overrides: { repositories: undefined } });
    expect((await failure(h.auth.token())).code).toBe("GITHUB_APP_SCOPE_UNDEFINED");
    expect((await failure(h.auth.token({ repositories: [] }))).code).toBe("GITHUB_APP_SCOPE_UNDEFINED");
    expect(h.fake.requests).toHaveLength(0);
    expect(h.auth.state().last_error?.code).toBe("GITHUB_APP_SCOPE_UNDEFINED");
  });

  it("B4: eksplisitt scope (innenfor allowlisten) overstyrer standarden; ugyldige repo-verdier avvises før nettverket", async () => {
    h = await harness({ overrides: { repositories: [REPO, "tsworkflow/other-repo"] } });
    const issued = await h.auth.issue({ repositories: ["other-repo"] });
    expect(JSON.parse(h.fake.mintRequests()[0]?.body ?? "{}")).toEqual({ repositories: ["other-repo"] });
    expect(issued.info.repositories).toEqual(["tsworkflow/other-repo"]);
    for (const bad of ["../etc", "a/b/c", "https://github.com/a/b", " ", "-x", "..", "a/..", "x?y=1"]) {
      expect((await failure(h.auth.token({ repositories: [bad] }))).code, bad).toBe("GITHUB_APP_CONFIG_INVALID");
    }
    expect(h.fake.mintRequests()).toHaveLength(1);
  });

  it("B5: permissions-nedskalering sendes som konfigurert; ugyldige navn/nivåer avvises; vendor-ekstra metadata:read tolereres", async () => {
    h = await harness();
    const narrowed = await h.auth.issue({ permissions: { contents: "write" } });
    expect(JSON.parse(h.fake.mintRequests()[0]?.body ?? "{}")).toEqual({ repositories: ["jarvisbuild"], permissions: { contents: "write" } });
    expect(narrowed.info.permissions).toEqual({ contents: "write" });
    for (const bad of [{ "Contents": "write" }, { contents: "root" }, { "../x": "read" }] as unknown as Array<Record<string, "read">>) {
      expect((await failure(h.auth.token({ permissions: bad }))).code).toBe("GITHUB_APP_CONFIG_INVALID");
    }
    h.auth.invalidate(); // «jarvisbuild» og «tsworkflow/jarvisbuild» er samme scope (allowlisten gir eieren) og ville ellers truffet cachen
    h.fake.script = [{ status: 201, build: () => ({ status: 201, json: { ...h.fake.buildTokenBody({ repositories: ["jarvisbuild"], permissions: { contents: "write", metadata: "read" } }) } }) }];
    const withMeta = await h.auth.issue({ permissions: { contents: "write" }, repositories: ["jarvisbuild"] });
    expect(withMeta.info.permissions["metadata"]).toBe("read");
  });

  it("B6: svar som IKKE dekker nøyaktig det som ble forespurt avvises (SCOPE_MISMATCH) - leverandøren kan ikke utvide scopet stille", async () => {
    h = await harness();
    const cases: Array<[string, (body: Record<string, unknown>) => Record<string, unknown>]> = [
      ["repository_selection=all", (b) => ({ ...b, repository_selection: "all", repositories: undefined })],
      ["ekstra repo i svaret", (b) => ({ ...b, repositories: [...(b["repositories"] as unknown[]), { id: 9, name: "hemmelig", full_name: "tsworkflow/hemmelig" }] })],
      ["feil eier", (b) => ({ ...b, repositories: [{ id: 1, name: "jarvisbuild", full_name: "fremmed/jarvisbuild" }] })],
      ["manglende repositories-liste", (b) => ({ ...b, repositories: undefined })],
      ["annet repo enn forespurt", (b) => ({ ...b, repositories: [{ id: 2, name: "annet", full_name: "tsworkflow/annet" }] })]
    ];
    for (const [name, mutate] of cases) {
      h.clock.t += 60_000; // forbi fail-fast-vinduet fra forrige case
      h.fake.script = [{ status: 201, build: () => ({ status: 201, json: mutate(h.fake.buildTokenBody({ repositories: ["jarvisbuild"] })) }) }];
      const error = await failure(h.auth.token());
      expect(error.code, name).toBe("GITHUB_APP_SCOPE_MISMATCH");
    }
    h.clock.t += 60_000;
    h.fake.script = [{ status: 201, build: () => ({ status: 201, json: h.fake.buildTokenBody({ repositories: ["jarvisbuild"], permissions: { contents: "write", issues: "write" } }) }) }];
    expect((await failure(h.auth.token({ permissions: { contents: "write" } }))).code).toBe("GITHUB_APP_SCOPE_MISMATCH");
  });

  it("B7: App-id kan være client-id (Iv…); ugyldige id-er avvises i konstruktøren", () => {
    const base = { privateKey: async () => keys.pkcs1, repositories: [REPO] };
    expect(() => new GitHubAppAuth({ ...base, appId: "Iv23liAbCdEf123", installationId: "42" })).not.toThrow();
    for (const [appId, installationId] of [["", "42"], ["a b", "42"], ["123", "0"], ["123", "abc"], ["123", ""], ["123", "-5"]] as const) {
      expect(() => new GitHubAppAuth({ ...base, appId, installationId }), `${appId}/${installationId}`).toThrow(GitHubAppAuthError);
    }
    expect(() => new GitHubAppAuth({ ...base, appId: "1", installationId: "2", repositories: Array.from({ length: 501 }, (_, i) => `o/r${i}`) })).toThrow(/too_many_repositories/);
  });

  it("B8: nøkkelen mangler / er ugyldig / vaulten feiler -> KEY_MISSING / KEY_INVALID uten nettverkskall og uten lekkasje fra kilden", async () => {
    h = await harness({ overrides: { privateKey: async () => null } });
    expect((await failure(h.auth.token())).code).toBe("GITHUB_APP_KEY_MISSING");
    h = await harness({ overrides: { privateKey: async () => "dette er ikke en nøkkel" } });
    expect((await failure(h.auth.token())).code).toBe("GITHUB_APP_KEY_INVALID");
    h = await harness({ overrides: { privateKey: async () => { throw new Error("vault nede: secret=sk-ant-HEMMELIG-123"); } } });
    const error = await failure(h.auth.token());
    expect(error.code).toBe("GITHUB_APP_KEY_MISSING");
    expect(JSON.stringify(error) + error.stack).not.toContain("sk-ant-HEMMELIG-123");
    expect(h.fake.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("C: cache, single-flight og fornyelse", () => {
  it("C1: gjenbruker tokenet til 5 min før expires_at, fornyer deretter (ett nytt kall, nytt token)", async () => {
    const h = await harness();
    const first = await h.auth.token();
    h.clock.t = T0 + 3_299_000; // 5 min før utløp minus 1 s
    expect(await h.auth.token()).toBe(first);
    expect(h.fake.mintRequests()).toHaveLength(1);
    h.clock.t = T0 + 3_301_000; // innenfor fornyelsesvinduet
    const second = await h.auth.token();
    expect(second).not.toBe(first);
    expect(h.fake.mintRequests()).toHaveLength(2);
  });

  it("C2: ti samtidige kall deler ÉN utstedelse (single-flight)", async () => {
    const h = await harness();
    h.fake.mintDelayMs = 60;
    const tokens = await Promise.all(Array.from({ length: 10 }, () => h.auth.token()));
    expect(new Set(tokens).size).toBe(1);
    expect(h.fake.mintRequests()).toHaveLength(1);
  });

  it("C3: ulike scope caches hver for seg; samme scope i annen rekkefølge/casing treffer samme cache", async () => {
    const h = await harness({ installationRepos: ["jarvisbuild", "other-repo", "third-repo"], overrides: { repositories: [REPO, "tsworkflow/other-repo", "tsworkflow/third-repo"] } });
    const a = await h.auth.token();
    const b = await h.auth.token({ repositories: ["other-repo"] });
    expect(a).not.toBe(b);
    expect(await h.auth.token({ repositories: ["other-repo"] })).toBe(b);
    const c = await h.auth.token({ repositories: ["tsworkflow/jarvisbuild", "tsworkflow/other-repo"] });
    expect(await h.auth.token({ repositories: ["TSWORKFLOW/OTHER-REPO", "tsworkflow/jarvisbuild"] })).toBe(c);
    expect(h.fake.mintRequests()).toHaveLength(3);
  });

  it("C4: feiler fornyelsen mens det gamle tokenet fortsatt er gyldig, brukes det videre (feilen registreres); først nær utløp feiler kallet", async () => {
    const h = await harness();
    const first = await h.auth.token();
    h.clock.t = T0 + 3_301_000;
    h.fake.script = [{ status: 500, json: { message: "boom" } }, { status: 500, json: { message: "boom" } }, { status: 500, json: { message: "boom" } }];
    expect(await h.auth.token()).toBe(first);
    expect(h.auth.state().last_error?.code).toBe("GITHUB_APP_UNAVAILABLE");
    expect(h.auth.state().consecutive_failures).toBe(1);
    h.clock.t += 5_000; // fortsatt i fail-fast-vinduet: ingen nye kall, tokenet brukes
    const requestsBefore = h.fake.requests.length;
    expect(await h.auth.token()).toBe(first);
    expect(h.fake.requests).toHaveLength(requestsBefore);
    h.clock.t = T0 + 3_590_000; // < 30 s igjen: tokenet er ikke lenger trygt å bruke
    h.fake.script = [{ status: 500 }, { status: 500 }, { status: 500 }];
    expect((await failure(h.auth.token())).code).toBe("GITHUB_APP_UNAVAILABLE");
  });

  it("C5: noteUnauthorized() forkaster kun tokens eldre enn 15 s; invalidate() alle", async () => {
    const h = await harness();
    const first = await h.auth.token();
    h.clock.t += 10_000;
    h.auth.noteUnauthorized();
    expect(await h.auth.token()).toBe(first);
    h.clock.t += 10_000;
    h.auth.noteUnauthorized();
    const second = await h.auth.token();
    expect(second).not.toBe(first);
    h.auth.invalidate();
    expect(await h.auth.token()).not.toBe(second);
    expect(h.fake.mintRequests()).toHaveLength(3);
  });

  it("C6: et svar med urimelig lang levetid caches likevel aldri lenger enn ~65 min", async () => {
    const h = await harness();
    h.fake.script = [{ status: 201, build: () => ({ status: 201, json: { ...h.fake.buildTokenBody({ repositories: ["jarvisbuild"] }), expires_at: "2099-01-01T00:00:00Z" } }) }];
    const first = await h.auth.token();
    h.clock.t = T0 + 66 * 60_000;
    expect(await h.auth.token()).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("D: feilkategorier, backoff og fail-fast", () => {
  it("D1: 401 -> GITHUB_APP_AUTH_FAILED etter ÉN forespørsel (ingen retry); 404 -> INSTALLATION_NOT_FOUND; 422 -> REQUEST_REJECTED", async () => {
    const cases: Array<[ScriptedResponse, GitHubAppAuthErrorCode, number]> = [
      [{ status: 401, json: { message: "A JSON web token could not be decoded" } }, "GITHUB_APP_AUTH_FAILED", 401],
      [{ status: 404, json: { message: "Not Found" } }, "GITHUB_APP_INSTALLATION_NOT_FOUND", 404],
      [{ status: 422, json: { message: "Validation Failed" } }, "GITHUB_APP_REQUEST_REJECTED", 422],
      [{ status: 403, json: { message: "Resource not accessible by integration" } }, "GITHUB_APP_FORBIDDEN", 403],
      [{ status: 403, json: { message: "This installation has been suspended" } }, "GITHUB_APP_INSTALLATION_SUSPENDED", 403],
      [{ status: 400, json: { message: "Problems parsing JSON" } }, "GITHUB_APP_REQUEST_REJECTED", 400]
    ];
    for (const [scripted, code, status] of cases) {
      const h = await harness();
      h.fake.script = [scripted];
      const error = await failure(h.auth.token());
      expect(error.code, code).toBe(code);
      expect(error.httpStatus).toBe(status);
      expect(h.fake.mintRequests(), code).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
      expect(error.message.startsWith(`${code}:`)).toBe(true);
    }
  });

  it("D2: faktiske GitHub-svar for ukjent repo / urettmessige rettigheter gir 422 -> REQUEST_REJECTED med lesbar (maskert) detalj", async () => {
    const h = await harness({ installationRepos: ["jarvisbuild"], overrides: { repositories: [REPO, "tsworkflow/finnes-ikke"] } });
    const unknownRepo = await failure(h.auth.token({ repositories: ["finnes-ikke"] }));
    expect(unknownRepo.code).toBe("GITHUB_APP_REQUEST_REJECTED");
    expect(unknownRepo.message).toContain("does not exist or is not accessible");
    h.clock.t += 60_000;
    const tooMuch = await failure(h.auth.token({ repositories: [REPO], permissions: { administration: "write" } }));
    expect(tooMuch.code).toBe("GITHUB_APP_REQUEST_REJECTED");
    expect(tooMuch.message).toContain("permissions requested are not granted");
  });

  it("D3: 5xx gjentas med eksponentiell backoff (500 ms, 1 s) og lykkes; 3x5xx -> UNAVAILABLE etter nøyaktig 3 forsøk", async () => {
    let h = await harness();
    h.fake.script = [{ status: 502, text: "bad gateway" }, { status: 503, json: { message: "unavailable" } }];
    expect(await h.auth.token()).toMatch(/^ghs_/);
    expect(h.sleeps).toEqual([500, 1000]);
    expect(h.fake.mintRequests()).toHaveLength(3);

    h = await harness();
    h.fake.script = [{ status: 500 }, { status: 500 }, { status: 500 }];
    const error = await failure(h.auth.token());
    expect(error.code).toBe("GITHUB_APP_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(h.fake.mintRequests()).toHaveLength(3);
    expect(h.sleeps).toEqual([500, 1000]);
  });

  it("D4: 429/Retry-After respekteres; for lang ventetid gir RATE_LIMITED UMIDDELBART med retryAfterMs; primær/sekundær rate limit klassifiseres", async () => {
    let h = await harness();
    h.fake.script = [{ status: 429, headers: { "retry-after": "2" }, json: { message: "API rate limit exceeded" } }];
    expect(await h.auth.token()).toMatch(/^ghs_/);
    expect(h.sleeps).toEqual([2000]);

    h = await harness();
    h.fake.script = [{ status: 429, headers: { "retry-after": "120" }, json: { message: "slow down" } }];
    let error = await failure(h.auth.token());
    expect(error.code).toBe("GITHUB_APP_RATE_LIMITED");
    expect(error.retryAfterMs).toBe(120_000);
    expect(h.sleeps).toEqual([]);
    expect(h.fake.mintRequests()).toHaveLength(1);

    h = await harness();
    const reset = Math.floor(T0 / 1000) + 10;
    h.fake.script = [{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, json: { message: "API rate limit exceeded for installation" } }];
    expect(await h.auth.token()).toMatch(/^ghs_/);
    expect(h.sleeps).toEqual([10_000]);

    h = await harness();
    h.fake.script = [1, 2, 3].map(() => ({ status: 403, json: { message: "You have exceeded a secondary rate limit." } }));
    error = await failure(h.auth.token());
    expect(error.code).toBe("GITHUB_APP_RATE_LIMITED");
    expect(h.fake.mintRequests()).toHaveLength(3);
    expect(h.sleeps).toEqual([500, 1000]);

    h = await harness();
    h.fake.script = [{ status: 422, json: { message: "Validation Failed: the endpoint has been spammed" } }, { status: 422, json: { message: "spammed" } }, { status: 422, json: { message: "spammed" } }];
    expect((await failure(h.auth.token())).code).toBe("GITHUB_APP_RATE_LIMITED");
  });

  it("D5: nettverksfeil og timeout -> UNAVAILABLE (retry), uten å lekke URL-er eller rå feilmelding", async () => {
    let h = await harness();
    await h.fake.stop();
    let error = await failure(h.auth.token());
    expect(error.code).toBe("GITHUB_APP_UNAVAILABLE");
    expect(error.message).toBe("GITHUB_APP_UNAVAILABLE:network_error");
    expect(h.sleeps).toEqual([500, 1000]);

    h = await harness({ overrides: { requestTimeoutMs: 300, maxAttempts: 2 } });
    h.fake.script = [{ hang: true }, { hang: true }];
    error = await failure(h.auth.token());
    expect(error.code).toBe("GITHUB_APP_UNAVAILABLE");
    expect(error.message).toBe("GITHUB_APP_UNAVAILABLE:timeout");

    h = await harness({ overrides: { maxAttempts: 2 } });
    h.fake.script = [{ closeSocket: true }];
    expect(await h.auth.token()).toMatch(/^ghs_/); // forbindelsen ble kuttet én gang, andre forsøk lyktes
    expect(h.sleeps).toEqual([500]);
  });

  it("D6: etter en feil svarer klienten fail-fast uten nye kall til vinduet er over, deretter prøves det igjen", async () => {
    const h = await harness();
    h.fake.script = [{ status: 401, json: { message: "Bad credentials" } }];
    const first = await failure(h.auth.token());
    expect(h.fake.mintRequests()).toHaveLength(1);
    h.clock.t += 1_000;
    const again = await failure(h.auth.token());
    expect(again).toBe(first);
    expect(h.fake.mintRequests()).toHaveLength(1);
    h.clock.t += 6_000;
    expect(await h.auth.token()).toMatch(/^ghs_/);
    expect(h.fake.mintRequests()).toHaveLength(2);
    expect(h.auth.state().last_error).toBeNull();
    expect(h.auth.state().consecutive_failures).toBe(0);
  });

  it("D7: lokale feil (nøkkel/scope) har INGEN fail-fast: eieren kan lime inn ny nøkkel og prøve igjen umiddelbart", async () => {
    let key: string | null = null;
    const h = await harness({ overrides: { privateKey: async () => key } });
    expect((await failure(h.auth.token())).code).toBe("GITHUB_APP_KEY_MISSING");
    key = keys.pkcs1;
    expect(await h.auth.token()).toMatch(/^ghs_/);
  });

  it("D8: ugyldige svar (ikke JSON, manglende/ugyldig token, ugyldig utløp, allerede utløpt, for stort) -> RESPONSE_INVALID", async () => {
    const good = (h: Harness): Record<string, unknown> => h.fake.buildTokenBody({ repositories: ["jarvisbuild"] });
    const variants: Array<[string, (h: Harness) => ScriptedResponse]> = [
      ["ikke JSON", () => ({ status: 201, text: "<html>hei</html>" })],
      ["uten token", (h) => ({ status: 201, build: () => ({ status: 201, json: { ...good(h), token: undefined } }) })],
      ["token med mellomrom", (h) => ({ status: 201, build: () => ({ status: 201, json: { ...good(h), token: "ghs_has space in it_0123456789" } }) })],
      ["token med linjeskift", (h) => ({ status: 201, build: () => ({ status: 201, json: { ...good(h), token: "ghs_has\nnewline_0123456789abc" } }) })],
      ["for kort token", (h) => ({ status: 201, build: () => ({ status: 201, json: { ...good(h), token: "ghs_x" } }) })],
      ["uten expires_at", (h) => ({ status: 201, build: () => ({ status: 201, json: { ...good(h), expires_at: undefined } }) })],
      ["ugyldig expires_at", (h) => ({ status: 201, build: () => ({ status: 201, json: { ...good(h), expires_at: "snart" } }) })],
      ["allerede utløpt", (h) => ({ status: 201, build: () => ({ status: 201, json: { ...good(h), expires_at: "2020-01-01T00:00:00Z" } }) })],
      ["ugyldig repository_selection", (h) => ({ status: 201, build: () => ({ status: 201, json: { ...good(h), repository_selection: "alle" } }) })],
      ["repositories ikke en liste", (h) => ({ status: 201, build: () => ({ status: 201, json: { ...good(h), repositories: "x" } }) })]
    ];
    for (const [name, make] of variants) {
      const h = await harness();
      h.fake.script = [make(h)];
      const error = await failure(h.auth.token());
      expect(error.code, name).toBe("GITHUB_APP_RESPONSE_INVALID");
    }
  });

  it("D9: det nye statuløse token-formatet ghs_<APPID>_<JWT> (lengde > 40) godtas - lengden antas aldri", async () => {
    const h = await harness();
    const stateless = `ghs_${APP_ID}_${"A".repeat(200)}.${"B".repeat(300)}.${"C".repeat(80)}`;
    h.fake.script = [{ status: 201, build: () => ({ status: 201, json: { ...h.fake.buildTokenBody({ repositories: ["jarvisbuild"] }), token: stateless } }) }];
    expect(await h.auth.token()).toBe(stateless);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("E: klokkeskjev", () => {
  it("E1: serverklokken 15 min foran: første JWT får 401 (exp passert), klienten lærer av Date-headeren og gjentar ÉN gang umiddelbart - uten backoff", async () => {
    const h = await harness({ serverSkewMs: 900_000 });
    const token = await h.auth.token();
    expect(token).toMatch(/^ghs_/);
    const mints = h.fake.mintRequests();
    expect(mints).toHaveLength(2);
    expect(mints[0]?.jwtProblems).toContain("exp_in_past");
    expect(mints[1]?.jwtProblems).toEqual([]);
    expect(h.sleeps).toEqual([]);
    expect(h.auth.state().clock_skew_ms).toBe(900_000);
    // Neste utstedelse bruker korrigert klokke fra første forsøk.
    h.auth.invalidate();
    await h.auth.token();
    const latest = h.fake.mintRequests().at(-1);
    expect(latest?.jwtProblems).toEqual([]);
    expect(h.fake.mintRequests()).toHaveLength(3);
  });

  it("E2: serverklokken 5 min bak (iat i fremtiden for serveren): samme selvkorrigering", async () => {
    const h = await harness({ serverSkewMs: -300_000 });
    expect(await h.auth.token()).toMatch(/^ghs_/);
    const mints = h.fake.mintRequests();
    expect(mints).toHaveLength(2);
    expect(mints[0]?.jwtProblems).toContain("iat_in_future");
    expect(mints[1]?.jwtProblems).toEqual([]);
  });

  it("E3: tokenets utløp beregnes i verts-tid (expires_at fra serveren minus avviket) - ikke i serverens absolutte tid", async () => {
    const h = await harness({ serverSkewMs: 900_000 });
    const first = await h.auth.token();
    h.clock.t = T0 + 3_299_000; // lokal tid: fortsatt 5 min+ igjen
    expect(await h.auth.token()).toBe(first);
    h.clock.t = T0 + 3_301_000; // innenfor fornyelsesvinduet i LOKAL tid, selv om serverens absolutte expires_at er 15 min lenger frem
    expect(await h.auth.token()).not.toBe(first);
  });

  it("E4: mindre avvik (< 5 s) ignoreres - ingen unødvendig gjentakelse", async () => {
    const h = await harness({ serverSkewMs: 2_000 });
    await h.auth.token();
    expect(h.fake.mintRequests()).toHaveLength(1);
    expect(h.auth.state().clock_skew_ms).toBe(0);
  });

  it("E5: 401 UTEN klokkeavvik (feil nøkkel) gjentas ikke - ingen retry-storm", async () => {
    const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const h = await harness({ overrides: { privateKey: async () => wrongKey } });
    const error = await failure(h.auth.token());
    expect(error.code).toBe("GITHUB_APP_AUTH_FAILED");
    expect(h.fake.mintRequests()).toHaveLength(1);
    expect(h.fake.mintRequests()[0]?.jwtProblems).toContain("signature");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F: API-base", () => {
  it("F1: standard er https://api.github.com; trailing slash fjernes; en annen vert/port/sti (GHES) avvises - review F5", () => {
    expect(normalizeGitHubApiBase(undefined)).toBe("https://api.github.com");
    expect(normalizeGitHubApiBase("")).toBe("https://api.github.com");
    expect(normalizeGitHubApiBase("  https://api.github.com/  ")).toBe("https://api.github.com");
    expect(() => normalizeGitHubApiBase("https://ghe.firma.no:8443/api/v3/")).toThrow(/api_base_host_not_allowed/);
  });

  it("F2: http, brukerinfo, query/fragment, IP-literaler, localhost, .local, enkeltnavn, backslash og mellomrom avvises", () => {
    for (const bad of [
      "http://api.github.com", "ftp://api.github.com", "https://user:pw@api.github.com", "https://api.github.com?x=1", "https://api.github.com#x",
      "https://127.0.0.1", "https://10.0.0.5", "https://[::1]", "https://localhost", "https://printer.local", "https://intranett",
      "https://api.github.com\\evil", "https://api.github.com /x", "api.github.com", "//api.github.com", "https://", "x".repeat(300)
    ]) {
      expect(() => normalizeGitHubApiBase(bad), bad).toThrow(GitHubAppAuthError);
    }
  });

  it("F3: loopback-http kun med det eksplisitte TESTFLAGGET (og kun 127.0.0.1) - flagget finnes ikke som miljøvariabel", () => {
    expect(() => normalizeGitHubApiBase("http://127.0.0.1:4010")).toThrow(/api_base_must_be_https/);
    expect(normalizeGitHubApiBase("http://127.0.0.1:4010", true)).toBe("http://127.0.0.1:4010");
    expect(() => normalizeGitHubApiBase("http://localhost:4010", true)).toThrow(GitHubAppAuthError);
    expect(() => normalizeGitHubApiBase("http://192.168.1.5:4010", true)).toThrow(GitHubAppAuthError);
    expect(() => new GitHubAppAuth({ appId: "1", installationId: "2", privateKey: async () => keys.pkcs1, repositories: [REPO], apiBase: "http://127.0.0.1:4010" })).toThrow(/api_base_must_be_https/);
  });

  it("F4: dot-segmenter/prosentkodede punktum i API-basen avvises (ingen stille URL-normalisering) FØR noe sendes", () => {
    for (const bad of ["https://api.github.com/%2e%2e/admin", "https://api.github.com/../admin", "https://api.github.com/./x", "https://api.github.com/a/%2E/b"]) {
      expect(() => normalizeGitHubApiBase(bad), bad).toThrow(/api_base_unsafe/);
    }
  });

  it("F5: standardveien går via guardedFetch: global fetch kalles med ferdig URL, POST og et abort-signal (timeout) - uten ekte nettkall (stubbet)", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        token: "ghs_StubbedTokenForTestOnly0123456789", expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { contents: "write" }, repository_selection: "selected", repositories: [{ id: 1, name: "jarvisbuild", full_name: REPO }]
      }), { status: 201, headers: { "content-type": "application/json" } });
    });
    try {
      const auth = new GitHubAppAuth({ appId: "1", installationId: "2", privateKey: async () => keys.pkcs1, repositories: [REPO], log: () => undefined });
      expect(await auth.token()).toBe("ghs_StubbedTokenForTestOnly0123456789");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://api.github.com/app/installations/2/access_tokens");
      expect(calls[0]?.init?.method).toBe("POST");
      expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("G: hemmelighetshygiene (adversarielt)", () => {
  const privateBodySnippets = [keys.pkcs1.split("\n")[2] as string, keys.pkcs1.split("\n")[5] as string];

  function expectClean(text: string, secrets: readonly string[], what: string): void {
    for (const secret of secrets) expect(text, `${what} lekker en hemmelighet`).not.toContain(secret);
    for (const snippet of privateBodySnippets) expect(text, `${what} lekker privatnøkkel`).not.toContain(snippet);
    expect(text, `${what}: PEM-header`).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY/);
    expect(text, `${what}: JWT-form`).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./);
    expect(text, `${what}: token-form`).not.toMatch(/gh[pousr]_[A-Za-z0-9_]{16,}/);
  }

  it("G1: en fiendtlig server som ekkoer JWT, privatnøkkel og tokens i feilsvar lekker ALDRI inn i feil, stack, JSON, inspect, status eller logg", async () => {
    const echoes: Array<(req: { bearer: string | null }) => { status: number; json?: unknown; text?: string }> = [
      (req) => ({ status: 401, json: { message: `Bad credentials. Du sendte ${req.bearer}` } }),
      () => ({ status: 403, json: { message: `${keys.pkcs1} ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` } }),
      (req) => ({ status: 422, json: { message: `Authorization: Bearer ${req.bearer} github_pat_11AAAAAAA0123456789abcdefghijkl` } }),
      (req) => ({ status: 500, text: `<pre>Authorization: Bearer ${req.bearer}\n${keys.pkcs1}</pre>` }),
      () => ({ status: 404, json: { message: `ghs_123456_${"x".repeat(60)}.${"y".repeat(60)}.${"z".repeat(30)}` } })
    ];
    const lines: string[] = [];
    const h = await harness({ overrides: { maxAttempts: 1, log: (event) => { lines.push(JSON.stringify(event)); } } });
    const seenJwts: string[] = [];
    for (const echo of echoes) {
      h.clock.t += 600_000; // forbi fail-fast
      h.fake.script = [{ status: 500, build: (req) => { if (req.bearer) seenJwts.push(req.bearer); return echo({ bearer: req.bearer }); } }];
      const error = await failure(h.auth.token());
      const blobs = [error.message, error.stack ?? "", JSON.stringify(error), inspect(error, { depth: 6 }), JSON.stringify(h.auth.state()), inspect(h.auth, { depth: 6 }), JSON.stringify(h.auth)];
      for (const blob of blobs) expectClean(blob, seenJwts, "feilsti");
    }
    expect(seenJwts.length).toBeGreaterThan(0);
    for (const line of lines) expectClean(line, seenJwts, "logglinje");
  });

  it("G2: vellykket utstedelse: tokenet står ikke i status, logg, inspect eller JSON - men knownTokens() har det kun til redaksjon", async () => {
    const lines: string[] = [];
    const h = await harness({ overrides: { log: (event) => { lines.push(JSON.stringify(event)); } } });
    const issued = await h.auth.issue();
    const blobs = [JSON.stringify(h.auth.state()), inspect(h.auth, { depth: 6 }), JSON.stringify(h.auth), JSON.stringify(issued.info), ...lines];
    for (const blob of blobs) {
      expect(blob).not.toContain(issued.token);
      expectClean(blob, [issued.token], "suksess");
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(h.auth.knownTokens()).toEqual([issued.token]);
    expect(maskGitHubSecrets(`feil: ${issued.token} ble avvist`, h.auth.knownTokens())).toBe("feil: [REDACTED] ble avvist");
  });

  it("G3: standardloggeren (console) skriver heller ikke hemmeligheter - verken ved suksess eller feil", async () => {
    const spies = [vi.spyOn(console, "log").mockImplementation(() => undefined), vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined)];
    const h = await harness({ overrides: { log: undefined } });
    const issued = await h.auth.issue();
    h.clock.t += 4_000_000;
    h.fake.script = [{ status: 401, build: (req) => ({ status: 401, json: { message: `jwt=${req.bearer}` } }) }];
    await failure(h.auth.token());
    const printed = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))).join("\n");
    expect(printed).toContain("github_app_token_issued");
    expect(printed).toContain("github_app_auth_failed");
    expectClean(printed, [issued.token, ...h.fake.requests.flatMap((r) => (r.bearer ? [r.bearer] : []))], "console");
  });

  it("G4: maskGitHubSecrets fjerner PEM (også uten END), ghs/ghp/gho/ghu/ghr, github_pat, det nye ghs_<APPID>_<JWT>-formatet, JWT og Bearer - men lar vanlig tekst være", () => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${"a".repeat(40)}.${"b".repeat(40)}`;
    const text = [
      `A: ${GHS}16C7e42F292c6912E7710c838347Ae178B4a`, `B: ${GHP}abcdefghijklmnopqrstuvwxyz0123456789`, "C: gho_abcdefghijklmnopqrstuvwxyz01", "D: ghu_abcdefghijklmnopqrstuvwxyz01",
      "E: ghr_abcdefghijklmnopqrstuvwxyz01", `F: ${["github", "pat_"].join("_")}11ABCDEFG0abcdefghijklmnopqrstuvwxyz`, `G: ${GHS}123456_${jwt}`, `H: ${jwt}`,
      "I: Authorization: Bearer abcdefghijklmnop1234567890", `J: ${BEGIN_RSA}\nMIIEowIBAAKCAQEAxyz\n${END_RSA}`, `K: ${BEGIN_PKCS8}\nMIIEvQIBADANBgkq`
    ].join("\n");
    const masked = maskGitHubSecrets(text);
    expect(masked).not.toMatch(/ghs_16C7|ghp_abc|gho_abc|ghu_abc|ghr_abc|github_pat_11|eyJhbGci|abcdefghijklmnop1234|MIIEow|MIIEvQ/);
    expect(masked).toContain("[REDACTED_TOKEN]");
    expect(masked).toContain("[REDACTED_JWT]");
    expect(masked).toContain("[REDACTED_KEY]");
    expect(maskGitHubSecrets("Resource not accessible by integration (ghost_user, gh_pages)")).toBe("Resource not accessible by integration (ghost_user, gh_pages)");
    expect(maskGitHubSecrets("hemmelig=abc12345xyz", ["abc12345xyz"])).toBe("hemmelig=[REDACTED]");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("H: installasjon, liste og revokering", () => {
  it("H1: inspectInstallation() bruker KUN App-JWT (ingen token utstedes) og rapporterer repoutvalg/rettigheter/suspensjon", async () => {
    const h = await harness();
    const info = await h.auth.inspectInstallation();
    expect(info).toMatchObject({ id: INSTALLATION_ID, account: "tsworkflow", repository_selection: "selected", suspended: false });
    expect(info.permissions["contents"]).toBe("write");
    expect(h.fake.mintRequests()).toHaveLength(0);
    expect(h.fake.requests[0]?.jwtProblems).toEqual([]);
    expect(h.auth.state().installation?.repository_selection).toBe("selected");
    h.fake.installationOverride = { status: 200, json: { id: 1, repository_selection: "all", permissions: { contents: "write" }, suspended_at: "2026-10-01T00:00:00Z", account: { login: "tsworkflow", type: "User" } } };
    const suspended = await h.auth.inspectInstallation();
    expect(suspended.repository_selection).toBe("all");
    expect(suspended.suspended).toBe(true);
  });

  it("H2: listInstallations() hjelper eieren å finne installasjons-id", async () => {
    const h = await harness();
    expect(await h.auth.listInstallations()).toEqual([{ id: INSTALLATION_ID, account: "tsworkflow", repository_selection: "selected", suspended: false }]);
  });

  it("H3: revoke() ugyldiggjør tokenet hos GitHub (DELETE /installation/token), er idempotent og fjerner det fra cachen", async () => {
    const h = await harness();
    const token = await h.auth.token();
    await h.auth.revoke(token);
    expect(h.fake.issued.get(token)?.revoked).toBe(true);
    const check = await globalThis.fetch(`${h.fake.baseUrl}/rate_limit`, { headers: { authorization: `Bearer ${token}` } });
    expect(check.status).toBe(401);
    await expect(h.auth.revoke(token)).resolves.toBeUndefined();
    const fresh = await h.auth.token();
    expect(fresh).not.toBe(token);
    const ok = await globalThis.fetch(`${h.fake.baseUrl}/rate_limit`, { headers: { authorization: `Bearer ${fresh}` } });
    expect(ok.status).toBe(200);
  });

  it("H4: feil mot installasjons-endepunktene klassifiseres likt (404 for ukjent installasjons-id)", async () => {
    const h = await harness({ overrides: { installationId: "111" } });
    expect((await failure(h.auth.inspectInstallation())).code).toBe("GITHUB_APP_INSTALLATION_NOT_FOUND");
  });
});
