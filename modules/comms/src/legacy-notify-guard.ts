import type { JsonValue } from "@jarvis/contracts";
import { PolicyDeniedError, type ToolInvocationContext, type ToolTransport } from "@jarvis/tool-gateway";
import { normalizeRecipient, optOutHash, type CommsChannel } from "./channels.ts";

/**
 * WP-G1c (D-481, JARVIS-112 g5, Q-72 pkt 12): STOP-VAKT for de eldre `twilio`/`telnyx`/`whatsapp`/`slack`/`discord`-`notify`-verktøyene (`modules/tool-gateway/src/integrations.ts`, klasse C, vilkårlig mottaker).
 * De omgikk hele den felles utgående policyen: en mottaker som hadde sendt STOPP (eller som eieren hadde avmeldt) kunne fortsatt nås gjennom dem. Dette er den SMALLESTE endringen som lukker det: en transport-dekoratør som
 * slår opp tenant-bred avmelding for (kanal, mottaker) rett FØR `notify` utføres. INGEN nye tak, ingen journal, ingen formålsgrunnlag - de er fortsatt utenfor (JARVIS-112 g5 ber bare om STOP).
 *
 *  - Kun handlingen `notify` rører vakten; alle andre handlinger (get_*, list_*, read_*) går rett gjennom, uendret.
 *  - Uten noen avmeldingsrad er oppførselen identisk med før (ett ekstra lese-oppslag per `notify`). Med ALLE comms-flagg AV pakkes ingenting inn (`commsRuntime.guardLegacyNotifyTransport` returnerer transporten uendret).
 *  - En avmeldt mottaker gir `PolicyDeniedError("recipient_opted_out")` (melding `comms_policy_denied:recipient_opted_out`) FØR noe forlater prosessen. Feilen er et policy-avslag, ikke en leverandørfeil, og teller ikke mot
 *    connector-helse (g4). Et oppslag som feiler (databasen utilgjengelig) feiler LUKKET (`opt_out_check_unavailable`): vi sender aldri uten å ha sjekket.
 *  - En mottaker vakten ikke kan normalisere (f.eks. et Slack-kanalnavn eller et nummer uten landkode) kan ikke ha en avmeldingsrad (registeret nøkles på normalisert identifikator) og slippes videre til den eksisterende transporten,
 *    som validerer selv (E.164 for telefon). Dette er ikke et nytt hull: avmeldinger registreres alltid på normalisert form.
 *  - Tenant: identitetens tenant OG webhook-tenanten (`JARVIS_COMMS_TENANT_ID`), fordi en innkommende STOP skrives dit. Avmeldinger i en tredje tenant sees ikke (tenant-isolasjon), og eierens egne varsler er IKKE unntatt: har eieren
 *    selv sendt STOPP fra sitt eget nummer, er det også avmeldt (leverandøren ville uansett avvist sendingen). Eieren løfter den med en START fra samme nummer.
 *  - Dekker KUN api-prosessen (der comms-kjøretiden finnes); en worker-prosess har egne transporter og er IKKE dekket (se runbook §10, PARTIAL).
 */
export const LEGACY_NOTIFY_TARGETS: Readonly<Record<string, { readonly parameter: string; readonly channel: CommsChannel }>> = {
  twilio: { parameter: "to", channel: "sms" },
  telnyx: { parameter: "to", channel: "sms" },
  whatsapp: { parameter: "to", channel: "whatsapp" },
  slack: { parameter: "channel", channel: "slack" },
  discord: { parameter: "channel_id", channel: "discord" }
};

export interface LegacyNotifyGuardDeps {
  readonly store: { isOptedOut(tenantId: string, optOutHash: string): Promise<boolean> };
  /** Tenanter utover identitetens som også sjekkes (webhook-tenanten). Tom/udefinert = kun identitetens tenant. */
  readonly extraTenants?: () => readonly string[];
  readonly warn?: (event: Record<string, unknown>) => void;
}

/** (kanal, normalisert mottaker) for en `notify`-handling, eller `null` når verktøyet ikke er et eldre `notify`-verktøy eller mottakeren ikke kan normaliseres. */
export function legacyNotifyTarget(toolId: string, parameters: Record<string, JsonValue>): { channel: CommsChannel; recipient: string } | null {
  const target = LEGACY_NOTIFY_TARGETS[toolId];
  if (target === undefined) return null;
  const normalized = normalizeRecipient(target.channel, parameters[target.parameter]);
  return normalized.ok ? { channel: target.channel, recipient: normalized.value } : null;
}

export function guardLegacyNotifyTransport(toolId: string, inner: ToolTransport, deps: LegacyNotifyGuardDeps): ToolTransport {
  if (LEGACY_NOTIFY_TARGETS[toolId] === undefined) return inner;
  return {
    async invoke(action: string, parameters: Record<string, JsonValue>, credential: string, context: ToolInvocationContext, signal?: AbortSignal) {
      if (action === "notify") await assertNotOptedOut(toolId, parameters, context, deps);
      return inner.invoke(action, parameters, credential, context, signal);
    }
  };
}

async function assertNotOptedOut(toolId: string, parameters: Record<string, JsonValue>, context: ToolInvocationContext, deps: LegacyNotifyGuardDeps): Promise<void> {
  const target = legacyNotifyTarget(toolId, parameters);
  if (target === null) return;
  const tenants = [...new Set([context.identity.tenant_id, ...(deps.extraTenants?.() ?? [])])];
  try {
    for (const tenantId of tenants) {
      if (await deps.store.isOptedOut(tenantId, optOutHash(tenantId, target.channel, target.recipient))) throw new PolicyDeniedError("comms_policy_denied:recipient_opted_out");
    }
  } catch (err) {
    if (err instanceof PolicyDeniedError) throw err;
    // Aldri send uten å ha sjekket. Kun en fast kode i loggen (ingen mottaker, ingen feiltekst).
    deps.warn?.({ msg: "comms_legacy_notify_optout_check_failed", tool: toolId });
    throw new PolicyDeniedError("comms_policy_denied:opt_out_check_unavailable");
  }
}
