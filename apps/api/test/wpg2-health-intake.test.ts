import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { HealthIntakeError, HealthRetentionPolicyRequiredError } from "@jarvis/health";
import { SURFACE_TOOL_GRANTS } from "@jarvis/tool-gateway";
import { HEALTH_INTAKE_CHANNELS, handlePersonalRoute, healthIntakeDenial, type PersonalRouteContext } from "../src/personal-routes.ts";
import { createPersonalWiring } from "../src/personal-wiring.ts";

/**
 * WP-G2 (D-464) P1d: rutegrensene for helse-inntaket og det begrensede-data-vernet (SECRET_RESTRICTED).
 *  A. flagg AV = ingen rute og ingen avhengighet; flagget på gir KUN en rute - aldri et verktøy.
 *  B. enhetssignert: signert grant + kanal mobile/watch + health-rom; rekkefølge og feilkoder; ingen feilmelding (kan sitere helseverdier) når ut i logg eller svar.
 *  C. utførelsesvern: helsedata kan strukturelt ikke nå en modell (ingen verktøy, ingen modellflate-tildeling, kun godkjente importører av helsepakken og tabellen).
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const phone: IdentityContext = { person_id: "p-adult", tenant_id: "t-1", memory_space_id: "health", session_id: "s-1", device_id: "iphone-1", channel: "mobile", auth_strength: "signed" };

describe("A: flagg AV = ingen rute; flagget på = en rute, aldri et verktøy", () => {
  const base = { pool: {} as never, gateway: {} as never, readSecret: async () => null };
  it("uten flagg finnes ingen helse-avhengighet (uansett annet flagg); kun nøyaktig `on` slår det på", () => {
    for (const value of [undefined, "", "true", "1", "ON", "yes"]) {
      const w = createPersonalWiring({ ...base, env: value === undefined ? { JARVIS_PERSONAL_FAMILY: "on" } : { JARVIS_PERSONAL_HEALTH_INGEST: value }, ownerPersonId: "p-owner" });
      expect(w.deps?.health, String(value)).toBeUndefined();
    }
    const on = createPersonalWiring({ ...base, env: { JARVIS_PERSONAL_HEALTH_INGEST: "on" } });
    expect(on.deps?.health?.intake).toBeDefined();
    expect(on.deps?.actions).toBeUndefined();
    expect(on.deps?.family).toBeUndefined();
    expect(on.tools).toEqual([]); // INGEN verktøy: helsedata skal ikke kunne nå en modell
    expect(on.describe()).toEqual({ msg: "personal_twin", health_ingest: { registered: true, source_type: "apple_health", max_samples: 250, max_deletes: 250, metrics: 10 } });
  });

  it("med ALLE personlig-flagg på registreres fortsatt ingen helse-/familie-/bilverktøy på en modellflate og ingen verktøy nevner helsekilden", () => {
    const all = createPersonalWiring({
      ...base, ownerPersonId: "p-owner",
      env: { JARVIS_PERSONAL_HEALTH_INGEST: "on", JARVIS_PERSONAL_FAMILY: "on", JARVIS_PERSONAL_HOME_CRITICAL: "on", JARVIS_PERSONAL_CAR: "on" }
    });
    for (const tool of all.tools) expect(`${tool.tool_id}.${tool.action}`).not.toMatch(/health|helse|apple/i);
    expect(all.deps?.health).toBeDefined();
    expect(all.deps?.family).toBeDefined();
    expect(all.deps?.actions).toBeDefined();
  });
});

interface Harness { ctx: PersonalRouteContext; calls: string[]; responses: Array<{ status: number; body: Record<string, unknown> }>; ingest: ReturnType<typeof vi.fn>; failures: unknown[] }

function harness(opts: { body?: Record<string, unknown>; identity?: IdentityContext; authed?: boolean; health?: boolean; method?: string; fail?: unknown; path?: string }): Harness {
  const calls: string[] = [];
  const failures: unknown[] = [];
  const responses: Harness["responses"] = [];
  const ingest = vi.fn(async () => { calls.push("ingest"); if (opts.fail !== undefined) throw opts.fail; return { results: [{ index: 0, status: "created" }], counts: { created: 1, duplicate: 0, conflict: 0, invalid: 0, expired: 0, deleted: 0 } }; });
  const ctx: PersonalRouteContext = {
    req: { method: opts.method ?? "POST" } as never, res: {} as never, url: new URL(opts.path ?? "/personal/health/ingest", "http://localhost"),
    deps: opts.health === false ? {} : { health: { intake: { ingestBatch: ingest as never } } },
    authed: async () => { calls.push("authed"); return opts.authed === false ? null : { identity: opts.identity ?? phone, body: opts.body ?? { samples: [{ x: 1 }], deleted_external_sample_ids: ["AAAAAAAA-1"] } }; },
    requireOwner: async () => { throw new Error("helse-inntaket bruker ikke requireOwner: dataene tilhører grantets person"); },
    stepUpDenial: () => { throw new Error("helse-inntaket bruker egen enhetssignert-regel, ikke eier-step-up"); },
    json: (status, b) => { responses.push({ status, body: b as Record<string, unknown> }); }, requestId: () => "req-1",
    fieldString: () => "", fieldOptionalString: () => undefined, fieldRecord: () => ({}), fieldOptionalNumber: () => undefined,
    domainFailure: (status, code, err) => { failures.push(err); responses.push({ status, body: { error: code, generic: true } }); }
  };
  return { ctx, calls, responses, ingest, failures };
}

describe("B: enhetssignert inntak - porter, rekkefølge og feil", () => {
  it("regelen: signert økt, kanal mobile/watch, health-rom - alt annet nektes med en stabil kode", () => {
    expect(healthIntakeDenial(phone)).toBeUndefined();
    expect(healthIntakeDenial({ ...phone, channel: "watch" })).toBeUndefined();
    expect(healthIntakeDenial({ ...phone, auth_strength: "active" })).toBe("signed_device_session_required");
    expect(healthIntakeDenial({ ...phone, auth_strength: "passkey" as never })).toBe("signed_device_session_required");
    for (const channel of ["web", "desktop", "api", "voice", "system", "telegram", "slack", "discord", "twilio"] as const) expect(healthIntakeDenial({ ...phone, channel }), channel).toBe("channel_not_allowed");
    for (const space of ["personal", "business", "home", "shared", "guest", "project"] as const) expect(healthIntakeDenial({ ...phone, memory_space_id: space }), space).toBe("health_space_required");
    expect([...HEALTH_INTAKE_CHANNELS].sort()).toEqual(["mobile", "watch"]);
  });

  it("grant -> regel -> tjeneste; identiteten er grantets (kroppen kan ikke gi person/tenant/kilde), og svaret merkes med kilden", async () => {
    const h = harness({});
    expect(await handlePersonalRoute(h.ctx)).toBe(true);
    expect(h.calls).toEqual(["authed", "ingest"]);
    const [identity, request] = h.ingest.mock.calls[0] as unknown as [IdentityContext, Record<string, unknown>];
    expect(identity).toBe(phone);
    expect(request).toEqual({ samples: [{ x: 1 }], deleted_external_sample_ids: ["AAAAAAAA-1"] });
    expect(h.responses).toEqual([{ status: 200, body: { source: "apple_health", results: [{ index: 0, status: "created" }], counts: { created: 1, duplicate: 0, conflict: 0, invalid: 0, expired: 0, deleted: 0 } } }]);
  });

  it("nektet identitet (ikke signert, feil kanal, feil rom): 403 med kode, og tjenesten nås ALDRI", async () => {
    for (const [identity, reason] of [
      [{ ...phone, auth_strength: "active" }, "signed_device_session_required"], [{ ...phone, channel: "web" }, "channel_not_allowed"], [{ ...phone, memory_space_id: "personal" }, "health_space_required"]
    ] as Array<[IdentityContext, string]>) {
      const h = harness({ identity });
      expect(await handlePersonalRoute(h.ctx)).toBe(true);
      expect(h.calls).toEqual(["authed"]);
      expect(h.responses).toEqual([{ status: 403, body: { error: "health_intake_denied", reason, request_id: "req-1" } }]);
    }
    const noGrant = harness({ authed: false });
    expect(await handlePersonalRoute(noGrant.ctx)).toBe(true);
    expect(noGrant.calls).toEqual(["authed"]);
    expect(noGrant.responses).toEqual([]);
  });

  it("feilkoder: tom/for stort/feil form, ingen oppbevaringstid (409); alt annet er generisk og feilmeldingen (som kan sitere helseverdier) når aldri logg eller svar", async () => {
    for (const [code, status] of [["empty_batch", 400], ["invalid_request", 400], ["batch_too_large", 413]] as const) {
      const h = harness({ fail: new HealthIntakeError(code) });
      await handlePersonalRoute(h.ctx);
      expect(h.responses).toEqual([{ status, body: { error: "health_intake_rejected", reason: code, request_id: "req-1" } }]);
    }
    // review B MEDIUM-2: ugyldige tidsstempel avviser batchen med 400 og INDEKSENE (aldri verdiene)
    const stamps = harness({ fail: new HealthIntakeError("invalid_timestamps", [1, 4]) });
    await handlePersonalRoute(stamps.ctx);
    expect(stamps.responses).toEqual([{ status: 400, body: { error: "health_intake_rejected", reason: "invalid_timestamps", indexes: [1, 4], request_id: "req-1" } }]);
    const noPolicy = harness({ fail: new HealthRetentionPolicyRequiredError() });
    await handlePersonalRoute(noPolicy.ctx);
    expect(noPolicy.responses).toEqual([{ status: 409, body: { error: "health_retention_policy_required", request_id: "req-1" } }]);

    const secret = new Error('new row violates check constraint; Failing row contains (heart_rate, 71, bpm, device-secret-1)');
    secret.name = "error";
    const boom = harness({ fail: secret });
    await handlePersonalRoute(boom.ctx);
    expect(boom.responses).toEqual([{ status: 500, body: { error: "health_intake_failed", generic: true } }]);
    expect(JSON.stringify(boom.responses)).not.toContain("71");
    expect(boom.failures).toHaveLength(1);
    expect((boom.failures[0] as Error).message).toBe("error"); // kun klassenavnet logges
    expect(JSON.stringify(boom.failures[0] instanceof Error ? boom.failures[0].message : boom.failures[0])).not.toMatch(/heart_rate|device-secret|71/);
  });

  it("ruten finnes ikke uten `deps.health`, for andre metoder eller andre stier (-> false = 404 hos kalleren)", async () => {
    expect(await handlePersonalRoute(harness({ health: false }).ctx)).toBe(false);
    const get = harness({ method: "GET" });
    expect(await handlePersonalRoute(get.ctx)).toBe(false);
    expect(get.calls).toEqual([]);
    expect(await handlePersonalRoute(harness({ path: "/personal/health/export" }).ctx)).toBe(false);
    expect(await handlePersonalRoute(harness({ path: "/personal/health/ingest/extra" }).ctx)).toBe(false);
  });
});

/** Alle `.ts`-kildefiler (ikke tester, ikke node_modules) under src-mappene i moduler/apper/pakker. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "test") continue;
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  for (const top of ["modules", "apps", "packages"]) {
    for (const pkg of readdirSync(join(ROOT, top))) {
      const src = join(ROOT, top, pkg, "src");
      try { if (statSync(src).isDirectory()) walk(src); } catch { /* ingen src-mappe */ }
    }
  }
  return out;
}

describe("C: utførelsesvern - helsedata kan strukturelt ikke nå en modell", () => {
  const files = sourceFiles().map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));

  it("kun godkjente filer importerer helsepakken (ingen verktøy-, modell-, chat- eller minnekode); en ny importør må godkjennes bevisst her", () => {
    // Både pakkenavnet og en relativ sti inn i helsemodulens kildekode teller som import.
    const importers = files.filter((f) => /from\s+["'](@jarvis\/health|(\.\.\/)+health\/src[^"']*)["']/.test(f.text)).map((f) => f.path).sort();
    expect(importers).toEqual(["apps/api/src/main.ts", "apps/api/src/personal-routes.ts", "apps/api/src/personal-wiring.ts"]);
  });

  it("kun helsemodulen og slettekjeden refererer helsetabellen; ingen annen modul leser eller skriver `health_metric_observations`", () => {
    const refs = files.filter((f) => f.text.includes("health_metric_observations")).map((f) => f.path).sort();
    expect(refs).toEqual(["modules/erasure/src/plan.ts", "modules/health/src/intake.ts", "modules/health/src/service.ts", "modules/health/src/types.ts"]);
  });

  it("inntaket har ingen avhengighet til modellgatewayen, verktøygatewayen eller leverandøradaptere, og logger aldri innhold", () => {
    const intake = files.find((f) => f.path === "modules/health/src/intake.ts")!.text;
    expect(intake).not.toMatch(/from\s+["']@jarvis\/(model-gateway|tool-gateway|provider-adapters|tasks|conversation-graph)["']/);
    expect(intake).not.toMatch(/console\.(log|error|warn|info|debug)/);
    const routes = files.find((f) => f.path === "apps/api/src/personal-routes.ts")!.text;
    const handler = routes.slice(routes.indexOf("async function handleHealthIngest"));
    expect(handler.slice(0, handler.indexOf("\n}\n"))).not.toMatch(/err\.message|console\./);
  });

  it("ingen modellflate-tildeling (SURFACE_TOOL_GRANTS) nevner helsekilden, helsetabellen eller en helse-oppsummering", () => {
    const grants = Object.values(SURFACE_TOOL_GRANTS).flat().map((g) => `${g.tool_id}.${g.action}`);
    expect(grants.length).toBeGreaterThan(10);
    for (const key of grants) expect(key, key).not.toMatch(/apple_health|healthkit|health_metric|personal_health|health_summary|health_ingest/i);
  });
});
