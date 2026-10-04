import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-400: 068 feilet på NAS (`invalid input syntax for type vector: "{0.129,...}"`). `real[]::text` gir
 * `{a,b,c}`, mens pgvector parser `[a,b,c]`. Embedded Postgres i testene har ikke pgvector, så selve
 * vektorgrenen kan ikke kjøres her - denne testen låser den bevisst feilede konverteringen ute.
 */
const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../core/src/db/migrations/068_memory_v2.sql"), "utf8");

describe("068_memory_v2: real[] -> pgvector-konvertering", () => {
  it("bruker ikke den direkte tekst-castingen som gir {..}-format", () => {
    expect(sql).not.toMatch(/embedding::text::vector/);
  });
  it("bytter klammer {} -> [] før ::vector", () => {
    expect(sql).toMatch(/translate\(embedding::text,\s*'\{\}',\s*'\[\]'\)::vector/);
  });
});
