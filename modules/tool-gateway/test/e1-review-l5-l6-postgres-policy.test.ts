import { describe, expect, it } from "vitest";
import { DEFAULT_PROTECTED_ROLES, normalizeSqlForDiagnostics, parsePostgresOpsConfig } from "../src/postgres-ops-target-policy.ts";

/**
 * Gjennomgang av PR #324.
 *
 * L5: `normalizeSqlForDiagnostics` lot hodet av en UAVSLUTTET dollar-literal slippe gjennom (`$$TOPSECRET`, `$tag$TOPSECRET`) - realistisk når `track_activity_query_size` (standard 1024 byte) kutter en lang spørring midt i en
 * literal. Det samme gjaldt en uavsluttet blokkommentar. Nå kuttes alt fra første gjenstående åpner; en uavsluttet enkeltsitat var allerede dekket (regresjonsvakt under).
 *
 * L6: `PROTECTED_ROLES` var tom som standard, så `jarvis_runtime` (appens egen tilkobling) og `jarvis_migrate` (migratoren) kunne termineres. Nå er de beskyttet som standard (kode-default); en eksplisitt liste erstatter standarden.
 */
describe("L5: uavsluttede literaler og kommentarer viser aldri hodet", () => {
  const SECRET = "TOPSECRET";
  const TRUNCATED: ReadonlyArray<readonly [string, string]> = [
    ["uavsluttet dollar-literal uten tag", `$$${SECRET}`],
    ["uavsluttet dollar-literal med tag", `$tag$${SECRET}`],
    ["etter en vanlig spørring", `SELECT * FROM t WHERE a = $$${SECRET}`],
    ["etter en avsluttet literal", `SELECT $$ok$$, $$${SECRET}`],
    ["flere ulike tagger, bare den første avsluttet", `SELECT $a$ x $b$ ${SECRET}`],
    ["tag med understrek/siffer", `UPDATE t SET c = $q_1$${SECRET} fortsetter`],
    ["uavsluttet blokkommentar", `SELECT 1 /* ${SECRET}`],
    ["uavsluttet blokkommentar etter en avsluttet", `SELECT 1 /* ok */, /* ${SECRET}`],
    ["uavsluttet enkeltsitat (regresjonsvakt)", `SELECT * FROM t WHERE a = '${SECRET}`],
    ["uavsluttet E-streng (regresjonsvakt)", `SELECT E'${SECRET}\\'`],
    ["dollar-literal som inneholder kommentartegn", `SELECT $$ -- ${SECRET}`],
    ["uavsluttet literal med linjeskift", `SELECT 1\n, $$\n${SECRET}\n`]
  ];

  it("ingen avkortet spørring lekker hodet av en uavsluttet literal/kommentar", () => {
    for (const [label, sql] of TRUNCATED) {
      const out = normalizeSqlForDiagnostics(sql);
      expect(out, label).not.toBeNull();
      expect(out, label).not.toContain(SECRET);
      expect(out, label).toContain("?");
    }
  });

  it("reviewerens eksempler gir kun markøren, og det foran åpneren beholdes (strukturen er nyttig)", () => {
    expect(normalizeSqlForDiagnostics("$$TOPSECRET")).toBe("?");
    expect(normalizeSqlForDiagnostics("$tag$TOPSECRET")).toBe("?");
    expect(normalizeSqlForDiagnostics("SELECT * FROM t WHERE a = $$TOPSECRET")).toBe("SELECT * FROM t WHERE a = ?");
    expect(normalizeSqlForDiagnostics("SELECT 1 /* TOPSECRET")).toBe("SELECT ? ?");
  });

  it("legitime konstruksjoner røres ikke: parametere ($1), identifikatorer med dollartegn, avsluttede literaler og kommentarer", () => {
    expect(normalizeSqlForDiagnostics("SELECT a FROM t WHERE x = $1 AND y = $2")).toBe("SELECT a FROM t WHERE x = $1 AND y = $2");
    expect(normalizeSqlForDiagnostics("SELECT a$b$c FROM t$x$ WHERE col$tag$ = 1")).toBe("SELECT a$b$c FROM t$x$ WHERE col$tag$ = ?");
    expect(normalizeSqlForDiagnostics("SELECT $$hemmelig$$, $tag$ også $tag$ FROM t")).toBe("SELECT ?, ? FROM t");
    expect(normalizeSqlForDiagnostics("SELECT 1 /* kommentar */ FROM t -- slutt")).toBe("SELECT ? FROM t");
    expect(normalizeSqlForDiagnostics("SELECT * FROM t WHERE a IN (1, 2, 3)")).toBe("SELECT * FROM t WHERE a IN (?)");
  });

  it("uendret grensetilfeller: null/undefined, «<insufficient privilege>», lengdekutt", () => {
    expect(normalizeSqlForDiagnostics(null)).toBeNull();
    expect(normalizeSqlForDiagnostics(undefined)).toBeNull();
    expect(normalizeSqlForDiagnostics("<insufficient privilege>")).toBe("<insufficient privilege>");
    expect(normalizeSqlForDiagnostics(`SELECT ${"abc, ".repeat(100)}x FROM t`, 20)).toHaveLength(21);
  });
});

describe("L6: jarvis_runtime og jarvis_migrate er beskyttet som standard", () => {
  it("standardlisten er appens runtime- og migrasjonsrolle", () => {
    expect([...DEFAULT_PROTECTED_ROLES]).toEqual(["jarvis_runtime", "jarvis_migrate"]);
  });

  it("tom, utelatt, blank eller kun ugyldige oppføringer gir standardlisten (aldri «ingen beskyttet rolle» ved et uhell)", () => {
    for (const raw of [undefined, "", "   ", ",,,", "bad role;DROP", "1abc", "a-b", " , "]) {
      expect([...parsePostgresOpsConfig({ protectedRoles: raw }).protectedRoles].sort(), JSON.stringify(raw)).toEqual(["jarvis_migrate", "jarvis_runtime"]);
    }
    expect([...parsePostgresOpsConfig().protectedRoles].sort()).toEqual(["jarvis_migrate", "jarvis_runtime"]);
    expect([...parsePostgresOpsConfig({ databases: "jarvis", schemas: "public" }).protectedRoles].sort()).toEqual(["jarvis_migrate", "jarvis_runtime"]);
  });

  it("en eksplisitt liste ERSTATTER standarden (eierens bevisste valg), og ugyldige enkeltoppføringer hoppes over", () => {
    expect([...parsePostgresOpsConfig({ protectedRoles: "jarvis_migrate" }).protectedRoles]).toEqual(["jarvis_migrate"]);
    expect([...parsePostgresOpsConfig({ protectedRoles: "min_rolle, bad role , annen_rolle" }).protectedRoles].sort()).toEqual(["annen_rolle", "min_rolle"]);
  });

  it("standarden er et eget sett per kall (mutasjon av ett resultat påvirker aldri neste)", () => {
    const a = parsePostgresOpsConfig().protectedRoles as Set<string>;
    a.add("x");
    expect([...parsePostgresOpsConfig().protectedRoles].sort()).toEqual(["jarvis_migrate", "jarvis_runtime"]);
  });
});
