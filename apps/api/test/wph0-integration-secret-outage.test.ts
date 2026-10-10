import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport, type ControlSection } from "@jarvis/executive";
import type { PolicyGateway } from "@jarvis/policy";
import { CONNECTOR_REGISTRY, FallbackSecretProvider, InfisicalSecretProvider, ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { createIntegrationCenter } from "../src/control-center/integration.ts";
import { PRESENCE_CONCURRENCY, PRESENCE_OUTAGE_BACKOFF_MS, PRESENCE_TTL_MS } from "../src/control-center/presence.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { ScriptedPool } from "./support/scripted-pool.ts";

/**
 * WP-H0, gjennomgang av PR #316 (M-1 + L-3): Integration Center over den EKTE kjeden (ToolGateway → Infisical → fallback) mot en lokal HTTP-server som etterligner Infisical.
 *
 * Funnet (M-1): med Infisical nede ga `hasSecret` «false» for alle ~87 credential-refs, og alle 50 bygde tilkoblinger fikk status OK («ikke konfigurert»). Her bevises det motsatte, på den ekte kjeden (ikke en mock som kaster):
 * nede ⇒ hver bygd tilkobling er UKJENT, og kilden spørres IKKE 87 ganger (L-3: ÉN innlogging, maks 8 samtidige oppslag, utfallsvern, 30 s cache).
 */
const identity: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const BUILT = CONNECTOR_REGISTRY.filter((c) => !c.category.startsWith("backlog"));
const BUILT_REFS = [...new Set(BUILT.flatMap((c) => c.credential_refs))];
const NONE: SecretProvider = { name: "ingen", get: async () => null };

interface FakeInfisical {
  url: string;
  mode: "ok" | "down";
  secrets: Map<string, string>;
  delayMs: number;
  readonly logins: number;
  readonly gets: number;
  readonly maxInflight: number;
  resetCounters(): void;
  stop(): Promise<void>;
}

async function startFakeInfisical(): Promise<FakeInfisical> {
  const s = { logins: 0, gets: 0, inflight: 0, maxInflight: 0, mode: "ok" as FakeInfisical["mode"], delayMs: 0, secrets: new Map<string, string>() };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respond = (status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST" && req.url?.startsWith("/api/v1/auth/universal-auth/login")) {
      s.logins += 1;
      req.resume();
      respond(200, { accessToken: "t-123" });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/v3/secrets/raw/")) {
      s.gets += 1;
      s.inflight += 1;
      s.maxInflight = Math.max(s.maxInflight, s.inflight);
      const ref = decodeURIComponent((req.url.split("?")[0] ?? "").slice("/api/v3/secrets/raw/".length));
      const finish = (): void => {
        s.inflight -= 1;
        if (s.mode === "down") return respond(503, { error: "unavailable" });
        const value = s.secrets.get(ref);
        return value === undefined ? respond(404, { error: "not found" }) : respond(200, { secret: { secretValue: value } });
      };
      if (s.delayMs > 0) setTimeout(finish, s.delayMs); else finish();
      return;
    }
    respond(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get mode() { return s.mode; }, set mode(m) { s.mode = m; },
    get delayMs() { return s.delayMs; }, set delayMs(ms) { s.delayMs = ms; },
    secrets: s.secrets,
    get logins() { return s.logins; }, get gets() { return s.gets; }, get maxInflight() { return s.maxInflight; },
    resetCounters() { s.logins = 0; s.gets = 0; s.maxInflight = 0; },
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

/** Den ekte kjeden slik `main.ts` setter den sammen (Infisical → env → intern), men uten miljøvariabler (hermetisk) og med en klokke testen styrer. */
function harness(fake: FakeInfisical) {
  const infisical = new InfisicalSecretProvider(fake.url, "client-id", "client-secret", "project-id", "dev");
  const chain = new FallbackSecretProvider(infisical, new FallbackSecretProvider(NONE, NONE));
  const gateway = new ToolGateway({} as pg.Pool, {} as PolicyGateway, chain);
  for (const def of productionToolDefinitions()) gateway.register(def);
  const center = createIntegrationCenter({
    pool: new ScriptedPool([]).asPool(), toolGateway: gateway,
    ownerControls: { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] }
  });
  const clock = { ms: Date.parse("2026-10-09T12:00:00.000Z") };
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => new Date(clock.ms), buildTimeoutMs: 20_000 });
  registry.register(center);
  return { infisical, gateway, clock, run: async () => (await registry.report("integration", identity)) as ControlCenterReport };
}

const section = (r: ControlCenterReport, id: string): ControlSection => {
  const s = r.sections.find((x) => x.id === id);
  if (!s) throw new Error(`mangler seksjon ${id}`);
  return s;
};
const builtItems = (r: ControlCenterReport) => ["live", "configured_other", "not_configured"].flatMap((id) => section(r, id).items);

describe("Integration Center over den ekte secret-kjeden når Infisical er nede (M-1) - og lasten mot kilden (L-3)", () => {
  let fake: FakeInfisical | undefined;
  afterEach(async () => { await fake?.stop(); fake = undefined; });

  it("REPRO fra gjennomgangen: Infisical svarer 503 på alle oppslag ⇒ ingen bygd tilkobling er OK, alle er UKJENT, og senteret sier at kilden er utilgjengelig", async () => {
    fake = await startFakeInfisical();
    fake.mode = "down";
    const h = harness(fake);
    const r = await h.run();
    const items = builtItems(r);
    expect(items).toHaveLength(BUILT.length);
    expect(items.filter((i) => i.status === "OK")).toEqual([]);
    for (const i of items) expect(i.status, i.id).toBe("UNKNOWN");
    expect(h.infisical.health).toBe("unavailable");
    expect(h.gateway.secretsHealth()).toBe("unavailable");
    for (const id of ["live", "configured_other", "not_configured"]) expect(section(r, id).status, id).toBe("UNKNOWN");
    expect(section(r, "live").summary_no).toContain("kilden er utilgjengelig");
    expect(r.status).toBe("UNKNOWN");
    // to-state hasSecret() ville sagt «false» for alle (funnet): den er uendret, men senteret bruker den ikke lenger
    expect(await h.gateway.hasSecret("JARVIS_GITHUB_TOKEN")).toBe(false);
    expect(await h.gateway.secretPresence("JARVIS_GITHUB_TOKEN")).toBeNull();
  });

  it("L-3: kilden som er nede spørres ikke ~87 ganger - ÉN innlogging, høyst 8 samtidige oppslag, og resten av refene spares (utfallsvern)", async () => {
    fake = await startFakeInfisical();
    fake.mode = "down";
    fake.delayMs = 15;
    const h = harness(fake);
    expect(BUILT_REFS.length).toBeGreaterThan(40);
    await h.run();
    expect(fake.logins).toBe(1);
    expect(fake.maxInflight).toBeLessThanOrEqual(PRESENCE_CONCURRENCY);
    expect(fake.gets).toBeLessThanOrEqual(PRESENCE_CONCURRENCY);
    // en oppdatering bygger to ganger (oversikt + detalj): den andre byggingen rører ikke kilden mens utfallsvernet gjelder
    const before = fake.gets;
    await h.run();
    expect(fake.gets).toBe(before);
    // etter utfallsvinduet prøves kilden på nytt (kilden som er tilbake skal måles, ikke antas nede)
    h.clock.ms += PRESENCE_OUTAGE_BACKOFF_MS + 1;
    await h.run();
    expect(fake.gets).toBeGreaterThan(before);
    expect(fake.gets).toBeLessThanOrEqual(2 * PRESENCE_CONCURRENCY);
  });

  it("kilden kommer tilbake: neste bygging måler på ekte - finnes, mangler og ukjent skilles, og ingenting ligger igjen som ukjent", async () => {
    fake = await startFakeInfisical();
    fake.mode = "down";
    const h = harness(fake);
    await h.run();
    fake.mode = "ok";
    for (const ref of CONNECTOR_REGISTRY.find((c) => c.id === "github")!.credential_refs) fake.secrets.set(ref, "verdi-som-aldri-skal-vises");
    h.clock.ms += PRESENCE_OUTAGE_BACKOFF_MS + 1;
    fake.resetCounters();
    fake.delayMs = 5;
    const r = await h.run();
    const items = builtItems(r);
    expect(items.every((i) => i.facts?.["configuration"] !== "unknown")).toBe(true);
    expect(items.find((i) => i.id === "github")?.facts).toMatchObject({ configured: true, configuration: "yes" });
    expect(items.find((i) => i.id === "slack")?.facts).toMatchObject({ configured: false, configuration: "no" });
    expect(section(r, "not_configured").summary_no).not.toContain("kunne ikke måles");
    expect(JSON.stringify(r)).not.toContain("verdi-som-aldri-skal-vises");
    expect(h.infisical.health).toBe("healthy");
    // L-3: alle refene målt med høyst 8 samtidige oppslag, uten ny innlogging (tokenet gjenbrukes)
    expect(fake.gets).toBe(BUILT_REFS.length);
    expect(fake.maxInflight).toBeLessThanOrEqual(PRESENCE_CONCURRENCY);
    expect(fake.logins).toBe(0);
  });

  it("L-3: et definitivt svar gjenbrukes i 30 s (andre bygging = 0 oppslag), og måles på nytt etter utløp - en ny nøkkel som er limt inn vises senest da", async () => {
    fake = await startFakeInfisical();
    const h = harness(fake);
    await h.run();
    expect(fake.gets).toBe(BUILT_REFS.length);
    fake.resetCounters();
    h.clock.ms += PRESENCE_TTL_MS - 1_000;
    await h.run();
    expect(fake.gets).toBe(0);
    fake.secrets.set(CONNECTOR_REGISTRY.find((c) => c.id === "github")!.credential_refs[0] as string, "ny-verdi");
    h.clock.ms += 1_001;
    const r = await h.run();
    expect(fake.gets).toBe(BUILT_REFS.length);
    expect(builtItems(r).find((i) => i.id === "github")?.facts?.["credentials_present"]).toMatch(/^1\//);
  });
});
