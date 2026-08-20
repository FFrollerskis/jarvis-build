import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { GithubApiError, GithubTransport, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";
import {
  GithubRateLimitController, GithubRateLimitedError, InMemoryGithubRateLimitStore, PgGithubRateLimitStore,
  classifyGithubResponse, computeFallbackCooldownMs, describeGithubEligibility, parseGithubPrimaryQuota,
  FALLBACK_BASE_COOLDOWN_MS, FALLBACK_MAX_COOLDOWN_MS
} from "../src/github-rate-limit-controller.ts";

/**
 * D-97 GitHub Rate-Limit Controller v1 - 25-punkts testmatrise per ordren
 * (§31). A-Q: ren klassifiserings-/kontroller-logikk (InMemoryGithubRateLimitStore,
 * ingen ekte HTTP/DB). R-T: wiring gjennom EKTE GithubTransport med mocket
 * global `fetch` (samme mønster som github-developer-control-plane.test.ts).
 * U-V: owner freeze/global pause - EKTE embedded Postgres + ToolGateway
 * (beviser at gateway.ts sine EKSISTERENDE, uendrede sjekker fortsatt
 * håndheves foran github-transporten, uavhengig av rate-limit-cooldown).
 * W: PgGithubRateLimitStore mot ekte Postgres (restart-sikkerhet/delt tilstand).
 */

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

describe("A-D: klassifisering av GitHub-svar (§9 - aldri hvert 403 som rate-limiting)", () => {
  it("A: status < 400 -> OK", () => {
    expect(classifyGithubResponse(200, headers({}), "")).toEqual({ kind: "OK" });
  });
  it("B: 403 med x-ratelimit-remaining=0 -> PRIMARY_RATE_LIMIT, retryAt fra x-ratelimit-reset", () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const result = classifyGithubResponse(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }), "");
    expect(result.kind).toBe("PRIMARY_RATE_LIMIT");
    expect((result as { retryAt: Date }).retryAt.getTime()).toBe(reset * 1000);
  });
  it("C: 429 med x-ratelimit-remaining=0 -> OGSAA PRIMARY_RATE_LIMIT (429 er aldri en tilgangsfeil)", () => {
    const result = classifyGithubResponse(429, headers({ "x-ratelimit-remaining": "0" }), "");
    expect(result.kind).toBe("PRIMARY_RATE_LIMIT");
  });
  it("D: 403 UTEN remaining=0, UTEN retry-after, UTEN sekundaer-fritekst -> EKTE PERMISSION_403, ALDRI en gjettet throttle", () => {
    const result = classifyGithubResponse(403, headers({}), '{"message":"Resource not accessible by integration"}');
    expect(result).toEqual({ kind: "PERMISSION_403" });
  });
});

describe("E-G: sekundaer-rate-limit-deteksjon", () => {
  it("E: 429 uten remaining=0 og uten retry-after -> SECONDARY_RATE_LIMIT, retryAfterMs=null", () => {
    const result = classifyGithubResponse(429, headers({}), "");
    expect(result).toEqual({ kind: "SECONDARY_RATE_LIMIT", retryAfterMs: null });
  });
  it("F: 403 med retry-after-header (sekunder) -> SECONDARY_RATE_LIMIT, retryAfterMs korrekt konvertert", () => {
    const result = classifyGithubResponse(403, headers({ "retry-after": "90" }), "");
    expect(result).toEqual({ kind: "SECONDARY_RATE_LIMIT", retryAfterMs: 90_000 });
  });
  it("G: 403 med dokumentert sekundaer-fritekst i kroppen (ingen retry-after) -> SECONDARY_RATE_LIMIT", () => {
    const result = classifyGithubResponse(403, headers({}), '{"message":"You have exceeded a secondary rate limit"}');
    expect(result).toEqual({ kind: "SECONDARY_RATE_LIMIT", retryAfterMs: null });
  });
  it("uinteressante statuser (404/422/500) -> OTHER, uroert av rate-limit-logikk", () => {
    expect(classifyGithubResponse(404, headers({}), "")).toEqual({ kind: "OTHER" });
    expect(classifyGithubResponse(500, headers({}), "")).toEqual({ kind: "OTHER" });
  });
  it("D-97 pre-merge-audit §6: negativ retry-after er MALFORMED - stoles ALDRI paa (skal ALDRI gi en cooldown i fortiden/0-delay-retry). 403 uten gyldig retry-after og uten sekundaer-fritekst faller derfor til PERMISSION_403", () => {
    const result = classifyGithubResponse(403, headers({ "retry-after": "-30" }), "");
    expect(result).toEqual({ kind: "PERMISSION_403" });
  });
  it("D-97 pre-merge-audit §6: retry-after=0 er en GYLDIG umiddelbar-retry-verdi, ikke malformed - godtas", () => {
    const result = classifyGithubResponse(403, headers({ "retry-after": "0" }), "");
    expect(result).toEqual({ kind: "SECONDARY_RATE_LIMIT", retryAfterMs: 0 });
  });
  it("D-97 pre-merge-audit §6: malformed (ikke-numerisk) retry-after paa 429 faller tilbake til SECONDARY_RATE_LIMIT med retryAfterMs=null (429 er uansett aldri en tilgangsfeil - jarvis_fallback tar over)", () => {
    const result = classifyGithubResponse(429, headers({ "retry-after": "not-a-number" }), "");
    expect(result).toEqual({ kind: "SECONDARY_RATE_LIMIT", retryAfterMs: null });
  });
});

describe("H: primaer-kvote-parsing (EXTERNAL_CANONICAL fakta)", () => {
  it("parser limit/remaining/used/reset(UTC epoch sek)/resource naar headerne finnes", () => {
    const reset = 1_800_000_000;
    const quota = parseGithubPrimaryQuota(headers({
      "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-used": "1",
      "x-ratelimit-reset": String(reset), "x-ratelimit-resource": "core"
    }));
    expect(quota).toEqual({ limit: 5000, remaining: 4999, used: 1, reset: new Date(reset * 1000), resource: "core" });
  });
  it("returnerer null naar INGEN av kvote-headerne er tilstede (ikke en gjettet 0-verdi)", () => {
    expect(parseGithubPrimaryQuota(headers({}))).toBeNull();
  });
});

describe("I-J: fallback-cooldown (§11 - >= 1 min, doblet, hardt tak, bundet jitter)", () => {
  it("I: base >= 1 min, dobler eksponentielt, aldri under 0", () => {
    const noJitter = () => 0.5; // (0.5*2-1)*ratio = 0 -> ingen jitter
    expect(computeFallbackCooldownMs(1, noJitter)).toBe(FALLBACK_BASE_COOLDOWN_MS);
    expect(computeFallbackCooldownMs(2, noJitter)).toBe(FALLBACK_BASE_COOLDOWN_MS * 2);
    expect(computeFallbackCooldownMs(3, noJitter)).toBe(FALLBACK_BASE_COOLDOWN_MS * 4);
  });
  it("J: hardt tak - selv mange paafoelgende brudd overskrider ALDRI FALLBACK_MAX_COOLDOWN_MS, med eller uten positiv jitter", () => {
    expect(computeFallbackCooldownMs(20, () => 1)).toBeLessThanOrEqual(FALLBACK_MAX_COOLDOWN_MS);
    expect(computeFallbackCooldownMs(20, () => 0)).toBeLessThanOrEqual(FALLBACK_MAX_COOLDOWN_MS);
  });
  it("jitter er bundet til +/-20% (§8/§11) - aldri utenfor det dokumenterte vinduet", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const v = computeFallbackCooldownMs(1, () => r);
      expect(v).toBeGreaterThanOrEqual(FALLBACK_BASE_COOLDOWN_MS * 0.8);
      expect(v).toBeLessThanOrEqual(FALLBACK_BASE_COOLDOWN_MS * 1.2 + 1);
    }
  });
});

describe("K-P: GithubRateLimitController med InMemoryGithubRateLimitStore", () => {
  const REF = "JARVIS_GITHUB_TOKEN";

  it("K: ingen tidligere tilstand -> alltid eligible (normal request passerer)", async () => {
    const c = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), REF);
    expect(await c.checkEligible(true)).toEqual({ eligible: true });
    expect(await c.checkEligible(false)).toEqual({ eligible: true });
  });

  it("L: PRIMARY_RATE_LIMIT blokkerer BAADE lesing og mutasjon (PROVIDER_THROTTLED) til reset-tidspunktet", async () => {
    const c = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), REF);
    const reset = Math.floor((Date.now() + 60_000) / 1000);
    await c.recordOutcome(true, 403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }), "");
    const mutationCheck = await c.checkEligible(true);
    const readCheck = await c.checkEligible(false);
    expect(mutationCheck.eligible).toBe(false);
    expect(readCheck.eligible).toBe(false);
    expect((mutationCheck as { reason: string }).reason).toBe("PROVIDER_THROTTLED");
  });

  it("M: SECONDARY_RATE_LIMIT blokkerer KUN mutasjoner (MUTATIONS_THROTTLED) - lesing forblir tilgjengelig", async () => {
    const c = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), REF);
    await c.recordOutcome(true, 429, headers({}), "");
    expect((await c.checkEligible(true)).eligible).toBe(false);
    expect((await c.checkEligible(false)).eligible).toBe(true);
  });

  it("N: cooldown blokkerer gjentatte mutasjonsforsøk med SAMME cooldown-vindu (ingen ny provider-forespørsel skal trengs for aa vite dette)", async () => {
    const c = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), REF);
    await c.recordOutcome(true, 403, headers({ "retry-after": "60" }), "");
    const first = await c.checkEligible(true);
    const second = await c.checkEligible(true);
    expect(first.eligible).toBe(false);
    expect(second.eligible).toBe(false);
    expect((first as { retryAt: Date }).retryAt.getTime()).toBe((second as { retryAt: Date }).retryAt.getTime());
  });

  it("O: eligible igjen etter at cooldown har passert (klokke injisert)", async () => {
    let now = new Date("2026-08-20T22:00:00Z");
    const c = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), REF, undefined, () => now);
    await c.recordOutcome(true, 429, headers({ "retry-after": "60" }), "");
    expect((await c.checkEligible(true)).eligible).toBe(false);
    now = new Date("2026-08-20T22:01:01Z"); // 61s senere - forbi 60s retry-after
    expect((await c.checkEligible(true)).eligible).toBe(true);
  });

  it("D-97 pre-merge-audit §14: eksakt grense now===cooldown_until - konsistent definert (eligible AKKURAT ved cooldown_until, IKKE ett tikk foer)", async () => {
    let now = new Date("2026-08-20T22:00:00Z");
    const c = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), REF, undefined, () => now);
    await c.recordOutcome(true, 429, headers({ "retry-after": "60" }), ""); // cooldown_until = 22:01:00
    now = new Date("2026-08-20T22:00:59.999Z"); // rett FOeR
    expect((await c.checkEligible(true)).eligible).toBe(false);
    now = new Date("2026-08-20T22:01:00.000Z"); // EKSAKT lik
    expect((await c.checkEligible(true)).eligible).toBe(true);
  });

  it("P: en vellykket MUTASJON rydder MUTATIONS_THROTTLED til NORMAL; en vellykket LESNING gjør IKKE det", async () => {
    const store = new InMemoryGithubRateLimitStore();
    const c = new GithubRateLimitController(store, REF);
    await c.recordOutcome(true, 429, headers({}), "");
    expect((await c.checkEligible(true)).eligible).toBe(false);
    await c.recordOutcome(false, 200, headers({}), ""); // vellykket LES
    expect((await c.checkEligible(true)).eligible).toBe(false); // fortsatt kastet - lesing sier ingenting
    await c.recordOutcome(true, 200, headers({}), ""); // vellykket MUTASJON
    expect((await c.checkEligible(true)).eligible).toBe(true);
  });
});

describe("D-97 pre-merge-audit §19 (KRITISK): monoton cooldown - en kortere, senere-ankommet brudd forkorter ALDRI en lengre eksisterende cooldown, uansett skrive-rekkefolge", () => {
  it("InMemoryGithubRateLimitStore: lang cooldown (10 min) skrevet FOeRST, kort fallback (1 min) skrevet ETTERPAA -> lang cooldown VINNER", async () => {
    const store = new InMemoryGithubRateLimitStore();
    const now = new Date("2026-08-20T22:00:00Z");
    const longCooldown = new Date(now.getTime() + 10 * 60_000); // provider Retry-After=10min
    const shortCooldown = new Date(now.getTime() + 1 * 60_000); // jarvis-fallback=1min, ankommer SENERE
    await store.recordViolation("TOKEN", "MUTATIONS_THROTTLED", longCooldown, "provider", null);
    await store.recordViolation("TOKEN", "MUTATIONS_THROTTLED", shortCooldown, "jarvis_fallback", null);
    const row = await store.get("TOKEN");
    expect(row?.cooldownUntil?.getTime()).toBe(longCooldown.getTime()); // IKKE forkortet til 1 min
    expect(row?.retryAfterSource).toBe("provider"); // kilden til den VINNENDE (lengste) cooldown-en
  });
  it("InMemoryGithubRateLimitStore: motsatt rekkefoelge (kort FOeRST, lang ETTERPAA) -> lang cooldown tar fortsatt over (forlenger korrekt)", async () => {
    const store = new InMemoryGithubRateLimitStore();
    const now = new Date("2026-08-20T22:00:00Z");
    const shortCooldown = new Date(now.getTime() + 1 * 60_000);
    const longCooldown = new Date(now.getTime() + 10 * 60_000);
    await store.recordViolation("TOKEN", "MUTATIONS_THROTTLED", shortCooldown, "jarvis_fallback", null);
    await store.recordViolation("TOKEN", "PROVIDER_THROTTLED", longCooldown, "provider", null);
    const row = await store.get("TOKEN");
    expect(row?.cooldownUntil?.getTime()).toBe(longCooldown.getTime());
    expect(row?.state).toBe("PROVIDER_THROTTLED");
  });
  it("consecutive_violations telles UAVHENGIG av hvilken skriving som faktisk 'vinner' cooldown_until/state", async () => {
    const store = new InMemoryGithubRateLimitStore();
    const now = new Date("2026-08-20T22:00:00Z");
    await store.recordViolation("TOKEN", "MUTATIONS_THROTTLED", new Date(now.getTime() + 10 * 60_000), "provider", null);
    await store.recordViolation("TOKEN", "MUTATIONS_THROTTLED", new Date(now.getTime() + 1 * 60_000), "jarvis_fallback", null);
    const row = await store.get("TOKEN");
    expect(row?.consecutiveViolations).toBe(2); // begge bruddene telles, selv om kun den ene "vant" cooldown_until
  });
});

describe("Q: credential-uavhengighet (§16 - credential B arver ALDRI credential A sin cooldown)", () => {
  it("to ulike credential_ref har uavhengig tilstand i samme store", async () => {
    const store = new InMemoryGithubRateLimitStore();
    const a = new GithubRateLimitController(store, "TOKEN_A");
    const b = new GithubRateLimitController(store, "TOKEN_B");
    await a.recordOutcome(true, 429, headers({}), "");
    expect((await a.checkEligible(true)).eligible).toBe(false);
    expect((await b.checkEligible(true)).eligible).toBe(true);
  });
});

describe("R: ingen hemmelighet i kontroller-tilstand", () => {
  it("credentialRef er en KONFIGURASJONS-referanse (samme streng som ToolDefinition.credential_ref), ALDRI et raatt token - GithubEligibilityDenied/describeGithubEligibility lekker ingen credential-verdi", async () => {
    const c = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), "JARVIS_GITHUB_TOKEN");
    await c.recordOutcome(true, 429, headers({}), "");
    const denied = await c.checkEligible(true);
    expect(denied.eligible).toBe(false);
    const message = describeGithubEligibility(denied as never);
    expect(message).not.toContain("ghp_");
    expect(message).not.toMatch(/[A-Za-z0-9]{20,}/); // ingen tokenlignende streng i den menneskelesbare meldingen
  });
});

describe("S: repeterte brudd spammer ikke transisjons-hendelser (§23)", () => {
  it("N paafoelgende SECONDARY_RATE_LIMIT-svar gir KUN 1x 'entered' + N-1x 'extended', aldri N identiske 'entered'", async () => {
    const events: string[] = [];
    const c = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), "JARVIS_GITHUB_TOKEN", (e) => events.push(e.transition));
    for (let i = 0; i < 5; i++) await c.recordOutcome(true, 429, headers({}), "");
    expect(events).toEqual(["entered", "extended", "extended", "extended", "extended"]);
  });
  it("en vellykket kall etter NORMAL gir ALDRI et 'cleared'-event (ingen falsk overgang)", async () => {
    const events: string[] = [];
    const c = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), "JARVIS_GITHUB_TOKEN", (e) => events.push(e.transition));
    await c.recordOutcome(true, 200, headers({}), "");
    await c.recordOutcome(true, 200, headers({}), "");
    expect(events).toEqual([]);
  });
});

const REPO = "tsworkflow/jarvisbuild";
const CTX = { identity: { person_id: "p1", tenant_id: "t1", session_id: "s1" } as never };
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("T-W: wiring gjennom EKTE GithubTransport (mocket global fetch, samme mønster som github-developer-control-plane.test.ts)", () => {
  it("T: normal request passerer OG oppdaterer kvote-fakta (5xx-retry UENDRET, IKKE et rate-limit-anliggende)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { full_name: REPO, description: null, updated_at: "x", default_branch: "main" }, { "x-ratelimit-remaining": "4999" }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), "JARVIS_GITHUB_TOKEN");
    const transport = new GithubTransport(controller);
    const result = await transport.invoke("read_repo_meta", { repo: REPO }, "tok", CTX);
    expect(result.data).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("U: naar kontrolleren allerede har registrert en mutasjons-cooldown, gjør githubFetch ALDRI det ekte nettverkskallet (§9/§12/PR37-klasse-regresjon)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { number: 1, html_url: "u", merged: true, message: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const store = new InMemoryGithubRateLimitStore();
    const controller = new GithubRateLimitController(store, "JARVIS_GITHUB_TOKEN");
    // Simulerer den EKTE PR#37-klasse-hendelsen: en tidligere mutasjon ble sekundaer-throttlet.
    await controller.recordOutcome(true, 429, headers({}), "");
    const transport = new GithubTransport(controller);
    await expect(transport.invoke("merge_pr", { repo: REPO, pr_number: "37" }, "tok", CTX))
      .rejects.toBeInstanceOf(GithubRateLimitedError);
    expect(fetchMock).not.toHaveBeenCalled(); // INGEN provider-kall gjort under cooldown
  });

  it("V: 429-svar fra selve provideren under et ekte forsøk kastes UMIDDELBART (ingen inline sleep-retry lenger naar kontroller er wired) OG registreres i delt tilstand for NESTE forsøk", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", { status: 429, headers: { "retry-after": "60" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), "JARVIS_GITHUB_TOKEN");
    const transport = new GithubTransport(controller);
    await expect(transport.invoke("create_pr", { repo: REPO, branch: "b", title: "t" }, "tok", CTX)).rejects.toBeInstanceOf(GithubApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // ETT forsøk, ALDRI en inline-sleep-retry-løkke for et rate-limit-signal
    await expect(transport.invoke("create_pr", { repo: REPO, branch: "b", title: "t" }, "tok", CTX)).rejects.toBeInstanceOf(GithubRateLimitedError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // andre forsøket blokkeres FØR nettverket i det hele tatt
  });

  it("W: 500 (ekte forbigående feil, IKKE rate-limiting) beholder UENDRET kort inline-retry naar kontroller er wired", async () => {
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls++;
      if (calls < 2) return new Response("", { status: 500 });
      return jsonResponse(200, { full_name: REPO, description: null, updated_at: "x", default_branch: "main" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), "JARVIS_GITHUB_TOKEN");
    const transport = new GithubTransport(controller);
    const result = await transport.invoke("read_repo_meta", { repo: REPO }, "tok", CTX);
    expect(result.data).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1x 500 + 1x vellykket inline-retry, som FØR denne sliceen
  });

  it("uten wired kontroller (undefined) er oppførselen 100% UENDRET fra før D-97 - inkludert den GAMLE 429-inline-sleep-retry-en", async () => {
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls++;
      if (calls < 2) return new Response("", { status: 429, headers: { "retry-after": "0" } });
      return jsonResponse(200, { full_name: REPO, description: null, updated_at: "x", default_branch: "main" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport(); // INGEN kontroller - samme som alle eksisterende kallesteder/tester
    const result = await transport.invoke("read_repo_meta", { repo: REPO }, "tok", CTX);
    expect(result.data).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2); // gammel oppførsel: 429 er fortsatt i GITHUB_RETRYABLE_STATUS naar ingen kontroller er tilstede
  });
});

describe("X: mutasjons-serialisering (§7/§14 - prosess-lokal, min. 1s avstand, offisiell veiledning)", () => {
  it("to samtidige mutasjoner gjennom SAMME kontroller kjøres serielt, ikke parallelt", async () => {
    const order: string[] = [];
    let nextCallId = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const callId = nextCallId++;
      order.push(`start:${callId}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${callId}`);
      return jsonResponse(200, { id: 1, html_url: "u" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), "JARVIS_GITHUB_TOKEN");
    const transport = new GithubTransport(controller);
    await Promise.all([
      transport.invoke("comment_on_issue", { repo: REPO, issue_number: "1", body: "a" }, "tok", CTX),
      transport.invoke("comment_on_issue", { repo: REPO, issue_number: "2", body: "b" }, "tok", CTX)
    ]);
    // Serielt: rekkefølgen maa vaere [start:0, end:0, start:1, end:1] - den andre
    // 'start' kommer ALDRI før den første 'end' (ingen overlapp/parallellitet).
    expect(order).toEqual(["start:0", "end:0", "start:1", "end:1"]);
  }, 10_000);
});

describe("Y: owner freeze/global pause håndheves FORTSATT foran GitHub-transporten, uavhengig av rate-limit-cooldown-tilstand (§21)", () => {
  const PORT = 30000 + Math.floor(Math.random() * 20000);
  let epg: InstanceType<typeof EmbeddedPostgres>;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let controls: OwnerControls;
  let killSwitch: KillSwitch;
  let gateway: ToolGateway;
  const owner: IdentityContext = {
    person_id: "p-tobias", tenant_id: "t-a", memory_space_id: "home",
    session_id: "s", device_id: "d", channel: "voice", auth_strength: "active"
  };
  const secrets: SecretProvider = { name: "t", async get() { return "tok"; } };

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pggh97-"));
    epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
    await epg.initialise(); await epg.start(); await epg.createDatabase("jarvis_test");
    adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
    adminPool.on("error", () => undefined);
    await runMigrations(adminPool);
    await adminPool.query("CREATE ROLE jarvis_test97 LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test97;");
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('t-a','T','person');
      INSERT INTO people (person_id, display_name) VALUES ('p-tobias','Tobias');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('p-tobias','t-a');
    `);
    appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test97", password: "pw2" });
    killSwitch = new KillSwitch();
    controls = new OwnerControls(killSwitch);
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls,
      authority: { owner_person_id: "p-tobias", owner_tenants: ["t-a"] }
    });
    gateway = new ToolGateway(appPool, policy, secrets, controls);
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { full_name: REPO, description: null, updated_at: "x", default_branch: "main" }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new GithubRateLimitController(new InMemoryGithubRateLimitStore(), "JARVIS_GITHUB_TOKEN");
    for (const t of firstWaveTools({ github: new GithubTransport(controller) })) gateway.register(t);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await appPool?.end(); await adminPool?.end(); await epg?.stop();
  }, 120_000);

  it("frosset 'github'-connector stopper handlingen FØR transporten nås - selv naar rate-limit-tilstanden er NORMAL", async () => {
    controls.freezeConnector("github");
    const r = await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } });
    expect((r as { reason: string }).reason).toBe("connector_frozen");
    controls.unfreezeConnector("github");
  });

  it("global pause (kill switch) stopper handlingen identisk - re-evaluert paa HVERT forsøk, ogsaa etter en tidligere cooldown ville ha utløpt", async () => {
    controls.pauseAll("test-D97");
    const r = await gateway.execute({ identity: owner, tool_id: "github", action: "read_repo_meta", parameters: { repo: REPO } });
    expect((r as { reason: string }).reason).toBe("kill_switch_active");
    controls.resumeAll();
  });
});

describe("Z: PgGithubRateLimitStore mot ekte Postgres (restart-sikkerhet/delt tilstand, §17)", () => {
  const PORT = 30000 + Math.floor(Math.random() * 20000);
  let epg: InstanceType<typeof EmbeddedPostgres>;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pggh97store-"));
    epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
    await epg.initialise(); await epg.start(); await epg.createDatabase("jarvis_test");
    adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
    adminPool.on("error", () => undefined);
    await runMigrations(adminPool);
    await adminPool.query("CREATE ROLE jarvis_test97b LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test97b;");
    appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test97b", password: "pw2" });
  }, 240_000);

  afterAll(async () => { await appPool?.end(); await adminPool?.end(); await epg?.stop(); }, 120_000);

  it("en violation skrevet av ÉN store-instans (t.d. 'api'-prosessen) leses tilbake av en HELT NY instans (t.d. 'worker'-prosessen etter restart) - delt/overlevende tilstand", async () => {
    const apiInstance = new PgGithubRateLimitStore(appPool);
    const retryAt = new Date(Date.now() + 120_000);
    await apiInstance.recordViolation("JARVIS_GITHUB_TOKEN", "MUTATIONS_THROTTLED", retryAt, "provider", { limit: 60, remaining: 55, used: 5, reset: null, resource: "core" });
    const workerInstanceAfterRestart = new PgGithubRateLimitStore(appPool);
    const row = await workerInstanceAfterRestart.get("JARVIS_GITHUB_TOKEN");
    expect(row?.state).toBe("MUTATIONS_THROTTLED");
    expect(row?.cooldownUntil?.getTime()).toBe(retryAt.getTime());
    expect(row?.primary.remaining).toBe(55);
  });

  it("recordSuccess(mutation=false) oppdaterer KUN kvote-fakta, rører ALDRI en eksisterende MUTATIONS_THROTTLED-rad", async () => {
    const store = new PgGithubRateLimitStore(appPool);
    await store.recordViolation("TOKEN_READONLY_TEST", "MUTATIONS_THROTTLED", new Date(Date.now() + 60_000), "jarvis_fallback", null);
    await store.recordSuccess("TOKEN_READONLY_TEST", false, { limit: 60, remaining: 59, used: 1, reset: null, resource: "core" });
    const row = await store.get("TOKEN_READONLY_TEST");
    expect(row?.state).toBe("MUTATIONS_THROTTLED");
    expect(row?.primary.remaining).toBe(59);
  });

  it("D-97 pre-merge-audit §19 (KRITISK) mot EKTE Postgres: en lang provider-cooldown (10 min) skrevet av 'prosess A' forkortes ALDRI av en senere, kortere jarvis-fallback-cooldown (1 min) fra 'prosess B' paa SAMME credential", async () => {
    const storeA = new PgGithubRateLimitStore(appPool);
    const storeB = new PgGithubRateLimitStore(appPool);
    const now = Date.now();
    const longCooldown = new Date(now + 10 * 60_000);
    const shortCooldown = new Date(now + 1 * 60_000);
    await storeA.recordViolation("TOKEN_RACE_TEST", "PROVIDER_THROTTLED", longCooldown, "provider", null);
    await storeB.recordViolation("TOKEN_RACE_TEST", "MUTATIONS_THROTTLED", shortCooldown, "jarvis_fallback", null);
    const row = await storeA.get("TOKEN_RACE_TEST");
    expect(row?.cooldownUntil?.getTime()).toBe(longCooldown.getTime());
    expect(row?.state).toBe("PROVIDER_THROTTLED");
    expect(row?.retryAfterSource).toBe("provider");
    expect(row?.consecutiveViolations).toBe(2); // begge bruddene talt, uansett hvilket som "vant"
  });

  it("D-97 pre-merge-audit §19: motsatt skrive-rekkefoelge (kort FOeRST fra prosess B, lang ETTERPAA fra prosess A) gir samme korrekte sluttresultat - lang cooldown vinner uansett rekkefoelge", async () => {
    const storeA = new PgGithubRateLimitStore(appPool);
    const storeB = new PgGithubRateLimitStore(appPool);
    const now = Date.now();
    const shortCooldown = new Date(now + 1 * 60_000);
    const longCooldown = new Date(now + 10 * 60_000);
    await storeB.recordViolation("TOKEN_RACE_TEST_2", "MUTATIONS_THROTTLED", shortCooldown, "jarvis_fallback", null);
    await storeA.recordViolation("TOKEN_RACE_TEST_2", "PROVIDER_THROTTLED", longCooldown, "provider", null);
    const row = await storeA.get("TOKEN_RACE_TEST_2");
    expect(row?.cooldownUntil?.getTime()).toBe(longCooldown.getTime());
    expect(row?.state).toBe("PROVIDER_THROTTLED");
  });
});
