import { describe, expect, it } from "vitest";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  CLOUDFLARE_CAPABILITIES, CLOUDFLARE_MUTATION_ACTIONS, CLOUDFLARE_ZONE_SETTINGS, INFRA_GATED_TOOL_IDS, assertDnsContent, assertDnsName, assertNameWithinZone,
  assertRateLimit, assertWafExpression, assertZoneSetting, authorizeCloudflareTarget, buildPurgeBody, cloudControlToolDefinitions, cloudflareToolDefinitions,
  dnsContentMatches, isCloudflareId, parseCloudflareMutationZones
} from "../src/index.ts";

/** WP-E1: rene enhetstester for Cloudflare-målpolicyen, validatorene, kapabilitetsmatrisen og den delte InfraExecutionGate-mengden. */
const Z = "a".repeat(32);
const Z2 = "b".repeat(32);

describe("A: sone-id-er og mål-autorisasjon (fail-closed)", () => {
  it("kun 32 tegn lowercase hex er en Cloudflare-id", () => {
    expect(isCloudflareId(Z)).toBe(true);
    for (const bad of ["", "A".repeat(32), "a".repeat(31), "a".repeat(33), "g".repeat(32), "../x", `${Z}/x`, 5, null, undefined, {}, [Z]]) expect(isCloudflareId(bad), String(bad)).toBe(false);
  });

  it("parseCloudflareMutationZones: eksakte id-er; ugyldige hoppes over uten å utvide autorisasjonen; tom/mangler gir tom mengde", () => {
    expect(parseCloudflareMutationZones(undefined)).toEqual(new Set());
    expect(parseCloudflareMutationZones("")).toEqual(new Set());
    expect(parseCloudflareMutationZones(` ${Z} , ${Z2.toUpperCase()} , *, ${Z.slice(1)}, ${Z}`)).toEqual(new Set([Z, Z2]));
    expect(parseCloudflareMutationZones("*")).toEqual(new Set());
    expect(parseCloudflareMutationZones(`${Z}/..`)).toEqual(new Set());
  });

  it("authorizeCloudflareTarget: ukjent handling, manglende/ugyldig id og sone utenfor listen nektes; bare eksakt treff tillates", () => {
    const zones = new Set([Z]);
    for (const action of CLOUDFLARE_MUTATION_ACTIONS) {
      expect(authorizeCloudflareTarget(action, Z, zones)).toEqual({ allowed: true, reason: "owner_configured_zone" });
      expect(authorizeCloudflareTarget(action, Z2, zones)).toEqual({ allowed: false, reason: "cloudflare_zone_not_authorized" });
      expect(authorizeCloudflareTarget(action, undefined, zones)).toEqual({ allowed: false, reason: "missing_or_invalid_zone_id" });
      expect(authorizeCloudflareTarget(action, Z, new Set())).toEqual({ allowed: false, reason: "cloudflare_zone_not_authorized" });
    }
    expect(authorizeCloudflareTarget("delete_zone" as never, Z, zones)).toEqual({ allowed: false, reason: "cloudflare_action_unknown" });
  });
});

describe("B: deterministiske validatorer", () => {
  it("DNS-navn: små bokstaver, lovlige etiketter, jokertegn kun som hele første etikett", () => {
    expect(assertDnsName("WWW.Example.COM")).toBe("www.example.com");
    expect(assertDnsName("*.example.com")).toBe("*.example.com");
    expect(assertDnsName("_dmarc.example.com")).toBe("_dmarc.example.com");
    for (const bad of ["", ".example.com", "example.com.", "a..b", "a b.com", "a/b.com", "a*.example.com", "x.*.example.com", `${"a".repeat(64)}.com`, `${"a.".repeat(130)}com`, "ex\u0000.com", "ex .com", 5]) {
      expect(() => assertDnsName(bad), String(bad)).toThrow(/cloudflare_invalid_name/);
    }
  });

  it("navn må ligge i sonen (også mot etterlignere som evilexample.com)", () => {
    expect(() => assertNameWithinZone("example.com", "example.com")).not.toThrow();
    expect(() => assertNameWithinZone("a.b.example.com", "example.com")).not.toThrow();
    expect(() => assertNameWithinZone("evilexample.com", "example.com")).toThrow(/name_outside_zone/);
    expect(() => assertNameWithinZone("example.com.evil.org", "example.com")).toThrow(/name_outside_zone/);
  });

  it("innhold per type: A=IPv4, AAAA=IPv6, CNAME/MX/NS=vertsnavn, TXT=fritekst uten kontrolltegn", () => {
    expect(assertDnsContent("A", "192.0.2.1")).toBe("192.0.2.1");
    expect(assertDnsContent("AAAA", "2001:db8::1")).toBe("2001:db8::1");
    expect(assertDnsContent("CNAME", "target.example.net.")).toBe("target.example.net.");
    expect(assertDnsContent("TXT", "v=spf1 -all")).toBe("v=spf1 -all");
    for (const [type, bad] of [["A", "2001:db8::1"], ["A", "256.1.1.1"], ["AAAA", "192.0.2.1"], ["CNAME", "ikke gyldig"], ["MX", "-bad.example.com"], ["TXT", "a\nb"], ["TXT", "x".repeat(2049)], ["A", ""]] as const) {
      expect(() => assertDnsContent(type, bad), `${type}:${bad}`).toThrow(/cloudflare_invalid_content/);
    }
    expect(() => assertDnsContent("SRV", "x")).toThrow(/cloudflare_invalid_type/);
  });

  it("dnsContentMatches ignorerer leverandørens normalisering (TXT-anførselstegn, etterfølgende punktum, IPv6-skrivemåte) men ikke reelle avvik", () => {
    expect(dnsContentMatches("TXT", "v=spf1 -all", '"v=spf1 -all"')).toBe(true);
    expect(dnsContentMatches("TXT", "v=spf1 -all", "v=spf1 +all")).toBe(false);
    expect(dnsContentMatches("CNAME", "Target.Example.NET", "target.example.net.")).toBe(true);
    expect(dnsContentMatches("AAAA", "2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1")).toBe(true);
    expect(dnsContentMatches("AAAA", "2001:db8::1", "2001:db8::2")).toBe(false);
    expect(dnsContentMatches("A", "192.0.2.1", "192.0.2.2")).toBe(false);
  });

  it("WAF-uttrykk: treffer-alt-vakt for blokkerende handlinger (ikke for log); lengde og tegn", () => {
    expect(assertWafExpression("ip.src eq 203.0.113.9", "block")).toBe("ip.src eq 203.0.113.9");
    expect(assertWafExpression("true", "log")).toBe("true");
    for (const bad of ["true", "( true )", "TRUE", "", "   ", "x".repeat(4097), "a\u0000b"]) expect(() => assertWafExpression(bad, "block"), bad).toThrow(/cloudflare_invalid_expression/);
  });

  it("rate limit: lukket feltsett og grenser", () => {
    expect(assertRateLimit({ characteristics: ["ip.src"], period: 60, requests_per_period: 10 })).toEqual({ characteristics: ["ip.src"], period: 60, requests_per_period: 10 });
    for (const bad of [null, [], { characteristics: ["ip.src"], period: 0, requests_per_period: 10 }, { characteristics: ["ip.src"], period: 60, requests_per_period: 0 },
      { characteristics: ["ip src"], period: 60, requests_per_period: 1 }, { characteristics: ["ip.src"], period: 60, requests_per_period: 1, extra: true }]) {
      expect(() => assertRateLimit(bad), JSON.stringify(bad)).toThrow(/cloudflare_invalid_ratelimit/);
    }
  });

  it("sone-innstillinger: kun verifiserte id-er med lukkede verdimengder (inkl. prototype-forsøk)", () => {
    expect(Object.keys(CLOUDFLARE_ZONE_SETTINGS).sort()).toEqual(["always_use_https", "development_mode", "min_tls_version", "security_level", "ssl", "tls_1_3"]);
    expect(assertZoneSetting("ssl", "strict")).toEqual({ setting_id: "ssl", value: "strict" });
    for (const [id, v] of [["ssl", "ultra"], ["constructor", "x"], ["__proto__", "x"], ["toString", "x"], ["ssl", 3], ["automatic_https_rewrites", "on"]] as const) {
      expect(() => assertZoneSetting(id, v), `${id}=${v}`).toThrow(/cloudflare_invalid_setting/);
    }
  });

  it("purge-body: nøyaktig én velger, aldri purge_everything sammen med andre", () => {
    expect(buildPurgeBody("everything", undefined, "example.com")).toEqual({ purge_everything: true });
    expect(buildPurgeBody("everything", [], "example.com")).toEqual({ purge_everything: true });
    expect(buildPurgeBody("tags", ["a", "b"], "example.com")).toEqual({ tags: ["a", "b"] });
    expect(() => buildPurgeBody("everything", ["x"], "example.com")).toThrow(/purge_items/);
    expect(() => buildPurgeBody("files", ["https://example.com.evil.org/x"], "example.com")).toThrow(/purge_item/);
  });
});

describe("C: kapabilitetsmatrisen (D-41) er ærlig og komplett", () => {
  it("hver rad har status, risikoklasse og en begrunnelse; DEFERRED-rader har aldri risikoklasse og IMPLEMENTED/PARTIAL har et token-scope", () => {
    expect(CLOUDFLARE_CAPABILITIES.length).toBeGreaterThanOrEqual(10);
    for (const c of CLOUDFLARE_CAPABILITIES) {
      expect(c.note.length, c.capability).toBeGreaterThan(20);
      expect(c.token_permission.length, c.capability).toBeGreaterThan(0);
      if (c.status === "DEFERRED") expect(c.risk, c.capability).toBe("-");
      else expect(["A", "B", "C", "D"], c.capability).toContain(c.risk);
    }
    const statuses = new Set(CLOUDFLARE_CAPABILITIES.map((c) => c.status));
    expect(statuses).toEqual(new Set(["IMPLEMENTED", "PARTIAL", "DEFERRED"]));
    // IAM-skriving er eksplisitt DEFERRED (privilegie-eskalering), ikke stille utelatt
    expect(CLOUDFLARE_CAPABILITIES.find((c) => /Tilgangsstyring \(skriv\)/.test(c.capability))?.status).toBe("DEFERRED");
  });

  it("hver implementert skrive-/lese-handling i verktøyfabrikken har en rad i matrisen som nevner dens risikoklasse", () => {
    const defs = cloudflareToolDefinitions({ invoke: async () => ({}) }, {});
    const risks = new Set(CLOUDFLARE_CAPABILITIES.filter((c) => c.status !== "DEFERRED").map((c) => c.risk));
    for (const d of defs) expect(risks.has(d.capability_class), d.action).toBe(true);
  });
});

describe("D: INFRA_GATED_TOOL_IDS - en infra-pause stanser ALLE kontrollerte mål, aldri lesing", () => {
  it("PAUSED nekter B/C/D og DEGRADED nekter D for hvert id i mengden; klasse A passerer alltid", async () => {
    expect([...INFRA_GATED_TOOL_IDS].sort()).toEqual(["cloudflare", "docker", "gce", "github", "infisical", "langfuse", "postgres_ops", "vercel"]);
    const owner = { person_id: "p", tenant_id: "t", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" } as const;
    for (const id of INFRA_GATED_TOOL_IDS) {
      const infraGate = new InfraExecutionGate();
      const policy = new PolicyGateway({
        devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), infraGate, infraToolIds: INFRA_GATED_TOOL_IDS,
        authority: { owner_person_id: "p", owner_tenants: ["t"] }
      });
      const decide = (cls: "A" | "B" | "C" | "D") => policy.authorize({ identity: owner, toolCall: { tool_id: id, action: "x", capability_class: cls, parameters: {} } });
      infraGate.pause("test");
      expect((await decide("A")).decision, `${id} A paused`).toBe("ALLOW");
      for (const cls of ["B", "C", "D"] as const) expect((await decide(cls)).decision, `${id} ${cls} paused`).toBe("DENY");
      infraGate.degrade("test");
      expect((await decide("C")).decision, `${id} C degraded`).toBe("ALLOW");
      expect((await decide("D")).decision, `${id} D degraded`).toBe("DENY");
    }
  });

  it("fabrikken gir sovende Cloudflare-verktøy uten transport (UnconfiguredHttpTransport kaster) og uten mutasjonssoner", async () => {
    const defs = cloudControlToolDefinitions();
    expect(defs.every((d) => d.tool_id === "cloudflare" || ["langfuse", "infisical", "postgres_ops"].includes(d.tool_id))).toBe(true);
    const create = defs.find((d) => d.action === "create_dns_record")!;
    expect(create.parameterAuthorizer!({ zone_id: Z }, {} as never)).toEqual({ allowed: false, reason: "cloudflare_zone_not_authorized" });
    await expect(create.transport.invoke("create_dns_record", {}, "x", {} as never)).rejects.toThrow("cloudflare_not_configured");
  });
});
