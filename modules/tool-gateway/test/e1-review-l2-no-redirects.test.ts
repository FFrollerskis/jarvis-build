import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { CloudflareTransport, InfisicalTransport, LangfuseTransport, guardedFetch } from "../src/index.ts";
import { FakeCloudflare } from "./support/fake-cloudflare.ts";

/**
 * Gjennomgang av PR #324 (L2): «ingen redirects» var PÅSTÅTT men ikke håndhevet. `guardedFetch` fulgte redirects (ingen `redirect`-modus), også for POST/PATCH/DELETE mot Cloudflare: en 307 til en annen sti på samme
 * opprinnelse ble fulgt med `Authorization` og kropp beholdt.
 *
 * Nå: en MUTASJON (alt unntatt GET/HEAD) følger aldri en redirect som standard (`unsafe_vendor_url:unexpected_redirect_http_<status>`), GET/HEAD beholder plattformens standard for andre kallere (ingen
 * regresjon), og skymål-transportene (Cloudflare, Langfuse, Infisical) velger `"reject"` eksplisitt for ALLE metoder. Her mot ekte lokale servere som redirecter: redirect-målet får ALDRI en forespørsel.
 */
interface Seen { method: string; path: string; authorization: string | undefined }
let server: Server;
let base = "";
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ method: req.method ?? "GET", path: url.pathname, authorization: req.headers["authorization"] as string | undefined });
    req.resume();
    if (url.pathname === "/not-modified") {
      res.writeHead(304);
      return void res.end();
    }
    const redirect = /^\/redir(\d{3})$/.exec(url.pathname);
    if (redirect) {
      res.writeHead(Number(redirect[1]), { location: "/target" });
      return void res.end();
    }
    // Langfuse / Infisical: helse- og innloggingsendepunktene redirecter til /elsewhere
    if (url.pathname === "/api/public/health" || url.pathname === "/api/status" || url.pathname === "/api/v1/auth/universal-auth/login") {
      res.writeHead(302, { location: "/elsewhere" });
      return void res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: url.pathname }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

const hits = (path: string): number => seen.filter((s) => s.path === path).length;

describe("A: guardedFetch - mutasjoner følger aldri en redirect (standard), og redirect-målet får aldri en forespørsel", () => {
  it("POST/PUT/PATCH/DELETE × 301/302/303/307/308: kaster `unsafe_vendor_url:unexpected_redirect_http_<status>`; /target får 0 forespørsler (Authorization følger aldri med)", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const status of [301, 302, 303, 307, 308]) {
        const body = method === "DELETE" ? {} : { body: "{}" };
        await expect(guardedFetch(`${base}/redir${status}`, { method, headers: { authorization: "Bearer topp-hemmelig" }, ...body }), `${method} ${status}`).rejects.toThrow(`unsafe_vendor_url:unexpected_redirect_http_${status}`);
      }
    }
    expect(hits("/target")).toBe(0);
    expect(seen.filter((s) => s.path !== "/target").every((s) => s.authorization === "Bearer topp-hemmelig")).toBe(true);
    expect(seen).toHaveLength(20); // hver mutasjon ble sendt nøyaktig ÉN gang (ingen retry, ingen oppfølging)
  });

  it("feilen er en `UnsafeVendorUrlError` med stabil årsak (ikke en generisk TypeError som ligner et nettverksavbrudd)", async () => {
    const err = await guardedFetch(`${base}/redir307`, { method: "POST", body: "{}" }).then(() => null, (e: Error) => e);
    expect(err?.name).toBe("UnsafeVendorUrlError");
    expect((err as unknown as { reason: string }).reason).toBe("unexpected_redirect_http_307");
  });

  it("GET/HEAD uten angitt modus følger som før (ingen regresjon for lesende kallere)", async () => {
    const res = await guardedFetch(`${base}/redir302`);
    expect(res.status).toBe(200);
    expect(hits("/target")).toBe(1);
    seen.length = 0;
    const head = await guardedFetch(`${base}/redir302`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(hits("/target")).toBe(1);
  });

  it("kalleren kan velge selv: `reject` på GET kaster, `manual` på POST gir 3xx-svaret rett ut, `follow` på POST følger (bevisst opt-in), `error` kaster fetch sin egen feil", async () => {
    await expect(guardedFetch(`${base}/redir302`, { redirect: "reject" })).rejects.toThrow("unsafe_vendor_url:unexpected_redirect_http_302");
    expect(hits("/target")).toBe(0);
    const manual = await guardedFetch(`${base}/redir307`, { method: "POST", body: "{}", redirect: "manual" });
    expect(manual.status).toBe(307);
    expect(hits("/target")).toBe(0);
    const follow = await guardedFetch(`${base}/redir307`, { method: "POST", body: "{}", redirect: "follow" });
    expect(follow.status).toBe(200);
    expect(hits("/target")).toBe(1);
    await expect(guardedFetch(`${base}/redir302`, { redirect: "error" })).rejects.toThrow();
  });

  it("vanlige svar og 304 (ikke en redirect) passerer for mutasjoner; URL-vakten er uendret", async () => {
    expect((await guardedFetch(`${base}/ok`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await guardedFetch(`${base}/not-modified`, { method: "POST", body: "{}" })).status).toBe(304);
    await expect(guardedFetch(`${base}/a/../b`, { method: "POST" })).rejects.toThrow("unsafe_vendor_url:dot_segment");
  });
});

describe("B: skymål-transportene håndhever «ingen redirects» for ALLE metoder", () => {
  it("Cloudflare: en 307 på PATCH og en 302 på GET kaster; redirect-målet (en annen sti på samme opprinnelse) får aldri en forespørsel", async () => {
    const cf = new FakeCloudflare();
    await cf.start();
    try {
      const zone = cf.addZone("example.org");
      const transport = new CloudflareTransport({ baseUrl: cf.baseUrl, accountId: async () => cf.accountId, sleep: async () => undefined });
      cf.redirectNext(new RegExp(`PATCH /zones/${zone}/settings/ssl$`), 307, `/client/v4/zones/${zone}/settings/min_tls_version`);
      cf.requests.length = 0;
      await expect(transport.invoke("update_zone_setting", { zone_id: zone, setting_id: "ssl", value: "strict" } as Record<string, JsonValue>, cf.token)).rejects.toThrow("unsafe_vendor_url:unexpected_redirect_http_307");
      expect(cf.requests.filter((r) => r.path.endsWith("/settings/min_tls_version"))).toEqual([]);
      expect(cf.requestsMatching("PATCH", /settings\/ssl$/)).toHaveLength(1); // sendt nøyaktig én gang
      expect(cf.settings.get(zone)!.get("ssl")).toBe("full");
      cf.redirectNext(/GET \/zones$/, 302, "/client/v4/user/tokens/verify");
      await expect(transport.invoke("list_zones", {}, cf.token)).rejects.toThrow("unsafe_vendor_url:unexpected_redirect_http_302");
      expect(cf.requests.filter((r) => r.path === "/user/tokens/verify")).toEqual([]);
    } finally {
      await cf.stop();
    }
  });

  it("Langfuse (GET helse) og Infisical (POST innlogging): 3xx er en feil, ikke «frisk» eller «utilgjengelig», og målet får ingen forespørsel", async () => {
    const lf = new LangfuseTransport({ baseUrl: async () => base, publicKey: async () => "pk-lf-test", sleep: async () => undefined });
    await expect(lf.invoke("get_health", {}, "sk-lf-test")).rejects.toThrow("unsafe_vendor_url:unexpected_redirect_http_302");
    const inf = new InfisicalTransport({ baseUrl: async () => base, clientId: async () => "client-x", projectId: async () => "proj-1", environment: async () => "dev", sleep: async () => undefined });
    await expect(inf.invoke("list_secret_metadata", {}, "client-secret-xyz")).rejects.toThrow("unsafe_vendor_url:unexpected_redirect_http_302");
    await expect(inf.invoke("get_health", {}, "client-secret-xyz")).rejects.toThrow("unsafe_vendor_url:unexpected_redirect_http_302");
    expect(hits("/elsewhere")).toBe(0);
  });
});
