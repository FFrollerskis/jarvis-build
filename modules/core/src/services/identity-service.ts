import type pg from "pg";
import {
  IdentityContextSchema,
  type AuthStrength,
  type Channel,
  type IdentityContext,
  type MemorySpace
} from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";

export interface ResolveIdentityInput {
  person_id: string;
  tenant_id: string;
  memory_space: MemorySpace;
  session_id: string;
  device_id: string;
  channel: Channel;
  auth_strength: AuthStrength;
  delegation_id?: string;
}

export type ResolveResult =
  | { ok: true; identity: IdentityContext }
  | { ok: false; reason: "unknown_membership" | "unknown_device" | "unknown_memory_space" };

/**
 * Identity Service (fase 2): slår opp og VALIDERER identitetskontekst mot
 * databasen under RLS - medlemskap, enhet og memory space må finnes i riktig
 * tenant. Returnerer en kontraktvalidert IdentityContext.
 */
export class IdentityService {
  constructor(private readonly pool: pg.Pool) {}

  async resolveIdentity(input: ResolveIdentityInput): Promise<ResolveResult> {
    return withTenantTransaction(this.pool, input.tenant_id, async (client) => {
      const auditIdentity = {
        tenant_id: input.tenant_id,
        person_id: input.person_id,
        session_id: input.session_id,
        device_id: input.device_id
      };

      const membership = await client.query(
        "SELECT 1 FROM person_tenants WHERE person_id = $1 AND tenant_id = $2",
        [input.person_id, input.tenant_id]
      );
      if (!membership.rowCount) {
        await writeAudit(client, auditIdentity, {
          type: "identity.denied",
          decision: "DENY",
          reason: "unknown_membership"
        });
        return { ok: false, reason: "unknown_membership" } as const;
      }

      const device = await client.query(
        "SELECT 1 FROM devices WHERE device_id = $1 AND tenant_id = $2 AND person_id = $3",
        [input.device_id, input.tenant_id, input.person_id]
      );
      if (!device.rowCount) {
        await writeAudit(client, auditIdentity, {
          type: "identity.denied",
          decision: "DENY",
          reason: "unknown_device"
        });
        return { ok: false, reason: "unknown_device" } as const;
      }

      const space = await client.query(
        "SELECT memory_space_id FROM memory_spaces WHERE tenant_id = $1 AND space = $2",
        [input.tenant_id, input.memory_space]
      );
      const spaceRow = space.rows[0] as { memory_space_id: string } | undefined;
      if (!spaceRow) {
        await writeAudit(client, auditIdentity, {
          type: "identity.denied",
          decision: "DENY",
          reason: "unknown_memory_space"
        });
        return { ok: false, reason: "unknown_memory_space" } as const;
      }

      const identity = IdentityContextSchema.parse({
        person_id: input.person_id,
        tenant_id: input.tenant_id,
        memory_space_id: input.memory_space,
        session_id: input.session_id,
        device_id: input.device_id,
        channel: input.channel,
        auth_strength: input.auth_strength,
        ...(input.delegation_id !== undefined ? { delegation_id: input.delegation_id } : {})
      });
      await writeAudit(client, auditIdentity, { type: "identity.resolved", decision: "ALLOW" });
      return { ok: true, identity } as const;
    });
  }
}
