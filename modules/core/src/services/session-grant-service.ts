import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import {
  SESSION_GRANT_TTL_MS,
  channelAllowedForDeviceKind,
  type AuthStrength,
  type Channel,
  type MemorySpace,
  type SessionGrantDenialReason,
  type StepUpBindingMode
} from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";
import { fingerprintPem } from "./device-service.ts";

/**
 * D-131 (uavhengig arkitektkontroll av PR #79, funn 1): den server-side
 * eieren av `session_grants` - det AVGRENSEDE, REVOKERBARE autorisasjonsbeviset
 * som erstatter «rå `session_id` = autentisert enhet».
 *
 * Se `packages/contracts/src/session-grant.ts` for hvorfor en samtale-ID
 * strukturelt ikke KAN være et autorisasjonsbevis, og migrasjon 053 for
 * datamodellen. Denne klassen fatter ALDRI et autorisasjonsvedtak selv - den
 * lagrer et vedtak `ChannelSessionAuthority`/`VoiceSessionAuthority` allerede
 * har fattet via de kanoniske primitivene, og den håndhever at vedtaket
 * fortsatt gjelder hver gang beviset presenteres.
 */

/** Alt som skal til for å lagre et allerede fattet vedtak. */
export interface SessionGrantIssueInput {
  tenant_id: string;
  person_id: string;
  device_id: string;
  session_id: string;
  memory_space: MemorySpace;
  channel: Channel;
  auth_strength: AuthStrength;
  /**
   * D-131b (uavhengig arkitektkontroll av PR #79, HEAD 72c4d0e - TOCTOU-funn):
   * fingerprinten kalleren SELV nettopp låste (`FOR UPDATE`) og verifiserte
   * i SAMME transaksjon mot den fingerprinten `DeviceService.verifyChallenge()`
   * faktisk beviste besittelse over - se `device-authority.ts`. `issueOn()`
   * leser IKKE lenger `devices` selv: en egen, uavhengig lesing HER var
   * nettopp TOCTOU-hullet (utstedt mot nøkkelen slik den sto PÅ DETTE
   * SENERE tidspunktet, ikke den som ble bevist).
   */
  device_key_fingerprint: string;
}

export interface IssuedSessionGrant {
  grant_token: string;
  expires_at_ms: number;
}

/** Et grant som ER verifisert gyldig NÅ. Aldri konstruerbart fra klientdata. */
export interface VerifiedSessionGrant {
  tenant_id: string;
  person_id: string;
  device_id: string;
  session_id: string;
  memory_space: MemorySpace;
  channel: Channel;
  auth_strength: AuthStrength;
  expires_at_ms: number;
}

export type SessionGrantVerification =
  | { ok: true; grant: VerifiedSessionGrant }
  | { ok: false; reason: SessionGrantDenialReason };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Databasen holder KUN denne hashen (`session_grants.grant_id`), aldri tokenet.
 * En lekket backup/replika gir derfor ingen brukbar autoritet - nøyaktig samme
 * resonnement som for innrullerings-billettene.
 */
export function grantIdFromToken(token: string): string {
  return sha256Hex(token);
}

export interface SessionGrantServiceOptions {
  /**
   * WP-S1 (JARVIS-111): DYBDEFORSVAR for kanalbindingen. Utstedelsen (`authorizeProvenDevice`) er den primære håndhevelsen; i `enforce` sjekker `verify()` i tillegg at grantets kanal fortsatt hører til enhetens type
   * SLIK DEN STÅR NÅ, så et grant utstedt før `enforce` ble slått på (eller før en typeendring) ikke lever ut levetiden sin med en kanal serveren ikke lenger tillater. Kun den eksakte verdien `enforce` nekter; i
   * `observe` (standard) er `verify()` uendret.
   */
  channelBindingMode?: StepUpBindingMode;
}

export class SessionGrantService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: SessionGrantServiceOptions = {}
  ) {}

  /**
   * Utsteder et grant PÅ EN EKSISTERENDE TRANSAKSJONSKLIENT.
   *
   * Kun `...On(client, ...)`-formen finnes med vilje: et grant skal ALDRI
   * kunne bli commitet uten sesjonsraden og audit-raden det hører til (og
   * omvendt). Kalleren eier transaksjonen, slik at et avslag hvor som helst i
   * autorisasjonen ruller ALT tilbake.
   *
   * D-131b (uavhengig arkitektkontroll av PR #79, HEAD 72c4d0e - TOCTOU-funn):
   * `input.device_key_fingerprint` MÅ komme fra en lås+lesing kalleren nettopp
   * gjorde i SAMME transaksjon (`DeviceService.lockDeviceKeyOn()`), sammenlignet
   * mot fingerprinten `verifyChallenge()` faktisk beviste. Denne metoden leser
   * IKKE `devices` selv lenger - det var nettopp den andre, senere, uavhengige
   * lesingen som lot en rotasjon i vinduet mellom bevis og utstedelse smette
   * imellom. Kalleren er ansvarlig for å ALDRI kalle denne uten en gyldig,
   * fersk låst fingerprint - `authorizeProvenDevice()` er den ENESTE kalleren.
   */
  async issueOn(
    client: pg.PoolClient,
    input: SessionGrantIssueInput,
    nowMs: number = Date.now()
  ): Promise<IssuedSessionGrant> {
    // 256 bits entropi. Tokenet vises kun her og i svaret til klienten.
    const token = `grt_${randomBytes(32).toString("base64url")}`;
    const expiresAtMs = nowMs + SESSION_GRANT_TTL_MS;
    await client.query(
      `INSERT INTO session_grants
         (grant_id, tenant_id, person_id, device_id, session_id, memory_space, channel,
          auth_strength, device_key_fingerprint, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0), to_timestamp($11 / 1000.0))`,
      [
        grantIdFromToken(token),
        input.tenant_id,
        input.person_id,
        input.device_id,
        input.session_id,
        input.memory_space,
        input.channel,
        input.auth_strength,
        input.device_key_fingerprint,
        nowMs,
        expiresAtMs
      ]
    );
    await writeAudit(
      client,
      {
        tenant_id: input.tenant_id,
        person_id: input.person_id,
        session_id: input.session_id,
        device_id: input.device_id
      },
      {
        type: "session_grant.issued",
        decision: "ALLOW",
        // ALDRI tokenet, og aldri hashen av det: audit skal dokumentere
        // vedtaket, ikke gjøre det gjenbrukbart for en logg-leser.
        payload: { channel: input.channel, memory_space: input.memory_space, expires_at_ms: expiresAtMs }
      }
    );
    return { grant_token: token, expires_at_ms: expiresAtMs };
  }

  /**
   * Verifiserer et FRAMLAGT grant-token - kalles ved HVERT `/chat`/`/brief`.
   *
   * Klienten sender KUN tokenet: ingen `tenant_id`, `person_id`, `device_id`,
   * `memory_space`, `channel` eller `auth_strength`. Alle disse LESES ut av
   * grant-raden, så det finnes ikke lenger noe identitetsbærende felt en klient
   * kan påstå. Tenanten slås opp med den smale SECURITY DEFINER-funksjonen
   * (migrasjon 053) fordi `session_grants` har `FORCE ROW LEVEL SECURITY` og
   * RLS-konteksten må settes FØR raden kan leses - funksjonen returnerer kun
   * `tenant_id` og avgjør ingenting om gyldighet.
   *
   * `nowMs` er eksplisitt: en tidsavhengig sikkerhetsgrense som leser klokka
   * selv kan ikke testes deterministisk (samme begrunnelse som
   * `voiceAuthorityFromGrant`).
   */
  async verify(rawToken: unknown, nowMs: number = Date.now()): Promise<SessionGrantVerification> {
    if (typeof rawToken !== "string" || rawToken.length === 0) {
      return { ok: false, reason: "grant_malformed" };
    }
    const grantId = grantIdFromToken(rawToken);

    const tenantLookup = await this.pool.query<{ tenant_id: string | null }>(
      "SELECT jarvis_session_grant_tenant($1) AS tenant_id",
      [grantId]
    );
    const tenantId = tenantLookup.rows[0]?.tenant_id ?? null;
    if (!tenantId) {
      return { ok: false, reason: "grant_not_found" };
    }

    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `SELECT g.person_id, g.device_id, g.session_id, g.memory_space, g.channel, g.auth_strength,
                g.device_key_fingerprint, g.revoked_at,
                (EXTRACT(EPOCH FROM g.expires_at) * 1000)::bigint AS expires_at_ms,
                d.public_key_pem, d.device_kind
           FROM session_grants g
           LEFT JOIN devices d ON d.device_id = g.device_id AND d.tenant_id = g.tenant_id
          WHERE g.grant_id = $1`,
        [grantId]
      );
      const row = result.rows[0] as
        | {
            person_id: string;
            device_id: string;
            session_id: string;
            memory_space: MemorySpace;
            channel: Channel;
            auth_strength: AuthStrength;
            device_key_fingerprint: string;
            revoked_at: Date | null;
            expires_at_ms: string;
            public_key_pem: string | null;
            device_kind: string | null;
          }
        | undefined;
      // Kan skje hvis `jarvis_session_grant_tenant()` fant en rad som RLS
      // deretter ikke slipper gjennom - behandles som «finnes ikke».
      if (!row) {
        return { ok: false, reason: "grant_not_found" } as const;
      }

      const deny = async (reason: SessionGrantDenialReason): Promise<SessionGrantVerification> => {
        await writeAudit(
          client,
          {
            tenant_id: tenantId,
            person_id: row.person_id,
            session_id: row.session_id,
            device_id: row.device_id
          },
          { type: "session_grant.denied", decision: "DENY", reason }
        );
        return { ok: false, reason };
      };

      if (row.revoked_at !== null) {
        return deny("grant_revoked");
      }
      const expiresAtMs = Number(row.expires_at_ms);
      if (expiresAtMs <= nowMs) {
        return deny("grant_expired");
      }
      // DEN STRUKTURELLE TILBAKEKALLINGEN reviewen etterlyste: nøkkelen som ble
      // bevist ved utstedelse må fortsatt være NØYAKTIG den som står registrert.
      // NULL = tilbakekalt enhet; en annen hash = rotert nøkkel. Begge dreper
      // alle utestående grants for enheten uten noen opprydningsjobb.
      if (!row.public_key_pem || fingerprintPem(row.public_key_pem) !== row.device_key_fingerprint) {
        return deny("device_authority_revoked");
      }
      // WP-S1: dybdeforsvar (kun `enforce`): grantets kanal MÅ fortsatt høre til enhetens type slik den står nå. Fail-closed for en type som ikke er i den lukkede listen.
      if (this.options.channelBindingMode === "enforce" && !channelAllowedForDeviceKind(row.device_kind, row.channel)) {
        return deny("channel_not_allowed_for_device_kind");
      }

      return {
        ok: true,
        grant: {
          tenant_id: tenantId,
          person_id: row.person_id,
          device_id: row.device_id,
          session_id: row.session_id,
          memory_space: row.memory_space,
          channel: row.channel,
          auth_strength: row.auth_strength,
          expires_at_ms: expiresAtMs
        }
      } as const;
    });
  }

  /**
   * Eksplisitt tilbakekalling av alle utestående grants for én enhet. Kalles
   * ved nøkkelrotasjon (`DeviceEnrollmentService`) i SAMME transaksjon som
   * rotasjonen, slik at det aldri finnes et øyeblikk der den gamle nøkkelens
   * grants og den nye nøkkelen eksisterer samtidig.
   *
   * Fingerprint-sjekken i `verify()` ville uansett ha avvist dem - dette gjør
   * tilbakekallingen SYNLIG og reviderbar i stedet for bare implisitt.
   */
  async revokeForDeviceOn(
    client: pg.PoolClient,
    tenantId: string,
    deviceId: string,
    nowMs: number = Date.now()
  ): Promise<number> {
    const result = await client.query(
      `UPDATE session_grants SET revoked_at = to_timestamp($3 / 1000.0)
        WHERE tenant_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
      [tenantId, deviceId, nowMs]
    );
    return result.rowCount ?? 0;
  }
}
