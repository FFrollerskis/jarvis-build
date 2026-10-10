import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { CloudflareTransport } from "../src/cloudflare-transport.ts";
import { FakeCloudflare, hex32 } from "./support/fake-cloudflare.ts";

/**
 * Gjennomgang av PR #324 (L7): en `create_*` som treffer en IDENTISK, allerede eksisterende ressurs har ikke OPPRETTET noe. Transporten journalførte likevel den eksisterende postens/regelens id som `external_id`
 * (= «det Jarvis opprettet»). Fantes ressursen fra før preflight, sto den i før-tilstanden og recovery lot den være; men oppsto den MELLOM preflight og kallet (en tredjepart la inn en identisk post), sto den
 * ikke i før-tilstanden - og kompensasjonen SLETTET en ressurs Jarvis aldri opprettet. Nå returnerer transporten `already_existed: true` UTEN `external_id`. (Recovery-siden: `modules/incidents/test/e1-review-l7-*`.)
 */
let cf: FakeCloudflare;
const transport = () => new CloudflareTransport({ baseUrl: cf.baseUrl, accountId: async () => cf.accountId, sleep: async () => undefined });
const call = (action: string, params: Record<string, JsonValue>) => transport().invoke(action, params, cf.token);
const freshZone = (): { id: string; name: string } => {
  const name = `z${hex32().slice(0, 8)}.example.com`;
  return { id: cf.addZone(name), name };
};
const PHASE = "http_request_firewall_custom";

beforeAll(async () => {
  cf = new FakeCloudflare();
  await cf.start();
});
afterAll(async () => {
  await cf.stop();
});

describe("DNS: en identisk post som fantes opprettes ikke på nytt, og ER ikke noe Jarvis opprettet", () => {
  it("identisk post fra før: `already_existed: true`, den eksisterende postens id i data - men INGEN `external_id`, og ingen skriving", async () => {
    const z = freshZone();
    const existing = cf.seedDns(z.id, { type: "A", name: `www.${z.name}`, content: "192.0.2.10" });
    cf.requests.length = 0;
    const r = await call("create_dns_record", { zone_id: z.id, type: "A", name: `www.${z.name}`, content: "192.0.2.10" });
    expect(r.external_id).toBeUndefined();
    expect("external_id" in r).toBe(false);
    expect(r.data).toMatchObject({ id: existing, already_existed: true });
    expect(cf.writeRequests()).toHaveLength(0);
  });

  it("kontroll: en ny post gir `external_id` = den opprettede postens id og INGEN `already_existed`", async () => {
    const z = freshZone();
    const r = await call("create_dns_record", { zone_id: z.id, type: "A", name: `ny.${z.name}`, content: "192.0.2.11" });
    expect(r.external_id).toMatch(/^[0-9a-f]{32}$/);
    expect(cf.dns.get(z.id)!.has(r.external_id!)).toBe(true);
    expect((r.data as Record<string, unknown>)["already_existed"]).toBeUndefined();
  });
});

describe("WAF: en identisk regel som fantes opprettes ikke på nytt, og ER ikke noe Jarvis opprettet", () => {
  it("identisk regel fra før: `already_existed: true` med regelen i data, ingen `external_id`, ingen skriving", async () => {
    const z = freshZone();
    const seeded = cf.seedRule(z.id, PHASE, { action: "block", expression: "ip.src eq 203.0.113.20", description: "fra før" });
    cf.requests.length = 0;
    const r = await call("create_waf_rule", { zone_id: z.id, phase: PHASE, action: "block", expression: "ip.src eq 203.0.113.20", description: "fra før" });
    expect("external_id" in r).toBe(false);
    expect(r.data).toMatchObject({ ruleset_id: seeded.rulesetId, rule: { id: seeded.ruleId }, already_existed: true });
    expect(cf.writeRequests()).toHaveLength(0);
  });

  it("kontroll: en ny regel gir `external_id` = den opprettede regelens id og INGEN `already_existed`", async () => {
    const z = freshZone();
    const r = await call("create_waf_rule", { zone_id: z.id, phase: PHASE, action: "block", expression: "ip.src eq 203.0.113.21", description: "ny" });
    expect(r.external_id).toMatch(/^[0-9a-f]{32}$/);
    expect(cf.rulesets.get(z.id)!.get(PHASE)!.rules.some((x) => x.id === r.external_id)).toBe(true);
    expect((r.data as Record<string, unknown>)["already_existed"]).toBeUndefined();
  });
});
