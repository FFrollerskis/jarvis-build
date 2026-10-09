import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { CloudflareApiError, CloudflareTransport, maskEmail } from "../src/cloudflare-transport.ts";
import { FakeCloudflare, hex32 } from "./support/fake-cloudflare.ts";

/**
 * WP-E1: `CloudflareTransport` mot en LOKAL fake Cloudflare-server (ekte node:http + guardedFetch + fetch - ingen nettverk ut av maskinen). Bevist:
 * lesing (soner/DNS/rulesets/innstillinger/konto), skriving med nøyaktige forespørselskropper, sone->konto-binding, retry-reglene (lesing gjentas,
 * mutasjon gjentas ALDRI på 5xx), sti-injeksjon avvises FØR noe kall, token lekker aldri i feil/utdata, og idempotens (identisk post/regel opprettes ikke to ganger).
 */
let cf: FakeCloudflare;
let sleeps: number[];

beforeAll(async () => {
  cf = new FakeCloudflare();
  await cf.start();
});
afterAll(async () => {
  await cf.stop();
});
beforeEach(() => {
  cf.requests.length = 0;
  cf.ignoreFilters = false;
  cf.silentlyIgnoreWrites = false;
  cf.ruleUpdateSemantics = "replace";
  cf.quoteTxt = true;
  cf.tokenKind = "account";
  cf.tokenStatus = "active";
  cf.rateLimitNext(0);
  sleeps = [];
});

const transport = (over: { accountId?: (() => Promise<string | null>) | undefined } = {}) =>
  new CloudflareTransport({
    baseUrl: cf.baseUrl,
    ...("accountId" in over ? (over.accountId ? { accountId: over.accountId } : {}) : { accountId: async () => cf.accountId }),
    sleep: async (ms) => { sleeps.push(ms); }
  });
const call = (action: string, params: Record<string, JsonValue>, token: string = cf.token, t: CloudflareTransport = transport()) => t.invoke(action, params, token);
const data = <T>(r: { data?: JsonValue }): T => r.data as unknown as T;
/** Venter på at et løfte avvises og returnerer feilen (feiler testen hvis det lykkes). */
const rejection = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("forventet avvisning, men kallet lyktes");
};
const freshZone = (name = `z${hex32().slice(0, 8)}.example.com`): { id: string; name: string } => ({ id: cf.addZone(name), name });

describe("A: autentisering, token-hygiene og ukjente handlinger", () => {
  it("check_token mot konto-endepunktet når konto er konfigurert; Bearer-token brukes og returneres aldri", async () => {
    const r = await call("check_token", {});
    expect(data<{ kind: string; status: string }>(r)).toMatchObject({ kind: "account", status: "active" });
    expect(cf.requests[0]).toMatchObject({ method: "GET", path: `/accounts/${cf.accountId}/tokens/verify`, auth: "ok" });
    expect(JSON.stringify(r)).not.toContain(cf.token);
  });

  it("et bruker-eid token faller tilbake til /user/tokens/verify når konto-endepunktet avviser det", async () => {
    cf.tokenKind = "user";
    const r = await call("check_token", {});
    expect(data<{ kind: string; expires_on: string }>(r)).toMatchObject({ kind: "user", expires_on: "2030-01-01T00:00:00Z" });
    expect(cf.requests.map((x) => x.path)).toEqual([`/accounts/${cf.accountId}/tokens/verify`, "/user/tokens/verify"]);
  });

  it("uten konfigurert konto brukes /user/tokens/verify direkte", async () => {
    cf.tokenKind = "user";
    await call("check_token", {}, cf.token, transport({ accountId: undefined }));
    expect(cf.requests.map((x) => x.path)).toEqual(["/user/tokens/verify"]);
  });

  it("feil token gir én 401 (ingen retry) og token-verdien står ikke i feilmeldingen", async () => {
    const wrong = "wrong-token-value-1234567890";
    const err = await rejection(call("list_zones", {}, wrong));
    expect(err).toBeInstanceOf(CloudflareApiError);
    expect((err as CloudflareApiError).httpStatus).toBe(401);
    expect((err as Error).message).toMatch(/^cloudflare_error_401:10000:Authentication error$/);
    expect((err as Error).message).not.toContain(wrong);
    expect(cf.requests).toHaveLength(1);
    expect(cf.requests[0]!.auth).toBe("wrong");
  });

  it("selv om leverandøren ekkoer tokenet i en feilmelding, vaskes det bort", async () => {
    cf.failNext(/GET \/zones$/, 400, { success: false, errors: [{ code: 1, message: `bad request for ${cf.token}` }], messages: [], result: null });
    const err = await rejection(call("list_zones", {}));
    expect(err.message).toContain("[REDACTED]");
    expect(err.message).not.toContain(cf.token);
  });

  it("ukjent handling kaster, og verken lesing eller skriving skjer", async () => {
    await expect(call("delete_zone", {})).rejects.toThrow("cloudflare_unsupported_action_delete_zone");
    expect(cf.requests).toHaveLength(0);
  });

  it("maskEmail beholder kun første tegn og domenet", () => {
    expect(maskEmail("tobias@example.com")).toBe("t***@example.com");
    expect(maskEmail("x")).toBe("***");
    expect(maskEmail(null)).toBeNull();
  });
});

describe("B: lesing - soner, DNS, rulesets, innstillinger og konto", () => {
  it("list_zones filtrerer til konfigurert konto også når serveren ignorerer filteret, og paginerer", async () => {
    const own = freshZone();
    const foreign = cf.addZone("foreign.example.org", hex32());
    cf.ignoreFilters = true;
    for (let i = 0; i < 60; i++) cf.addZone(`bulk${i}.example.net`);
    const r = data<{ zones: Array<{ id: string; account_id: string }>; account_filter: boolean }>(await call("list_zones", {}));
    expect(r.account_filter).toBe(true);
    expect(r.zones.some((z) => z.id === own.id)).toBe(true);
    expect(r.zones.some((z) => z.id === foreign)).toBe(false);
    expect(r.zones.every((z) => z.account_id === cf.accountId)).toBe(true);
    expect(cf.requests.filter((x) => x.path === "/zones").length).toBeGreaterThanOrEqual(2);
    expect(cf.requests[0]!.query["per_page"]).toBe("50");
  });

  it("get_zone: normalisert svar, 404 gir null, sone fra en annen konto avvises", async () => {
    const z = freshZone();
    expect(data<{ id: string; name: string; account_id: string }>(await call("get_zone", { zone_id: z.id }))).toMatchObject({ id: z.id, name: z.name, account_id: cf.accountId });
    expect((await call("get_zone", { zone_id: hex32() })).data).toBeNull();
    const foreign = cf.addZone("other.example.org", hex32());
    await expect(call("get_zone", { zone_id: foreign })).rejects.toThrow("cloudflare_zone_not_in_account");
  });

  it("list_dns_records: paginerer over flere sider, og eksakt type/navn-filtrering gjelder også lokalt", async () => {
    const z = freshZone();
    for (let i = 0; i < 250; i++) cf.seedDns(z.id, { type: "A", name: `h${i}.${z.name}`, content: "192.0.2.10" });
    cf.seedDns(z.id, { type: "TXT", name: `h7.${z.name}`, content: "hello" });
    const all = data<{ count: number; truncated: boolean }>(await call("list_dns_records", { zone_id: z.id }));
    expect(all).toMatchObject({ count: 251, truncated: false });
    cf.requests.length = 0;
    cf.ignoreFilters = true; // serveren kjenner ikke filteret -> returnerer alt; transporten må filtrere selv
    const filtered = data<{ records: Array<{ type: string; name: string }> }>(await call("list_dns_records", { zone_id: z.id, type: "A", name: `H7.${z.name}` }));
    expect(filtered.records).toEqual([expect.objectContaining({ type: "A", name: `h7.${z.name}` })]);
  });

  it("list_dns_records avkorter ved 10 sider og sier det eksplisitt (truncated)", async () => {
    const z = freshZone();
    for (let i = 0; i < 1_010; i++) cf.seedDns(z.id, { type: "A", name: `t${i}.${z.name}`, content: "192.0.2.11" });
    const r = data<{ count: number; truncated: boolean }>(await call("list_dns_records", { zone_id: z.id }));
    expect(r).toMatchObject({ count: 1_000, truncated: true });
  });

  it("find_dns_records gir alltid et objekt (også uten treff) - brukes som preflight/readback for opprettelse", async () => {
    const z = freshZone();
    const none = data<{ count: number; records: unknown[] }>(await call("find_dns_records", { zone_id: z.id, type: "A", name: `ny.${z.name}` }));
    expect(none).toMatchObject({ count: 0, records: [] });
  });

  it("get_dns_record: normalisert post, 404 gir null (preflight 'finnes ikke')", async () => {
    const z = freshZone();
    const id = cf.seedDns(z.id, { type: "TXT", name: `txt.${z.name}`, content: "v=spf1 -all", comment: "spf" });
    expect(data<{ id: string; content: string; comment: string }>(await call("get_dns_record", { zone_id: z.id, record_id: id }))).toMatchObject({ id, content: '"v=spf1 -all"', comment: "spf" });
    expect((await call("get_dns_record", { zone_id: z.id, record_id: hex32() })).data).toBeNull();
  });

  it("get_ruleset: manglende entrypoint gir exists:false (ikke feil); eksisterende regler normaliseres og ukjente felt bevares i extra", async () => {
    const z = freshZone();
    const missing = data<{ exists: boolean; rules: unknown[] }>(await call("get_ruleset", { zone_id: z.id, phase: "http_request_firewall_custom" }));
    expect(missing).toMatchObject({ exists: false, rules: [] });
    cf.seedRule(z.id, "http_request_firewall_custom", { action: "block", expression: 'ip.src eq 203.0.113.9', description: "blokker", action_parameters: { response: { status_code: 403 } } });
    const got = data<{ exists: boolean; id: string; rules: Array<{ action: string; extra: Record<string, unknown> }> }>(await call("get_ruleset", { zone_id: z.id, phase: "http_request_firewall_custom" }));
    expect(got.exists).toBe(true);
    expect(got.rules[0]).toMatchObject({ action: "block", extra: { action_parameters: { response: { status_code: 403 } } } });
    await expect(call("get_ruleset", { zone_id: z.id, phase: "http_request_transform" })).rejects.toThrow(/cloudflare_invalid_phase/);
  });

  it("sone-innstillinger leses per innstilling - det deprecated batch-endepunktet kalles aldri", async () => {
    const z = freshZone();
    const r = data<{ settings: Array<{ id: string; value: string }> }>(await call("list_zone_settings", { zone_id: z.id }));
    expect(r.settings.map((s) => s.id).sort()).toEqual(["always_use_https", "development_mode", "min_tls_version", "security_level", "ssl", "tls_1_3"]);
    expect(cf.requests.some((x) => x.path === `/zones/${z.id}/settings`)).toBe(false);
    await expect(call("get_zone_setting", { zone_id: z.id, setting_id: "automatic_https_rewrites" })).rejects.toThrow("cloudflare_invalid_setting_id");
    expect(data<{ id: string; value: string }>(await call("get_zone_setting", { zone_id: z.id, setting_id: "ssl" }))).toMatchObject({ id: "ssl", value: "full" });
  });

  it("konto-lister: e-post maskeres, token-metadata uten policy, audit-logg uten aktørens e-post/IP; manglende konto feiler lukket", async () => {
    cf.members = [{ id: "m1", status: "accepted", user: { email: "tobias@example.com", first_name: "Tobias", two_factor_authentication_enabled: true }, roles: [{ id: "r1", name: "Administrator" }] }];
    cf.roles = [{ id: "r1", name: "Administrator", description: "Full access", permissions: { dns: { read: true, write: true } } }];
    cf.apiTokens = [{ id: "t1", name: "jarvis", status: "active", issued_on: "2026-01-01T00:00:00Z", expires_on: "2027-01-01T00:00:00Z", policies: [{ secret: "should-not-appear" }] }];
    cf.auditEvents = [{ id: "a1", action: { type: "update", result: "success", time: "2026-10-01T10:00:00Z" }, actor: { type: "user", email: "tobias@example.com", ip_address: "198.51.100.7" }, resource: { type: "dns_record", id: "x", product: "dns" }, zone: { name: "example.com" } }];
    const members = JSON.stringify(await call("list_account_members", {}));
    expect(members).toContain("t***@example.com");
    expect(members).not.toContain("tobias@");
    expect(members).not.toContain("Tobias");
    expect(JSON.stringify(await call("list_account_roles", {}))).toContain("Administrator");
    const tokens = JSON.stringify(await call("list_api_tokens", {}));
    expect(tokens).toContain("jarvis");
    expect(tokens).not.toContain("should-not-appear");
    const audit = JSON.stringify(await call("list_audit_logs", { since: "2026-09-30T00:00:00Z", limit: 10 }));
    expect(audit).toContain("dns_record");
    expect(audit).not.toContain("198.51.100.7");
    expect(audit).not.toContain("tobias@");
    expect(cf.requestsMatching("GET", /logs\/audit/)[0]!.query).toMatchObject({ since: "2026-09-30T00:00:00.000Z", limit: "10" });
    await expect(call("list_account_members", {}, cf.token, transport({ accountId: undefined }))).rejects.toThrow("cloudflare_account_not_configured");
    await expect(call("list_audit_logs", { since: "ikke-en-dato" })).rejects.toThrow("cloudflare_invalid_since");
    await expect(call("list_audit_logs", { limit: 1000 })).rejects.toThrow("cloudflare_invalid_limit");
  });

  it("audit-logg v2 KREVER både since og before hos Cloudflare: uten parametre sendes siste 24 timer, og et omvendt vindu avvises før kallet", async () => {
    cf.requests.length = 0;
    const fixed = Date.parse("2026-10-09T12:00:00Z");
    const t = new CloudflareTransport({ baseUrl: cf.baseUrl, accountId: async () => cf.accountId, sleep: async () => undefined, now: () => fixed });
    await call("list_audit_logs", {}, cf.token, t);
    expect(cf.requestsMatching("GET", /logs\/audit/)[0]!.query).toMatchObject({ before: "2026-10-09T12:00:00.000Z", since: "2026-10-08T12:00:00.000Z" });
    await call("list_audit_logs", { before: "2026-10-05T00:00:00Z" }, cf.token, t);
    expect(cf.requestsMatching("GET", /logs\/audit/)[1]!.query).toMatchObject({ before: "2026-10-05T00:00:00.000Z", since: "2026-10-04T00:00:00.000Z" });
    cf.requests.length = 0;
    await expect(call("list_audit_logs", { since: "2026-10-09T13:00:00Z" }, cf.token, t)).rejects.toThrow("cloudflare_invalid_since");
    await expect(call("list_audit_logs", { since: "2026-10-02T00:00:00Z", before: "2026-10-01T00:00:00Z" }, cf.token, t)).rejects.toThrow("cloudflare_invalid_since");
    expect(cf.requestsMatching("GET", /logs\/audit/)).toHaveLength(0);
  });
});

describe("C: retry-regler og svarvalidering", () => {
  it("lesing gjentas på 5xx og på 429 med Retry-After (begrenset), og gir opp etter 3 forsøk", async () => {
    cf.failNext(/GET \/zones$/, 500, undefined, 1);
    const ok = data<{ zones: unknown[] }>(await call("list_zones", {}));
    expect(Array.isArray(ok.zones)).toBe(true);
    // første side hentes to ganger (500 + vellykket retry); flere sider kan komme fra soner andre tester har lagt til
    expect(cf.requests.filter((x) => x.path === "/zones" && x.query["page"] === "1")).toHaveLength(2);
    expect(sleeps).toEqual([500]);
    sleeps.length = 0;
    cf.rateLimitNext(1, 3);
    await call("list_zones", {});
    expect(sleeps).toEqual([3_000]);
    sleeps.length = 0;
    cf.rateLimitNext(1, 3_600); // utrolig lang Retry-After kappes
    await call("list_zones", {});
    expect(sleeps).toEqual([10_000]);
    cf.requests.length = 0;
    cf.failNext(/GET \/zones$/, 503, undefined, 5);
    await expect(call("list_zones", {})).rejects.toThrow(/^cloudflare_error_503/);
    expect(cf.requests.filter((x) => x.path === "/zones" && x.query["page"] === "1")).toHaveLength(3);
  });

  it("mutasjon gjentas ALDRI på 5xx (bivirkningen kan ha skjedd), men gjentas på 429 (avslag før behandling)", async () => {
    const z = freshZone();
    cf.failNext(new RegExp(`POST /zones/${z.id}/dns_records$`), 500, undefined, 1);
    await expect(call("create_dns_record", { zone_id: z.id, type: "A", name: `a.${z.name}`, content: "192.0.2.1" })).rejects.toThrow(/^cloudflare_error_500/);
    expect(cf.requestsMatching("POST", /dns_records$/)).toHaveLength(1);
    cf.requests.length = 0;
    cf.failNext(new RegExp(`POST /zones/${z.id}/dns_records$`), 429, undefined, 1);
    await call("create_dns_record", { zone_id: z.id, type: "A", name: `b.${z.name}`, content: "192.0.2.2" });
    expect(cf.requestsMatching("POST", /dns_records$/)).toHaveLength(2);
  });

  it("ikke-JSON 200-svar og 200 med success:false avvises som ugyldig svar - aldri tolket som suksess", async () => {
    cf.failNext(/GET \/zones$/, 200, "<html>gateway</html>");
    await expect(call("list_zones", {})).rejects.toThrow(/cloudflare_invalid_response:non_json|cloudflare_error_200/);
    cf.failNext(/GET \/zones$/, 200, { success: false, errors: [{ code: 5, message: "nope" }], messages: [], result: null });
    await expect(call("list_zones", {})).rejects.toThrow(/^cloudflare_error_200:5:nope/);
  });
});

describe("D: DNS-skriving", () => {
  it("create A: nøyaktig forespørselskropp, normalisert svar, ekstern id = post-id", async () => {
    const z = freshZone();
    const r = await call("create_dns_record", { zone_id: z.id, type: "A", name: `API.${z.name}`, content: "192.0.2.50", ttl: 300, proxied: true, comment: "jarvis" });
    const rec = data<{ id: string; name: string; proxied: boolean }>(r);
    expect(r.external_id).toBe(rec.id);
    expect(rec).toMatchObject({ name: `api.${z.name}`, proxied: true });
    const post = cf.requestsMatching("POST", /dns_records$/)[0]!;
    expect(post.body).toEqual({ type: "A", name: `api.${z.name}`, content: "192.0.2.50", ttl: 300, proxied: true, comment: "jarvis" });
    expect(cf.dns.get(z.id)!.has(rec.id)).toBe(true);
  });

  it("create er idempotent: identisk post (også TXT som serveren returnerer i anførselstegn) opprettes ikke to ganger", async () => {
    const z = freshZone();
    const params = { zone_id: z.id, type: "TXT", name: `_dmarc.${z.name}`, content: "v=DMARC1; p=none" };
    const first = data<{ id: string; already_existed?: boolean }>(await call("create_dns_record", params));
    const second = await call("create_dns_record", params);
    expect(data<{ id: string; already_existed: boolean }>(second)).toMatchObject({ id: first.id, already_existed: true });
    expect(cf.requestsMatching("POST", /dns_records$/)).toHaveLength(1);
  });

  it("create MX krever prioritet; prioritet kun for MX; proxied kun for A/AAAA/CNAME", async () => {
    const z = freshZone();
    await expect(call("create_dns_record", { zone_id: z.id, type: "MX", name: `m.${z.name}`, content: "mail.example.com" })).rejects.toThrow("cloudflare_invalid_priority");
    await expect(call("create_dns_record", { zone_id: z.id, type: "A", name: `m.${z.name}`, content: "192.0.2.1", priority: 10 })).rejects.toThrow("cloudflare_invalid_priority:kun_for_mx");
    await expect(call("create_dns_record", { zone_id: z.id, type: "TXT", name: `m.${z.name}`, content: "x", proxied: true })).rejects.toThrow(/cloudflare_invalid_proxied/);
    const mx = await call("create_dns_record", { zone_id: z.id, type: "MX", name: `m.${z.name}`, content: "mail.example.com", priority: 10 });
    expect(data<{ priority: number }>(mx).priority).toBe(10);
    expect(cf.requestsMatching("POST", /dns_records$/)).toHaveLength(1);
  });

  it("ugyldig inndata avvises FØR noe skrives: navn utenfor sonen, farlige tegn, feil innhold, ttl utenfor 1/60-86400, lang kommentar", async () => {
    const z = freshZone();
    const bad: Array<[Record<string, JsonValue>, RegExp]> = [
      [{ type: "A", name: "evil.other.org", content: "192.0.2.1" }, /name_outside_zone/],
      [{ type: "A", name: `../x.${z.name}`, content: "192.0.2.1" }, /cloudflare_invalid_name/],
      [{ type: "A", name: `a b.${z.name}`, content: "192.0.2.1" }, /cloudflare_invalid_name/],
      [{ type: "A", name: `a.${z.name}.`, content: "192.0.2.1" }, /cloudflare_invalid_name/],
      [{ type: "A", name: `${"x".repeat(64)}.${z.name}`, content: "192.0.2.1" }, /cloudflare_invalid_name/],
      [{ type: "A", name: `a.*.${z.name}`, content: "192.0.2.1" }, /cloudflare_invalid_name/],
      [{ type: "A", name: `a.${z.name}`, content: "999.1.1.1" }, /cloudflare_invalid_content:ipv4/],
      [{ type: "AAAA", name: `a.${z.name}`, content: "192.0.2.1" }, /cloudflare_invalid_content:ipv6/],
      [{ type: "CNAME", name: `a.${z.name}`, content: "bad host!" }, /cloudflare_invalid_content:hostname/],
      [{ type: "TXT", name: `a.${z.name}`, content: "linje1\nlinje2" }, /cloudflare_invalid_content/],
      [{ type: "SRV", name: `a.${z.name}`, content: "x" }, /cloudflare_invalid_type/],
      [{ type: "A", name: `a.${z.name}`, content: "192.0.2.1", ttl: 59 }, /cloudflare_invalid_ttl/],
      [{ type: "A", name: `a.${z.name}`, content: "192.0.2.1", ttl: 86_401 }, /cloudflare_invalid_ttl/],
      [{ type: "A", name: `a.${z.name}`, content: "192.0.2.1", comment: "x".repeat(101) }, /cloudflare_invalid_comment/]
    ];
    for (const [extra, expected] of bad) {
      await expect(call("create_dns_record", { zone_id: z.id, ...extra }), JSON.stringify(extra)).rejects.toThrow(expected);
    }
    expect(cf.writeRequests()).toHaveLength(0);
    // grenseverdier og jokertegn er lovlige
    for (const ttl of [1, 60, 86_400]) {
      await call("create_dns_record", { zone_id: z.id, type: "A", name: `ttl${ttl}.${z.name}`, content: "192.0.2.1", ttl });
    }
    await call("create_dns_record", { zone_id: z.id, type: "A", name: `*.${z.name}`, content: "192.0.2.1" });
    expect(cf.writeRequests()).toHaveLength(4);
  });

  it("update: kun oppgitte felt sendes (PATCH), uendret verdi gir ingen skriving, type/navn kan ikke endres, ukjent post gir 404", async () => {
    const z = freshZone();
    const id = cf.seedDns(z.id, { type: "A", name: `u.${z.name}`, content: "192.0.2.1", ttl: 300 });
    const r = await call("update_dns_record", { zone_id: z.id, record_id: id, content: "192.0.2.99" });
    expect(data<{ content: string; ttl: number }>(r)).toMatchObject({ content: "192.0.2.99", ttl: 300 });
    expect(cf.requestsMatching("PATCH", /dns_records\/[0-9a-f]{32}$/)[0]!.body).toEqual({ content: "192.0.2.99" });
    cf.requests.length = 0;
    const same = await call("update_dns_record", { zone_id: z.id, record_id: id, content: "192.0.2.99", ttl: 300 });
    expect(data<{ unchanged: boolean }>(same).unchanged).toBe(true);
    expect(cf.writeRequests()).toHaveLength(0);
    await expect(call("update_dns_record", { zone_id: z.id, record_id: id, type: "TXT" })).rejects.toThrow("cloudflare_invalid_type:kan_ikke_endres");
    await expect(call("update_dns_record", { zone_id: z.id, record_id: id, name: `x.${z.name}` })).rejects.toThrow("cloudflare_invalid_name:kan_ikke_endres");
    await expect(call("update_dns_record", { zone_id: z.id, record_id: id })).rejects.toThrow("cloudflare_invalid_update:ingen_felt");
    await expect(call("update_dns_record", { zone_id: z.id, record_id: id, content: "ikke-en-ip" })).rejects.toThrow(/cloudflare_invalid_content:ipv4/);
    await expect(call("update_dns_record", { zone_id: z.id, record_id: hex32(), content: "192.0.2.1" })).rejects.toThrow(/^cloudflare_error_404/);
    expect(cf.writeRequests()).toHaveLength(0);
  });

  it("delete fjerner posten; ukjent post gir 404 og ingenting annet røres", async () => {
    const z = freshZone();
    const id = cf.seedDns(z.id, { type: "A", name: `d.${z.name}`, content: "192.0.2.1" });
    const keep = cf.seedDns(z.id, { type: "A", name: `keep.${z.name}`, content: "192.0.2.2" });
    const r = await call("delete_dns_record", { zone_id: z.id, record_id: id });
    expect(r.external_id).toBe(id);
    expect(cf.dns.get(z.id)!.has(id)).toBe(false);
    expect(cf.dns.get(z.id)!.has(keep)).toBe(true);
    await expect(call("delete_dns_record", { zone_id: z.id, record_id: hex32() })).rejects.toThrow(/^cloudflare_error_404/);
  });

  it("skriving uten konfigurert konto, eller mot en sone fra en annen konto, feiler lukket uten noen skriveforespørsel", async () => {
    const z = freshZone();
    const params = { zone_id: z.id, type: "A", name: `n.${z.name}`, content: "192.0.2.1" };
    await expect(call("create_dns_record", params, cf.token, transport({ accountId: undefined }))).rejects.toThrow("cloudflare_account_not_configured");
    const foreign = cf.addZone("foreign.example.org", hex32());
    await expect(call("create_dns_record", { ...params, zone_id: foreign, name: "n.foreign.example.org" })).rejects.toThrow("cloudflare_zone_not_in_account");
    await expect(call("delete_dns_record", { zone_id: foreign, record_id: hex32() })).rejects.toThrow("cloudflare_zone_not_in_account");
    expect(cf.writeRequests()).toHaveLength(0);
  });

  it("id-er interpoleres aldri i stien uten streng 32-hex-validering (sti-injeksjon, store bokstaver, feil lengde) - ingen forespørsel sendes", async () => {
    const z = freshZone();
    const evil = ["../../accounts", "%2e%2e/x", z.id.toUpperCase(), z.id.slice(1), `${z.id}/dns_records`, "", "0".repeat(33)];
    for (const bad of evil) {
      await expect(call("get_zone", { zone_id: bad }), bad).rejects.toThrow("cloudflare_invalid_zone_id");
      await expect(call("get_dns_record", { zone_id: z.id, record_id: bad }), bad).rejects.toThrow("cloudflare_invalid_record_id");
      await expect(call("delete_dns_record", { zone_id: z.id, record_id: bad }), bad).rejects.toThrow("cloudflare_invalid_record_id");
    }
    await expect(call("get_zone", { zone_id: 123 as unknown as JsonValue })).rejects.toThrow("cloudflare_invalid_zone_id");
    expect(cf.requests.filter((r) => r.method !== "GET" || r.path.includes(".."))).toHaveLength(0);
  });
});

describe("E: WAF custom rules og rate limiting (Rulesets API)", () => {
  const phase = "http_request_firewall_custom";

  it("første regel oppretter entrypoint-rulesettet med regelen i rules[]; neste regel legges til i det eksisterende; identisk regel er idempotent", async () => {
    const z = freshZone();
    const first = await call("create_waf_rule", { zone_id: z.id, phase, action: "block", expression: "ip.src eq 203.0.113.9", description: "blokker ond IP" });
    const firstData = data<{ ruleset_id: string; rule: { id: string; action: string } }>(first);
    expect(first.external_id).toBe(firstData.rule.id);
    const createReq = cf.requestsMatching("POST", /\/rulesets$/)[0]!;
    expect(createReq.body).toMatchObject({ name: "default", kind: "zone", phase, rules: [{ action: "block", expression: "ip.src eq 203.0.113.9", description: "blokker ond IP", enabled: true }] });
    cf.requests.length = 0;
    const second = await call("create_waf_rule", { zone_id: z.id, phase, action: "managed_challenge", expression: 'http.request.uri.path contains "/admin"' });
    expect(data<{ ruleset_id: string }>(second).ruleset_id).toBe(firstData.ruleset_id);
    expect(cf.requestsMatching("POST", new RegExp(`/rulesets/${firstData.ruleset_id}/rules$`))).toHaveLength(1);
    cf.requests.length = 0;
    const dup = await call("create_waf_rule", { zone_id: z.id, phase, action: "block", expression: "ip.src eq 203.0.113.9", description: "blokker ond IP" });
    expect(data<{ already_existed: boolean }>(dup).already_existed).toBe(true);
    expect(cf.writeRequests()).toHaveLength(0);
  });

  it("rate limiting-regel krever ratelimit-objekt (kun for http_ratelimit) med lukket feltsett", async () => {
    const z = freshZone();
    const base = { zone_id: z.id, phase: "http_ratelimit", action: "block", expression: 'http.request.uri.path eq "/login"' };
    await expect(call("create_waf_rule", base)).rejects.toThrow("cloudflare_invalid_ratelimit:paakrevd_for_http_ratelimit");
    await expect(call("create_waf_rule", { ...base, ratelimit: { characteristics: ["ip.src"], period: 60, requests_per_period: 5, evil: 1 } })).rejects.toThrow("cloudflare_invalid_ratelimit_field:evil");
    await expect(call("create_waf_rule", { ...base, ratelimit: { characteristics: [], period: 60, requests_per_period: 5 } })).rejects.toThrow("cloudflare_invalid_ratelimit_characteristics");
    await expect(call("create_waf_rule", { ...base, phase, ratelimit: { characteristics: ["ip.src"], period: 60, requests_per_period: 5 } })).rejects.toThrow("cloudflare_invalid_ratelimit:kun_for_http_ratelimit");
    expect(cf.writeRequests()).toHaveLength(0);
    const ok = await call("create_waf_rule", { ...base, ratelimit: { characteristics: ["cf.colo.id", "ip.src"], period: 60, requests_per_period: 100, mitigation_timeout: 600 } });
    expect(data<{ rule: { ratelimit: { period: number } } }>(ok).rule.ratelimit.period).toBe(60);
  });

  it("deterministisk vakt: blokkerende regel som treffer ALL trafikk avvises (log er tillatt); ugyldig handling/fase/lengde avvises", async () => {
    const z = freshZone();
    for (const expression of ["true", "(true)", " ( ( true ) ) "]) {
      await expect(call("create_waf_rule", { zone_id: z.id, phase, action: "block", expression }), expression).rejects.toThrow("cloudflare_invalid_expression:treffer_all_trafikk");
    }
    await expect(call("create_waf_rule", { zone_id: z.id, phase, action: "skip", expression: "ip.src eq 1.1.1.1" })).rejects.toThrow("cloudflare_invalid_action");
    await expect(call("create_waf_rule", { zone_id: z.id, phase: "http_request_firewall_managed", action: "block", expression: "ip.src eq 1.1.1.1" })).rejects.toThrow("cloudflare_invalid_phase");
    await expect(call("create_waf_rule", { zone_id: z.id, phase, action: "block", expression: "x".repeat(4097) })).rejects.toThrow("cloudflare_invalid_expression");
    await expect(call("create_waf_rule", { zone_id: z.id, phase, action: "block", expression: "" })).rejects.toThrow("cloudflare_invalid_expression");
    expect(cf.writeRequests()).toHaveLength(0);
    await call("create_waf_rule", { zone_id: z.id, phase, action: "log", expression: "true", description: "logg alt" });
    expect(cf.writeRequests()).toHaveLength(1);
  });

  it("update sender HELE regelen (verste tilfelle: serveren erstatter) og bevarer ukjente felt som action_parameters; uendret gir ingen skriving", async () => {
    const z = freshZone();
    const seeded = cf.seedRule(z.id, phase, { action: "block", expression: "ip.src eq 203.0.113.9", description: "orig", action_parameters: { response: { status_code: 451 } } });
    const r = await call("update_waf_rule", { zone_id: z.id, phase, rule_id: seeded.ruleId, description: "ny beskrivelse", enabled: false });
    const rule = data<{ rule: { description: string; enabled: boolean; action: string; extra: Record<string, unknown> } }>(r).rule;
    expect(rule).toMatchObject({ description: "ny beskrivelse", enabled: false, action: "block", extra: { action_parameters: { response: { status_code: 451 } } } });
    const patch = cf.requestsMatching("PATCH", /\/rules\/[0-9a-f]{32}$/)[0]!;
    expect(patch.body).toMatchObject({ action: "block", expression: "ip.src eq 203.0.113.9", description: "ny beskrivelse", enabled: false, action_parameters: { response: { status_code: 451 } } });
    expect(Object.keys(patch.body as object)).not.toEqual(expect.arrayContaining(["id", "version", "last_updated"]));
    cf.requests.length = 0;
    const same = await call("update_waf_rule", { zone_id: z.id, phase, rule_id: seeded.ruleId, description: "ny beskrivelse" });
    expect(data<{ unchanged: boolean }>(same).unchanged).toBe(true);
    expect(cf.writeRequests()).toHaveLength(0);
    await expect(call("update_waf_rule", { zone_id: z.id, phase, rule_id: hex32(), description: "x" })).rejects.toThrow(/^cloudflare_error_404/);
    await expect(call("update_waf_rule", { zone_id: z.id, phase, rule_id: seeded.ruleId, expression: "true", action: "block" })).rejects.toThrow("cloudflare_invalid_expression:treffer_all_trafikk");
    await expect(call("update_waf_rule", { zone_id: z.id, phase, rule_id: seeded.ruleId, expression: "true" })).rejects.toThrow("cloudflare_invalid_expression:treffer_all_trafikk");
  });

  it("delete fjerner kun den ene regelen; regel i en annen fase eller ukjent id gir 404", async () => {
    const z = freshZone();
    const a = cf.seedRule(z.id, phase, { action: "block", expression: "ip.src eq 203.0.113.1" });
    const b = cf.seedRule(z.id, phase, { action: "block", expression: "ip.src eq 203.0.113.2" });
    await call("delete_waf_rule", { zone_id: z.id, phase, rule_id: a.ruleId });
    const remaining = cf.rulesets.get(z.id)!.get(phase)!.rules.map((r) => r.id);
    expect(remaining).toEqual([b.ruleId]);
    await expect(call("delete_waf_rule", { zone_id: z.id, phase: "http_ratelimit", rule_id: b.ruleId })).rejects.toThrow(/^cloudflare_error_404/);
    await expect(call("delete_waf_rule", { zone_id: z.id, phase, rule_id: hex32() })).rejects.toThrow(/^cloudflare_error_404/);
    expect(cf.writeRequests().filter((r) => r.method === "DELETE")).toHaveLength(1);
  });
});

describe("F: sone-innstillinger og cache-purge", () => {
  it("update_zone_setting sender kun {value}; ukjent innstilling/verdi avvises FØR noe kall", async () => {
    const z = freshZone();
    const r = await call("update_zone_setting", { zone_id: z.id, setting_id: "ssl", value: "strict" });
    expect(data<{ value: string }>(r).value).toBe("strict");
    expect(cf.requestsMatching("PATCH", /settings\/ssl$/)[0]!.body).toEqual({ value: "strict" });
    cf.requests.length = 0;
    for (const [setting_id, value, expected] of [["ssl", "ultra", "setting_value"], ["automatic_https_rewrites", "on", "setting_id"], ["__proto__", "on", "setting_id"], ["ssl", 1, "setting_value"]] as const) {
      await expect(call("update_zone_setting", { zone_id: z.id, setting_id, value: value as JsonValue }), `${setting_id}=${value}`).rejects.toThrow(new RegExp(`cloudflare_invalid_${expected}`));
    }
    expect(cf.writeRequests()).toHaveLength(0);
  });

  it("purge: nøyaktig én velger per kall; innhold utenfor sonen, for mange elementer og kombinasjoner avvises", async () => {
    const z = freshZone("cache.example.com");
    await call("purge_cache", { zone_id: z.id, mode: "everything" });
    await call("purge_cache", { zone_id: z.id, mode: "files", items: ["https://cache.example.com/a.css", "https://www.cache.example.com/b.js"] });
    await call("purge_cache", { zone_id: z.id, mode: "hosts", items: ["www.cache.example.com"] });
    await call("purge_cache", { zone_id: z.id, mode: "prefixes", items: ["cache.example.com/static/"] });
    await call("purge_cache", { zone_id: z.id, mode: "tags", items: ["product-123", "layout:v2"] });
    expect(cf.purges.map((p) => p.body)).toEqual([
      { purge_everything: true },
      { files: ["https://cache.example.com/a.css", "https://www.cache.example.com/b.js"] },
      { hosts: ["www.cache.example.com"] },
      { prefixes: ["cache.example.com/static/"] },
      { tags: ["product-123", "layout:v2"] }
    ]);
    cf.requests.length = 0;
    const bad: Array<[Record<string, JsonValue>, RegExp]> = [
      [{ mode: "files", items: ["https://evil.example.org/a"] }, /purge_item/],
      [{ mode: "files", items: ["https://user:pw@cache.example.com/a"] }, /purge_item/],
      [{ mode: "files", items: ["ftp://cache.example.com/a"] }, /purge_item/],
      [{ mode: "hosts", items: ["evil.org"] }, /purge_item/],
      [{ mode: "prefixes", items: ["https://cache.example.com/x"] }, /purge_item/],
      [{ mode: "prefixes", items: ["cache.example.com/x?y=1"] }, /purge_item/],
      [{ mode: "everything", items: ["https://cache.example.com/a"] }, /purge_items/],
      [{ mode: "files", items: [] }, /purge_items/],
      [{ mode: "files", items: Array.from({ length: 31 }, (_, i) => `https://cache.example.com/${i}`) }, /purge_items/],
      [{ mode: "tags", items: ["bad tag with spaces"] }, /purge_item/],
      [{ mode: "nuke" }, /purge_mode/]
    ];
    for (const [extra, expected] of bad) await expect(call("purge_cache", { zone_id: z.id, ...extra }), JSON.stringify(extra).slice(0, 80)).rejects.toThrow(expected);
    expect(cf.writeRequests()).toHaveLength(0);
  });
});
