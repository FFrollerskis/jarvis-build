import { describe, expect, it } from "vitest";
import { MAX_OWNER_EXTRA_TENANTS, OwnerConfigError, describeOwnerConfigError, loadOwnerConfig, ownerTenantsFromEnv, systemIdentity } from "../src/owner-config.ts";

const OK = { JARVIS_TENANT_ID: "tenant-acme", JARVIS_OWNER_PERSON_ID: "person-ola", JARVIS_OWNER_NAME: "Ola Nordmann" };

describe("Remediering del 2 (JARVIS-065): loadOwnerConfig - én validert eier-identitet, fail closed", () => {
  it("leser og normaliserer gyldig konfig", () => {
    expect(loadOwnerConfig({ ...OK, JARVIS_OWNER_NAME: "  Ola Nordmann " })).toEqual({
      tenant_id: "tenant-acme", owner_person_id: "person-ola", owner_display_name: "Ola Nordmann"
    });
  });
  it.each(["JARVIS_TENANT_ID", "JARVIS_OWNER_PERSON_ID", "JARVIS_OWNER_NAME"])("mangler %s -> owner_config_missing (ingen default)", (name) => {
    for (const value of [undefined, "", "   "]) {
      const env: Record<string, string | undefined> = { ...OK, [name]: value };
      expect(() => loadOwnerConfig(env)).toThrow(OwnerConfigError);
      try { loadOwnerConfig(env); } catch (err) {
        expect((err as OwnerConfigError).code).toBe("owner_config_missing");
        expect((err as OwnerConfigError).variable).toBe(name);
      }
    }
  });
  it.each(["Tenant With Space", "UPPER", "a", "../x", "x;drop", "a".repeat(65), "tenant\nid"])("ugyldig id %j avvises", (bad) => {
    expect(() => loadOwnerConfig({ ...OK, JARVIS_TENANT_ID: bad })).toThrow(/owner_config_invalid/);
    expect(() => loadOwnerConfig({ ...OK, JARVIS_OWNER_PERSON_ID: bad })).toThrow(/owner_config_invalid/);
  });
  it("ugyldig visningsnavn (kontrolltegn, <>, for langt) avvises", () => {
    for (const bad of ["a\u0000b", "<script>", "x".repeat(81)]) {
      expect(() => loadOwnerConfig({ ...OK, JARVIS_OWNER_NAME: bad })).toThrow(/owner_config_invalid/);
    }
  });
  it("feilmeldingen inneholder kun kode + variabelnavn, aldri verdien", () => {
    try { loadOwnerConfig({ ...OK, JARVIS_TENANT_ID: "Secret Value!" }); } catch (err) {
      expect((err as Error).message).not.toContain("Secret");
      expect(describeOwnerConfigError(err)).toContain("JARVIS_TENANT_ID");
      expect(describeOwnerConfigError(err)).not.toContain("Secret");
    }
  });
});

describe("systemIdentity: unike, ikke-falske sesjoner", () => {
  const owner = loadOwnerConfig(OK);
  it("bruker eierens tenant/person, kanal 'system', og unik sesjons-id per kall", () => {
    const a = systemIdentity(owner, "brief");
    const b = systemIdentity(owner, "brief");
    expect(a.person_id).toBe("person-ola");
    expect(a.tenant_id).toBe("tenant-acme");
    expect(a.channel).toBe("system");
    expect(a.session_id).toMatch(/^sess-sys-brief-[0-9a-f]{8}$/);
    expect(a.session_id).not.toBe(b.session_id);
    for (const fixed of ["sess-brief", "sess-worker", "sess-coding"]) expect(a.session_id).not.toBe(fixed);
  });
  it("overrides gjelder, ugyldig formål kaster", () => {
    expect(systemIdentity(owner, "worker", { channel: "api" }).channel).toBe("api");
    expect(() => systemIdentity(owner, "Bad Purpose")).toThrow("system_identity_purpose_invalid");
  });
});

describe("WP-D2 (Q-44/Q-48 C): ownerTenantsFromEnv - dormant utvidelse, standard uendret", () => {
  const owner = loadOwnerConfig(OK);
  it("uten variabel (eller tom/kun blanke) er listen NØYAKTIG [JARVIS_TENANT_ID] - standardoppførselen er uendret", () => {
    for (const value of [undefined, "", "   ", "\n"]) {
      expect(ownerTenantsFromEnv(owner, { JARVIS_OWNER_EXTRA_TENANTS: value })).toEqual(["tenant-acme"]);
    }
    expect(ownerTenantsFromEnv(owner, {})).toEqual(["tenant-acme"]);
  });
  it("utvider med gyldige ekstra tenants (komma/mellomrom), eierens egen tenant først, uten duplikater", () => {
    expect(ownerTenantsFromEnv(owner, { JARVIS_OWNER_EXTRA_TENANTS: "tenant-kundeoppfolging, tenant-annet" })).toEqual(["tenant-acme", "tenant-kundeoppfolging", "tenant-annet"]);
    expect(ownerTenantsFromEnv(owner, { JARVIS_OWNER_EXTRA_TENANTS: "tenant-acme,tenant-b,tenant-b" })).toEqual(["tenant-acme", "tenant-b"]);
    expect(ownerTenantsFromEnv(owner, { JARVIS_OWNER_EXTRA_TENANTS: ",,tenant-b,," })).toEqual(["tenant-acme", "tenant-b"]);
  });
  it.each(["Tenant With Space!", "UPPER", "a", "../x", "x;drop table tenants", "a".repeat(65), "tenant-ok,BAD", "tenant-ok;tenant-b", "tenant\u0000x", "*", "tenant-ok,*"])(
    "ugyldig verdi %j stopper oppstarten (fail closed) - aldri en stille delvis liste",
    (bad) => {
      expect(() => ownerTenantsFromEnv(owner, { JARVIS_OWNER_EXTRA_TENANTS: bad })).toThrow(OwnerConfigError);
      try { ownerTenantsFromEnv(owner, { JARVIS_OWNER_EXTRA_TENANTS: bad }); } catch (err) {
        expect((err as OwnerConfigError).variable).toBe("JARVIS_OWNER_EXTRA_TENANTS");
        expect(describeOwnerConfigError(err)).not.toContain(bad.slice(0, 6) === "tenant" ? "drop" : "\u0000");
      }
    }
  );
  it("for mange ekstra tenants avvises (sikkerhetsflaten skal være liten)", () => {
    const many = Array.from({ length: MAX_OWNER_EXTRA_TENANTS + 1 }, (_, i) => `tenant-x${i}`).join(",");
    expect(() => ownerTenantsFromEnv(owner, { JARVIS_OWNER_EXTRA_TENANTS: many })).toThrow(OwnerConfigError);
    const ok = Array.from({ length: MAX_OWNER_EXTRA_TENANTS }, (_, i) => `tenant-x${i}`).join(",");
    expect(ownerTenantsFromEnv(owner, { JARVIS_OWNER_EXTRA_TENANTS: ok })).toHaveLength(MAX_OWNER_EXTRA_TENANTS + 1);
  });
  it("listen gir ingenting til noen annen person: den er kun en tenant-liste, ingen person-id", () => {
    const tenants = ownerTenantsFromEnv(owner, { JARVIS_OWNER_EXTRA_TENANTS: "tenant-b" });
    expect(tenants.every((t) => t.startsWith("tenant-"))).toBe(true);
    expect(JSON.stringify(tenants)).not.toContain("person-");
  });
});
