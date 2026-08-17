// UA-2 P1B-A HOST ACCEPTANCE - kjøres AV TOBIAS mot ekte lokal Postgres
// (docker-compose) og, der credentials finnes, ekte Gmail + ekte vision-
// leverandør (Anthropic - eneste adapter med reell bildestøtte denne runden,
// se capability-registry.ts). Gjenbruker KUN eksisterende arkitektur
// (@jarvis/knowledge, @jarvis/tool-gateway, @jarvis/model-gateway,
// @jarvis/policy, @jarvis/core) - ingen alternativ testimplementasjon.
// Speiler strukturen i ua2-p1a-live.ts (samme log()/section()/Verdict-
// mønster, samme FK-trygge cleanupTenant()-rekkefølge).
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/knowledge/scripts/ua2-p1b-a-host-run.ts
//
// HOST FIX #1 (2026-08-16, host-funn run_id `3af67dab`, §15 i ordren): en
// fersk branch-checkout kan mangle `node_modules` - `@jarvis/*`-importene er
// derfor BEVISST flyttet til DYNAMISKE `await import(...)`-kall INNI main(),
// ETTER `ensureWorkspaceInstalled()` (Node-innebygde moduler + rene, lokale
// imports KUN - samme "kan kjøre FØR pnpm install"-presedens som
// `modules/core/scripts/ua2-p1a-host-run.ts`/`q20-host-run.ts`). Dette
// holder ÉN fil, ÉN kommando (den samme Tobias allerede har kjørt) - ingen
// egen andre "husk å kjøre pnpm install først"-steg lenger.
//
// HOST FIX #1 (samme runde): Gmail-autentiseringsfeil klassifiseres nå (se
// `classifyGoogleTokenEndpointError()`/`parseGoogleAuthFailureReason()` i
// `@jarvis/tool-gateway`) - er klassen GJENOPPRETTBAR (typisk et
// `JARVIS_EMAIL_TOKEN` utstedt til feil klient/tilbakekalt/manglende scope),
// forsøker scriptet AUTOMATISK ÉN Gmail-reauth (kjører
// `modules/core/scripts/google-email-reauth.ts` som en interaktiv
// underprosess - SAMME allerede persisterte Desktop-OAuth-klient som Drive,
// INGEN ny klient/JSON), leser `.env` på nytt, og prøver §3 PÅ NYTT i SAMME
// prosess/kjøring - Tobias skal normalt ALDRI trenge en egen andre kommando
// (§8 i ordren). Reauth forsøkes KUN ÉN gang per kjøring (unngår en løkke
// mot en grunnleggende, ikke-reauth-løsbar årsak).
//
// HOST FIX #2 (2026-08-16, host-funn run_id `ab43fb1f`): et ekte host-funn
// viste `tool_failed:google_auth_failed_401:GOOGLE_INVALID_CLIENT:
// unauthorized_client` mot den ALLEREDE host-bevist Desktop-klienten -
// `isRecoverableGoogleAuthErrorClass("GOOGLE_INVALID_CLIENT")` var (korrekt,
// for den GENERELLE klassen) `false`, så auto-reauth ble ALDRI forsøkt.
// `classifyGoogleTokenEndpointError()` skiller nå dette kontekst-beviste
// tilfellet ut som en EGEN klasse (`EMAIL_REAUTH_REQUIRED`,
// `recoveryReason=LEGACY_TOKEN_OR_CLIENT_BINDING`) - SELVE dette scriptet
// endret INGENTING i sin egen logikk (samme
// `parseGoogleAuthFailureReason()`/`isRecoverableGoogleAuthErrorClass()`-kall
// som før): den nye klassen er ganske enkelt en av de gjenopprettbare nå, og
// samme eksisterende reauth-forsøks-/retry-vei under håndterer den identisk.
// Ny `p1b_gmail_reauth`-markør legges til for å gjøre reauth-forsøkets EGET
// utfall (i motsetning til KUN sluttresultatet av selve `list_messages`)
// eksplisitt synlig i sammendraget.
//
// LIVE vs IMPLEMENTATION-VERIFIED (§ordren, aldri overklaimet):
// - p1b_pdf_native_extraction/p1b_pdf_page_render: LOKALE, KREVER INGEN
//   credentials (pdf-parse er en ren lokal avhengighet) - kjører ALLTID ekte,
//   rapporterer PASS/FAIL, ALDRI BLOCKED.
// - p1b_gmail_*: LIVE mot ekte Gmail KUN når JARVIS_GOOGLE_CLIENT_ID/_SECRET
//   og JARVIS_EMAIL_TOKEN alle er satt - ellers BLOCKED_NO_EMAIL_CREDENTIALS
//   (ALDRI en fake PASS).
// - p1b_vision_ocr_live: LIVE modellkall (purpose:VISION) KUN når en faktisk
//   vision-kapabel provider er konfigurert (Anthropic) - ellers
//   BLOCKED_NO_VISION_PROVIDER.
// - p1b_sync_email_source_live/p1b_q20_no_resurrection_live: krever BEGGE
//   Gmail-credentials (bruker den ekte postkassen via ToolGateway) - BLOCKED
//   samtidig med p1b_gmail_*.
// - p1b_worker_registration: IKKE re-testet her - allerede strukturelt bevist
//   i apps/api/test/worker-knowledge-ingest-wiring.test.ts (suite-verifisert,
//   rapporteres som SUITE_VERIFIED, ikke live).
// - p1b_gmail_attachment_download_live: SKIPPED_SAFE_FIXTURE når ingen
//   vedlegg finnes i de siste meldingene - se HOST FIX #1 §10/§11 i ordren:
//   Jarvis sin Gmail-connector har INGEN implementert `send`-handling ennå
//   (kjent, separat sporet gap - ToolDefinition lover det, GmailTransport
//   gjør det ikke), så det finnes INGEN trygg måte å opprette et
//   kontrollert test-vedlegg denne runden - Tobias sin postkasse skannes
//   ALDRI utover en vanlig, allerede planlagt `list_messages`-listing, og
//   INGEN vedlegg konstrueres/sendes kunstig kun for testen.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnInvocation, readPinnedPackageManager, resolvePackageManager } from "../../core/scripts/lib/package-manager-resolve.ts";

const repoRoot = process.cwd();
const envPath = join(repoRoot, ".env");

/**
 * HOST FIX #2 §11: en STABIL (IKKE run_id-avhengig - Tobias skal kunne sende
 * ÉN testmelding FØR en fremtidig kjøring, ikke måtte forutsi et fremtidig
 * run_id) emnetekst for en deterministisk, MENNESKE-sendt akseptanse-
 * testmelding. `list_messages` sitt EKSISTERENDE `query`-parameter (allerede
 * bygget, se `listMessages()` i `GmailTransport`) brukes til et SMALT
 * `subject:"..."`-søk - ALDRI en generell postkasse-skann. Bevisst en mindre
 * ambisiøs, men trygg og faktisk-fungerende variant av ordrens eksempel (som
 * foreslo en run_id-avhengig emnetekst + bundet polling) - se D-46 for full
 * begrunnelse. Ingen `send`-kapabilitet legges til Gmail-connectoren for
 * dette - Tobias sender selv, manuelt, fra en annen konto.
 */
const ACCEPTANCE_FIXTURE_SUBJECT = "Jarvis P1B Acceptance";

type Verdict =
  | "PASS" | "FAIL" | "BLOCKED_BY_RUNTIME_ROLE" | "BLOCKED_NO_EMAIL_CREDENTIALS"
  | "BLOCKED_NO_VISION_PROVIDER" | "SUITE_VERIFIED" | "SKIPPED_SAFE_FIXTURE"
  | "SKIPPED_NOT_NEEDED" | "SKIPPED_NOT_RECOVERABLE";

const results: Record<string, Verdict> = {
  p1b_pdf_native_extraction: "FAIL",
  p1b_pdf_page_render: "FAIL",
  p1b_extraction_routing_decision: "FAIL",
  p1b_gmail_list_messages_live: "BLOCKED_NO_EMAIL_CREDENTIALS",
  p1b_gmail_reauth: "BLOCKED_NO_EMAIL_CREDENTIALS",
  p1b_gmail_attachment_download_live: "BLOCKED_NO_EMAIL_CREDENTIALS",
  p1b_vision_ocr_live: "BLOCKED_NO_VISION_PROVIDER",
  p1b_sync_email_source_live: "BLOCKED_NO_EMAIL_CREDENTIALS",
  p1b_q20_no_resurrection_live: "BLOCKED_NO_EMAIL_CREDENTIALS",
  p1b_token_leak_audit: "BLOCKED_NO_EMAIL_CREDENTIALS",
  p1b_worker_registration: "SUITE_VERIFIED"
};
const diagnostics: Record<string, string> = {};

function log(msg: string): void {
  console.log(`[ua2-p1b-a-host-run] ${msg}`);
}

async function section<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  log(`\n== ${name} ==`);
  try {
    return await fn();
  } catch (err) {
    log(`${name}: UVENTET FEIL - ${(err as Error).message.slice(0, 200)}`);
    return undefined;
  }
}

/** Identisk mønster som `ua2-p1a-host-run.ts` sin `ensureWorkspaceInstalled()` - Node-innebygde moduler + rene, avhengighetsfrie lokale imports KUN, slik at DETTE steget kan kjøre selv om `pnpm install` aldri har blitt kjørt på en fersk branch-checkout (HOST FIX #1 §15). */
function ensureWorkspaceInstalled(): void {
  const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");
  const pinned = readPinnedPackageManager(packageJson);
  if (!pinned || pinned.name !== "pnpm") {
    throw new Error(`package.json sitt "packageManager"-felt mangler eller er ikke pnpm-basert: ${JSON.stringify(pinned)}`);
  }
  const resolved = resolvePackageManager(
    { platform: process.platform, pathEnv: process.env["PATH"] ?? process.env["Path"] ?? "", pathExt: process.env["PATHEXT"] ?? process.env["Pathext"] ?? "", exists: existsSync },
    pinned
  );
  log(`package_manager_resolution=PASS package_manager_driver=${resolved.driver} package_manager_version=${pinned.version}`);
  const invocation = buildSpawnInvocation(resolved, ["install", "--frozen-lockfile"]);
  log(`$ ${invocation.command} ${invocation.args.join(" ")}`);
  execFileSync(invocation.command, invocation.args, { stdio: "inherit", cwd: repoRoot });
  log("install_frozen_lockfile=PASS workspace_install=PASS");
}

/** Minimal, GYLDIG 1-sides PDF MED lesbar native tekst - samme mal som email-attachment-source.test.ts, ingen ny fixture-konvensjon. */
function textPdfBuffer(): Buffer {
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 100] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 70 >>
stream
BT /F1 14 Tf 10 50 Td (Dette er nok native tekst til aa passere terskelen) Tj ET
endstream
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`);
}

/** HOST FIX #1: leser `JARVIS_EMAIL_TOKEN` FERSKT fra `.env` på disk (IKKE `process.env`, som ALDRI oppdateres av en underprosess) - kalt ETTER `google-email-reauth.ts` har fullført, for å gjenoppta SAMME kjøring uten en ny kommando. */
function readFreshEmailTokenFromEnvFile(): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const content = readFileSync(envPath, "utf8");
  const match = /^JARVIS_EMAIL_TOKEN=(.*)$/m.exec(content);
  return match?.[1]?.trim() || undefined;
}

async function main(): Promise<void> {
  ensureWorkspaceInstalled();

  const { PgApprovalStore, adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, computeErasureFingerprint, configFromEnv, createPool } = await import("@jarvis/core");
  const { LocalHashEmbedding } = await import("@jarvis/memory");
  const { KnowledgeSourceRegistry, KnowledgeSyncService, ModelGatewayVisionExtractor, PdfExtractor, decideExtractionTier } = await import("@jarvis/knowledge");
  const {
    EnvSecretProvider, GmailTransport, ToolGateway, firstWaveTools,
    isRecoverableGoogleAuthErrorClass, parseGoogleAuthFailureReason
  } = await import("@jarvis/tool-gateway");
  const { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } = await import("@jarvis/policy");
  const { ModelGateway, MemoryTraceSink } = await import("@jarvis/model-gateway");
  const { AnthropicAdapter } = await import("@jarvis/provider-adapters");
  const { randomUUID } = await import("node:crypto");

  assertRuntimeCredentialsConfigured();
  const pool = createPool(configFromEnv());
  const adminPool = createPool(adminConfigFromEnv());
  const embedding = new LocalHashEmbedding();

  const runId = randomUUID().slice(0, 8);
  log(`run_id=${runId}`);

  const TENANT = `tenant-p1b-a-live-${runId}`;
  const OWNER_PERSON = `person-p1b-a-live-${runId}`;
  const SPACE = "personal";

  function identity() {
    return {
      person_id: OWNER_PERSON, tenant_id: TENANT, memory_space_id: SPACE,
      session_id: `sess-p1b-a-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
    } as const;
  }

  /**
   * Samme FK-trygge rekkefølge som ua2-p1a-live.ts sin cleanupTenant() (HOST
   * FIX #8, 2026-08-16) - barn FØR foreldre, verifisert mot faktisk
   * migrasjonsgraf, ALDRI TRUNCATE/DISABLE TRIGGER. HOST FIX #1
   * (2026-08-16, host-funn run_id `3af67dab`): §5-vision-kallet (LIVE
   * ModelGateway.complete()) skriver en `cost_events`-rad
   * (`cost_events.tenant_id REFERENCES tenants` - bekreftet mot faktisk
   * migrasjon `004_audit_cost.sql`, IKKE gjettet) - denne raden manglet i
   * forrige runde og blokkerte `DELETE FROM tenants` med et FK-brudd.
   * `cost_events` har INGEN append-only-trigger (i motsetning til
   * `audit_events`/`events` - bekreftet ved fravær av en slik trigger i
   * ALLE migrasjoner), og er derfor trygt slettbar operasjonell test-metadata
   * for KUN denne midlertidige akseptanse-tenanten.
   */
  async function cleanupTenant(tenantId: string): Promise<void> {
    await adminPool.query("DELETE FROM cost_events WHERE tenant_id = $1", [tenantId]);
    await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
    await adminPool.query(
      `DELETE FROM knowledge_embeddings WHERE knowledge_document_id IN (SELECT knowledge_document_id FROM knowledge_documents WHERE tenant_id = $1)`,
      [tenantId]
    );
    await adminPool.query("DELETE FROM knowledge_documents WHERE tenant_id = $1", [tenantId]);
    await adminPool.query("DELETE FROM erasure_fingerprints WHERE tenant_id = $1", [tenantId]);
    await adminPool.query("DELETE FROM erasure_requests WHERE tenant_id = $1", [tenantId]);
    await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
    await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
  }

  async function selfHeal(): Promise<void> {
    try {
      const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-p1b-a-live-%'");
      for (const row of stale.rows as Array<{ tenant_id: string }>) {
        await cleanupTenant(row.tenant_id).catch(() => undefined);
      }
      await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-p1b-a-live-%'").catch(() => undefined);
    } catch {
      // best-effort
    }
  }

  let runtimeRoleSafe = false;
  await section("§1 Q-21 RUNTIME ROLE", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    diagnostics["runtime_current_user"] = status.role;
    log(`q21_runtime_role_safe=PASS role=${status.role}`);
  });
  if (!runtimeRoleSafe) {
    log("\nP1B-A KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21 regresjon). Ingen kall forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish(pool, adminPool);
  }

  await selfHeal();
  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, 'P1B-A Live', 'person');
     INSERT INTO people (person_id, display_name) VALUES ($2, 'P1B-A Live Tester') ON CONFLICT DO NOTHING;
     INSERT INTO person_tenants (person_id, tenant_id) VALUES ($2, $1);`.replace(/\$1/g, `'${TENANT}'`).replace(/\$2/g, `'${OWNER_PERSON}'`)
  );

  // ===== §2: LOKAL PDF-EKSTRAKSJON (ingen credentials nødvendig - ekte pdf-parse) =====
  await section("§2 PDF native tekst + side-rasterisering (lokalt, D-44)", async () => {
    const extractor = new PdfExtractor(textPdfBuffer());
    try {
      const pageCount = await extractor.pageCount();
      const textByPage = await extractor.nativeTextByPage();
      const text = textByPage.get(1) ?? "";
      results.p1b_pdf_native_extraction = pageCount === 1 && text.includes("native tekst") ? "PASS" : "FAIL";
      log(`p1b_pdf_native_extraction=${results.p1b_pdf_native_extraction} (pages=${pageCount}, text_len=${text.length})`);

      const image = await extractor.renderPageToImage(1);
      const bytes = Buffer.from(image.data, "base64");
      const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      results.p1b_pdf_page_render = isPng && image.media_type === "image/png" ? "PASS" : "FAIL";
      log(`p1b_pdf_page_render=${results.p1b_pdf_page_render} (bytes=${bytes.length})`);

      results.p1b_extraction_routing_decision =
        decideExtractionTier(text) === "native" && decideExtractionTier("") === "needs_image_extraction" ? "PASS" : "FAIL";
      log(`p1b_extraction_routing_decision=${results.p1b_extraction_routing_decision}`);
    } finally {
      await extractor.destroy();
    }
  });

  // ===== §3-§7: GMAIL/VISION LIVE (KUN hvis credentials finnes) =====
  const clientId = process.env["JARVIS_GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["JARVIS_GOOGLE_CLIENT_SECRET"];
  let emailToken = process.env["JARVIS_EMAIL_TOKEN"];
  const emailCredentialsConfigured = Boolean(clientId && clientSecret && emailToken);
  diagnostics["email_credentials_configured"] = String(emailCredentialsConfigured);

  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  const visionProviderConfigured = Boolean(anthropicKey);
  diagnostics["vision_provider_configured"] = String(visionProviderConfigured);

  if (!emailCredentialsConfigured) {
    log(
      `\n§3-§7 HOPPET OVER: BLOCKED_NO_EMAIL_CREDENTIALS (client_id=${Boolean(clientId)} client_secret=${Boolean(clientSecret)} email_token=${Boolean(emailToken)}) - ` +
        "google-drive-reauth.ts sitt Google OAuth-oppsett dekker JARVIS_GOOGLE_CLIENT_ID/_SECRET; JARVIS_EMAIL_TOKEN er en SEPARAT, egen Gmail-refresh-token (D-35/§2 i denne ordren) - ikke satt av Drive-reauth-flyten."
    );
  } else {
    const devices = new InMemoryDeviceRegistry();
    const policy = new PolicyGateway({
      devices, nonces: new PgApprovalStore(pool), killSwitch: new KillSwitch(),
      authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT] }
    });
    const toolGateway = new ToolGateway(pool, policy, new EnvSecretProvider());
    for (const tool of firstWaveTools({ email: new GmailTransport() })) toolGateway.register(tool);

    let realMessageId: string | undefined;
    let realAttachment: { attachment_id: string; mime_type: string } | undefined;
    let reauthAttempted = false;

    async function attemptListMessages(): Promise<boolean> {
      const result = await toolGateway.execute({ identity: identity(), tool_id: "email", action: "list_messages", parameters: { max: 10 } });
      if (result.ok) {
        results.p1b_gmail_list_messages_live = "PASS";
        const body = result.data as { messages: Array<{ id: string; attachments: Array<{ attachment_id: string; mime_type: string }> }> };
        log(`p1b_gmail_list_messages_live=PASS (messages=${body.messages.length})`);
        realMessageId = body.messages[0]?.id;
        realAttachment = body.messages.find((m) => m.attachments.length > 0)?.attachments[0];
        if (realAttachment) {
          realMessageId = body.messages.find((m) => m.attachments.some((a) => a.attachment_id === realAttachment?.attachment_id))?.id;
        }
        return true;
      }
      diagnostics["gmail_list_messages_reason"] = result.reason;
      log(`p1b_gmail_list_messages_live=FAIL (${result.reason})`);
      results.p1b_gmail_list_messages_live = "FAIL";
      return false;
    }

    await section("§3 GMAIL list_messages (LIVE, med automatisk reauth-forsøk ved gjenopprettbar autentiseringsfeil)", async () => {
      const firstAttemptOk = await attemptListMessages();
      if (firstAttemptOk) {
        results.p1b_gmail_reauth = "SKIPPED_NOT_NEEDED";
        log("p1b_gmail_reauth=SKIPPED_NOT_NEEDED (list_messages lyktes allerede ved første forsøk - ingen reauth nødvendig)");
        return;
      }

      const errorClass = parseGoogleAuthFailureReason(diagnostics["gmail_list_messages_reason"] ?? "");
      if (!errorClass) {
        log("gmail_auth_recoverable=UNKNOWN (feilen var ikke en klassifisert Google-auth-feil i det hele tatt - INGEN automatisk reauth forsøkt)");
        results.p1b_gmail_reauth = "SKIPPED_NOT_RECOVERABLE";
        return;
      }
      diagnostics["gmail_auth_error_class"] = errorClass;
      if (!isRecoverableGoogleAuthErrorClass(errorClass)) {
        // HOST FIX #2: GOOGLE_INVALID_CLIENT her betyr at klienten IKKE var
        // bevist Desktop-type på klassifiseringstidspunktet (manglende
        // secret/uprøvd/feilkonfigurert klient, se `classifyGoogleTokenEndpointError()`
        // sin `GoogleAuthClientContext`-gren) - fortsatt korrekt fail-closed.
        log(`gmail_auth_recoverable=false (klasse=${errorClass}) - krever manuell undersøkelse, INGEN automatisk reauth forsøkt (unngår en løkke mot feil grunnleggende årsak).`);
        results.p1b_gmail_reauth = "SKIPPED_NOT_RECOVERABLE";
        return;
      }
      if (reauthAttempted) {
        log("gmail_auth_recoverable=true, MEN reauth er allerede forsøkt ÉN gang denne kjøringen - stopper (unngår en uendelig løkke).");
        results.p1b_gmail_reauth = "FAIL";
        return;
      }
      reauthAttempted = true;
      // HOST FIX #2: `EMAIL_REAUTH_REQUIRED` (host-funn run_id `ab43fb1f`,
      // klassifisert som en gjenopprettbar klasse fra og med HOST FIX #2) tar
      // NØYAKTIG samme vei som de øvrige gjenopprettbare klassene fra HOST
      // FIX #1 - ingen egen gren nødvendig, kun en tydeligere loggmelding.
      const recoveryNote = errorClass === "EMAIL_REAUTH_REQUIRED" ? " (reason=LEGACY_TOKEN_OR_CLIENT_BINDING - se D-46)" : "";
      log(`gmail_auth_recoverable=true (klasse=${errorClass}${recoveryNote}) - forsøker automatisk Gmail-reauth (google-email-reauth.ts, samme allerede persisterte Desktop-klient, INGEN ny klient/JSON)...`);
      try {
        execFileSync("node", ["--experimental-transform-types", "modules/core/scripts/google-email-reauth.ts"], { stdio: "inherit", cwd: repoRoot });
      } catch (err) {
        log(`gmail_reauth_subprocess=FAIL (${(err as Error).message.slice(0, 200)}) - fortsetter med det opprinnelige (fortsatt ugyldige) JARVIS_EMAIL_TOKEN.`);
        results.p1b_gmail_reauth = "FAIL";
        return;
      }
      log("gmail_reauth_subprocess=PASS - leser oppdatert JARVIS_EMAIL_TOKEN fra .env og prøver §3 på nytt i SAMME kjøring (ingen ny kommando nødvendig)...");
      const freshToken = readFreshEmailTokenFromEnvFile();
      if (!freshToken) {
        log("gmail_reauth_resume=FAIL (fant ikke et oppdatert JARVIS_EMAIL_TOKEN i .env etter reauth) - fortsetter uten retry.");
        results.p1b_gmail_reauth = "FAIL";
        return;
      }
      process.env["JARVIS_EMAIL_TOKEN"] = freshToken;
      emailToken = freshToken;
      const retryOk = await attemptListMessages();
      results.p1b_gmail_reauth = retryOk ? "PASS" : "FAIL";
      log(`gmail_reauth_resume=${retryOk ? "PASS" : "FAIL"} (retry etter automatisk reauth) p1b_gmail_reauth=${results.p1b_gmail_reauth}`);
    });

    await section("§4 GMAIL read_attachment (LIVE, kun hvis et reelt vedlegg finnes i innboksen)", async () => {
      if (!realAttachment || !realMessageId) {
        // HOST FIX #2 §11: ETT smalt, subject-scoped ekstra-søk etter en
        // TIDLIGERE, MENNESKE-sendt deterministisk akseptanse-testmelding -
        // FØR fallback til SKIPPED_SAFE_FIXTURE. `subject:"..."`-filteret
        // gjør dette til NØYAKTIG det samme som den allerede planlagte
        // listingen (samme `list_messages`-handling, samme scope-begrensning)
        // - IKKE en bredere/generell postkasse-skann.
        const acceptanceSearch = await toolGateway.execute({
          identity: identity(), tool_id: "email", action: "list_messages",
          parameters: { max: 5, query: `subject:"${ACCEPTANCE_FIXTURE_SUBJECT}" has:attachment` }
        });
        if (acceptanceSearch.ok) {
          const body = acceptanceSearch.data as { messages: Array<{ id: string; attachments: Array<{ attachment_id: string; mime_type: string }> }> };
          const withAttachment = body.messages.find((m) => m.attachments.length > 0);
          if (withAttachment) {
            realMessageId = withAttachment.id;
            realAttachment = withAttachment.attachments[0];
            diagnostics["gmail_attachment_fixture_source"] = "acceptance_subject_search";
            log(`p1b_gmail_attachment_download_live: fant en deterministisk akseptanse-testmelding via smalt subject-søk ("${ACCEPTANCE_FIXTURE_SUBJECT}") - fortsetter med LIVE nedlasting.`);
          }
        }
      }
      if (!realAttachment || !realMessageId) {
        diagnostics["gmail_attachment_download_skip_reason"] = "no_attachment_in_recent_inbox_no_safe_fixture";
        results.p1b_gmail_attachment_download_live = "SKIPPED_SAFE_FIXTURE";
        log(
          "p1b_gmail_attachment_download_live=SKIPPED_SAFE_FIXTURE (ingen vedlegg i de siste meldingene, og ingen " +
            `deterministisk akseptanse-testmelding funnet - Gmail-connectoren har INGEN implementert send-handling ennå, ` +
            "så INGEN trygg måte å konstruere et kontrollert test-vedlegg denne runden; postkassen skannes ALDRI utover " +
            `den allerede planlagte listingen + ETT smalt subject-søk. For neste kjøring: send ÉN liten test-e-post fra ` +
            `en ANNEN konto til ${process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "den konfigurerte Jarvis-kontoen"} med EKSAKT ` +
            `emnefelt "${ACCEPTANCE_FIXTURE_SUBJECT}" og ETT vedlegg for å bevise denne veien LIVE - se D-46 §11.)`
        );
        return;
      }
      const result = await toolGateway.execute({
        identity: identity(), tool_id: "email", action: "read_attachment",
        parameters: { message_id: realMessageId, attachment_id: realAttachment.attachment_id }
      });
      results.p1b_gmail_attachment_download_live = result.ok ? "PASS" : "FAIL";
      log(`p1b_gmail_attachment_download_live=${results.p1b_gmail_attachment_download_live}`);
    });

    // ===== §5: VISION OCR LIVE (KUN hvis vision-provider konfigurert) =====
    if (!visionProviderConfigured) {
      log("\n§5 HOPPET OVER: BLOCKED_NO_VISION_PROVIDER (ANTHROPIC_API_KEY ikke satt - eneste adapter med ekte bildestøtte denne runden, se D-43 §3)");
    } else {
      await section("§5 VISION OCR (LIVE modellkall, purpose:VISION)", async () => {
        const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [new AnthropicAdapter()] });
        const ocr = new ModelGatewayVisionExtractor(gateway, TENANT, `task-p1b-a-live-${runId}`);
        const extractor = new PdfExtractor(textPdfBuffer());
        try {
          const image = await extractor.renderPageToImage(1);
          const text = await ocr.transcribeText(image);
          results.p1b_vision_ocr_live = text.length > 0 ? "PASS" : "FAIL";
          diagnostics["vision_ocr_sample"] = text.slice(0, 80);
          log(`p1b_vision_ocr_live=${results.p1b_vision_ocr_live} (transcribed_len=${text.length})`);
        } finally {
          await extractor.destroy();
        }
      });
    }

    // ===== §6: FULL SYNC + Q-20 (LIVE, mot ekte innboks) =====
    await section("§6 KnowledgeSyncService.sync() med EmailAttachmentKnowledgeSource (LIVE)", async () => {
      if (results.p1b_gmail_list_messages_live !== "PASS") {
        diagnostics["sync_skip_reason"] = "gmail_list_messages_not_passing";
        log("p1b_sync_email_source_live=SKIPPED (list_messages selv ikke PASS - se §3)");
        return;
      }
      const noopOcr = {
        async transcribeText() { return ""; },
        async describeImage() { return ""; }
      };
      const registry = new KnowledgeSourceRegistry([
        { source_type: "email_attachment", tenant_id: TENANT, memory_space_id: SPACE, source_instance_id: "email:live", account: process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com", max: 5 }
      ]);
      const source = registry.build(TENANT, SPACE, "email:live", { toolGateway, identity: identity(), ocr: noopOcr });
      const sync = new KnowledgeSyncService(pool, embedding);
      const report = await sync.sync(identity(), SPACE, source);
      log(`sync report: ${JSON.stringify(report)}`);
      results.p1b_sync_email_source_live = report.failed === 0 ? "PASS" : "FAIL";
      log(`p1b_sync_email_source_live=${results.p1b_sync_email_source_live}`);

      // §Q-20: registrer en fingerprint for ETT faktisk synkronisert external_id, slett dokumentet,
      // resync - skal ALDRI gjenoppstå (suppressed, ikke created). Samme mekanisme som email-sync-integration.test.ts.
      const anyDoc = await adminPool.query(
        "SELECT knowledge_document_id, external_id FROM knowledge_documents WHERE tenant_id=$1 LIMIT 1",
        [TENANT]
      );
      const row = anyDoc.rows[0] as { knowledge_document_id: string; external_id: string } | undefined;
      if (!row) {
        diagnostics["q20_skip_reason"] = "no_synced_document_to_test_against";
        log("p1b_q20_no_resurrection_live=SKIPPED (ingen synkronisert dokument å teste mot)");
        return;
      }
      const fingerprint = computeErasureFingerprint(TENANT, "email_attachment", "email:live", row.external_id);
      await adminPool.query(
        `INSERT INTO erasure_requests (request_id, tenant_id, scope_type, scope_summary, status)
         VALUES ($1, $2, 'knowledge_document', '{}'::jsonb, 'completed')`,
        [`req-p1b-a-live-${runId}`, TENANT]
      );
      await adminPool.query("DELETE FROM knowledge_embeddings WHERE knowledge_document_id = $1", [row.knowledge_document_id]);
      await adminPool.query("DELETE FROM knowledge_documents WHERE knowledge_document_id = $1", [row.knowledge_document_id]);
      await adminPool.query(
        `INSERT INTO erasure_fingerprints (fingerprint, tenant_id, source_type, source_instance_id, erasure_request_id)
         VALUES ($1, $2, 'email_attachment', 'email:live', $3)`,
        [fingerprint, TENANT, `req-p1b-a-live-${runId}`]
      );
      const resync = await sync.sync(identity(), SPACE, source);
      const stillGone = await adminPool.query("SELECT 1 FROM knowledge_documents WHERE knowledge_document_id = $1", [row.knowledge_document_id]);
      results.p1b_q20_no_resurrection_live = resync.suppressed >= 1 && stillGone.rows.length === 0 ? "PASS" : "FAIL";
      log(`p1b_q20_no_resurrection_live=${results.p1b_q20_no_resurrection_live} (suppressed=${resync.suppressed})`);
    });

    // ===== §7: TOKEN-LEKKASJE-REVISJON =====
    await section("§7 token_leak-revisjon av persistert audit_events", async () => {
      const auditRows = await pool.query(
        "SELECT payload::text AS p FROM audit_events WHERE tenant_id=$1 AND tool_id='email' ORDER BY audit_id DESC LIMIT 20",
        [TENANT]
      );
      const leak = (auditRows.rows as Array<{ p: string }>).some(
        (r) => r.p.includes(String(emailToken)) || r.p.includes(String(clientSecret))
      );
      results.p1b_token_leak_audit = leak ? "FAIL" : "PASS";
      diagnostics["token_leak"] = String(leak);
      log(`p1b_token_leak_audit=${results.p1b_token_leak_audit}`);
    });
  }

  await cleanupTenant(TENANT).catch((err: unknown) => log(`cleanup feilet: ${(err as Error).message}`));
  await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch(() => undefined);
  return finish(pool, adminPool);
}

function finish(pool: { end: () => Promise<void> }, adminPool: { end: () => Promise<void> }): void {
  log("\n== UA-2 P1B-A HOST ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);
  const hardFail = Object.values(results).some((v) => v === "FAIL");
  log(`\nhard_fail=${hardFail}`);
  void pool.end().catch(() => undefined);
  void adminPool.end().catch(() => undefined);
}

main().catch((err: unknown) => {
  console.error(`[ua2-p1b-a-host-run] FEILET: ${(err as Error).message}`);
  process.exitCode = 1;
});
