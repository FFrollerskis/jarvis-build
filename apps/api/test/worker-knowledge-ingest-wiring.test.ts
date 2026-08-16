import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-2 P1B-A (D-43 §5): `worker-main.ts` er et top-level side-effekt-skript
 * (kobler til ekte Postgres, starter en drain-løkke idet det importeres) -
 * kan IKKE trygt importeres direkte i en testfil, samme presedens som
 * `drive-runtime-wiring.test.ts`. Denne suiten beviser strukturelt at
 * `knowledge-ingest-email`-jobbtypen faktisk er registrert på SAMME
 * worker/kø-infrastruktur som "executive", bruker den delte `gateway`
 * (ingen ny AI Mesh-vei), og at registryen er tenant/space-eksplisitt
 * (ingen implisitt/global kilde).
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const source = readSource("../src/worker-main.ts");

describe("worker-main.ts registrerer 'knowledge-ingest-email' på SAMME InProcessWorker som 'executive'", () => {
  it("A: importerer KnowledgeSourceRegistry/emailIngestHandler fra @jarvis/knowledge", () => {
    expect(source).toMatch(/import\s*\{[^}]*KnowledgeSourceRegistry[^}]*emailIngestHandler[^}]*\}\s*from\s*"@jarvis\/knowledge"/s);
  });

  it("B: worker.register('knowledge-ingest-email', ...) kalles på SAMME 'worker'-instans som worker.register('executive', ...)", () => {
    expect(source).toMatch(/worker\.register\(\s*\n?\s*"executive"/);
    expect(source).toMatch(/worker\.register\(\s*\n?\s*"knowledge-ingest-email"/);
    // Ingen ny/parallell InProcessWorker-instans opprettet:
    expect([...source.matchAll(/new InProcessWorker\(/g)]).toHaveLength(1);
  });

  it("C: emailIngestHandler({...}) bruker den DELTE 'gateway' (ModelGateway) som visionGateway - ingen ny AI Mesh-instans/direkte leverandør-SDK", () => {
    const callIdx = source.indexOf("emailIngestHandler({");
    expect(callIdx).toBeGreaterThan(-1);
    const callBlock = source.slice(callIdx, source.indexOf("})", callIdx) + 2);
    expect(callBlock).toContain("visionGateway: gateway");
    expect(callBlock).toContain("toolGateway");
    expect(callBlock).toContain("pool");
  });

  it("D: registryen er EKSPLISITT (statisk liste) - INGEN implisitt/global kilde, tenant_id/memory_space_id/source_instance_id alle satt eksplisitt", () => {
    const registryIdx = source.indexOf("new KnowledgeSourceRegistry([");
    expect(registryIdx).toBeGreaterThan(-1);
    const registryBlock = source.slice(registryIdx, source.indexOf("]);", registryIdx) + 3);
    expect(registryBlock).toContain('source_type: "email_attachment"');
    expect(registryBlock).toContain("tenant_id:");
    expect(registryBlock).toContain('memory_space_id: "personal"');
    expect(registryBlock).toContain("source_instance_id:");
  });

  it("E: bruker LocalHashEmbedding fra @jarvis/memory - SAMME embedding-konvensjon som main.ts (D-28), ingen ny embedding-avhengighet", () => {
    expect(source).toMatch(/import\s*\{[^}]*LocalHashEmbedding[^}]*\}\s*from\s*"@jarvis\/memory"/s);
    expect(source).toContain("new LocalHashEmbedding()");
  });
});
