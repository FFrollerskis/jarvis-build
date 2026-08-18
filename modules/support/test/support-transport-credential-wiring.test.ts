import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { EnvSecretProvider, FakeTransport, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService } from "@jarvis/business";
import { SupportService } from "../src/service.ts";
import { SupportTransport } from "../src/transport.ts";

/**
 * UA-3 Native Support Core HOST FIX #1 (D-67, ekte host-funn run_id
 * 60f0d682/5457c59a): rotårsaken til `tool_failed`/`credential_unavailable`
 * gjennom HELE Gmail-ingress-/svar-kjeden var at `ua3-native-support-live.ts`
 * sin EGEN `FallbackSecretProvider` alltid returnerte null for
 * JARVIS_EMAIL_TOKEN/JARVIS_GOOGLE_TOKEN (SAMME klasse feil som D-58 for
 * business-events - en akseptanse-HARNESS-bug, ikke en svakhet i selve
 * `ToolGateway`/`SupportTransport`). Denne suiten beviser mekanismen
 * presist, samme mønster som `business-event-sync-credential-wiring.test.ts`
 * (D-58): (A) EnvSecretProvider løser en KONFIGURERT JARVIS_EMAIL_TOKEN
 * gjennom SAMME gateway-graf `support.reply` faktisk bruker (ekte
 * `ToolGateway.execute()` mot embedded Postgres, ekte `SupportService`,
 * `FakeTransport` staar KUN inn for selve e-post-utsendingen);
 * (B) manglende credential gir FORTSATT `credential_unavailable` - beviser
 * at produksjonens håndhevelse er UENDRET av akseptanse-scriptets fiks;
 * (C) en credential-verdi lekker aldri i reason-/audit-feltet;
 * (D) den EKSAKTE dummy-secret-konstruksjonen HOST FIX #1 selv bruker
 * (D-57/D-67 "test-google-static") beviselig FUNGERER helt uavhengig av
 * `process.env`/`EnvSecretProvider` - den isolerte akseptanse-fiksen rører
 * ALDRI produksjonens egen secret-provider-wiring i `main.ts`/`worker-main.ts`.
 *
 * Under skrivingen av DENNE suiten (test A) ble en TREDJE, tidligere
 * uoppdaget feil avdekket (fikset i SAMME runde, `modules/support/src/
 * transport.ts`): `SupportTransport.invoke("reply", ...)` bygde internt en
 * `person_id: "system"`-identitet for det nøstede `email.send`-kallet
 * (klasse D). `resolveAuthorityMode()` (@jarvis/policy) krever
 * `identity.person_id === authority.owner_person_id` for SOVEREIGN-modus -
 * "system" matcher ALDRI en konfigurert eier, saa `email.send` fikk
 * UBETINGET "class_d_missing_approval" for HVER reply, helt uavhengig av
 * credential-status. Denne feilen var usynlig for eksisterende tester (kun
 * FAKE gateways, aldri ekte `PolicyGateway`) og ble maskert i det ekte
 * host-funnet av credential_unavailable-feilen paa selve YTRE kallet (som
 * skjedde FØR transport.invoke() i det hele tatt ble naadd). Fikset ved aa
 * gjenbruke EKSAKT samme `JARVIS_OWNER_PERSON_ID`-konvensjon som
 * `apps/api/src/main.ts`/`worker-main.ts` - se kommentaren i transport.ts.
 * Test A/D i denne filen ville FEILE uten den fiksen (verifisert manuelt
 * under utvikling).
 */
const EMAIL_REF = "JARVIS_EMAIL_TOKEN";
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT = "tenant-support-cred-wiring";
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "business",
  session_id: "sess-support-cred-wiring", device_id: "dev-support-cred-wiring", channel: "api", auth_strength: "active"
};

function ownerPolicy(): PolicyGateway {
  return new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT] }
  });
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-support-cred-wiring-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  // §O-mønster (samme som erasure-service.test.ts/business-event-sync-credential-wiring.test.ts):
  // garantert non-bypass rolle - ALDRI superbruker.
  await adminPool.query("CREATE ROLE jarvis_support_cred_wiring_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_support_cred_wiring_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Support Cred Wiring Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-support-cred-wiring-business','${TENANT}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_support_cred_wiring_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

beforeEach(() => {
  delete process.env[EMAIL_REF];
});
afterEach(() => {
  delete process.env[EMAIL_REF];
});

async function replyToFreshTicket(gateway: ToolGateway, idemSuffix: string) {
  const support = new SupportService(appPool);
  const ticket = await support.createTicket(TENANT, "business", { subject: `Cred wiring ${idemSuffix}` });
  return gateway.execute({
    identity, tool_id: "support", action: "reply",
    parameters: {
      tenant_id: TENANT, memory_space: "business", ticket_id: ticket.ticket_id,
      to: `kunde-${idemSuffix}@example.no`, subject: "Re: Cred wiring", body: "Svar",
      idempotency_key: `reply-cred-wiring-${idemSuffix}`
    }
  });
}

describe("A: EnvSecretProvider løser en KONFIGURERT JARVIS_EMAIL_TOKEN gjennom SAMME gateway-graf som support.reply bruker", () => {
  it("support.reply lykkes og ruter GJENNOM email.send naar JARVIS_EMAIL_TOKEN er satt i process.env", async () => {
    process.env[EMAIL_REF] = "real-looking-support-email-secret-xyz";
    const support = new SupportService(appPool);
    const emailFake = new FakeTransport(() => ({ data: {} }));
    const gateway = new ToolGateway(appPool, ownerPolicy(), new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()));
    const supportTransport = new SupportTransport(support, new BusinessService(appPool), gateway);
    for (const tool of firstWaveTools({ support: supportTransport, email: emailFake })) gateway.register(tool);
    const result = await replyToFreshTicket(gateway, "a");
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.data as { sent?: boolean } | undefined)?.sent).toBe(true);
    expect(emailFake.calls).toHaveLength(1);
  });
});

describe("B: manglende JARVIS_EMAIL_TOKEN gir credential_unavailable - produksjonens håndhevelse er IKKE svekket av HOST FIX #1", () => {
  it("support.reply feiler med credential_unavailable naar JARVIS_EMAIL_TOKEN mangler (SAMME EnvSecretProvider produksjonen bruker)", async () => {
    const support = new SupportService(appPool);
    const emailFake = new FakeTransport(() => ({ data: {} }));
    const gateway = new ToolGateway(appPool, ownerPolicy(), new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()));
    const supportTransport = new SupportTransport(support, new BusinessService(appPool), gateway);
    for (const tool of firstWaveTools({ support: supportTransport, email: emailFake })) gateway.register(tool);
    const result = await replyToFreshTicket(gateway, "b");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("credential_unavailable");
    // Aldri naadd frem til selve e-post-transporten - fail-closed FØR invoke().
    expect(emailFake.calls).toHaveLength(0);
  });
});

describe("C: credential-verdien lekker ALDRI i reason-/audit-feltet", () => {
  it("en satt (dummy) credential-verdi dukker aldri opp i ToolGateway sitt resultat ved en providerfeil", async () => {
    process.env[EMAIL_REF] = "SUPPORT-SUPER-SECRET-SHOULD-NEVER-LEAK-42";
    const support = new SupportService(appPool);
    const failingEmail = new FakeTransport(undefined, "gmail_simulated_outage");
    const gateway = new ToolGateway(appPool, ownerPolicy(), new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()));
    const supportTransport = new SupportTransport(support, new BusinessService(appPool), gateway);
    for (const tool of firstWaveTools({ support: supportTransport, email: failingEmail })) gateway.register(tool);
    const result = await replyToFreshTicket(gateway, "c");
    // Ytre support.reply "lykkes" (ticket/event opprettes uansett) - selve
    // e-post-utsendingen INNI feiler kontrollert (samme mønster som
    // SupportEmailService.reply(): sent=false, error satt, aldri en kastet feil).
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.data as { sent?: boolean } | undefined)?.sent).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SUPPORT-SUPER-SECRET-SHOULD-NEVER-LEAK-42");
  });
});

describe("D: den EKSAKTE dummy-secret-konstruksjonen HOST FIX #1 bruker (D-57/D-67 'test-google-static') fungerer UTEN aa røre process.env/EnvSecretProvider", () => {
  it("support.create_ticket + support.reply lykkes med en isolert test-lokal dummy-provider, aldri via produksjonens EnvSecretProvider", async () => {
    expect(process.env[EMAIL_REF]).toBeUndefined();
    const support = new SupportService(appPool);
    const emailFake = new FakeTransport(() => ({ data: {} }));
    // Identisk konstruksjon som `ua3-native-support-live.ts` etter HOST FIX #1.
    const dummySecrets = new FallbackSecretProvider(
      {
        name: "test-google-static",
        get: async (ref) => (ref === "JARVIS_EMAIL_TOKEN" || ref === "JARVIS_GOOGLE_TOKEN") ? "dummy-google-cred-native-support" : null
      },
      new BusinessInternalSecretProvider()
    );
    const gateway = new ToolGateway(appPool, ownerPolicy(), dummySecrets);
    const supportTransport = new SupportTransport(support, new BusinessService(appPool), gateway);
    for (const tool of firstWaveTools({ support: supportTransport, email: emailFake })) gateway.register(tool);

    const ticketResult = await gateway.execute({
      identity, tool_id: "support", action: "create_ticket",
      parameters: { tenant_id: TENANT, memory_space: "business", subject: "Dummy secret ticket" }
    });
    expect(ticketResult.ok).toBe(true);

    const replyResult = await replyToFreshTicket(gateway, "d");
    expect(replyResult.ok).toBe(true);
    if (replyResult.ok) expect((replyResult.data as { sent?: boolean } | undefined)?.sent).toBe(true);
    expect(emailFake.calls).toHaveLength(1);
    // Beviser at INGENTING av dette rørte produksjonens egen process.env-baserte provider.
    expect(process.env[EMAIL_REF]).toBeUndefined();
  });
});
