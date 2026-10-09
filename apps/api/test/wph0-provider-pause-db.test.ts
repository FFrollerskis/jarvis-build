import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProviderAdapter, ModelResult } from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway, NoEligibleProviderError } from "@jarvis/model-gateway";
import { OwnerControlsService, OwnerControlsTransport } from "@jarvis/owner-controls";
import { KillSwitch, OwnerControls } from "@jarvis/policy";
import { createProviderPauseSourceFromPool, freezeTargetError } from "../src/provider-pause.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H0 / JARVIS-087 - EKTE Postgres som EKTE app-rolle: eierens pause/tilbakekall av en modellleverandør virker LIVE, uten omstart, gjennom de eksisterende eierbryterne (`owner_control_state`).
 *  - pausekilden leser rollens GRANT-er (ingen «permission denied») og ser frys/tilbakekall skrevet av `OwnerControls` (eier-autoritet håndheves der);
 *  - en ekte `ModelGateway` (ekte budsjettvakt og kostrader) stanser en pauset leverandør umiddelbart og tar den i bruk igjen etter gjenopptak - samme gateway-instans;
 *  - SECRET_RESTRICTED + pauset lokal leverandør = fail-closed, og ingen skyadapter røres;
 *  - et pauset kall skriver ingen kostrad.
 */
let db: H0Db;
const TENANT = "tenant-pp";
const OWNER = "person-pp";
const calls: Record<string, number> = {};

function adapter(name: string, model: string): ModelProviderAdapter {
  return {
    name, model, available: () => true,
    complete: async (): Promise<ModelResult> => {
      calls[name] = (calls[name] ?? 0) + 1;
      return { text: `svar fra ${name}`, usage: { input_tokens: 1, output_tokens: 1 }, provider: name, model, finish_reason: "stop" };
    }
  };
}

beforeAll(async () => {
  db = await startH0Db("pp");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT, person_id: OWNER }]);
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

const controls = () => new OwnerControls(new KillSwitch(db.appPool, { owner_person_id: OWNER }), db.appPool, { owner_person_id: OWNER });
const costRows = async (): Promise<number> => Number(((await db.adminPool.query("SELECT count(*)::int AS n FROM cost_events")).rows[0] as { n: number }).n);

function gateway(): ModelGateway {
  return new ModelGateway({
    pool: db.appPool, trace: new MemoryTraceSink(),
    providers: [adapter("anthropic", "claude-x"), adapter("openai", "gpt-x"), adapter("gemma_local", "gemma3")],
    providerPause: createProviderPauseSourceFromPool(db.appPool)
  });
}
const request = { messages: [{ role: "user" as const, content: "hei" }] };

describe("pausekilden som app-rolle", () => {
  it("leser frosne modell-mål og tilbakekalte nøkler skrevet av OwnerControls; verktøyfrys og andre nøkler pauser ingen modell", async () => {
    const source = createProviderPauseSourceFromPool(db.appPool);
    expect((await source.pausedProviders()).size).toBe(0);
    const oc = controls();
    await oc.freezeConnectorDurable("model:anthropic", "test", OWNER);
    await oc.freezeConnectorDurable("github", "test", OWNER);
    await oc.revokeCredentialDurable("GITHUB_TOKEN", "test", OWNER);
    expect([...(await source.pausedProviders())]).toEqual(["anthropic"]);
    await oc.revokeCredentialDurable("GEMINI_API_KEY", "test", OWNER);
    expect([...(await source.pausedProviders())].sort()).toEqual(["anthropic", "gemini", "gemma_hosted"]);
    await oc.restoreCredentialDurable("GEMINI_API_KEY", OWNER);
    await oc.restoreCredentialDurable("GITHUB_TOKEN", OWNER);
    await oc.unfreezeConnectorDurable("github", OWNER);
    await oc.unfreezeConnectorDurable("model:anthropic", OWNER);
    expect((await source.pausedProviders()).size).toBe(0);
  });

  it("kun eieren kan pause: en annen aktør nektes av OwnerControls (autoritet håndheves der, ikke i kontrollsenteret)", async () => {
    await expect(controls().freezeConnectorDurable("model:openai", "x", "person-annen")).rejects.toThrow(/owner_control_unauthorized/);
    expect((await createProviderPauseSourceFromPool(db.appPool).pausedProviders()).size).toBe(0);
  });
});

describe("L-5: frys-målet valideres ved skriving (transport + ekte database)", () => {
  const transport = () => {
    const killSwitch = new KillSwitch(db.appPool, { owner_person_id: OWNER });
    const service = new OwnerControlsService(killSwitch, controls(), undefined, { freezeTargetValidator: (t) => freezeTargetError(t) });
    return new OwnerControlsTransport(service);
  };
  const context = { identity: { person_id: OWNER, tenant_id: TENANT, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" } } as never;
  const frozenRows = async (): Promise<string[]> => (await db.adminPool.query("SELECT control_target FROM owner_control_state WHERE control_kind = 'connector_freeze' ORDER BY control_target")).rows.map((r) => String(r.control_target));

  it("model:Anthropic / model: / en leverandør ingen adapter har avvises med tydelig feil - og INGEN rad skrives (før ga det «Utført» uten pause)", async () => {
    const t = transport();
    for (const [target, error] of [["model:Anthropic", "invalid_model_freeze_target:Anthropic"], ["model:", "invalid_model_freeze_target:"], ["model:finnes_ikke", "unknown_model_provider:finnes_ikke"]] as const) {
      await expect(t.invoke("freeze_connector", { connector_id: target, reason: "x" }, "", context), target).rejects.toThrow(error);
    }
    expect(await frozenRows()).toEqual([]);
  });

  it("model:anthropic skrives og pauser leverandøren; gjenopptak av både gyldig og et gammelt ugyldig mål virker", async () => {
    const t = transport();
    await t.invoke("freeze_connector", { connector_id: "model:anthropic", reason: "test" }, "", context);
    expect(await frozenRows()).toEqual(["model:anthropic"]);
    expect([...(await createProviderPauseSourceFromPool(db.appPool).pausedProviders())]).toEqual(["anthropic"]);
    // en gammel, ugyldig rad (skrevet før valideringen fantes) kan fortsatt ryddes bort
    await controls().freezeConnectorDurable("model:Anthropic", "gammel", OWNER);
    await t.invoke("unfreeze_connector", { connector_id: "model:Anthropic" }, "", context);
    await t.invoke("unfreeze_connector", { connector_id: "model:anthropic" }, "", context);
    expect(await frozenRows()).toEqual([]);
  });
});

describe("ekte gateway: live pause uten omstart", () => {
  it("pause → umiddelbart stanset (ingen adapterkall, ingen kostrad) → gjenopptak → virker igjen, samme gateway-instans", async () => {
    const gw = gateway();
    const oc = controls();
    const before = await costRows();
    const first = await gw.complete({ tenant_id: TENANT, provider: "anthropic", purpose: "CHAT", request });
    expect(first.provider).toBe("anthropic");
    expect(await costRows()).toBe(before + 1);

    await oc.freezeConnectorDurable("model:anthropic", "kostnadskontroll", OWNER);
    const callsBefore = calls["anthropic"];
    await expect(gw.complete({ tenant_id: TENANT, provider: "anthropic", purpose: "CHAT", request })).rejects.toMatchObject({ kind: "not_configured", provider: "anthropic" });
    expect(calls["anthropic"]).toBe(callsBefore);
    expect(await costRows()).toBe(before + 1);
    // AUTO bruker en annen leverandør i stedet
    const auto = await gw.complete({ tenant_id: TENANT, mode: "QUALITY", purpose: "CHAT", request });
    expect(auto.provider).not.toBe("anthropic");

    await oc.unfreezeConnectorDurable("model:anthropic", OWNER);
    const again = await gw.complete({ tenant_id: TENANT, provider: "anthropic", purpose: "CHAT", request });
    expect(again.provider).toBe("anthropic");
  });

  it("tilbakekalt nøkkel stanser leverandøren i modellrutingen (ANTHROPIC_API_KEY), og gjenoppretting åpner den igjen", async () => {
    const gw = gateway();
    const oc = controls();
    await oc.revokeCredentialDurable("ANTHROPIC_API_KEY", "mistenkt lekkasje", OWNER);
    await expect(gw.complete({ tenant_id: TENANT, provider: "anthropic", purpose: "CHAT", request })).rejects.toMatchObject({ kind: "not_configured", message: "anthropic_paused_by_owner" });
    await oc.restoreCredentialDurable("ANTHROPIC_API_KEY", OWNER);
    expect((await gw.complete({ tenant_id: TENANT, provider: "anthropic", purpose: "CHAT", request })).provider).toBe("anthropic");
  });

  it("SECRET_RESTRICTED + pauset lokal leverandør: fail-closed, ingen skyadapter kalles", async () => {
    const gw = gateway();
    const oc = controls();
    await oc.freezeConnectorDurable("model:gemma_local", "PC-en skal stå av", OWNER);
    const cloudBefore = (calls["anthropic"] ?? 0) + (calls["openai"] ?? 0);
    const localBefore = calls["gemma_local"] ?? 0;
    await expect(gw.complete({ tenant_id: TENANT, purpose: "CHAT", sensitivity: "SECRET_RESTRICTED", request })).rejects.toBeInstanceOf(NoEligibleProviderError);
    expect((calls["anthropic"] ?? 0) + (calls["openai"] ?? 0)).toBe(cloudBefore);
    expect(calls["gemma_local"] ?? 0).toBe(localBefore);
    await oc.unfreezeConnectorDurable("model:gemma_local", OWNER);
    const ok = await gw.complete({ tenant_id: TENANT, purpose: "CHAT", sensitivity: "SECRET_RESTRICTED", request });
    expect(ok.provider).toBe("gemma_local");
  });
});
