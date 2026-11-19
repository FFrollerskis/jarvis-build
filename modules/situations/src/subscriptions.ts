import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import {
  FILTER_SCHEMAS, HOME_ROLES, isEventTypeOf, isSignalSource, ruleFor, type HomeFilter, type SignalSource
} from "./signal-types.ts";

/**
 * WP-G4 (D-466), UA-10 P1a: ABONNEMENTSREGISTERET. Eieren registrerer EKSPLISITT hvilke kilder, hendelsestyper og filtre som får mate motoren; FRAVÆR av abonnement = signalet forkastes (fail-closed).
 * Registeret er Jarvis' egen kanoniske tilstand (D-64): kilder (Home Assistant, kamera, helse, hendelsesregisteret) er kun porter som leverer minimerte observasjoner.
 *
 * Autoritet: å registrere/endre/fjerne et abonnement krever den SAMME sovereign-eieren som autonomi-bindinger og gjenoppretting (`SituationRecoveryAuthority`), fail-closed uten konfigurert autoritet. Tenant/space/aktør
 * kommer fra den betrodde identiteten (se `signals-transport.ts`), aldri fra parametre. Helse er KUN egen helse: `filter.person_id` MÅ være aktøren selv.
 *
 * Valideringen er LUKKET: kilde og hendelsestype fra settene i `signal-types.ts`, filteret mot kildens `strict()`-skjema, memory space må være et av kildens tillatte rom (en begrenset kilde kan ikke registreres i et
 * tilfeldig rom), og for Home Assistant må hver entitets ROLLE passe hendelsestypen (en lekkasjesensor kan ikke ligge under `door_open_too_long`). Registrering er idempotent (samme kilde/type/filter = samme rad).
 */
export interface SituationSubscription {
  subscription_id: string;
  tenant_id: string;
  memory_space_id: string;
  source: SignalSource;
  event_type: string;
  domain: string;
  filter: Record<string, unknown>;
  enabled: boolean;
  created_by_person_id: string;
  task_id: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export class SubscriptionValidationError extends Error {
  constructor(public readonly code: string) {
    super(`subscription_invalid:${code}`);
    this.name = "SubscriptionValidationError";
  }
}

export class SubscriptionUnauthorizedError extends Error {
  constructor(public readonly personId: string | undefined) {
    super(`subscription_unauthorized:${personId ?? "none"}`);
    this.name = "SubscriptionUnauthorizedError";
  }
}

export class SubscriptionNotFoundError extends Error {
  constructor(public readonly subscriptionId: string) {
    super(`subscription_not_found:${subscriptionId}`);
    this.name = "SubscriptionNotFoundError";
  }
}

/** Hvilke memory spaces en kilde kan registreres i. Begrensede kilder er låst til sine egne rom (helse -> `health`; kamerahendelser -> `home`/`personal`). */
export const SOURCE_SPACES: Readonly<Record<SignalSource, readonly MemorySpace[]>> = {
  home_assistant: ["home"],
  vision: ["home", "personal"],
  health: ["health"],
  incident: ["business"],
  communications: [],
  business: []
};

/** Hvilke HA-roller som hører til hvilken hendelsestype. */
const ROLES_FOR_EVENT: Readonly<Record<string, readonly string[]>> = {
  door_open_too_long: ["door", "window", "garage_door", "gate", "opening"],
  water_leak: ["leak"],
  alarm_triggered: ["alarm"],
  power_over_limit: ["power"]
};

/** Rekursiv, nøkkel-sortert kanonisk JSON (samme verdi gir alltid samme streng). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`).join(",")}}`;
}

export function filterDigest(filter: unknown): string {
  return createHash("sha256").update(canonical(filter)).digest("hex");
}

export interface SubscribeInput {
  source: string;
  event_type: string;
  filter: unknown;
  enabled?: boolean;
}

export interface SubscriptionActor {
  person_id: string | undefined;
  task_id?: string | undefined;
  session_id?: string | undefined;
}

export class SubscriptionRegistry {
  constructor(
    private readonly pool: pg.Pool,
    /** Sovereign eier (samme form som `SituationRecoveryAuthority`). `undefined` = alle mutasjoner nektes (fail-closed). */
    private readonly authority?: { owner_person_id: string }
  ) {}

  private assertOwner(actor: SubscriptionActor): string {
    if (!actor.person_id || !this.authority || actor.person_id !== this.authority.owner_person_id) throw new SubscriptionUnauthorizedError(actor.person_id);
    return actor.person_id;
  }

  /** Validerer input mot de lukkede settene og gir den normaliserte raden som skal lagres. Ren (ingen I/O) og eksportert for direkte test. */
  static validate(memorySpace: string, actorPersonId: string, input: SubscribeInput): { source: SignalSource; eventType: string; domain: string; filter: Record<string, unknown> } {
    if (!isSignalSource(input.source)) throw new SubscriptionValidationError("source_unknown");
    const source = input.source;
    if (!isEventTypeOf(source, input.event_type)) throw new SubscriptionValidationError("event_type_unknown");
    const rule = ruleFor(source, input.event_type);
    if (rule === undefined) throw new SubscriptionValidationError("event_type_without_rule");
    if (!(SOURCE_SPACES[source] as readonly string[]).includes(memorySpace)) throw new SubscriptionValidationError("space_not_allowed_for_source");
    const parsed = FILTER_SCHEMAS[source].safeParse(input.filter ?? {});
    if (!parsed.success) throw new SubscriptionValidationError(`filter_invalid:${parsed.error.issues[0]?.path.join(".") || "filter"}`);
    const filter = parsed.data as Record<string, unknown>;
    if (source === "health" && (filter as { person_id: string }).person_id !== actorPersonId) throw new SubscriptionValidationError("health_self_only");
    if (source === "home_assistant") {
      const allowed = ROLES_FOR_EVENT[input.event_type] ?? [];
      for (const entity of (filter as HomeFilter).entities) {
        if (!(HOME_ROLES as readonly string[]).includes(entity.role) || !allowed.includes(entity.role)) throw new SubscriptionValidationError("role_event_mismatch");
      }
    }
    return { source, eventType: input.event_type, domain: rule.domain, filter };
  }

  async subscribe(tenantId: string, memorySpace: MemorySpace, input: SubscribeInput, actor: SubscriptionActor): Promise<SituationSubscription> {
    const personId = this.assertOwner(actor);
    const v = SubscriptionRegistry.validate(memorySpace, personId, input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO situation_subscriptions
           (subscription_id, tenant_id, memory_space_id, source, event_type, domain, filter, filter_digest, enabled, created_by_person_id, task_id, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, memory_space_id, source, event_type, filter_digest)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
         RETURNING *`,
        [`sub-${randomUUID()}`, tenantId, memorySpace, v.source, v.eventType, v.domain, JSON.stringify(v.filter), filterDigest(v.filter), input.enabled ?? true, personId, actor.task_id ?? null, actor.session_id ?? null]
      );
      return rows[0] as SituationSubscription;
    });
  }

  async setEnabled(tenantId: string, memorySpace: MemorySpace, subscriptionId: string, enabled: boolean, actor: SubscriptionActor): Promise<SituationSubscription> {
    this.assertOwner(actor);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE situation_subscriptions SET enabled = $4, updated_at = now() WHERE tenant_id = $1 AND memory_space_id = $2 AND subscription_id = $3 RETURNING *`,
        [tenantId, memorySpace, subscriptionId, enabled]
      );
      if (!rows[0]) throw new SubscriptionNotFoundError(subscriptionId);
      return rows[0] as SituationSubscription;
    });
  }

  async remove(tenantId: string, memorySpace: MemorySpace, subscriptionId: string, actor: SubscriptionActor): Promise<boolean> {
    this.assertOwner(actor);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM situation_subscriptions WHERE tenant_id = $1 AND memory_space_id = $2 AND subscription_id = $3`,
        [tenantId, memorySpace, subscriptionId]
      );
      return rowCount === 1;
    });
  }

  async list(tenantId: string, memorySpace: MemorySpace): Promise<SituationSubscription[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM situation_subscriptions WHERE tenant_id = $1 AND memory_space_id = $2 ORDER BY source ASC, event_type ASC, created_at ASC`,
        [tenantId, memorySpace]
      );
      return rows as SituationSubscription[];
    });
  }

  /** Kun PÅSLÅTTE abonnementer (det inntaksbussen og kildeleserne bruker). */
  async listEnabled(tenantId: string, memorySpace: MemorySpace, source?: SignalSource): Promise<SituationSubscription[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        source === undefined
          ? `SELECT * FROM situation_subscriptions WHERE tenant_id = $1 AND memory_space_id = $2 AND enabled = true ORDER BY created_at ASC`
          : `SELECT * FROM situation_subscriptions WHERE tenant_id = $1 AND memory_space_id = $2 AND enabled = true AND source = $3 ORDER BY created_at ASC`,
        source === undefined ? [tenantId, memorySpace] : [tenantId, memorySpace, source]
      );
      return rows as SituationSubscription[];
    });
  }
}
