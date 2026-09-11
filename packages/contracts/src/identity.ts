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

/**
 * D-125 (UA-7): `telegram` er lagt til fordi eier-innkommende Telegram-tekst nå
 * faktisk går inn i den kanoniske samtale-/sesjonsbanen. Uten verdien måtte den
 * banen ha merket `sessions.last_channel` og audit-radene som `api` - altså
 * skrevet en USANN kilde (CLAUDE.md regel 4: alt minne og alle handlinger merkes
 * med kilde). Utvidelsen krever INGEN migrasjon (`sessions.last_channel` er
 * `text NOT NULL` uten CHECK-constraint, 002_sessions_events.sql) og INGEN
 * kodeendring andre steder (ingen uttømmende `switch` over `Channel` finnes;
 * `ChannelSchema` brukes kun i denne filen). Den utvider kun hva som ER gyldig -
 * den fjerner ingen tidligere gyldig verdi. Telegram forblir en TRANSPORT
 * (D-64 `EXTERNAL_CANONICAL`), aldri en identitets- eller autoritetskilde.
 */
/**
 * `desktop` (UA-7-generalisering av D-123/D-125, kanonisk local-agent-kontrakt
 * for Mac/Windows fra masterplanen): modellerer en lokal desktop-agent som en
 * ordinær `devices`-rad (`kind = 'desktop-agent'` - ingen skjemaendring,
 * `devices.kind` er allerede fritekst), autentisert med SAMME
 * `DeviceService.verifyChallenge()` Ed25519-proof-of-possession-primitiv som
 * enhver annen enhet, og autorisert via den nye, generiske
 * `ChannelSessionAuthority` (`modules/core/src/services/
 * channel-session-authority.ts`) med `channel = "desktop"` - IKKE en parallell
 * lokal-agent-infrastruktur. `desktop` er bevisst IKKE en tredjeparts-
 * leverandør-integrasjon (D-64): enheten er alltid Tobias sin egen, kjørt på
 * hans egen maskin, og eies fullt ut av den eksisterende kanoniske
 * enhets-/identitetsmodellen.
 *
 * Krever INGEN migrasjon, av samme grunn som D-125 sin `telegram`-utvidelse
 * over: `sessions.last_channel` er `text NOT NULL` uten CHECK-constraint
 * (002_sessions_events.sql), og ingen uttømmende `switch` over `Channel`
 * finnes andre steder - `ChannelSchema` brukes kun i denne filen. Utvidelsen
 * legger kun til en gyldig verdi; ingen tidligere gyldig verdi fjernes.
 *
 * MERK (ærlighet om sporbarhet, CLAUDE.md): denne verdien er lagt til uten et
 * eget logget D-nummer i `docs/DECISIONS_AND_ASSUMPTIONS.md`, fordi den
 * økten som skrev dette eksplisitt ikke fikk endre `docs/*`. Bør formaliseres
 * med et D-xx av en økt som har den tilgangen.
 */
export const ChannelSchema = z.enum(["web", "mobile", "watch", "voice", "api", "system", "telegram", "desktop"]);
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
