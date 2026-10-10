import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductUsageService, USAGE_LIMITS, USAGE_WEBHOOK_SIGNATURE_HEADER, signUsageWebhook } from "@jarvis/business";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-D2 (UA-3 «churn/product usage»): `POST /webhooks/product-usage` mot ekte Postgres som app-rolle. Signatur ER autentisering (ingen identitet), replay-vern,
 * størrelsesgrense FØR signatur, ingen ekko av hendelsesinnhold, dormant (404) uten konfigurasjon og fail-closed (503) ved halv konfigurasjon.
 */
const BIZ = "tenant-wpd2-wh";
const BIZ_B = "tenant-wpd2-wh-b";
const PERSON = "tenant-wpd2-wh-person";
const SECRET = "k".repeat(48);
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
const closers: Array<() => Promise<void>> = [];
const urls: Record<string, string> = {};

async function listen(deps: ApiDeps): Promise<string> {
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const deps = (service: ProductUsageService | undefined, extra: Partial<ApiDeps> = {}): ApiDeps => ({ ...(service ? { productUsage: { service } } : {}), ...extra }) as unknown as ApiDeps;
const svc = (secret: string | null, tenant: string | null) => new ProductUsageService(app, { webhookSecretProvider: async () => secret, tenantResolver: () => tenant });

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-webhook-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd2_wh LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_wh");
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${BIZ}', 'Wh', 'business'), ('${BIZ_B}', 'Wh B', 'business'), ('${PERSON}', 'Person', 'person')`);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_wh", password: "pw2" });
  urls["on"] = await listen(deps(svc(SECRET, BIZ)));
  urls["off"] = await listen(deps(undefined));
  urls["nosecret"] = await listen(deps(svc(null, BIZ)));
  urls["shortsecret"] = await listen(deps(svc("k".repeat(31), BIZ)));
  urls["notenant"] = await listen(deps(svc(SECRET, null)));
  urls["person"] = await listen(deps(svc(SECRET, PERSON)));
  urls["limited"] = await listen(deps(svc(SECRET, BIZ), { rateLimits: { authPerIpPerMinute: 5 } }));
}, 240_000);

afterAll(async () => {
  for (const c of closers) await c();
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const ago = (days: number) => new Date(Date.now() - days * 86_400_000 - 60_000).toISOString();
const evt = (id: string, account: string, over: Record<string, unknown> = {}) => ({ event_id: id, account_ref: account, feature: "chat.send", quantity: 1, occurred_at: ago(1), ...over });
const nowSec = () => Math.floor(Date.now() / 1000);
const post = (base: string, body: string | Buffer, headers: Record<string, string> = {}) =>
  fetch(`${base}/webhooks/product-usage`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
const signedPost = (base: string, payload: unknown, opts: { secret?: string; ts?: number } = {}) => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return post(base, body, { [USAGE_WEBHOOK_SIGNATURE_HEADER]: signUsageWebhook(body, opts.secret ?? SECRET, opts.ts ?? nowSec()) });
};
const count = async (sql: string, params: unknown[] = []) => ((await admin.query(sql, params)).rows[0] as { n: number }).n;
const body = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("dormant og kildevakter", () => {
  it("uten productUsage i deps er ruten 404 - selv med en gyldig signatur - og GET finnes ikke", async () => {
    const res = await signedPost(urls["off"] as string, { events: [evt("wh-dorm-00001", "acct-dorm-0001")] });
    expect(res.status).toBe(404);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id = 'wh-dorm-00001'")).toBe(0);
    expect((await fetch(`${urls["on"]}/webhooks/product-usage`)).status).toBe(404);
  });

  it("main.ts åpner ruten KUN når JARVIS_PRODUCT_USAGE_TENANT_ID er satt, leser hemmeligheten via den delte kjeden ved hvert kall, og ruten er aldri et verktøy", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
    expect(main).toMatch(/process\.env\["JARVIS_PRODUCT_USAGE_TENANT_ID"\]\s*\?\s*\{\s*productUsage:/);
    expect(main).toContain('readSecretProvider.get("JARVIS_PRODUCT_USAGE_WEBHOOK_SECRET")');
    expect(main).toContain('tenantResolver: () => process.env["JARVIS_PRODUCT_USAGE_TENANT_ID"] ?? null');
    const server = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
    expect(server).toMatch(/"\/webhooks\/product-usage"\s*\n\]\)/); // med i AUTH_ROUTES (streng per-IP-grense)
    for (const f of ["../../../modules/tool-gateway/src/chat-act-tier.ts", "../../../modules/tool-gateway/src/chat-read-tier.ts"]) {
      expect(readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8")).not.toMatch(/ingest_product_usage|product_usage_webhook|ingestWebhook/);
    }
  });
});

describe("gyldig signert levering", () => {
  it("lagrer i den KONFIGURERTE tenanten og svarer med tellere uten å ekko innhold; replay gir duplikater, aldri dobbelttelling", async () => {
    const payload = { events: [evt("wh-ok-000001", "acct-wh-ok-001", { quantity: 3 }), evt("wh-ok-000002", "acct-wh-ok-001", { feature: "export" })] };
    const text = JSON.stringify(payload);
    const sig = signUsageWebhook(text, SECRET, nowSec());
    const res = await post(urls["on"] as string, text, { [USAGE_WEBHOOK_SIGNATURE_HEADER]: sig });
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b).toMatchObject({ received: true, events: { received: 2, inserted: 2, duplicates: 0, conflicts: 0, rejected: 0 }, rejected_detail: [] });
    expect(typeof b["request_id"]).toBe("string");
    expect(JSON.stringify(b)).not.toMatch(/acct-wh-ok-001|chat\.send|export/);
    expect((await admin.query("SELECT DISTINCT tenant_id, source_id FROM product_usage_events WHERE external_event_id LIKE 'wh-ok-%'")).rows).toEqual([{ tenant_id: BIZ, source_id: "webhook" }]);
    // identisk replay innen vinduet: samme signatur, samme kropp
    const again = await body(await post(urls["on"] as string, text, { [USAGE_WEBHOOK_SIGNATURE_HEADER]: sig }));
    expect(again["events"]).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id LIKE 'wh-ok-%'")).toBe(2);
    // samme id, endret innhold -> konflikt (ikke anvendt)
    const changed = await body(await signedPost(urls["on"] as string, { events: [evt("wh-ok-000001", "acct-wh-ok-001", { quantity: 9 })] }));
    expect(changed["events"]).toMatchObject({ inserted: 0, duplicates: 0, conflicts: 1 });
    expect((await admin.query("SELECT quantity FROM product_usage_events WHERE external_event_id = 'wh-ok-000001'")).rows[0]).toEqual({ quantity: 3 });
  });

  it("delvis avvisning: gyldige lagres, ugyldige rapporteres med posisjon + kode (aldri verdien); PII og tenant-styring kommer ikke inn", async () => {
    const payload = {
      events: [
        evt("wh-part-00001", "acct-wh-part-01"),
        evt("wh-part-00002", "ola.nordmann@example.com"),
        { ...evt("wh-part-00003", "acct-wh-part-01"), email: "ola@example.com" },
        { ...evt("wh-part-00004", "acct-wh-part-01"), tenant_id: BIZ_B },
        evt("wh-part-00005", "acct-wh-part-01", { occurred_at: "2000-01-01T00:00:00Z" })
      ]
    };
    const res = await signedPost(urls["on"] as string, payload);
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b["events"]).toMatchObject({ received: 1, inserted: 1, rejected: 4 });
    expect(b["rejected_detail"]).toEqual([
      { position: 2, reason: "account_ref_invalid_or_not_pseudonymous" }, { position: 3, reason: "unknown_field:email" },
      { position: 4, reason: "unknown_field:tenant_id" }, { position: 5, reason: "occurred_at_out_of_range" }
    ]);
    expect(JSON.stringify(b)).not.toMatch(/ola|nordmann|example\.com/);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1", [BIZ_B])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id IN ('wh-part-00002','wh-part-00003','wh-part-00004','wh-part-00005')")).toBe(0);
  });

  it("ugyldig HEL kropp (signert) gir 400 med kode, og skriver ingenting", async () => {
    const cases: Array<[string, string]> = [["{broken", "payload_not_json"], ["[]", "payload_not_an_object"], [JSON.stringify({ events: [] }), "payload_event_count_invalid"], [JSON.stringify({ events: "x" }), "payload_events_invalid"]];
    for (const [raw, code] of cases) {
      const res = await signedPost(urls["on"] as string, raw);
      expect(res.status, raw).toBe(400);
      expect(await body(res)).toMatchObject({ error: code });
    }
  });
});

describe("autentisering: signatur ER autentisering - alt annet avvises UTEN å skrive og UTEN å røpe hvorfor", () => {
  it("manglende, feil, utløpt eller framtidig signatur og endret kropp gir 401 med identisk, nøytral feilkropp", async () => {
    const payload = { events: [evt("wh-auth-00001", "acct-wh-auth-01")] };
    const text = JSON.stringify(payload);
    const goodHeader = signUsageWebhook(text, SECRET, nowSec());
    const attempts: Array<[string, Promise<Response>]> = [
      ["ingen header", post(urls["on"] as string, text)],
      ["feil hemmelighet", signedPost(urls["on"] as string, payload, { secret: "x".repeat(48) })],
      ["utløpt (400 s)", signedPost(urls["on"] as string, payload, { ts: nowSec() - 400 })],
      ["framtidig (400 s)", signedPost(urls["on"] as string, payload, { ts: nowSec() + 400 })],
      ["endret kropp", post(urls["on"] as string, text + " ", { [USAGE_WEBHOOK_SIGNATURE_HEADER]: goodHeader })],
      ["ødelagt header", post(urls["on"] as string, text, { [USAGE_WEBHOOK_SIGNATURE_HEADER]: "garbage" })],
      ["v1 uten t", post(urls["on"] as string, text, { [USAGE_WEBHOOK_SIGNATURE_HEADER]: `v1=${"0".repeat(64)}` })],
      ["annen header enn den riktige", post(urls["on"] as string, text, { "stripe-signature": goodHeader, "x-signature": goodHeader })]
    ];
    for (const [label, p] of attempts) {
      const res = await p;
      expect(res.status, label).toBe(401);
      const b = await body(res);
      expect(Object.keys(b).sort(), label).toEqual(["error", "request_id"]);
      expect(b["error"], label).toBe("invalid_signature");
    }
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id = 'wh-auth-00001'")).toBe(0);
  });

  it("størrelsesgrensen gjelder FØR signaturen: for stor kropp gir 413 selv uten/med feil signatur", async () => {
    const big = Buffer.alloc(USAGE_LIMITS.webhook_max_bytes + 1, 0x61);
    expect((await post(urls["on"] as string, big)).status).toBe(413);
    expect((await post(urls["on"] as string, big, { [USAGE_WEBHOOK_SIGNATURE_HEADER]: signUsageWebhook(big, SECRET, nowSec()) })).status).toBe(413);
    // akkurat på grensen er ikke et størrelsesproblem (men en ugyldig kropp)
    const edge = Buffer.alloc(USAGE_LIMITS.webhook_max_bytes, 0x20);
    const res = await post(urls["on"] as string, edge, { [USAGE_WEBHOOK_SIGNATURE_HEADER]: signUsageWebhook(edge, SECRET, nowSec()) });
    expect(res.status).toBe(400);
  });

  it("strengere per-IP-grense (AUTH_ROUTES): etter fem kall innen minuttet gir det sjette 429 - også for ugyldige", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await post(urls["limited"] as string, "{}", { [USAGE_WEBHOOK_SIGNATURE_HEADER]: "garbage" })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe("fail closed ved halv konfigurasjon", () => {
  it("ingen/for kort hemmelighet, ingen tenant eller en tenant som ikke er en bedrifts-tenant gir 503 not_configured (aldri 200, aldri skriving)", async () => {
    for (const name of ["nosecret", "shortsecret", "notenant", "person"]) {
      const res = await signedPost(urls[name] as string, { events: [evt("wh-cfg-000001", "acct-wh-cfg-01")] });
      expect(res.status, name).toBe(503);
      const b = await body(res);
      expect(Object.keys(b).sort(), name).toEqual(["error", "request_id"]);
      expect(b["error"], name).toBe("not_configured");
    }
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id = 'wh-cfg-000001'")).toBe(0);
  });
});
