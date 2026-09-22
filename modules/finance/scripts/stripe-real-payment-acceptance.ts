// UA-6 FINANCE & SPEND INTEGRITY GATEWAY - STRIPE (D-109) - REAL, TEST-MODE
// LIVE ACCEPTANCE (D-225).
//
// FORMÅL: bevise de TRE navngitte STRIPE_LIVE_GATE-kriteriene
// (`stripe_payment_execution`/`stripe_refund_execution`/
// `stripe_webhook_reachability`, se docs/RUNTIME_GATES.md) som
// `stripe-live.ts` BEVISST ALDRI beviser (den bruker en fake ved
// nettverksgrensen uansett credentials, se dens egen filhode). Denne
// scriptet gjør EKTE HTTP-kall mot https://api.stripe.com via den
// EKSISTERENDE, ALLEREDE FERDIGBYGDE `StripeTransport`
// (modules/finance/src/stripe-transport.ts) - INGEN ny produksjons-
// transportkode, INGEN ny fake.
//
// ==== SIKKERHETSGRENSE (D-41 - blast radius) - LES FØR KJØRING ====
// Dette scriptet krever `JARVIS_STRIPE_TEST_SECRET_KEY` - en Stripe TEST-
// MODUS nøkkel (`sk_test_...`/`rk_test_...`), ALDRI den ekte, live
// `JARVIS_STRIPE_SECRET_KEY` som allerede står i `.env` (D-224). Scriptet
// AVBRYTER FAIL-CLOSED (kaster FØR noe kall gjøres) hvis nøkkelen ikke
// eksplisitt matcher `_test_`-mønsteret, ELLER hvis den inneholder
// `_live_` noe sted. Stripe sin plattform garanterer i tillegg at en
// test-nøkkel STRUKTURELT ALDRI kan opprette/lese/mutere et ekte, live
// objekt (test/live er fullstendig isolerte datasett på samme konto) -
// scriptets egen nøkkel-prefiks-sjekk er derfor et FØRSTE forsvarslag,
// IKKE det eneste. Som en TREDJE, uavhengig kontroll leser scriptet i
// tillegg `livemode` fra Stripe sitt eget JSON-svar på DEN FAKTISKE
// PaymentIntent-opprettelsen og avbryter umiddelbart dersom Stripe selv
// rapporterer `livemode: true` - tre uavhengige lag, ALDRI kun ett.
//
// Å hente en Stripe TEST-modus-nøkkel er GRATIS og RISIKOFRITT (ingen
// ekte penger, ingen ekte kort) - Stripe Dashboard -> øverst til høyre,
// slå PÅ "Test mode" (bryter) -> Developers -> API keys -> "Secret key"
// under TEST-modus-visningen. Legg den i .env som
// JARVIS_STRIPE_TEST_SECRET_KEY - IKKE i JARVIS_STRIPE_SECRET_KEY (den
// forblir den ekte, live nøkkelen fra D-224, urørt av dette scriptet).
//
// ==== HVA DETTE SCRIPTET IKKE GJØR (bevisst, ikke et gap) ====
// Gjenbruker IKKE `finance_stripe`-produktlogikkens wiring/idempotens/
// kill-switch/avviksdeteksjon/avstemming/tenant-isolasjon-bevis -
// `stripe-live.ts` beviser ALLEREDE alle disse grundig (ren domenelogikk,
// UAVHENGIG av ekte vs. fake nettverksgrense). Dette scriptet sitt ENESTE
// mål er de tre kriteriene ingen eksisterende kodesti beviser: at et
// EKTE Stripe-API-kall faktisk fullfører en betaling, en refusjon, og at
// en EKTE, Stripe-signert webhook-hendelse faktisk når
// `POST /webhooks/stripe` og blir korrekt behandlet.
//
// ==== TEST-FIXTURE-BETALINGSMETODE (VERIFIED_SEARCH_SNIPPET, D-109-
// disiplin) ====
// `pm_card_visa` er Stripe sin dokumenterte, offentlige test-modus-
// betalingsmetode-ID for server-side bekreftelse UTEN Stripe.js/et ekte
// kort (uavhengig websøk denne runden mot Stripe sin egen API-referanse
// - "Confirm a PaymentIntent" - og flere tredjeparts kilder som siterer
// den ordrett; direkte WebFetch mot docs.stripe.com var EGRESS-BLOKKERT,
// SAMME strukturelle begrensning som rammet stripe-transport.ts sin
// egen D-109-verifisering). Bekreftelses-kallet under
// (`confirmWithTestCardFixture()`) er BEVISST holdt UTENFOR
// `StripeTransport`/produksjonskode - Jarvis sin faktiske produktlogikk
// fester ALDRI en betalingsmetode server-side (ekte kunder betaler via
// en separat, ekstern flyt - se stripe-transport.ts sin
// `createPaymentIntent()`-kommentar) - denne funksjonen simulerer KUN
// "kunden betalte" for DETTE scriptets egne test-fixture-formål, og skal
// ALDRI forfremmes til produksjonskode.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/finance/scripts/stripe-real-payment-acceptance.ts
// (normalt via modules/finance/scripts/stripe-real-payment-acceptance-host-run.ts)
//
// Bruker UTELUKKENDE en syntetisk, kjøre-unik tenant for Jarvis-side
// fixtures - RØRER ALDRI ekte Jarvis-kundedata. All test-scaffolding
// fjernes ved slutten. De EKTE Stripe-side test-modus-objektene
// (PaymentIntent/Refund) blir BEVISST liggende i Tobias sin egen Stripe
// test-modus-dashbord (ingen ekte penger, ingen kostnad, ingen fare -
// samme prinsipp som ethvert annet Stripe-integrasjonstestbibliotek) -
// merket med `metadata.jarvis_payment_intent_id`/`jarvis_tenant_id` for
// sporbarhet om Tobias vil rydde manuelt i Stripe sin egen dashbord.

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { IdentityContext } from "@jarvis/contracts";
import { adminConfigFromEnv, assertRuntimeCredentialsConfigured, assertRuntimeRoleSafe, configFromEnv, createPool } from "@jarvis/core";
import { PolicyGateway, InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch } from "@jarvis/policy";
import { EnvSecretProvider, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, OpenLoopService } from "@jarvis/business";
import {
  FinanceService, FinanceTransport, StripeFinanceTransport,
  type FikenCredentials, type FikenCredentialsProvider,
  type StripeCredentials, type StripeCredentialsProvider, type StripePaymentWriter, type StripeTransportFactory
} from "../src/index.ts";
import { StripeTransport } from "../src/stripe-transport.ts";
import { evaluateSecretSafety, type Verdict } from "./lib/fiken-live-lib.ts";
import { createApiServer } from "../../../apps/api/src/server.ts";

void OpenLoopService; // reservert - kan trenges av en fremtidig avviks-seksjon her; ubrukt i DENNE sliceen.

const results: Record<string, Verdict> = {
  q21_runtime_role_safe: "NOT_RUN",
  test_mode_key_guard: "NOT_RUN",
  stripe_payment_execution: "NOT_RUN",
  stripe_refund_execution: "NOT_RUN",
  stripe_webhook_reachability: "NOT_RUN",
  secret_redaction: "NOT_RUN",
  cleanup: "NOT_RUN"
};

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
    log(`${name}: UVENTET FEIL - ${(err as Error).message.slice(0, 300)}`);
    return undefined;
  }
}

function mustExternalId(result: Awaited<ReturnType<InstanceType<typeof ToolGateway>["execute"]>>, label: string): string {
  if (!result.ok) throw new Error(`${label}_denied:${result.reason}`);
  if (!result.external_id) throw new Error(`${label}_did_not_return_external_id`);
  return result.external_id;
}

/** Fail-closed nøkkel-guard (FØRSTE forsvarslag - se filhode). Kaster med en tydelig, handlingsrettet feilmelding. */
function requireTestModeSecretKey(): string {
  const key = process.env["JARVIS_STRIPE_TEST_SECRET_KEY"];
  if (!key || key.trim().length === 0) {
    throw new Error(
      "JARVIS_STRIPE_TEST_SECRET_KEY er IKKE satt. Dette scriptet krever en Stripe TEST-modus-nøkkel " +
      "(Dashboard -> slå PÅ \"Test mode\" -> Developers -> API keys -> Secret key, sk_test_.../rk_test_...) - " +
      "ALDRI den ekte, live JARVIS_STRIPE_SECRET_KEY."
    );
  }
  if (key.includes("_live_")) {
    throw new Error("JARVIS_STRIPE_TEST_SECRET_KEY inneholder \"_live_\" - dette er en LIVE-nøkkel. AVBRUTT (D-41 blast radius) - bytt til en sk_test_/rk_test_-nøkkel.");
  }
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error(`JARVIS_STRIPE_TEST_SECRET_KEY matcher ikke forventet sk_test_/rk_test_-mønster (fikk prefiks "${key.slice(0, 8)}..."). AVBRUTT (D-41 blast radius).`);
  }
  return key;
}

/** TREDJE, uavhengig kontroll - se filhode. */
function assertLivemodeFalse(objectLabel: string, raw: unknown): void {
  const livemode = (raw as { livemode?: unknown } | null)?.livemode;
  if (livemode !== false) {
    throw new Error(`${objectLabel}: Stripe sitt eget svar rapporterte livemode=${JSON.stringify(livemode)}, IKKE false. AVBRUTT UMIDDELBART (D-41 blast radius) - dette skriptet skal ALDRI røre et live-objekt.`);
  }
}

/** BEVISST test-fixture-only, se filhode sin forklaring - ALDRI i produksjonskode. */
async function confirmWithTestCardFixture(secretKey: string, stripePaymentIntentId: string, idempotencyKey: string): Promise<unknown> {
  const response = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(stripePaymentIntentId)}/confirm`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "idempotency-key": idempotencyKey
    },
    body: `payment_method=${encodeURIComponent("pm_card_visa")}`
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`confirm_test_card_fixture_failed_${response.status}:${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

const runId = randomUUID().slice(0, 8);
log(`UA-6 FINANCE & SPEND INTEGRITY GATEWAY - STRIPE REAL, TEST-MODUS LIVE ACCEPTANCE (D-225) - run_id=${runId}`);

assertRuntimeCredentialsConfigured();
const pool = createPool(configFromEnv());
const adminPool = createPool(adminConfigFromEnv());

const TENANT_A = `tenant-stripe-real-${runId}`;
const OWNER_PERSON = `person-stripe-real-${runId}`;

function ownerIdentityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: `sess-stripe-real-${runId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await adminPool.query("DELETE FROM stripe_webhook_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM stripe_refunds WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM payment_intent_events WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM payment_intents WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM finance_kill_switch WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tool_executions WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM memory_spaces WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM person_tenants WHERE tenant_id = $1", [tenantId]);
  await adminPool.query("DELETE FROM tenants WHERE tenant_id = $1", [tenantId]);
}

async function selfHeal(): Promise<void> {
  try {
    const stale = await adminPool.query("SELECT tenant_id FROM tenants WHERE tenant_id LIKE 'tenant-stripe-real-%'");
    for (const row of stale.rows as Array<{ tenant_id: string }>) await cleanupTenant(row.tenant_id).catch(() => undefined);
    await adminPool.query("DELETE FROM people WHERE person_id LIKE 'person-stripe-real-%'").catch(() => undefined);
  } catch {
    // best-effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starter den EKTE Stripe CLI-en (`stripe listen`, TEST-modus - `--live` BEVISST ALDRI sendt) og venter til den skriver ut sitt FERSKE `whsec_...`-signeringssekret. */
async function startStripeListenAndCaptureSecret(port: number): Promise<{ child: ChildProcessByStdio<null, Readable, Readable>; webhookSecret: string }> {
  const cliBin = process.env["JARVIS_STRIPE_CLI_BIN"] ?? "stripe";
  const child = spawn(cliBin, ["listen", "--forward-to", `localhost:${port}/webhooks/stripe`, "--all-snapshot"], { stdio: ["ignore", "pipe", "pipe"] });
  let combinedOutput = "";
  const secretPromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`stripe_listen_timeout: ingen whsec_ funnet i CLI-output innen 20s. Sjekk at "${cliBin}" er på PATH (eller sett JARVIS_STRIPE_CLI_BIN) og at "stripe login" er kjørt. Output så langt: ${combinedOutput.slice(0, 500)}`)), 20_000);
    function onChunk(chunk: Buffer): void {
      combinedOutput += chunk.toString("utf8");
      const match = /whsec_[A-Za-z0-9]+/.exec(combinedOutput);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    }
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", (err) => { clearTimeout(timeout); reject(new Error(`stripe_listen_spawn_failed: ${err.message}`)); });
    child.on("exit", (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`stripe_listen_exited_early: code=${code} output=${combinedOutput.slice(0, 500)}`)); } });
  });
  const webhookSecret = await secretPromise;
  log(`stripe_listen: KLAR, ekte whsec_-sekret fanget (${webhookSecret.length} tegn, aldri logget i klartekst)`);
  return { child, webhookSecret };
}

async function waitForWebhookEvent(tenantId: string, timeoutMs: number): Promise<{ stripe_event_id: string; event_type: string; status: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await adminPool.query(
      `SELECT stripe_event_id, event_type, status FROM stripe_webhook_events WHERE tenant_id = $1 AND event_type = 'payment_intent.succeeded' ORDER BY received_at DESC LIMIT 1`,
      [tenantId]
    );
    if (rows.length > 0) return rows[0] as { stripe_event_id: string; event_type: string; status: string };
    await sleep(1000);
  }
  return null;
}

async function main(): Promise<void> {
  let runtimeRoleSafe = false;
  await section("Q-21 RUNTIME ROLE (obligatorisk)", async () => {
    const status = await assertRuntimeRoleSafe(pool);
    runtimeRoleSafe = true;
    results.q21_runtime_role_safe = "PASS";
    log(`q21_runtime_role_safe=PASS role=${status.role} superuser=${status.superuser} bypassrls=${status.bypassrls}`);
  });
  if (!runtimeRoleSafe) {
    for (const key of Object.keys(results)) results[key] = "BLOCKED_BY_RUNTIME_ROLE";
    return finish(true);
  }

  let testKey = "";
  await section("TEST-MODUS NØKKEL-GUARD (D-41 blast radius, FØRSTE forsvarslag - FØR noe Stripe-kall gjøres)", async () => {
    testKey = requireTestModeSecretKey();
    results.test_mode_key_guard = "PASS";
    log(`test_mode_key_guard=PASS key_prefix=${testKey.slice(0, 8)}... key_length=${testKey.length}`);
  });
  if (results.test_mode_key_guard !== "PASS") {
    for (const key of Object.keys(results)) if (results[key] === "NOT_RUN") results[key] = "BLOCKED_NO_CREDENTIALS";
    return finish(true);
  }

  await selfHeal();
  await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1,$2,'business')", [TENANT_A, `Stripe Real Acceptance ${runId}`]);
  await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1,$2)", [OWNER_PERSON, "Stripe Real Acceptance Owner"]);
  await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1,$2)", [OWNER_PERSON, TENANT_A]);
  await adminPool.query("INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1,$2,'business')", [`ms-stripe-real-${runId}`, TENANT_A]);

  const stripeTransportFactory: StripeTransportFactory = (credentials: StripeCredentials) => new StripeTransport(credentials.secretKey) as unknown as StripePaymentWriter;
  const stripeCredentialsProvider: StripeCredentialsProvider = { async getCredentials(): Promise<StripeCredentials | null> { return { secretKey: testKey }; } };
  const fikenCredentialsProvider: FikenCredentialsProvider = { async getCredentials(): Promise<FikenCredentials | null> { return null; } };
  let capturedWebhookSecret: string | null = null;
  const finance = new FinanceService(pool, undefined, stripeCredentialsProvider, stripeTransportFactory, () => capturedWebhookSecret, () => TENANT_A);

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
  });
  // `finance.submit_payment_intent` sin ToolGateway-registrering erklærer
  // `credential_ref: "JARVIS_FIKEN_REFRESH_TOKEN"` UBETINGET (provider-
  // agnostisk statisk gate - se `integrations.ts`), sjøl om FAKTISK Fiken-
  // API-kall KUN skjer for `current.provider === "fiken"` inne i
  // `FinanceService.submitPaymentIntent()`. Denne intensjonen har ALLTID
  // `provider: "stripe"` (satt over i `create_payment_intent`) - Fiken-
  // grenen kjøres derfor STRUKTURELT aldri, og denne sentinel-verdien blir
  // ALDRI lest av noen ekte Fiken-transport. Kun til stede for å tilfredsstille
  // ToolGateway sin rene tilstedeværelses-sjekk (`secrets.get(ref)` - se
  // `gateway.ts`), ALDRI validert mot Fiken sitt eget API.
  process.env.JARVIS_FIKEN_REFRESH_TOKEN ??= "unused-fiken-token-sentinel-stripe-only-acceptance";

  const secrets = new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider());
  const toolGateway = new ToolGateway(pool, policy, secrets);
  for (const tool of firstWaveTools({
    finance: new FinanceTransport(finance, fikenCredentialsProvider),
    finance_stripe: new StripeFinanceTransport(finance)
  })) toolGateway.register(tool);
  const identity = ownerIdentityFor(TENANT_A);

  async function stripeAction(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "finance_stripe", action, parameters: parameters as never });
  }
  async function financeAction(action: string, parameters: Record<string, unknown>) {
    return toolGateway.execute({ identity, tool_id: "finance", action, parameters: parameters as never });
  }

  let stripeIntentId = "";
  let stripePaymentIntentApiId = "";
  await section("STRIPE_PAYMENT_EXECUTION (EKTE create_payment_intent + EKTE bekreftelse med test-kort + EKTE refresh mot api.stripe.com)", async () => {
    const created = await financeAction("create_payment_intent", {
      tenant_id: TENANT_A, idempotency_key: `stripe-real-${runId}`, purpose: "D-225 real acceptance", amount_ore: 12_345,
      vendor_name: "D-225 test", account_code: "stripe-category", provider: "stripe"
    });
    stripeIntentId = mustExternalId(created, "stripe_create");

    // `submit_payment_intent` bor i det provider-nøytrale `finance.*`-
    // namespacet (IKKE `finance_stripe.*` - se `integrations.ts` linje
    // ~1651), ETT felles innsendingspunkt for fiken/stripe/vipps/neonomics
    // som selv grener på `current.provider` internt (`service.ts`).
    const submitResult = await financeAction("submit_payment_intent", { tenant_id: TENANT_A, payment_intent_id: stripeIntentId });
    if (!submitResult.ok) throw new Error(`submit_payment_intent_denied:${submitResult.reason}`);
    const afterSubmit = await finance.getPaymentIntent(TENANT_A, "business", stripeIntentId);
    if (!afterSubmit?.provider_ref) throw new Error("submit_payment_intent_returned_no_provider_ref");
    stripePaymentIntentApiId = afterSubmit.provider_ref;
    log(`stripe_pi_id=${stripePaymentIntentApiId} status_after_submit=${afterSubmit.provider_status}`);

    const confirmed = await confirmWithTestCardFixture(testKey, stripePaymentIntentApiId, `stripe-real-confirm-${runId}`);
    assertLivemodeFalse("confirm_payment_intent", confirmed);
    log(`confirm_response_status=${(confirmed as { status?: string }).status ?? "unknown"}`);

    const refreshed = await finance.refreshStripePaymentState(TENANT_A, "business", stripeIntentId);
    const executionOk = refreshed.state === "settled" && refreshed.settled_at !== null && refreshed.provider_ref === stripePaymentIntentApiId;
    results.stripe_payment_execution = executionOk ? "PASS" : "FAIL";
    log(`refreshed_state=${refreshed.state} settled_at=${refreshed.settled_at} -> stripe_payment_execution: ${results.stripe_payment_execution}`);
  });

  await section("STRIPE_REFUND_EXECUTION (EKTE POST /refunds mot api.stripe.com)", async () => {
    if (results.stripe_payment_execution !== "PASS") { results.stripe_refund_execution = "NOT_RUN"; return; }
    const draft = await stripeAction("request_refund", { tenant_id: TENANT_A, idempotency_key: `stripe-real-refund-${runId}`, payment_intent_id: stripeIntentId, amount_ore: 5_000 });
    const refundId = mustExternalId(draft, "refund_draft");
    const submitted1 = await finance.submitStripeRefund(TENANT_A, "business", refundId);
    const submitted2 = await finance.submitStripeRefund(TENANT_A, "business", refundId);
    const refundOk = submitted1.state === "settled" && submitted1.refund_id === submitted2.refund_id && submitted1.provider_ref !== null;
    results.stripe_refund_execution = refundOk ? "PASS" : "FAIL";
    log(`refund_state=${submitted1.state} refund_provider_ref=${submitted1.provider_ref} idempotent=${submitted1.refund_id === submitted2.refund_id} -> stripe_refund_execution: ${results.stripe_refund_execution}`);
  });

  let listenChild: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let apiServer: ReturnType<typeof createApiServer> | undefined;
  await section("STRIPE_WEBHOOK_REACHABILITY (EKTE, Stripe-signert webhook levert via `stripe listen` -> POST /webhooks/stripe)", async () => {
    apiServer = createApiServer({
      identity: { resolveIdentity: async () => ({ ok: false, reason: "not_used" }) } as never,
      sessions: {} as never, conversation: {} as never, policy, worker: {} as never,
      channelAuthority: {} as never, grants: {} as never,
      finance: { service: finance }
    });
    const port = await new Promise<number>((resolve) => {
      apiServer?.listen(0, "127.0.0.1", () => {
        const address = apiServer?.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    log(`lokal akseptanse-server lyttet på 127.0.0.1:${port}`);

    const { child, webhookSecret } = await startStripeListenAndCaptureSecret(port);
    listenChild = child;
    capturedWebhookSecret = webhookSecret;
    // Gi CLI-tunnelen en kort stund til å faktisk koble til Stripe FØR vi
    // trigger den ekte hendelsen (samme "ready, men ikke nødvendigvis
    // tilkoblet ennå"-margin som andre host-scripts bruker for eksterne
    // prosesser).
    await sleep(2000);

    // Den EKTE payment_intent.succeeded-hendelsen ble allerede utløst av
    // det EKTE confirm-kallet i STRIPE_PAYMENT_EXECUTION over - Stripe
    // sender den asynkront til `stripe listen` sin tunnel akkurat nå.
    const event = await waitForWebhookEvent(TENANT_A, 30_000);
    if (!event) {
      results.stripe_webhook_reachability = "FAIL";
      log("stripe_webhook_reachability: FAIL - ingen payment_intent.succeeded-rad ankom stripe_webhook_events innen 30s");
      return;
    }
    const reachabilityOk = event.status === "processed";
    results.stripe_webhook_reachability = reachabilityOk ? "PASS" : "FAIL";
    log(`webhook_event_id=${event.stripe_event_id} status=${event.status} -> stripe_webhook_reachability: ${results.stripe_webhook_reachability}`);
  });
  if (listenChild) listenChild.kill();
  if (apiServer) await new Promise<void>((resolve) => apiServer?.close(() => resolve()));

  await section("SECRET REDACTION (det EKTE, fangede whsec_-sekretet skal ALDRI opptre i klartekst i loggen)", async () => {
    const redactionOk = evaluateSecretSafety(logBuffer, capturedWebhookSecret ? [capturedWebhookSecret] : []);
    results.secret_redaction = redactionOk;
    log(`secret_redaction: ${results.secret_redaction}`);
  });

  await section("CLEANUP (KUN denne kjøringens egne syntetiske Jarvis-side fixtures - Stripe sine EGNE test-modus-objekter blir bevisst liggende, se filhode)", async () => {
    let cleanupOk = true;
    await cleanupTenant(TENANT_A).catch((err: unknown) => { cleanupOk = false; log(`cleanup feilet: ${(err as Error).message}`); });
    await adminPool.query("DELETE FROM people WHERE person_id = $1", [OWNER_PERSON]).catch((err: unknown) => { cleanupOk = false; log(`cleanup person feilet: ${(err as Error).message}`); });
    const remaining = await adminPool.query("SELECT count(*)::int AS n FROM tenants WHERE tenant_id = $1", [TENANT_A]);
    const leftover = (remaining.rows[0] as { n: number }).n;
    results.cleanup = cleanupOk && leftover === 0 ? "PASS" : "FAIL";
    log(`cleanup_ok=${cleanupOk} leftover_tenants=${leftover} -> cleanup: ${results.cleanup}`);
  });

  return finish(false);
}

function finish(blockedByRuntimeRole: boolean): void {
  log("\n== UA-6 FINANCE & SPEND INTEGRITY GATEWAY - STRIPE REAL, TEST-MODUS LIVE ACCEPTANCE (D-225) SUMMARY ==");
  for (const [key, value] of Object.entries(results)) log(`${key}=${value}`);
  const hardFail = blockedByRuntimeRole || Object.values(results).some((v) => v === "FAIL" || v === "NOT_RUN");
  log(`\nSTRIPE_REAL_TEST_MODE_ACCEPTANCE_RUN=true`);
  log(`STRIPE_LIVE_GATE_CANDIDATE=${hardFail ? "FAIL" : "PASS_PENDING_ARCHITECT_REVIEW"}`);
  log(`run_id=${runId}`);
  log(`hard_fail=${hardFail}`);
  if (hardFail) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
  await adminPool.end();
}
