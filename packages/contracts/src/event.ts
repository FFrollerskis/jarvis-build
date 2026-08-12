import { z } from "zod";
import { JsonValueSchema } from "./capability.js";
import { TrustLevelSchema } from "./job.js";

/**
 * Felles hendelseskonvolutt for Core, Worker og audit (append-only i fase 2+).
 * idempotency_key gjør skriving idempotent: samme hendelse to ganger = én rad.
 */
export const EventEnvelopeSchema = z
  .object({
    event_id: z.string().uuid(),
    /** Nøkkel for idempotent skriving; velges av produsenten. */
    idempotency_key: z.string().min(1),
    occurred_at: z.string().datetime(),
    /** Produsenten, f.eks. "core.policy", "voice-gateway", "worker.coding". */
    source: z.string().min(1),
    /** Hendelsestype, f.eks. "tool_call.denied", "session.resumed". */
    type: z.string().min(1),
    tenant_id: z.string().min(1),
    person_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    trust_level: TrustLevelSchema,
    payload: z.record(JsonValueSchema)
  })
  .strict();
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
