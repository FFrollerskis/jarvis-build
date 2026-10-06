import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-420 (UA0-PRIVACY): behandlingsoversikten (`docs/security/PROCESSING_INVENTORY.md`) er én artefakt for «hva lagrer Jarvis, hvorfor, hvem ser det, hvor lenge».
 * Vakten gjør den til en CI-port: ny tabell, connector eller modellleverandør uten rad i oversikten feiler. Den sier ingenting om at vilkår er VERIFISERT.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const inventory = readFileSync(join(ROOT, "docs/security/PROCESSING_INVENTORY.md"), "utf8");
const matrix = readFileSync(join(ROOT, "docs/security/PROCESSOR_REGION_MATRIX.md"), "utf8");

const migrationsDir = join(ROOT, "modules/core/src/db/migrations");
const tables = new Set<string>();
for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql"))) {
  for (const m of readFileSync(join(migrationsDir, f), "utf8").matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z_0-9]+)/gm)) tables.add(m[1]!);
}
const has = (name: string) => inventory.includes(`\`${name}\``);

describe("behandlingsoversikten dekker alt som lagres og alle behandlere", () => {
  it("hver tabell i migrasjonene har en rad (datakategori, formål, retensjon)", () => {
    expect(tables.size).toBeGreaterThan(100);
    expect([...tables].filter((t) => !has(t)).sort()).toEqual([]);
  });

  it("hver connector i CONNECTOR_REGISTRY har en rad", () => {
    const src = readFileSync(join(ROOT, "modules/tool-gateway/src/connector-registry.ts"), "utf8");
    const body = src.slice(src.indexOf("export const CONNECTOR_REGISTRY"));
    const ids = [...body.matchAll(/id: "([^"]+)", display_name: "[^"]+", category: "/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(40);
    expect(ids.filter((id) => !has(id))).toEqual([]);
  });

  it("hver modellleverandør har en rad; skyleverandører er IKKE VERIFISERT (ingen falsk «verifisert»)", () => {
    const src = readFileSync(join(ROOT, "modules/model-gateway/src/capability-registry.ts"), "utf8");
    const profiles = [...src.matchAll(/provider: "([a-z_]+)",\s*\n\s*model: [^\n]*\n[\s\S]*?locality: "(local|cloud)"/g)].map((m) => ({ provider: m[1]!, locality: m[2]! }));
    expect(profiles.length).toBeGreaterThanOrEqual(8);
    for (const p of profiles) {
      expect(has(p.provider), p.provider).toBe(true);
      const row = inventory.split("\n").find((l) => l.startsWith("|") && l.includes(`\`${p.provider}\``) && l.includes("| sky |") || l.startsWith("|") && l.includes(`\`${p.provider}\``) && l.includes("| lokal |"));
      expect(row, p.provider).toBeDefined();
      if (p.locality === "cloud") {
        expect(row).toContain("IKKE VERIFISERT");
        expect(row).toMatch(/aldri `SECRET_RESTRICTED`/);
        expect(row).not.toMatch(/\bGODKJENT\b/);
      }
    }
  });

  it("PROCESSOR_REGION_MATRIX har ikke lenger en TBD-rad for LLM/embeddings mens leverandørene er live", () => {
    expect(matrix).not.toContain("| LLM | TBD / benchmark required");
    expect(matrix).not.toContain("| LLM (lokal) | TBD |");
    expect(matrix).not.toContain("| Embeddings | TBD |");
    const llm = matrix.split("\n").find((l) => l.startsWith("| LLM (sky)"));
    expect(llm).toBeDefined();
    expect((llm!.match(/IKKE VERIFISERT/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("DPIA-henvisningene peker på filer som finnes, og alle UA-DPIA-ene er med i trigger-matrisen", () => {
    const refs = [...inventory.matchAll(/`(docs\/[A-Za-z0-9_\/.-]+\.md)`/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(5);
    expect(refs.filter((r) => !existsSync(join(ROOT, r)))).toEqual([]);
    for (const d of ["UA2_KNOWLEDGE_DPIA", "UA3_BUSINESS_DPIA", "UA7_COMMUNICATIONS_DPIA", "UA8_PERSONAL_TWIN_DPIA", "UA9_VISION_DPIA", "DPIA_VOICE", "DPIA_DRAFT"]) {
      expect(inventory, d).toContain(d);
    }
    expect(inventory).toContain("DPIA-trigger-matrise");
  });

  it("oversikten er ærlig: utkast, ikke godkjent, og peker på åpne punkter", () => {
    expect(inventory).toMatch(/UTKAST/);
    expect(inventory).toContain("IKKE juridisk gjennomgått");
    expect(inventory).toContain("Åpne punkter");
  });
});
