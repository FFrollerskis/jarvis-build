import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ownerTenantsFromEnv, systemIdentity } from "@jarvis/contracts";
import { resolveAuthorityMode, type AuthorityConfig } from "../src/authority.ts";

/**
 * WP-D2, gjennomgang av PR #326 (F1): hva `JARVIS_OWNER_EXTRA_TENANTS` faktisk gir, festet i en test slik at dokumentasjonen ikke kan drive fra virkeligheten igjen. Autoriteten avgjøres av PERSON + TENANT (+ ingen delegasjon), ikke av kanal:
 * eierens egne planlagte jobber (brief, situasjonssveip - `systemIdentity(owner, ...)` med eierens person-id) er suverene i en utvidet tenant, akkurat som i primær-tenanten; `person_id: "system"`, delegater og andre personer er det ikke.
 */
const owner = { tenant_id: "tenant-primary", owner_person_id: "person-tobias", owner_display_name: "Tobias" };
const authority = (extra: string): AuthorityConfig => ({ owner_person_id: owner.owner_person_id, owner_tenants: ownerTenantsFromEnv(owner, { JARVIS_OWNER_EXTRA_TENANTS: extra }) });
const base = (over: Partial<IdentityContext>): IdentityContext => ({
  person_id: "person-tobias", tenant_id: "tenant-biz", memory_space_id: "business", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "signed", ...over
});

describe("JARVIS_OWNER_EXTRA_TENANTS: hvem er suveren i den utvidede tenanten", () => {
  const cfg = authority("tenant-biz");

  it("eieren (signert økt) er suveren", () => {
    expect(resolveAuthorityMode(cfg, base({}))).toBe("SOVEREIGN");
  });

  it("eierens EGNE planlagte jobber (systemIdentity med eierens person-id, kanal system, aktiv) er suverene - som i primær-tenanten (dokumentert valg, NEEDS_TOBIAS)", () => {
    const job = systemIdentity(owner, "situation-sweep", { tenant_id: "tenant-biz", memory_space_id: "business" });
    expect(job.channel).toBe("system");
    expect(resolveAuthorityMode(cfg, job)).toBe("SOVEREIGN");
    expect(resolveAuthorityMode(cfg, { ...job, tenant_id: owner.tenant_id })).toBe("SOVEREIGN"); // samme som i primær-tenanten
  });

  it("person_id «system» er IKKE suveren (heller ikke i primær-tenanten) - Q-48-jobbene forblir avvist", () => {
    expect(resolveAuthorityMode(cfg, base({ person_id: "system" }))).toBe("SCOPED");
    expect(resolveAuthorityMode(cfg, base({ person_id: "system", tenant_id: owner.tenant_id }))).toBe("SCOPED");
  });

  it("delegat (selv med eierens person-id) og andre personer er IKKE suverene", () => {
    expect(resolveAuthorityMode(cfg, base({ delegation_id: "deleg-1" }))).toBe("SCOPED");
    expect(resolveAuthorityMode(cfg, base({ person_id: "person-annen" }))).toBe("SCOPED");
    expect(resolveAuthorityMode(cfg, base({ person_id: "person-gjest", tenant_id: "tenant-biz", memory_space_id: "guest" }))).toBe("SCOPED");
  });

  it("en tenant som IKKE står i listen gir ikke suverenitet, og uten konfigurasjon er alt SCOPED (legacy)", () => {
    expect(resolveAuthorityMode(cfg, base({ tenant_id: "tenant-annen" }))).toBe("SCOPED");
    expect(resolveAuthorityMode(undefined, base({}))).toBe("SCOPED");
  });

  it("uten JARVIS_OWNER_EXTRA_TENANTS er bare primær-tenanten suveren (standard, uendret)", () => {
    const standard: AuthorityConfig = { owner_person_id: owner.owner_person_id, owner_tenants: ownerTenantsFromEnv(owner, {}) };
    expect(standard.owner_tenants).toEqual(["tenant-primary"]);
    expect(resolveAuthorityMode(standard, base({}))).toBe("SCOPED");
    expect(resolveAuthorityMode(standard, base({ tenant_id: "tenant-primary" }))).toBe("SOVEREIGN");
  });
});
