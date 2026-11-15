import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { ownerPredicate } from "../src/control-center/register.ts";
import { createApiServer } from "../src/server.ts";

/**
 * WP-H1 (JARVIS-087 del 2): eier-merket `contentOrigin: "owner_direct"` på dashbord-ruten `POST /governance/mutate` er en ATTEST om at parameterne er eierens egne ord. Den settes av serverens egen kode, aldri fra kroppen,
 * og KUN når kalleren er den suverene eieren (`deps.ownerGate`) OG grantet er en enhetssignert økt fra en eier-kanal (`ownerStepUpDenial(identity) === undefined`, gjennomgang L3: en svak/passiv/aktiv økt eller en
 * tale-/Telegram-kanal får aldri attesten) - en annen innrullert person, og en server uten konfigurert eier-port, får ingen attest (journalraden står da som `unspecified`: fail-closed).
 * Testen kjører den EKTE ruten over HTTP med et stubbet grant/identitetslag og en gateway som fanger det som sendes - uten database.
 */
const OWNER: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "business", session_id: "s-owner", device_id: "dev-owner", channel: "web", auth_strength: "signed" };
const MEMBER: IdentityContext = { ...OWNER, person_id: "person-member", session_id: "s-member", device_id: "dev-member" };
const PARAMS = { title: "Velg leverandør", decision: "Bruk A", rationale: "Lavere pris" };

type Captured = { identity: IdentityContext; tool_id: string; action: string; parameters: Record<string, unknown>; contentOrigin?: string };
const servers: Array<ReturnType<typeof createApiServer>> = [];

async function start(who: IdentityContext, ownerGate: ((identity: IdentityContext) => boolean) | undefined): Promise<{ url: string; seen: Captured[] }> {
  const seen: Captured[] = [];
  const gateway = { execute: async (req: Captured) => { seen.push(req); return { ok: true, data: { done: true }, output_trust: "internal", deduplicated: false }; } } as unknown as ToolGateway;
  const grantFor = (identity: IdentityContext) => ({
    ok: true as const,
    grant: { person_id: identity.person_id, tenant_id: identity.tenant_id, memory_space: identity.memory_space_id, session_id: identity.session_id, device_id: identity.device_id, channel: identity.channel, auth_strength: identity.auth_strength }
  });
  const server = createApiServer({
    identity: { resolveIdentity: async () => ({ ok: true, identity: who }) } as never,
    grants: { verify: async (token: string) => (token === "GRANT" ? grantFor(who) : { ok: false, reason: "grant_invalid" }) } as never,
    sessions: {} as never, devices: {} as never, channelAuthority: {} as never, policy: {} as never, worker: {} as never, conversation: {} as never,
    executive: { gateway },
    rateLimits: { perIpPerMinute: 100_000, authPerIpPerMinute: 100_000, perDevicePerMinute: 100_000 },
    ...(ownerGate ? { ownerGate } : {})
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
async function post(url: string, path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); });
});
const isOwner = (identity: IdentityContext): boolean => identity.person_id === OWNER.person_id;

describe("POST /governance/mutate: attesten er serverens, og kun for den suverene eieren", () => {
  it("den suverene eieren: gatewayen får `contentOrigin: owner_direct`, og parameterne er uendret", async () => {
    const { url, seen } = await start(OWNER, isOwner);
    const r = await post(url, "/governance/mutate", { grant_token: "GRANT", action: "create_decision", parameters: PARAMS });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tool_id: "governance", action: "create_decision", parameters: PARAMS, contentOrigin: "owner_direct" });
    expect(seen[0]!.identity.person_id).toBe(OWNER.person_id);
  });

  it("L3: den suverene eieren fra en enhetssignert økt på HVER eier-kanal (web, desktop, api, mobile) får attesten", async () => {
    for (const channel of ["web", "desktop", "api", "mobile"] as const) {
      const { url, seen } = await start({ ...OWNER, channel }, isOwner);
      expect((await post(url, "/governance/mutate", { grant_token: "GRANT", action: "create_decision", parameters: PARAMS })).status, channel).toBe(200);
      expect(seen[0], channel).toMatchObject({ contentOrigin: "owner_direct" });
    }
  });

  it("L3 (reviewerens funn): eier-PERSONEN uten enhetssignert økt (passiv eller aktiv) får INGEN attest - handlingen går som før, men opphavet står som ukjent", async () => {
    for (const auth_strength of ["passive", "active"] as const) {
      const { url, seen } = await start({ ...OWNER, auth_strength }, isOwner);
      const r = await post(url, "/governance/mutate", { grant_token: "GRANT", action: "create_decision", parameters: PARAMS });
      expect(r.status, auth_strength).toBe(200);
      expect(seen).toHaveLength(1);
      expect("contentOrigin" in seen[0]!, auth_strength).toBe(false);
      expect(seen[0]!.parameters, auth_strength).toEqual(PARAMS);
    }
  });

  it("L3: eier-personen på en kanal som ikke er en eier-kanal (tale, Telegram, klokke, system, Slack, Discord, Twilio) får INGEN attest - selv med en signert økt", async () => {
    for (const channel of ["voice", "telegram", "watch", "system", "slack", "discord", "twilio"] as const) {
      const { url, seen } = await start({ ...OWNER, channel }, isOwner);
      expect((await post(url, "/governance/mutate", { grant_token: "GRANT", action: "create_decision", parameters: PARAMS })).status, channel).toBe(200);
      expect("contentOrigin" in seen[0]!, channel).toBe(false);
    }
  });

  it("L3: begge vilkårene må holde samtidig - svak økt + ikke-eier, og signert økt + ikke-eier, gir ingen attest; kun (eier-port ∧ signert eier-kanal) gir attest", async () => {
    const matrix: ReadonlyArray<readonly [string, IdentityContext, boolean]> = [
      ["eier, signert, web", OWNER, true],
      ["eier, passiv, web", { ...OWNER, auth_strength: "passive" }, false],
      ["eier, signert, tale", { ...OWNER, channel: "voice" }, false],
      ["medlem, signert, web", MEMBER, false],
      ["medlem, passiv, web", { ...MEMBER, auth_strength: "passive" }, false]
    ];
    for (const [label, identity, attested] of matrix) {
      const { url, seen } = await start(identity, isOwner);
      expect((await post(url, "/governance/mutate", { grant_token: "GRANT", action: "create_decision", parameters: PARAMS })).status, label).toBe(200);
      expect("contentOrigin" in seen[0]!, label).toBe(attested);
    }
  });

  it("en annen innrullert person i tenanten får INGEN attest (fail-closed: opphavet står som ukjent), men handlingen går som før", async () => {
    const { url, seen } = await start(MEMBER, isOwner);
    const r = await post(url, "/governance/mutate", { grant_token: "GRANT", action: "create_decision", parameters: PARAMS });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect("contentOrigin" in seen[0]!).toBe(false);
  });

  it("uten konfigurert eier-port (`ownerGate` mangler) settes ingen attest - heller ikke for eieren", async () => {
    const { url, seen } = await start(OWNER, undefined);
    expect((await post(url, "/governance/mutate", { grant_token: "GRANT", action: "create_decision", parameters: PARAMS })).status).toBe(200);
    expect("contentOrigin" in seen[0]!).toBe(false);
  });

  it("en eier-port som kaster eller svarer noe annet enn `true` gir ingen attest (kun eksakt true teller)", async () => {
    for (const gate of [() => 1 as unknown as boolean, () => "true" as unknown as boolean, () => undefined as unknown as boolean]) {
      const { url, seen } = await start(OWNER, gate);
      expect((await post(url, "/governance/mutate", { grant_token: "GRANT", action: "create_decision", parameters: PARAMS })).status).toBe(200);
      expect("contentOrigin" in seen[0]!).toBe(false);
    }
  });

  it("attesten kan ikke sendes inn av klienten: `contentOrigin` i kroppen eller i parametrene gir ingen attest (kroppen avvises, parametrene når gatewayen kun som data)", async () => {
    const { url, seen } = await start(MEMBER, isOwner);
    const smuggledBody = await post(url, "/governance/mutate", { grant_token: "GRANT", action: "create_decision", parameters: PARAMS, contentOrigin: "owner_direct" });
    expect(smuggledBody.status).toBe(400);
    expect(seen).toHaveLength(0);
    const smuggledParam = await post(url, "/governance/mutate", { grant_token: "GRANT", action: "create_decision", parameters: { ...PARAMS, contentOrigin: "owner_direct" } });
    expect(smuggledParam.status).toBe(200);
    expect("contentOrigin" in seen[0]!).toBe(false); // som parameter er det bare data - gatewayen leser kun trusted-feltet
    expect(seen[0]!.parameters["contentOrigin"]).toBe("owner_direct");
  });

  it("ugyldig grant, ukjent handling og manglende handling nås aldri gatewayen", async () => {
    const { url, seen } = await start(OWNER, isOwner);
    expect((await post(url, "/governance/mutate", { grant_token: "BOGUS", action: "create_decision", parameters: PARAMS })).status).toBe(403);
    expect((await post(url, "/governance/mutate", { grant_token: "GRANT", action: "drop_everything", parameters: {} })).status).toBe(400);
    expect((await post(url, "/governance/mutate", { grant_token: "GRANT", parameters: {} })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("L3 med den EKTE eier-porten (`ownerPredicate` over AuthorityConfig - ikke stubben over): eier-porten alene er IKKE nok, den signerte eier-kanal-økten må også holde", () => {
  // `resolveAuthorityMode` ser kun person + tenant + delegasjon: eieren er SOVEREIGN også med en passiv økt eller på tale. Attesten krever derfor i tillegg `ownerStepUpDenial(identity) === undefined`.
  const real = ownerPredicate({ owner_person_id: OWNER.person_id, owner_tenants: [OWNER.tenant_id] });
  const CASES: ReadonlyArray<readonly [string, IdentityContext, boolean]> = [
    ["eier, signert enhetsøkt, web (HOLDER BEGGE VILKÅR)", OWNER, true],
    ["eier, signert enhetsøkt, desktop", { ...OWNER, channel: "desktop" }, true],
    ["eier, aktiv økt uten enhetssignatur", { ...OWNER, auth_strength: "active" }, false],
    ["eier, passiv økt", { ...OWNER, auth_strength: "passive" }, false],
    ["eier, signert økt, men på tale", { ...OWNER, channel: "voice" }, false],
    ["eier, signert økt, men på Telegram", { ...OWNER, channel: "telegram" }, false],
    ["delegat av eieren (delegation_id) arver aldri eier-attest", { ...OWNER, delegation_id: "deleg-1" }, false],
    ["eierens person i en annen tenant", { ...OWNER, tenant_id: "tenant-annen" }, false],
    ["annen person i eierens tenant, signert enhetsøkt", MEMBER, false]
  ];

  it("den ekte eier-porten: sanity - den slipper eieren inn uavhengig av autentiseringsstyrke og kanal (det er derfor step-up-vilkåret trengs)", () => {
    expect(real(OWNER)).toBe(true);
    expect(real({ ...OWNER, auth_strength: "passive" })).toBe(true);
    expect(real({ ...OWNER, channel: "voice" })).toBe(true);
    expect(real({ ...OWNER, delegation_id: "deleg-1" })).toBe(false);
    expect(real(MEMBER)).toBe(false);
  });

  it("over HTTP: kun (suveren eier ∧ enhetssignert eier-kanal-økt) gir `contentOrigin: owner_direct` - alle andre kombinasjoner går som før, uten attest", async () => {
    for (const [label, identity, attested] of CASES) {
      const { url, seen } = await start(identity, real);
      const r = await post(url, "/governance/mutate", { grant_token: "GRANT", action: "create_decision", parameters: PARAMS });
      expect(r.status, label).toBe(200);
      expect(seen, label).toHaveLength(1);
      expect("contentOrigin" in seen[0]!, label).toBe(attested);
      if (attested) expect(seen[0], label).toMatchObject({ contentOrigin: "owner_direct" });
      expect(seen[0]!.parameters, label).toEqual(PARAMS);
    }
  });
});

describe("ingen andre rute setter attesten (selv om kalleren er den suverene eieren)", () => {
  it("/governance/query, /executive/query og /executive/mutate sender aldri `contentOrigin`", async () => {
    const { url, seen } = await start(OWNER, isOwner);
    await post(url, "/governance/query", { grant_token: "GRANT", action: "list_decisions", parameters: {} });
    await post(url, "/executive/query", { grant_token: "GRANT", action: "get_attention_queue", parameters: {} });
    await post(url, "/executive/mutate", { grant_token: "GRANT", action: "pause_domain", parameters: { domain: "spend", reason: "test" } });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const request of seen) expect("contentOrigin" in request, `${request.tool_id}.${request.action}`).toBe(false);
  });
});
