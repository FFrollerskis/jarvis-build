import type { ConversationChannel } from "./types.ts";

/**
 * Deterministisk normalisering av en kanal-identifikator (E.164-lignende
 * disiplin for e-post: kun lowercase+trim, ALDRI fuzzy-matching). Samme
 * valideringsmønster som `extractEmailAddress` i
 * `@jarvis/business` sin `business-event-sync.ts` (§9: "do not let an LLM
 * freely decide identity where deterministic keys exist").
 */
export function normalizeChannelIdentifier(channel: ConversationChannel, raw: string): string {
  const trimmed = raw.trim();
  if (channel === "email") {
    const lower = trimmed.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) {
      throw new Error("conversation_invalid_email_channel_identifier");
    }
    return lower;
  }
  if (trimmed.length === 0) {
    throw new Error("conversation_empty_channel_identifier");
  }
  return trimmed;
}
