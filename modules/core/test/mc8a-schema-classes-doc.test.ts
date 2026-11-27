import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXCEPTION_ELIGIBLE_RULES, RULES, SCHEMA_CLASSES, loadManifest } from "@jarvis/core/testing";

/**
 * WP-MC8a K7: runbooken (`docs/runbooks/WPMC8A_SCHEMA_CLASSIFICATION.md`) er den eneste forklaringen på hvordan en ny tabell klassifiseres. Vakten hindrer at den råtner:
 * hver regel-ID, hver klasse, kommandoene og de FROSNE tallene (baseline) må stå i dokumentet, og dokumentet må si ærlig hva som ikke er verifisert.
 */
const RUNBOOK = readFileSync(fileURLToPath(new URL("../../../docs/runbooks/WPMC8A_SCHEMA_CLASSIFICATION.md", import.meta.url)), "utf8");
const MANIFEST = loadManifest();

describe("runbook-vakt", () => {
  it("hver regel-ID (alle 49) og hver klasse står i runbooken som `kode`", () => {
    expect(RULES).toHaveLength(49);
    for (const rule of RULES) expect(RUNBOOK, `regel ${rule.id}`).toContain(`\`${rule.id}\``);
    for (const klass of SCHEMA_CLASSES) expect(RUNBOOK, `klasse ${klass}`).toContain(`\`${klass}\``);
    expect(EXCEPTION_ELIGIBLE_RULES.size).toBe(17);
  });

  it("kommandoene, annotasjonsformatet og de frosne tallene stemmer med manifestet", () => {
    for (const needle of ["pnpm check:schema-classes --static", "pnpm check:schema-classes", "-- jarvis-class:", "-- jarvis-definer:", "tenant-payload=", "isolation-factories", "assertTenantIsolation"]) {
      expect(RUNBOOK, needle).toContain(needle);
    }
    const counts = SCHEMA_CLASSES.map((c) => MANIFEST.classes[c].length);
    expect(counts).toEqual([2, 1, 173, 7]);
    expect(RUNBOOK).toContain("**183 tabeller** = 173 `ORG_OWNED` + 1 `USER_OWNED` (`people`) + 2 `GLOBAL` (`capabilities`, `schema_migrations`) + 7 `PLATFORM`");
    expect(RUNBOOK).toContain(`de ${MANIFEST.exceptions.length} KJENTE bruddene`);
    expect(RUNBOOK).toContain(`(${Object.keys(MANIFEST.frozen_migrations).length} filer)`);
    expect(RUNBOOK).toContain("Frosset gjennom migrasjon 148");
    expect(RUNBOOK).toContain(`de ${MANIFEST.definer_allowlist.length} eksisterende DEFINER-funksjonene`);
    for (const id of new Set(MANIFEST.exceptions.map((e) => e.finding))) expect(RUNBOOK, String(id)).toContain(`\`${String(id)}\``);
  });

  it("er ærlig om status: NOT VERIFIED, CI-kobling som eierhandling, ingen migrasjon/flagg, forslag til byggeregel", () => {
    for (const needle of ["IKKE KJØRT MOT NAS-en", "INGENTING ER `VERIFIED`", "NOT VERIFIED", "CI-kobling gjenstår (eierhandling)", "**Migrasjon: ingen. Flagg: ingen. Runtime-kode: uendret**", "Ny tabell => klasseannotasjon"]) {
      expect(RUNBOOK, needle).toContain(needle);
    }
  });
});
