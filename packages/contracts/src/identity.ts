import { z } from "zod";

/**
 * Minneområder (memory spaces) per CANONICAL_SPEC §3.
 * Ett logisk minne, strengt adskilte sikkerhetsområder.
 */
export const MemorySpaceSchema = z.enum([
  "personal",
  "business",
  "project",
  "health",
  "home",
  "guest",
  "shared"
]);
export type MemorySpace = z.infer<typeof MemorySpaceSchema>;

/**
 * Gradert autentiseringsstyrke (SECURITY_MODEL §10).
 * passive < active < signed. Stemme alene gir aldri forhøyet styrke.
 */
export const AuthStrengthSchema = z.enum(["passive", "active", "signed"]);
export type AuthStrength = z.infer<typeof AuthStrengthSchema>;

export const ChannelSchema = z.enum(["web", "mobile", "watch", "voice", "api", "system"]);
export type Channel = z.infer<typeof ChannelSchema>;

/**
 * Identitetskontekst som følger hver forespørsel (CANONICAL_SPEC §3).
 * Fase 1: bevisst minimal - ingen auth-flyt, kun kontrakten.
 */
export const IdentityContextSchema = z
  .object({
    person_id: z.string().min(1),
    tenant_id: z.string().min(1),
    memory_space_id: MemorySpaceSchema,
    session_id: z.string().min(1),
    device_id: z.string().min(1),
    site_id: z.string().min(1).optional(),
    room_id: z.string().min(1).optional(),
    channel: ChannelSchema,
    auth_strength: AuthStrengthSchema,
    /** Satt når en agent handler på vegne av personen. Revisjon av kjeden kommer i fase 2 (K-10). */
    delegation_id: z.string().min(1).optional()
  })
  .strict();
export type IdentityContext = z.infer<typeof IdentityContextSchema>;
