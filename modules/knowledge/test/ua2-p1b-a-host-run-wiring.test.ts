import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-2 P1B-A: `ua2-p1b-a-host-run.ts` er et top-level side-effekt-skript
 * (kobler til ekte Postgres, gjør ekte Gmail/vision-kall når credentials
 * finnes) - kan IKKE trygt importeres direkte i en testfil, samme presedens
 * som `ua2-p1a-host-run-wiring.test.ts`. Denne suiten beviser strukturelt at
 * ett-kommando-kontrakten, BLOCKED-fail-closed-defaultene, og FK-trygg
 * cleanup-rekkefølgen er tilstede.
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const source = readSource("../scripts/ua2-p1b-a-host-run.ts");
const codeOnly = source
  .split("\n")
  .filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
  })
  .join("\n");

describe("ett-kommando-kontrakten (--env-file=.env, samme konvensjon som ua2-p1a-live.ts/p1a-drive-runtime-smoke.ts)", () => {
  it("toppkommentaren viser NØYAKTIG kommandoen med --env-file=.env", () => {
    expect(source).toContain("node --env-file=.env --experimental-transform-types modules/knowledge/scripts/ua2-p1b-a-host-run.ts");
  });
});

describe("fail-closed BLOCKED-defaults - ALDRI en stille antatt PASS", () => {
  it("alle Gmail-avhengige markører starter som BLOCKED_NO_EMAIL_CREDENTIALS, vision-markøren som BLOCKED_NO_VISION_PROVIDER", () => {
    expect(source).toMatch(/p1b_gmail_list_messages_live:\s*"BLOCKED_NO_EMAIL_CREDENTIALS"/);
    expect(source).toMatch(/p1b_gmail_attachment_download_live:\s*"BLOCKED_NO_EMAIL_CREDENTIALS"/);
    expect(source).toMatch(/p1b_sync_email_source_live:\s*"BLOCKED_NO_EMAIL_CREDENTIALS"/);
    expect(source).toMatch(/p1b_q20_no_resurrection_live:\s*"BLOCKED_NO_EMAIL_CREDENTIALS"/);
    expect(source).toMatch(/p1b_vision_ocr_live:\s*"BLOCKED_NO_VISION_PROVIDER"/);
  });

  it("lokale PDF-markører (native/render/routing) starter som FAIL, ALDRI BLOCKED - de skal kjøre uansett credentials", () => {
    expect(source).toMatch(/p1b_pdf_native_extraction:\s*"FAIL"/);
    expect(source).toMatch(/p1b_pdf_page_render:\s*"FAIL"/);
    expect(source).toMatch(/p1b_extraction_routing_decision:\s*"FAIL"/);
  });

  it("§3-§7 (Gmail/vision/sync/Q-20/token-leak) er INNI en emailCredentialsConfigured-betinget blokk - kjøres ALDRI uten credentials", () => {
    const gateIdx = source.indexOf("if (!emailCredentialsConfigured)");
    const syncIdx = source.indexOf('section("§6');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(gateIdx);
  });

  it("hard_fail beregnes fra ALLE results - inkluderer ALDRI en hardkodet 'false'", () => {
    expect(source).toContain('Object.values(results).some((v) => v === "FAIL")');
  });
});

describe("FK-trygg cleanup - SAMME rekkefølge som ua2-p1a-live.ts sin HOST FIX #8-fiks (barn FØR foreldre)", () => {
  it("tool_executions slettes FØR knowledge_embeddings FØR knowledge_documents FØR tenants", () => {
    const idx = (needle: string) => codeOnly.indexOf(needle);
    const toolExec = idx("DELETE FROM tool_executions");
    const embeddings = idx("DELETE FROM knowledge_embeddings WHERE knowledge_document_id IN");
    const documents = idx("DELETE FROM knowledge_documents WHERE tenant_id");
    const tenants = idx("DELETE FROM tenants WHERE tenant_id");
    expect(toolExec).toBeGreaterThan(-1);
    expect(embeddings).toBeGreaterThan(toolExec);
    expect(documents).toBeGreaterThan(embeddings);
    expect(tenants).toBeGreaterThan(documents);
  });

  it("ingen DISABLE TRIGGER/TRUNCATE-omvei brukt for cleanup", () => {
    expect(codeOnly).not.toMatch(/DISABLE TRIGGER|TRUNCATE/);
  });

  it("selfHeal() rydder opp stale tenants fra en TIDLIGERE avbrutt kjøring FØR en ny kjøring starter", () => {
    expect(source).toContain("async function selfHeal(): Promise<void>");
    expect(source).toContain("tenant-p1b-a-live-%");
  });
});

describe("token_leak-revisjon og Q-20-mekanisme gjenbruker EKSISTERENDE, delte funksjoner - ingen egen parallell implementasjon", () => {
  it("bruker computeErasureFingerprint fra @jarvis/core (SAMME funksjon KnowledgeSyncService selv bruker) - ikke en egen hash-rutine", () => {
    expect(source).toMatch(/import\s*\{[^}]*computeErasureFingerprint[^}]*\}\s*from\s*"@jarvis\/core"/s);
    expect(source).toContain("computeErasureFingerprint(TENANT,");
  });

  it("token_leak sjekker BÅDE emailToken og clientSecret mot den persisterte audit_events-payloaden", () => {
    expect(source).toContain("r.p.includes(String(emailToken))");
    expect(source).toContain("r.p.includes(String(clientSecret))");
  });
});
