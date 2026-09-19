import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateMigrationEvidence, UA10_REQUIRED_MIGRATIONS } from "../scripts/lib/migration-evidence.ts";

/**
 * Regresjonsvakt for host-funn run_id `2105bb7d` (D-160 I): harnessens
 * migrasjonsbevis skal bevise DET UA-10 TRENGER (055/056/057 unike, ordnet,
 * anvendt) - og ALDRI feile på historiske, migrator-støttede prefiks-
 * duplikater i `schema_migrations` (navn som ikke lenger finnes i repoet).
 * Samtidig skal en EKTE kollisjon aldri skjules.
 */
const REPO_FILES = readdirSync(fileURLToPath(new URL("../../core/src/db/migrations/", import.meta.url))).filter((f) =>
  /^\d{3}_.*\.sql$/.test(f)
);
const t = (iso: string) => iso;
const baseline = REPO_FILES.map((name, i) => ({ name, applied_at: t(`2026-09-01T00:00:${String(i).padStart(2, "0")}Z`) }));

describe("migration-evidence: repoets faktiske migrasjonsmappe", () => {
  it("repoet har unike prefikser og inneholder 055/056/057", () => {
    const ev = evaluateMigrationEvidence(baseline, REPO_FILES);
    expect(ev.repo_prefix_collisions).toEqual([]);
    expect(ev.required_missing).toEqual([]);
    expect(ev.ok).toBe(true);
  });
});

describe("migration-evidence: hostens historiske tilstand (run_id 2105bb7d) er LEGITIM", () => {
  it("historiske orphan-rader med delt prefiks (014_pgvector_embeddings.sql, 023_zendesk_support.sql) gir PASS og rapporteres eksplisitt", () => {
    const rows = [
      ...baseline,
      { name: "014_pgvector_embeddings.sql", applied_at: t("2026-08-13T10:00:00Z") },
      { name: "023_zendesk_support.sql", applied_at: t("2026-08-18T10:00:00Z") }
    ];
    const ev = evaluateMigrationEvidence(rows, REPO_FILES);
    expect(ev.ok).toBe(true);
    expect(ev.historical_prefix_duplicates).toEqual([
      "014:014_embeddings_pgvector.sql,014_pgvector_embeddings.sql",
      "023:023_business_tenant_catalog.sql,023_zendesk_support.sql"
    ]);
    expect(ev.orphan_rows).toEqual(["014_pgvector_embeddings.sql", "023_zendesk_support.sql"]);
    expect(ev.required_prefix_collisions).toEqual([]);
    expect(ev.applied_in_order).toBe(true);
  });
  it("den GAMLE, for brede harness-påstanden (ingen prefiks-duplikat i hele tabellen) ville feilet på nøyaktig denne tilstanden", () => {
    const rows = [...baseline, { name: "014_pgvector_embeddings.sql", applied_at: t("2026-08-13T10:00:00Z") }];
    const oldAssertion = new Map<string, number>();
    for (const r of rows) oldAssertion.set(r.name.slice(0, 3), (oldAssertion.get(r.name.slice(0, 3)) ?? 0) + 1);
    expect([...oldAssertion.values()].some((n) => n > 1)).toBe(true); // gammel påstand: FAIL
    expect(evaluateMigrationEvidence(rows, REPO_FILES).ok).toBe(true); // ny påstand: PASS
  });
});

describe("migration-evidence: EKTE kollisjoner skjules aldri", () => {
  it("en ekstra rad med prefiks 057 som ikke er 057_situations_activation.sql => FAIL (required_prefix_collisions)", () => {
    const rows = [...baseline, { name: "057_other.sql", applied_at: t("2026-09-02T00:00:00Z") }];
    const ev = evaluateMigrationEvidence(rows, REPO_FILES);
    expect(ev.ok).toBe(false);
    expect(ev.required_prefix_collisions).toEqual(["057_other.sql"]);
  });
  it("manglende 056 => FAIL", () => {
    const rows = baseline.filter((r) => r.name !== "056_situations.sql");
    const ev = evaluateMigrationEvidence(rows, REPO_FILES);
    expect(ev.ok).toBe(false);
    expect(ev.required_missing).toEqual(["056_situations.sql"]);
    expect(ev.applied_in_order).toBe(false);
  });
  it("057 anvendt FØR 056 => FAIL (applied_in_order=false)", () => {
    const rows = baseline.map((r) =>
      r.name === "057_situations_activation.sql" ? { ...r, applied_at: t("2026-08-01T00:00:00Z") } : r
    );
    const ev = evaluateMigrationEvidence(rows, REPO_FILES);
    expect(ev.ok).toBe(false);
    expect(ev.applied_in_order).toBe(false);
  });
  it("to filer i REPOET med samme prefiks (migratoren ville anvendt begge) => FAIL (repo_prefix_collisions)", () => {
    const files = [...REPO_FILES, "057_duplicate.sql"];
    const ev = evaluateMigrationEvidence(baseline, files);
    expect(ev.ok).toBe(false);
    expect(ev.repo_prefix_collisions).toEqual(["057:057_duplicate.sql,057_situations_activation.sql"]);
  });
  it("kravlisten er nøyaktig 055/056/057", () => {
    expect([...UA10_REQUIRED_MIGRATIONS]).toEqual(["055_vision.sql", "056_situations.sql", "057_situations_activation.sql"]);
  });
});
