/**
 * D-416: chattens DELEGERINGSNIVÅ (web_chat) - chat og agenter er to løp. Modellen kan legge en oppgave i den eksisterende, durable
 * jobbkøen (`TaskService.submit`, klasse B) og svare Tobias med en gang; arbeidet kjører som en LESENDE bakgrunnsjobb (bakgrunnsflaten:
 * ingen skriving, ingen utgående handlinger) og resultatet leveres tilbake til samtalen senere.
 *
 * Eier-valget «A» (2026-10-06): `delegate_background_task` krever IKKE bekreftelse i en ren eier-tur - jobben kan ikke endre noe utad,
 * har budsjettgrense og får bare bakgrunnsflatens lese-verktøy. I en TAINTED tur (ubetrodd innhold er lest) kreves derimot en ny, bundet
 * eier-bekreftelse (`requiresConfirmationWhenTainted`) - ubetrodd tekst kan aldri sette i gang agenter uten eierens ja. Regel 6/7 uendret.
 * Låst av `assertChatDelegateTier()` ved oppstart og av `apps/api/test/d416-chat-delegation.test.ts`.
 */
export const CHAT_DELEGATE_TIER: ReadonlyArray<{ readonly tool_id: string; readonly action: string }> = [
  { tool_id: "tasks", action: "delegate_background_task" },
  { tool_id: "tasks", action: "get_task_status" }
];

export const CHAT_DELEGATE_TIER_KEYS: ReadonlySet<string> = new Set(CHAT_DELEGATE_TIER.map((g) => `${g.tool_id}.${g.action}`));

/** Handlingen i delegeringsnivået som OPPRETTER en jobb (klasse B, write); den andre er ren lesing (klasse A). */
export const DELEGATE_WRITE_KEYS: ReadonlySet<string> = new Set(["tasks.delegate_background_task"]);
