import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { INFISICAL_CAPABILITIES, InfisicalTransport, isRotationId, parseInfisicalRotationIds } from "../src/infisical-transport.ts";
import { FakeInfisical } from "./support/fake-infisical.ts";

/**
 * WP-E1: `InfisicalTransport` mot en LOKAL fake Infisical-server. Bevist: login/token-gjenbruk/fornyelse ved 401, helse, secret-METADATA uten at en eneste VERDI
 * forlater transporten (heller ikke når serveren ignorerer `viewSecretValue=false`), alder/stale, rotasjonsstatus (også når funksjonen er utilgjengelig) og rotasjon
 * med type fra Infisicals egen liste (aldri fra kaller), readback og feilhåndtering. Credential og tokens vaskes ut av alle feil.
 */
const VALUE = "SUPER-HEMMELIG-VERDI-4711";
let fx: FakeInfisical;
let sleeps: number[];
let nowMs = Date.parse("2026-10-09T12:00:00Z");

beforeAll(async () => { fx = new FakeInfisical(); await fx.start(); });
afterAll(async () => { await fx.stop(); });
beforeEach(() => {
  fx.requests.length = 0;
  fx.secrets.clear();
  fx.rotations.clear();
  fx.leakValues = false;
  fx.rotationsStatus = 200;
  fx.rotationFails = false;
  fx.silentlyIgnoreRotate = false;
  fx.loginCount = 0;
  fx.revokeTokens();
  sleeps = [];
  nowMs = Date.now();
});

const transport = (over: Partial<{ baseUrl: string | null; clientId: string | null; projectId: string | null; env: string | null }> = {}): InfisicalTransport =>
  new InfisicalTransport({
    baseUrl: async () => ("baseUrl" in over ? over.baseUrl ?? null : fx.baseUrl),
    clientId: async () => ("clientId" in over ? over.clientId ?? null : fx.clientId),
    projectId: async () => ("projectId" in over ? over.projectId ?? null : fx.projectId),
    environment: async () => ("env" in over ? over.env ?? null : fx.environment),
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => nowMs
  });
const call = async <T = Record<string, unknown>>(action: string, params: Record<string, JsonValue> = {}, t: InfisicalTransport = transport(), secret: string = fx.clientSecret): Promise<T> =>
  ((await t.invoke(action, params, secret)).data ?? null) as unknown as T;
const rejection = async (p: Promise<unknown>): Promise<Error> => { try { await p; } catch (e) { return e as Error; } throw new Error("forventet avvisning"); };

describe("A: autentisering (maskin-identitet) og helse", () => {
  it("logger inn én gang og gjenbruker tokenet; ved 401 (utløpt/tilbakekalt) logges det inn på nytt ÉN gang og kallet gjentas", async () => {
    fx.seedSecret("A_KEY", VALUE);
    const t = transport();
    await call("list_secret_metadata", {}, t);
    await call("list_secret_metadata", {}, t);
    expect(fx.loginCount).toBe(1);
    fx.revokeTokens();
    const again = await call<{ count: number }>("list_secret_metadata", {}, t);
    expect(again.count).toBe(1);
    expect(fx.loginCount).toBe(2);
  });

  it("feil klient-hemmelighet -> infisical_login_failed_401, og hemmeligheten står ikke i feilen", async () => {
    const wrong = "cs-feil-hemmelighet-0000";
    const err = await rejection(transport().invoke("list_secret_metadata", {}, wrong));
    expect(err.message).toBe("infisical_login_failed_401");
    expect(err.message).not.toContain(wrong);
    expect(fx.requests.filter((r) => r.path.includes("/secrets/")).length).toBe(0);
  });

  it("helse: offentlig /api/status uten autentisering; hvitlistede flagg og melding", async () => {
    const r = await call<Record<string, unknown>>("get_health");
    expect(r).toMatchObject({ reachable: true, healthy: true, http_status: 200, message: "Ok", email_configured: false, redis_configured: true, invite_only_signup: true });
    expect(fx.requests).toEqual([{ method: "GET", path: "/api/status", query: {}, body: null, auth: "missing" }]);
    expect(JSON.stringify(r)).not.toContain("secretScanning");
  });

  it("helse: 503 er «nede»; ingen lytter er infisical_unreachable", async () => {
    fx.failNext(/GET \/api\/status/, 503);
    expect(await call("get_health")).toMatchObject({ reachable: true, healthy: false, http_status: 503 });
    expect((await rejection(transport({ baseUrl: "http://127.0.0.1:1" }).invoke("get_health", {}, fx.clientSecret))).message).toBe("infisical_unreachable");
  });

  it("manglende/ugyldig konfig feiler lukket før noe sendes", async () => {
    expect((await rejection(transport({ baseUrl: null }).invoke("get_health", {}, fx.clientSecret))).message).toBe("infisical_base_url_not_configured");
    expect((await rejection(transport({ clientId: null }).invoke("list_secret_metadata", {}, fx.clientSecret))).message).toBe("infisical_client_id_not_configured");
    expect((await rejection(transport({ projectId: null }).invoke("list_secret_metadata", {}, fx.clientSecret))).message).toBe("infisical_project_not_configured");
    expect((await rejection(transport({ projectId: "../x" }).invoke("list_secret_metadata", {}, fx.clientSecret))).message).toBe("infisical_project_invalid");
    expect((await rejection(transport({ baseUrl: "http://host/sti" }).invoke("get_health", {}, fx.clientSecret))).message).toBe("infisical_base_url_invalid");
    expect(fx.requests).toHaveLength(0);
  });
});

describe("B: secret-METADATA - aldri verdier", () => {
  it("alder, versjon, tagger og rotasjonsflagg; sendes med viewSecretValue=false; prosjekt og miljø kommer fra konfig", async () => {
    fx.seedSecret("OLD_TOKEN", VALUE, { ageDays: 200, tags: ["prod"] });
    fx.seedSecret("NEW_TOKEN", VALUE, { ageDays: 3, rotationId: "rot-1" });
    const r = await call<{ count: number; stale_count: number; oldest_age_days: number; values_returned: boolean; secrets: Array<Record<string, unknown>> }>("list_secret_metadata", { max_age_days: 90 });
    expect(r).toMatchObject({ count: 2, stale_count: 1, oldest_age_days: 200, values_returned: false, project_id: fx.projectId, environment: fx.environment, path: "/" });
    expect(r.secrets[0]).toMatchObject({ key: "OLD_TOKEN", age_days: 200, stale: true, tags: ["prod"], is_rotated: false, version: 1 });
    expect(r.secrets[1]).toMatchObject({ key: "NEW_TOKEN", age_days: 3, stale: false, is_rotated: true });
    const req = fx.requests.find((x) => x.path === "/api/v3/secrets/raw")!;
    expect(req.query).toMatchObject({ viewSecretValue: "false", workspaceId: fx.projectId, environment: fx.environment, secretPath: "/", recursive: "false" });
    expect(req.auth).toBe("ok");
    expect(JSON.stringify(r)).not.toContain(VALUE);
  });

  it("selv når serveren IGNORERER viewSecretValue=false og sender verdier, kopieres ingen verdi (eller kommentar) videre", async () => {
    fx.leakValues = true;
    fx.seedSecret("LEAKY", VALUE, { comment: "kommentar-med-hemmelighet-99" });
    const list = JSON.stringify(await call("list_secret_metadata"));
    const one = JSON.stringify(await call("get_secret_metadata", { key: "LEAKY" }));
    for (const text of [list, one]) {
      expect(text).not.toContain(VALUE);
      expect(text).not.toContain("kommentar-med-hemmelighet-99");
      expect(text).not.toContain("secretValue");
    }
  });

  it("get_secret_metadata: finnes -> metadata; finnes ikke -> null; navn og sti valideres FØR kallet (ingen sti-injeksjon)", async () => {
    fx.seedSecret("EXISTS_1", VALUE, { ageDays: 10 });
    expect(await call("get_secret_metadata", { key: "EXISTS_1" })).toMatchObject({ key: "EXISTS_1", age_days: 10, values_returned: false });
    expect(await call("get_secret_metadata", { key: "FINNES_IKKE" })).toBeNull();
    fx.requests.length = 0;
    for (const key of ["../admin", "a/b", "..", "a b", "x".repeat(201), "", "%2e%2e", "KEY?x=1"]) {
      expect((await rejection(transport().invoke("get_secret_metadata", { key }, fx.clientSecret))).message, key).toBe("infisical_invalid_secret_name");
    }
    for (const path of ["relativ", "/a/../b", "//", "/a//b", "/a/%2e%2e/b", "/a b", "/a?x=1", `/${"x".repeat(250)}`]) {
      expect((await rejection(transport().invoke("list_secret_metadata", { path }, fx.clientSecret))).message, path).toBe("infisical_invalid_path");
    }
    expect(fx.requests).toHaveLength(0);
  });

  it("max_age_days valideres strengt, og et svar med ukjente/ugyldige elementer hoppes over uten å kaste", async () => {
    expect((await rejection(transport().invoke("list_secret_metadata", { max_age_days: 0 }, fx.clientSecret))).message).toBe("infisical_invalid_max_age_days");
    expect((await rejection(transport().invoke("list_secret_metadata", { max_age_days: "90" as never }, fx.clientSecret))).message).toBe("infisical_invalid_max_age_days");
    fx.seedSecret("BAD KEY WITH SPACES", VALUE);
    fx.seedSecret("GOOD_KEY", VALUE);
    const r = await call<{ count: number; secrets: Array<{ key: string }> }>("list_secret_metadata");
    expect(r.secrets.map((s) => s.key)).toEqual(["GOOD_KEY"]);
  });
});

describe("C: rotasjon (V2)", () => {
  it("list_secret_rotations: hvitlistede felt (status/tider), og utilgjengelig funksjon meldes som available:false (aldri som feil)", async () => {
    const r1 = fx.seedRotation({ name: "supabase-main", rotationStatus: "success" });
    const list = await call<{ available: boolean; count: number; rotations: Array<Record<string, unknown>> }>("list_secret_rotations");
    expect(list).toMatchObject({ available: true, count: 1 });
    expect(list.rotations[0]).toMatchObject({ id: r1.id, name: "supabase-main", type: "supabase-api-key", rotation_status: "success", auto_rotation_enabled: true });
    fx.rotationsStatus = 403;
    expect(await call("list_secret_rotations")).toMatchObject({ available: false, reason: "http_403", count: 0 });
    expect(await call("get_rotation", { rotation_id: r1.id })).toBeNull();
  });

  it("rotate_secrets: type leses fra Infisicals liste, readback viser fersk rotasjon, og ingen verdier returneres", async () => {
    const r = fx.seedRotation();
    const before = r.lastRotatedAt;
    const out = await transport().invoke("rotate_secrets", { rotation_id: r.id }, fx.clientSecret);
    expect(out.external_id).toBe(`rotation:${r.id}`);
    expect(out.data).toMatchObject({ rotated: true, rotation: { id: r.id, rotation_status: "success" } });
    expect(fx.rotations.get(r.id)!.lastRotatedAt).not.toBe(before);
    expect(fx.requestsMatching("POST", /rotate-secrets$/)[0]!.path).toBe(`/api/v2/secret-rotations/supabase-api-key/${r.id}/rotate-secrets`);
    expect(JSON.stringify(out)).not.toContain("secretValue");
  });

  it("rotasjon som feiler hos leverandøren gir infisical_rotation_failed (ikke ok), og siste feil står ikke i feilmeldingen", async () => {
    const r = fx.seedRotation();
    fx.rotationFails = true;
    const err = await rejection(transport().invoke("rotate_secrets", { rotation_id: r.id }, fx.clientSecret));
    expect(err.message).toMatch(/^infisical_rotation_failed:failed/);
    expect(err.message).not.toContain("supabase");
  });

  it("ukjent rotasjon, ugyldig id og utilgjengelig funksjon feiler lukket uten POST", async () => {
    const r = fx.seedRotation();
    expect((await rejection(transport().invoke("rotate_secrets", { rotation_id: "00000000-0000-4000-8000-000000000000" }, fx.clientSecret))).message).toBe("infisical_rotation_not_found");
    for (const bad of ["../x", "123", "", 1, null]) expect((await rejection(transport().invoke("rotate_secrets", { rotation_id: bad as never }, fx.clientSecret))).message).toBe("infisical_invalid_rotation_id");
    fx.rotationsStatus = 404;
    expect((await rejection(transport().invoke("rotate_secrets", { rotation_id: r.id }, fx.clientSecret))).message).toBe("infisical_rotation_unavailable:http_404");
    expect(fx.requestsMatching("POST", /rotate-secrets$/)).toHaveLength(0);
  });

  it("en rotasjonstype fra serveren som ikke er en ren sti-token (f.eks. «../..») brukes ALDRI i en URL", async () => {
    const r = fx.seedRotation({ type: "../../admin" });
    expect((await rejection(transport().invoke("rotate_secrets", { rotation_id: r.id }, fx.clientSecret))).message).toBe("infisical_rotation_type_invalid");
    expect(fx.requestsMatching("POST", /rotate-secrets/)).toHaveLength(0);
  });

  it("mutasjonen gjentas ALDRI på 5xx (bivirkningen kan ha skjedd)", async () => {
    const r = fx.seedRotation();
    fx.failNext(/POST \/api\/v2\/secret-rotations\//, 503, 3);
    const err = await rejection(transport().invoke("rotate_secrets", { rotation_id: r.id }, fx.clientSecret));
    expect(err.message).toMatch(/^infisical_error_503:/);
    expect(fx.requestsMatching("POST", /rotate-secrets$/)).toHaveLength(1);
  });

  it("rotasjons-id-er parses strengt (UUID), små bokstaver, ugyldige hoppes over", () => {
    const id = "3f2b8c1e-9d4a-4f6b-8a1c-2e7d5b9a0c11";
    expect(isRotationId(id)).toBe(true);
    expect(isRotationId("3f2b8c1e")).toBe(false);
    expect([...parseInfisicalRotationIds(` ${id.toUpperCase()}, ikke-uuid, ${id} `)]).toEqual([id]);
    expect([...parseInfisicalRotationIds(undefined)]).toEqual([]);
  });
});

describe("D: kapabilitetsmatrisen (D-41) er ærlig", () => {
  it("sletting, identitets-/tilgangsstyring og snapshots er DEFERRED med begrunnelse; verdiskriving peker på den eksisterende eierveien", () => {
    const deferred = INFISICAL_CAPABILITIES.filter((c) => c.status === "DEFERRED").map((c) => c.capability);
    expect(deferred.some((c) => /Slette secret/.test(c))).toBe(true);
    expect(deferred.some((c) => /maskin-identiteter/.test(c))).toBe(true);
    for (const c of INFISICAL_CAPABILITIES.filter((x) => x.status === "DEFERRED")) expect(c.note.length, c.capability).toBeGreaterThan(30);
    const write = INFISICAL_CAPABILITIES.find((c) => /Opprette\/oppdatere secret-verdi/.test(c.capability))!;
    expect(write.note).toMatch(/set_connector_credential/);
  });
});
