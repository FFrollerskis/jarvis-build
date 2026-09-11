import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import type { DeviceRegistry } from "@jarvis/policy";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";

/**
 * D-131b (uavhengig arkitektkontroll av PR #79, HEAD 72c4d0e - TOCTOU-funn):
 * DEN ENE fingerprint-funksjonen, brukt av `DeviceService`,
 * `SessionGrantService` og `DeviceEnrollmentService`. Tidligere fantes
 * identiske `sha256Hex()`-kopier i alle tre filene - harmløst for HASHING,
 * men et upåaktet sted en fremtidig endring kunne latt dem divergere. Delt
 * her (der nøkkelen selv leses) i stedet for i en fjerde fil.
 */
export function fingerprintPem(pem: string): string {
  return createHash("sha256").update(pem, "utf8").digest("hex");
}

/**
 * Enhetsidentitet (fase 8-fundament): enheter registreres server-side med
 * offentlig nøkkel (genereres på enheten - Secure Enclave på iPhone/Watch).
 * Klient-sendt device_id alene stoles aldri på: forhøyet auth_strength og
 * klasse D-godkjenninger krever signatur fra REGISTRERT enhetsnøkkel.
 */
export class DeviceService {
  private readonly challenges = new Map<string, { device_id: string; expires: number }>();

  constructor(private readonly pool: pg.Pool) {}

  /**
   * D-131 (uavhengig arkitektkontroll av PR #79, funn 2): skriver enhetsraden
   * PÅ EN EKSISTERENDE TRANSAKSJONSKLIENT, og gjør INGEN autorisasjon i det
   * hele tatt. Kalleren MÅ ha bevist innrullerings-autoritet først - se
   * `DeviceEnrollmentService`, som er den ENESTE nettverksnære veien hit.
   *
   * EIERSKAPSGARDEN (`WHERE devices.tenant_id = ... AND devices.person_id = ...`
   * på `DO UPDATE`) er ny og gjelder ALLE kallere, også betrodde: en
   * `device_id` som allerede tilhører en annen person/tenant kan ALDRI
   * overtas ved å skrive en ny `public_key_pem`. Den gamle `ON CONFLICT
   * (device_id) DO UPDATE SET public_key_pem = $5` gjorde nettopp det.
   *
   * Returnerer `false` når garden slo inn (0 rader) - kalleren avgjør om det
   * skal bli et avslag eller en feil.
   */
  async registerDeviceOn(
    client: pg.PoolClient,
    principal: { tenant_id: string; person_id: string },
    device: { device_id: string; kind: string; public_key_pem: string }
  ): Promise<boolean> {
    createPublicKey(device.public_key_pem); // valider PEM før lagring
    let result;
    try {
      result = await client.query(
        `INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (device_id) DO UPDATE
           SET public_key_pem = EXCLUDED.public_key_pem, kind = EXCLUDED.kind
         WHERE devices.tenant_id = EXCLUDED.tenant_id AND devices.person_id = EXCLUDED.person_id
         RETURNING device_id`,
        [device.device_id, principal.tenant_id, principal.person_id, device.kind, device.public_key_pem]
      );
    } catch (err) {
      // En kolliderende rad i en ANNEN tenant er ikke synlig under RLS, så
      // Postgres avviser `ON CONFLICT DO UPDATE` mot den med en RLS-/unik-feil
      // i stedet for å returnere 0 rader. Begge betyr det SAMME for oss -
      // `device_id` er opptatt av en annen prinsipal - og begge må bli et
      // avslag, aldri en 500 som lekker at ID-en finnes et annet sted.
      const code = (err as { code?: string }).code;
      if (code === "42501" || code === "23505" || code === "23503") {
        return false;
      }
      throw err;
    }
    if (!result.rowCount) {
      return false;
    }
    await writeAudit(
      client,
      { tenant_id: principal.tenant_id, person_id: principal.person_id, device_id: device.device_id },
      { type: "device.registered", payload: { device_id: device.device_id, kind: device.kind } }
    );
    return true;
  }

  /**
   * BETRODD server-side seeding/provisjonering (tester, `seedOwner()`-lignende
   * oppsett). Gjør INGEN autorisasjon - navnet sier det, slik at ingen
   * fremtidig rute kobler den til nettverket ved et uhell. Nettverksveien er
   * `DeviceEnrollmentService.enroll()`, som krever eksplisitt eier-/bootstrap-
   * autoritet.
   *
   * Kaller BEVISST ikke `SessionGrantService.revokeForDeviceOn()`: den er for
   * NØKKELROTASJON på en enhet som allerede kan ha utestående grants, og den
   * hører hjemme i innrulleringsstien. Utestående grants blir uansett ugyldige
   * strukturelt, fordi `SessionGrantService.verify()` sammenligner mot
   * nøkkelens fingerprint slik den står NÅ.
   */
  async registerDeviceTrusted(
    identity: IdentityContext,
    device: { device_id: string; kind: string; public_key_pem: string }
  ): Promise<void> {
    const written = await withTenantTransaction(this.pool, identity.tenant_id, (client) =>
      this.registerDeviceOn(client, identity, device)
    );
    if (!written) {
      throw new Error(`device_owned_by_other_principal: ${device.device_id}`);
    }
  }

  /** Challenge-respons: klienten signerer en engangs-nonce med enhetsnøkkelen. */
  issueChallenge(deviceId: string): string {
    const challenge = `chal-${randomUUID()}`;
    this.challenges.set(challenge, { device_id: deviceId, expires: Date.now() + 60_000 });
    return challenge;
  }

  /**
   * Fingerprint av nøkkelen som FAKTISK verifiserte signaturen, eller `null`
   * ved avslag (auth_strength kan heves når resultatet ikke er `null`).
   *
   * D-131b (uavhengig arkitektkontroll av PR #79, HEAD 72c4d0e - TOCTOU-funn):
   * denne metoden kjører i SIN EGEN transaksjon, atskilt i tid fra enhver
   * senere mutasjon (sesjon/grant/innrullering/rotasjon) som stoler på
   * resultatet. Tidligere returnerte den kun `boolean`, og kalleren utstedte
   * et bevis mot HVA ENN NØKKEL SOM STO I RADEN på et SENERE tidspunkt - roterte
   * nøkkelen i mellomtiden, kunne en forespørsel signert med den GAMLE nøkkelen
   * ende opp med et bærer-bevis fingerprintet til den NYE. Ved å returnere
   * fingerprinten av den NØYAKTIGE nøkkelen som ble brukt her, kan kalleren
   * (`authorizeProvenDevice()`/`DeviceEnrollmentService.enroll()`) låse og
   * lese raden PÅ NYTT inne i sin egen mutasjonstransaksjon og kreve et EKSAKT
   * fingerprint-treff FØR noen skriving - se de filene for resten av lukkingen.
   *
   * D-123 (Q-32 punkt 2): valgfri `personId` binder beviset til en PÅSTÅTT
   * eier. Uten den svarer metoden kun på «holder noen den private nøkkelen til
   * enhet X?», og en kaller som holder sin EGEN registrerte enhetsnøkkel kunne
   * derfor bevise enheten mens den påsto en ANNEN persons `person_id`.
   */
  async verifyChallenge(
    tenantId: string,
    deviceId: string,
    challenge: string,
    signatureB64: string,
    personId?: string
  ): Promise<string | null> {
    const pending = this.challenges.get(challenge);
    if (!pending || pending.device_id !== deviceId || pending.expires < Date.now()) {
      return null;
    }
    this.challenges.delete(challenge); // engangs - replay av challenge er umulig
    const proven = await this.publicKeyFromDb(tenantId, deviceId, personId);
    if (!proven) {
      return null;
    }
    try {
      const ok = verify(null, Buffer.from(challenge, "utf8"), proven.key, Buffer.from(signatureB64, "base64"));
      return ok ? proven.fingerprint : null;
    } catch {
      return null;
    }
  }

  /**
   * D-131b: lås OG les enhetens registrerte nøkkel PÅ NYTT, INNE I kallerens
   * egen mutasjonstransaksjon - den andre halvparten av TOCTOU-lukkingen over.
   * `FOR UPDATE` holder raden låst til transaksjonen committer eller ruller
   * tilbake, slik at en SAMTIDIG rotasjon/tilbakekalling for SAMME enhet må
   * vente til denne autorisasjonen er avgjort (og omvendt) - de kan aldri
   * interleaves. Returnerer `null` når enheten mangler nøkkel (tilbakekalt)
   * ELLER ikke tilhører den påståtte person/tenant - kalleren skiller ikke på
   * de to, av samme "aldri lekk hvorfor"-grunn som `checkAuthorizationOn()`.
   */
  async lockDeviceKeyOn(
    client: pg.PoolClient,
    principal: { tenant_id: string; person_id: string; device_id: string }
  ): Promise<{ fingerprint: string } | null> {
    const result = await client.query(
      "SELECT public_key_pem FROM devices WHERE device_id = $1 AND tenant_id = $2 AND person_id = $3 FOR UPDATE",
      [principal.device_id, principal.tenant_id, principal.person_id]
    );
    const pem = (result.rows[0] as { public_key_pem: string | null } | undefined)?.public_key_pem;
    return pem ? { fingerprint: fingerprintPem(pem) } : null;
  }

  private async publicKeyFromDb(
    tenantId: string,
    deviceId: string,
    personId?: string
  ): Promise<{ key: KeyObject; fingerprint: string } | null> {
    // Tenant-RLS gjelder allerede via `withTenantTransaction`; `person_id`
    // legges på som et EKSPLISITT predikat når kalleren har oppgitt en påstått
    // eier, slik at en enhet i riktig tenant men hos feil person ikke kan
    // bevise seg. En enhet uten `public_key_pem` (tilbakekalt) gir `null`.
    const result = await withTenantTransaction(this.pool, tenantId, (client) =>
      personId === undefined
        ? client.query("SELECT public_key_pem FROM devices WHERE device_id = $1", [deviceId])
        : client.query("SELECT public_key_pem FROM devices WHERE device_id = $1 AND person_id = $2", [
            deviceId,
            personId
          ])
    );
    const pem = (result.rows[0] as { public_key_pem: string | null } | undefined)?.public_key_pem;
    return pem ? { key: createPublicKey(pem), fingerprint: fingerprintPem(pem) } : null;
  }
}

/**
 * DB-basert enhetsregister for Policy Gateway: godkjenninger verifiseres mot
 * registrerte nøkler i devices-tabellen (tenant-RLS gjelder). Synkron
 * oppslags-cache med eksplisitt refresh (policy-grensesnittet er synkront).
 */
export class PgDeviceRegistry implements DeviceRegistry {
  private readonly cache = new Map<string, KeyObject>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string
  ) {}

  async refresh(): Promise<void> {
    const result = await withTenantTransaction(this.pool, this.tenantId, (client) =>
      client.query("SELECT device_id, public_key_pem FROM devices WHERE public_key_pem IS NOT NULL")
    );
    this.cache.clear();
    for (const row of result.rows as Array<{ device_id: string; public_key_pem: string }>) {
      this.cache.set(row.device_id, createPublicKey(row.public_key_pem));
    }
  }

  publicKeyFor(deviceId: string): KeyObject | undefined {
    return this.cache.get(deviceId);
  }
}

/** Push-varsling bak adapter. APNs krever Apple-miljø - skallet er UVERIFISERT. */
export interface PushAdapter {
  readonly name: string;
  send(deviceId: string, title: string, body: string): Promise<void>;
}

export class FakePushAdapter implements PushAdapter {
  readonly name = "fake-push";
  readonly sent: Array<{ deviceId: string; title: string; body: string }> = [];
  async send(deviceId: string, title: string, body: string): Promise<void> {
    this.sent.push({ deviceId, title, body });
  }
}

export class ApnsPushAdapter implements PushAdapter {
  readonly name = "apns";
  async send(): Promise<void> {
    throw new Error("apns_unverified: krever Apple-utviklerkonto og p8-noekkel (fase 8-klientmiljoe)");
  }
}
