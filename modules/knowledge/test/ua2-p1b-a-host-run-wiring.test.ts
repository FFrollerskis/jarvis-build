import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * UA-2 P1B-A HOST FIX #1 (2026-08-16): `ua2-p1b-a-host-run.ts` er et
 * top-level side-effekt-skript (kobler til ekte Postgres, gjør ekte Gmail/
 * vision-kall når credentials finnes) - kan IKKE trygt importeres direkte i
 * en testfil, samme presedens som `ua2-p1a-host-run-wiring.test.ts`. Denne
 * suiten beviser strukturelt: ett-kommando-kontrakten, at scriptet nå
 * SELV-bootstrapper workspacet (§15 i host-fix-ordren), automatisk
 * Gmail-reauth-forsøk ved gjenopprettbar autentiseringsfeil (§ordren), den
 * fiksede FK-trygge cleanup-rekkefølgen (cost_events - HOST FIX #1), og
 * BLOCKED-fail-closed-defaultene.
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

describe("HOST FIX #1 §15: scriptet SELV-bootstrapper workspacet - Tobias trenger ALDRI et separat pnpm install-steg", () => {
  it("kaller ensureWorkspaceInstalled() FØR noen @jarvis/*-modul lastes (dynamisk import, ikke statisk)", () => {
    const bootstrapIdx = source.indexOf("ensureWorkspaceInstalled();");
    const firstDynamicImportIdx = source.indexOf('await import("@jarvis/core")');
    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(firstDynamicImportIdx).toBeGreaterThan(bootstrapIdx);
  });

  it("INGEN statisk (topp-nivå) import fra noen @jarvis/*-pakke - kun dynamiske await import() inni main()", () => {
    expect(codeOnly).not.toMatch(/^import .* from "@jarvis\//m);
    for (const pkg of ["@jarvis/core", "@jarvis/memory", "@jarvis/knowledge", "@jarvis/tool-gateway", "@jarvis/policy", "@jarvis/model-gateway", "@jarvis/provider-adapters"]) {
      expect(source, pkg).toContain(`await import("${pkg}")`);
    }
  });

  it("bruker SAMME Windows-sikre package-manager-resolusjon som Q-20/P1A (buildSpawnInvocation, aldri shell:true) via relativ import (fungerer FØR node_modules finnes)", () => {
    expect(source).toContain('from "../../core/scripts/lib/package-manager-resolve.ts"');
    expect(source).toContain("buildSpawnInvocation");
    expect(source).toContain("readPinnedPackageManager");
    expect(codeOnly).not.toMatch(/shell:\s*true/);
  });

  it("kjører 'install' '--frozen-lockfile' - ALDRI en variant som skriver om lockfilen", () => {
    expect(source).toContain('["install", "--frozen-lockfile"]');
    expect(codeOnly).not.toMatch(/--no-frozen-lockfile|pnpm.*update/);
  });
});

describe("HOST FIX #1: automatisk Gmail-reauth-forsøk ved gjenopprettbar autentiseringsfeil (§8/§3 i ordren)", () => {
  it("bruker parseGoogleAuthFailureReason()/isRecoverableGoogleAuthErrorClass() fra @jarvis/tool-gateway - ikke en egen, parallell klassifisering", () => {
    expect(source).toContain("parseGoogleAuthFailureReason");
    expect(source).toContain("isRecoverableGoogleAuthErrorClass");
  });

  it("reauth forsøkes KUN ÉN gang per kjøring (reauthAttempted-vakt) - unngår en uendelig løkke mot en ikke-reauth-løsbar årsak", () => {
    expect(source).toContain("let reauthAttempted = false;");
    expect(source).toContain("if (reauthAttempted) {");
    expect(source).toContain("reauthAttempted = true;");
  });

  it("spawner google-email-reauth.ts (SAMME allerede persisterte Desktop-klient) via execFileSync - ALDRI google-drive-reauth.ts (ville krevd en ny Drive-samtykkerunde for et rent Gmail-problem)", () => {
    const execCallIdx = codeOnly.indexOf('execFileSync("node", ["--experimental-transform-types",');
    expect(execCallIdx).toBeGreaterThan(-1);
    const execCallLine = codeOnly.slice(execCallIdx, codeOnly.indexOf("\n", execCallIdx));
    expect(execCallLine).toContain("modules/core/scripts/google-email-reauth.ts");
    expect(execCallLine).not.toContain("google-drive-reauth.ts");
  });

  it("leser .env på nytt fra DISK (ikke process.env, som en underprosess aldri kan endre i forelderen) etter reauth, FØR retry", () => {
    const readFreshIdx = source.indexOf("function readFreshEmailTokenFromEnvFile()");
    expect(readFreshIdx).toBeGreaterThan(-1);
    expect(source).toContain('readFileSync(envPath, "utf8")');
    const callIdx = source.indexOf("const freshToken = readFreshEmailTokenFromEnvFile();");
    const retryIdx = source.indexOf("const retryOk = await attemptListMessages();");
    expect(callIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeGreaterThan(callIdx);
  });

  it("gjenopptar retry i SAMME prosess/kjøring - ingen process.exit()/ny kommando krevd mellom første feil og retry", () => {
    const gateIdx = source.indexOf("if (!errorClass) {");
    const retryIdx = source.indexOf("const retryOk = await attemptListMessages();");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeGreaterThan(gateIdx);
    expect(codeOnly).not.toMatch(/process\.exit\(/);
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

  it("§4 vedleggsnedlasting bruker SKIPPED_SAFE_FIXTURE (ALDRI en stille antatt PASS) når ingen vedlegg finnes - IKKE lenger bare et loggmønster, et eget Verdict-medlem", () => {
    expect(source).toContain('"SKIPPED_SAFE_FIXTURE"');
    expect(source).toContain('results.p1b_gmail_attachment_download_live = "SKIPPED_SAFE_FIXTURE";');
  });

  it("§6 sync hoppes eksplisitt over (SKIPPED, ikke en stille FAIL/PASS) hvis list_messages selv ikke er PASS", () => {
    expect(source).toContain('if (results.p1b_gmail_list_messages_live !== "PASS") {');
  });

  it("hard_fail beregnes fra ALLE results - inkluderer ALDRI en hardkodet 'false'", () => {
    expect(source).toContain('Object.values(results).some((v) => v === "FAIL")');
  });
});

describe("FK-trygg cleanup - HOST FIX #1 (2026-08-16, host-funn run_id 3af67dab): cost_events lagt til FØRST", () => {
  it("cost_events slettes FØR tool_executions FØR knowledge_embeddings FØR knowledge_documents FØR tenants", () => {
    const idx = (needle: string) => codeOnly.indexOf(needle);
    const costEvents = idx("DELETE FROM cost_events WHERE tenant_id");
    const toolExec = idx("DELETE FROM tool_executions");
    const embeddings = idx("DELETE FROM knowledge_embeddings WHERE knowledge_document_id IN");
    const documents = idx("DELETE FROM knowledge_documents WHERE tenant_id");
    const tenants = idx("DELETE FROM tenants WHERE tenant_id");
    expect(costEvents).toBeGreaterThan(-1);
    expect(toolExec).toBeGreaterThan(costEvents);
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
  it("bruker computeErasureFingerprint via dynamisk import fra @jarvis/core (SAMME funksjon KnowledgeSyncService selv bruker) - ikke en egen hash-rutine", () => {
    const importIdx = source.indexOf('await import("@jarvis/core")');
    const importLine = source.slice(source.lastIndexOf("const {", importIdx), importIdx);
    expect(importLine).toContain("computeErasureFingerprint");
    expect(source).toContain("computeErasureFingerprint(TENANT,");
  });

  it("token_leak sjekker BÅDE emailToken og clientSecret mot den persisterte audit_events-payloaden", () => {
    expect(source).toContain("r.p.includes(String(emailToken))");
    expect(source).toContain("r.p.includes(String(clientSecret))");
  });
});
