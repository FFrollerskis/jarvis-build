import type { ConversationChannel } from "./types.ts";

/**
 * Deterministisk normalisering av en kanal-identifikator (E.164-lignende
 * disiplin for e-post: kun lowercase+trim, ALDRI fuzzy-matching). Samme
 * valideringsmønster som `extractEmailAddress` i
 * `@jarvis/business` sin `business-event-sync.ts` (§9: "do not let an LLM
 * freely decide identity where deterministic keys exist").
 *
 * WP-G1 (D-463): hver nye kanal har en EKSAKT, lukket form. Ingenting gjettes:
 *  - telefon (`phone`/`sms`/`whatsapp`): E.164 (`+` og 8-15 sifre). `00`-prefiks tolkes som `+`; mellomrom, bindestrek, punktum og parenteser fjernes. Et NASJONALT nummer uten landnummer
 *    («900 00 000») avvises: et landnummer gjettes aldri. Unntak: WhatsApps egen `wa_id` er per definisjon internasjonalt format uten `+` - kun `whatsapp` godtar rene sifre (8-15, ikke ledende 0).
 *  - Slack: `<team_id>:<bruker_id>` (`T…:U…`/`W…`) - bruker-id-er er scopet til arbeidsområdet, så teamet er med i nøkkelen.
 *  - Discord: bruker-snowflake (17-20 sifre). Teams: Entra-objekt-id (GUID, lowercase).
 *  - Messenger/Instagram: `<side_id>:<sidescopet_id>` (PSID/IGSID er scopet til siden/kontoen).
 * Alt som ikke matcher gir en feil med fast kode (`conversation_invalid_<kanal>_channel_identifier`) - aldri verdien (kan være personopplysning).
 */
const E164 = /^\+[1-9]\d{7,14}$/;
const SLACK_ID = /^T[A-Z0-9]{8,14}:[UW][A-Z0-9]{8,14}$/;
const DISCORD_ID = /^\d{17,20}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const META_SCOPED_ID = /^\d{5,20}:\d{5,20}$/;

/**
 * E.164-normalisering. Returnerer `null` når inndata ikke kan gjøres om til et entydig internasjonalt nummer uten å gjette. Eksportert fordi webhook-parserne og kontaktsynken bruker NØYAKTIG samme regel
 * (én regel for «samme nummer», aldri to nesten-like).
 */
export function normalizeE164(raw: string, options: { allowBareInternationalDigits?: boolean } = {}): string | null {
  const stripped = raw.trim().replace(/[\s().-]/g, "");
  if (stripped.length === 0 || stripped.length > 32) return null;
  let candidate: string;
  if (stripped.startsWith("+")) candidate = stripped;
  else if (stripped.startsWith("00")) candidate = `+${stripped.slice(2)}`;
  else if (options.allowBareInternationalDigits === true && /^[1-9]\d+$/.test(stripped)) candidate = `+${stripped}`;
  else return null;
  return E164.test(candidate) ? candidate : null;
}

export function normalizeChannelIdentifier(channel: ConversationChannel, raw: string): string {
  const trimmed = raw.trim();
  if (channel === "email") {
    const lower = trimmed.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) {
      throw new Error("conversation_invalid_email_channel_identifier");
    }
    return lower;
  }
  switch (channel) {
    case "phone":
    case "sms":
    case "whatsapp": {
      const e164 = normalizeE164(trimmed, { allowBareInternationalDigits: channel === "whatsapp" });
      if (e164 === null) throw new Error(`conversation_invalid_${channel}_channel_identifier`);
      return e164;
    }
    case "slack": {
      const upper = trimmed.toUpperCase();
      if (!SLACK_ID.test(upper)) throw new Error("conversation_invalid_slack_channel_identifier");
      return upper;
    }
    case "discord":
      if (!DISCORD_ID.test(trimmed)) throw new Error("conversation_invalid_discord_channel_identifier");
      return trimmed;
    case "teams": {
      const lower = trimmed.toLowerCase();
      if (!GUID.test(lower)) throw new Error("conversation_invalid_teams_channel_identifier");
      return lower;
    }
    case "messenger":
    case "instagram":
      if (!META_SCOPED_ID.test(trimmed)) throw new Error(`conversation_invalid_${channel}_channel_identifier`);
      return trimmed;
    default:
      break;
  }
  if (trimmed.length === 0) {
    throw new Error("conversation_empty_channel_identifier");
  }
  return trimmed;
}
