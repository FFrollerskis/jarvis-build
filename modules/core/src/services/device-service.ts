import { createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import type { DeviceRegistry } from "@jarvis/policy";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";

/**
 * Enhetsidentitet (fase 8-fundament): enheter registreres server-side med
 * offentlig nøkkel (genereres på enheten - Secure Enclave på iPhone/Watch).
 * Klient-sendt device_id alene stoles aldri på: forhøyet auth_strength og
 * klasse D-godkjenninger krever signatur fra REGISTRERT enhetsnøkkel.
 */
export class DeviceService {
  private readonly challenges = new Map<string, { device_id: string; expires: number }>();

  constructor(private readonly pool: pg.Pool) {}

  async registerDevice(
    identity: IdentityContext,
    device: { device_id: string; kind: string; public_key_pem: string }
  ): Promise<void> {
    createPublicKey(device.public_key_pem); // valider PEM før lagring
    await withTenantTransaction(this.pool, identity.tenant_id, async (client) => {
      await client.query(
        `INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (device_id) DO UPDATE SET public_key_pem = $5, kind = $4`,
        [device.device_id, identity.tenant_id, identity.person_id, device.kind, device.public_key_pem]
      );
      await writeAudit(client, identity, {
        type: "device.registered",
        payload: { device_id: device.device_id, kind: device.kind }
      });
    });
  }

  /** Challenge-respons: klienten signerer en engangs-nonce med enhetsnøkkelen. */
  issueChallenge(deviceId: string): string {
    const challenge = `chal-${randomUUID()}`;
    this.challenges.set(challenge, { device_id: deviceId, expires: Date.now() + 60_000 });
    return challenge;
  }

  /**
   * true => enheten har bevist besittelse av privat nøkkel (auth_strength kan heves).
   *
   * D-123 (Q-32 punkt 2): valgfri `personId` binder beviset til en PÅSTÅTT
   * eier. Uten den svarer metoden kun på «holder noen den private nøkkelen til
   * enhet X?», og en kaller som holder sin EGEN registrerte enhetsnøkkel kunne
   * derfor bevise enheten mens den påsto en ANNEN persons `person_id`. For
   * `/devices/challenge/verify` (fase 8, uendret oppførsel) er det uskadelig,
   * fordi ruten kun rapporterer en `auth_strength` og ikke muterer noe på
   * vegne av en person. For voice-autoriteten er det IKKE uskadelig: der
   * skrives det server-eid sesjonstilstand rett etter beviset, så bindingen
   * må skje FØR. Parameteren er valgfri nettopp for å la eksisterende kallere
   * være bit-for-bit uendret i stedet for å innføre en ny, parallell metode
   * som gjør «nesten det samme».
   */
  async verifyChallenge(
    tenantId: string,
    deviceId: string,
    challenge: string,
    signatureB64: string,
    personId?: string
  ): Promise<boolean> {
    const pending = this.challenges.get(challenge);
    if (!pending || pending.device_id !== deviceId || pending.expires < Date.now()) {
      return false;
    }
    this.challenges.delete(challenge); // engangs - replay av challenge er umulig
    const key = await this.publicKeyFromDb(tenantId, deviceId, personId);
    if (!key) {
      return false;
    }
    try {
      return verify(null, Buffer.from(challenge, "utf8"), key, Buffer.from(signatureB64, "base64"));
    } catch {
      return false;
    }
  }

  private async publicKeyFromDb(
    tenantId: string,
    deviceId: string,
    personId?: string
  ): Promise<KeyObject | null> {
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
    return pem ? createPublicKey(pem) : null;
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
