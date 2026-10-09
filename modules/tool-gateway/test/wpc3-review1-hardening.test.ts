import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubAppAuthError, maskGitHubSecrets } from "../src/github-app-auth.ts";
import { failure, harness, stopFakeServers } from "./support/wpc3-harness.ts";

/**
 * WP-C3, rettelser etter den UAVHENGIGE sikkerhetsreviewen (PR #311). Hver `describe` bærer funn-id-en (F1, F4, ...) og er skrevet slik at den
 * FEILER mot koden slik den var før rettelsen (verifisert ved å reversere rettelsen lokalt, se commit-meldingene).
 */

afterEach(stopFakeServers);

// PEM-rammer bygges dynamisk, slik at hemmelighetsskannere (gitleaks) ikke tar test-fikstureringen for en ekte nøkkel.
const BEGIN_PKCS8 = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const BEGIN_RSA = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const END_RSA = ["-----END", "RSA PRIVATE KEY-----"].join(" ");
const BEGIN_ONLY = ["-----BEGIN", ""].join(" ");

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F1: maskeringen er lineær i inndata-lengden (ReDoS) og kutter inndata FØR regexene kjører", () => {
  const sized = (unit: string, size: number, suffix = ""): string => unit.repeat(Math.ceil(size / unit.length)) + suffix;

  // Fiendtlig inndata per maskeringsregex (JWT, PEM, token, Bearer) pluss blandinger. Alle er konstruert for å gi motoren mange mislykkede
  // startpunkter innenfor ÉN lang tegnkjede - den klassiske veien til O(n²).
  const HOSTILE: Array<[string, (size: number) => string]> = [
    ["JWT: «eyJ» i én lang kjede", (n) => sized("eyJ", n)],
    ["JWT: «eyJ»-kjede avsluttet med punktum", (n) => sized("eyJ", n, ".")],
    ["JWT: «eyJ»-kjede med to punktum og ingen avslutning", (n) => `${sized("eyJ", n / 2)}.${sized("eyJ", n / 2)}.`],
    ["JWT: «eyJ_»-kjede (understrek er en del av tegnklassen)", (n) => sized("eyJ_", n)],
    ["JWT: «eyJ-»-kjede (bindestrek er en del av tegnklassen)", (n) => sized("eyJ-", n)],
    ["JWT: lovlige ledd i det uendelige", (n) => sized("eyJaaaa.", n)],
    ["PEM: BEGIN-rammer uten END", (n) => sized(BEGIN_PKCS8, n)],
    ["PEM: «-----BEGIN » gjentatt", (n) => sized(BEGIN_ONLY, n)],
    ["PEM: BEGIN fulgt av én lang etikett uten «PRIVATE KEY»", (n) => `${BEGIN_ONLY}${"A".repeat(n)}`],
    ["PEM: mange komplette korte nøkler", (n) => sized(`${BEGIN_RSA}\nAAAA\n${END_RSA}\n`, n)],
    ["token: «ghp_» gjentatt", (n) => sized("ghp_", n)],
    ["token: ett tegn for kort etter prefikset, gjentatt", (n) => sized("ghp_aaaaaaaaaaa ", n)],
    ["token: «github_pat_» gjentatt", (n) => sized("github_pat_", n)],
    ["token: «gh» gjentatt", (n) => sized("gh", n)],
    ["Bearer: «Bearer » gjentatt", (n) => sized("Bearer ", n)],
    ["Bearer: «token» fulgt av et hav av mellomrom", (n) => `token${" ".repeat(n)}`],
    ["Bearer: elleve tegn (ett for kort), gjentatt", (n) => sized("Bearer aaaaaaaaaaa ", n)],
    ["Bearer: «token»+tab gjentatt", (n) => sized("token\t", n)],
    ["blanding av alle", (n) => sized(`eyJ${BEGIN_ONLY}ghp_Bearer token `, n)]
  ];

  it("F1a: alle regexene bruker < 1 s på fiendtlig inndata opptil 512 KB (eskalerende størrelser, så en regresjon feiler raskt og ikke henger)", () => {
    for (const [name, make] of HOSTILE) {
      for (const size of [16_384, 65_536, 524_288]) {
        const input = make(size);
        const started = performance.now();
        const masked = maskGitHubSecrets(input);
        const elapsed = performance.now() - started;
        expect(elapsed, `${name} @ ${size} tegn tok ${Math.round(elapsed)} ms`).toBeLessThan(1_000);
        expect(typeof masked).toBe("string");
      }
    }
  });

  it("F1b: mange eksakte kjente hemmeligheter mot en stor tekst er også raskt (split/join er lineært per hemmelighet)", () => {
    const text = sized("a", 524_288);
    const secrets = Array.from({ length: 50 }, (_, i) => "a".repeat(8 + i));
    const started = performance.now();
    maskGitHubSecrets(text, secrets);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("F1c: feilmeldingen (safeDetail via GitHubAppAuthError) kutter til en kort detalj, også for fiendtlig inndata på 512 KB", () => {
    for (const [name, make] of HOSTILE) {
      const started = performance.now();
      const error = new GitHubAppAuthError("GITHUB_APP_REQUEST_REJECTED", make(524_288));
      const elapsed = performance.now() - started;
      expect(elapsed, `${name} tok ${Math.round(elapsed)} ms`).toBeLessThan(1_000);
      expect(error.message.length).toBeLessThanOrEqual("GITHUB_APP_REQUEST_REJECTED:".length + 160);
    }
  });

  it("F1d: en fiendtlig 422-respons (21 000 × «eyJ», reprodusert fra reviewen: 7,9 s) stanser ikke event-loopen - og 510 KB er like raskt", async () => {
    for (const repeat of [21_000, 170_000]) {
      const h = await harness({ overrides: { maxAttempts: 1 } });
      h.fake.script = [{ status: 422, json: { message: "eyJ".repeat(repeat) } }];
      const started = performance.now();
      const error = await failure(h.auth.token());
      const elapsed = performance.now() - started;
      expect(error.code).toBe("GITHUB_APP_REQUEST_REJECTED");
      expect(elapsed, `${repeat} × eyJ tok ${Math.round(elapsed)} ms`).toBeLessThan(1_000);
      expect(error.message.length).toBeLessThan(200);
      await stopFakeServers();
    }
  });

  it("F1e: kuttet inndata svekker ikke maskeringen: hemmeligheter nær starten maskeres, og hemmeligheter bak vinduet slippes aldri inn i meldingen", () => {
    const token = `${["gh", "s_"].join("")}${"A1b2C3d4".repeat(6)}`;
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${"a".repeat(40)}.${"b".repeat(40)}`;
    const near = new GitHubAppAuthError("GITHUB_APP_FORBIDDEN", `feil ${token} og ${jwt} her`);
    expect(near.message).not.toContain(token);
    expect(near.message).not.toContain(jwt);
    expect(near.message).toContain("[REDACTED_TOKEN]");
    expect(near.message).toContain("[REDACTED_JWT]");
    const behind = new GitHubAppAuthError("GITHUB_APP_FORBIDDEN", `${"støy ".repeat(600)}${token} ${jwt}`);
    expect(behind.message).not.toContain(token.slice(0, 20));
    expect(behind.message).not.toContain(jwt.slice(0, 20));
  });

  it("F1f: en server som limer et bokstavprefiks foran JWT-en vi sendte (slipper unna lookbehind-mønsteret) får den likevel maskert - eksakt kjent JWT", async () => {
    const h = await harness({ overrides: { maxAttempts: 1 } });
    const seen: string[] = [];
    h.fake.script = [{ status: 401, build: (req) => { if (req.bearer) seen.push(req.bearer); return { status: 401, json: { message: `A${req.bearer ?? ""}B` } }; } }];
    const error = await failure(h.auth.token());
    expect(error.code).toBe("GITHUB_APP_AUTH_FAILED");
    expect(seen).toHaveLength(1);
    const jwt = seen[0] as string;
    expect(error.message).not.toContain(jwt);
    expect(error.message).not.toContain(jwt.slice(0, 40));
    expect(error.message).not.toContain(jwt.split(".")[1] as string);
    expect(JSON.stringify(error)).not.toContain(jwt.slice(0, 40));
    expect(JSON.stringify(h.auth.state())).not.toContain(jwt.slice(0, 40));
  });
});
