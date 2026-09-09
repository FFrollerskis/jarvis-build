import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Channel } from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";

export interface SessionRef {
  session_id: string;
  resumed: boolean;
  last_channel: Channel;
}

export interface SessionPrincipal {
  tenant_id: string;
  person_id: string;
  device_id: string;
}

/**
 * Session Service (fase 2): samme samtale på tvers av kanaler.
 * resumeOrCreate gjenopptar personens aktive sesjon i tenanten uansett hvilken
 * kanal/enhet som spør (akseptansekriterium 3); ellers opprettes ny.
 */
export class SessionService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Arkitekt-review-fiks (D-130, MERGE BLOCKER 1): den betrodde server-side
   * oppslagsveien for et allerede-utstedt `session_id` - den eneste måten
   * `/chat`/`/brief` skal slå opp HVEM en sesjon tilhører fra nå av.
   *
   * `session_id` ER selve bæreren-beviset her: den utstedes KUN av
   * `ChannelSessionAuthority`/`VoiceSessionAuthority`, som BEGGE krever ekte
   * enhetsbevis (Ed25519-signatur over en engangs-nonce) FØR noen sesjonsrad
   * i det hele tatt berøres. Et gyldig `session_id` er derfor i seg selv
   * kryptografisk begrunnet - klienten kan ALDRI velge/gjette en fremmed
   * sesjon (122-bits tilfeldig UUID), og et forsøk med feil `tenant_id`
   * finner ingen rad (RLS-scopet søk) i stedet for å lekke andre tenanters
   * sesjoner. `person_id`/`device_id` returneres HERFRA (server-eid
   * tilstand) - ALDRI fra noe klienten selv påstår i request-kroppen.
   */
  async getActive(tenantId: string, sessionId: string): Promise<SessionPrincipal | null> {
    return withTenantTransaction(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `SELECT person_id, last_device_id AS device_id FROM sessions
         WHERE tenant_id = $1 AND session_id = $2 AND status = 'active'`,
        [tenantId, sessionId]
      );
      const row = result.rows[0] as { person_id: string; device_id: string } | undefined;
      return row ? { tenant_id: tenantId, person_id: row.person_id, device_id: row.device_id } : null;
    });
  }

  async resumeOrCreate(principal: SessionPrincipal, channel: Channel): Promise<SessionRef> {
    return withTenantTransaction(this.pool, principal.tenant_id, async (client) => {
      const existing = await client.query(
        `SELECT session_id FROM sessions
         WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'
         ORDER BY last_active_at DESC LIMIT 1
         FOR UPDATE`,
        [principal.tenant_id, principal.person_id]
      );
      const row = existing.rows[0] as { session_id: string } | undefined;

      if (row) {
        await client.query(
          `UPDATE sessions
             SET last_channel = $2, last_device_id = $3, last_active_at = now()
           WHERE session_id = $1`,
          [row.session_id, channel, principal.device_id]
        );
        await writeAudit(client, { ...principal, session_id: row.session_id }, {
          type: "session.resumed",
          payload: { channel }
        });
        return { session_id: row.session_id, resumed: true, last_channel: channel };
      }

      const sessionId = `sess-${randomUUID()}`;
      await client.query(
        `INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, principal.tenant_id, principal.person_id, channel, principal.device_id]
      );
      await writeAudit(client, { ...principal, session_id: sessionId }, {
        type: "session.created",
        payload: { channel }
      });
      return { session_id: sessionId, resumed: false, last_channel: channel };
    });
  }
}
