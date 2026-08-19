// UA-4 GOOGLE ADS ADAPTER (D-83) - LIVE ACCEPTANCE
// Kjøres AV TOBIAS mot en EKTE, konfigurert Google Ads-konto (og ekte lokal
// Postgres via docker-compose). Gjenbruker KUN eksisterende arkitektur
// (@jarvis/growth GoogleAdsTransport/GrowthService, @jarvis/tool-gateway
// ToolGateway/EnvSecretProvider, @jarvis/policy, @jarvis/core) - INGEN
// alternativ testimplementasjon, INGEN produksjonsatferd endret av dette
// scriptet. Rene, avhengighetsfrie beslutningsfunksjoner er FLYTTET til
// `./lib/google-ads-live-lib.ts` slik at de kan enhetstestes direkte (denne
// filen selv kjøres KUN mot en ekte host, ALDRI unit-testet - samme mønster
// som `google-drive-reauth.ts` + `google-drive-reauth-lib.ts`).
//
// PRE-MERGE HARDENING (denne runden): D-83 sin egen rapport erkjente at
// HOST_ACTION_REQUIRED=true, men INGEN deterministisk live-kjøringsvei
// fantes ennå. Dette scriptet ER den veien - klar til å kjøres FØR Tobias
// har konfigurert Google Ads-credentials (gir da et rent, forklarende
// BLOCKED_NO_CREDENTIALS-resultat, IKKE en krasj) og igjen ETTER (gir da et
// ekte LIVE_PROVIDER_VERIFIED-resultat).
//
// LES-/RAPPORTERING-/SYNK-OMFANG KUN (Finance Integrity-grense, uendret fra
// D-83): scriptet kaller ALDRI en Google Ads-mutate-endepunkt - kun
// googleads.list_campaigns/sync_campaigns/sync_spend/sync_tracking_tags
// (`ALLOWED_GOOGLE_ADS_ACTIONS` i lib-filen, samme fire handlinger som selve
// D-83-adapteren eksponerer - strukturelt bevist i
// google-ads-live-lib.test.ts §H). INGEN budsjett/bud/pause/resume/opprett/
// slett/konvertering-opplasting forsøkes her, uansett hva den ekte kontoen
// tillater.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/growth/scripts/google-ads-live.ts
// (normalt via modules/growth/scripts/google-ads-live-host-run.ts, som
// bootstrapper workspacet/Docker/migrasjoner først - se den filen for DEN
// ENE forventede Tobias-kommandoen)
//
// Bruker UTELUKKENDE en syntetisk, kjøre-unik tenant (tenant-googleads-live-
// <run_id>-a/-b) for Jarvis-side fixtures - RØRER ALDRI ekte Jarvis-
// kunde-/kampanjedata. All test-scaffolding fjernes ved slutten (§8 i
// byggeordren). Google Ads-kontoen selv røres ALDRI (ingen skriving mot
// Google - kun lesing via GAQL search).

import { randomUUID } from "node:crypto";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { PolicyGateway, InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch } from "@jarvis/policy";
import { EnvSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { GrowthService } from "../src/service.ts";
import { GoogleAdsTransport, type GoogleAdsSyncStats } from "../src/google-ads-transport.ts";
import {
  checkRequiredEnv, classifyListCampaignsResult, classifyScanStats, computeHardFail, evaluateSecretSafety, isoDate, type Verdict
} from "./lib/google-ads-live-lib.ts";

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "NOT_RUN",
  googleads_live_env_safe: "NOT_RUN",
  googleads_live_auth: "NOT_RUN",
  googleads_live_customer_access: "NOT_RUN",
  googleads_live_provider_read: "NOT_RUN",
  googleads_live_campaign_sync: "NOT_RUN",
  googleads_live_campaign_sync_idempotent: "NOT_RUN",
  googleads_live_spend_sync: "NOT_RUN",
  googleads_live_spend_idempotent: "NOT_RUN",
  googleads_live_tracking_sync: "NOT_RUN",
  googleads_live_tracking_no_guess: "NOT_RUN",
  googleads_live_provenance: "NOT_RUN",
  googleads_live_tenant_isolation: "NOT_RUN",
  googleads_live_secret_safety: "NOT_RUN",
  googleads_live_cleanup: "NOT_RUN"
};
const diagnostics: Record<string, string> = {};

// §3/§13: ALDRI print secret-verdier. Alle log()-kall bufres slik at
// `evaluateSecretSafety()` kan bevise, EKSPLISITT og ETTERPRØVBART (ikke bare
// "vi prøvde å huske å ikke printe det"), at ingen av dem noensinne inneholdt
// en ekte credential-verdi.
const logBuffer: string[] = [];
function log(msg: string): void {
  logBuffer.push(msg);
  console.log(msg);
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

const runId = randomUUID().slice(0, 8);
log(`UA-4 GOOGLE ADS ADAPTER (D-83) LIVE ACCEPTANCE - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-googleads-live-${runId}-a`;
const TENANT_B = `tenant-googleads-live-${runId}-b`; // tenant-isolasjon: annen tenant, skal forbli urørt av synk mot A
const OWNER_PERSON = `person-googleads-live-${runId}`;

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-googleads-live-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

function assertSafeIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`googleads_live_cleanup_unsafe_identifier: "${name}"`);
}

interface TenantFkBlocker {
  table: string;
  constraint: string;
  rows: number;
}

/** Schema-drevet (ikke hardkodet) sjekk FØR `DELETE FROM tenants` - samme mønster som alle øvrige UA-3/UA-4-live-scriptene. */
async function findBlockingTenantDependencies(tenantId: string): Promise<TenantFkBlocker[]> {
  const { rows: fkRows } = await adminPool.query(`
    SELECT tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'tenants' AND kcu.column_name = 'tenant_id'
  `);
  const blockers: TenantFkBlocker[] = [];
  for (const row of fkRows as Array<{ table_name: string; constraint_name: string }>) {
    assertSafeIdentifier(row.table_name);
    const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM "${row.table_name}" WHERE tenant_id = $1`, [tenantId]);
    const n = (rows[0] as { n: number }).n;
    if (n > 0) blockers.push({ table: row.table_name, constraint: row.constraint_name, rows: n });
  }
  return blockers;
}

/**
 * §8 i byggeordren: sletter UTELUKKENDE data DENNE runneren selv opprettet
 * (kjøre-unik syntetisk tenant, HVER DELETE tenant_id-scopet) - RØRER ALDRI
 * ekte, pre-eksisterende Jarvis-kampanjedata, og RØRER ALDRI selve Google
 * Ads-kontoen. FK-rekkefølge: `marketing_campaign_tracking_tags` (D-82,
 * INGEN ON DELETE CASCADE fra marketing_campaigns) MÅ slettes FØR
 * marketing_campaigns, ellers blokkerer FK-constrainten slettingen - lærdom
 * anvendt proaktivt (samme feilklasse som D-67/D-69/D-72 for andre tabeller).
 */
async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM marketing_campaign_tracking_tags WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_attributions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_spend_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_campaign_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_experiments WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM marketing_campaigns WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM business_open_loops WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);

  const blockers = await findBlockingTenantDependencies(tenantId);
  if (blockers.length > 0) {
    for (const b of blockers) log(`blocking_fk_table=${b.table} blocking_fk_name=${b.constraint} rows_for_test_tenant=${b.rows}`);
    throw new Error(`googleads_live_cleanup_blocked: ${blockers.length} uventet(e) FK-refererende tabell(er) har fortsatt rader for ${tenantId}`);
  }
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-googleads-live-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-googleads-live-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE (obligatorisk, UAVHENGIG av Google Ads-credentials)", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    diagnostics["runtime_current_user"] = status.role;
    diagnostics["runtime_role_superuser"] = String(status.superuser);
    diagnostics["runtime_role_bypassrls"] = String(status.bypassrls);
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    log("\nGOOGLE ADS LIVE-AKSEPTANSE KAN IKKE BEVISES: runtime-rollen er ikke trygg (Q-21-regresjon). Ingen Google Ads-kall forsøkt.");
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish(true);
  }

  // ===== §3 ENV-PREKSJEKK (KUN tilstedeværelse, ALDRI verdi) =====
  let refreshToken = "";
  let developerToken = "";
  let customerId = "";
  const envCheck = checkRequiredEnv(process.env as Record<string, string | undefined>);
  await section("§3 ENV-PREKSJEKK (kun tilstedeværelse - ALDRI verdi printet)", async () => {
    const loginCustomerIdConfigured = Boolean(process.env["JARVIS_GOOGLE_ADS_LOGIN_CUSTOMER_ID"]);
    log(`optional_login_customer_id_configured=${loginCustomerIdConfigured}`);
    if (!envCheck.configured) {
      results.googleads_live_env_safe = "BLOCKED_NO_CREDENTIALS";
      log(`googleads_live_env_safe=BLOCKED_NO_CREDENTIALS missing_env_vars=${envCheck.missing.join(",")} - INGEN Google Ads-kall vil bli forsøkt. Se D-83 §11 i DECISIONS_AND_ASSUMPTIONS.md for nøyaktig Tobias-oppsettsekvens.`);
      return;
    }
    results.googleads_live_env_safe = "PASS";
    refreshToken = process.env["JARVIS_GOOGLE_ADS_REFRESH_TOKEN"] ?? "";
    developerToken = process.env["JARVIS_GOOGLE_ADS_DEVELOPER_TOKEN"] ?? "";
    customerId = process.env["JARVIS_GOOGLE_ADS_CUSTOMER_ID"] ?? "";
    log("googleads_live_env_safe=PASS (alle påkrevde variabler tilstede - ingen verdi logget)");
  });

  if (!envCheck.configured) {
    // BLOCKED_NO_CREDENTIALS er en FORVENTET, IKKE-krasjende tilstand FØR
    // Tobias har fullført oppsettsekvensen (§11/§14 i byggeordren) - ALDRI en
    // runner-feil. Alle leverandøravhengige markører forblir BLOCKED_NO_CREDENTIALS;
    // secret_safety/cleanup bevises likevel eksplisitt (trivielt sanne når
    // ingenting ble opprettet/logget), Q-21 er allerede bevist over.
    for (const key of Object.keys(results)) {
      if (key === "q21_runtime_role_safe" || key === "googleads_live_env_safe") continue;
      results[key] = "BLOCKED_NO_CREDENTIALS";
    }
    await selfHeal();
    results.googleads_live_cleanup = "PASS";
    log("googleads_live_cleanup=PASS (ingen fixtures opprettet - selfHeal() kjørt for å fjerne ev. rester fra en tidligere avbrutt kjøring)");
    results.googleads_live_secret_safety = evaluateSecretSafety(logBuffer, []);
    return finish(false);
  }

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business'), ($3,$4,'business')", [
    TENANT_A, `Google Ads Live A ${runId}`, TENANT_B, `Google Ads Live B ${runId}`
  ]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "Google Ads Live Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2), ($1,$3)", [OWNER_PERSON, TENANT_A, TENANT_B]);
  await adminPool.query(
    "INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business'), ($3,$4,'business')",
    [`ms-gads-a-${runId}`, TENANT_A, `ms-gads-b-${runId}`, TENANT_B]
  );

  const growth = new GrowthService(pool);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
  });
  const secrets = new EnvSecretProvider();
  const toolGateway = new ToolGateway(pool, policy, secrets);
  for (const tool of firstWaveTools({ googleads: new GoogleAdsTransport(growth) })) toolGateway.register(tool);
  const identity = ownerIdentityFor(TENANT_A);

  // §2/§12 i byggeordren: KUN de fire kjente, mutate-frie googleads.*-
  // handlingene kalles noensinne fra dette scriptet (ALLOWED_GOOGLE_ADS_ACTIONS,
  // strukturelt bevist i google-ads-live-lib.test.ts §H mot DENNE filens
  // egen kildetekst).
  async function googleads(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "googleads", action, parameters: parameters as never });
  }

  // ===== §4 LIVE AKSEPTANSE - LES-SIDE (auth/customer-access/provider-read i ÉTT kall) =====
  await section("§4 LIVE LESING (auth + customer-access + provider-read, ETT kall - GAQL SELECT, INGEN mutate)", async () => {
    const listResult = await googleads("list_campaigns", { tenant_id: TENANT_A });
    const classified = classifyListCampaignsResult(listResult);
    results.googleads_live_auth = classified.auth;
    results.googleads_live_customer_access = classified.customerAccess;
    results.googleads_live_provider_read = classified.providerRead;
    diagnostics["googleads_live_campaign_count_from_provider"] = String(classified.campaignCount);
    if (listResult.ok) {
      log(`list_campaigns_ok=true provider_campaign_count=${classified.campaignCount} -> auth/customer_access/provider_read: PASS (0 kampanjer er et GYLDIG, ikke-feilende resultat - se §4 i byggeordren)`);
    } else {
      log(`list_campaigns_ok=false reason=${listResult.reason} -> auth:${classified.auth} customer_access:${classified.customerAccess} provider_read:${classified.providerRead}`);
    }
  });

  const authOk = results.googleads_live_auth === "PASS" && results.googleads_live_customer_access === "PASS" && results.googleads_live_provider_read === "PASS";
  if (!authOk) {
    log("\nGoogle Ads-autentisering/kontotilgang feilet - videre live-seksjoner (synk/idempotens/sporing) HOPPES OVER (ville uansett feile på samme root cause). Se D-83 §11 i DECISIONS_AND_ASSUMPTIONS.md for oppsettsekvensen.");
    for (const key of [
      "googleads_live_campaign_sync", "googleads_live_campaign_sync_idempotent", "googleads_live_spend_sync", "googleads_live_spend_idempotent",
      "googleads_live_tracking_sync", "googleads_live_tracking_no_guess", "googleads_live_provenance"
    ]) {
      results[key] = "FAIL";
    }
    results.googleads_live_tenant_isolation = "PASS"; // trivielt sant - INGEN skriving mot noen tenant skjedde
    diagnostics["tenant_isolation_note"] = "auth/customer-access feilet FØR noen skriving - tenant-isolasjon er derfor triviell (ingenting å lekke)";
  } else {
    // ===== §5 LIVE KAMPANJESYNK + IDEMPOTENS =====
    await section("§5 LIVE KAMPANJESYNK + IDEMPOTENS (samme applikasjonssti som produksjon: googleads.sync_campaigns via ToolGateway)", async () => {
      const first = await googleads("sync_campaigns", { tenant_id: TENANT_A });
      results.googleads_live_campaign_sync = first.ok ? "PASS" : "FAIL";
      const firstStats = first.ok ? ((first.data as { data?: GoogleAdsSyncStats }).data ?? (first.data as unknown as GoogleAdsSyncStats)) : undefined;
      log(`sync_campaigns_1_ok=${first.ok} stats=${JSON.stringify(firstStats)} -> googleads_live_campaign_sync: ${results.googleads_live_campaign_sync}`);
      if (!first.ok) return;

      const campaignsAfterFirst = await growth.listCampaigns(TENANT_A, "business", "all");
      const countAfterFirst = campaignsAfterFirst.length;
      diagnostics["googleads_live_campaigns_synced_into_growth_core"] = String(countAfterFirst);

      const second = await googleads("sync_campaigns", { tenant_id: TENANT_A });
      const campaignsAfterSecond = await growth.listCampaigns(TENANT_A, "business", "all");
      results.googleads_live_campaign_sync_idempotent = second.ok && campaignsAfterSecond.length === countAfterFirst ? "PASS" : "FAIL";
      log(
        `sync_campaigns_2_ok=${second.ok} campaigns_after_first=${countAfterFirst} campaigns_after_second=${campaignsAfterSecond.length} ` +
          `-> googleads_live_campaign_sync_idempotent: ${results.googleads_live_campaign_sync_idempotent} (re-synk MÅ ALDRI duplisere kampanjerader)`
      );
    });

    const syncedCampaigns = results.googleads_live_campaign_sync === "PASS" ? await growth.listCampaigns(TENANT_A, "business", "all") : [];

    // ===== §5 LIVE UTGIFTSSYNK + IDEMPOTENS (siste 30 fullførte dager - en trygg, avgrenset lese-periode) =====
    await section("§5 LIVE UTGIFTSSYNK + IDEMPOTENS (googleads.sync_spend, siste 30 fullførte dager)", async () => {
      const today = new Date();
      const endDate = isoDate(new Date(today.getTime() - 86_400_000)); // i går (unngår ufullstendig inneværende dag)
      const startDate = isoDate(new Date(today.getTime() - 31 * 86_400_000));
      diagnostics["googleads_live_spend_window"] = `${startDate}..${endDate}`;

      const first = await googleads("sync_spend", { tenant_id: TENANT_A, start_date: startDate, end_date: endDate });
      if (!first.ok) {
        results.googleads_live_spend_sync = "FAIL";
        results.googleads_live_spend_idempotent = "FAIL";
        results.googleads_live_provenance = "FAIL";
        log(`sync_spend_1_ok=false reason=${first.reason} -> googleads_live_spend_sync: FAIL`);
        return;
      }
      const firstStats = ((first.data as { data?: GoogleAdsSyncStats }).data ?? (first.data as unknown as GoogleAdsSyncStats));
      log(`sync_spend_1_ok=true stats=${JSON.stringify(firstStats)}`);
      results.googleads_live_spend_sync = classifyScanStats(firstStats);

      if (results.googleads_live_spend_sync === "NO_DATA") {
        results.googleads_live_spend_idempotent = "NO_DATA";
        results.googleads_live_provenance = "NO_DATA";
        log(`googleads_live_spend_sync=NO_DATA (kontoen har reelt sett INGEN forbruk i vinduet ${startDate}..${endDate} - dette er IKKE en implementasjonsfeil)`);
        return;
      }

      // Provenance-bevis: for HVER faktisk synket kampanje, sjekk minst én spend_event med source_type=provider_sync og en googleads:-source_pointer.
      let provenanceOk = syncedCampaigns.length > 0;
      const sampledRowCounts: Record<string, number> = {};
      for (const c of syncedCampaigns) {
        const events = await growth.listSpendEvents(TENANT_A, "business", c.campaign_id);
        sampledRowCounts[c.external_campaign_id ?? c.campaign_id] = events.length;
        if (events.length === 0) continue;
        const allProviderSynced = events.every((e) => e.source_type === "provider_sync" && (e.source_pointer ?? "").startsWith(`googleads:customers/${customerId}/campaigns/`));
        if (!allProviderSynced) provenanceOk = false;
      }
      results.googleads_live_provenance = provenanceOk ? "PASS" : "FAIL";
      log(`provenance_row_counts=${JSON.stringify(sampledRowCounts)} -> googleads_live_provenance: ${results.googleads_live_provenance}`);

      // Idempotens: re-kjør SAMME vindu, antall spend_events-rader per kampanje MÅ være uendret (ingen duplikat).
      const second = await googleads("sync_spend", { tenant_id: TENANT_A, start_date: startDate, end_date: endDate });
      let idempotentOk = second.ok;
      for (const c of syncedCampaigns) {
        const eventsAfter = await growth.listSpendEvents(TENANT_A, "business", c.campaign_id);
        if (eventsAfter.length !== (sampledRowCounts[c.external_campaign_id ?? c.campaign_id] ?? 0)) idempotentOk = false;
      }
      results.googleads_live_spend_idempotent = idempotentOk ? "PASS" : "FAIL";
      log(`sync_spend_2_ok=${second.ok} -> googleads_live_spend_idempotent: ${results.googleads_live_spend_idempotent} (re-synk av SAMME vindu MÅ ALDRI endre radantall)`);
    });

    // ===== §6 LIVE GCLID/D-82-SPORING (én ferdig fullført dag - i går, per click_view sin enkelt-dags-begrensning) =====
    await section("§6 LIVE GCLID/D-82-SPORING (googleads.sync_tracking_tags, ÉN dag - i går)", async () => {
      const trackingDate = isoDate(new Date(Date.now() - 86_400_000));
      diagnostics["googleads_live_tracking_date"] = trackingDate;

      const first = await googleads("sync_tracking_tags", { tenant_id: TENANT_A, date: trackingDate });
      if (!first.ok) {
        results.googleads_live_tracking_sync = "FAIL";
        results.googleads_live_tracking_no_guess = "FAIL";
        log(`sync_tracking_tags_ok=false reason=${first.reason} -> googleads_live_tracking_sync: FAIL`);
        return;
      }
      const stats = ((first.data as { data?: GoogleAdsSyncStats }).data ?? (first.data as unknown as GoogleAdsSyncStats));
      log(`sync_tracking_tags_ok=true stats=${JSON.stringify(stats)}`);
      results.googleads_live_tracking_sync = classifyScanStats(stats, "campaign_not_yet_synced");
      if (results.googleads_live_tracking_sync === "NO_DATA") {
        log(`googleads_live_tracking_sync=NO_DATA (INGEN gclid-klikk registrert hos Google for ${trackingDate} - dette er IKKE en implementasjonsfeil, og INGEN gclid ble oppfunnet)`);
      }

      // NO-GUESS-BEVIS (§6 i byggeordren, alltid kjørbart uansett scanned-tall):
      // antall FAKTISK registrerte sporingstagger denne kjøringen kan ALDRI
      // overstige antall RÅE gclid-rader Google selv returnerte (`stats.synced
      // <= stats.scanned` er en strukturell invariant i syncTrackingTags() -
      // bevises her direkte mot den ekte kontoen, ikke bare i suiten).
      let registeredCount = 0;
      for (const c of syncedCampaigns) registeredCount += (await growth.listCampaignTrackingTags(TENANT_A, "business", c.campaign_id)).length;
      results.googleads_live_tracking_no_guess = registeredCount <= stats.scanned ? "PASS" : "FAIL";
      log(`registered_tracking_tags=${registeredCount} raw_gclid_rows_from_provider=${stats.scanned} -> googleads_live_tracking_no_guess: ${results.googleads_live_tracking_no_guess} (registrert antall kan ALDRI overstige rått antall - ingen fabrikkert gclid)`);
    });

    // ===== §7 TENANT-ISOLASJON =====
    await section("§7 TENANT-ISOLASJON (synk skjedde KUN mot TENANT_A - TENANT_B skal forbli 100% urørt)", async () => {
      const campaignsB = await growth.listCampaigns(TENANT_B, "business", "all");
      results.googleads_live_tenant_isolation = campaignsB.length === 0 ? "PASS" : "FAIL";
      log(`tenant_b_campaigns=${campaignsB.length} -> googleads_live_tenant_isolation: ${results.googleads_live_tenant_isolation}`);
    });
  }

  // ===== §8 CLEANUP =====
  await section("§8 CLEANUP (KUN denne kjøringens egne syntetiske fixtures - Google Ads-kontoen ALDRI rørt)", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup A feilet: ${(err as Error).message}`); });
    await cleanupTenant(TENANT_B).catch((err: unknown) => { cleanupOk = false; log(`cleanup B feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => {
      cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`);
    });
    const remainingCampaigns = await adminPool.query("SELECT count(*)::int AS n FROM marketing_campaigns WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverCampaigns = (remainingCampaigns.rows[0] as { n: number }).n;
    const remainingTenants = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    const leftoverTenants = (remainingTenants.rows[0] as { n: number }).n;
    results.googleads_live_cleanup = cleanupOk && leftoverCampaigns === 0 && leftoverTenants === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_campaigns=${leftoverCampaigns} leftover_tenants=${leftoverTenants} -> googleads_live_cleanup: ${results.googleads_live_cleanup}`);
  });

  // ===== §13 SECRET SAFETY (etterprøvbart bevis, ikke en antakelse - evalueres
  // SIST, ETTER cleanup-loggingen, slik at HELE denne kjøringens loggbuffer
  // er dekket, ikke bare loggen frem til synk-seksjonene) =====
  results.googleads_live_secret_safety = evaluateSecretSafety(logBuffer, [refreshToken, developerToken, process.env["JARVIS_GOOGLE_CLIENT_SECRET"] ?? ""]);

  return finish(false);
}

function finish(blockedByRuntimeRole: boolean): void {
  log("\n== UA-4 GOOGLE ADS ADAPTER (D-83) LIVE ACCEPTANCE SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  for (const [key, value] of Object.entries(diagnostics)) log(`${key}=${value}`);

  const credentialsConfigured = results.googleads_live_env_safe === "PASS";
  const hardFail = computeHardFail({ blockedByRuntimeRole, credentialsConfigured, results });
  const liveProviderVerified = !blockedByRuntimeRole && credentialsConfigured && !hardFail;

  log(`\nrun_id=${runId} credentials_configured=${credentialsConfigured} LIVE_PROVIDER_VERIFIED=${liveProviderVerified} hard_fail=${hardFail}`);
  if (!credentialsConfigured && !blockedByRuntimeRole) {
    log("Google Ads-credentials er IKKE konfigurert ennå - dette er FORVENTET FØR Tobias fullfører oppsettsekvensen (se D-83 §11 i DECISIONS_AND_ASSUMPTIONS.md). Runneren selv er klar (LIVE_RUNNER_READY=true).");
  }
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}
